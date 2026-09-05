const ALLOWED_ACTIONS = new Set([
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
]);

const STALE_DAYS = 45;
const ACTIVE_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

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

  if (!text || text === 'help' || text === '?') return { action: 'help' };
  if (/\b(overview|status|how are things|dashboard|what needs attention|health)\b/.test(text) && !repo) {
    return { action: 'dashboard_overview' };
  }
  if (text.includes('fail') || text.includes('broken') || text.includes('red')) return { action: 'list_failing_repos' };
  if (text.includes('review')) return repo ? { action: 'list_review_requests', repo } : { action: 'list_review_requests' };
  if (text.includes('stale') || text.includes('quiet') || text.includes('inactive')) return { action: 'list_stale_repos' };
  if (/\b(active|recent|recently|changed|busy|this week)\b/.test(text) && !repo) return { action: 'list_active_repos' };
  if (text.includes('issue')) return repo ? { action: 'list_issues', repo } : { action: 'list_issues' };
  if (/\b(prs?|pull requests?|pulls)\b/.test(text)) {
    return repo ? { action: 'list_pull_requests', repo } : { action: 'list_pull_requests' };
  }
  if (text.includes('open')) return repo ? { action: 'open_repo', repo } : { action: 'help' };
  if (text.includes('summarize') || text.includes('summary') || text.includes('tell me about') || text.includes('about')) {
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
      `review=${repo.reviewNeeded || 0}`,
      `workflow=${repo.workflow?.status || 'unknown'}`,
      `language=${repo.language || 'Unknown'}`,
      `stars=${repo.stars || 0}`,
      `commits30d=${repo.commits30d || 0}`,
      `activity=${repo.activity || activityOf(repo)}`
    ].join(' ');
  }).join('\n');
}

export async function executeDashboardCommand({ command, repos, githubToken, requestGithub }) {
  const safeCommand = sanitizeModelCommand(command);

  if (safeCommand.action === 'dashboard_overview') {
    return markdownResult(overviewText(repos));
  }

  if (safeCommand.action === 'list_failing_repos') {
    const failing = repos.filter((repo) => repo.workflow?.status === 'failure');
    return markdownResult(formatRepoList('Failing repositories', failing, 'No failing repositories in the dashboard data.'));
  }

  if (safeCommand.action === 'list_stale_repos') {
    const stale = repos.filter((repo) => !repo.isArchived && isStale(repo.pushedAt));
    return markdownResult(formatRepoList('Stale repositories', stale, 'No stale repositories in the dashboard data.'));
  }

  if (safeCommand.action === 'list_active_repos') {
    const active = repos
      .filter((repo) => !repo.isArchived && isActive(repo.pushedAt))
      .sort((a, b) => (b.commits30d || 0) - (a.commits30d || 0));
    return markdownResult(formatRepoList(`Active in the last ${ACTIVE_DAYS} days`, active, 'Nothing has been pushed in the last week.', (repo) => [
      `${repo.commits30d || 0} commits in 30d`,
      `last push ${formatDate(repo.pushedAt)}`
    ]));
  }

  if (safeCommand.action === 'list_review_requests') {
    const scope = safeCommand.repo ? [findRepo(repos, safeCommand.repo)].filter(Boolean) : repos;
    if (safeCommand.repo && scope.length === 0) return markdownResult(`I could not find a repo matching "${safeCommand.repo}".`);
    const lines = [];
    for (const repo of scope) {
      const waiting = (repo.prs || []).filter((pr) => !pr.isDraft && pr.reviewDecision !== 'APPROVED');
      if (!waiting.length) continue;
      lines.push(`**${repo.fullName}**`);
      for (const pr of waiting.slice(0, 5)) {
        const decision = pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes requested' : 'needs review';
        lines.push(`- #${pr.number} ${pr.title} (${pr.author || 'unknown'}, ${decision}) ${pr.url}`);
      }
    }
    return markdownResult(lines.length ? ['**Pull requests waiting on review**', ...lines].join('\n') : 'No pull requests are waiting on review in the dashboard data.');
  }

  if (safeCommand.action === 'summarize_repo') {
    const repo = findRepo(repos, safeCommand.repo);
    if (!repo) return markdownResult(`I could not find a repo matching "${safeCommand.repo || ''}".`);
    const waiting = (repo.prs || []).filter((pr) => !pr.isDraft && pr.reviewDecision !== 'APPROVED').length;
    return markdownResult([
      `**${repo.fullName}**${repo.isArchived ? ' (archived)' : ''}${repo.isPrivate ? ' · private' : ''}`,
      repo.description || 'No description.',
      `Language: ${repo.language || 'Unknown'}`,
      `Stars: ${repo.stars || 0} · Forks: ${repo.forks || 0}`,
      `Open issues: ${repo.openIssues || 0}`,
      `Open PRs: ${repo.openPrs || 0}${waiting ? ` (${waiting} waiting on review)` : ''}`,
      `Commits in last 30 days: ${repo.commits30d || 0}`,
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

function overviewText(repos) {
  if (!repos.length) return 'The dashboard has not loaded any repositories yet. Refresh it and ask again.';
  const live = repos.filter((repo) => !repo.isArchived);
  const failing = repos.filter((repo) => repo.workflow?.status === 'failure');
  const review = repos.reduce((sum, repo) => sum + (repo.reviewNeeded || 0), 0);
  const issues = repos.reduce((sum, repo) => sum + (repo.openIssues || 0), 0);
  const prs = repos.reduce((sum, repo) => sum + (repo.openPrs || 0), 0);
  const commits = repos.reduce((sum, repo) => sum + (repo.commits30d || 0), 0);
  const stale = live.filter((repo) => isStale(repo.pushedAt));
  const active = live.filter((repo) => isActive(repo.pushedAt));
  const busiest = [...live].sort((a, b) => (b.commits30d || 0) - (a.commits30d || 0)).slice(0, 3).filter((repo) => (repo.commits30d || 0) > 0);

  const lines = [
    '**Dashboard overview**',
    `${repos.length} repositories (${live.length} active, ${repos.length - live.length} archived).`,
    `${failing.length} failing CI · ${prs} open PRs (${review} waiting on review) · ${issues} open issues.`,
    `${commits} commits in the last 30 days across ${active.length} repos pushed this week; ${stale.length} repos stale for ${STALE_DAYS}+ days.`
  ];
  if (failing.length) lines.push(`Failing: ${failing.slice(0, 5).map((repo) => repo.fullName).join(', ')}${failing.length > 5 ? ', …' : ''}`);
  if (busiest.length) lines.push(`Busiest: ${busiest.map((repo) => `${repo.fullName} (${repo.commits30d})`).join(', ')}`);
  return lines.join('\n');
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
      const flags = item === 'pulls' && row.draft ? ' [draft]' : '';
      lines.push(`- #${row.number} ${row.title}${flags} (${row.user?.login || 'unknown'}) ${row.html_url}`);
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

function formatRepoList(title, repos, emptyText, describe) {
  if (!repos.length) return emptyText;
  return [
    `**${title}**`,
    ...repos.slice(0, 12).map((repo) => {
      const bits = describe ? describe(repo) : [
        `${repo.openIssues || 0} issues`,
        `${repo.openPrs || 0} PRs`,
        repo.workflow?.text || 'Actions unknown'
      ];
      return `- ${repo.fullName}: ${bits.join(', ')} ${repo.url}`;
    }),
    ...(repos.length > 12 ? [`…and ${repos.length - 12} more.`] : [])
  ].join('\n');
}

function helpText() {
  return [
    'Try one of these read-only GitHub commands:',
    '- overview',
    '- show failing repos',
    '- which PRs need review?',
    '- show open PRs',
    '- show issues for repo-name',
    '- what changed recently?',
    '- show stale repos',
    '- summarize repo-name',
    '- open repo-name'
  ].join('\n');
}

function extractRepoHint(text) {
  const match = text.match(/(?:for|in|open|summarize|summary of|about)\s+([a-z0-9_.-]+\/[a-z0-9_.-]+|[a-z0-9_.-]+)/i);
  const hint = match?.[1] || '';
  if (['the', 'my', 'all', 'a', 'any', 'repos', 'repo', 'repositories', 'this', 'week', 'last'].includes(hint)) return '';
  return hint;
}

function markdownResult(text) {
  return { kind: 'markdown', text };
}

function activityOf(repo) {
  if (repo.isArchived) return 'archived';
  if (isStale(repo.pushedAt)) return 'stale';
  if (isActive(repo.pushedAt)) return 'active';
  return 'recent';
}

function isStale(value) {
  if (!value) return false;
  return Date.now() - new Date(value).getTime() > STALE_DAYS * DAY;
}

function isActive(value) {
  if (!value) return false;
  return Date.now() - new Date(value).getTime() <= ACTIVE_DAYS * DAY;
}

function formatDate(value) {
  if (!value) return 'Unknown';
  return new Date(value).toLocaleDateString();
}
