import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { startWatching } from "./watcher.ts";
import type { DashboardState } from "./git.ts";
import { getIdeName, resolveIdeCommand } from "./ide.ts";

export function createApp(repoPaths: string[], ideCmd?: string) {
  const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();
  const app = new Hono();

  // Track connected WebSocket clients
  const clients = new Set<ServerWebSocket>();
  let currentState: DashboardState | null = null;

  function broadcast(state: DashboardState) {
    currentState = state;
    const payload = ideCmd ? { ...state, ide: getIdeName(ideCmd) } : state;
    const message = JSON.stringify(payload);
    for (const client of clients) {
      try {
        client.send(message);
      } catch {
        clients.delete(client);
      }
    }
  }

  // Serve frontend
  app.get("/", async (c) => {
    const file = Bun.file(new URL("../public/index.html", import.meta.url).pathname);
    return c.html(await file.text());
  });

  // Full state API
  app.get("/api/state", (c) => {
    if (!currentState) return c.json({ error: "Not ready" }, 503);
    const payload = ideCmd ? { ...currentState, ide: getIdeName(ideCmd) } : currentState;
    return c.json(payload);
  });

  // Merged worktrees API — slim shape for cleanup automation
  app.get("/api/merged", (c) => {
    if (!currentState) return c.json({ error: "Not ready" }, 503);
    const merged = currentState.worktrees
      .filter((wt) => wt.status === "merged")
      .map((wt) => ({
        repo: wt.repoName,
        branch: wt.branch,
        path: wt.path,
        repoPath: wt.repoPath,
        pr: wt.pr,
      }));
    return c.json(merged);
  });

  // Open worktree in IDE
  app.post("/api/open", async (c) => {
    if (!ideCmd) {
      return c.json({ error: "No IDE configured. Use --ide flag or config file." }, 400);
    }
    if (!currentState) {
      return c.json({ error: "Not ready" }, 503);
    }

    const body = await c.req.json();
    const targetPath = body?.path;
    if (!targetPath || !currentState.worktrees.some((wt) => wt.path === targetPath)) {
      return c.json({ error: "Unknown worktree path" }, 400);
    }

    const argv = resolveIdeCommand(ideCmd, targetPath);
    try {
      Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Failed to launch IDE" }, 500);
    }
  });

  // WebSocket endpoint
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        const raw = ws.raw as ServerWebSocket;
        clients.add(raw);
        if (currentState) {
          const payload = ideCmd ? { ...currentState, ide: getIdeName(ideCmd) } : currentState;
          raw.send(JSON.stringify(payload));
        }
      },
      onClose(_event, ws) {
        clients.delete(ws.raw as ServerWebSocket);
      },
      onMessage() {
        // Read-only: ignore incoming messages
      },
    }))
  );

  async function start(port: number) {
    const stopWatching = await startWatching({
      repoPaths,
      onUpdate: broadcast,
    });

    const server = Bun.serve({
      port,
      fetch: app.fetch,
      websocket,
    });

    console.log(`work-for-the-trees running at http://localhost:${server.port}`);
    for (const p of repoPaths) {
      console.log(`Watching: ${p}`);
    }

    return {
      stop: async () => {
        await stopWatching();
        server.stop();
      },
    };
  }

  return { app, start };
}
