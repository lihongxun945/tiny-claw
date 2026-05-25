import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, HookContext } from "../types.js";
import { loadIdentity } from "../../workspace/workspace.js";
import { loadAllMemories } from "../../tools/memory.js";
import { listSkills } from "../../tools/skill.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadTemplate(workspacePath: string): string {
  const customPath = resolve(workspacePath, "system_prompt.md");
  if (existsSync(customPath)) {
    return readFileSync(customPath, "utf-8");
  }
  return readFileSync(resolve(__dirname, "../../prompts/default.md"), "utf-8");
}

export const corePromptsPlugin: Plugin = {
  name: "core-prompts",
  async init(ctx) {
    const template = loadTemplate(ctx.workspacePath);
    const identity = loadIdentity(ctx.workspacePath);
    const workspacePath = ctx.workspacePath;

    ctx.registerHooks({
      onBuildPrompt: (_ctx: HookContext, prompt: string) => {
        // 首次构建时从模板开始
        if (prompt === "") {
          const tools = _ctx.getToolDefinitions();
          const memories = loadAllMemories(workspacePath);
          const skills = listSkills(workspacePath);
          const skillsText = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
          const toolsText = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
          const currentDate = new Date().toISOString().slice(0, 10);

          let result = template
            .replace(/\{\{identity}}/g, identity)
            .replace(/\{\{memories}}/g, memories)
            .replace(/\{\{skills}}/g, skillsText)
            .replace(/\{\{tools}}/g, toolsText)
            .replace(/\{\{current_date}}/g, currentDate)
            .replace(/\{\{[^}]+}}/g, "");

          return result;
        }
        return prompt;
      },
    });
  },
};