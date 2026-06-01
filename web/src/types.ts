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
}

export interface SSEEvent {
  event: string;
  data: unknown;
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
