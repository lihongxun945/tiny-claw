import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { AgentSession, type AgentEvent } from "./agent.js";

const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 分钟

function parseWorkspaceArg(): string | undefined {
  const idx = process.argv.indexOf("--workspace");
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
}

function parsePortArg(): number {
  const idx = process.argv.indexOf("--port");
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return parseInt(process.argv[idx + 1], 10) || 3000;
  }
  const envPort = process.env.TINY_CLAW_PORT;
  if (envPort) return parseInt(envPort, 10) || 3000;
  return 3000;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

function sendSSEHeader(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
    "access-control-allow-origin": "*",
  });
}

function sendSSE(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// === 会话管理 ===

const sessions = new Map<string, AgentSession>();

function getOrCreateSession(sessionId: string | undefined, workspacePath: string): AgentSession {
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    session.lastActivity = Date.now();
    return session;
  }
  const id = sessionId || randomUUID();
  const session = new AgentSession(id, workspacePath);
  sessions.set(id, session);
  return session;
}

function cleanupSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT) {
      sessions.delete(id);
    }
  }
}

// 每 5 分钟清理超时会话
setInterval(cleanupSessions, 5 * 60 * 1000);

// === HTTP 服务器 ===

async function main() {
  const workspacePath = parseWorkspaceArg() || process.env.TINY_CLAW_WORKSPACE || process.cwd() + "/workspace";
  const port = parsePortArg();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }

    // POST /chat
    if (req.method === "POST" && url.pathname === "/chat") {
      try {
        const body = JSON.parse(await readBody(req));
        const message = body.message as string;
        const sessionId = body.session_id as string | undefined;

        if (!message || typeof message !== "string") {
          sendJSON(res, 400, { error: "缺少 message 字段" });
          return;
        }

        const session = getOrCreateSession(sessionId, workspacePath);
        sendSSEHeader(res);

        for await (const event of session.chat(message)) {
          switch (event.type) {
            case "text_delta":
              sendSSE(res, "text_delta", { text: event.text });
              break;
            case "tool_call":
              sendSSE(res, "tool_call", { name: event.name, input: event.input });
              break;
            case "tool_result":
              sendSSE(res, "tool_result", { name: event.name, result: event.result });
              break;
            case "done":
              sendSSE(res, "done", { text: event.text, session_id: session.id });
              break;
            case "error":
              sendSSE(res, "error", { message: event.message });
              break;
          }
        }

        res.end();
      } catch (err) {
        if (!res.headersSent) {
          sendJSON(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      }
      return;
    }

    // GET /sessions
    if (req.method === "GET" && url.pathname === "/sessions") {
      const list = Array.from(sessions.values()).map((s) => ({
        id: s.id,
        lastActivity: s.lastActivity,
      }));
      sendJSON(res, 200, { sessions: list });
      return;
    }

    // DELETE /sessions/:id
    if (req.method === "DELETE" && url.pathname.startsWith("/sessions/")) {
      const id = url.pathname.slice("/sessions/".length);
      if (sessions.delete(id)) {
        sendJSON(res, 200, { deleted: true });
      } else {
        sendJSON(res, 404, { error: "会话不存在" });
      }
      return;
    }

    // 404
    sendJSON(res, 404, { error: "未找到路由" });
  });

  server.listen(port, () => {
    console.log(`tiny-claw gateway 已启动: http://localhost:${port}`);
    console.log(`  POST /chat        - 发送消息（SSE 流式响应）`);
    console.log(`  GET  /sessions    - 列出活跃会话`);
    console.log(`  DELETE /sessions/:id - 销毁会话`);
    console.log(`工作目录: ${workspacePath}`);
  });
}

main();
