import { defineConfig } from "vite";

export default defineConfig({
  build: {
    assetsDir: "app-assets",
    sourcemap: false,
    emptyOutDir: true,
  },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
