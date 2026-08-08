import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface MemoryState {
  completedTurns: number;
  updatedAt: string;
}

function statePath(workspacePath: string): string {
  const dir = resolve(workspacePath, "memory");
  mkdirSync(dir, { recursive: true });
  return resolve(dir, "state.json");
}

export function loadMemoryState(workspacePath: string): MemoryState {
  try {
    if (existsSync(statePath(workspacePath))) {
      const value = JSON.parse(readFileSync(statePath(workspacePath), "utf-8")) as Partial<MemoryState>;
      return { completedTurns: Math.max(0, Number(value.completedTurns) || 0), updatedAt: String(value.updatedAt || "") };
    }
  } catch { /* Recover with an empty counter. */ }
  return { completedTurns: 0, updatedAt: "" };
}

export function incrementMemoryTurn(workspacePath: string): MemoryState {
  const current = loadMemoryState(workspacePath);
  const next = { completedTurns: current.completedTurns + 1, updatedAt: new Date().toISOString() };
  writeFileSync(statePath(workspacePath), `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return next;
}
