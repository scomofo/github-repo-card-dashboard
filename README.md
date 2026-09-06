# GitHub Repo Card Dashboard

A local macOS repository dashboard: double-click a repository card to install it on your Mac, including supported project dependencies and a launcher. Double-click an installed card to update its code and dependencies. Repository activity, failing CI, reviews, and issues stay together in the same view.

The dashboard is a macOS launcher for a browser interface backed by a local Node.js server. Node.js and Git are prerequisites; they are not bundled. Automatic project setup supports Node.js apps with a root `package.json` and a `dev` or `start` script, plus static sites with a root `index.html`. Other repositories are downloaded locally with guidance for manual setup.

## Install on macOS

1. Install **Node.js 24 LTS** from [nodejs.org](https://nodejs.org/en/download). The dashboard itself supports Node 20+, but individual repositories can require newer versions.
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

## Install, update, and run your repositories

1. Connect GitHub in the dashboard to load your repository cards.
2. **Double-click a repository card** to download its code and install its dependencies. Installation runs that project's package-manager lifecycle scripts, so use it for repositories you trust.
3. When setup finishes, choose **Launch app**. The dashboard creates a reusable launcher at **`~/Applications/Repo Apps/OWNER/REPO.command`**; you can also double-click that file in Finder later.
4. Double-click a clean, ready card again when you want to fetch updates and refresh its dependencies. If the checkout has local changes or unpublished commits, double-click launches the existing app instead. Restart a running project to use updated code.

Choose **Details** to inspect a repository without installing or updating it. The card controls also expose these actions directly:

| Control | What it does |
| --- | --- |
| **Install locally** | Downloads the repository into `~/Developer/GitHub/OWNER/REPO`, sets up supported dependencies, and creates its launcher. Existing source downloads are set up in place. |
| **Update app** | Fetches from GitHub, fast-forwards an eligible checkout on its matching upstream branch, and refreshes project setup. |
| **Launch app** | Starts the installed project's launch command in Terminal. |
| **Update installed** | Updates eligible repositories in sequence and reports the result for each. |
| **Scan local status** | Refreshes local checkout status. |
| **Finder / Terminal** | Opens the installed repository's folder on your Mac. |

For Node.js apps, setup selects the project's package manager from its declaration or lockfile and uses its `dev` script when available, otherwise `start`. When a project has `start` and `build` but no `dev` script, installation also runs its build. Standalone Electron packaging commands are skipped: running an Electron app from source does not need an installer package, and a Windows packaging target must not run during Mac setup. Compilation followed by packaging is still treated as a build. The selected package manager must already be installed; modern Yarn projects need a committed `yarn.lock`. Setup does not install global runtimes or configure API keys, databases, environment files, or other external services.

Static sites run through a local server. A build-free site can also have a `package.json` used only for tests, linting, or formatting; those development dependencies are not installed for its browser launcher. Projects needing compilation, runtime packages, or custom setup still require a supported launch script. Unsupported projects keep their downloaded code and show a manual-setup message instead of being marked ready to launch.

Project setup records and install logs live in `~/Library/Application Support/Repo Dashboard Projects/OWNER/`, outside both your checkouts and the dashboard runtime. Reinstalling the dashboard preserves these records and the project launchers.

Updates stop when there are local changes, a conflicting destination, an unexpected origin, a detached branch, or a missing/mismatched upstream. The dashboard never force-pulls, resets, stashes, or deletes a checkout. Project install scripts can create or change files; those changes may need attention before the next update. If dependency setup fails after a successful Git update, the fetched code remains in place and setup can be retried. Status counts describe the repositories currently loaded into the dashboard. An update fetches before checking whether remote commits are available; a scan alone does not fetch every repository.

For private repositories, configure **Git's own credentials** before cloning. If you use [GitHub CLI](https://cli.github.com/), run `gh auth login`, then `gh auth setup-git` in Terminal. Existing Git credential helpers also work. The browser's GitHub token is used for repository information and read-only chat; local clone/update actions use Git credentials and do not receive that browser token. Interactive Git credential prompts are disabled for dashboard operations, so resolve sign-in problems in Terminal first.

To update the dashboard itself, download or pull the latest project and run `install-macos.command` again. The installer stages a replacement, waits for the launched service to stop safely, and preserves the previous installation if replacement fails. If a Git operation is still finishing, wait and rerun the installer. Your checkouts remain separate and are not removed.

### If an installation fails

The result identifies the failed stage and, when recognized, its cause: for example a Node version requirement, a dependency conflict, a lockfile mismatch, a network problem, disk space, or folder permissions. The dashboard does not delete lockfiles, disable certificate checks, or force incompatible dependency versions to make a retry pass.

For dependency failures, open the displayed `REPO.install.log`. Git command failures also write a `REPO.git.log` when the diagnostic folder is writable. In Finder, choose **Go → Go to Folder** and paste `~/Library/Application Support/Repo Dashboard Projects/OWNER/`, replacing `OWNER` with your GitHub name. Open the relevant log in TextEdit. Logs remain on your Mac with private file permissions and common credential formats redacted; inspect them for other sensitive output before sharing an excerpt.

Include the final error lines when reporting an issue. A failed build is recorded separately from dependency installation, and the log includes the dashboard's Node version and processor. For comparison, these read-only Terminal commands show the versions in your current shell:

```sh
node --version
npm --version
```

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
- Choose a card’s **Details** button for a slide-over with stats (stars, forks, watchers, size, created), the latest workflow run, the most recently updated open PRs with review decision, open issues, latest commit and release, a language breakdown, topics, links (including Pulse, Releases and homepage) and HTTPS / SSH / `gh` clone commands.

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

You can still open `index.html` directly for repository cards, but local install/update/launch controls and chat require the local server. Finder and Terminal shortcuts require macOS.

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

Do not publish a copy of this app with your token inside it. Use `Forget token` to clear the token from your browser. The OpenAI API key is read by the local server from your environment and is not stored by the app. No OpenAI key is needed for the dashboard's local install/update/launch controls or built-in read-only chat commands; individual projects may have their own requirements.

The server binds to `127.0.0.1`. Local repository routes require the dashboard's same-origin session protection. The local manager rejects unexpected repository origins and paths that escape the configured root. Do not expose the local server through a public proxy or share a browser profile containing your token.

## Limits

- No hosted backend or OAuth flow; GitHub dashboard access uses a personal access token.
- No bundled Node.js or Git, Developer ID signature, or notarized installer.
- Automatic app setup covers root-level Node.js `dev`/`start` projects and static `index.html` sites. Monorepo-specific setup, other languages, native app packaging, and external services may require manual steps.
- Dependency installation and project launch execute repository code on your Mac. A successful install means setup completed and a launcher was created; the project may still require its own configuration to run.
- No team sharing.
- Chat commands are read-only.
- GitHub API rate limits still apply. Each refresh costs roughly one GraphQL point per five repos plus one REST call per non-archived repo for Actions status.
