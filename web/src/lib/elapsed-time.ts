import { useEffect, useState } from "react";

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m ${seconds % 60}s`;
}

export function useElapsedTime(startedAt?: number, completedAt?: number, running = false): number | undefined {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    refresh();
    if (!running || startedAt === undefined) return;
    const timer = window.setInterval(refresh, 1000);
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [startedAt, completedAt, running]);
  if (startedAt === undefined || (!running && completedAt === undefined)) return undefined;
  return Math.max(0, (completedAt ?? now) - startedAt);
}
