import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
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

export interface PRInfo {
  state: "merged" | "open" | "closed";
  number: number;
  title: string;
  url: string;
}

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
  pr: PRInfo | null;
  behindRemote: number | null;
}

export interface DashboardState {
  repoPaths: string[];
  worktrees: WorktreeData[];
  updatedAt: string;
  remoteCheckedAt: string | null;
  ide?: string;
}

// --- Git helpers ---

async function runGit(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args[0]} failed: ${stderr}`);
  }
  return stdout;
}

async function runGitSafe(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await runGit(cwd, args);
  } catch {
    return null;
  }
}

// --- Core functions ---

// Claude Code creates its own worktrees under .claude/worktrees/ for --worktree,
// background sessions and `isolation: worktree` subagents, and sweeps them on its
// own schedule. They are not ours to show or remove, so they never enter the
// dashboard's view of the repo.
function isClaudeCodeWorktree(path: string): boolean {
  return path.includes("/.claude/worktrees/");
}

export function parseWorktreePorcelain(output: string): Worktree[] {
  const blocks = output.trim().split("\n\n");

  return blocks
    .map((block, index) => {
      const lines = block.split("\n");
      const path =
        lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length) ?? "";
      const head =
        lines.find((l) => l.startsWith("HEAD "))?.slice("HEAD ".length) ?? "";
      const branchLine = lines.find((l) => l.startsWith("branch "));
      const branch = branchLine
        ? branchLine.slice("branch refs/heads/".length)
        : "(detached)";

      // isMainWorktree is derived from the pre-filter index: git always lists the
      // main worktree first, and filtering must not promote another entry into it.
      return { path, head, branch, isMainWorktree: index === 0 };
    })
    .filter((wt) => !isClaudeCodeWorktree(wt.path));
}

export async function discoverWorktrees(repoPath: string): Promise<Worktree[]> {
  const output = await runGit(repoPath, ["worktree", "list", "--porcelain"]);
  return parseWorktreePorcelain(output);
}

const BASE_BRANCH_CANDIDATES = ["main", "master", "develop"];

/**
 * Strip the remote prefix from a `symbolic-ref --short` result:
 * "origin/develop" -> "develop", "origin/release/2.0" -> "release/2.0".
 */
export function parseOriginHead(symbolicRef: string | null): string | null {
  const trimmed = symbolicRef?.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/**
 * Turn a branch name into a ref that actually resolves in this worktree,
 * preferring the local branch and falling back to the remote-tracking one.
 * A repo worked on only through worktrees often has no local checkout of its
 * own default branch, and callers use the result as a plain rev.
 */
async function resolvableBaseRef(
  worktreePath: string,
  name: string
): Promise<string | null> {
  const local = await runGitSafe(worktreePath, [
    "rev-parse",
    "--verify",
    `refs/heads/${name}`,
  ]);
  if (local) return name;

  const remote = await runGitSafe(worktreePath, [
    "rev-parse",
    "--verify",
    `refs/remotes/origin/${name}`,
  ]);
  if (remote) return `origin/${name}`;

  return null;
}

export async function detectBaseBranch(
  worktreePath: string
): Promise<string | null> {
  // Primary: the remote's default branch, recorded in origin/HEAD. This is
  // authoritative — it is what the remote reports and what Claude Code's own
  // worktree creation uses — so it beats guessing from a list of common names.
  // It is cached at clone time; `git remote set-head origin -a` refreshes it.
  const originHead = parseOriginHead(
    await runGitSafe(worktreePath, [
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ])
  );
  if (originHead) {
    const ref = await resolvableBaseRef(worktreePath, originHead);
    if (ref) return ref;
  }

  // Secondary: the upstream tracking branch, but only when it names a
  // conventional base. A feature branch tracks itself, which tells us nothing.
  const upstream = await runGitSafe(worktreePath, [
    "rev-parse",
    "--abbrev-ref",
    "@{upstream}",
  ]);
  if (upstream) {
    const stripped = upstream.trim().replace(/^[^/]+\//, "");
    if (BASE_BRANCH_CANDIDATES.includes(stripped)) {
      const ref = await resolvableBaseRef(worktreePath, stripped);
      if (ref) return ref;
    }
  }

  // Fallback, for clones with no origin/HEAD (--single-branch, shallow CI
  // clones): shortest merge-base distance to a conventionally named branch.
  let bestBranch: string | null = null;
  let bestDistance = Infinity;

  for (const candidate of BASE_BRANCH_CANDIDATES) {
    const ref = await resolvableBaseRef(worktreePath, candidate);
    if (!ref) continue;

    const mergeBase = await runGitSafe(worktreePath, [
      "merge-base",
      "HEAD",
      ref,
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
      bestBranch = ref;
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

/**
 * Extract plan filenames from a session JSONL file's content.
 * Only looks at tool_use blocks in assistant messages (where Claude called
 * Read/Write/Edit on a plan file). Ignores tool_result content to avoid
 * false positives from commands that happened to list plan files.
 */
export function extractPlanNamesFromSessionContent(content: string): string[] {
  const planNames = new Set<string>();
  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type !== "assistant") continue;
      const blocks = msg.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (block.type !== "tool_use") continue;
        const input = JSON.stringify(block.input ?? {});
        for (const m of input.matchAll(
          /\.claude\/plans\/([a-zA-Z0-9_-]+\.md)/g
        )) {
          planNames.add(m[1]);
        }
      }
    } catch {}
  }
  return [...planNames];
}

export type PlanMappingCache = Map<string, { mtime: number; planNames: string[] }>;

export async function buildPlanMapping(
  worktreePaths: string[],
  cache?: PlanMappingCache
): Promise<Map<string, string[]>> {
  const home = homedir();
  const projectsDir = join(home, ".claude", "projects");
  const mapping = new Map<string, string[]>();
  const touched = new Set<string>();

  await Promise.all(
    worktreePaths.map(async (wtPath) => {
      const encoded = wtPath.replaceAll("/", "-");
      const projectDir = join(projectsDir, encoded);

      try {
        const entries = await readdir(projectDir);
        const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));
        if (jsonlFiles.length === 0) return;

        // Sort by mtime descending, take the 3 most recent
        const withStats = await Promise.all(
          jsonlFiles.map(async (f) => {
            const filePath = join(projectDir, f);
            const s = await stat(filePath);
            return { filePath, mtime: s.mtimeMs };
          })
        );
        withStats.sort((a, b) => b.mtime - a.mtime);

        const planNames = new Set<string>();
        for (const { filePath, mtime } of withStats.slice(0, 3)) {
          touched.add(filePath);
          const cached = cache?.get(filePath);
          let names: string[];
          if (cached && cached.mtime === mtime) {
            names = cached.planNames;
          } else {
            try {
              const text = await Bun.file(filePath).text();
              names = extractPlanNamesFromSessionContent(text);
              cache?.set(filePath, { mtime, planNames: names });
            } catch {
              names = [];
            }
          }
          for (const name of names) planNames.add(name);
        }

        if (planNames.size > 0) {
          mapping.set(wtPath, [...planNames]);
        }
      } catch {}
    })
  );

  // Evict cache entries we didn't touch this round so the cache tracks
  // the current set of "most recent" files rather than growing unboundedly.
  if (cache) {
    for (const key of cache.keys()) {
      if (!touched.has(key)) cache.delete(key);
    }
  }

  return mapping;
}

export async function findPlanFiles(
  worktreePath: string,
  globalPlanNames?: string[]
): Promise<PlanFile[]> {
  const results: PlanFile[] = [];

  // 1. Check local worktree plans (existing behavior)
  const plansDir = join(worktreePath, ".claude", "plans");
  try {
    const entries = await readdir(plansDir);
    const mdFiles = entries.filter((f) => f.endsWith(".md"));

    const localPlans = await Promise.all(
      mdFiles.map(async (filename) => {
        const filePath = join(plansDir, filename);
        const [content, fileStat] = await Promise.all([
          Bun.file(filePath).text(),
          stat(filePath),
        ]);
        return { filename, path: filePath, content, modifiedAt: fileStat.mtimeMs };
      })
    );
    results.push(...localPlans);
  } catch {}

  // 2. Check global plans from ~/.claude/plans/
  if (globalPlanNames?.length) {
    const globalPlansDir = join(homedir(), ".claude", "plans");
    const localFilenames = new Set(results.map((r) => r.filename));

    const globalPlans = await Promise.all(
      globalPlanNames
        .filter((f) => !localFilenames.has(f))
        .map(async (filename) => {
          try {
            const filePath = join(globalPlansDir, filename);
            const [content, fileStat] = await Promise.all([
              Bun.file(filePath).text(),
              stat(filePath),
            ]);
            return { filename, path: filePath, content, modifiedAt: fileStat.mtimeMs };
          } catch {
            return null;
          }
        })
    );
    results.push(...globalPlans.filter((p): p is PlanFile => p !== null));
  }

  return results.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

export function deriveStatus(
  planFiles: PlanFile[],
  commitsAhead: number,
  lastCommitTimestamp: string | null,
  mergedLocally: boolean = false,
  prState: string | null = null,
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
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export async function checkPR(
  repoPath: string,
  branch: string
): Promise<PRInfo | null> {
  try {
    const proc = Bun.spawn(
      ["gh", "pr", "view", branch, "--json", "state,number,title,url"],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" }
    );
    const [stdout, , exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) return null;

    const data = JSON.parse(stdout.trim());
    const state = (data.state as string)?.toUpperCase();
    if (state !== "MERGED" && state !== "OPEN" && state !== "CLOSED") return null;

    return {
      state: state.toLowerCase() as PRInfo["state"],
      number: data.number,
      title: data.title,
      url: data.url,
    };
  } catch {
    return null;
  }
}

export function applyRemoteState(
  state: DashboardState,
  remoteCache: Map<string, PRInfo | null>,
  behindRemoteCache: Map<string, number | null> = new Map()
): DashboardState {
  return {
    ...state,
    worktrees: state.worktrees.map((wt) => {
      const key = `${wt.repoPath}:${wt.branch}`;
      const pr = remoteCache.get(key) ?? wt.pr;
      const behindRemote = behindRemoteCache.get(key) ?? wt.behindRemote;
      const status = deriveStatus(
        wt.planFiles,
        wt.commitsAhead,
        wt.lastCommitTimestamp,
        wt.mergedLocally,
        pr?.state ?? null
      );
      return { ...wt, pr, behindRemote, status };
    }),
  };
}

async function getRepoWorktrees(
  repoPath: string,
  planMapping?: Map<string, string[]>
): Promise<WorktreeData[]> {
  const repoName = basename(repoPath);
  const worktrees = await discoverWorktrees(repoPath);

  return Promise.all(
    worktrees.map(async (wt): Promise<WorktreeData> => {
      const [baseBranch, planFiles, uncommitted] = await Promise.all([
        detectBaseBranch(wt.path),
        findPlanFiles(wt.path, planMapping?.get(wt.path)),
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
        pr: null,
        behindRemote: null,
      };
    })
  );
}

export async function getFullState(
  repoPaths: string[],
  planMapping?: Map<string, string[]>
): Promise<DashboardState> {
  const allWorktrees = await Promise.all(
    repoPaths.map((rp) => getRepoWorktrees(rp, planMapping))
  );

  return {
    repoPaths,
    worktrees: allWorktrees.flat(),
    updatedAt: new Date().toISOString(),
    remoteCheckedAt: null,
  };
}
