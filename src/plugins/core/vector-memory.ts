import type { Plugin, HookContext } from "../types.js";
import { loadConfig } from "../../config.js";
import { VectorMemoryService, formatRetrievedMemories } from "../../memory/service.js";
import { incrementMemoryTurn } from "../../memory/state.js";
import { runMemoryMaintenance } from "../../tools/memory.js";

function scopeFor(ctx: HookContext): string {
  return ctx.sessionContext.mode === "project" && ctx.sessionContext.project
    ? `project:${ctx.sessionContext.project.root}`
    : "global";
}

export const coreVectorMemoryPlugin: Plugin = {
  name: "core-vector-memory",
  async init(ctx) {
    const queryBySession = new Map<string, string>();
    const retrievalBySession = new Map<string, Promise<string>>();
    const serviceByConfig = new Map<string, VectorMemoryService>();

    function service(config = loadConfig(ctx.workspacePath)): VectorMemoryService {
      const embedding = config.memory?.embedding;
      const key = JSON.stringify([embedding?.provider, embedding?.model, embedding?.dimensions, embedding?.apiUrl]);
      let instance = serviceByConfig.get(key);
      if (!instance) {
        instance = new VectorMemoryService(ctx.workspacePath, config);
        serviceByConfig.set(key, instance);
      }
      return instance;
    }

    ctx.registerHooks({
      onUserMessage(hookCtx, input) {
        queryBySession.set(hookCtx.sessionId, input);
        retrievalBySession.delete(hookCtx.sessionId);
      },
      async onBuildTurnPrompt(hookCtx, prompt) {
        if (hookCtx.config.memory?.enabled === false) return prompt;
        const query = queryBySession.get(hookCtx.sessionId);
        if (!query?.trim()) return prompt;
        let retrieval = retrievalBySession.get(hookCtx.sessionId);
        if (!retrieval) {
          retrieval = service(hookCtx.config).search(query, scopeFor(hookCtx)).then((results) => formatRetrievedMemories(
            results,
            hookCtx.config.memory?.retrieval?.maxContextChars ?? 6000,
          ));
          retrievalBySession.set(hookCtx.sessionId, retrieval);
        }
        const memoryText = await retrieval;
        return memoryText ? `${prompt}\n\n${memoryText}` : prompt;
      },
      onTurnEnd(hookCtx, reason) {
        if (reason !== "completed" || hookCtx.sessionId.startsWith("sub:")) return;
        incrementMemoryTurn(ctx.workspacePath);
        const maintenance = hookCtx.config.memory?.maintenance;
        runMemoryMaintenance(ctx.workspacePath, {
          inactiveTurns: maintenance?.inactiveTurns ?? 200,
          inactiveDays: maintenance?.inactiveDays ?? 30,
          trashRetentionDays: maintenance?.trashRetentionDays ?? 30,
        });
      },
    });

    ctx.registerTool({
      name: "memory_search",
      description: "按语义和关键词搜索长期记忆。自动召回的信息不足，或者需要查找历史偏好、决策、事实和经验时使用",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "完整、明确的检索问题" },
          scope: { type: "string", description: "可选作用域，默认 global" },
        },
        required: ["query"],
      },
      async execute(args) {
        const query = String(args.query ?? "").trim();
        if (!query) return JSON.stringify({ error: "query 不能为空" });
        const results = await service().search(query, typeof args.scope === "string" ? args.scope : "global");
        return JSON.stringify({
          memories: results.map((result) => ({
            name: result.memory.name,
            summary: result.memory.summary,
            content: result.memory.content,
            tags: result.memory.tags,
            scope: result.memory.scope,
            updatedAt: result.memory.updatedAt,
            score: result.score,
          })),
        });
      },
    });

    ctx.registerRoute({
      method: "POST",
      path: "/memory/search",
      async handler(_req, res, routeCtx) {
        let body: { query?: unknown; scope?: unknown } | undefined;
        try { body = JSON.parse(await routeCtx.readBody()) as typeof body; } catch { body = undefined; }
        const query = typeof body?.query === "string" ? body.query.trim() : "";
        if (!query) {
          routeCtx.sendJSON(400, { error: "query 不能为空" });
          return;
        }
        const results = await service().search(query, typeof body?.scope === "string" ? body.scope : "global");
        routeCtx.sendJSON(200, { results });
      },
    });
  },
};
