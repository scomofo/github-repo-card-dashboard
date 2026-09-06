import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createProjectInstaller, ProjectInstallError } from './projectInstall.mjs';
const ACTIONS = new Set(['clone', 'update', 'open', 'terminal', 'install', 'update-app', 'launch']);

function execBounded(file, args, options) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    const sizes = { stdout: 0, stderr: 0 };
    let failure;
    let settled = false;
    const child = spawn(file, args, {
      cwd: options.cwd, env: options.env, windowsHide: options.windowsHide,
      detached: process.platform !== 'win32', shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stop = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // If a process group has already exited or is unavailable, still stop
        // the direct child. POSIX detached groups include SSH/helper children.
        try { child.kill('SIGKILL'); } catch { /* Already exited. */ }
      }
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = {
        stdout: Buffer.concat(stdout).toString(options.encoding || 'utf8'),
        stderr: Buffer.concat(stderr).toString(options.encoding || 'utf8'),
      };
      if (error) {
        stop();
        error.stderr = output.stderr;
        reject(error);
      } else resolve(output);
    };
    const abort = (error) => {
      failure ||= error;
      stop();
      // A descendant can inherit a pipe, or deliberately detach itself. Closing
      // our streams ensures it cannot keep the action waiting after Git exits.
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const collect = (name, chunks, chunk) => {
      if (failure) return;
      const remaining = options.maxBuffer - sizes[name];
      if (chunk.length > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        abort(Object.assign(new Error('Git output exceeded its limit.'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
      } else {
        sizes[name] += chunk.length;
        chunks.push(chunk);
      }
    };
    child.stdout.on('data', (chunk) => collect('stdout', stdout, chunk));
    child.stderr.on('data', (chunk) => collect('stderr', stderr, chunk));
    child.once('error', (error) => finish(failure || error));
    child.once('close', (code, signal) => {
      finish(failure || (code === 0 ? null : Object.assign(new Error('Git exited unsuccessfully.'), { code, signal })));
    });
    const timer = setTimeout(() => {
      abort(Object.assign(new Error('Git operation timed out.'), { code: 'ETIMEDOUT' }));
    }, options.timeout);
    timer.unref();
  });
}

export class LocalRepoError extends Error {
  constructor(message, statusCode = 409) {
    super(message);
    this.name = 'LocalRepoError';
    this.statusCode = statusCode;
  }
}

function validateFullName(value) {
  if (typeof value !== 'string' || value.length > 140) {
    throw new LocalRepoError('Choose a repository using its GitHub owner/name.', 400);
  }
  const parts = value.split('/');
  const [owner, name] = parts;
  if (parts.length !== 2 || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner)
    || !/^[a-z\d_.-]{1,100}$/i.test(name) || name === '.' || name === '..' || name.toLowerCase() === '.git') {
    throw new LocalRepoError('Choose a repository using its GitHub owner/name.', 400);
  }
  return value;
}

function githubName(url) {
  const scp = /^git@github\.com:([a-z\d_.-]+\/[a-z\d_.-]+?)(?:\.git)?\/?$/i.exec(url);
  if (scp) return scp[1].toLowerCase();
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'github.com' || parsed.port || parsed.password || parsed.search || parsed.hash) return null;
    if (parsed.protocol === 'https:' && parsed.username) return null;
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'ssh:' && parsed.username === 'git')) return null;
    const match = /^\/([a-z\d_.-]+\/[a-z\d_.-]+?)(?:\.git)?\/?$/i.exec(parsed.pathname);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

async function existingDirectory(directory) {
  try {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new LocalRepoError('This location is a symlink or is not a folder. Choose a regular repository folder.');
    }
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function safeFailure(error) {
  if (error instanceof LocalRepoError) return error;
  if (error.code === 'ENOENT') return new LocalRepoError('Git is unavailable. Install the macOS Command Line Tools with xcode-select --install, then reopen the dashboard.', 503);
  if (error.killed || error.code === 'ETIMEDOUT') return new LocalRepoError('The Git operation timed out. Check your connection and try again.', 504);
  // Inspect diagnostics for classification only. Never return subprocess output, command lines,
  // or credential helper output: those can contain private URLs or credentials.
  if (/authentication failed|could not read username|permission denied|repository not found|terminal prompts disabled/i.test(error.stderr || '')) {
    return new LocalRepoError('Git could not access this repository. Sign in to Git using GitHub CLI (gh auth login, then gh auth setup-git) or your macOS Git credential helper, then retry. The dashboard token is used for GitHub data; local Git uses your Git credentials.', 403);
  }
  if (/would be overwritten by merge|untracked working tree files/i.test(error.stderr || '')) {
    return new LocalRepoError('Incoming changes overlap local files, including ignored files. Your files were preserved. Move or commit them in Terminal before updating.');
  }
  if (/not possible to fast-forward/i.test(error.stderr || '')) {
    return new LocalRepoError('The branch cannot be fast-forwarded. Your local commits were preserved; resolve the history in Terminal.');
  }
  return new LocalRepoError('Git could not complete this operation. Check the repository in Terminal before trying again.', 502);
}

/** Local Git operations only. remoteUrlForTests is an in-process integration-test seam,
 * never an HTTP input. Browser tokens deliberately do not enter Git subprocesses. */
export function createLocalRepoManager({
  root = process.env.REPO_DASHBOARD_ROOT || path.join(homedir(), 'Developer', 'GitHub'),
  cacheTtlMs = 1500,
  timeoutMs = 120_000,
  platform = process.platform,
  remoteUrlForTests,
  projectInstaller = createProjectInstaller({ platform }),
} = {}) {
  const repoRoot = path.resolve(root);
  const locks = new Set();
  const cache = new Map();
  let gitCheck;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_OPTIONAL_LOCKS: '0',
    GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oStrictHostKeyChecking=yes -oConnectTimeout=15',
    LC_ALL: 'C',
  });
  const gitOptions = [
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'submodule.recurse=false', '-c', 'http.followRedirects=false',
    '-c', 'protocol.ext.allow=never', '-c', `protocol.file.allow=${remoteUrlForTests ? 'always' : 'never'}`,
  ];

  async function git(args, cwd, { allowedFailure = false } = {}) {
    try {
      const result = await execBounded('git', [...gitOptions, ...args], {
        cwd, env, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true,
      });
      return result.stdout.trim();
    } catch (error) {
      if (allowedFailure && error.code === 1) return null;
      throw safeFailure(error);
    }
  }

  async function gitAvailable() {
    if (!gitCheck || Date.now() - gitCheck.at > 30_000) {
      gitCheck = { at: Date.now(), value: await git(['--version']).then(() => true, () => false) };
    }
    return gitCheck.value;
  }

  function repoPath(fullName) {
    return path.join(repoRoot, ...fullName.split('/'));
  }

  async function locationExists(fullName) {
    if (!await existingDirectory(repoRoot)) return false;
    if (!await existingDirectory(path.dirname(repoPath(fullName)))) return false;
    return existingDirectory(repoPath(fullName));
  }

  async function verifyRepository(fullName) {
    const directory = repoPath(fullName);
    if (!await locationExists(fullName)) throw new LocalRepoError('Install this repository first.', 404);
    if (!await existingDirectory(path.join(directory, '.git'))) {
      throw new LocalRepoError('This folder is not a standalone Git checkout. Move it aside or use Terminal to inspect it.');
    }
    const actual = await realpath(directory);
    const top = await git(['rev-parse', '--show-toplevel'], directory);
    if (await realpath(top) !== actual) throw new LocalRepoError('This folder belongs to a different Git checkout.');
    const common = await git(['rev-parse', '--git-common-dir'], directory);
    if (await realpath(path.resolve(directory, common)) !== await realpath(path.join(directory, '.git'))) {
      throw new LocalRepoError('This checkout shares Git metadata outside its folder. Manage it in Terminal.');
    }
    const configured = await git(['config', '--get-all', 'remote.origin.url'], directory, { allowedFailure: true });
    const resolved = await git(['remote', 'get-url', '--all', 'origin'], directory).catch(() => null);
    const expected = remoteUrlForTests?.(fullName);
    const matches = (value) => value && !value.includes('\n') && (expected ? value === expected : githubName(value) === fullName.toLowerCase());
    if (!matches(configured) || !matches(resolved)) {
      throw new LocalRepoError('The folder’s origin does not match this GitHub repository. Correct its origin in Terminal before updating.');
    }
    return directory;
  }

  async function inspect(fullName) {
    const base = { fullName, path: repoPath(fullName), installed: false, state: 'not-installed', branch: null, dirty: false, ahead: 0, behind: 0, project: null, message: 'Source has not been downloaded to this computer.' };
    try {
      if (!await locationExists(fullName)) return base;
      base.installed = true;
      const directory = await verifyRepository(fullName);
      try { base.project = await projectInstaller.describe({ directory, fullName }); }
      catch (error) {
        base.project = { kind: 'unsupported', supported: false, ready: false,
          message: error instanceof ProjectInstallError ? error.message : 'Project setup could not be inspected. Check the project README.' };
      }
      const output = await git(['status', '--porcelain=v2', '--branch', '--untracked-files=normal', '-z'], directory);
      const records = output.split('\0').filter(Boolean);
      const header = (name) => records.find((record) => record.startsWith(`# branch.${name} `))?.slice(name.length + 10);
      const head = header('head');
      base.branch = head === '(detached)' ? null : head || null;
      base.dirty = records.some((record) => !record.startsWith('# '));
      const counts = /^\+(\d+) -(\d+)$/.exec(header('ab') || '');
      if (counts) { base.ahead = Number(counts[1]); base.behind = Number(counts[2]); }
      if (head === '(detached)') return { ...base, state: 'blocked', message: 'Detached HEAD. Select a branch in Terminal before updating.' };
      if (header('oid') === '(initial)') return { ...base, state: 'blocked', message: 'This repository has no local commits yet. Create or fetch its first branch in Terminal.' };
      if (base.dirty) return { ...base, state: 'dirty', message: 'Local changes or untracked files need attention. Commit or move them in Terminal before updating.' };
      await upstream(directory, base.branch);
      if (base.ahead && base.behind) return { ...base, state: 'diverged', message: 'Local and remote history have diverged. Resolve this in Terminal; your commits will be preserved.' };
      if (base.behind) return { ...base, state: 'behind', message: `${base.behind} incoming commit${base.behind === 1 ? '' : 's'} in the last fetched Git data.` };
      if (base.ahead) return { ...base, state: 'ahead', message: `${base.ahead} local commit${base.ahead === 1 ? '' : 's'} preserved. Update can check for incoming changes.` };
      return { ...base, state: 'ready', message: 'Clean checkout. Update checks GitHub for new commits.' };
    } catch (error) {
      return { ...base, state: 'blocked', message: error instanceof LocalRepoError ? error.message : 'This repository folder could not be inspected. Check its permissions in Terminal.' };
    }
  }

  async function upstream(directory, branch) {
    if (!branch) throw new LocalRepoError('Select a branch in Terminal before updating.');
    const remote = await git(['config', '--get', `branch.${branch}.remote`], directory, { allowedFailure: true });
    const merge = await git(['config', '--get', `branch.${branch}.merge`], directory, { allowedFailure: true });
    if (remote !== 'origin' || !merge?.startsWith('refs/heads/') || merge.includes('\n')) {
      throw new LocalRepoError('This branch must track a branch on origin. Configure its upstream in Terminal before updating.');
    }
    const tracking = `refs/remotes/origin/${merge.slice('refs/heads/'.length)}`;
    const resolved = await git(['rev-parse', '--symbolic-full-name', '@{upstream}'], directory).catch(() => null);
    if (resolved !== tracking) throw new LocalRepoError('The branch’s upstream is missing or does not match origin. Fix its tracking branch in Terminal.');
    return { tracking, remoteRef: merge };
  }

  async function status(fullNames) {
    if (!Array.isArray(fullNames) || fullNames.length > 1000) throw new LocalRepoError('Provide up to 1,000 GitHub repository names.', 400);
    const names = [...new Set(fullNames.map(validateFullName))];
    const available = await gitAvailable();
    const repos = new Array(names.length);
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, names.length) }, async () => {
      for (;;) {
        const current = index++;
        if (current >= names.length) return;
        const name = names[current];
        const cached = cache.get(name.toLowerCase());
        if (cached && Date.now() - cached.at < cacheTtlMs) repos[current] = cached.value;
        else {
          repos[current] = await inspect(name);
          cache.set(name.toLowerCase(), { at: Date.now(), value: repos[current] });
        }
      }
    }));
    return { root: repoRoot, gitAvailable: available, repos };
  }

  async function cloneRepository(fullName) {
    const directory = repoPath(fullName);
    // Never reuse even an empty existing folder: it may contain the user’s work.
    if (await locationExists(fullName)) throw new LocalRepoError('This folder already exists. Open it or move it aside before downloading.');
    await mkdir(repoRoot, { recursive: true });
    await existingDirectory(repoRoot);
    await mkdir(path.dirname(directory), { recursive: true });
    await existingDirectory(path.dirname(directory));
    if (await locationExists(fullName)) throw new LocalRepoError('This folder already exists. Open it or move it aside before downloading.');
    const remote = remoteUrlForTests ? remoteUrlForTests(fullName) : `https://github.com/${fullName}.git`;
    const resolved = await git(['ls-remote', '--get-url', remote], repoRoot);
    if (remoteUrlForTests ? resolved !== remote : githubName(resolved) !== fullName.toLowerCase()) {
      throw new LocalRepoError('Your Git configuration rewrites this repository to a different host or repository. Correct the URL rewrite in Terminal before downloading.');
    }
    await git(['clone', '--no-recurse-submodules', '--origin', 'origin', '--template=', '--', remote, directory], repoRoot);
    await verifyRepository(fullName);
    return `Downloaded ${fullName}. Source-only download does not install app dependencies.`;
  }

  async function updateRepository(fullName) {
    const directory = await verifyRepository(fullName);
    const before = await inspect(fullName);
    if (before.dirty || before.state === 'blocked' || before.state === 'diverged') throw new LocalRepoError(before.message);
    const target = await upstream(directory, before.branch);
    // Only the tracked origin branch is fetched. Preserve local work and ignore
    // repository settings that would stash, squash or execute Git hooks.
    await git(['fetch', '--no-tags', '--no-recurse-submodules', '--upload-pack=git-upload-pack', 'origin', `+${target.remoteRef}:${target.tracking}`], directory);
    const afterFetch = await inspect(fullName);
    if (afterFetch.dirty || afterFetch.state === 'blocked' || afterFetch.state === 'diverged' || afterFetch.branch !== before.branch) {
      throw new LocalRepoError(afterFetch.branch !== before.branch ? 'The checked-out branch changed during the update. Retry after finishing your Terminal operation.' : afterFetch.message);
    }
    await git(['merge', '--ff-only', '--no-edit', '--no-autostash', '--no-squash', '--no-overwrite-ignore', target.tracking], directory);
    return afterFetch.behind ? `Updated ${fullName} with a fast-forward. Your local work was preserved.` : `${fullName} is up to date with its tracked branch. Local commits were preserved.`;
  }

  async function excludeGeneratedDependencies(directory) {
    // Keep generated dependencies out of Git status without editing .gitignore
    // or hiding any tracked files. Refuse symlinked Git metadata destinations.
    const info = path.join(directory, '.git', 'info');
    if (!await existingDirectory(info)) await mkdir(info);
    const handle = await open(path.join(info, 'exclude'), constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o644);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new LocalRepoError('Git’s local exclude file needs attention before installing dependencies.');
      const current = await handle.readFile('utf8');
      if (!current.split(/\r?\n/).includes('/node_modules/')) {
        await handle.write('\n# Repo Dashboard generated dependencies\n/node_modules/\n');
      }
    } finally { await handle.close(); }
  }

  async function installProject(fullName) {
    const directory = await verifyRepository(fullName);
    const project = await projectInstaller.describe({ directory, fullName });
    if (!project.supported) throw new ProjectInstallError(`Source downloaded. ${project.message || 'This project needs manual setup; open its README.'}`, 422);
    if (project.kind === 'node') await excludeGeneratedDependencies(directory);
    return projectInstaller.install({ directory, fullName });
  }

  async function runAction({ fullName, action } = {}) {
    validateFullName(fullName);
    if (!ACTIONS.has(action)) throw new LocalRepoError('Choose install, update app, launch, download source, update source, Finder, or Terminal.', 400);
    const key = fullName.toLowerCase();
    if (locks.has(key)) throw new LocalRepoError('An operation is already running for this repository. Wait for it to finish.');
    locks.add(key);
    cache.delete(key);
    try {
      if (!await gitAvailable()) throw new LocalRepoError('Git is unavailable. Install the macOS Command Line Tools with xcode-select --install, then reopen the dashboard.', 503);
      const directory = repoPath(fullName);
      let message;
      if (action === 'install') {
        if (!await locationExists(fullName)) await cloneRepository(fullName);
        const project = await installProject(fullName);
        message = project.message || `Installed ${fullName}. Its app launcher is ready.`;
      } else if (action === 'update-app') {
        const updated = await updateRepository(fullName);
        try {
          const project = await installProject(fullName);
          message = `${updated} ${project.message || 'App dependencies and launcher are ready.'}`;
        } catch (error) {
          if (error instanceof ProjectInstallError) error.message = `Source update completed. App setup did not finish: ${error.message}`;
          throw error;
        }
      } else if (action === 'launch') {
        await verifyRepository(fullName);
        const result = await projectInstaller.launch({ directory, fullName });
        message = result.message || `Opened the launcher for ${fullName}.`;
      } else if (action === 'clone') {
        message = await cloneRepository(fullName);
      } else if (action === 'update') {
        message = await updateRepository(fullName);
      } else {
        await verifyRepository(fullName);
        if (platform !== 'darwin') throw new LocalRepoError('Opening Finder or Terminal is available when this dashboard runs on your Mac.', 400);
        const args = action === 'terminal' ? ['-a', 'Terminal', directory] : [directory];
        try { await execBounded('/usr/bin/open', args, { timeout: 10_000, maxBuffer: 64 * 1024, env }); }
        catch { throw new LocalRepoError('macOS could not open this folder. Open the displayed repository path manually.', 502); }
        message = action === 'terminal' ? `Opened ${fullName} in Terminal.` : `Opened ${fullName} in Finder.`;
      }
      cache.delete(key);
      return { message, repo: await inspect(fullName) };
    } catch (error) {
      throw error instanceof LocalRepoError || error instanceof ProjectInstallError ? error : safeFailure(error);
    } finally {
      cache.delete(key);
      locks.delete(key);
    }
  }

  return { status, runAction };
}
