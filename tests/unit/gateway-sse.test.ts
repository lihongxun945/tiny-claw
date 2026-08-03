import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { startSSEHeartbeat } from "../../src/gateway-sse.js";

describe("Gateway SSE heartbeat", () => {
  it("keeps an idle stream alive and stops after the response finishes", () => {
    vi.useFakeTimers();
    try {
      const response = new EventEmitter() as EventEmitter & {
        writableEnded: boolean;
        write: ReturnType<typeof vi.fn>;
      };
      response.writableEnded = false;
      response.write = vi.fn();

      startSSEHeartbeat(response as never, 1000);
      vi.advanceTimersByTime(3000);
      expect(response.write).toHaveBeenCalledTimes(3);
      expect(response.write).toHaveBeenLastCalledWith(": heartbeat\n\n");

      response.emit("finish");
      vi.advanceTimersByTime(3000);
      expect(response.write).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
