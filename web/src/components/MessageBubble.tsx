import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message } from "../types.js";
import ToolCallBlock from "./ToolCallBlock.js";

interface Props {
  message: Message;
  isStreaming?: boolean;
  onApproveAndResume?: (approvalId: string) => Promise<void>;
}

function formatTime(ts: number): string {
  if (ts <= 0) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export default function MessageBubble({ message, isStreaming, onApproveAndResume }: Props) {
  const isUser = message.role === "user";

  return (
    <div className={`message ${message.role}`}>
      <div className="message-content">
        {message.attachments && message.attachments.length > 0 && (
          <div className="message-attachments">
            {message.attachments.map((attachment) => (
              <a
                key={attachment.id}
                href={attachment.url}
                target="_blank"
                rel="noreferrer"
                title={attachment.name}
              >
                <img src={attachment.url} alt={attachment.name} />
              </a>
            ))}
          </div>
        )}
        {isUser ? (
          <span>{message.text}</span>
        ) : (
          <>
            {message.toolCalls.map((tc, i) => (
              <ToolCallBlock key={i} toolCall={tc} onApproveAndResume={onApproveAndResume} />
            ))}
            {message.text && (
              <div className={`markdown-content ${isStreaming ? "streaming-cursor" : ""}`}>
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    table: ({ children }) => (
                      <div className="markdown-table-wrap">
                        <table>{children}</table>
                      </div>
                    ),
                  }}
                >
                  {message.text}
                </Markdown>
              </div>
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
