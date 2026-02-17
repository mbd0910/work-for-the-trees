I'm building an open-source local development tool called work-for-the-trees.
Tagline: "Can't see the work for the trees"

It's a browser-based dashboard for developers running parallel AI coding 
agents across multiple git worktrees. You leave it open in a browser tab 
while your agents work — it gives you a real-time read-only view of what's 
happening across all your worktrees so you don't have to fight with tmux 
panes.

## Core functionality

Given a git repository path, the tool:
1. Discovers all active git worktrees via `git worktree list --porcelain`
2. Finds Claude Code plan files in each worktree's .claude/plans/ directory 
   (Claude Code's Plan Mode persists plans here by default, configurable 
   via plansDirectory in .claude/settings.json)
3. Calculates git divergence from each worktree's base branch
4. Serves a web UI on localhost rendering one card per worktree
5. Updates in real-time via WebSocket as plans are written and commits land

## Per-worktree card displays

- Branch name (prominently)
- Base branch — detected via `git rev-parse --abbrev-ref @{upstream}`, 
  falling back to shortest merge-base distance against main/develop/master
- Rendered plan file(s) as formatted markdown. There may be multiple plan 
  files per worktree — show all of them, most recently modified first
- Git divergence from base branch:
  - Number of commits ahead
  - Commit messages listed (most recent first)
  - Files changed summary: added/modified/deleted counts
- Derived status badge, based purely on observable data:
  - "No plan" — no plan files found, no commits ahead
  - "Planning" — plan file(s) exist, zero commits ahead of base
  - "In progress" — commits ahead of base exist
  - "Idle" — in progress but last commit older than threshold (default 5 min)
  - "Done" — could be indicated if the branch has been merged, but not 
    essential for v1

## Tech stack

- Bun runtime
- Hono web framework
- chokidar for filesystem watching on plan files
- Simple polling interval for git data (every 3-5 seconds — git commands 
  are cheap)
- WebSocket (via Hono's built-in support) for pushing updates to browser
- Vanilla HTML/CSS/JS for the frontend — no framework, no build step
- marked.js loaded from CDN for markdown rendering
- Single HTML page served from public/index.html, CSS and JS inline

## Project structure
├── src/
│   ├── index.ts          # Entry point, CLI arg parsing, starts server
│   ├── server.ts         # Hono app, routes, WebSocket setup
│   ├── git.ts            # Worktree discovery, divergence calc, base
│   │                     # branch detection
│   └── watcher.ts        # Filesystem watching, change detection,
│                         # polling orchestration
├── public/
│   └── index.html        # Single-file frontend with inline CSS/JS
├── package.json
├── tsconfig.json
├── CLAUDE.md             # Project conventions for Claude Code sessions
├── AGENTS.md             # Tool-agnostic agent instructions (Claude Code,
│                         # Cursor, Codex etc all read this)
├── README.md
├── LICENSE               # MIT
└── .gitignore

## Usage
```bash
# Install globally
bun install -g [package-name]

# Point it at any repo — discovers worktrees automatically
[name] ~/code/my-project

# Custom port
[name] ~/code/my-project --port 3456

# Auto-open browser
[name] ~/code/my-project --open
```

## Design

- Dark mode by default. Developer-oriented aesthetic — think terminal 
  vibes, not corporate dashboard
- Cards in a responsive grid that works well with 1-6 worktrees
- Status badges should be the first thing your eye hits on each card — 
  colour coded (subtle, not garish)
- Plan markdown should be collapsible/expandable per card since plans 
  can be long
- Commit messages shown as a compact list, not taking over the card
- The main worktree (the repo itself) should either be excluded or 
  visually de-emphasised since it's not a parallel work branch

## Key design principles

- Zero configuration required in the target repo. Works with vanilla 
  git and default Claude Code plan mode settings out of the box
- No dependency on Claude Code — it just reads files and git data. 
  Useful for anyone using worktrees regardless of their AI tooling
- Lightweight enough to leave running all day as a background process
- No write operations to the watched repo — strictly read-only, 
  it must never interfere with the agents or git state

## CLAUDE.md should include

- Project architecture and file responsibilities
- Coding conventions: TypeScript strict mode, no classes (functions 
  and modules), minimal dependencies
- How to run locally during development
- How to test (manual for v1 — point at a test repo with worktrees)
- The principle that this is a read-only tool — never write to the 
  watched repo

## AGENTS.md should include

- Same core info as CLAUDE.md but tool-agnostic framing
- Brief explanation of what the project does and who it's for
- File structure guide so agents can navigate quickly

## What to build first

Get the full loop working end to end:
1. Accept a repo path from CLI args
2. Discover worktrees
3. Find plan files
4. Calculate git divergence  
5. Serve a page that renders real cards with real data
6. WebSocket updates when things change

I want to run this against my actual worktrees and see something 
useful immediately. Polish later, working data first.