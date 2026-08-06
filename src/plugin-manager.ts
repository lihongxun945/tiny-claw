import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ToolRegistry } from "./tools/registry.js";
import { loadPlugins, destroyPlugins } from "./plugins/loader.js";
import { corePlugins } from "./plugins/core/index.js";
import { loadConfig } from "./config.js";
import type {
  Plugin,
  PluginContext,
  PluginHooks,
  HookContext,
  PromptSection,
  RegisteredRoute,
  RouteDefinition,
  ChatCommand,
  ChatCommandResult,
  ExecuteChatCommandOptions,
  TurnEndReason,
  ModelCallContext,
} from "./plugins/types.js";
import type { Config, Tool, ToolDefinition, Message, ChatResponse, SessionContext, ExecutionMode } from "./types.js";
import type { ModelClient } from "./model/index.js";
import type { ModelDebugEvent } from "./model/types.js";
import type { AgentSession } from "./agent.js";
import type { MessageHistory } from "./history.js";

type PluginModule = { default: Plugin };
type RegisteredChatCommand = ChatCommand & { pluginName: string };

export interface PluginManagerOptions {
  builtinPlugins?: string[];
  externalPlugins?: string[];
  pluginConfigs?: Record<string, Record<string, unknown>>;
  allowedTools?: string[];
  disabledTools?: string[];
}

export class PluginManager {
  private registry = new ToolRegistry();
  private hooks: PluginHooks[] = [];
  private chatCommands = new Map<string, RegisteredChatCommand>();
  private promptSections: PromptSection[] = [];
  private routes: RegisteredRoute[] = [];
  private loadedPlugins: Plugin[] = [];
  private config?: Config;
  private baseConfig?: Config;
  private client?: ModelClient;
  private history?: MessageHistory;
  private runtimeDepsBySession = new Map<string, { config: Config; client: ModelClient; history: MessageHistory; sessionContext: SessionContext }>();
  private executionModesBySession = new Map<string, ExecutionMode>();
  private turnIdsBySession = new Map<string, string>();
  private sessionFactory?: {
    getOrCreateSession: (id: string, prefix?: string) => AgentSession;
    deleteSession: (id: string) => boolean;
  };

  private allowedTools?: Set<string>;
  private disabledTools: Set<string>;

  constructor(private workspacePath: string, options: Pick<PluginManagerOptions, "allowedTools" | "disabledTools"> = {}) {
    this.allowedTools = options.allowedTools ? new Set(options.allowedTools) : undefined;
    this.disabledTools = new Set(options.disabledTools ?? []);
    try {
      this.baseConfig = loadConfig(workspacePath);
      this.config = this.baseConfig;
    } catch {
      // AgentSession will surface configuration errors with the existing message.
    }
  }

  /** 设置运行时依赖（在 AgentSession 创建后调用） */
  setRuntimeDeps(config: Config, client: ModelClient, history: MessageHistory, sessionId?: string, sessionContext: SessionContext = { mode: "chat" }): void {
    this.config = config;
    this.client = client;
    this.history = history;
    if (sessionId) {
      this.runtimeDepsBySession.set(sessionId, { config, client, history, sessionContext });
    }
  }

  clearRuntimeDeps(sessionId: string): void {
    this.runtimeDepsBySession.delete(sessionId);
  }

  // ========== Core Plugins ==========

  async loadCorePlugins(): Promise<void> {
    for (const plugin of corePlugins) {
      const ctx = this.createPluginContext(plugin.name);
      await plugin.init(ctx);
      this.loadedPlugins.push(plugin);
    }
  }

  // ========== User Plugins ==========

  async loadUserPlugins(options: PluginManagerOptions): Promise<void> {
    if (options.builtinPlugins?.length || options.externalPlugins?.length) {
      const plugins = await loadPlugins(
        {
          builtin: options.builtinPlugins,
          external: options.externalPlugins,
        },
        (pluginName) => this.createPluginContext(pluginName),
      );
      this.loadedPlugins.push(...plugins);
    }

    await this.loadWorkspacePlugins();
  }

  /** 扫描 workspace/plugins/ 目录，加载所有用户自定义插件 */
  private async loadWorkspacePlugins(): Promise<void> {
    const pluginsDir = resolve(this.workspacePath, "plugins");
    if (!existsSync(pluginsDir)) return;

    const entries = readdirSync(pluginsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const indexFile = resolve(pluginsDir, entry.name, "index.ts");
      if (!existsSync(indexFile)) continue;

      try {
        const mod = await import(indexFile) as PluginModule;
        const plugin = mod.default;
        if (!plugin?.name || typeof plugin.init !== "function") {
          console.warn(`workspace/plugins/${entry.name}: 未导出有效的 Plugin，已跳过`);
          continue;
        }
        const ctx = this.createPluginContext(plugin.name);
        await plugin.init(ctx);
        this.loadedPlugins.push(plugin);
        console.log(`插件已加载: ${plugin.name} (workspace/plugins/)`);
      } catch (err) {
        console.error(`workspace/plugins/${entry.name}: 加载失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private createPluginContext(pluginName: string): PluginContext {
    const pm = this;
    return {
      config: pluginName.startsWith("core-")
        ? ((pm.config ?? pm.baseConfig ?? {}) as unknown as Record<string, unknown>)
        : (pm.pluginConfigs?.[pluginName] ?? {}),
      workspacePath: pm.workspacePath,
      registerRoute(route: RouteDefinition) {
        pm.routes.push({ ...route, pluginName });
      },
      registerTool(tool: Tool) {
        if (pm.allowedTools && !pm.allowedTools.has(tool.name)) return;
        if (pm.disabledTools.has(tool.name)) return;
        pm.registry.register(tool);
      },
      registerChatCommand(command: ChatCommand) {
        pm.registerChatCommand(command, pluginName);
      },
      executeChatCommand(input, options) {
        return pm.executeChatCommand(input, options);
      },
      registerHooks(hooks: PluginHooks) {
        pm.hooks.push(hooks);
      },
      extendPrompt(section: PromptSection) {
        pm.promptSections.push(section);
      },
      getOrCreateSession(id: string, prefix?: string) {
        if (pm.sessionFactory) {
          return pm.sessionFactory.getOrCreateSession(id, prefix);
        }
        throw new Error("PluginContext.getOrCreateSession 仅在 Gateway 模式下可用");
      },
      deleteSession(id: string) {
        if (pm.sessionFactory) {
          return pm.sessionFactory.deleteSession(id);
        }
        return false;
      },
      log(level, message, sessionId) {
        // 用户插件日志由宿主（Gateway/CLI）负责，这里做 fallback
        const ts = new Date().toISOString().slice(11, 19);
        const prefix = sessionId ? `[${ts}] [${level}] [${pluginName}] [${sessionId}]` : `[${ts}] [${level}] [${pluginName}]`;
        console.log(`${prefix} ${message}`);
      },
    };
  }

  // ========== Plugin Config Lookup ==========

  private pluginConfigs: Record<string, Record<string, unknown>> = {};

  setPluginConfigs(configs: Record<string, Record<string, unknown>>): void {
    this.pluginConfigs = configs;
  }

  /** 设置会话工厂（Gateway 模式下覆盖默认实现） */
  setSessionFactory(factory: { getOrCreateSession: (id: string, prefix?: string) => AgentSession; deleteSession: (id: string) => boolean }): void {
    this.sessionFactory = factory;
  }

  // ========== Tool Access ==========

  getToolDefinitions(
    context?: SessionContext,
    executionMode: ExecutionMode = "normal",
    sessionId?: string,
    iteration = 0,
  ): ToolDefinition[] {
    let definitions = this.registry.getDefinitions(context, executionMode);
    if (!sessionId) return definitions;
    for (const hooks of this.hooks) {
      const filtered = hooks.onFilterToolDefinitions?.(
        this.buildHookContext(iteration, sessionId),
        definitions,
      );
      if (filtered !== undefined) definitions = filtered;
    }
    return definitions;
  }

  setExecutionMode(sessionId: string, mode: ExecutionMode): void {
    this.executionModesBySession.set(sessionId, mode);
  }

  clearExecutionMode(sessionId: string): void {
    this.executionModesBySession.delete(sessionId);
  }

  getExecutionMode(sessionId: string): ExecutionMode {
    return this.executionModesBySession.get(sessionId) ?? "normal";
  }

  setTurnId(sessionId: string, turnId: string): void {
    this.turnIdsBySession.set(sessionId, turnId);
  }

  clearTurnId(sessionId: string): void {
    this.turnIdsBySession.delete(sessionId);
  }

  getTurnId(sessionId: string): string | undefined {
    return this.turnIdsBySession.get(sessionId);
  }

  getTool(name: string): Tool | undefined {
    return this.registry.getTool(name);
  }

  // ========== Chat Command Access ==========

  private registerChatCommand(command: ChatCommand, pluginName: string): void {
    const registered = { ...command, pluginName };
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      this.chatCommands.set(name.toLowerCase(), registered);
    }
  }

  getChatCommands(): ChatCommand[] {
    const seen = new Set<RegisteredChatCommand>();
    const commands: ChatCommand[] = [];
    for (const command of this.chatCommands.values()) {
      if (seen.has(command)) continue;
      seen.add(command);
      commands.push(command);
    }
    return commands.sort((a, b) => a.name.localeCompare(b.name));
  }

  async executeChatCommand(input: string, options: ExecuteChatCommandOptions): Promise<ChatCommandResult | undefined> {
    const parsed = parseChatCommand(input);
    if (!parsed) return undefined;

    if (parsed.name === "help" && !this.chatCommands.has("help")) {
      return { text: formatCommandHelp(this.getChatCommands()) };
    }

    const command = this.chatCommands.get(parsed.name);
    if (!command) {
      return { text: `未知命令：/${parsed.name}\n发送 /help 查看可用命令。` };
    }
    const deps = this.runtimeDepsBySession.get(options.sessionId);

    return command.execute({
      workspacePath: this.workspacePath,
      sessionId: options.sessionId,
      channel: options.channel,
      actor: options.actor,
      config: deps?.config ?? this.config,
      client: deps?.client ?? this.client,
      history: deps?.history ?? this.history,
      commandName: parsed.name,
      args: parsed.args,
      rawArgs: parsed.rawArgs,
      rawInput: input,
      getChatCommands: () => this.getChatCommands(),
      getToolDefinitions: () => this.getToolDefinitions(deps?.sessionContext, this.executionModesBySession.get(options.sessionId) ?? "normal", options.sessionId),
      getTool: (name) => this.getTool(name),
    });
  }

  // ========== Route Access ==========

  getRoutes(): RegisteredRoute[] {
    return this.routes;
  }

  // ========== Prompt Section Access ==========

  getPromptSections(): PromptSection[] {
    return this.promptSections;
  }

  // ========== Hook Dispatch ==========

  callOnModelDebug(event: ModelDebugEvent): void {
    for (const hooks of this.hooks) {
      try {
        hooks.onModelDebug?.(event);
      } catch {
        // Debug hooks must never affect model calls.
      }
    }
  }

  private buildHookContext(iteration: number, sessionId: string, turnStartIndex = 0): HookContext {
    const deps = this.runtimeDepsBySession.get(sessionId);
    const config = deps?.config ?? this.config;
    const client = deps?.client ?? this.client;
    const history = deps?.history ?? this.history;
    if (!config || !client || !history) {
      throw new Error("PluginManager: 未设置运行时依赖，请先调用 setRuntimeDeps");
    }
    return {
      sessionId,
      turnId: this.turnIdsBySession.get(sessionId),
      iteration,
      turnStartIndex,
      config,
      client,
      history,
      sessionContext: deps?.sessionContext ?? { mode: "chat" },
      executionMode: this.executionModesBySession.get(sessionId) ?? "normal",
      getToolDefinitions: () => this.registry.getDefinitions(deps?.sessionContext, this.executionModesBySession.get(sessionId) ?? "normal"),
      getTool: (name) => this.getTool(name),
    };
  }

  async callOnBeforeChat(input: string, sessionId: string): Promise<{ input: string; abort?: string }> {
    let result: { input: string; abort?: string } = { input };
    for (const hooks of this.hooks) {
      if (hooks.onBeforeChat) {
        const r = await hooks.onBeforeChat(
          this.buildHookContext(0, sessionId),
          result.input,
        );
        if (r) {
          if (r.abort) return { ...result, abort: r.abort };
          if (r.input !== undefined) result = { ...result, input: r.input };
        }
      }
    }
    return result;
  }

  async callOnBuildPrompt(prompt: string, sessionId: string): Promise<string> {
    let result = prompt;
    for (const hooks of this.hooks) {
      if (hooks.onBuildPrompt) {
        const r = await hooks.onBuildPrompt(
          this.buildHookContext(0, sessionId),
          result,
        );
        if (r !== undefined) result = r;
      }
    }
    return result;
  }

  async callOnBuildTurnPrompt(prompt: string, iteration: number, sessionId: string): Promise<string> {
    let result = prompt;
    for (const hooks of this.hooks) {
      if (hooks.onBuildTurnPrompt) {
        const updated = await hooks.onBuildTurnPrompt(this.buildHookContext(iteration, sessionId), result);
        if (updated !== undefined) result = updated;
      }
    }
    return result;
  }

  async callOnUserMessage(input: string, sessionId: string, content?: Message["content"]): Promise<void> {
    for (const hooks of this.hooks) {
      if (hooks.onUserMessage) {
        await hooks.onUserMessage(
          this.buildHookContext(0, sessionId),
          input,
          content,
        );
      }
    }
  }

  async callOnBeforeModelCall(modelContext: ModelCallContext, iteration: number, sessionId: string): Promise<ModelCallContext> {
    let result = modelContext;
    for (const hooks of this.hooks) {
      if (hooks.onBeforeModelCall) {
        const r = await hooks.onBeforeModelCall(
          this.buildHookContext(iteration, sessionId, result.turnStartIndex),
          result,
        );
        if (r !== undefined) result = r;
      }
    }
    return result;
  }

  async callOnChatResponse(response: ChatResponse, iteration: number, sessionId: string): Promise<ChatResponse> {
    let result = response;
    for (const hooks of this.hooks) {
      if (hooks.onChatResponse) {
        const r = await hooks.onChatResponse(
          this.buildHookContext(iteration, sessionId),
          result,
        );
        if (r !== undefined) result = r;
      }
    }
    return result;
  }

  async callOnBeforeTool(name: string, args: Record<string, unknown>, iteration: number, sessionId: string): Promise<{ abort?: string }> {
    for (const hooks of this.hooks) {
      if (hooks.onBeforeTool) {
        const r = await hooks.onBeforeTool(
          this.buildHookContext(iteration, sessionId),
          name,
          args,
        );
        if (r?.abort) return { abort: r.abort };
      }
    }
    return {};
  }

  async callOnAfterTool(name: string, result: string, iteration: number, sessionId: string): Promise<string> {
    let r = result;
    for (const hooks of this.hooks) {
      if (hooks.onAfterTool) {
        const updated = await hooks.onAfterTool(
          this.buildHookContext(iteration, sessionId),
          name,
          r,
        );
        if (updated !== undefined) r = updated;
      }
    }
    return r;
  }

  async callOnAfterIteration(iteration: number, sessionId: string): Promise<void> {
    for (const hooks of this.hooks) {
      if (hooks.onAfterIteration) {
        await hooks.onAfterIteration(
          this.buildHookContext(iteration, sessionId),
        );
      }
    }
  }

  async callOnTurnEnd(reason: TurnEndReason, iteration: number, sessionId: string): Promise<void> {
    for (const hooks of this.hooks) {
      if (hooks.onTurnEnd) {
        await hooks.onTurnEnd(
          this.buildHookContext(iteration, sessionId),
          reason,
        );
      }
    }
  }

  async callOnError(error: Error, iteration: number, sessionId: string): Promise<void> {
    for (const hooks of this.hooks) {
      if (hooks.onError) {
        await hooks.onError(
          this.buildHookContext(iteration, sessionId),
          error,
        );
      }
    }
  }

  // ========== Cleanup ==========

  async destroy(): Promise<void> {
    this.executionModesBySession.clear();
    this.turnIdsBySession.clear();
    await destroyPlugins(this.loadedPlugins);
  }
}

function parseChatCommand(input: string): { name: string; args: string[]; rawArgs: string } | undefined {
  const text = input.trim();
  if (!text.startsWith("/") || text === "/") return undefined;
  const match = text.match(/^\/([A-Za-z][\w-]*)(?:\s+(.*))?$/);
  if (!match) return undefined;
  const rawArgs = match[2]?.trim() ?? "";
  return {
    name: match[1].toLowerCase(),
    rawArgs,
    args: rawArgs ? rawArgs.split(/\s+/) : [],
  };
}

function formatCommandHelp(commands: Array<{ name: string; description: string; usage?: string }>): string {
  if (commands.length === 0) return "暂无可用命令。";
  return [
    "可用命令：",
    ...commands.map((command) => {
      const usage = command.usage ?? `/${command.name}`;
      return `- \`${usage}\`：${command.description}`;
    }),
  ].join("\n");
}
