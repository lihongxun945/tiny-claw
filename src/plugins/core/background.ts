import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "../types.js";
import type { ToolExecutionContext } from "../../types.js";
import { loadConfig } from "../../config.js";
import { sessionDir } from "../../session-store.js";
import { executeShell } from "../../tools/bash.js";
import { resolveRootFile } from "../../tools/workspace-path.js";
import { checkDangerousToolPermission } from "../../tools/permission.js";
import { isTrustedProject, projectTempDirectory } from "../../security/project-trust.js";
import { withAudit } from "./tools.js";
import { parseShell, type ShellNode } from "../../security/shell-analysis.js";

interface Job {
  id: string;
  sessionId: string;
  command: string;
  state: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  log: string;
  exitCode?: number;
  startedAt?: number;
  completedAt?: number;
}
interface RunningJob { job: Job; controller: AbortController; done: Promise<void> }

export const coreBackgroundPlugin: Plugin = {
  name: "core-background",
  async init(ctx) {
    const running = new Map<string, RunningJob>();
    const directory = (session: string) => resolve(sessionDir(ctx.workspacePath, session), "background");
    const save = (job: Job) => {
      const dir = directory(job.sessionId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = resolve(dir, `${job.id}.json`);
      writeFileSync(`${file}.tmp`, JSON.stringify(job), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    };
    const jobs = (session: string): Job[] => {
      let files: string[];
      try { files = readdirSync(directory(session)); } catch { return []; }
      return files.filter((file) => file.endsWith(".json")).flatMap((file) => {
        try {
          const stored = JSON.parse(readFileSync(resolve(directory(session), file), "utf8")) as Job;
          if (stored.sessionId !== session) return [];
          const active = running.get(stored.id);
          return [{ ...(active?.job ?? stored), state: active ? active.job.state : stored.state === "running" ? "interrupted" : stored.state }];
        } catch { return []; }
      });
    };
    const stop = async (session: string, id: string) => {
      const active = running.get(id);
      if (!active || active.job.sessionId !== session) return { error: "未找到当前会话的运行中任务" };
      active.controller.abort();
      await active.done;
      return active.job;
    };
    ctx.registerDisposable({ async dispose() {
      for (const active of running.values()) active.controller.abort();
      await Promise.all([...running.values()].map((active) => active.done));
    } });
    ctx.registerTool(withAudit(ctx.workspacePath, {
      name: "background_start", effect: "write",
      description: "托管长时间命令，立即返回任务ID；命令直接前台运行，不加 nohup 或 &。任务独立于当前对话，停止对话不终止任务；用 background_stop 或用户 /task-stop 终止。",
      isAvailable: (context) => context.mode === "project",
      inputSchema: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } }, required: ["command"] },
      async execute(args, context) {
        if (!context?.sessionId || !context.rootPath) return JSON.stringify({ error: "需要项目会话" });
        const config = context.config ?? loadConfig(ctx.workspacePath);
        const root = context.rootPath;
        let cwd: string;
        try { cwd = resolveRootFile(root, typeof args.cwd === "string" ? args.cwd : "."); }
        catch (error) { return JSON.stringify({ error: String(error) }); }
        const command = String(args.command ?? "");
        const detachedSyntax = (node: ShellNode): boolean => !!node.async || node.name?.text === "nohup"
          || (node.commands ?? []).some(detachedSyntax) || (!!node.left && detachedSyntax(node.left)) || (!!node.right && detachedSyntax(node.right));
        try {
          if (detachedSyntax(parseShell(command))) return JSON.stringify({ error: "托管任务请提交前台命令，不要使用 nohup 或 &" });
        } catch { return JSON.stringify({ error: "无法解析后台任务命令" }); }
        const permission = checkDangerousToolPermission({ workspacePath: ctx.workspacePath, config, toolName: "background_start", args, command, cwd, context });
        if (!permission.allowed) return permission.result;
        if (context.signal?.aborted) return JSON.stringify({ error: "本轮已取消" });
        if (running.size >= (config.security?.background?.maxRunning ?? 4)) return JSON.stringify({ error: "运行中后台任务达到上限" });
        const temp = isTrustedProject(config, root, ctx.workspacePath) ? projectTempDirectory(ctx.workspacePath, root) : undefined;
        const job: Job = { id: randomUUID(), sessionId: context.sessionId, command, state: "running", log: "", startedAt: Date.now() };
        const controller = new AbortController();
        const active: RunningJob = { job, controller, done: Promise.resolve() };
        save(job);
        running.set(job.id, active);
        active.done = executeShell(command, config.security?.background?.timeoutSeconds ?? 3600, cwd, config.bashTerminationGraceMs, controller.signal, temp, (text) => {
          job.log = (job.log + text).slice(-(config.security?.background?.maxLogChars ?? 20000));
        }).then((result) => {
          const output = JSON.parse(result) as { exitCode: number; stderr: string };
          job.exitCode = output.exitCode;
          job.state = controller.signal.aborted ? "cancelled" : output.exitCode === 0 ? "completed" : "failed";
        }).catch((error: unknown) => { job.state = "failed"; job.log += String(error); }).finally(() => {
          job.completedAt = Date.now();
          running.delete(job.id);
          try { save(job); } catch (error) { ctx.log("WARN", `后台任务保存失败：${String(error)}`, job.sessionId); }
        });
        return JSON.stringify({ id: job.id, state: job.state, startedAt: job.startedAt, independentOfTurn: true });
      },
    }));
    const controls = [
      { name: "background_status", effect: "read" as const, description: "查看当前会话后台任务状态和最近日志", action: async (id: string | undefined, context?: ToolExecutionContext) => jobs(context?.sessionId ?? "").filter((job) => !id || job.id === id) },
      { name: "background_stop", effect: "write" as const, description: "终止当前会话指定后台任务及其进程组", action: async (id: string | undefined, context?: ToolExecutionContext) => stop(context?.sessionId ?? "", id ?? "") },
    ];
    for (const control of controls) ctx.registerTool(withAudit(ctx.workspacePath, {
      ...control,
      inputSchema: { type: "object", properties: { id: { type: "string" } }, ...(control.name === "background_stop" ? { required: ["id"] } : {}) },
      async execute(args, context) { return JSON.stringify(await control.action(typeof args.id === "string" ? args.id : undefined, context)); },
    }));
    ctx.registerChatCommand({ name: "tasks", description: "查看当前会话后台任务及日志", usage: "/tasks", execute: (context) => ({ text: JSON.stringify(jobs(context.sessionId), null, 2) }) });
    ctx.registerChatCommand({ name: "task-stop", description: "终止后台任务", usage: "/task-stop <id>", execute: async (context) => ({ text: JSON.stringify(await stop(context.sessionId, context.args[0] ?? ""), null, 2) }) });
  },
};
