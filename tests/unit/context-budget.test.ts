import { describe, expect, it } from "vitest";
import { calculateMessageTokenBudget } from "../../src/context-budget.js";
import type { Config, ToolDefinition } from "../../src/types.js";

function config(overrides: Partial<Config> = {}): Config {
  return {
    apiUrl: "https://example.com",
    apiKey: "key",
    model: "model",
    maxTokens: 1000,
    maxContextTokens: 10_000,
    contextCompressionThreshold: 0.7,
    contextCompressionMaxChars: 5000,
    contextCompressionToolResultMaxChars: 500,
    toolResultInitialMaxChars: 12_000,
    historyWindowSize: 5,
    maxAgentIterations: 100,
    searchProvider: "duckduckgo",
    workspacePath: "/tmp/test",
    systemPrompt: "",
    ...overrides,
  };
}

describe("calculateMessageTokenBudget", () => {
  it("reserves system prompt, tools, and output space", () => {
    const tools: ToolDefinition[] = [{
      name: "read",
      description: "读取文件",
      input_schema: { type: "object", properties: {} },
    }];
    const fullThresholdConfig = config({ contextCompressionThreshold: 1 });
    const budgetWithoutFixedInput = calculateMessageTokenBudget(fullThresholdConfig, "", []);
    const budgetWithFixedInput = calculateMessageTokenBudget(fullThresholdConfig, "系统提示".repeat(100), tools);

    expect(budgetWithoutFixedInput).toBe(8999);
    expect(budgetWithFixedInput).toBeLessThan(budgetWithoutFixedInput);
    expect(budgetWithFixedInput).toBeLessThanOrEqual(9000);
  });

  it("never returns a negative budget", () => {
    expect(calculateMessageTokenBudget(config({ maxContextTokens: 100, maxTokens: 100 }), "system", []))
      .toBe(0);
  });
});
