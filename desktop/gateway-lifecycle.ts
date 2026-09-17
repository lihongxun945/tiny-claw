import { execFile, type ChildProcess } from "node:child_process";

export async function stopDesktopGateway(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      if (process.platform === "win32" && child.pid) {
        execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, error => {
          if (error && child.exitCode === null && child.signalCode === null) reject(error);
          else resolve();
        });
      } else child.kill("SIGKILL");
    }, timeoutMs);
    child.once("exit", finish);
    if (child.connected) child.send({ type: "desktop:shutdown" }, error => {
      if (error) console.error("Gateway shutdown IPC failed", error);
    });
    else if (process.platform !== "win32") child.kill("SIGTERM");
  });
}
