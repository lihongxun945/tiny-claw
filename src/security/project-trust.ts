import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Config } from "../types.js";
import { resolveRootFile } from "../tools/workspace-path.js";

export function setProjectTrust(workspace: string, root: string, trusted: boolean): void {
  const canonical = realpathSync(root);
  if (!statSync(canonical).isDirectory()) throw new Error("项目路径必须是目录");
  const path = resolve(workspace, "config.json");
  const config = JSON.parse(readFileSync(path, "utf8")) as Config;
  const paths = (config.security?.trustedProjects ?? []).filter((entry) => {
    try { return realpathSync(entry) !== canonical; } catch { return entry !== canonical; }
  });
  if (trusted) paths.push(canonical);
  config.security = { ...config.security, trustedProjects: paths };
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function isTrustedProject(config: Config, root: string, workspace?: string): boolean {
  try {
    // Trust can be revoked without rebuilding active session configuration.
    const stored = workspace ? JSON.parse(readFileSync(resolve(workspace, "config.json"), "utf8")) as Config : undefined;
    const canonical = realpathSync(root);
    return (stored?.security?.trustedProjects ?? config.security?.trustedProjects ?? []).some((path) => {
      try { return realpathSync(path) === canonical; } catch { return false; }
    });
  } catch { return false; }
}

export function projectTempDirectory(workspace: string, root: string): string {
  const key = createHash("sha256").update(realpathSync(root)).digest("hex");
  const path = resolveRootFile(workspace, resolve(workspace, "project-tmp", key));
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return realpathSync(path);
}
