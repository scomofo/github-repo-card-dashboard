// Fixture responses for the GitHub API calls the dashboard makes while the
// session regression suite runs. The browser never reaches api.github.com:
// the spec routes these endpoints to the payloads below. Node shapes mirror
// the fields `normalizeRepo` reads in index.html.
import { fixtureNames } from './fixtures.mjs';

const OWNER = 'e2e-owner';

function repoNode(name, { description, language, languageColor }) {
  const now = new Date().toISOString();
  return {
    name,
    nameWithOwner: `${OWNER}/${name}`,
    url: `https://github.com/${OWNER}/${name}`,
    description,
    homepageUrl: '',
    isPrivate: false,
    isArchived: false,
    isFork: false,
    isTemplate: false,
    visibility: 'PUBLIC',
    pushedAt: now,
    updatedAt: now,
    createdAt: now,
    sshUrl: `git@github.com:${OWNER}/${name}.git`,
    diskUsage: 12,
    stargazerCount: 3,
    forkCount: 0,
    hasIssuesEnabled: true,
    watchers: { totalCount: 1 },
    owner: { login: OWNER, avatarUrl: 'https://avatars.githubusercontent.com/u/0?v=4' },
    licenseInfo: null,
    primaryLanguage: { name: language, color: languageColor },
    languages: { totalSize: 0, edges: [] },
    repositoryTopics: { nodes: [] },
    defaultBranchRef: { name: 'main', target: null },
    latestRelease: null,
    issues: { totalCount: 0 },
    recentIssues: { nodes: [] },
    pullRequests: { totalCount: 0 },
    recentPullRequests: { nodes: [] }
  };
}

/** GraphQL `viewer.repositories` payload with one node per fixture repo. */
export function graphqlResponse() {
  const meta = {
    'fixture-node': {
      description: 'Hermetic Node fixture for the session regression suite',
      language: 'JavaScript',
      languageColor: '#f1e05a'
    },
    'fixture-static': {
      description: 'Hermetic static-site fixture for the session regression suite',
      language: 'HTML',
      languageColor: '#e34c26'
    },
    'fixture-update': {
      description: 'Hermetic Node fixture for the update-flow regression test',
      language: 'JavaScript',
      languageColor: '#f1e05a'
    }
  };
  const nodes = fixtureNames().map((name) => repoNode(name, meta[name]));
  return {
    data: {
      viewer: {
        login: OWNER,
        repositories: {
          totalCount: nodes.length,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes
        }
      }
    }
  };
}

/** Actions REST payload: no runs, so no workflow noise in the cards. */
export function actionsRunsResponse() {
  return { total_count: 0, workflow_runs: [] };
}
