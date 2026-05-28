import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'POST' && request.url === '/chat') {
      await handleChat(request, response);
      return;
    }

    if (request.method === 'GET') {
      await serveStatic(request, response);
      return;
    }

    sendJson(response, 405, { error: 'Method not allowed' });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: 'Unexpected server error' });
  }
});

server.listen(port, () => {
  console.log(`GitHub Repo Dashboard running at http://localhost:${port}`);
  if (!openaiApiKey) {
    console.log('OPENAI_API_KEY is not set. Chat will use basic command parsing only.');
  }
});

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
    'Allowed actions: help, list_failing_repos, list_issues, list_pull_requests, list_stale_repos, open_repo, summarize_repo.',
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
                  'list_failing_repos',
                  'list_issues',
                  'list_pull_requests',
                  'list_stale_repos',
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
  const resolved = normalize(join(root, pathname));

  if (!resolved.startsWith(root)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

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
  response.writeHead(200, { 'Content-Type': contentType(resolved) });
  response.end(content);
}

async function readJson(request) {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function contentType(path) {
  const extension = extname(path);
  if (extension === '.html') return 'text/html; charset=utf-8';
  if (extension === '.js' || extension === '.mjs') return 'text/javascript; charset=utf-8';
  if (extension === '.css') return 'text/css; charset=utf-8';
  if (extension === '.md') return 'text/markdown; charset=utf-8';
  return 'application/octet-stream';
}
