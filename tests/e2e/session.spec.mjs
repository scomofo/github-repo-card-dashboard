// Session regression suite for the repo-card dashboard.
//
// Covers a full browser session against the real server with hermetic
// fixtures: server health, dashboard page load, repository card rendering,
// and the double-click clone/install/update flows. GitHub API traffic is
// intercepted (see github-fixtures.mjs) and Git remotes are tiny local
// fixture repositories (see fixtures.mjs), so the suite never touches the
// network or a real GitHub account.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { graphqlResponse, actionsRunsResponse } from './github-fixtures.mjs';
import { advanceFixture } from './fixtures.mjs';

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(e2eDir, 'fixtures');

const NODE_REPO = 'e2e-owner/fixture-node';
const STATIC_REPO = 'e2e-owner/fixture-static';
const UPDATE_REPO = 'e2e-owner/fixture-update';

test.beforeEach(async ({ page }) => {
  // Seed a token so the dashboard skips the token panel and loads data.
  await page.addInitScript(() => {
    localStorage.setItem('repoDashboard.githubToken', 'e2e-fake-token');
  });
  await page.route('https://api.github.com/graphql', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(graphqlResponse())
    })
  );
  await page.route('https://api.github.com/repos/*/actions/runs*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(actionsRunsResponse())
    })
  );
});

test('server health reports ok with a session token', async ({ page }) => {
  await page.goto('/');
  const body = await page.evaluate(async () => {
    const response = await fetch('/api/health', { cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  });
  expect(body.status).toBe(200);
  expect(body.body.ok).toBe(true);
  expect(body.body.app).toBe('repo-dashboard');
  expect(body.body.localRepos).toBe(true);
  expect(body.body.projectInstall).toBe(true);
  expect(typeof body.body.csrfToken).toBe('string');
  expect(body.body.csrfToken.length).toBeGreaterThan(0);
});

test('local API rejects requests without the session token', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const response = await fetch('/api/local/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repos: [] })
    });
    return { status: response.status, body: await response.json() };
  });
  expect(result.status).toBe(403);
  expect(result.body.code).toBe('SESSION_EXPIRED');
});

test('dashboard loads and renders a card per fixture repository', async ({ page }) => {
  await page.goto('/');
  for (const fullName of [NODE_REPO, STATIC_REPO, UPDATE_REPO]) {
    const card = page.locator(`#allGrid article.card[data-repo="${fullName}"]`);
    await expect(card).toBeVisible();
    // The local-status scan finishes without a checkout on disk.
    await expect(card.getByText('Not downloaded')).toBeVisible();
  }
});

test('double-clicking a card clones and installs the Node app', async ({ page }) => {
  await page.goto('/');
  const card = page.locator(`#allGrid article.card[data-repo="${NODE_REPO}"]`);
  await expect(card.getByText('Not downloaded')).toBeVisible();

  // Double-click the card body (not a link or button) to trigger the
  // primary local action: clone + install.
  await card.locator('p.description').dblclick();

  await expect(card.getByText('App ready · clean')).toBeVisible({ timeout: 120_000 });
  await expect(
    page.locator('#localResults li.success', { hasText: `Installed ${NODE_REPO} locally` })
  ).toBeVisible();
});

test('double-clicking a card clones and installs the static site', async ({ page }) => {
  await page.goto('/');
  const card = page.locator(`#allGrid article.card[data-repo="${STATIC_REPO}"]`);
  await expect(card.getByText('Not downloaded')).toBeVisible();

  await card.locator('p.description').dblclick();

  await expect(card.getByText('App ready · clean')).toBeVisible({ timeout: 120_000 });
  await expect(
    page.locator('#localResults li.success', { hasText: `Installed ${STATIC_REPO} locally` })
  ).toBeVisible();
});

test('double-clicking an installed app pulls and reinstalls when the remote advances', async ({ page }) => {
  await page.goto('/');
  const card = page.locator(`#allGrid article.card[data-repo="${UPDATE_REPO}"]`);
  await expect(card.getByText('Not downloaded')).toBeVisible();

  // First double-click: clone + install.
  await card.locator('p.description').dblclick();
  await expect(card.getByText('App ready · clean')).toBeVisible({ timeout: 120_000 });

  // Simulate an upstream change landing on the fixture remote.
  advanceFixture(fixturesDir, 'fixture-update', (workdir) => {
    appendFileSync(path.join(workdir, 'index.js'), 'console.log("fixture-update v2");\n');
  });

  // Second double-click: the app is installed, so this updates + reinstalls.
  await card.locator('p.description').dblclick();
  await expect(
    page.locator('#localResults li.success', { hasText: `Updated ${UPDATE_REPO} with a fast-forward` })
  ).toBeVisible({ timeout: 120_000 });
  await expect(card.getByText('App ready · clean')).toBeVisible({ timeout: 120_000 });
});
