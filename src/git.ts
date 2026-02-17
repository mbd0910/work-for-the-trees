import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

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

export type WorktreeStatus = "no-plan" | "planning" | "in-progress" | "idle";

export interface WorktreeData {
  path: string;
  branch: string;
  baseBranch: string | null;
  isMainWorktree: boolean;
  status: WorktreeStatus;
  commitsAhead: number;
  commits: Commit[];
  fileChanges: FileChanges;
  planFiles: PlanFile[];
  lastCommitTimestamp: string | null;
}

export interface DashboardState {
  repoPath: string;
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
  idleThresholdMs: number = 5 * 60 * 1000
): WorktreeStatus {
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

export async function getFullState(
  repoPath: string
): Promise<DashboardState> {
  const worktrees = await discoverWorktrees(repoPath);

  const worktreeData = await Promise.all(
    worktrees.map(async (wt): Promise<WorktreeData> => {
      const [baseBranch, planFiles] = await Promise.all([
        detectBaseBranch(wt.path),
        findPlanFiles(wt.path),
      ]);

      let divergence = {
        commitsAhead: 0,
        commits: [] as Commit[],
        fileChanges: { added: 0, modified: 0, deleted: 0 } as FileChanges,
        lastCommitTimestamp: null as string | null,
      };

      if (baseBranch && !wt.isMainWorktree) {
        divergence = await calculateDivergence(wt.path, baseBranch);
      }

      return {
        path: wt.path,
        branch: wt.branch,
        baseBranch,
        isMainWorktree: wt.isMainWorktree,
        status: deriveStatus(
          planFiles,
          divergence.commitsAhead,
          divergence.lastCommitTimestamp
        ),
        ...divergence,
        planFiles,
      };
    })
  );

  return {
    repoPath,
    worktrees: worktreeData,
    updatedAt: new Date().toISOString(),
  };
}
