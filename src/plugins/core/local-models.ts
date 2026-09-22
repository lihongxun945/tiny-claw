import { loadConfig, restoreMaskedSecrets } from "../../config.js";
import { createModelClientFromProfile } from "../../model/index.js";
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
          const modelId = typeof body.modelId === "string" && body.modelId.length > 0 ? body.modelId : undefined;
          const draftRaw = body.config && typeof body.config === "object" && !Array.isArray(body.config)
            ? body.config as Record<string, unknown>
            : {};
          const base = loadConfig(ctx.workspacePath);
          const restored = restoreMaskedSecrets(draftRaw, base) as Partial<Config>;
          const config: Config = { ...base, ...restored, workspacePath: ctx.workspacePath, maxTokens: 32 };
          const models = config.models ?? [];
          const profile = modelId
            ? models.find((item) => item.id === modelId)
            : models.find((item) => target === "local" ? item.provider === "local-llama" : item.provider !== "local-llama");
          if (!profile) {
            throw new Error(modelId ? "未找到指定模型" : (target === "local" ? "没有配置本地模型" : "没有配置远程模型"));
          }
          const text = await createModelClientFromProfile({ ...profile, maxTokens: 32 }, config).complete([
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
