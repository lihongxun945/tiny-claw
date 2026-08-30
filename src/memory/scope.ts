import type { SessionContext } from "../types.js";

export type MemoryScope = "global" | `project:${string}`;

export function projectMemoryScope(root: string): MemoryScope {
  return `project:${root}`;
}

export function memoryScopeForSession(context?: SessionContext): MemoryScope {
  return context?.mode === "project" && context.project
    ? projectMemoryScope(context.project.root)
    : "global";
}

export function allowedMemoryScopes(context?: SessionContext): MemoryScope[] {
  const scope = memoryScopeForSession(context);
  return scope === "global" ? ["global"] : ["global", scope];
}

export function canAccessMemoryScope(scope: string, context?: SessionContext): boolean {
  return allowedMemoryScopes(context).includes(scope as MemoryScope);
}

export function resolveMemoryWriteScope(requestedScope: unknown, context?: SessionContext): MemoryScope | null {
  const fallback = memoryScopeForSession(context);
  if (typeof requestedScope !== "string" || !requestedScope.trim()) return fallback;
  const requested = requestedScope.trim();
  return canAccessMemoryScope(requested, context) ? requested as MemoryScope : null;
}

export function sessionContextForMemoryScope(scope: string): SessionContext {
  if (!scope.startsWith("project:")) return { mode: "chat" };
  const root = scope.slice("project:".length);
  return { mode: "project", project: { root, name: root.split("/").pop() || root } };
}
