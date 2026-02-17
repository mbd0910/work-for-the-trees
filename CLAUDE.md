# CLAUDE.md

## Project: work-for-the-trees

Browser-based dashboard for monitoring git worktrees and Claude Code plan files in real time. Tagline: "Can't see the work for the trees."

## Architecture

- `src/index.ts` — Entry point. CLI arg parsing, validation, starts the server.
- `src/server.ts` — Hono web server with HTTP routes and WebSocket endpoint.
- `src/git.ts` — All git operations: worktree discovery, base branch detection, divergence calculation, plan file reading. Pure functions, no side effects.
- `src/watcher.ts` — Orchestrates filesystem watching (chokidar for plan files) and polling (git data every 3s). Triggers WebSocket broadcasts on changes.
- `public/index.html` — Single-file frontend. Inline CSS and JS. No build step.

## Conventions

- TypeScript strict mode
- No classes — use functions and plain objects/interfaces
- Minimal dependencies: hono (web framework), chokidar (file watching), and that's it
- All git operations via `Bun.spawn` calling the git CLI
- Functions that can fail return `null` rather than throwing (`runGitSafe` pattern)
- Bun runtime only — uses `Bun.spawn`, `Bun.file`, `Bun.serve`

## Running locally

```bash
bun install
bun run dev -- <path-to-git-repo>
```

Dashboard opens at `http://localhost:4040`. Custom port:
```bash
bun run dev -- <path-to-git-repo> --port 8080
```

## Testing

Manual testing for v1. Point at a repo with active worktrees and verify:

1. Cards render for each worktree with real branch names and commit data
2. Plan files display as formatted markdown, collapse/expand works
3. New commits appear within 3-5 seconds
4. Plan file edits appear immediately (~300ms)
5. Status badges update correctly (no-plan / planning / in-progress / idle)
6. Main worktree card is visually de-emphasised

## Critical principle

This is a **read-only** tool. It must NEVER write to, modify, or interfere with the watched repository. All git commands are read-only. All file access is read-only.
