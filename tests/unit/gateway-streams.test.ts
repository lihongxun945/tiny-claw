import { describe, expect, it } from "vitest";
import { GatewayStream } from "../../src/gateway-streams.js";
import type { AgentEvent } from "../../src/agent.js";

describe("reconnectable Gateway streams", () => {
  it("restores structured activity and clears it on terminal runs", async () => {
    const stream = new GatewayStream("turn");
    const run = { id: "run", turnId: "turn", executionMode: "normal" as const, state: "running" as const, revision: 1, ordinal: 1, updatedAt: "now", owner: "test", ownerPid: 0,
      status: { stage: "execution:model_wait", state: "started" as const, message: "正在等待模型响应...", startedAt: 1000 } };
    const observed: string[] = [];
    stream.subscribe(() => observed.push(stream.snapshot.status));
    async function* events(): AsyncGenerator<AgentEvent> {
      yield { type: "run_state", run };
      yield { type: "run_state", run: { ...run, state: "completed", revision: 2, status: undefined } };
    }
    await stream.consume(events());
    expect(observed).toEqual(["正在等待模型响应...", ""]);
    expect(stream.snapshot.run?.state).toBe("completed");
  });
  it("retains partial output without subscribers and resumes with only new deltas", async () => {
    let release!: () => void;
    let ready!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const prepared = new Promise<void>((resolve) => { ready = resolve; });
    async function* events(): AsyncGenerator<AgentEvent> {
      yield { type: "text_delta", text: "已有输出" };
      yield { type: "tool_call", toolCallId: "call", name: "bash", input: { command: "test" }, startedAt: 1000 };
      ready();
      await paused;
      yield { type: "tool_result", toolCallId: "call", name: "bash", result: "ok", completedAt: 6000 };
      yield { type: "text_delta", text: "后续输出" };
      yield { type: "done", text: "已有输出后续输出", reason: "completed" };
    }
    const stream = new GatewayStream("turn", "approval");
    const consume = stream.consume(events());
    await prepared;
    expect(stream.snapshot).toMatchObject({ turnId: "turn", approvalId: "approval", text: "已有输出", toolCalls: [{ id: "call" }] });
    const received: AgentEvent[] = [];
    const unsubscribe = stream.subscribe((event) => received.push(event));
    release();
    await consume;
    await stream.finished;
    unsubscribe();
    expect(received.map((event) => event.type)).toEqual(["tool_result", "text_delta", "done"]);
    expect(stream.snapshot.toolCalls[0].result).toBe("ok");
    expect(stream.snapshot.toolCalls[0]).toMatchObject({ startedAt: 1000, completedAt: 6000 });
  });
});
