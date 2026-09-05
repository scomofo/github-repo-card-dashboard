import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLocalRepoManager } from './src/localRepos.mjs';

import {
  buildPromptContext,
  executeDashboardCommand,
  parseFallbackCommand,
  sanitizeModelCommand
} from './src/githubCommands.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 8787);
const openaiApiKey = process.env.OPENAI_API_KEY || '';
const openaiModel = process.env.OPENAI_MODEL || 'gpt-5.4-mini';

export function createDashboardServer({ localManager = createLocalRepoManager() } = {}) {
  const csrfToken = randomBytes(32).toString('hex');
  const server = http.createServer(async (request, response) => {
    try {
      // A local service with filesystem access must reject foreign Host/Origin headers.
      validateLocalRequest(request, server.address()?.port);

      if (request.url?.startsWith('/api/local/')) {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'Use POST for local repository actions.' });
          return;
        }
        requireSessionToken(request, csrfToken);
        const body = await readJson(request);
        if (request.url === '/api/local/status') {
          sendJson(response, 200, await localManager.status(body.repos));
        } else if (request.url === '/api/local/action') {
          // Only these fields cross into Git; browser credentials are never forwarded.
          sendJson(response, 200, await localManager.runAction({ fullName: body.fullName, action: body.action }));
        } else {
          sendJson(response, 404, { error: 'Unknown local repository endpoint.' });
        }
        return;
      }

      if (request.method === 'POST' && request.url === '/chat') {
        await handleChat(request, response);
        return;
      }

      if (request.method === 'GET' && request.url === '/api/health') {
        sendJson(response, 200, {
          ok: true, app: 'repo-dashboard', localRepos: true, csrfToken,
          platform: process.platform, pid: process.pid, runtime: root,
          openai: Boolean(openaiApiKey), model: openaiApiKey ? openaiModel : ''
        });
        return;
      }

      if (request.method === 'GET') {
        await serveStatic(request, response);
        return;
      }

      sendJson(response, 405, { error: 'Method not allowed' });
    } catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      // Never log request bodies, Git output or credentials.
      if (status === 500) console.error('Dashboard request failed.');
      sendJson(response, status, { error: status === 500 ? 'Unexpected server error' : error.message,
        ...(error.code === 'SESSION_EXPIRED' ? { code: 'SESSION_EXPIRED' } : {}) });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const server = createDashboardServer();
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE'
      ? `Port ${port} is already in use. Open the running dashboard or choose another PORT.`
      : `Could not start the dashboard (${error.code || 'server error'}).`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`GitHub Repo Dashboard running at http://127.0.0.1:${server.address().port}`);
    if (!openaiApiKey) console.log('Chat uses basic command parsing. No API key is needed.');
  });
  // Let an in-flight Git operation finish before an installer restarts the app.
  const shutdown = () => server.close(() => { process.exitCode = 0; });
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

function requestError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function validateLocalRequest(request, listeningPort) {
  const allowedHosts = new Set([`127.0.0.1:${listeningPort}`, `localhost:${listeningPort}`]);
  if (!allowedHosts.has(request.headers.host)) throw requestError(403, 'Only local dashboard requests are allowed.');
  const origin = request.headers.origin;
  if (origin && origin !== `http://${request.headers.host}`) {
    throw requestError(403, 'Open the dashboard on this computer to use this action.');
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') throw requestError(403, 'Cross-site requests are not allowed.');
}

function requireSessionToken(request, expected) {
  const supplied = request.headers['x-repo-dashboard-token'];
  if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected)
    || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    throw Object.assign(requestError(403, 'Refresh the dashboard to reconnect to the local server.'), { code: 'SESSION_EXPIRED' });
  }
}

async function handleChat(request, response) {
  const body = await readJson(request);
  const message = String(body.message || '').trim();
  const repos = Array.isArray(body.repos) ? body.repos : [];
  const githubToken = String(body.githubToken || '');

  if (!message) {
    sendJson(response, 400, { error: 'Message is required' });
    return;
  }

  const command = openaiApiKey
    ? await commandFromOpenAI(message, repos).catch((error) => {
      console.warn(`OpenAI command parsing failed: ${error.message}`);
      return parseFallbackCommand(message);
    })
    : parseFallbackCommand(message);

  const result = await executeDashboardCommand({
    command,
    repos,
    githubToken,
    requestGithub: (path) => requestGithub(path, githubToken)
  });

  sendJson(response, 200, {
    ...result,
    action: command.action,
    usedOpenAI: Boolean(openaiApiKey)
  });
}

async function commandFromOpenAI(message, repos) {
  const instructions = [
    'You translate short user requests into one safe JSON command for a GitHub repo dashboard.',
    'Only return JSON. Do not use markdown.',
    'Allowed actions: help, dashboard_overview, list_failing_repos, list_issues, list_pull_requests, list_review_requests, list_stale_repos, list_active_repos, open_repo, summarize_repo.',
    'Use dashboard_overview for general "how are things" questions, list_review_requests for PRs waiting on review, list_active_repos for what changed recently.',
    'Commands are read-only. If the user asks to create, delete, merge, close, push, edit, or mutate anything, return {"action":"help"}.',
    'When a repo is mentioned, use the closest repo fullName or name from the context.'
  ].join(' ');

  const input = [
    { role: 'developer', content: instructions },
    { role: 'user', content: `Repo context:\n${buildPromptContext(repos)}\n\nUser request: ${message}` }
  ];

  const openaiResponse = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: openaiModel,
      input,
      text: {
        format: {
          type: 'json_schema',
          name: 'dashboard_command',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              action: {
                type: 'string',
                enum: [
                  'help',
                  'dashboard_overview',
                  'list_failing_repos',
                  'list_issues',
                  'list_pull_requests',
                  'list_review_requests',
                  'list_stale_repos',
                  'list_active_repos',
                  'open_repo',
                  'summarize_repo'
                ]
              },
              repo: { type: 'string' }
            },
            required: ['action', 'repo']
          }
        }
      }
    })
  });

  const body = await openaiResponse.json().catch(() => ({}));
  if (!openaiResponse.ok) {
    throw new Error(body.error?.message || openaiResponse.statusText);
  }

  const text = body.output_text || body.output?.flatMap((item) => item.content || [])
    .find((item) => item.type === 'output_text')?.text;
  return sanitizeModelCommand(JSON.parse(text || '{"action":"help","repo":""}'));
}

async function requestGithub(path, token) {
  if (!token) throw new Error('GitHub token is required');
  const githubResponse = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  const body = await githubResponse.json().catch(() => ({}));
  if (!githubResponse.ok) {
    throw new Error(body.message || githubResponse.statusText);
  }
  return body;
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://localhost:${port}`);
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  // Explicit public assets only: never expose .git, source, scripts, or local config.
  const publicFiles = new Set(['/index.html', '/favicon.png', '/app-icon.png', '/assets/icons/app-icon.png']);
  if (!publicFiles.has(pathname)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  const resolved = join(root, pathname);

  let content;
  try {
    content = await readFile(resolved);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    throw error;
  }
  response.writeHead(200, {
    'Content-Type': contentType(resolved), 'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache'
  });
  response.end(content);
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    throw requestError(415, 'Send an application/json request.');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) throw requestError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw requestError(400, 'Request must contain valid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw requestError(400, 'Request must be a JSON object.');
  return parsed;
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY'
  });
  response.end(JSON.stringify(body));
}

function contentType(path) {
  const extension = extname(path);
  if (extension === '.html') return 'text/html; charset=utf-8';
  if (extension === '.js' || extension === '.mjs') return 'text/javascript; charset=utf-8';
  if (extension === '.css') return 'text/css; charset=utf-8';
  if (extension === '.md') return 'text/markdown; charset=utf-8';
  if (extension === '.json') return 'application/json; charset=utf-8';
  if (extension === '.png') return 'image/png';
  if (extension === '.svg') return 'image/svg+xml';
  if (extension === '.ico') return 'image/x-icon';
  if (extension === '.webmanifest') return 'application/manifest+json';
  return 'application/octet-stream';
}
