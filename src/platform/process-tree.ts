import { execFile } from "node:child_process";

export function terminateWindowsTree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (error) => {
      if (!error) { resolve(); return; }
      // taskkill also reports an error when the process already exited.
      try { process.kill(pid, 0); } catch { resolve(); return; }
      reject(error);
    });
  });
}
