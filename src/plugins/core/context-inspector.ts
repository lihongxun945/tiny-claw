import type { PreparedModelRequest, Plugin } from "../types.js";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { sessionDir } from "../../session-store.js";

export const coreContextInspectorPlugin: Plugin = {
  name: "core-context-inspector",
  async init(ctx) {
    const snapshotPath = (sessionId: string) => resolve(sessionDir(ctx.workspacePath, sessionId), "context-snapshot.json");

    ctx.registerHooks({
      async onModelRequestPrepared(_hookCtx, request) {
        const path = snapshotPath(request.sessionId);
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          let lastRequest: PreparedModelRequest["lastRequest"];
          if (request.kind === "estimate") {
            try {
              const previous = JSON.parse(await readFile(path, "utf8")) as PreparedModelRequest;
              lastRequest = previous.kind === "estimate" ? previous.lastRequest : { createdAt: previous.createdAt, usage: previous.usage };
            } catch { /* The first estimate has no earlier request. */ }
          }
          await writeFile(temporary, JSON.stringify({ ...request, lastRequest }), { encoding: "utf8", mode: 0o600 });
          await rename(temporary, path);
        } catch (error) {
          ctx.log("WARN", `保存上下文快照失败: ${error instanceof Error ? error.message : String(error)}`, request.sessionId);
        } finally {
          await rm(temporary, { force: true }).catch(() => {});
        }
      },
    });

    ctx.registerRoute({
      method: "GET",
      path: "/context",
      async handler(_req, _res, routeCtx) {
        const sessionId = routeCtx.url.searchParams.get("session_id")?.trim();
        if (!sessionId) {
          routeCtx.sendJSON(400, { error: "session_id 不能为空" });
          return;
        }
        let snapshot: PreparedModelRequest | undefined;
        try {
          const stored = JSON.parse(await readFile(snapshotPath(sessionId), "utf8")) as PreparedModelRequest;
          if (stored?.sessionId === sessionId && typeof stored.systemPrompt === "string"
            && Array.isArray(stored.messages) && Array.isArray(stored.tools) && stored.usage) snapshot = stored;
        } catch {
          // Missing or incomplete snapshots do not prevent opening the conversation.
        }
        if (!snapshot) {
          routeCtx.sendJSON(404, { error: "当前会话尚无模型上下文" });
          return;
        }
        routeCtx.sendJSON(200, { snapshot });
      },
    });
  },
};
