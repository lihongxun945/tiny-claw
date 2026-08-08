import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import * as lancedb from "@lancedb/lancedb";

export interface VectorMemoryDocument {
  id: string;
  name: string;
  content: string;
  summary: string;
  tags: string[];
  scope: string;
  status: "active" | "stale" | "superseded" | "trash";
  source: string;
  createdAt: string;
  updatedAt: string;
  validFrom: string;
  validTo: string;
  supersedes: string[];
  supersededBy: string;
  importance: number;
  strength: number;
  readCount: number;
  lastReadAt: string;
  embeddingModel: string;
  vector: number[];
}

export interface VectorSearchResult extends VectorMemoryDocument {
  distance: number;
}

export interface VectorMemoryStore {
  upsert(document: VectorMemoryDocument): Promise<void>;
  search(vector: number[], limit: number, scopes?: string[]): Promise<VectorSearchResult[]>;
  list(limit?: number): Promise<VectorMemoryDocument[]>;
  remove(id: string): Promise<void>;
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

function fromRow(row: Record<string, unknown>): VectorMemoryDocument {
  const parseArray = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.map(String);
    try { return JSON.parse(String(value || "[]")) as string[]; } catch { return []; }
  };
  return {
    id: String(row.id),
    name: String(row.name),
    content: String(row.content),
    summary: String(row.summary),
    tags: parseArray(row.tags),
    scope: String(row.scope),
    status: String(row.status) as VectorMemoryDocument["status"],
    source: String(row.source),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    validFrom: String(row.validFrom),
    validTo: String(row.validTo),
    supersedes: parseArray(row.supersedes),
    supersededBy: String(row.supersededBy),
    importance: Number(row.importance),
    strength: Number(row.strength),
    readCount: Number(row.readCount),
    lastReadAt: String(row.lastReadAt),
    embeddingModel: String(row.embeddingModel),
    vector: Array.from(row.vector as Iterable<number>, Number),
  };
}

function toRow(document: VectorMemoryDocument): Record<string, unknown> {
  return {
    ...document,
    tags: JSON.stringify(document.tags),
    supersedes: JSON.stringify(document.supersedes),
  };
}

export class LanceVectorMemoryStore implements VectorMemoryStore {
  private readonly dbPath: string;
  private connection?: lancedb.Connection;

  constructor(workspacePath: string, private readonly tableName = "memories") {
    this.dbPath = resolve(workspacePath, "memory", "vector");
    mkdirSync(this.dbPath, { recursive: true });
  }

  private async db(): Promise<lancedb.Connection> {
    this.connection ??= await lancedb.connect(this.dbPath);
    return this.connection;
  }

  private async table(): Promise<lancedb.Table | null> {
    const db = await this.db();
    return (await db.tableNames()).includes(this.tableName) ? db.openTable(this.tableName) : null;
  }

  async upsert(document: VectorMemoryDocument): Promise<void> {
    const db = await this.db();
    const table = await this.table();
    if (!table) {
      await db.createTable(this.tableName, [toRow(document)]);
      return;
    }
    await table.delete(`id = '${escapeSql(document.id)}'`);
    await table.add([toRow(document)]);
  }

  async search(vector: number[], limit: number, scopes?: string[]): Promise<VectorSearchResult[]> {
    const table = await this.table();
    if (!table) return [];
    const scopeFilter = scopes && scopes.length > 0
      ? ` AND (${scopes.map((scope) => `scope = '${escapeSql(scope)}'`).join(" OR ")})`
      : "";
    const query = table.vectorSearch(vector).where(`status = 'active'${scopeFilter}`);
    const rows = await query.limit(limit).toArray();
    return rows.map((row) => ({
      ...fromRow(row as unknown as Record<string, unknown>),
      distance: Number((row as unknown as Record<string, unknown>)._distance ?? 1),
    }));
  }

  async list(limit = 10_000): Promise<VectorMemoryDocument[]> {
    const table = await this.table();
    if (!table) return [];
    const rows = await table.query().limit(limit).toArray();
    return rows.map((row) => fromRow(row as unknown as Record<string, unknown>));
  }

  async remove(id: string): Promise<void> {
    const table = await this.table();
    if (table) await table.delete(`id = '${escapeSql(id)}'`);
  }
}
