import chokidar from "chokidar";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  discoverWorktrees,
  getFullState,
  buildPlanMapping,
  checkGhAvailable,
  checkPR,
  checkBehindRemote,
  applyRemoteState,
} from "./git.ts";
import type { DashboardState, PRInfo } from "./git.ts";

export interface WatcherOptions {
  repoPaths: string[];
  pollIntervalMs?: number;
  remoteCheckIntervalMs?: number;
  onUpdate: (state: DashboardState) => void;
}

export type StopFn = () => Promise<void>;

export async function startWatching(options: WatcherOptions): Promise<StopFn> {
  const {
    repoPaths,
    pollIntervalMs = 3000,
    remoteCheckIntervalMs = 60000,
    onUpdate,
  } = options;

  // Check gh availability once at startup
  const ghAvailable = await checkGhAvailable();
  if (ghAvailable) {
    console.log("GitHub CLI detected — PR merge detection enabled (60s interval)");
  } else {
    console.log("GitHub CLI not available — PR merge detection disabled");
  }
  console.log("Remote behind-check enabled via git ls-remote (60s interval)");

  // Remote state caches
  const remoteCache = new Map<string, PRInfo | null>();
  const behindRemoteCache = new Map<string, number | null>();

  // Plan mapping cache: worktree path → global plan filenames
  const allWorktrees = await Promise.all(repoPaths.map(discoverWorktrees));
  const worktreePaths = allWorktrees.flat().map((wt) => wt.path);
  let planMapping = await buildPlanMapping(worktreePaths);
  const planCount = [...planMapping.values()].reduce((sum, v) => sum + v.length, 0);
  console.log(`Plan mapping: found ${planCount} plan(s) across ${planMapping.size} worktree(s)`);

  // Initial state
  let currentState = await getFullState(repoPaths, planMapping);
  currentState = applyRemoteState(currentState, remoteCache, behindRemoteCache);
  onUpdate(currentState);

  // Set up chokidar for plan file directories across all repos + global plans dir
  const globalPlansDir = join(homedir(), ".claude", "plans");
  const planDirs = [
    ...allWorktrees.flat().map((wt) => join(wt.path, ".claude", "plans")),
    globalPlansDir,
  ];

  const watcher = chokidar.watch(planDirs, {
    ignoreInitial: true,
    depth: 0,
    persistent: true,
  });

  // Debounce plan file changes
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const DEBOUNCE_MS = 300;

  watcher.on("all", () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      let newState = await getFullState(repoPaths, planMapping);
      newState = applyRemoteState(newState, remoteCache, behindRemoteCache);
      newState.remoteCheckedAt = currentState.remoteCheckedAt;
      currentState = newState;
      onUpdate(currentState);
    }, DEBOUNCE_MS);
  });

  // Fast poll for git changes (3s)
  const pollInterval = setInterval(async () => {
    let newState = await getFullState(repoPaths, planMapping);
    newState = applyRemoteState(newState, remoteCache, behindRemoteCache);
    newState.remoteCheckedAt = currentState.remoteCheckedAt;

    if (JSON.stringify(currentState) !== JSON.stringify(newState)) {
      currentState = newState;
      onUpdate(currentState);

      // Add any new worktree plan dirs to chokidar
      const newPlanDirs = newState.worktrees.map((wt) =>
        join(wt.path, ".claude", "plans")
      );
      for (const dir of newPlanDirs) {
        watcher.add(dir);
      }
    }
  }, pollIntervalMs);

  // Slow poll for remote checks (60s): PR state via gh + behind-remote via ls-remote + plan mapping
  const refreshRemote = async () => {
    const worktrees = currentState.worktrees;

    // Rebuild plan mapping alongside remote checks
    const currentWorktreePaths = worktrees.map((wt) => wt.path);
    const [, newPlanMapping] = await Promise.all([
      Promise.all([
        // Check PR state for non-main worktrees (if gh available)
        ...(ghAvailable
          ? worktrees
              .filter((wt) => !wt.isMainWorktree && wt.branch !== "(detached)")
              .map(async (wt) => {
                const pr = await checkPR(wt.repoPath, wt.branch);
                remoteCache.set(`${wt.repoPath}:${wt.branch}`, pr);
              })
          : []),
        // Check behind-remote for main worktrees
        ...worktrees
          .filter((wt) => wt.isMainWorktree)
          .map(async (wt) => {
            const behind = await checkBehindRemote(wt.repoPath, wt.branch);
            behindRemoteCache.set(`${wt.repoPath}:${wt.branch}`, behind);
          }),
      ]),
      buildPlanMapping(currentWorktreePaths),
    ]);
    planMapping = newPlanMapping;

    // Re-apply remote state and broadcast if changed
    const updated = applyRemoteState(currentState, remoteCache, behindRemoteCache);
    updated.remoteCheckedAt = new Date().toISOString();
    if (JSON.stringify(currentState) !== JSON.stringify(updated)) {
      currentState = updated;
      onUpdate(currentState);
    }
  };

  // Run immediately, then on interval
  refreshRemote();
  const remoteInterval = setInterval(refreshRemote, remoteCheckIntervalMs);

  // Cleanup
  return async () => {
    clearInterval(pollInterval);
    clearInterval(remoteInterval);
    if (debounceTimer) clearTimeout(debounceTimer);
    await watcher.close();
  };
}
