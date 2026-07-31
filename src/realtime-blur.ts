// 实时动态毛玻璃（透明主题）：截取“便签背后的真实屏幕内容”作为毛玻璃底图，
// 定时刷新 + 窗口移动/缩放时即时补拍，让模糊内容随背后的画面实时变化
// （手机系统毛玻璃同款效果），而不是把壁纸扫下来当固定背景。
//
// 性能优化（与上一版 canvas + toDataURL 的差异，正是“延迟大”的根因）：
//  - 不再每帧把截屏画进 canvas 再 toDataURL 重编码（CPU 编解码 + 大字符串），
//    而是把后端返回的 JPEG 字节直接 objectURL 给 <img> 承载：解码交给浏览器的
//    硬件/JPEG 解码器，合成与模糊全走 GPU 合成层，JS 侧几乎零开销；
//  - 后端 GDI BitBlt 本身即 GPU 加速截屏，区域=便签窗口大小（小区域），
//    降采样 0.5 + 低质量 JPEG，单帧成本约几毫秒；
//  - 刷新间隔 200ms（5fps）跟随背后内容变化，移动/缩放立即补拍，观感实时。
//
// 便签窗口自身通过 WDA_EXCLUDEFROMCAPTURE 从截屏中排除，不会把自己拍进背景产生重影。

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyGlassBlur } from "./glass";
import { applyAdaptiveColorsFromImage } from "./panel-bg";

let running = false;
let timer: number | undefined;
let el: HTMLElement | null = null;
/** Markdown 预览 iframe 的 body（有则同步更新它的背景，预览区同样实时） */
let mdTarget: HTMLElement | null = null;
/** 承载实时截屏帧的背景 <img>（直接做 CSS blur，GPU 合成） */
let imgEl: HTMLImageElement | null = null;
let lastStrength = 0;
let moveListenersAttached = false;
let capturePending = false;
let capturing = false;
let currentUrl: string | null = null;
let lastAdaptiveCheck = 0;

/** 开启/更新实时毛玻璃：target 为面板元素；strength 0~100（CSS 模糊半径） */
export function startRealtimeBlur(
  target: HTMLElement,
  strength: number,
  mdBody: HTMLElement | null = null,
): void {
  el = target;
  mdTarget = mdBody;
  lastStrength = Math.max(0, Math.min(100, Math.round(strength)));
  ensureBgLayer();
  if (!running) {
    running = true;
    invoke("set_exclude_from_capture", { enable: true }).catch(() => {});
    attachMoveListeners();
    void captureNow();
    timer = window.setInterval(() => void captureNow(), 450);
  } else {
    // 仅强度/目标变化：补一帧即可
    void captureNow();
  }
  applyGlassBlur({ target, strength: lastStrength, enabled: true });
}

/** 关闭实时毛玻璃：停止截屏、移除背景层并恢复自身可被截屏 */
export function stopRealtimeBlur(): void {
  running = false;
  el = null;
  mdTarget = null;
  if (imgEl) {
    imgEl.remove();
    imgEl = null;
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
  invoke("set_exclude_from_capture", { enable: false }).catch(() => {});
}

/** 确保背景 <img> 已挂到面板上（无则创建） */
function ensureBgLayer(): void {
  if (imgEl && imgEl.parentElement === el) return;
  if (imgEl) imgEl.remove();
  imgEl = document.createElement("img");
  imgEl.className = "note-bg-live";
  imgEl.alt = "";
  if (el) el.appendChild(imgEl);
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

/** 截取窗口背后的屏幕区域，交给背景 <img> 显示并套用模糊 */
async function captureNow(): Promise<void> {
  if (!running || !el || capturing) return;
  capturing = true;
  try {
    const win = getCurrentWindow();
    const pos = await win.outerPosition();
    const size = await win.outerSize();
    // 捕获窗口外矩形区域：坐标/尺寸为物理像素，降采样 0.35（模糊后无观感损失）；
    // 自身已被截屏排除，拍到的是窗口背后的内容。
    // 向外多截取 48px（与背景层 inset:-48px 对应，容纳最大模糊半径 40px 的采样）：
    // 否则背景图边缘的模糊采样落到图外透明区域，出现“中间模糊、四周不模糊”。
    const inset = 4;
    const margin = 48;
    const w = Math.max(8, size.width - inset * 2 + margin * 2);
    const h = Math.max(8, size.height - inset * 2 + margin * 2);
    const bytes = await invoke<Uint8Array>("capture_screen_region", {
      x: pos.x + inset - margin,
      y: pos.y + inset - margin,
      w,
      h,
      scale: 0.35,
    });
    if (!running) return;
    // 每帧都更新背景 <img>（不做帧去重）：实时毛玻璃必须持续跟随便签背后的内容。
    // 性能由 img 直接承载解码 + GPU 合成/模糊保证（无 canvas 重编码）。
    // 截采样率 0.35：模糊后无观感损失，编码/解码/合成开销约为 0.5 的一半。
    const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: "image/jpeg" }));
    if (imgEl) {
      // 上一帧 URL 在 onload 后释放（避免图片仍在解码时被回收）
      imgEl.onload = () => {
        if (currentUrl) URL.revokeObjectURL(currentUrl);
        currentUrl = url;
      };
      imgEl.onerror = () => URL.revokeObjectURL(url);
      imgEl.src = url;
    } else {
      URL.revokeObjectURL(url);
    }
    if (mdTarget) {
      mdTarget.style.setProperty("--md-bg-img", `url("${url}")`);
    }
    // 依据背景亮度切换按钮配色（透明模式下第一行/第二行按钮跟随背景实时变亮/变暗）。
    // 直接采样已加载的背景 <img>，节流到约 400ms 一次（采样有 canvas 开销）。
    const now = Date.now();
    if (now - lastAdaptiveCheck > 400) {
      lastAdaptiveCheck = now;
      if (el && imgEl) applyAdaptiveColorsFromImage(el, imgEl);
    }
  } catch (e) {
    // 首帧可能在窗口尚未就绪时失败，定时器会重试
    console.debug("实时截屏失败:", e);
  } finally {
    capturing = false;
  }
}
