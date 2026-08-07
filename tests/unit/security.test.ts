import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { createBashTool } from "../../src/tools/bash.js";
import { createFileEditTool } from "../../src/tools/file_edit.js";
import { createFileReadTool } from "../../src/tools/file_read.js";
import { createFileWriteTool } from "../../src/tools/file_write.js";
import { createSkillListTool, createSkillUseTool } from "../../src/tools/skill.js";
import { loadConfig } from "../../src/config.js";
import { PluginManager } from "../../src/plugin-manager.js";
import {
  approveRequest,
  approveTurnRequest,
  clearTurnApproval,
  hasTurnApproval,
  listApprovals,
  rejectRequest,
  requestApproval,
} from "../../src/tools/approval.js";
import { checkDangerousToolPermission } from "../../src/tools/permission.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

describe("security boundary", () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const path of paths.splice(0)) removeTempWorkspace(path);
  });

  it("allows file tools to access paths outside the workspace", async () => {
    const workspacePath = createTempWorkspace();
    const outsidePath = mkdtempSync(resolve(tmpdir(), "tiny-claw-outside-"));
    paths.push(workspacePath, outsidePath);
    writeFileSync(resolve(workspacePath, "inside.txt"), "inside", "utf-8");
    writeFileSync(resolve(outsidePath, "outside.txt"), "outside", "utf-8");
    symlinkSync(outsidePath, resolve(workspacePath, "escape"));

    const read = createFileReadTool(workspacePath, () => loadConfig(workspacePath));
    const write = createFileWriteTool(workspacePath, () => loadConfig(workspacePath));
    const edit = createFileEditTool(workspacePath, () => loadConfig(workspacePath));

    expect(await read.execute({ path: "inside.txt" })).toContain("inside");
    expect(await read.execute({ path: resolve(outsidePath, "outside.txt") })).toContain("outside");
    expect(await read.execute({ path: relative(workspacePath, resolve(outsidePath, "outside.txt")) })).toContain("outside");
    expect(await write.execute({ path: resolve(outsidePath, "new.txt"), content: "created" })).toContain('"bytesWritten":7');
    expect(await edit.execute({ path: resolve(outsidePath, "outside.txt"), old_text: "outside", new_text: "edited" })).toContain('"replaced":true');
    expect(await read.execute({ path: resolve(workspacePath, "escape", "outside.txt") })).toContain("edited");
    expect(readFileSync(resolve(outsidePath, "new.txt"), "utf-8")).toBe("created");
    expect(readFileSync(resolve(outsidePath, "outside.txt"), "utf-8")).toBe("edited");
  });

  it("allows bash by default and supports deny, ask and allow modes", async () => {
    const workspacePath = createTempWorkspace();
    const outsidePath = mkdtempSync(resolve(tmpdir(), "tiny-claw-bash-outside-"));
    paths.push(workspacePath, outsidePath);
    const configPath = resolve(workspacePath, "config.json");
    const bash = createBashTool(workspacePath, () => loadConfig(workspacePath));

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(await bash.execute({ command: "pwd" })).toContain(workspacePath);

    config.security = { tools: { bash: { mode: "deny" } } };
    writeFileSync(configPath, JSON.stringify(config), "utf-8");
    expect(await bash.execute({ command: "pwd" })).toContain("bash 执行已禁用");

    config.security = { tools: { bash: { mode: "ask" } } };
    writeFileSync(configPath, JSON.stringify(config), "utf-8");
    const pending = JSON.parse(await bash.execute({ command: "pwd", cwd: outsidePath }));
    expect(pending).toMatchObject({ requiresConfirmation: true, command: "pwd", cwd: outsidePath });
    expect(approveRequest(workspacePath, pending.approvalId)).toMatchObject({ status: "approved" });
    expect(await bash.execute({ command: "pwd", cwd: outsidePath })).toContain(outsidePath);
    expect(await bash.execute({ command: "pwd", cwd: outsidePath })).toContain('"requiresConfirmation":true');

    config.security.tools.bash.mode = "allow";
    writeFileSync(configPath, JSON.stringify(config), "utf-8");
    expect(await bash.execute({ command: "pwd" })).toContain(workspacePath);
    expect(await bash.execute({ command: "pwd", cwd: outsidePath })).toContain(outsidePath);
  });

  it("terminates an allowed bash command when cancelled", async () => {
    const workspacePath = createTempWorkspace({ security: { tools: { bash: { mode: "allow" } } } });
    paths.push(workspacePath);
    const bash = createBashTool(workspacePath, () => loadConfig(workspacePath));
    const controller = new AbortController();
    const running = bash.execute({ command: "sleep 5" }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    expect(await running).toContain("[已取消: 命令执行被用户中止]");
  });

  it("audits tool calls without logging file contents", async () => {
    const workspacePath = createTempWorkspace();
    paths.push(workspacePath);
    const manager = new PluginManager(workspacePath);
    await manager.loadCorePlugins();

    await manager.getTool("file_write")!.execute({
      path: "audit.txt",
      content: "do-not-log-this-content",
    });
    await manager.destroy();

    const today = new Date().toISOString().slice(0, 10);
    const log = readFileSync(resolve(workspacePath, "logs", `${today}.log`), "utf-8");
    expect(log).toContain("[AUDIT] 工具调用 file_write");
    expect(log).toContain('"path":"audit.txt"');
    expect(log).toContain("[AUDIT] 工具完成 file_write");
    expect(log).not.toContain("do-not-log-this-content");
  });

  it("applies the bash mode to dynamic commands in skills", async () => {
    const workspacePath = createTempWorkspace();
    paths.push(workspacePath);
    const skillDir = resolve(workspacePath, "skills", "dynamic");
    mkdirSync(skillDir);
    writeFileSync(resolve(skillDir, "SKILL.md"), [
      "---",
      "description: dynamic test",
      "---",
      "result: !`printf executed`",
      "```!",
      "printf block-executed",
      "```",
    ].join("\n"), "utf-8");
    const configPath = resolve(workspacePath, "config.json");
    const skill = createSkillUseTool(workspacePath, () => loadConfig(workspacePath));

    expect(await skill.execute({ name: "dynamic" })).toContain("result: executed");
    expect(await skill.execute({ name: "dynamic" })).toContain("block-executed");
    expect(await skill.execute({ name: "../config" })).toContain("未找到技能");

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    config.security = { tools: { bash: { mode: "deny" } } };
    writeFileSync(configPath, JSON.stringify(config), "utf-8");
    expect(await skill.execute({ name: "dynamic" })).toContain("bash 执行已禁用");

    config.security = { tools: { bash: { mode: "ask" } } };
    writeFileSync(configPath, JSON.stringify(config), "utf-8");
    expect(await skill.execute({ name: "dynamic" })).toContain('"requiresConfirmation":true');
    for (const approval of listApprovals(workspacePath)) approveRequest(workspacePath, approval.id);
    const approvedSkill = await skill.execute({ name: "dynamic" });
    expect(approvedSkill).toContain("result: executed");
    expect(approvedSkill).toContain("block-executed");

    config.security.tools.bash.mode = "allow";
    writeFileSync(configPath, JSON.stringify(config), "utf-8");
    expect(await skill.execute({ name: "dynamic" })).toContain("result: executed");
    expect(await skill.execute({ name: "dynamic" })).toContain("block-executed");
  });

  it("skips skills that escape the workspace through symlinks", async () => {
    const workspacePath = createTempWorkspace();
    const outsidePath = mkdtempSync(resolve(tmpdir(), "tiny-claw-skill-outside-"));
    paths.push(workspacePath, outsidePath);
    writeFileSync(resolve(outsidePath, "SKILL.md"), [
      "---",
      "description: external skill",
      "---",
      "external",
    ].join("\n"), "utf-8");
    symlinkSync(outsidePath, resolve(workspacePath, "skills", "external"));

    const skillList = createSkillListTool(workspacePath);
    expect(await skillList.execute({})).toContain("暂无可用技能");
  });

  it("discovers and loads project skills from universal and Claude directories", async () => {
    const workspacePath = createTempWorkspace();
    const projectRoot = mkdtempSync(resolve(tmpdir(), "tiny-claw-project-skills-"));
    paths.push(workspacePath, projectRoot);

    const workspaceSkillDir = resolve(workspacePath, "skills", "review");
    mkdirSync(workspaceSkillDir, { recursive: true });
    writeFileSync(resolve(workspaceSkillDir, "SKILL.md"), [
      "---",
      "description: workspace review",
      "---",
      "workspace body",
    ].join("\n"), "utf-8");

    const projectSkillDir = resolve(projectRoot, ".agents", "skills", "review");
    mkdirSync(projectSkillDir, { recursive: true });
    writeFileSync(resolve(projectSkillDir, "SKILL.md"), [
      "---",
      "description: project review",
      "---",
      "project body",
    ].join("\n"), "utf-8");

    const claudeSkillDir = resolve(projectRoot, ".claude", "skills", "deploy");
    mkdirSync(claudeSkillDir, { recursive: true });
    writeFileSync(resolve(claudeSkillDir, "SKILL.md"), [
      "---",
      "description: claude deploy",
      "---",
      "claude body",
    ].join("\n"), "utf-8");

    const context = {
      rootPath: projectRoot,
      restrictToRoot: true,
      sessionContext: { mode: "project" as const, project: { root: projectRoot, name: "project" } },
    };
    const skillList = createSkillListTool(workspacePath);
    const listed = await skillList.execute({}, context);
    expect(listed).toContain("project/review");
    expect(listed).toContain("project/deploy");
    expect(listed).toContain("workspace/review");

    const skill = createSkillUseTool(workspacePath, () => loadConfig(workspacePath));
    expect(await skill.execute({ name: "review" }, context)).toContain("project body");
    expect(await skill.execute({ name: "workspace/review" }, context)).toContain("workspace body");
    expect(await skill.execute({ name: "project/deploy" }, context)).toContain("claude body");
    expect(await skill.execute({ name: "project/deploy" })).toContain("未找到技能");
  });

  it("deduplicates, consumes, rejects and expires approvals", () => {
    const workspacePath = createTempWorkspace();
    paths.push(workspacePath);

    const first = requestApproval(workspacePath, "bash", { command: "pwd", cwd: workspacePath }, undefined, undefined, undefined, { command: "pwd", cwd: workspacePath });
    const duplicate = requestApproval(workspacePath, "bash", { cwd: workspacePath, command: "pwd" }, undefined, undefined, undefined, { command: "pwd", cwd: workspacePath });
    expect(duplicate.approval?.id).toBe(first.approval?.id);
    expect(listApprovals(workspacePath)).toHaveLength(1);

    expect(approveRequest(workspacePath, first.approval!.id)?.status).toBe("approved");
    expect(requestApproval(workspacePath, "bash", { command: "pwd", cwd: workspacePath })).toEqual({ approved: true, source: "single" });
    expect(listApprovals(workspacePath)).toEqual([]);

    const rejected = requestApproval(workspacePath, "bash", { command: "ls", cwd: workspacePath }, undefined, undefined, undefined, { command: "ls", cwd: workspacePath });
    expect(rejectRequest(workspacePath, rejected.approval!.id)).toBe(true);
    expect(rejectRequest(workspacePath, rejected.approval!.id)).toBe(false);

    requestApproval(workspacePath, "bash", { command: "expired", cwd: workspacePath }, -1);
    expect(listApprovals(workspacePath)).toEqual([]);
  });

  it("does not deduplicate identical approvals across sessions", () => {
    const workspacePath = createTempWorkspace();
    paths.push(workspacePath);
    const actor = { channel: "web" as const, requesterId: "user-a" };
    const first = requestApproval(workspacePath, "file_read", { path: "same.ts" }, undefined, actor, "main");
    const second = requestApproval(workspacePath, "file_read", { path: "same.ts" }, undefined, actor, "sub:main:worker");

    expect(first.approval?.id).not.toBe(second.approval?.id);
    expect(listApprovals(workspacePath)).toHaveLength(2);
  });

  it("scopes turn approvals to the current session and actor until cleared", () => {
    const workspacePath = createTempWorkspace();
    paths.push(workspacePath);
    const actor = { channel: "web" as const, requesterId: "user-a" };
    const otherActor = { channel: "web" as const, requesterId: "user-b" };
    const pending = requestApproval(
      workspacePath,
      "bash",
      { command: "first" },
      undefined,
      actor,
      "session-a",
    );

    expect(approveTurnRequest(workspacePath, pending.approval!.id, actor)?.status).toBe("approved");
    expect(hasTurnApproval(workspacePath, "session-a", actor)).toBe(true);
    expect(requestApproval(workspacePath, "bash", { command: "first" }, undefined, actor, "session-a"))
      .toEqual({ approved: true, source: "single" });
    expect(requestApproval(workspacePath, "file_write", { path: "a" }, undefined, actor, "session-a"))
      .toEqual({ approved: true, source: "turn" });
    const denied = checkDangerousToolPermission({
      workspacePath,
      config: { ...loadConfig(workspacePath), security: { mode: "deny" } },
      toolName: "bash",
      args: { command: "blocked" },
      context: { sessionId: "session-a", actor },
    });
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.result).toContain("执行已禁用");
    expect(requestApproval(workspacePath, "bash", { command: "other-user" }, undefined, otherActor, "session-a").approved)
      .toBe(false);
    expect(requestApproval(workspacePath, "bash", { command: "other-session" }, undefined, actor, "session-b").approved)
      .toBe(false);

    clearTurnApproval(workspacePath, "session-a", actor);
    expect(hasTurnApproval(workspacePath, "session-a", actor)).toBe(false);
    expect(requestApproval(workspacePath, "file_edit", { path: "a" }, undefined, actor, "session-a").approved)
      .toBe(false);
  });
});
