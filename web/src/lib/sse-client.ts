import type { ExecutionMode, SSEEvent } from "../types.js";

export async function* streamChat(
  message: string,
  sessionId?: string,
  attachmentIds?: string[],
  signal?: AbortSignal,
  executionMode: ExecutionMode = "normal",
  turnId?: string,
  planId?: string,
): AsyncGenerator<SSEEvent> {
  const body: Record<string, unknown> = { message };
  if (sessionId) body.session_id = sessionId;
  if (attachmentIds?.length) body.attachments = attachmentIds;
  body.execution_mode = executionMode;
  if (turnId) body.turn_id = turnId;
  if (planId) body.plan_id = planId;

  yield* streamPost("/chat", body, signal);
}

export async function* streamApprovalResume(
  approvalId: string,
  action: "approve" | "approve-turn" | "reject" = "approve",
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const route = action === "approve-turn" ? "approve-turn-and-resume"
    : action === "reject" ? "reject-and-resume" : "approve-and-resume";
  yield* streamPost(`/approvals/${encodeURIComponent(approvalId)}/${route}`, undefined, signal);
}

export async function* streamPost(
  url: string,
  body: Record<string, unknown> | undefined,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const response = await fetch(url, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  yield* readStream(response, signal);
}

export async function* streamSessionEvents(sessionId: string, signal?: AbortSignal): AsyncGenerator<SSEEvent> {
  const response = await fetch(`/sessions/${encodeURIComponent(sessionId)}/events`, { signal });
  if (response.status === 204) return;
  yield* readStream(response, signal);
}

async function* readStream(response: Response, signal?: AbortSignal): AsyncGenerator<SSEEvent> {
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Chat request failed: ${response.status} ${error}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminalEventReceived = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n\n");
    buffer = parts.pop()!;

    for (const part of parts) {
      if (!part.trim()) continue;
      if (signal?.aborted) return;
      const event = parseSSEFrame(part);
      if (event) {
        if (event.event === "done" || event.event === "error") terminalEventReceived = true;
        yield event;
      }
    }
  }

  if (buffer.trim()) {
    const event = parseSSEFrame(buffer);
    if (event) {
      if (event.event === "done" || event.event === "error") terminalEventReceived = true;
      yield event;
    }
  }

  if (!terminalEventReceived && !signal?.aborted) {
    throw new Error("SSE 流在任务完成前意外中断");
  }
}

function parseSSEFrame(frame: string): SSEEvent | null {
  let event = "message";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event: ")) {
      event = line.slice(7);
    } else if (line.startsWith("data: ")) {
      data = line.slice(6);
    }
  }
  if (!data) return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}
