import Markdown from "react-markdown";
import type { ToolCallInfo } from "../types.js";

interface Props {
  toolCall: ToolCallInfo;
}

function summarizeInput(name: string, input: Record<string, unknown>): string {
  if (name === "web_search" && input.query) return String(input.query);
  if (name === "web_fetch" && input.url) return String(input.url);
  if (name === "bash" && input.command) return String(input.command);
  if (name === "file_read" && input.path) return String(input.path);
  if (name === "file_write" && input.path) return String(input.path);
  if (name === "file_edit" && input.path) return String(input.path);
  if (name === "memory_save" && input.name) return String(input.name);
  if (name === "skill_use" && input.name) return String(input.name);
  const vals = Object.values(input);
  if (vals.length === 1) return String(vals[0]).slice(0, 80);
  return JSON.stringify(input).slice(0, 80);
}

function summarizeResult(result: string | undefined): string {
  if (!result) return "";
  try {
    const obj = JSON.parse(result);
    if (obj.error) return `❌ ${obj.error}`;
    if (obj.stdout !== undefined) return obj.stdout.slice(0, 80);
    if (obj.results) return `${Array.isArray(obj.results) ? obj.results.length : 0} 条结果`;
    if (obj.content) return obj.content.slice(0, 80);
  } catch { /* not JSON */ }
  return result.slice(0, 80);
}

export default function ToolCallBlock({ toolCall }: Props) {
  const inputStr = JSON.stringify(toolCall.input, null, 2);
  const inputSummary = summarizeInput(toolCall.name, toolCall.input);
  const resultSummary = summarizeResult(toolCall.result);

  return (
    <details className="tool-block">
      <summary>
        <span className="tool-name">{toolCall.name}</span>
        {inputSummary && <span className="tool-input-summary">{inputSummary}</span>}
        {resultSummary && <span className="tool-result-summary">{resultSummary}</span>}
      </summary>
      <div className="tool-body">
        <div><strong>Input:</strong></div>
        <div>{inputStr}</div>
        {toolCall.result !== undefined && (
          <>
            <div style={{ marginTop: 8 }}><strong>Result:</strong></div>
            <Markdown>{toolCall.result}</Markdown>
          </>
        )}
      </div>
    </details>
  );
}
