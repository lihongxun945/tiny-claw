import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function findExistingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

/**
 * 在指定 root（workspace 或项目根）下解析用户提供的路径，并防止符号链接逃逸。
 * 语义与旧 resolveWorkspaceFile 完全一致，仅 root 可配置，用于支持项目开发模式。
 */
export function resolveRootFile(rootPath: string, requestedPath: string): string {
  const lexicalRoot = resolve(rootPath);
  const root = realpathSync(lexicalRoot);
  const candidate = resolve(lexicalRoot, requestedPath);

  if (!isInside(lexicalRoot, candidate)) {
    throw new Error("拒绝访问当前根目录之外的路径");
  }

  const existingAncestor = findExistingAncestor(candidate);
  const realAncestor = realpathSync(existingAncestor);
  if (!isInside(root, realAncestor)) {
    throw new Error("拒绝通过符号链接访问当前根目录之外的路径");
  }

  if (existsSync(candidate)) {
    const realCandidate = realpathSync(candidate);
    if (!isInside(root, realCandidate)) {
      throw new Error("拒绝通过符号链接访问当前根目录之外的路径");
    }
  }

  return candidate;
}

/** 兼容旧签名：以 workspace 为 root 解析 */
export function resolveWorkspaceFile(workspacePath: string, requestedPath: string): string {
  return resolveRootFile(workspacePath, requestedPath);
}
