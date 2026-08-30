import { createHash } from "node:crypto";
import type { Message } from "../types.js";
import type {
  PersistedSessionSummary,
  SummaryCategory,
  SummaryDelta,
  SummaryDeltaDraft,
  SummaryItem,
  SummaryItemDraft,
  SummaryOperation,
  SummaryOperationDraft,
  SummarySource,
} from "./types.js";

const SUMMARY_CATEGORIES = new Set<SummaryCategory>([
  "goals", "constraints", "facts", "decisions", "completed", "pending", "resources",
]);

export interface SummaryValidationLimits {
  maxOperations: number;
  maxItemChars: number;
  maxSourcesPerOperation: number;
}

export interface ValidateSummaryDeltaInput {
  sessionId: string;
  current: PersistedSessionSummary;
  messages: Message[];
  limits: SummaryValidationLimits;
  createdAt?: string;
}

export class SummaryDeltaValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`结构化摘要 Delta 校验失败：${issues.join("；")}`);
    this.name = "SummaryDeltaValidationError";
  }
}

export function parseSummaryDeltaDraft(output: string): SummaryDeltaDraft {
  const trimmed = output.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const json = fenced?.[1] ?? trimmed;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new SummaryDeltaValidationError([
      `模型输出不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  const issues: string[] = [];
  if (!isRecord(value)) throw new SummaryDeltaValidationError(["顶层必须是对象"]);
  assertOnlyKeys(value, ["baseRevision", "sourceRange", "operations"], "$", issues);
  const baseRevision = readInteger(value.baseRevision, "$.baseRevision", issues);
  const sourceRange = readSourceRange(value.sourceRange, issues);
  const operations = readOperations(value.operations, issues);
  if (issues.length > 0 || baseRevision === undefined || !sourceRange || !operations) {
    throw new SummaryDeltaValidationError(issues);
  }
  return { baseRevision, sourceRange, operations };
}

export function validateSummaryDelta(
  draft: SummaryDeltaDraft,
  input: ValidateSummaryDeltaInput,
): SummaryDelta {
  const issues: string[] = [];
  if (draft.baseRevision !== input.current.revision) {
    issues.push(`baseRevision 应为 ${input.current.revision}，实际为 ${draft.baseRevision}`);
  }
  if (draft.sourceRange.fromSequence !== input.current.summarizedThroughSequence + 1) {
    issues.push(`sourceRange.fromSequence 应为 ${input.current.summarizedThroughSequence + 1}`);
  }
  if (draft.sourceRange.throughSequence < draft.sourceRange.fromSequence) {
    issues.push("sourceRange.throughSequence 不能小于 fromSequence");
  }
  if (draft.operations.length > input.limits.maxOperations) {
    issues.push(`operations 数量不能超过 ${input.limits.maxOperations}`);
  }

  const sourceMessages = new Map<string, Message>();
  for (const message of input.messages) {
    if (!message._messageId || !Number.isInteger(message._sequence)) continue;
    if (Number(message._sequence) >= draft.sourceRange.fromSequence
      && Number(message._sequence) <= draft.sourceRange.throughSequence) {
      sourceMessages.set(message._messageId, message);
    }
  }
  const sequences = [...sourceMessages.values()].map((message) => Number(message._sequence));
  if (sequences.length === 0) {
    issues.push("sourceRange 内没有可验证的持久化消息");
  } else if (Math.max(...sequences) !== draft.sourceRange.throughSequence) {
    issues.push("sourceRange.throughSequence 没有对应的持久化消息");
  }
  const sequenceSet = new Set(sequences);
  for (let sequence = draft.sourceRange.fromSequence; sequence <= draft.sourceRange.throughSequence; sequence++) {
    if (!sequenceSet.has(sequence)) {
      issues.push(`sourceRange 缺少 sequence ${sequence} 对应的持久化消息`);
    }
  }


  const existingItems = new Map(Object.entries(input.current.checkpoint.categories).flatMap(
    ([category, items]) => items.map((item) => [
      item.id, { item, category: category as SummaryCategory },
    ]),
  ));
  const deltaId = `delta_${digest(JSON.stringify({
    sessionId: input.sessionId,
    baseRevision: draft.baseRevision,
    sourceRange: draft.sourceRange,
    operations: draft.operations,
  }))}`;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const operations: SummaryOperation[] = [];

  draft.operations.forEach((operation, index) => {
    const path = `operations[${index}]`;
    if (!SUMMARY_CATEGORIES.has(operation.category)) {
      issues.push(`${path}.category 无效`);
      return;
    }
    if (operation.type === "add") {
      const item = materializeItem(operation.item, path, index, deltaId, createdAt, sourceMessages, input.limits, issues);
      if (item) operations.push({ type: "add", category: operation.category, item });
      return;
    }
    const target = existingItems.get(operation.targetId);
    if (!target) {
      issues.push(`${path}.targetId 不存在`);
      return;
    }
    if (target.category !== operation.category) {
      issues.push(`${path}.category 与 targetId 所在类别不一致`);
      return;
    }
    if (target.item.status !== "active") {
      issues.push(`${path}.targetId 必须指向 active 条目`);
      return;
    }
    if (operation.type === "supersede") {
      const replacement = materializeItem(
        operation.replacement, path, index, deltaId, createdAt, sourceMessages, input.limits, issues,
      );
      if (replacement) {
        replacement.supersedes = [operation.targetId];
        operations.push({
          type: "supersede", category: operation.category, targetId: operation.targetId, replacement,
        });
      }
      return;
    }
    const source = materializeSource(
      operation.sourceMessageIds, path, sourceMessages, input.limits, issues,
    );
    if (source) operations.push({
      type: "resolve", category: operation.category, targetId: operation.targetId, source,
    });
  });

  if (issues.length > 0) throw new SummaryDeltaValidationError(issues);
  return {
    id: deltaId,
    baseRevision: draft.baseRevision,
    fromSequence: draft.sourceRange.fromSequence,
    throughSequence: draft.sourceRange.throughSequence,
    createdAt,
    operations,
  };
}

function materializeItem(
  draft: SummaryItemDraft,
  path: string,
  index: number,
  deltaId: string,
  createdAt: string,
  sourceMessages: Map<string, Message>,
  limits: SummaryValidationLimits,
  issues: string[],
): SummaryItem | undefined {
  const text = draft.text.trim();
  if (!text) issues.push(`${path}.text 不能为空`);
  if (text.length > limits.maxItemChars) issues.push(`${path}.text 不能超过 ${limits.maxItemChars} 字符`);
  const source = materializeSource(draft.sourceMessageIds, path, sourceMessages, limits, issues);
  if (!text || text.length > limits.maxItemChars || !source) return undefined;
  return {
    id: `item_${digest(`${deltaId}:${index}`)}`,
    text,
    status: "active",
    source,
    createdAt,
  };
}

function materializeSource(
  messageIds: string[],
  path: string,
  sourceMessages: Map<string, Message>,
  limits: SummaryValidationLimits,
  issues: string[],
): SummarySource | undefined {
  const uniqueIds = [...new Set(messageIds)];
  if (uniqueIds.length === 0) issues.push(`${path}.sourceMessageIds 不能为空`);
  if (uniqueIds.length > limits.maxSourcesPerOperation) {
    issues.push(`${path}.sourceMessageIds 不能超过 ${limits.maxSourcesPerOperation} 个`);
  }
  const resolved = uniqueIds.map((id) => sourceMessages.get(id));
  uniqueIds.forEach((id, index) => {
    if (!resolved[index]) issues.push(`${path} 引用了不在 sourceRange 内的消息 ${id}`);
  });
  if (uniqueIds.length === 0 || uniqueIds.length > limits.maxSourcesPerOperation || resolved.some((item) => !item)) {
    return undefined;
  }
  const messages = resolved as Message[];
  return {
    messageIds: uniqueIds,
    sequences: messages.map((message) => Number(message._sequence)),
    turnIds: [...new Set(messages.map((message) => message._turnId).filter((id): id is string => !!id))],
  };
}

function readOperations(value: unknown, issues: string[]): SummaryOperationDraft[] | undefined {
  if (!Array.isArray(value)) {
    issues.push("$.operations 必须是数组");
    return undefined;
  }
  const result: SummaryOperationDraft[] = [];
  value.forEach((raw, index) => {
    const path = `$.operations[${index}]`;
    if (!isRecord(raw) || typeof raw.type !== "string") {
      issues.push(`${path} 必须是带 type 的对象`);
      return;
    }
    if (!SUMMARY_CATEGORIES.has(raw.category as SummaryCategory)) {
      issues.push(`${path}.category 无效`);
      return;
    }
    const category = raw.category as SummaryCategory;
    if (raw.type === "add") {
      assertOnlyKeys(raw, ["type", "category", "item"], path, issues);
      const item = readItemDraft(raw.item, `${path}.item`, issues);
      if (item) result.push({ type: "add", category, item });
    } else if (raw.type === "supersede") {
      assertOnlyKeys(raw, ["type", "category", "targetId", "replacement"], path, issues);
      const replacement = readItemDraft(raw.replacement, `${path}.replacement`, issues);
      if (typeof raw.targetId !== "string") issues.push(`${path}.targetId 必须是字符串`);
      if (replacement && typeof raw.targetId === "string") {
        result.push({ type: "supersede", category, targetId: raw.targetId, replacement });
      }
    } else if (raw.type === "resolve") {
      assertOnlyKeys(raw, ["type", "category", "targetId", "sourceMessageIds"], path, issues);
      const ids = readStringArray(raw.sourceMessageIds, `${path}.sourceMessageIds`, issues);
      if (typeof raw.targetId !== "string") issues.push(`${path}.targetId 必须是字符串`);
      if (ids && typeof raw.targetId === "string") {
        result.push({ type: "resolve", category, targetId: raw.targetId, sourceMessageIds: ids });
      }
    } else {
      issues.push(`${path}.type 无效`);
    }
  });
  return result;
}

function readItemDraft(value: unknown, path: string, issues: string[]): SummaryItemDraft | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} 必须是对象`);
    return undefined;
  }
  assertOnlyKeys(value, ["text", "sourceMessageIds"], path, issues);
  if (typeof value.text !== "string") issues.push(`${path}.text 必须是字符串`);
  const sourceMessageIds = readStringArray(value.sourceMessageIds, `${path}.sourceMessageIds`, issues);
  if (typeof value.text !== "string" || !sourceMessageIds) return undefined;
  return { text: value.text, sourceMessageIds };
}

function readSourceRange(value: unknown, issues: string[]): SummaryDeltaDraft["sourceRange"] | undefined {
  if (!isRecord(value)) {
    issues.push("$.sourceRange 必须是对象");
    return undefined;
  }
  assertOnlyKeys(value, ["fromSequence", "throughSequence"], "$.sourceRange", issues);
  const fromSequence = readInteger(value.fromSequence, "$.sourceRange.fromSequence", issues);
  const throughSequence = readInteger(value.throughSequence, "$.sourceRange.throughSequence", issues);
  if (fromSequence === undefined || throughSequence === undefined) return undefined;
  return { fromSequence, throughSequence };
}

function readInteger(value: unknown, path: string, issues: string[]): number | undefined {
  if (!Number.isInteger(value) || Number(value) < 0) {
    issues.push(`${path} 必须是非负整数`);
    return undefined;
  }
  return Number(value);
}

function readStringArray(value: unknown, path: string, issues: string[]): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    issues.push(`${path} 必须是字符串数组`);
    return undefined;
  }
  return value;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[], path: string, issues: string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) issues.push(`${path} 包含未知字段 ${key}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}
