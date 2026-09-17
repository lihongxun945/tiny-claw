import { existsSync } from "node:fs";
import { win32 } from "node:path";

/** Do not fall back to Windows' WSL bash: it has a different filesystem and process model. */
export function resolveBash(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string {
  if (platform !== "win32") return "bash";
  const value = (key: string) => Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
  const roots = [
    value("ProgramFiles") && win32.join(value("ProgramFiles")!, "Git"),
    value("ProgramFiles(x86)") && win32.join(value("ProgramFiles(x86)")!, "Git"),
    value("LOCALAPPDATA") && win32.join(value("LOCALAPPDATA")!, "Programs", "Git"),
  ].filter((root): root is string => !!root);
  for (const entry of (value("PATH") ?? "").split(";")) {
    const directory = entry.replace(/^"|"$/g, "");
    if (!win32.isAbsolute(directory) || !exists(win32.join(directory, "git.exe"))) continue;
    roots.push(win32.resolve(directory, ".."), win32.resolve(directory, "../.."));
  }
  for (const root of roots) {
    const bash = win32.join(root, "bin", "bash.exe");
    if (exists(bash) && exists(win32.join(root, "cmd", "git.exe"))) return bash;
  }
  throw new Error("未找到 Git Bash。请安装 Git for Windows 后重启 tiny-claw；聊天和文件工具不受影响。不支持以 WSL 或 PowerShell 替代 Bash。");
}

export function shellEnvironment(tempPath?: string): NodeJS.ProcessEnv {
  return { ...process.env, ...(tempPath ? { TMPDIR: process.platform === "win32" ? tempPath.replace(/\\/g, "/") : tempPath } : {}) };
}

/** Resolve only unambiguous Git Bash paths; /tmp, /usr and custom mounts need review. */
export function nativeShellPath(path: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== "win32") return path;
  if (path.includes("\\")) return undefined;
  if (/^\/[a-zA-Z](?:\/|$)/.test(path)) return `${path[1]}:${path.slice(2) || "/"}`;
  if (path.startsWith("/") || /^[a-zA-Z]:(?!\/)/.test(path)) return undefined;
  return path;
}
