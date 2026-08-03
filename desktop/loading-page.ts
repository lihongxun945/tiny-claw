export function createLoadingPageUrl(logoDataUrl: string): string {
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>tiny-claw</title>
    <style>
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; }
      body {
        display: grid;
        place-items: center;
        overflow: hidden;
        background: #f7f7f5;
        color: #191919;
        font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      main {
        display: flex;
        flex-direction: column;
        align-items: center;
        transform: translateY(-3vh);
      }
      img {
        width: 104px;
        height: 104px;
        border-radius: 23px;
        box-shadow: 0 16px 42px rgba(65, 64, 120, 0.13);
      }
      h1 {
        margin: 22px 0 0;
        font-size: 22px;
        font-weight: 720;
        letter-spacing: -0.035em;
      }
      .status {
        display: flex;
        align-items: center;
        gap: 9px;
        margin-top: 16px;
        color: #7b7b77;
        font-size: 13px;
      }
      .spinner {
        width: 15px;
        height: 15px;
        border: 2px solid #d9d8ee;
        border-top-color: #635bff;
        border-radius: 50%;
        animation: spin 780ms linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) {
        .spinner { animation-duration: 1500ms; }
      }
    </style>
  </head>
  <body>
    <main>
      <img src="${logoDataUrl}" alt="tiny-claw Logo" />
      <h1>tiny-claw</h1>
      <div class="status" role="status" aria-live="polite">
        <span class="spinner" aria-hidden="true"></span>
        <span>正在启动服务…</span>
      </div>
    </main>
  </body>
</html>`;

  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`;
}
