import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import type { Config, SessionContext } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_RULE_FILE_CHARS = 50_000;
const MAX_RULES_CHARS = 80_000;
const DEFAULT_GIT_TIMEOUT_MS = 10_000;
const DEFAULT_DIFF_MAX_CHARS = 200_000;

const STACK_MARKERS: Array<{ file: string; label: string }> = [
  { file: "package.json", label: "Node.js / npm" },
  { file: "go.mod", label: "Go" },
  { file: "pyproject.toml", label: "Python (pyproject)" },
  { file: "requirements.txt", label: "Python" },
  { file: "Cargo.toml", label: "Rust" },
  { file: "pom.xml", label: "Java (Maven)" },
  { file: "build.gradle", label: "Java (Gradle)" },
  { file: "Gemfile", label: "Ruby" },
  { file: "composer.json", label: "PHP" },
  { file: "CMakeLists.txt", label: "C/C++ (CMake)" },
];

export interface ProjectInfo {
  root: string;
  name: string;
  stack: string[];
  rules: string;
}

export interface ProjectChangedFile {
  path: string;
  previousPath?: string;
  indexStatus: string;
  workTreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface ProjectGitStatus {
  isRepository: boolean;
  branch: string;
  clean: boolean;
  changedCount: number;
  files: ProjectChangedFile[];
}

export interface ProjectDiff {
  path: string;
  staged: string;
  unstaged: string;
  truncated: boolean;
}

const staticInfoCache = new Map<string, { signature: string; info: ProjectInfo }>();

export function getProjectLimits(config?: Config): { gitTimeoutMs: number; diffMaxChars: number } {
  return {
    gitTimeoutMs: config?.project?.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    diffMaxChars: config?.project?.diffMaxChars ?? DEFAULT_DIFF_MAX_CHARS,
  };
}

export async function inspectProject(requestedPath: string): Promise<ProjectInfo> {
  const root = resolveProjectRoot(requestedPath);
  const signature = projectSignature(root);
  const cached = staticInfoCache.get(root);
  if (cached?.signature === signature) return cached.info;
  const info = {
    root,
    name: basename(root),
    stack: STACK_MARKERS.filter((marker) => existsSync(resolve(root, marker.file))).map((marker) => marker.label),
    rules: loadProjectRules(root),
  };
  staticInfoCache.set(root, { signature, info });
  return info;
}

export async function readProjectGitStatus(requestedPath: string, timeoutMs = DEFAULT_GIT_TIMEOUT_MS): Promise<ProjectGitStatus> {
  const root = resolveProjectRoot(requestedPath);
  try {
    const [{ stdout: branchOutput }, { stdout: statusOutput }] = await Promise.all([
      runGit(root, ["branch", "--show-current"], timeoutMs),
      runGit(root, ["status", "--porcelain=v1", "-z"], timeoutMs),
    ]);
    const files = parseGitStatus(statusOutput);
    return {
      isRepository: true,
      branch: branchOutput.trim() || "(未命名)",
      clean: files.length === 0,
      changedCount: files.length,
      files,
    };
  } catch (error) {
    if (isTimeoutError(error)) throw new Error(`读取 Git 状态超时（${timeoutMs}ms）`);
    return { isRepository: false, branch: "", clean: true, changedCount: 0, files: [] };
  }
}

export async function readProjectDiff(
  requestedPath: string,
  filePath: string | undefined,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
  maxChars = DEFAULT_DIFF_MAX_CHARS,
): Promise<ProjectDiff> {
  const root = resolveProjectRoot(requestedPath);
  if (filePath?.includes("\0")) throw new Error("变更文件路径无效");
  const pathArgs = filePath ? ["--", filePath] : [];
  const [{ stdout: staged }, { stdout: unstaged }] = await Promise.all([
    runGit(root, ["diff", "--cached", "--no-ext-diff", ...pathArgs], timeoutMs),
    runGit(root, ["diff", "--no-ext-diff", ...pathArgs], timeoutMs),
  ]);
  let remaining = maxChars;
  const take = (value: string): string => {
    const result = value.slice(0, Math.max(0, remaining));
    remaining -= result.length;
    return result;
  };
  const stagedResult = take(staged);
  const unstagedResult = take(unstaged);
  return {
    path: filePath ?? ".",
    staged: stagedResult,
    unstaged: unstagedResult,
    truncated: stagedResult.length < staged.length || unstagedResult.length < unstaged.length,
  };
}

export function parseGitStatus(output: string): ProjectChangedFile[] {
  const records = output.split("\0");
  const files: ProjectChangedFile[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const indexStatus = record[0];
    const workTreeStatus = record[1];
    const path = record.slice(3);
    const renamed = indexStatus === "R" || indexStatus === "C" || workTreeStatus === "R" || workTreeStatus === "C";
    const previousPath = renamed ? records[++index] || undefined : undefined;
    files.push({
      path,
      previousPath,
      indexStatus,
      workTreeStatus,
      staged: indexStatus !== " " && indexStatus !== "?",
      unstaged: workTreeStatus !== " " && workTreeStatus !== "?",
      untracked: indexStatus === "?" && workTreeStatus === "?",
    });
  }
  return files;
}

function resolveProjectRoot(requestedPath: string): string {
  const candidate = resolve(requestedPath);
  if (!existsSync(candidate)) throw new Error(`目录不存在: ${candidate}`);
  if (!statSync(candidate).isDirectory()) throw new Error(`路径不是目录: ${candidate}`);
  return realpathSync(candidate);
}

function projectSignature(root: string): string {
  return [...STACK_MARKERS.map((marker) => marker.file), ".tiny-claw/rules.md", "AGENTS.md"]
    .map((relativePath) => {
      const path = resolve(root, relativePath);
      if (!existsSync(path)) return `${relativePath}:missing`;
      const stat = statSync(path);
      return `${relativePath}:${stat.mtimeMs}:${stat.size}`;
    })
    .join("|");
}

async function runGit(root: string, args: string[], timeoutMs: number): Promise<{ stdout: string }> {
  return execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
}

function isTimeoutError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "killed" in error && (error as { killed?: boolean }).killed);
}

export function loadProjectRules(root: string): string {
  const sections: string[] = [];
  for (const relativePath of [".tiny-claw/rules.md", "AGENTS.md"]) {
    const path = resolve(root, relativePath);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const raw = readFileSync(path, "utf-8");
    const content = raw.length > MAX_RULE_FILE_CHARS
      ? `${raw.slice(0, MAX_RULE_FILE_CHARS)}\n...[规则文件已截断]`
      : raw;
    sections.push(`### ${relativePath}\n${content.trim()}`);
  }
  const combined = sections.join("\n\n");
  return combined.length > MAX_RULES_CHARS
    ? `${combined.slice(0, MAX_RULES_CHARS)}\n...[项目规则已截断]`
    : combined;
}

export function applySessionConfig(config: Config, context: SessionContext): Config {
  if (context.mode !== "project") return config;
  const project = config.project;
  return {
    ...config,
    historyWindowSize: project?.historyWindowSize ?? config.historyWindowSize,
    maxAgentIterations: project?.maxAgentIterations ?? config.maxAgentIterations,
    security: {
      ...config.security,
      mode: project?.security?.mode ?? "ask",
      tools: {
        ...config.security?.tools,
        project_tree: { mode: "allow" },
        project_search: { mode: "allow" },
        git_status: { mode: "allow" },
        git_diff: { mode: "allow" },
        ...project?.security?.tools,
      },
    },
  };
}

export function buildProjectPrompt(info: ProjectInfo): string {
  const lines = [
    "## 项目开发模式",
    `当前项目：${info.name}`,
    `项目根目录：${info.root}`,
    `技术栈：${info.stack.length > 0 ? info.stack.join("、") : "未检测到明显技术栈"}`,
  ];
  if (info.rules) lines.push(`\n### 项目规则\n${info.rules}`);
  lines.push("\n所有相对文件路径和 bash 工作目录均基于项目根目录，并且不得越过项目边界。");
  return lines.join("\n");
}
