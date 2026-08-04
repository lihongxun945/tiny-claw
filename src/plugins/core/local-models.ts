import { loadConfig } from "../../config.js";
import { createModelClient } from "../../model/index.js";
import { downloadLocalModel, listLocalModelStatus } from "../../model/local-store.js";
import type { Config } from "../../types.js";
import type { Plugin } from "../types.js";

function parseObject(body: string): Record<string, unknown> {
  const value = JSON.parse(body || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象");
  return value as Record<string, unknown>;
}

export const coreLocalModelsPlugin: Plugin = {
  name: "core-local-models",
  async init(ctx) {
    ctx.registerRoute({
      method: "GET",
      path: "/local-models",
      async handler(_req, _res, routeCtx) {
        routeCtx.sendJSON(200, { models: listLocalModelStatus(ctx.workspacePath) });
      },
    });

    ctx.registerRoute({
      method: "POST",
      path: "/local-models/download",
      async handler(_req, _res, routeCtx) {
        try {
          const body = parseObject(await routeCtx.readBody());
          const modelId = String(body.modelId ?? "");
          void downloadLocalModel(ctx.workspacePath, modelId).catch(() => {});
          routeCtx.sendJSON(202, { accepted: true, modelId });
        } catch (error) {
          routeCtx.sendJSON(400, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    });

    ctx.registerRoute({
      method: "POST",
      path: "/models/test",
      async handler(_req, _res, routeCtx) {
        const startedAt = Date.now();
        try {
          const body = parseObject(await routeCtx.readBody());
          const target = body.target === "local" ? "local" : "remote";
          const draft = body.config && typeof body.config === "object" && !Array.isArray(body.config)
            ? body.config as Partial<Config>
            : {};
          const base = loadConfig(ctx.workspacePath);
          if (typeof draft.apiKey === "string" && draft.apiKey.endsWith("***")) draft.apiKey = base.apiKey;
          const config: Config = {
            ...base,
            ...draft,
            workspacePath: ctx.workspacePath,
            remoteModel: { enabled: target === "remote" },
            localModel: {
              ...base.localModel,
              ...draft.localModel,
              enabled: target === "local",
            },
            maxTokens: 32,
          };
          const text = await createModelClient(config).complete([
            { role: "user", content: "这是连通性测试。请只回复 OK。" },
          ]);
          routeCtx.sendJSON(200, { ok: true, elapsedMs: Date.now() - startedAt, text: text.trim().slice(0, 200) });
        } catch (error) {
          routeCtx.sendJSON(400, { ok: false, elapsedMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) });
        }
      },
    });
  },
};
