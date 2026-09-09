import { describe, expect, it, vi } from "vitest";
import { PluginManager } from "../../src/plugin-manager.js";
import { loadConfig } from "../../src/config.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";
import type { ToolExecutionContext } from "../../src/types.js";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sessionDir } from "../../src/session-store.js";

describe("managed background tasks", () => {
  it("starts, reports logs, isolates sessions and stops without cancelling the chat", async () => {
    const root = createTempWorkspace({ security: { mode: "allow", background: { maxRunning: 1 } }, bashTerminationGraceMs: 20 });
    const pm = new PluginManager(root);
    try {
      await pm.loadCorePlugins();
      const controller = new AbortController();
      const context: ToolExecutionContext = { sessionId: "jobs", rootPath: root, config: loadConfig(root), signal: controller.signal, sessionContext: { mode: "project", project: { root, name: "test" } } };
      const start = pm.getTool("background_start")!;
      const status = pm.getTool("background_status")!;
      const stop = pm.getTool("background_stop")!;
      const job = JSON.parse(await start.execute({ command: "echo ready; sleep 30" }, context));
      expect(job.state).toBe("running");
      controller.abort();
      await vi.waitFor(async () => expect(await status.execute({ id: job.id }, context)).toContain("ready"));
      expect(await start.execute({ command: "echo other" }, { ...context, signal: undefined })).toContain("上限");
      expect(await status.execute({ id: job.id }, { ...context, sessionId: "other" })).toBe("[]");
      expect(await stop.execute({ id: job.id }, { ...context, sessionId: "other" })).toContain("未找到");
      expect(JSON.parse(await stop.execute({ id: job.id }, context)).state).toBe("cancelled");
      expect(await start.execute({ command: "sleep 30 &" }, context)).toContain("不要使用");
      const cleanup = JSON.parse(await start.execute({ command: "sleep 30" }, { ...context, signal: undefined }));
      await pm.stopPlugin("core-background");
      expect(JSON.parse(readFileSync(resolve(sessionDir(root, "jobs"), "background", `${cleanup.id}.json`), "utf8")).state).toBe("cancelled");
    } finally { await pm.destroy(); removeTempWorkspace(root); }
  });
  it("allows project scripts, preserves required approvals and persists completion", async () => {
    const root = createTempWorkspace({ security: { mode: "auto" } });
    const pm = new PluginManager(root);
    try {
      await pm.loadCorePlugins();
      const context: ToolExecutionContext = { sessionId: "jobs", rootPath: root, config: loadConfig(root), sessionContext: { mode: "project", project: { root, name: "test" } } };
      expect(await pm.getTool("background_start")!.execute({ command: "node /outside/script.js" }, context)).toContain("requiresConfirmation");
      expect(await pm.getTool("background_start")!.execute({ command: "node script.js" }, { ...context, sessionId: "ask-jobs", config: { ...context.config!, security: { mode: "ask" } } })).toContain("requiresConfirmation");
      writeFileSync(resolve(root, "script.js"), 'console.log("done");');
      const job = JSON.parse(await pm.getTool("background_start")!.execute({ command: "node script.js" }, context));
      await vi.waitFor(async () => expect(await pm.getTool("background_status")!.execute({ id: job.id }, context)).toContain('"completed"'));
    } finally { await pm.destroy(); removeTempWorkspace(root); }
  });
});
