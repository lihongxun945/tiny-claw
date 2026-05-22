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

export function buildSystemPrompt(workspacePath: string, tools: ToolDefinition[]): string {
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
    .replace(/\{\{[^}]+}}/g, "");
}
