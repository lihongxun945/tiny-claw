import type {
  PersistedSessionSummary,
  SummaryCategories,
  SummaryCategory,
  SummaryDelta,
  SummaryItem,
} from "./types.js";

const CATEGORY_ORDER: SummaryCategory[] = [
  "goals", "constraints", "facts", "decisions", "completed", "pending", "resources",
];

export function applySummaryDelta(current: PersistedSessionSummary, delta: SummaryDelta): PersistedSessionSummary {
  if (current.deltas.some((existing) => existing.id === delta.id)) return current;
  if (delta.baseRevision !== current.revision) {
    throw new Error(`摘要 Delta baseRevision 冲突：期望 ${current.revision}，实际为 ${delta.baseRevision}`);
  }
  if (delta.fromSequence !== current.summarizedThroughSequence + 1) {
    throw new Error("摘要 Delta 与当前 summarizedThroughSequence 不连续");
  }
  const categories = cloneCategories(current.checkpoint.categories);
  for (const operation of delta.operations) {
    if (operation.type === "add") {
      assertUniqueItemId(categories, operation.item.id);
      categories[operation.category].push(operation.item);
      continue;
    }
    const target = findItem(categories, operation.targetId);
    if (!target || target.status !== "active") throw new Error(`摘要操作目标无效：${operation.targetId}`);
    if (operation.type === "supersede") {
      assertUniqueItemId(categories, operation.replacement.id);
      target.status = "superseded";
      categories[operation.category].push(operation.replacement);
    } else {
      target.status = "resolved";
      target.source = mergeSources(target.source, operation.source);
    }
  }
  sortCategories(categories);
  return {
    ...current,
    checkpoint: { ...current.checkpoint, throughSequence: delta.throughSequence, categories },
    deltas: [...current.deltas, delta],
    summarizedThroughSequence: delta.throughSequence,
  };
}

export function compactSummary(
  current: PersistedSessionSummary,
  createdAt = new Date().toISOString(),
): PersistedSessionSummary {
  if (current.deltas.length === 0) return current;
  return {
    ...current,
    checkpoint: {
      id: `checkpoint_r${current.revision}`,
      throughSequence: current.summarizedThroughSequence,
      createdAt,
      categories: cloneCategories(current.checkpoint.categories),
    },
    deltas: [],
  };
}

export interface SummaryCompactionLimits {
  maxDeltas: number;
  maxChars: number;
}

export function shouldCompactSummary(
  current: PersistedSessionSummary,
  limits: SummaryCompactionLimits,
): boolean {
  return current.deltas.length >= limits.maxDeltas
    || JSON.stringify({ checkpoint: current.checkpoint, deltas: current.deltas }).length >= limits.maxChars;
}

function cloneCategories(categories: SummaryCategories): SummaryCategories {
  return Object.fromEntries(CATEGORY_ORDER.map((category) => [
    category,
    categories[category].map((item) => ({
      ...item,
      source: {
        messageIds: [...item.source.messageIds],
        sequences: [...item.source.sequences],
        turnIds: [...item.source.turnIds],
      },
      supersedes: item.supersedes ? [...item.supersedes] : undefined,
    })),
  ])) as SummaryCategories;
}

function findItem(categories: SummaryCategories, id: string): SummaryItem | undefined {
  for (const category of CATEGORY_ORDER) {
    const item = categories[category].find((candidate) => candidate.id === id);
    if (item) return item;
  }
  return undefined;
}

function assertUniqueItemId(categories: SummaryCategories, id: string): void {
  if (findItem(categories, id)) throw new Error(`摘要条目 ID 重复：${id}`);
}

function sortCategories(categories: SummaryCategories): void {
  for (const category of CATEGORY_ORDER) {
    categories[category].sort((left, right) =>
      (left.source.sequences[0] ?? 0) - (right.source.sequences[0] ?? 0)
      || left.id.localeCompare(right.id));
  }
}

function mergeSources(left: SummaryItem["source"], right: SummaryItem["source"]): SummaryItem["source"] {
  return {
    messageIds: [...new Set([...left.messageIds, ...right.messageIds])],
    sequences: [...new Set([...left.sequences, ...right.sequences])].sort((a, b) => a - b),
    turnIds: [...new Set([...left.turnIds, ...right.turnIds])],
  };
}
