import { describe, expect, it } from "vitest";
import { createLoadingPageUrl } from "../../desktop/loading-page.js";

describe("desktop loading page", () => {
  it("renders the logo and an accessible startup status on a light background", () => {
    const logoDataUrl = "data:image/png;base64,logo";
    const pageUrl = createLoadingPageUrl(logoDataUrl);
    const html = decodeURIComponent(pageUrl.slice(pageUrl.indexOf(",") + 1));

    expect(pageUrl.startsWith("data:text/html;charset=UTF-8,")).toBe(true);
    expect(html).toContain(`src="${logoDataUrl}"`);
    expect(html).toContain("正在启动服务…");
    expect(html).toContain('role="status"');
    expect(html).toContain("background: #f7f7f5");
    expect(html).toContain("@keyframes spin");
  });
});
