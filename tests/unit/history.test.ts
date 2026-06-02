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
