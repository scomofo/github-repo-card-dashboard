import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^    init\(\);$/m, '');

class Element {
  constructor() {
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.disabled = false;
    this.innerHTML = '';
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const enabled = force ?? !classes.has(name);
        if (enabled) classes.add(name);
        else classes.delete(name);
        return enabled;
      }
    };
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  appendChild(child) { child.parent = this; this.children.push(child); }
  replaceChildren() { this.children = []; this._text = ''; }
  get firstElementChild() { return this.children[0]; }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  set textContent(value) { this._text = value; }
  get textContent() { return this._text || this.children.map((child) => child.textContent).join('\n'); }
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function checkout(fullName, state = 'ready', overrides = {}) {
  return {
    fullName, path: `/Users/scott/Repos/${fullName}`, installed: state !== 'not-installed',
    state, branch: 'main', dirty: state === 'dirty', ahead: 0, behind: state === 'behind' ? 1 : 0,
    message: '', ...overrides
  };
}

function harness(fetch, { protocol = 'http:' } = {}) {
  const elements = new Map();
  const document = {
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    querySelectorAll: () => [],
    createElement: () => new Element()
  };
  const context = vm.createContext({
    document, fetch, location: { protocol },
    window: { matchMedia: () => ({ matches: false }) },
    console, setTimeout, clearTimeout, setInterval, clearInterval
  });
  vm.runInContext(`${script}\nglobalThis.dashboardTest = { state, els, runLocalAction, updateInstalledRepos, checkServer, renderLocalRepo, renderLocalPanel, readLocalStatus };`, context);
  const api = context.dashboardTest;
  api.state.server = { checked: true, online: true, localRepos: true, csrfToken: 'local-session-secret', platform: 'darwin', openai: false, model: '' };
  api.state.local.gitAvailable = true;
  api.state.local.scanned = true;
  api.state.token = 'github-browser-token-must-not-be-sent';
  api.setRepos = (statuses) => {
    api.state.repos = statuses.map((local) => ({
      fullName: local.fullName, owner: local.fullName.split('/')[0],
      attention: { score: 0 }, workflow: { status: 'none' }, topics: []
    }));
    statuses.forEach((local) => api.state.local.repos.set(local.fullName, local));
  };
  return api;
}

test('a repeated clone request executes once and keeps the browser token out of local requests', async () => {
  const requests = [];
  let finishClone;
  const cloned = checkout('scott/music');
  const api = harness(async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, options, body });
    if (url.endsWith('/action')) return await new Promise((resolve) => { finishClone = resolve; });
    return response({ root: '/Users/scott/Repos', gitAvailable: true, repos: [cloned] });
  });
  api.setRepos([checkout('scott/music', 'not-installed')]);

  const first = api.runLocalAction('scott/music', 'clone');
  assert.equal(api.state.local.pending.has('scott/music'), true);
  assert.equal(await api.runLocalAction('scott/music', 'clone'), false);
  assert.equal(requests.length, 1);
  const busyButtons = api.renderLocalRepo('scott/music').match(/<button\b[^>]*>/g);
  assert.ok(busyButtons.every((button) => /\bdisabled\b/.test(button)));

  finishClone(response({ message: 'Source code cloned.', repo: cloned }));
  assert.equal(await first, true);
  assert.equal(requests.filter((request) => request.url.endsWith('/action')).length, 1);
  assert.equal(api.state.local.pending.size, 0);
  assert.equal(api.state.local.repos.get('scott/music').installed, true);
  assert.match(api.els.localResults.textContent, /Source code cloned/);
  for (const request of requests) {
    assert.equal(request.options.headers['X-Repo-Dashboard-Token'], 'local-session-secret');
    assert.equal(request.options.credentials, 'same-origin');
    assert.equal(request.body.githubToken, undefined);
    assert.ok(!request.options.body.includes(api.state.token));
  }
});

test('bulk update skips local edits and divergence, remains sequential, and continues after Git auth fails', async () => {
  const statuses = [checkout('scott/private'), checkout('scott/edited', 'dirty'),
    checkout('scott/conflict', 'diverged', { ahead: 2, behind: 1 }), checkout('scott/healthy', 'behind')];
  const actions = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const api = harness(async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/status')) return response({ root: '/Users/scott/Repos', gitAvailable: true,
      repos: statuses.filter((repo) => body.repos.includes(repo.fullName)) });
    actions.push(body);
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await Promise.resolve();
    concurrent--;
    return body.fullName === 'scott/private'
      ? response({ error: 'Git authentication failed. Run gh auth login and gh auth setup-git.' }, 403)
      : response({ message: 'Updated successfully.', repo: checkout(body.fullName) });
  });
  api.setRepos(statuses);
  await api.updateInstalledRepos();

  assert.deepEqual(actions.map((action) => action.fullName), ['scott/private', 'scott/healthy']);
  assert.ok(actions.every((action) => action.action === 'update' && action.githubToken === undefined));
  assert.equal(maxConcurrent, 1);
  assert.equal(api.state.server.localRepos, true);
  assert.equal(api.state.local.bulk, false);
  assert.match(api.els.localResults.textContent, /scott\/edited: Skipped/);
  assert.match(api.els.localResults.textContent, /scott\/conflict: Skipped/);
  assert.match(api.els.localResults.textContent, /gh auth login/);
  assert.match(api.els.localResults.textContent, /scott\/healthy: Updated successfully/);
  assert.match(api.els.localProgress.textContent, /1 checked successfully, 1 failed, 2 skipped/);
});

test('an expired local session stops the bulk queue and offers reconnection', async () => {
  const statuses = [checkout('scott/first'), checkout('scott/second')];
  const actions = [];
  const api = harness(async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/status')) return response({ root: '/Users/scott/Repos', gitAvailable: true, repos: statuses });
    actions.push(body.fullName);
    return response({ error: 'Invalid session token.', code: 'SESSION_EXPIRED' }, 403);
  });
  api.setRepos(statuses);
  await api.updateInstalledRepos();

  assert.deepEqual(actions, ['scott/first']);
  assert.equal(api.state.server.localRepos, false);
  assert.equal(api.els.localUpdateAll.disabled, true);
  assert.equal(api.els.localReconnect.classList.contains('hidden'), false);
  assert.match(api.els.localResults.textContent, /session expired/);
  assert.match(api.els.localProgress.textContent, /0 checked successfully, 1 failed, 1 skipped/);
});

test('opening the HTML file directly shows launcher instructions and disables local actions', async () => {
  let calls = 0;
  const api = harness(async () => { calls++; throw new Error('Unexpected request'); }, { protocol: 'file:' });
  api.setRepos([checkout('scott/music', 'not-installed')]);
  await api.checkServer();

  assert.equal(calls, 0);
  assert.equal(api.state.server.online, false);
  assert.equal(api.els.localScan.disabled, true);
  assert.equal(api.els.localUpdateAll.disabled, true);
  assert.equal(api.els.localLauncher.classList.contains('hidden'), false);
  const buttons = api.renderLocalRepo('scott/music').match(/<button\b[^>]*>/g);
  assert.ok(buttons.length > 0 && buttons.every((button) => /\bdisabled\b/.test(button)));
  assert.match(html, /install-macos\.command/);
  assert.match(html, /launch-dashboard\.command/);
});

test('local repository paths, branch names, and error messages render as text', () => {
  const api = harness(async () => { throw new Error('Unexpected request'); });
  api.setRepos([checkout('scott/music', 'dirty', {
    path: '/Users/scott/<img src=x onerror=alert(1)>',
    branch: '<script>alert(1)</script>',
    message: 'Local edits: <img src=x onerror=alert(2)> & "important"'
  })]);
  const rendered = api.renderLocalRepo('scott/music', true);
  assert.ok(!rendered.includes('<img'));
  assert.ok(!rendered.includes('<script>'));
  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(rendered, /&amp; &quot;important&quot;/);
});

test('large account scans batch requests and retain status for every repository', async () => {
  const requests = [];
  const api = harness(async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body.repos);
    return response({ root: '/Users/scott/Repos', gitAvailable: true, repos: body.repos.map((name) => checkout(name)) });
  });
  const names = Array.from({ length: 101 }, (_, index) => `scott/repo-${index}`);
  const statuses = await api.readLocalStatus(names);
  assert.deepEqual(requests.map((names) => names.length), [100, 1]);
  assert.equal(statuses.length, 101);
  assert.equal(api.state.local.repos.size, 101);
  assert.equal(api.state.local.root, '/Users/scott/Repos');
});
