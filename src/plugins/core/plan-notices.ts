/** Read-only compatibility presentation; never infer a choice from old step state. */
export function legacyPlanNotice(run: { state: string; reason?: string }): string | undefined {
  if (run.state === "interrupted") return `本轮已中断：${run.reason || "运行未能继续"}。当前没有继续执行。`;
  if (run.state === "cancelled") return `本轮已取消：${run.reason || "用户停止任务"}。`;
  if (run.state === "waiting_user") return `等待您的回复：\n\n${run.reason || "请补充继续任务所需的信息。"}\n\n您可以直接在输入框回复。`;
}
