import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message, ToolCallInfo } from "../types.js";
import ImageLightbox from "./ImageLightbox.js";
import ToolCallBlock from "./ToolCallBlock.js";
import ToolCallGroup from "./ToolCallGroup.js";
import SyntaxHighlightedPre from "./SyntaxHighlightedPre.js";

interface Props {
  message: Message;
  isStreaming?: boolean;
  toolGroupExpanded?: boolean;
  onToolGroupExpandedChange?: (expanded: boolean) => void;
  onApproveAndResume?: (approvalId: string) => Promise<void>;
  onApproveTurnAndResume?: (approvalId: string) => Promise<void>;
  onRejectAndResume?: (approvalId: string) => Promise<void>;
}

function formatTime(ts: number): string {
  if (ts <= 0) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function QuestionRecord({ call }: { call: ToolCallInfo }) {
  let answer: { status?: string; error?: string; text?: string; selectedOptions?: Array<{ label: string }> } = {};
  try { answer = JSON.parse(call.result ?? "{}"); } catch { /* A pending question has no persisted result yet. */ }
  return <div className="question-record">
    <p><strong>问题：</strong>{String(call.input.question ?? "")}</p>
    {typeof call.input.context === "string" && <p>{call.input.context}</p>}
    {answer.status === "answered" ? <p><strong>你的回答：</strong>{[...(answer.selectedOptions ?? []).map((option) => option.label), answer.text].filter(Boolean).join("；")}</p>
      : <p className="user-question-status">{answer.status === "cancelled" ? "已终止" : answer.error ? answer.error : "等待回答"}</p>}
  </div>;
}

export default function MessageBubble({ message, isStreaming, toolGroupExpanded, onToolGroupExpandedChange, onApproveAndResume, onApproveTurnAndResume, onRejectAndResume }: Props) {
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
              {message.toolCalls.filter((call) => call.name === "ask_user").map((call, index) => <QuestionRecord key={call.id ?? index} call={call} />)}
              {message.toolCalls.length > 1 ? (
                <ToolCallGroup
                  toolCalls={message.toolCalls}
                  expanded={toolGroupExpanded}
                  onExpandedChange={onToolGroupExpandedChange}
                  onApproveAndResume={onApproveAndResume}
                  onApproveTurnAndResume={onApproveTurnAndResume}
                  onRejectAndResume={onRejectAndResume}
                />
              ) : message.toolCalls.map((toolCall, index) => (
                <ToolCallBlock
                  key={toolCall.id ?? index}
                  toolCall={toolCall}
                  onApproveAndResume={onApproveAndResume}
                  onApproveTurnAndResume={onApproveTurnAndResume}
                  onRejectAndResume={onRejectAndResume}
                />
              ))}
              {message.text && (
                <div className={`markdown-content ${isStreaming ? "streaming-cursor" : ""}`}>
                  <Markdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      pre: SyntaxHighlightedPre,
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
