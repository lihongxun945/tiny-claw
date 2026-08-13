import { isAbsolute, relative, resolve } from "node:path";

export type AutoApprovalRisk = "low" | "medium" | "high" | "critical";
export type AutoApprovalAction = "allow" | "ask" | "deny";

export interface AutoApprovalDecision {
  action: AutoApprovalAction;
  risk: AutoApprovalRisk;
  ruleId: string;
  reason: string;
}

export interface AutoApprovalInput {
  toolName: string;
  args: Record<string, unknown>;
  command?: string;
  cwd?: string;
  rootPath: string;
}

const FILE_WRITE_TOOLS = new Set(["file_write", "file_edit"]);

export function evaluateAutoApproval(input: AutoApprovalInput): AutoApprovalDecision {
  if (FILE_WRITE_TOOLS.has(input.toolName)) return evaluateFileWrite(input);
  if (input.toolName === "bash") return evaluateBash(input);

  return allow("default-auto-allow", "low", "该工具未命中明确的高风险规则");
}

function evaluateFileWrite(input: AutoApprovalInput): AutoApprovalDecision {
  const target = resolveToolPath(input);
  if (!target) return ask("missing-write-path", "high", "无法确定写入目标路径");
  if (!isWithin(input.rootPath, target)) return ask("external-write", "high", "写入目标位于当前工作目录之外");
  return allow("workspace-file-operation", "low", "当前工作目录内的文件操作自动执行");
}

function evaluateBash(input: AutoApprovalInput): AutoApprovalDecision {
  const command = String(input.command ?? input.args.command ?? "").trim();
  if (!command) return deny("empty-command", "critical", "命令内容为空");

  if (isCatastrophicCommand(command)) {
    return deny("catastrophic-system-command", "critical", "命令可能造成不可恢复的系统或磁盘破坏");
  }
  if (isHighRiskSystemCommand(command)) {
    return ask("high-risk-system-command", "high", "命令涉及提权、系统状态修改或远程脚本执行");
  }
  if (writesOutsideRoot(command, input)) {
    return ask("external-shell-write", "high", "命令可能修改当前工作目录之外的文件");
  }

  return allow("default-shell-allow", "low", "命令未命中明确的高风险规则");
}

function isCatastrophicCommand(command: string): boolean {
  return /(^|[;&|\s])(?:mkfs(?:\.[\w-]+)?|fdisk)\b/i.test(command)
    || /\bdiskutil\s+(?:eraseDisk|eraseVolume|partitionDisk|zeroDisk)\b/i.test(command)
    || /\brm\s+(?:-[\w-]*r[\w-]*f[\w-]*|-[\w-]*f[\w-]*r[\w-]*)\s+(?:\/|~|\$HOME)(?:\s|$)/i.test(command);
}

function isHighRiskSystemCommand(command: string): boolean {
  return /(^|[;&|\s])(?:sudo|su|shutdown|reboot|halt|launchctl|systemctl)\b/i.test(command)
    || /\b(?:curl|wget)\b[^\n|;]*(?:\||\|&)\s*(?:sh|bash|zsh)\b/i.test(command);
}

function writesOutsideRoot(command: string, input: AutoApprovalInput): boolean {
  const cwd = input.cwd ?? input.rootPath;
  for (const match of command.matchAll(/(?:^|[;&|])\s*(rm|mv|cp|mkdir|touch|chmod|chown)\b([^;&|]*)/gi)) {
    const operation = match[1]!.toLowerCase();
    const paths = tokenizeWords(match[2] ?? "").filter((word) => word && !word.startsWith("-"));
    const writeTargets = operation === "cp" ? paths.slice(-1) : paths;
    if (writeTargets.some((path) => isExternalPath(path, cwd, input.rootPath))) return true;
  }
  for (const match of command.matchAll(/>{1,2}\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g)) {
    const path = match[1] ?? match[2] ?? match[3] ?? "";
    if (isExternalPath(path, cwd, input.rootPath)) return true;
  }
  return false;
}

function isExternalPath(path: string, cwd: string, rootPath: string): boolean {
  if (!looksLikePath(path)) return false;
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  return !isWithin(rootPath, absolute);
}

function tokenizeWords(value: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === "\\" && quote !== "'") {
      current += value[index + 1] ?? "";
      index += 1;
    } else if (char === "'" || char === '"') {
      quote = quote === char ? undefined : quote ?? char;
    } else if (!quote && /\s/.test(char)) {
      if (current) words.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) words.push(current);
  return words;
}

function looksLikePath(value: string): boolean {
  return value === "." || value === ".." || value.startsWith("/") || value.startsWith("~")
    || value.startsWith("./") || value.startsWith("../") || value.includes("/");
}

function resolveToolPath(input: AutoApprovalInput): string | undefined {
  const rawPath = typeof input.args.path === "string" ? input.args.path : undefined;
  if (!rawPath) return undefined;
  return isAbsolute(rawPath) ? resolve(rawPath) : resolve(input.rootPath, rawPath);
}

function isWithin(rootPath: string, targetPath: string): boolean {
  const pathFromRoot = relative(resolve(rootPath), resolve(targetPath));
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function allow(ruleId: string, risk: AutoApprovalRisk, reason: string): AutoApprovalDecision {
  return { action: "allow", risk, ruleId, reason };
}

function ask(ruleId: string, risk: AutoApprovalRisk, reason: string): AutoApprovalDecision {
  return { action: "ask", risk, ruleId, reason };
}

function deny(ruleId: string, risk: AutoApprovalRisk, reason: string): AutoApprovalDecision {
  return { action: "deny", risk, ruleId, reason };
}
