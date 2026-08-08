import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import type { Config, Tool } from "../types.js";
import { checkDangerousToolPermission } from "./permission.js";
import { loadMemoryState } from "../memory/state.js";

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
  status: "active" | "stale" | "superseded" | "trash";
  validFrom: string;
  validTo?: string;
  supersedes: string[];
  supersededBy?: string;
  importance: number;
  strength: number;
  readCount: number;
  lastReadAt?: string;
  forgottenAt?: string;
  forgetReason?: string;
  retention: "permanent" | "normal" | "temporary";
  createdTurn: number;
  updatedTurn: number;
  lastReadTurn: number;
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
  status: MemoryMeta["status"];
  validFrom: string;
  validTo?: string;
  supersedes: string[];
  supersededBy?: string;
  importance: number;
  strength: number;
  readCount: number;
  lastReadAt?: string;
  retention: MemoryMeta["retention"];
  createdTurn: number;
  updatedTurn: number;
  lastReadTurn: number;
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
    status: "active",
    validFrom: fallbackTime,
    supersedes: [],
    importance: 0.5,
    strength: 1,
    readCount: 0,
    retention: "normal",
    createdTurn: 0,
    updatedTurn: 0,
    lastReadTurn: 0,
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
      case "status":
        if (["active", "stale", "superseded", "trash"].includes(value)) meta.status = value as MemoryMeta["status"];
        break;
      case "validFrom": meta.validFrom = value || fallbackTime; break;
      case "validTo": meta.validTo = value || undefined; break;
      case "supersedes": meta.supersedes = parseListValue(value); break;
      case "supersededBy": meta.supersededBy = value || undefined; break;
      case "importance": meta.importance = Number(value) || 0.5; break;
      case "strength": meta.strength = Number(value) || 1; break;
      case "readCount": meta.readCount = Number(value) || 0; break;
      case "lastReadAt": meta.lastReadAt = value || undefined; break;
      case "forgottenAt": meta.forgottenAt = value || undefined; break;
      case "forgetReason": meta.forgetReason = value || undefined; break;
      case "retention":
        if (["permanent", "normal", "temporary"].includes(value)) meta.retention = value as MemoryMeta["retention"];
        break;
      case "createdTurn": meta.createdTurn = Number(value) || 0; break;
      case "updatedTurn": meta.updatedTurn = Number(value) || 0; break;
      case "lastReadTurn": meta.lastReadTurn = Number(value) || 0; break;
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
    `status: ${meta.status}`,
    `validFrom: ${meta.validFrom}`,
    `supersedes: [${meta.supersedes.join(", ")}]`,
    `importance: ${meta.importance}`,
    `strength: ${meta.strength}`,
    `readCount: ${meta.readCount}`,
    `retention: ${meta.retention}`,
    `createdTurn: ${meta.createdTurn}`,
    `updatedTurn: ${meta.updatedTurn}`,
    `lastReadTurn: ${meta.lastReadTurn}`,
  ];
  if (meta.validTo) lines.push(`validTo: ${meta.validTo}`);
  if (meta.supersededBy) lines.push(`supersededBy: ${meta.supersededBy}`);
  if (meta.lastReadAt) lines.push(`lastReadAt: ${meta.lastReadAt}`);
  if (meta.forgottenAt) lines.push(`forgottenAt: ${meta.forgottenAt}`);
  if (meta.forgetReason) lines.push(`forgetReason: ${meta.forgetReason}`);
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
    status: entry.meta.status,
    validFrom: entry.meta.validFrom,
    validTo: entry.meta.validTo,
    supersedes: entry.meta.supersedes,
    supersededBy: entry.meta.supersededBy,
    importance: entry.meta.importance,
    strength: entry.meta.strength,
    readCount: entry.meta.readCount,
    lastReadAt: entry.meta.lastReadAt,
    retention: entry.meta.retention,
    createdTurn: entry.meta.createdTurn,
    updatedTurn: entry.meta.updatedTurn,
    lastReadTurn: entry.meta.lastReadTurn,
  };
}

export function listMemoryRecords(workspacePath: string, options: { includeDisabled?: boolean } = {}): MemoryRecord[] {
  return listMemoryEntries(workspacePath)
    .filter((entry) => options.includeDisabled || (!entry.meta.disabled && entry.meta.status === "active"))
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
    status?: MemoryMeta["status"];
    supersedes?: string[];
    supersededBy?: string;
    importance?: number;
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
  existing.meta.updatedTurn = loadMemoryState(workspacePath).completedTurns;
  if (Array.isArray(updates.tags)) existing.meta.tags = updates.tags.map(String).filter(Boolean);
  if (typeof updates.disabled === "boolean") existing.meta.disabled = updates.disabled;
  if (typeof updates.scope === "string") existing.meta.scope = updates.scope.trim() || "global";
  if (updates.source) existing.meta.source = updates.source;
  if (updates.status) existing.meta.status = updates.status;
  if (Array.isArray(updates.supersedes)) existing.meta.supersedes = updates.supersedes;
  if (typeof updates.supersededBy === "string") existing.meta.supersededBy = updates.supersededBy || undefined;
  if (typeof updates.importance === "number") existing.meta.importance = Math.max(0, Math.min(1, updates.importance));
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
    supersedes?: string[];
    importance?: number;
    retention?: MemoryMeta["retention"];
    limits?: MemoryLimits;
  } = {},
): string {
  const filePath = memoryPath(workspacePath, name);
  const existing = readMemoryEntry(workspacePath, name);
  const timestamp = nowIso();
  const currentTurn = loadMemoryState(workspacePath).completedTurns;
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
    status: "active",
    validFrom: existing?.meta.validFrom ?? timestamp,
    supersedes: options.supersedes ?? existing?.meta.supersedes ?? [],
    supersededBy: existing?.meta.supersededBy,
    importance: Math.max(0, Math.min(1, options.importance ?? existing?.meta.importance ?? 0.5)),
    strength: existing?.meta.strength ?? 1,
    readCount: existing?.meta.readCount ?? 0,
    lastReadAt: existing?.meta.lastReadAt,
    retention: options.retention ?? existing?.meta.retention ?? "normal",
    createdTurn: existing?.meta.createdTurn ?? currentTurn,
    updatedTurn: currentTurn,
    lastReadTurn: existing?.meta.lastReadTurn ?? 0,
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
  entry.meta.readCount += 1;
  entry.meta.lastReadAt = nowIso();
  entry.meta.lastReadTurn = loadMemoryState(workspacePath).completedTurns;
  entry.meta.strength = Math.min(2, entry.meta.strength + 0.05);
  writeMemoryEntry(entry);
  return JSON.stringify({
    name: entry.name,
    meta: entry.meta,
    content: entry.content,
  });
}

export function deleteMemory(workspacePath: string, name: string): string {
  const filePath = memoryPath(workspacePath, name);
  if (!existsSync(filePath)) return `记忆不存在: ${name}`;
  const entry = readMemoryEntry(workspacePath, name)!;
  entry.meta.status = "trash";
  entry.meta.forgottenAt = nowIso();
  entry.meta.forgetReason = "user_requested";
  writeMemoryEntry(entry);
  const trashDir = resolve(ensureMemoryDir(workspacePath), "trash");
  mkdirSync(trashDir, { recursive: true });
  renameSync(filePath, resolve(trashDir, sanitizeName(name)));
  return `已将记忆移入回收站: ${name}`;
}

export function restoreMemory(workspacePath: string, name: string): string {
  const trashPath = resolve(ensureMemoryDir(workspacePath), "trash", sanitizeName(name));
  if (!existsSync(trashPath)) return `回收站中不存在记忆: ${name}`;
  const raw = readFileSync(trashPath, "utf-8");
  const parsed = parseFrontmatter(raw, name);
  parsed.meta.status = "active";
  parsed.meta.forgottenAt = undefined;
  parsed.meta.forgetReason = undefined;
  const target = memoryPath(workspacePath, name);
  writeMemoryEntry({ name, meta: parsed.meta, content: parsed.content, filePath: target });
  unlinkSync(trashPath);
  return `已恢复记忆: ${name}`;
}

export function runMemoryMaintenance(
  workspacePath: string,
  options: { inactiveTurns: number; inactiveDays: number; trashRetentionDays: number },
): { stale: number; purged: number } {
  const state = loadMemoryState(workspacePath);
  const now = Date.now();
  let stale = 0;
  for (const entry of listMemoryEntries(workspacePath)) {
    if (entry.meta.status !== "active" || entry.meta.retention !== "normal") continue;
    const lastTurn = Math.max(entry.meta.updatedTurn, entry.meta.lastReadTurn);
    const lastAt = Date.parse(entry.meta.lastReadAt || entry.meta.updatedAt);
    const inactiveTurns = state.completedTurns - lastTurn;
    const inactiveDays = (now - lastAt) / 86_400_000;
    if (inactiveTurns >= options.inactiveTurns && inactiveDays >= options.inactiveDays) {
      entry.meta.status = "stale";
      writeMemoryEntry(entry);
      stale += 1;
    }
  }
  let purged = 0;
  const trashDir = resolve(memoryDir(workspacePath), "trash");
  let trashFiles: string[] = [];
  try { trashFiles = readdirSync(trashDir).filter((file) => file.endsWith(".md")); } catch { /* Empty trash. */ }
  for (const file of trashFiles) {
    const path = resolve(trashDir, file);
    const parsed = parseFrontmatter(readFileSync(path, "utf-8"), file.replace(/\.md$/, ""));
    const forgottenAt = Date.parse(parsed.meta.forgottenAt || parsed.meta.updatedAt);
    if ((now - forgottenAt) / 86_400_000 >= options.trashRetentionDays) {
      unlinkSync(path);
      purged += 1;
    }
  }
  return { stale, purged };
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
    description: "保存或覆盖一条按需召回的长期记忆，用于项目事实、历史决策、经验和相关时才需要的信息；稳定用户偏好应使用 profile_save",
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
        supersedes: {
          type: "array",
          description: "被当前新事实替代的旧记忆名称",
          items: { type: "string" },
        },
        importance: {
          type: "number",
          description: "重要度，0 到 1",
        },
        retention: {
          type: "string",
          enum: ["permanent", "normal", "temporary"],
          description: "保留策略，默认 normal；明确要求永久保留时使用 permanent",
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
        const supersedes = Array.isArray(args.supersedes) ? args.supersedes.map(String).filter(Boolean) : undefined;
        const result = saveMemory(workspacePath, name, content, {
          tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
          scope: typeof args.scope === "string" ? args.scope : undefined,
          summary: typeof args.summary === "string" ? args.summary : undefined,
          source: args.source === "auto" ? "auto" : undefined,
          supersedes,
          importance: typeof args.importance === "number" ? args.importance : undefined,
          retention: ["permanent", "normal", "temporary"].includes(String(args.retention))
            ? args.retention as MemoryMeta["retention"]
            : undefined,
          limits: getMemoryLimits(getConfig()),
        });
        for (const previousName of supersedes ?? []) {
          if (previousName === name || !getMemoryRecord(workspacePath, previousName)) continue;
          updateMemoryRecord(workspacePath, previousName, {
            status: "superseded",
            supersededBy: name,
          }, getMemoryLimits(getConfig()));
        }
        return result;
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
    description: "将指定长期记忆移入回收站。仅当用户明确要求遗忘，或记忆被确认错误、过期时使用",
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

export function createMemoryRestoreTool(workspacePath: string, getConfig: () => Config): Tool {
  return {
    name: "memory_restore",
    description: "从回收站恢复一条长期记忆",
    inputSchema: {
      type: "object" as const,
      properties: { name: { type: "string", description: "记忆名称" } },
      required: ["name"],
    },
    execute: async (args, context) => {
      const permission = checkDangerousToolPermission({
        workspacePath,
        config: getConfig(),
        toolName: "memory_restore",
        args,
        context,
        command: `memory_restore ${String(args.name ?? "")}`,
        cwd: memoryDir(workspacePath),
      });
      if (!permission.allowed) return permission.result;
      return restoreMemory(workspacePath, String(args.name ?? ""));
    },
  };
}
