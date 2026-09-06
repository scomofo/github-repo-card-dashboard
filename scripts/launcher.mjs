import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const runtime = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 8787);
const cache = join(homedir(), 'Library', 'Caches', 'Repo Dashboard');
const logDirectory = join(homedir(), 'Library', 'Logs', 'Repo Dashboard');
const logPath = join(logDirectory, 'server.log');
const lockPath = join(cache, `launch-${port}.lock`);
const pidPath = join(cache, `server-${port}.json`);
const url = `http://127.0.0.1:${port}`;
const lockOwner = { pid: process.pid, id: randomUUID() };
let ownsLock = false;

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function jsonFile(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

async function health() {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(800), redirect: 'error' });
    const body = await response.json().catch(() => null);
    return { reachable: true, dashboard: response.ok && body?.ok === true && body?.app === 'repo-dashboard', body };
  } catch { return { reachable: false, dashboard: false }; }
}

async function acquireLock() {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    try {
      const file = await open(lockPath, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(lockOwner)); } finally { await file.close(); }
      ownsLock = true;
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await jsonFile(lockPath);
      const details = await stat(lockPath).catch(() => null);
      // Give another launcher time to finish writing its freshly created lock.
      if (details && Date.now() - details.mtimeMs > 5_000 && !alive(owner?.pid)) {
        await unlink(lockPath).catch(() => {});
      }
      await delay(250);
    }
  }
  throw new Error('Another Repo Dashboard launch or shutdown is still running. Wait a moment and try again.');
}

async function stop() {
  const current = await health();
  const saved = await jsonFile(pidPath);
  if (!current.dashboard) {
    if (saved && alive(saved.pid)) {
      throw new Error('The saved dashboard process is still running but is not responding. Wait for ongoing Git operations to finish, then try again.');
    }
    await unlink(pidPath).catch(() => {});
    console.log('Repo Dashboard is already stopped.');
    return;
  }
  if (!saved || current.body.pid !== saved.pid || resolve(current.body.runtime || '/') !== saved.runtime || !alive(saved.pid)) {
    throw new Error('A dashboard started outside this launcher is using this port. Stop it in its Terminal window (Control-C), then try again.');
  }
  process.kill(saved.pid, 'SIGTERM');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!alive(saved.pid)) {
      await unlink(pidPath).catch(() => {});
      console.log('Repo Dashboard stopped. Your repositories were kept.');
      return;
    }
    await delay(250);
  }
  throw new Error('Repo Dashboard is finishing an operation. Wait for the repository operation to complete and try again; no files have been replaced.');
}

async function start() {
  let current = await health();
  if (current.dashboard) {
    console.log(`Repo Dashboard is already running at ${url}`);
    return;
  }
  if (current.reachable) throw new Error(`Port ${port} is used by another service. Close that service or launch with a different PORT.`);

  const saved = await jsonFile(pidPath);
  if (saved && alive(saved.pid)) {
    throw new Error(`Repo Dashboard is still starting or stopping. Wait a moment and try again. Log: ${logPath}`);
  }
  const git = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (git.status !== 0) {
    throw new Error('Git is required. Open Terminal and run xcode-select --install, complete the Command Line Tools installation, then open Repo Dashboard again.');
  }
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  const log = openSync(logPath, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [join(runtime, 'server.mjs')], {
      cwd: runtime,
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, PORT: String(port) }
    });
  } finally { closeSync(log); }
  let failed;
  child.once('error', (error) => { failed = error.message; });
  child.once('exit', (code, signal) => { failed = `Server exited (${signal || code}).`; });
  if (child.pid) await writeFile(pidPath, JSON.stringify({ pid: child.pid, runtime }), { mode: 0o600 });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !failed) {
    current = await health();
    if (current.dashboard && current.body.pid === child.pid && resolve(current.body.runtime || '/') === runtime) {
      child.unref();
      console.log(`Repo Dashboard is ready at ${url}\nLog: ${logPath}`);
      return;
    }
    await delay(200);
  }
  if (child.pid && alive(child.pid)) child.kill('SIGTERM');
  await unlink(pidPath).catch(() => {});
  throw new Error(`${failed || 'The dashboard did not become ready.'} Check ${logPath}. Another service may already use port ${port}.`);
}

try {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20 or newer is required.');
  if (process.platform !== 'darwin' && process.env.REPO_DASHBOARD_NO_OPEN !== '1') throw new Error('This launcher is for macOS. On other platforms use npm start.');
  await mkdir(cache, { recursive: true, mode: 0o700 });
  await acquireLock();
  if (process.argv.includes('--stop')) {
    await stop();
  } else {
    if (await stat(join(homedir(), 'Library', 'Application Support', '.repo-dashboard-install.lock')).catch(() => null)) {
      throw new Error('Repo Dashboard is being installed or updated. Wait for the installer to finish and open it again.');
    }
    await start();
    if (process.env.REPO_DASHBOARD_NO_OPEN !== '1') {
      const result = spawnSync('/usr/bin/open', [url], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`The dashboard is running. Open ${url} in your browser. macOS could not open the default browser.`);
    }
  }
} catch (error) {
  console.error(`Repo Dashboard: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (ownsLock && (await jsonFile(lockPath))?.id === lockOwner.id) await unlink(lockPath).catch(() => {});
}
