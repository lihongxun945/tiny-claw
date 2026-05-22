import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const SUBDIRS = ["skills", "memory", "history", "logs"];

export function resolveWorkspacePath(cliPath?: string): string {
  return cliPath || process.env.TINY_CLAW_WORKSPACE || resolve(process.cwd(), "workspace");
}

export function ensureWorkspace(workspacePath: string): void {
  for (const dir of SUBDIRS) {
    mkdirSync(resolve(workspacePath, dir), { recursive: true });
  }
}

export function loadIdentity(workspacePath: string): string {
  try {
    return readFileSync(resolve(workspacePath, "identity.md"), "utf-8");
  } catch {
    return "";
  }
}

