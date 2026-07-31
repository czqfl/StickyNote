// 实时动态毛玻璃（透明主题）：截取“便签背后的真实屏幕内容”作为毛玻璃底图，
// 每帧更新 + 窗口移动/缩放时即时补拍，让模糊内容随背后的画面实时变化
// （手机系统毛玻璃同款效果），而不是把壁纸扫下来当固定背景。
//
// 管线：GDI BitBlt 截屏 → JPEG 编码（后端，二进制 IPC 直传）→ createImageBitmap
// 解码 → canvas 重编码 data URL → 作为 --note-bg-img 背景图 → CSS filter:blur。
// 便签窗口自身通过 WDA_EXCLUDEFROMCAPTURE 从截屏中排除，不会把自己拍进背景产生重影。
//
// 性能：截屏区域 = 便签窗口大小（小区域），降采样 0.5 + 低质量 JPEG；约 4~5fps
// 更新 + 移动/缩放即时补拍，开销远低于连续全屏截屏，肉眼观感已是“实时”。

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyGlassBlur } from "./glass";

let running = false;
let timer: number | undefined;
let el: HTMLElement | null = null;
/** Markdown 预览 iframe 的 body（有则同步更新它的背景，预览区同样实时） */
let mdTarget: HTMLElement | null = null;
let lastStrength = 0;
let moveListenersAttached = false;
let capturePending = false;
let capturing = false;

/** 开启/更新实时毛玻璃：target 为带 ::before 背景图的面板；strength 0~100（CSS 模糊半径） */
export function startRealtimeBlur(
  target: HTMLElement,
  strength: number,
  mdBody: HTMLElement | null = null,
): void {
  el = target;
  mdTarget = mdBody;
  lastStrength = Math.max(0, Math.min(100, Math.round(strength)));
  if (!running) {
    running = true;
    invoke("set_exclude_from_capture", { enable: true }).catch(() => {});
    attachMoveListeners();
    void captureNow();
    // 定时刷新：跟随背后内容（其它窗口移动/播放画面/桌面变化）实时更新
    timer = window.setInterval(() => void captureNow(), 450);
  } else {
    // 仅强度变化：补一帧即可
    void captureNow();
  }
  applyGlassBlur({ target, strength: lastStrength, enabled: true });
}

/** 关闭实时毛玻璃：停止截屏并恢复自身可被截屏（如开启录屏/截图时便签可见） */
export function stopRealtimeBlur(): void {
  running = false;
  el = null;
  mdTarget = null;
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
  invoke("set_exclude_from_capture", { enable: false }).catch(() => {});
}

/** 窗口移动/缩放时即时补拍（防抖合并），避免拖拽时背景与窗口错位 */
function attachMoveListeners(): void {
  if (moveListenersAttached) return;
  moveListenersAttached = true;
  try {
    getCurrentWindow().onMoved(() => scheduleCapture());
    getCurrentWindow().onResized(() => scheduleCapture());
  } catch {
    /* 忽略 */
  }
}

function scheduleCapture(): void {
  if (!running || capturePending) return;
  capturePending = true;
  window.setTimeout(() => {
    capturePending = false;
    if (running) void captureNow();
  }, 100);
}

/** 截取窗口背后的屏幕区域，写入背景图并套用模糊 */
async function captureNow(): Promise<void> {
  if (!running || !el || capturing) return;
  capturing = true;
  try {
    const win = getCurrentWindow();
    const pos = await win.outerPosition();
    const size = await win.outerSize();
    // 捕获窗口外矩形区域：坐标/尺寸为物理像素，降采样 0.5（模糊后无观感损失）；
    // 自身已被截屏排除，拍到的是窗口背后的内容
    const inset = 4;
    const w = Math.max(8, size.width - inset * 2);
    const h = Math.max(8, size.height - inset * 2);
    const bytes = await invoke<Uint8Array>("capture_screen_region", {
      x: pos.x + inset,
      y: pos.y + inset,
      w,
      h,
      scale: 0.5,
    });
    const bmp = await createImageBitmap(new Blob([bytes as unknown as BlobPart], { type: "image/jpeg" }));
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(bmp, 0, 0);
      const url = canvas.toDataURL("image/jpeg", 0.6);
      el.style.setProperty("--note-bg-img", `url("${url}")`);
      el.style.setProperty("--note-bg-opacity", "1");
      el.classList.add("has-bg");
      if (mdTarget) {
        mdTarget.style.setProperty("--md-bg-img", `url("${url}")`);
      }
    } finally {
      bmp.close();
    }
  } catch (e) {
    // 首帧可能在窗口尚未就绪时失败，定时器会重试
    console.debug("实时截屏失败:", e);
  } finally {
    capturing = false;
  }
}

/** 导出当前状态（供调试） */
export function isRealtimeBlurRunning(): boolean {
  return running;
}
