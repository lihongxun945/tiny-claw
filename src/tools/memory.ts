import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Config, Tool } from "../types.js";
import { checkDangerousToolPermission } from "./permission.js";

// === 文件操作 ===

const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;
const SUMMARY_LIMIT = 300;
const DEFAULT_MAX_ITEM_CHARS = 20000;
const DEFAULT_MAX_TOTAL_CHARS = 80000;

export type MemorySource = "manual" | "tool" | "auto";

export interface MemoryMeta {
  name: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
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
  disabled: boolean;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryLimits {
  maxItemChars: number;
  maxTotalChars: number;
}

export class MemoryCapacityError extends Error {
  constructor(
    readonly code: "memory_content_too_large" | "memory_total_too_large",
    readonly actualChars: number,
    readonly maxChars: number,
  ) {
    super(code === "memory_content_too_large"
      ? `记忆正文超过单条上限: ${actualChars}/${maxChars}`
      : `启用的长期记忆总量超过上限: ${actualChars}/${maxChars}`);
    this.name = "MemoryCapacityError";
  }
}

export function getMemoryLimits(config: Config): MemoryLimits {
  return {
    maxItemChars: config.memory?.maxItemChars ?? DEFAULT_MAX_ITEM_CHARS,
    maxTotalChars: config.memory?.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS,
  };
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
    disabled: entry.meta.disabled,
    source: entry.meta.source,
    createdAt: entry.meta.createdAt,
    updatedAt: entry.meta.updatedAt,
  };
}

export function listMemoryRecords(workspacePath: string, options: { includeDisabled?: boolean } = {}): MemoryRecord[] {
  return listMemoryEntries(workspacePath)
    .filter((entry) => options.includeDisabled || !entry.meta.disabled)
    .map(toMemoryRecord);
}

export function getMemoryRecord(workspacePath: string, name: string): MemoryRecord | null {
  const entry = readMemoryEntry(workspacePath, name);
  if (!entry) return null;
  return toMemoryRecord(entry);
}

export function updateMemoryRecord(
  workspacePath: string,
  name: string,
  updates: {
    content?: string;
    summary?: string;
    tags?: string[];
    disabled?: boolean;
    scope?: string;
    source?: MemorySource;
  },
  limits?: MemoryLimits,
): MemoryRecord {
  const existing = readMemoryEntry(workspacePath, name);
  if (!existing) {
    throw new Error(`记忆不存在: ${name}`);
  }

  const content = typeof updates.content === "string" ? updates.content : existing.content;
  validateMemoryCapacity(
    workspacePath,
    name,
    content,
    updates.disabled ?? existing.meta.disabled,
    limits,
  );
  existing.content = content;
  existing.meta.updatedAt = nowIso();
  if (Array.isArray(updates.tags)) existing.meta.tags = updates.tags.map(String).filter(Boolean);
  if (typeof updates.disabled === "boolean") existing.meta.disabled = updates.disabled;
  if (typeof updates.scope === "string") existing.meta.scope = updates.scope.trim() || "global";
  if (updates.source) existing.meta.source = updates.source;
  existing.meta.summary = buildSummary(content, updates.summary ?? existing.meta.summary);

  writeMemoryEntry(existing);
  return toMemoryRecord(existing);
}

export function setMemoryDisabled(
  workspacePath: string,
  name: string,
  disabled: boolean,
  limits?: MemoryLimits,
): MemoryRecord {
  return updateMemoryRecord(workspacePath, name, { disabled }, limits);
}

export function saveMemory(
  workspacePath: string,
  name: string,
  content: string,
  options: {
    tags?: string[];
    disabled?: boolean;
    scope?: string;
    summary?: string;
    source?: MemorySource;
    limits?: MemoryLimits;
  } = {},
): string {
  const filePath = memoryPath(workspacePath, name);
  const existing = readMemoryEntry(workspacePath, name);
  const timestamp = nowIso();
  const disabled = options.disabled ?? existing?.meta.disabled ?? false;
  validateMemoryCapacity(workspacePath, name, content, disabled, options.limits);
  const meta: MemoryMeta = {
    name,
    tags: options.tags ?? existing?.meta.tags ?? [],
    createdAt: existing?.meta.createdAt ?? timestamp,
    updatedAt: timestamp,
    disabled,
    scope: options.scope ?? existing?.meta.scope ?? "global",
    source: options.source ?? existing?.meta.source ?? "tool",
    summary: buildSummary(content, options.summary),
  };

  writeMemoryEntry({ name, meta, content, filePath });
  return `已保存记忆: ${name}`;
}

export function appendMemory(workspacePath: string, name: string, content: string, limits?: MemoryLimits): string {
  const existing = readMemoryEntry(workspacePath, name);
  if (!existing) {
    return saveMemory(workspacePath, name, content, { limits });
  }

  existing.content = `${existing.content.trim()}\n${content.trim()}`.trim();
  validateMemoryCapacity(workspacePath, name, existing.content, existing.meta.disabled, limits);
  existing.meta.updatedAt = nowIso();
  existing.meta.summary = buildSummary(existing.content, existing.meta.summary);
  writeMemoryEntry(existing);
  return `已追加记忆: ${name}`;
}

export function readMemory(workspacePath: string, name: string): string {
  const entry = readMemoryEntry(workspacePath, name);
  if (!entry) return JSON.stringify({ error: `记忆不存在: ${name}` });
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

export function listMemories(workspacePath: string): string {
  const entries = listMemoryEntries(workspacePath)
    .filter((entry) => !entry.meta.disabled);

  if (entries.length === 0) return "暂无记忆";

  return JSON.stringify({
    memories: entries.map((entry) => ({
      name: entry.name,
      tags: entry.meta.tags,
      scope: entry.meta.scope,
      updatedAt: entry.meta.updatedAt,
      disabled: entry.meta.disabled,
      source: entry.meta.source,
      summary: buildSummary(entry.content, entry.meta.summary),
    })),
  });
}

export function loadAllMemories(workspacePath: string): string {
  const entries = listMemoryEntries(workspacePath).filter((entry) => !entry.meta.disabled);
  if (entries.length === 0) return "";

  const parts = entries.map((entry) => {
    const tags = entry.meta.tags.length > 0 ? ` tags=${entry.meta.tags.join(",")}` : "";
    return [
      `## ${entry.name}`,
      `meta:${tags} scope=${entry.meta.scope} updated=${entry.meta.updatedAt}`,
      entry.content.trim(),
    ].join("\n");
  });

  return [
    "以下是已启用的长期记忆全文。",
    ...parts,
  ].join("\n");
}

function validateMemoryCapacity(
  workspacePath: string,
  name: string,
  content: string,
  disabled: boolean,
  limits?: MemoryLimits,
): void {
  if (!limits) return;
  const normalizedContent = content.trim();
  if (normalizedContent.length > limits.maxItemChars) {
    throw new MemoryCapacityError("memory_content_too_large", normalizedContent.length, limits.maxItemChars);
  }
  if (disabled) return;

  const totalChars = listMemoryEntries(workspacePath)
    .filter((entry) => !entry.meta.disabled && entry.name !== name)
    .reduce((total, entry) => total + entry.content.trim().length, normalizedContent.length);
  if (totalChars > limits.maxTotalChars) {
    throw new MemoryCapacityError("memory_total_too_large", totalChars, limits.maxTotalChars);
  }
}

function memoryErrorResult(error: MemoryCapacityError): string {
  return JSON.stringify({
    error: error.code,
    message: error.message,
    actualChars: error.actualChars,
    maxChars: error.maxChars,
    retryable: true,
  });
}

// === 工具定义 ===

export function createMemorySaveTool(workspacePath: string, getConfig: () => Config): Tool {
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
    execute: async (args: Record<string, unknown>, context): Promise<string> => {
      const permission = checkDangerousToolPermission({
        workspacePath,
        config: getConfig(),
        toolName: "memory_save",
        args,
        context,
        command: `memory_save ${String(args.name ?? "")}`,
        cwd: memoryDir(workspacePath),
      });
      if (!permission.allowed) return permission.result;

      const name = String(args.name ?? "");
      const content = String(args.content ?? "");
      try {
        return saveMemory(workspacePath, name, content, {
          tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
          scope: typeof args.scope === "string" ? args.scope : undefined,
          summary: typeof args.summary === "string" ? args.summary : undefined,
          source: args.source === "auto" ? "auto" : undefined,
          limits: getMemoryLimits(getConfig()),
        });
      } catch (error) {
        if (error instanceof MemoryCapacityError) return memoryErrorResult(error);
        throw error;
      }
    },
  };
}

export function createMemoryAppendTool(workspacePath: string, getConfig: () => Config): Tool {
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
    execute: async (args: Record<string, unknown>, context): Promise<string> => {
      const permission = checkDangerousToolPermission({
        workspacePath,
        config: getConfig(),
        toolName: "memory_append",
        args,
        context,
        command: `memory_append ${String(args.name ?? "")}`,
        cwd: memoryDir(workspacePath),
      });
      if (!permission.allowed) return permission.result;

      const name = String(args.name ?? "");
      const content = String(args.content ?? "");
      try {
        return appendMemory(workspacePath, name, content, getMemoryLimits(getConfig()));
      } catch (error) {
        if (error instanceof MemoryCapacityError) return memoryErrorResult(error);
        throw error;
      }
    },
  };
}

export function createMemoryListTool(workspacePath: string): Tool {
  return {
    name: "memory_list",
    description: "列出长期记忆摘要索引。当用户询问你记住了什么、或者你想回顾已有记忆时使用",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    execute: async (): Promise<string> => {
      return listMemories(workspacePath);
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
      },
      required: ["name"],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      return readMemory(workspacePath, String(args.name ?? ""));
    },
  };
}

export function createMemoryDeleteTool(workspacePath: string, getConfig: () => Config): Tool {
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
    execute: async (args: Record<string, unknown>, context): Promise<string> => {
      const permission = checkDangerousToolPermission({
        workspacePath,
        config: getConfig(),
        toolName: "memory_delete",
        args,
        context,
        command: `memory_delete ${String(args.name ?? "")}`,
        cwd: memoryDir(workspacePath),
      });
      if (!permission.allowed) return permission.result;

      return deleteMemory(workspacePath, String(args.name ?? ""));
    },
  };
}
