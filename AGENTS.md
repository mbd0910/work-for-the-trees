# AGENTS.md

## What is this?

work-for-the-trees is a browser-based dashboard that monitors git worktrees and Claude Code plan files in real time. It shows one card per worktree with branch info, commit divergence, plan file content, and a derived status badge.

## Who is it for?

Developers running parallel AI coding agents across multiple git worktrees. You leave it open in a browser tab while agents work.

## File structure

| File | Purpose |
|------|---------|
| `src/index.ts` | CLI entry point, arg parsing, startup |
| `src/server.ts` | Hono HTTP + WebSocket server |
| `src/git.ts` | Git operations (worktree discovery, divergence, plans) |
| `src/watcher.ts` | File watching + polling orchestration |
| `public/index.html` | Frontend (inline CSS/JS, no build step) |

## Key constraints

- TypeScript strict mode, no classes — functions and plain objects only
- Read-only: never writes to the watched repo
- Bun runtime only (uses Bun.spawn, Bun.file, Bun.serve)
- Frontend: vanilla HTML/CSS/JS, marked.js from CDN
- Minimal dependencies: hono + chokidar

## Running

```bash
bun install
bun run dev -- <path-to-git-repo>
```
