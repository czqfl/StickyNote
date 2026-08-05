import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface ViewerData {
  urls: string[];
  index: number;
}

let urls: string[] = [];
let idx = 0;

function getEl<T extends HTMLElement>(sel: string): T {
  return document.querySelector(sel) as T;
}

function render() {
  if (!urls.length) return;
  const img = getEl<HTMLImageElement>(".iv-img");
  img.src = urls[idx];
  getEl<HTMLElement>(".iv-count").textContent = `${idx + 1} / ${urls.length}`;
}

function step(d: number) {
  if (!urls.length) return;
  idx = (idx + d + urls.length) % urls.length;
  render();
}

function closeViewer() {
  getCurrentWindow().close();
}

async function load() {
  try {
    const data = (await invoke("get_viewer_data")) as ViewerData | null;
    if (!data || !data.urls || data.urls.length === 0) {
      closeViewer();
      return;
    }
    urls = data.urls;
    idx = Math.min(Math.max(0, data.index), urls.length - 1);
    render();
  } catch (e) {
    console.error("加载图片预览失败:", e);
    closeViewer();
  }
}

export async function mountImageViewer(): Promise<void> {
  document.body.innerHTML = `
    <div class="iv-root">
      <div class="iv-stage"><img class="iv-img" alt="图片预览"></div>
      <button class="iv-nav iv-prev" type="button" title="上一张">‹</button>
      <button class="iv-nav iv-next" type="button" title="下一张">›</button>
      <div class="iv-count"></div>
    </div>`;

  getEl<HTMLButtonElement>(".iv-prev").onclick = () => step(-1);
  getEl<HTMLButtonElement>(".iv-next").onclick = () => step(1);

  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
  });

  const img = getEl<HTMLImageElement>(".iv-img");
  img.addEventListener("dragstart", (e) => e.preventDefault());

  await load();
  // 同一窗口被复用时（再次双击别的图片），后端会 emit 该事件触发重新拉取
  listen("viewer-reload", () => load());
  // 数据为空时 load() 内部已关闭窗口，无需（也不应）再 show
  if (!urls.length) return;
  // 首帧（结构已注入、CSS 深色背景已应用）就绪后再显示窗口，消除打开瞬间白闪
  try {
    await getCurrentWindow().show();
    await getCurrentWindow().setFocus();
  } catch (e) {
    console.error("显示图片预览窗口失败:", e);
  }
}
