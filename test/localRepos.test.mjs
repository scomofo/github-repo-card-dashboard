import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { classifyLocalRepoFailure, createLocalRepoManager } from '../src/localRepos.mjs';

const exec = promisify(execFile);
const fullName = 'owner/demo';

async function git(cwd, ...args) {
  return (await exec('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
}

async function fixture(t, { empty = false } = {}) {
  const temp = await mkdtemp(path.join(tmpdir(), 'repo-dashboard-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'checkouts');
  const remote = path.join(temp, 'remote.git');
  const seed = path.join(temp, 'seed');
  await git(temp, 'init', '--bare', '--initial-branch=main', remote);
  await git(temp, 'init', '--initial-branch=main', seed);
  await git(seed, 'config', 'user.name', 'Dashboard Test');
  await git(seed, 'config', 'user.email', 'test@example.invalid');
  await git(seed, 'remote', 'add', 'origin', remote);
  async function push(content = 'next version\n') {
    await writeFile(path.join(seed, 'README.md'), content);
    await git(seed, 'add', 'README.md');
    await git(seed, 'commit', '-m', 'Update readme');
    await git(seed, 'push', '-u', 'origin', 'main');
  }
  if (!empty) await push('initial version\n');
  const options = { root, cacheTtlMs: 0, remoteUrlForTests: () => remote, diagnosticsRoot: path.join(temp, 'diagnostics') };
  const manager = createLocalRepoManager(options);
  const checkout = path.join(root, 'owner', 'demo');
  async function clone() {
    const result = await manager.runAction({ fullName, action: 'clone' });
    await git(checkout, 'config', 'user.name', 'Dashboard Test');
    await git(checkout, 'config', 'user.email', 'test@example.invalid');
    return result;
  }
  async function status() { return (await manager.status([fullName])).repos[0]; }
  return { temp, root, remote, seed, push, manager, checkout, options, clone, status };
}

test('clones into owner/repo and safely fast-forwards; status never fetches', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.status()).state, 'not-installed');
  const installed = await f.clone();
  assert.equal(installed.repo.state, 'ready');
  assert.equal(installed.repo.branch, 'main');
  assert.equal(installed.repo.path, f.checkout);
  assert.equal((await f.manager.status([fullName])).gitAvailable, true);
  const previous = await git(f.checkout, 'rev-parse', 'HEAD');
  await f.push();
  assert.equal((await f.status()).state, 'ready', 'local status must not fetch new remote commits');
  assert.equal(await git(f.checkout, 'rev-parse', 'refs/remotes/origin/main'), previous);
  const updated = await f.manager.runAction({ fullName, action: 'update' });
  assert.match(updated.message, /fast-forward/);
  assert.equal(updated.repo.state, 'ready');
  assert.equal(await git(f.checkout, 'rev-parse', 'HEAD'), await git(f.seed, 'rev-parse', 'HEAD'));
  assert.equal(await readFile(path.join(f.checkout, 'README.md'), 'utf8'), 'next version\n');
});

test('failed downloads retain the exact stage and write private diagnostics without sending raw output', async (t) => {
  const f = await fixture(t);
  await rm(f.remote, { recursive: true });
  await assert.rejects(f.manager.runAction({ fullName, action: 'clone' }), (error) => {
    assert.equal(error.stage, 'clone');
    assert.equal(error.exitCode, 128);
    assert.match(error.message, /Details:/);
    assert.ok(!error.message.includes(f.remote), 'raw Git stderr stays out of the browser error');
    assert.ok(!JSON.stringify(error).includes(f.remote), 'the internal cause is not serializable');
    return true;
  });
  const log = await readFile(path.join(f.options.diagnosticsRoot, 'owner/demo.git.log'), 'utf8');
  assert.match(log, /Stage: clone/);
  assert.match(log, /does not exist/);
});

test('refuses tracked edits and untracked files without modifying or fetching', async (t) => {
  const f = await fixture(t);
  await f.clone();
  const original = await git(f.checkout, 'rev-parse', 'HEAD');
  await f.push();
  await writeFile(path.join(f.checkout, 'README.md'), 'my unfinished work\n');
  assert.equal((await f.status()).state, 'dirty');
  await assert.rejects(f.manager.runAction({ fullName, action: 'update' }), { statusCode: 409 });
  assert.equal(await readFile(path.join(f.checkout, 'README.md'), 'utf8'), 'my unfinished work\n');
  assert.equal(await git(f.checkout, 'rev-parse', 'origin/main'), original);
  await writeFile(path.join(f.checkout, 'README.md'), 'initial version\n');
  await writeFile(path.join(f.checkout, 'untracked.txt'), 'keep me');
  await assert.rejects(f.manager.runAction({ fullName, action: 'update' }), /untracked/);
  assert.equal(await readFile(path.join(f.checkout, 'untracked.txt'), 'utf8'), 'keep me');
});

test('preserves local commits and blocks divergence after fetching', async (t) => {
  const f = await fixture(t);
  await f.clone();
  await writeFile(path.join(f.checkout, 'local.txt'), 'my local commit');
  await git(f.checkout, 'add', 'local.txt');
  await git(f.checkout, 'commit', '-m', 'Local work');
  const localHead = await git(f.checkout, 'rev-parse', 'HEAD');
  assert.equal((await f.status()).state, 'ahead');
  await f.manager.runAction({ fullName, action: 'update' });
  assert.equal(await git(f.checkout, 'rev-parse', 'HEAD'), localHead);
  await f.push();
  await assert.rejects(f.manager.runAction({ fullName, action: 'update' }), /diverged/);
  assert.equal((await f.status()).state, 'diverged');
  assert.equal(await git(f.checkout, 'rev-parse', 'HEAD'), localHead);
  assert.equal(await readFile(path.join(f.checkout, 'local.txt'), 'utf8'), 'my local commit');
});

test('preserves ignored local files when upstream starts tracking the same path', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.seed, '.gitignore'), '.env\n');
  await git(f.seed, 'add', '.gitignore');
  await git(f.seed, 'commit', '-m', 'Ignore local environment');
  await git(f.seed, 'push');
  await f.clone();
  const previous = await git(f.checkout, 'rev-parse', 'HEAD');
  await writeFile(path.join(f.checkout, '.env'), 'LOCAL_SECRET=keep-me\n');
  await writeFile(path.join(f.seed, '.env'), 'REMOTE_DEFAULT=replacement\n');
  await git(f.seed, 'add', '-f', '.env');
  await git(f.seed, 'commit', '-m', 'Track an environment file');
  await git(f.seed, 'push');
  assert.equal((await f.status()).state, 'ready', 'ignored files do not appear as working tree changes');
  await assert.rejects(f.manager.runAction({ fullName, action: 'update' }), { statusCode: 409 });
  assert.equal(await readFile(path.join(f.checkout, '.env'), 'utf8'), 'LOCAL_SECRET=keep-me\n');
  assert.equal(await git(f.checkout, 'rev-parse', 'HEAD'), previous);
});

test('overrides squash and autostash defaults to preserve ordinary fast-forward behavior', async (t) => {
  const f = await fixture(t);
  await f.clone();
  await git(f.checkout, 'config', 'branch.main.mergeOptions', '--squash --autostash');
  await git(f.checkout, 'config', 'merge.autoStash', 'true');
  await f.push();
  const result = await f.manager.runAction({ fullName, action: 'update' });
  assert.equal(result.repo.state, 'ready');
  assert.equal(await git(f.checkout, 'rev-parse', 'HEAD'), await git(f.seed, 'rev-parse', 'HEAD'));
  assert.equal(await git(f.checkout, 'stash', 'list'), '');
});

test('checks origin identity without exposing credential-bearing URLs', async (t) => {
  const f = await fixture(t);
  await f.clone();
  await git(f.checkout, 'remote', 'set-url', 'origin', 'https://secret-token@github.com/other/repo.git');
  const state = await f.status();
  assert.equal(state.state, 'blocked');
  assert.match(state.message, /origin/);
  assert.doesNotMatch(state.message, /secret-token/);
  await assert.rejects(f.manager.runAction({ fullName, action: 'update' }), (error) => {
    assert.equal(error.statusCode, 409);
    assert.doesNotMatch(error.message, /secret-token/);
    return true;
  });
});

test('recognizes matching HTTPS and SSH GitHub origins and rejects host lookalikes', async (t) => {
  const f = await fixture(t);
  await f.clone();
  const production = createLocalRepoManager({ root: f.root, cacheTtlMs: 0 });
  for (const origin of ['https://github.com/owner/demo.git', 'https://github.com/OWNER/demo', 'git@github.com:owner/demo.git', 'ssh://git@github.com/owner/demo.git']) {
    await git(f.checkout, 'remote', 'set-url', 'origin', origin);
    assert.equal((await production.status([fullName])).repos[0].state, 'ready', origin);
  }
  for (const origin of ['https://github.com.evil.invalid/owner/demo.git', 'https://github.com/owner/demo.git?x=1', 'https://github.com/other/demo.git', 'http://github.com/owner/demo.git']) {
    await git(f.checkout, 'remote', 'set-url', 'origin', origin);
    assert.equal((await production.status([fullName])).repos[0].state, 'blocked', origin);
  }
});

test('refuses detached HEAD and a branch tracking another remote', async (t) => {
  const f = await fixture(t);
  await f.clone();
  await git(f.checkout, 'checkout', '--detach');
  assert.equal((await f.status()).state, 'blocked');
  await assert.rejects(f.manager.runAction({ fullName, action: 'update' }), /Detached HEAD/);
  await git(f.checkout, 'checkout', 'main');
  await git(f.checkout, 'config', 'branch.main.remote', 'elsewhere');
  await assert.rejects(f.manager.runAction({ fullName, action: 'update' }), /track a branch on origin/);
});

test('validates repository names and actions before touching the filesystem', async (t) => {
  const f = await fixture(t);
  for (const invalid of ['../escape', 'owner/..', 'owner/.', 'owner/.git', 'owner/repo/other', '/tmp/file', 'owner\\repo', '-owner/repo', 'owner/repo\n', null]) {
    await assert.rejects(f.manager.runAction({ fullName: invalid, action: 'clone' }), { statusCode: 400 });
    await assert.rejects(f.manager.status([invalid]), { statusCode: 400 });
  }
  await assert.rejects(f.manager.runAction({ fullName, action: 'reset' }), { statusCode: 400 });
});

test('does not overwrite existing folders or act on a parent repository', async (t) => {
  const f = await fixture(t);
  await mkdir(f.checkout, { recursive: true });
  await writeFile(path.join(f.checkout, 'important.txt'), 'preserve');
  await assert.rejects(f.manager.runAction({ fullName, action: 'clone' }), /already exists/);
  assert.equal((await f.status()).state, 'blocked');
  await git(f.root, 'init');
  await assert.rejects(f.manager.runAction({ fullName, action: 'update' }), /standalone Git checkout/);
  assert.equal(await readFile(path.join(f.checkout, 'important.txt'), 'utf8'), 'preserve');
});

test('blocks symlinks at the root, owner, checkout, and .git boundaries', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.temp, 'outside');
  await mkdir(outside);
  await symlink(outside, f.root, 'dir');
  await assert.rejects(f.manager.runAction({ fullName, action: 'clone' }), /symlink/);
  await rm(f.root);
  await mkdir(f.root);
  await symlink(outside, path.join(f.root, 'owner'), 'dir');
  await assert.rejects(f.manager.runAction({ fullName, action: 'clone' }), /symlink/);
  await rm(path.join(f.root, 'owner'));
  await mkdir(path.join(f.root, 'owner'));
  await symlink(outside, f.checkout, 'dir');
  await assert.rejects(f.manager.runAction({ fullName, action: 'clone' }), /symlink/);
  await rm(f.checkout);
  await mkdir(f.checkout);
  await symlink(path.join(f.seed, '.git'), path.join(f.checkout, '.git'), 'dir');
  await assert.rejects(f.manager.runAction({ fullName, action: 'update' }), /symlink/);
});

test('serializes actions per repository and releases locks after failures', async (t) => {
  const f = await fixture(t);
  const first = f.manager.runAction({ fullName, action: 'clone' });
  await assert.rejects(f.manager.runAction({ fullName, action: 'clone' }), /already running/);
  await first;
  await assert.rejects(f.manager.runAction({ fullName, action: 'clone' }), /already exists/);
  await f.manager.runAction({ fullName, action: 'update' });
});

test('disables repository hooks during updates', async (t) => {
  const f = await fixture(t);
  await f.clone();
  const hookDir = path.join(f.temp, 'hooks');
  const marker = path.join(f.temp, 'hook-ran');
  await mkdir(hookDir);
  const hook = path.join(hookDir, 'post-merge');
  await writeFile(hook, `#!/bin/sh\nprintf ran > '${marker}'\n`);
  await chmod(hook, 0o755);
  await git(f.checkout, 'config', 'core.hooksPath', hookDir);
  await f.push();
  await f.manager.runAction({ fullName, action: 'update' });
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  assert.equal(await git(f.checkout, 'rev-parse', 'HEAD'), await git(f.seed, 'rev-parse', 'HEAD'));
});

test('empty remote clones remain inspectable and cannot be accidentally updated', async (t) => {
  const f = await fixture(t, { empty: true });
  const result = await f.clone();
  assert.equal(result.repo.installed, true);
  assert.equal(result.repo.state, 'blocked');
  assert.match(result.repo.message, /no local commits/);
  await assert.rejects(f.manager.runAction({ fullName, action: 'update' }), /no local commits/);
});

test('Git timeouts stop the process group and release the action lock', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t);
  const bin = path.join(f.temp, 'bin');
  await mkdir(bin);
  const started = path.join(f.temp, 'helper-started');
  const completed = path.join(f.temp, 'helper-survived');
  const helper = `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'started'); setTimeout(() => { try { require('node:fs').writeFileSync(${JSON.stringify(completed)}, 'survived'); } catch {} }, 1000);`;
  await writeFile(path.join(bin, 'git'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('git version test');
else if (args.includes('--get-url')) console.log(args.at(-1));
else {
  require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: 'ignore' });
  setTimeout(() => process.exit(1), 3000);
}
`);
  await chmod(path.join(bin, 'git'), 0o755);
  const originalPath = process.env.PATH;
  let manager;
  try {
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    manager = createLocalRepoManager({ ...f.options, timeoutMs: 500 });
  } finally { process.env.PATH = originalPath; }
  const start = Date.now();
  await assert.rejects(manager.runAction({ fullName, action: 'clone' }), { statusCode: 504 });
  assert.ok(Date.now() - start < 2500, 'the timeout stops Git before its own delayed exit');
  assert.equal(await readFile(started, 'utf8'), 'started');
  await delay(1100);
  await assert.rejects(readFile(completed), { code: 'ENOENT' });
  // A new action gets past the lock and fails for the actual missing checkout.
  await assert.rejects(manager.runAction({ fullName, action: 'update' }), { statusCode: 404 });
});

test('Git output overflow stops the process group, sanitizes errors, and releases the lock', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t);
  const bin = path.join(f.temp, 'bin');
  await mkdir(bin);
  const completed = path.join(f.temp, 'helper-survived');
  const helper = `process.send('ready'); setTimeout(() => { try { require('node:fs').writeFileSync(${JSON.stringify(completed)}, 'survived'); } catch {} }, 1000);`;
  await writeFile(path.join(bin, 'git'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('git version test');
else if (args.includes('--get-url')) console.log(args.at(-1));
else {
  const helper = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  helper.on('message', () => process.stderr.write('private-token-never-expose ' + 'x'.repeat(2 * 1024 * 1024)));
  setTimeout(() => process.exit(1), 3000);
}
`);
  await chmod(path.join(bin, 'git'), 0o755);
  const originalPath = process.env.PATH;
  let manager;
  try {
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    manager = createLocalRepoManager({ ...f.options, timeoutMs: 5000 });
  } finally { process.env.PATH = originalPath; }
  const start = Date.now();
  await assert.rejects(manager.runAction({ fullName, action: 'clone' }), (error) => {
    assert.equal(error.statusCode, 502);
    assert.equal(error.reasonCode, 'output-limit');
    assert.equal(error.stage, 'clone');
    assert.doesNotMatch(error.message, /private-token-never-expose/);
    assert.doesNotMatch(JSON.stringify(error), /private-token-never-expose/);
    return true;
  });
  assert.ok(Date.now() - start < 2500, 'the output cap stops Git before its delayed exit or timeout');
  await delay(1100);
  await assert.rejects(readFile(completed), { code: 'ENOENT' });
  await assert.rejects(manager.runAction({ fullName, action: 'update' }), { statusCode: 404 });
});

test('classifies Git diagnostics without publishing raw errors, URLs, or credentials', () => {
  const cases = [
    ['fatal: could not read Username for https://credential-never-publish@github.com: terminal prompts disabled', 'git-auth', 403],
    ['fatal: Authentication failed for https://credential-never-publish@github.com/owner/repo', 'git-auth', 403],
    ['git@github.com: Permission denied (publickey).', 'git-auth', 403],
    ["fatal: unable to access 'https://credential-never-publish@github.com/owner/repo': The requested URL returned error: 403", 'git-auth', 403],
    ['fatal: Could not resolve host: private-host-never-publish.invalid', 'network-dns', 502],
    ['fatal: Could not resolve proxy: private-host-never-publish.invalid', 'network-dns', 502],
    ['fatal: SSL certificate problem: unable to get local issuer certificate', 'network-certificate', 502],
    ['fatal: RPC failed; curl 92 HTTP/2 stream was not closed cleanly: INTERNAL_ERROR', 'network-transport', 502],
    ['fatal: early EOF; the remote end hung up unexpectedly', 'network-transport', 502],
    ['fatal: Failed to connect to private-host-never-publish.invalid port 443', 'network-transport', 502],
    ['fatal: unable to update url base from redirection:', 'network-redirect', 502],
    ['fatal: The requested URL returned error: 301', 'network-redirect', 502],
    ["fatal: Unable to create '/private-path-never-publish/.git/index.lock': File exists.", 'git-lock', 409],
    ["error: cannot lock ref 'refs/heads/main'", 'git-lock', 409],
    ["fatal: assets.bin: smudge filter lfs failed", 'git-filter', 502],
    ["git-lfs: command not found", 'git-filter', 502],
    ["error: unknown option `no-overwrite-ignore'", 'git-version', 503],
    ["fatal: could not create work tree dir '/private-path-never-publish': Permission denied", 'filesystem-permission', 403],
    ["fatal: Unable to create '/private-path-never-publish/.git/index.lock': Operation not permitted", 'filesystem-permission', 403],
    ["fatal: cannot write pack file: No space left on device", 'disk-full', 507],
    ["fatal: cannot open file: Read-only file system", 'filesystem-readonly', 409],
    ["fatal: Too many levels of symbolic links", 'filesystem-symlink', 409],
    ['error: Your local changes would be overwritten by merge', 'local-overlap', 409],
    ['fatal: Not possible to fast-forward, aborting.', 'non-fast-forward', 409],
    ['unrecognized-secret-never-publish failure', 'unknown', 502],
  ];
  for (const [stderr, reasonCode, statusCode] of cases) {
    const original = Object.assign(new Error('command-line-never-publish'), { code: 128, stderr });
    const error = classifyLocalRepoFailure(original, { stage: 'clone', gitProcess: true });
    assert.equal(error.reasonCode, reasonCode, stderr);
    assert.equal(error.statusCode, statusCode, stderr);
    assert.equal(error.stage, 'clone');
    assert.equal(error.exitCode, 128);
    assert.match(error.message, /While downloading source; exit 128/);
    assert.doesNotMatch(error.message, /never-publish/);
    assert.doesNotMatch(JSON.stringify(error), /never-publish/);
    assert.equal(error.cause, original, 'internal diagnostics retain the original error');
    assert.equal(Object.getOwnPropertyDescriptor(error, 'cause').enumerable, false);
  }
});

test('distinguishes filesystem failures from missing Git and rejects untrusted stage or exit metadata', () => {
  for (const [code, reasonCode, statusCode] of [
    ['EACCES', 'filesystem-permission', 403], ['EPERM', 'filesystem-permission', 403],
    ['ENOSPC', 'disk-full', 507], ['EROFS', 'filesystem-readonly', 409],
    ['ELOOP', 'filesystem-symlink', 409], ['ENOENT', 'file-missing', 409],
  ]) {
    const error = classifyLocalRepoFailure(Object.assign(new Error('private-path-never-publish'), { code }), { stage: 'install' });
    assert.equal(error.reasonCode, reasonCode, code);
    assert.equal(error.statusCode, statusCode, code);
    assert.equal(error.stage, 'install');
    assert.doesNotMatch(error.message, /Git is unavailable|private-path-never-publish/);
    assert.equal(error.exitCode, undefined);
  }
  const missingGit = classifyLocalRepoFailure(Object.assign(new Error(), { code: 'ENOENT' }), { stage: 'git-version', gitProcess: true });
  assert.equal(missingGit.reasonCode, 'git-unavailable');
  assert.equal(missingGit.statusCode, 503);
  for (const code of [-1, 256, NaN, Infinity, '128', 'private-exit-never-publish']) {
    const error = classifyLocalRepoFailure({ code, stderr: 'private-secret-never-publish' }, { stage: 'private-stage-never-publish' });
    assert.equal(error.stage, 'local-files');
    assert.equal(error.exitCode, undefined);
    assert.doesNotMatch(error.message, /exit|never-publish/);
    assert.doesNotMatch(JSON.stringify(error), /never-publish/);
  }
});

test('failed clone and Git preflight report their actual stage and retain safe failure classifications', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t);
  const bin = path.join(f.temp, 'fake-git-bin');
  const scenarioFile = path.join(f.temp, 'fake-git-scenario.json');
  await mkdir(bin);
  await writeFile(path.join(bin, 'git'), `#!/usr/bin/env node
const args = process.argv.slice(2);
const scenario = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(scenarioFile)}, 'utf8'));
if (args.includes('--version') && scenario.stage !== 'preflight') console.log('git version test');
else if (args.includes('--get-url')) console.log(args.at(-1));
else { process.stderr.write(scenario.stderr); process.exit(128); }
`);
  await chmod(path.join(bin, 'git'), 0o755);
  async function manager() {
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
      return createLocalRepoManager(f.options);
    } finally { process.env.PATH = previousPath; }
  }
  await writeFile(scenarioFile, JSON.stringify({ stage: 'clone', stderr: 'fatal: Could not resolve host: private-host-never-publish' }));
  const cloneManager = await manager();
  await assert.rejects(cloneManager.runAction({ fullName, action: 'clone' }), (error) => {
    assert.equal(error.reasonCode, 'network-dns');
    assert.equal(error.stage, 'clone');
    assert.match(error.message, /downloading source/);
    assert.doesNotMatch(error.message, /private-host-never-publish/);
    return true;
  });
  await writeFile(scenarioFile, JSON.stringify({ stage: 'preflight', stderr: 'error: unknown option private-option-never-publish' }));
  const unavailableManager = await manager();
  assert.equal((await unavailableManager.status([fullName])).gitAvailable, false);
  await assert.rejects(unavailableManager.runAction({ fullName, action: 'clone' }), (error) => {
    assert.equal(error.reasonCode, 'git-version');
    assert.equal(error.stage, 'git-version');
    assert.equal(error.statusCode, 503);
    assert.doesNotMatch(error.message, /private-option-never-publish|Git is unavailable/);
    return true;
  });
});
