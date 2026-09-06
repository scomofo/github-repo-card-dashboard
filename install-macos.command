#!/bin/bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
source_dir="$(cd "$(dirname "$0")" && pwd -P)"
support_dir="$HOME/Library/Application Support"
runtime_dir="$support_dir/Repo Dashboard"
applications_dir="$HOME/Applications"
app_path="$applications_dir/Repo Dashboard.app"
stage=""
app_stage=""
runtime_backup=""
app_backup=""
install_lock=""
runtime_installed=0
app_installed=0
complete=0

finish() {
  result=$?
  trap - EXIT
  set +e
  recovery_failed=0
  if [ "$complete" -eq 0 ]; then
    # Only remove the exact runtime/app this installer staged, never repository folders.
    if [ "$runtime_installed" -eq 1 ]; then rm -rf "$runtime_dir"; fi
    if [ "$app_installed" -eq 1 ]; then rm -rf "$app_path"; fi
    if [ -n "$runtime_backup" ] && [ -e "$runtime_backup" ]; then mv "$runtime_backup" "$runtime_dir" || recovery_failed=1; fi
    if [ -n "$app_backup" ] && [ -e "$app_backup" ]; then mv "$app_backup" "$app_path" || recovery_failed=1; fi
    if [ "$recovery_failed" -eq 0 ]; then
      printf '\nInstallation did not finish. Any previous installation has been restored.\n' >&2
    else
      printf '\nInstallation did not finish. Backups were kept for recovery in %s and %s.\n' "$stage" "$app_stage" >&2
    fi
  fi
  if [ "$recovery_failed" -eq 0 ]; then
    if [ -n "$stage" ]; then rm -rf "$stage"; fi
    if [ -n "$app_stage" ]; then rm -rf "$app_stage"; fi
  fi
  if [ -n "$install_lock" ]; then rmdir "$install_lock" 2>/dev/null || true; fi
  if [ -t 0 ]; then printf 'Press Return to close. '; read -r _answer || true; fi
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$(uname -s)" != "Darwin" ]; then
  printf 'This installer requires macOS. On other systems, run npm start.\n' >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1; then
  printf 'Install Node.js 20 or newer from https://nodejs.org/ (choose LTS), then double-click this installer again.\n' >&2
  exit 1
fi
if ! git --version >/dev/null 2>&1; then
  printf 'Git is required. In Terminal, run xcode-select --install and finish installing the Command Line Tools. Then double-click this installer again.\n' >&2
  exit 1
fi

mkdir -p "$support_dir" "$applications_dir"
if [ -L "$runtime_dir" ] || [ -L "$app_path" ]; then
  printf 'The destination is a symbolic link. Move or rename it before installing: %s or %s\n' "$runtime_dir" "$app_path" >&2
  exit 1
fi
if [ -e "$runtime_dir" ] && [ ! -f "$runtime_dir/.repo-dashboard-runtime" ]; then
  printf 'The destination already contains files from outside this installer: %s. Move or rename that folder before installing.\n' "$runtime_dir" >&2
  exit 1
fi
if [ -d "$runtime_dir" ] && [ -n "$(/usr/bin/find "$runtime_dir" -name .git -print -quit)" ]; then
  printf 'A Git checkout was found inside the app runtime: %s. Move it to a separate repository folder before updating; it has not been changed.\n' "$runtime_dir" >&2
  exit 1
fi
if [ -e "$app_path" ] && [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app_path/Contents/Info.plist" 2>/dev/null || true)" != 'com.scomofo.repodashboard' ]; then
  printf 'An unrelated app already uses the name %s. Move or rename it before installing.\n' "$app_path" >&2
  exit 1
fi
if ! mkdir "$support_dir/.repo-dashboard-install.lock" 2>/dev/null; then
  printf 'Another installer is running. Wait for it to finish. If a previous installer was interrupted, remove the empty folder "%s/.repo-dashboard-install.lock" and try again.\n' "$support_dir" >&2
  exit 1
fi
install_lock="$support_dir/.repo-dashboard-install.lock"
stage="$(mktemp -d "$support_dir/.repo-dashboard-install.XXXXXX")"
app_stage="$(mktemp -d "$applications_dir/.repo-dashboard-app.XXXXXX")"
mkdir "$stage/runtime"
printf 'Repo Dashboard managed runtime\n' > "$stage/runtime/.repo-dashboard-runtime"

printf 'Preparing Repo Dashboard…\n'
for file in server.mjs index.html package.json README.md launch-dashboard.command; do
  cp "$source_dir/$file" "$stage/runtime/$file"
done
for directory in src scripts assets; do
  cp -R "$source_dir/$directory" "$stage/runtime/$directory"
done
for file in app-icon.png favicon.png; do
  if [ -f "$source_dir/$file" ]; then cp "$source_dir/$file" "$stage/runtime/$file"; fi
done
chmod +x "$stage/runtime/launch-dashboard.command"
node --check "$stage/runtime/server.mjs"
node --check "$stage/runtime/scripts/launcher.mjs"

cat > "$stage/launcher.applescript" <<'APPLESCRIPT'
on run
  set launcherPath to POSIX path of (path to home folder) & "Library/Application Support/Repo Dashboard/launch-dashboard.command"
  try
    do shell script quoted form of launcherPath & " --app"
  on error errorMessage
    display dialog errorMessage with title "Repo Dashboard" buttons {"OK"} default button "OK" with icon stop
  end try
end run
APPLESCRIPT
/usr/bin/osacompile -o "$app_stage/Repo Dashboard.app" "$stage/launcher.applescript"

# Build a proper macOS icon from the existing project artwork.
if [ -f "$source_dir/app-icon.png" ]; then
  mkdir "$stage/dashboard.iconset"
  for size in 16 32 128 256 512; do
    /usr/bin/sips -z "$size" "$size" "$source_dir/app-icon.png" --out "$stage/dashboard.iconset/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    /usr/bin/sips -z "$double" "$double" "$source_dir/app-icon.png" --out "$stage/dashboard.iconset/icon_${size}x${size}@2x.png" >/dev/null
  done
  /usr/bin/iconutil -c icns "$stage/dashboard.iconset" -o "$app_stage/Repo Dashboard.app/Contents/Resources/dashboard.icns"
  /usr/libexec/PlistBuddy -c 'Set :CFBundleIconFile dashboard.icns' "$app_stage/Repo Dashboard.app/Contents/Info.plist" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c 'Add :CFBundleIconFile string dashboard.icns' "$app_stage/Repo Dashboard.app/Contents/Info.plist"
fi
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier com.scomofo.repodashboard' "$app_stage/Repo Dashboard.app/Contents/Info.plist" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string com.scomofo.repodashboard' "$app_stage/Repo Dashboard.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleName Repo Dashboard' "$app_stage/Repo Dashboard.app/Contents/Info.plist" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c 'Add :CFBundleName string Repo Dashboard' "$app_stage/Repo Dashboard.app/Contents/Info.plist"
# Seal the finished local bundle after changing its icon and metadata. This
# ad-hoc signature provides local integrity, not Developer ID or notarization.
/usr/bin/codesign --force --sign - --timestamp=none "$app_stage/Repo Dashboard.app"

printf 'Stopping the previous dashboard safely, if running…\n'
node "$stage/runtime/scripts/launcher.mjs" --stop

# Both replacements are staged on their destination filesystem. Keep backups
# until both moves succeed so an interrupted upgrade can be rolled back.
if [ -e "$runtime_dir" ]; then
  runtime_backup="$stage/previous-runtime"
  mv "$runtime_dir" "$runtime_backup"
fi
if [ -e "$app_path" ]; then
  app_backup="$app_stage/previous-app"
  mv "$app_path" "$app_backup"
fi
mv "$stage/runtime" "$runtime_dir"
runtime_installed=1
mv "$app_stage/Repo Dashboard.app" "$app_path"
app_installed=1
complete=1
rmdir "$install_lock"
install_lock=""
printf '\nInstalled: %s\nDouble-click Repo Dashboard in your home Applications folder. You can drag it into the Dock.\n' "$app_path"
printf 'Repository checkouts live separately in ~/Developer/GitHub and were not changed by this installer.\n'
if [ "${REPO_DASHBOARD_NO_OPEN:-}" != "1" ]; then
  /usr/bin/open "$app_path" || printf 'Open %s in Finder to start the dashboard.\n' "$app_path"
fi
