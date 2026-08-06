import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message } from "../types.js";
import ImageLightbox from "./ImageLightbox.js";
import ToolCallBlock from "./ToolCallBlock.js";
import ToolCallGroup from "./ToolCallGroup.js";

interface Props {
  message: Message;
  isStreaming?: boolean;
  onApproveAndResume?: (approvalId: string) => Promise<void>;
  onApproveTurnAndResume?: (approvalId: string) => Promise<void>;
}

function formatTime(ts: number): string {
  if (ts <= 0) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export default function MessageBubble({ message, isStreaming, onApproveAndResume, onApproveTurnAndResume }: Props) {
  const isUser = message.role === "user";
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const attachments = message.attachments ?? [];

  return (
    <>
      <div className={`message ${message.role}`}>
        <div className="message-content">
          {attachments.length > 0 && (
            <div className="message-attachments">
              {attachments.map((attachment, index) => (
                <button
                  type="button"
                  key={attachment.id}
                  title={`预览 ${attachment.name}`}
                  aria-label={`预览 ${attachment.name}`}
                  onClick={() => setPreviewIndex(index)}
                >
                  <img src={attachment.url} alt={attachment.name} />
                </button>
              ))}
            </div>
          )}
          {isUser ? (
            <span>{message.text}</span>
          ) : (
            <>
              {message.toolCalls.length > 1 ? (
                <ToolCallGroup
                  toolCalls={message.toolCalls}
                  onApproveAndResume={onApproveAndResume}
                  onApproveTurnAndResume={onApproveTurnAndResume}
                />
              ) : message.toolCalls.map((toolCall, index) => (
                <ToolCallBlock
                  key={toolCall.id ?? index}
                  toolCall={toolCall}
                  onApproveAndResume={onApproveAndResume}
                  onApproveTurnAndResume={onApproveTurnAndResume}
                />
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

      {previewIndex !== null && attachments[previewIndex] && (
        <ImageLightbox
          attachments={attachments}
          index={previewIndex}
          onIndexChange={setPreviewIndex}
          onClose={() => setPreviewIndex(null)}
        />
      )}
    </>
  );
}
