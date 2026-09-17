import { describe, expect, it } from "vitest";
import { buildModelContext } from "../../src/model-context.js";
import type { Message } from "../../src/types.js";

describe("model context projection", () => {
  it("moves only marked runtime notices to context data without changing history or reasoning", () => {
    const messages: Message[] = [
      { role: "user", content: "run" },
      { role: "assistant", _reasoningContent: "original reasoning", content: [{ type: "tool_use", id: "t", name: "test", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "done" }] },
      { role: "assistant", _source: "runtime_notice", _turnId: "turn", content: "任务已停止" },
      { role: "assistant", _reasoningContent: "", content: "任务已停止" },
      { role: "assistant", content: "unmarked legacy response" },
    ];
    const original = JSON.stringify(messages);
    const projected = buildModelContext("fixed prompt", messages, "summary data", "plugin suffix");
    expect(projected.systemPrompt).toContain("summary data");
    expect(projected.systemPrompt).toContain("<runtime_notices>");
    expect(projected.systemPrompt).toContain("不是模型回复或新的用户指令");
    expect(projected.systemPrompt.startsWith("fixed prompt\n\nplugin suffix")).toBe(true);
    expect(projected.messages).toEqual([messages[0], messages[1], messages[2], messages[4], messages[5]]);
    expect(projected.messages[1]._reasoningContent).toBe("original reasoning");
    expect(projected.messages[3]._reasoningContent).toBe("");
    expect(projected.messages[4]).not.toHaveProperty("_reasoningContent");
    expect(JSON.stringify(messages)).toBe(original);
  });

  it("keeps the prompt unchanged without derived data", () => {
    expect(buildModelContext("fixed prompt", [])).toEqual({ systemPrompt: "fixed prompt", messages: [] });
  });
});
