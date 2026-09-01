import type { PluginManifest, PluginPermissionDeclaration } from "./plugin.js";

export interface PluginPermissionIssue {
  capability: string;
  message: string;
  severity: "error" | "warning";
}

export function inspectPluginPermissions(manifest: PluginManifest): PluginPermissionIssue[] {
  const permissions = manifest.permissions;
  if (permissions) return [];
  if (manifest.legacy) return [];
  return [{
    capability: "manifest.permissions",
    message: `插件 ${manifest.id} 未声明权限`,
    severity: manifest.kind === "core" ? "warning" : "error",
  }];
}

export function assertPluginRegistrationPermission(
  manifest: PluginManifest,
  capability: "route" | "tool",
  detail?: string,
): void {
  if ((manifest.kind === "core" || manifest.legacy) && !manifest.permissions) return;
  const permissions = manifest.permissions;
  if (capability === "route" && permissions?.gatewayRoutes !== true) {
    throw new Error(`插件 ${manifest.id} 未声明 gatewayRoutes 权限，不能注册 HTTP 路由`);
  }
  if (capability === "tool" && (!detail || !permissions?.tools?.includes(detail))) {
    throw new Error(`插件 ${manifest.id} 未声明工具 ${detail ?? "unknown"}，不能注册该工具`);
  }
}

export function normalizePluginPermissions(value: PluginPermissionDeclaration | undefined): PluginPermissionDeclaration {
  return structuredClone(value ?? {});
}
