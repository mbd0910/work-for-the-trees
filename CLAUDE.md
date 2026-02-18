# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install                                           # Install dependencies
bun run dev -- <repo-path> [repo-path...] [options]   # Dev mode with hot reload
bun run start <repo-path> [repo-path...]              # Production start
```

Options: `--port <number>` (default 4040), `--open` (auto-open browser), `--help`.

Multiple repo paths are supported — the dashboard shows all worktrees across all repos with a pill selector to filter by repo.

No test suite yet — manual testing by pointing at repos with active worktrees.

## Architecture

The data flows in one direction: **git CLI → git.ts → watcher.ts → server.ts → WebSocket → browser**.

- **`src/git.ts`** — Pure data layer. All types are defined here (`DashboardState`, `WorktreeData`, `PRState`, etc.). Every function takes explicit params and uses `Bun.spawn` to call git (and `gh` for PR state). The key orchestrator is `getFullState(repoPaths)` which discovers worktrees across all repos in parallel, then fetches base branch, plan files, divergence, uncommitted changes, and local merge status for each worktree concurrently via `Promise.all`. Remote PR state is managed separately via `checkPRState`/`applyRemoteState`. Plan discovery uses `buildPlanMapping` to find plans in Claude Code's global `~/.claude/plans/` directory (see Plan File Discovery below).

- **`src/watcher.ts`** — Three update mechanisms feed into a single `onUpdate` callback: chokidar watches `.claude/plans/` directories (both per-worktree and global `~/.claude/plans/`) for instant plan file changes (debounced 300ms), a fast polling interval (3s) calls `getFullState` for git data, and a slow polling interval (60s) checks GitHub PR merge status via `gh` CLI and rebuilds the plan mapping cache. The remote cache and plan mapping are merged into state before broadcasting. Change detection uses `JSON.stringify` comparison to avoid no-op broadcasts. New worktrees are automatically picked up and their plan dirs added to chokidar.

- **`src/server.ts`** — Hono app with `createBunWebSocket`. Tracks WebSocket clients in a `Set`. The watcher's `onUpdate` callback broadcasts state to all clients. New connections receive the current state immediately in `onOpen`. Endpoints: `GET /api/state` (full dashboard state), `GET /api/merged` (slim list of merged worktrees for cleanup automation).

- **`src/index.ts`** — CLI entry point. Validates each repo path is a git repo, then wires `createApp` → `start`.

- **`public/index.html`** — Single file, all CSS/JS inline. Receives `DashboardState` JSON over WebSocket. Full DOM re-render on each message (state is small). Plan expand/collapse state is preserved across re-renders via a `Set`. Uses `marked.js` from CDN for markdown.

## Conventions

- TypeScript strict mode, no classes — functions and plain objects/interfaces only
- All git operations via `Bun.spawn` (not `child_process`), using `Bun.file` for file reads
- `runGitSafe` pattern: returns `null` on failure instead of throwing, enabling graceful degradation
- Frontend is vanilla HTML/CSS/JS with no build step — no framework, no bundler
- Dark mode only, monospace font, GitHub-dark-inspired color palette

## Plan file discovery

Claude Code stores plan files globally in `~/.claude/plans/` with random names (e.g., `rosy-nibbling-puppy.md`) — not inside each worktree. To map plans back to worktrees, `buildPlanMapping` encodes each worktree path (replacing `/` with `-`) to find its project directory at `~/.claude/projects/<encoded-path>/`, then greps the 3 most recent session `.jsonl` files for plan file references. This mapping is cached and rebuilt every 60s. The assumption is that Claude Code uses the default `~/.claude/plans/` location — custom `plansDirectory` settings are not currently handled.

## Critical constraint

This is a **read-only** tool. It must NEVER write to, modify, or interfere with any watched repository. All git commands are read-only (`worktree list`, `log`, `diff`, `status`, `rev-parse`, `merge-base`, `rev-list`, `ls-remote`). All file access is read-only. The `gh pr view` command is also read-only (queries GitHub API, no local writes).

## Optional dependency

The [GitHub CLI](https://cli.github.com/) (`gh`) enables PR merge detection (including squash merges). If `gh` is not installed or not authenticated, the feature degrades gracefully to local-only merge detection.
