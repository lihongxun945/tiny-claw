// === Message ===

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
  _timestamp?: number;
}

// === Config ===

export interface Config {
  apiUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  maxContextTokens: number;
  contextCompressionThreshold: number;
  historyWindowSize: number;
  maxAgentIterations: number;
  searchProvider: "searxng" | "brave" | "duckduckgo";
  searxngUrl?: string;
  braveApiKey?: string;
  enabledPlugins?: string[];
  externalPlugins?: string[];
  plugins?: Record<string, Record<string, unknown>>;
  subAgent?: SubAgentConfig;
  sessionSummary?: SessionSummaryConfig;
  workspacePath: string;
  systemPrompt: string;
}

export interface SubAgentConfig {
  allowedTools?: string[];
  disabledTools?: string[];
  maxIterations?: number;
  maxConcurrency?: number;
}

export interface SessionSummaryConfig {
  enabled?: boolean;
  recentTurns?: number;
  maxChars?: number;
}

// === Tool ===

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: ToolDefinition["input_schema"];
  execute: (args: Record<string, unknown>) => Promise<string>;
}

// === API Request ===

export interface CreateMessageRequest {
  model: string;
  max_tokens: number;
  messages: Message[];
  tools?: ToolDefinition[];
  stream: boolean;
}

// === API Response ===

export interface ChatResponse {
  text: string;
  toolCalls: ToolUseBlock[];
}

// === Stream Events ===

export interface TextDelta {
  type: "text_delta";
  text: string;
}

export interface ThinkingDelta {
  type: "thinking_delta";
  thinking: string;
}

export interface InputJsonDelta {
  type: "input_json_delta";
  partial_json: string;
}

export interface ContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: TextDelta | ThinkingDelta | InputJsonDelta;
}

export interface ContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block: TextBlock | ToolUseBlock;
}

export type StreamEvent =
  | { type: "message_start" }
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | { type: "content_block_stop" }
  | { type: "message_delta" }
  | { type: "message_stop" };
