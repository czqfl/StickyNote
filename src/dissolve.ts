// 便签关闭动画：鸿蒙式粒子消散（参考鸿蒙系统通知栏的删除粒子特效）
// ----------------------------------------------------------------------------
// 触发：关闭窗口（标题栏关闭按钮 / “全部关闭”全局快捷键）时，先播放本动画，结束后再真正关闭。
//
// 效果：整张便签（内容 + 边框 + 底色，作为一个整体）像被火焰从上往下燃烧一样逐渐消散——
// 燃烧线是一条左右起伏、随时间抖动的波浪形边缘（不是平直的横线），从顶部向底部推进；
// 线所到之处立即化为细密的白色粒子，粒子从燃烧边缘升起，像纸灰/火星一样卷曲上飘
// （多频率摇摆 + 上下扑闪 + 左右定向偏飘），边飘边淡出。
// 从左到右：每一列的燃烧时机（波浪起伏）与上飘速度（左慢右快渐变）都不同，
// 但整体保持“从上到下”的消散方向。消散很快（约 0.32s 烧完全页），粒子云再飘散
// 约 0.6s，粒子消散完窗口立即真正关闭，页面不复存在。
//
// 实现：
// - 页面本体用 clip-path 多边形逐帧裁剪：多边形上边 = 波浪燃烧线（每帧按正弦叠加
//   两档频率采样 26 个点），线以上被裁掉——边框/圆角/内部线条随燃烧线一同消失；
// - 燃烧区（线以上）在 Canvas 覆盖层上不画任何填充：透明窗口直接透出便签背后的
//   桌面内容，白色粒子在真实桌面上飘散；页面裁剪 + 粒子覆盖即完整消散；
// - 粒子按网格预铺满全页，激活时机 = 该列燃烧线扫到该行的时刻（波浪起伏导致
//   左右列时机不同），上飘速度按列渐变（左慢右快）+ 随机；
// - 粒子为预渲染的白色柔光细点精灵图，逐帧 drawImage 批量绘制；数量自适应
//   （约每 6px 一个，上限 6000），粒子细小，观感是整页化为细腻的白色尘雾；
// - 帧循环用 setTimeout(16ms) 驱动（按 performance.now() 计量）——便签窗口处于后台时
//   rAF 会被系统/浏览器节流甚至暂停，计时器仍能持续推进，杜绝“卡住后无动画直接关闭”；
// - 播放前把窗口聚焦到前台，进一步确保动画不被节流；自带看门狗，onDone 必定被调用。

let animating = false;

/** 请求播放粒子消散关闭动画；onDone 在动画完全结束后调用（用于真正关闭窗口）。
 * @param particleDensity 粒子强度 0~100（默认 50≈5000 粒，最大 100≈9000 粒） */
export function requestParticleDissolveClose(onDone: () => void, particleDensity = 50): void {
  const root = document.querySelector(".note-window") as HTMLElement | null;
  if (!root || animating) {
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
  const watchdog = window.setTimeout(safeDone, 2600);

  const bringToFront = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      try { await win.setFocus(); } catch { /* ignore */ }
    } catch { /* ignore */ }
  };

  bringToFront().catch(() => {}).finally(() => {
    try {
      playDissolve(root, () => { window.clearTimeout(watchdog); safeDone(); }, particleDensity);
    } catch (e) {
      console.error("粒子消散动画异常:", e);
      window.clearTimeout(watchdog);
      safeDone();
    }
  });
}

interface Particle {
  x: number;
  y: number;
  spawnT: number; // 激活时刻 ms（= 该列燃烧线扫到该行的时刻；之前不绘制）
  life: number; // 寿命 ms（保证在动画结束前消亡）
  riseMul: number; // 个体微差（0.9~1.1），保持火焰内细微个体差异又不破坏区域整体趋势
  jitX: number; // 个体微抖动 px/s（远小于流场速度，不破坏方向一致性）
  jitY: number;
  phase: number; // 明灭相位
  r: number; // 粒子半径 px（细小）
  alpha: number; // 初始不透明度
}

// ---- 火焰式流场（Curl Noise 思想的轻量实现，核心算法）----
// 经典做法（Bridson《Curl Noise for Procedural Fluid Flow》SIGGRAPH 2007 /
// Shiffman《Nature of Code》flow field）：不让每个粒子各自随机飘，而是让所有粒子
// 采样同一个平滑矢量场 v(x,y,t)，相邻区域粒子取到相近流速 → 区域方向一致（火焰般
// 的整体趋势）；场随时间低频变化 → 整片粒子云如热气流般摇曳。
// 此处用“可解析求导的正弦势场 ψ 求旋度”实现（散度为零，粒子不会堆积/坍缩）：
//   vx = ∂ψ/∂y，vy = -∂ψ/∂x
// 再叠加“热羽流”上飘速度（火焰热气向上升腾）。
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
  // 旋度项（可正可负，形成漩涡/回旋）+ 热羽流上飘（整体向上，略微按列起伏）
  const vy = -(FLOW_A1 * FLOW_AX1 * c1 + FLOW_A2 * FLOW_AX2 * c2) - (62 + 14 * Math.sin(x * 0.006 + t * 0.6));
  return { vx, vy };
}

async function playDissolve(root: HTMLElement, onDone: () => void, particleDensity: number): Promise<void> {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;

  // 全窗口覆盖层 canvas（置于最顶；逐帧重画“燃烧区底色 + 粒子”）
  const canvas = document.createElement("canvas");
  canvas.className = "dissolve-canvas";
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
    animating = false;
    onDone();
    return;
  }
  ctx.scale(dpr, dpr);

  // 便签的 box-shadow（内嵌描边环 + 底部内影）在 WebView2 里不会随 clip-path 被
  // 裁剪，会整圈残留到最后——动画期间移除真实边框，改为在 Canvas 上按“燃烧线以下
  // 区域”重新绘制（随燃烧线逐段消失），隐藏后由 cleanup 恢复。
  // 窗口不启用 DWM 圆角（见 main.rs 说明），因此动画期间没有圆角描边需要处理。
  root.style.boxShadow = "none";
  const noteRadius = parseFloat(getComputedStyle(root).borderRadius) || 14;

  // 预渲染白色柔光细点精灵（径向渐变：中心白 → 边缘快速透明）
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

  // ---- 燃烧线：波浪形边缘，从顶部向底部推进 ----
  const wipeDuration = 320; // 烧完全页的用时 ms（快）
  const duration = 900; // 总时长 ms（燃烧 + 粒子飘散收尾）

  // 波浪燃烧线的纵向位置：基准随进度下移 + 两档频率的正弦起伏（左右时机不同）+ 抖动
  const EDGE_N = 26; // 采样点数（左右方向的波浪细腻度）
  const waveAmp = 10; // 主波幅度 px
  const waveAmp2 = 5; // 次波幅度 px
  function edgeYAt(x: number, age: number): number {
    const prog = Math.min(1, age / wipeDuration);
    // 幅度随进度渐入，开头不闪裁（age=0 时无波浪）
    const ampIn = Math.min(1, age / 90);
    const base = prog * (h + 10);
    const wave =
      waveAmp * Math.sin((x / w) * Math.PI * 2.4 + age * 0.011) +
      waveAmp2 * Math.sin((x / w) * Math.PI * 5.1 + age * 0.017 + 1.3);
    return Math.max(0, base + wave * ampIn);
  }

  // ---- 粒子：网格预铺满整张便签（带抖动），激活时机 = 所在列燃烧线扫到该行 ----
  // 每列燃烧时机不同（波浪）、上飘速度按列渐变（左慢右快），但整体从上到下推进；
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
      // 该行被燃烧线扫到的时刻：按列相位修正（与 edgeYAt 的波浪同构），
      // 使粒子恰好从燃烧边缘升起
      const t0 = (y / h) * wipeDuration;
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
        // 寿命覆盖到动画结束前（约 8~10 成剩余时间），粒子与消散收尾同步结束，
        // 消散完即关闭，不留空窗
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
  let rafId = 0;
  let backupId = 0;
  let lastPaint = 0;
  let ended = false;
  let prevNow = start;

  const stopLoop = () => {
    ended = true;
    cancelAnimationFrame(rafId);
    if (backupId) window.clearInterval(backupId);
  };

  const cleanup = async () => {
    stopLoop();
    // 窗口隐藏后保持“空画面”（不复原 clip-path/box-shadow）：下次呼出时
    // DWM 呈现的是空帧，粒子成形动画（summon.ts）从空开始，不会先闪出便签内容。
    // 样式复原由呼出动画收尾负责（playSummonMaterialize 结束 / cancelSummon）。
    try {
      root.style.clipPath = "inset(0 0 100% 0)";
      root.style.opacity = "";
      root.style.boxShadow = "none";
    } catch {
      /* ignore */
    }
    try {
      canvas.remove();
    } catch {
      /* ignore */
    }
    animating = false;
  };

  // 粒子透明度分桶（复用数组，每帧只重置长度，避免逐帧分配造成 GC 停顿）
  const ALPHA_BUCKETS = 24;
  const buckets: number[][] = Array.from({ length: ALPHA_BUCKETS }, () => []);

  // 预计算燃烧线 X 坐标与 X 字符串（每帧不变），逐帧只算 Y，减少分配与 toFixed
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

    // ---- 波浪燃烧线采样 ----
    for (let i = 0; i <= EDGE_N; i++) edgeY[i] = edgeYAt(edgeX[i], age);

    // 页面本体：clip-path 多边形保留“燃烧线以下”区域，线以上（含边框/圆角）被裁掉
    for (let i = 0; i <= EDGE_N; i++) pts[i] = `${edgeXs[i]} ${edgeY[i].toFixed(1)}px`;
    pts[EDGE_N + 1] = `${w}px ${h}px`;
    pts[EDGE_N + 2] = `0px ${h}px`;
    root.style.clipPath = `polygon(${pts.join(", ")})`;

    ctx.clearRect(0, 0, w, h);
    // 燃烧区（线以上）不画任何填充：透明窗口直接透出便签背后的桌面内容，
    // 白色粒子在桌面背景上飘散

    // 边框环：只在“燃烧进行中”绘制（随燃烧线逐段消失）；燃烧完成即整体消失，
    // 绝不在粒子飘散的尾巴阶段残留一圈悬浮边框
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
    // 在粗网格上采样流场（约 200 次 cos/帧），粒子经双线性插值取值，
    // 彻底消除逐粒 cos（10000+ 次/帧），从 CPU 侧根除卡顿。
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
    // 双线性插值取流场
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
    // 收尾：先清空画面（页面已被裁剪、粒子已淡尽）——窗口以“空”状态隐藏，
    // 避免隐藏瞬间对残留画面重新合成而产生“便签缩小一下”的残影
    ctx.clearRect(0, 0, w, h);
    stopLoop();
    try {
      onDone();
    } finally {
      // 关闭现为“隐藏”（异步 IPC）：延迟清理，待隐藏生效后再复原页面，
      // 避免隐藏前一瞬闪回原内容
      window.setTimeout(cleanup, 400);
    }
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
