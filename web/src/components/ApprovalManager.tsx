import { useEffect, useState } from "react";
import type { ApprovalRequest } from "../types.js";
import { approveCommand, fetchApprovals, rejectCommand } from "../lib/api.js";

function formatTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function ApprovalManager() {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const loadApprovals = async () => {
    setLoading(true);
    setMessage("");
    try {
      setApprovals(await fetchApprovals());
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "加载审批失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadApprovals();
  }, []);

  const handleApprove = async (id: string) => {
    setMessage("");
    try {
      const updated = await approveCommand(id);
      setApprovals((prev) => prev.map((item) => item.id === id ? updated : item));
      setMessage("已允许一次。请重新发起原任务。");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "审批失败");
    }
  };

  const handleReject = async (id: string) => {
    setMessage("");
    try {
      await rejectCommand(id);
      setApprovals((prev) => prev.filter((item) => item.id !== id));
      setMessage("已拒绝");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "拒绝失败");
    }
  };

  return (
    <div className="approval-manager">
      <div className="approval-toolbar">
        <div>
          <h2>命令审批</h2>
          <span>批准后，相同命令下次调用可执行一次。</span>
        </div>
        <button onClick={loadApprovals} disabled={loading}>{loading ? "刷新中..." : "刷新"}</button>
      </div>
      {message && <div className="approval-message">{message}</div>}
      <div className="approval-list">
        {!loading && approvals.length === 0 && <div className="empty-state">暂无待审批命令</div>}
        {approvals.map((approval) => (
          <div className="approval-item" key={approval.id}>
            <div className="approval-item-header">
              <span className="approval-source">{approval.source}</span>
              <span className={`approval-status ${approval.status}`}>{approval.status === "approved" ? "已允许一次" : "待审批"}</span>
            </div>
            <pre>{approval.command}</pre>
            <div className="approval-meta">
              <span>目录：{approval.cwd}</span>
              {approval.actor?.channel && <span>来源：{approval.actor.channel}{approval.actor.requesterId ? ` / ${approval.actor.requesterId}` : ""}</span>}
              <span>过期：{formatTime(approval.expiresAt)}</span>
            </div>
            <div className="approval-actions">
              <button onClick={() => handleApprove(approval.id)} disabled={approval.status === "approved"}>允许一次</button>
              <button onClick={() => handleReject(approval.id)}>拒绝</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
