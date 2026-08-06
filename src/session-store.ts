import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExecutionMode, Message, SessionContext } from "./types.js";

const META_VERSION = 1;

export interface SessionMeta {
  version: number;
  id: string;
  title: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
  lastActivity: number;
  archived: boolean;
  pinned: boolean;
  context: SessionContext;
  preferences: { executionMode: ExecutionMode };
}

export function readSessionMeta(workspacePath: string, sessionId: string): SessionMeta | undefined {
  return readSessionMetaPath(resolve(sessionDir(workspacePath, sessionId), "meta.json"));
}

export function createSessionMeta(
  workspacePath: string,
  sessionId: string,
  context: SessionContext,
): SessionMeta {
  const dir = sessionDir(workspacePath, sessionId);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, "meta.json");
  const existing = readSessionMetaPath(path);
  if (existing) {
    if (JSON.stringify(existing.context) !== JSON.stringify(context)) {
      throw new Error("会话已绑定其他运行上下文，不能切换项目");
    }
    return existing;
  }
  const now = new Date();
  const meta: SessionMeta = {
    version: META_VERSION,
    id: sessionId,
    title: sessionId.slice(0, 8),
    preview: "",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastActivity: now.getTime(),
    archived: false,
    pinned: false,
    context,
    preferences: { executionMode: "normal" },
  };
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
  return meta;
}

export interface SessionDeleteResult {
  deleted: boolean;
  deletedHistoryRecords: number;
  deletedSessionState: boolean;
}

export function encodeSessionId(sessionId: string): string {
  return Buffer.from(sessionId, "utf-8").toString("base64url");
}

export function sessionsDir(workspacePath: string): string {
  return resolve(workspacePath, "sessions");
}

export function sessionDir(workspacePath: string, sessionId: string): string {
  return resolve(sessionsDir(workspacePath), encodeSessionId(sessionId));
}

export function sessionMessagesPath(workspacePath: string, sessionId: string): string {
  return resolve(sessionDir(workspacePath, sessionId), "messages.jsonl");
}

export function sessionStateFilePath(workspacePath: string, sessionId: string): string {
  return resolve(sessionDir(workspacePath, sessionId), "state.json");
}

export function appendSessionMessage(workspacePath: string, sessionId: string, message: Message): void {
  const dir = sessionDir(workspacePath, sessionId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(sessionMessagesPath(workspacePath, sessionId), `${JSON.stringify(message)}\n`, "utf-8");
  updateSessionMeta(workspacePath, sessionId, message);
}

export function readSessionMessages(workspacePath: string, sessionId: string): Message[] {
  const path = sessionMessagesPath(workspacePath, sessionId);
  if (!existsSync(path)) return [];

  const messages: Message[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n").filter(Boolean)) {
    try {
      const record = JSON.parse(line) as Partial<Message>;
      if (record.role !== "user" && record.role !== "assistant") continue;
      if (typeof record.content !== "string" && !Array.isArray(record.content)) continue;
      messages.push({
        role: record.role,
        content: record.content,
        _timestamp: typeof record._timestamp === "number" ? record._timestamp : undefined,
        _turnId: typeof record._turnId === "string" ? record._turnId : undefined,
      });
    } catch {
      // Ignore malformed message records.
    }
  }
  return messages;
}

export function listSessionMetas(workspacePath: string): SessionMeta[] {
  const dir = sessionsDir(workspacePath);
  if (!existsSync(dir)) return [];

  const metas: SessionMeta[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const meta = readSessionMetaPath(resolve(dir, entry.name, "meta.json"));
    if (meta) metas.push(meta);
  }
  return metas;
}

export function deleteStoredSession(workspacePath: string, sessionId: string): SessionDeleteResult {
  const dir = sessionDir(workspacePath, sessionId);
  if (!existsSync(dir)) {
    return { deleted: false, deletedHistoryRecords: 0, deletedSessionState: false };
  }

  const deletedHistoryRecords = countMessageRecords(sessionMessagesPath(workspacePath, sessionId));
  const deletedSessionState = existsSync(sessionStateFilePath(workspacePath, sessionId));
  rmSync(dir, { recursive: true, force: true });
  return { deleted: true, deletedHistoryRecords, deletedSessionState };
}

export function updateSessionExecutionMode(
  workspacePath: string,
  sessionId: string,
  executionMode: ExecutionMode,
): SessionMeta {
  const path = resolve(sessionDir(workspacePath, sessionId), "meta.json");
  const meta = readSessionMetaPath(path);
  if (!meta) throw new Error("会话不存在");
  const updated = {
    ...meta,
    updatedAt: new Date().toISOString(),
    preferences: { ...meta.preferences, executionMode },
  };
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
  return updated;
}

function updateSessionMeta(workspacePath: string, sessionId: string, message: Message): void {
  const dir = sessionDir(workspacePath, sessionId);
  const path = resolve(dir, "meta.json");
  const now = new Date(message._timestamp ?? Date.now());
  const existing = readSessionMetaPath(path);
  const preview = message.role === "user" ? messagePreview(message) : (existing?.preview ?? "");
  const meta: SessionMeta = {
    version: META_VERSION,
    id: sessionId,
    title: existing?.title || preview || sessionId.slice(0, 8),
    preview: preview || existing?.preview || "",
    createdAt: existing?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
    lastActivity: now.getTime(),
    archived: existing?.archived ?? false,
    pinned: existing?.pinned ?? false,
    context: existing?.context ?? { mode: "chat" },
    preferences: existing?.preferences ?? { executionMode: "normal" },
  };
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
}

function readSessionMetaPath(path: string): SessionMeta | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<SessionMeta>;
    if (parsed.version !== META_VERSION || typeof parsed.id !== "string") return undefined;
    return {
      version: META_VERSION,
      id: parsed.id,
      title: typeof parsed.title === "string" ? parsed.title : parsed.id.slice(0, 8),
      preview: typeof parsed.preview === "string" ? parsed.preview : "",
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      lastActivity: typeof parsed.lastActivity === "number" ? parsed.lastActivity : Date.parse(String(parsed.updatedAt)) || 0,
      archived: parsed.archived === true,
      pinned: parsed.pinned === true,
      context: parseSessionContext(parsed.context),
      preferences: {
        executionMode: parsed.preferences?.executionMode === "plan" ? "plan" : "normal",
      },
    };
  } catch {
    return undefined;
  }
}

function parseSessionContext(value: unknown): SessionContext {
  if (!value || typeof value !== "object") return { mode: "chat" };
  const context = value as Partial<SessionContext>;
  if (context.mode !== "project" || !context.project || typeof context.project.root !== "string") {
    return { mode: "chat" };
  }
  return {
    mode: "project",
    project: {
      root: context.project.root,
      name: typeof context.project.name === "string" ? context.project.name : context.project.root.split("/").pop() || context.project.root,
    },
  };
}

function messagePreview(message: Message): string {
  if (typeof message.content === "string") return message.content.slice(0, 60);
  const textBlock = message.content.find((block) => block.type === "text");
  return textBlock?.type === "text" ? textBlock.text.slice(0, 60) : "";
}

function countMessageRecords(path: string): number {
  if (!existsSync(path)) return 0;
  let count = 0;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (line.trim()) count++;
  }
  return count;
}
