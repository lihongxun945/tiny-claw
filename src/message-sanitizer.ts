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

export function sanitizeToolMessageChains(messages: Message[], incomplete?: (message: Message) => "preserve" | "describe" | "drop"): Message[] {
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

    const policy = incomplete?.(message) ?? "drop";
    if (policy === "preserve") {
      sanitized.push(message, ...toolResultMessages);
      index = nextIndex - 1;
      continue;
    }
    if (policy === "describe") {
      sanitized.push({ ...message, content: message.content.map(block => block.type === "tool_use" && !seenIds.has(block.id)
        ? { type: "text" as const, text: `[历史工具调用未记录到结果；不能推断已执行、成功或失败] ${JSON.stringify(block)}` }
        : block) }, ...toolResultMessages);
      index = nextIndex - 1;
      continue;
    }
    const readable = stripToolUses(message);
    if (readable) sanitized.push(readable);
  }

  return sanitized;
}

export function validateToolMessageChains(messages: Message[]): string | undefined {
  let pendingIds: Set<string> | undefined;

  for (const message of messages) {
    const toolUses = message.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter((block): block is ToolUseBlock => block.type === "tool_use")
      : [];
    const results = toolResultBlocks(message);

    if (pendingIds) {
      if (!isToolResultOnly(message)) return "工具调用后缺少对应的工具结果消息";
      for (const result of results) {
        if (!pendingIds.delete(result.tool_use_id)) return `工具结果无法匹配工具调用: ${result.tool_use_id}`;
      }
      if (pendingIds.size === 0) pendingIds = undefined;
      continue;
    }

    if (results.length > 0) return `工具结果前不存在对应的工具调用: ${results[0].tool_use_id}`;
    if (toolUses.length > 0) {
      pendingIds = new Set(toolUses.map((block) => block.id));
      if (pendingIds.size !== toolUses.length) return "工具调用 ID 重复";
    }
  }

  return pendingIds ? "工具调用后缺少对应的工具结果消息" : undefined;
}

/** Keep a tool exchange together even when an older checkpoint falls inside it. */
export function selectUncoveredMessages(messages: Message[], throughSequence: number, preserveUserRequest = false): Message[] {
  const selected: Message[] = [];
  for (let index = 0; index < messages.length;) {
    const first = messages[index];
    const group = [first];
    index++;
    const pending = new Set(first.role === "assistant" && Array.isArray(first.content)
      ? first.content.filter((block): block is ToolUseBlock => block.type === "tool_use").map(block => block.id) : []);
    while (pending.size && index < messages.length && isToolResultOnly(messages[index])) {
      const next = messages[index++];
      group.push(next);
      for (const result of toolResultBlocks(next)) pending.delete(result.tool_use_id);
    }
    const originalRequest = preserveUserRequest && first === messages[0] && first.role === "user"
      && toolResultBlocks(first).length === 0;
    if (originalRequest || group.some(message => (message._sequence ?? Infinity) > throughSequence)) selected.push(...group);
  }
  return selected;
}

/** Metadata only: never include message text, tool arguments or tool output. */
export function toolChainMetadata(messages: Message[]) {
  return messages.map((message, index) => ({
    index, role: message.role, sequence: message._sequence, messageId: message._messageId,
    blocks: Array.isArray(message.content) ? message.content.map(block => ({ type: block.type,
      ...(block.type === "tool_use" ? { id: block.id } : block.type === "tool_result" ? { id: block.tool_use_id } : {}),
    })) : [{ type: "text" }],
  }));
}
