import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentActor, ExecutionMode, ToolUseBlock } from "../types.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface ApprovalRequest {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  command?: string;
  cwd?: string;
  status: "pending" | "approved" | "expired";
  createdAt: string;
  expiresAt: string;
  actor?: AgentActor;
  sessionId?: string;
}

export interface PendingApprovalContinuation {
  toolCall: ToolUseBlock;
  displayResult?: string;
  skippedToolCalls: ToolUseBlock[];
  iteration: number;
  executionMode: ExecutionMode;
  turnId: string;
}

interface StoredApproval extends ApprovalRequest {
  version: 1;
  continuation?: PendingApprovalContinuation;
}

interface ApprovalScope {
  byId: Map<string, ApprovalRequest>;
  byKey: Map<string, string>;
  turnGrants: Map<string, string>;
}

const scopes = new Map<string, ApprovalScope>();

function getScope(workspacePath: string): ApprovalScope {
  let scope = scopes.get(workspacePath);
  if (!scope) {
    scope = { byId: new Map(), byKey: new Map(), turnGrants: new Map() };
    const dir = approvalsDir(workspacePath);
    if (existsSync(dir)) {
      for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
        try {
          const approval = JSON.parse(readFileSync(resolve(dir, file), "utf-8")) as StoredApproval;
          if (!approval.id || !approval.toolName || !approval.sessionId) continue;
          scope.byId.set(approval.id, approval);
          scope.byKey.set(keyOf(approval.toolName, approval.args, approval.actor, approval.sessionId), approval.id);
        } catch {
          // Ignore malformed runtime records; reconciliation handles orphaned plans.
        }
      }
    }
    scopes.set(workspacePath, scope);
  }
  return scope;
}

function approvalsDir(workspacePath: string): string {
  return resolve(workspacePath, "approvals");
}

function approvalPath(workspacePath: string, id: string): string | undefined {
  return /^[A-Za-z0-9_-]+$/.test(id) ? resolve(approvalsDir(workspacePath), `${id}.json`) : undefined;
}

function persist(workspacePath: string, approval: ApprovalRequest): void {
  const path = approvalPath(workspacePath, approval.id);
  if (!path) throw new Error("无效审批 ID");
  mkdirSync(approvalsDir(workspacePath), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({ version: 1, ...approval }, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  renameSync(tempPath, path);
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

function keyOf(toolName: string, args: Record<string, unknown>, actor?: AgentActor, sessionId?: string): string {
  return `${toolName}\0${stableStringify(args)}\0${actor?.channel ?? ""}\0${actor?.requesterId ?? ""}\0${actor?.chatId ?? ""}\0${sessionId ?? ""}`;
}

function remove(workspacePath: string, scope: ApprovalScope, approval: ApprovalRequest): void {
  scope.byId.delete(approval.id);
  scope.byKey.delete(keyOf(approval.toolName, approval.args, approval.actor, approval.sessionId));
  const path = approvalPath(workspacePath, approval.id);
  if (path && existsSync(path)) unlinkSync(path);
}

function cleanup(workspacePath: string, scope: ApprovalScope): void {
  const now = Date.now();
  for (const approval of scope.byId.values()) {
    if (approval.status !== "expired" && Date.parse(approval.expiresAt) <= now) {
      approval.status = "expired";
      persist(workspacePath, approval);
    }
  }
  for (const [key, expiresAt] of scope.turnGrants) {
    if (Date.parse(expiresAt) <= now) scope.turnGrants.delete(key);
  }
}

function turnGrantKey(sessionId: string, actor?: AgentActor): string {
  return `${sessionId}\0${actor?.channel ?? ""}\0${actor?.requesterId ?? ""}\0${actor?.chatId ?? ""}`;
}

export function requestApproval(
  workspacePath: string,
  toolName: string,
  args: Record<string, unknown>,
  ttlMs = DEFAULT_TTL_MS,
  actor?: AgentActor,
  sessionId?: string,
  display: { command?: string; cwd?: string } = {},
): { approved: boolean; approval?: ApprovalRequest; source?: "single" | "turn" } {
  const scope = getScope(workspacePath);
  cleanup(workspacePath, scope);
  const key = keyOf(toolName, args, actor, sessionId);
  const existingId = scope.byKey.get(key);
  const existing = existingId ? scope.byId.get(existingId) : undefined;

  if (existing?.status === "approved") {
    remove(workspacePath, scope, existing);
    return { approved: true, source: "single" };
  }
  if (existing) return { approved: false, approval: existing };
  if (sessionId && scope.turnGrants.has(turnGrantKey(sessionId, actor))) {
    return { approved: true, source: "turn" };
  }

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
  persist(workspacePath, approval);
  return { approved: false, approval };
}

export function listApprovals(workspacePath: string, actor?: AgentActor): ApprovalRequest[] {
  const scope = getScope(workspacePath);
  cleanup(workspacePath, scope);
  return Array.from(scope.byId.values())
    .filter((approval) => !actor || canManageApproval(approval, actor))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getApprovalRequest(workspacePath: string, id: string, actor?: AgentActor): ApprovalRequest | undefined {
  const scope = getScope(workspacePath);
  cleanup(workspacePath, scope);
  const approval = scope.byId.get(id);
  return approval && (!actor || canManageApproval(approval, actor)) ? approval : undefined;
}

function canManageApproval(approval: ApprovalRequest, actor: AgentActor): boolean {
  if (!approval.actor?.requesterId) return false;
  return approval.actor.channel === actor.channel
    && approval.actor.requesterId === actor.requesterId
    && approval.actor.chatId === actor.chatId;
}

export function approveRequest(workspacePath: string, id: string, actor?: AgentActor): ApprovalRequest | undefined {
  const scope = getScope(workspacePath);
  cleanup(workspacePath, scope);
  const approval = scope.byId.get(id);
  if (!approval || approval.status === "expired" || (actor && !canManageApproval(approval, actor))) return undefined;
  approval.status = "approved";
  persist(workspacePath, approval);
  return approval;
}

export function approveTurnRequest(workspacePath: string, id: string, actor?: AgentActor): ApprovalRequest | undefined {
  const scope = getScope(workspacePath);
  cleanup(workspacePath, scope);
  const approval = scope.byId.get(id);
  if (!approval?.sessionId || approval.status === "expired" || (actor && !canManageApproval(approval, actor))) return undefined;
  approval.status = "approved";
  persist(workspacePath, approval);
  scope.turnGrants.set(turnGrantKey(approval.sessionId, approval.actor), approval.expiresAt);
  return approval;
}

export function clearTurnApproval(workspacePath: string, sessionId: string, actor?: AgentActor): void {
  const scope = getScope(workspacePath);
  scope.turnGrants.delete(turnGrantKey(sessionId, actor));
}

/** Renew the request, never the authorization; preserve the suspended tool call. */
export function renewApprovalRequest(workspacePath: string, id: string, ttlMs = DEFAULT_TTL_MS, actor?: AgentActor): ApprovalRequest | undefined {
  const approval = getApprovalRequest(workspacePath, id, actor);
  if (!approval || approval.status !== "expired") return undefined;
  approval.status = "pending";
  approval.expiresAt = new Date(Date.now() + ttlMs).toISOString();
  persist(workspacePath, approval);
  return approval;
}

export function hasTurnApproval(workspacePath: string, sessionId: string, actor?: AgentActor): boolean {
  const scope = getScope(workspacePath);
  cleanup(workspacePath, scope);
  return scope.turnGrants.has(turnGrantKey(sessionId, actor));
}

export function rejectRequest(workspacePath: string, id: string, actor?: AgentActor): boolean {
  const scope = getScope(workspacePath);
  cleanup(workspacePath, scope);
  const approval = scope.byId.get(id);
  if (!approval || (actor && !canManageApproval(approval, actor))) return false;
  remove(workspacePath, scope, approval);
  return true;
}

export function attachApprovalContinuation(
  workspacePath: string,
  id: string,
  continuation: PendingApprovalContinuation,
): boolean {
  const approval = getScope(workspacePath).byId.get(id) as StoredApproval | undefined;
  if (!approval) return false;
  approval.continuation = continuation;
  persist(workspacePath, approval);
  return true;
}

export function listSessionApprovalContinuations(
  workspacePath: string,
  sessionId: string,
): Array<{ approval: ApprovalRequest; continuation: PendingApprovalContinuation }> {
  const scope = getScope(workspacePath);
  cleanup(workspacePath, scope);
  return Array.from(scope.byId.values())
    .filter((approval) => approval.sessionId === sessionId && (approval as StoredApproval).continuation)
    .map((approval) => ({ approval, continuation: (approval as StoredApproval).continuation! }));
}

export function clearApproval(workspacePath: string, id: string): void {
  const scope = getScope(workspacePath);
  const approval = scope.byId.get(id);
  if (approval) remove(workspacePath, scope, approval);
}

export function clearSessionApprovals(workspacePath: string, sessionId: string): void {
  const scope = getScope(workspacePath);
  for (const approval of Array.from(scope.byId.values())) {
    if (approval.sessionId === sessionId) remove(workspacePath, scope, approval);
  }
}
