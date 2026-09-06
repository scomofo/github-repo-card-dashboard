# GitHub Repo Card Dashboard

A local macOS repository dashboard: double-click **Repo Dashboard.app**, then clone and safely update your GitHub repositories from their cards. Repository activity, failing CI, reviews, and issues stay together in the same view.

The app is a macOS launcher for a browser interface backed by a local Node.js server. Node.js and Git are prerequisites; they are not bundled. Cloning downloads repository source code. It does not install each project's dependencies, execute its scripts, or turn arbitrary repositories into macOS applications.

## Install on macOS

1. Install **Node.js 20 or newer** from [nodejs.org](https://nodejs.org/) (choose LTS).
2. Make sure Git works. If needed, open Terminal, run `xcode-select --install`, and finish installing Apple's Command Line Tools.
3. Clone this repository or download and extract its ZIP from GitHub.
4. Double-click **`install-macos.command`** in the extracted project folder. The installer creates **`~/Applications/Repo Dashboard.app`** and opens it.
5. Drag the app into your Dock if you want. From now on, double-clicking it starts the local service, waits until it is ready, and opens your default browser. Repeated launches reuse the running service.

The installer copies the app's runtime to `~/Library/Application Support/Repo Dashboard`; it does not require administrator access or `npm install`. Repository checkouts are kept separately under `~/Developer/GitHub/OWNER/REPO`.

If a downloaded ZIP did not retain executable permissions, run the installer with Bash instead (replace the path with your extracted folder):

```sh
bash "/path/to/github-repo-card-dashboard/install-macos.command"
```

The installer signs its generated app locally for bundle integrity; it does not provide a Developer ID signature or notarization. Downloaded scripts and the generated app may trigger macOS security prompts. If your Mac's software policy blocks them, use your organization's approved software process.

## Clone and update repositories

Connect GitHub in the dashboard to load your repository cards, then use:

| Control | What it does |
| --- | --- |
| **Clone to Mac** | Downloads the repository into `~/Developer/GitHub/OWNER/REPO`. |
| **Check & update** | Fetches from GitHub and fast-forwards a clean checkout on its matching upstream branch. |
| **Update installed** | Updates eligible repositories in sequence and reports the result for each. |
| **Scan local status** | Refreshes local checkout status. |
| **Finder / Terminal** | Opens the installed repository's folder on your Mac. |

Updates stop when there are local changes, a conflicting destination, an unexpected origin, a detached branch, or a missing/mismatched upstream. The dashboard never force-pulls, resets, stashes, deletes a checkout, or installs project dependencies. Status counts describe the repositories currently loaded into the dashboard. An update fetches before checking whether remote commits are available; a scan alone does not fetch every repository.

For private repositories, configure **Git's own credentials** before cloning. If you use [GitHub CLI](https://cli.github.com/), run `gh auth login`, then `gh auth setup-git` in Terminal. Existing Git credential helpers also work. The browser's GitHub token is used for repository information and read-only chat; local clone/update actions use Git credentials and do not receive that browser token. Interactive Git credential prompts are disabled for dashboard operations, so resolve sign-in problems in Terminal first.

To update the dashboard itself, download or pull the latest project and run `install-macos.command` again. The installer stages a replacement, waits for the launched service to stop safely, and preserves the previous installation if replacement fails. If a Git operation is still finishing, wait and rerun the installer. Your checkouts remain separate and are not removed.

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
- macOS without installing an app: double-click `launch-dashboard.command`, or run `bash launch-dashboard.command`.
- Any platform with Node.js: run `npm start`, then open [the local dashboard](http://127.0.0.1:8787).

You can still open `index.html` directly for repository cards, but local clone/update controls and chat require the local server. Finder and Terminal shortcuts require macOS.

The macOS launcher keeps the server running when you close the browser. To stop it:

```sh
bash "$HOME/Library/Application Support/Repo Dashboard/launch-dashboard.command" --stop
```

For an uninstalled checkout, use `bash launch-dashboard.command --stop`. A server started with `npm start` is stopped with Control-C in its Terminal window. Launcher logs are at `~/Library/Logs/Repo Dashboard/server.log`.

You can set a different repository root or port when starting from Terminal:

```sh
REPO_DASHBOARD_ROOT="$HOME/Projects" PORT=8788 bash launch-dashboard.command
```

Stop a running instance before changing these settings. Use the same `PORT` when stopping a custom-port instance. The app opened from Finder uses the defaults unless its environment has been configured separately. If port 8787 belongs to another program, the launcher reports the conflict instead of opening that service.

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

Do not publish a copy of this app with your token inside it. Use `Forget token` to clear the token from your browser. The OpenAI API key is read by the local server from your environment and is not stored by the app. No OpenAI key is needed for launching, cloning, updating, or built-in read-only chat commands.

The server binds to `127.0.0.1`. Local repository routes require the dashboard's same-origin session protection. The local manager rejects unexpected repository origins and paths that escape the configured root. Do not expose the local server through a public proxy or share a browser profile containing your token.

## Limits

- No hosted backend or OAuth flow; GitHub dashboard access uses a personal access token.
- No bundled Node.js or Git, Developer ID signature, or notarized installer.
- Repository installation means cloning source; running each project remains a separate step.
- No team sharing.
- Chat commands are read-only.
- GitHub API rate limits still apply. Each refresh costs roughly one GraphQL point per five repos plus one REST call per non-archived repo for Actions status.
