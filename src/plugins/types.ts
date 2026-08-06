import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentSession } from "../agent.js";
import type { MessageHistory } from "../history.js";
import type { Tool, ToolDefinition, Config, Message, ChatResponse, AgentActor, SessionContext, ExecutionMode } from "../types.js";
import type { ModelClient } from "../model/index.js";
import type { ModelDebugEvent } from "../model/types.js";

// === 插件接口 ===

export interface Plugin {
  name: string;
  init(ctx: PluginContext): Promise<void>;
  destroy?(): Promise<void>;
}

// === 宿主提供给插件的 API ===

export interface PluginContext {
  config: Record<string, unknown>;
  workspacePath: string;
  registerRoute(route: RouteDefinition): void;
  registerTool(tool: Tool): void;
  registerChatCommand(command: ChatCommand): void;
  executeChatCommand(input: string, options: ExecuteChatCommandOptions): Promise<ChatCommandResult | undefined>;
  registerHooks(hooks: PluginHooks): void;
  extendPrompt(section: PromptSection): void;
  getOrCreateSession(id: string, prefix?: string): AgentSession;
  deleteSession(id: string): boolean;
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
  onUserMessage?: (ctx: HookContext, input: string, content?: Message["content"]) => void | Promise<void>;
  onBeforeModelCall?: (ctx: HookContext, modelContext: ModelCallContext) =>
    ModelCallContext | Promise<ModelCallContext> | void;
  onChatResponse?: (ctx: HookContext, response: ChatResponse) =>
    ChatResponse | Promise<ChatResponse> | void;
  onBeforeTool?: (ctx: HookContext, name: string, args: Record<string, unknown>) =>
    { abort?: string } | Promise<{ abort?: string } | void> | void;
  onAfterTool?: (ctx: HookContext, name: string, result: string) =>
    string | Promise<string> | void;
  onAfterIteration?: (ctx: HookContext) => void | Promise<void>;
  onTurnEnd?: (ctx: HookContext, reason: TurnEndReason) => void | Promise<void>;
  onError?: (ctx: HookContext, error: Error) => void | Promise<void>;
}

export type TurnEndReason = "completed" | "approval_required" | "iteration_limit";

export interface ModelCallContext {
  messages: Message[];
  /** 当前用户轮次在 messages 中的起始位置。 */
  turnStartIndex: number;
  /** 扣除系统提示词、工具定义和最大输出后，可供 messages 使用的 token 预算。 */
  messageTokenBudget: number;
  /** 上报不写入历史的临时执行状态。 */
  reportStatus?: (status: AgentStatusUpdate) => void;
}

export interface AgentStatusUpdate {
  stage: string;
  state: "started" | "completed" | "failed";
  message: string;
  beforeTokens?: number;
  afterTokens?: number;
}

export interface HookContext {
  sessionId: string;
  turnId?: string;
  iteration: number;
  config: Config;
  client: ModelClient;
  history: MessageHistory;
  sessionContext: SessionContext;
  executionMode: ExecutionMode;
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
  url: URL;
  readBody(): Promise<string>;
  sendJSON(status: number, data: unknown): void;
}

// === 已注册路由（含插件名） ===

export interface RegisteredRoute extends RouteDefinition {
  pluginName: string;
}
