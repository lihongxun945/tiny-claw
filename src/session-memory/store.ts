import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withSessionLock } from "../session-lock.js";
import { sessionDir } from "../session-store.js";
import { compactSummary } from "./reducer.js";
import {
  SESSION_SUMMARY_VERSION,
  emptySummaryCategories,
  type PersistedSessionSummary,
} from "./types.js";

export class SessionSummaryRevisionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`Session 摘要版本冲突：期望 revision ${expected}，实际为 ${actual}`);
    this.name = "SessionSummaryRevisionConflictError";
  }
}

export function sessionSummaryPath(workspacePath: string, sessionId: string): string {
  return resolve(sessionDir(workspacePath, sessionId), "summary", "current.json");
}

export function sessionSummaryArchivePath(
  workspacePath: string,
  sessionId: string,
  revision: number,
): string {
  return resolve(
    sessionDir(workspacePath, sessionId),
    "summary",
    "archive",
    `revision-${revision}.json`,
  );
}

export function emptySessionSummary(sessionId: string): PersistedSessionSummary {
  return {
    version: SESSION_SUMMARY_VERSION,
    sessionId,
    revision: 0,
    checkpoint: {
      id: "checkpoint_initial",
      throughSequence: 0,
      createdAt: new Date(0).toISOString(),
      categories: emptySummaryCategories(),
    },
    deltas: [],
    summarizedThroughSequence: 0,
    updatedAt: new Date(0).toISOString(),
  };
}

export function loadSessionSummary(workspacePath: string, sessionId: string): PersistedSessionSummary {
  const path = sessionSummaryPath(workspacePath, sessionId);
  if (!existsSync(path)) return emptySessionSummary(sessionId);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(`无法读取 Session 结构化摘要：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPersistedSessionSummary(parsed) || parsed.sessionId !== sessionId) {
    throw new Error(`Session 结构化摘要格式无效：${path}`);
  }
  return parsed;
}

export async function saveSessionSummary(
  workspacePath: string,
  summary: PersistedSessionSummary,
): Promise<PersistedSessionSummary> {
  return withSessionLock(workspacePath, summary.sessionId, async () => {
    const persisted = { ...summary, updatedAt: new Date().toISOString() };
    await writeSummaryAtomic(workspacePath, persisted);
    return persisted;
  });
}

export async function updateSessionSummary(
  workspacePath: string,
  sessionId: string,
  expectedRevision: number,
  updater: (current: PersistedSessionSummary) => PersistedSessionSummary,
): Promise<PersistedSessionSummary> {
  return withSessionLock(workspacePath, sessionId, async () => {
    const current = loadSessionSummary(workspacePath, sessionId);
    if (current.revision !== expectedRevision) {
      throw new SessionSummaryRevisionConflictError(expectedRevision, current.revision);
    }
    const updated = updater(current);
    if (updated.sessionId !== sessionId || updated.version !== SESSION_SUMMARY_VERSION) {
      throw new Error("Session 结构化摘要更新结果无效");
    }
    const persisted: PersistedSessionSummary = {
      ...updated,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    await writeSummaryAtomic(workspacePath, persisted);
    return persisted;
  });

}
export async function compactStoredSessionSummary(
  workspacePath: string,
  sessionId: string,
  expectedRevision: number,
  createdAt = new Date().toISOString(),
): Promise<PersistedSessionSummary> {
  return withSessionLock(workspacePath, sessionId, async () => {
    const current = loadSessionSummary(workspacePath, sessionId);
    if (current.revision !== expectedRevision) {
      throw new SessionSummaryRevisionConflictError(expectedRevision, current.revision);
    }
    if (current.deltas.length === 0) return current;
    const archivePath = sessionSummaryArchivePath(workspacePath, sessionId, current.revision);
    await writeJsonAtomic(archivePath, current);
    const persisted: PersistedSessionSummary = {
      ...compactSummary(current, createdAt),
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    await writeSummaryAtomic(workspacePath, persisted);
    return persisted;
  });
}

async function writeSummaryAtomic(
  workspacePath: string,
  summary: PersistedSessionSummary,
): Promise<void> {
  const path = sessionSummaryPath(workspacePath, summary.sessionId);
  await mkdir(resolve(sessionDir(workspacePath, summary.sessionId), "summary"), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");

  await rename(tmpPath, path);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  await rename(tmpPath, path);
}

function isPersistedSessionSummary(value: unknown): value is PersistedSessionSummary {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PersistedSessionSummary>;
  return record.version === SESSION_SUMMARY_VERSION
    && typeof record.sessionId === "string"
    && Number.isInteger(record.revision)
    && Number(record.revision) >= 0
    && !!record.checkpoint
    && Array.isArray(record.deltas)
    && Number.isInteger(record.summarizedThroughSequence)
    && Number(record.summarizedThroughSequence) >= 0
    && typeof record.updatedAt === "string";
}
