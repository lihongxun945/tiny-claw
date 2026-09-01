import type { Plugin, PluginContext } from "../plugins/types.js";
import type { Disposable } from "./disposable.js";

export type PluginKind = "core" | "builtin" | "workspace" | "external";

export type PluginConfigField =
  | { type: "string"; title: string; description?: string; required?: boolean; default?: string; secret?: boolean; minLength?: number; maxLength?: number }
  | { type: "number"; title: string; description?: string; required?: boolean; default?: number; min?: number; max?: number; integer?: boolean }
  | { type: "boolean"; title: string; description?: string; required?: boolean; default?: boolean }
  | { type: "select"; title: string; description?: string; required?: boolean; default?: string; options: Array<{ value: string; label: string }> }
  | { type: "json"; title: string; description?: string; required?: boolean; default?: unknown };

export interface PluginConfigDeclaration {
  fields: Record<string, PluginConfigField>;
}

export type PluginPathScope = "workspace" | "project" | "plugin-data";

export interface PluginPermissionDeclaration {
  tools?: string[];
  filesystem?: {
    read?: PluginPathScope[];
    write?: PluginPathScope[];
  };
  network?: { hosts: string[] };
  shell?: boolean;
  gatewayRoutes?: boolean;
}

export interface PluginManifest {
  id: string;
  version: string;
  description?: string;
  kind: PluginKind;
  requires?: Record<string, string>;
  optional?: Record<string, string>;
  provides?: string[];
  config?: PluginConfigDeclaration;
  permissions?: PluginPermissionDeclaration;
  /** 由旧 Plugin 接口适配生成，仅用于迁移期兼容。 */
  legacy?: boolean;
}

export interface KernelPlugin {
  manifest: PluginManifest;
  setup(context: PluginContext): void | Disposable | Promise<void | Disposable>;
}

export function isKernelPlugin(value: unknown): value is KernelPlugin {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<KernelPlugin>;
  return typeof candidate.manifest?.id === "string"
    && typeof candidate.manifest.version === "string"
    && typeof candidate.setup === "function";
}

export function isLegacyPlugin(value: unknown): value is Plugin {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Plugin>;
  return typeof candidate.name === "string" && typeof candidate.init === "function";
}

export function adaptLegacyPlugin(plugin: Plugin, kind: PluginKind): KernelPlugin {
  return {
    manifest: {
      id: plugin.name,
      version: "0.0.0",
      kind,
      legacy: true,
    },
    async setup(context) {
      await plugin.init(context);
      return plugin.destroy ? { dispose: () => plugin.destroy!() } : undefined;
    },
  };
}

export function normalizePlugin(value: unknown, kind: PluginKind): KernelPlugin {
  if (isKernelPlugin(value)) {
    return {
      ...value,
      manifest: { ...value.manifest, kind },
    };
  }
  if (isLegacyPlugin(value)) return adaptLegacyPlugin(value, kind);
  throw new Error("未导出有效的 Plugin 或 KernelPlugin");
}
