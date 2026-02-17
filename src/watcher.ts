import chokidar from "chokidar";
import { join } from "node:path";
import { discoverWorktrees, getFullState } from "./git.ts";
import type { DashboardState } from "./git.ts";

export interface WatcherOptions {
  repoPath: string;
  pollIntervalMs?: number;
  onUpdate: (state: DashboardState) => void;
}

export type StopFn = () => Promise<void>;

export async function startWatching(options: WatcherOptions): Promise<StopFn> {
  const { repoPath, pollIntervalMs = 3000, onUpdate } = options;

  // Initial state
  let currentState = await getFullState(repoPath);
  onUpdate(currentState);

  // Set up chokidar for plan file directories
  const worktrees = await discoverWorktrees(repoPath);
  const planDirs = worktrees.map((wt) => join(wt.path, ".claude", "plans"));

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
      currentState = await getFullState(repoPath);
      onUpdate(currentState);
    }, DEBOUNCE_MS);
  });

  // Poll for git changes
  const pollInterval = setInterval(async () => {
    const newState = await getFullState(repoPath);

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

  // Cleanup
  return async () => {
    clearInterval(pollInterval);
    if (debounceTimer) clearTimeout(debounceTimer);
    await watcher.close();
  };
}
