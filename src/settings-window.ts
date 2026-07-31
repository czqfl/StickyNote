// 独立“设置”窗口入口：只渲染设置面板本身，绝不挂载便签应用。
// 任何异常都显示在窗口顶部的红色横幅里，绝不静默白屏；窗口右上角 ✕（含静态骨架里的）
// 直接调用后端 close_window 真正关闭窗口。

import "./styles.css";
import { openSettingsModal } from "./settings";

function showError(msg: string): void {
  let el = document.getElementById("settings-fatal");
  if (!el) {
    el = document.createElement("div");
    el.id = "settings-fatal";
    el.style.cssText =
      "position:fixed;left:0;right:0;top:0;z-index:2147483647;background:#c0392b;color:#fff;" +
      "font:12px/1.5 sans-serif;padding:8px 12px;white-space:pre-wrap;box-shadow:0 2px 8px rgba(0,0,0,.3)";
    document.body.appendChild(el);
  }
  el.textContent = msg;
}

window.addEventListener("error", (e) =>
  showError("运行时错误：" + (e.message || String(e.error))),
);
window.addEventListener("unhandledrejection", (e) =>
  showError("未处理的 Promise 拒绝：" + String((e as PromiseRejectionEvent).reason)),
);

// 保底关闭：静态骨架的 ✕（不经 @tauri-apps/api 包装，直接走底层 IPC）
const skeletonClose = document.getElementById("skeleton-close") as HTMLButtonElement | null;
skeletonClose?.addEventListener("click", () => {
  try {
    (window as unknown as { __TAURI_INTERNALS__?: { invoke: (cmd: string) => Promise<unknown> } })
      .__TAURI_INTERNALS__?.invoke("close_window")
      .catch(() => {});
  } catch {
    /* 忽略 */
  }
});

// 打开设置面板；面板浮层会覆盖住静态骨架（同为铺满窗口）。
// 面板关闭时（closeWindow）整个设置窗口一并销毁。
openSettingsModal().catch((e) => showError("设置面板加载失败：" + String(e)));
