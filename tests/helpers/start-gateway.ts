import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

async function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配随机端口"));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitUntilReady(url: string, child: ChildProcess, token?: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Gateway 提前退出: ${child.exitCode}`);
    }
    try {
      const response = await fetch(url, {
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
      });
      if (response.ok) return;
    } catch {
      // Gateway is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("等待 Gateway 启动超时");
}

export interface TestGateway {
  apiUrl: string;
  webUrl: string;
  stop(): Promise<void>;
}

export async function startTestGateway(workspacePath: string, token?: string): Promise<TestGateway> {
  const apiPort = await getFreePort();
  const webPort = await getFreePort();
  const tsxBin = resolve("node_modules/.bin/tsx");
  const child = spawn(tsxBin, [
    resolve("src/gateway.ts"),
    "--daemon-child",
    "--port",
    String(apiPort),
    "--web-port",
    String(webPort),
    "--workspace",
    workspacePath,
  ], {
    stdio: "ignore",
  });

  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  await Promise.all([
    waitUntilReady(`${apiUrl}/sessions`, child, token),
    waitUntilReady(`${webUrl}/`, child),
  ]);

  return {
    apiUrl,
    webUrl,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolveStop) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolveStop();
        }, 3_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolveStop();
        });
      });
    },
  };
}
