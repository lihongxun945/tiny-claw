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

export function resolveWorkspaceFile(workspacePath: string, requestedPath: string): string {
  const lexicalRoot = resolve(workspacePath);
  const root = realpathSync(lexicalRoot);
  const candidate = resolve(lexicalRoot, requestedPath);

  if (!isInside(lexicalRoot, candidate)) {
    throw new Error("拒绝访问 workspace 之外的路径");
  }

  const existingAncestor = findExistingAncestor(candidate);
  const realAncestor = realpathSync(existingAncestor);
  if (!isInside(root, realAncestor)) {
    throw new Error("拒绝通过符号链接访问 workspace 之外的路径");
  }

  if (existsSync(candidate)) {
    const realCandidate = realpathSync(candidate);
    if (!isInside(root, realCandidate)) {
      throw new Error("拒绝通过符号链接访问 workspace 之外的路径");
    }
  }

  return candidate;
}
