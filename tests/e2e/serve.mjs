// Hermetic dashboard server for the Playwright session regression suite.
//
// Starts the real dashboard server with the real local-repo manager, but:
// - checkouts, install state, launchers, and diagnostics live in a fresh
//   temp directory (HOME is redirected so launcher/state roots stay hermetic)
// - the test-only `remoteUrlForTests` seam points clones at the local fixture
//   Git repositories built by global setup, never at real GitHub remotes
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDashboardServer } from '../../server.mjs';
import { createLocalRepoManager } from '../../src/localRepos.mjs';
import { createProjectInstaller } from '../../src/projectInstall.mjs';

const fixturesDir = process.env.E2E_FIXTURES_DIR;
if (!fixturesDir) throw new Error('E2E_FIXTURES_DIR must point at the fixture directory.');

const runRoot = mkdtempSync(path.join(tmpdir(), 'repo-dashboard-e2e-'));
// Redirect launcher/state roots (~/Applications/Repo Apps, ~/Library/…) into
// the temp run directory so the suite never touches the real home folder.
process.env.HOME = runRoot;
process.env.USERPROFILE = runRoot;

const localManager = createLocalRepoManager({
  root: path.join(runRoot, 'checkouts'),
  diagnosticsRoot: path.join(runRoot, 'diagnostics'),
  remoteUrlForTests: (fullName) => path.join(fixturesDir, 'remotes', `${fullName.split('/')[1]}.git`),
  projectInstaller: createProjectInstaller()
});

const server = createDashboardServer({ localManager });
const port = Number(process.env.E2E_PORT || 8787);
server.listen(port, '127.0.0.1', () => {
  console.log(`session regression server listening on 127.0.0.1:${port} (run root ${runRoot})`);
});
process.once('SIGTERM', () => server.close(() => process.exit(0)));
process.once('SIGINT', () => server.close(() => process.exit(0)));
