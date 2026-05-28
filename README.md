# GitHub Repo Card Dashboard

A free personal dashboard for scanning GitHub repositories as cards.

The app is intentionally simple: launch it locally, paste a GitHub token, and it loads your public and private repositories into an attention-first dashboard.

## Features

- Repo cards for all accessible repositories.
- `Needs attention` section for open issues, open PRs, failing Actions, or stale repos.
- Search by repo, owner, description, language, branch, or visibility.
- Owner/org filter.
- Summary counts for repos, attention items, issues, PRs, and failing checks.
- Quick links to repo, issues, PRs, and Actions.
- Clone URL copy button.
- Local chat window for basic read-only GitHub commands.
- Token persistence in browser `localStorage`.
- `Forget token` button to clear the token and cached repo data.

## Use Locally

Use a launcher so the local command server starts with the dashboard:

- Windows: double-click `launch-dashboard.bat`.
- macOS: double-click `launch-dashboard.command`, or run `./launch-dashboard.command`.
- Any platform with Node.js: run `npm start`, then open <http://localhost:8787>.

You can still open `index.html` directly for the repo cards, but chat commands need the local server.

For private repos, create a GitHub personal access token:

1. Go to <https://github.com/settings/personal-access-tokens>.
2. Create a fine-grained token.
3. Give it read-only access to the repos you want to view.
4. Include repository metadata, issues, pull requests, and Actions read access where available.
5. Paste the token into the dashboard.

For OpenAI-powered command parsing, set `OPENAI_API_KEY` before launching. If it is not set, the chat falls back to a small built-in parser for commands like `show failing repos` and `show open PRs`.

## Chat Commands

The chat window is read-only. It can help with:

- `show failing repos`
- `show open PRs`
- `show issues for repo-name`
- `summarize repo-name`
- `open repo-name`
- `show stale repos`

It will not create, edit, merge, close, delete, push, or otherwise mutate GitHub data.

## Security Note

This is a personal local tool. If you choose to remember the token, it is stored in this browser's `localStorage`.

Do not publish a copy of this app with your token inside it. Use `Forget token` to clear the token from your browser. The OpenAI API key is read by the local server from your environment or the launcher prompt and is not stored by the app.

## Limits

- No backend or OAuth flow.
- No team sharing.
- Manual refresh only.
- Chat commands are read-only.
- GitHub API rate limits still apply.
