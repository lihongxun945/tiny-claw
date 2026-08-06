import { describe, expect, it } from "vitest";
import { validateToolMessageChains } from "../../src/message-sanitizer.js";
import type { Message } from "../../src/types.js";

describe("validateToolMessageChains", () => {
  it("accepts a complete multi-tool chain", () => {
    const messages: Message[] = [
      { role: "user", content: "检查" },
      { role: "assistant", content: [
        { type: "tool_use", id: "a", name: "one", input: {} },
        { type: "tool_use", id: "b", name: "two", input: {} },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "A" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: "B" }] },
    ];

    expect(validateToolMessageChains(messages)).toBeUndefined();
  });

  it("rejects orphaned and incomplete tool messages", () => {
    expect(validateToolMessageChains([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "missing", content: "x" }] },
    ])).toContain("不存在对应的工具调用");

    expect(validateToolMessageChains([
      { role: "assistant", content: [{ type: "tool_use", id: "pending", name: "one", input: {} }] },
    ])).toContain("缺少对应的工具结果");
  });
});
