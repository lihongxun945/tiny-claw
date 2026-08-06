import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSession } from "./agent.js";
import { loadConfig } from "./config.js";
import { PluginManager } from "./plugin-manager.js";
import { rejectRequest } from "./tools/approval.js";
import type { AgentEvent } from "./agent.js";
import type { AgentActor, Config, SessionContext } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_SUB_AGENT_TOOLS = [
  "web_search",
  "web_fetch",
  "file_read",
  "memory_list",
  "memory_read",
  "skill_list",
  "skill_use",
];

const ALWAYS_DISABLED_TOOLS = ["sub_agent_run"];
const DEFAULT_MAX_ITERATIONS = 3;
const DEFAULT_MAX_CONCURRENCY = 3;
const HARD_MAX_ITERATIONS = 8;
const HARD_MAX_CONCURRENCY = 8;

export interface SubAgentTask {
  id?: string;
  task: string;
  context?: string;
}

export interface SubAgentRunOptions {
  workspacePath: string;
  parentSessionId?: string;
  actor?: AgentActor;
  tasks: SubAgentTask[];
  maxIterations?: number;
  maxConcurrency?: number;
  sessionContext?: SessionContext;
}

export interface SubAgentTaskResult {
  id: string;
  status: "completed" | "max_iterations_reached" | "approval_required" | "error";
  summary: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
  error?: string;
}

function parseApprovalResult(result: string): { approvalId: string } | undefined {
  try {
    const parsed = JSON.parse(result) as { requiresConfirmation?: unknown; approvalId?: unknown };
    if (parsed.requiresConfirmation === true && typeof parsed.approvalId === "string") {
      return { approvalId: parsed.approvalId };
    }
  } catch {
    // Non-JSON tool results cannot represent an approval request.
  }
  return undefined;
}

export async function collectSubAgentResult(options: {
  workspacePath: string;
  actor?: AgentActor;
  id: string;
  events: AsyncIterable<AgentEvent>;
}): Promise<SubAgentTaskResult> {
  let finalText = "";
  let doneReason: Extract<AgentEvent, { type: "done" }>["reason"] | undefined;
  let blockedTool: string | undefined;
  const toolCalls: SubAgentTaskResult["toolCalls"] = [];

  for await (const event of options.events) {
    if (event.type === "tool_call") {
      toolCalls.push({ name: event.name, input: event.input });
    } else if (event.type === "tool_result") {
      const approval = parseApprovalResult(event.result);
      if (approval) {
        rejectRequest(options.workspacePath, approval.approvalId, options.actor);
        blockedTool = event.name;
      }
    } else if (event.type === "done") {
      finalText = event.text;
      doneReason = event.reason;
    } else if (event.type === "error") {
      return { id: options.id, status: "error", summary: "", toolCalls, error: event.message };
    }
  }

  if (doneReason === "approval_required" || blockedTool) {
    return {
      id: options.id,
      status: "approval_required",
      summary: "",
      toolCalls,
      error: `sub-agent 调用 ${blockedTool ?? "工具"} 时需要用户审批。子会话不能独立恢复审批，请由主 Agent 使用相同参数重新调用该工具。`,
    };
  }
  return {
    id: options.id,
    status: doneReason ? "completed" : "max_iterations_reached",
    summary: finalText.trim(),
    toolCalls,
  };
}

export interface SubAgentRunResult {
  status: "completed" | "partial_error" | "error";
  results: SubAgentTaskResult[];
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value) || !value || value < 1) return fallback;
  return Math.min(Math.floor(value), max);
}

function resolveSubAgentTools(config: Config): string[] {
  const subConfig = config.subAgent ?? {};
  const allowed = subConfig.allowedTools?.length
    ? subConfig.allowedTools
    : DEFAULT_SUB_AGENT_TOOLS;
  const disabled = new Set([...ALWAYS_DISABLED_TOOLS, ...(subConfig.disabledTools ?? [])]);
  return allowed.filter((name) => !disabled.has(name));
}

function loadSubAgentTemplate(workspacePath: string): string {
  const customPath = resolve(workspacePath, "sub_agent_prompt.md");
  if (existsSync(customPath)) {
    return readFileSync(customPath, "utf-8");
  }
  return readFileSync(resolve(__dirname, "prompts/sub_agent.md"), "utf-8");
}

function buildSubAgentPrompt(
  workspacePath: string,
  task: SubAgentTask,
  allowedTools: string[],
): string {
  const template = loadSubAgentTemplate(workspacePath);
  const values: Record<string, string> = {
    task: task.task.trim(),
    context: task.context?.trim() ?? "",
    allowed_tools: allowedTools.join(", "),
    current_date: new Date().toISOString().slice(0, 10),
  };

  return template.replace(/\{\{([^}]+)}}/g, (_, key: string) => values[key.trim()] ?? "");
}

async function runOneSubAgent(
  workspacePath: string,
  config: Config,
  parentSessionId: string | undefined,
  actor: AgentActor | undefined,
  task: SubAgentTask,
  maxIterations: number,
  sessionContext?: SessionContext,
): Promise<SubAgentTaskResult> {
  const id = task.id?.trim() || randomUUID();
  const sessionId = parentSessionId
    ? `sub:${parentSessionId}:${id}`
    : `sub:${id}`;

  let pm: PluginManager | undefined;
  try {
    const allowedTools = resolveSubAgentTools(config);
    pm = new PluginManager(workspacePath, {
      allowedTools,
      disabledTools: ALWAYS_DISABLED_TOOLS,
    });
    await pm.loadCorePlugins();

    const session = new AgentSession(sessionId, workspacePath, pm, {
      maxAgentIterations: maxIterations,
    }, undefined, sessionContext);

    return collectSubAgentResult({
      workspacePath,
      actor,
      id,
      events: session.chat(buildSubAgentPrompt(workspacePath, task, allowedTools), actor),
    });
  } catch (err) {
    return {
      id,
      status: "error",
      summary: "",
      toolCalls: [],
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await pm?.destroy();
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function consume(): Promise<void> {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await worker(items[current]);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => consume(),
  );
  await Promise.all(workers);
  return results;
}

export async function runSubAgents(options: SubAgentRunOptions): Promise<SubAgentRunResult> {
  const config = loadConfig(options.workspacePath);
  const maxIterations = clamp(
    options.maxIterations ?? config.subAgent?.maxIterations,
    DEFAULT_MAX_ITERATIONS,
    HARD_MAX_ITERATIONS,
  );
  const maxConcurrency = clamp(
    options.maxConcurrency ?? config.subAgent?.maxConcurrency,
    DEFAULT_MAX_CONCURRENCY,
    HARD_MAX_CONCURRENCY,
  );

  if (options.tasks.length === 0) {
    return { status: "error", results: [] };
  }

  const results = await runWithConcurrency(
    options.tasks,
    maxConcurrency,
    (task) => runOneSubAgent(
      options.workspacePath,
      config,
      options.parentSessionId,
      options.actor,
      task,
      maxIterations,
      options.sessionContext,
    ),
  );

  const hasError = results.some((r) => r.status === "error" || r.status === "approval_required");
  return {
    status: hasError ? "partial_error" : "completed",
    results,
  };
}
