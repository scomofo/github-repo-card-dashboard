import { homedir } from 'node:os';
import path from 'node:path';

// Device names Windows reserves as file names, with or without an extension.
const WINDOWS_RESERVED_NAMES = new Set(['CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)]);

/** True when a repository name would be an unusable path on Windows. Checked
 * on every platform: a checkout created on macOS may later be used on Windows. */
export function isWindowsReservedName(name) {
  if (typeof name !== 'string') return false;
  return WINDOWS_RESERVED_NAMES.has(name.split('.')[0].toUpperCase());
}

/** Base folder for user-level app data: ~/Library/Application Support on
 * macOS, %APPDATA% on Windows. `platform`/`env` overrides exist for tests. */
export function appDataRoot(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    if (env.APPDATA) return env.APPDATA;
    return path.join(env.USERPROFILE || homedir(), 'AppData', 'Roaming');
  }
  return path.join(homedir(), 'Library', 'Application Support');
}

/** Where install records, launcher state, and diagnostic logs live. */
export function dashboardProjectsRoot(platform = process.platform, env = process.env) {
  return path.join(appDataRoot(platform, env), 'Repo Dashboard Projects');
}

/** Where generated per-app launchers live. */
export function dashboardAppsRoot(platform = process.platform, env = process.env) {
  if (platform === 'win32') return path.join(appDataRoot(platform, env), 'Repo Dashboard Apps');
  return path.join(homedir(), 'Applications', 'Repo Apps');
}

/** Cache folder for the single-instance launcher lock. */
export function dashboardCacheRoot(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    if (env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, 'Repo Dashboard');
    return path.join(env.USERPROFILE || homedir(), 'AppData', 'Local', 'Repo Dashboard');
  }
  return path.join(homedir(), 'Library', 'Caches', 'Repo Dashboard');
}

/** Folder for the launcher-managed server log. */
export function dashboardLogRoot(platform = process.platform, env = process.env) {
  if (platform === 'win32') return path.join(dashboardCacheRoot(platform, env), 'Logs');
  return path.join(homedir(), 'Library', 'Logs', 'Repo Dashboard');
}
