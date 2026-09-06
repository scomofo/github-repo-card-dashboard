import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createLocalRepoManager } from '../src/localRepos.mjs';
import { createProjectInstaller } from '../src/projectInstall.mjs';

const exec = promisify(execFile);
const fullName = 'owner/local-app';
const git = async (cwd, ...args) => (await exec('git', args, { cwd })).stdout.trim();

async function fixture(t, { supported = true } = {}) {
  const temp = await mkdtemp(path.join(tmpdir(), 'repo-app-actions-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repos');
  const seed = path.join(temp, 'seed');
  const remote = path.join(temp, 'remote.git');
  await git(temp, 'init', '--bare', '--initial-branch=main', remote);
  await git(temp, 'init', '--initial-branch=main', seed);
  await git(seed, 'config', 'user.name', 'App Install Test');
  await git(seed, 'config', 'user.email', 'test@example.invalid');
  await git(seed, 'remote', 'add', 'origin', remote);
  const manifest = { name: 'local-app-fixture', private: true, version: '1.0.0',
    scripts: { dev: 'node app.mjs', postinstall: 'node setup.mjs' } };
  await writeFile(path.join(seed, 'README.md'), 'Local app fixture\n');
  if (supported) {
    await writeFile(path.join(seed, 'package.json'), JSON.stringify(manifest));
    await writeFile(path.join(seed, 'app.mjs'), "console.log('Application started');\n");
    await writeSetup(seed, 'first');
  }
  async function publish() {
    await git(seed, 'add', '.');
    await git(seed, 'commit', '-m', 'Update app fixture');
    await git(seed, 'push', '-u', 'origin', 'main');
  }
  await publish();
  const installer = createProjectInstaller({ stateRoot: path.join(temp, 'state'), launchersRoot: path.join(temp, 'launchers') });
  const options = { root, cacheTtlMs: 0, remoteUrlForTests: () => remote, projectInstaller: installer };
  const manager = createLocalRepoManager(options);
  const directory = path.join(root, 'owner', 'local-app');
  const status = async () => (await manager.status([fullName])).repos[0];
  return { temp, seed, manifest, manager, directory, publish, status, options };
}

async function writeSetup(directory, marker) {
  await writeFile(path.join(directory, 'setup.mjs'), `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('node_modules', { recursive: true });
writeFileSync('node_modules/setup-marker', ${JSON.stringify(marker)});
`);
}

test('Install locally downloads source, installs dependencies, and creates a launcher without dirtying Git', async (t) => {
  const f = await fixture(t);
  const result = await f.manager.runAction({ fullName, action: 'install' });
  assert.equal(result.repo.installed, true);
  assert.equal(result.repo.project.ready, true);
  assert.equal(await readFile(path.join(f.directory, 'node_modules/setup-marker'), 'utf8'), 'first');
  assert.ok((await stat(result.repo.project.launcherPath)).mode & 0o111);
  assert.equal(await git(f.directory, 'status', '--porcelain'), '');
  await assert.rejects(stat(path.join(f.directory, 'package-lock.json')), { code: 'ENOENT' });

  f.manifest.version = '1.0.1';
  await writeFile(path.join(f.seed, 'package.json'), JSON.stringify(f.manifest));
  await writeSetup(f.seed, 'second');
  await f.publish();
  const updated = await f.manager.runAction({ fullName, action: 'update-app' });
  assert.equal(updated.repo.project.ready, true);
  assert.equal(await readFile(path.join(f.directory, 'node_modules/setup-marker'), 'utf8'), 'second');
  assert.equal(await git(f.directory, 'status', '--porcelain'), '');

  await writeFile(path.join(f.directory, 'README.md'), 'Unfinished local work');
  await assert.rejects(f.manager.runAction({ fullName, action: 'update-app' }), { statusCode: 409 });
  assert.equal(await readFile(path.join(f.directory, 'README.md'), 'utf8'), 'Unfinished local work');
});

test('failed dependency setup after an update stays unready and can be retried on the local checkout', async (t) => {
  const f = await fixture(t);
  await f.manager.runAction({ fullName, action: 'install' });
  f.manifest.version = '1.0.2';
  f.manifest.scripts.postinstall = 'node -e "process.exit(1)"';
  await writeFile(path.join(f.seed, 'package.json'), JSON.stringify(f.manifest));
  await f.publish();
  await assert.rejects(f.manager.runAction({ fullName, action: 'update-app' }), /Source update completed\. App setup did not finish/);
  assert.equal((await f.status()).project.ready, false);
  assert.equal(await git(f.directory, 'rev-parse', 'HEAD'), await git(f.seed, 'rev-parse', 'HEAD'));

  f.manifest.scripts.postinstall = 'node setup.mjs';
  await writeFile(path.join(f.directory, 'package.json'), JSON.stringify(f.manifest));
  const result = await f.manager.runAction({ fullName, action: 'install' });
  assert.equal(result.repo.project.ready, true);
  assert.equal(result.repo.dirty, true, 'dependency retry preserves the user’s manifest fix');
});

test('unsupported repos remain source downloads instead of being reported as installed apps', async (t) => {
  const f = await fixture(t, { supported: false });
  await assert.rejects(f.manager.runAction({ fullName, action: 'install' }), /Source downloaded/);
  const repo = await f.status();
  assert.equal(repo.installed, true);
  assert.equal(repo.project.supported, false);
  assert.equal(repo.project.ready, false);
  assert.equal(await readFile(path.join(f.directory, 'README.md'), 'utf8'), 'Local app fixture\n');
});

test('app install retains the per-repository lock until dependency setup finishes', async (t) => {
  const f = await fixture(t);
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { entered = resolve; });
  const descriptor = { kind: 'node', supported: true, ready: false, message: 'Waiting for setup' };
  const manager = createLocalRepoManager({ ...f.options, projectInstaller: {
    describe: async () => descriptor,
    install: async () => { entered(); await gate; descriptor.ready = true; return descriptor; }
  } });
  const first = manager.runAction({ fullName, action: 'install' });
  await ready;
  try {
    await assert.rejects(manager.runAction({ fullName, action: 'install' }), /already running/);
    await assert.rejects(manager.runAction({ fullName, action: 'update' }), /already running/);
  } finally { release(); }
  assert.equal((await first).repo.project.ready, true);
});

test('dependency exclusion refuses a symlink and does not modify an outside file', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t);
  await f.manager.runAction({ fullName, action: 'clone' });
  const outside = path.join(f.temp, 'outside.txt');
  await writeFile(outside, 'keep');
  const exclude = path.join(f.directory, '.git/info/exclude');
  await mkdir(path.dirname(exclude), { recursive: true });
  await rm(exclude, { force: true });
  await symlink(outside, exclude);
  await assert.rejects(f.manager.runAction({ fullName, action: 'install' }));
  assert.equal(await readFile(outside, 'utf8'), 'keep');
  await assert.rejects(stat(path.join(f.directory, 'node_modules/setup-marker')), { code: 'ENOENT' });
});
