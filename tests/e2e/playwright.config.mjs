// Playwright configuration for the dashboard session regression suite.
import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(e2eDir, 'fixtures');

export default defineConfig({
  testDir: e2eDir,
  testMatch: ['session.spec.mjs'],
  // Git-heavy flows (clone, npm install, fetch) can take a while on CI.
  timeout: 180_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  globalSetup: path.join(e2eDir, 'global-setup.mjs'),
  webServer: {
    command: `node ${path.join(e2eDir, 'serve.mjs')}`,
    url: 'http://127.0.0.1:8787/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
    env: { E2E_FIXTURES_DIR: fixturesDir }
  },
  use: {
    baseURL: 'http://127.0.0.1:8787'
  }
});
