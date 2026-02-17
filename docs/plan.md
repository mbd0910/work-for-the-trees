# Plan: work-for-the-trees — first end-to-end build

## Context

Building a greenfield local dev tool: a browser-based dashboard that monitors git worktrees and Claude Code plan files in real time. The repo currently has only a README and prompt.md — everything needs to be created from scratch.

**Scope for this session** (from "What to build first"):
1. Accept a repo path from CLI args
2. Discover worktrees
3. Find plan files
4. Calculate git divergence
5. Serve a page with real cards and real data
6. WebSocket updates when things change

## Implementation order

### Step 1: Project scaffolding
Create `package.json`, `tsconfig.json`, `.gitignore`, then `bun install`.

- **package.json**: deps are `hono` + `chokidar`, devDeps are `@types/bun` + `typescript`. `bin` field points to `src/index.ts` (Bun runs TS directly). Scripts: `dev` uses `bun run --watch`, `start` is plain `bun run`.
- **tsconfig.json**: strict mode, ESNext target/module, bundler moduleResolution, types includes bun-types.

### Step 2: `src/git.ts` — core data layer (no internal deps)

**Types** (all exported):
```
Worktree        { path, head, branch, isMainWorktree }
Commit          { hash, message, timestamp }
FileChanges     { added, modified, deleted }
PlanFile        { filename, path, content, modifiedAt }
WorktreeStatus  "no-plan" | "planning" | "in-progress" | "idle"
WorktreeData    { path, branch, baseBranch, isMainWorktree, status, commitsAhead, commits, fileChanges, planFiles, lastCommitTimestamp }
DashboardState  { repoPath, worktrees: WorktreeData[], updatedAt }
```

**Functions** (all use `Bun.spawn` for git, no `child_process`):

- `runGit(cwd, args)` / `runGitSafe(cwd, args)` — helper to exec git commands. Safe variant returns `null` on failure.
- `discoverWorktrees(repoPath)` — parses `git worktree list --porcelain`. Split on `\n\n`, extract path/HEAD/branch from each block. First block = main worktree.
- `detectBaseBranch(worktreePath)` — try `@{upstream}` first (fast path: if it strips to main/master/develop, use it). Fallback: for each candidate branch that exists, compute merge-base distance, pick shortest.
- `calculateDivergence(worktreePath, baseBranch)` — `git log base..HEAD --format=%H%x00%s%x00%aI` for commits; `git diff base...HEAD --name-status` for file change counts.
- `findPlanFiles(worktreePath)` — read `.claude/plans/` dir, filter `.md`, read content + mtime, sort by mtime desc. Returns `[]` if dir doesn't exist.
- `deriveStatus(planFiles, commitsAhead, lastCommitTimestamp)` — pure function implementing the status badge logic (no-plan / planning / in-progress / idle with 5min threshold).
- `getFullState(repoPath)` — orchestrator: discovers worktrees, then `Promise.all` over them to fetch base branch + plans + divergence in parallel.

### Step 3: `src/watcher.ts` — change detection + broadcast

Two update mechanisms:
1. **chokidar** watches all `<worktree>/.claude/plans/` dirs — debounced 300ms, triggers full state refresh + broadcast
2. **Polling interval** (3s) calls `getFullState`, compares via `JSON.stringify` to avoid no-op broadcasts

On each poll, checks for new worktrees and adds their plan dirs to chokidar dynamically.

Exports `startWatching({ repoPath, pollIntervalMs, onUpdate })` → returns a `stop()` cleanup function.

### Step 4: `src/server.ts` — Hono app + WebSocket

```typescript
import { upgradeWebSocket, websocket } from "hono/bun"
```

- Tracks connected clients in a `Set<WSContext>`
- `GET /` serves `public/index.html` via `Bun.file`
- `GET /ws` upgrades to WebSocket. `onOpen` adds client + sends current state. `onClose` removes client. `onMessage` ignored (read-only).
- `GET /api/state` returns current state as JSON (useful for debugging)
- `broadcast(state)` sends JSON to all clients
- Exports `createApp(repoPath)` which returns `{ app, start(port) }`
- `start()` calls `startWatching` with `broadcast` as the callback, then `Bun.serve({ port, fetch: app.fetch, websocket })`

### Step 5: `src/index.ts` — CLI entry point

- Parses `Bun.argv.slice(2)`: positional repo path (required), `--port` (default 3000), `--open`, `--help`
- Validates repo path is a git repo via `git rev-parse --git-dir`
- Calls `createApp(repoPath).start(port)`
- `--open` spawns `open` (macOS) / `xdg-open` (Linux)
- SIGINT/SIGTERM handlers for graceful shutdown

### Step 6: `public/index.html` — single-file frontend

All CSS and JS inline. No build step.

**Design**: Dark mode, monospace font, terminal aesthetic. GitHub-dark-inspired color palette (`#0d1117` bg, `#161b22` cards, `#30363d` borders).

**Card grid**: `display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr))` — responsive for 1-6 worktrees.

**Per card**:
- Branch name (prominent) + base branch (muted, below)
- Status badge (top-right): color-coded pill — gray (no-plan), amber (planning), green (in-progress), red (idle). Subtle tinted backgrounds using `color-mix`.
- Divergence section: "N commits ahead" + file change counts (green +added, amber ~modified, red -deleted) + compact scrollable commit list (max-height 120px)
- Plan section: collapsible `<button>` toggle per plan file, content rendered via `marked.parse()`, max-height 400px with scroll. Collapse/expand state persisted across re-renders via a `Set`.

**Main worktree**: card rendered with `opacity: 0.5` and dimmer border to de-emphasise.

**WebSocket client**: connects to `/ws`, auto-reconnects after 2s on close, connection status dot in header. On message, parses JSON and full re-renders the grid (state is small, updates infrequent — simpler than DOM diffing).

**Sorting**: main worktree last; others sorted by activity priority (in-progress > planning > idle > no-plan).

**marked.js**: loaded from `https://cdn.jsdelivr.net/npm/marked/lib/marked.umd.js`.

### Step 7: `CLAUDE.md` + `AGENTS.md`

Per the spec: architecture, conventions (strict TS, no classes, minimal deps), how to run, how to test (manual for v1), read-only principle. AGENTS.md is the tool-agnostic version.

## Edge cases handled

- **Single worktree (no linked ones)**: renders one de-emphasised main card
- **No plan files**: plan section omitted, status correctly derives
- **Missing `.claude/plans/` dir**: `readdir` catch returns `[]`
- **Git command failures**: `runGitSafe` returns null, graceful degradation
- **New worktree added while running**: picked up on next poll cycle, plan dir added to chokidar
- **WebSocket disconnect**: auto-reconnect, current state sent on reconnect

## Verification

1. `bun install` succeeds
2. `bun run dev -- <path-to-repo-with-worktrees>` starts server
3. Browser at `localhost:3000` shows cards with real branch names, real commit data
4. Edit a plan file in a worktree → card updates within ~300ms
5. Make a commit in a worktree → card updates within ~3s
6. Status badges reflect actual state (planning vs in-progress vs idle)
7. Plans render as formatted markdown, collapse/expand works
8. Main worktree card is visually de-emphasised
