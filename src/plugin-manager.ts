import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { discoverPlugins } from "./plugins/loader.js";
import { corePlugins } from "./plugins/core/index.js";
import { loadConfig } from "./config.js";
import type {
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
  NotificationPayload,
  ModelCallContext,
  AgentStatusUpdate,
  PreparedModelRequest,
} from "./plugins/types.js";
import type { Config, Tool, ToolDefinition, Message, ChatResponse, SessionContext, ExecutionMode } from "./types.js";
import type { ModelClient } from "./model/index.js";
import type { ModelDebugEvent } from "./model/types.js";
import type { AgentSession } from "./agent.js";
import type { MessageHistory } from "./history.js";
import { ApplicationScope, type SessionScope, type TurnScope } from "./kernel/scope.js";
import {
  ACTIVE_TURN_SCOPE,
  SESSION_RUNTIME,
  TURN_EXECUTION_MODE,
  type SessionRuntimeDependencies,
} from "./kernel/runtime-values.js";
import {
  CHAT_COMMAND_CAPABILITY,
  PLUGIN_HOOKS_CAPABILITY,
  PROMPT_SECTION_CAPABILITY,
  ROUTE_CAPABILITY,
  TOOL_CAPABILITY,
} from "./kernel/builtin-capabilities.js";
import type { Disposable, DisposableStore } from "./kernel/disposable.js";
import { normalizePlugin, type KernelPlugin } from "./kernel/plugin.js";
import { PluginHost, type PluginSnapshot } from "./kernel/plugin-host.js";
import { resolvePluginConfig, type PluginConfigResult } from "./kernel/plugin-config.js";
import { assertPluginRegistrationPermission, normalizePluginPermissions } from "./kernel/plugin-permissions.js";

type PluginModule = { default: unknown };
export interface PluginManagerOptions {
  builtinPlugins?: string[];
  externalPlugins?: string[];
  pluginConfigs?: Record<string, Record<string, unknown>>;
  pluginStates?: Record<string, { enabled?: boolean }>;
  allowedTools?: string[];
  disabledTools?: string[];
}

export class PluginManager {
  readonly applicationScope: ApplicationScope;
  private readonly pluginHost: PluginHost;
  private config?: Config;
  private baseConfig?: Config;
  private client?: ModelClient;
  private history?: MessageHistory;
  private sessionScopes = new Map<string, SessionScope>();
  private sessionFactory?: {
    getOrCreateSession: (id: string, prefix?: string) => AgentSession;
    deleteSession: (id: string) => Promise<boolean>;
  };

  private allowedTools?: Set<string>;
  private disabledTools: Set<string>;

  constructor(private workspacePath: string, options: Pick<PluginManagerOptions, "allowedTools" | "disabledTools"> = {}) {
    this.applicationScope = new ApplicationScope();
    this.pluginHost = new PluginHost(
      (plugin, disposables, config) => this.createPluginContext(plugin, disposables, config),
      (plugin) => this.resolvePluginConfig(plugin),
    );
    this.allowedTools = options.allowedTools ? new Set(options.allowedTools) : undefined;
    this.disabledTools = new Set(options.disabledTools ?? []);
    try {
      this.baseConfig = loadConfig(workspacePath);
      this.config = this.baseConfig;
    } catch {
      // AgentSession will surface configuration errors with the existing message.
    }
  }

  createSessionScope(sessionId: string): SessionScope {
    const existing = this.sessionScopes.get(sessionId);
    if (existing) return existing;
    const scope = this.applicationScope.createSession(sessionId);
    this.sessionScopes.set(sessionId, scope);
    return scope;
  }

  /** 设置运行时依赖（在 AgentSession 创建后调用） */
  setRuntimeDeps(config: Config, client: ModelClient, history: MessageHistory, sessionId?: string, sessionContext: SessionContext = { mode: "chat" }): void {
    this.config = config;
    this.client = client;
    this.history = history;
    if (sessionId) {
      this.createSessionScope(sessionId).set(SESSION_RUNTIME, { config, client, history, sessionContext });
    }
  }

  async clearRuntimeDeps(sessionId: string): Promise<void> {
    const scope = this.sessionScopes.get(sessionId);
    if (!scope) return;
    this.sessionScopes.delete(sessionId);
    await scope.dispose();
  }

  async beginTurn(sessionId: string, turnId: string, executionMode: ExecutionMode): Promise<TurnScope> {
    const session = this.sessionScopes.get(sessionId);
    if (!session?.get(SESSION_RUNTIME)) {
      throw new Error("PluginManager: 未设置运行时依赖，请先调用 setRuntimeDeps");
    }
    const active = session.get(ACTIVE_TURN_SCOPE);
    if (active?.id === turnId) {
      active.set(TURN_EXECUTION_MODE, executionMode);
      return active;
    }
    if (active) await active.dispose();
    const turn = session.createTurn(turnId);
    turn.set(TURN_EXECUTION_MODE, executionMode);
    session.set(ACTIVE_TURN_SCOPE, turn);
    return turn;
  }

  async endTurn(sessionId: string, turnId: string, preserve = false): Promise<void> {
    const session = this.sessionScopes.get(sessionId);
    const active = session?.get(ACTIVE_TURN_SCOPE);
    if (!session || !active || active.id !== turnId || preserve) return;
    session.delete(ACTIVE_TURN_SCOPE);
    await active.dispose();
  }

  // ========== Core Plugins ==========

  async loadCorePlugins(): Promise<void> {
    for (const plugin of corePlugins) {
      this.pluginHost.register(normalizePlugin(plugin, "core"));
    }
    await this.pluginHost.startAll();
  }

  // ========== User Plugins ==========

  async loadUserPlugins(options: PluginManagerOptions): Promise<void> {
    this.pluginStates = options.pluginStates ?? {};
    for (const name of options.builtinPlugins ?? []) {
      try {
        const discovered = await discoverPlugins({ builtin: [name] });
        for (const { plugin } of discovered) this.registerUserPlugin(plugin);
      } catch (error) {
        console.error(`内置插件 ${name} 发现失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const specifier of options.externalPlugins ?? []) {
      try {
        const discovered = await discoverPlugins({ external: [specifier] });
        for (const { plugin } of discovered) this.registerUserPlugin(plugin);
      } catch (error) {
        console.error(`外部插件 ${specifier} 发现失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await this.loadWorkspacePlugins();
    await this.pluginHost.startAll();
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
        const mod = await import(pathToFileURL(indexFile).href) as PluginModule;
        const plugin = normalizePlugin(mod.default, "workspace");
        this.registerUserPlugin(plugin, async () => {
          const url = `${pathToFileURL(indexFile).href}?tiny_claw_reload=${Date.now()}-${workspaceReloadNonce++}`;
          const reloaded = await import(url) as PluginModule;
          return normalizePlugin(reloaded.default, "workspace");
        });
      } catch (err) {
        console.error(`workspace/plugins/${entry.name}: 加载失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private createPluginContext(
    pluginOrName: KernelPlugin | string,
    owner = this.applicationScope.disposables,
    resolvedConfig?: PluginConfigResult,
  ): PluginContext {
    const pm = this;
    const plugin = typeof pluginOrName === "string" ? undefined : pluginOrName;
    const pluginName = typeof pluginOrName === "string" ? pluginOrName : pluginOrName.manifest.id;
    const manifest = plugin?.manifest ?? {
      id: pluginName,
      version: "0.0.0",
      kind: pluginName.startsWith("core-") ? "core" as const : "external" as const,
    };
    return {
      manifest,
      permissions: normalizePluginPermissions(manifest.permissions),
      applicationScope: pm.applicationScope,
      capabilities: pm.applicationScope.capabilities,
      config: resolvedConfig?.value ?? (pluginName.startsWith("core-")
        ? ((pm.config ?? pm.baseConfig ?? {}) as unknown as Record<string, unknown>)
        : (pm.pluginConfigs?.[pluginName] ?? {})),
      workspacePath: pm.workspacePath,
      registerDisposable(resource: Disposable) { return owner.add(resource); },
      registerRoute(route: RouteDefinition) {
        if (plugin) assertPluginRegistrationPermission(manifest, "route");
        const registered = { ...route, pluginName };
        const registration = pm.applicationScope.capabilities.contribute(
          ROUTE_CAPABILITY,
          registered,
          { pluginId: pluginName },
        );
        owner.add(registration);
        return registration;
      },
      registerTool(tool: Tool) {
        if (plugin) assertPluginRegistrationPermission(manifest, "tool", tool.name);
        if (pm.allowedTools && !pm.allowedTools.has(tool.name)) return NOOP_DISPOSABLE;
        if (pm.disabledTools.has(tool.name)) return NOOP_DISPOSABLE;
        const registration = pm.applicationScope.capabilities.contribute(
          TOOL_CAPABILITY,
          tool,
          { pluginId: pluginName },
        );
        owner.add(registration);
        return registration;
      },
      registerChatCommand(command: ChatCommand) {
        const registration = pm.applicationScope.capabilities.contribute(
          CHAT_COMMAND_CAPABILITY,
          command,
          { pluginId: pluginName },
        );
        owner.add(registration);
        return registration;
      },
      executeChatCommand(input, options) {
        return pm.executeChatCommand(input, options);
      },
      registerHooks(hooks: PluginHooks) {
        const registration = pm.applicationScope.capabilities.contribute(
          PLUGIN_HOOKS_CAPABILITY,
          hooks,
          { pluginId: pluginName },
        );
        owner.add(registration);
        return registration;
      },
      extendPrompt(section: PromptSection) {
        const registration = pm.applicationScope.capabilities.contribute(
          PROMPT_SECTION_CAPABILITY,
          section,
          { pluginId: pluginName },
        );
        owner.add(registration);
        return registration;
      },
      getOrCreateSession(id: string, prefix?: string) {
        if (pm.sessionFactory) {
          return pm.sessionFactory.getOrCreateSession(id, prefix);
        }
        throw new Error("PluginContext.getOrCreateSession 仅在 Gateway 模式下可用");
      },
      async deleteSession(id: string) {
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
  private pluginStates: Record<string, { enabled?: boolean }> = {};

  private registerUserPlugin(plugin: KernelPlugin, reload?: () => Promise<KernelPlugin>): void {
    this.pluginHost.register(plugin, reload);
    this.pluginHost.setInitialEnabled(plugin.manifest.id, this.pluginStates[plugin.manifest.id]?.enabled !== false);
  }

  setPluginConfigs(configs: Record<string, Record<string, unknown>>): void {
    this.pluginConfigs = configs;
  }

  getPluginConfig(id: string): {
    declaration: KernelPlugin["manifest"]["config"];
    value: Readonly<Record<string, unknown>>;
    valid: boolean;
    issues: PluginConfigResult["issues"];
  } | undefined {
    const manifest = this.pluginHost.getPluginManifest(id);
    if (!manifest) return undefined;
    const result = resolvePluginConfig(manifest.config, this.pluginConfigs[id]);
    return { declaration: manifest.config, value: result.value, valid: result.valid, issues: result.issues };
  }

  validatePluginConfig(id: string, value: Record<string, unknown>): PluginConfigResult | undefined {
    const manifest = this.pluginHost.getPluginManifest(id);
    return manifest ? resolvePluginConfig(manifest.config, value) : undefined;
  }

  private resolvePluginConfig(plugin: KernelPlugin): PluginConfigResult {
    if (plugin.manifest.kind === "core" && !plugin.manifest.config) {
      return resolvePluginConfig(undefined, (this.config ?? this.baseConfig ?? {}) as unknown as Record<string, unknown>);
    }
    return resolvePluginConfig(plugin.manifest.config, this.pluginConfigs[plugin.manifest.id]);
  }

  getPluginManifest(id: string): KernelPlugin["manifest"] | undefined {
    return this.pluginHost.getPluginManifest(id);
  }

  /** 设置会话工厂（Gateway 模式下覆盖默认实现） */
  setSessionFactory(factory: { getOrCreateSession: (id: string, prefix?: string) => AgentSession; deleteSession: (id: string) => Promise<boolean> }): void {
    this.sessionFactory = factory;
  }

  listPlugins(): PluginSnapshot[] {
    return this.pluginHost.listPlugins();
  }

  async stopPlugin(id: string): Promise<void> {
    await this.pluginHost.stopPlugin(id);
  }

  async startPlugin(id: string): Promise<void> {
    await this.pluginHost.startPlugin(id);
  }

  async reloadPlugin(id: string): Promise<void> {
    await this.pluginHost.reloadPlugin(id);
  }

  async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    await this.pluginHost.setPluginEnabled(id, enabled);
    this.pluginStates = { ...this.pluginStates, [id]: { enabled } };
  }

  // ========== Tool Access ==========

  getToolDefinitions(
    context?: SessionContext,
    executionMode: ExecutionMode = "normal",
    sessionId?: string,
    iteration = 0,
  ): ToolDefinition[] {
    let definitions = this.getTools()
      .filter((tool) => !context || !tool.isAvailable || tool.isAvailable(context, executionMode))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    if (!sessionId) return definitions;
    for (const hooks of this.getHooks()) {
      const filtered = hooks.onFilterToolDefinitions?.(
        this.buildHookContext(iteration, sessionId),
        definitions,
      );
      if (filtered !== undefined) definitions = filtered;
    }
    return definitions;
  }

  getExecutionMode(sessionId: string): ExecutionMode {
    return this.getTurnScope(sessionId)?.get(TURN_EXECUTION_MODE) ?? "normal";
  }

  getTurnId(sessionId: string): string | undefined {
    return this.getTurnScope(sessionId)?.id;
  }

  getTool(name: string): Tool | undefined {
    return this.getToolIndex().get(name);
  }

  // ========== Chat Command Access ==========

  getChatCommands(): ChatCommand[] {
    const seen = new Set<ChatCommand>();
    const commands: ChatCommand[] = [];
    for (const command of this.getChatCommandIndex().values()) {
      if (seen.has(command)) continue;
      seen.add(command);
      commands.push(command);
    }
    return commands.sort((a, b) => a.name.localeCompare(b.name));
  }

  async executeChatCommand(input: string, options: ExecuteChatCommandOptions): Promise<ChatCommandResult | undefined> {
    const parsed = parseChatCommand(input);
    if (!parsed) return undefined;
    const commands = this.getChatCommandIndex();

    if (parsed.name === "help" && !commands.has("help")) {
      return { text: formatCommandHelp(this.getChatCommands()) };
    }

    const command = commands.get(parsed.name);
    if (!command) {
      return { text: `未知命令：/${parsed.name}\n发送 /help 查看可用命令。` };
    }
    const deps = this.getSessionRuntime(options.sessionId);

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
      getToolDefinitions: () => this.getToolDefinitions(deps?.sessionContext, this.getExecutionMode(options.sessionId), options.sessionId),
      getTool: (name) => this.getTool(name),
    });
  }

  // ========== Route Access ==========

  getRoutes(): RegisteredRoute[] {
    return this.applicationScope.capabilities.resolveAll(ROUTE_CAPABILITY);
  }

  // ========== Prompt Section Access ==========

  getPromptSections(): PromptSection[] {
    return this.applicationScope.capabilities.resolveAll(PROMPT_SECTION_CAPABILITY);
  }

  // ========== Hook Dispatch ==========

  callOnModelDebug(event: ModelDebugEvent): void {
    for (const hooks of this.getHooks()) {
      try {
        hooks.onModelDebug?.(event);
      } catch {
        // Debug hooks must never affect model calls.
      }
    }
  }

  private buildHookContext(iteration: number, sessionId: string, turnStartIndex = 0, reportStatus?: (status: AgentStatusUpdate) => void): HookContext {
    const deps = this.getSessionRuntime(sessionId);
    const config = deps?.config ?? this.config;
    const client = deps?.client ?? this.client;
    const history = deps?.history ?? this.history;
    if (!config || !client || !history) {
      throw new Error("PluginManager: 未设置运行时依赖，请先调用 setRuntimeDeps");
    }
    return {
      sessionId,
      turnId: this.getTurnId(sessionId),
      iteration,
      turnStartIndex,
      config,
      client,
      history,
      sessionContext: deps?.sessionContext ?? { mode: "chat" },
      executionMode: this.getExecutionMode(sessionId),
      getToolDefinitions: () => this.getToolDefinitions(deps?.sessionContext, this.getExecutionMode(sessionId), sessionId, iteration),
      reportStatus,
      getTool: (name) => this.getTool(name),
    };
  }

  async callOnBeforeChat(input: string, sessionId: string, signal?: AbortSignal, reportStatus?: (status: AgentStatusUpdate) => void): Promise<{ input: string; abort?: string }> {
    let result: { input: string; abort?: string } = { input };
    for (const hooks of this.getHooks()) {
      if (hooks.onBeforeChat) {
        const r = await hooks.onBeforeChat(
          { ...this.buildHookContext(0, sessionId, 0, reportStatus), signal },
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
    for (const hooks of this.getHooks()) {
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
    for (const hooks of this.getHooks()) {
      if (hooks.onBuildTurnPrompt) {
        const updated = await hooks.onBuildTurnPrompt(this.buildHookContext(iteration, sessionId), result);
        if (updated !== undefined) result = updated;
      }
    }
    return result;
  }

  async callOnUserMessage(input: string, sessionId: string, content?: Message["content"]): Promise<void> {
    for (const hooks of this.getHooks()) {
      if (hooks.onUserMessage) {
        await hooks.onUserMessage(
          this.buildHookContext(0, sessionId),
          input,
          content,
        );
      }
    }
  }

  async callOnBeforeModelCall(modelContext: ModelCallContext, iteration: number, sessionId: string, signal?: AbortSignal): Promise<ModelCallContext> {
    let result = modelContext;
    for (const hooks of this.getHooks()) {
      if (hooks.onBeforeModelCall) {
        const r = await hooks.onBeforeModelCall(
          { ...this.buildHookContext(iteration, sessionId, result.turnStartIndex), signal },
          result,
        );
        if (r !== undefined) result = r;
      }
    }
    return result;
  }

  async callOnModelRequestPrepared(request: PreparedModelRequest, iteration: number, sessionId: string): Promise<void> {
    for (const hooks of this.getHooks()) {
      await hooks.onModelRequestPrepared?.(this.buildHookContext(iteration, sessionId), request);
    }
  }

  async callOnChatResponse(response: ChatResponse, iteration: number, sessionId: string): Promise<ChatResponse> {
    let result = response;
    for (const hooks of this.getHooks()) {
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

  async callOnBeforeTool(name: string, args: Record<string, unknown>, iteration: number, sessionId: string): Promise<import("./plugins/types.js").ToolGateResult> {
    for (const hooks of this.getHooks()) {
      if (hooks.onBeforeTool) {
        const r = await hooks.onBeforeTool(
          this.buildHookContext(iteration, sessionId),
          name,
          args,
        );
        if (r?.abort) return r;
      }
    }
    return {};
  }

  async callOnAfterTool(name: string, result: string, iteration: number, sessionId: string): Promise<string> {
    let r = result;
    for (const hooks of this.getHooks()) {
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
    for (const hooks of this.getHooks()) {
      if (hooks.onAfterIteration) {
        await hooks.onAfterIteration(
          this.buildHookContext(iteration, sessionId),
        );
      }
    }
  }

  async callOnTurnEnd(reason: TurnEndReason, iteration: number, sessionId: string, reportStatus?: (status: AgentStatusUpdate) => void, signal?: AbortSignal): Promise<NotificationPayload[]> {
    const notifications: NotificationPayload[] = [];
    for (const hooks of this.getHooks()) {
      if (hooks.onTurnEnd) {
        signal?.throwIfAborted();
        const result = await hooks.onTurnEnd(
          { ...this.buildHookContext(iteration, sessionId, 0, reportStatus), signal },
          reason,
        );
        if (Array.isArray(result)) notifications.push(...result);
        else if (result) notifications.push(result);
        signal?.throwIfAborted();
      }
    }
    return notifications;
  }

  async callOnTurnNotices(reason: TurnEndReason, iteration: number, sessionId: string): Promise<Array<{ id: string; text: string }>> {
    const notices: Array<{ id: string; text: string }> = [];
    for (const hooks of this.getHooks()) {
      const notice = await hooks.onTurnNotice?.(this.buildHookContext(iteration, sessionId), reason);
      if (notice?.text.trim()) notices.push(notice);
    }
    return notices;
  }

  async callOnError(error: Error, iteration: number, sessionId: string): Promise<void> {
    for (const hooks of this.getHooks()) {
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
    this.sessionScopes.clear();
    try {
      await this.pluginHost.stopAll();
    } finally {
      await this.applicationScope.dispose();
    }
  }

  private getTurnScope(sessionId: string): TurnScope | undefined {
    return this.sessionScopes.get(sessionId)?.get(ACTIVE_TURN_SCOPE);
  }

  private getSessionRuntime(sessionId: string): SessionRuntimeDependencies | undefined {
    return this.sessionScopes.get(sessionId)?.get(SESSION_RUNTIME);
  }

  private getTools(): Tool[] {
    return [...this.getToolIndex().values()];
  }

  private getToolIndex(): Map<string, Tool> {
    const tools = new Map<string, Tool>();
    for (const tool of this.applicationScope.capabilities.resolveAll(TOOL_CAPABILITY)) {
      tools.set(tool.name, tool);
    }
    return tools;
  }

  private getChatCommandIndex(): Map<string, ChatCommand> {
    const commands = new Map<string, ChatCommand>();
    for (const command of this.applicationScope.capabilities.resolveAll(CHAT_COMMAND_CAPABILITY)) {
      for (const name of [command.name, ...(command.aliases ?? [])]) {
        commands.set(name.toLowerCase(), command);
      }
    }
    return commands;
  }

  private getHooks(): PluginHooks[] {
    return this.applicationScope.capabilities.resolveAll(PLUGIN_HOOKS_CAPABILITY);
  }
}

const NOOP_DISPOSABLE: Disposable = { dispose() {} };
let workspaceReloadNonce = 0;

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
