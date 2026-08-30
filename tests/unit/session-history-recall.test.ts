import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { PluginManager } from "../../src/plugin-manager.js";
import { recallSessionHistory } from "../../src/session-memory/recall.js";
import { appendSessionMessage } from "../../src/session-store.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

describe("session history recall", () => {
  it("recalls exact source messages by stable message ID", async () => {
    const workspacePath = createTempWorkspace();
    try {
      const first = await appendSessionMessage(workspacePath, "session", { role: "user", content: "保留这句原文" });
      await appendSessionMessage(workspacePath, "session", { role: "assistant", content: "回答" });

      const result = recallSessionHistory(workspacePath, "session", {
        messageIds: [first._messageId!],
        limit: 20,
        maxOutputChars: 20000,
      });

      expect(result).toEqual({
        messages: [expect.objectContaining({
          messageId: first._messageId,
          sequence: 1,
          role: "user",
          content: "保留这句原文",
        })],
        matched: 1,
        truncated: false,
      });
    } finally {
      removeTempWorkspace(workspacePath);
    }
  });

  it("filters by sequence and keyword and reports truncation", async () => {
    const workspacePath = createTempWorkspace();
    try {
      await appendSessionMessage(workspacePath, "session", { role: "user", content: "alpha" });
      await appendSessionMessage(workspacePath, "session", { role: "assistant", content: "beta detail" });
      await appendSessionMessage(workspacePath, "session", { role: "user", content: "beta second" });

      const result = recallSessionHistory(workspacePath, "session", {
        fromSequence: 2,
        query: "BETA",
        limit: 1,
        maxOutputChars: 20000,
      });
      expect(result.matched).toBe(2);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].sequence).toBe(2);
      expect(result.truncated).toBe(true);
    } finally {
      removeTempWorkspace(workspacePath);
    }
  });

  it("registers a current-session-only read tool with configured limits", async () => {
    const workspacePath = createTempWorkspace({
      sessionSummary: {
        enabled: false,
        recallMaxResults: 1,
        recallMaxOutputChars: 20000,
        recallMaxQueryChars: 5,
      },
    });
    const manager = new PluginManager(workspacePath);
    try {
      await manager.loadCorePlugins();
      await appendSessionMessage(workspacePath, "session-a", { role: "user", content: "needle one" });
      await appendSessionMessage(workspacePath, "session-a", { role: "assistant", content: "needle two" });
      await appendSessionMessage(workspacePath, "session-b", { role: "user", content: "needle secret" });
      const tool = manager.getTool("session_history_recall")!;

      expect(tool.effect).toBe("read");
      expect(JSON.parse(await tool.execute({ query: "too-long" }, {
        sessionId: "session-a",
        config: loadConfig(workspacePath),
      }))).toEqual({ error: "query 不能超过 5 字符" });

      const result = JSON.parse(await tool.execute({ query: "needl", limit: 20 }, {
        sessionId: "session-a",
        config: loadConfig(workspacePath),
      }));
      expect(result.matched).toBe(2);
      expect(result.messages).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain("secret");
    } finally {
      await manager.destroy();
      removeTempWorkspace(workspacePath);
    }
  });
});
