import { describe, expect, it } from "vitest";
import { resolveNotification } from "../../src/plugins/core/notifications.js";

describe("resolveNotification", () => {
  it("notifies default reasons when settings are absent", () => {
    expect(resolveNotification("completed")).toEqual({ title: "本轮完成", body: "皮皮虾已完成本轮任务，可回来查看结果" });
    expect(resolveNotification("approval_required")).toEqual({ title: "需要你的审批", body: "皮皮虾已暂停，等待你批准后继续执行" });
    expect(resolveNotification("waiting_user")).toEqual({ title: "等待你的输入", body: "皮皮虾已暂停，等待你的回答" });
    expect(resolveNotification("iteration_limit")).toEqual({ title: "已达迭代上限", body: "皮皮虾本轮已自动停止，可继续追问" });
  });

  it("does not notify interrupted by default", () => {
    expect(resolveNotification("interrupted")).toBeUndefined();
  });

  it("honours the enabled switch and reason whitelist", () => {
    expect(resolveNotification("completed", { enabled: false })).toBeUndefined();
    expect(resolveNotification("completed", { reasons: ["approval_required"] })).toBeUndefined();
    expect(resolveNotification("approval_required", { reasons: ["approval_required"] })).toMatchObject({ title: "需要你的审批" });
  });
});
