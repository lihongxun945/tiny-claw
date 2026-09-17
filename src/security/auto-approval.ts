import { basename, isAbsolute, relative, resolve } from "node:path";
import { existsSync, accessSync, constants, realpathSync, statSync } from "node:fs";
import { resolveRootFile } from "../tools/workspace-path.js";
import { parseShell, type ShellNode, type ShellWord } from "./shell-analysis.js";
import { isReadOnlySed } from "./sed-analysis.js";
import { isReadOnlyAwk, isReadOnlyFind, isReadOnlyGit } from "./read-command-analysis.js";

export type AutoApprovalRisk = "low" | "medium" | "high" | "critical";
export type AutoApprovalAction = "allow" | "ask" | "deny";
export interface AutoApprovalDecision { action: AutoApprovalAction; risk: AutoApprovalRisk; ruleId: string; reason: string; executionCommand?: string }
export interface AutoApprovalInput {
  toolName: string;
  args: Record<string, unknown>;
  command?: string;
  cwd?: string;
  rootPath: string;
  trustedProject?: boolean;
  projectMode?: boolean;
  tempPath?: string;
  prepareExecution?: boolean;
}
const allow = (): AutoApprovalDecision => ({ action: "allow", risk: "low", ruleId: "safe-operation", reason: "操作位于允许的执行范围内" });
const ask = (ruleId: string, reason: string, risk: AutoApprovalRisk = "high"): AutoApprovalDecision => ({ action: "ask", risk, ruleId, reason });
const deny = (): AutoApprovalDecision => ({ action: "deny", risk: "critical", ruleId: "catastrophic-system-command", reason: "命令可能造成不可恢复的系统或磁盘破坏" });
const readCommands = new Set(["ps", "grep", "rg", "head", "tail", "ls", "cat", "pwd", "echo", "printf", "wc", "sort", "uniq", "stat", "du", "df", "date", "uname", "which", "true", "false", "sleep"]);
const writeCommands = new Set(["rm", "mv", "cp", "mkdir", "touch", "chmod", "chown", "tee"]);
const systemCommands = new Set(["sudo", "su", "shutdown", "reboot", "halt", "launchctl", "systemctl", "kill", "killall", "pkill"]);
const opaqueCommands = new Set(["eval", "exec", "source", ".", "bash", "sh", "zsh", "env", "xargs"]);

function sensitiveEnvironment(name: string): boolean {
  return /^(?:LD_|DYLD_|GIT_|NPM_CONFIG_|PYTHON|PERL|RUBY|BASH_FUNC_)/i.test(name)
    || new Set(["PATH", "HOME", "XDG_CONFIG_HOME", "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "CDPATH", "IFS", "NODE_OPTIONS", "NODE_PATH", "NODE_REPL_EXTERNAL_MODULE", "PAGER", "EDITOR", "VISUAL", "MAKEFLAGS", "MAKEFILES", "MFLAGS", "ZDOTDIR"]).has(name);
}

function isLocalGitWrite(args: string[], pathAllowed: (path: string) => boolean): boolean {
  const [command, ...options] = args;
  if (command === "add") {
    let pathsOnly = false;
    return options.length > 0 && options.every(option => {
      if (!pathsOnly && option === "--") { pathsOnly = true; return true; }
      if (!pathsOnly && ["-A", "--all", "-u", "--update"].includes(option)) return true;
      return !option.startsWith("-") && !/[:*?\[\]{}]/.test(option) && pathAllowed(option);
    });
  }
  if (command === "commit") {
    let message = false;
    for (let i = 0; i < options.length; i++) {
      if (["-m", "--message"].includes(options[i]!)) {
        if (options[++i] === undefined) return false;
        message = true;
      } else if (options[i]!.startsWith("--message=")) message = true;
      else return false;
    }
    return message;
  }
  return command === "branch" && options.length === 1 && /^[a-zA-Z0-9][a-zA-Z0-9_/-]*$/.test(options[0]!);
}

function within(root: string, target: string): boolean {
  try {
    if (existsSync(root)) { resolveRootFile(root, target); return true; }
    const rel = relative(resolve(root), target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  } catch { return false; }
}

export function evaluateAutoApproval(input: AutoApprovalInput): AutoApprovalDecision {
  const permittedPath = (path: string, cwd: string) => within(input.rootPath, resolve(cwd, path))
    || (!!input.tempPath && (!!input.projectMode || !!input.trustedProject) && within(input.tempPath, resolve(cwd, path)));
  if (["file_write", "file_edit"].includes(input.toolName)) {
    const path = input.args.path;
    return typeof path === "string" && permittedPath(path, input.rootPath) ? allow() : ask("external-write", `写入目标不在允许范围内：${String(path)}`);
  }
  if (input.toolName !== "bash") return allow();
  const source = String(input.command ?? input.args.command ?? "").trim();
  if (!source) return { ...deny(), ruleId: "empty-command", reason: "命令内容为空" };
  let ast: ShellNode;
  try { ast = parseShell(source); } catch { return ask("unresolved-shell", "无法可靠解析命令语法，需要确认其影响", "medium"); }
  const decisions: AutoApprovalDecision[] = [];
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const replaceWord = (value: ShellWord | undefined, text: string) => {
    if (!value?.loc || source.slice(value.loc.start.char, value.loc.end.char + 1) !== value.text) {
      uncertain("无法可靠定位安全命令替换位置"); return;
    }
    edits.push({ start: value.loc.start.char, end: value.loc.end.char + 1, text });
  };
  const uncertain = (reason: string) => decisions.push(ask("unresolved-shell", reason, "medium"));
  const write = (path: string, cwd: string) => {
    if (/[*?\[\]{}]/.test(path)) { uncertain(`写入目标包含动态路径模式：${path}`); return; }
    if (!permittedPath(path, cwd)) decisions.push(ask("external-shell-write", `命令写入目标不在允许范围内：${resolve(cwd, path)}`));
  };
  const word = (value: ShellWord, cwd: string, outputOnly = false): string | undefined => {
    if (!value.expansion?.length) {
      if (value.text.startsWith("~")) { uncertain("无法静态确定用户目录展开结果"); return undefined; }
      return value.text;
    }
    const text = /^"[^"\\]*"$/.test(value.text) ? value.text.slice(1, -1) : value.text;
    if (input.tempPath && value.expansion.every((e) => e.type === "ParameterExpansion" && e.parameter === "TMPDIR")
      && /^\$(?:TMPDIR|\{TMPDIR\})(?:\/|$)/.test(text)) return text.replace(/^\$(?:TMPDIR|\{TMPDIR\})/, input.tempPath);
    for (const expansion of value.expansion) if (expansion.commandAST) visit(expansion.commandAST, cwd);
    if (!outputOnly || value.expansion.some((e) => e.type !== "ParameterExpansion")) uncertain("命令包含无法静态确定的展开表达式");
    return undefined;
  };
  const visit = (node: ShellNode, initialCwd: string): string => {
    let cwd = initialCwd;
    if (node.type === "Script" || node.type === "CompoundList") {
      for (const child of node.commands ?? []) { const next = visit(child, cwd); if (!child.async) cwd = next; }
      return cwd;
    }
    if (node.type === "Subshell" && node.list) {
      visit({ type: "Command", suffix: node.redirections }, cwd);
      visit(node.list, cwd);
      return cwd;
    }
    if (node.type === "Pipeline") { for (const child of node.commands ?? []) visit(child, cwd); return cwd; }
    if (node.type === "LogicalExpression" && node.left && node.right) {
      const next = visit(node.left, cwd);
      if (node.op !== "and" && next !== cwd) uncertain("条件分支改变工作目录，无法确定后续写入位置");
      return visit(node.right, node.op === "and" ? next : cwd);
    }
    if (node.type !== "Command") { uncertain(`暂不支持静态分析此 shell 结构：${node.type}`); return cwd; }
    let name = node.name ? word(node.name, cwd) : "";
    const args: string[] = [];
    for (const item of [...(node.prefix ?? []), ...(node.suffix ?? [])]) {
      if (item.type === "Redirect") {
        const path = word(item.file, cwd);
        if (path === undefined) continue;
        const op = item.op.text;
        if ([">&", "<&"].includes(op) && /^(?:\d+|-)$/.test(path)) continue;
        if ([">", ">>", ">|", ">&", "&>", "&>>", "<>"].includes(op)) { if (path !== "/dev/null") write(path, cwd); }
        else if (op !== "<") uncertain(`暂不支持静态分析重定向：${op}`);
      } else if (item.type === "Word") {
        const value = word(item, cwd, name === "echo" || name === "printf");
        if (value !== undefined) args.push(value);
      } else if (item.type === "AssignmentWord" && name) {
        const variable = /^([a-zA-Z_][a-zA-Z0-9_]*)=/.exec(item.text)?.[1];
        if (!variable || sensitiveEnvironment(variable) || item.expansion?.length) {
          uncertain("环境变量改变执行环境或包含动态展开，需要确认");
        } else if (!input.projectMode && !/^(?:CI=(?:true|false|0|1)|NODE_ENV=(?:test|development|production)|FORCE_COLOR=[0-3]|NO_COLOR=1)$/.test(item.text)) {
          uncertain("普通对话中的自定义环境变量需要确认");
        }
      } else uncertain("命令包含环境赋值或不支持的前缀");
    }
    if (name === "nohup") name = args.shift();
    if (!name) return cwd;
    const command = basename(name);
    if (command === "timeout" && name === command) {
      if (!/^\d+(?:\.\d+)?[smhd]?$/.test(args[0] ?? "") || !args[1] || args[1].startsWith("-")) {
        uncertain("timeout 仅支持明确时限和直接命令，其他选项需要确认");
      } else {
        visit({ type: "Command", name: { type: "Word", text: args[1] }, suffix: args.slice(2).map(text => ({ type: "Word", text })) }, cwd);
      }
      return cwd;
    }
    const readOnlyGit = command === "git" && isReadOnlyGit(args, input.prepareExecution && name === "git");
    const localGitWrite = command === "git" && input.projectMode && within(input.rootPath, cwd)
      && isLocalGitWrite(args, path => within(input.rootPath, resolve(cwd, path)));
    if (command === "git" && !readOnlyGit && !localGitWrite) {
      decisions.push(ask("git-operation-review", "Git 操作不属于已支持的只读查询、项目内暂存、普通提交或分支创建，需要确认"));
    }
    if (readOnlyGit && args[0] === "diff" && input.prepareExecution && node.name?.text === "git") {
      replaceWord(node.name, "git -c core.fsmonitor=false --no-pager");
      replaceWord(node.suffix?.find(item => item.type === "Word" && item.text === "diff") as ShellWord | undefined,
        "diff --no-ext-diff --no-textconv");
    } else if (readOnlyGit && args[0] === "diff" && !isReadOnlyGit(args)) uncertain("此包装结构尚不支持安全 Diff 转换");
    let localNpx = false;
    if (command === "npx" && input.prepareExecution && input.projectMode && node.name?.text === "npx"
      && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(args[0] ?? "") && within(input.rootPath, cwd)) {
      try {
        const executable = realpathSync(resolve(cwd, "node_modules/.bin", args[0]!));
        if (within(realpathSync(input.rootPath), executable) && statSync(executable).isFile()) {
          accessSync(executable, constants.X_OK);
          replaceWord(node.name, `'${executable.replace(/'/g, "'\\''")}'`);
          replaceWord(node.suffix?.find(item => item.type === "Word") as ShellWord | undefined, "");
          localNpx = true;
        }
      } catch { /* Missing or external binaries require approval, never installation. */ }
    }
    const systemRead = (command === "nproc" && args.every(arg => ["--all"].includes(arg)))
      || (command === "vm_stat" && args.length === 0)
      || (command === "sysctl" && args[0] === "-n" && args.length > 1 && args.slice(1).every(arg => ["hw.ncpu", "hw.logicalcpu", "hw.physicalcpu", "hw.memsize"].includes(arg)))
      || (command === "od" && args[0] === "-c" && args.slice(1).every(arg => !arg.startsWith("-")));
    if (command === "find" && !isReadOnlyFind(args)) uncertain("find 包含执行、写入或未支持的查询参数，需要确认");
    if (command === "git" && !readOnlyGit && !localGitWrite && (["status", "ls-files", "rev-parse", "log", "branch", "diff"].includes(args[0] ?? "") || args[0]?.startsWith("-"))) uncertain("git 包含未支持的查询选项或全局配置覆盖，需要确认");
    if (command === "awk" && !isReadOnlyAwk(args)) uncertain("awk 不是已支持的只读字段格式化，需要确认脚本与参数的影响");
    if (command === "sed" && !isReadOnlySed(args)) uncertain("sed 不是已支持的只读行打印用法，需要确认脚本与参数的影响");
    if (command !== name) uncertain(`命令使用显式可执行文件路径：${name}`);
    const operands = args.filter((arg) => !arg.startsWith("-"));
    if (/^mkfs(?:\.|$)/.test(command) || command === "fdisk"
      || (command === "diskutil" && args.some((a) => /^(eraseDisk|eraseVolume|partitionDisk|zeroDisk)$/.test(a)))
      || (["rm", "sudo"].includes(command) && args.some((a) => /^-.*r/.test(a)) && args.some((a) => /^-.*f/.test(a)) && operands.includes("/"))) decisions.push(deny());
    if (systemCommands.has(command)) decisions.push(ask("high-risk-system-command", `命令涉及系统或进程状态修改：${command}`));
    if (opaqueCommands.has(command)) uncertain(`命令包含间接执行，需要确认：${command}`);
    if ((command === "rg" && args.some((a) => a === "--pre" || a.startsWith("--pre=")))
      || (command === "sort" && args.some((a) => a.startsWith("--compress-program")))) uncertain("只读命令参数包含外部程序执行");
    if (command === "curl" || command === "wget") decisions.push(ask("network-shell-command", `网络命令需确认目标与写入行为：${command}`));
    if (command === "cd") {
      if (args.length !== 1 || args[0]!.startsWith("-")) uncertain("无法确定 cd 的目标目录");
      else cwd = resolve(cwd, args[0]!);
      return cwd;
    }
    if (writeCommands.has(command)) {
      for (const target of command === "cp" ? operands.slice(-1) : operands) write(target, cwd);
      if (command === "cp" || command === "mv") for (let i = 0; i < args.length; i++) if (args[i] === "-t" || args[i] === "--target-directory") write(args[i + 1] ?? "", cwd);
      for (const arg of args) if (arg.startsWith("--target-directory=")) write(arg.slice("--target-directory=".length), cwd);
    }
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--output" || (args[i] === "-o" && !["grep", "rg", "ps", "find"].includes(command) && !readOnlyGit)) write(args[i + 1] ?? "", cwd);
      if (args[i]!.startsWith("--output=")) write(args[i]!.slice(9), cwd);
    }
    if (input.projectMode && !["sed", "find", "awk"].includes(command) && !readOnlyGit && !localNpx && !systemRead && !readCommands.has(command) && !writeCommands.has(command)) {
      if (!["node", "python", "python3", "npm", "git", "make"].includes(command)) uncertain(`未识别的项目命令：${command}`);
      if (command === "npm" && !["run", "test", "build"].includes(args[0] ?? "")) decisions.push(ask("project-external-operation", `命令涉及包管理：${command}`));
      if (!within(input.rootPath, cwd)) decisions.push(ask("project-code-execution", `执行目录不在当前项目内：${cwd}`, "medium"));
      if (["node", "python", "python3"].includes(command)) {
        const checkingNode = command === "node" && ["--check", "-c"].includes(args[0] ?? "");
        const scriptArgs = checkingNode ? args.slice(1) : args;
        const script = scriptArgs[0] === "--" ? scriptArgs[1] : scriptArgs[0];
        if (checkingNode && scriptArgs.length !== (scriptArgs[0] === "--" ? 2 : 1)) uncertain("node 语法检查仅支持单个项目文件");
        if (!script || script.startsWith("-") || /[*?\[\]{}]|:\/\//.test(script)) uncertain("仅自动允许明确的项目内脚本文件，内联代码或解释器选项需要确认");
        else if (!within(input.rootPath, resolve(cwd, script))) decisions.push(ask("external-script", `脚本不在当前项目内：${script}`));
      } else if (command === "npm") {
        // Arguments after -- belong to the project script, not npm itself.
        const separator = args.indexOf("--");
        const npmArgs = separator < 0 ? args : args.slice(0, separator);
        if (npmArgs.some((arg) => arg.startsWith("-"))) uncertain("npm 选项可能改变执行目录或配置，需要确认");
        if (args[0] === "run" && (!args[1] || args[1].startsWith("-"))) uncertain("未指定明确的 npm 项目脚本");
      } else if (command === "make") {
        if (args.some((arg) => arg.startsWith("-") || arg.includes("="))) uncertain("make 选项或变量可能改变执行文件，需要确认");
      }
    }
    return cwd;
  };
  visit(ast, input.cwd ?? input.rootPath);
  const decision = decisions.find((d) => d.action === "deny") ?? decisions.find((d) => d.risk === "high") ?? decisions[0] ?? allow();
  if (decision.action === "allow" && edits.length) {
    let executionCommand = source;
    for (const edit of edits.sort((a, b) => b.start - a.start)) executionCommand = executionCommand.slice(0, edit.start) + edit.text + executionCommand.slice(edit.end);
    return { ...decision, executionCommand };
  }
  return decision;
}
