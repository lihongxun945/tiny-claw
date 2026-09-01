import type { PluginConfigDeclaration, PluginConfigField } from "./plugin.js";

export interface PluginConfigIssue {
  path: string;
  code: "required" | "invalid_type" | "invalid_value" | "out_of_range" | "unknown_field";
  message: string;
  severity: "error" | "warning";
}

export interface PluginConfigResult {
  value: Readonly<Record<string, unknown>>;
  issues: PluginConfigIssue[];
  valid: boolean;
}

export function resolvePluginConfig(
  declaration: PluginConfigDeclaration | undefined,
  raw: Record<string, unknown> | undefined,
): PluginConfigResult {
  const input = raw ?? {};
  if (!declaration) return { value: deepFreeze({ ...input }), issues: [], valid: true };
  const value: Record<string, unknown> = {};
  const issues: PluginConfigIssue[] = [];

  for (const [key, field] of Object.entries(declaration.fields)) {
    const configured = input[key];
    if (configured === undefined) {
      if ("default" in field && field.default !== undefined) value[key] = clone(field.default);
      else if (field.required) issues.push(issue(key, "required", `配置字段 ${key} 为必填项`));
      continue;
    }
    const fieldIssue = validateField(key, configured, field);
    if (fieldIssue) issues.push(fieldIssue);
    else value[key] = clone(configured);
  }

  for (const [key, configured] of Object.entries(input)) {
    if (Object.hasOwn(declaration.fields, key)) continue;
    value[key] = clone(configured);
    issues.push(issue(key, "unknown_field", `配置字段 ${key} 未在插件 Manifest 中声明`, "warning"));
  }

  return {
    value: deepFreeze(value),
    issues,
    valid: !issues.some((item) => item.severity === "error"),
  };
}

export function maskPluginConfig(
  declaration: PluginConfigDeclaration | undefined,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const masked = clone(value) as Record<string, unknown>;
  for (const [key, field] of Object.entries(declaration?.fields ?? {})) {
    if (field.type === "string" && field.secret && typeof masked[key] === "string" && masked[key]) {
      masked[key] = `${(masked[key] as string).slice(0, 4)}***`;
    }
  }
  return masked;
}

export function restoreMaskedPluginConfig(
  declaration: PluginConfigDeclaration | undefined,
  value: Record<string, unknown>,
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const restored = clone(value) as Record<string, unknown>;
  for (const [key, field] of Object.entries(declaration?.fields ?? {})) {
    if (field.type === "string" && field.secret && typeof restored[key] === "string" && restored[key].endsWith("***")) {
      restored[key] = existing[key];
    }
  }
  return restored;
}

function validateField(key: string, value: unknown, field: PluginConfigField): PluginConfigIssue | undefined {
  if (field.type === "string" || field.type === "select") {
    if (typeof value !== "string") return issue(key, "invalid_type", `配置字段 ${key} 必须是字符串`);
    if (field.type === "select" && !field.options.some((option) => option.value === value)) {
      return issue(key, "invalid_value", `配置字段 ${key} 包含不支持的值`);
    }
    if (field.type === "string" && field.minLength !== undefined && value.length < field.minLength) {
      return issue(key, "out_of_range", `配置字段 ${key} 长度不能小于 ${field.minLength}`);
    }
    if (field.type === "string" && field.maxLength !== undefined && value.length > field.maxLength) {
      return issue(key, "out_of_range", `配置字段 ${key} 长度不能大于 ${field.maxLength}`);
    }
    return undefined;
  }
  if (field.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return issue(key, "invalid_type", `配置字段 ${key} 必须是数字`);
    if (field.integer && !Number.isInteger(value)) return issue(key, "invalid_value", `配置字段 ${key} 必须是整数`);
    if (field.min !== undefined && value < field.min) return issue(key, "out_of_range", `配置字段 ${key} 不能小于 ${field.min}`);
    if (field.max !== undefined && value > field.max) return issue(key, "out_of_range", `配置字段 ${key} 不能大于 ${field.max}`);
    return undefined;
  }
  if (field.type === "boolean" && typeof value !== "boolean") return issue(key, "invalid_type", `配置字段 ${key} 必须是布尔值`);
  return undefined;
}

function issue(path: string, code: PluginConfigIssue["code"], message: string, severity: PluginConfigIssue["severity"] = "error"): PluginConfigIssue {
  return { path, code, message, severity };
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
