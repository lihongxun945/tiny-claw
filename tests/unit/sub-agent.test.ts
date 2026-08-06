import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/agent.js";
import { collectSubAgentResult } from "../../src/sub-agent.js";
import { listApprovals, requestApproval } from "../../src/tools/approval.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

describe("sub-agent approval handling", () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const workspacePath of workspaces.splice(0)) removeTempWorkspace(workspacePath);
  });

  it("reports approval as blocked and removes the unresumable sub-session approval", async () => {
    const workspacePath = createTempWorkspace();
    workspaces.push(workspacePath);
    const actor = { channel: "web" as const, requesterId: "user-a" };
    const approval = requestApproval(
      workspacePath,
      "file_read",
      { path: "src/agent.ts" },
      undefined,
      actor,
      "sub:main:worker",
    ).approval!;

    async function* events(): AsyncGenerator<AgentEvent> {
      yield { type: "tool_call", toolCallId: "call-1", name: "file_read", input: { path: "src/agent.ts" } };
      yield {
        type: "tool_result",
        toolCallId: "call-1",
        name: "file_read",
        result: JSON.stringify({ requiresConfirmation: true, approvalId: approval.id }),
      };
      yield { type: "done", text: "", reason: "approval_required" };
    }

    await expect(collectSubAgentResult({ workspacePath, actor, id: "worker", events: events() })).resolves.toEqual({
      id: "worker",
      status: "approval_required",
      summary: "",
      toolCalls: [{ name: "file_read", input: { path: "src/agent.ts" } }],
      error: expect.stringContaining("请由主 Agent 使用相同参数重新调用"),
    });
    expect(listApprovals(workspacePath)).toEqual([]);
  });
});
