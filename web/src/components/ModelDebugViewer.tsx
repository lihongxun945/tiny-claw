import { useEffect, useMemo, useState } from "react";
import { fetchModelCall, fetchModelCalls } from "../lib/api.js";
import type { ModelCallSummary, ModelCallTrace } from "../types.js";

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
        setEventIndex(0);
      })
      .catch(() => setTrace(null));
  }, [selectedId]);

  const displayEvents = useMemo(() => {
    if (!trace) return [];
    const request = trace.events.find((event) => event.phase === "request");
    const finalResponse = [...trace.events].reverse().find((event) => event.phase === "parsed_response")
      ?? [...trace.events].reverse().find((event) => event.phase === "response")
      ?? [...trace.events].reverse().find((event) => event.phase === "error");
    return [
      ...(request ? [{ label: "请求原文", event: request }] : []),
      ...(finalResponse ? [{ label: "最终回复", event: finalResponse }] : []),
    ];
  }, [trace]);

  const selectedEvent = displayEvents[eventIndex]?.event;

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
                {displayEvents.map((item, index) => (
                  <button
                    key={`${item.event.timestamp}-${index}`}
                    className={eventIndex === index ? "active" : ""}
                    onClick={() => setEventIndex(index)}
                  >
                    {item.label}
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
