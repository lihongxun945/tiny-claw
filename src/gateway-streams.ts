import type { AgentEvent } from "./agent.js";

interface StreamToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  startedAt: number;
  completedAt?: number;
}

export interface StreamSnapshot {
  turnId: string;
  approvalId?: string;
  text: string;
  status: string;
  toolCalls: StreamToolCall[];
}

export class GatewayStream {
  readonly snapshot: StreamSnapshot;
  private listeners = new Set<(event: AgentEvent) => void>();
  readonly finished: Promise<void>;
  private finish!: () => void;

  constructor(turnId: string, approvalId?: string) {
    this.snapshot = { turnId, approvalId, text: "", status: "", toolCalls: [] };
    this.finished = new Promise((resolve) => { this.finish = resolve; });
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async consume(events: AsyncIterable<AgentEvent>): Promise<void> {
    try {
      for await (const event of events) {
        if (event.type === "text_delta") this.snapshot.text += event.text;
        if (event.type === "status") this.snapshot.status = event.message;
        if (event.type === "tool_call") this.snapshot.toolCalls.push({
          id: event.toolCallId, name: event.name, input: event.input, startedAt: Date.now(),
        });
        if (event.type === "tool_result") {
          const call = this.snapshot.toolCalls.find((item) => item.id === event.toolCallId);
          if (call) { call.result = event.result; call.completedAt = Date.now(); }
        }
        for (const listener of this.listeners) listener(event);
      }
    } catch (error) {
      for (const listener of this.listeners) listener({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.listeners.clear();
      this.finish();
    }
  }
}
