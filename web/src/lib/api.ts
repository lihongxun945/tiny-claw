import type { Session, Message, MemoryRecord, ApprovalRequest, ChatCommand, Attachment, ModelCallSummary, ModelCallTrace } from "../types.js";

export { streamChat, streamApprovalResume } from "./sse-client.js";

export async function fetchSessions(): Promise<Session[]> {
  const res = await fetch("/sessions");
  const data = await res.json();
  return data.sessions ?? [];
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

export async function fetchHistorySessions(): Promise<Array<{ id: string; lastActivity: number; preview: string }>> {
  const res = await fetch("/history/sessions");
  const data = await res.json();
  return data.sessions ?? [];
}

export async function fetchHistoryMessages(id: string): Promise<Message[]> {
  const res = await fetch(`/history/sessions/${encodeURIComponent(id)}/messages`);
  const data = await res.json();
  return data.messages ?? [];
}

export async function fetchChatCommands(): Promise<ChatCommand[]> {
  const res = await fetch("/commands");
  const data = await parseJSON<{ commands: ChatCommand[] }>(res);
  return data.commands ?? [];
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

export async function fetchModelCalls(sessionId?: string): Promise<ModelCallSummary[]> {
  const query = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : "";
  const res = await fetch(`/debug/model-calls${query}`);
  const data = await parseJSON<{ traces: ModelCallSummary[] }>(res);
  return data.traces ?? [];
}

export async function fetchModelCall(requestId: string): Promise<ModelCallTrace> {
  const res = await fetch(`/debug/model-calls?id=${encodeURIComponent(requestId)}`);
  const data = await parseJSON<{ trace: ModelCallTrace }>(res);
  return data.trace;
}

export async function fetchConfig(): Promise<Record<string, unknown>> {
  const res = await fetch("/config");
  const data = await parseJSON<{ config: Record<string, unknown> }>(res);
  return data.config ?? {};
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

export async function testModel(target: "remote" | "local", config: Record<string, unknown>): Promise<{ elapsedMs: number; text: string }> {
  const res = await fetch("/models/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target, config }),
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

export async function rejectCommand(id: string): Promise<void> {
  const res = await fetch(`/approvals/${encodeURIComponent(id)}/reject`, { method: "POST" });
  await parseJSON(res);
}
