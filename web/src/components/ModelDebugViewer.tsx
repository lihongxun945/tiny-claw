import { useEffect, useMemo, useRef, useState } from "react";
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
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailRevision, setDetailRevision] = useState(0);
  const listController = useRef<AbortController | null>(null);
  const appliedFilter = useRef("");

  const loadCalls = async (nextPage = 1, size = pageSize, filter = sessionFilter.trim()) => {
    listController.current?.abort();
    const controller = new AbortController();
    listController.current = controller;
    setLoading(true);
    setError("");
    try {
      const next = await fetchModelCalls(filter || undefined, nextPage, size, controller.signal);
      if (controller.signal.aborted) return;
      appliedFilter.current = filter;
      setPage(next.page);
      setPageSize(next.pageSize);
      setTotal(next.total);
      setCalls(next.traces);
      setSelectedId((current) => next.traces.some((call) => call.requestId === current)
        ? current
        : next.traces[0]?.requestId ?? "");
      setDetailRevision(value => value + 1);
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "加载失败");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    void loadCalls();
    return () => listController.current?.abort();
  }, []);

  useEffect(() => {
    setTrace(null);
    setDetailError("");
    if (!selectedId) {
      setDetailLoading(false);
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    fetchModelCall(selectedId, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setTrace(next);
        setEventIndex(0);
      })
      .catch(error => { if (!controller.signal.aborted) setDetailError(error instanceof Error ? error.message : "详情加载失败"); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [selectedId, detailRevision]);

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
        <button onClick={() => void loadCalls()} disabled={loading}>{loading ? "加载中…" : "刷新"}</button>
        <select aria-label="每页调用条数" value={pageSize} disabled={loading}
          onChange={event => void loadCalls(1, Number(event.target.value), appliedFilter.current)}>
          {[20, 50, 100].map(size => <option key={size} value={size}>{size} 条/页</option>)}
        </select>
        <button disabled={loading || page <= 1} onClick={() => void loadCalls(page - 1, pageSize, appliedFilter.current)}>上一页</button>
        <span>第 {page} / {Math.max(1, Math.ceil(total / pageSize))} 页 · 共 {total} 条</span>
        <button disabled={loading || page * pageSize >= total} onClick={() => void loadCalls(page + 1, pageSize, appliedFilter.current)}>下一页</button>
      </div>
      {error && <div role="alert">{error}</div>}

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
          {detailError && <div role="alert">{detailError}</div>}
          {!trace && <div className="empty-state">{detailLoading ? "正在加载调用详情…" : "选择一条模型调用查看请求原文"}</div>}
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
