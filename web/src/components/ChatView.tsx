import { useEffect, useRef } from "react";
import type { Message, ToolCallInfo } from "../types.js";
import MessageBubble from "./MessageBubble.js";

interface Props {
  messages: Message[];
  streamingText: string;
  streamingToolCalls: ToolCallInfo[];
  isStreaming: boolean;
}

export default function ChatView({ messages, streamingText, streamingToolCalls, isStreaming }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText, streamingToolCalls]);

  return (
    <div className="chat-view">
      {messages.length === 0 && !isStreaming && (
        <div className="empty-state">发送一条消息开始对话</div>
      )}
      {messages.map((msg, i) => (
        <MessageBubble key={i} message={msg} />
      ))}
      {isStreaming && (streamingText || streamingToolCalls.length > 0) && (
        <MessageBubble
          message={{
            role: "assistant",
            text: streamingText,
            toolCalls: streamingToolCalls,
            timestamp: Date.now(),
          }}
          isStreaming
        />
      )}
      <div ref={bottomRef} />
    </div>
  );
}
