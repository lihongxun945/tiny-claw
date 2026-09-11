import type { Plugin } from "../types.js";
import { loadConfig } from "../../config.js";
import { listRuns } from "../../run-store.js";

export interface UserQuestion {
  question: string;
  context?: string;
  type: "text" | "single_choice" | "multiple_choice";
  options: Array<{ id: string; label: string }>;
}

function settings(workspace: string) {
  const raw = loadConfig(workspace).plugins?.["core-user-input"] ?? {};
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new Error("core-user-input.enabled 必须为布尔值");
  const number = (key: string, fallback: number) => {
    const value = raw[key] ?? fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`core-user-input.${key} 必须为正整数`);
    return value;
  };
  return { enabled: raw.enabled !== false, maxOptions: number("maxOptions", 8), maxQuestionChars: number("maxQuestionChars", 4000), maxAnswerChars: number("maxAnswerChars", 12000) };
}

export function validateQuestion(args: Record<string, unknown>, limits: { maxOptions: number; maxQuestionChars: number }): UserQuestion {
  if (typeof args.question !== "string" || !args.question.trim() || args.question.length > limits.maxQuestionChars) throw new Error("问题不能为空或超过长度上限");
  if (args.context !== undefined && (typeof args.context !== "string" || args.context.length > limits.maxQuestionChars)) throw new Error("问题背景超过长度上限或格式错误");
  const type = args.type ?? "text";
  if (type !== "text" && type !== "single_choice" && type !== "multiple_choice") throw new Error("不支持的问题类型");
  const options = args.options ?? [];
  if (!Array.isArray(options) || options.length > limits.maxOptions) throw new Error("选项过多或格式错误");
  const ids = new Set<string>();
  const parsed = options.map((option: unknown) => {
    if (!option || typeof option !== "object") throw new Error("选项格式错误");
    const { id, label } = option as Record<string, unknown>;
    if (typeof id !== "string" || !id.trim() || id.length > limits.maxQuestionChars || ids.has(id) || typeof label !== "string" || !label.trim() || label.length > limits.maxQuestionChars) throw new Error("选项 ID 重复或内容无效");
    ids.add(id);
    return { id, label };
  });
  if (type !== "text" && parsed.length === 0) throw new Error("选择题需要提供选项");
  if (type === "text" && parsed.length) throw new Error("文本问题不能包含选项");
  return { question: args.question.trim(), context: args.context as string | undefined, type, options: parsed };
}

export function validateAnswer(question: UserQuestion, answer: Record<string, unknown>, maxChars: number): { selectedIds: string[]; text: string } {
  const ids = answer.selectedIds ?? [];
  const text = answer.text ?? "";
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !question.options.some((option) => option.id === id)) || new Set(ids).size !== ids.length) throw new Error("所选答案无效");
  if ((question.type === "text" && ids.length) || (question.type === "single_choice" && ids.length > 1)) throw new Error("所选答案数量不符合题型");
  if (typeof text !== "string" || text.length > maxChars || (!ids.length && !text.trim())) throw new Error("请填写答案，且不要超过答案长度上限");
  return { selectedIds: ids as string[], text: text.trim() };
}

export const coreUserInputPlugin: Plugin = {
  name: "core-user-input",
  async init(ctx) {
    const limits = settings(ctx.workspacePath);
    if (limits.enabled) {
      ctx.registerTool({
        name: "ask_user", effect: "read",
        description: "需要用户补充关键信息或选择执行方向时提问并暂停，用户回答后继续。每次只问一个问题；选择题也允许用户自由回答。不要用于审批工具权限。",
        inputSchema: { type: "object", properties: {
          question: { type: "string", maxLength: limits.maxQuestionChars },
          context: { type: "string", maxLength: limits.maxQuestionChars },
          type: { type: "string", enum: ["text", "single_choice", "multiple_choice"] },
          options: { type: "array", maxItems: limits.maxOptions, items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" } }, required: ["id", "label"] } },
        }, required: ["question"] },
        async execute(args, context) {
          const question = validateQuestion(args, limits);
          if (context?.actor && context.actor.channel !== "web") return JSON.stringify({ error: "当前渠道不支持问题弹窗，请在正文中提问并等待用户回复" });
          if (!context?.suspend) return JSON.stringify({ error: "当前执行入口不支持等待用户回答" });
          const requestId = context.suspend("user_input", { ...question, maxAnswerChars: limits.maxAnswerChars });
          return JSON.stringify({ status: "waiting_user", requestId, question: question.question });
        },
      });
      ctx.registerHooks({
        onFilterToolDefinitions(hook, definitions) { return hook.sessionId.startsWith("sub:") ? definitions.filter((tool) => tool.name !== "ask_user") : definitions; },
        onBuildTurnPrompt(hook, prompt) { return hook.sessionId.startsWith("sub:") ? prompt : `${prompt}\n\n在 Web 或桌面界面中，缺少关键输入或需要用户决定方向时使用 ask_user；其他渠道在正文提问。可合理自行决定的细节不要反复询问。调用前在正文简述原因，不要将 ask_user 和依赖答案的操作放在同一批。用户回答不是工具审批授权。`; },
      });
    }
    ctx.registerRoute({ method: "POST", path: "/user-input/answer", async handler(_req, _res, route) {
      let body: Record<string, unknown>;
      try { body = JSON.parse(await route.readBody()); } catch { return route.sendJSON(400, { error: "请求格式错误" }); }
      if (!body || typeof body.session_id !== "string" || typeof body.request_id !== "string") return route.sendJSON(400, { error: "缺少会话或问题 ID" });
      const run = listRuns(ctx.workspacePath, body.session_id).find((item) => item.suspension?.id === body.request_id);
      const pending = run?.suspension;
      if (run?.state !== "waiting_user" || pending?.kind !== "user_input" || pending.status !== "pending") return route.sendJSON(409, { error: "问题已处理或已取消" });
      const question = pending.payload as unknown as UserQuestion;
      let answer: ReturnType<typeof validateAnswer>;
      try { answer = validateAnswer(question, body, settings(ctx.workspacePath).maxAnswerChars); }
      catch (error) { return route.sendJSON(400, { error: String(error) }); }
      if (!route.resumeTool) return route.sendJSON(503, { error: "当前入口不支持恢复任务" });
      await route.resumeTool(body.session_id, body.request_id, JSON.stringify({ status: "answered", question: question.question, ...answer, selectedOptions: question.options.filter((option) => answer.selectedIds.includes(option.id)) }));
    } });
  },
};
