import type { ModelClient } from "../model/types.js";
import type { Message } from "../types.js";
import { extractSummaryDelta } from "./extractor.js";
import { applySummaryDelta, compactSummary } from "./reducer.js";
import type { PersistedSessionSummary, SummaryDelta } from "./types.js";
import type { SummaryValidationLimits } from "./validation.js";

export interface SessionSummaryEngineOptions {
  limits: SummaryValidationLimits;
  maxOutputTokens: number;
  maxInputChars: number;
  maxContextTokens?: number;
}

export interface SessionSummaryEngine {
  createDelta(
    client: ModelClient,
    sessionId: string,
    current: PersistedSessionSummary,
    messages: Message[],
    signal?: AbortSignal,
  ): Promise<SummaryDelta>;
  applyDelta(current: PersistedSessionSummary, delta: SummaryDelta): PersistedSessionSummary;
  compact(current: PersistedSessionSummary, createdAt?: string): PersistedSessionSummary;
}

export function createSessionSummaryEngine(options: SessionSummaryEngineOptions): SessionSummaryEngine {
  return {
    createDelta: (client, sessionId, current, messages, signal) => extractSummaryDelta(client, {
      signal,
      sessionId,
      current,
      messages,
      limits: options.limits,
      maxInputChars: options.maxInputChars,
      maxOutputTokens: options.maxOutputTokens,
      maxContextTokens: options.maxContextTokens,
    }),
    applyDelta: applySummaryDelta,
    compact: compactSummary,
  };
}
