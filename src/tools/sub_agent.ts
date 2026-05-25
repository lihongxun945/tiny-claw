import { runSubAgents, type SubAgentTask } from "../sub-agent.js";
import type { Tool } from "../types.js";

function parseTasks(args: Record<string, unknown>): SubAgentTask[] {
  const rawTasks = args.tasks;
  if (Array.isArray(rawTasks)) {
    const tasks: SubAgentTask[] = [];
    rawTasks.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const task = item as Record<string, unknown>;
      if (typeof task.task !== "string" || !task.task.trim()) return;
      tasks.push({
        id: typeof task.id === "string" ? task.id : `task-${index + 1}`,
        task: task.task,
        context: typeof task.context === "string" ? task.context : undefined,
      });
    });
    return tasks;
  }

  if (typeof args.task === "string" && args.task.trim()) {
    return [{
      id: "task-1",
      task: args.task,
      context: typeof args.context === "string" ? args.context : undefined,
    }];
  }

  return [];
}

export function createSubAgentTool(workspacePath: string): Tool {
  return {
    name: "sub_agent_run",
    description: "并行启动一个或多个只读 sub-agent 执行独立子任务，适合代码结构分析、资料检索、审查和方案调研。子 agent 的工具权限由配置控制，默认不能写文件、执行 bash 或保存记忆。",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "单个子任务。若提供 tasks，则忽略此字段。",
        },
        context: {
          type: "string",
          description: "单个子任务的补充上下文。",
        },
        tasks: {
          type: "array",
          description: "多个可并行执行的子任务。",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "可选的任务标识，便于汇总结果。",
              },
              task: {
                type: "string",
                description: "子任务描述。",
              },
              context: {
                type: "string",
                description: "该子任务的补充上下文。",
              },
            },
            required: ["task"],
          },
        },
        max_iterations: {
          type: "number",
          description: "每个 sub-agent 的最大 Agent Loop 轮数，默认读取配置，硬上限为 8。",
          minimum: 1,
          maximum: 8,
        },
        max_concurrency: {
          type: "number",
          description: "并发 sub-agent 数量，默认读取配置，硬上限为 8。",
          minimum: 1,
          maximum: 8,
        },
      },
    },
    execute: async (args) => {
      const tasks = parseTasks(args);
      if (tasks.length === 0) {
        return JSON.stringify({
          status: "error",
          error: "必须提供 task 或 tasks[].task",
        });
      }

      const result = await runSubAgents({
        workspacePath,
        tasks,
        maxIterations: args.max_iterations as number | undefined,
        maxConcurrency: args.max_concurrency as number | undefined,
      });

      return JSON.stringify(result);
    },
  };
}
