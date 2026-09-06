#!/bin/bash
# Finder does not load your interactive shell profile.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
cd "$(dirname "$0")" || exit 1
launch_mode="${1:-}"

fail() {
  printf '\n%s\n' "$1" >&2
  if [ -t 0 ] && [ "$launch_mode" != "--app" ]; then
    printf 'Press Return to close. '
    read -r _answer
  fi
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js 20 or newer is required. Install the current LTS version from https://nodejs.org/ and open Repo Dashboard again."
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1; then
  fail "Node.js 20 or newer is required. Update Node.js at https://nodejs.org/ and open Repo Dashboard again."
fi

node scripts/launcher.mjs "$@"
result=$?
if [ "$result" -ne 0 ] && [ -t 0 ] && [ "$launch_mode" != "--app" ]; then
  printf 'Press Return to close. '
  read -r _answer
fi
exit "$result"
