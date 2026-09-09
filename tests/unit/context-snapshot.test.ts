import { describe, expect, it } from "vitest";
import { createPreparedModelRequest } from "../../src/context-snapshot.js";
import { loadConfig } from "../../src/config.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

describe("context snapshot", () => {
  it("reports a token breakdown and removes internal message metadata", () => {
    const workspacePath = createTempWorkspace({ maxTokens: 1000, maxContextTokens: 10000 });
    try {
      const snapshot = createPreparedModelRequest({
        config: loadConfig(workspacePath),
        sessionId: "session-1",
        turnId: "turn-1",
        iteration: 2,
        attempt: 1,
        systemPrompt: "system prompt",
        messages: [{ role: "user", content: "hello", _messageId: "private", _sequence: 1, _turnId: "turn-1" }],
        tools: [{ name: "read", description: "read", input_schema: { type: "object", properties: {} } }],
      });

      expect(snapshot).toMatchObject({ sessionId: "session-1", turnId: "turn-1", iteration: 2, attempt: 1 });
      expect(snapshot.messages[0]).not.toHaveProperty("_messageId");
      expect(snapshot.messages[0]).not.toHaveProperty("_sequence");
      expect(snapshot.messages[0]).not.toHaveProperty("_turnId");
      expect(snapshot.usage.input).toBe(snapshot.usage.systemPrompt + snapshot.usage.messages + snapshot.usage.tools);
      expect(snapshot.usage.totalReserved).toBe(snapshot.usage.input + 1000);
      expect(snapshot.usage.maxContext).toBe(10000);
      expect(snapshot.contextSummaries).toEqual([]);
    } finally {
      removeTempWorkspace(workspacePath);
    }
  });

  it("copies summary metadata without changing the request or token totals", () => {
    const workspacePath = createTempWorkspace();
    try {
      const options = {
        config: loadConfig(workspacePath), sessionId: "summary", iteration: 1, attempt: 1,
        systemPrompt: "prompt with temporary summary", messages: [], tools: [],
      };
      const contextSummaries = [{ title: "会话摘要", content: "summary at request time" }];
      const baseline = createPreparedModelRequest(options);
      const snapshot = createPreparedModelRequest({ ...options, contextSummaries });
      expect(snapshot.contextSummaries).toEqual(contextSummaries);
      expect(snapshot.usage).toEqual(baseline.usage);
      expect(snapshot.messages).toEqual(baseline.messages);
      expect(snapshot.systemPrompt).toBe(baseline.systemPrompt);
      contextSummaries[0].content = "newer summary";
      expect(snapshot.contextSummaries?.[0].content).toBe("summary at request time");
    } finally {
      removeTempWorkspace(workspacePath);
    }
  });

  it("does not expose attachment filesystem paths", () => {
    const workspacePath = createTempWorkspace();
    try {
      const snapshot = createPreparedModelRequest({
        config: loadConfig(workspacePath), sessionId: "session-1", iteration: 1, attempt: 1,
        systemPrompt: "", tools: [],
        messages: [{ role: "user", content: [{
          type: "image", id: "image-1", name: "screen.png",
          source: { type: "attachment", path: "/private/secret/screen.png", mediaType: "image/png" },
        }] }],
      });
      expect(JSON.stringify(snapshot.messages)).not.toContain("/private/secret");
      expect(JSON.stringify(snapshot.messages)).toContain("[attachment]");
    } finally {
      removeTempWorkspace(workspacePath);
    }
  });
});
