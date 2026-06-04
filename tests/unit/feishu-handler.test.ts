import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/agent.js";
import { loadConfig } from "../../src/config.js";
import { PluginManager } from "../../src/plugin-manager.js";
import { processFeishuMessage } from "../../src/plugins/feishu/handler.js";
import { listApprovals, requestApproval } from "../../src/tools/approval.js";
import { createBashTool } from "../../src/tools/bash.js";
import type { AgentActor, AgentEvent } from "../../src/types.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

describe("feishu approval commands", () => {
  const paths: string[] = [];
  const managers: PluginManager[] = [];
  const actor: AgentActor = { channel: "feishu", requesterId: "ou_requester", chatId: "oc_chat" };
  const otherActor: AgentActor = { channel: "feishu", requesterId: "ou_other", chatId: "oc_chat" };

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.destroy();
    for (const path of paths.splice(0)) removeTempWorkspace(path);
  });

  async function createCommandManager(workspacePath: string): Promise<PluginManager> {
    const manager = new PluginManager(workspacePath);
    await manager.loadCorePlugins();
    managers.push(manager);
    return manager;
  }

  async function runFeishuCommand(manager: PluginManager, input: string, commandActor = actor): Promise<string | undefined> {
    return (await manager.executeChatCommand(input, {
      sessionId: "feishu:oc_chat",
      channel: "feishu",
      actor: commandActor,
    }))?.text;
  }

  it("lists and approves only the current user's approvals", async () => {
    const workspacePath = createTempWorkspace({ security: { bash: { mode: "ask" } } });
    paths.push(workspacePath);
    const manager = await createCommandManager(workspacePath);
    const pending = requestApproval(workspacePath, "bash", "pwd", workspacePath, undefined, actor, "feishu:oc_chat");

    await expect(runFeishuCommand(manager, "/approvals", actor)).resolves.toContain(pending.approval!.id);
    await expect(runFeishuCommand(manager, "/approvals", actor)).resolves.toContain(`/approve ${pending.approval!.id}`);
    await expect(runFeishuCommand(manager, "/approvals", otherActor)).resolves.toBe("暂无你可以处理的命令审批。");
    await expect(runFeishuCommand(manager, `/approve ${pending.approval!.id}`, otherActor)).resolves.toContain("无权处理");
    expect(listApprovals(workspacePath, actor)[0].status).toBe("pending");

    await expect(runFeishuCommand(manager, `/approve ${pending.approval!.id}`, actor)).resolves.toContain("已批准并执行该命令");
    expect(listApprovals(workspacePath, actor)).toEqual([]);
  });

  it("returns a ready-to-send approval command from bash", async () => {
    const workspacePath = createTempWorkspace({ security: { bash: { mode: "ask" } } });
    paths.push(workspacePath);
    const bash = createBashTool(workspacePath, () => loadConfig(workspacePath));

    const pending = JSON.parse(await bash.execute({ command: "pwd" }, { actor }));

    expect(pending.approvalCommand).toBe(`/approve ${pending.approvalId}`);
    expect(pending.error).toContain(`/approve ${pending.approvalId}`);
    expect(pending.error).toContain("只回复“批准”无效");
    expect(pending.error).toContain("批准后系统会立即执行该命令");
  });

  it("rejects approvals and ignores normal messages", async () => {
    const workspacePath = createTempWorkspace();
    paths.push(workspacePath);
    const manager = await createCommandManager(workspacePath);
    const pending = requestApproval(workspacePath, "skill", "printf test", workspacePath, undefined, actor);

    await expect(runFeishuCommand(manager, `/reject ${pending.approval!.id}`, actor)).resolves.toBe("已拒绝该命令。");
    expect(listApprovals(workspacePath, actor)).toEqual([]);
    await expect(runFeishuCommand(manager, "继续执行任务", actor)).resolves.toBeUndefined();
  });

  it("executes an approved bash command immediately in Feishu", async () => {
    const workspacePath = createTempWorkspace({ security: { bash: { mode: "ask" } } });
    paths.push(workspacePath);
    const manager = await createCommandManager(workspacePath);
    const pending = requestApproval(workspacePath, "bash", "printf feishu-approved", workspacePath, undefined, actor, "feishu:oc_chat");

    const reply = await runFeishuCommand(manager, `/approve ${pending.approval!.id}`, actor);

    expect(reply).toContain("已批准并执行该命令");
    expect(reply).toContain("feishu-approved");
    expect(reply).toContain("退出码：0");
    expect(listApprovals(workspacePath, actor)).toEqual([]);
  });

  it("handles approval commands before entering the agent loop", async () => {
    const workspacePath = createTempWorkspace();
    paths.push(workspacePath);
    const manager = await createCommandManager(workspacePath);
    requestApproval(workspacePath, "bash", "pwd", workspacePath, undefined, actor);
    const chat = vi.fn(async function* (): AsyncGenerator<AgentEvent> {
      yield { type: "done", text: "" };
    });
    const replyMessage = vi.fn(async () => ["om_reply"]);

    await processFeishuMessage(
      { chat } as unknown as AgentSession,
      "/approvals",
      "om_message",
      { replyMessage, updateMessageCard: vi.fn(async () => {}) },
      workspacePath,
      actor,
      async (input, commandActor) => (await manager.executeChatCommand(input, {
        sessionId: "feishu:oc_chat",
        channel: "feishu",
        actor: commandActor,
      }))?.text,
    );

    expect(chat).not.toHaveBeenCalled();
    expect(replyMessage).toHaveBeenCalledWith("om_message", expect.stringContaining("审批 ID"));
  });

  it("passes the actor into normal agent messages", async () => {
    const workspacePath = createTempWorkspace();
    paths.push(workspacePath);
    const chat = vi.fn(async function* (): AsyncGenerator<AgentEvent> {
      yield { type: "done", text: "" };
    });

    await processFeishuMessage(
      { chat } as unknown as AgentSession,
      "你好",
      "om_message",
      { replyMessage: vi.fn(async () => ["om_reply"]), updateMessageCard: vi.fn(async () => {}) },
      workspacePath,
      actor,
    );

    expect(chat).toHaveBeenCalledWith("你好", actor);
  });

  it("streams normal agent messages by updating one reply card", async () => {
    const workspacePath = createTempWorkspace();
    paths.push(workspacePath);
    const chat = vi.fn(async function* (): AsyncGenerator<AgentEvent> {
      yield { type: "text_delta", text: "hello" };
      yield { type: "tool_call", name: "file_read", input: { path: "a.txt" } };
      yield { type: "tool_result", name: "file_read", result: "content" };
      yield { type: "text_delta", text: " world" };
      yield { type: "done", text: "hello world" };
    });
    const replyMessage = vi.fn(async () => ["om_reply"]);
    const updateMessageCard = vi.fn(async () => {});

    await processFeishuMessage(
      { chat } as unknown as AgentSession,
      "你好",
      "om_message",
      { replyMessage, updateMessageCard },
      workspacePath,
      actor,
    );

    expect(replyMessage).toHaveBeenCalledTimes(1);
    expect(replyMessage).toHaveBeenCalledWith("om_message", "正在处理...");
    expect(updateMessageCard).toHaveBeenCalledWith("om_reply", expect.stringContaining("hello"));
    expect(updateMessageCard).toHaveBeenLastCalledWith("om_reply", expect.stringContaining(" world"));
  });

  it("renders approval tool results as explicit Feishu instructions", async () => {
    const workspacePath = createTempWorkspace();
    paths.push(workspacePath);
    const result = JSON.stringify({
      error: "bash 执行需要用户确认。",
      requiresConfirmation: true,
      approvalId: "approval-1",
      approvalCommand: "/approve approval-1",
      command: "pwd",
    });
    const chat = vi.fn(async function* (): AsyncGenerator<AgentEvent> {
      yield { type: "tool_result", name: "bash", result };
      yield { type: "done", text: "" };
    });
    const updateMessageCard = vi.fn(async () => {});

    await processFeishuMessage(
      { chat } as unknown as AgentSession,
      "查一下",
      "om_message",
      { replyMessage: vi.fn(async () => ["om_reply"]), updateMessageCard },
      workspacePath,
      actor,
    );

    expect(updateMessageCard).toHaveBeenLastCalledWith("om_reply", expect.stringContaining("/approve approval-1"));
    expect(updateMessageCard).toHaveBeenLastCalledWith("om_reply", expect.stringContaining("只回复“批准”不会生效"));
    expect(updateMessageCard).toHaveBeenLastCalledWith("om_reply", expect.stringContaining("批准后系统会立即执行这条命令"));
  });
});
