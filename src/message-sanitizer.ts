import type { Message, ToolResultBlock, ToolUseBlock } from "./types.js";

function isToolResultOnly(message: Message): boolean {
  return message.role === "user"
    && Array.isArray(message.content)
    && message.content.length > 0
    && message.content.every((block) => block.type === "tool_result");
}

function toolResultBlocks(message: Message): ToolResultBlock[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.filter((block): block is ToolResultBlock => block.type === "tool_result");
}

function stripToolResults(message: Message): Message | undefined {
  if (!Array.isArray(message.content)) return message;
  const readableContent = message.content.filter((block) => block.type !== "tool_result");
  if (readableContent.length === 0) return undefined;
  return { ...message, content: readableContent };
}

function stripToolUses(message: Message): Message | undefined {
  if (!Array.isArray(message.content)) return message;
  const readableContent = message.content.filter((block) => block.type !== "tool_use");
  if (readableContent.length === 0) return undefined;
  return { ...message, content: readableContent };
}

export function sanitizeToolMessageChains(messages: Message[]): Message[] {
  const sanitized: Message[] = [];

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!Array.isArray(message.content)) {
      sanitized.push(message);
      continue;
    }

    if (message.role === "user" && message.content.some((block) => block.type === "tool_result")) {
      const readable = stripToolResults(message);
      if (readable) sanitized.push(readable);
      continue;
    }

    const toolUses = message.role === "assistant"
      ? message.content.filter((block): block is ToolUseBlock => block.type === "tool_use")
      : [];
    if (toolUses.length === 0) {
      sanitized.push(message);
      continue;
    }

    const expectedIds = new Set(toolUses.map((block) => block.id));
    const toolResultMessages: Message[] = [];
    const seenIds = new Set<string>();
    let nextIndex = index + 1;

    while (nextIndex < messages.length && isToolResultOnly(messages[nextIndex])) {
      const results = toolResultBlocks(messages[nextIndex]);
      if (!results.every((block) => expectedIds.has(block.tool_use_id) && !seenIds.has(block.tool_use_id))) break;
      toolResultMessages.push(messages[nextIndex]);
      for (const block of results) seenIds.add(block.tool_use_id);
      nextIndex++;
      if (seenIds.size === expectedIds.size) break;
    }

    if (seenIds.size === expectedIds.size) {
      sanitized.push(message, ...toolResultMessages);
      index = nextIndex - 1;
      continue;
    }

    const readable = stripToolUses(message);
    if (readable) sanitized.push(readable);
  }

  return sanitized;
}

export function stripToolMessagesForNewTurn(messages: Message[]): Message[] {
  const stripped: Message[] = [];

  for (const message of messages) {
    if (typeof message.content === "string") {
      stripped.push(message);
      continue;
    }

    const readableContent = message.content.filter((block) => block.type !== "tool_use" && block.type !== "tool_result");
    if (readableContent.length === 0) continue;
    stripped.push({ ...message, content: readableContent });
  }

  return stripped;
}
