export interface ToolCallInfo {
  name: string;
  input: Record<string, unknown>;
  result?: string;
}

export interface Message {
  role: "user" | "assistant";
  text: string;
  toolCalls: ToolCallInfo[];
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

export type MemorySource = "manual" | "tool" | "auto";

export interface MemoryRecord {
  name: string;
  summary: string;
  content: string;
  tags: string[];
  scope: string;
  sensitive: boolean;
  disabled: boolean;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
}
