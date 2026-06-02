import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../../src/config.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

describe("loadConfig", () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const workspacePath of workspaces.splice(0)) {
      removeTempWorkspace(workspacePath);
    }
  });

  it("loads defaults and identity from the workspace", () => {
    const workspacePath = createTempWorkspace();
    workspaces.push(workspacePath);
    writeFileSync(resolve(workspacePath, "identity.md"), "You are tiny-claw.", "utf-8");

    expect(loadConfig(workspacePath)).toMatchObject({
      apiUrl: "https://example.com/api",
      apiKey: "test-api-key",
      model: "test-model",
      modelProvider: "anthropic-messages",
      maxTokens: 4096,
      maxContextTokens: 128000,
      contextCompressionThreshold: 0.7,
      historyWindowSize: 5,
      maxAgentIterations: 0,
      searchProvider: "ollama",
      workspacePath,
      systemPrompt: "You are tiny-claw.",
    });
  });

  it("loads provider-specific search configuration", () => {
    const workspacePath = createTempWorkspace({
      searchProvider: "ollama",
      ollamaApiKey: "ollama-key",
      braveApiKey: "brave-key",
      searxngUrl: "http://localhost:8080",
    });
    workspaces.push(workspacePath);

    expect(loadConfig(workspacePath)).toMatchObject({
      searchProvider: "ollama",
      ollamaApiKey: "ollama-key",
      braveApiKey: "brave-key",
      searxngUrl: "http://localhost:8080",
    });
  });

  it.each([
    [{ apiKey: "key", model: "model" }, "配置缺少 apiUrl"],
    [{ apiUrl: "url", model: "model" }, "配置缺少 apiKey"],
    [{ apiUrl: "url", apiKey: "key" }, "配置缺少 model"],
  ])("rejects missing required fields", (config, message) => {
    const workspacePath = createTempWorkspace();
    workspaces.push(workspacePath);
    writeFileSync(resolve(workspacePath, "config.json"), JSON.stringify(config), "utf-8");

    expect(() => loadConfig(workspacePath)).toThrow(message);
  });
});
