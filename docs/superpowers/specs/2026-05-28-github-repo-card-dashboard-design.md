# GitHub Repo Card Dashboard Design

## Goal

Build a free, personal GitHub dashboard that runs locally as a static HTML app. The first version focuses on repositories as cards, with an attention-first layout that highlights repos needing review before showing the full repo grid.

## Users And Scope

The app is for one person using their own browser. It supports public and private repositories through a GitHub personal access token. It does not include accounts, teams, a backend, deployment, shared dashboards, or database storage.

## Recommended Approach

Use a local static app:

- One `index.html` file for the first version.
- Vanilla HTML, CSS, and JavaScript.
- GitHub REST API calls from the browser.
- Token stored in `localStorage` after the user chooses to remember it.
- A visible `Forget token` button that clears stored credentials.

This keeps the tool free, portable, easy to inspect, and simple to run from the filesystem.

## Layout

The dashboard uses an attention-first structure:

1. Top bar with connection status, search, owner/org filter, refresh, and `Forget token`.
2. `Needs attention` section with repo cards for repositories that have open PRs, open issues, failed workflow runs, or stale activity.
3. `All repos` section with a responsive grid of every accessible repository.

The interface should be dense enough for repeated use but still card-based and scannable.

## Repo Card Fields

Each repo card shows:

- Repository name and owner.
- Public/private visibility.
- Description, when available.
- Primary language.
- Last pushed date.
- Default branch.
- Open issue count.
- Open pull request count.
- Latest workflow status when available.
- Quick links for repo, issues, pull requests, Actions, and clone URL.

## Data Flow

On load:

1. Read token from `localStorage`.
2. If no token exists, show a token entry screen.
3. Fetch repositories through the GitHub API.
4. Fetch per-repo status details for visible repos.
5. Normalize API responses into repo card objects.
6. Sort attention cards before all other repos.
7. Render cards and summary counts.

Refresh is manual for the first version. The app may cache the last successful response in `localStorage` so the screen can remain useful if a refresh fails.

## Error Handling

Errors should be visible but not fatal when possible:

- Missing token: show token setup.
- Bad token: show a clear authentication error and offer to replace/forget token.
- Rate limit: show reset time if GitHub provides it.
- Partial repo failure: show the repo card with unavailable fields marked as unknown.
- Workflow API unavailable or disabled: omit workflow status for that repo.

## Token Guidance

The app should recommend a fine-grained GitHub token with read-only access where possible. The app stores the token in `localStorage` only because the user chose browser persistence for a personal local tool. The UI must make this tradeoff clear and provide a one-click way to remove the token.

## Testing

Manual checks for the first version:

- No token.
- Invalid token.
- Valid token with public repos only.
- Valid token with private repos.
- Repo with open issues and PRs.
- Repo with passing Actions.
- Repo with failing Actions.
- Repo with no Actions.
- Search/filter behavior.
- Forget token behavior.

## Deferred

These are intentionally out of scope for the first version:

- Backend proxy.
- OAuth login.
- Multi-user/team support.
- Automatic background refresh.
- Notifications.
- Git write actions.
- Issue or PR editing from the dashboard.
