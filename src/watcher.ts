import chokidar from "chokidar";
import { join } from "node:path";
import {
  discoverWorktrees,
  getFullState,
  checkGhAvailable,
  checkPRState,
  applyRemoteState,
} from "./git.ts";
import type { DashboardState, PRState } from "./git.ts";

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

  // Remote state cache: "repoPath:branch" -> PRState
  const remoteCache = new Map<string, PRState | null>();

  // Initial state
  let currentState = await getFullState(repoPaths);
  if (ghAvailable) {
    currentState = applyRemoteState(currentState, remoteCache);
  }
  onUpdate(currentState);

  // Set up chokidar for plan file directories across all repos
  const allWorktrees = await Promise.all(repoPaths.map(discoverWorktrees));
  const planDirs = allWorktrees
    .flat()
    .map((wt) => join(wt.path, ".claude", "plans"));

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
      let newState = await getFullState(repoPaths);
      if (ghAvailable) {
        newState = applyRemoteState(newState, remoteCache);
      }
      currentState = newState;
      onUpdate(currentState);
    }, DEBOUNCE_MS);
  });

  // Fast poll for git changes (3s)
  const pollInterval = setInterval(async () => {
    let newState = await getFullState(repoPaths);
    if (ghAvailable) {
      newState = applyRemoteState(newState, remoteCache);
    }

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

  // Slow poll for remote PR state (60s), if gh is available
  let remoteInterval: ReturnType<typeof setInterval> | null = null;

  if (ghAvailable) {
    const refreshRemote = async () => {
      const worktrees = currentState.worktrees.filter(
        (wt) => !wt.isMainWorktree && wt.branch !== "(detached)"
      );

      await Promise.all(
        worktrees.map(async (wt) => {
          const prState = await checkPRState(wt.repoPath, wt.branch);
          remoteCache.set(`${wt.repoPath}:${wt.branch}`, prState);
        })
      );

      // Re-apply remote state and broadcast if changed
      const updated = applyRemoteState(currentState, remoteCache);
      if (JSON.stringify(currentState) !== JSON.stringify(updated)) {
        currentState = updated;
        onUpdate(currentState);
      }
    };

    // Run immediately, then on interval
    refreshRemote();
    remoteInterval = setInterval(refreshRemote, remoteCheckIntervalMs);
  }

  // Cleanup
  return async () => {
    clearInterval(pollInterval);
    if (remoteInterval) clearInterval(remoteInterval);
    if (debounceTimer) clearTimeout(debounceTimer);
    await watcher.close();
  };
}
