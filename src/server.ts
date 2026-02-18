import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { startWatching } from "./watcher.ts";
import type { DashboardState } from "./git.ts";

export function createApp(repoPaths: string[]) {
  const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();
  const app = new Hono();

  // Track connected WebSocket clients
  const clients = new Set<ServerWebSocket>();
  let currentState: DashboardState | null = null;

  function broadcast(state: DashboardState) {
    currentState = state;
    const message = JSON.stringify(state);
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
    if (currentState) return c.json(currentState);
    return c.json({ error: "Not ready" }, 503);
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
      }));
    return c.json(merged);
  });

  // WebSocket endpoint
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        const raw = ws.raw as ServerWebSocket;
        clients.add(raw);
        if (currentState) {
          raw.send(JSON.stringify(currentState));
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
