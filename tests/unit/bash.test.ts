import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBashTool } from "../../src/tools/bash.js";
import { loadConfig } from "../../src/config.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

describe.skipIf(process.platform === "win32")("bash process cancellation", () => {
  it.each([false, true])("terminates background descendants (timeout=%s)", async (timeout) => {
    const workspace = createTempWorkspace({ security: { mode: "allow" }, bashTerminationGraceMs: 50 });
    const controller = new AbortController();
    const pidFile = resolve(workspace, "child.pid");
    let pending: Promise<string> | undefined;
    let pid: number | undefined;
    try {
      const config = loadConfig(workspace);
      const tool = createBashTool(workspace, () => config);
      pending = tool.execute({ command: `bash -c 'trap "" TERM; echo $$ > child.pid; while :; do sleep 1; done' & wait`, timeout: timeout ? 1 : 30 }, { config, signal: controller.signal });
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
      pid = Number(readFileSync(pidFile, "utf8").trim());
      if (!timeout) controller.abort();
      const result = JSON.parse(await pending);
      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toContain(timeout ? "超时" : "已取消");
      await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow());
      expect(JSON.parse(await tool.execute({ command: "echo ready" }, { config })).stdout.trim()).toBe("ready");
    } finally {
      controller.abort();
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
      await pending;
      removeTempWorkspace(workspace);
    }
  });
});
