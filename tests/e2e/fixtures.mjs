// Hermetic Git fixtures for the Playwright session regression suite.
//
// The dashboard's clone/update flows normally only accept GitHub remotes.
// For tests we point the server's test-only `remoteUrlForTests` seam at tiny
// local bare repositories created here, so the suite never touches the
// network or a real GitHub account.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const GIT_IDENTITY = ['-c', 'user.name=e2e-fixture', '-c', 'user.email=e2e-fixture@example.invalid'];

function git(args, options) {
  return execFileSync('git', [...GIT_IDENTITY, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

// name -> files map for the initial commit of each fixture remote.
const FIXTURE_SOURCES = {
  'fixture-node': {
    'package.json': JSON.stringify({
      name: 'fixture-node',
      version: '1.0.0',
      private: true,
      scripts: { dev: 'node index.js' }
    }, null, 2) + '\n',
    'index.js': 'console.log("fixture-node running");\n'
  },
  'fixture-static': {
    'index.html': '<!doctype html><title>fixture static</title><h1>fixture static</h1>\n'
  },
  'fixture-update': {
    'package.json': JSON.stringify({
      name: 'fixture-update',
      version: '1.0.0',
      private: true,
      scripts: { dev: 'node index.js' }
    }, null, 2) + '\n',
    'index.js': 'console.log("fixture-update v1");\n'
  }
};

export function fixtureNames() {
  return Object.keys(FIXTURE_SOURCES);
}

/** Absolute path of the bare remote the server clones for `e2e-owner/<name>`. */
export function remotePath(fixturesDir, name) {
  return path.join(fixturesDir, 'remotes', `${name}.git`);
}

/** Create every fixture bare remote (with one initial commit on `main`) plus
 * a persistent work clone per remote that tests can advance later. */
export function createFixtures(fixturesDir) {
  rmSync(fixturesDir, { recursive: true, force: true });
  mkdirSync(path.join(fixturesDir, 'remotes'), { recursive: true });
  mkdirSync(path.join(fixturesDir, 'work'), { recursive: true });
  for (const [name, files] of Object.entries(FIXTURE_SOURCES)) {
    const bare = remotePath(fixturesDir, name);
    mkdirSync(bare, { recursive: true });
    git(['init', '--bare', '-b', 'main'], { cwd: bare });
    const work = path.join(fixturesDir, 'work', name);
    git(['clone', '--', bare, work]);
    for (const [file, contents] of Object.entries(files)) {
      writeFileSync(path.join(work, file), contents);
    }
    git(['add', '-A'], { cwd: work });
    git(['commit', '-m', 'initial fixture commit'], { cwd: work });
    git(['push', 'origin', 'main'], { cwd: work });
  }
}

/** Commit `mutate(workdir)` as a new commit on the fixture remote's `main`.
 * Used to simulate an upstream change the dashboard must then pull. */
export function advanceFixture(fixturesDir, name, mutate) {
  const work = path.join(fixturesDir, 'work', name);
  if (!existsSync(work)) throw new Error(`Fixture work clone missing for ${name}; run global setup first.`);
  mutate(work);
  git(['add', '-A'], { cwd: work });
  git(['commit', '-m', 'upstream change for session regression'], { cwd: work });
  git(['push', 'origin', 'main'], { cwd: work });
}

