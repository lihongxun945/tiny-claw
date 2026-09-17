import { readFileSync, existsSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBashTool } from "../../src/tools/bash.js";
import { createFileReadTool } from "../../src/tools/file_read.js";
import { loadConfig } from "../../src/config.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";
import { projectTempDirectory } from "../../src/security/project-trust.js";

describe("bash process cancellation", () => {
  it("runs local npx without npx resolution and writes logs to the managed temporary directory", async () => {
    const workspace = createTempWorkspace({ security: { mode: "auto" } });
    const project = createTempWorkspace();
    try {
      mkdirSync(resolve(project, "node_modules/.bin"), { recursive: true });
      writeFileSync(resolve(project, "node_modules/runner"), "#!/bin/sh\nprintf '%s' \"$CI\"\n", { mode: 0o700 });
      symlinkSync("../runner", resolve(project, "node_modules/.bin/runner"));
      const config = loadConfig(workspace);
      const context = { config, rootPath: project, sessionId: "local", sessionContext: { mode: "project" as const, project: { root: project, name: "project" } } };
      const tool = createBashTool(workspace, () => config);
      const result = JSON.parse(await tool.execute({ command: 'CI=true npx runner > "$TMPDIR/test.log"; cat "$TMPDIR/test.log"' }, context));
      expect(result).toMatchObject({ exitCode: 0, stdout: "true" });
      expect(result.executionCommand).not.toContain("npx");
      expect(readFileSync(resolve(projectTempDirectory(workspace, project), "test.log"), "utf8")).toBe("true");
      expect(JSON.parse(await tool.execute({ command: "npx missing-package" }, context)).requiresConfirmation).toBe(true);
      expect(JSON.parse(await tool.execute({ command: "npx runner" }, { ...context, config: { ...config, security: { mode: "ask" } } })).requiresConfirmation).toBe(true);
    } finally { removeTempWorkspace(workspace); removeTempWorkspace(project); }
  });
  it("disables configured external diff and textconv programs in the actual git process", async () => {
    const workspace = createTempWorkspace({ security: { mode: "auto" } });
    const project = createTempWorkspace();
    try {
      const git = (args: string[]) => execFileSync("git", args, { cwd: project, stdio: "pipe" });
      git(["init"]);
      writeFileSync(resolve(project, "file"), "before\n");
      writeFileSync(resolve(project, ".gitattributes"), "file diff=unsafe\n");
      writeFileSync(resolve(project, "helper.sh"), "#!/bin/sh\ntouch helper-ran\n", { mode: 0o700 });
      git(["add", "file", ".gitattributes"]);
      git(["config", "diff.external", "./helper.sh"]);
      git(["config", "diff.unsafe.textconv", "./helper.sh"]);
      writeFileSync(resolve(project, "file"), "after\n");
      const config = loadConfig(workspace);
      const result = JSON.parse(await createBashTool(workspace, () => config).execute({ command: "git diff file" }, {
        config, rootPath: project, sessionContext: { mode: "project", project: { root: project, name: "project" } },
      }));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("+after");
      expect(result.executionCommand).toContain("--no-ext-diff --no-textconv");
      expect(existsSync(resolve(project, "helper-ran"))).toBe(false);
    } finally { removeTempWorkspace(workspace); removeTempWorkspace(project); }
  });
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
  it.skipIf(process.platform === "win32").each([false, true])("terminates POSIX background descendants (timeout=%s)", async (timeout) => {
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
  it.skipIf(process.platform !== "win32").each([false, true])("terminates Windows process trees (timeout=%s)", async timeout => {
    const workspace = createTempWorkspace({ security: { mode: "allow" } });
    const controller = new AbortController();
    let pending: Promise<string> | undefined;
    let pid: number | undefined;
    try {
      writeFileSync(resolve(workspace, "parent.cjs"), `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
        require('node:fs').writeFileSync('child.pid', String(child.pid));
        setInterval(() => {}, 1000);
      `);
      const config = loadConfig(workspace);
      pending = createBashTool(workspace, () => config).execute({ command: "node parent.cjs", timeout: timeout ? 2 : 30 }, { config, signal: controller.signal });
      await vi.waitFor(() => expect(existsSync(resolve(workspace, "child.pid"))).toBe(true), { timeout: 5000 });
      pid = Number(readFileSync(resolve(workspace, "child.pid"), "utf8"));
      if (!timeout) controller.abort();
      const result = JSON.parse(await pending);
      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toContain(timeout ? "超时" : "已取消");
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      controller.abort();
      await pending;
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
      removeTempWorkspace(workspace);
    }
  }, 15000);
});
