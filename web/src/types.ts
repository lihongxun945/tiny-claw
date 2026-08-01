export interface ToolCallInfo {
  name: string;
  input: Record<string, unknown>;
  result?: string;
}

export interface Attachment {
  id: string;
  name: string;
  mediaType: string;
  size?: number;
  url: string;
}

export interface Message {
  role: "user" | "assistant";
  text: string;
  toolCalls: ToolCallInfo[];
  attachments?: Attachment[];
  timestamp: number;
}

export interface Session {
  id: string;
  lastActivity: number;
  preview?: string;
  busy?: boolean;
}

export interface SSEEvent {
  event: string;
  data: unknown;
}

export interface ChatCommand {
  name: string;
  aliases: string[];
  description: string;
  usage: string;
}

export interface ApprovalRequest {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  command?: string;
  cwd?: string;
  status: "pending" | "approved";
  createdAt: string;
  expiresAt: string;
  actor?: {
    channel: "cli" | "web" | "feishu";
    requesterId?: string;
    chatId?: string;
  };
  sessionId?: string;
}

export type ModelDebugPhase = "request" | "response" | "parsed_response" | "error" | "repair" | "stream_event";

export interface ModelCallSummary {
  requestId: string;
  sessionId?: string;
  provider: string;
  model: string;
  mode: "chat" | "complete";
  startedAt: string;
  updatedAt: string;
  durationMs?: number;
  status: "running" | "success" | "error";
  eventCount: number;
}

export interface ModelCallTrace extends Omit<ModelCallSummary, "eventCount"> {
  events: Array<{
    timestamp: string;
    phase: ModelDebugPhase;
    data: unknown;
  }>;
}

export type MemorySource = "manual" | "tool" | "auto";

export interface MemoryRecord {
  name: string;
  summary: string;
  content: string;
  tags: string[];
  scope: string;
  disabled: boolean;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
}
