// 背景图模糊（filter: blur）的平滑过渡动画
// ----------------------------------------------------------------------------
// 解决：之前 --glass-blur 是“瞬变”赋值，切换/调强度时模糊半径硬跳变，观感突兀。
//
// 设计要点（对应需求 1~4）：
// 1) 用 requestAnimationFrame 在旧值与新值之间逐帧补间，纯前端可控，流畅无卡顿；
// 2) 选用 easeInOutCubic 缓动——起止极缓、中段顺滑，过渡自然不跳跃；
// 3) 模糊半径随缓动曲线平滑渐变，参数变化连续；
// 4) 性能：每帧只改一个 CSS 变量（浏览器据此重算 blur，GPU 合成）；动画期间给 ::before
//    加 will-change 提示独立合成层，结束即移除，避免长期占用显存导致掉帧；
//    尊重 prefers-reduced-motion，直接落定不做动画；可中断/重定向——同一元素再次调用
//    会取消上一段并从当前值续接，杜绝“跳一下”。
// 模糊本身只作用于 .note-window.has-bg.glass::before（一张静态背景图），开销可控。

const reduceMotion =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** easeInOutCubic：起止柔和、中段顺滑，最符合“丝滑自然”的观感 */
const easeInOutCubic = (x: number): number =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

/** 每元素保存动画状态，便于取消/续接 */
const state = new WeakMap<HTMLElement, { raf: number; alive: boolean }>();

/**
 * 将 target 上的 --glass-blur 从当前值平滑过渡到 toPx（px）。
 * @param target 设置了 .glass 且 ::before 用 var(--glass-blur) 做 filter:blur 的元素
 * @param toPx   目标模糊半径（px），<=0 表示完全不模糊
 * @param opts   duration 动画时长(ms)；onDone 动画结束（含被取消前的那次收尾）后的回调
 */
export function tweenGlassBlur(
  target: HTMLElement,
  toPx: number,
  opts?: { duration?: number; onDone?: () => void },
): void {
  const duration = opts?.duration ?? 280;
  const onDone = opts?.onDone;

  const raw = target.style.getPropertyValue("--glass-blur");
  const from = raw ? parseFloat(raw) || 0 : 0;
  const to = Math.max(0, toPx);

  // 取消上一段动画（含其可能的 onDone），从当前值无缝续接
  const prev = state.get(target);
  if (prev) {
    cancelAnimationFrame(prev.raf);
    prev.alive = false;
  }

  // 减弱动画偏好 / 起止相同 / 无时长：直接落定
  if (reduceMotion || from === to || duration <= 0) {
    target.style.setProperty("--glass-blur", to + "px");
    onDone?.();
    state.delete(target);
    return;
  }

  target.classList.add("animating");

  let startTs = 0;
  const step = (now: number) => {
    const st = state.get(target);
    if (!st || !st.alive) return; // 已被新动画取消
    if (!startTs) startTs = now;
    const t = Math.min(1, (now - startTs) / duration);
    const v = from + (to - from) * easeInOutCubic(t);
    target.style.setProperty("--glass-blur", v.toFixed(2) + "px");
    if (t < 1) {
      st.raf = requestAnimationFrame(step);
    } else {
      target.style.setProperty("--glass-blur", to + "px");
      target.classList.remove("animating");
      st.alive = false;
      onDone?.();
      state.delete(target);
    }
  };

  const entry = { raf: 0, alive: true };
  state.set(target, entry);
  entry.raf = requestAnimationFrame(step);
}
