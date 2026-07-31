// 统一毛玻璃工具：透明背景（系统级磨砂）与自定义背景图片（CSS 模糊）两种模式
// 共用同一套入口与同一套「强度 0~100%」语义，避免两处各自实现、行为漂移。
//
// 透明背景 = system 模式：Windows 系统合成层实时模糊窗口背后的真实内容
// （桌面、其它窗口、动态画面），零截屏、零延迟、零错位、不占前端性能。
// 通过 SetWindowCompositionAttribute 设置 ACCENT_ENABLE_ACRYLICBLURBEHIND
// （TranslucentTB 同款方案），不依赖 Tauri setEffects（内置 blur 在透明窗口上
// 渲染成黑底；内置 acrylic 在 Win11 22H2+ 对透明窗口不生效）。
// DWM 磨砂半径固定不可调，强度通过遮罩 alpha 表达：强度越低遮罩越浓、
// 磨砂被盖住（观感接近不模糊）；强度越高遮罩越淡、磨砂完全透出（模糊感越强）。
// 遮罩底色跟随浅色/深色主题（暖白 / 深灰），整体保持在很淡的水平，不会盖住背景。
//
// 自定义背景图片 = image 模式：对便签窗口内的背景图做 CSS filter:blur，
// 强度直接映射为模糊半径（0% 原图无模糊，100% ≈ MAX_BLUR_PX 强模糊），
// 半径变化用 rAF 平滑过渡（见 blur-anim.ts），纯前端可控、开销小。

import { invoke } from "@tauri-apps/api/core";
import { tweenGlassBlur } from "./blur-anim";

/** 自定义背景磨砂的最大模糊半径（px），对应强度 100% */
export const MAX_BLUR_PX = 40;

/** 各主题的系统磨砂遮罩底色（与 --bg 一致的暖白 / 深灰，深色主题不发白） */
const TINTS: Record<string, [number, number, number]> = {
  light: [255, 253, 248],
  dark: [35, 35, 42],
};

export type GlassMode = "system" | "image";

export interface GlassOptions {
  /** 自定义背景模式的 .note-window 元素（system 模式可为 null） */
  target: HTMLElement | null;
  /** system=透明背景系统级磨砂；image=自定义背景图 CSS 模糊 */
  mode: GlassMode;
  /** 强度 0~100 */
  strength: number;
  /** 毛玻璃总开关（关闭时两模式都回到“无模糊”） */
  enabled: boolean;
  /** 主题名（light/dark…），system 模式选遮罩底色 */
  theme: string;
}

/** 统一入口：把「毛玻璃强度」应用到指定模式。幂等，可随时改强度/开关反复调用。 */
export async function applyGlassBlur(opts: GlassOptions): Promise<void> {
  const pct = Math.max(0, Math.min(100, Math.round(opts.strength)));
  if (opts.mode === "system") {
    if (!opts.enabled || pct <= 0) {
      disableSystemBlur();
      return;
    }
    await enableSystemBlur(pct, opts.theme);
    return;
  }
  applyImageBlur(opts.target, pct, opts.enabled);
}

/** system 模式：开启/更新系统级磨砂（只传 tint，由后端作用于当前窗口） */
async function enableSystemBlur(pct: number, theme: string): Promise<void> {
  const rgb = TINTS[theme] || TINTS.light;
  // 遮罩始终很淡：强度 1% → 约 40/255（15.7%），100% → 约 6/255（2.4%），
  // 强度越高遮罩越淡、磨砂越通透。这样默认强度下背景也清晰可见，
  // 蒙版只是轻微提亮/加深来保证文字对比度，不会盖住背景。
  const alpha = Math.max(6, Math.min(40, Math.round(40 - pct * 0.34)));
  try {
    await invoke("set_window_blur", {
      enabled: true,
      tint: [rgb[0], rgb[1], rgb[2], alpha],
    });
  } catch (e) {
    console.warn("设置系统磨砂失败:", e);
  }
}

/** system 模式：关闭系统级磨砂（回到完全透明、直接透出桌面） */
function disableSystemBlur(): void {
  invoke("set_window_blur", {
    enabled: false,
    tint: [0, 0, 0, 0],
  }).catch(() => {});
}

/** image 模式：对背景图做 CSS 模糊，强度→半径，用 rAF 平滑过渡 */
function applyImageBlur(target: HTMLElement | null, pct: number, enabled: boolean): void {
  if (!target) return;
  target.style.removeProperty("--glass-blur");
  if (!enabled || pct <= 0) {
    if (target.classList.contains("glass")) {
      // 关闭：先平滑退到 0 再摘除 glass，避免模糊瞬间消失的跳变
      tweenGlassBlur(target, 0, {
        onDone: () => {
          target.classList.remove("glass");
          target.style.removeProperty("--glass-blur");
        },
      });
    } else {
      target.classList.remove("glass");
      target.style.removeProperty("--glass-blur");
    }
    return;
  }
  const px = Math.round((pct / 100) * MAX_BLUR_PX);
  // 刚开启且无内联值时先归零，防止 CSS 默认 16px 闪现后再动画
  if (!target.classList.contains("glass")) {
    target.style.setProperty("--glass-blur", "0px");
  }
  target.classList.add("glass");
  tweenGlassBlur(target, px);
}
