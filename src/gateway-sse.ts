import type { ServerResponse } from "node:http";

export function startSSEHeartbeat(res: ServerResponse, intervalMs: number): () => void {
  const timer = setInterval(() => {
    if (!res.writableEnded) res.write(": heartbeat\n\n");
  }, intervalMs);
  timer.unref();

  const stop = () => clearInterval(timer);
  res.once("finish", stop);
  res.once("close", stop);
  return stop;
}
