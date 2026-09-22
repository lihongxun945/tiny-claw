import type { Session, Message, MemoryRecord, ProfileRecord, ApprovalRequest, ChatCommand, Attachment, ModelCallSummary, ModelCallTrace, ProjectInfo, ProjectGitStatus, ProjectDiff, SessionContext, SessionPlan, ExecutionMode, PluginSnapshot, PluginConfigView, ContextSnapshot, ModelInfo } from "../types.js";

export { streamChat, streamApprovalResume, streamSessionEvents } from "./sse-client.js";

export async function projectSettings(path: string, trusted?: boolean, signal?: AbortSignal): Promise<{ root: string; trusted: boolean }> {
  return parseJSON(await fetch("/projects/settings", {
    method: trusted === undefined ? "POST" : "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, trusted }), signal,
  }));
}

export async function fetchSessions(): Promise<Session[]> {
  const res = await fetch("/sessions");
  const data = await res.json();
  return data.sessions ?? [];
}

export async function fetchPlugins(): Promise<PluginSnapshot[]> {
  const data = await parseJSON<{ plugins: PluginSnapshot[] }>(await fetch("/plugins"));
  return data.plugins ?? [];
}

export async function fetchPluginConfig(id: string): Promise<PluginConfigView> {
  return parseJSON<PluginConfigView>(await fetch(`/plugins/${encodeURIComponent(id)}/config`));
}

export async function updatePluginConfig(id: string, config: Record<string, unknown>): Promise<PluginConfigView> {
  return parseJSON<PluginConfigView>(await fetch(`/plugins/${encodeURIComponent(id)}/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(config),
  }));
}

export async function updatePluginState(id: string, enabled: boolean): Promise<PluginSnapshot> {
  const data = await parseJSON<{ plugin: PluginSnapshot }>(await fetch(`/plugins/${encodeURIComponent(id)}/state`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  }));
  return data.plugin;
}

export async function deleteSession(id: string): Promise<void> {
  const res = await fetch(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  await parseJSON(res);
}

export async function cancelSession(id: string): Promise<void> {
  const res = await fetch(`/sessions/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  if (!res.ok && res.status !== 409) {
    const data = await res.json();
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
}

export async function fetchMessages(id: string): Promise<Message[]> {
  const res = await fetch(`/sessions/${encodeURIComponent(id)}/messages`);
  const data = await res.json();
  return data.messages ?? [];
}

export async function fetchHistorySessions(): Promise<Session[]> {
  const res = await fetch("/history/sessions");
  const data = await res.json();
  return data.sessions ?? [];
}

export async function fetchHistoryMessages(id: string): Promise<Message[]> {
  const res = await fetch(`/history/sessions/${encodeURIComponent(id)}/messages`);
  const data = await res.json();
  return data.messages ?? [];
}

export async function fetchSessionPlans(id: string): Promise<SessionPlan[]> {
  return (await fetchSessionPlanState(id)).plans;
}

export async function fetchSessionPlanState(id: string): Promise<{ plans: SessionPlan[]; activePlan: SessionPlan | null; currentTurnId?: string; run?: import("../types.js").RunView }> {
  const res = await fetch(`/plan?session_id=${encodeURIComponent(id)}`);
  const data = await parseJSON<{ plans: SessionPlan[]; activePlan?: SessionPlan | null; currentTurnId?: string; run?: import("../types.js").RunView }>(res);
  return { plans: data.plans ?? [], activePlan: data.activePlan ?? null, currentTurnId: data.currentTurnId, run: data.run };
}

export async function fetchChatCommands(): Promise<ChatCommand[]> {
  const res = await fetch("/commands");
  const data = await parseJSON<{ commands: ChatCommand[] }>(res);
  return data.commands ?? [];
}

export async function fetchContextSnapshot(sessionId: string): Promise<ContextSnapshot | null> {
  const res = await fetch(`/context?session_id=${encodeURIComponent(sessionId)}`);
  if (res.status === 404) return null;
  return (await parseJSON<{ snapshot: ContextSnapshot }>(res)).snapshot;
}

export async function uploadImage(sessionId: string, file: File): Promise<Attachment> {
  const form = new FormData();
  form.set("session_id", sessionId);
  form.set("file", file);
  const res = await fetch("/uploads", { method: "POST", body: form });
  const data = await parseJSON<{ attachment: Attachment }>(res);
  return data.attachment;
}

export async function fetchLogFiles(): Promise<{ files: Array<{ name: string; size: number }> }> {
  const res = await fetch("/logs");
  return res.json();
}

export async function fetchLog(date: string, tail = 200): Promise<{ date: string; lines: string[] }> {
  const res = await fetch(`/logs/${date}?tail=${tail}`);
  return res.json();
}

export async function fetchModelCalls(sessionId?: string, page = 1, pageSize = 20, signal?: AbortSignal): Promise<{ traces: ModelCallSummary[]; page: number; pageSize: number; total: number }> {
  const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (sessionId) query.set("session_id", sessionId);
  const res = await fetch(`/debug/model-calls?${query}`, { signal });
  return parseJSON(res);
}

export async function fetchModelCall(requestId: string, signal?: AbortSignal): Promise<ModelCallTrace> {
  const res = await fetch(`/debug/model-calls?id=${encodeURIComponent(requestId)}&view=display`, { signal });
  const data = await parseJSON<{ trace: ModelCallTrace }>(res);
  return data.trace;
}

export async function fetchConfig(): Promise<Record<string, unknown>> {
  return (await fetchConfigSettings()).config;
}

export async function fetchConfigSettings(): Promise<{ config: Record<string, unknown>; defaults: Record<string, unknown> }> {
  const res = await fetch("/config");
  const data = await parseJSON<{ config: Record<string, unknown>; defaults?: Record<string, unknown> }>(res);
  return { config: data.config ?? {}, defaults: data.defaults ?? {} };
}

export async function updateConfig(config: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch("/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(config),
  });
  const data = await parseJSON<{ config: Record<string, unknown> }>(res);
  return data.config ?? {};
}

export interface LocalModelStatus {
  id: string;
  name: string;
  description: string;
  size: string;
  family: "Qwen" | "Gemma";
  license: "Apache-2.0";
  recommendedMemoryGb: number;
  recommendedContextTokens: number;
  maxContextTokens: number;
  installed: boolean;
  status: "idle" | "downloading" | "ready" | "error";
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  error?: string;
}

export async function fetchLocalModels(): Promise<LocalModelStatus[]> {
  const res = await fetch("/local-models");
  return (await parseJSON<{ models: LocalModelStatus[] }>(res)).models;
}

export async function downloadLocalModel(modelId: string): Promise<void> {
  const res = await fetch("/local-models/download", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ modelId }),
  });
  await parseJSON(res);
}

export async function testModel(target: "remote" | "local", config: Record<string, unknown>, modelId?: string): Promise<{ elapsedMs: number; text: string }> {
  const res = await fetch("/models/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target, config, modelId }),
  });
  return parseJSON(res);
}

async function parseJSON<T>(res: Response): Promise<T> {
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error ?? data.message ?? `HTTP ${res.status}`);
  }
  return data;
}

export async function fetchMemories(): Promise<MemoryRecord[]> {
  const res = await fetch("/memory?include_disabled=true");
  const data = await parseJSON<{ memories: MemoryRecord[] }>(res);
  return data.memories ?? [];
}

export async function fetchMemory(name: string): Promise<MemoryRecord> {
  const res = await fetch(`/memory/${encodeURIComponent(name)}`);
  const data = await parseJSON<{ memory: MemoryRecord }>(res);
  return data.memory;
}

export async function updateMemory(name: string, memory: Partial<MemoryRecord>): Promise<MemoryRecord> {
  const res = await fetch(`/memory/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(memory),
  });
  const data = await parseJSON<{ memory: MemoryRecord }>(res);
  return data.memory;
}

export async function setMemoryEnabled(name: string, enabled: boolean): Promise<MemoryRecord> {
  const res = await fetch(`/memory/${encodeURIComponent(name)}/${enabled ? "enable" : "disable"}`, {
    method: "POST",
  });
  const data = await parseJSON<{ memory: MemoryRecord }>(res);
  return data.memory;
}

export async function deleteMemory(name: string): Promise<void> {
  const res = await fetch(`/memory/${encodeURIComponent(name)}`, { method: "DELETE" });
  await parseJSON(res);
}

export async function fetchProfiles(): Promise<ProfileRecord[]> {
  const data = await parseJSON<{ profiles: ProfileRecord[] }>(await fetch("/profile"));
  return data.profiles ?? [];
}

export async function fetchProfile(name: string): Promise<ProfileRecord> {
  const res = await fetch("/profile/get", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
  return (await parseJSON<{ profile: ProfileRecord }>(res)).profile;
}

export async function updateProfile(profile: Partial<ProfileRecord> & { name: string; content: string }): Promise<ProfileRecord> {
  const res = await fetch("/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(profile) });
  return (await parseJSON<{ profile: ProfileRecord }>(res)).profile;
}

export async function deleteProfile(name: string): Promise<void> {
  const res = await fetch("/profile", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
  await parseJSON(res);
}

export async function fetchApprovals(): Promise<ApprovalRequest[]> {
  const res = await fetch("/approvals");
  const data = await parseJSON<{ approvals: ApprovalRequest[] }>(res);
  return data.approvals ?? [];
}

export async function approveCommand(id: string): Promise<ApprovalRequest> {
  const res = await fetch(`/approvals/${encodeURIComponent(id)}/approve`, { method: "POST" });
  const data = await parseJSON<{ approval: ApprovalRequest }>(res);
  return data.approval;
}

export async function renewCommand(id: string): Promise<ApprovalRequest> {
  const res = await fetch(`/approvals/${encodeURIComponent(id)}/renew`, { method: "POST" });
  return (await parseJSON<{ approval: ApprovalRequest }>(res)).approval;
}

export async function rejectCommand(id: string): Promise<void> {
  const res = await fetch(`/approvals/${encodeURIComponent(id)}/reject`, { method: "POST" });
  await parseJSON(res);
}

export async function fetchProjectInfo(projectPath: string, signal?: AbortSignal): Promise<ProjectInfo> {
  const res = await fetch("/projects/inspect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: projectPath }),
    signal,
  });
  const data = await parseJSON<{ project: ProjectInfo }>(res);
  return data.project;
}

export async function fetchProjectStatus(projectPath: string): Promise<ProjectGitStatus> {
  const res = await fetch("/projects/status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: projectPath }),
  });
  return (await parseJSON<{ status: ProjectGitStatus }>(res)).status;
}

export async function fetchProjectDiff(projectPath: string, file: string): Promise<ProjectDiff> {
  const res = await fetch("/projects/diff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: projectPath, file }),
  });
  return (await parseJSON<{ diff: ProjectDiff }>(res)).diff;
}

export async function createSession(mode: "chat" | "project", projectRoot?: string, reuseEmpty = false, signal?: AbortSignal): Promise<{ id: string; context: SessionContext; executionMode: ExecutionMode; reused?: boolean }> {
  const res = await fetch("/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode, projectRoot, reuseEmpty }),
    signal,
  });
  const data = await parseJSON<{ session: { id: string; context: SessionContext; executionMode: ExecutionMode; reused?: boolean } }>(res);
  return data.session;
}

export async function updateSessionExecutionMode(id: string, executionMode: ExecutionMode): Promise<void> {
  const res = await fetch(`/sessions/${encodeURIComponent(id)}/execution-mode`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ executionMode }),
  });
  await parseJSON(res);
}

export async function fetchModels(): Promise<{ models: ModelInfo[]; defaultModelId?: string }> {
  const data = await parseJSON<{ models: ModelInfo[]; defaultModelId?: string }>(await fetch("/models"));
  return { models: data.models ?? [], defaultModelId: data.defaultModelId };
}

export async function updateSessionModel(id: string, modelId: string): Promise<{ id: string; name?: string }> {
  const res = await fetch(`/sessions/${encodeURIComponent(id)}/model`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ modelId }),
  });
  return parseJSON<{ id: string; name?: string }>(res);
}
