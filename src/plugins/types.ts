import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentSession } from "../agent.js";
import type { MessageHistory } from "../history.js";
import type { Tool, ToolDefinition, Config, Message, ChatResponse } from "../types.js";
import type { AnthropicClient } from "../client.js";

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
  registerHooks(hooks: PluginHooks): void;
  extendPrompt(section: PromptSection): void;
  getOrCreateSession(id: string, prefix?: string): AgentSession;
  deleteSession(id: string): boolean;
  log(level: "INFO" | "WARN" | "ERROR", message: string, sessionId?: string): void;
}

// === 插件钩子 ===

export interface PluginHooks {
  onBeforeChat?: (ctx: HookContext, input: string) =>
    { input?: string; abort?: string } | Promise<{ input?: string; abort?: string } | void> | void;
  onBuildPrompt?: (ctx: HookContext, prompt: string) =>
    string | Promise<string> | void;
  onUserMessage?: (ctx: HookContext, input: string) => void | Promise<void>;
  onBeforeModelCall?: (ctx: HookContext, messages: Message[]) =>
    Message[] | Promise<Message[]> | void;
  onChatResponse?: (ctx: HookContext, response: ChatResponse) =>
    ChatResponse | Promise<ChatResponse> | void;
  onBeforeTool?: (ctx: HookContext, name: string, args: Record<string, unknown>) =>
    { abort?: string } | Promise<{ abort?: string } | void> | void;
  onAfterTool?: (ctx: HookContext, name: string, result: string) =>
    string | Promise<string> | void;
  onAfterIteration?: (ctx: HookContext) => void | Promise<void>;
  onError?: (ctx: HookContext, error: Error) => void | Promise<void>;
}

export interface HookContext {
  sessionId: string;
  iteration: number;
  config: Config;
  client: AnthropicClient;
  history: MessageHistory;
  turnStartIndex: number;
  getToolDefinitions(): ToolDefinition[];
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
  readBody(): Promise<string>;
  sendJSON(status: number, data: unknown): void;
}

// === 已注册路由（含插件名） ===

export interface RegisteredRoute extends RouteDefinition {
  pluginName: string;
}
