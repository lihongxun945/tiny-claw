import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const gatewayPort = parseInt(process.env.TINY_CLAW_PORT ?? "3000", 10);
const gatewayToken = process.env.TINY_CLAW_GATEWAY_TOKEN;
const proxy = {
  target: `http://localhost:${gatewayPort}`,
  headers: gatewayToken ? { authorization: `Bearer ${gatewayToken}` } : undefined,
};

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/chat": proxy,
      "/sessions": proxy,
      "/approvals": proxy,
      "/logs": proxy,
      "/config": proxy,
      "/memory": proxy,
      "/history": proxy,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
