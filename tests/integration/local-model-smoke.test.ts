import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadLocalModel } from "../../src/model/local-store.js";
import { LocalLlamaClient } from "../../src/model/local.js";
import { LOCAL_MODELS } from "../../src/model/local-catalog.js";
import type { Config } from "../../src/types.js";

const enabled = process.env.RUN_LOCAL_MODEL_TEST === "1";
let workspacePath = "";

describe.skipIf(!enabled)("local model catalog smoke test", () => {
  beforeAll(() => { workspacePath = mkdtempSync(join(tmpdir(), "tiny-claw-qwen-smoke-")); });
  afterAll(() => rmSync(workspacePath, { recursive: true, force: true }));

  it("resolves every catalog model without authentication", async () => {
    const { createModelDownloader } = await import("node-llama-cpp");
    for (const model of LOCAL_MODELS) {
      const downloader = await createModelDownloader({
        modelUri: model.modelUri,
        dirPath: workspacePath,
        showCliProgress: false,
      });
      expect(downloader.totalSize, model.id).toBeGreaterThan(0);
    }
  }, 2 * 60 * 1000);

  it("downloads Qwen 0.8B and generates a response", async () => {
    await downloadLocalModel(workspacePath, "qwen3.5-0.8b-q4");
    const client = new LocalLlamaClient({
      apiUrl: "https://unused.local",
      apiKey: "",
      model: "local",
      maxTokens: 16,
      maxContextTokens: 2048,
      contextCompressionThreshold: 0.7,
      contextCompressionMaxChars: 1000,
      contextCompressionToolResultMaxChars: 500,
      toolResultInitialMaxChars: 12000,
      historyWindowSize: 1,
      maxAgentIterations: 1,
      searchProvider: "duckduckgo",
      remoteModel: { enabled: false },
      localModel: { enabled: true, modelId: "qwen3.5-0.8b-q4", contextSize: 2048 },
      workspacePath,
      systemPrompt: "",
    } satisfies Config);
    const response = await client.complete([{ role: "user", content: "只回复 OK" }]);
    expect(response.trim().length).toBeGreaterThan(0);
  }, 10 * 60 * 1000);
});
