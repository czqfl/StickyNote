// 统一毛玻璃工具：透明主题（桌面壁纸）与自定义背景图片共用同一条模糊管线——
// 把背景图（壁纸 / 用户图片）画在便签上，用 CSS filter:blur 做高斯模糊。
// 强度直接映射为模糊半径（0% 原图无模糊，100% ≈ MAX_BLUR_PX 强模糊），
// 半径变化用 rAF 平滑过渡（见 blur-anim.ts）。
//
// 为什么透明主题也走这一条管线（而不是系统 Acrylic）：
// Windows 系统级 Acrylic/Blurbehind 必然叠加一层 tint 着色（浅色下就是“白蒙版”），
// 且强度无法控制模糊半径；而这里与自定义背景图片完全一致——纯背景图 + 纯高斯模糊，
// 没有任何色罩，观感与“自定义背景图片做高斯模糊”完全相同。
// 性能：模糊是静态背景图上的 GPU filter，无实时合成开销。

import { tweenGlassBlur } from "./blur-anim";

/** 背景磨砂的最大模糊半径（px），对应强度 100% */
export const MAX_BLUR_PX = 40;

export interface GlassOptions {
  /** 设置了背景图的 .note-window（其 ::before 承载背景图） */
  target: HTMLElement | null;
  /** 强度 0~100 */
  strength: number;
  /** 毛玻璃总开关（关闭时回到无模糊） */
  enabled: boolean;
}

/** 统一入口：把「毛玻璃强度」应用到便签背景图。幂等，可随时改强度/开关反复调用。 */
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
