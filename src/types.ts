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
  _reasoningContent?: string;
  role: "user" | "assistant";
  content: string | ContentBlock[];
  /** Session 内稳定的消息标识；旧消息读取时会生成确定性兼容 ID。 */
  _messageId?: string;
  /** Session 内从 1 开始单调递增的持久化序号。 */
  _sequence?: number;
  _timestamp?: number;
  _turnId?: string;
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
  bashTerminationGraceMs: number;
  bashMaxOutputChars?: number;
  fileReadMaxChars?: number;
  maxAgentIterations: number;
  emptyResponseRetries?: number;
  searchProvider: "ollama" | "searxng" | "brave" | "duckduckgo";
  ollamaApiKey?: string;
  searxngUrl?: string;
  braveApiKey?: string;
  enabledPlugins?: string[];
  externalPlugins?: string[];
  plugins?: Record<string, Record<string, unknown>>;
  pluginStates?: Record<string, { enabled?: boolean }>;
  subAgent?: SubAgentConfig;
  sessionSummary?: SessionSummaryConfig;
  autoMemory?: AutoMemoryConfig;
  profile?: ProfileConfig;
  memory?: MemoryConfig;
  attachments?: AttachmentsConfig;
  debug?: boolean | DebugConfig;
  security?: SecurityConfig;
  /** 项目开发模式配置 */
  project?: ProjectConfig;
  plan?: PlanConfig;
  workspacePath: string;
  systemPrompt: string;
}

export type ExecutionMode = "normal" | "plan";

export interface PlanConfig {
  enabled?: boolean;
  maxSteps?: number;
}

export interface ProjectConfig {
  security?: {
    mode?: PermissionMode;
    tools?: Record<string, ToolSecurityConfig>;
  };
  /** 项目模式历史窗口（轮数，默认 8） */
  /** 项目模式最大 agent 迭代数（默认 100） */
  maxAgentIterations?: number;
  /** Git 命令超时（毫秒，默认 10000） */
  gitTimeoutMs?: number;
  /** 单个文件 diff 返回字符上限（默认 200000） */
  diffMaxChars?: number;
  /** WebUI 打开项目超时（毫秒，默认 30000） */
  openTimeoutMs?: number;
  /** 项目目录树最大深度（默认 4） */
  treeMaxDepth?: number;
  /** 项目目录树最大条目数（默认 2000） */
  treeMaxEntries?: number;
  /** 项目搜索最大结果数（默认 200） */
  searchMaxResults?: number;
  /** 项目搜索最大输出字符数（默认 50000） */
  searchMaxChars?: number;
  /** 项目搜索超时（毫秒，默认 10000） */
  searchTimeoutMs?: number;
}

export interface SessionContext {
  mode: "chat" | "project";
  project?: {
    root: string;
    name: string;
  };
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
  /** 摘要输入（本次新增上下文）字符上限（默认 40000） */
  maxInputChars?: number;
  /** 摘要 LLM 输出的 token 上限（默认 10000），避免通用 complete 的 1024 限制 */
  maxOutputTokens?: number;
  maxOperations?: number;
  maxItemChars?: number;
  maxSourcesPerOperation?: number;
  checkpointDeltaThreshold?: number;
  checkpointMaxChars?: number;
  recallMaxResults?: number;
  recallMaxOutputChars?: number;
  recallMaxQueryChars?: number;
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
  enabled?: boolean;
  maxItemChars?: number;
  maxTotalChars?: number;
  retrieval?: {
    maxResults?: number;
    candidateLimit?: number;
    maxContextChars?: number;
    minScore?: number;
  };
  embedding?: {
    provider?: "local-hash" | "openai-compatible";
    model: string;
    dimensions: number;
    apiUrl?: string;
    apiKey?: string;
  };
  maintenance?: {
    inactiveTurns?: number;
    inactiveDays?: number;
    trashRetentionDays?: number;
  };
}

export interface ProfileConfig {
  enabled?: boolean;
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
  trustedProjects?: string[];
  background?: { timeoutSeconds?: number; maxRunning?: number; maxLogChars?: number };
  mode?: PermissionMode;
  approvalTtlMs?: number;
  tools?: Record<string, ToolSecurityConfig>;
  gateway?: {
    host?: string;
    token?: string;
    sseHeartbeatIntervalMs?: number;
  };
  auditTools?: boolean;
}

export type PermissionMode = "ask" | "auto" | "allow";

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
  /** 工具对外部状态的影响；未声明时按 write 处理。 */
  effect?: "read" | "write";
  inputSchema: ToolDefinition["input_schema"];
  isAvailable?: (context: SessionContext, executionMode: ExecutionMode) => boolean;
  execute: (args: Record<string, unknown>, context?: ToolExecutionContext) => Promise<string>;
}

export interface ToolExecutionContext {
  /** Report observable activity after permission checks, without changing run state. */
  reportActivity?: (message: string) => void;
  signal?: AbortSignal;
  sessionId?: string;
  actor?: AgentActor;
  rootPath?: string;
  restrictToRoot?: boolean;
  config?: Config;
  sessionContext?: SessionContext;
  executionMode?: ExecutionMode;
  turnId?: string;
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
  reasoningContent?: string;
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
