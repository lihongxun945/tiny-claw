import { useEffect, useMemo, useState } from "react";
import { fetchModelCall, fetchModelCalls } from "../lib/api.js";
import type { ModelCallSummary, ModelCallTrace } from "../types.js";

const PHASE_LABELS: Record<string, string> = {
  request: "请求原文",
  response: "响应原文",
  parsed_response: "解析结果",
  error: "错误响应",
  repair: "修复过程",
  stream_event: "流事件",
};

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

export default function ModelDebugViewer() {
  const [calls, setCalls] = useState<ModelCallSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [trace, setTrace] = useState<ModelCallTrace | null>(null);
  const [eventIndex, setEventIndex] = useState(0);
  const [sessionFilter, setSessionFilter] = useState("");
  const [loading, setLoading] = useState(false);

  const loadCalls = async () => {
    setLoading(true);
    try {
      const next = await fetchModelCalls(sessionFilter.trim() || undefined);
      setCalls(next);
      setSelectedId((current) => next.some((call) => call.requestId === current)
        ? current
        : next[0]?.requestId ?? "");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCalls().catch(() => setCalls([]));
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setTrace(null);
      return;
    }
    fetchModelCall(selectedId)
      .then((next) => {
        setTrace(next);
        setEventIndex(Math.max(0, next.events.findIndex((event) => event.phase === "request")));
      })
      .catch(() => setTrace(null));
  }, [selectedId]);

  const eventLabels = useMemo(() => {
    const counts = new Map<string, number>();
    return trace?.events.map((event) => {
      const count = (counts.get(event.phase) ?? 0) + 1;
      counts.set(event.phase, count);
      return `${PHASE_LABELS[event.phase] ?? event.phase}${count > 1 ? ` ${count}` : ""}`;
    }) ?? [];
  }, [trace]);

  const selectedEvent = trace?.events[eventIndex];

  return (
    <div className="model-debug-viewer">
      <div className="model-debug-toolbar">
        <input
          value={sessionFilter}
          onChange={(event) => setSessionFilter(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") loadCalls(); }}
          placeholder="按完整 Session ID 筛选"
          aria-label="Session 筛选"
        />
        <button onClick={loadCalls} disabled={loading}>{loading ? "加载中…" : "刷新"}</button>
      </div>

      <div className="model-debug-layout">
        <div className="model-call-list">
          {calls.length === 0 && !loading && (
            <div className="empty-state">
              暂无模型调用记录。请先在设置中开启 Debug 和“记录模型输入输出”。
            </div>
          )}
          {calls.map((call) => (
            <button
              key={call.requestId}
              className={`model-call-item ${selectedId === call.requestId ? "active" : ""}`}
              onClick={() => setSelectedId(call.requestId)}
            >
              <span className={`model-call-status ${call.status}`} />
              <span className="model-call-main">
                <strong>{call.model}</strong>
                <small>{call.provider} · {call.mode}</small>
                <small>{formatTime(call.startedAt)}</small>
              </span>
              {call.durationMs !== undefined && <span className="model-call-duration">{call.durationMs}ms</span>}
            </button>
          ))}
        </div>

        <div className="model-call-detail">
          {!trace && <div className="empty-state">选择一条模型调用查看请求原文</div>}
          {trace && (
            <>
              <div className="model-call-meta">
                <span>Session：{trace.sessionId ?? "-"}</span>
                <span>Request ID：{trace.requestId}</span>
              </div>
              <div className="model-event-tabs">
                {trace.events.map((event, index) => (
                  <button
                    key={`${event.timestamp}-${index}`}
                    className={eventIndex === index ? "active" : ""}
                    onClick={() => setEventIndex(index)}
                  >
                    {eventLabels[index]}
                  </button>
                ))}
              </div>
              <div className="model-event-header">
                <span>{selectedEvent ? formatTime(selectedEvent.timestamp) : ""}</span>
                <button
                  onClick={() => navigator.clipboard.writeText(JSON.stringify(selectedEvent?.data ?? null, null, 2))}
                >
                  复制 JSON
                </button>
              </div>
              <pre className="model-event-json">{JSON.stringify(selectedEvent?.data ?? null, null, 2)}</pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
