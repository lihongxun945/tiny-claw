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

export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface ImageBlock {
  type: "image";
  source: {
    type: "attachment";
    path: string;
    mediaType: ImageMediaType;
  };
  id: string;
  name: string;
}

export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
  _timestamp?: number;
}

// === Config ===

export interface Config {
  remoteModel?: RemoteModelConfig;
  localModel?: LocalModelConfig;
  apiUrl: string;
  apiKey: string;
  model: string;
  modelProvider?: string;
  maxTokens: number;
  maxContextTokens: number;
  contextCompressionThreshold: number;
  contextCompressionMaxChars: number;
  contextCompressionToolResultMaxChars: number;
  toolResultInitialMaxChars: number;
  historyWindowSize: number;
  maxAgentIterations: number;
  searchProvider: "ollama" | "searxng" | "brave" | "duckduckgo";
  ollamaApiKey?: string;
  searxngUrl?: string;
  braveApiKey?: string;
  enabledPlugins?: string[];
  externalPlugins?: string[];
  plugins?: Record<string, Record<string, unknown>>;
  subAgent?: SubAgentConfig;
  sessionSummary?: SessionSummaryConfig;
  autoMemory?: AutoMemoryConfig;
  memory?: MemoryConfig;
  attachments?: AttachmentsConfig;
  debug?: boolean | DebugConfig;
  security?: SecurityConfig;
  workspacePath: string;
  systemPrompt: string;
}

export interface RemoteModelConfig {
  enabled?: boolean;
}

export type LocalModelId =
  | "qwen3.5-0.8b-q4"
  | "qwen3.5-2b-q4"
  | "qwen3.5-4b-q4"
  | "qwen3.5-9b-q4"
  | "qwen3.5-27b-q4"
  | "qwen3.5-35b-a3b-q4"
  | "gemma-4-e2b-it-q4"
  | "gemma-4-e4b-it-q4"
  | "gemma-4-12b-it-q4"
  | "gemma-4-26b-a4b-it-q4"
  | "gemma-4-31b-it-q4";

export interface LocalModelConfig {
  enabled?: boolean;
  modelId?: LocalModelId;
  contextSize?: number;
}

export interface SubAgentConfig {
  allowedTools?: string[];
  disabledTools?: string[];
  maxIterations?: number;
  maxConcurrency?: number;
}

export interface SessionSummaryConfig {
  enabled?: boolean;
  persistent?: boolean;
  turnThreshold?: number;
  recentTurns?: number;
  /** 摘要输入（本次新增上下文）字符上限（默认 40000） */
  maxInputChars?: number;
  /** 摘要存储字符上限（默认 10000） */
  maxChars?: number;
  /** 摘要 LLM 输出的 token 上限（默认 10000），避免通用 complete 的 1024 限制 */
  maxOutputTokens?: number;
}

export interface AutoMemoryConfig {
  enabled?: boolean;
  mode?: "auto" | "hybrid" | "suggest";
  turnThreshold?: number;
  maxCandidates?: number;
  maxBatchChars?: number;
  lockTimeoutSeconds?: number;
}

export interface MemoryConfig {
  maxItemChars?: number;
  maxTotalChars?: number;
}

export interface AttachmentsConfig {
  enabled?: boolean;
  maxFilesPerMessage?: number;
  maxFileSize?: number;
  allowedImageTypes?: ImageMediaType[];
}

export interface DebugConfig {
  enabled?: boolean;
  modelIO?: boolean;
  rawStreamEvents?: boolean;
}

export interface SecurityConfig {
  mode?: PermissionMode;
  tools?: Record<string, ToolSecurityConfig>;
  gateway?: {
    host?: string;
    token?: string;
    sseHeartbeatIntervalMs?: number;
  };
  auditTools?: boolean;
}

export type PermissionMode = "deny" | "ask" | "allow";

export interface ToolSecurityConfig {
  mode?: PermissionMode;
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
  execute: (args: Record<string, unknown>, context?: ToolExecutionContext) => Promise<string>;
}

export interface ToolExecutionContext {
  signal?: AbortSignal;
  sessionId?: string;
  actor?: AgentActor;
}

export interface AgentActor {
  channel: "cli" | "web" | "feishu";
  requesterId?: string;
  chatId?: string;
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
