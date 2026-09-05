# GitHub Repo Card Dashboard

A free, local, personal dashboard that turns every GitHub repository you can reach into an informative card, with the ones that need you first.

Launch it locally, paste a GitHub token, and it loads your public and private repositories with CI status, pull requests waiting on review, recent commit activity, releases, languages and more. Nothing leaves your browser except calls to GitHub (and, optionally, the local chat server).

## Features

**Attention-first layout**
- `Needs attention` section ranked by urgency: failing Actions first, then PRs with changes requested or awaiting review, open PRs and issues, then repos that have gone quiet.
- Every attention card explains *why* it is there with reason chips.

**Informative cards**
- Owner avatar, language stripe, visibility, fork/archived/template flags.
- Latest Actions run status plus a mini history of the last six runs.
- Open PR count with how many are waiting on review, open issue count.
- Stars, commits in the last 30 days, last push, default branch, topics.
- Quick links to the repo, issues, PRs, latest workflow run, and a one-click HTTPS clone URL copy.

**Detail drawer**
- Click any card for a slide-over with stats (stars, forks, watchers, size, created), the latest workflow run, the most recently updated open PRs with review decision, open issues, latest commit and release, a language breakdown, topics, links (including Pulse, Releases and homepage) and HTTPS / SSH / `gh` clone commands.

**Overview and insights**
- Summary tiles for repos, attention, failing CI, PRs awaiting review, open issues, commits (30d), stale repos and stars. Click a tile to filter.
- Language mix, push-recency histogram and most-starred repos for the current view.

**Finding things**
- Search across name, owner, description, language, branch, topics, license, CI state and activity (multi-word search matches all terms).
- Owner and language filters, quick-filter chips (needs attention, failing CI, review needed, open PRs/issues, active this week, stale, private, forks, archived) and eight sort orders.
- Cards / compact density toggle.

**Quality of life**
- Light, dark and system themes.
- Optional auto refresh (5 / 15 / 30 minutes) with a progress bar during loads.
- Cached data shown instantly on launch while GitHub refreshes.
- GitHub API budget shown at the bottom of the page.
- Keyboard shortcuts: `/` search, `R` refresh, `C` chat, `Esc` close.
- Token can be remembered in `localStorage` or kept only for the current tab.
- `Forget token` clears the token and cached repo data.

**Chat**
- Local chat window for read-only questions, with clickable suggestions and rendered links.

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
4. Include repository **Metadata**, **Contents**, **Issues**, **Pull requests** and **Actions** read access where available. Missing scopes degrade gracefully (for example, Actions status shows as unavailable).
5. Paste the token into the dashboard.

For OpenAI-powered command parsing, set `OPENAI_API_KEY` before launching. If it is not set, the chat falls back to a small built-in parser. The chat header shows which mode is active.

## Chat Commands

The chat window is read-only. It can help with:

- `overview` (totals, failing repos, busiest repos)
- `show failing repos`
- `which PRs need review?`
- `show open PRs`
- `show issues for repo-name`
- `what changed recently?`
- `show stale repos`
- `summarize repo-name`
- `open repo-name`

It will not create, edit, merge, close, delete, push, or otherwise mutate GitHub data.

## Development

```sh
npm test
```

## Security Note

This is a personal local tool. If you choose to remember the token, it is stored in this browser's `localStorage`; otherwise it is kept in `sessionStorage` and forgotten when the tab closes.

Do not publish a copy of this app with your token inside it. Use `Forget token` to clear the token from your browser. The OpenAI API key is read by the local server from your environment or the launcher prompt and is not stored by the app.

## Limits

- No backend or OAuth flow.
- No team sharing.
- Chat commands are read-only.
- GitHub API rate limits still apply. Each refresh costs roughly one GraphQL point per five repos plus one REST call per non-archived repo for Actions status.
