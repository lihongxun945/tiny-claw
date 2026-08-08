import type { Config } from "../types.js";

export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude > 0 ? vector.map((value) => value / magnitude) : vector;
}

function tokens(text: string): string[] {
  const normalized = text.toLocaleLowerCase().normalize("NFKC");
  const words = normalized.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const cjk = [...normalized.replace(/[^\p{Script=Han}]/gu, "")];
  return [...words, ...cjk, ...cjk.slice(0, -1).map((char, index) => `${char}${cjk[index + 1]}`)];
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index++) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Offline fallback used when no embedding service is configured. It preserves
 * lexical similarity and keeps memory usable, but is not a semantic model.
 */
export class LocalHashEmbeddingProvider implements EmbeddingProvider {
  readonly id = "local-hash-v1";

  constructor(readonly dimensions = 384) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = Array.from<number>({ length: this.dimensions }).fill(0);
      for (const token of tokens(text)) {
        const hash = hashToken(token);
        const index = hash % this.dimensions;
        vector[index] += (hash & 1) === 0 ? 1 : -1;
      }
      return normalize(vector);
    });
  }
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;

  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    readonly dimensions: number,
  ) {
    this.id = `openai-compatible:${model}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const baseUrl = this.apiUrl.replace(/\/$/, "");
    const response = await fetch(`${baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!response.ok) throw new Error(`Embedding 请求失败 (${response.status}): ${await response.text()}`);
    const body = await response.json() as { data?: Array<{ index: number; embedding: number[] }> };
    const data = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
    if (data.length !== texts.length || data.some((item) => item.embedding.length !== this.dimensions)) {
      throw new Error("Embedding 响应数量或维度不匹配");
    }
    return data.map((item) => normalize(item.embedding));
  }
}

export function createEmbeddingProvider(config: Config): EmbeddingProvider {
  const embedding = config.memory?.embedding;
  if (embedding?.provider === "openai-compatible") {
    return new OpenAICompatibleEmbeddingProvider(
      embedding.apiUrl || config.apiUrl,
      embedding.apiKey ?? config.apiKey,
      embedding.model,
      embedding.dimensions,
    );
  }
  return new LocalHashEmbeddingProvider(embedding?.dimensions ?? 384);
}
