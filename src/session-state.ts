import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sessionStateFilePath } from "./session-store.js";
import type { Message } from "./types.js";

const STATE_VERSION = 1;

export interface PersistedSessionState {
  version: number;
  sessionId: string;
  summary: string;
  pendingMessages: Message[];
  turnsSinceSummary: number;
  autoMemory: PersistedAutoMemoryState;
  updatedAt: string;
}

export interface SessionStateInput {
  sessionId: string;
  summary: string;
  pendingMessages: Message[];
  turnsSinceSummary: number;
  autoMemory?: AutoMemoryStateInput;
}

export interface PersistedAutoMemoryTurn {
  user: string;
  assistant: string;
  at: string;
}

export interface PersistedAutoMemoryResult {
  analyzedTurns: number;
  toolCalls: number;
  saved: number;
  deleted: number;
  at: string;
}

export interface PersistedAutoMemoryState {
  pendingTurns: PersistedAutoMemoryTurn[];
  turnsSinceAnalysis: number;
  lastAnalyzedAt?: string;
  lastAnalyzedTurnAt?: string;
  lastResult?: PersistedAutoMemoryResult;
}

export interface AutoMemoryStateInput {
  pendingTurns: PersistedAutoMemoryTurn[];
  turnsSinceAnalysis: number;
  lastAnalyzedAt?: string;
  lastAnalyzedTurnAt?: string;
  lastResult?: PersistedAutoMemoryResult;
}

export function emptySessionState(sessionId: string): PersistedSessionState {
  return {
    version: STATE_VERSION,
    sessionId,
    summary: "",
    pendingMessages: [],
    turnsSinceSummary: 0,
    autoMemory: emptyAutoMemoryState(),
    updatedAt: new Date(0).toISOString(),
  };
}

export function loadSessionState(workspacePath: string, sessionId: string): PersistedSessionState {
  const path = sessionStatePath(workspacePath, sessionId);
  if (!existsSync(path)) return emptySessionState(sessionId);

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<PersistedSessionState>;
    if (parsed.version !== STATE_VERSION || parsed.sessionId !== sessionId) return emptySessionState(sessionId);
    const turnsSinceSummary = parsed.turnsSinceSummary;
    return {
      version: STATE_VERSION,
      sessionId,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      pendingMessages: Array.isArray(parsed.pendingMessages) ? sanitizeMessages(parsed.pendingMessages) : [],
      turnsSinceSummary: typeof turnsSinceSummary === "number" && Number.isInteger(turnsSinceSummary) && turnsSinceSummary >= 0
        ? turnsSinceSummary
        : 0,
      autoMemory: sanitizeAutoMemoryState(parsed.autoMemory),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return emptySessionState(sessionId);
  }
}

export function saveSessionState(workspacePath: string, state: SessionStateInput): PersistedSessionState {
  const existing = loadSessionState(workspacePath, state.sessionId);
  const persisted: PersistedSessionState = {
    version: STATE_VERSION,
    sessionId: state.sessionId,
    summary: state.summary,
    pendingMessages: sanitizeMessages(state.pendingMessages),
    turnsSinceSummary: Math.max(0, Math.floor(state.turnsSinceSummary)),
    autoMemory: state.autoMemory === undefined ? existing.autoMemory : sanitizeAutoMemoryState(state.autoMemory),
    updatedAt: new Date().toISOString(),
  };

  const path = sessionStatePath(workspacePath, state.sessionId);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf-8");
  renameSync(tmpPath, path);
  return persisted;
}

export function emptyAutoMemoryState(): PersistedAutoMemoryState {
  return {
    pendingTurns: [],
    turnsSinceAnalysis: 0,
  };
}

export function deleteSessionState(workspacePath: string, sessionId: string): boolean {
  const path = sessionStatePath(workspacePath, sessionId);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function sessionStatePath(workspacePath: string, sessionId: string): string {
  return sessionStateFilePath(workspacePath, sessionId);
}

function sanitizeMessages(messages: unknown[]): Message[] {
  const result: Message[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as Partial<Message>;
    if (record.role !== "user" && record.role !== "assistant") continue;
    if (typeof record.content !== "string" && !Array.isArray(record.content)) continue;
    result.push({
      role: record.role,
      content: record.content,
      _timestamp: typeof record._timestamp === "number" ? record._timestamp : undefined,
    });
  }
  return result;
}

function sanitizeAutoMemoryState(value: unknown): PersistedAutoMemoryState {
  if (!value || typeof value !== "object") return emptyAutoMemoryState();
  const record = value as Partial<PersistedAutoMemoryState>;
  const turnsSinceAnalysis = record.turnsSinceAnalysis;
  const pendingTurns = Array.isArray(record.pendingTurns)
    ? sanitizeAutoMemoryTurns(record.pendingTurns)
    : [];
  const lastResult = sanitizeAutoMemoryResult(record.lastResult);
  return {
    pendingTurns,
    turnsSinceAnalysis: typeof turnsSinceAnalysis === "number" && Number.isInteger(turnsSinceAnalysis) && turnsSinceAnalysis >= 0
      ? turnsSinceAnalysis
      : pendingTurns.length,
    lastAnalyzedAt: typeof record.lastAnalyzedAt === "string" ? record.lastAnalyzedAt : undefined,
    lastAnalyzedTurnAt: typeof record.lastAnalyzedTurnAt === "string" ? record.lastAnalyzedTurnAt : undefined,
    lastResult,
  };
}

function sanitizeAutoMemoryTurns(value: unknown[]): PersistedAutoMemoryTurn[] {
  const turns: PersistedAutoMemoryTurn[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Partial<PersistedAutoMemoryTurn>;
    if (typeof record.user !== "string" || typeof record.assistant !== "string") continue;
    turns.push({
      user: record.user,
      assistant: record.assistant,
      at: typeof record.at === "string" ? record.at : new Date(0).toISOString(),
    });
  }
  return turns;
}

function sanitizeAutoMemoryResult(value: unknown): PersistedAutoMemoryResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<PersistedAutoMemoryResult>;
  if (
    typeof record.analyzedTurns !== "number"
    || typeof record.toolCalls !== "number"
    || typeof record.saved !== "number"
    || typeof record.deleted !== "number"
  ) {
    return undefined;
  }
  return {
    analyzedTurns: Math.max(0, Math.floor(record.analyzedTurns)),
    toolCalls: Math.max(0, Math.floor(record.toolCalls)),
    saved: Math.max(0, Math.floor(record.saved)),
    deleted: Math.max(0, Math.floor(record.deleted)),
    at: typeof record.at === "string" ? record.at : new Date(0).toISOString(),
  };
}
