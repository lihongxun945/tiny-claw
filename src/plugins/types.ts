import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentSession } from "../agent.js";

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
  getOrCreateSession(id: string, prefix?: string): AgentSession;
  deleteSession(id: string): boolean;
  log(level: "INFO" | "WARN" | "ERROR", message: string, sessionId?: string): void;
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
