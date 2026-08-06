import type { Message, ToolCallInfo } from "../types.js";

function hasApprovalId(toolCall: ToolCallInfo, approvalId: string): boolean {
  if (!toolCall.result) return false;
  try {
    const value = JSON.parse(toolCall.result) as { approvalId?: unknown };
    return value.approvalId === approvalId;
  } catch {
    return false;
  }
}

export function mergeApprovalResume(
  messages: Message[],
  approvalId: string,
  text: string,
  resumedToolCalls: ToolCallInfo[],
  metadata?: Pick<Message, "turnId" | "plan">,
): Message[] {
  const messageIndex = messages.findIndex((message) => (
    message.role === "assistant"
    && message.toolCalls.some((toolCall) => hasApprovalId(toolCall, approvalId))
  ));
  if (messageIndex < 0) {
    return [...messages, {
      role: "assistant",
      text,
      toolCalls: resumedToolCalls,
      timestamp: Date.now(),
      ...metadata,
    }];
  }

  const next = [...messages];
  const target = messages[messageIndex];
  const toolCalls = target.toolCalls.map((toolCall) => ({ ...toolCall }));
  for (const resumed of resumedToolCalls) {
    const existingIndex = resumed.id
      ? toolCalls.findIndex((toolCall) => toolCall.id === resumed.id)
      : -1;
    if (existingIndex >= 0) toolCalls[existingIndex] = { ...resumed };
    else toolCalls.push({ ...resumed });
  }

  next[messageIndex] = {
    ...target,
    text: text ? [target.text, text].filter(Boolean).join("\n") : target.text,
    toolCalls,
    ...metadata,
  };
  return next;
}
