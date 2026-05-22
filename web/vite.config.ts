import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const gatewayPort = parseInt(process.env.TINY_CLAW_PORT ?? "3000", 10);

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/chat": `http://localhost:${gatewayPort}`,
      "/sessions": `http://localhost:${gatewayPort}`,
      "/logs": `http://localhost:${gatewayPort}`,
      "/config": `http://localhost:${gatewayPort}`,
      "/history": `http://localhost:${gatewayPort}`,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
