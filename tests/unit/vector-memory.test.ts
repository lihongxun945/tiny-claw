import { afterEach, describe, expect, it } from "vitest";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";
import { LocalHashEmbeddingProvider, type EmbeddingProvider } from "../../src/memory/embedding.js";
import { VectorMemoryService } from "../../src/memory/service.js";
import type { VectorMemoryDocument, VectorMemoryStore, VectorSearchResult } from "../../src/memory/vector-store.js";
import { saveMemory } from "../../src/tools/memory.js";
import type { Config } from "../../src/types.js";

class MemoryStore implements VectorMemoryStore {
  documents = new Map<string, VectorMemoryDocument>();
  async upsert(document: VectorMemoryDocument) { this.documents.set(document.id, document); }
  async list() { return [...this.documents.values()]; }
  async remove(id: string) { this.documents.delete(id); }
  async search(vector: number[], limit: number): Promise<VectorSearchResult[]> {
    return [...this.documents.values()].map((document) => {
      const similarity = document.vector.reduce((sum, value, index) => sum + value * vector[index], 0);
      return { ...document, distance: 1 - similarity };
    }).sort((a, b) => a.distance - b.distance).slice(0, limit);
  }
}

function config(workspacePath: string): Config {
  return {
    apiUrl: "http://localhost", apiKey: "", model: "test", maxTokens: 1000,
    maxContextTokens: 10000, contextCompressionThreshold: 0.7,
    contextCompressionMaxChars: 5000, contextCompressionToolResultMaxChars: 500,
    toolResultInitialMaxChars: 12000, historyWindowSize: 5, maxAgentIterations: 10,
    searchProvider: "duckduckgo", workspacePath, systemPrompt: "",
    memory: { retrieval: { maxResults: 3, candidateLimit: 10, minScore: 0.1 } },
  };
}

describe("vector memory", () => {
  let workspacePath = "";
  afterEach(() => { if (workspacePath) removeTempWorkspace(workspacePath); });

  it("indexes markdown memories and combines semantic and keyword scores", async () => {
    workspacePath = createTempWorkspace();
    saveMemory(workspacePath, "ui-preference", "用户偏好浅色主题，暗色主题会造成眼睛疲劳。", { summary: "界面主题偏好" });
    saveMemory(workspacePath, "language", "项目主要使用 TypeScript。", { summary: "编程语言" });
    const store = new MemoryStore();
    const service = new VectorMemoryService(workspacePath, config(workspacePath), {
      store,
      embedding: new LocalHashEmbeddingProvider(64),
    });

    const results = await service.search("用户喜欢什么界面主题");
    expect(results[0]?.memory.name).toBe("ui-preference");
    expect(store.documents.size).toBe(2);
  });

  it("falls back to keyword retrieval when embedding fails", async () => {
    workspacePath = createTempWorkspace();
    saveMemory(workspacePath, "typescript", "tiny-claw 使用 TypeScript。", { summary: "技术栈" });
    const failingEmbedding: EmbeddingProvider = {
      id: "broken", dimensions: 8,
      async embed() { throw new Error("offline"); },
    };
    const service = new VectorMemoryService(workspacePath, config(workspacePath), {
      store: new MemoryStore(), embedding: failingEmbedding,
    });
    expect((await service.search("TypeScript 技术栈"))[0]?.memory.name).toBe("typescript");
  });

  it("persists and searches the embedded LanceDB index", async () => {
    workspacePath = createTempWorkspace();
    saveMemory(workspacePath, "deployment", "项目使用 Gateway 模式部署。", { summary: "部署模式" });
    const service = new VectorMemoryService(workspacePath, config(workspacePath), {
      embedding: new LocalHashEmbeddingProvider(64),
    });
    expect((await service.search("Gateway 部署模式"))[0]?.memory.name).toBe("deployment");
  });
});
