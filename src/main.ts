import "./styles.css";
import { mountNoteApp } from "./note";
import { mountHistoryApp } from "./history";
import { getCurrentWindow } from "@tauri-apps/api/window";

// 全局错误兜底：任何未捕获异常都显示出来，避免静默空白/卡死难以排查。
function showFatal(msg: string) {
  let el = document.getElementById("fatal-banner");
  if (!el) {
    el = document.createElement("div");
    el.id = "fatal-banner";
    el.style.cssText =
      "position:fixed;left:0;right:0;top:0;z-index:2147483647;background:#c0392b;color:#fff;" +
      "font:12px/1.5 sans-serif;padding:8px 12px;white-space:pre-wrap;box-shadow:0 2px 8px rgba(0,0,0,.3);" +
      "pointer-events:none";
    document.body.appendChild(el);
  }
  el.textContent = msg;
}
window.addEventListener("error", (e) =>
  showFatal("运行时错误：" + (e.message || String(e.error))),
);
window.addEventListener("unhandledrejection", (e) =>
  showFatal("未处理的 Promise 拒绝：" + String((e as PromiseRejectionEvent).reason)),
);

// 用 Tauri 窗口 label 区分窗口类型（替代不可靠的 ?view= URL 参数）
const label = getCurrentWindow().label;
const params = new URLSearchParams(window.location.search);
const noteId = params.get("noteId") || "main";
const preset = params.get("preset") || "";

if (label === "history") {
  mountHistoryApp();
} else {
  mountNoteApp(noteId, preset);
}
