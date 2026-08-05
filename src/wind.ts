// 便签「侧风吹散 / 侧风成形」粒子动画（与 dissolve.ts / summon.ts 平行的第三种风格）
// ----------------------------------------------------------------------------
// 触发场景与 dissolve/summon 完全对应，由设置项 particle_mode = "wind" 启用：
//   - 关闭便签（标题栏关闭 / “全部关闭”）→ requestParticleWindClose（侧风吹散）
//   - 呼出便签（托盘 / 快捷键 / 历史打开）→ playWindMaterialize（侧风成形）
//
// 效果：一条竖直的波浪形“风幕”从源侧（左或右，每次随机）横扫整张便签：
//   - 吹散（关闭）：风幕所到之处便签被“吃”掉，粒子从风幕边缘升起，被强水平风
//     吹向目标侧、边飘边淡出，像被风卷走；
//   - 成形（呼出）：风幕从源侧扫向目标侧，所过之处便签逐段显现，粒子从源侧吹入、
//     落定，便签在风幕后方完整呈现。
// 两个动画互为时间倒放，与火焰模式（上→下竖扫）在视觉上正交（水平横扫）。
//
// 实现（性能与 dissolve 完全一致的优化基线）：
// - 粒子数据 Float32Array（SoA）；流场网格 flat Float32Array；内联流动场与双线性
//   插值，零逐帧对象分配；age 由 dt 累积（帧慢时慢放而非冻结后消失）。
// - 主风：水平方向（按 dir 定向，+1 向右 / -1 向左）叠加阵性 gust 与 curl 扰动，
//   再加整体上飘；粒子在真实桌面上飘散（透明窗口透出背景）。
// - 窗口隐藏后保持“空画面”，呼出时从空开始，不闪旧内容（同 dissolve/summon）。

let windClosing = false;   // 关闭动画进行中
let windSummoning = false; // 呼出动画进行中
let windRafId = 0;
let windBackupId = 0;

const CLS = "wind-canvas";

/** 立即结束在播的「侧风成形」呼出动画并复原页面（关闭动画开始前调用，避免两个动画同时改 clip-path）。 */
export function cancelWind(): void {
  if (!windSummoning) return;
  windSummoning = false;
  cancelAnimationFrame(windRafId);
  if (windBackupId) {
    window.clearInterval(windBackupId);
    windBackupId = 0;
  }
  const root = document.querySelector(".note-window") as HTMLElement | null;
  if (root) {
    root.style.clipPath = "";
    root.style.boxShadow = "";
    root.style.opacity = "";
  }
  document.querySelector("." + CLS)?.remove();
}

// ---- 风场（火焰流场思想 + 强水平主风）----
// curl 项复用 dissolve 的势场散度为零结构（粒子不堆积）；主风 dir 恒定，
// 故 dir 直接折叠进网格计算（gvx 已是带方向的风速），无需逐粒判断方向。
const FLOW_A1 = 3200;
const FLOW_A2 = 1500;
const FLOW_AX1 = 0.009;
const FLOW_BY1 = 0.011;
const FLOW_W1 = 0.5;
const FLOW_AX2 = 0.017;
const FLOW_BY2 = 0.008;
const FLOW_W2 = 0.35;
const WIND_X = 175;  // 基础水平风速 px/s（按 dir 定向）
const WIND_UP = 52;  // 整体上飘 px/s

interface WindCfg {
  root: HTMLElement;
  density: number;
  dir: number;       // +1 = 风向右吹（源在左）；-1 = 风向左吹（源在右）
  isClose: boolean;  // true=吹散(关闭) / false=成形(呼出)
  onDone?: () => void; // 关闭动画结束回调（真正关闭窗口）
}

/** 播放侧风粒子动画（关闭/呼出共用核心）。 */
function playWind(cfg: WindCfg): void {
  const { root, density, dir, isClose, onDone } = cfg;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;

  // 全窗口覆盖层 canvas（最顶，逐帧重画“裁剪区描边 + 粒子”）
  const canvas = document.createElement("canvas");
  canvas.className = CLS;
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
    if (isClose) { windClosing = false; onDone?.(); }
    else { windSummoning = false; restorePage(root); }
    return;
  }
  ctx.scale(dpr, dpr);

  root.style.boxShadow = "none";
  const noteRadius = parseFloat(getComputedStyle(root).borderRadius) || 14;

  // 预渲染白色柔光细点精灵（与 dissolve 同一套）
  const SS = 8;
  const sprite = document.createElement("canvas");
  sprite.width = SS;
  sprite.height = SS;
  {
    const sctx = sprite.getContext("2d");
    if (sctx) {
      const g = sctx.createRadialGradient(SS / 2, SS / 2, 0, SS / 2, SS / 2, SS / 2);
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.3, "rgba(255,255,255,0.65)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      sctx.fillStyle = g;
      sctx.fillRect(0, 0, SS, SS);
    }
  }

  // ---- 竖直风幕：波浪形竖边，从源侧扫向目标侧 ----
  const wipeDuration = 360; // 横扫全页用时 ms
  const duration = 1000;    // 总时长 ms（横扫 + 粒子飘散收尾）

  const EDGE_N = 22;  // 风幕竖直方向采样点数（波浪细腻度）
  const waveAmp = 12; // 主波幅度 px（沿竖直方向起伏）
  const waveAmp2 = 6; // 次波幅度 px
  const span = w + 14;
  function edgeXAt(y: number, age: number): number {
    const prog = Math.min(1, age / wipeDuration);
    const ampIn = Math.min(1, age / 90);
    // 基准：dir=+1 从 -7 扫到 w+7（左→右）；dir=-1 从 w+7 扫到 -7（右→左）
    const base = dir === 1 ? -7 + prog * span : w + 7 - prog * span;
    const wave =
      waveAmp * Math.sin((y / h) * Math.PI * 2.2 + age * 0.013) +
      waveAmp2 * Math.sin((y / h) * Math.PI * 4.7 + age * 0.019 + 1.3);
    return base + wave * ampIn;
  }

  // 保留侧：关闭时保留“目标侧”（被从源侧吃掉）；呼出时保留“源侧”（从源侧成形）。
  // (dir===1)===isClose → 右；否则 → 左
  const keep: "left" | "right" = (dir === 1) === isClose ? "right" : "left";

  // ---- 粒子：网格预铺满整张便签（带抖动）----
  const dc = Math.max(0, Math.min(100, density)) / 100;
  const MAX_COUNT = Math.round(500 + dc * 7500);
  const spacing = Math.max(5, Math.sqrt((w * h) / MAX_COUNT));
  const countX = Math.ceil(w / spacing);
  const countY = Math.ceil(h / spacing);
  const pcount = countX * countY;

  const px = new Float32Array(pcount);
  const py = new Float32Array(pcount);
  const pspawnT = new Float32Array(pcount);
  const plife = new Float32Array(pcount);
  const priseMul = new Float32Array(pcount);
  const pjitX = new Float32Array(pcount);
  const pjitY = new Float32Array(pcount);
  const pphase = new Float32Array(pcount);
  const pr = new Float32Array(pcount);
  const palpha = new Float32Array(pcount);

  let pi = 0;
  for (let iy = 0; iy < countY; iy++) {
    const y = (iy + 0.5 + (Math.random() - 0.5) * 0.8) * spacing;
    for (let ix = 0; ix < countX; ix++) {
      const x = (ix + 0.5 + (Math.random() - 0.5) * 0.8) * spacing;
      // 该列被风幕扫到的时刻（与 edgeXAt 同构）：dir=+1 左列先、dir=-1 右列先
      const t0 = (dir === 1 ? x / w : (w - x) / w) * wipeDuration;
      px[pi] = x;
      py[pi] = y;
      pspawnT[pi] = Math.min(wipeDuration - 1, Math.max(0, t0));
      plife[pi] = (duration - pspawnT[pi]) * (0.8 + Math.random() * 0.2);
      priseMul[pi] = 0.9 + Math.random() * 0.2;
      pjitX[pi] = (Math.random() - 0.5) * 8;
      pjitY[pi] = (Math.random() - 0.5) * 8;
      pphase[pi] = Math.random() * Math.PI * 2;
      pr[pi] = 0.9 + Math.random() * 0.9;
      palpha[pi] = 0.4 + Math.random() * 0.35;
      pi++;
    }
  }

  // ---- 帧状态 ----
  let ended = false;
  let prevNow = performance.now();
  // age 由 dt 累积（而非 now-start 真实时间）：帧慢时动画慢放而非冻结后瞬间消失
  let ageAccum = 0;

  const stopLoop = () => {
    ended = true;
    cancelAnimationFrame(windRafId);
    if (windBackupId) {
      window.clearInterval(windBackupId);
      windBackupId = 0;
    }
  };

  function restorePage(r: HTMLElement): void {
    try {
      r.style.clipPath = "";
      r.style.boxShadow = "";
      r.style.opacity = "";
    } catch { /* ignore */ }
    try { canvas.remove(); } catch { /* ignore */ }
  }

  // 粒子透明度分桶：预分配容量 + bucketLens 跟踪长度
  const ALPHA_BUCKETS = 16;
  const buckets: number[][] = Array.from({ length: ALPHA_BUCKETS }, () => new Array(pcount));
  const bucketLens = new Int32Array(ALPHA_BUCKETS);

  // 风幕 X 采样位置（每帧不变），逐帧只算 X 值
  const edgeYy: number[] = new Array(EDGE_N + 1);
  for (let i = 0; i <= EDGE_N; i++) edgeYy[i] = (i / EDGE_N) * h;
  const edgeXs: number[] = new Array(EDGE_N + 1);

  // 流场网格：flat Float32Array（dir 已折入 gvx）
  const CELL = 40;
  const GX = Math.ceil(w / CELL) + 1;
  const GY = Math.ceil(h / CELL) + 1;
  const gvx = new Float32Array(GX * GY);
  const gvy = new Float32Array(GX * GY);
  const GXm2 = GX - 2;
  const GYm2 = GY - 2;

  /** 把保留区域（风幕 + 角点）写入 ctx 路径（用于边框描边裁剪） */
  const traceKeep = (edgeXvals: number[]) => {
    const N = EDGE_N;
    ctx.beginPath();
    if (keep === "right") {
      ctx.moveTo(edgeXvals[0], 0);
      for (let i = 1; i <= N; i++) ctx.lineTo(edgeXvals[i], edgeYy[i]);
      ctx.lineTo(w, h);
      ctx.lineTo(w, 0);
    } else {
      ctx.moveTo(0, 0);
      ctx.lineTo(0, h);
      for (let i = N; i >= 0; i--) ctx.lineTo(edgeXvals[i], edgeYy[i]);
    }
    ctx.closePath();
  };

  const frame = (now: number) => {
    const dt = Math.min(0.05, Math.max(0.001, (now - prevNow) / 1000));
    prevNow = now;
    ageAccum += dt * 1000;
    const age = ageAccum;

    // 采样风幕 X
    for (let i = 0; i <= EDGE_N; i++) edgeXs[i] = edgeXAt(edgeYy[i], age);

    // 页面本体：clip-path 保留 keep 侧
    const cssPts: string[] = [];
    if (keep === "right") {
      for (let i = 0; i <= EDGE_N; i++) cssPts.push(`${edgeXs[i].toFixed(1)}px ${edgeYy[i].toFixed(1)}px`);
      cssPts.push(`${w}px ${h}px`, `${w}px 0px`);
    } else {
      cssPts.push("0px 0px", `0px ${h}px`);
      for (let i = EDGE_N; i >= 0; i--) cssPts.push(`${edgeXs[i].toFixed(1)}px ${edgeYy[i].toFixed(1)}px`);
    }
    root.style.clipPath = `polygon(${cssPts.join(", ")})`;

    ctx.clearRect(0, 0, w, h);

    // 边框环：只在横扫进行中绘制（随风幕逐段出现/消失）
    if (age < wipeDuration) {
      ctx.save();
      traceKeep(edgeXs);
      ctx.clip();
      ctx.strokeStyle = "rgba(0, 0, 0, 0.05)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") ctx.roundRect(0.5, 0.5, w - 1, h - 1, noteRadius);
      else ctx.rect(0.5, 0.5, w - 1, h - 1);
      ctx.stroke();
      ctx.restore();
    }

    // ---- 粒子：风场网格（内联，dir 折叠进 gvx）+ 分桶 ----
    const u = age / 1000;
    for (let gy = 0; gy < GY; gy++) {
      const yy = gy * CELL;
      const rowBase = gy * GX;
      for (let gx = 0; gx < GX; gx++) {
        const xx = gx * CELL;
        const c1 = Math.cos(FLOW_AX1 * xx + FLOW_BY1 * yy + u * FLOW_W1);
        const c2 = Math.cos(FLOW_AX2 * xx + FLOW_BY2 * yy + u * FLOW_W2 + 1.3);
        const idx = rowBase + gx;
        const curlX = FLOW_A1 * FLOW_BY1 * c1 + FLOW_A2 * FLOW_BY2 * c2;
        const curlY = -(FLOW_A1 * FLOW_AX1 * c1 + FLOW_A2 * FLOW_AX2 * c2);
        const gust = 35 + 25 * Math.sin(yy * 0.012 + u * 0.9);
        gvx[idx] = dir * (WIND_X + gust) + curlX * 0.35;
        gvy[idx] = curlY * 0.35 - (WIND_UP + 12 * Math.sin(xx * 0.006 + u * 0.6));
      }
    }

    bucketLens.fill(0);
    for (let i = 0; i < pcount; i++) {
      const spawnT = pspawnT[i];
      if (age < spawnT) continue;
      const pa = age - spawnT;
      const life = plife[i];
      if (pa > life) continue;
      const life01 = pa / life;

      const fgx = px[i] / CELL;
      const fgy = py[i] / CELL;
      let ix = fgx | 0;
      let iy = fgy | 0;
      if (ix < 0) ix = 0; else if (ix > GXm2) ix = GXm2;
      if (iy < 0) iy = 0; else if (iy > GYm2) iy = GYm2;
      const sfx = fgx - ix, sfy = fgy - iy;
      const ifx = 1 - sfx, ify = 1 - sfy;
      const idx = iy * GX + ix;
      const vx = ifx * ify * gvx[idx] + sfx * ify * gvx[idx + 1] + ifx * sfy * gvx[idx + GX] + sfx * sfy * gvx[idx + GX + 1];
      const vy = ifx * ify * gvy[idx] + sfx * ify * gvy[idx + 1] + ifx * sfy * gvy[idx + GX] + sfx * sfy * gvy[idx + GX + 1];

      const rm = priseMul[i];
      px[i] += (vx * rm + pjitX[i]) * dt;
      py[i] += (vy * rm + pjitY[i]) * dt;

      const fadeIn = pa < 60 ? pa * 0.016666667 : 1;
      const fadeOut = (1 - life01) * (1 - life01);
      const flicker = 0.82 + 0.18 * Math.sin(pa * 0.012 + pphase[i]);
      const a = palpha[i] * fadeIn * fadeOut * flicker;
      if (a < 0.025) continue;
      let bi = (a * ALPHA_BUCKETS) | 0;
      if (bi >= ALPHA_BUCKETS) bi = ALPHA_BUCKETS - 1;
      buckets[bi][bucketLens[bi]++] = i;
    }
    for (let bi = 0; bi < ALPHA_BUCKETS; bi++) {
      const len = bucketLens[bi];
      if (len === 0) continue;
      ctx.globalAlpha = (bi + 0.5) / ALPHA_BUCKETS;
      const list = buckets[bi];
      for (let k = 0; k < len; k++) {
        const i = list[k];
        const r = pr[i];
        ctx.drawImage(sprite, px[i] - r, py[i] - r, r * 2, r * 2);
      }
    }
    ctx.globalAlpha = 1;

    if (age >= duration) {
      ctx.clearRect(0, 0, w, h);
      stopLoop();
      if (isClose) {
        windClosing = false;
        onDone?.();
      } else {
        windSummoning = false;
        restorePage(root);
      }
      return;
    }
  };

  // 帧驱动：rAF 链 + 40ms 备用计时器兜底（备用路径只推帧、不排程 rAF，
  // 避免渲染队列膨胀成“卡住后瞬间消失”）
  const step = (now: number) => {
    lastPaint = now;
    frame(now);
    if (!ended) windRafId = requestAnimationFrame(step);
  };
  let lastPaint = performance.now();
  windRafId = requestAnimationFrame(step);
  windBackupId = window.setInterval(() => {
    if (ended) return;
    const now = performance.now();
    if (now - lastPaint > 60) {
      lastPaint = now;
      frame(now);
    }
  }, 40);
}

/** 请求播放侧风吹散关闭动画；onDone 在动画完全结束后调用（用于真正关闭窗口）。
 * 方向（左/右）每次随机。 */
export function requestParticleWindClose(onDone: () => void, density = 50): void {
  const root = document.querySelector(".note-window") as HTMLElement | null;
  if (!root || windClosing) {
    onDone();
    return;
  }
  windClosing = true;
  let done = false;
  const safeDone = () => {
    if (done) return;
    done = true;
    windClosing = false;
    onDone();
  };
  const watchdog = window.setTimeout(safeDone, 3500);

  const bringToFront = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      try { await win.setFocus(); } catch { /* ignore */ }
    } catch { /* ignore */ }
  };

  const dir = Math.random() < 0.5 ? -1 : 1;
  bringToFront().catch(() => {}).finally(() => {
    try {
      playWind({ root, density, dir, isClose: true, onDone: () => { window.clearTimeout(watchdog); safeDone(); } });
    } catch (e) {
      console.error("侧风吹散动画异常:", e);
      window.clearTimeout(watchdog);
      safeDone();
    }
  });
}

/** 播放侧风成形呼出动画；动画收尾时自动复原页面（无需 onDone）。方向（左/右）每次随机。 */
export function playWindMaterialize(root: HTMLElement, density = 50): void {
  if (windSummoning) return;
  windSummoning = true;
  const dir = Math.random() < 0.5 ? -1 : 1;
  try {
    playWind({ root, density, dir, isClose: false });
  } catch (e) {
    console.error("侧风成形动画异常:", e);
    windSummoning = false;
    try {
      root.style.clipPath = "";
      root.style.boxShadow = "";
      root.style.opacity = "";
    } catch { /* ignore */ }
    document.querySelector("." + CLS)?.remove();
  }
}
