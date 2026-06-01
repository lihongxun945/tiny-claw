import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Tool } from "../types.js";

// === 文件操作 ===

const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;
const SUMMARY_LIMIT = 300;

export type MemorySource = "manual" | "tool" | "auto";

export interface MemoryMeta {
  name: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  sensitive: boolean;
  disabled: boolean;
  scope: string;
  source: MemorySource;
  summary?: string;
}

export interface MemoryEntry {
  name: string;
  meta: MemoryMeta;
  content: string;
  filePath: string;
}

export interface MemoryRecord {
  name: string;
  summary: string;
  content: string;
  tags: string[];
  scope: string;
  sensitive: boolean;
  disabled: boolean;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
}

function sanitizeName(name: string): string {
  if (!SAFE_NAME.test(name)) {
    throw new Error(`记忆名称只能包含字母、数字、下划线和连字符: ${name}`);
  }
  return name + ".md";
}

function memoryDir(workspacePath: string): string {
  return resolve(workspacePath, "memory");
}

function ensureMemoryDir(workspacePath: string): string {
  const dir = memoryDir(workspacePath);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function memoryPath(workspacePath: string, name: string): string {
  return resolve(ensureMemoryDir(workspacePath), sanitizeName(name));
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseListValue(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseBoolValue(value: string): boolean {
  return value.trim().toLowerCase() === "true";
}

function parseSourceValue(value: string): MemorySource {
  const source = value.trim().toLowerCase();
  if (source === "manual" || source === "tool" || source === "auto") return source;
  return "tool";
}

function parseFrontmatter(raw: string, name: string): { meta: MemoryMeta; content: string } {
  const fallbackTime = nowIso();
  const meta: MemoryMeta = {
    name,
    tags: [],
    createdAt: fallbackTime,
    updatedAt: fallbackTime,
    sensitive: false,
    disabled: false,
    scope: "global",
    source: "tool",
  };

  if (!raw.startsWith("---\n")) {
    return { meta, content: raw.trim() };
  }

  const endIdx = raw.indexOf("\n---", 4);
  if (endIdx === -1) {
    return { meta, content: raw.trim() };
  }

  const fm = raw.slice(4, endIdx).trim();
  const content = raw.slice(endIdx + 4).trim();
  for (const line of fm.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    switch (key) {
      case "name":
        meta.name = value || name;
        break;
      case "tags":
        meta.tags = parseListValue(value);
        break;
      case "createdAt":
        meta.createdAt = value || fallbackTime;
        break;
      case "updatedAt":
        meta.updatedAt = value || fallbackTime;
        break;
      case "sensitive":
        meta.sensitive = parseBoolValue(value);
        break;
      case "disabled":
        meta.disabled = parseBoolValue(value);
        break;
      case "scope":
        meta.scope = value || "global";
        break;
      case "source":
        meta.source = parseSourceValue(value);
        break;
      case "summary":
        meta.summary = value;
        break;
    }
  }

  return { meta, content };
}

function formatFrontmatter(meta: MemoryMeta): string {
  const lines = [
    "---",
    `name: ${meta.name}`,
    `tags: [${meta.tags.join(", ")}]`,
    `createdAt: ${meta.createdAt}`,
    `updatedAt: ${meta.updatedAt}`,
    `sensitive: ${meta.sensitive}`,
    `disabled: ${meta.disabled}`,
    `scope: ${meta.scope}`,
    `source: ${meta.source}`,
  ];
  if (meta.summary?.trim()) {
    lines.push(`summary: ${meta.summary.trim().replace(/\n/g, " ")}`);
  }
  lines.push("---");
  return lines.join("\n");
}

function buildSummary(content: string, explicit?: string): string {
  const summary = explicit?.trim() || content.trim().replace(/\s+/g, " ");
  return summary.length > SUMMARY_LIMIT ? `${summary.slice(0, SUMMARY_LIMIT)}...` : summary;
}

function readMemoryEntry(workspacePath: string, name: string): MemoryEntry | null {
  const filePath = memoryPath(workspacePath, name);
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  const parsed = parseFrontmatter(raw, name);
  return {
    name,
    meta: { ...parsed.meta, name },
    content: parsed.content,
    filePath,
  };
}

function writeMemoryEntry(entry: MemoryEntry): void {
  writeFileSync(
    entry.filePath,
    `${formatFrontmatter(entry.meta)}\n\n${entry.content.trim()}\n`,
    "utf-8",
  );
}

function listMemoryEntries(workspacePath: string): MemoryEntry[] {
  const dir = memoryDir(workspacePath);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }

  return files.map((file) => {
    const name = file.replace(/\.md$/, "");
    const raw = readFileSync(resolve(dir, file), "utf-8");
    const parsed = parseFrontmatter(raw, name);
    return {
      name,
      meta: { ...parsed.meta, name },
      content: parsed.content,
      filePath: resolve(dir, file),
    };
  });
}

function toMemoryRecord(entry: MemoryEntry): MemoryRecord {
  return {
    name: entry.name,
    summary: buildSummary(entry.content, entry.meta.summary),
    content: entry.content,
    tags: entry.meta.tags,
    scope: entry.meta.scope,
    sensitive: entry.meta.sensitive,
    disabled: entry.meta.disabled,
    source: entry.meta.source,
    createdAt: entry.meta.createdAt,
    updatedAt: entry.meta.updatedAt,
  };
}

export function listMemoryRecords(workspacePath: string, options: { includeSensitive?: boolean; includeDisabled?: boolean } = {}): MemoryRecord[] {
  return listMemoryEntries(workspacePath)
    .filter((entry) => options.includeSensitive || !entry.meta.sensitive)
    .filter((entry) => options.includeDisabled || !entry.meta.disabled)
    .map(toMemoryRecord);
}

export function getMemoryRecord(workspacePath: string, name: string, includeSensitive = true): MemoryRecord | null {
  const entry = readMemoryEntry(workspacePath, name);
  if (!entry) return null;
  if (entry.meta.sensitive && !includeSensitive) return null;
  return toMemoryRecord(entry);
}

export function updateMemoryRecord(
  workspacePath: string,
  name: string,
  updates: {
    content?: string;
    summary?: string;
    tags?: string[];
    sensitive?: boolean;
    disabled?: boolean;
    scope?: string;
    source?: MemorySource;
  },
): MemoryRecord {
  const existing = readMemoryEntry(workspacePath, name);
  if (!existing) {
    throw new Error(`记忆不存在: ${name}`);
  }

  const content = typeof updates.content === "string" ? updates.content : existing.content;
  existing.content = content;
  existing.meta.updatedAt = nowIso();
  if (Array.isArray(updates.tags)) existing.meta.tags = updates.tags.map(String).filter(Boolean);
  if (typeof updates.sensitive === "boolean") existing.meta.sensitive = updates.sensitive;
  if (typeof updates.disabled === "boolean") existing.meta.disabled = updates.disabled;
  if (typeof updates.scope === "string") existing.meta.scope = updates.scope.trim() || "global";
  if (updates.source) existing.meta.source = updates.source;
  existing.meta.summary = buildSummary(content, updates.summary ?? existing.meta.summary);

  writeMemoryEntry(existing);
  return toMemoryRecord(existing);
}

export function setMemoryDisabled(workspacePath: string, name: string, disabled: boolean): MemoryRecord {
  return updateMemoryRecord(workspacePath, name, { disabled });
}

export function saveMemory(
  workspacePath: string,
  name: string,
  content: string,
  options: { tags?: string[]; sensitive?: boolean; disabled?: boolean; scope?: string; summary?: string; source?: MemorySource } = {},
): string {
  const filePath = memoryPath(workspacePath, name);
  const existing = readMemoryEntry(workspacePath, name);
  const timestamp = nowIso();
  const meta: MemoryMeta = {
    name,
    tags: options.tags ?? existing?.meta.tags ?? [],
    createdAt: existing?.meta.createdAt ?? timestamp,
    updatedAt: timestamp,
    sensitive: options.sensitive ?? existing?.meta.sensitive ?? false,
    disabled: options.disabled ?? existing?.meta.disabled ?? false,
    scope: options.scope ?? existing?.meta.scope ?? "global",
    source: options.source ?? existing?.meta.source ?? "tool",
    summary: buildSummary(content, options.summary),
  };

  writeMemoryEntry({ name, meta, content, filePath });
  return `已保存记忆: ${name}`;
}

export function appendMemory(workspacePath: string, name: string, content: string): string {
  const existing = readMemoryEntry(workspacePath, name);
  if (!existing) {
    return saveMemory(workspacePath, name, content);
  }

  existing.content = `${existing.content.trim()}\n${content.trim()}`.trim();
  existing.meta.updatedAt = nowIso();
  existing.meta.summary = buildSummary(existing.content, existing.meta.summary);
  writeMemoryEntry(existing);
  return `已追加记忆: ${name}`;
}

export function readMemory(workspacePath: string, name: string, includeSensitive = false): string {
  const entry = readMemoryEntry(workspacePath, name);
  if (!entry) return JSON.stringify({ error: `记忆不存在: ${name}` });
  if (entry.meta.sensitive && !includeSensitive) {
    return JSON.stringify({ error: `记忆 ${name} 标记为敏感，请显式设置 include_sensitive=true 后读取` });
  }
  return JSON.stringify({
    name: entry.name,
    meta: entry.meta,
    content: entry.content,
  });
}

export function deleteMemory(workspacePath: string, name: string): string {
  const filePath = memoryPath(workspacePath, name);
  if (!existsSync(filePath)) return `记忆不存在: ${name}`;
  unlinkSync(filePath);
  return `已删除记忆: ${name}`;
}

export function listMemories(workspacePath: string, includeSensitive = false): string {
  const entries = listMemoryEntries(workspacePath)
    .filter((entry) => !entry.meta.disabled)
    .filter((entry) => includeSensitive || !entry.meta.sensitive);

  if (entries.length === 0) return "暂无记忆";

  return JSON.stringify({
    memories: entries.map((entry) => ({
      name: entry.name,
      tags: entry.meta.tags,
      scope: entry.meta.scope,
      updatedAt: entry.meta.updatedAt,
      sensitive: entry.meta.sensitive,
      disabled: entry.meta.disabled,
      source: entry.meta.source,
      summary: buildSummary(entry.content, entry.meta.summary),
    })),
  });
}

function scoreMemory(entry: MemoryEntry, query: string): number {
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery) return 0;
  const haystack = [
    entry.name,
    entry.meta.tags.join(" "),
    entry.meta.scope,
    entry.meta.summary ?? "",
    entry.content,
  ].join("\n").toLowerCase();
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  let score = haystack.includes(normalizedQuery) ? 5 : 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

export function searchMemories(workspacePath: string, query: string, limit = 5, includeSensitive = false): string {
  const entries = listMemoryEntries(workspacePath)
    .filter((entry) => !entry.meta.disabled)
    .filter((entry) => includeSensitive || !entry.meta.sensitive)
    .map((entry) => ({ entry, score: scoreMemory(entry, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(limit, 20)));

  if (entries.length === 0) {
    return JSON.stringify({ results: [] });
  }

  return JSON.stringify({
    results: entries.map(({ entry, score }) => ({
      name: entry.name,
      score,
      tags: entry.meta.tags,
      scope: entry.meta.scope,
      updatedAt: entry.meta.updatedAt,
      sensitive: entry.meta.sensitive,
      disabled: entry.meta.disabled,
      source: entry.meta.source,
      summary: buildSummary(entry.content, entry.meta.summary),
    })),
  });
}

export function loadAllMemories(workspacePath: string): string {
  const entries = listMemoryEntries(workspacePath).filter((entry) => !entry.meta.sensitive && !entry.meta.disabled);
  if (entries.length === 0) return "";

  const parts = entries.map((entry) => {
    const tags = entry.meta.tags.length > 0 ? ` tags=${entry.meta.tags.join(",")}` : "";
    return `- ${entry.name}${tags} scope=${entry.meta.scope} updated=${entry.meta.updatedAt}: ${buildSummary(entry.content, entry.meta.summary)}`;
  });

  return [
    "以下是非敏感长期记忆的摘要索引。需要完整内容时，请使用 memory_read 或 memory_search 工具。",
    ...parts,
  ].join("\n");
}

// === 工具定义 ===

export function createMemorySaveTool(workspacePath: string): Tool {
  return {
    name: "memory_save",
    description: "保存或覆盖一条长期记忆。当用户明确告诉你需要记住的信息时（偏好、约定、事实等），用此工具记录下来。name 是文件名（不含 .md），content 是记忆内容",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "记忆名称，只能包含字母、数字、下划线、连字符",
        },
        content: {
          type: "string",
          description: "记忆内容，markdown 格式",
        },
        tags: {
          type: "array",
          description: "可选标签，用于后续检索",
          items: { type: "string" },
        },
        sensitive: {
          type: "boolean",
          description: "是否为敏感记忆；敏感记忆不会自动注入 system prompt，默认 false",
        },
        scope: {
          type: "string",
          description: "作用域，如 global、project、user，默认 global",
        },
        summary: {
          type: "string",
          description: "可选短摘要；不提供时自动从内容截取",
        },
      },
      required: ["name", "content"],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      const name = String(args.name ?? "");
      const content = String(args.content ?? "");
      return saveMemory(workspacePath, name, content, {
        tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
        sensitive: typeof args.sensitive === "boolean" ? args.sensitive : undefined,
        scope: typeof args.scope === "string" ? args.scope : undefined,
        summary: typeof args.summary === "string" ? args.summary : undefined,
      });
    },
  };
}

export function createMemoryAppendTool(workspacePath: string): Tool {
  return {
    name: "memory_append",
    description: "追加内容到已有的长期记忆文件。当有新的信息需要补充到已保存的记忆中时使用，如果文件不存在会创建",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "记忆名称，只能包含字母、数字、下划线、连字符",
        },
        content: {
          type: "string",
          description: "要追加的内容，markdown 格式",
        },
      },
      required: ["name", "content"],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      const name = String(args.name ?? "");
      const content = String(args.content ?? "");
      return appendMemory(workspacePath, name, content);
    },
  };
}

export function createMemoryListTool(workspacePath: string): Tool {
  return {
    name: "memory_list",
    description: "列出长期记忆摘要索引。当用户询问你记住了什么、或者你想回顾已有记忆时使用。默认不包含敏感记忆",
    inputSchema: {
      type: "object" as const,
      properties: {
        include_sensitive: {
          type: "boolean",
          description: "是否包含敏感记忆索引，默认 false",
        },
      },
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      return listMemories(workspacePath, args.include_sensitive === true);
    },
  };
}

export function createMemoryReadTool(workspacePath: string): Tool {
  return {
    name: "memory_read",
    description: "读取指定长期记忆的完整内容。已知记忆名称且需要详细内容时使用",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "记忆名称，不含 .md",
        },
        include_sensitive: {
          type: "boolean",
          description: "是否允许读取敏感记忆，默认 false",
        },
      },
      required: ["name"],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      return readMemory(workspacePath, String(args.name ?? ""), args.include_sensitive === true);
    },
  };
}

export function createMemorySearchTool(workspacePath: string): Tool {
  return {
    name: "memory_search",
    description: "按关键词搜索长期记忆摘要。需要从记忆中查找相关信息但不知道具体记忆名称时使用。默认不搜索敏感记忆",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "搜索关键词",
        },
        limit: {
          type: "number",
          description: "返回数量，默认 5，最大 20",
          minimum: 1,
          maximum: 20,
        },
        include_sensitive: {
          type: "boolean",
          description: "是否搜索敏感记忆，默认 false",
        },
      },
      required: ["query"],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      return searchMemories(
        workspacePath,
        String(args.query ?? ""),
        Number(args.limit ?? 5),
        args.include_sensitive === true,
      );
    },
  };
}

export function createMemoryDeleteTool(workspacePath: string): Tool {
  return {
    name: "memory_delete",
    description: "删除指定长期记忆。仅当用户明确要求删除某条记忆时使用",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "记忆名称，不含 .md",
        },
      },
      required: ["name"],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      return deleteMemory(workspacePath, String(args.name ?? ""));
    },
  };
}
