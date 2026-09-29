// Playwright global setup: build the hermetic Git fixtures before any test
// (or the webServer) starts.
import { createFixtures } from './fixtures.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default async function globalSetup() {
  const e2eDir = path.dirname(fileURLToPath(import.meta.url));
  createFixtures(path.join(e2eDir, 'fixtures'));
}
