import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDashboardServer } from '../server.mjs';

async function fixture(t) {
  const calls = [];
  const server = createDashboardServer({ localManager: {
    async status(repos) { calls.push({ repos }); return { root: '/test/repos', gitAvailable: true, repos: [] }; },
    async runAction(input) {
      calls.push(input);
      if (input.fullName === 'owner/dirty') throw Object.assign(new Error('Save your local changes first.'), { statusCode: 409 });
      return { message: 'Cloned.' };
    }
  } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/api/health`).then((res) => res.json());
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Repo-Dashboard-Token': health.csrfToken, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
  return { calls, port, base, health, post };
}

test('health identifies the app and local actions require the server session token', async (t) => {
  const f = await fixture(t);
  assert.equal(f.health.app, 'repo-dashboard');
  assert.equal(f.health.localRepos, true);
  assert.match(f.health.csrfToken, /^[a-f0-9]{64}$/);
  const rejected = await f.post('/api/local/action', { fullName: 'owner/repo', action: 'clone' }, { 'X-Repo-Dashboard-Token': '' });
  assert.equal(rejected.status, 403);
  assert.equal(f.calls.length, 0);
  const accepted = await f.post('/api/local/action', { fullName: 'owner/repo', action: 'clone', githubToken: 'do-not-forward', path: '/outside' });
  assert.equal(accepted.status, 200);
  assert.deepEqual(f.calls, [{ fullName: 'owner/repo', action: 'clone' }]);
});

test('foreign origins and DNS rebinding hosts cannot read health or run actions', async (t) => {
  const f = await fixture(t);
  for (const headers of [{ Origin: 'https://example.com' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await f.post('/api/local/status', { repos: [] }, headers)).status, 403);
  }
  const status = await new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: f.port, path: '/api/health', headers: { Host: `attacker.example:${f.port}` } }, (res) => {
      res.resume(); resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 403);
  assert.equal(f.calls.length, 0);
});

test('local API rejects malformed requests, unsafe media types and unsupported methods', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/local/action', '{')).status, 400);
  assert.equal((await f.post('/api/local/action', 'null')).status, 400);
  assert.equal((await f.post('/api/local/action', '[]')).status, 400);
  assert.equal((await f.post('/api/local/action', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await fetch(`${f.base}/api/local/action`)).status, 405);
  assert.equal((await f.post('/api/local/missing', {})).status, 404);
  assert.equal((await f.post('/api/local/action', JSON.stringify({ text: 'x'.repeat(2 * 1024 * 1024) }))).status, 413);
  assert.equal(f.calls.length, 0);
});

test('local status is returned and actionable Git conflicts keep their safe message', async (t) => {
  const f = await fixture(t);
  const status = await f.post('/api/local/status', { repos: ['owner/repo'] });
  assert.deepEqual(await status.json(), { root: '/test/repos', gitAvailable: true, repos: [] });
  const conflict = await f.post('/api/local/action', { fullName: 'owner/dirty', action: 'update' });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: 'Save your local changes first.' });
});

test('only public dashboard assets are served, with no caching of the session secret', async (t) => {
  const f = await fixture(t);
  const page = await fetch(f.base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Repo Dashboard/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  for (const path of ['/.git/config', '/server.mjs', '/src/localRepos.mjs', '/package.json', '/%2e%2e/server.mjs']) {
    assert.equal((await fetch(`${f.base}${path}`)).status, 404, path);
  }
  const health = await fetch(`${f.base}/api/health`);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal(health.headers.get('access-control-allow-origin'), null);
});

test('existing read-only chat still works without an AI key', async (t) => {
  if (process.env.OPENAI_API_KEY) return t.skip('Avoid live AI calls in tests.');
  const f = await fixture(t);
  const response = await f.post('/chat', { message: 'overview', repos: [], githubToken: '' });
  assert.equal(response.status, 200);
  assert.match((await response.json()).text, /not loaded any repositories/);
});
