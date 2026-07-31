// 面板背景统一工具：便签窗口、历史窗口、设置窗口共用同一条背景管线——
// 「背景图（自定义图片 / 透明主题的桌面壁纸）+ CSS 高斯模糊」，保证各窗口
// 与「自定义背景图片」的观感完全一致（纯模糊、无色罩）。
//
// 另外提供「背景亮度自适应」：计算背景图平均亮度，过暗时给面板挂上
// .on-dark-bg 类，按钮自动切换为浅色，保证背景过暗时按钮始终清晰可见。

import type { Settings } from "./types";
import { normalizeGlassPct } from "./settings";

/** 桌面壁纸 → 压缩后的 data URL（透明主题把壁纸当背景图用，与自定义背景图片同一条模糊管线）。
 *  壁纸可能 4K+，先压到最长边 1920 → JPEG，避免超大 data URL 拖垮渲染；进程内缓存一份。 */
let wallpaperDataUrlCache: Promise<string> | null = null;

export function getWallpaperDataUrl(): Promise<string> {
  if (wallpaperDataUrlCache) return wallpaperDataUrlCache;
  wallpaperDataUrlCache = (async () => {
    try {
      const { getWallpaper, readBgImage } = await import("./api");
      const wp = await getWallpaper();
      if (!wp) return "";
      const dataUrl = await readBgImage(wp);
      if (!dataUrl || !dataUrl.startsWith("data:")) return "";
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("壁纸解码失败"));
        img.src = dataUrl;
      });
      const maxEdge = 1920;
      const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return "";
      ctx.drawImage(img, 0, 0, w, h);
      return canvas.toDataURL("image/jpeg", 0.82);
    } catch (e) {
      console.warn("读取桌面壁纸失败:", e);
      return "";
    }
  })();
  return wallpaperDataUrlCache;
}

/** 读取全局默认背景图为 data URL（磁盘路径 → data URL） */
async function resolveGlobalBg(path: string): Promise<string> {
  if (path.startsWith("data:")) return path;
  try {
    const { readBgImage } = await import("./api");
    return await readBgImage(path);
  } catch (e) {
    console.warn("读取背景图失败:", e);
    return "";
  }
}

export interface PanelBgOptions {
  /** 已解析好的背景图 data URL（自定义背景时传入；透明主题自动取壁纸） */
  bgUrl?: string;
}

/**
 * 把「背景图 + 透明主题」应用到任意面板元素（.note-window / .history-window /
 * #settings-overlay）：设置 --note-bg-img 与 has-bg / bg-transparent 类，
 * 并按背景亮度自动切换 on-dark-bg（过暗时按钮变浅色）。
 * 注意：毛玻璃强度由调用方另行套用（applyGlassBlur），保持职责单一。
 */
export async function applyPanelBackground(
  el: HTMLElement,
  s: Settings,
  opts: PanelBgOptions = {},
): Promise<void> {
  const transparent = s.theme === "transparent";

  let bgUrl = opts.bgUrl ?? "";
  if (!bgUrl) {
    if (transparent) {
      bgUrl = await getWallpaperDataUrl();
    } else if (s.bg_image) {
      bgUrl = await resolveGlobalBg(s.bg_image);
    }
  }

  if (bgUrl) {
    el.style.setProperty("--note-bg-img", `url("${bgUrl}")`);
    el.style.setProperty("--note-bg-opacity", "1");
    el.classList.add("has-bg");
  } else {
    el.style.removeProperty("--note-bg-img");
    el.style.removeProperty("--note-bg-opacity");
    el.classList.remove("has-bg");
  }
  el.classList.toggle("bg-transparent", transparent);

  await applyAdaptiveColors(el, bgUrl);
}

/** 计算背景图平均亮度（0~1），用于判断按钮是否需要切换浅色 */
function bgLuminance(dataUrl: string): Promise<number> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        const size = 32;
        c.width = size;
        c.height = size;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          resolve(0.5);
          return;
        }
        ctx.drawImage(img, 0, 0, size, size);
        const d = ctx.getImageData(0, 0, size, size).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) {
          sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        }
        resolve(sum / (size * size) / 255);
      } catch {
        resolve(0.5);
      }
    };
    img.onerror = () => resolve(0.5);
    img.src = dataUrl;
  });
}

/** 按背景亮度切换 on-dark-bg（过暗 → 按钮变浅色，保证始终清晰可见） */
export async function applyAdaptiveColors(el: HTMLElement, bgUrl: string): Promise<void> {
  let dark = false;
  if (bgUrl) {
    try {
      dark = (await bgLuminance(bgUrl)) < 0.45;
    } catch {
      dark = false;
    }
  }
  el.classList.toggle("on-dark-bg", dark);
}

/** 便捷入口：按设置把背景应用到面板，并套用毛玻璃强度（供历史/设置窗口使用） */
export async function applyPanelWithGlass(el: HTMLElement, s: Settings): Promise<void> {
  const pct = normalizeGlassPct(s.glass_blur);
  const enabled = s.glass_enabled !== false;
  await applyPanelBackground(el, s);
  const { applyGlassBlur } = await import("./glass");
  applyGlassBlur({ target: el, strength: pct, enabled });
}
