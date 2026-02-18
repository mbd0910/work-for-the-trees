import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

// --- Types ---

export interface Worktree {
  path: string;
  head: string;
  branch: string;
  isMainWorktree: boolean;
}

export interface Commit {
  hash: string;
  message: string;
  timestamp: string;
}

export interface FileChanges {
  added: number;
  modified: number;
  deleted: number;
}

export interface PlanFile {
  filename: string;
  path: string;
  content: string;
  modifiedAt: number;
}

export interface UncommittedChanges {
  staged: number;
  unstaged: number;
  untracked: number;
}

export type WorktreeStatus = "no-plan" | "planning" | "in-progress" | "idle" | "merged";

export type PRState = "merged" | "open" | "closed";

export interface WorktreeData {
  repoName: string;
  repoPath: string;
  path: string;
  branch: string;
  baseBranch: string | null;
  isMainWorktree: boolean;
  status: WorktreeStatus;
  commitsAhead: number;
  commits: Commit[];
  fileChanges: FileChanges;
  uncommitted: UncommittedChanges;
  planFiles: PlanFile[];
  lastCommitTimestamp: string | null;
  mergedLocally: boolean;
  prState: PRState | null;
  behindRemote: number | null;
}

export interface DashboardState {
  repoPaths: string[];
  worktrees: WorktreeData[];
  updatedAt: string;
}

// --- Git helpers ---

async function runGit(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args[0]} failed: ${stderr}`);
  }
  return output;
}

async function runGitSafe(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await runGit(cwd, args);
  } catch {
    return null;
  }
}

// --- Core functions ---

export async function discoverWorktrees(repoPath: string): Promise<Worktree[]> {
  const output = await runGit(repoPath, ["worktree", "list", "--porcelain"]);
  const blocks = output.trim().split("\n\n");

  return blocks.map((block, index) => {
    const lines = block.split("\n");
    const path =
      lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length) ?? "";
    const head =
      lines.find((l) => l.startsWith("HEAD "))?.slice("HEAD ".length) ?? "";
    const branchLine = lines.find((l) => l.startsWith("branch "));
    const branch = branchLine
      ? branchLine.slice("branch refs/heads/".length)
      : "(detached)";

    return { path, head, branch, isMainWorktree: index === 0 };
  });
}

export async function detectBaseBranch(
  worktreePath: string
): Promise<string | null> {
  const candidates = ["main", "master", "develop"];

  // Fast path: check upstream tracking branch
  const upstream = await runGitSafe(worktreePath, [
    "rev-parse",
    "--abbrev-ref",
    "@{upstream}",
  ]);
  if (upstream) {
    const stripped = upstream.trim().replace(/^[^/]+\//, "");
    if (candidates.includes(stripped)) {
      return stripped;
    }
  }

  // Fallback: shortest merge-base distance to a candidate branch
  let bestBranch: string | null = null;
  let bestDistance = Infinity;

  for (const candidate of candidates) {
    const exists = await runGitSafe(worktreePath, [
      "rev-parse",
      "--verify",
      candidate,
    ]);
    if (!exists) continue;

    const mergeBase = await runGitSafe(worktreePath, [
      "merge-base",
      "HEAD",
      candidate,
    ]);
    if (!mergeBase) continue;

    const countStr = await runGitSafe(worktreePath, [
      "rev-list",
      "--count",
      `${mergeBase.trim()}..HEAD`,
    ]);
    const count = parseInt(countStr ?? "Infinity", 10);

    if (count < bestDistance) {
      bestDistance = count;
      bestBranch = candidate;
    }
  }

  return bestBranch;
}

export async function calculateDivergence(
  worktreePath: string,
  baseBranch: string
): Promise<{
  commitsAhead: number;
  commits: Commit[];
  fileChanges: FileChanges;
  lastCommitTimestamp: string | null;
}> {
  // Get commit log
  const logOutput = await runGitSafe(worktreePath, [
    "log",
    `${baseBranch}..HEAD`,
    "--format=%H%x00%s%x00%aI",
  ]);

  const commits: Commit[] = [];
  let lastCommitTimestamp: string | null = null;

  if (logOutput?.trim()) {
    for (const line of logOutput.trim().split("\n")) {
      const [hash, message, timestamp] = line.split("\0");
      commits.push({ hash, message, timestamp });
    }
    lastCommitTimestamp = commits[0]?.timestamp ?? null;
  }

  // Get file changes
  const diffOutput = await runGitSafe(worktreePath, [
    "diff",
    `${baseBranch}...HEAD`,
    "--name-status",
  ]);

  const fileChanges: FileChanges = { added: 0, modified: 0, deleted: 0 };
  if (diffOutput?.trim()) {
    for (const line of diffOutput.trim().split("\n")) {
      const status = line[0];
      if (status === "A") fileChanges.added++;
      else if (status === "M") fileChanges.modified++;
      else if (status === "D") fileChanges.deleted++;
    }
  }

  return { commitsAhead: commits.length, commits, fileChanges, lastCommitTimestamp };
}

export async function getUncommittedChanges(
  worktreePath: string
): Promise<UncommittedChanges> {
  const output = await runGitSafe(worktreePath, [
    "status",
    "--porcelain",
  ]);

  const result: UncommittedChanges = { staged: 0, unstaged: 0, untracked: 0 };
  if (!output?.trim()) return result;

  for (const line of output.trim().split("\n")) {
    const x = line[0]; // index (staged) status
    const y = line[1]; // worktree (unstaged) status
    if (x === "?" && y === "?") {
      result.untracked++;
    } else {
      if (x && x !== " " && x !== "?") result.staged++;
      if (y && y !== " " && y !== "?") result.unstaged++;
    }
  }

  return result;
}

export async function findPlanFiles(
  worktreePath: string
): Promise<PlanFile[]> {
  const plansDir = join(worktreePath, ".claude", "plans");

  try {
    const entries = await readdir(plansDir);
    const mdFiles = entries.filter((f) => f.endsWith(".md"));

    const planFiles = await Promise.all(
      mdFiles.map(async (filename) => {
        const filePath = join(plansDir, filename);
        const [content, fileStat] = await Promise.all([
          Bun.file(filePath).text(),
          stat(filePath),
        ]);
        return {
          filename,
          path: filePath,
          content,
          modifiedAt: fileStat.mtimeMs,
        };
      })
    );

    return planFiles.sort((a, b) => b.modifiedAt - a.modifiedAt);
  } catch {
    return [];
  }
}

export function deriveStatus(
  planFiles: PlanFile[],
  commitsAhead: number,
  lastCommitTimestamp: string | null,
  mergedLocally: boolean = false,
  prState: PRState | null = null,
  idleThresholdMs: number = 5 * 60 * 1000
): WorktreeStatus {
  if (mergedLocally || prState === "merged") return "merged";

  const hasPlans = planFiles.length > 0;
  const hasCommits = commitsAhead > 0;

  if (!hasPlans && !hasCommits) return "no-plan";
  if (hasPlans && !hasCommits) return "planning";

  // Has commits — check for idle
  if (lastCommitTimestamp) {
    const elapsed = Date.now() - new Date(lastCommitTimestamp).getTime();
    if (elapsed > idleThresholdMs) return "idle";
  }

  return "in-progress";
}

export async function checkLocallyMerged(
  worktreePath: string,
  baseBranch: string
): Promise<boolean> {
  const [branchHead, mergeBase] = await Promise.all([
    runGitSafe(worktreePath, ["rev-parse", "HEAD"]),
    runGitSafe(worktreePath, ["merge-base", "HEAD", baseBranch]),
  ]);
  if (!branchHead || !mergeBase) return false;

  // If HEAD == merge-base, branch was just created (no unique commits)
  if (branchHead.trim() === mergeBase.trim()) return false;

  // Branch has unique commits — check if they're all in baseBranch
  const isAncestor = await runGitSafe(worktreePath, [
    "merge-base",
    "--is-ancestor",
    "HEAD",
    baseBranch,
  ]);
  // merge-base --is-ancestor exits 0 if true (runGitSafe returns output), 1 if false (returns null)
  return isAncestor !== null;
}

export async function checkBehindRemote(
  repoPath: string,
  branch: string
): Promise<number | null> {
  // Get the remote SHA via network (read-only, no local writes)
  const lsOutput = await runGitSafe(repoPath, ["ls-remote", "origin", branch]);
  if (!lsOutput?.trim()) return null;

  const remoteSha = lsOutput.trim().split(/\s+/)[0];
  if (!remoteSha) return null;

  // Get local HEAD
  const localSha = await runGitSafe(repoPath, ["rev-parse", "HEAD"]);
  if (!localSha) return null;

  // If same SHA, we're up to date
  if (remoteSha === localSha.trim()) return 0;

  // Check if we have the remote object locally
  const hasObject = await runGitSafe(repoPath, ["cat-file", "-e", remoteSha]);
  if (hasObject === null) {
    // We don't have the object — we know we're behind but can't count
    return -1; // sentinel: behind by unknown amount
  }

  // We have the object — count the gap
  const countStr = await runGitSafe(repoPath, [
    "rev-list",
    "--count",
    `HEAD..${remoteSha}`,
  ]);
  if (!countStr) return null;
  return parseInt(countStr.trim(), 10);
}

export async function checkGhAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["gh", "auth", "status"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export async function checkPRState(
  repoPath: string,
  branch: string
): Promise<PRState | null> {
  try {
    const proc = Bun.spawn(
      ["gh", "pr", "view", branch, "--json", "state", "-q", ".state"],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" }
    );
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;

    const state = output.trim().toUpperCase();
    if (state === "MERGED") return "merged";
    if (state === "OPEN") return "open";
    if (state === "CLOSED") return "closed";
    return null;
  } catch {
    return null;
  }
}

export function applyRemoteState(
  state: DashboardState,
  remoteCache: Map<string, PRState | null>,
  behindRemoteCache: Map<string, number | null> = new Map()
): DashboardState {
  return {
    ...state,
    worktrees: state.worktrees.map((wt) => {
      const key = `${wt.repoPath}:${wt.branch}`;
      const prState = remoteCache.get(key) ?? wt.prState;
      const behindRemote = behindRemoteCache.get(key) ?? wt.behindRemote;
      const status = deriveStatus(
        wt.planFiles,
        wt.commitsAhead,
        wt.lastCommitTimestamp,
        wt.mergedLocally,
        prState
      );
      return { ...wt, prState, behindRemote, status };
    }),
  };
}

async function getRepoWorktrees(repoPath: string): Promise<WorktreeData[]> {
  const repoName = basename(repoPath);
  const worktrees = await discoverWorktrees(repoPath);

  return Promise.all(
    worktrees.map(async (wt): Promise<WorktreeData> => {
      const [baseBranch, planFiles, uncommitted] = await Promise.all([
        detectBaseBranch(wt.path),
        findPlanFiles(wt.path),
        getUncommittedChanges(wt.path),
      ]);

      let divergence = {
        commitsAhead: 0,
        commits: [] as Commit[],
        fileChanges: { added: 0, modified: 0, deleted: 0 } as FileChanges,
        lastCommitTimestamp: null as string | null,
      };

      let mergedLocally = false;

      if (baseBranch && !wt.isMainWorktree) {
        [divergence, mergedLocally] = await Promise.all([
          calculateDivergence(wt.path, baseBranch),
          checkLocallyMerged(wt.path, baseBranch),
        ]);
      }

      return {
        repoName,
        repoPath,
        path: wt.path,
        branch: wt.branch,
        baseBranch,
        isMainWorktree: wt.isMainWorktree,
        status: deriveStatus(
          planFiles,
          divergence.commitsAhead,
          divergence.lastCommitTimestamp,
          mergedLocally
        ),
        ...divergence,
        uncommitted,
        planFiles,
        mergedLocally,
        prState: null,
        behindRemote: null,
      };
    })
  );
}

export async function getFullState(
  repoPaths: string[]
): Promise<DashboardState> {
  const allWorktrees = await Promise.all(repoPaths.map(getRepoWorktrees));

  return {
    repoPaths,
    worktrees: allWorktrees.flat(),
    updatedAt: new Date().toISOString(),
  };
}
