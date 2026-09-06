import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createProjectInstaller } from '../src/projectInstall.mjs';
import { loopbackUrl, serveStaticProject } from '../scripts/project-launcher.mjs';

const exec = promisify(execFile);
const fullName = 'owner/demo';

async function fixture(t, manifest, options = {}) {
  const temp = await mkdtemp(path.join(tmpdir(), "repo-app-'quoted-space-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const directory = path.join(temp, "checkouts $() `literal`", 'repo');
  await mkdir(directory, { recursive: true });
  const stateRoot = path.join(temp, 'private state');
  const launchersRoot = path.join(temp, 'Repo Apps');
  const env = { ...process.env, REPO_DASHBOARD_NO_OPEN: '1', APP_TEST_ROOT: temp };
  const installer = createProjectInstaller({ stateRoot, launchersRoot, env, ...options });
  const input = { directory, fullName };
  const writeManifest = (value) => writeFile(path.join(directory, 'package.json'), JSON.stringify(value));
  if (manifest) await writeManifest(manifest);
  return { temp, directory, stateRoot, launchersRoot, env, installer, input, writeManifest,
    describe: () => installer.describe(input), install: () => installer.install(input) };
}

test('npm setup runs lifecycle scripts, creates a runnable launcher, and leaves source manifests/lockfiles alone', async (t) => {
  const manifest = { name: 'local-app', version: '1.0.0', private: true, scripts: { postinstall: 'node setup.cjs', dev: 'node app.cjs', start: 'node should-not-run.cjs' } };
  const f = await fixture(t, manifest);
  await writeFile(path.join(f.directory, 'setup.cjs'), "require('node:fs').writeFileSync(require('node:path').join(process.env.APP_TEST_ROOT, 'setup-ran'), 'yes')");
  await writeFile(path.join(f.directory, 'app.cjs'), "require('node:fs').writeFileSync(require('node:path').join(process.env.APP_TEST_ROOT, 'app-ran'), 'yes')");
  const before = await f.describe();
  assert.equal(before.kind, 'node');
  assert.equal(before.ready, false);
  assert.equal(before.script, 'dev');
  await assert.rejects(readFile(path.join(f.temp, 'setup-ran')), { code: 'ENOENT' });
  const result = await f.install();
  assert.equal(result.ready, true);
  assert.equal(await readFile(path.join(f.temp, 'setup-ran'), 'utf8'), 'yes');
  assert.ok((await stat(result.launcherPath)).mode & 0o100);
  assert.equal(await readFile(path.join(f.directory, 'package.json'), 'utf8'), JSON.stringify(manifest));
  await assert.rejects(readFile(path.join(f.directory, 'package-lock.json')), { code: 'ENOENT' });
  assert.ok(result.launcherPath.startsWith(f.launchersRoot));
  await exec('bash', [result.launcherPath], { env: f.env });
  assert.equal(await readFile(path.join(f.temp, 'app-ran'), 'utf8'), 'yes');
  assert.equal((await f.installer.launch(f.input)).ready, true);
});

test('locked npm projects use ci without rewriting the lock; start-only projects build before they become ready', async (t) => {
  const f = await fixture(t, { name: 'local-app', version: '1.0.0', scripts: { start: 'node app.cjs', build: 'node build.cjs' } });
  await writeFile(path.join(f.directory, 'build.cjs'), "require('node:fs').writeFileSync(require('node:path').join(process.env.APP_TEST_ROOT, 'built'), 'yes')");
  await writeFile(path.join(f.directory, 'app.cjs'), "if (require('node:fs').readFileSync(require('node:path').join(process.env.APP_TEST_ROOT, 'built'), 'utf8') !== 'yes') process.exit(1)");
  await exec('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: f.directory });
  const original = await readFile(path.join(f.directory, 'package-lock.json'), 'utf8');
  const result = await f.install();
  assert.equal(result.ready, true);
  assert.equal(await readFile(path.join(f.directory, 'package-lock.json'), 'utf8'), original);
  assert.equal(await readFile(path.join(f.temp, 'built'), 'utf8'), 'yes');
  const log = await readFile(path.join(f.stateRoot, 'owner/demo.install.log'), 'utf8');
  assert.match(log, /^npm ci /);
  assert.match(log, /npm run build/);
  await exec('bash', [result.launcherPath], { env: f.env });
});

test('a failed repair invalidates prior readiness and returns no subprocess secrets', async (t) => {
  const f = await fixture(t, { name: 'local-app', version: '1.0.0', scripts: { start: 'node app.cjs', postinstall: 'node setup.cjs' } });
  await writeFile(path.join(f.directory, 'setup.cjs'), "if (require('node:fs').existsSync(require('node:path').join(process.env.APP_TEST_ROOT, 'fail'))) { console.error('private-test-token'); process.exit(3); }");
  assert.equal((await f.install()).ready, true);
  await writeFile(path.join(f.temp, 'fail'), 'yes');
  await assert.rejects(f.install(), (error) => {
    assert.equal(error.statusCode, 502);
    assert.match(error.message, /Dependency installation failed/);
    assert.doesNotMatch(error.message, /private-test-token/);
    return true;
  });
  assert.equal((await f.describe()).ready, false);
  await assert.rejects(f.installer.launch(f.input), { statusCode: 409 });
});

test('manifest changes and removed dependencies require a fresh install', async (t) => {
  const f = await fixture(t, { name: 'local-app', version: '1.0.0', dependencies: { helper: 'file:./helper' }, scripts: { dev: 'node app.cjs' } });
  await mkdir(path.join(f.directory, 'helper'));
  await writeFile(path.join(f.directory, 'helper/package.json'), JSON.stringify({ name: 'helper', version: '1.0.0' }));
  assert.equal((await f.install()).ready, true);
  await rm(path.join(f.directory, 'node_modules'), { recursive: true });
  assert.equal((await f.describe()).ready, false);
  assert.equal((await f.install()).ready, true);
  await f.writeManifest({ name: 'local-app', version: '2.0.0', scripts: { dev: 'node changed.cjs' } });
  assert.equal((await f.describe()).ready, false);
  const oldLauncher = path.join(f.launchersRoot, 'owner/demo.command');
  await assert.rejects(exec('bash', [oldLauncher], { env: f.env }), /Project setup has changed/);
});

test('unsupported and ambiguous projects never claim an installed app', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.install()).supported, false);
  await f.writeManifest({ scripts: { test: 'echo tests-only' } });
  assert.equal((await f.describe()).supported, false);
  await f.writeManifest({ scripts: { start: 'node app.js' } });
  await writeFile(path.join(f.directory, 'yarn.lock'), '# yarn lock');
  await writeFile(path.join(f.directory, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  assert.match((await f.describe()).message, /Several package managers/);
  await f.writeManifest({ packageManager: 'pnpm@10.0.0', scripts: { start: 'node app.js' } });
  assert.equal((await f.describe()).manager, 'pnpm');
  await f.writeManifest({ packageManager: 'something@1.0.0', scripts: { start: 'node app.js' } });
  assert.equal((await f.install()).ready, false);
});

test('missing package manager gives a retryable setup error without installing a global tool', async (t) => {
  const f = await fixture(t, { packageManager: 'pnpm@10.0.0', scripts: { dev: 'node app.js' } }, { env: { PATH: '/not-a-real-package-manager-folder', REPO_DASHBOARD_NO_OPEN: '1' } });
  await assert.rejects(f.install(), (error) => error.statusCode === 503 && /pnpm is required/.test(error.message));
  assert.equal((await f.describe()).ready, false);
});

test('setup refuses symlink/file node_modules and unrelated empty launcher files', async (t) => {
  const f = await fixture(t, { scripts: { dev: 'node app.js' } });
  const outside = path.join(f.temp, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'keep.txt'), 'keep');
  await symlink(outside, path.join(f.directory, 'node_modules'));
  assert.equal((await f.install()).supported, false);
  assert.match((await f.describe()).message, /node_modules is a symlink/);
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  await rm(path.join(f.directory, 'node_modules'));
  await writeFile(path.join(f.directory, 'node_modules'), 'not a directory');
  assert.equal((await f.install()).ready, false);
  await rm(path.join(f.directory, 'node_modules'));
  await mkdir(path.join(f.launchersRoot, 'owner'), { recursive: true });
  const launcher = path.join(f.launchersRoot, 'owner/demo.command');
  await writeFile(launcher, '');
  await assert.rejects(f.install(), /different file already uses this launcher name/);
  assert.equal(await readFile(launcher, 'utf8'), '');
});

test('setup refuses symlinks at state and launcher output boundaries', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'index.html'), '<h1>Static</h1>');
  const outside = path.join(f.temp, 'outside');
  await mkdir(outside);
  await symlink(outside, f.stateRoot);
  await assert.rejects(f.install(), /symlink/);
  await rm(f.stateRoot);
  await mkdir(f.stateRoot);
  await symlink(outside, path.join(f.stateRoot, 'owner'));
  await assert.rejects(f.install(), /symlink/);
  await rm(path.join(f.stateRoot, 'owner'));
  await symlink(outside, f.launchersRoot);
  await assert.rejects(f.install(), /symlink/);
  await rm(f.launchersRoot);
  await mkdir(f.launchersRoot);
  await symlink(outside, path.join(f.launchersRoot, 'owner'));
  await assert.rejects(f.install(), /symlink/);
  await assert.rejects(readFile(path.join(outside, 'demo.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(outside, 'demo.command')), { code: 'ENOENT' });
});

test('static projects install a local launcher and serve HTML without exposing dotfiles or symlink escapes', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'index.html'), '<h1>My local app</h1>');
  await writeFile(path.join(f.directory, '.env'), 'PRIVATE=value');
  await writeFile(path.join(f.temp, 'outside.txt'), 'outside');
  await symlink(path.join(f.temp, 'outside.txt'), path.join(f.directory, 'outside.txt'));
  await symlink(path.join(f.directory, '.env'), path.join(f.directory, 'hidden-alias.txt'));
  const result = await f.install();
  assert.equal(result.kind, 'static');
  assert.equal(result.ready, true);
  let opened;
  const { server, url } = await serveStaticProject(f.directory, { open: (value) => { opened = value; } });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal(opened, url);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<h1>My local app</h1>');
  assert.equal((await fetch(`${url}.env`)).status, 404);
  assert.equal((await fetch(`${url}%2eenv`)).status, 404);
  assert.equal((await fetch(`${url}outside.txt`)).status, 404);
  assert.equal((await fetch(`${url}hidden-alias.txt`)).status, 404);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    http.get(url, { headers: { Host: 'evil.example' } }, (response) => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  assert.equal((await fetch(url, { method: 'HEAD' })).status, 200);
});

test('launcher browser detection accepts only loopback URLs without embedded credentials', () => {
  assert.equal(loopbackUrl('Local: \u001b[32mhttp://localhost:5173/\u001b[0m\n'), 'http://localhost:5173/');
  assert.equal(loopbackUrl('http://127.0.0.1:8080/path\n'), 'http://127.0.0.1:8080/path');
  assert.equal(loopbackUrl('https://evil.example/ http://localhost.evil.example/ http://password@localhost:8080/'), null);
});

test('closing the launcher Terminal forwards SIGHUP to the running app', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t, { name: 'local-app', version: '1.0.0', scripts: { dev: 'node app.cjs' } });
  const startedPath = path.join(f.temp, 'app-started');
  const stoppedPath = path.join(f.temp, 'app-stopped');
  await writeFile(path.join(f.directory, 'app.cjs'), `const fs = require('node:fs'); process.on('SIGHUP', () => { fs.writeFileSync(${JSON.stringify(stoppedPath)}, 'yes'); process.exit(0); }); fs.writeFileSync(${JSON.stringify(startedPath)}, String(process.pid)); setInterval(() => {}, 1000);`);
  const result = await f.install();
  const launcher = spawn('bash', [result.launcherPath], { env: f.env, stdio: 'ignore' });
  const exited = new Promise((resolve, reject) => { launcher.once('close', resolve); launcher.once('error', reject); });
  let appPid;
  t.after(() => { launcher.kill('SIGKILL'); if (appPid) { try { process.kill(appPid, 'SIGKILL'); } catch { /* Already stopped. */ } } });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !appPid) {
    appPid = Number(await readFile(startedPath, 'utf8').catch(() => ''));
    if (!appPid) await delay(25);
  }
  assert.ok(appPid, 'fixture app started before closing its Terminal');
  launcher.kill('SIGHUP');
  await Promise.race([exited, delay(5000, undefined, { ref: false }).then(() => { throw new Error('Launcher did not exit after SIGHUP.'); })]);
  assert.equal(await readFile(stoppedPath, 'utf8'), 'yes');
});

test('setup timeouts stop lifecycle descendants and leave the app unready', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t, { scripts: { dev: 'node app.js' } });
  const bin = path.join(f.temp, 'bin');
  await mkdir(bin);
  const marker = path.join(f.temp, 'survived');
  const pidFile = path.join(f.temp, 'installer-pid');
  const childCode = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'), 1000)`;
  await writeFile(path.join(bin, 'npm'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {stdio: 'ignore'}); setTimeout(() => {}, 5000);\n`);
  await chmod(path.join(bin, 'npm'), 0o700);
  const installer = createProjectInstaller({ stateRoot: f.stateRoot, launchersRoot: f.launchersRoot, env: { ...f.env, PATH: `${bin}${path.delimiter}${f.env.PATH}` }, timeoutMs: 250 });
  await assert.rejects(installer.install(f.input), { statusCode: 504 });
  const installerPid = Number(await readFile(pidFile, 'utf8'));
  assert.throws(() => process.kill(installerPid, 0), { code: 'ESRCH' }, 'the direct installer has exited before its repository lock is released');
  assert.equal((await installer.describe(f.input)).ready, false);
  await delay(1100);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});
