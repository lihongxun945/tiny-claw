import { expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { coreDebugPlugin } from "../../src/plugins/core/debug.js";
import type { PluginContext } from "../../src/plugins/types.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

it("paginates metadata, filters sessions, migrates legacy traces and limits display details", async () => {
  const workspace = createTempWorkspace();
  try {
    let route!: Parameters<PluginContext["registerRoute"]>[0];
    await coreDebugPlugin.init({ workspacePath: workspace, registerHooks() {}, registerRoute(value) { route = value; } } as unknown as PluginContext);
    const dir = resolve(workspace, "debug/model-calls/2026-09-21");
    mkdirSync(dir, { recursive: true });
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const requestId = randomUUID(); ids.push(requestId);
      writeFileSync(resolve(dir, `${requestId}.json`), JSON.stringify({ requestId, sessionId: i < 3 ? "other" : "main",
        model: "test", provider: "test", mode: "chat", status: "success", startedAt: new Date(i * 1000).toISOString(),
        events: [{ phase: "request", data: "request" }, { phase: "stream_event", data: "chunk" }, { phase: "parsed_response", data: "final" }] }));
    }
    const query = async (suffix: string) => {
      const sendJSON = vi.fn();
      await route.handler({} as never, {} as never, { url: new URL(`http://localhost/debug/model-calls?${suffix}`), sendJSON, readBody: async () => "" });
      return sendJSON.mock.calls[0];
    };
    const [status, first] = await query("page=1&page_size=20");
    expect(status).toBe(200);
    expect(first.total).toBe(25);
    expect(first.traces).toHaveLength(20);
    expect(first.traces[0].requestId).toBe(ids[24]);
    expect(first.traces[0].events).toBeUndefined();
    expect(existsSync(resolve(dir, `${ids[0]}.json.meta`))).toBe(true);
    const second = (await query("page=2&page_size=20"))[1];
    expect(second.traces).toHaveLength(5);
    expect(second.traces.some((item: { requestId: string }) => first.traces.some((other: { requestId: string }) => item.requestId === other.requestId))).toBe(false);
    expect((await query("session_id=other"))[1].total).toBe(3);
    expect((await query("session_id=missing"))[1].traces).toEqual([]);
    expect((await query("page=999"))[1].page).toBe(2);
    expect((await query("page=-1"))[0]).toBe(400);
    expect((await query("page_size=1000"))[0]).toBe(400);
    const detail = (await query(`id=${ids[0]}&view=display`))[1].trace;
    expect(detail.events.map((event: { phase: string }) => event.phase)).toEqual(["request", "parsed_response"]);
    expect(JSON.parse(readFileSync(resolve(dir, `${ids[0]}.json`), "utf-8")).events).toHaveLength(3);
    // Once indexed, even an unreadable body must not affect list queries.
    writeFileSync(resolve(dir, `${ids[0]}.json`), "invalid JSON");
    expect((await query("page=2"))[1].total).toBe(25);
  } finally { removeTempWorkspace(workspace); }
});
