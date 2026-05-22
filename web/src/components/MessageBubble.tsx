import Markdown from "react-markdown";
import type { Message } from "../types.js";
import ToolCallBlock from "./ToolCallBlock.js";

interface Props {
  message: Message;
  isStreaming?: boolean;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export default function MessageBubble({ message, isStreaming }: Props) {
  const isUser = message.role === "user";

  return (
    <div className={`message ${message.role}`}>
      <div className="message-content">
        {isUser ? (
          <span>{message.text}</span>
        ) : (
          <>
            {message.toolCalls.map((tc, i) => (
              <ToolCallBlock key={i} toolCall={tc} />
            ))}
            {message.text && (
              <span className={isStreaming ? "streaming-cursor" : ""}>
                <Markdown>{message.text}</Markdown>
              </span>
            )}
            {isStreaming && !message.text && message.toolCalls.length > 0 && (
              <span className="streaming-cursor" />
            )}
          </>
        )}
      </div>
      <div className="message-time">{formatTime(message.timestamp)}</div>
    </div>
  );
}
