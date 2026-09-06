import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectProject } from '../src/projectInstall.mjs';

function openBrowser(url) {
  if (process.platform !== 'darwin' || process.env.REPO_DASHBOARD_NO_OPEN === '1') return;
  const child = spawn('/usr/bin/open', [url], { stdio: 'ignore', shell: false });
  child.on('error', () => console.log(`Open ${url} in your browser.`));
}

export function loopbackUrl(text) {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  for (const raw of clean.match(/https?:\/\/[^\s<>"']+/g) || []) {
    try {
      const parsed = new URL(raw);
      if (['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && !parsed.username && !parsed.password) return parsed.href;
    } catch { /* Incomplete URL in a stream chunk. */ }
  }
  return null;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4' };

export async function serveStaticProject(directory, { open = openBrowser } = {}) {
  const root = await realpath(directory);
  const server = http.createServer(async (req, res) => {
    const fail = (code, text) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(text); };
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) return fail(403, 'Local requests only.');
    if (!['GET', 'HEAD'].includes(req.method)) return fail(405, 'Use GET or HEAD.');
    try {
      const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (requested.includes('\0') || requested.includes('\\') || requested.split('/').some((part) => part.startsWith('.') || part === 'node_modules')) return fail(404, 'Not found.');
      let file = path.resolve(root, `.${requested}`);
      let info = await stat(file);
      if (info.isDirectory()) { file = path.join(file, 'index.html'); info = await stat(file); }
      const actual = await realpath(file);
      if (!actual.startsWith(`${root}${path.sep}`) || !info.isFile()) return fail(404, 'Not found.');
      if (path.relative(root, actual).split(path.sep).some((part) => part.startsWith('.') || part === 'node_modules')) return fail(404, 'Not found.');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': info.size, 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') return res.end();
      const stream = createReadStream(actual);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch { if (!res.headersSent) fail(404, 'Not found.'); else res.destroy(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  console.log(`App running at ${url}\nKeep this Terminal window open. Press Control-C to stop.`);
  open(url);
  return { server, url };
}

export async function launchProject(recordPath) {
  const saved = JSON.parse(await readFile(recordPath, 'utf8'));
  if (saved.version !== 1) throw new Error('This launcher record is invalid. Install the app again from Repo Dashboard.');
  const current = await inspectProject(saved);
  if (!current.supported || current.fingerprint !== saved.fingerprint || current.kind !== saved.kind || current.manager !== saved.manager || current.script !== saved.script) {
    throw new Error('Project setup has changed. Choose Install locally in Repo Dashboard to refresh it.');
  }
  if (saved.kind === 'static') {
    const { server } = await serveStaticProject(saved.directory);
    const stop = () => server.close(() => process.exit(0));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(saved.manager) || !path.isAbsolute(saved.managerPath) || !['dev', 'start'].includes(saved.script)) throw new Error('This app launcher needs to be installed again.');
  console.log(`Starting ${saved.fullName} with ${saved.manager} run ${saved.script}.\nKeep this Terminal window open. Press Control-C to stop.`);
  const child = spawn(saved.managerPath, ['run', saved.script], { cwd: saved.directory, shell: false, detached: process.platform !== 'win32',
    env: { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', BROWSER: 'none' }, stdio: ['inherit', 'pipe', 'pipe'] });
  let opened = false;
  let buffer = '';
  const collect = (target, chunk) => {
    target.write(chunk);
    if (!opened) {
      buffer = `${buffer}${chunk.toString()}`.slice(-8192);
      // Wait for a completed line so a split chunk such as "localhost:51"
      // cannot open the browser before the remaining port digits arrive.
      const completed = buffer.slice(0, buffer.lastIndexOf('\n') + 1);
      const url = loopbackUrl(completed);
      if (url) { opened = true; openBrowser(url); }
    }
  };
  child.stdout.on('data', (chunk) => collect(process.stdout, chunk));
  child.stderr.on('data', (chunk) => collect(process.stderr, chunk));
  const stop = (signal) => {
    try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already stopped. */ }
  };
  const onInt = () => stop('SIGINT');
  const onTerm = () => stop('SIGTERM');
  const onHangup = () => stop('SIGHUP');
  const onExit = () => stop('SIGTERM');
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  process.once('SIGHUP', onHangup);
  process.once('exit', onExit);
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); resolve(); });
  }).finally(() => {
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('SIGHUP', onHangup);
    process.removeListener('exit', onExit);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2]) throw new Error('Launch this app using its installed .command file.');
    await launchProject(process.argv[2]);
  } catch (error) { console.error(`Repo App: ${error.message}`); process.exitCode = 1; }
}
