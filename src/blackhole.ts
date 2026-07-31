// 黑洞吸入关闭动画
// ----------------------------------------------------------------------------
// 触发：用户通过快捷键（或标题栏关闭按钮）关闭窗口时，先播放本动画，结束后再真正关闭。
//
// 实现要点：
// 1) 内容形变（流体扭曲 + 螺旋吸入）
//    - 对 .note-window 施加 SVG feDisplacementMap（湍流噪声），随时间增强位移尺度，
//      使窗口像素产生“流体般”的扭曲，而非简单的缩放。
//    - 配合 CSS transform 做“旋转 + 缩放”向几何中心螺旋收缩，模拟引力透镜下的坠入。
// 2) 黑洞视觉（Canvas2D 覆盖层）
//    - 深色吸积核心（吞噬区）随时间扩张直至覆盖整个窗口；
//    - 亮色“光子环”（Einstein ring）勾勒事件视界；
//    - 暖色辉光外晕 + 旋转吸积盘臂，营造《星际穿越》式的时空扭曲与吸积盘质感。
// 3) 动画时长约 1s。
//
// 【关键可靠性修复】早期版本用 requestAnimationFrame 驱动，但当动画由“全部关闭”全局
// 快捷键触发、而便签窗口处于后台（非前台聚焦）时，浏览器/系统会节流甚至暂停该 webview
// 的 rAF，导致帧循环停摆、看门狗 2.6s 后直接关闭却无任何动画（即用户反馈的“卡 2 秒后
// 直接关闭”）。因此改为：
//   - 播放前先把窗口置顶并聚焦（setAlwaysOnTop + setFocus），确保其进入前台、rAF 不被节流；
//   - 帧循环改用 setTimeout(16ms) 驱动（按 performance.now() 计量时间），即便 rAF 被节流
//     也能持续推进，杜绝“卡住后无动画关闭”。

let animating = false;

/** 请求播放黑洞吸入关闭动画；onDone 在动画完全结束后调用（用于真正关闭窗口）。
 * 自带看门狗与异常兜底：无论动画是否顺利完成，onDone 都一定会被调用，绝不卡死关闭按钮。 */
export function requestBlackHoleClose(onDone: () => void): void {
  const root = document.querySelector(".note-window") as HTMLElement | null;
  if (!root) {
    onDone();
    return;
  }
  // 若已有动画在进行（理论上 cleanup 必复位，此处为兜底），直接关闭，绝不卡死按钮
  if (animating) {
    onDone();
    return;
  }
  animating = true;
  let done = false;
  const safeDone = () => {
    if (done) return;
    done = true;
    animating = false;
    onDone();
  };
  // 看门狗：极端情况下（如窗口置顶失败且计时器被节流）动画未能在 2.6s 内结束，强制收尾
  const watchdog = window.setTimeout(safeDone, 2600);

  // 播放前只把窗口聚焦到前台（不置顶）：确保窗口可见、rAF 不被节流；动画用 setTimeout 驱动，
  // 即便仍被节流也能持续推进。此前版本在关闭前 setAlwaysOnTop(true)，而主窗口是“隐藏到托盘”
  // 而非销毁，该置顶状态在隐藏/重新呼出后可能残留，导致窗口卡在置顶、后续点击响应异常。
  // 仅 setFocus 足以让动画正常播放，无需置顶。
  const bringToFront = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      try {
        await win.setFocus();
      } catch {
        /* ignore */
      }
    } catch {
      /* ignore */
    }
  };
  const resetTop = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      try {
        await win.setAlwaysOnTop(false);
      } catch {
        /* ignore */
      }
    } catch {
      /* ignore */
    }
  };

  bringToFront()
    .catch(() => {})
    .finally(() => {
      try {
        // 收尾时先真正关闭窗口（safeDone），再异步复位 alwaysOnTop 作为兜底；
        // 关键：绝不 await resetTop 再关闭 —— 否则“页面全黑后还要停顿一下才关闭”。
        playBlackHole(root, () => {
          window.clearTimeout(watchdog);
          resetTop().catch(() => {}); // 异步复位，不阻塞关闭
          safeDone();
        });
      } catch (e) {
        console.error("黑洞动画异常:", e);
        window.clearTimeout(watchdog);
        resetTop().catch(() => {});
        safeDone();
      }
    });
}

function ensureSvgDefs(): void {
  if (document.getElementById("bh-warp-svg")) return;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = "bh-warp-svg";
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.style.position = "absolute";
  svg.style.width = "0";
  svg.style.height = "0";
  svg.style.pointerEvents = "none";
  svg.style.left = "0";
  svg.style.top = "0";
  svg.innerHTML = `
    <defs>
      <filter id="bh-warp" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">
        <feTurbulence id="bh-turb" type="fractalNoise" baseFrequency="0.009 0.013"
          numOctaves="1" seed="11" result="noise" />
        <feDisplacementMap id="bh-disp" in="SourceGraphic" in2="noise" scale="0"
          xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </defs>`;
  document.body.appendChild(svg);
}

function playBlackHole(root: HTMLElement, onDone: () => void): void {
  ensureSvgDefs();
  const turb = document.getElementById("bh-turb") as SVGFETurbulenceElement | null;
  const disp = document.getElementById("bh-disp") as SVGFEDisplacementMapElement | null;

  // 全窗口覆盖层 canvas（置于 .note-window 之外，避免被自身滤镜扭曲）
  const canvas = document.createElement("canvas");
  canvas.className = "bh-canvas";
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  canvas.style.position = "fixed";
  canvas.style.left = "0";
  canvas.style.top = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.zIndex = "2147483647";
  canvas.style.pointerEvents = "none";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    animating = false;
    onDone();
    return;
  }
  ctx.scale(dpr, dpr);

  // 覆盖窗口四角所需的最大半径（略大于半对角线）
  const maxR = (Math.hypot(w, h) / 2) * 1.08;
  // 整体提速：约 0.65s 完成吸入；暗核铺满全屏的“那一刻”立即真正关闭窗口，
  // 杜绝“变黑后还停顿一下才关”。（旧版 1s 且须跑到 t=1 才关，故有约 1s 拖尾观感。）
  const duration = 650;
  const start = performance.now();

  const easeInCubic = (x: number) => x * x * x;

  let raf = 0;
  const cleanup = () => {
    clearTimeout(raf);
    try {
      root.style.transform = "";
      root.style.filter = "";
    } catch {
      /* ignore */
    }
    try {
      canvas.remove();
    } catch {
      /* ignore */
    }
    const svg = document.getElementById("bh-warp-svg");
    if (svg) svg.remove();
    animating = false;
  };

  const frame = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    const e = easeInCubic(t); // 加速坠入
    const shrink = 1 - easeInCubic(Math.min(1, t * 1.05)) * 0.985; // 内容缩至极小
    const rot = e * 600; // 螺旋旋转角（度）

    // 流体扭曲：只随时间增强位移尺度。
    // 【性能】不要逐帧改 baseFrequency——那会让浏览器每帧重新生成整窗湍流噪声位图
    // （feTurbulence 是 CPU 光栅化，全窗口重算一次要几十毫秒），是关闭动画掉帧的元凶；
    // 固定噪声、只改 scale 则仅做位移采样，代价低得多。
    if (turb && disp) {
      disp.setAttribute("scale", (e * 42).toFixed(2));
    }
    // 内容螺旋收缩
    root.style.transformOrigin = "50% 50%";
    root.style.transform = `rotate(${rot}deg) scale(${shrink})`;
    root.style.filter = "url(#bh-warp)";

    drawBlackHole(ctx, w, h, t, maxR);

    // 暗核已铺满全屏：立刻真正关闭窗口（黑幕掩护下），绝不“变黑后空等”
    const darkR = maxR * easeOutCubicLocal(Math.min(1, t * 1.18));
    if (darkR >= maxR * 0.999 || t >= 1) {
      drawBlackHole(ctx, w, h, 1, maxR);
      try {
        onDone();
      } finally {
        // 关闭现为“隐藏”（异步 IPC）：黑幕延迟清理，待隐藏生效后再复原页面，
        // 避免隐藏前一瞬闪回未扭曲的原内容
        window.setTimeout(cleanup, 400);
      }
      return;
    }
    if (t < 1) {
      // 用 setTimeout 驱动（而非 requestAnimationFrame）：当便签窗口处于后台、rAF 被
      // 系统/浏览器节流或暂停时，计时器仍能持续推进，避免“卡住后无动画直接关闭”。
      raf = window.setTimeout(() => frame(performance.now()), 16) as unknown as number;
    } else {
      drawBlackHole(ctx, w, h, 1, maxR);
      try {
        onDone();
      } finally {
        window.setTimeout(cleanup, 400); // 同上：延迟清理黑幕
      }
    }
  };

  raf = window.setTimeout(() => frame(performance.now()), 16) as unknown as number;
}

function drawBlackHole(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
  maxR: number
): void {
  const cx = w / 2;
  const cy = h / 2;
  // 暗核略快于整体进度扩张，确保在 coverFraction 之前已完全覆盖全屏
  const darkR = maxR * easeOutCubicLocal(Math.min(1, t * 1.18));
  ctx.clearRect(0, 0, w, h);

  // 1) 时空辉光外晕：暖色径向渐变由暗区边缘向外淡出
  const haloR = darkR * 2.3;
  if (haloR > 1) {
    const halo = ctx.createRadialGradient(cx, cy, darkR * 0.95, cx, cy, haloR);
    const a = 1 - t * 0.4;
    halo.addColorStop(0, `rgba(255, 196, 128, ${(0.55 * a).toFixed(3)})`);
    halo.addColorStop(0.25, `rgba(255, 150, 90, ${(0.28 * a).toFixed(3)})`);
    halo.addColorStop(0.6, `rgba(120, 90, 200, ${(0.12 * a).toFixed(3)})`);
    halo.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
    ctx.fill();
  }

  // 2) 旋转吸积盘臂：暗区边缘的明亮螺旋高光
  const spin = t * Math.PI * 6;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(spin);
  const arms = 3;
  ctx.shadowColor = "rgba(255, 170, 90, 0.9)";
  // 【性能】shadowBlur 是 Canvas 里最贵的操作之一，半径大时（darkR≈400 → blur≈48px）
  // 每帧要做多次大核模糊，封顶到 20px：观感几乎无差，帧率显著提升
  ctx.shadowBlur = Math.min(20, Math.max(8, darkR * 0.12));
  for (let i = 0; i < arms; i++) {
    const a0 = (i / arms) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(0, 0, darkR * 1.12, a0, a0 + Math.PI * 0.9);
    ctx.lineWidth = Math.max(2, darkR * 0.05);
    ctx.strokeStyle = `rgba(255, 210, 160, ${(0.5 * (1 - t * 0.3)).toFixed(3)})`;
    ctx.stroke();
  }
  ctx.restore();

  // 3) 深色吸积核心（吞噬区）
  ctx.beginPath();
  ctx.arc(cx, cy, darkR, 0, Math.PI * 2);
  ctx.fillStyle = "#000";
  ctx.fill();

  // 4) 光子环（事件视界亮环）
  ctx.beginPath();
  ctx.arc(cx, cy, darkR, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(1.5, darkR * 0.012);
  ctx.strokeStyle = `rgba(255, 240, 220, ${(0.9 * (1 - t * 0.2)).toFixed(3)})`;
  ctx.shadowColor = "rgba(255, 200, 140, 1)";
  ctx.shadowBlur = Math.min(18, Math.max(6, darkR * 0.1)); // 同样封顶，避免大半径高开销模糊
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function easeOutCubicLocal(x: number): number {
  return 1 - Math.pow(1 - x, 3);
}
