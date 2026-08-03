import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelDebugEvent } from "../../model/types.js";
import type { Plugin } from "../types.js";

export interface ModelCallTrace {
  requestId: string;
  sessionId?: string;
  provider: string;
  model: string;
  mode: "chat" | "complete";
  startedAt: string;
  updatedAt: string;
  durationMs?: number;
  status: "running" | "success" | "error";
  events: Array<Pick<ModelDebugEvent, "timestamp" | "phase" | "data">>;
}

function traceRoot(workspacePath: string): string {
  return resolve(workspacePath, "debug", "model-calls");
}

function tracePath(workspacePath: string, requestId: string, date: string): string {
  return resolve(traceRoot(workspacePath), date, `${requestId}.json`);
}

function sanitizeDebugData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeDebugData);
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === "data" && record.type === "base64" && typeof item === "string") {
      result[key] = `[base64 omitted, ${item.length} characters]`;
    } else if (key === "url" && typeof item === "string" && item.startsWith("data:image/")) {
      result[key] = `[image data URL omitted, ${item.length} characters]`;
    } else {
      result[key] = sanitizeDebugData(item);
    }
  }
  return result;
}

function findTracePath(workspacePath: string, requestId: string): string | undefined {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return undefined;
  const root = traceRoot(workspacePath);
  if (!existsSync(root)) return undefined;
  for (const date of readdirSync(root).sort().reverse()) {
    const path = tracePath(workspacePath, requestId, date);
    if (existsSync(path)) return path;
  }
  return undefined;
}

function readTrace(path: string): ModelCallTrace | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ModelCallTrace;
  } catch {
    return undefined;
  }
}

function persistEvents(workspacePath: string, events: ModelDebugEvent[]): void {
  if (events.length === 0) return;
  const firstEvent = events[0];
  const existingPath = findTracePath(workspacePath, firstEvent.requestId);
  const path = existingPath ?? tracePath(workspacePath, firstEvent.requestId, firstEvent.timestamp.slice(0, 10));
  const existing = existsSync(path) ? readTrace(path) : undefined;
  const startedAt = existing?.startedAt ?? firstEvent.timestamp;
  const lastEvent = events[events.length - 1];
  let status = existing?.status ?? "running";
  let durationMs = existing?.durationMs;
  for (const event of events) {
    const terminal = event.phase === "parsed_response" || event.phase === "response" || event.phase === "error";
    if (terminal) {
      status = event.phase === "error" ? "error" : "success";
      durationMs = Math.max(0, Date.parse(event.timestamp) - Date.parse(startedAt));
    }
  }
  const trace: ModelCallTrace = {
    requestId: firstEvent.requestId,
    sessionId: lastEvent.sessionId ?? existing?.sessionId,
    provider: lastEvent.provider,
    model: lastEvent.model,
    mode: lastEvent.mode,
    startedAt,
    updatedAt: lastEvent.timestamp,
    durationMs,
    status,
    events: [
      ...(existing?.events ?? []),
      ...events.map((event) => ({
        timestamp: event.timestamp,
        phase: event.phase,
        data: sanitizeDebugData(event.data),
      })),
    ],
  };

  mkdirSync(resolve(path, ".."), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(trace, null, 2)}\n`, "utf-8");
  renameSync(temporaryPath, path);
}

function listTraces(workspacePath: string, sessionId?: string): ModelCallTrace[] {
  const root = traceRoot(workspacePath);
  if (!existsSync(root)) return [];
  const traces: ModelCallTrace[] = [];
  for (const date of readdirSync(root).sort().reverse()) {
    const dir = resolve(root, date);
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      const trace = readTrace(resolve(dir, file));
      if (trace && (!sessionId || trace.sessionId === sessionId)) traces.push(trace);
    }
  }
  return traces.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export const coreDebugPlugin: Plugin = {
  name: "core-debug",
  async init(ctx) {
    const bufferedStreamEvents = new Map<string, ModelDebugEvent[]>();
    ctx.registerHooks({
      onModelDebug(event) {
        if (event.phase === "stream_event") {
          const buffered = bufferedStreamEvents.get(event.requestId) ?? [];
          buffered.push(event);
          bufferedStreamEvents.set(event.requestId, buffered);
          return;
        }

        const buffered = bufferedStreamEvents.get(event.requestId) ?? [];
        bufferedStreamEvents.delete(event.requestId);
        persistEvents(ctx.workspacePath, [...buffered, event]);
      },
    });

    ctx.registerRoute({
      method: "GET",
      path: "/debug/model-calls",
      async handler(_req, _res, routeCtx) {
        const requestId = routeCtx.url.searchParams.get("id");
        if (requestId) {
          const path = findTracePath(ctx.workspacePath, requestId);
          const trace = path ? readTrace(path) : undefined;
          routeCtx.sendJSON(trace ? 200 : 404, trace ? { trace } : { error: "模型调用记录不存在" });
          return;
        }

        const sessionId = routeCtx.url.searchParams.get("session_id") ?? undefined;
        const traces = listTraces(ctx.workspacePath, sessionId).map(({ events, ...trace }) => ({
          ...trace,
          eventCount: events.length,
        }));
        routeCtx.sendJSON(200, { traces });
      },
    });
  },
};
