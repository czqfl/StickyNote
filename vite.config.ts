import { defineConfig } from "vite";

// 多页入口：index.html（便签/历史/图片预览共享入口） + settings.html（独立设置窗口入口）。
// 独立 settings.html 只加载 src/settings-window.ts（仅 settings.ts 依赖，不含 note/history），
// 从而根治“打开设置面板即白板”——之前复用 index.html 会把便签 bundle 拉进设置窗口导致整页白。
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
        main: "index.html",
        settings: "settings.html",
      },
    },
  },
}));
