// 透明背景：把桌面壁纸预模糊成一张「高斯模糊 + 缩小」的图（非实时 CSS filter:blur）。
// 目的：透明窗口上实时模糊全分辨率壁纸会带来严重卡顿；改为 canvas 预模糊一次并缓存，
// 前端只显示已模糊好的小图（无任何实时 filter 合成层重绘），彻底去卡。
// 模糊半径按滑块值从物理上缩放到小图，放大显示后观感与原图实时模糊（自定义背景）一致。

import { getWallpaper, readBgImage } from "./api";

const SMALL_LONGEST = 640; // 预缩放最长边：越小越快、越省显存（模糊背景本就糊，分辨率无关紧要）

let rawImage: HTMLImageElement | null = null;
let loadPromise: Promise<HTMLImageElement | null> | null = null;
// 按模糊像素档位缓存「进行中的 Promise」（避免拖动滑块时重复并发计算同一档位）
const cache = new Map<number, Promise<string | null>>();

async function loadRaw(): Promise<HTMLImageElement | null> {
  if (rawImage) return rawImage;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const p = await getWallpaper();
      if (!p) return null;
      const dataUrl = p.startsWith("data:") ? p : await readBgImage(p);
      if (!dataUrl) return null;
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("壁纸加载失败"));
        img.src = dataUrl;
      });
      rawImage = img;
      return img;
    } catch (e) {
      console.warn("读取桌面壁纸失败:", e);
      return null;
    }
  })();
  return loadPromise;
}

/** 取「按 blurPx 预模糊过的桌面壁纸」data URL；失败返回 null（调用方回退主题色面板）。
 *  blurPx 为等效于原图分辨率的模糊半径（与自定义背景 CSS --glass-blur 同口径，0~MAX_BLUR_PX）。 */
export async function getBlurredWallpaper(blurPx: number): Promise<string | null> {
  const img = await loadRaw();
  if (!img || !img.naturalWidth) return null;
  const key = Math.round(blurPx);
  let pending = cache.get(key);
  if (!pending) {
    pending = (async () => {
      const longest = Math.max(img.naturalWidth, img.naturalHeight);
      const scale = SMALL_LONGEST / longest;
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      // 物理正确缩放补偿：在小图上模糊 blurPx*scale，放大回原尺寸后观感 ≈ 原尺寸 blurPx
      const blurSmall = Math.max(0, blurPx) * scale;
      if (blurSmall > 0) ctx.filter = `blur(${blurSmall}px)`;
      ctx.drawImage(img, 0, 0, w, h);
      return canvas.toDataURL("image/jpeg", 0.72);
    })();
    cache.set(key, pending);
  }
  try {
    return await pending;
  } catch {
    return null;
  }
}
