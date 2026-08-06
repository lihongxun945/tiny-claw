export interface ToolCallInfo {
  id?: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
}

export interface Attachment {
  id: string;
  name: string;
  mediaType: string;
  size?: number;
  url: string;
}

export interface Message {
  role: "user" | "assistant";
  text: string;
  toolCalls: ToolCallInfo[];
  attachments?: Attachment[];
  timestamp: number;
  turnId?: string;
  plan?: SessionPlan;
}

export interface Session {
  id: string;
  lastActivity: number;
  preview?: string;
  busy?: boolean;
  context: SessionContext;
  executionMode: ExecutionMode;
}

export interface SessionContext {
  mode: "chat" | "project";
  project?: { root: string; name: string };
}

export interface SSEEvent {
  event: string;
  data: unknown;
}

export interface ChatCommand {
  name: string;
  aliases: string[];
  description: string;
  usage: string;
}

export interface ApprovalRequest {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  command?: string;
  cwd?: string;
  status: "pending" | "approved";
  createdAt: string;
  expiresAt: string;
  actor?: {
    channel: "cli" | "web" | "feishu";
    requesterId?: string;
    chatId?: string;
  };
  sessionId?: string;
}

export type ModelDebugPhase = "request" | "response" | "parsed_response" | "error" | "repair" | "stream_event";

export interface ModelCallSummary {
  requestId: string;
  sessionId?: string;
  provider: string;
  model: string;
  mode: "chat" | "complete";
  startedAt: string;
  updatedAt: string;
  durationMs?: number;
  status: "running" | "success" | "error";
  eventCount: number;
}

export interface ModelCallTrace extends Omit<ModelCallSummary, "eventCount"> {
  events: Array<{
    timestamp: string;
    phase: ModelDebugPhase;
    data: unknown;
  }>;
}

export type MemorySource = "manual" | "tool" | "auto";

export interface MemoryRecord {
  name: string;
  summary: string;
  content: string;
  tags: string[];
  scope: string;
  disabled: boolean;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectInfo {
  root: string;
  name: string;
  stack: string[];
  rules: string;
}

export interface ProjectChangedFile {
  path: string;
  previousPath?: string;
  indexStatus: string;
  workTreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface ProjectGitStatus {
  isRepository: boolean;
  branch: string;
  clean: boolean;
  changedCount: number;
  files: ProjectChangedFile[];
}

export interface ProjectDiff {
  path: string;
  staged: string;
  unstaged: string;
  truncated: boolean;
}

export type ExecutionMode = "normal" | "plan";
export type PlanStepStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped" | "waiting_approval";

export interface SessionPlan {
  id: string;
  turnId: string;
  status: "planning" | "executing" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  currentStepId?: string;
  steps: Array<{ id: string; title: string; status: PlanStepStatus; summary?: string }>;
}
