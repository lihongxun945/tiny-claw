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

export function appendHistory(workspacePath: string, message: unknown): void {
  const dir = resolve(workspacePath, "history");
  ensureDir(dir);
  const path = resolve(dir, `${today()}.jsonl`);
  appendFileSync(path, JSON.stringify(message) + "\n", "utf-8");
}

export function appendLog(workspacePath: string, level: string, message: string): void {
  const dir = resolve(workspacePath, "logs");
  ensureDir(dir);
  const path = resolve(dir, `${today()}.log`);
  appendFileSync(path, `[${now()}] [${level}] ${message}\n`, "utf-8");
}