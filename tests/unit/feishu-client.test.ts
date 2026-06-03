import { afterEach, describe, expect, it, vi } from "vitest";
import { FeishuClient } from "../../src/plugins/feishu/client.js";

describe("FeishuClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns reply ids and marks cards as updateable", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (url.includes("/auth/v3/tenant_access_token/internal")) {
        return Response.json({ tenant_access_token: "tenant-token", expire: 7200 });
      }
      return Response.json({ data: { message_id: "om_reply" } });
    }));
    const client = new FeishuClient("app-id", "app-secret");

    expect(await client.replyMessage("om_source", "hello")).toEqual(["om_reply"]);
    await client.updateMessageCard("om_reply", "updated");

    const replyBody = JSON.parse(String(requests[1].init?.body)) as { content: string };
    expect(JSON.parse(replyBody.content)).toMatchObject({ config: { update_multi: true } });
    expect(requests[2].url).toContain("/im/v1/messages/om_reply");
    expect(requests[2].init?.method).toBe("PATCH");
    const updateBody = JSON.parse(String(requests[2].init?.body)) as { content: string };
    expect(JSON.parse(updateBody.content)).toMatchObject({ config: { update_multi: true } });
  });
});
