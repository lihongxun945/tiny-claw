import { spawn } from "node:child_process";
import { relative, resolve } from "node:path";
import type { Config, Tool, ToolExecutionContext } from "../types.js";
import { checkDangerousToolPermission } from "./permission.js";
import { resolveRootFile } from "./workspace-path.js";

interface SearchLimits {
  maxResults: number;
  maxChars: number;
  timeoutMs: number;
}

export function createProjectSearchTool(workspacePath: string, getConfig: () => Config): Tool {
  return {
    name: "project_search",
    description: "在当前项目中按文件 Glob、纯文本或正则表达式搜索，返回结构化路径、行号和匹配文本。",
    isAvailable: (context) => context.mode === "project",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索文本、正则表达式，或 files 模式下的 Glob" },
        mode: { type: "string", enum: ["text", "regex", "files"], description: "默认 text" },
        path: { type: "string", description: "项目内搜索目录，默认项目根目录" },
        glob: { type: "string", description: "text/regex 模式的可选文件 Glob，例如 **/*.ts" },
      },
      required: ["query"],
    },
    execute: async (args, context) => {
      const project = getProjectExecution(context);
      if ("error" in project) return JSON.stringify(project);
      const query = typeof args.query === "string" ? args.query : "";
      const mode = args.mode === "regex" || args.mode === "files" ? args.mode : "text";
      if (!query) return JSON.stringify({ error: "query 不能为空" });
      const config = context?.config ?? getConfig();
      const limits = {
        maxResults: config.project?.searchMaxResults ?? 200,
        maxChars: config.project?.searchMaxChars ?? 50000,
        timeoutMs: config.project?.searchTimeoutMs ?? 10000,
      };
      let start: string;
      try {
        start = resolveRootFile(project.root, typeof args.path === "string" ? args.path : ".");
      } catch (error) {
        return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      }
      const permission = checkDangerousToolPermission({
        workspacePath,
        config,
        toolName: "project_search",
        args,
        context,
        command: `search ${query}`,
        cwd: start,
      });
      if (!permission.allowed) return permission.result;

      try {
        return JSON.stringify(await runSearch({
          root: project.root,
          start,
          query,
          mode,
          glob: typeof args.glob === "string" && args.glob ? args.glob : undefined,
          limits,
          signal: context?.signal,
        }));
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          return JSON.stringify({ error: "未找到 rg（ripgrep），project_search 需要安装 rg 后才能使用" });
        }
        return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}

async function runSearch(options: {
  root: string;
  start: string;
  query: string;
  mode: "text" | "regex" | "files";
  glob?: string;
  limits: SearchLimits;
  signal?: AbortSignal;
}): Promise<{ results: unknown[]; truncated: boolean }> {
  const args = options.mode === "files"
    ? ["--files", "--glob", options.query, "."]
    : ["--json", ...(options.mode === "text" ? ["--fixed-strings"] : []), ...(options.glob ? ["--glob", options.glob] : []), "--", options.query, "."];
  const child = spawn("rg", args, { cwd: options.start, stdio: ["ignore", "pipe", "pipe"] });
  const results: unknown[] = [];
  let stdoutBuffer = "";
  let stderr = "";
  let chars = 0;
  let truncated = false;
  let timedOut = false;
  const stop = () => child.kill("SIGTERM");
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.limits.timeoutMs);
  options.signal?.addEventListener("abort", stop, { once: true });

  const consumeLine = (line: string) => {
    if (!line || truncated) return;
    let result: unknown;
    if (options.mode === "files") {
      result = { path: relative(options.root, resolve(options.start, line)) };
    } else {
      const event = JSON.parse(line) as { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string }; submatches?: Array<{ start: number; end: number }> } };
      if (event.type !== "match" || !event.data?.path?.text) return;
      result = {
        path: relative(options.root, resolve(options.start, event.data.path.text)),
        line: event.data.line_number,
        text: event.data.lines?.text?.replace(/\r?\n$/, ""),
        matches: event.data.submatches,
      };
    }
    const size = JSON.stringify(result).length;
    if (results.length >= options.limits.maxResults || chars + size > options.limits.maxChars) {
      truncated = true;
      stop();
      return;
    }
    results.push(result);
    chars += size;
  };

  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
  });
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
  });
  if (stdoutBuffer) consumeLine(stdoutBuffer);
  if (options.signal?.aborted) throw new Error("项目搜索已取消");
  if (timedOut) throw new Error(`项目搜索超时（${options.limits.timeoutMs}ms）`);
  if (!truncated && exitCode !== 0 && exitCode !== 1) throw new Error(stderr.trim() || `rg 执行失败（退出码 ${exitCode}）`);
  return { results, truncated };
}

function getProjectExecution(context?: ToolExecutionContext): { root: string } | { error: string } {
  if (context?.sessionContext?.mode !== "project" || !context.rootPath || !context.restrictToRoot) {
    return { error: "project_search 仅可在项目会话中使用" };
  }
  return { root: context.rootPath };
}
