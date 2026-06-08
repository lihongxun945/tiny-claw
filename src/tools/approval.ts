import { randomUUID } from "node:crypto";
import type { AgentActor } from "../types.js";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export interface ApprovalRequest {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  command?: string;
  cwd?: string;
  status: "pending" | "approved";
  createdAt: string;
  expiresAt: string;
  actor?: AgentActor;
  sessionId?: string;
}

interface ApprovalScope {
  byId: Map<string, ApprovalRequest>;
  byKey: Map<string, string>;
}

const scopes = new Map<string, ApprovalScope>();

function getScope(workspacePath: string): ApprovalScope {
  let scope = scopes.get(workspacePath);
  if (!scope) {
    scope = { byId: new Map(), byKey: new Map() };
    scopes.set(workspacePath, scope);
  }
  return scope;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function keyOf(toolName: string, args: Record<string, unknown>, actor?: AgentActor): string {
  return `${toolName}\0${stableStringify(args)}\0${actor?.channel ?? ""}\0${actor?.requesterId ?? ""}\0${actor?.chatId ?? ""}`;
}

function remove(scope: ApprovalScope, approval: ApprovalRequest): void {
  scope.byId.delete(approval.id);
  scope.byKey.delete(keyOf(approval.toolName, approval.args, approval.actor));
}

function cleanup(scope: ApprovalScope): void {
  const now = Date.now();
  for (const approval of scope.byId.values()) {
    if (Date.parse(approval.expiresAt) <= now) remove(scope, approval);
  }
}

export function requestApproval(
  workspacePath: string,
  toolName: string,
  args: Record<string, unknown>,
  ttlMs = DEFAULT_TTL_MS,
  actor?: AgentActor,
  sessionId?: string,
  display: { command?: string; cwd?: string } = {},
): { approved: boolean; approval?: ApprovalRequest } {
  const scope = getScope(workspacePath);
  cleanup(scope);
  const key = keyOf(toolName, args, actor);
  const existingId = scope.byKey.get(key);
  const existing = existingId ? scope.byId.get(existingId) : undefined;

  if (existing?.status === "approved") {
    remove(scope, existing);
    return { approved: true };
  }
  if (existing) return { approved: false, approval: existing };

  const createdAt = new Date();
  const approval: ApprovalRequest = {
    id: randomUUID(),
    toolName,
    args,
    command: display.command,
    cwd: display.cwd,
    status: "pending",
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
    actor,
    sessionId,
  };
  scope.byId.set(approval.id, approval);
  scope.byKey.set(key, approval.id);
  return { approved: false, approval };
}

export function listApprovals(workspacePath: string, actor?: AgentActor): ApprovalRequest[] {
  const scope = getScope(workspacePath);
  cleanup(scope);
  return Array.from(scope.byId.values())
    .filter((approval) => !actor || canManageApproval(approval, actor))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function canManageApproval(approval: ApprovalRequest, actor: AgentActor): boolean {
  if (!approval.actor?.requesterId) return false;
  return approval.actor.channel === actor.channel
    && approval.actor.requesterId === actor.requesterId
    && approval.actor.chatId === actor.chatId;
}

export function approveRequest(workspacePath: string, id: string, actor?: AgentActor): ApprovalRequest | undefined {
  const scope = getScope(workspacePath);
  cleanup(scope);
  const approval = scope.byId.get(id);
  if (!approval || (actor && !canManageApproval(approval, actor))) return undefined;
  approval.status = "approved";
  return approval;
}

export function rejectRequest(workspacePath: string, id: string, actor?: AgentActor): boolean {
  const scope = getScope(workspacePath);
  cleanup(scope);
  const approval = scope.byId.get(id);
  if (!approval || (actor && !canManageApproval(approval, actor))) return false;
  remove(scope, approval);
  return true;
}
