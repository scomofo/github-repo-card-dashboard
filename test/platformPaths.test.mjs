import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  appDataRoot,
  dashboardAppsRoot,
  dashboardCacheRoot,
  dashboardLogRoot,
  dashboardProjectsRoot,
  isWindowsReservedName,
} from '../src/platformPaths.mjs';

test('Windows reserved device names are detected with or without an extension', () => {
  for (const name of ['con', 'CON', 'PRN', 'aux', 'Nul', 'COM1', 'com9', 'LPT1', 'lpt9', 'con.txt', 'COM2.log', 'nul.json']) {
    assert.ok(isWindowsReservedName(name), name);
  }
  for (const name of ['console', 'comfort', 'comp1', 'com10', 'lpt', 'null', 'nulx', 'demo', '']) {
    assert.ok(!isWindowsReservedName(name), name);
  }
  assert.ok(!isWindowsReservedName(null));
});

test('Windows default paths live under APPDATA and LOCALAPPDATA', () => {
  // path.join uses the host separators here; on real Windows these are all
  // backslashes. Assert the joined segments, not the separator style.
  const env = { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };
  assert.equal(dashboardProjectsRoot('win32', env), path.join(env.APPDATA, 'Repo Dashboard Projects'));
  assert.equal(dashboardAppsRoot('win32', env), path.join(env.APPDATA, 'Repo Dashboard Apps'));
  assert.equal(dashboardCacheRoot('win32', env), path.join(env.LOCALAPPDATA, 'Repo Dashboard'));
  assert.equal(dashboardLogRoot('win32', env), path.join(env.LOCALAPPDATA, 'Repo Dashboard', 'Logs'));
  assert.equal(appDataRoot('win32', env), env.APPDATA);
});

test('Windows default paths fall back when APPDATA is missing', () => {
  const env = { USERPROFILE: 'C:\\Users\\me' };
  assert.equal(dashboardProjectsRoot('win32', env),
    path.join('C:\\Users\\me', 'AppData', 'Roaming', 'Repo Dashboard Projects'));
});

test('macOS default paths are unchanged', () => {
  const projects = dashboardProjectsRoot('darwin', {});
  assert.ok(projects.endsWith('Library/Application Support/Repo Dashboard Projects'), projects);
  assert.ok(dashboardAppsRoot('darwin', {}).endsWith('Applications/Repo Apps'));
  assert.ok(dashboardCacheRoot('darwin', {}).endsWith('Library/Caches/Repo Dashboard'));
  assert.ok(dashboardLogRoot('darwin', {}).endsWith('Library/Logs/Repo Dashboard'));
});
