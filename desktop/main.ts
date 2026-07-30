import { app, BrowserWindow, dialog, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { initializeDesktopWorkspace } from "./workspace.js";

let mainWindow: BrowserWindow | null = null;
let gatewayProcess: ChildProcess | null = null;
let quitting = false;

function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配本地端口"));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitForGateway(url: string, child: ChildProcess, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Gateway 启动失败，退出码 ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Gateway 尚未监听，继续等待。
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Gateway 启动超时");
}

async function stopGateway(): Promise<void> {
  const child = gatewayProcess;
  gatewayProcess = null;
  if (!child || child.exitCode !== null) return;

  await new Promise<void>((resolveStop) => {
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(forceTimer);
      resolveStop();
    });
    child.kill("SIGTERM");
  });
}

async function launchDesktop(): Promise<void> {
  const workspacePath = initializeDesktopWorkspace(app.getPath("userData"));
  const [apiPort, webPort] = await Promise.all([reservePort(), reservePort()]);
  const appRoot = app.getAppPath();
  const tsxCli = resolve(appRoot, "node_modules/tsx/dist/cli.mjs");
  const gatewayEntry = resolve(appRoot, "dist/gateway.js");

  gatewayProcess = spawn(
    process.execPath,
    [
      tsxCli,
      gatewayEntry,
      "--daemon-child",
      "--host",
      "127.0.0.1",
      "--port",
      String(apiPort),
      "--web-port",
      String(webPort),
      "--workspace",
      workspacePath,
    ],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  gatewayProcess.stdout?.on("data", (chunk) => console.log(`[gateway] ${String(chunk).trimEnd()}`));
  gatewayProcess.stderr?.on("data", (chunk) => console.error(`[gateway] ${String(chunk).trimEnd()}`));
  gatewayProcess.once("exit", (code, signal) => {
    gatewayProcess = null;
    if (!quitting) {
      void dialog.showErrorBox("tiny-claw Gateway 已停止", `退出码：${code ?? "无"}\n信号：${signal ?? "无"}`);
    }
  });

  const webUrl = `http://127.0.0.1:${webPort}/`;
  await waitForGateway(webUrl, gatewayProcess);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    title: "tiny-claw",
    backgroundColor: "#111426",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(webUrl)) event.preventDefault();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(webUrl);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady()
    .then(launchDesktop)
    .catch((error) => {
      dialog.showErrorBox("tiny-claw 启动失败", error instanceof Error ? error.message : String(error));
      app.quit();
    });

  app.on("activate", () => {
    if (mainWindow) mainWindow.show();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", (event) => {
    if (quitting || !gatewayProcess) return;
    event.preventDefault();
    quitting = true;
    void stopGateway().finally(() => app.quit());
  });
}
