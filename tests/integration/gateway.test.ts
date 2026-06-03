import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";
import { startTestGateway, type TestGateway } from "../helpers/start-gateway.js";

async function json(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

describe("Gateway HTTP API", () => {
  let workspacePath: string;
  let gateway: TestGateway;

  beforeEach(async () => {
    workspacePath = createTempWorkspace({
      ollamaApiKey: "ollama-secret",
      plugins: {
        demo: {
          appSecret: "plugin-secret",
          verificationToken: "plugin-token",
        },
      },
    });
    gateway = await startTestGateway(workspacePath);
  });

  afterEach(async () => {
    await gateway.stop();
    removeTempWorkspace(workspacePath);
  });

  it("masks nested secrets and preserves them when masked config is saved", async () => {
    const before = await json(`${gateway.apiUrl}/config`);
    expect(before.status).toBe(200);
    expect(before.body.config).toMatchObject({
      apiKey: "test***",
      ollamaApiKey: "olla***",
      plugins: {
        demo: {
          appSecret: "plug***",
          verificationToken: "plug***",
        },
      },
    });

    const saved = await json(`${gateway.apiUrl}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(before.body.config),
    });
    expect(saved.status).toBe(200);

    const disk = JSON.parse(readFileSync(resolve(workspacePath, "config.json"), "utf-8"));
    expect(disk).toMatchObject({
      apiKey: "test-api-key",
      ollamaApiKey: "ollama-secret",
      plugins: {
        demo: {
          appSecret: "plugin-secret",
          verificationToken: "plugin-token",
        },
      },
    });
  });

  it("rejects invalid config updates without writing them to disk", async () => {
    const configPath = resolve(workspacePath, "config.json");
    const before = readFileSync(configPath, "utf-8");
    const result = await json(`${gateway.apiUrl}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxTokens: 0 }),
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toContain("配置字段 maxTokens 超出允许范围");
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("supports memory CRUD and enable/disable operations", async () => {
    writeFileSync(resolve(workspacePath, "memory", "project.md"), [
      "---",
      "name: project",
      "tags: [tiny-claw]",
      "createdAt: 2026-06-02T00:00:00.000Z",
      "updatedAt: 2026-06-02T00:00:00.000Z",
      "sensitive: false",
      "disabled: false",
      "scope: project",
      "source: manual",
      "summary: 项目背景",
      "---",
      "",
      "tiny-claw project",
      "",
    ].join("\n"), "utf-8");

    expect((await json(`${gateway.apiUrl}/memory?include_sensitive=true&include_disabled=true`)).body.memories).toHaveLength(1);
    expect((await json(`${gateway.apiUrl}/memory/project`)).body.memory).toMatchObject({
      name: "project",
      summary: "项目背景",
    });

    const updated = await json(`${gateway.apiUrl}/memory/project`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "updated project", tags: ["updated"] }),
    });
    expect(updated.body.memory).toMatchObject({
      content: "updated project",
      tags: ["updated"],
    });

    expect((await json(`${gateway.apiUrl}/memory/project/disable`, { method: "POST" })).body.memory.disabled).toBe(true);
    expect((await json(`${gateway.apiUrl}/memory/project/enable`, { method: "POST" })).body.memory.disabled).toBe(false);
    expect((await json(`${gateway.apiUrl}/memory/project`, { method: "DELETE" })).body.deleted).toBe(true);
    expect((await json(`${gateway.apiUrl}/memory/project`)).status).toBe(404);
  });

  it("filters sub-agent sessions and deletes persisted session history", async () => {
    const historyPath = resolve(workspacePath, "history", "2026-06-02.jsonl");
    writeFileSync(historyPath, [
      JSON.stringify({ role: "user", content: "main question", _session: "main", _timestamp: 2 }),
      JSON.stringify({ role: "assistant", content: "main answer", _session: "main", _timestamp: 3 }),
      JSON.stringify({ role: "user", content: "sub question", _session: "sub:main:worker", _timestamp: 4 }),
      "{malformed",
      "",
    ].join("\n"), "utf-8");

    const sessions = await json(`${gateway.apiUrl}/history/sessions`);
    expect(sessions.body.sessions.map((session: { id: string }) => session.id)).toEqual(["main"]);
    expect((await json(`${gateway.apiUrl}/history/sessions/main/messages`)).body.messages).toEqual([
      expect.objectContaining({ role: "user", text: "main question" }),
      expect.objectContaining({ role: "assistant", text: "main answer" }),
    ]);

    const deleted = await json(`${gateway.apiUrl}/sessions/main`, { method: "DELETE" });
    expect(deleted.body).toEqual({ deleted: true, deletedHistoryRecords: 2 });
    expect((await json(`${gateway.apiUrl}/history/sessions`)).body.sessions).toEqual([]);
    expect(readFileSync(historyPath, "utf-8")).toContain("{malformed");
  });

  it("restores persisted tool results after a page refresh", async () => {
    const historyPath = resolve(workspacePath, "history", "2026-06-02.jsonl");
    writeFileSync(historyPath, [
      JSON.stringify({ role: "user", content: "run pwd", _session: "tool-history", _timestamp: 1 }),
      JSON.stringify({
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "bash", input: { command: "pwd" } }],
        _session: "tool-history",
        _timestamp: 2,
      }),
      JSON.stringify({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "{\"error\":\"bash 执行已禁用\"}" }],
        _session: "tool-history",
        _timestamp: 3,
      }),
      "",
    ].join("\n"), "utf-8");

    expect((await json(`${gateway.apiUrl}/history/sessions/tool-history/messages`)).body.messages).toEqual([
      expect.objectContaining({ role: "user", text: "run pwd" }),
      expect.objectContaining({
        role: "assistant",
        toolCalls: [{
          id: "call-1",
          name: "bash",
          input: { command: "pwd" },
          result: "{\"error\":\"bash 执行已禁用\"}",
        }],
      }),
    ]);
  });

  it("serves WebUI static files and proxies memory API", async () => {
    const page = await fetch(`${gateway.webUrl}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");

    const proxied = await json(`${gateway.webUrl}/memory?include_sensitive=true&include_disabled=true`);
    expect(proxied).toEqual({ status: 200, body: { memories: [] } });
  });

  it("exposes approval API and proxies it through the WebUI server", async () => {
    expect(await json(`${gateway.apiUrl}/approvals`)).toEqual({ status: 200, body: { approvals: [] } });
    expect(await json(`${gateway.webUrl}/approvals`)).toEqual({ status: 200, body: { approvals: [] } });
    expect((await json(`${gateway.apiUrl}/approvals/missing/approve`, { method: "POST" })).status).toBe(404);
    expect((await json(`${gateway.apiUrl}/approvals/missing/reject`, { method: "POST" })).status).toBe(404);
  });

  it("returns not found when cancelling an unknown session", async () => {
    expect((await json(`${gateway.apiUrl}/sessions/missing/cancel`, { method: "POST" })).status).toBe(404);
  });
});

describe("Gateway token authentication", () => {
  let workspacePath: string;
  let gateway: TestGateway;

  beforeEach(async () => {
    workspacePath = createTempWorkspace({
      security: {
        gateway: {
          token: "gateway-secret",
        },
      },
    });
    gateway = await startTestGateway(workspacePath, "gateway-secret");
  });

  afterEach(async () => {
    await gateway.stop();
    removeTempWorkspace(workspacePath);
  });

  it("rejects unauthenticated API requests and keeps the local WebUI proxy working", async () => {
    expect((await json(`${gateway.apiUrl}/sessions`)).status).toBe(401);
    expect((await json(`${gateway.apiUrl}/sessions`, {
      headers: { authorization: "Bearer gateway-secret" },
    })).status).toBe(200);
    expect((await json(`${gateway.webUrl}/sessions`)).status).toBe(200);
  });
});
