import { describe, expect, it } from "vitest";
import { mergeApprovalResume } from "../../web/src/lib/message-merge.js";
import type { Message } from "../../web/src/types.js";

describe("WebUI approval resume message merge", () => {
  it("replaces the approval result and keeps the resumed loop in the same assistant message", () => {
    const messages: Message[] = [
      { role: "user", text: "检查环境", toolCalls: [], timestamp: 1 },
      {
        role: "assistant",
        text: "我先检查一下。",
        toolCalls: [{
          id: "call-1",
          name: "bash",
          input: { command: "pwd" },
          result: JSON.stringify({ requiresConfirmation: true, approvalId: "approval-1" }),
        }],
        timestamp: 2,
      },
    ];

    const merged = mergeApprovalResume(messages, "approval-1", "检查完成。", [
      { id: "call-1", name: "bash", input: { command: "pwd" }, result: "/workspace" },
      { id: "call-2", name: "file_read", input: { path: "a.txt" }, result: "content" },
    ]);

    expect(merged).toHaveLength(2);
    expect(merged[1]).toEqual({
      role: "assistant",
      text: "我先检查一下。\n检查完成。",
      toolCalls: [
        { id: "call-1", name: "bash", input: { command: "pwd" }, result: "/workspace" },
        { id: "call-2", name: "file_read", input: { path: "a.txt" }, result: "content" },
      ],
      timestamp: 2,
    });
  });

  it("falls back to a new message when the approval message is unavailable", () => {
    const merged = mergeApprovalResume([], "missing", "完成", []);
    expect(merged).toEqual([expect.objectContaining({ role: "assistant", text: "完成" })]);
  });
});
