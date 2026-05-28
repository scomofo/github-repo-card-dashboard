const ALLOWED_ACTIONS = new Set([
  'help',
  'list_failing_repos',
  'list_issues',
  'list_pull_requests',
  'list_stale_repos',
  'open_repo',
  'summarize_repo'
]);

export function sanitizeModelCommand(value) {
  if (!value || typeof value !== 'object') return { action: 'help' };
  const action = typeof value.action === 'string' ? value.action : 'help';
  if (!ALLOWED_ACTIONS.has(action)) return { action: 'help' };

  const command = { action };
  if (typeof value.repo === 'string' && value.repo.trim()) {
    command.repo = value.repo.trim();
  }
  return command;
}

export function parseFallbackCommand(message) {
  const text = String(message || '').trim().toLowerCase();
  const repo = extractRepoHint(text);

  if (text.includes('fail')) return { action: 'list_failing_repos' };
  if (text.includes('stale') || text.includes('quiet')) return { action: 'list_stale_repos' };
  if (text.includes('issue')) return repo ? { action: 'list_issues', repo } : { action: 'list_issues' };
  if (text.includes('pr') || text.includes('pull request')) {
    return repo ? { action: 'list_pull_requests', repo } : { action: 'list_pull_requests' };
  }
  if (text.includes('open')) return repo ? { action: 'open_repo', repo } : { action: 'help' };
  if (text.includes('summarize') || text.includes('summary')) {
    return repo ? { action: 'summarize_repo', repo } : { action: 'help' };
  }

  return { action: 'help' };
}

export function buildPromptContext(repos) {
  return repos.slice(0, 80).map((repo) => {
    return [
      repo.fullName,
      `issues=${repo.openIssues || 0}`,
      `prs=${repo.openPrs || 0}`,
      `workflow=${repo.workflow?.status || 'unknown'}`,
      `language=${repo.language || 'Unknown'}`
    ].join(' ');
  }).join('\n');
}

export async function executeDashboardCommand({ command, repos, githubToken, requestGithub }) {
  const safeCommand = sanitizeModelCommand(command);

  if (safeCommand.action === 'list_failing_repos') {
    const failing = repos.filter((repo) => repo.workflow?.status === 'failure');
    return markdownResult(formatRepoList('Failing repositories', failing, 'No failing repositories in the dashboard data.'));
  }

  if (safeCommand.action === 'list_stale_repos') {
    const stale = repos.filter((repo) => isStale(repo.pushedAt));
    return markdownResult(formatRepoList('Stale repositories', stale, 'No stale repositories in the dashboard data.'));
  }

  if (safeCommand.action === 'summarize_repo') {
    const repo = findRepo(repos, safeCommand.repo);
    if (!repo) return markdownResult(`I could not find a repo matching "${safeCommand.repo || ''}".`);
    return markdownResult([
      `**${repo.fullName}**`,
      repo.description || 'No description.',
      `Language: ${repo.language || 'Unknown'}`,
      `Open issues: ${repo.openIssues || 0}`,
      `Open PRs: ${repo.openPrs || 0}`,
      `Actions: ${repo.workflow?.text || 'unknown'}`,
      `Last push: ${formatDate(repo.pushedAt)}`,
      repo.url
    ].join('\n'));
  }

  if (safeCommand.action === 'open_repo') {
    const repo = findRepo(repos, safeCommand.repo);
    if (!repo) return markdownResult(`I could not find a repo matching "${safeCommand.repo || ''}".`);
    return { kind: 'open', text: `Open ${repo.fullName}`, url: repo.url };
  }

  if (safeCommand.action === 'list_issues') {
    return listGithubItems({
      command: safeCommand,
      repos,
      githubToken,
      requestGithub,
      item: 'issues'
    });
  }

  if (safeCommand.action === 'list_pull_requests') {
    return listGithubItems({
      command: safeCommand,
      repos,
      githubToken,
      requestGithub,
      item: 'pulls'
    });
  }

  return markdownResult(helpText());
}

async function listGithubItems({ command, repos, githubToken, requestGithub, item }) {
  if (!githubToken) return markdownResult('Add your GitHub token in the dashboard before using repo commands.');

  const matchingRepos = command.repo ? [findRepo(repos, command.repo)].filter(Boolean) : repos;
  if (matchingRepos.length === 0) return markdownResult(`I could not find a repo matching "${command.repo}".`);

  const reposToFetch = matchingRepos
    .filter((repo) => item === 'issues' ? (repo.openIssues || 0) > 0 : (repo.openPrs || 0) > 0)
    .slice(0, command.repo ? 1 : 8);

  if (reposToFetch.length === 0) {
    return markdownResult(item === 'issues' ? 'No open issues found in the current dashboard data.' : 'No open PRs found in the current dashboard data.');
  }

  const lines = [];
  for (const repo of reposToFetch) {
    const path = item === 'issues'
      ? `/repos/${repo.fullName}/issues?state=open&per_page=10`
      : `/repos/${repo.fullName}/pulls?state=open&per_page=10`;
    const rows = await requestGithub(path);
    const filtered = item === 'issues' ? rows.filter((row) => !row.pull_request) : rows;
    if (filtered.length === 0) continue;
    lines.push(`**${repo.fullName}**`);
    for (const row of filtered.slice(0, 5)) {
      lines.push(`- #${row.number} ${row.title} (${row.user?.login || 'unknown'}) ${row.html_url}`);
    }
  }

  return markdownResult(lines.length ? lines.join('\n') : `No open ${item === 'issues' ? 'issues' : 'PRs'} found.`);
}

function findRepo(repos, hint) {
  if (!hint) return null;
  const normalized = hint.toLowerCase();
  return repos.find((repo) => repo.fullName.toLowerCase() === normalized)
    || repos.find((repo) => repo.name.toLowerCase() === normalized)
    || repos.find((repo) => repo.fullName.toLowerCase().includes(normalized));
}

function formatRepoList(title, repos, emptyText) {
  if (!repos.length) return emptyText;
  return [
    `**${title}**`,
    ...repos.slice(0, 12).map((repo) => {
      const bits = [
        `${repo.openIssues || 0} issues`,
        `${repo.openPrs || 0} PRs`,
        repo.workflow?.text || 'Actions unknown'
      ];
      return `- ${repo.fullName}: ${bits.join(', ')} ${repo.url}`;
    })
  ].join('\n');
}

function helpText() {
  return [
    'Try one of these read-only GitHub commands:',
    '- show failing repos',
    '- show open PRs',
    '- show issues for repo-name',
    '- summarize repo-name',
    '- open repo-name',
    '- show stale repos'
  ].join('\n');
}

function extractRepoHint(text) {
  const match = text.match(/(?:for|in|open|summarize|summary of)\s+([a-z0-9_.-]+\/[a-z0-9_.-]+|[a-z0-9_.-]+)/i);
  return match?.[1] || '';
}

function markdownResult(text) {
  return { kind: 'markdown', text };
}

function isStale(value) {
  if (!value) return false;
  return Date.now() - new Date(value).getTime() > 45 * 24 * 60 * 60 * 1000;
}

function formatDate(value) {
  if (!value) return 'Unknown';
  return new Date(value).toLocaleDateString();
}
