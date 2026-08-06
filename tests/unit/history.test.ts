import { describe, expect, it } from "vitest";
import { MessageHistory } from "../../src/history.js";
import type { Message } from "../../src/types.js";

function message(role: Message["role"], content: string): Message {
  return { role, content };
}

describe("MessageHistory", () => {
  it("keeps the configured number of previous turns", () => {
    const history = new MessageHistory([
      message("user", "u1"),
      message("assistant", "a1"),
      message("user", "u2"),
      message("assistant", "a2"),
      message("user", "u3"),
      message("assistant", "a3"),
    ]);

    expect(history.getRecentMessages(2)).toEqual([
      message("user", "u2"),
      message("assistant", "a2"),
      message("user", "u3"),
      message("assistant", "a3"),
    ]);
  });

  it("never trims messages from the current turn", () => {
    const history = new MessageHistory([
      message("user", "previous-user"),
      message("assistant", "previous-assistant"),
    ]);
    history.markTurnStart();
    history.push(message("user", "current-user"));
    history.push(message("assistant", "tool-call"));
    history.push(message("user", "tool-result"));

    expect(history.getRecentMessages(0)).toEqual([
      message("user", "current-user"),
      message("assistant", "tool-call"),
      message("user", "tool-result"),
    ]);
    expect(history.getTurnStartIndexInContext(0)).toBe(0);
  });

  it("drops a leading assistant message after trimming", () => {
    const history = new MessageHistory([
      message("user", "u1"),
      message("assistant", "a1"),
      message("assistant", "a1-extra"),
      message("user", "u2"),
      message("assistant", "a2"),
    ]);

    expect(history.getRecentMessages(1)).toEqual([
      message("user", "u2"),
      message("assistant", "a2"),
    ]);
  });

  it("counts readable user turns after removing tool messages", () => {
    const history = new MessageHistory([
      message("user", "u1"),
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "bash", input: { command: "pwd" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }],
      },
      message("assistant", "a1"),
      message("user", "u2"),
      message("assistant", "a2"),
    ]);

    expect(history.getRecentMessages(2)).toEqual([
      message("user", "u1"),
      message("assistant", "a1"),
      message("user", "u2"),
      message("assistant", "a2"),
    ]);
  });

  it("does not let dense tool traffic evict the previous user prompt", () => {
    const history = new MessageHistory([
      message("user", "original-task"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "progress-1" },
          { type: "tool_use", id: "call-1", name: "bash", input: { command: "one" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "large-result-1" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "progress-2" },
          { type: "tool_use", id: "call-2", name: "bash", input: { command: "two" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-2", content: "large-result-2" }],
      },
      message("assistant", "iteration-limit"),
    ]);
    history.markTurnStart();
    history.push(message("user", "continue"));

    expect(history.getRecentMessages(1)).toEqual([
      message("user", "original-task"),
      { role: "assistant", content: [{ type: "text", text: "progress-1" }] },
      { role: "assistant", content: [{ type: "text", text: "progress-2" }] },
      message("assistant", "iteration-limit"),
      message("user", "continue"),
    ]);
  });

  it("strips completed tool messages from previous turns", () => {
    const history = new MessageHistory([
      message("user", "previous-user"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will search" },
          { type: "tool_use", id: "call-1", name: "web_search", input: { query: "large" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "very large result" }],
      },
      message("assistant", "previous-final-answer"),
    ]);
    history.markTurnStart();
    history.push(message("user", "current-user"));

    expect(history.getRecentMessages(10)).toEqual([
      message("user", "previous-user"),
      {
        role: "assistant",
        content: [{ type: "text", text: "I will search" }],
      },
      message("assistant", "previous-final-answer"),
      message("user", "current-user"),
    ]);
  });

  it("keeps tool messages inside the current turn", () => {
    const history = new MessageHistory([
      message("user", "previous-user"),
      message("assistant", "previous-assistant"),
    ]);
    history.markTurnStart();
    history.push(message("user", "current-user"));
    history.push({
      role: "assistant",
      content: [{ type: "tool_use", id: "call-1", name: "web_search", input: { query: "large" } }],
    });
    history.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call-1", content: "current result" }],
    });

    expect(history.getRecentMessages(10)).toEqual([
      message("user", "previous-user"),
      message("assistant", "previous-assistant"),
      message("user", "current-user"),
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "web_search", input: { query: "large" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "current result" }],
      },
    ]);
  });

  it("replaces compressed history and preserves the new turn index", () => {
    const history = new MessageHistory();
    history.replaceWithCompressed([
      message("user", "summary"),
      message("assistant", "compressed"),
      message("user", "current"),
    ], 2);

    expect(history.getCurrentTurnMessages()).toEqual([message("user", "current")]);
    expect(history.getTurnStartIndexInContext(1)).toBe(2);
  });
});
