import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import type { Config, SessionContext, Tool, ToolExecutionContext } from "../types.js";
import { resolveRootFile, resolveWorkspaceFile } from "./workspace-path.js";
import { checkDangerousToolPermission, getToolPermissionMode } from "./permission.js";

export interface SkillMeta {
  name: string;
  description: string;
  source?: "workspace" | "project";
}

function skillsDir(workspacePath: string): string {
  return resolve(workspacePath, "skills");
}

const PROJECT_SKILL_DIRS = [".agents/skills", ".claude/skills"];

/** 解析 SKILL.md 的 frontmatter 和 body */
function parseSkillMd(content: string): { description: string; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = match[2].trim();

  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
  if (!descMatch) return null;

  return {
    description: descMatch[1].trim(),
    body,
  };
}

interface SkillLocation {
  source: "workspace" | "project";
  root: string;
  dir: string;
}

function projectSkillDirs(projectRoot: string): string[] {
  return PROJECT_SKILL_DIRS.map((dir) => resolve(projectRoot, dir));
}

/** 扫描技能目录下的子文件夹，每个含 SKILL.md 的即为一个技能 */
function listSkillsInDir(location: SkillLocation): SkillMeta[] {
  const dir = location.dir;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const skills: SkillMeta[] = [];
  for (const entry of entries) {
    try {
      const skillPath = location.source === "workspace"
        ? resolveWorkspaceFile(location.root, resolve(dir, entry))
        : resolveRootFile(location.root, resolve(dir, entry));
      if (!statSync(skillPath).isDirectory()) continue;
      const mdPath = resolve(skillPath, "SKILL.md");
      const content = readFileSync(mdPath, "utf-8");
      const parsed = parseSkillMd(content);
      if (parsed) {
        skills.push({ name: entry, description: parsed.description, source: location.source });
      }
    } catch {
      // 跳过无 SKILL.md 或无法读取的目录
    }
  }
  return skills;
}

export function listWorkspaceSkills(workspacePath: string): SkillMeta[] {
  return listSkillsInDir({ source: "workspace", root: workspacePath, dir: skillsDir(workspacePath) });
}

export function listProjectSkills(projectRoot: string): SkillMeta[] {
  const seen = new Set<string>();
  const skills: SkillMeta[] = [];
  for (const dir of projectSkillDirs(projectRoot)) {
    for (const skill of listSkillsInDir({ source: "project", root: projectRoot, dir })) {
      const key = `${skill.source}/${skill.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      skills.push(skill);
    }
  }
  return skills;
}

export function listAvailableSkills(workspacePath: string, sessionContext?: SessionContext): SkillMeta[] {
  const workspaceSkills = listWorkspaceSkills(workspacePath);
  if (sessionContext?.mode !== "project" || !sessionContext.project?.root) return workspaceSkills;
  return [...listProjectSkills(sessionContext.project.root), ...workspaceSkills];
}

/** 兼容旧调用：列出 workspace 技能 */
export function listSkills(workspacePath: string): SkillMeta[] {
  return listWorkspaceSkills(workspacePath);
}

interface SkillLoadResult {
  body: string;
  approvalResult?: string;
  source: "workspace" | "project";
  skillDir: string;
}

interface DynamicCommandResult {
  body: string;
  approvalResult?: string;
}

/** 执行技能中的动态命令（`!`command`` 语法） */
function executeDynamicCommands(workspacePath: string, body: string, skillDir: string, args: string, config: Config, context?: ToolExecutionContext): DynamicCommandResult {
  // 替换 $ARGUMENTS
  let result = body.replace(/\$ARGUMENTS/g, args);
  // 替换 ${CLAUDE_SKILL_DIR}
  result = result.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir);
  let approvalResult: string | undefined;

  // 处理 !`command` 语法：执行命令并替换为输出
  result = result.replace(/!`([^`]+)`/g, (_, cmd) => {
    const permission = checkDangerousToolPermission({
      workspacePath,
      config,
      toolName: "bash",
      args: { command: cmd, cwd: skillDir },
      context,
      command: cmd,
      cwd: skillDir,
    });
    if (!permission.allowed) {
      approvalResult ??= permission.result;
      return getToolPermissionMode(config, "bash") === "deny"
        ? `[动态命令已禁用: ${cmd}]`
        : `[动态命令需要用户确认，批准后系统会立即继续执行。命令: ${cmd}]`;
    }
    try {
      return execSync(cmd, { encoding: "utf-8", timeout: 10_000, cwd: skillDir }).trim();
    } catch (err) {
      return `[命令执行失败: ${err instanceof Error ? err.message : String(err)}]`;
    }
  });

  // 处理 ```! 代码块语法
  result = result.replace(/```!\n([\s\S]*?)```/g, (_, code) => {
    const command = code.trim();
    const permission = checkDangerousToolPermission({
      workspacePath,
      config,
      toolName: "bash",
      args: { command, cwd: skillDir },
      context,
      command,
      cwd: skillDir,
    });
    if (!permission.allowed) {
      approvalResult ??= permission.result;
      return getToolPermissionMode(config, "bash") === "deny"
        ? `[动态命令已禁用: ${command}]`
        : `[动态命令需要用户确认，批准后系统会立即继续执行。命令: ${command}]`;
    }
    try {
      return execSync(command, { encoding: "utf-8", timeout: 10_000, cwd: skillDir }).trim();
    } catch (err) {
      return `[命令执行失败: ${err instanceof Error ? err.message : String(err)}]`;
    }
  });

  return { body: result, approvalResult };
}

/** 加载技能的完整指令内容 */
function loadSkillFromLocation(
  workspacePath: string,
  name: string,
  args: string,
  config: Config,
  location: SkillLocation,
  context?: ToolExecutionContext,
): SkillLoadResult | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return null;

  try {
    const skillPath = location.source === "workspace"
      ? resolveWorkspaceFile(location.root, resolve(location.dir, name))
      : resolveRootFile(location.root, resolve(location.dir, name));
    const mdPath = resolve(skillPath, "SKILL.md");
    if (!statSync(skillPath).isDirectory()) return null;
    const content = readFileSync(mdPath, "utf-8");
    const parsed = parseSkillMd(content);
    if (!parsed) return null;
    return {
      ...executeDynamicCommands(workspacePath, parsed.body, skillPath, args, config, context),
      source: location.source,
      skillDir: skillPath,
    };
  } catch {
    return null;
  }
}

/** 加载技能的完整指令内容 */
function loadSkill(workspacePath: string, name: string, args: string, config: Config, context?: ToolExecutionContext): SkillLoadResult | null {
  const nameParts = name.split("/");
  if (nameParts.length > 2) return null;
  const [maybeSource, maybeName] = nameParts;
  const requestedSource = maybeName && (maybeSource === "workspace" || maybeSource === "project") ? maybeSource : undefined;
  const skillName = requestedSource ? maybeName : name;
  if (!/^[a-zA-Z0-9_-]+$/.test(skillName)) return null;

  const locations: SkillLocation[] = [];
  if (requestedSource !== "workspace" && context?.sessionContext?.mode === "project" && context.sessionContext.project?.root) {
    for (const dir of projectSkillDirs(context.sessionContext.project.root)) {
      locations.push({ source: "project", root: context.sessionContext.project.root, dir });
    }
  } else if (requestedSource === "project") {
    return null;
  }
  if (requestedSource !== "project") {
    locations.push({ source: "workspace", root: workspacePath, dir: skillsDir(workspacePath) });
  }

  for (const location of locations) {
    const loaded = loadSkillFromLocation(workspacePath, skillName, args, config, location, context);
    if (loaded) return loaded;
  }
  return null;
}

export function formatSkillName(skill: SkillMeta): string {
  return skill.source ? `${skill.source}/${skill.name}` : skill.name;
}

export function createSkillUseTool(workspacePath: string, getConfig: () => Config): Tool {
  return {
    name: "skill_use",
    description: "激活一个技能。激活后，按照技能的指令执行任务。",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "要激活的技能名称",
        },
        args: {
          type: "string",
          description: "传给技能的参数，会替换指令中的 $ARGUMENTS",
        },
      },
      required: ["name"],
    },
    execute: async (toolArgs, context) => {
      const name = toolArgs.name as string;
      const args = (toolArgs.args as string) ?? "";
      const config = getConfig();
      const loaded = loadSkill(workspacePath, name, args, config, context);
      if (!loaded) {
        const available = listAvailableSkills(workspacePath, context?.sessionContext).map(formatSkillName).join(", ");
        return JSON.stringify({
          error: `未找到技能: ${name}。可用技能: ${available || "无"}`,
        });
      }
      if (loaded.approvalResult) return loaded.approvalResult;
      return JSON.stringify({
        skill: name,
        source: loaded.source,
        instruction: `[技能工作目录: ${loaded.skillDir}]\n执行此技能中的脚本或文件操作时，必须使用上述绝对路径作为工作目录。例如：cd 到该目录后再执行命令，或使用绝对路径引用文件。\n\n${loaded.body}`,
      });
    },
  };
}

export function createSkillListTool(workspacePath: string): Tool {
  return {
    name: "skill_list",
    description: "列出所有可用的技能。",
    inputSchema: {
      type: "object",
      properties: {},
    },
    execute: async (_args, context) => {
      const skills = listAvailableSkills(workspacePath, context?.sessionContext);
      if (skills.length === 0) {
        return JSON.stringify({ message: "暂无可用技能。在 workspace/skills/<技能名>/SKILL.md 或项目 .agents/skills/<技能名>/SKILL.md 创建技能。" });
      }
      return JSON.stringify({ skills: skills.map((s) => ({ name: formatSkillName(s), description: s.description, source: s.source ?? "workspace" })) });
    },
  };
}
