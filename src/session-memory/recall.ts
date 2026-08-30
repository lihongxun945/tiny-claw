import type { Message } from "../types.js";
import { readSessionMessages } from "../session-store.js";

export interface SessionHistoryRecallQuery {
  messageIds?: string[];
  fromSequence?: number;
  toSequence?: number;
  query?: string;
  limit: number;
  maxOutputChars: number;
}

export interface RecalledSessionMessage {
  messageId: string;
  sequence: number;
  turnId?: string;
  role: Message["role"];
  timestamp?: number;
  content: Message["content"];
}

export interface SessionHistoryRecallResult {
  messages: RecalledSessionMessage[];
  matched: number;
  truncated: boolean;
}

export function recallSessionHistory(
  workspacePath: string,
  sessionId: string,
  input: SessionHistoryRecallQuery,
): SessionHistoryRecallResult {
  const ids = new Set((input.messageIds ?? []).map((id) => id.trim()).filter(Boolean));
  const keyword = input.query?.trim().toLocaleLowerCase();
  const hasSelector = ids.size > 0
    || input.fromSequence !== undefined
    || input.toSequence !== undefined
    || !!keyword;
  if (!hasSelector) throw new Error("至少提供 message_ids、序号范围或 query 之一");

  const matches = readSessionMessages(workspacePath, sessionId).filter((message) => {
    if (ids.size > 0 && (!message._messageId || !ids.has(message._messageId))) return false;
    if (input.fromSequence !== undefined && (message._sequence ?? 0) < input.fromSequence) return false;
    if (input.toSequence !== undefined && (message._sequence ?? 0) > input.toSequence) return false;
    if (keyword && !renderSearchText(message).toLocaleLowerCase().includes(keyword)) return false;
    return true;
  });

  const selected: RecalledSessionMessage[] = [];
  let usedChars = 0;
  let truncated = matches.length > input.limit;
  for (const message of matches.slice(0, input.limit)) {
    const recalled: RecalledSessionMessage = {
      messageId: message._messageId!,
      sequence: message._sequence!,
      turnId: message._turnId,
      role: message.role,
      timestamp: message._timestamp,
      content: message.content,
    };
    const chars = JSON.stringify(recalled).length;
    if (selected.length > 0 && usedChars + chars > input.maxOutputChars) {
      truncated = true;
      break;
    }
    if (chars > input.maxOutputChars) {
      recalled.content = truncateContent(recalled.content, input.maxOutputChars);
      truncated = true;
    }
    selected.push(recalled);
    usedChars += Math.min(chars, input.maxOutputChars);
  }
  return { messages: selected, matched: matches.length, truncated };
}

function renderSearchText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "tool_use") return `${block.name} ${JSON.stringify(block.input)}`;
    if (block.type === "tool_result") return block.content;
    return block.name;
  }).join("\n");
}

function truncateContent(content: Message["content"], maxChars: number): Message["content"] {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  const suffix = "...[原文过长，已截断]";
  return maxChars <= suffix.length ? text.slice(0, maxChars) : `${text.slice(0, maxChars - suffix.length)}${suffix}`;
}
