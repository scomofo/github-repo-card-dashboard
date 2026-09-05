import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createLocalRepoManager } from '../src/localRepos.mjs';

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
  const options = { root, cacheTtlMs: 0, remoteUrlForTests: () => remote };
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

test('Git timeouts stop the operation and release the action lock', { skip: process.platform === 'win32' }, async (t) => {
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
  // The Linux tool sandbox does not expose process groups. The product target
  // is macOS, where the detached group must also terminate helper descendants.
  if (process.platform === 'darwin') {
    await delay(1100);
    await assert.rejects(readFile(completed), { code: 'ENOENT' });
  }
  // A new action gets past the lock and fails for the actual missing checkout.
  await assert.rejects(manager.runAction({ fullName, action: 'update' }), { statusCode: 404 });
});
