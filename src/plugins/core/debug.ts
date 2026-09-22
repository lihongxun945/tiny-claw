import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readdir, readFile, writeFile, link, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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

type ModelCallSummary = Omit<ModelCallTrace, "events"> & { eventCount: number };
function summarize({ events, ...trace }: ModelCallTrace): ModelCallSummary {
  return { ...trace, eventCount: events.length };
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
  const indexPath = `${path}.meta`;
  writeFileSync(`${indexPath}.${process.pid}.tmp`, JSON.stringify(summarize(trace)), "utf-8");
  renameSync(`${indexPath}.${process.pid}.tmp`, indexPath);
}

async function listTraces(workspacePath: string, sessionId?: string): Promise<ModelCallSummary[]> {
  const root = traceRoot(workspacePath);
  if (!existsSync(root)) return [];
  const traces: ModelCallSummary[] = [];
  for (const date of (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse()) {
    const dir = resolve(root, date);
    for (const file of (await readdir(dir)).filter((name) => name.endsWith(".json"))) {
      const path = resolve(dir, file);
      try {
        let summary: ModelCallSummary;
        try { summary = JSON.parse(await readFile(`${path}.meta`, "utf-8")) as ModelCallSummary; }
        catch {
          // Legacy traces are migrated one at a time without synchronous bulk I/O.
          summary = summarize(JSON.parse(await readFile(path, "utf-8")) as ModelCallTrace);
          if (summary.status !== "running") {
            const temporary = `${path}.${process.pid}.${randomUUID()}.meta.tmp`;
            await writeFile(temporary, JSON.stringify(summary), "utf-8");
            try { await link(temporary, `${path}.meta`); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
            finally { await unlink(temporary); }
          }
        }
        if (!sessionId || summary.sessionId === sessionId) traces.push(summary);
      } catch { /* Ignore incomplete or corrupt trace files. */ }
    }
  }
  return traces.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.requestId.localeCompare(a.requestId));
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
          const trace = path ? await readFile(path, "utf-8").then(value => JSON.parse(value) as ModelCallTrace).catch(() => undefined) : undefined;
          if (trace && routeCtx.url.searchParams.get("view") === "display") {
            const request = trace.events.find(event => event.phase === "request");
            const reversed = [...trace.events].reverse();
            const response = reversed.find(event => event.phase === "parsed_response")
              ?? reversed.find(event => event.phase === "response") ?? reversed.find(event => event.phase === "error");
            trace.events = [...(request ? [request] : []), ...(response ? [response] : [])];
          }
          routeCtx.sendJSON(trace ? 200 : 404, trace ? { trace } : { error: "模型调用记录不存在" });
          return;
        }

        const sessionId = routeCtx.url.searchParams.get("session_id") ?? undefined;
        const page = Number(routeCtx.url.searchParams.get("page") ?? 1);
        const pageSize = Number(routeCtx.url.searchParams.get("page_size") ?? 20);
        if (!Number.isSafeInteger(page) || page < 1 || ![20, 50, 100].includes(pageSize)) {
          routeCtx.sendJSON(400, { error: "page 必须为正整数，page_size 必须为 20、50 或 100" });
          return;
        }
        const traces = await listTraces(ctx.workspacePath, sessionId);
        const total = traces.length;
        const currentPage = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
        routeCtx.sendJSON(200, { traces: traces.slice((currentPage - 1) * pageSize, currentPage * pageSize),
          page: currentPage, pageSize, total });
      },
    });
  },
};
