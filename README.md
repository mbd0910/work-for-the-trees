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
| **Merged** | Branch PR merged on GitHub, or branch merged into local base |

## PR merge detection

If the [GitHub CLI](https://cli.github.com/) (`gh`) is installed and authenticated, the dashboard automatically detects when a worktree's branch has been merged via pull request — including squash merges. PR number, title, and a clickable link are shown on each card. This runs on a 60-second polling interval to stay within API rate limits.

Without `gh`, merge detection falls back to local-only ancestry checks (which only detect regular merges after pulling the base branch).

## Configuration

Create `~/.config/work-for-the-trees/config.json` to configure persistent settings (see `config.example.json`):

```json
{
  "ide": "cursor"
}
```

### Open in IDE

When `ide` is configured, each worktree card shows a button to open that worktree in your editor. Supported presets:

| Preset | Editor |
|--------|--------|
| `code` | VS Code |
| `cursor` | Cursor |
| `zed` | Zed |
| `subl` | Sublime Text |
| `webstorm` | WebStorm |
| `idea` | IntelliJ IDEA |

For other editors, use a command template with `{path}` as the worktree path placeholder:

```json
{
  "ide": "open -a Nova {path}"
}
```

The `--ide` CLI flag overrides the config file for a single session:

```bash
work-for-the-trees ~/code/project --ide code
```

## API

The dashboard exposes JSON endpoints for external tooling and automation:

- **`GET /api/state`** — full dashboard state (all worktrees with status, divergence, PR state, etc.)
- **`GET /api/merged`** — just the merged worktrees, slim shape for cleanup scripts:
  ```json
  [{ "repo": "my-project", "branch": "feature-x", "path": "/home/user/...", "repoPath": "/home/user/...", "pr": { "state": "merged", "number": 42, "title": "Add feature X", "url": "https://github.com/..." } }]
  ```

Example — clean up all merged worktrees for a repo:
```bash
curl -s localhost:4040/api/merged | jq -r '.[].path' | xargs -I{} git worktree remove {}
```

## Tech stack

Bun, Hono, chokidar, vanilla HTML/CSS/JS. No build step.

## License

MIT
