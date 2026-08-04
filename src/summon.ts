// 便签呼出动画：粒子成形（关闭动画的倒放）
// ----------------------------------------------------------------------------
// 触发：便签窗口被“呼出”（托盘 / 全局快捷键 / 单实例唤起 / 历史打开）时播放，替代瞬现。
// 效果：整张便签从下到上“粒子成形”——成形线（左右起伏的波浪形边缘）从窗口底边
// 向顶边推进，线以下的便签区域随线上移逐渐显示（内容/边框/底色整体生成），
// 线以上的空白区里细密白色粒子从成形边缘升起、上飘淡出；成形线扫到顶边后便签
// 完整呈现，粒子云再飘散收尾。时长与关闭动画一致（约 0.32s 成形 + 0.6s 粒子）。
//
// 实现：与 dissolve.ts 完全镜像——
// - 页面本体用 clip-path 多边形逐帧裁剪：成形线从底向顶推进，保留“线以下”区域
//   （关闭动画是线从顶向底推进、同样保留线以下区域——两个动画互为时间倒放）；
// - 粒子激活时机 = 该列成形线扫到该行的时刻（提前一点），上飘速度按列渐变，
//   与关闭动画同一套火焰式流场（粒子总是向上飘散，只是成形线方向相反）；
// - 帧循环用 setTimeout(16ms) 驱动（便签窗口处于后台时 rAF 会被系统/浏览器节流，
//   计时器仍能持续推进）；自带看门狗，动画必定收尾，绝不卡在“空画面”。
// - 窗口隐藏后保持“空画面”（见 dissolve.ts cleanup / 托盘隐藏），呼出时 DWM
//   先呈现空帧，本动画从空开始粒子成形，不会闪出旧内容。

let summoning = false;
let rafId = 0;
let backupId = 0;

/** 立即结束呼出动画并复原页面（关闭动画开始前调用，避免两个动画同时改 clip-path）。 */
export function cancelSummon(): void {
  if (!summoning) return;
  summoning = false;
  cancelAnimationFrame(rafId);
  if (backupId) {
    window.clearInterval(backupId);
    backupId = 0;
  }
  const root = document.querySelector(".note-window") as HTMLElement | null;
  if (root) {
    root.style.clipPath = "";
    root.style.boxShadow = "";
    root.style.opacity = "";
  }
  document.querySelector(".summon-canvas")?.remove();
}

interface Particle {
  x: number;
  y: number;
  spawnT: number; // 激活时刻 ms（= 该列成形线扫到该行的时刻；之前不绘制）
  life: number; // 寿命 ms（保证在动画结束前消亡）
  riseMul: number; // 个体微差（0.9~1.1），保持火焰内细微个体差异又不破坏区域整体趋势
  jitX: number; // 个体微抖动 px/s（远小于流场速度，不破坏方向一致性）
  jitY: number;
  phase: number; // 明灭相位
  r: number; // 粒子半径 px（细小）
  alpha: number; // 初始不透明度
}

// 火焰式流场：与 dissolve.ts 同一套实现（粒子总是向上飘散，两个动画方向一致）。
const FLOW_A1 = 3200;
const FLOW_A2 = 1500;
const FLOW_AX1 = 0.009;
const FLOW_BY1 = 0.011;
const FLOW_W1 = 0.5;
const FLOW_AX2 = 0.017;
const FLOW_BY2 = 0.008;
const FLOW_W2 = 0.35;
function flowAt(x: number, y: number, t: number): { vx: number; vy: number } {
  const c1 = Math.cos(FLOW_AX1 * x + FLOW_BY1 * y + t * FLOW_W1);
  const c2 = Math.cos(FLOW_AX2 * x + FLOW_BY2 * y + t * FLOW_W2 + 1.3);
  const vx = FLOW_A1 * FLOW_BY1 * c1 + FLOW_A2 * FLOW_BY2 * c2;
  const vy = -(FLOW_A1 * FLOW_AX1 * c1 + FLOW_A2 * FLOW_AX2 * c2) - (62 + 14 * Math.sin(x * 0.006 + t * 0.6));
  return { vx, vy };
}

/** 播放粒子成形呼出动画；动画收尾时自动复原页面（无需 onDone）。
 * @param particleDensity 粒子强度 0~100（默认 50≈5000 粒，最大 100≈9000 粒） */
export function playSummonMaterialize(root: HTMLElement, particleDensity = 50): void {
  if (summoning) return;
  summoning = true;
  rafId = 0;
  backupId = 0;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;

  // 全窗口覆盖层 canvas（置于最顶；逐帧重画“粒子 + 成形期边框环”）
  const canvas = document.createElement("canvas");
  canvas.className = "summon-canvas";
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  canvas.style.position = "fixed";
  canvas.style.left = "0";
  canvas.style.top = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.zIndex = "2147483647";
  canvas.style.pointerEvents = "none";
  // 提升为独立合成层，避免动画期间页面在 canvas 下方被反复重绘
  canvas.style.transform = "translateZ(0)";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    summoning = false;
    canvas.remove();
    return;
  }
  ctx.scale(dpr, dpr);

  // 初始先进入“整窗不可见”态：成形线在窗口底边之下，线以下区域为空。
  // 隐藏时窗口已保持空画面（dissolve cleanup / 托盘隐藏），此处再设一次，
  // 确保无论上次状态如何，动画都从空画面开始、不闪出旧内容。
  root.style.boxShadow = "none";
  root.style.clipPath = "inset(0 0 100% 0)";
  const noteRadius = parseFloat(getComputedStyle(root).borderRadius) || 14;

  // 预渲染白色柔光细点精灵（径向渐变：中心白 → 边缘快速透明），与关闭动画同一套
  const SS = 8;  // 缩小精灵体积（原 12），降低逐帧填充率
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

  // ---- 成形线：波浪形边缘，从窗口底边向顶边推进 ----
  const wipeDuration = 320; // 成形完成用时 ms（与关闭动画一致）
  const duration = 900; // 总时长 ms（成形 + 粒子飘散收尾）

  // 波浪成形线的纵向位置：基准随进度上移 + 两档频率的正弦起伏 + 抖动
  const EDGE_N = 26; // 采样点数（左右方向的波浪细腻度）
  const waveAmp = 10; // 主波幅度 px
  const waveAmp2 = 5; // 次波幅度 px
  function edgeYAt(x: number, age: number): number {
    const prog = Math.min(1, age / wipeDuration);
    // 幅度随进度渐入，开头不闪现（age=0 时无波浪）
    const ampIn = Math.min(1, age / 90);
    // 成形线基准：底边下方 h+10 → 顶边上方 -10，随进度上移（与关闭动画方向相反）
    const base = h + 10 - prog * (h + 20);
    const wave =
      waveAmp * Math.sin((x / w) * Math.PI * 2.4 + age * 0.011) +
      waveAmp2 * Math.sin((x / w) * Math.PI * 5.1 + age * 0.017 + 1.3);
    return Math.max(-10, Math.min(h + 10, base + wave * ampIn));
  }

  // ---- 粒子：网格预铺满整张便签（带抖动），激活时机 = 所在列成形线扫到该行 ----
  // 线从底向顶推进：底部行先激活（“粒子从最下方开始渐渐显示出来”），
  // 顶部行最后激活；粒子从成形边缘升起、上飘淡出，便签在线下方逐段成形。
  // 粒子数按强度 0~100 二次曲线缩放：50→约 7.5 万、100→约 30 万（上限 10×）。
  // 实际数量还受最小间距约束（3px）：小窗口下由 spacing 决定实际网格数。
  const density = Math.max(0, Math.min(100, particleDensity)) / 100;
  const MAX_COUNT = Math.round(500 + density * density * 299500);
  const spacing = Math.max(3, Math.sqrt((w * h) / MAX_COUNT));
  const countX = Math.ceil(w / spacing);
  const countY = Math.ceil(h / spacing);
  const particles: Particle[] = [];
  for (let iy = 0; iy < countY; iy++) {
    const y = (iy + 0.5 + (Math.random() - 0.5) * 0.8) * spacing;
    for (let ix = 0; ix < countX; ix++) {
      const x = (ix + 0.5 + (Math.random() - 0.5) * 0.8) * spacing;
      // 该行被成形线扫到的时刻：线从底向顶，t0 = (1 - y/h) * wipeDuration；
      // 粒子提前于线到达激活，从成形边缘升起（与关闭动画同构的波浪相位修正）
      const t0 = ((h - y) / h) * wipeDuration;
      const wave =
        waveAmp * Math.sin((x / w) * Math.PI * 2.4 + t0 * 0.011) +
        waveAmp2 * Math.sin((x / w) * Math.PI * 5.1 + t0 * 0.017 + 1.3);
      const spawnT = Math.min(
        wipeDuration - 1,
        Math.max(0, t0 - (wave / h) * wipeDuration),
      );
      particles.push({
        x,
        y,
        spawnT,
        life: (duration - spawnT) * (0.8 + Math.random() * 0.2),
        riseMul: 0.9 + Math.random() * 0.2,
        jitX: (Math.random() - 0.5) * 10,
        jitY: (Math.random() - 0.5) * 10,
        phase: Math.random() * Math.PI * 2,
        r: 0.9 + Math.random() * 0.9,
        alpha: 0.4 + Math.random() * 0.35,
      });
    }
  }

  const start = performance.now();
  // 帧驱动：优先 rAF（对齐垂直同步，动画更顺滑）；窗口被后台节流导致 rAF 停摆时，
  // 由 40ms 备用计时器检测并兜底推进（与旧 setTimeout 方案同等防卡死保证）
  let lastPaint = 0;
  let ended = false;
  let prevNow = start;

  const stopLoop = () => {
    ended = true;
    cancelAnimationFrame(rafId);
    if (backupId) {
      window.clearInterval(backupId);
      backupId = 0;
    }
  };

  const finishSummon = () => {
    summoning = false;
    // 成形完成：复原页面，便签完整显示（样式由下次动画重新接管）
    try {
      root.style.clipPath = "";
      root.style.boxShadow = "";
      root.style.opacity = "";
    } catch {
      /* ignore */
    }
    try {
      canvas.remove();
    } catch {
      /* ignore */
    }
  };

  // 看门狗：极端情况下动画未能在 2.6s 内结束，强制收尾（先停帧循环再复原），
  // 绝不卡在“空画面”
  const watchdog = window.setTimeout(() => {
    stopLoop();
    finishSummon();
  }, 2600);

  // 粒子透明度分桶（复用数组，每帧只重置长度，避免逐帧分配造成 GC 停顿）
  const ALPHA_BUCKETS = 24;
  const buckets: number[][] = Array.from({ length: ALPHA_BUCKETS }, () => []);

  // 预计算成形线 X 坐标与 X 字符串（每帧不变），逐帧只算 Y，减少分配与 toFixed
  const edgeX: number[] = new Array(EDGE_N + 1);
  const edgeXs: string[] = new Array(EDGE_N + 1);
  for (let i = 0; i <= EDGE_N; i++) {
    const x = (i / EDGE_N) * w;
    edgeX[i] = x;
    edgeXs[i] = x.toFixed(1) + "px";
  }
  const edgeY: number[] = new Array(EDGE_N + 1);
  const pts: string[] = new Array(EDGE_N + 3); // 线点 + 左下 + 右下

  // 流场网格（复用数组，每帧只重写值，避免逐帧分配）
  const GX = Math.ceil(w / 40) + 1;
  const GY = Math.ceil(h / 40) + 1;
  const gvx: number[][] = new Array(GY);
  const gvy: number[][] = new Array(GY);
  for (let gy = 0; gy < GY; gy++) {
    gvx[gy] = new Array(GX);
    gvy[gy] = new Array(GX);
  }

  const frame = (now: number) => {
    const age = now - start;
    // 按真实帧间隔积分（rAF 在 144Hz 下帧间隔约 7ms，固定 0.016 会整体加速）；
    // 限幅避免后台节流后的跳帧把粒子瞬间甩飞
    const dt = Math.min(0.05, Math.max(0.001, (now - prevNow) / 1000));
    prevNow = now;

    // ---- 波浪成形线采样（从底向顶）----
    for (let i = 0; i <= EDGE_N; i++) edgeY[i] = edgeYAt(edgeX[i], age);

    // 页面本体：clip-path 多边形保留“成形线以下”区域，线以上（尚未成形的部分）
    // 透明——粒子从成形边缘升起，便签在线下方随线上移逐段成形
    for (let i = 0; i <= EDGE_N; i++) pts[i] = `${edgeXs[i]} ${edgeY[i].toFixed(1)}px`;
    pts[EDGE_N + 1] = `${w}px ${h}px`;
    pts[EDGE_N + 2] = `0px ${h}px`;
    root.style.clipPath = `polygon(${pts.join(", ")})`;

    ctx.clearRect(0, 0, w, h);
    // 未成形区（线以上）不画任何填充：透明窗口直接透出便签背后的桌面内容，
    // 白色粒子在桌面背景上飘散

    // 边框环：只在“成形进行中”绘制（随成形线逐段出现）；成形完成即整体出现，
    // 绝不在粒子收尾阶段悬浮一圈边框
    if (age < wipeDuration) {
      ctx.save();
      ctx.beginPath();
      for (let i = 0; i <= EDGE_N; i++) {
        if (i === 0) ctx.moveTo(edgeX[i], edgeY[i]);
        else ctx.lineTo(edgeX[i], edgeY[i]);
      }
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.clip();
      ctx.strokeStyle = "rgba(0, 0, 0, 0.05)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") {
        ctx.roundRect(0.5, 0.5, w - 1, h - 1, noteRadius);
      } else {
        ctx.rect(0.5, 0.5, w - 1, h - 1);
      }
      ctx.stroke();
      ctx.restore();
    }

    // ---- 粒子：网格流场（预计算取代逐粒 cos）+ 分桶绘制 ----
    // 在粗网格上采样流场（约 200 次 cos/帧），粒子经双线性插值取值。
    const u = age / 1000;
    // 刷新流场网格（复用数组，只写字面值）
    for (let gy = 0; gy < GY; gy++) {
      const yy = gy * 40;
      for (let gx = 0; gx < GX; gx++) {
        const f = flowAt(gx * 40, yy, u);
        gvx[gy][gx] = f.vx;
        gvy[gy][gx] = f.vy;
      }
    }
    const sampleFlow = (px: number, py: number) => {
      const gx = px / 40, gy = py / 40;
      const ix = Math.min(Math.max(0, Math.floor(gx)), GX - 2);
      const iy = Math.min(Math.max(0, Math.floor(gy)), GY - 2);
      const fx = gx - ix, fy = gy - iy;
      const v00 = gvx[iy][ix], v10 = gvx[iy][ix + 1], v01 = gvx[iy + 1][ix], v11 = gvx[iy + 1][ix + 1];
      const vx = (1 - fx) * (1 - fy) * v00 + fx * (1 - fy) * v10 + (1 - fx) * fy * v01 + fx * fy * v11;
      const w00 = gvy[iy][ix], w10 = gvy[iy][ix + 1], w01 = gvy[iy + 1][ix], w11 = gvy[iy + 1][ix + 1];
      const vy = (1 - fx) * (1 - fy) * w00 + fx * (1 - fy) * w10 + (1 - fx) * fy * w01 + fx * fy * w11;
      return { vx, vy };
    };

    for (const b of buckets) b.length = 0;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (age < p.spawnT) continue;
      const pa = age - p.spawnT;
      if (pa > p.life) continue;
      const life01 = pa / p.life;
      const f = sampleFlow(p.x, p.y);
      p.x += (f.vx * p.riseMul + p.jitX) * dt;
      p.y += (f.vy * p.riseMul + p.jitY) * dt;
      const fadeIn = Math.min(1, pa / 60);
      const fadeOut = Math.pow(1 - life01, 1.2);
      const flicker = 0.82 + 0.18 * Math.sin(pa * 0.012 + p.phase);
      const a = p.alpha * fadeIn * fadeOut * flicker;
      if (a < 0.025) continue; // 近乎透明，跳过绘制
      const bi = Math.min(ALPHA_BUCKETS - 1, (a * ALPHA_BUCKETS) | 0);
      buckets[bi].push(i);
    }
    for (let bi = 0; bi < ALPHA_BUCKETS; bi++) {
      const list = buckets[bi];
      if (list.length === 0) continue;
      ctx.globalAlpha = (bi + 0.5) / ALPHA_BUCKETS;
      for (let k = 0; k < list.length; k++) {
        const p = particles[list[k]];
        ctx.drawImage(sprite, p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
      }
    }
    ctx.globalAlpha = 1;

    if (age >= duration) {
      // 收尾：先清空画面（页面已完整成形）——直接复原样式并移除覆盖层
      window.clearTimeout(watchdog);
      ctx.clearRect(0, 0, w, h);
      stopLoop();
      finishSummon();
      return;
    }
  };

  // 帧驱动：rAF 链每帧推进一次（对齐垂直同步）；rAF 停摆（>60ms 无新帧，如后台
  // 节流）时备用计时器直接推进一帧。注意：备用路径只推帧、不额外排程 rAF——
  // 否则帧耗时较长时 rAF 回调会层层堆积（每 40ms 多挂一个），渲染队列膨胀成
  // “粒子卡住不动”的死循环（时间仍在走，恢复后瞬间收尾“消失”）。
  const step = (now: number) => {
    lastPaint = now;
    frame(now);
    if (!ended) rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
  backupId = window.setInterval(() => {
    if (ended) return;
    const now = performance.now();
    if (now - lastPaint > 60) {
      lastPaint = now;
      frame(now); // 只推帧，不调度 rAF（rAF 恢复后自带继续）
    }
  }, 40);
}
