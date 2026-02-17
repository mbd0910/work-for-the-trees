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

- **`src/git.ts`** — Pure data layer. All types are defined here (`DashboardState`, `WorktreeData`, etc.). Every function takes explicit params and uses `Bun.spawn` to call git. The key orchestrator is `getFullState(repoPaths)` which discovers worktrees across all repos in parallel, then fetches base branch, plan files, divergence, and uncommitted changes for each worktree concurrently via `Promise.all`.

- **`src/watcher.ts`** — Two update mechanisms feed into a single `onUpdate` callback: chokidar watches `.claude/plans/` directories for instant plan file changes (debounced 300ms), and a polling interval (3s) calls `getFullState` for git data. Change detection uses `JSON.stringify` comparison to avoid no-op broadcasts. New worktrees are automatically picked up and their plan dirs added to chokidar.

- **`src/server.ts`** — Hono app with `createBunWebSocket`. Tracks WebSocket clients in a `Set`. The watcher's `onUpdate` callback broadcasts state to all clients. New connections receive the current state immediately in `onOpen`. Debug endpoint at `GET /api/state`.

- **`src/index.ts`** — CLI entry point. Validates each repo path is a git repo, then wires `createApp` → `start`.

- **`public/index.html`** — Single file, all CSS/JS inline. Receives `DashboardState` JSON over WebSocket. Full DOM re-render on each message (state is small). Plan expand/collapse state is preserved across re-renders via a `Set`. Uses `marked.js` from CDN for markdown.

## Conventions

- TypeScript strict mode, no classes — functions and plain objects/interfaces only
- All git operations via `Bun.spawn` (not `child_process`), using `Bun.file` for file reads
- `runGitSafe` pattern: returns `null` on failure instead of throwing, enabling graceful degradation
- Frontend is vanilla HTML/CSS/JS with no build step — no framework, no bundler
- Dark mode only, monospace font, GitHub-dark-inspired color palette

## Critical constraint

This is a **read-only** tool. It must NEVER write to, modify, or interfere with any watched repository. All git commands are read-only (`worktree list`, `log`, `diff`, `status`, `rev-parse`, `merge-base`, `rev-list`). All file access is read-only.
