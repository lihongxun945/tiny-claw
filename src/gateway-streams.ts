import type { AgentEvent } from "./agent.js";
import type { SessionRun } from "./run-store.js";

interface StreamToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface StreamSnapshot {
  run?: SessionRun;
  sequence: number;
  turnId: string;
  approvalId?: string;
  text: string;
  status: string;
  toolCalls: StreamToolCall[];
}

export class GatewayStream {
  readonly snapshot: StreamSnapshot;
  private listeners = new Set<(event: AgentEvent, sequence: number) => void>();
  readonly finished: Promise<void>;
  private finish!: () => void;

  constructor(turnId: string, approvalId?: string) {
    this.snapshot = { turnId, approvalId, text: "", status: "", toolCalls: [], sequence: 0 };
    this.finished = new Promise((resolve) => { this.finish = resolve; });
  }

  subscribe(listener: (event: AgentEvent, sequence: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async consume(events: AsyncIterable<AgentEvent>): Promise<void> {
    try {
      for await (const event of events) {
        this.snapshot.sequence++;
        if (event.type === "run_state") {
          this.snapshot.run = event.run;
          this.snapshot.turnId = event.run.turnId;
          this.snapshot.status = event.run.state === "running" ? event.run.status?.message ?? "" : "";
        }
        if (event.type === "text_delta") this.snapshot.text += event.text;
        if (event.type === "status") this.snapshot.status = event.message;
        if (event.type === "tool_call") this.snapshot.toolCalls.push({
          id: event.toolCallId, name: event.name, input: event.input, startedAt: event.startedAt,
        });
        if (event.type === "tool_result") {
          const call = this.snapshot.toolCalls.find((item) => item.id === event.toolCallId);
          if (call) { call.result = event.result; call.completedAt = event.completedAt; }
        }
        for (const listener of this.listeners) listener(event, this.snapshot.sequence);
      }
    } catch (error) {
      for (const listener of this.listeners) listener({ type: "error", message: error instanceof Error ? error.message : String(error) }, ++this.snapshot.sequence);
    } finally {
      this.listeners.clear();
      this.finish();
    }
  }
}
