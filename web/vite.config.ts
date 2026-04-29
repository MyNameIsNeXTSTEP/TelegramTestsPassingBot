import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from "node:path"
import tailwindcss from "@tailwindcss/vite"

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const proxyTarget =
    env.VITE_API_PROXY_TARGET ||
    env.BOT_API_BASE_URL ||
    "http://127.0.0.1:3001";

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      port: 3000,
      proxy: {
        "/api": {
          target: proxyTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
      },
      allowedHosts: ["localhost", "127.0.0.1", 'dev.mycustomdomain.org'],
    },
  };
})
