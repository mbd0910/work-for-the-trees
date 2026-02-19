#!/usr/bin/env bun

import { resolve } from "node:path";
import { createApp } from "./server.ts";
import { loadConfig } from "./config.ts";

function printUsage() {
  console.log(`
work-for-the-trees - Monitor git worktrees and Claude Code plans

Usage:
  work-for-the-trees <repo-path> [repo-path...] [options]

Options:
  --port <number>  Port to serve on (default: 4040)
  --open           Open browser automatically
  --ide <name|cmd> IDE to open worktrees in (e.g. code, cursor, zed)
  --help, -h       Show this help

Example:
  work-for-the-trees ~/code/my-project
  work-for-the-trees ~/code/project-a ~/code/project-b
  work-for-the-trees ~/code/my-project --port 8080 --open
`.trim());
}

function parseArgs(args: string[]) {
  const repoPaths: string[] = [];
  let port = 4040;
  let open = false;
  let ide: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      if (isNaN(port)) {
        console.error("Invalid port number");
        process.exit(1);
      }
      i++;
    } else if (arg === "--ide" && args[i + 1]) {
      ide = args[i + 1];
      i++;
    } else if (arg === "--open") {
      open = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith("--")) {
      repoPaths.push(resolve(arg));
    }
  }

  if (repoPaths.length === 0) {
    console.error("Error: at least one repo path is required\n");
    printUsage();
    process.exit(1);
  }

  return { repoPaths, port, open, ide };
}

async function validateGitRepo(path: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "-C", path, "rev-parse", "--git-dir"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return (await proc.exited) === 0;
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2));

  // Validate all paths are git repos
  for (const repoPath of args.repoPaths) {
    if (!(await validateGitRepo(repoPath))) {
      console.error(`Error: ${repoPath} is not a git repository`);
      process.exit(1);
    }
  }

  // Resolve IDE setting: CLI flag > config file
  const config = await loadConfig();
  const ide = args.ide ?? config.ide;
  if (ide) {
    console.log(`IDE configured: ${ide}`);
  }

  const { start } = createApp(args.repoPaths, ide);
  const { stop } = await start(args.port);

  if (args.open) {
    const openCmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open";
    Bun.spawn([openCmd, `http://localhost:${args.port}`]);
  }

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
