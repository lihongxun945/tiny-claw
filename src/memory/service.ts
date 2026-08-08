import type { Config } from "../types.js";
import { listMemoryRecords, type MemoryRecord } from "../tools/memory.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embedding.js";
import {
  LanceVectorMemoryStore,
  type VectorMemoryDocument,
  type VectorMemoryStore,
} from "./vector-store.js";

export interface MemorySearchResult {
  memory: MemoryRecord;
  score: number;
  semanticScore: number;
  keywordScore: number;
}

function terms(text: string): Set<string> {
  const normalized = text.toLocaleLowerCase().normalize("NFKC");
  const words = normalized.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const cjk = [...normalized.replace(/[^\p{Script=Han}]/gu, "")];
  return new Set([...words, ...cjk, ...cjk.slice(0, -1).map((char, index) => `${char}${cjk[index + 1]}`)]);
}

function keywordScore(query: string, record: MemoryRecord): number {
  const queryTerms = terms(query);
  if (queryTerms.size === 0) return 0;
  const memoryTerms = terms(`${record.name} ${record.summary} ${record.tags.join(" ")} ${record.content}`);
  let matches = 0;
  for (const term of queryTerms) if (memoryTerms.has(term)) matches += 1;
  return matches / queryTerms.size;
}

function toDocument(record: MemoryRecord, vector: number[], embeddingModel: string): VectorMemoryDocument {
  return {
    id: record.name,
    name: record.name,
    content: record.content,
    summary: record.summary,
    tags: record.tags,
    scope: record.scope,
    status: record.disabled ? "stale" : "active",
    source: record.source,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    validFrom: record.createdAt,
    validTo: "",
    supersedes: [],
    supersededBy: "",
    importance: 0.5,
    strength: 1,
    readCount: 0,
    lastReadAt: "",
    embeddingModel,
    vector,
  };
}

export class VectorMemoryService {
  private readonly store: VectorMemoryStore;
  private readonly embedding: EmbeddingProvider;

  constructor(
    private readonly workspacePath: string,
    private readonly config: Config,
    options: { store?: VectorMemoryStore; embedding?: EmbeddingProvider } = {},
  ) {
    this.store = options.store ?? new LanceVectorMemoryStore(workspacePath);
    this.embedding = options.embedding ?? createEmbeddingProvider(config);
  }

  async synchronize(): Promise<void> {
    const records = listMemoryRecords(this.workspacePath, { includeDisabled: true });
    const indexed = new Map((await this.store.list()).map((memory) => [memory.id, memory]));
    const activeIds = new Set(records.map((record) => record.name));
    for (const stale of indexed.values()) {
      if (!activeIds.has(stale.id)) await this.store.remove(stale.id);
    }
    const changed = records.filter((record) => {
      const current = indexed.get(record.name);
      return !current || current.updatedAt !== record.updatedAt || current.embeddingModel !== this.embedding.id;
    });
    if (changed.length === 0) return;
    const vectors = await this.embedding.embed(changed.map((record) => `${record.summary}\n${record.content}`));
    for (let index = 0; index < changed.length; index++) {
      await this.store.upsert(toDocument(changed[index], vectors[index], this.embedding.id));
    }
  }

  async search(query: string, scope = "global"): Promise<MemorySearchResult[]> {
    const retrieval = this.config.memory?.retrieval;
    const maxResults = retrieval?.maxResults ?? 5;
    const candidateLimit = Math.max(maxResults, retrieval?.candidateLimit ?? 20);
    const minScore = retrieval?.minScore ?? 0.35;
    const records = listMemoryRecords(this.workspacePath)
      .filter((record) => record.scope === "global" || record.scope === scope);
    if (records.length === 0) return [];

    let semantic = new Map<string, number>();
    try {
      await this.synchronize();
      const [vector] = await this.embedding.embed([query]);
      const results = await this.store.search(vector, candidateLimit);
      semantic = new Map(results.map((result) => [result.id, Math.max(0, 1 - result.distance)]));
    } catch {
      // Keyword retrieval keeps chat functional when embeddings or the index fail.
    }

    return records
      .map((memory) => {
        const semanticScore = semantic.get(memory.name) ?? 0;
        const lexical = keywordScore(query, memory);
        const score = semanticScore * 0.7 + lexical * 0.3;
        return { memory, score, semanticScore, keywordScore: lexical };
      })
      .filter((result) => result.score >= minScore)
      .sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt))
      .slice(0, maxResults);
  }
}

export function formatRetrievedMemories(results: MemorySearchResult[], maxChars: number): string {
  if (results.length === 0) return "";
  const lines = ["[与当前问题相关的长期记忆]", "以下内容来自持久化记忆，仅在相关时使用；如与用户当前陈述冲突，以当前陈述为准。"];
  for (const result of results) {
    const section = `\n## ${result.memory.name}\n${result.memory.content.trim()}\n来源：${result.memory.source}，更新时间：${result.memory.updatedAt}`;
    if (`${lines.join("\n")}\n${section}`.length > maxChars) break;
    lines.push(section);
  }
  return lines.length > 2 ? lines.join("\n") : "";
}
