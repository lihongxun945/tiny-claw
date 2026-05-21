import type { Plugin, PluginContext, RegisteredRoute } from "./types.js";

type PluginModule = { default: Plugin };

export interface PluginLoadOptions {
  builtin?: string[];
  external?: string[];
}

export async function loadPlugins(
  options: PluginLoadOptions,
  createContext: (pluginName: string) => PluginContext,
): Promise<Plugin[]> {
  const plugins: Plugin[] = [];

  for (const name of options.builtin ?? []) {
    const mod = await import(`./${name}/index.js`) as PluginModule;
    const plugin = mod.default;
    if (!plugin?.name || typeof plugin.init !== "function") {
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
    if (!plugin?.name || typeof plugin.init !== "function") {
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
