import { loadConfig, maskConfigSecrets } from "../../config.js";
import { readSessionMeta } from "../../session-store.js";
import type { Plugin } from "../types.js";

export const coreModelsPlugin: Plugin = {
  name: "core-models",
  async init(ctx) {
    ctx.registerRoute({
      method: "GET",
      path: "/models",
      async handler(_req, _res, routeCtx) {
        try {
          const config = loadConfig(ctx.workspacePath);
          routeCtx.sendJSON(200, {
            models: maskConfigSecrets(config.models ?? []),
            defaultModelId: config.defaultModelId,
          });
        } catch (error) {
          routeCtx.sendJSON(400, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    });

    ctx.registerRoute({
      method: "PUT",
      path: "/sessions/:id/model",
      async handler(_req, _res, routeCtx) {
        try {
          const sessionId = decodeURIComponent(routeCtx.params.id ?? "");
          const body = JSON.parse(await routeCtx.readBody()) as { modelId?: unknown };
          if (typeof body.modelId !== "string" || !body.modelId.trim()) throw new Error("modelId 必须是字符串");
          if (!readSessionMeta(ctx.workspacePath, sessionId)) {
            routeCtx.sendJSON(404, { error: "会话不存在" });
            return;
          }
          routeCtx.sendJSON(200, ctx.getOrCreateSession(sessionId).switchModel(body.modelId));
        } catch (error) {
          const status = error instanceof Error && /不存在/.test(error.message) ? 404 : 400;
          routeCtx.sendJSON(status, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    });
  },
};
