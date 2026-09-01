import type { PluginContext } from "../plugins/types.js";
import type { DisposableStore } from "./disposable.js";
import { PluginContainer, type PluginState } from "./plugin-container.js";
import { PluginGraph } from "./plugin-graph.js";
import type { KernelPlugin, PluginKind } from "./plugin.js";
import type { PluginConfigIssue, PluginConfigResult } from "./plugin-config.js";
import { resolvePluginConfig } from "./plugin-config.js";
import type { PluginPermissionDeclaration } from "./plugin.js";
import type { PluginPermissionIssue } from "./plugin-permissions.js";

export interface PluginSnapshot {
  id: string;
  version: string;
  kind: PluginKind;
  state: PluginState;
  enabled: boolean;
  canToggle: boolean;
  error?: string;
  description?: string;
  requires: Record<string, string>;
  optional: Record<string, string>;
  config: { valid: boolean; issues: PluginConfigIssue[] };
  permissions: { declared: PluginPermissionDeclaration; issues: PluginPermissionIssue[] };
}

export class PluginHost {
  private readonly containers = new Map<string, PluginContainer>();
  private readonly reloaders = new Map<string, () => Promise<KernelPlugin>>();
  private readonly disabled = new Set<string>();
  private startOrder: string[] = [];

  constructor(
    private readonly createContext: (plugin: KernelPlugin, disposables: DisposableStore, config: PluginConfigResult) => PluginContext,
    private readonly resolveConfig: (plugin: KernelPlugin) => PluginConfigResult = (plugin) => resolvePluginConfig(plugin.manifest.config, undefined),
  ) {}

  register(plugin: KernelPlugin, reload?: () => Promise<KernelPlugin>): void {
    const id = plugin.manifest.id;
    if (!id.trim()) throw new Error("插件 id 不能为空");
    if (this.containers.has(id)) throw new Error(`插件 id 重复: ${id}`);
    this.containers.set(id, new PluginContainer(plugin, this.createContext, this.resolveConfig));
    if (reload) this.reloaders.set(id, reload);
  }

  setInitialEnabled(id: string, enabled: boolean): void {
    const container = this.requireContainer(id);
    if (container.plugin.manifest.kind === "core" && !enabled) throw new Error(`核心插件 ${id} 不可禁用`);
    if (enabled) this.disabled.delete(id);
    else this.disabled.add(id);
  }

  async startAll(): Promise<void> {
    const plugins = new Map([...this.containers].map(([id, container]) => [id, container.plugin]));
    const graph = new PluginGraph(plugins);
    const { startOrder, issues } = graph.analyze();
    for (const [id, error] of issues) {
      const container = this.containers.get(id)!;
      if (container.state === "active") continue;
      container.block(error);
      if (container.plugin.manifest.kind === "core") {
        await this.stopAll();
        throw error;
      }
      console.error(`插件 ${id} 无法启动: ${error.message}`);
    }

    for (const id of startOrder) {
      const container = this.containers.get(id)!;
      if (this.disabled.has(id)) continue;
      if (container.state === "active") continue;
      const failedDependency = Object.keys(container.plugin.manifest.requires ?? {})
        .find((dependencyId) => this.containers.get(dependencyId)?.state !== "active");
      if (failedDependency) {
        const error = new Error(`插件 ${id} 因依赖 ${failedDependency} 未激活而无法启动`);
        container.block(error);
        if (container.plugin.manifest.kind === "core") {
          await this.stopAll();
          throw error;
        }
        console.error(error.message);
        continue;
      }
      try {
        await container.start();
        if (!this.startOrder.includes(id)) this.startOrder.push(id);
        console.log(`插件已加载: ${id} (${kindLabel(container.plugin.manifest.kind)})`);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (container.plugin.manifest.kind === "core") {
          await this.stopAll();
          throw failure;
        }
        console.error(`插件 ${id} 启动失败: ${failure.message}`);
      }
    }
  }

  async stopPlugin(id: string): Promise<void> {
    const container = this.requireContainer(id);
    const graph = new PluginGraph(new Map([...this.containers].map(([key, value]) => [key, value.plugin])));
    const activeDependents = graph.getDependents(id)
      .filter((dependentId) => this.containers.get(dependentId)?.state === "active");
    if (activeDependents.length > 0) {
      throw new Error(`插件 ${id} 仍被活动插件依赖: ${activeDependents.join(", ")}`);
    }
    await container.stop();
    this.startOrder = this.startOrder.filter((pluginId) => pluginId !== id);
  }

  async startPlugin(id: string): Promise<void> {
    const container = this.requireContainer(id);
    if (this.disabled.has(id)) throw new Error(`插件 ${id} 已禁用`);
    if (container.state === "active") return;
    const plugins = new Map([...this.containers].map(([pluginId, value]) => [pluginId, value.plugin]));
    const { issues } = new PluginGraph(plugins).analyze();
    const issue = issues.get(id);
    if (issue) {
      container.block(issue);
      throw issue;
    }
    for (const dependencyId of Object.keys(container.plugin.manifest.requires ?? {})) {
      if (this.disabled.has(dependencyId)) throw new Error(`插件 ${id} 的必需依赖 ${dependencyId} 已禁用`);
      await this.startPlugin(dependencyId);
    }
    for (const dependencyId of Object.keys(container.plugin.manifest.optional ?? {})) {
      if (!this.containers.has(dependencyId)) continue;
      try {
        await this.startPlugin(dependencyId);
      } catch {
        // Optional dependencies never block activation.
      }
    }
    await container.start();
    if (!this.startOrder.includes(id)) this.startOrder.push(id);
    console.log(`插件已加载: ${id} (${kindLabel(container.plugin.manifest.kind)})`);
    const current = this.requireContainer(id);
    if ((current.state as PluginState) !== "active") throw current.error ?? new Error(`插件 ${id} 未能启动`);
  }

  async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    const container = this.requireContainer(id);
    if (container.plugin.manifest.kind === "core") throw new Error(`核心插件 ${id} 不可修改启用状态`);
    if (enabled) {
      this.disabled.delete(id);
      try {
        await this.startPlugin(id);
      } catch (error) {
        this.disabled.add(id);
        throw error;
      }
      return;
    }
    await this.stopPlugin(id);
    this.disabled.add(id);
  }

  async reloadPlugin(id: string): Promise<void> {
    let container = this.requireContainer(id);
    if (container.state === "active") await this.stopPlugin(id);
    const reload = this.reloaders.get(id);
    if (reload) {
      const plugin = await reload();
      if (plugin.manifest.id !== id) {
        throw new Error(`插件 ${id} 重载后导出了不同 id: ${plugin.manifest.id}`);
      }
      container = new PluginContainer(plugin, this.createContext, this.resolveConfig);
      this.containers.set(id, container);
    }
    await this.startPlugin(id);
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.startOrder].reverse()) {
      try {
        await this.containers.get(id)?.stop();
      } catch (error) {
        console.error(`插件 ${id} 销毁失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.startOrder = [];
  }

  getPlugin(id: string): PluginSnapshot | undefined {
    const container = this.containers.get(id);
    return container ? snapshot(container, !this.disabled.has(id)) : undefined;
  }

  listPlugins(): PluginSnapshot[] {
    return [...this.containers.entries()].map(([id, container]) => snapshot(container, !this.disabled.has(id)));
  }

  getPluginManifest(id: string): KernelPlugin["manifest"] | undefined {
    return this.containers.get(id)?.plugin.manifest;
  }

  private requireContainer(id: string): PluginContainer {
    const container = this.containers.get(id);
    if (!container) throw new Error(`插件不存在: ${id}`);
    return container;
  }
}

function snapshot(container: PluginContainer, enabled: boolean): PluginSnapshot {
  return {
    id: container.plugin.manifest.id,
    version: container.plugin.manifest.version,
    kind: container.plugin.manifest.kind,
    state: container.state,
    enabled,
    canToggle: container.plugin.manifest.kind !== "core",
    error: container.error?.message,
    description: container.plugin.manifest.description,
    requires: { ...container.plugin.manifest.requires },
    optional: { ...container.plugin.manifest.optional },
    config: { valid: container.configResult.valid, issues: [...container.configResult.issues] },
    permissions: {
      declared: structuredClone(container.plugin.manifest.permissions ?? {}),
      issues: [...container.permissionIssues],
    },
  };
}

function kindLabel(kind: PluginKind): string {
  if (kind === "core") return "核心";
  if (kind === "workspace") return "workspace/plugins/";
  return kind === "builtin" ? "内置" : "外部";
}
