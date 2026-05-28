# GitHub Repo Card Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish a free local static GitHub dashboard that shows repositories as attention-first cards.

**Architecture:** The app is a single `index.html` file containing markup, CSS, and vanilla JavaScript. It stores a user-approved GitHub token in `localStorage`, fetches repository and per-repo status from GitHub REST APIs, normalizes the results into card view models, and renders an attention-first dashboard.

**Tech Stack:** HTML, CSS, vanilla JavaScript, GitHub REST API, local browser, `git`, `gh`.

---

### Task 1: Static App

**Files:**
- Create: `index.html`
- Create: `README.md`
- Create: `.gitignore`

- [ ] **Step 1: Create `index.html`**

Build a complete static page with token setup, attention-first cards, all-repo cards, search/filter controls, refresh, and token removal.

- [ ] **Step 2: Create `README.md`**

Document local use, token permissions, and security notes.

- [ ] **Step 3: Create `.gitignore`**

Ignore local brainstorming artifacts and OS clutter.

### Task 2: Manual Verification

**Files:**
- Verify: `index.html`

- [ ] **Step 1: Open the file in a browser**

Run the in-app browser or open `index.html` directly.

- [ ] **Step 2: Test no-token state**

Expected: token setup panel appears with clear instructions.

- [ ] **Step 3: Test UI controls without GitHub data**

Expected: no JavaScript syntax errors; token save, forget, search, filters, and refresh handlers are wired.

### Task 3: Publish To GitHub

**Files:**
- Modify: local Git repository metadata

- [ ] **Step 1: Initialize git if needed**

Run: `git init`

- [ ] **Step 2: Commit app files**

Run: `git add index.html README.md .gitignore docs/superpowers/specs/2026-05-28-github-repo-card-dashboard-design.md docs/superpowers/plans/2026-05-28-github-repo-card-dashboard.md && git commit -m "feat: add github repo card dashboard"`

- [ ] **Step 3: Create GitHub repository**

Run: `gh repo create scomofo/github-repo-card-dashboard --public --source=. --remote=origin --push`

- [ ] **Step 4: Confirm remote**

Run: `gh repo view scomofo/github-repo-card-dashboard --web=false`
