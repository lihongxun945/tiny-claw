import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBashTool } from "../../src/tools/bash.js";
import { createFileReadTool } from "../../src/tools/file_read.js";
import { loadConfig } from "../../src/config.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

describe.skipIf(process.platform === "win32")("bash process cancellation", () => {
  it("bounds output explicitly and retains a readable full log across project boundaries", async () => {
    const workspace = createTempWorkspace({ security: { mode: "allow" }, bashMaxOutputChars: 8, fileReadMaxChars: 12 });
    const project = createTempWorkspace();
    try {
      const config = loadConfig(workspace);
      const context = { config, rootPath: project, restrictToRoot: true };
      const result = JSON.parse(await createBashTool(workspace, () => config).execute({ command: "printf 'first-line\\nlast-line\\n'" }, context));
      expect(result).toMatchObject({ truncated: true, exitCode: 0 });
      expect(result.stdout.length).toBeLessThanOrEqual(8);
      expect(readFileSync(result.outputPath, "utf8")).toBe("first-line\nlast-line\n");
      const reader = createFileReadTool(workspace, () => config);
      const clipped = await reader.execute({ path: result.outputPath }, context);
      expect(clipped).toContain("内容截断");
      expect(clipped).toContain("offset/limit");
      expect(await reader.execute({ path: result.outputPath, offset: 2, limit: 1 }, context)).toBe("2\tlast-line");
    } finally {
      removeTempWorkspace(workspace);
      removeTempWorkspace(project);
    }
  });
  it("only reports command execution after permission and process startup", async () => {
    const workspace = createTempWorkspace({ security: { mode: "ask" } });
    try {
      const config = loadConfig(workspace);
      const tool = createBashTool(workspace, () => config);
      const reportActivity = vi.fn();
      await tool.execute({ command: "echo ready" }, { config, reportActivity });
      expect(reportActivity).not.toHaveBeenCalled();
      const allowed = { ...config, security: { ...config.security, mode: "allow" as const } };
      const result = await tool.execute({ command: "echo ready" }, { config: allowed, reportActivity });
      expect(JSON.parse(result).exitCode).toBe(0);
      expect(reportActivity).toHaveBeenCalledExactlyOnceWith("正在执行命令：echo ready");
    } finally {
      removeTempWorkspace(workspace);
    }
  });
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
