import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopDesktopGateway } from "../../desktop/gateway-lifecycle.js";

afterEach(() => vi.useRealTimers());
describe("desktop gateway shutdown", () => {
  it("requests graceful shutdown over private IPC", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null, signalCode: null, connected: true,
      send: vi.fn(() => { queueMicrotask(() => child.emit("exit", 0)); }), kill: vi.fn(),
    });
    await stopDesktopGateway(child as unknown as ChildProcess, 100);
    expect(child.send).toHaveBeenCalledWith({ type: "desktop:shutdown" }, expect.any(Function));
    expect(child.kill).not.toHaveBeenCalled();
  });
  it("does nothing for an exited gateway", async () => {
    const child = { exitCode: 0, send: vi.fn(), kill: vi.fn() };
    await stopDesktopGateway(child as unknown as ChildProcess, 100);
    expect(child.send).not.toHaveBeenCalled();
  });
});
