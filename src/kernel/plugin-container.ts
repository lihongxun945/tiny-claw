import type { PluginContext } from "../plugins/types.js";
import { DisposableStore } from "./disposable.js";
import type { KernelPlugin } from "./plugin.js";
import type { PluginConfigResult } from "./plugin-config.js";
import { inspectPluginPermissions, type PluginPermissionIssue } from "./plugin-permissions.js";

export type PluginState = "registered" | "starting" | "active" | "stopping" | "stopped" | "failed" | "blocked";

export class PluginContainer {
  private _disposables = new DisposableStore();
  state: PluginState = "registered";
  error?: Error;
  configResult: PluginConfigResult;
  readonly permissionIssues: PluginPermissionIssue[];

  constructor(
    readonly plugin: KernelPlugin,
    private readonly createContext: (plugin: KernelPlugin, disposables: DisposableStore, config: PluginConfigResult) => PluginContext,
    private readonly resolveConfig: (plugin: KernelPlugin) => PluginConfigResult,
  ) {
    this.configResult = resolveConfig(plugin);
    this.permissionIssues = inspectPluginPermissions(plugin.manifest);
  }

  get disposables(): DisposableStore {
    return this._disposables;
  }

  async start(): Promise<void> {
    if (this.state === "active") return;
    if (this.state !== "registered" && this.state !== "stopped" && this.state !== "failed" && this.state !== "blocked") {
      throw new Error(`插件 ${this.plugin.manifest.id} 当前状态 ${this.state}，无法启动`);
    }
    if (this.state !== "registered") this._disposables = new DisposableStore();
    this.state = "starting";
    this.error = undefined;
    this.configResult = this.resolveConfig(this.plugin);
    if (!this.configResult.valid) {
      const error = new Error(this.configResult.issues.filter((item) => item.severity === "error").map((item) => item.message).join("; "));
      this.block(error);
      throw error;
    }
    const permissionErrors = this.permissionIssues.filter((item) => item.severity === "error");
    if (permissionErrors.length > 0) {
      const error = new Error(permissionErrors.map((item) => item.message).join("; "));
      this.block(error);
      throw error;
    }
    try {
      const cleanup = await this.plugin.setup(this.createContext(this.plugin, this._disposables, this.configResult));
      if (cleanup) this._disposables.add(cleanup);
      this.state = "active";
    } catch (error) {
      this.error = toError(error);
      this.state = "failed";
      try {
        await this._disposables.dispose();
      } catch (disposeError) {
        this.error = new AggregateError([this.error, disposeError], `插件 ${this.plugin.manifest.id} 启动回滚失败`);
      }
      throw this.error;
    }
  }

  async stop(): Promise<void> {
    if (this.state === "stopped" || this.state === "registered" || this.state === "blocked") {
      this.state = "stopped";
      return;
    }
    if (this.state === "stopping") return;
    this.state = "stopping";
    try {
      await this._disposables.dispose();
      this.state = "stopped";
    } catch (error) {
      this.error = toError(error);
      this.state = "stopped";
      throw this.error;
    }
  }

  block(error: Error): void {
    this.error = error;
    this.state = "blocked";
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
