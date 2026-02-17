#!/usr/bin/env bun

import { resolve } from "node:path";
import { createApp } from "./server.ts";

function printUsage() {
  console.log(`
work-for-the-trees - Monitor git worktrees and Claude Code plans

Usage:
  work-for-the-trees <repo-path> [options]

Options:
  --port <number>  Port to serve on (default: 4040)
  --open           Open browser automatically
  --help, -h       Show this help

Example:
  work-for-the-trees ~/code/my-project
  work-for-the-trees ~/code/my-project --port 8080 --open
`.trim());
}

function parseArgs(args: string[]) {
  let repoPath: string | null = null;
  let port = 4040;
  let open = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      if (isNaN(port)) {
        console.error("Invalid port number");
        process.exit(1);
      }
      i++;
    } else if (arg === "--open") {
      open = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith("--")) {
      repoPath = arg;
    }
  }

  if (!repoPath) {
    console.error("Error: repo path is required\n");
    printUsage();
    process.exit(1);
  }

  return { repoPath: resolve(repoPath), port, open };
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2));

  // Validate it's a git repo
  const proc = Bun.spawn(["git", "-C", args.repoPath, "rev-parse", "--git-dir"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) {
    console.error(`Error: ${args.repoPath} is not a git repository`);
    process.exit(1);
  }

  const { start } = createApp(args.repoPath);
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
