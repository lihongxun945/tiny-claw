export const SESSION_SUMMARY_VERSION = 2 as const;

export type SummaryCategory =
  | "goals"
  | "constraints"
  | "facts"
  | "decisions"
  | "completed"
  | "pending"
  | "resources";

export interface SummarySource {
  messageIds: string[];
  sequences: number[];
  turnIds: string[];
  legacy?: {
    type: "legacy_summary";
    stateFile: string;
    summaryThroughTimestamp?: number;
  };
}

export interface SummaryItem {
  id: string;
  text: string;
  status: "active" | "superseded" | "resolved";
  source: SummarySource;
  supersedes?: string[];
  createdAt: string;
}

export type SummaryCategories = Record<SummaryCategory, SummaryItem[]>;

export interface SummaryCheckpoint {
  id: string;
  throughSequence: number;
  createdAt: string;
  categories: SummaryCategories;
}

export type SummaryOperation =
  | { type: "add"; category: SummaryCategory; item: SummaryItem }
  | { type: "supersede"; category: SummaryCategory; targetId: string; replacement: SummaryItem }
  | { type: "resolve"; category: SummaryCategory; targetId: string; source: SummarySource };

export interface SummaryDelta {
  id: string;
  baseRevision: number;
  fromSequence: number;
  throughSequence: number;
  createdAt: string;
  operations: SummaryOperation[];
}

export interface PersistedSessionSummary {
  version: typeof SESSION_SUMMARY_VERSION;
  sessionId: string;
  revision: number;
  checkpoint: SummaryCheckpoint;
  deltas: SummaryDelta[];
  summarizedThroughSequence: number;
  updatedAt: string;
}

export interface SummaryItemDraft {
  text: string;
  sourceMessageIds: string[];
}

export type SummaryOperationDraft =
  | { type: "add"; category: SummaryCategory; item: SummaryItemDraft }
  | { type: "supersede"; category: SummaryCategory; targetId: string; replacement: SummaryItemDraft }
  | { type: "resolve"; category: SummaryCategory; targetId: string; sourceMessageIds: string[] };

export interface SummaryDeltaDraft {
  baseRevision: number;
  sourceRange: { fromSequence: number; throughSequence: number };
  operations: SummaryOperationDraft[];
}

export function emptySummaryCategories(): SummaryCategories {
  return {
    goals: [],
    constraints: [],
    facts: [],
    decisions: [],
    completed: [],
    pending: [],
    resources: [],
  };
}
