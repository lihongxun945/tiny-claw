import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadIdentity } from "./workspace/workspace.js";
import type { Config } from "./types.js";

const DEFAULTS: Partial<Config> = {
  maxTokens: 4096,
  maxContextTokens: 128000,
  contextCompressionThreshold: 0.7,
  historyWindowSize: 5,
  maxAgentIterations: 0,
  searchProvider: "duckduckgo",
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
    maxContextTokens: (raw.maxContextTokens as number) ?? DEFAULTS.maxContextTokens!,
    contextCompressionThreshold: (raw.contextCompressionThreshold as number) ?? DEFAULTS.contextCompressionThreshold!,
    historyWindowSize: (raw.historyWindowSize as number) ?? DEFAULTS.historyWindowSize!,
    maxAgentIterations: (raw.maxAgentIterations as number) ?? DEFAULTS.maxAgentIterations!,
    searchProvider: (raw.searchProvider as Config["searchProvider"]) ?? DEFAULTS.searchProvider!,
    searxngUrl: raw.searxngUrl as string | undefined,
    braveApiKey: raw.braveApiKey as string | undefined,
    enabledPlugins: raw.enabledPlugins as string[] | undefined,
    externalPlugins: raw.externalPlugins as string[] | undefined,
    plugins: raw.plugins as Record<string, Record<string, unknown>> | undefined,
    subAgent: raw.subAgent as Config["subAgent"] | undefined,
    sessionSummary: raw.sessionSummary as Config["sessionSummary"] | undefined,
    workspacePath,
    systemPrompt: loadIdentity(workspacePath),
  };
}
