# GitHub Repo Card Dashboard

A free personal dashboard for scanning GitHub repositories as cards.

The app is intentionally simple: open `index.html`, paste a GitHub token, and it loads your public and private repositories into an attention-first dashboard.

## Features

- Repo cards for all accessible repositories.
- `Needs attention` section for open issues, open PRs, failing Actions, or stale repos.
- Search by repo, owner, description, language, branch, or visibility.
- Owner/org filter.
- Summary counts for repos, attention items, issues, PRs, and failing checks.
- Quick links to repo, issues, PRs, and Actions.
- Clone URL copy button.
- Token persistence in browser `localStorage`.
- `Forget token` button to clear the token and cached repo data.

## Use Locally

Open `index.html` in your browser.

On Windows, you can also double-click `launch-dashboard.bat`.

For private repos, create a GitHub personal access token:

1. Go to <https://github.com/settings/personal-access-tokens>.
2. Create a fine-grained token.
3. Give it read-only access to the repos you want to view.
4. Include repository metadata, issues, pull requests, and Actions read access where available.
5. Paste the token into the dashboard.

## Security Note

This is a personal local tool. If you choose to remember the token, it is stored in this browser's `localStorage`.

Do not publish a copy of this app with your token inside it. Use `Forget token` to clear the token from your browser.

## Limits

- No backend or OAuth flow.
- No team sharing.
- Manual refresh only.
- GitHub API rate limits still apply.
