import { ToolRegistry } from "./tools/registry.js";
import { loadPlugins, destroyPlugins } from "./plugins/loader.js";
import { corePlugins } from "./plugins/core/index.js";
import type {
  Plugin,
  PluginContext,
  PluginHooks,
  HookContext,
  PromptSection,
  RegisteredRoute,
  RouteDefinition,
} from "./plugins/types.js";
import type { Config, Tool, ToolDefinition, Message, ChatResponse } from "./types.js";
import type { AnthropicClient } from "./client.js";
import type { AgentSession } from "./agent.js";

export interface PluginManagerOptions {
  builtinPlugins?: string[];
  externalPlugins?: string[];
  pluginConfigs?: Record<string, Record<string, unknown>>;
}

export class PluginManager {
  private registry = new ToolRegistry();
  private hooks: PluginHooks[] = [];
  private promptSections: PromptSection[] = [];
  private routes: RegisteredRoute[] = [];
  private loadedPlugins: Plugin[] = [];
  private config?: Config;
  private client?: AnthropicClient;
  private sessionFactory?: {
    getOrCreateSession: (id: string, prefix?: string) => AgentSession;
    deleteSession: (id: string) => boolean;
  };

  constructor(private workspacePath: string) {}

  /** 设置运行时依赖（在 AgentSession 创建后调用） */
  setRuntimeDeps(config: Config, client: AnthropicClient): void {
    this.config = config;
    this.client = client;
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
    if (!options.builtinPlugins?.length && !options.externalPlugins?.length) return;

    const plugins = await loadPlugins(
      {
        builtin: options.builtinPlugins,
        external: options.externalPlugins,
      },
      (pluginName) => this.createPluginContext(pluginName),
    );
    this.loadedPlugins.push(...plugins);
  }

  private createPluginContext(pluginName: string): PluginContext {
    const pm = this;
    return {
      config: pm.pluginConfigs?.[pluginName] ?? {},
      workspacePath: pm.workspacePath,
      registerRoute(route: RouteDefinition) {
        pm.routes.push({ ...route, pluginName });
      },
      registerTool(tool: Tool) {
        pm.registry.register(tool);
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

  getToolDefinitions(): ToolDefinition[] {
    return this.registry.getDefinitions();
  }

  getTool(name: string): Tool | undefined {
    return this.registry.getTool(name);
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

  private buildHookContext(iteration: number, turnStartIndex = 0): HookContext {
    if (!this.config || !this.client) {
      throw new Error("PluginManager: 未设置运行时依赖，请先调用 setRuntimeDeps");
    }
    return {
      sessionId: "",
      iteration,
      turnStartIndex,
      config: this.config,
      client: this.client,
      getToolDefinitions: () => this.getToolDefinitions(),
    };
  }

  async callOnBeforeChat(input: string, sessionId: string): Promise<{ input: string; abort?: string }> {
    let result: { input: string; abort?: string } = { input };
    for (const hooks of this.hooks) {
      if (hooks.onBeforeChat) {
        const r = await hooks.onBeforeChat(
          { ...this.buildHookContext(0), sessionId },
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
          { ...this.buildHookContext(0), sessionId },
          result,
        );
        if (r !== undefined) result = r;
      }
    }
    return result;
  }

  async callOnBeforeModelCall(messages: Message[], turnStartIndex: number, iteration: number, sessionId: string): Promise<Message[]> {
    let result = messages;
    for (const hooks of this.hooks) {
      if (hooks.onBeforeModelCall) {
        const r = await hooks.onBeforeModelCall(
          { ...this.buildHookContext(iteration, turnStartIndex), sessionId },
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
          { ...this.buildHookContext(iteration), sessionId },
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
          { ...this.buildHookContext(iteration), sessionId },
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
          { ...this.buildHookContext(iteration), sessionId },
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
          { ...this.buildHookContext(iteration), sessionId },
        );
      }
    }
  }

  async callOnError(error: Error, iteration: number, sessionId: string): Promise<void> {
    for (const hooks of this.hooks) {
      if (hooks.onError) {
        await hooks.onError(
          { ...this.buildHookContext(iteration), sessionId },
          error,
        );
      }
    }
  }

  // ========== Cleanup ==========

  async destroy(): Promise<void> {
    await destroyPlugins(this.loadedPlugins);
  }
}