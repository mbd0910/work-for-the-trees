# work-for-the-trees

> Can't see the work for the trees?

A browser-based dashboard for monitoring git worktrees and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plan files in real time.

Point it at any git repository — it discovers all worktrees automatically, shows branch info, commit divergence, plan file content, and a derived status badge for each. Updates live via WebSocket.

## Quick start

```bash
bun install
bun run dev -- ~/code/my-project
```

Opens at `http://localhost:4040`. Watch multiple repos at once:

```bash
bun run dev -- ~/code/project-a ~/code/project-b --open
```

## How it works

- Discovers worktrees via `git worktree list --porcelain`
- Finds Claude Code plan files in `.claude/plans/` directories
- Calculates git divergence from each worktree's base branch
- Watches for plan file changes (instant) and polls git data (every 3s)
- Pushes updates to the browser via WebSocket

## Status badges

| Badge | Meaning |
|-------|---------|
| **No plan** | No plan files, no commits ahead of base |
| **Planning** | Plan file(s) exist, zero commits ahead |
| **In progress** | Commits ahead of base branch |
| **Idle** | In progress but last commit >5 minutes ago |

## Tech stack

Bun, Hono, chokidar, vanilla HTML/CSS/JS. No build step.

## License

MIT
