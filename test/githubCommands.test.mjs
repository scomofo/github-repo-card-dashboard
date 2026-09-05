import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPromptContext,
  executeDashboardCommand,
  parseFallbackCommand,
  sanitizeModelCommand
} from '../src/githubCommands.mjs';

const repos = [
  {
    fullName: 'scomofo/api-service',
    owner: 'scomofo',
    name: 'api-service',
    url: 'https://github.com/scomofo/api-service',
    description: 'Backend service',
    openIssues: 2,
    openPrs: 1,
    workflow: { status: 'failure', text: 'Actions failure' },
    pushedAt: new Date().toISOString(),
    language: 'TypeScript'
  },
  {
    fullName: 'scomofo/docs',
    owner: 'scomofo',
    name: 'docs',
    url: 'https://github.com/scomofo/docs',
    description: 'Project docs',
    openIssues: 0,
    openPrs: 0,
    workflow: { status: 'success', text: 'Actions passing' },
    pushedAt: '2024-01-01T00:00:00Z',
    language: 'HTML'
  }
];

test('sanitizeModelCommand only allows known read-only commands', () => {
  assert.deepEqual(
    sanitizeModelCommand({ action: 'list_pull_requests', repo: 'scomofo/api-service' }),
    { action: 'list_pull_requests', repo: 'scomofo/api-service' }
  );

  assert.deepEqual(
    sanitizeModelCommand({ action: 'merge_pull_request', repo: 'scomofo/api-service' }),
    { action: 'help' }
  );
});

test('parseFallbackCommand maps simple phrases to safe commands', () => {
  assert.deepEqual(parseFallbackCommand('show failing repos'), { action: 'list_failing_repos' });
  assert.deepEqual(parseFallbackCommand('what prs are open?'), { action: 'list_pull_requests' });
  assert.deepEqual(parseFallbackCommand('summarize api-service'), { action: 'summarize_repo', repo: 'api-service' });
});

test('executeDashboardCommand summarizes failing repositories from dashboard data', async () => {
  const result = await executeDashboardCommand({
    command: { action: 'list_failing_repos' },
    repos,
    githubToken: 'token',
    requestGithub: async () => ({})
  });

  assert.equal(result.kind, 'markdown');
  assert.match(result.text, /scomofo\/api-service/);
  assert.doesNotMatch(result.text, /scomofo\/docs/);
});

test('executeDashboardCommand fetches open pull requests for a repository', async () => {
  const calls = [];
  const result = await executeDashboardCommand({
    command: { action: 'list_pull_requests', repo: 'scomofo/api-service' },
    repos,
    githubToken: 'token',
    requestGithub: async (path) => {
      calls.push(path);
      return [
        {
          number: 7,
          title: 'Improve auth',
          html_url: 'https://github.com/scomofo/api-service/pull/7',
          user: { login: 'scomofo' }
        }
      ];
    }
  });

  assert.equal(calls[0], '/repos/scomofo/api-service/pulls?state=open&per_page=10');
  assert.match(result.text, /#7/);
  assert.match(result.text, /Improve auth/);
});

test('buildPromptContext keeps repo context compact', () => {
  const context = buildPromptContext(repos);

  assert.match(context, /scomofo\/api-service/);
  assert.match(context, /issues=2/);
  assert.ok(context.length < 1000);
});

test('parseFallbackCommand understands the new read-only phrasings', () => {
  assert.deepEqual(parseFallbackCommand('overview'), { action: 'dashboard_overview' });
  assert.deepEqual(parseFallbackCommand('which PRs need review?'), { action: 'list_review_requests' });
  assert.deepEqual(parseFallbackCommand('what changed recently?'), { action: 'list_active_repos' });
  assert.deepEqual(parseFallbackCommand('show issues for scomofo/docs'), { action: 'list_issues', repo: 'scomofo/docs' });
  assert.deepEqual(parseFallbackCommand('tell me about api-service'), { action: 'summarize_repo', repo: 'api-service' });
});

test('executeDashboardCommand lists pull requests waiting on review from dashboard data', async () => {
  const withPrs = repos.map((repo) => repo.name === 'api-service'
    ? {
      ...repo,
      prs: [
        { number: 7, title: 'Improve auth', url: 'https://github.com/scomofo/api-service/pull/7', isDraft: false, reviewDecision: null, author: 'scomofo' },
        { number: 8, title: 'WIP docs', url: 'https://github.com/scomofo/api-service/pull/8', isDraft: true, reviewDecision: null, author: 'scomofo' },
        { number: 9, title: 'Approved thing', url: 'https://github.com/scomofo/api-service/pull/9', isDraft: false, reviewDecision: 'APPROVED', author: 'scomofo' }
      ]
    }
    : repo);

  const result = await executeDashboardCommand({
    command: { action: 'list_review_requests' },
    repos: withPrs,
    githubToken: 'token',
    requestGithub: async () => { throw new Error('should not call GitHub'); }
  });

  assert.match(result.text, /#7 Improve auth/);
  assert.doesNotMatch(result.text, /#8/);
  assert.doesNotMatch(result.text, /#9/);
});

test('executeDashboardCommand builds an overview without calling GitHub', async () => {
  const result = await executeDashboardCommand({
    command: { action: 'dashboard_overview' },
    repos: repos.map((repo) => ({ ...repo, commits30d: repo.name === 'api-service' ? 12 : 0, reviewNeeded: 1 })),
    githubToken: '',
    requestGithub: async () => { throw new Error('should not call GitHub'); }
  });

  assert.equal(result.kind, 'markdown');
  assert.match(result.text, /2 repositories/);
  assert.match(result.text, /1 failing CI/);
  assert.match(result.text, /Busiest: scomofo\/api-service \(12\)/);
});
