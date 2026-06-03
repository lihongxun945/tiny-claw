import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/agent.js";
import { loadConfig } from "../../src/config.js";
import { handleApprovalCommand, processFeishuMessage } from "../../src/plugins/feishu/handler.js";
import { listApprovals, requestApproval } from "../../src/tools/approval.js";
import { createBashTool } from "../../src/tools/bash.js";
import type { AgentActor, AgentEvent } from "../../src/types.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

describe("feishu approval commands", () => {
  const paths: string[] = [];
  const actor: AgentActor = { channel: "feishu", requesterId: "ou_requester", chatId: "oc_chat" };
  const otherActor: AgentActor = { channel: "feishu", requesterId: "ou_other", chatId: "oc_chat" };

  afterEach(() => {
    for (const path of paths.splice(0)) removeTempWorkspace(path);
  });

  it("lists and approves only the current user's approvals", () => {
    const workspacePath = createTempWorkspace();
    paths.push(workspacePath);
    const pending = requestApproval(workspacePath, "bash", "pwd", workspacePath, undefined, actor, "feishu:oc_chat");

    expect(handleApprovalCommand(workspacePath, "/approvals", actor)).toContain(pending.approval!.id);
    expect(handleApprovalCommand(workspacePath, "/approvals", actor)).toContain(`/approve ${pending.approval!.id}`);
    expect(handleApprovalCommand(workspacePath, "/approvals", otherActor)).toBe("暂无你可以处理的命令审批。");
    expect(handleApprovalCommand(workspacePath, `/approve ${pending.approval!.id}`, otherActor)).toContain("无权处理");
    expect(listApprovals(workspacePath, actor)[0].status).toBe("pending");

    expect(handleApprovalCommand(workspacePath, `/approve ${pending.approval!.id}`, actor)).toContain("已允许");
    expect(requestApproval(workspacePath, "bash", "pwd", workspacePath, undefined, actor, "feishu:oc_chat")).toEqual({ approved: true });
  });

  it("returns a ready-to-send approval command from bash", async () => {
    const workspacePath = createTempWorkspace({ security: { bash: { mode: "ask" } } });
    paths.push(workspacePath);
    const bash = createBashTool(workspacePath, () => loadConfig(workspacePath));

    const pending = JSON.parse(await bash.execute({ command: "pwd" }, { actor }));

    expect(pending.approvalCommand).toBe(`/approve ${pending.approvalId}`);
  });

  it("rejects approvals and ignores normal messages", () => {
    const workspacePath = createTempWorkspace();
    paths.push(workspacePath);
    const pending = requestApproval(workspacePath, "skill", "printf test", workspacePath, undefined, actor);

    expect(handleApprovalCommand(workspacePath, `/reject ${pending.approval!.id}`, actor)).toBe("已拒绝该命令。");
    expect(listApprovals(workspacePath, actor)).toEqual([]);
    expect(handleApprovalCommand(workspacePath, "继续执行任务", actor)).toBeUndefined();
  });

  it("handles approval commands before entering the agent loop", async () => {
    const workspacePath = createTempWorkspace();
    paths.push(workspacePath);
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
});
