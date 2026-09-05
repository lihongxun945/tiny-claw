import { useState } from "react";
import type { ContextSnapshot } from "../types.js";

interface Props {
  snapshot: ContextSnapshot;
  onClose: () => void;
}

type Tab = "usage" | "prompt" | "messages" | "tools";

function number(value: number): string {
  return value.toLocaleString();
}

export default function ContextViewer({ snapshot, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("usage");
  const usage = snapshot.usage;
  return (
    <div className="context-viewer-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="context-viewer" role="dialog" aria-modal="true" aria-label="当前模型上下文" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <strong>当前模型上下文</strong>
            <span>第 {snapshot.iteration} 次模型调用{snapshot.attempt > 1 ? ` · 第 ${snapshot.attempt} 次尝试` : ""}</span>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭">×</button>
        </header>
        <nav aria-label="上下文分类">
          {([['usage', '统计'], ['prompt', 'System Prompt'], ['messages', 'Messages'], ['tools', 'Tools']] as Array<[Tab, string]>).map(([value, label]) => (
            <button key={value} type="button" className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{label}</button>
          ))}
        </nav>
        <div className="context-viewer-content">
          {tab === "usage" && (
            <div className="context-usage-details">
              <div><span>输入上下文</span><strong>{number(usage.input)} tokens</strong></div>
              <div><span>System Prompt</span><strong>{number(usage.systemPrompt)}</strong></div>
              <div><span>Messages</span><strong>{number(usage.messages)}</strong></div>
              <div><span>Tools</span><strong>{number(usage.tools)}</strong></div>
              <div><span>输出预留</span><strong>{number(usage.outputReserved)}</strong></div>
              <div><span>上下文上限</span><strong>{number(usage.maxContext)}</strong></div>
              <div><span>上下文占用</span><strong>{usage.percent}%</strong></div>
            </div>
          )}
          {tab === "prompt" && <pre>{snapshot.systemPrompt}</pre>}
          {tab === "messages" && <pre>{JSON.stringify(snapshot.messages, null, 2)}</pre>}
          {tab === "tools" && <pre>{JSON.stringify(snapshot.tools, null, 2)}</pre>}
        </div>
      </section>
    </div>
  );
}
