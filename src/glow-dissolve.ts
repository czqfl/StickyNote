// 便签「粒子光效消散」动画：鸿蒙通知删除同款 —— 界面从下往上碎裂成大量发光微粒，
// 粒子区域化朝相近方向加速上升、边升边淡出，全程带光晕辉光。
// ----------------------------------------------------------------------------
// 触发：关闭窗口时播放（粒子风格 particle_mode = "particle" 时选用）。
//
// 视觉要点（对齐需求规格）：
// - 从底部开始碎裂，消散边界自下而上**不规则推进**：同一水平线 ±150ms 随机延迟
//   （低频值噪声形成错落团块 + 细碎哈希抖动），不是水平直线一刀切。
// - 粒子运动**区域趋同**：水平方向按 ~65px 划区，每区一个基础飘散角（垂直向上 ±20°，
//   边缘微外扩成扇形 + 低频噪声错落），同区粒子方向相近、不同区方向不同 →
//   “左一团微左飘、中一团垂直、右一团微右飘”的多股微气流呼吸感，不散得太开。
// - **加速上升**：初速 ~150-250px/s、末速 ~400-600px/s，二次缓动(ease-in-quad)柔和加速，
//   逐粒子初速/加速度 ±20% 随机差异；附加极轻微左右摆动（呼吸感），不“嗖”地飞走。
// - 质感：冷色发光微粒（白 / 淡蓝 #4FC3F7 / 淡紫），additive 叠加出辉光，
//   边升边变暗变淡直至完全消失，全程保持发光质感。
// - 可配（见常量）：主体时长 ~780ms、粒子数 200-400、大小 2-5px、区域宽 ~65px、角度 ±20°。
//
// 实现（与 flame.ts 同一套契约）：canvas 覆盖层画粒子（z-index 置顶、pointer-events:none、
// additive 辉光）；便签本体用 clip-path 多边形沿不规则前沿逐步裁掉（边界以上可见）；
// 提供 cancelGlowDissolve() 立即中止（停帧+复原页面、不触发 onDone），供“呼出打断关闭”等
// 快速切换；看门狗强制收尾，杜绝动画卡死导致窗口无法关闭。

let glowing = false;
let rafId = 0;
let backupId = 0;

/** 当前粒子消散动画的“立即中止”句柄（由 runGlowDissolve 注册；cancelGlowDissolve 调用）。 */
let cancelGlowFn: (() => void) | null = null;

/** 立即中止粒子消散动画并复原页面（呼出打断关闭时调用——不触发 onDone，窗口保持显示）。 */
export function cancelGlowDissolve(): void {
  const c = cancelGlowFn;
  cancelGlowFn = null;
  if (c) {
    c();
    return;
  }
  if (!glowing) return;
  glowing = false;
  cancelAnimationFrame(rafId);
  if (backupId) {
    window.clearInterval(backupId);
    backupId = 0;
  }
  const root = document.querySelector(".note-window") as HTMLElement | null;
  if (root) restoreRoot(root);
  document.querySelector(".glow-dissolve-canvas")?.remove();
}

/** 复原便签本体样式（裁剪 / 透明度 / 阴影还原）。 */
function restoreRoot(root: HTMLElement): void {
  try {
    root.style.clipPath = "";
    root.style.opacity = "";
    root.style.boxShadow = "";
  } catch {
    /* ignore */
  }
}

/** 隐藏便签本体（保持“空画面”，供下次呼出从空开始，契约与 flame.ts 一致）。 */
function blankRoot(root: HTMLElement): void {
  try {
    root.style.clipPath = "inset(0 0 100% 0)";
    root.style.opacity = "";
    root.style.boxShadow = "none";
  } catch {
    /* ignore */
  }
}

/** 请求播放「粒子光效消散」关闭动画；onDone 在动画完全结束后调用（用于真正关闭窗口）。 */
export function requestGlowDissolveClose(onDone: () => void, particleDensity = 50): void {
  const root = document.querySelector(".note-window") as HTMLElement | null;
  if (!root || glowing) {
    onDone();
    return;
  }
  glowing = true;
  let done = false;
  let aborted = false;
  let stopRun: (() => void) | null = null;
  const safeDone = () => {
    if (done) return;
    done = true;
    glowing = false;
    cancelGlowFn = null;
    onDone();
  };
  const watchdog = window.setTimeout(safeDone, 4000);
  cancelGlowFn = () => {
    if (aborted) return;
    aborted = true;
    window.clearTimeout(watchdog);
    if (stopRun) stopRun();
    done = true; // 阻止 onDone：finish() 不会被调用，窗口保持显示
    glowing = false;
  };
  try {
    stopRun = runGlowDissolve(root, particleDensity, () => {
      window.clearTimeout(watchdog);
      safeDone();
    });
  } catch (e) {
    console.error("粒子光效消散动画异常:", e);
    window.clearTimeout(watchdog);
    safeDone();
  }
}

// ---- 确定性哈希 / 值噪声（提供平滑团块 + 细碎抖动）----
function hash2(ix: number, iy: number): number {
  let n = (ix * 374761393 + iy * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n = n ^ (n >>> 16);
  return (n >>> 0) / 4294967295; // 0..1
}

/** 一维平滑值噪声（0..1），用固定第二维 + 种偏移去相关。 */
function valueNoise1(x: number, seedY: number): number {
  const ix = Math.floor(x);
  const fx = x - ix;
  const ux = fx * fx * (3 - 2 * fx);
  const a = hash2(ix, seedY);
  const b = hash2(ix + 1, seedY);
  return a + (b - a) * ux;
}

/** 播放一次粒子光效消散（仅关闭方向）。返回“立即中止”句柄。 */
function runGlowDissolve(
  root: HTMLElement,
  particleDensity: number,
  onDone: () => void,
): () => void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  const density = Math.max(0, Math.min(100, particleDensity)) / 100;

  // ---- 时序参数（可配）----
  const delaySpan = 280; // 同水平线 ±150ms 随机延迟的展开宽度（团块+抖动）
  const colSweep = 500; // 单列自底向上扫掠耗时
  const wipe = delaySpan + colSweep; // 主体消散 ~780ms（最后一列扫完）
  const endFade = 160; // 末端全局淡出带宽，避免被强制收尾硬切
  const duration = wipe + 220; // 总时长 ~1000ms（含粒子收尾飘散）

  // ---- 粒子覆盖层 canvas ----
  const canvas = document.createElement("canvas");
  canvas.className = "glow-dissolve-canvas";
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  canvas.style.position = "fixed";
  canvas.style.left = "0";
  canvas.style.top = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.zIndex = "2147483647";
  canvas.style.pointerEvents = "none";
  canvas.style.transform = "translateZ(0)";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    finishEarly();
    return () => {};
  }
  ctx.scale(dpr, dpr);

  // ---- 冷色辉光精灵：白 / 淡蓝 / 淡紫（亮核 + 外晕）----
  const SS = 16;
  const makeGlow = (stops: [number, string][]): HTMLCanvasElement => {
    const c = document.createElement("canvas");
    c.width = SS;
    c.height = SS;
    const sctx = c.getContext("2d");
    if (sctx) {
      const g = sctx.createRadialGradient(SS / 2, SS / 2, 0, SS / 2, SS / 2, SS / 2);
      for (const [pos, col] of stops) g.addColorStop(pos, col);
      sctx.fillStyle = g;
      sctx.fillRect(0, 0, SS, SS);
    }
    return c;
  };
  const sprites = [
    makeGlow([
      [0, "rgba(255,255,255,1)"],
      [0.35, "rgba(226,242,255,0.85)"],
      [1, "rgba(200,230,255,0)"],
    ]),
    makeGlow([
      [0, "rgba(214,240,255,1)"],
      [0.35, "rgba(79,195,247,0.8)"],
      [1, "rgba(79,195,247,0)"],
    ]),
    makeGlow([
      [0, "rgba(240,226,255,1)"],
      [0.35, "rgba(179,157,219,0.8)"],
      [1, "rgba(179,157,219,0)"],
    ]),
  ];

  // ---- 消散前沿：按列采样，列间不规则推进（±150ms 延迟团块 + 抖动）----
  const N = 48; // 列采样数（前沿细腻度）
  const margin = 30; // 扫出顶部的余量
  const edgeX = new Float32Array(N + 1);
  const t0 = new Float32Array(N + 1); // 各列开始消散的时刻
  const prevEdgeY = new Float32Array(N + 1);
  const spawnAcc = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) {
    edgeX[i] = (i / N) * w;
    const clump = valueNoise1(i * 0.32, 57) * delaySpan; // 平滑团块 0..delaySpan
    const jit = (hash2(i, 91) * 2 - 1) * 22; // 细碎抖动 ±22ms
    t0[i] = Math.max(0, Math.min(delaySpan, clump + jit));
    prevEdgeY[i] = h;
    spawnAcc[i] = 0;
  }
  const edgeYAt = (i: number, age: number): number => {
    let p = (age - t0[i]) / colSweep;
    if (p < 0) p = 0;
    else if (p > 1) p = 1;
    return h - p * (h + margin); // 从底部 h 上移到 -margin
  };

  // ---- 方向区域：~65px 一区，每区基础飘散角（垂直向上 ±20°，扇形外扩 + 噪声错落）----
  const regionW = 65;
  const numRegions = Math.max(2, Math.round(w / regionW));
  const regionAngle = new Float32Array(numRegions); // 弧度，相对垂直向上
  const fanMax = (13 * Math.PI) / 180;
  const noiseMax = (9 * Math.PI) / 180;
  for (let r = 0; r < numRegions; r++) {
    const fan = ((r / (numRegions - 1)) - 0.5) * 2 * fanMax; // 左区负(左飘)、右区正(右飘)
    const noise = (valueNoise1(r * 0.9 + 13.7, 83) * 2 - 1) * noiseMax;
    regionAngle[r] = fan + noise;
  }
  const angleAt = (x: number): number => {
    let r = Math.floor(x / regionW);
    if (r < 0) r = 0;
    else if (r >= numRegions) r = numRegions - 1;
    return regionAngle[r];
  };

  // ---- 粒子池（SoA + swap-remove）----
  const totalTarget = Math.round(200 + density * 200); // 200 ~ 400
  const maxP = totalTarget + 64;
  const px = new Float32Array(maxP);
  const py = new Float32Array(maxP);
  const pang = new Float32Array(maxP); // 飘散角（弧度，相对垂直向上）
  const pv0 = new Float32Array(maxP); // 初速 px/s
  const pv1 = new Float32Array(maxP); // 末速 px/s
  const plife = new Float32Array(maxP);
  const page = new Float32Array(maxP);
  const psize = new Float32Array(maxP);
  const pseed = new Float32Array(maxP);
  const pcol = new Uint8Array(maxP); // 0 白 / 1 蓝 / 2 紫
  let pcount = 0;
  const totalMovement = (N + 1) * (h + margin); // 全部列扫完的累计位移
  const emitRatio = totalTarget / totalMovement; // 每像素位移发射的粒子数

  // 在前沿 (x,y) 生成一粒发光微粒；age 用于把寿命夹到收尾窗口内，避免被强制收尾硬切。
  const spawn = (x: number, y: number, age: number): void => {
    if (pcount >= maxP) return;
    let life = 520 + Math.random() * 300;
    const fit = duration - age - 40; // 距离强制收尾的余量
    if (fit < 120) return; // 太晚生成会直接被切，跳过
    if (life > fit) life = fit;
    const i = pcount++;
    px[i] = x + (Math.random() - 0.5) * (w / N);
    py[i] = y + (Math.random() - 0.5) * 4;
    pang[i] = angleAt(x) + (Math.random() - 0.5) * ((12 * Math.PI) / 180); // 区域内 ±6° 抖动
    const rv = () => 0.8 + Math.random() * 0.4; // ±20% 随机差异
    pv0[i] = (150 + Math.random() * 100) * rv(); // 初速 150-250 ±20%
    pv1[i] = (400 + Math.random() * 200) * rv(); // 末速 400-600 ±20%
    plife[i] = life;
    page[i] = 0;
    psize[i] = 2 + Math.random() * 3; // 亮核 2-5px
    pseed[i] = Math.random() * Math.PI * 2;
    const cr = Math.random();
    pcol[i] = cr < 0.45 ? 0 : cr < 0.85 ? 1 : 2; // 白居多，其次蓝，少量紫
  };

  // ---- 便签本体：进入动画态 ----
  try {
    root.style.clipPath = "";
    root.style.boxShadow = "none";
  } catch {
    /* ignore */
  }

  // ---- 帧循环 ----
  let start = 0;
  let started = false;
  let prevNow = 0;
  let lastPaint = 0;
  let endedLocal = false;
  let watchdog = 0;

  const stopLoop = () => {
    endedLocal = true;
    cancelAnimationFrame(rafId);
    if (backupId) {
      window.clearInterval(backupId);
      backupId = 0;
    }
    if (watchdog) {
      window.clearTimeout(watchdog);
      watchdog = 0;
    }
  };

  function finishEarly(): void {
    // 无法渲染时直接收尾：隐藏窗口（契约同 flame）
    stopLoop();
    blankRoot(root);
    onDone();
  }

  const cleanupAfterHide = () => {
    stopLoop();
    blankRoot(root); // 保持“空画面”供下次呼出
    try {
      canvas.remove();
    } catch {
      /* ignore */
    }
    glowing = false;
  };

  const frame = (now: number) => {
    if (!started) {
      started = true;
      start = now;
      prevNow = now;
    }
    const dt = Math.min(0.05, Math.max(0.001, (now - prevNow) / 1000));
    prevNow = now;
    const age = now - start;

    // ---- 推进前沿 + 按位移生成粒子 + 更新 clip-path ----
    let poly = "0px 0px," + w.toFixed(1) + "px 0px";
    for (let i = N; i >=0; i--) {
      const ey = edgeYAt(i, age);
      const move = prevEdgeY[i] - ey; // 上移 = y 减小
      if (move > 0 && age < wipe) {
        spawnAcc[i] += move * emitRatio;
        while (spawnAcc[i] >= 1) {
          spawnAcc[i] -= 1;
          spawn(edgeX[i], ey, age);
        }
      }
      prevEdgeY[i] = ey;
      poly += "," + edgeX[i].toFixed(1) + "px " + ey.toFixed(1) + "px";
    }
    try {
      root.style.clipPath = "polygon(" + poly + ")";
    } catch {
      /* ignore */
    }

    // ---- 粒子：更新 + 绘制（additive 辉光）----
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    const globalFade = age > duration - endFade ? Math.max(0, (duration - age) / endFade) : 1;
    for (let i = 0; i < pcount; i++) {
      const a = page[i] + dt * 1000;
      page[i] = a;
      const life = plife[i];
      const u = a / life;
      if (u >= 1) {
        // swap-remove
        const last = --pcount;
        if (i !== last) {
          px[i] = px[last]; py[i] = py[last]; pang[i] = pang[last];
          pv0[i] = pv0[last]; pv1[i] = pv1[last]; plife[i] = plife[last];
          page[i] = page[last]; psize[i] = psize[last]; pseed[i] = pseed[last];
          pcol[i] = pcol[last];
        }
        i--;
        continue;
      }
      // ease-in-quad 柔和加速：v0 → v1
      const speed = pv0[i] + (pv1[i] - pv0[i]) * u * u;
      const dx = Math.sin(pang[i]);
      const dy = -Math.cos(pang[i]); // 向上为负 y
      const sway = Math.sin(age * 0.005 + pseed[i]) * 16; // 极轻微左右呼吸摆动
      px[i] += (dx * speed + sway) * dt;
      py[i] += dy * speed * dt;
      const alpha = Math.pow(1 - u, 1.25) * globalFade; // 边升边变淡
      if (alpha < 0.02) continue;
      const haloR = psize[i] * (1 - u * 0.25) * 2.4; // 亮核 + 外晕，略随生命收缩
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprites[pcol[i]], px[i] - haloR, py[i] - haloR, haloR * 2, haloR * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    if (age >= duration) {
      ctx.clearRect(0, 0, w, h);
      stopLoop();
      try {
        onDone(); // 触发真正隐藏窗口
      } finally {
        window.setTimeout(cleanupAfterHide, 400);
      }
    }
  };

  const step = (now: number) => {
    lastPaint = now;
    frame(now);
    if (!endedLocal) rafId = requestAnimationFrame(step);
  };

  rafId = requestAnimationFrame(step);
  backupId = window.setInterval(() => {
    if (endedLocal) return;
    const now = performance.now();
    if (now - lastPaint > 60) {
      lastPaint = now;
      frame(now);
    }
  }, 40);

  // 看门狗：无论循环是否推进，到时强制收尾（隐藏窗口），杜绝动画卡死导致无法关闭。
  watchdog = window.setTimeout(() => {
    if (endedLocal) return;
    stopLoop();
    cleanupAfterHide();
    onDone();
  }, duration + 600);

  // 返回“立即中止”句柄（cancelGlowDissolve 调用）：停帧、移除覆盖层、复原页面样式。
  return () => {
    stopLoop();
    restoreRoot(root);
    try {
      canvas.remove();
    } catch {
      /* ignore */
    }
  };
}
