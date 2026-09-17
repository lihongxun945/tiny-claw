import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentSession } from "../agent.js";
import type { MessageHistory } from "../history.js";
import type { Tool, ToolDefinition, Config, Message, ChatResponse, AgentActor, SessionContext, ExecutionMode } from "../types.js";
import type { ModelClient } from "../model/index.js";
import type { ModelDebugEvent } from "../model/types.js";
import type { ApplicationScope } from "../kernel/scope.js";
import type { CapabilityRegistry } from "../kernel/registry.js";
import type { Disposable } from "../kernel/disposable.js";
import type { PluginManifest, PluginPermissionDeclaration } from "../kernel/plugin.js";

// === 插件接口 ===

export interface Plugin {
  name: string;
  init(ctx: PluginContext): Promise<void>;
  destroy?(): Promise<void>;
}

// === 宿主提供给插件的 API ===

export interface PluginContext {
  readonly manifest: PluginManifest;
  readonly permissions: Readonly<PluginPermissionDeclaration>;
  applicationScope: ApplicationScope;
  capabilities: CapabilityRegistry;
  readonly config: Readonly<Record<string, unknown>>;
  workspacePath: string;
  registerDisposable(resource: Disposable): Disposable;
  registerRoute(route: RouteDefinition): Disposable;
  registerTool(tool: Tool): Disposable;
  registerChatCommand(command: ChatCommand): Disposable;
  executeChatCommand(input: string, options: ExecuteChatCommandOptions): Promise<ChatCommandResult | undefined>;
  registerHooks(hooks: PluginHooks): Disposable;
  extendPrompt(section: PromptSection): Disposable;
  getOrCreateSession(id: string, prefix?: string): AgentSession;
  deleteSession(id: string): Promise<boolean>;
  log(level: "INFO" | "WARN" | "ERROR", message: string, sessionId?: string): void;
}

// === 聊天命令 ===

export interface ChatCommand {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  execute(ctx: ChatCommandContext): Promise<ChatCommandResult> | ChatCommandResult;
}

export interface ChatCommandContext {
  workspacePath: string;
  sessionId: string;
  channel: AgentActor["channel"];
  actor?: AgentActor;
  config?: Config;
  client?: ModelClient;
  history?: MessageHistory;
  commandName: string;
  args: string[];
  rawArgs: string;
  rawInput: string;
  getChatCommands(): ChatCommand[];
  getToolDefinitions(): ToolDefinition[];
  getTool(name: string): Tool | undefined;
}

export interface ExecuteChatCommandOptions {
  sessionId: string;
  channel: AgentActor["channel"];
  actor?: AgentActor;
}

export interface ChatCommandResult {
  text: string;
  sessionId?: string;
  clearMessages?: boolean;
}

// === 插件钩子 ===

export interface PluginHooks {
  onModelDebug?: (event: ModelDebugEvent) => void;
  onBeforeChat?: (ctx: HookContext, input: string) =>
    { input?: string; abort?: string } | Promise<{ input?: string; abort?: string } | void> | void;
  onBuildPrompt?: (ctx: HookContext, prompt: string) =>
    string | Promise<string> | void;
  onBuildTurnPrompt?: (ctx: HookContext, prompt: string) =>
    string | Promise<string> | void;
  onFilterToolDefinitions?: (ctx: HookContext, definitions: ToolDefinition[]) => ToolDefinition[] | void;
  onUserMessage?: (ctx: HookContext, input: string, content?: Message["content"]) => void | Promise<void>;
  onBeforeModelCall?: (ctx: HookContext, modelContext: ModelCallContext) =>
    ModelCallContext | Promise<ModelCallContext> | void;
  /** Observe the final request after prompt injection, compression, and tool filtering. */
  onModelRequestPrepared?: (ctx: HookContext, request: PreparedModelRequest) => void | Promise<void>;
  onChatResponse?: (ctx: HookContext, response: ChatResponse) =>
    ChatResponse | Promise<ChatResponse> | void;
  onBeforeTool?: (ctx: HookContext, name: string, args: Record<string, unknown>) =>
    ToolGateResult | Promise<ToolGateResult | void> | void;
  onAfterTool?: (ctx: HookContext, name: string, result: string) =>
    string | Promise<string> | void;
  onAfterIteration?: (ctx: HookContext) => void | Promise<void>;
  onTurnEnd?: (ctx: HookContext, reason: TurnEndReason) => void | Promise<void>;
  onTurnNotice?: (ctx: HookContext, reason: TurnEndReason) => { id: string; text: string } | undefined | Promise<{ id: string; text: string } | undefined>;
  onError?: (ctx: HookContext, error: Error) => void | Promise<void>;
}

export interface ToolGateResult {
  abort?: string;
  code?: string;
  requiredAction?: string;
  stop?: boolean;
  stopState?: "waiting_user" | "interrupted";
}

export type TurnEndReason = "completed" | "approval_required" | "iteration_limit" | "waiting_user" | "interrupted";

export interface ContextTokenUsage {
  systemPrompt: number;
  messages: number;
  tools: number;
  outputReserved: number;
  input: number;
  totalReserved: number;
  maxContext: number;
  percent: number;
}

export interface ContextSummarySection {
  title: string;
  content: string;
}

export interface PreparedModelRequest {
  kind?: "estimate" | "request";
  lastRequest?: { createdAt: string; usage: ContextTokenUsage };
  contextSummaries?: ContextSummarySection[];
  sessionId: string;
  turnId?: string;
  iteration: number;
  attempt: number;
  createdAt: string;
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
  usage: ContextTokenUsage;
}

export interface ModelCallContext {
  /** Display metadata for summaries already included in the actual request. */
  contextSummaries?: ContextSummarySection[];
  messages: Message[];
  /** Temporary historical data appended to the system prompt, never an assistant message or persisted history. */
  derivedContext?: string;
  /** 仅用于当前模型调用的内部系统提示后缀，不写入消息历史。 */
  systemPromptSuffix?: string;
  /** 当前用户轮次在 messages 中的起始位置。 */
  turnStartIndex: number;
  /** 扣除系统提示词、工具定义和最大输出后，可供 messages 使用的 token 预算。 */
  messageTokenBudget: number;
  /** Full-input accounting and hard limit, distinct from the compression trigger. */
  hardMessageTokenBudget?: number;
  fixedInputTokens?: number;
  /** 上报不写入历史的临时执行状态。 */
  reportStatus?: (status: AgentStatusUpdate) => void;
}

export interface AgentStatusUpdate {
  startedAt?: number;
  stage: string;
  state: "started" | "completed" | "failed";
  message: string;
  beforeTokens?: number;
  afterTokens?: number;
}

export interface HookContext {
  signal?: AbortSignal;
  sessionId: string;
  turnId?: string;
  iteration: number;
  config: Config;
  client: ModelClient;
  history: MessageHistory;
  sessionContext: SessionContext;
  executionMode: ExecutionMode;
  /** 上报不写入历史的插件生命周期状态。 */
  reportStatus?: (status: AgentStatusUpdate) => void;
  turnStartIndex: number;
  getToolDefinitions(): ToolDefinition[];
  getTool(name: string): Tool | undefined;
}

// === 提示词片段 ===

export interface PromptSection {
  title: string;
  content: string;
  priority: number;
}

// === 路由注册 ===

export interface RouteDefinition {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  handler: RouteHandler;
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
) => Promise<void>;

export interface RouteContext {
  resumeTool?: (sessionId: string, requestId: string, result: string) => Promise<void>;
  url: URL;
  readBody(): Promise<string>;
  sendJSON(status: number, data: unknown): void;
}

// === 已注册路由（含插件名） ===

export interface RegisteredRoute extends RouteDefinition {
  pluginName: string;
}
