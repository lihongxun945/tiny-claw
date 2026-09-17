import { spawn } from "node:child_process";
import { mkdirSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Tool } from "../types.js";
import type { Config } from "../types.js";
import { checkDangerousToolPermission } from "./permission.js";
import { resolveRootFile } from "./workspace-path.js";
import { projectTempDirectory } from "../security/project-trust.js";

const MAX_OUTPUT = 10000;
const DEFAULT_TIMEOUT = 30;

export function createBashTool(workspacePath: string, getConfig: () => Config): Tool {
  return {
    name: "bash",
    description:
      "在 shell 中执行命令并返回输出。项目临时日志使用受管 $TMPDIR，不要写任意 /tmp 路径。自动审批会为普通 git diff 禁用外部辅助程序，并将 npx 限定为项目已安装的本地工具，转换后的命令随结果返回。不要用于读取文件（用 file_read）或写入文件（用 file_write/file_edit）。",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "要执行的 shell 命令",
        },
        timeout: {
          type: "number",
          description: "超时秒数，默认30",
          minimum: 1,
          maximum: 300,
        },
        cwd: {
          type: "string",
          description: "执行目录（相对 workspace 或绝对路径），默认 workspace",
        },
      },
      required: ["command"],
    },
    execute: async (args, context) => {
      const command = args.command as string;
      const timeout = (args.timeout as number) ?? DEFAULT_TIMEOUT;
      const root = context?.rootPath ?? workspacePath;
      const requestedCwd = (args.cwd as string | undefined) ?? ".";
      let cwd: string;
      try {
        cwd = context?.restrictToRoot ? resolveRootFile(root, requestedCwd) : resolve(root, requestedCwd);
      } catch (error) {
        return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      }
      const permission = checkDangerousToolPermission({
        workspacePath,
        config: context?.config ?? getConfig(),
        toolName: "bash",
        args,
        context,
        command,
        cwd,
        prepareExecution: true,
      });
      if (!permission.allowed) return permission.result;

      const config = context?.config ?? getConfig();
      const tempPath = context?.sessionContext?.mode === "project" ? projectTempDirectory(workspacePath, root) : undefined;
      const executionCommand = permission.executionCommand ?? command;
      const outputDir = resolve(workspacePath, "tool-output");
      mkdirSync(outputDir, { recursive: true });
      const outputPath = resolve(outputDir, `${randomUUID()}.log`);
      let outputSaveError: string | undefined;
      const result = JSON.parse(await executeShell(executionCommand, timeout, cwd, config.bashTerminationGraceMs ?? 1000, context?.signal, tempPath,
        (text) => {
          if (outputSaveError) return;
          try { appendFileSync(outputPath, text, { mode: 0o600 }); }
          catch (error) { outputSaveError = String(error); }
        },
        () => context?.reportActivity?.(`正在执行命令：${executionCommand}`), config.bashMaxOutputChars ?? MAX_OUTPUT));
      if (permission.executionCommand) result.executionCommand = executionCommand;
      if (result.truncated) {
        if (outputSaveError) result.outputSaveError = outputSaveError;
        else result.outputPath = outputPath;
        result.notice = outputSaveError
          ? "输出已截断，仅保留尾部；完整日志保存失败，详见 outputSaveError。"
          : "输出已截断，仅保留尾部；完整输出见 outputPath，可使用 file_read 按行读取。";
      }
      return JSON.stringify(result);
    },
  };
}

export function executeShell(command: string, timeout: number, cwd: string, graceMs: number, signal?: AbortSignal, tempPath?: string, onOutput?: (text: string) => void, onStarted?: () => void, maxOutput = MAX_OUTPUT): Promise<string> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(JSON.stringify({ stdout: "", stderr: "命令执行已取消", exitCode: -1 }));
      return;
    }
    const proc = spawn("bash", ["-c", command], {
      cwd,
      env: { ...process.env, ...(tempPath ? { TMPDIR: tempPath } : {}) },
      detached: process.platform !== "win32",
    });

    let stdout = "";
    proc.once("spawn", () => onStarted?.());
    let stderr = "";
    let truncated = false;
    let terminating = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (kind: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, kind);
        else proc.kill(kind);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") stderr += `\n${String(error)}`;
      }
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      proc.stdin.destroy();
      proc.stdout.destroy();
      proc.stderr.destroy();
      resolve(JSON.stringify({ stdout: truncate(stdout, maxOutput), stderr: truncate(stderr, maxOutput), exitCode: code ?? -1, ...(truncated ? { truncated: true } : {}) }));
    };
    const terminate = (message: string) => {
      if (terminating || settled) return;
      terminating = true;
      stderr += message;
      kill("SIGTERM");
      // Descendants may ignore TERM or retain pipes after the shell exits.
      killTimer = setTimeout(() => { kill("SIGKILL"); finish(-1); }, graceMs);
    };

    proc.stdout.on("data", (data: Buffer) => {
      truncated ||= stdout.length + data.toString().length > maxOutput;
      stdout = (stdout + data.toString()).slice(-maxOutput);
      onOutput?.(data.toString());
    });

    proc.stderr.on("data", (data: Buffer) => {
      truncated ||= stderr.length + data.toString().length > maxOutput;
      stderr = (stderr + data.toString()).slice(-maxOutput);
      onOutput?.(data.toString());
    });

    const timer = setTimeout(() => {
      terminate("\n[超时: 命令执行超过指定时间]");
    }, timeout * 1000);
    const onAbort = () => {
      terminate("\n[已取消: 命令执行被用户中止]");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    proc.on("close", (code) => {
      if (!terminating) { kill("SIGKILL"); finish(code); }
    });

    proc.on("error", (err) => {
      stderr += err.message;
      if (!terminating) finish(-1);
    });
  });
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n...[输出截断，共 ${str.length} 字符]`;
}
