// 便签「侵蚀消散」动画：烧纸 / 酸蚀金属式逐像素消散（与火焰式 dissolve/summon 正交的新效果）
// ----------------------------------------------------------------------------
// 触发：关闭窗口 / 呼出窗口时播放（与火焰二选一，由设置 particle_mode 决定）。
//
// 效果（对齐用户需求）：
// - 从底部开始向上消散，但消散边界**不是水平直线**——边缘呈锯齿状 / 波浪状 / 破碎状，
//   像火焰烧纸、酸蚀金属；
// - 同一水平线上不同位置的消散进度有随机差异（±200ms），有的已消散到中部、有的还在底部，
//   形成错落有致的节奏；
// - 消散起点不止整条底边：还在底部随机布置 2~3 个「种子点」，像墨水滴在宣纸上一样
//   向四周扩散（不规则圆 / 椭圆），与底部推进前沿取 min 融合成多前沿侵蚀；
// - 消散边界带**羽化模糊**（真正的逐像素软边，不是硬切）；
// - 整体持续约 1 秒，配合整体透明度从 100% 渐变到 0%（末端淡出）。
//
// 实现（关键：逐像素羽化无法用 clip-path 硬边实现，改用 CSS mask 蒙版）：
// - 把「消散时间场」T(x,y)（该像素开始消散的毫秒时刻）在初始化时一次性烘焙出来：
//     T = min(底部向上基准, 各种子点椭圆距离场) + 多倍频值噪声(±200ms) + 每格哈希抖动(±40ms)
//   噪声是平滑的 → 波浪起伏；哈希抖动是碎的 → 锯齿；种子点距离场 → 不规则扩散。
// - 每帧把 T 场按当前 age 转成一张低分辨率 alpha 蒙版（visible=不透明 / dissolved=透明 /
//   边界处按羽化带宽渐变），putImageData 后 toDataURL，作为 .note-window 的
//   -webkit-mask-image；mask-size:100% 100% 上采样 → 低分辨率蒙版自动进一步柔化羽化。
// - 蒙版用「先解码再替换」（new Image onload 后才 set）避免逐帧 dataURL 闪烁；
// - 透明度淡出：root.style.opacity 随全局进度 1→0（消散）/ 0→1（成形）；
// - 余烬粒子：canvas 覆盖层上，侵蚀前沿处的发射点向上飘出暖色火星，边飘边淡出，
//   让「烧纸」更有质感（独立元素，不随便签本体一起变透明）。
// - 关闭(dissolve)与呼出(materialize)互为倒放：dissolve 底部向上消失，
//   materialize 顶部向下成形（用 Tm = wipe - T 反转同一时间场）。

let eroding = false;
let materializing = false;

/** 当前侵蚀动画的“立即中止”句柄（由 runErode 注册；cancelErode 调用）。
 *  中止 = 停帧 + 复原页面（保持可见，供“呼出打断关闭”等快速切换）。 */
let cancelErodeFn: (() => void) | null = null;

/** 立即中止侵蚀动画并复原页面（关闭动画开始前调用，避免与呼出动画同时改 mask/透明度；
 *  呼出打断关闭时也调用——此时不触发 onDone，窗口保持显示）。 */
export function cancelErode(): void {
  const c = cancelErodeFn;
  cancelErodeFn = null;
  if (c) {
    c();
    return;
  }
  // 兜底：无注册句柄时（理论不会出现）直接复原
  if (!eroding && !materializing) return;
  eroding = false;
  materializing = false;
  const root = document.querySelector(".note-window") as HTMLElement | null;
  if (root) restoreRoot(root);
  document.querySelector(".erode-canvas")?.remove();
}

/** 复原便签本体样式（mask / 透明度 / 阴影 / 裁剪全部还原）。 */
function restoreRoot(root: HTMLElement): void {
  try {
    root.style.setProperty("-webkit-mask-image", "");
    root.style.setProperty("mask-image", "");
    root.style.clipPath = "";
    root.style.opacity = "";
    root.style.boxShadow = "";
  } catch {
    /* ignore */
  }
}

/** 隐藏便签本体（保持"空画面"，供下次呼出从空开始，契约与 dissolve.ts 一致）。 */
function blankRoot(root: HTMLElement): void {
  try {
    root.style.setProperty("-webkit-mask-image", "");
    root.style.setProperty("mask-image", "");
    root.style.clipPath = "inset(0 0 100% 0)";
    root.style.opacity = "";
    root.style.boxShadow = "none";
  } catch {
    /* ignore */
  }
}

/** 请求播放「侵蚀消散」关闭动画；onDone 在动画完全结束后调用（用于真正关闭窗口）。 */
export function requestErodeDissolveClose(onDone: () => void, particleDensity = 50): void {
  const root = document.querySelector(".note-window") as HTMLElement | null;
  if (!root || eroding) {
    onDone();
    return;
  }
  eroding = true;
  let done = false;
  let aborted = false;
  let stopRun: (() => void) | null = null;
  const safeDone = () => {
    if (done) return;
    done = true;
    eroding = false;
    cancelErodeFn = null;
    onDone();
  };
  const watchdog = window.setTimeout(safeDone, 4000);
  cancelErodeFn = () => {
    if (aborted) return;
    aborted = true;
    window.clearTimeout(watchdog);
    if (stopRun) stopRun();
    done = true; // 阻止 onDone：finish() 不会被调用，窗口保持显示
    eroding = false;
  };
  try {
    stopRun = runErode(root, "dissolve", particleDensity, () => {
      window.clearTimeout(watchdog);
      safeDone();
    });
  } catch (e) {
    console.error("侵蚀消散动画异常:", e);
    window.clearTimeout(watchdog);
    safeDone();
  }
}

/** 播放「侵蚀成形」呼出动画（关闭的倒放：顶部向下成形）；收尾自动复原页面。 */
export function playErodeMaterialize(root: HTMLElement, particleDensity = 50): void {
  // 强制接管：若已有侵蚀动画在播放（快速呼出时上一轮动画未收尾、materializing 残留），
  // 先取消旧的再启动新的，杜绝「呼出被静默拒绝 → 窗口空画面永久卡死」。
  if (materializing || eroding) cancelErode();
  materializing = true;
  let aborted = false;
  let stopRun: (() => void) | null = null;
  cancelErodeFn = () => {
    if (aborted) return;
    aborted = true;
    if (stopRun) stopRun();
    materializing = false;
  };
  try {
    stopRun = runErode(root, "materialize", particleDensity, () => {
      /* materialize 收尾在 runErode 内自行复原，无需额外 onDone */
    });
  } catch (e) {
    console.error("侵蚀成形动画异常:", e);
    cancelErodeFn = null;
    materializing = false;
    restoreRoot(root);
  }
}

// ---- 确定性哈希 / 值噪声（提供平滑的波浪起伏 + 细碎的锯齿）----
function hash2(ix: number, iy: number): number {
  let n = (ix * 374761393 + iy * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n = n ^ (n >>> 16);
  return (n >>> 0) / 4294967295; // 0..1
}

function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy; // 0..1
}

/** 多倍频值噪声，输出约 [-1,1]：低频出大波浪、高频出锯齿破碎。 */
function fbm(x: number, y: number): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < 3; o++) {
    sum += (valueNoise(x * freq, y * freq) * 2 - 1) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

interface Seed {
  x: number;
  y: number;
  invRx: number;
  invRy: number;
}

/**
 * 播放一次侵蚀动画。
 * @param direction "dissolve"=关闭消散（底部向上）；"materialize"=呼出成形（顶部向下，倒放）
 */
function runErode(
  root: HTMLElement,
  direction: "dissolve" | "materialize",
  particleDensity: number,
  onDone: () => void,
): () => void {
  const isDissolve = direction === "dissolve";
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // 内容尺寸（便签本体）：动画开始前窗口尚未扩大，innerWidth/Height 即便签尺寸。
  const w = window.innerWidth;
  const h = window.innerHeight;

  // ---- 时序参数 ----
  const wipe = 1000; // 消散 / 成形主体时长 ms（用户要求约 1 秒）
  const featherMs = 90; // 羽化软边时间带宽（越大边缘越柔）
  const tailMs = isDissolve ? 520 : 160; // 余烬飘散收尾（延长让火星飘更久；成形更短）
  const duration = wipe + tailMs;

  // ---- 蒙版：低分辨率逐像素 alpha（mask-size:100% 100% 上采样柔化）----
  const maskScale = Math.max(0.18, Math.min(0.32, 120 / Math.max(w, 1))); // 目标宽 ~120px
  const mw = Math.max(8, Math.round(w * maskScale));
  const mh = Math.max(8, Math.round(h * maskScale));
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = mw;
  maskCanvas.height = mh;
  const mctx = maskCanvas.getContext("2d");
  if (!mctx) {
    finishEarly();
    return () => {};
  }
  const img = mctx.createImageData(mw, mh);
  const px32 = new Uint32Array(img.data.buffer); // 以 32 位写入，仅改最高字节(alpha)

  // ---- 消散时间场 T(x,y)（初始化烘焙一次，单位 ms，越小越先消散）----
  const noiseAmp = 200; // ±200ms：同一水平线不同位置的进度差（20%~40%）
  const jitterAmp = 42; // 细碎锯齿
  const leadIn = noiseAmp + jitterAmp + 8; // 保证 T∈[0, wipe-featherMs]
  const baseMax = wipe - featherMs - leadIn;
  const noiseScale = 1 / 42; // 主波长 ~42px

  // 底部 2~3 个种子点（墨滴扩散源），椭圆半径
  const seedCount = 2 + Math.floor(Math.random() * 2);
  const seeds: Seed[] = [];
  for (let i = 0; i < seedCount; i++) {
    const rx = (0.22 + Math.random() * 0.3) * w;
    const ry = (0.22 + Math.random() * 0.35) * h;
    seeds.push({
      x: (0.15 + Math.random() * 0.7) * w,
      y: (0.55 + Math.random() * 0.4) * h, // 偏底部
      invRx: 1 / rx,
      invRy: 1 / ry,
    });
  }
  const seedSpan = wipe * 0.5; // 种子点从中心到边缘的扩散耗时

  // 返回 CSS 坐标 (nx,ny) 的消散时刻（dissolve 语义：底部小、顶部大）
  const dissolveTimeAt = (nx: number, ny: number): number => {
    // 底部向上基准：底部 leadIn，顶部 baseMax
    let base = leadIn + ((h - ny) / h) * (baseMax - leadIn);
    // 种子点扩散场（不规则椭圆），取 min → 多前沿侵蚀 / 局部破洞
    for (let i = 0; i < seedCount; i++) {
      const s = seeds[i];
      const dx = (nx - s.x) * s.invRx;
      const dy = (ny - s.y) * s.invRy;
      const d = Math.sqrt(dx * dx + dy * dy); // 0..1 归一化椭圆距离
      const t = d * seedSpan;
      if (t < base) base = t;
    }
    const n = fbm(nx * noiseScale, ny * noiseScale) * noiseAmp;
    const j = (hash2(Math.round(nx), Math.round(ny)) * 2 - 1) * jitterAmp;
    let T = base + n + j;
    if (T < 0) T = 0;
    else if (T > baseMax + noiseAmp + jitterAmp) T = baseMax + noiseAmp + jitterAmp;
    return T;
  };

  // 烘焙到蒙版分辨率
  const Tfield = new Float32Array(mw * mh);
  for (let my = 0; my < mh; my++) {
    const ny = (my + 0.5) / maskScale;
    for (let mx = 0; mx < mw; mx++) {
      const nx = (mx + 0.5) / maskScale;
      Tfield[my * mw + mx] = dissolveTimeAt(nx, ny);
    }
  }

  // ---- 余烬粒子覆盖层 canvas ----
  const canvas = document.createElement("canvas");
  canvas.className = "erode-canvas";
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
  // ---- 余烬渲染：WebGL 点精灵（单次 draw call + GPU additive），替代 Canvas2D 逐粒 drawImage ----
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: false,
    antialias: false,
    depth: false,
  });
  if (!gl) {
    canvas.remove();
    finishEarly();
    return () => {};
  }
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive 辉光（等同 2D 的 globalCompositeOperation="lighter"）

  // 着色器：顶点把 CSS 像素坐标转 clip 空间（y 翻转）；片元用 gl_PointCoord 程序化软辉光。
  // 火色由 CPU 端按粒子生命插值后随顶点属性传入，替代 3 档预渲染精灵。
  const VERT = `
    attribute vec2 a_pos;
    attribute float a_size;
    attribute float a_alpha;
    attribute vec3 a_color;
    attribute float a_core;
    uniform vec2 u_resCss;
    uniform float u_dpr;
    varying float v_alpha;
    varying vec3 v_color;
    varying float v_core;
    void main() {
      vec2 clip = vec2(
        a_pos.x / u_resCss.x * 2.0 - 1.0,
        1.0 - a_pos.y / u_resCss.y * 2.0
      );
      gl_Position = vec4(clip, 0.0, 1.0);
      gl_PointSize = a_size * 2.0 * u_dpr;
      v_alpha = a_alpha;
      v_color = a_color;
      v_core = a_core;
    }`;
  const FRAG = `
    precision mediump float;
    varying float v_alpha;
    varying vec3 v_color;
    varying float v_core;
    void main() {
      vec2 c = gl_PointCoord - vec2(0.5);
      float d = length(c);
      float glow = smoothstep(0.5, 0.0, d); // 中心亮、边缘柔化到 0
      // 白热核心只在该粒子最出生的极小中心、且最年轻时出现（pow(glow,4) 把白核压成针尖大小）；
      // 其余区域一律是 v_color 的橙黄火色——否则白核太大、加性叠加会把整片前沿饱和成纯白。
      vec3 col = mix(v_color, vec3(1.0, 0.96, 0.86), v_core * pow(glow, 4.0));
      float a = glow * v_alpha;
      gl_FragColor = vec4(col, a); // 配合 SRC_ALPHA,ONE 实现 additive 辉光
    }`;
  const compile = (type: number, src: string): WebGLShader | null => {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error("erode 着色器编译失败:", gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  };
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  const program = gl.createProgram();
  if (!vs || !fs || !program) {
    canvas.remove();
    finishEarly();
    return () => {};
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("erode 着色器链接失败:", gl.getProgramInfoLog(program));
    canvas.remove();
    finishEarly();
    return () => {};
  }
  gl.useProgram(program);
  const a_pos = gl.getAttribLocation(program, "a_pos");
  const a_size = gl.getAttribLocation(program, "a_size");
  const a_alpha = gl.getAttribLocation(program, "a_alpha");
  const a_color = gl.getAttribLocation(program, "a_color");
  const a_core = gl.getAttribLocation(program, "a_core");
  const u_resCss = gl.getUniformLocation(program, "u_resCss");
  const u_dpr = gl.getUniformLocation(program, "u_dpr");
  gl.uniform2f(u_resCss, w, h);
  gl.uniform1f(u_dpr, dpr);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  const STRIDE = 8 * 4; // 字节：x,y,size,alpha,r,g,b,core
  gl.enableVertexAttribArray(a_pos);
  gl.vertexAttribPointer(a_pos, 2, gl.FLOAT, false, STRIDE, 0);
  gl.enableVertexAttribArray(a_size);
  gl.vertexAttribPointer(a_size, 1, gl.FLOAT, false, STRIDE, 8);
  gl.enableVertexAttribArray(a_alpha);
  gl.vertexAttribPointer(a_alpha, 1, gl.FLOAT, false, STRIDE, 12);
  gl.enableVertexAttribArray(a_color);
  gl.vertexAttribPointer(a_color, 3, gl.FLOAT, false, STRIDE, 16);
  gl.enableVertexAttribArray(a_core);
  gl.vertexAttribPointer(a_core, 1, gl.FLOAT, false, STRIDE, 28);
  const loseCtx = gl.getExtension("WEBGL_lose_context");

  // 发射点网格：铺满整面，位于锯齿侵蚀前沿上（每个点在其 T 时刻正处前沿）。
  // 预计算各点的**边缘法线**（T 场梯度方向 = 前沿推进方向），粒子沿法线喷射，
  // 于是水平边缘段向上喷、竖直锯齿段向侧向喷——粒子流贴合破碎边缘形状，物理联动更紧。
  const density = Math.max(0, Math.min(100, particleDensity)) / 100;
  const emitSpacing = 10; // 更密的发射点 → 粒子更多、边缘轨迹更细腻
  const ecx = Math.ceil(w / emitSpacing);
  const ecy = Math.ceil(h / emitSpacing);
  const emitX = new Float32Array(ecx * ecy);
  const emitY = new Float32Array(ecx * ecy);
  const emitT = new Float32Array(ecx * ecy); // 各发射点被前沿扫到的时刻
  const emitNX = new Float32Array(ecx * ecy); // 边缘法线（单位向量，指向前沿推进方向）
  const emitNY = new Float32Array(ecx * ecy);
  const emitW = new Float32Array(ecx * ecy); // 发射权重：末段前沿大幅降权，避免火星在终点堆成“墙”
  let ecount = 0;
  const GRAD_EPS = 4;
  for (let iy = 0; iy < ecy; iy++) {
    for (let ix = 0; ix < ecx; ix++) {
      const nx = (ix + 0.5) * emitSpacing;
      const ny = (iy + 0.5) * emitSpacing;
      emitX[ecount] = nx;
      emitY[ecount] = ny;
      const T = dissolveTimeAt(nx, ny);
      // 有限差分求 T 场梯度 → 边缘法线（materialize 用同一空间法线，方向随后处理）
      const gx = dissolveTimeAt(nx + GRAD_EPS, ny) - dissolveTimeAt(nx - GRAD_EPS, ny);
      const gy = dissolveTimeAt(nx, ny + GRAD_EPS) - dissolveTimeAt(nx, ny - GRAD_EPS);
      let gl = Math.sqrt(gx * gx + gy * gy);
      if (gl < 1e-3) gl = 1e-3;
      emitNX[ecount] = gx / gl;
      emitNY[ecount] = gy / gl;
      emitT[ecount] = isDissolve ? T : wipe - T; // materialize 反转
      // 末段前沿（无论 dissolve 的顶部、还是 materialize 的底部，都是 emitT 最大的最后一点）
      // 大幅降权：让火星不会在终点边缘持续堆积成一道“墙”。t01 越大 → 权重越小。
      const t01 = Math.max(0, Math.min(1, emitT[ecount] / wipe));
      let ww = 1 - t01;
      ww = ww * ww * ww; // 立方 → 末段强抑制
      emitW[ecount] = 0.05 + 0.95 * ww;
      ecount++;
    }
  }

  // 余烬粒子池（SoA + swap-remove）：寿命改短后同屏存活数大幅下降，池可相应缩小。
  const maxEmbers = Math.round(1100 + density * 2200); // 1100 ~ 3300（短命贴边，配合帧上限防开头爆满）
  const ex = new Float32Array(maxEmbers);
  const ey = new Float32Array(maxEmbers);
  const evx = new Float32Array(maxEmbers);
  const evy = new Float32Array(maxEmbers);
  const elife = new Float32Array(maxEmbers);
  const eage = new Float32Array(maxEmbers);
  const esize = new Float32Array(maxEmbers);
  const eseed = new Float32Array(maxEmbers);
  let emberCount = 0;
  // GPU 上传缓冲：每粒 8 float（x, y, size, alpha, r, g, b, core），每帧重写后单次 bufferData
  const glData = new Float32Array(maxEmbers * 8);

  // 在前沿点 (x,y) 沿边缘法线 (nmx,nmy) 喷出一粒火星。w 为发射权重（末段小 → 火星更小更弱）。
  // 关键：推力小、寿命短 → 单粒紧贴出生边、火舌只舔出一小段（约 10~20px），
  // 不飞散成团；“持久”由沿燃烧边**持续 spawn**（细水长流）保证，而非单粒长命漂走。
  // 法线让水平段向上喷、竖直锯齿段向侧向喷 → 粒子流贴合破碎边缘几何、与燃边紧密联动。
  const spawnEmber = (x: number, y: number, nmx: number, nmy: number, w: number) => {
    if (emberCount >= maxEmbers) return;
    const i = emberCount++;
    ex[i] = x + (Math.random() - 0.5) * 4;
    ey[i] = y + (Math.random() - 0.5) * 4;
    const kick = (16 + Math.random() * 26) * (0.5 + 0.5 * w); // 小推力：火舌贴边、不飞散成团
    // materialize 时前沿推进方向与 dissolve 相反，法线取反保持"沿推进方向喷"
    const dir = isDissolve ? 1 : -1;
    // 沿边缘法线小推力（贴合边缘几何）+ 轻微上升浮力（火舌向上舔）+ 极小湍流（不横向铺开）
    evx[i] = nmx * kick * dir + (Math.random() - 0.5) * 10;
    evy[i] = nmy * kick * dir - (28 + Math.random() * 46);
    elife[i] = 150 + Math.random() * 200; // 0.15~0.35s：短命→每粒紧贴出生边、不漂成团；持久由沿边持续 spawn 保证
    eage[i] = 0;
    esize[i] = (2.6 + Math.random() * 3.8) * (0.5 + 0.5 * w); // 更大更厚；末段更小
    eseed[i] = Math.random() * Math.PI * 2;
  };

  // ---- 便签本体：进入动画态 ----
  // dissolve：便签本就可见，清掉可能残留的 clip-path、改由 mask 接管；
  // materialize：保持空裁剪（clip-path inset），等空蒙版解码后再清除，避免闪现旧内容。
  if (isDissolve) {
    try {
      root.style.clipPath = "";
    } catch {
      /* ignore */
    }
  }
  root.style.boxShadow = "none";
  const setMask = (url: string) => {
    root.style.setProperty("-webkit-mask-image", `url("${url}")`);
    root.style.setProperty("mask-image", `url("${url}")`);
    root.style.setProperty("-webkit-mask-size", "100% 100%");
    root.style.setProperty("mask-size", "100% 100%");
    root.style.setProperty("-webkit-mask-repeat", "no-repeat");
    root.style.setProperty("mask-repeat", "no-repeat");
  };

  // 把当前 age 对应的蒙版写入 canvas 并返回是否还有内容（materialize 起始全透明）
  const renderMask = (age: number): void => {
    let p = 0;
    for (let i = 0; i < Tfield.length; i++) {
      let T = Tfield[i];
      if (!isDissolve) T = wipe - T;
      const local = age - T;
      let a = local / featherMs; // -inf..+inf
      if (a < 0) a = 0;
      else if (a > 1) a = 1;
      if (isDissolve) a = 1 - a; // dissolve：可见→消散
      const alphaByte = (a * 255) & 0xff;
      px32[p++] = (alphaByte << 24) | 0x00ffffff; // RGB 白 + alpha
    }
    mctx.putImageData(img, 0, 0);
  };

  // 蒙版替换：先解码（new Image onload）再 set，避免逐帧 dataURL 闪烁。
  // 关键：用 lastAppliedSeq 跟踪「已应用的最新帧序号」——只丢弃比已应用更旧的帧，
  // 绝不能用 seq !== maskSeq 丢弃（否则 Image 解码慢于推帧间隔(30ms)时，中间所有帧都会被
  // 判为"非最新"而丢弃，setMask 直到最后一帧才执行 → materialize 的 mask 永远停在全透明、
  // 便签被透明 mask 藏住、直到收尾 restoreRoot 才"瞬间出现"，表现为"只有粒子、没有便签"）。
  let lastMaskPush = -1;
  let maskSeq = 0;
  let lastAppliedSeq = 0; // 已应用的最大帧序号
  const pushMask = (age: number, force: boolean): void => {
    if (!force && age - lastMaskPush < 30) return; // ~30Hz 更新蒙版即可（羽化边缘平滑）
    lastMaskPush = age;
    renderMask(age);
    const url = maskCanvas.toDataURL();
    const seq = ++maskSeq;
    const im = new Image();
    const apply = (): void => {
      if (endedLocal || seq < lastAppliedSeq) return; // 丢弃比已应用更旧的帧（防乱序回退）
      lastAppliedSeq = seq;
      setMask(url);
    };
    im.onload = apply;
    im.onerror = () => {
      // 解码失败兜底：materialize 直接显示本体（清 mask + 还原 opacity），避免卡在空白等看门狗；
      // dissolve 本体本就可见，mask 仅增强裁切，解码失败可忽略。
      if (endedLocal || isDissolve || seq < lastAppliedSeq) return;
      lastAppliedSeq = seq;
      try {
        root.style.opacity = "1";
        root.style.setProperty("-webkit-mask-image", "");
        root.style.setProperty("mask-image", "");
      } catch {
        /* ignore */
      }
    };
    im.src = url;
  };

  // 全局透明度：dissolve 从完全不透明缓慢淡出到透明度 70%（opacity 0.3）即止——
  // 剩余画面由后续「火烧/关闭」收尾，无需完全透明；materialize 从全透明淡入到不透明。
  // 淡出放缓：dissolve 用整个动画时长（wipe+tailMs）完成淡出，而不是随 wipe 一起结束。
  const applyOpacity = (age: number): void => {
    const fadeSpan = isDissolve ? duration : wipe;
    let p = age / fadeSpan;
    if (p < 0) p = 0;
    else if (p > 1) p = 1;
    const o = isDissolve ? 1 - p * 0.7 : p;
    root.style.opacity = o.toFixed(3);
  };

  // ---- 帧循环 ----
  // rafId/backupId 是本动画实例的局部句柄（不能是模块级：多个动画实例并存时
  // 共享句柄会导致 A 的 stopLoop 取消掉 B 的 rAF，帧循环互相踩踏、动画卡死）。
  let rafId = 0;
  let backupId = 0;
  let start = 0;
  let started = false;
  let prevNow = 0;
  let lastPaint = 0;
  let endedLocal = false;
  let watchdog = 0; // 强制收尾看门狗句柄

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
    // 无法渲染时直接收尾（dissolve：隐藏；materialize：复原）
    stopLoop();
    if (isDissolve) {
      blankRoot(root);
      onDone();
    } else {
      restoreRoot(root);
      materializing = false;
      onDone();
    }
  }

  const cleanupAfterHide = () => {
    stopLoop();
    // 保持"空画面"供下次呼出（契约同 dissolve.ts cleanup）
    blankRoot(root);
    try {
      canvas.remove();
    } catch {
      /* ignore */
    }
    try {
      loseCtx?.loseContext(); // 释放 GPU 资源，避免透明窗口下上下文泄漏
    } catch {
      /* ignore */
    }
    eroding = false;
  };

  const finishMaterialize = () => {
    stopLoop();
    restoreRoot(root);
    try {
      canvas.remove();
    } catch {
      /* ignore */
    }
    try {
      loseCtx?.loseContext(); // 释放 GPU 资源，避免透明窗口下上下文泄漏
    } catch {
      /* ignore */
    }
    materializing = false;
  };

  const frame = (now: number) => {
    if (endedLocal) return; // 已取消/收尾：丢弃迟到帧（rAF 回调入队后无法撤销，必须在此拦截）
    if (!started) {
      started = true;
      start = now;
      prevNow = now;
    }
    const dt = Math.min(0.05, Math.max(0.001, (now - prevNow) / 1000));
    prevNow = now;
    // age 取真实墙钟（首帧定 start），与位移积分解耦
    const age = now - start;

    pushMask(age, false);
    applyOpacity(age);

    // ---- 余烬：随燃烧前沿推进、沿边持续渗出（细水长流）+ 更新 + 绘制 ----
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (age < wipe + 60) {
      // 燃烧边缘 = 该点 mask 从“可见”变“透明”的过渡带（age ∈ [T, T+featherMs]）。
      // 火星根必须落在窗口 [T+burstAt, T+winEnd] 内：
      //   - burstAt=featherMs/2：等到半透明边才点燃 → 根对齐“正在燃烧”处，不滞后已烧黑区；
      //   - winEnd=featherMs+360：火舌飘离前沿一小段再熄，根随前沿推进而上移。
      // 每个点在其窗口内**每帧低概率 spawn 1 粒**（而非一次性爆发一大簇），于是：
      //   - 整段动画期间只要还有点处于窗口就持续冒 → 后边也出现（旧版一次爆发 + 长寿命把池塞满→后边寂灭）；
      //   - 根沿边缘铺开、连续渗出的火舌，而不是一上来全屏齐发成“一团”。
      const burstAt = featherMs * 0.5; // 相对 T：等到半透明边才点燃
      const winEnd = featherMs + 150;  // 火舌稍离前沿即熄（短命已保证贴边；不再长尾随拖出已烧黑区火云）
      // 全局每帧 spawn 上限：防止开头一帧把粒子池塞满、导致后续燃到的点 spawn 不到空位（后边寂灭）。
      // 配合短寿命，粒子在整段动画里均匀周转、持续可见。
      const spawnProb = 0.7; // 窗口内每点每帧 spawn 概率（细水长流）
      const FRAME_CAP = Math.round(40 + density * 50); // 每帧最多约 40~90 粒
      let spawned = 0;
      for (let i = 0; i < ecount; i++) {
        const T = emitT[i];
        if (age < T + burstAt) continue;   // 沿前沿推进而点燃（根对齐燃烧边）
        if (age > T + winEnd) continue;    // 火舌飘离后熄灭，不在已烧黑区滞留
        if (spawned >= FRAME_CAP) break;   // 全帧上限：避免开头爆满
        if (Math.random() < emitW[i] * spawnProb) {
          // 根仅极小抖动（火舌细、紧贴燃边、不挤成一簇）
          const ox = (Math.random() - 0.5) * 6;
          const oy = (Math.random() - 0.5) * 6;
          spawnEmber(emitX[i] + ox, emitY[i] + oy, emitNX[i], emitNY[i], emitW[i]);
          spawned++;
        }
      }
    }
    // ---- 余烬：GPU 点精灵单次 draw call（additive 辉光，替代 2D 逐粒 drawImage）----
    if (emberCount > 0) {
      let p = 0;
      for (let i = 0; i < emberCount; i++) {
        let a = eage[i] + dt * 1000;
        eage[i] = a;
        const life = elife[i];
        if (a >= life) {
          // swap-remove
          const last = --emberCount;
          if (i !== last) {
            ex[i] = ex[last]; ey[i] = ey[last]; evx[i] = evx[last]; evy[i] = evy[last];
            elife[i] = elife[last]; eage[i] = eage[last]; esize[i] = esize[last]; eseed[i] = eseed[last];
          }
          i--;
          continue;
        }
        const sway = Math.sin(a * 0.006 + eseed[i]) * 10; // 小幅摆动（短命下仅几 px，不横向铺开成团）
        ex[i] += (evx[i] + sway) * dt;
        ey[i] += evy[i] * dt;
        const life01 = a / life;
        const alpha = Math.min(1, (1 - life01) * (1 - life01 * 0.15) * 1.25); // 中段更亮更持久、末端才淡出
        if (alpha < 0.02) continue; // 末端极淡：本帧不画（仍留池中）
        const r = esize[i] * (1 - life01 * 0.4); // 冷却收缩更缓：火挂更久、离前沿后缩小变暗
        // 火色（光晕色）：随生命从亮黄橙(热)冷却到暗红(冷)连续插值。
        // 蓝色通道在整个生命周期压到 ~0：加性叠加时蓝永不饱和，密集前沿只会叠到黄/橙，
        // 而不会像原配色(蓝≈0.2~0.46)那样叠多了蓝也顶满 → 整片泛白。
        let cr: number, cg: number, cb: number;
        if (life01 < 0.4) {
          const t = life01 / 0.4;
          cr = 1; cg = 0.82 + (0.55 - 0.82) * t; cb = 0.08 * (1 - t); // 热：亮黄橙→橙（更黄更浓；仅出生一丝暖蓝）
        } else if (life01 < 0.75) {
          const t = (life01 - 0.4) / 0.35;
          cr = 1; cg = 0.55 + (0.32 - 0.55) * t; cb = 0; // 中：橙（更亮）
        } else {
          const t = (life01 - 0.75) / 0.25;
          cr = 1 + (0.72 - 1) * t; cg = 0.32 + (0.14 - 0.32) * t; cb = 0; // 冷：暗红（略提亮避免太暗淡）
        }
        // 白热核心只在该粒子最出生的极短瞬间(life01<0.18)出现，且迅速衰减；
        // 其余时间 coreW=0 → 粒子完全是橙黄火色，不再整体发白。
        const coreW = life01 < 0.18 ? Math.pow(1 - life01 / 0.18, 2) : 0;
        glData[p] = ex[i]; glData[p + 1] = ey[i]; glData[p + 2] = r;
        glData[p + 3] = alpha; glData[p + 4] = cr; glData[p + 5] = cg; glData[p + 6] = cb;
        glData[p + 7] = coreW;
        p += 8;
      }
      if (p > 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, glData.subarray(0, p), gl.DYNAMIC_DRAW);
        gl.drawArrays(gl.POINTS, 0, p / 8);
      }
    }

    if (age >= duration) {
      if (isDissolve) {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        stopLoop();
        try {
          onDone(); // 触发真正隐藏窗口
        } finally {
          window.setTimeout(cleanupAfterHide, 400);
        }
      } else {
        window.clearInterval(backupId);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        finishMaterialize();
        onDone();
      }
      return;
    }
  };

  const step = (now: number) => {
    lastPaint = now;
    frame(now);
    if (!endedLocal) rafId = requestAnimationFrame(step);
  };

  // 两种方向都同步启动循环（不依赖 Image.onload），避免首帧蒙版未解码时循环永不开始、
  // materialize 卡死（便签呼出后无内容、materializing 卡 true、后续呼出被忽略）。
  // dissolve 首帧为全可见、materialize 首帧为全透明，各自与语义一致。
  renderMask(0);
  setMask(maskCanvas.toDataURL());
  if (isDissolve) {
    try {
      root.style.clipPath = "";
    } catch {
      /* ignore */
    }
  } else {
    // materialize：清掉 flame 残留的 clip-path 空裁切，由 mask 接管；起始 opacity=0
    // 配合 applyOpacity 淡入，杜绝闪现旧内容。
    try {
      root.style.clipPath = "";
    } catch {
      /* ignore */
    }
    root.style.opacity = "0";
  }
  rafId = requestAnimationFrame(step);
  backupId = window.setInterval(() => {
    if (endedLocal) return;
    const now = performance.now();
    if (now - lastPaint > 60) {
      lastPaint = now;
      frame(now);
    }
  }, 40);

  // 看门狗：无论循环是否推进，到时强制收尾——materialize 复原内容 / dissolve 隐藏窗口，
  // 彻底杜绝「呼出后便签无内容」卡死（与 summon.ts 的看门狗同思路）。
  watchdog = window.setTimeout(() => {
    if (endedLocal) return;
    stopLoop();
    if (isDissolve) {
      cleanupAfterHide();
      onDone();
    } else {
      finishMaterialize();
      onDone();
    }
  }, duration + 600);

  // 返回“立即中止”句柄（cancelErode 调用）：停帧、移除覆盖层、复原页面样式。
  // 中止 = 保持窗口可见（呼出打断关闭 / 关闭打断呼出都走这里）。
  return () => {
    stopLoop();
    restoreRoot(root);
    try {
      canvas.remove();
    } catch {
      /* ignore */
    }
    try {
      loseCtx?.loseContext(); // 释放 GPU 资源，避免透明窗口下上下文泄漏
    } catch {
      /* ignore */
    }
  };
}
