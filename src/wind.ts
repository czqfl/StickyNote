// 便签「侧风吹散 / 侧风成形」粒子动画（与 dissolve.ts / summon.ts 平行的第三种风格）
// ----------------------------------------------------------------------------
// 触发场景与 dissolve/summon 完全对应，由设置项 particle_mode = "wind" 启用：
//   - 关闭便签（标题栏关闭 / “全部关闭”）→ requestParticleWindClose（侧风吹散）
//   - 呼出便签（托盘 / 快捷键 / 历史打开）→ playWindMaterialize（侧风成形）
//
// 效果：从最左或最右侧（每次随机）某一点发起——以该点为圆心，一个圆形“啃食”区域
// 向外扩散，把便签从这一点开始向四周“吹散”；粒子按到圆心距离先后激活，沿径向 + 水平风
// 向外飞散，并随速度方向被拉伸成“风丝”（被风吹变形的效果），边飘边淡出。呼出为其时间
// 倒放：圆形区域从覆盖全页收缩回该点，便签从四周向该点聚拢成形。
//
// 与火焰模式（上→下 / 下→上 单向竖扫）的区别：本模式是“从边缘某点向四周径向爆散”，
// 粒子有方向性拉伸（风丝），视觉更“被风卷走”而非“被一条线扫过”。
//
// 实现（性能与 dissolve 一致优化基线）：
// - 粒子数据 Float32Array（SoA）；流场网格 flat Float32Array；内联流场与双线性插值，
//   零逐帧对象分配；age 由 dt 累积（帧慢时慢放而非冻结后瞬间消失）。
// - 风场为“以圆心 P 为中心的径向场 + 水平风偏 + curl 扰动”，逐格预计算后双线性插值取用。
// - 粒子绘制：按速度方向旋转 + 沿运动方向拉伸（风丝），近似被风吹变形。
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

// ---- 风场（以圆心 P 为中心的径向场 + 水平风偏 + curl 扰动）----
const FLOW_A1 = 3200;
const FLOW_A2 = 1500;
const FLOW_AX1 = 0.009;
const FLOW_BY1 = 0.011;
const FLOW_W1 = 0.5;
const FLOW_AX2 = 0.017;
const FLOW_BY2 = 0.008;
const FLOW_W2 = 0.35;
const WIND_BASE = 155; // 径向基础速度 px/s（离圆心越近越快）
const WIND_W = 95;    // 水平风偏强度 px/s（按 dir 定向，把粒子吹离源侧）
const WIND_UP = 40;   // 整体上飘 px/s

interface WindCfg {
  root: HTMLElement;
  density: number;
  dir: number;        // +1 = 源在左缘（0, y0）；-1 = 源在右缘（w, y0）
  y0: number;         // 源点纵坐标（最左/最右侧上的“某点”）
  isClose: boolean;   // true=吹散(关闭) / false=成形(呼出)
  onDone?: () => void; // 关闭动画结束回调（真正关闭窗口）
}

/** 生成“保留区域”多边形（便签矩形减去以 P 为圆心、R 为半径的圆盘）。
 * 因 P 在边缘，被啃掉的是探入便签内的半圆盘。返回 [x,y] 点序列（顺时针）。 */
function radialClip(Px: number, Py: number, R: number, w: number, h: number, dir: number): [number, number][] {
  if (R <= 0.5) return [[0, 0], [w, 0], [w, h], [0, h]]; // 无啃食 → 整窗
  const pts: [number, number][] = [[w, 0], [0, 0]];
  const N = 18;
  const sgn = dir === 1 ? 1 : -1; // 左缘向 +x 鼓、右缘向 -x 鼓
  for (let i = 0; i <= N; i++) {
    const th = -Math.PI / 2 + Math.PI * (i / N); // -90° → +90°
    let x = Px + sgn * R * Math.cos(th);
    let y = Py + R * Math.sin(th);
    if (x < 0) x = 0; else if (x > w) x = w;
    if (y < 0) y = 0; else if (y > h) y = h;
    pts.push([x, y]);
  }
  pts.push([0, h], [w, h]);
  return pts;
}

/** 播放侧风粒子动画（关闭/呼出共用核心）。 */
function playWind(cfg: WindCfg): void {
  const { root, density, dir, y0, isClose, onDone } = cfg;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;

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

  // 预渲染白色柔光细点精灵（与 dissolve 同一套；拉伸后呈风丝）
  const SS = 8;
  const sprite = document.createElement("canvas");
  sprite.width = SS;
  sprite.height = SS;
  {
    const sctx = sprite.getContext("2d");
    if (sctx) {
      const g = sctx.createRadialGradient(SS / 2, SS / 2, 0, SS / 2, SS / 2, SS / 2);
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.3, "rgba(255,255,255,0.7)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      sctx.fillStyle = g;
      sctx.fillRect(0, 0, SS, SS);
    }
  }

  // ---- 圆心 P（最左/最右侧上的“某点”）----
  const Px = dir === 1 ? 0 : w;
  const Py = y0;
  const maxR = Math.hypot(Math.max(Px, w - Px), Math.max(Py, h - Py)); // 到最远角距离
  const RMARGIN = 14;

  // ---- 圆形“啃食”区扩散 ----
  const wipeDuration = 420; // 圆盘从 P 扩到覆盖全页（或反之为收缩）的用时 ms
  const duration = 1100;   // 总时长 ms（扩散 + 粒子飘散收尾）

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
  const pang = new Float32Array(pcount);     // 变形角度（激活时按初速度方向定，固定）
  const pstretch = new Float32Array(pcount); // 变形拉伸比（固定）

  let pi = 0;
  for (let iy = 0; iy < countY; iy++) {
    const y = (iy + 0.5 + (Math.random() - 0.5) * 0.8) * spacing;
    for (let ix = 0; ix < countX; ix++) {
      const x = (ix + 0.5 + (Math.random() - 0.5) * 0.8) * spacing;
      const dx = x - Px;
      const dy = y - Py;
      const d = Math.hypot(dx, dy) || 1e-3;
      const ux = dx / d, uy = dy / d;
      // 径向速度（近圆心更快）+ 水平风偏（把粒子吹离源侧）+ 上飘
      const radial = WIND_BASE * (0.45 + 0.95 * (1 - Math.min(1, d / maxR)));
      const vx0 = ux * radial + dir * WIND_W;
      const vy0 = uy * radial - WIND_UP;
      const speed = Math.hypot(vx0, vy0);
      px[pi] = x;
      py[pi] = y;
      // 激活时机：关闭=近圆心先、远后；呼出=远先、近后（与圆形区扩散同步）
      const f = Math.min(1, d / maxR);
      pspawnT[pi] = isClose
        ? f * wipeDuration
        : Math.max(0, Math.min(wipeDuration - 1, (1 - f) * wipeDuration));
      plife[pi] = (duration - pspawnT[pi]) * (0.8 + Math.random() * 0.2);
      priseMul[pi] = 0.9 + Math.random() * 0.2;
      pjitX[pi] = (Math.random() - 0.5) * 8;
      pjitY[pi] = (Math.random() - 0.5) * 8;
      pphase[pi] = Math.random() * Math.PI * 2;
      pr[pi] = 0.9 + Math.random() * 0.7;
      palpha[pi] = 0.45 + Math.random() * 0.4;
      pang[pi] = Math.atan2(vy0, vx0);
      pstretch[pi] = Math.min(3.2, 1 + speed * 0.011);
      pi++;
    }
  }

  // ---- 帧状态 ----
  let ended = false;
  let prevNow = performance.now();
  let ageAccum = 0; // age 由 dt 累积（帧慢时慢放而非冻结后瞬间消失）

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

  // 风场网格：flat Float32Array（每帧按“圆心径向场 + 风偏 + curl”刷新）
  const CELL = 40;
  const GX = Math.ceil(w / CELL) + 1;
  const GY = Math.ceil(h / CELL) + 1;
  const gvx = new Float32Array(GX * GY);
  const gvy = new Float32Array(GX * GY);
  const GXm2 = GX - 2;
  const GYm2 = GY - 2;

  const frame = (now: number) => {
    const dt = Math.min(0.05, Math.max(0.001, (now - prevNow) / 1000));
    prevNow = now;
    ageAccum += dt * 1000;
    const age = ageAccum;
    const prog = Math.min(1, age / wipeDuration);

    // 圆形“啃食”区半径：关闭=从 0 扩到覆盖全页；呼出=从覆盖全页缩回 0
    const R = (isClose ? prog : 1 - prog) * (maxR + RMARGIN);
    const pts = radialClip(Px, Py, R, w, h, dir);
    root.style.clipPath = `polygon(${pts.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(", ")})`;

    ctx.clearRect(0, 0, w, h);

    // 边框环：只在扩散进行中绘制（随风丝区域逐段出现/消失）
    if (age < wipeDuration) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.clip();
      ctx.strokeStyle = "rgba(0, 0, 0, 0.05)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") ctx.roundRect(0.5, 0.5, w - 1, h - 1, noteRadius);
      else ctx.rect(0.5, 0.5, w - 1, h - 1);
      ctx.stroke();
      ctx.restore();
    }

    // ---- 风场网格刷新（圆心径向场 + 水平风偏 + curl 扰动）----
    const u = age / 1000;
    for (let gy = 0; gy < GY; gy++) {
      const yy = gy * CELL;
      const rowBase = gy * GX;
      for (let gx = 0; gx < GX; gx++) {
        const xx = gx * CELL;
        const dx = xx - Px, dy = yy - Py;
        const d = Math.hypot(dx, dy) + 1e-3;
        const ux = dx / d, uy = dy / d;
        const radial = WIND_BASE * (0.45 + 0.95 * (1 - Math.min(1, d / maxR)));
        const windX = dir * WIND_W * (0.6 + 0.4 * Math.sin(yy * 0.011 + u * 0.6));
        const c1 = Math.cos(FLOW_AX1 * xx + FLOW_BY1 * yy + u * FLOW_W1);
        const c2 = Math.cos(FLOW_AX2 * xx + FLOW_BY2 * yy + u * FLOW_W2 + 1.3);
        const curlX = FLOW_A1 * FLOW_BY1 * c1 + FLOW_A2 * FLOW_BY2 * c2;
        const curlY = -(FLOW_A1 * FLOW_AX1 * c1 + FLOW_A2 * FLOW_AX2 * c2);
        const idx = rowBase + gx;
        gvx[idx] = ux * radial + windX + curlX * 0.3;
        gvy[idx] = uy * radial - WIND_UP + curlY * 0.3;
      }
    }

    // ---- 粒子更新 + 分桶（内联双线性插值）----
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

    // ---- 分桶批量绘制（按透明度分组；按速度方向旋转 + 拉伸为风丝）----
    for (let bi = 0; bi < ALPHA_BUCKETS; bi++) {
      const len = bucketLens[bi];
      if (len === 0) continue;
      ctx.globalAlpha = (bi + 0.5) / ALPHA_BUCKETS;
      const list = buckets[bi];
      for (let k = 0; k < len; k++) {
        const i = list[k];
        const r = pr[i];
        const st = pstretch[i];
        const L = r * 2 * st;   // 沿运动方向拉长
        const T = r * 2 / st;   // 垂直方向压扁 → 风丝
        ctx.save();
        ctx.translate(px[i], py[i]);
        ctx.rotate(pang[i]);
        ctx.drawImage(sprite, -L / 2, -T / 2, L, T);
        ctx.restore();
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
 * 源侧（左/右）与源点纵坐标每次随机。 */
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
  const watchdog = window.setTimeout(safeDone, 4200);

  const bringToFront = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      try { await win.setFocus(); } catch { /* ignore */ }
    } catch { /* ignore */ }
  };

  const dir = Math.random() < 0.5 ? -1 : 1;
  const y0 = window.innerHeight * (0.3 + 0.4 * Math.random());
  bringToFront().catch(() => {}).finally(() => {
    try {
      playWind({ root, density, dir, y0, isClose: true, onDone: () => { window.clearTimeout(watchdog); safeDone(); } });
    } catch (e) {
      console.error("侧风吹散动画异常:", e);
      window.clearTimeout(watchdog);
      safeDone();
    }
  });
}

/** 播放侧风成形呼出动画；动画收尾时自动复原页面（无需 onDone）。源侧（左/右）与源点纵坐标每次随机。 */
export function playWindMaterialize(root: HTMLElement, density = 50): void {
  if (windSummoning) return;
  windSummoning = true;
  const dir = Math.random() < 0.5 ? -1 : 1;
  const y0 = window.innerHeight * (0.3 + 0.4 * Math.random());
  try {
    playWind({ root, density, dir, y0, isClose: false });
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
