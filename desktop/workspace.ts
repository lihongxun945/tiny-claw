import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export function initializeDesktopWorkspace(userDataPath: string): string {
  const workspacePath = resolve(userDataPath, "workspace");
  mkdirSync(workspacePath, { recursive: true });

  for (const name of ["skills", "memory", "sessions", "logs", "plugins"]) {
    mkdirSync(resolve(workspacePath, name), { recursive: true });
  }

  return workspacePath;
}
