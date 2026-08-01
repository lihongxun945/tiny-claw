import { useEffect, useState, useRef } from "react";
import { fetchLogFiles, fetchLog } from "../lib/api.js";
import ModelDebugViewer from "./ModelDebugViewer.js";

export default function LogViewer() {
  const [view, setView] = useState<"runtime" | "model">("runtime");
  const [files, setFiles] = useState<Array<{ name: string; size: number }>>([]);
  const [selectedDate, setSelectedDate] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [tail, setTail] = useState(200);
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchLogFiles().then((data) => {
      setFiles(data.files);
      if (data.files.length > 0 && !selectedDate) {
        const date = data.files[0].name.replace(".log", "");
        setSelectedDate(date);
      }
    });
  }, []);

  useEffect(() => {
    if (!selectedDate) return;
    setLoading(true);
    fetchLog(selectedDate, tail)
      .then((data) => setLines(data.lines))
      .catch(() => setLines([]))
      .finally(() => setLoading(false));
  }, [selectedDate, tail]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, [lines]);

  const handleRefresh = () => {
    if (!selectedDate) return;
    setLoading(true);
    fetchLog(selectedDate, tail)
      .then((data) => setLines(data.lines))
      .catch(() => setLines([]))
      .finally(() => setLoading(false));
  };

  const getLevelClass = (line: string): string => {
    const upper = line.toUpperCase();
    if (upper.includes("[ERROR]")) return "log-error";
    if (upper.includes("[WARN]")) return "log-warn";
    if (upper.includes("[INFO]")) return "log-info";
    return "";
  };

  return (
    <div className="log-viewer">
      <div className="log-view-tabs">
        <button className={view === "runtime" ? "active" : ""} onClick={() => setView("runtime")}>运行日志</button>
        <button className={view === "model" ? "active" : ""} onClick={() => setView("model")}>模型调用</button>
      </div>
      {view === "model" ? <ModelDebugViewer /> : (
        <>
          <div className="log-toolbar">
            <select value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)}>
              {files.map((f) => (
                <option key={f.name} value={f.name.replace(".log", "")}>
                  {f.name} ({(f.size / 1024).toFixed(1)} KB)
                </option>
              ))}
            </select>
            <select value={tail} onChange={(e) => setTail(Number(e.target.value))}>
              <option value={100}>100 行</option>
              <option value={200}>200 行</option>
              <option value={500}>500 行</option>
              <option value={1000}>1000 行</option>
              <option value={2000}>2000 行</option>
            </select>
            <button onClick={handleRefresh} disabled={loading}>刷新</button>
          </div>
          <div className="log-content">
            {lines.length === 0 && !loading && <div className="empty-state">暂无日志</div>}
            {lines.map((line, i) => (
              <div key={i} className={`log-line ${getLevelClass(line)}`}>{line}</div>
            ))}
            <div ref={bottomRef} />
          </div>
        </>
      )}
    </div>
  );
}
