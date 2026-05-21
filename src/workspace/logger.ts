import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function now(): string {
  return new Date().toISOString().slice(11, 19);
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function appendHistory(workspacePath: string, message: unknown, sessionId?: string): void {
  const dir = resolve(workspacePath, "history");
  ensureDir(dir);
  const path = resolve(dir, `${today()}.jsonl`);
  const record = sessionId ? { ...message as object, _session: sessionId } : message;
  appendFileSync(path, JSON.stringify(record) + "\n", "utf-8");
}

export function appendLog(workspacePath: string, level: string, message: string, sessionId?: string): void {
  const dir = resolve(workspacePath, "logs");
  ensureDir(dir);
  const path = resolve(dir, `${today()}.log`);
  const prefix = sessionId ? `[${now()}] [${level}] [${sessionId}] ` : `[${now()}] [${level}] `;
  appendFileSync(path, `${prefix}${message}\n`, "utf-8");
}