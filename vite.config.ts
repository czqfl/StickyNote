import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig(async () => ({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    rollupOptions: {
      input: {
        index: resolve(process.cwd(), "index.html"),
        settings: resolve(process.cwd(), "settings.html"),
      },
    },
  },
}));
