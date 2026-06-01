import type { Session, Message, MemoryRecord } from "../types.js";

export { streamChat } from "./sse-client.js";

export async function fetchSessions(): Promise<Session[]> {
  const res = await fetch("/sessions");
  const data = await res.json();
  return data.sessions ?? [];
}

export async function deleteSession(id: string): Promise<void> {
  await fetch(`/sessions/${id}`, { method: "DELETE" });
}

export async function fetchMessages(id: string): Promise<Message[]> {
  const res = await fetch(`/sessions/${id}/messages`);
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

export async function fetchLogFiles(): Promise<{ files: Array<{ name: string; size: number }> }> {
  const res = await fetch("/logs");
  return res.json();
}

export async function fetchLog(date: string, tail = 200): Promise<{ date: string; lines: string[] }> {
  const res = await fetch(`/logs/${date}?tail=${tail}`);
  return res.json();
}

export async function fetchConfig(): Promise<Record<string, unknown>> {
  const res = await fetch("/config");
  const data = await res.json();
  return data.config ?? {};
}

export async function updateConfig(config: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch("/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(config),
  });
  const data = await res.json();
  return data.config ?? {};
}

async function parseJSON<T>(res: Response): Promise<T> {
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error ?? data.message ?? `HTTP ${res.status}`);
  }
  return data;
}

export async function fetchMemories(): Promise<MemoryRecord[]> {
  const res = await fetch("/memory?include_sensitive=true&include_disabled=true");
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
