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
  updatedAt: string;
}

export interface SessionStateInput {
  sessionId: string;
  summary: string;
  pendingMessages: Message[];
  turnsSinceSummary: number;
}

export function emptySessionState(sessionId: string): PersistedSessionState {
  return {
    version: STATE_VERSION,
    sessionId,
    summary: "",
    pendingMessages: [],
    turnsSinceSummary: 0,
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
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return emptySessionState(sessionId);
  }
}

export function saveSessionState(workspacePath: string, state: SessionStateInput): PersistedSessionState {
  const persisted: PersistedSessionState = {
    version: STATE_VERSION,
    sessionId: state.sessionId,
    summary: state.summary,
    pendingMessages: sanitizeMessages(state.pendingMessages),
    turnsSinceSummary: Math.max(0, Math.floor(state.turnsSinceSummary)),
    updatedAt: new Date().toISOString(),
  };

  const path = sessionStatePath(workspacePath, state.sessionId);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf-8");
  renameSync(tmpPath, path);
  return persisted;
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
