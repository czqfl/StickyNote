// 统一毛玻璃工具：自定义背景图片 + CSS 高斯模糊。
// 强度直接映射为模糊半径（0% 原图无模糊，100% ≈ MAX_BLUR_PX 强模糊）。
// 半径变化用 rAF 平滑过渡（见 blur-anim.ts），纯前端可控、开销小。
//
// 为什么自定义背景走 CSS 模糊而非系统 Acrylic：
// - Windows 系统级 Acrylic 的模糊半径固定不可调，强度 1% 和 100% 观感几乎无差别；
// - Acrylic 必然叠加一层 tint 着色（浅色下就是"白蒙版"），低强度时蒙版更浓，
//   与「自定义背景图片 + CSS 模糊」的观感差异明显。
// 透明主题则反过来：为实时性直接用 DWM 原生亚克力（见 main.rs set_acrylic），
// 模糊半径由系统固定，不透明度由“背景不透明度”滑块调节（见 note.ts applyAcrylic）。

import { tweenGlassBlur } from "./blur-anim";

/** 背景磨砂的最大模糊半径（px），对应强度 100% */
export const MAX_BLUR_PX = 40;

/** 解析 CSS 颜色（#rrggbb / rgb()）为 0xRRGGBB；解析失败返回 null。
 *  透明主题把 --bg（主题面板色）作为 SWCA 亚克力的 tint，避免黑/白蒙版。 */
export function parseColorToRgbInt(value: string | null | undefined): number | null {
  if (!value) return null;
  const s = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(s);
  if (hex) return parseInt(hex[1], 16);
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
  if (rgb) {
    return (parseInt(rgb[1], 10) << 16) | (parseInt(rgb[2], 10) << 8) | parseInt(rgb[3], 10);
  }
  return null;
}

export interface GlassOptions {
  /** 设置了背景图且带 .glass 的元素（其 ::before 承载背景图） */
  target: HTMLElement | null;
  /** 强度 0~100：0%（或关闭）原图无模糊；100% 强模糊（≈ MAX_BLUR_PX） */
  strength: number;
  /** 毛玻璃总开关（关闭时回到"无模糊"） */
  enabled: boolean;
}

/** 统一入口：把「毛玻璃强度」应用到背景图。幂等，可随时改强度/开关反复调用。 */
export function applyGlassBlur(opts: GlassOptions): void {
  const target = opts.target;
  if (!target) return;
  const pct = Math.max(0, Math.min(100, Math.round(opts.strength)));

  target.style.removeProperty("--glass-blur");
  if (!opts.enabled || pct <= 0) {
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
