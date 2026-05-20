import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadIdentity } from "./workspace.js";
import type { Config } from "./types.js";

const DEFAULTS: Partial<Config> = {
  maxTokens: 4096,
  historyWindowSize: 5,
};

export function loadConfig(workspacePath: string): Config {
  const configPath = resolve(workspacePath, "config.json");

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    throw new Error(`无法读取配置文件: ${configPath}`);
  }

  if (!raw.apiUrl) throw new Error("配置缺少 apiUrl");
  if (!raw.apiKey) throw new Error("配置缺少 apiKey");
  if (!raw.model) throw new Error("配置缺少 model");

  return {
    apiUrl: raw.apiUrl as string,
    apiKey: raw.apiKey as string,
    model: raw.model as string,
    maxTokens: (raw.maxTokens as number) ?? DEFAULTS.maxTokens!,
    historyWindowSize: (raw.historyWindowSize as number) ?? DEFAULTS.historyWindowSize!,
    workspacePath,
    systemPrompt: loadIdentity(workspacePath),
  };
}