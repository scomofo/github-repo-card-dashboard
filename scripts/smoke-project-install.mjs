import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const runtimeRoot = path.resolve(process.argv[2] || fileURLToPath(new URL('..', import.meta.url)));
// The optional installer argument exercises the real macOS runtime replacement
// while a project's default setup record and existing launcher remain in use.
const reinstallScript = process.argv[3] ? path.resolve(process.argv[3]) : null;
const { createProjectInstaller } = await import(pathToFileURL(path.join(runtimeRoot, 'src/projectInstall.mjs')));
const scratch = await mkdtemp(path.join(tmpdir(), "repo app's smoke "));
const owner = `repo-smoke-${path.basename(scratch).slice(-6).toLowerCase()}`;
const defaultStateDirectory = path.join(homedir(), 'Library', 'Application Support', 'Repo Dashboard Projects', owner);

try {
  const directory = path.join(scratch, 'source checkout');
  const markers = path.join(scratch, 'markers');
  await Promise.all([mkdir(directory), mkdir(markers)]);
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({
    name: 'repo-dashboard-install-smoke', version: '1.0.0', private: true,
    scripts: { postinstall: 'node install.mjs', start: 'node serve.mjs' },
  }, null, 2));
  await writeFile(path.join(directory, 'install.mjs'), `
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
await writeFile(path.join(process.env.REPO_DASHBOARD_SMOKE_STATE, 'installed'), 'lifecycle ran');
`);
  await writeFile(path.join(directory, 'serve.mjs'), `
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
const server = createServer((_request, response) => response.end('fixture app running'));
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
try {
  const response = await fetch('http://127.0.0.1:' + server.address().port);
  assert.equal(await response.text(), 'fixture app running');
  await writeFile(path.join(process.env.REPO_DASHBOARD_SMOKE_STATE, 'launched'), 'served a request');
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
`);
  const env = { ...process.env, REPO_DASHBOARD_NO_OPEN: '1', REPO_DASHBOARD_SMOKE_STATE: markers };
  const installer = createProjectInstaller({
    ...(reinstallScript ? {} : { stateRoot: path.join(scratch, 'app state') }),
    launchersRoot: path.join(scratch, 'Repo Apps'),
    runtimeRoot,
    env,
  });
  const project = { directory, fullName: `${owner}/local-app` };
  assert.equal((await installer.describe(project)).ready, false);
  const installed = await installer.install(project);
  assert.equal(installed.kind, 'node');
  assert.equal(installed.ready, true);
  assert.equal(installed.script, 'start');
  assert.equal(await readFile(path.join(markers, 'installed'), 'utf8'), 'lifecycle ran');
  assert.ok((await stat(installed.launcherPath)).mode & 0o111, 'Launcher must be executable');
  if (reinstallScript) {
    await execFileAsync('bash', [reinstallScript], { env, timeout: 60_000, maxBuffer: 1024 * 1024 });
    assert.equal((await installer.describe(project)).ready, true, 'Dashboard replacement must preserve installed project state');
  }
  await execFileAsync('bash', [installed.launcherPath], { env, timeout: 20_000, maxBuffer: 256 * 1024 });
  assert.equal(await readFile(path.join(markers, 'launched'), 'utf8'), 'served a request');
  assert.equal((await installer.describe(project)).ready, true);
  await assert.rejects(access(path.join(directory, 'package-lock.json')), { code: 'ENOENT' });
  console.log(`Project smoke passed: dependency lifecycle ran, launcher started the app, and its server answered a request${reinstallScript ? ' after dashboard reinstallation' : ''}.`);
} finally {
  await rm(scratch, { recursive: true, force: true });
  if (reinstallScript) await rm(defaultStateDirectory, { recursive: true, force: true });
}
