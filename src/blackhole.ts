// 黑洞吸入关闭动画
// ----------------------------------------------------------------------------
// 触发：用户通过快捷键（或标题栏关闭按钮）关闭窗口时，先播放本动画，结束后再真正关闭。
//
// 实现要点：
// 1) 中心小黑洞：窗口中央快速“弹出”一个小黑洞（直径 ≈ 便签最短边的一半，不扩张至整窗），
//    由暖色辉光 + 旋转吸积盘臂 + 暗核 + 光子环组成（Canvas2D 覆盖层绘制）。
// 2) 内容旋转扭曲吸入：.note-window 沿中心旋转约两圈并收缩至消失（向洞心坠入），
//    同时 SVG feDisplacementMap（湍流噪声）位移尺度随接近黑洞而增强，产生流体扭曲感；
//    吸收完成瞬间光子环向外迸发一圈闪光。
// 3) 动画时长约 0.75s；内容被吸尽即真正关闭，绝无“吸完空等”。
//
// 【性能】黑洞半径小 → Canvas 绘制范围小、shadowBlur 封顶；湍流噪声固定 baseFrequency、
// 只改位移 scale（避免每帧重算噪声位图）；内容变换用 will-change 提升为 GPU 合成层。
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

  // 黑洞最终直径 = 便签最短边的一半（半径 = 最短边 1/4），保持“中心小黑洞”观感，
  // 不扩张至整个便签；内容被旋转扭曲吸入洞中。
  const holeR = Math.max(24, Math.min(w, h) / 4);
  const duration = 750;
  const start = performance.now();

  const easeInCubic = (x: number) => x * x * x;
  // 黑洞快速出现：0→1 带轻微回弹（弹出感）
  const easeOutBack = (x: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  };

  let raf = 0;
  const cleanup = () => {
    clearTimeout(raf);
    try {
      root.style.transform = "";
      root.style.filter = "";
      root.style.willChange = "";
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
    const e = easeInCubic(t); // 坠入感加速
    // 黑洞在前 15% 时间快速弹出到最终大小，之后保持小洞
    const appear = easeOutBack(Math.min(1, t / 0.15));
    // 内容螺旋吸入：旋转两圈 + 向中心收缩（先慢后快）；扭曲随接近黑洞增强
    const rot = e * 720;
    const scale = Math.pow(Math.max(0, 1 - e), 1.35);
    if (turb && disp) {
      // 【性能】只改位移尺度，不动 baseFrequency（固定湍流噪声位图，避免每帧重算）
      disp.setAttribute("scale", (e * 60).toFixed(2));
    }
    root.style.transformOrigin = "50% 50%";
    root.style.transform = `rotate(${rot}deg) scale(${scale.toFixed(4)})`;
    root.style.filter = "url(#bh-warp)";

    drawBlackHole(ctx, w, h, t, holeR * Math.max(0, appear));

    // 内容已被完全吸入：立刻真正关闭窗口（黑幕/闪光掩护下），绝不“吸完后空等”
    if (scale < 0.015 || t >= 1) {
      drawBlackHole(ctx, w, h, 1, holeR);
      try {
        onDone();
      } finally {
        // 关闭现为“隐藏”（异步 IPC）：画面延迟清理，待隐藏生效后再复原页面，
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
      drawBlackHole(ctx, w, h, 1, holeR);
      try {
        onDone();
      } finally {
        window.setTimeout(cleanup, 400); // 同上：延迟清理黑幕
      }
    }
  };

  // 提前提示浏览器为内容变换准备独立合成层，全程 GPU 变换不引发整页重绘
  try {
    root.style.willChange = "transform";
  } catch {
    /* ignore */
  }
  raf = window.setTimeout(() => frame(performance.now()), 16) as unknown as number;
}

function drawBlackHole(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
  r: number
): void {
  const cx = w / 2;
  const cy = h / 2;
  ctx.clearRect(0, 0, w, h);
  if (r < 1) return;

  // 1) 暖色辉光外晕（小洞范围内，开销低）
  const haloR = r * 2.4;
  if (haloR > 1) {
    const halo = ctx.createRadialGradient(cx, cy, r * 0.9, cx, cy, haloR);
    const a = 1 - t * 0.35;
    halo.addColorStop(0, `rgba(255, 190, 120, ${(0.5 * a).toFixed(3)})`);
    halo.addColorStop(0.3, `rgba(255, 140, 80, ${(0.22 * a).toFixed(3)})`);
    halo.addColorStop(0.7, `rgba(100, 80, 190, ${(0.1 * a).toFixed(3)})`);
    halo.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
    ctx.fill();
  }

  // 2) 旋转吸积盘臂：围绕小黑洞高速旋转的明亮高光
  const spin = t * Math.PI * 8;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(spin);
  const arms = 3;
  ctx.shadowColor = "rgba(255, 170, 90, 0.9)";
  // 【性能】shadowBlur 封顶，黑洞小所以开销天然可控
  ctx.shadowBlur = Math.min(14, Math.max(6, r * 0.18));
  for (let i = 0; i < arms; i++) {
    const a0 = (i / arms) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.35, a0, a0 + Math.PI * 0.7);
    ctx.lineWidth = Math.max(2, r * 0.09);
    ctx.strokeStyle = `rgba(255, 210, 160, ${(0.55 * (1 - t * 0.25)).toFixed(3)})`;
    ctx.stroke();
  }
  ctx.restore();

  // 3) 黑洞本体（事件视界内的暗核）
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "#000";
  ctx.fill();

  // 4) 光子环：事件视界亮环，随吸入进程逐渐提亮
  const flash = Math.sin(t * Math.PI); // 0→1→0 的收尾闪光
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(1.5, r * 0.03);
  ctx.strokeStyle = `rgba(255, 240, 220, ${(0.85 + flash * 0.15).toFixed(3)})`;
  ctx.shadowColor = "rgba(255, 200, 140, 1)";
  ctx.shadowBlur = Math.min(16, Math.max(6, r * 0.22) + flash * 6);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // 5) 收尾迸发：吸收完成瞬间，光子环向外迸出一圈亮环（不扩张暗核本体）
  if (t > 0.9) {
    const ft = (t - 0.9) / 0.1;
    ctx.beginPath();
    ctx.arc(cx, cy, r * (1 + ft * 1.6), 0, Math.PI * 2);
    ctx.lineWidth = 2.5 * (1 - ft);
    ctx.strokeStyle = `rgba(255, 235, 200, ${(0.9 * (1 - ft)).toFixed(3)})`;
    ctx.stroke();
  }
}
