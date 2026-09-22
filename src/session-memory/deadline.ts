/** Bound even a provider that neglects cancellation; late results are never committed. */
export async function withinSummaryDeadline<T>(task: (signal: AbortSignal) => Promise<T>, milliseconds: number,
  parent?: AbortSignal): Promise<T> {
  parent?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("上下文压缩达到总耗时上限")), Math.max(0, milliseconds));
  let rejectAbort: (() => void) | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); return task(controller.signal); }),
      new Promise<never>((_, reject) => {
        rejectAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", rejectAbort, { once: true });
      })]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
    if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
  }
}
