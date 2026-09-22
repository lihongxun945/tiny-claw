import { describe, it, expect } from "vitest";
import type { Config, Message } from "../../src/types.js";
import { boundedToolResult, projectToolMessages, toolContextOptions } from "../../src/tool-context.js";
import { estimateTextTokens, estimateTokens } from "../../src/estimate-tokens.js";

const config = { plugins: {} } as Config;
describe("tool context budgets", () => {
  it("caps only historical bodies and keeps the projection stable", () => {
    const raw: Message[] = ["old", "current"].map(id => ({ role: "user", content: [
      { type: "tool_result", tool_use_id: id, content: "文".repeat(900) },
    ] }));
    const projected = projectToolMessages(raw, config, Infinity, false, undefined, 1);
    const content = (message: Message) => Array.isArray(message.content) && message.content[0].type === "tool_result" ? message.content[0].content : "";
    expect(JSON.parse(content(projected[0])).preview).toHaveLength(500);
    expect(content(projected[1])).toHaveLength(900);
    expect(content(raw[0])).toHaveLength(900);
    expect(projectToolMessages(projected, config, Infinity, false, undefined, 1)).toEqual(projected);
    const custom = { plugins: { "core-tool-context": { historyResultMaxChars: 100 } } } as unknown as Config;
    expect(JSON.parse(content(projectToolMessages(raw, custom, Infinity, false, undefined, 1)[0])).preview).toHaveLength(100);
    expect(() => toolContextOptions({ plugins: { "core-tool-context": { historyResultMaxChars: 0 } } } as unknown as Config)).toThrow();
  });
  it("bounds all three large search results without changing originals or breaking JSON", () => {
    const messages: Message[] = [60000, 285000, 71000].map((size, i) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: `call-${i}`,
      content: JSON.stringify({ results: [{ title: "论文", url: "https://example.com/paper", snippet: "文".repeat(size) }] }) }] }));
    const before = JSON.stringify(messages);
    const projected = projectToolMessages(messages, config, 10000);
    expect(estimateTokens(projected)).toBeLessThanOrEqual(10000);
    expect(JSON.stringify(messages)).toBe(before);
    for (const m of projected) if (Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_result") {
      const result = JSON.parse(b.content);
      expect(result.truncated).toBe(true);
      expect(result.contentRef.toolCallId).toBe(b.tool_use_id);
      expect(result.results[0].snippet.length).toBeLessThanOrEqual(1500);
      expect(result.results[0].url).toBe("https://example.com/paper");
    }
  });
  it("shares a cumulative budget and includes reasoning tokens", () => {
    const messages: Message[] = Array.from({ length: 20 }, (_, i) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: String(i), content: "x".repeat(10000) }] }));
    messages.unshift({ role: "assistant", content: "ready", _reasoningContent: "r".repeat(4000) });
    const projected = projectToolMessages(messages, config, 6000);
    expect(estimateTokens(projected)).toBeLessThanOrEqual(6000);
    expect(projected[0]._reasoningContent).toBe(messages[0]._reasoningContent);
  });
  it("keeps small results and control responses intact", () => {
    for (const content of ["small", JSON.stringify({ requiresConfirmation: true, approvalId: "id", args: { content: "x".repeat(10000) } }), JSON.stringify({ status: "waiting_user", question: "x".repeat(10000) })]) {
      expect(boundedToolResult(content, "tool", 100, 100)).toBe(content);
    }
    const failed = JSON.parse(boundedToolResult(JSON.stringify({ exitCode: 1, error: "failed", stdout: "x".repeat(50000) }), "tool", 200, 100));
    const answer = JSON.stringify({ status: "answered", selectedIds: [], text: "x".repeat(20000) });
    expect(boundedToolResult(answer, "answer", 100, 100)).toBe(answer);
    expect(failed.exitCode).toBe(1);
    expect(failed.error).toBe("failed");
    expect(estimateTextTokens(JSON.stringify(failed))).toBeLessThanOrEqual(200);
  });
  it("updates pagination after a page is shortened again", () => {
    const page = JSON.stringify({ toolCallId: "source", offset: 100, nextOffset: 10100, totalChars: 20000, content: "x".repeat(10000) });
    const result = JSON.parse(boundedToolResult(page, "read-call", 200, 100));
    expect(result.toolCallId).toBe("source");
    expect(result.nextOffset).toBe(100 + result.content.length);
    expect(result.truncated).toBe(true);
    expect(estimateTextTokens(JSON.stringify(result))).toBeLessThanOrEqual(200);
  });
  it("validates configurable limits", () => {
    expect(toolContextOptions(config).maxResultTokens).toBe(8000);
    for (const settings of [{ maxResultTokens: 0 }, { safetyMargin: 1 }, { summaryRetries: -1 }]) {
      expect(() => toolContextOptions({ plugins: { "core-tool-context": settings } } as Config)).toThrow("配置无效");
    }
  });

  it("keeps a complete newest recall page readable among many old results", () => {
    const messages: Message[] = Array.from({ length: 100 }, (_, i) => ({ role: "user", content: [{
      type: "tool_result", tool_use_id: `old-${i}`, content: "旧资料".repeat(3000),
    }] }));
    const page = JSON.stringify({ toolCallId: "source", resultIndex: 1, offset: 1720,
      nextOffset: 6277, totalChars: 6277, truncated: false, content: "x".repeat(4557) });
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: "latest", name: "session_history_recall", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "latest", content: page }] });
    const projected = projectToolMessages(messages, config, 18000, true);
    const block = projected.at(-1)!.content;
    expect(Array.isArray(block) && block[0].type === "tool_result" && block[0].content).toBe(page);
    expect(estimateTokens(projected)).toBeLessThanOrEqual(18000);
    expect(projectToolMessages(projected, config, 18000, true)).toEqual(projected);
  });

  it("does not silently shrink the latest read to a few characters when history cannot fit", () => {
    const page = JSON.stringify({ toolCallId: "source", offset: 0, nextOffset: 4000,
      totalChars: 4000, truncated: false, content: "x".repeat(4000) });
    const messages: Message[] = [{ role: "user", content: "fixed".repeat(3000) },
      { role: "assistant", content: [{ type: "tool_use", id: "read", name: "session_history_recall", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "read", content: page }] }];
    const projected = projectToolMessages(messages, config, 200, true);
    expect(JSON.stringify(projected)).toContain("x".repeat(4000));
    // The caller must compress or report the hard budget failure before sending.
    expect(estimateTokens(projected)).toBeGreaterThan(200);
  });
});
