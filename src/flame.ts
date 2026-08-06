// 便签「火焰消散」动画：火焰式逐像素消散（像真实火舌舔过纸面与金属；与粒子光效 dissolve/summon 为两套独立效果）
// ----------------------------------------------------------------------------
// 触发：关闭窗口 / 呼出窗口时播放（与火焰二选一，由设置 particle_mode 决定）。
//
// 效果（对齐用户需求）：
// - 从底部开始向上消散，但消散边界**不是水平直线**——边缘呈锯齿状 / 波浪状 / 破碎状，
//   像真实火焰舔过纸面与金属；
// - 同一水平线上不同位置的消散进度有随机差异（±200ms），有的已消散到中部、有的还在底部，
//   形成错落有致的节奏；
// - 消散起点不止整条底边：还在底部随机布置 2~3 个「种子点」，像墨水滴在宣纸上一样
//   向四周扩散（不规则圆 / 椭圆），与底部推进前沿取 min 融合成多前沿火焰；
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
// - 火焰覆盖层：canvas 上以连续火舌场（见 VERT/FRAG 着色器）在燃烧前沿处舔出分层火焰，
//   半透明、无离散颗粒（独立元素，不随便签本体一起变透明）。
// - 关闭(dissolve)与呼出(materialize)互为倒放：dissolve 底部向上消失，
//   materialize 顶部向下成形（用 Tm = wipe - T 反转同一时间场）。

let flaming = false;
let materializing = false;
/** 动画代次：每次 runFlame 启动 +1。上一轮动画遗留的延时清理（cleanupAfterHide）凭此作废，
 *  避免快速呼出时把正在播放的新动画便签裁掉/隐藏（见 cleanupAfterHide 守卫）。 */
let flameGen = 0;

/** 当前火焰动画的“立即中止”句柄（由 runFlame 注册；cancelFlame 调用）。
 *  中止 = 停帧 + 复原页面（保持可见，供“呼出打断关闭”等快速切换）。 */
let cancelFlameFn: (() => void) | null = null;

/** 立即中止火焰动画并复原页面（关闭动画开始前调用，避免与呼出动画同时改 mask/透明度；
 *  呼出打断关闭时也调用——此时不触发 onDone，窗口保持显示）。 */
export function cancelFlame(): void {
  const c = cancelFlameFn;
  cancelFlameFn = null;
  if (c) {
    c();
    return;
  }
  // 兜底：无注册句柄时（理论不会出现）直接复原
  if (!flaming && !materializing) return;
  flaming = false;
  materializing = false;
  const root = document.querySelector(".note-window") as HTMLElement | null;
  if (root) restoreRoot(root);
  document.querySelector(".flame-canvas")?.remove();
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

/** 请求播放「火焰消散」关闭动画；onDone 在动画完全结束后调用（用于真正关闭窗口）。 */
export function requestFlameDissolveClose(onDone: () => void, particleDensity = 50): void {
  const root = document.querySelector(".note-window") as HTMLElement | null;
  if (!root || flaming) {
    onDone();
    return;
  }
  flaming = true;
  let done = false;
  let aborted = false;
  let stopRun: (() => void) | null = null;
  const safeDone = () => {
    if (done) return;
    done = true;
    flaming = false;
    cancelFlameFn = null;
    onDone();
  };
  const watchdog = window.setTimeout(safeDone, 4000);
  cancelFlameFn = () => {
    if (aborted) return;
    aborted = true;
    window.clearTimeout(watchdog);
    if (stopRun) stopRun();
    done = true; // 阻止 onDone：finish() 不会被调用，窗口保持显示
    flaming = false;
  };
  try {
    stopRun = runFlame(root, "dissolve", particleDensity, () => {
      window.clearTimeout(watchdog);
      safeDone();
    });
  } catch (e) {
    console.error("火焰消散动画异常:", e);
    window.clearTimeout(watchdog);
    safeDone();
  }
}

/** 播放「火焰成形」呼出动画（关闭的倒放：顶部向下成形）；收尾自动复原页面。 */
export function playFlameMaterialize(root: HTMLElement, particleDensity = 50): void {
  // 强制接管：若已有火焰动画在播放（快速呼出时上一轮动画未收尾、materializing 残留），
  // 先取消旧的再启动新的，杜绝「呼出被静默拒绝 → 窗口空画面永久卡死」。
  if (materializing || flaming) cancelFlame();
  materializing = true;
  let aborted = false;
  let stopRun: (() => void) | null = null;
  cancelFlameFn = () => {
    if (aborted) return;
    aborted = true;
    if (stopRun) stopRun();
    materializing = false;
  };
  try {
    stopRun = runFlame(root, "materialize", particleDensity, () => {
      /* materialize 收尾在 runFlame 内自行复原，无需额外 onDone */
    });
  } catch (e) {
    console.error("火焰成形动画异常:", e);
    cancelFlameFn = null;
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
 * 播放一次火焰动画。
 * @param direction "dissolve"=关闭消散（底部向上）；"materialize"=呼出成形（顶部向下，倒放）
 */
function runFlame(
  root: HTMLElement,
  direction: "dissolve" | "materialize",
  particleDensity: number,
  onDone: () => void,
): () => void {
  const myGen = ++flameGen; // 本动画实例代次：作废上一轮遗留的延时清理
  const isDissolve = direction === "dissolve";
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // 内容尺寸（便签本体）：动画开始前窗口尚未扩大，innerWidth/Height 即便签尺寸。
  const w = window.innerWidth;
  const h = window.innerHeight;

  // ---- 时序参数 ----
  const wipe = 1000; // 消散 / 成形主体时长 ms（用户要求约 1 秒）
  const featherMs = 90; // 羽化软边时间带宽（越大边缘越柔）
  const tailMs = isDissolve ? 520 : 160; // 收尾余时（关闭时让火舌多停留片刻；成形更短）
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
    // 种子点扩散场（不规则椭圆），取 min → 多前沿火焰 / 局部破洞
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

  // ---- 火焰覆盖层 canvas ----
  const canvas = document.createElement("canvas");
  canvas.className = "flame-canvas";
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
  // ---- 火焰渲染：全屏 quad + 火焰场片元着色器（见 VERT/FRAG） ----
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
  // 火焰本体用普通 alpha 混合（非加性）：颜色保真（橙就是橙，不会被叠成白/黄），且天然半透明。
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  // 火焰场着色器：全屏 quad，片元用分形噪声 + 消散蒙版烘焙出「连续火焰」（非离散粒子）。
  // 火焰紧贴燃烧前沿、向上（空气侧）舔出细长火舌；颜色按火舌高度分层（根暖白黄→橙→舌尖暗红）；半透明。
  const VERT = `
    attribute vec2 a_pos;          // clip 空间全屏四边形（-1..1）
    varying vec2 v_uv;             // 0..1，y=0 底 / 1 顶
    void main() {
      v_uv = a_pos * 0.5 + 0.5;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }`;
  const FRAG = `
    precision mediump float;
    varying vec2 v_uv;
    uniform float u_time;          // 秒（火焰闪烁/上卷）
    uniform float u_density;       // 0..1 强度（粒子密度设置）
    uniform sampler2D u_mask;      // 消散蒙版：.a = 剩余可见度（1 可见 / 0 已烧没）
    uniform sampler2D u_flame;     // 火焰高度场：.r = 距燃烧前沿的屏幕归一化高度(0 前沿..~1 活动侧远端)，.g = 是否允许出火
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p){
      vec2 i = floor(p), f = fract(p);
      float a = hash(i), b = hash(i + vec2(1.0,0.0)), c = hash(i + vec2(0.0,1.0)), d = hash(i + vec2(1.0,1.0));
      vec2 u = f*f*(3.0-2.0*f);
      return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
    }
    float fbm(vec2 p){
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.0; a *= 0.5; }
      return v;
    }
    void main() {
      float ny = v_uv.y;                                        // 0 底 .. 1 顶
      float vis  = texture2D(u_mask,  vec2(v_uv.x, 1.0 - ny)).a;   // 画布顶=纹理 v=0，需翻转
      float hgt  = texture2D(u_flame, vec2(v_uv.x, 1.0 - ny)).r;   // 距前沿高度（0 前沿 .. ~1 活动侧远端）
      float gate = texture2D(u_flame, vec2(v_uv.x, 1.0 - ny)).g;   // 本列存在真实前沿且位于活动侧 → 允许出火
      if (gate < 0.5) { gl_FragColor = vec4(0.0); return; }
      // 火舌高度包络：以前沿（hgt=0）为根，向活动侧（hgt 增大）高斯衰减 → 形成有真实高度的连续火舌（可达约 0.3 屏高）。
      float envH = exp(-(hgt * hgt) / (2.0 * 0.13 * 0.13));
      // 上升火舌：分形噪声随时间向上滚动（rise 增大 → 火苗整体上移），横向起伏 → 跳动、参差的火苗。
      float rise = u_time * 1.9;
      vec2 q = vec2(v_uv.x * 8.0, hgt * 7.0 - rise);
      float n  = fbm(q);
      float n2 = fbm(q * 2.7 + vec2(13.0, -rise * 0.6));
      float tongues = 0.45 + 0.95 * n;       // 噪声高=火苗旺、低=凹陷
      float flick   = 0.55 + 0.7 * n2;       // 明灭变化（明暗过渡）
      float flame = clamp(envH * tongues * flick, 0.0, 1.0);
      // 竖向分层配色：根（hgt≈0）白热 → 橙 → 红 → 暗红（火尖）；降黄（根加白）。
      vec3 cCore = vec3(1.00, 0.96, 0.78);   // 根：白热（非纯黄）
      vec3 cMid  = vec3(1.00, 0.55, 0.16);   // 中：橙
      vec3 cEdge = vec3(0.86, 0.20, 0.05);   // 红
      vec3 cTip  = vec3(0.30, 0.05, 0.02);   // 尖：暗红
      vec3 col;
      if (hgt < 0.13)          col = mix(cCore, cMid, clamp(hgt / 0.13, 0.0, 1.0));
      else if (hgt < 0.32)     col = mix(cMid, cEdge, (hgt - 0.13) / 0.19);
      else                     col = mix(cEdge, cTip, clamp((hgt - 0.32) / 0.5, 0.0, 1.0));
      // 明灭：核心随噪声提亮（白热闪动），火尖压暗，形成真实明暗过渡。
      col += cCore * 0.30 * smoothstep(0.65, 1.0, n) * (1.0 - clamp(hgt / 0.4, 0.0, 1.0));
      // 半透明：根部更实、火尖更透；强度随 density 微调。整体提亮确保火苗清晰可见。
      float alpha = flame * (1.0 - clamp(hgt / 0.5, 0.0, 1.0) * 0.6) * (0.62 + 0.38 * u_density);
      alpha = clamp(alpha, 0.0, 0.95);
      gl_FragColor = vec4(col, alpha);
    }`;
  const compile = (type: number, src: string): WebGLShader | null => {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error("flame 火焰着色器编译失败:", gl.getShaderInfoLog(sh));
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
    console.error("flame 火焰着色器链接失败:", gl.getProgramInfoLog(program));
    canvas.remove();
    finishEarly();
    return () => {};
  }
  gl.useProgram(program);

  // 火焰强度（粒子密度设置映射 0..1），供着色器 u_density 控制整体亮度/浓度。
  const density = Math.max(0, Math.min(100, particleDensity)) / 100;

  // 全屏四边形（两三角）：覆盖整张画布；火焰在片元着色器内按「消散蒙版 + 噪声」连续生成。
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 1, -1, -1, 1,
    -1, 1, 1, -1, 1, 1,
  ]), gl.STATIC_DRAW);
  const a_pos = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(a_pos);
  gl.vertexAttribPointer(a_pos, 2, gl.FLOAT, false, 0, 0);

  // 消散蒙版纹理：每帧由 maskCanvas 上传，供火焰着色器定位燃烧前沿（含其锯齿/噪声起伏）。
  const u_time = gl.getUniformLocation(program, "u_time");
  const u_density = gl.getUniformLocation(program, "u_density");
  const u_mask = gl.getUniformLocation(program, "u_mask");
  const maskTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, maskTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.uniform1f(u_density, density); // 火焰强度（density 已在 useProgram 后声明）
  gl.uniform1i(u_mask, 0); // 绑定到纹理单元 0

  // 火焰高度场纹理（屏幕归一化“距燃烧前沿的高度”），供着色器把火焰舔出真实高度（而非仅贴着细窄前沿）。
  const u_flame = gl.getUniformLocation(program, "u_flame");
  const flameCanvas = document.createElement("canvas");
  flameCanvas.width = mw;
  flameCanvas.height = mh;
  const fctx = flameCanvas.getContext("2d");
  if (!fctx) {
    canvas.remove();
    finishEarly();
    return () => {};
  }
  const flameImg = fctx.createImageData(mw, mh);
  const flamePx32 = new Uint32Array(flameImg.data.buffer);
  const flameTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, flameTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.uniform1i(u_flame, 1); // 绑定到纹理单元 1
  gl.activeTexture(gl.TEXTURE0); // 复原默认单元（后续每帧在 TEXTURE0 上传 mask）

  const loseCtx = gl.getExtension("WEBGL_lose_context");

  // 计算“距燃烧前沿的高度场”：逐列定位 α 穿越 0.5 的前沿行，再算每像素在活动侧距前沿的归一化高度，
  // 写入 flameCanvas（R=高度、G=是否允许出火），供着色器把火焰舔出真实高度（而非仅贴着细窄前沿）。
  // 仅当本列存在“真实前沿”（α 确实穿过 0.5）且像素位于活动侧时出火，避免整张纸一起烧 / 前沿未到就出火。
  const frontArr = new Float32Array(mw);
  const computeFlameField = (): void => {
    const cols = mw, rows = mh;
    // 顶部 α 判断活动侧：dissolve 顶部=纸(α高)活动侧在上；materialize 顶部=隐(α低)活动侧在下。
    const topAlpha = ((px32[0] >>> 24) & 0xff) / 255;
    const activeTop = topAlpha > 0.5;
    for (let x = 0; x < cols; x++) {
      let f = -1;
      let prev = ((px32[x] >>> 24) & 0xff) / 255; // 顶行
      for (let y = 1; y < rows; y++) {
        const cur = ((px32[x + y * cols] >>> 24) & 0xff) / 255;
        if ((prev - 0.5) * (cur - 0.5) <= 0 && prev !== cur) {
          f = (y - 1) + (0.5 - prev) / (cur - prev); // 线性插值穿越点
          break;
        }
        prev = cur;
      }
      frontArr[x] = f;
    }
    let p = 0;
    for (let y = 0; y < rows; y++) {
      const yN = y / rows;
      for (let x = 0; x < cols; x++) {
        const f = frontArr[x];
        let r = 0, g = 0;
        if (f >= 0) {
          const fN = f / rows;
          // 活动侧（火舌舔入方向）为正：dissolve 活动在上 → (fN - yN)；materialize 活动在下 → (yN - fN)。
          const dActive = activeTop ? fN - yN : yN - fN;
          if (dActive > 0) {
            const hh = dActive > 1 ? 1 : dActive;
            r = (hh * 255) | 0;
            g = 255;
          }
        }
        flamePx32[p++] = (255 << 24) | (g << 16) | (g << 8) | r; // R=高度, G=允许出火, B=g, A=255
      }
    }
    fctx.putImageData(flameImg, 0, 0);
  };

  // 注：原「余烬点精灵」覆盖层已移除——火焰改为连续火舌场（见 VERT/FRAG），
  // 由消散蒙版 + 分形噪声 + 高度场在片元着色器内整体生成，不再有离散颗粒/上升力。

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
    // 代次守卫：若已启动新动画（flameGen 改变），本实例的延时清理作废，
    // 否则会把正在播放的新动画便签裁掉/隐藏（快速关闭后立刻呼出时会触发）。
    if (myGen !== flameGen) return;
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
    flaming = false;
  };

  const finishMaterialize = () => {
    stopLoop();
    if (myGen !== flameGen) return; // 已被新动画接管：勿复位其样式
    materializing = false;
    // 让“便签已完整显现”的最后一帧先提交，再移除覆盖层与复位样式，避免收尾闪一下。
    requestAnimationFrame(() => {
      if (myGen !== flameGen) return; // 期间已启动新动画：勿复位其样式
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
      restoreRoot(root);
    });
  };

  const frame = (now: number) => {
    if (endedLocal) return; // 已取消/收尾：丢弃迟到帧（rAF 回调入队后无法撤销，必须在此拦截）
    if (!started) {
      started = true;
      start = now;
    }
    // age 取真实墙钟（首帧定 start），与位移积分解耦
    const age = now - start;

    pushMask(age, false);
    applyOpacity(age);

    // ---- 火焰覆盖层：把当前消散蒙版 + 高度场上传为纹理，再用全屏 quad 着色器烘焙「连续火焰」 ----
    // 蒙版已在 pushMask 中按 age 烘焙到 maskCanvas（含燃烧前沿的锯齿/噪声起伏）；
    // 高度场（computeFlameField）据蒙版定位前沿、算出各像素距前沿高度 → 火焰着色器据此
    // 把分层火舌舔出真实高度——无离散颗粒、无上升“力”，但具备跳动/上升的真实燃烧感。
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    computeFlameField();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, flameTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, flameCanvas);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
    gl.uniform1f(u_time, age * 0.001); // 秒：驱动火舌上卷/闪烁
    gl.drawArrays(gl.TRIANGLES, 0, 6);

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

  // 返回“立即中止”句柄（cancelFlame 调用）：停帧、移除覆盖层、复原页面样式。
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
