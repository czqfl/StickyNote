// 便签关闭动画：鸿蒙式粒子消散（参考鸿蒙系统通知栏的删除粒子特效）
// ----------------------------------------------------------------------------
// 触发：关闭窗口（标题栏关闭按钮 / "全部关闭"全局快捷键）时，先播放本动画，结束后再真正关闭。
//
// 效果：整张便签（内容 + 边框 + 底色，作为一个整体）像被火焰从上往下燃烧一样逐渐消散——
// 燃烧线是一条左右起伏、随时间抖动的波浪形边缘（不是平直的横线），从顶部向底部推进；
// 线所到之处立即化为细密的火焰色余烬，余烬从燃烧边缘升起，像纸灰/火星一样卷曲上飘
// （多频率摇摆 + 上下扑闪 + 左右定向偏飘），边飘边淡出。
// 从左到右：每一列的燃烧时机（波浪起伏）与上飘速度（左慢右快渐变）都不同，
// 但整体保持"从上到下"的消散方向。消散很快（约 0.32s 烧完全页），粒子云再飘散
// 约 0.6s，粒子消散完窗口立即真正关闭，页面不复存在。
//
// 实现：
// - 页面本体用 clip-path 多边形逐帧裁剪：多边形上边 = 波浪燃烧线（每帧按正弦叠加
//   两档频率采样 26 个点），线以上被裁掉——边框/圆角/内部线条随燃烧线一同消失；
// - 燃烧区（线以上）在 Canvas 覆盖层上不画任何填充：透明窗口直接透出便签背后的
//   桌面内容，火焰色余烬在真实桌面上飘散；页面裁剪 + 粒子覆盖即完整消散；
// - 粒子按网格预铺满全页，激活时机 = 该列燃烧线扫到该行的时刻（波浪起伏导致
//   左右列时机不同），上飘速度按列渐变（左慢右快）+ 随机；
// - 粒子为预渲染的火焰色余烬精灵（按温度分档：白热→黄→橙→暗红），逐帧 drawImage
//   批量绘制；additive 混合让重叠余烬叠亮成白热核心（火焰最典型特征）；数量自适应
//   （强度 0~100 线性映射 500~8000 粒，最小间距 5px）；
// - 粒子数据用 Float32Array（SoA），流场网格用 Float32Array，消除逐帧对象分配；
// - 帧循环用 rAF 驱动 + 40ms 备用计时器兜底；时间线 age 走真实墙钟（now-start），
//   窗口被遮挡节流时仍按真实耗时收尾（不会卡半途很久）；dt 仅用于粒子位移积分；
//   自带看门狗，onDone 必定被调用。

let animating = false;

/** 请求播放粒子消散关闭动画；onDone 在动画完全结束后调用（用于真正关闭窗口）。
 * @param particleDensity 粒子强度 0~100（默认 50≈4250 粒，最大 100≈8000 粒） */
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
  const watchdog = window.setTimeout(safeDone, 3500);

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

// ---- 火焰式流场（Curl Noise 思想的轻量实现，核心算法）----
// 经典做法（Bridson《Curl Noise for Procedural Fluid Flow》SIGGRAPH 2007 /
// Shiffman《Nature of Code》flow field）：不让每个粒子各自随机飘，而是让所有粒子
// 采样同一个平滑矢量场 v(x,y,t)，相邻区域粒子取到相近流速 → 区域方向一致（火焰般
// 的整体趋势）；场随时间低频变化 → 整片粒子云如热气流般摇曳。
// 此处用"可解析求导的正弦势场 ψ 求旋度"实现（散度为零，粒子不会堆积/坍缩）：
//   vx = ∂ψ/∂y，vy = -∂ψ/∂x
// 再叠加"热羽流"上飘速度（火焰热气向上升腾）。
// 注意：flowAt 的计算已内联到帧循环的网格刷新中（避免逐格分配 {vx,vy} 对象），
// 此处仅保留常量供内联代码引用。
const FLOW_A1 = 3200;
const FLOW_A2 = 1500;
const FLOW_AX1 = 0.009;
const FLOW_BY1 = 0.011;
const FLOW_W1 = 0.5;
const FLOW_AX2 = 0.017;
const FLOW_BY2 = 0.008;
const FLOW_W2 = 0.35;

async function playDissolve(root: HTMLElement, onDone: () => void, particleDensity: number): Promise<void> {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;

  // 全窗口覆盖层 canvas（置于最顶；逐帧重画"燃烧区底色 + 粒子"）
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
  // 裁剪，会整圈残留到最后——动画期间移除真实边框，改为在 Canvas 上按"燃烧线以下
  // 区域"重新绘制（随燃烧线逐段消失），隐藏后由 cleanup 恢复。
  // 窗口不启用 DWM 圆角（见 main.rs 说明），因此动画期间没有圆角描边需要处理。
  root.style.boxShadow = "none";

  // 预渲染火焰色余烬精灵：按温度分档（白热→黄→橙→暗红），径向渐变中心实、边缘透。
  // 真实火焰：锋面刚升起的余烬最热（白/黄），上飘过程中冷却为橙→暗红。
  const SS = 8;  // 缩小精灵体积（原 12），降低逐帧填充率
  const FIRE_RGB: number[][] = [
    [255, 246, 214], // 0 白热核心
    [255, 222, 130], // 1 黄
    [255, 150, 52],  // 2 橙
    [232, 92, 28],   // 3 深橙
    [168, 40, 14],   // 4 暗红余烬
  ];
  const FIRE_N = FIRE_RGB.length;
  function makeFireSprite(rgb: number[]): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = SS; c.height = SS;
    const s = c.getContext("2d");
    if (s) {
      const g = s.createRadialGradient(SS / 2, SS / 2, 0, SS / 2, SS / 2, SS / 2);
      g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`);
      g.addColorStop(0.35, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.6)`);
      g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
      s.fillStyle = g;
      s.fillRect(0, 0, SS, SS);
    }
    return c;
  }
  const fireSprites: HTMLCanvasElement[] = FIRE_RGB.map(makeFireSprite);
  // 燃烧/成形前沿的纵向暖色渐变（上黄下橙），只创建一次避免逐帧分配
  const fireEdgeGrad = ctx.createLinearGradient(0, 0, 0, h);
  fireEdgeGrad.addColorStop(0, "rgba(255,215,130,0.95)");
  fireEdgeGrad.addColorStop(1, "rgba(255,105,30,0.8)");

  // ---- 燃烧线：波浪形边缘，从顶部向底部推进 ----
  const wipeDuration = 320; // 烧完全页的用时 ms（快）
  const duration = 1400; // 总时长 ms（燃烧 + 粒子飘散收尾），延长让粒子更舒缓地随风飘散

  // 波浪燃烧线的纵向位置：基准随进度下移 + 两档频率的正弦起伏（左右时机不同）+ 抖动
  const EDGE_N = 26; // 采样点数（左右方向的波浪细腻度）
  const waveAmp = 10; // 主波幅度 px
  const waveAmp2 = 5; // 次波幅度 px
  function edgeYAt(x: number, age: number): number {
    // 幅度随进度渐入，开头不闪裁（age=0 时无波浪）
    const ampIn = Math.min(1, age / 90);
    // 基准：随进度从 0 直线下移到 h+余量，确保在 wipeDuration 时已完全扫出窗口底部
    // （base 留足波幅余量）。波浪改为纯空间静态形状（不含 age 项），边缘只是干净地向下
    // 推移，不再随时间抖动——避免尾巴阶段底边因波浪上下波动而反复闪现（原 age*0.011/0.017
    // 时间项导致的“波动两下”）。
    const span = h + 2 * (waveAmp + waveAmp2) + 12;
    const base = (age / wipeDuration) * span;
    const wave =
      waveAmp * Math.sin((x / w) * Math.PI * 2.4) +
      waveAmp2 * Math.sin((x / w) * Math.PI * 5.1 + 1.3);
    return Math.max(0, base + wave * ampIn);
  }

  // ---- 粒子：网格预铺满整张便签（带抖动），激活时机 = 所在列燃烧线扫到该行 ----
  // 每列燃烧时机不同（波浪）、上飘速度按列渐变（左慢右快），但整体从上到下推进；
  // 粒子数按强度 0~100 线性缩放：0→500、50→4250、100→8000（最小间距 5px）。
  const density = Math.max(0, Math.min(100, particleDensity)) / 100;
  const MAX_COUNT = Math.round(500 + density * 7500);
  const spacing = Math.max(5, Math.sqrt((w * h) / MAX_COUNT));
  const countX = Math.ceil(w / spacing);
  const countY = Math.ceil(h / spacing);
  const pcount = countX * countY;

  // 粒子数据用 SoA（Structure of Arrays）typed arrays：
  // 连续内存布局 → cache 友好，逐粒循环中无对象属性查找开销，无 GC 压力
  const px = new Float32Array(pcount);
  const py = new Float32Array(pcount);
  const pspawnT = new Float32Array(pcount);
  const plife = new Float32Array(pcount);
  const priseMul = new Float32Array(pcount);
  const pphase = new Float32Array(pcount);
  const psway = new Float32Array(pcount); // 随风摇摆速度 px/s
  const pr = new Float32Array(pcount);
  const palpha = new Float32Array(pcount);

  let pi = 0;
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
      px[pi] = x;
      py[pi] = y;
      pspawnT[pi] = spawnT;
      // 寿命覆盖到动画结束前（约 8~10 成剩余时间），粒子与消散收尾同步结束，
      // 消散完即关闭，不留空窗
      plife[pi] = (duration - spawnT) * (0.8 + Math.random() * 0.2);
      priseMul[pi] = 0.9 + Math.random() * 0.2;
      pphase[pi] = Math.random() * Math.PI * 2;
      psway[pi] = 18 + Math.random() * 34; // 随风摇摆速度 px/s（18~52），粒子左右摇曳飘落
      pr[pi] = 0.9 + Math.random() * 0.9;
      palpha[pi] = 0.4 + Math.random() * 0.35;
      pi++;
    }
  }

  // 时间线以真实墙钟推进（age = now - start），首帧落定时才开始计时。
  // 这样窗口被遮挡/后台节流、rAF 与备用计时器被降速时，动画仍按真实耗时收尾，
  // 不会"卡在半途很久"。clamp 后的 dt 只用于粒子位移积分，不用于时间线。
  let start = 0;
  let started = false;
  // 帧驱动：优先 rAF（对齐垂直同步，动画更顺滑）；窗口被后台节流导致 rAF 停摆时，
  // 由 40ms 备用计时器检测并兜底推进（与旧 setTimeout 方案同等防卡死保证）
  let rafId = 0;
  let backupId = 0;
  let lastPaint = 0;
  let ended = false;
  let prevNow = 0;

  const stopLoop = () => {
    ended = true;
    cancelAnimationFrame(rafId);
    if (backupId) window.clearInterval(backupId);
  };

  const cleanup = async () => {
    stopLoop();
    // 窗口隐藏后保持"空画面"（不复原 clip-path/box-shadow）：下次呼出时
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

  // 粒子透明度分桶：预分配容量（避免逐帧 push 扩容），用 bucketLens 跟踪实际长度
  const ALPHA_BUCKETS = 16;
  const buckets: number[][] = Array.from({ length: ALPHA_BUCKETS }, () => new Array(pcount));
  const bucketLens = new Int32Array(ALPHA_BUCKETS);

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

  // 流场网格：flat Float32Array（连续内存，cache 友好，无逐行数组间接）
  const CELL = 40;
  const GX = Math.ceil(w / CELL) + 1;
  const GY = Math.ceil(h / CELL) + 1;
  const gvx = new Float32Array(GX * GY);
  const gvy = new Float32Array(GX * GY);
  const GXm2 = GX - 2;
  const GYm2 = GY - 2;

  const frame = (now: number) => {
    // 首帧落定时间基准：用真实墙钟，避免启动延迟带来的负偏移
    if (!started) {
      started = true;
      start = now;
      prevNow = now;
    }
    // 时间线 age 走真实墙钟（now - start）：窗口被遮挡/后台节流时仍按真实耗时推进，
    // 不会"卡在半途很久"。位移积分才用 clamp 后的 dt，防止跳帧把粒子甩飞。
    const age = now - start;
    // 按真实帧间隔积分（rAF 在 144Hz 下帧间隔约 7ms，固定 0.016 会整体加速）；
    // 限幅避免后台节流后的跳帧把粒子瞬间甩飞
    const dt = Math.min(0.05, Math.max(0.001, (now - prevNow) / 1000));
    prevNow = now;

    // ---- 波浪燃烧线采样 ----
    for (let i = 0; i <= EDGE_N; i++) edgeY[i] = edgeYAt(edgeX[i], age);

    // 页面本体：clip-path 多边形保留"燃烧线以下"区域，线以上（含边框/圆角）被裁掉
    for (let i = 0; i <= EDGE_N; i++) pts[i] = `${edgeXs[i]} ${edgeY[i].toFixed(1)}px`;
    pts[EDGE_N + 1] = `${w}px ${h}px`;
    pts[EDGE_N + 2] = `0px ${h}px`;
    root.style.clipPath = `polygon(${pts.join(", ")})`;

    ctx.clearRect(0, 0, w, h);
    // 燃烧区（线以上）不画任何填充：透明窗口直接透出便签背后的桌面内容，
    // 火焰色余烬在桌面背景上飘散

    // 燃烧前沿：沿波浪线描一条发光暖色火边（替代原极淡黑描边），
    // 让"裁剪硬边"看起来像真实燃烧锋面而非被一刀切掉；additive + 阴影模糊形成热辉光
    if (age < wipeDuration) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.shadowColor = "rgba(255,140,40,0.95)";
      ctx.shadowBlur = 14;
      ctx.strokeStyle = fireEdgeGrad;
      ctx.lineWidth = 2.4;
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = 0; i <= EDGE_N; i++) {
        if (i === 0) ctx.moveTo(edgeX[i], edgeY[i]);
        else ctx.lineTo(edgeX[i], edgeY[i]);
      }
      ctx.stroke();
      ctx.restore();
    }

    // ---- 粒子：网格流场（内联计算，零对象分配）+ 分桶绘制 ----
    const u = age / 1000;
    // 刷新流场网格：直接内联 flowAt 公式，写入 flat Float32Array
    for (let gy = 0; gy < GY; gy++) {
      const yy = gy * CELL;
      const rowBase = gy * GX;
      for (let gx = 0; gx < GX; gx++) {
        const xx = gx * CELL;
        const c1 = Math.cos(FLOW_AX1 * xx + FLOW_BY1 * yy + u * FLOW_W1);
        const c2 = Math.cos(FLOW_AX2 * xx + FLOW_BY2 * yy + u * FLOW_W2 + 1.3);
        const idx = rowBase + gx;
        gvx[idx] = FLOW_A1 * FLOW_BY1 * c1 + FLOW_A2 * FLOW_BY2 * c2;
        gvy[idx] = -(FLOW_A1 * FLOW_AX1 * c1 + FLOW_A2 * FLOW_AX2 * c2) - (50 + 12 * Math.sin(xx * 0.005 + u * 0.5));
      }
    }

    // 粒子更新 + 分桶：内联双线性插值（无函数调用、无对象分配）
    bucketLens.fill(0);
    for (let i = 0; i < pcount; i++) {
      const spawnT = pspawnT[i];
      if (age < spawnT) continue;
      const pa = age - spawnT;
      const life = plife[i];
      if (pa > life) continue;
      const life01 = pa / life;

      // 内联双线性插值取流场
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
      // 随风摇摆：横向正弦摇曳 + 轻微纵向浮动，幅度随粒子随机，
      // 使整片粒子像被气流托着左右飘忽（而非直线飞走）
      const sway = Math.sin(pa * 0.006 + pphase[i]) * psway[i];
      const bob = Math.cos(pa * 0.005 + pphase[i] * 1.3) * psway[i] * 0.35;
      px[i] += (vx * rm + sway) * dt;
      py[i] += (vy * rm + bob) * dt;

      // fadeIn / fadeOut / flicker：用多项式替代 Math.pow，减少逐粒数学调用
      const fadeIn = pa < 60 ? pa * 0.016666667 : 1; // /60
      const fadeOut = (1 - life01) * (1 - life01);   // ≈ Math.pow(1-life01, 2)
      const flicker = 0.82 + 0.18 * Math.sin(pa * 0.012 + pphase[i]);
      const a = palpha[i] * fadeIn * fadeOut * flicker;
      if (a < 0.025) continue; // 近乎透明，跳过绘制
      let bi = (a * ALPHA_BUCKETS) | 0;
      if (bi >= ALPHA_BUCKETS) bi = ALPHA_BUCKETS - 1;
      buckets[bi][bucketLens[bi]++] = i;
    }
    // 分桶批量绘制（按透明度分组，减少 globalAlpha 状态切换）。
    // additive 混合：重叠余烬自然叠亮成白热核心，是火焰最典型的特征；
    // 按 life01 选温度档——刚升起的余烬最热（白/黄），上飘冷却为橙→暗红。
    ctx.globalCompositeOperation = "lighter";
    for (let bi = 0; bi < ALPHA_BUCKETS; bi++) {
      const len = bucketLens[bi];
      if (len === 0) continue;
      ctx.globalAlpha = (bi + 0.5) / ALPHA_BUCKETS;
      const list = buckets[bi];
      for (let k = 0; k < len; k++) {
        const i = list[k];
        const r = pr[i];
        const life01 = plife[i] > 0 ? (age - pspawnT[i]) / plife[i] : 1;
        let fi = (life01 * FIRE_N) | 0;
        if (fi >= FIRE_N) fi = FIRE_N - 1;
        ctx.drawImage(fireSprites[fi], px[i] - r, py[i] - r, r * 2, r * 2);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    if (age >= duration) {
      // 收尾：先清空画面（页面已被裁剪、粒子已淡尽）——窗口以"空"状态隐藏，
      // 避免隐藏瞬间对残留画面重新合成而产生"便签缩小一下"的残影
      ctx.clearRect(0, 0, w, h);
      stopLoop();
      try {
        onDone();
      } finally {
        // 关闭现为"隐藏"（异步 IPC）：延迟清理，待隐藏生效后再复原页面，
        // 避免隐藏前一瞬闪回原内容
        window.setTimeout(cleanup, 400);
      }
      return;
    }
  };

  // 帧驱动：rAF 链每帧推进一次（对齐垂直同步）；rAF 停摆（>60ms 无新帧，如后台
  // 节流）时备用计时器直接推进一帧。注意：备用路径只推帧、不额外排程 rAF——
  // 否则帧耗时较长时 rAF 回调会层层堆积（每 40ms 多挂一个），渲染队列膨胀成
  // "粒子卡住不动"的死循环（时间仍在走，恢复后瞬间收尾"消失"）。
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
