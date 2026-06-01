import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolDefinition } from "../types.js";
import { loadIdentity } from "../workspace/workspace.js";
import { loadAllMemories } from "../tools/memory.js";
import { listSkills } from "../tools/skill.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadTemplate(workspacePath: string): string {
  const customPath = resolve(workspacePath, "system_prompt.md");
  if (existsSync(customPath)) {
    return readFileSync(customPath, "utf-8");
  }
  return readFileSync(resolve(__dirname, "default.md"), "utf-8");
}

function buildSearchGuidance(provider: string): string {
  if (provider === "duckduckgo") {
    return "使用 web_search 时，当前搜索 provider 是 DuckDuckGo Instant Answer，query 必须是 1-3 个简短英文实体关键词（如 'iPhone 17'、'Python'），不要加限定词、描述词或完整句子。先用最短关键词搜索，搜索到的信息由你负责总结回答。";
  }

  return "使用 web_search 时，根据用户问题构造清晰、具体的搜索 query；当前搜索 provider 支持常规搜索查询，不要求压缩成 1-3 个英文实体关键词。搜索结果由你负责总结回答。";
}

export function buildSystemPrompt(workspacePath: string, tools: ToolDefinition[], searchProvider = "ollama"): string {
  const template = loadTemplate(workspacePath);

  const identity = loadIdentity(workspacePath);

  const memories = loadAllMemories(workspacePath);

  const skills = listSkills(workspacePath);
  const skillsText = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");

  const toolsText = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");

  const currentDate = new Date().toISOString().slice(0, 10);

  return template
    .replace(/\{\{identity}}/g, identity)
    .replace(/\{\{memories}}/g, memories)
    .replace(/\{\{skills}}/g, skillsText)
    .replace(/\{\{tools}}/g, toolsText)
    .replace(/\{\{current_date}}/g, currentDate)
    .replace(/\{\{search_guidance}}/g, buildSearchGuidance(searchProvider))
    .replace(/\{\{[^}]+}}/g, "");
}
