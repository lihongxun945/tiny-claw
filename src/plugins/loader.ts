import type { Plugin, PluginContext } from "./types.js";
import { isLegacyPlugin, normalizePlugin, type KernelPlugin } from "../kernel/plugin.js";

type PluginModule = { default: unknown };

export interface PluginLoadOptions {
  builtin?: string[];
  external?: string[];
}

export interface DiscoveredPlugin {
  plugin: KernelPlugin;
  source: string;
}

export async function discoverPlugins(options: PluginLoadOptions): Promise<DiscoveredPlugin[]> {
  const plugins: DiscoveredPlugin[] = [];
  for (const name of options.builtin ?? []) {
    const mod = await import(`./${name}/index.js`) as PluginModule;
    plugins.push({ plugin: normalizePlugin(mod.default, "builtin"), source: `内置: ${name}` });
  }
  for (const specifier of options.external ?? []) {
    const mod = await import(specifier) as PluginModule;
    plugins.push({ plugin: normalizePlugin(mod.default, "external"), source: `外部: ${specifier}` });
  }
  return plugins;
}

export async function loadPlugins(
  options: PluginLoadOptions,
  createContext: (pluginName: string) => PluginContext,
): Promise<Plugin[]> {
  const plugins: Plugin[] = [];

  for (const name of options.builtin ?? []) {
    const mod = await import(`./${name}/index.js`) as PluginModule;
    const plugin = mod.default;
    if (!isLegacyPlugin(plugin)) {
      throw new Error(`内置插件 "${name}" 未导出有效的 Plugin`);
    }
    const ctx = createContext(plugin.name);
    await plugin.init(ctx);
    plugins.push(plugin);
    console.log(`插件已加载: ${plugin.name} (内置)`);
  }

  for (const specifier of options.external ?? []) {
    const mod = await import(specifier) as PluginModule;
    const plugin = mod.default;
    if (!isLegacyPlugin(plugin)) {
      throw new Error(`外部插件 "${specifier}" 未导出有效的 Plugin`);
    }
    const ctx = createContext(plugin.name);
    await plugin.init(ctx);
    plugins.push(plugin);
    console.log(`插件已加载: ${plugin.name} (外部: ${specifier})`);
  }

  return plugins;
}

export async function destroyPlugins(plugins: Plugin[]): Promise<void> {
  for (const plugin of plugins) {
    if (plugin.destroy) {
      try {
        await plugin.destroy();
      } catch (err) {
        console.error(`插件 ${plugin.name} 销毁失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
