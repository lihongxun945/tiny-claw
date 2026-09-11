import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { sessionDir } from "./session-store.js";
import type { ExecutionMode, ToolUseBlock, AgentActor } from "./types.js";
import type { AgentStatusUpdate } from "./plugins/types.js";

export type RunState = "running" | "waiting_approval" | "waiting_user" | "completed" | "interrupted" | "cancelled";
export interface SessionRun {
  suspension?: {
    id: string;
    kind: string;
    payload: Record<string, unknown>;
    status: "pending" | "answered" | "cancelled";
    toolCall: ToolUseBlock;
    skippedToolCalls: ToolUseBlock[];
    iteration: number;
    actor?: AgentActor;
    result?: string;
  };
  id: string;
  turnId: string;
  executionMode: ExecutionMode;
  state: RunState;
  status?: AgentStatusUpdate;
  reason?: string;
  approvalId?: string;
  planId?: string;
  selectedPlanId?: string;
  pendingToolCallId?: string;
  revision: number;
  ordinal: number;
  updatedAt: string;
  startedAt?: number;
  completedAt?: number;
  toolTimings?: Record<string, { startedAt: number; completedAt?: number }>;
  owner: string;
  ownerPid: number;
}

const owner = randomUUID();
function file(workspace: string, session: string, turn: string): string {
  return resolve(sessionDir(workspace, session), "runs", `${encodeURIComponent(turn)}.json`);
}
function save(workspace: string, session: string, run: SessionRun): SessionRun {
  const path = file(workspace, session, run.turnId);
  mkdirSync(resolve(sessionDir(workspace, session), "runs"), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(run), { mode: 0o600 });
  renameSync(temp, path);
  return run;
}
export function readRun(workspace: string, session: string, turn: string): SessionRun | undefined {
  const path = file(workspace, session, turn);
  if (!existsSync(path)) return;
  const run = JSON.parse(readFileSync(path, "utf8")) as SessionRun;
  if (run.turnId !== turn) throw new Error("运行记录轮次不匹配");
  let ownerAlive = false;
  if (run.ownerPid > 0 && run.ownerPid !== process.pid) {
    try { process.kill(run.ownerPid, 0); ownerAlive = true; } catch { /* The old process has exited. */ }
  }
  if (run.state === "running" && run.owner !== owner && !ownerAlive) {
    return save(workspace, session, { ...run, state: "interrupted", reason: "服务重启，先核实上次操作结果再继续", completedAt: Date.parse(run.updatedAt), revision: run.revision + 1, updatedAt: new Date().toISOString() });
  }
  return run;
}
export function listRuns(workspace: string, session: string): SessionRun[] {
  const dir = resolve(sessionDir(workspace, session), "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json"))
    .map((name) => readRun(workspace, session, decodeURIComponent(name.slice(0, -5)))!)
    .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0) || a.updatedAt.localeCompare(b.updatedAt));
}
export function startRun(workspace: string, session: string, turnId: string, executionMode: ExecutionMode, approvalId?: string, selectedPlanId?: string, suspensionAnswer?: { id: string; result: string }): SessionRun {
  const previous = readRun(workspace, session, turnId);
  if (previous && !(suspensionAnswer && previous.state === "waiting_user" && previous.suspension?.id === suspensionAnswer.id && previous.suspension.status === "pending") && (!approvalId || previous.state !== "waiting_approval" || previous.approvalId !== approvalId)) {
    throw new Error("该轮次已有运行记录，不能重复执行；请发起新轮次");
  }
  return save(workspace, session, { ...previous, id: previous?.id ?? randomUUID(), turnId, executionMode,
    ordinal: previous?.ordinal ?? (listRuns(workspace, session).at(-1)?.ordinal ?? 0) + 1,
    state: "running", status: undefined, reason: undefined, approvalId: undefined, selectedPlanId,
    ...(suspensionAnswer && previous?.suspension ? { suspension: { ...previous.suspension, status: "answered" as const, result: suspensionAnswer.result } } : {}),
    startedAt: previous ? previous.startedAt : Date.now(), completedAt: undefined,
    owner, ownerPid: process.pid, revision: (previous?.revision ?? 0) + 1, updatedAt: new Date().toISOString() });
}
export function updateRun(workspace: string, session: string, turn: string, patch: Partial<Pick<SessionRun, "state" | "status" | "reason" | "approvalId" | "planId" | "pendingToolCallId" | "toolTimings" | "suspension">>): SessionRun | undefined {
  const run = readRun(workspace, session, turn);
  if (!run) return;
  const state = patch.state ?? run.state;
  const completedAt = state === "running" || state === "waiting_approval" || (state === "waiting_user" && (patch.suspension ?? run.suspension)?.status === "pending") ? undefined : run.completedAt ?? Date.now();
  return save(workspace, session, { ...run, ...patch, completedAt, revision: run.revision + 1, updatedAt: new Date().toISOString() });
}
