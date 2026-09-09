import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, HookContext } from "../types.js";
import { loadIdentity } from "../../workspace/workspace.js";
import { formatSkillName, listAvailableSkills } from "../../tools/skill.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadTemplate(workspacePath: string): string {
  const customPath = resolve(workspacePath, "system_prompt.md");
  if (existsSync(customPath)) {
    return readFileSync(customPath, "utf-8");
  }
  return readFileSync(resolve(__dirname, "../../prompts/default.md"), "utf-8");
}

function buildSearchGuidance(provider: string): string {
  if (provider === "duckduckgo") {
    return "使用 web_search 时，当前搜索 provider 是 DuckDuckGo Instant Answer，query 必须是 1-3 个简短英文实体关键词（如 'iPhone 17'、'Python'），不要加限定词、描述词或完整句子。先用最短关键词搜索，搜索到的信息由你负责总结回答。";
  }

  return "使用 web_search 时，根据用户问题构造清晰、具体的搜索 query；当前搜索 provider 支持常规搜索查询，不要求压缩成 1-3 个英文实体关键词。搜索结果由你负责总结回答。";
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
          const skills = listAvailableSkills(workspacePath, _ctx.sessionContext);
          const skillsText = skills.map((s) => `- ${formatSkillName(s)}: ${s.description}`).join("\n");
          const currentDate = new Date().toISOString().slice(0, 10);
          const searchGuidance = buildSearchGuidance(_ctx.config.searchProvider);

          let result = template
            .replace(/\{\{identity}}/g, identity)
            .replace(/\{\{memories}}/g, "")
            .replace(/\{\{profile}}/g, "")
            .replace(/\{\{skills}}/g, skillsText)
            .replace(/\{\{current_date}}/g, currentDate)
            .replace(/\{\{search_guidance}}/g, searchGuidance)
            .replace(/\{\{(?!tools}})[^}]+}}/g, "");

          return result;
        }
        return prompt;
      },
      onBuildTurnPrompt(hookCtx, prompt) {
        const tools = hookCtx.getToolDefinitions();
        const toolsText = "仅可调用本次请求开放的工具；历史记录中的工具不代表当前可用。阶段变更后等待下一次请求更新工具列表。\n"
          + (tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n") || "当前无可用工具。");
        return prompt.includes("{{tools}}")
          ? prompt.replace(/\{\{tools}}/g, () => toolsText)
          : `${prompt}\n\n## 当前可用工具\n${toolsText}`;
      },
    });
  },
};
