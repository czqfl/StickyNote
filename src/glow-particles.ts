// 便签「粒子光效」统一动画：鸿蒙通知删除同款 —— 界面碎裂成大量发光微粒，
// 区域化朝相近方向加速上升、边升边淡出，全程带光晕辉光。
// ----------------------------------------------------------------------------
// 触发：关闭窗口（dissolve，顶部+底部双起点相向消散）/ 呼出窗口（materialize，互为倒放）。
// 两个方向**共用同一套粒子系统** → 粒子的形态 / 大小 / 颜色表现完全一致（仅运动方向相反）。
//
// 视觉要点（对齐需求规格）：
// - 双起点消散形态：便签本体用「时间场 T(x,y)」+ mask 逐像素裁切——
//   · 顶部起点：顶部快速向下推进，且向两侧蔓延快（左上角/右上角先被吞没）；
//   · 底部起点：底部慢速向上推进，边界呈驼峰状（中间快、两侧慢）；
//   · 顶部到达侧边后沿侧边向下"流淌"（速度介于顶底之间）；
//   · 上下两个消散区域在中央附近汇合，界面完全消失。
//   叠加 fbm 噪声 + 细碎抖动，边缘随机破碎（参考侵蚀的随机感，不破坏整体形态）。
// - 粒子数量随时间递增：前 50% 动画时间消散的粒子少、后 50% 多（粒子化速度较快，
//   主体粒子集中在动画后半段涌出），粒子寿命长、持续飘散。
// - 区域趋同方向：水平按 ~100px 划区，每区基础飘散角（垂直向上 ±8° 扇形 + 低频噪声错落），
//   同区粒子方向相近、不同区错落，逐粒抖动 ±3° → 整体向上飘散的粒子感。
// - 加速上升：ease-in-quad 二次缓动，初速 200-330px/s → 末速 520-780px/s，逐粒子 ±15% 随机差异，
//   附加极轻微左右摆动，柔和不"嗖"地飞走。
// - 颜色（动态主题采样）：构建便签"区域颜色场"（--bg 底色 + has-bg 背景图 cover 为主导，
//   底色仅轻量调和），按粒子**生成区域**采样对应背景颜色（背景是什么颜色粒子就是什么颜色），
//   additive 叠加出辉光，边升边变淡直至自然消散。
// - 形态/大小：鸿蒙式细微光点（亮核 ~0.6-1.5px + 外晕收紧），寿命 900~1500ms 飘散持久。
//
// 工程契约（与 erode.ts 一致）：canvas 覆盖层画粒子（z-index 置顶、pointer-events:none）；
// cancelGlowParticles() 立即中止（停帧+复原页面、不触发 onDone），供"呼出↔关闭"互相打断；
// 看门狗强制收尾，杜绝动画卡死导致窗口无法关闭/成形。

let glowActive = false;

/** 当前粒子动画的“立即中止”句柄（由 runGlow 注册；cancelGlowParticles 调用）。 */
let cancelGlowFn: (() => void) | null = null;

/** 立即中止粒子动画并复原页面（呼出打断关闭 / 关闭打断呼出时调用——不触发 onDone，窗口保持显示）。 */
export function cancelGlowParticles(): void {
  const c = cancelGlowFn;
  cancelGlowFn = null;
  if (c) {
    c();
    return;
  }
  // 兜底：无注册句柄时（理论不会出现）直接复原页面
  if (!glowActive) return;
  glowActive = false;
  const root = document.querySelector(".note-window") as HTMLElement | null;
  if (root) restoreRoot(root);
  document.querySelector(".glow-particles-canvas")?.remove();
}

/** 复原便签本体样式（裁剪 / mask / 透明度 / 阴影还原）。 */
function restoreRoot(root: HTMLElement): void {
  try {
    root.style.clipPath = "";
    root.style.setProperty("-webkit-mask-image", "");
    root.style.setProperty("mask-image", "");
    root.style.opacity = "";
    root.style.boxShadow = "";
  } catch {
    /* ignore */
  }
}

/** 隐藏便签本体（保持“空画面”，供下次呼出从空开始，契约与 erode.ts 一致）。 */
function blankRoot(root: HTMLElement): void {
  try {
    root.style.clipPath = "inset(0 0 100% 0)";
    root.style.setProperty("-webkit-mask-image", "");
    root.style.setProperty("mask-image", "");
    root.style.opacity = "";
    root.style.boxShadow = "none";
  } catch {
    /* ignore */
  }
}

/** 请求播放「粒子光效消散」关闭动画（自底向上）；onDone 在动画完全结束后调用（真正关闭窗口）。 */
export function requestGlowDissolveClose(onDone: () => void, particleDensity = 50): void {
  const root = document.querySelector(".note-window") as HTMLElement | null;
  if (!root || glowActive) {
    onDone();
    return;
  }
  glowActive = true;
  let done = false;
  let aborted = false;
  let stopRun: (() => void) | null = null;
  const safeDone = () => {
    if (done) return;
    done = true;
    glowActive = false;
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
    glowActive = false;
  };
  try {
    stopRun = runGlow(root, "dissolve", particleDensity, () => {
      window.clearTimeout(watchdog);
      safeDone();
    });
  } catch (e) {
    console.error("粒子光效消散动画异常:", e);
    window.clearTimeout(watchdog);
    safeDone();
  }
}

/** 播放「粒子光效成形」呼出动画（自顶向下，关闭的倒放）；收尾自动复原页面。 */
export function playGlowMaterialize(root: HTMLElement, particleDensity = 50): void {
  // 强制接管：若已有粒子光效动画在播放（快速呼出时上一轮动画未收尾、glowActive 残留），
  // 先取消旧的再启动新的，杜绝「呼出被静默拒绝 → 窗口空画面永久卡死」。
  if (glowActive) cancelGlowParticles();
  glowActive = true;
  let aborted = false;
  let stopRun: (() => void) | null = null;
  cancelGlowFn = () => {
    if (aborted) return;
    aborted = true;
    if (stopRun) stopRun();
    glowActive = false;
  };
  try {
    stopRun = runGlow(root, "materialize", particleDensity, () => {
      /* materialize 收尾在 runGlow 内自行复原，无需额外 onDone */
    });
  } catch (e) {
    console.error("粒子光效成形动画异常:", e);
    cancelGlowFn = null;
    glowActive = false;
    restoreRoot(root);
  }
}

// ---- 确定性哈希 / 值噪声（提供平滑团块 + 细碎抖动）----
function hash2(ix: number, iy: number): number {
  let n = (ix * 374761393 + iy * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n = n ^ (n >>> 16);
  return (n >>> 0) / 4294967295; // 0..1
}

function valueNoise1(x: number, seedY: number): number {
  const ix = Math.floor(x);
  const fx = x - ix;
  const ux = fx * fx * (3 - 2 * fx);
  const a = hash2(ix, seedY);
  const b = hash2(ix + 1, seedY);
  return a + (b - a) * ux;
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

// ---- 颜色工具：采样到的主题色提亮到足够发光的明度（保留色相）----
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hue(h + 1 / 3) * 255),
    Math.round(hue(h) * 255),
    Math.round(hue(h - 1 / 3) * 255),
  ];
}

/** 让粒子颜色贴近背景实际颜色：只在背景过暗时轻微提亮到最低可见明度（保留色相），
 *  不再强行拉亮成浅色——背景是什么颜色，粒子就是什么颜色。 */
function toGlowColor(r: number, g: number, b: number): [number, number, number] {
  const [h, s, l] = rgbToHsl(r, g, b);
  const nl = Math.max(l, 0.38); // 仅兜底：深色背景轻微提亮保证 additive 下可见
  const ns = Math.max(s, 0.2); // 避免发灰
  return hslToRgb(h, ns, nl);
}

interface ColorField {
  data: Uint8ClampedArray;
  fw: number;
  fh: number;
}

/** 提取 CSS 变量里的 url("...") → data URL；无则返回空串。 */
function extractUrl(prop: string): string {
  if (!prop) return "";
  const m = prop.match(/url\((['"]?)([\s\S]*?)\1\)/);
  return m ? m[2] : "";
}

/**
 * 构建便签「区域颜色场」（低分辨率）：肉眼所见背景色 = --bg 底色 +（has-bg 时）背景图 cover
 * + 面板半透明叠加（--note-panel-alpha）。随后按粒子生成区域采样主题色。
 * 背景图是 data URL（内存中），解码很快；给 140ms 上限，超时/失败回退纯色，绝不卡住动画。
 */
function buildColorField(root: HTMLElement, w: number, h: number): Promise<ColorField | null> {
  const fw = Math.max(8, Math.min(128, Math.round(w)));
  const fh = Math.max(8, Math.round((h * fw) / Math.max(1, w)));
  const c = document.createElement("canvas");
  c.width = fw;
  c.height = fh;
  const fctx = c.getContext("2d", { willReadFrequently: true });
  if (!fctx) return Promise.resolve(null);

  const cs = getComputedStyle(root);
  const bgColor = cs.backgroundColor || "rgb(128,128,128)";
  let panelAlpha = parseFloat(cs.getPropertyValue("--note-panel-alpha"));
  if (!isFinite(panelAlpha) || panelAlpha <= 0 || panelAlpha > 1) panelAlpha = 0.7;
  const dataUrl = extractUrl(cs.getPropertyValue("--note-bg-img"));

  const readBack = (): ColorField => ({
    data: fctx.getImageData(0, 0, fw, fh).data,
    fw,
    fh,
  });
  const fillSolid = (): void => {
    fctx.fillStyle = bgColor;
    fctx.fillRect(0, 0, fw, fh);
  };

  // 无背景图：纯色主题，直接填充即可
  if (!dataUrl) {
    fillSolid();
    return Promise.resolve(readBack());
  }

  return new Promise((resolve) => {
    let settled = false;
    const finishWith = (withImage: HTMLImageElement | null): void => {
      if (settled) return;
      settled = true;
      if (withImage && withImage.naturalWidth > 0) {
        // cover 适配 + 轻量底色调和：以背景图颜色为主导（粒子颜色 = 背景颜色），
        // 底色仅轻微混合防刺眼——不能用 70% 面板覆盖，否则深色主题会把背景图压没、粒子全同色。
        const iw = withImage.naturalWidth;
        const ih = withImage.naturalHeight;
        const ir = iw / ih;
        const fr = fw / fh;
        let dw: number, dh: number, dx: number, dy: number;
        if (ir > fr) {
          dh = fh; dw = fh * ir; dx = (fw - dw) / 2; dy = 0;
        } else {
          dw = fw; dh = fw / ir; dx = 0; dy = (fh - dh) / 2;
        }
        fctx.drawImage(withImage, dx, dy, dw, dh);
        fctx.save();
        fctx.globalAlpha = panelAlpha * 0.15; // 底色调和仅 ~10%（原 70% 覆盖改为轻混）
        fctx.fillStyle = bgColor;
        fctx.fillRect(0, 0, fw, fh);
        fctx.restore();
      } else {
        fillSolid();
      }
      resolve(readBack());
    };
    const img = new Image();
    const timer = window.setTimeout(() => finishWith(null), 140);
    img.onload = () => {
      window.clearTimeout(timer);
      finishWith(img);
    };
    img.onerror = () => {
      window.clearTimeout(timer);
      finishWith(null);
    };
    img.src = dataUrl;
  });
}

/** 播放一次粒子光效动画。direction: "dissolve"=关闭(自底向上) / "materialize"=呼出(自顶向下)。 */
function runGlow(
  root: HTMLElement,
  direction: "dissolve" | "materialize",
  particleDensity: number,
  onDone: () => void,
): () => void {
  const isDissolve = direction === "dissolve";
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  const density = Math.max(0, Math.min(100, particleDensity)) / 100;

  // ---- 时序参数（两方向一致，保证粒子表现完全一致）----
  const wipe = 1100; // 随机时间场 T(x,y) 主体消散/成形时长 ms（顶部+底部双起点相向推进，中央汇合）
  const endFade = 220; // 末端全局淡出带宽，避免被强制收尾硬切
  const duration = wipe + 480; // 总时长 ~1580ms（粒子收尾窗口长，细粒子持续飘散）
  const emitWindow = 560; // 每个发射点在前沿扫过后持续涌出粒子的窗口 ms（上飘拖尾，使整片消散区连贯、上下两道在中间衔接）

  // ---- 粒子覆盖层 canvas ----
  const canvas = document.createElement("canvas");
  canvas.className = "glow-particles-canvas";
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

  // ---- 动态颜色辉光精灵：按采样主题色生成并缓存（量化避免过多）----
  const SS = 24;
  const spriteList: HTMLCanvasElement[] = [];
  const spriteKeyToIdx = new Map<string, number>();
  const spriteIndexFor = (r: number, g: number, b: number): number => {
    // 量化取 8 级（>>3），保留背景不同区域的色差；16 级会把相近色合并成同一种粒子
    const key = (r >> 3) + "_" + (g >> 3) + "_" + (b >> 3);
    const hit = spriteKeyToIdx.get(key);
    if (hit !== undefined) return hit;
    const c = document.createElement("canvas");
    c.width = SS;
    c.height = SS;
    const sctx = c.getContext("2d");
    if (sctx) {
      // 亮核只轻微提亮（贴近背景本色，不漂白）；外晕用背景原色
      const cr = Math.round(r + (255 - r) * 0.15);
      const cg = Math.round(g + (255 - g) * 0.15);
      const cb = Math.round(b + (255 - b) * 0.15);
      const grad = sctx.createRadialGradient(SS / 2, SS / 2, 0, SS / 2, SS / 2, SS / 2);
      grad.addColorStop(0, `rgba(${cr},${cg},${cb},1)`);
      grad.addColorStop(0.4, `rgba(${r},${g},${b},0.9)`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      sctx.fillStyle = grad;
      sctx.fillRect(0, 0, SS, SS);
    }
    const idx = spriteList.length;
    spriteList.push(c);
    spriteKeyToIdx.set(key, idx);
    return idx;
  };

  // ---- 颜色场（异步构建；之后按生成区域采样）----
  let field: ColorField | null = null;
  const sampleThemeColor = (x: number, y: number): [number, number, number] => {
    if (!field) return [235, 240, 255]; // 兜底亮白
    let fx = Math.round((x / w) * field.fw);
    if (fx < 0) fx = 0;
    else if (fx >= field.fw) fx = field.fw - 1;
    let fy = Math.round((y / h) * field.fh);
    if (fy < 0) fy = 0;
    else if (fy >= field.fh) fy = field.fh - 1;
    const idx = (fy * field.fw + fx) * 4;
    return toGlowColor(field.data[idx], field.data[idx + 1], field.data[idx + 2]);
  };

  // ---- 消散时间场 T(x,y)：顶部+底部双起点相向推进，中央汇合 ----
  // 形态（dissolve 语义：T 小 = 先消散）：
  //  - 顶部起点：ny=0 处 T=0，顶部快速向下推进（topBand 高度内几乎清空）
  //  - 底部起点：ny=1 处 T=0，底部慢速向上推进（驼峰：中间快、两侧慢）
  //  - 顶部向两侧蔓延快（左上角/右上角先被吞没）→ 顶部带内 edge 大处 T 更小
  //  - 顶部到达侧边后沿侧边向下"流淌"（速度介于顶底之间）→ 中央带/底部带边缘走侧边流
  //  - 中央带 T 最大（最后消散，上下在中央附近汇合）
  const featherMs = 90; // 羽化软边时间带宽（越大边缘越柔）
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
  const mimg = mctx.createImageData(mw, mh);
  const mpx32 = new Uint32Array(mimg.data.buffer); // 32 位写入，仅改最高字节(alpha)

  // 噪声参数（保留随机破碎边缘，但幅度收紧——否则会抹平驼峰/双起点轮廓）
  const noiseAmp = 55; // ±55ms：边缘随机破碎（小幅度，不破坏形态）
  const jitterAmp = 18; // 细碎锯齿
  const noiseScale = 1 / 42; // 主波长 ~42px

  // 形态参数
  const topBand = 0.30;    // 顶部快速带高度比例（0~30% 高度快速清空）
  const botBand = 0.36;    // 底部慢速带高度比例（底部 36% 高度慢速推进）
  const topTime = 0.56 * wipe;   // 顶部带清空耗时（明显放缓：616ms，不再抢跑）
  const botTime = 0.32 * wipe;   // 底部带到中央耗时（明显加快：352ms，驼峰快速拱起）
  const sideTime = 0.46 * wipe;  // 侧边流淌从顶带到中央带底的耗时（介于顶底之间）

  // 返回 CSS 坐标 (nx,ny) 的消散时刻
  const dissolveTimeAt = (nx: number, ny: number): number => {
    const ny01 = ny / h; // 0=顶, 1=底
    const nx01 = nx / w;
    const edge = Math.abs(nx01 - 0.5) * 2; // 0=中, 1=边

    let T: number;
    if (ny01 <= topBand) {
      // ---- 顶部带：快速清空，两侧（左上角/右上角）更快被吞没 ----
      T = (ny01 / topBand) * topTime * (1 - 0.22 * edge * edge);
    } else if (ny01 >= 1 - botBand) {
      // ---- 底部带：驼峰（中间快、两侧慢）——峰尖陡峭：edge^2 幂次 + 大系数
      //   中间 1（飞快）、edge=0.5 处 ≈2.0、两侧 5.0（明显拖后），差异拉满
      const fromBottom = (1 - ny01) / botBand; // 0=底, 1=顶部边界
      const hump = 1 + 4.0 * edge * edge;
      const humpT = fromBottom * botTime * hump;
      // 侧边流延伸：顶部沿侧边向下流淌（介于顶底之间），接管最边缘区域——
      // 否则底部带边缘会被驼峰拖到极慢，破坏"从顶部顺流而下"的连贯感。
      const sideExt = topTime + (sideTime - topTime) * (ny01 - topBand) / (1 - topBand);
      const edgeW = Math.max(0, (edge - 0.6) / 0.4); // 0..1：edge>0.6 后逐渐由侧边流接管
      T = humpT * (1 - edgeW) + Math.min(humpT, sideExt) * edgeW;
    } else {
      // ---- 中央带：上下消散前沿在此汇合 ----
      // 关键约束：两端必须与邻带严格连续（顶=topTime 接顶部带底、底=botTime 接底部带顶），
      // 中间用正弦峰——峰值是唯一的汇合点、最后消散，绝无大片平顶/滞留带。
      // （旧公式在 midProg 0.45~0.55 是 0.90wipe 平顶且底部不衔接 → 中间留一块不消散）
      const midProg = (ny01 - topBand) / (1 - topBand - botBand); // 0..1
      const lerpBase = topTime + (botTime - topTime) * midProg; // 0.56→0.32 线性衔接
      const centerT = lerpBase + 0.30 * wipe * Math.sin(midProg * Math.PI); // 峰值 0.74wipe 在中央
      // 侧边流：顶部沿侧边向下流淌（介于顶底之间）
      const sideFlowT = topTime + (sideTime - topTime) * midProg;
      T = centerT * (1 - edge * edge) + sideFlowT * (edge * edge);
    }

    // 随机破碎边缘（fbm 噪声 + 细碎抖动）
    const n = fbm(nx * noiseScale, ny * noiseScale) * noiseAmp;
    const j = (hash2(Math.round(nx), Math.round(ny)) * 2 - 1) * jitterAmp;
    let Tf = T + n + j;
    if (Tf < 0) Tf = 0;
    else if (Tf > wipe - featherMs) Tf = wipe - featherMs;
    return Tf;
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

  // ---- 方向区域：粒子以垂直向上为中心小幅错落（同区域趋同、区域间轻微变化，
  //   保持整体向上飘散的粒子感；不再有全局风向偏角——消散形态由 T 场双起点决定）----
  const regionW = 100;
  const numRegions = Math.max(2, Math.round(w / regionW));
  const regionAngle = new Float32Array(numRegions);
  const fanMax = (8 * Math.PI) / 180; // 区域间角度差上限 ±8°
  const noiseMax = (5 * Math.PI) / 180; // 区域间噪声 ±5°
  for (let r = 0; r < numRegions; r++) {
    const fan = ((r / (numRegions - 1)) - 0.5) * 2 * fanMax;
    const noise = (valueNoise1(r * 0.9 + 13.7, 83) * 2 - 1) * noiseMax;
    regionAngle[r] = fan + noise; // 以垂直向上（0°）为中心
  }
  const angleAt = (x: number): number => {
    let r = Math.floor(x / regionW);
    if (r < 0) r = 0;
    else if (r >= numRegions) r = numRegions - 1;
    return regionAngle[r];
  };

  // ---- 粒子池（SoA + swap-remove）----
  // 采用「连续发射 + 峰值存活上限」模型：全局发射率由峰值存活数换算，池子只需容纳
  // peakAlive + 余量；不会像旧版"每格一次性爆发"那样被早发光的边缘格子趁池未满占满，
  // 导致中央（最后才扫到）格子被拒、留下一片无粒子空白。两道扫掠得以在中间用粒子衔接。
  const peakAlive = Math.round(2600 + density * 3600); // 峰值存活粒子数 2600 ~ 6200（随强度）
  const avgLife = 1150; // 粒子平均寿命 ms（把峰值存活换算成发射率）
  const maxP = peakAlive + 1500; // 余量应对节流帧瞬时多发
  const px = new Float32Array(maxP);
  const py = new Float32Array(maxP);
  const pang = new Float32Array(maxP);
  const pv0 = new Float32Array(maxP);
  const pv1 = new Float32Array(maxP);
  const plife = new Float32Array(maxP);
  const page = new Float32Array(maxP);
  const psize = new Float32Array(maxP);
  const pseed = new Float32Array(maxP);
  const psprite = new Uint16Array(maxP); // 颜色精灵索引
  let pcount = 0;

  // ---- 发射点网格：铺满整面（更密），每个点在前沿扫过后持续涌出粒子（见帧循环）----
  const emitSpacing = 9;
  const ecx = Math.max(2, Math.ceil(w / emitSpacing));
  const ecy = Math.max(2, Math.ceil(h / emitSpacing));
  const emitX = new Float32Array(ecx * ecy);
  const emitY = new Float32Array(ecx * ecy);
  const emitT = new Float32Array(ecx * ecy); // 各发射点被前沿扫到的时刻
  const emitW = new Float32Array(ecx * ecy); // 发射权重：末段前沿大幅降权，避免粒子在终点堆成“墙”
  const activeIdx = new Int32Array(ecx * ecy); // 帧内“处于激活窗口”的发射点索引（持续涌出粒子）
  let ecount = 0;
  for (let iy = 0; iy < ecy; iy++) {
    for (let ix = 0; ix < ecx; ix++) {
      const nx = (ix + 0.5) * emitSpacing;
      const ny = (iy + 0.5) * emitSpacing;
      emitX[ecount] = nx;
      emitY[ecount] = ny;
      const T = dissolveTimeAt(nx, ny);
      emitT[ecount] = isDissolve ? T : wipe - T; // materialize 反转
      // 粒子数量随时间递增：前 50% 动画时间消散的粒子少、后 50% 多
      // （粒子化速度较快 → 主体粒子集中在动画后半段涌出，避免前半段一拥而上）
      const t01 = Math.max(0, Math.min(1, emitT[ecount] / wipe));
      let ww = 0.25 + 0.75 * t01; // 线性递增：早期 0.25，末期 1.0
      ww = ww * ww; // 二次 → 前段抑制更强，后段占比更大
      emitW[ecount] = ww;
      ecount++;
    }
  }
  // 全局发射率：把峰值存活数换算成「粒子/ms」上限（peakAlive / 平均寿命）；
  // 每帧按该速率从“激活窗口内”的发射点中加权采样生成，使整段动画匀速涌出、
  // 顶/底两道前沿同时持续冒粒子并在中央汇合，绝不出现中段空白。
  const emitRate = peakAlive / avgLife; // 粒子/ms

  // ---- mask 裁切：把 T 场逐像素 alpha 渲染到蒙版 canvas，驱动便签随机破碎消散 ----
  // （替代旧版 clip-path 平滑多边形；与 erode.ts 同机制，前沿随机破碎、多起点发起）
  const setMask = (url: string): void => {
    root.style.setProperty("-webkit-mask-image", `url("${url}")`);
    root.style.setProperty("mask-image", `url("${url}")`);
    root.style.setProperty("-webkit-mask-size", "100% 100%");
    root.style.setProperty("mask-size", "100% 100%");
    root.style.setProperty("-webkit-mask-repeat", "no-repeat");
    root.style.setProperty("mask-repeat", "no-repeat");
  };
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
      mpx32[p++] = ((a * 255) & 0xff) << 24 | 0x00ffffff; // RGB 白 + alpha
    }
    mctx.putImageData(mimg, 0, 0);
  };
  // 蒙版替换：先解码（new Image onload）再 set，避免逐帧 dataURL 闪烁
  let lastMaskPush = -1;
  let maskSeq = 0; // 帧序号：仅丢弃"严格更旧"的帧，保证最新帧必然被应用
  let lastAppliedSeq = 0; // 已应用的最大帧序号
  let clipCleared = false; // materialize：等首帧 mask 解码生效后再清 clip 全裁（防闪现）
  const pushMask = (age: number, force: boolean): void => {
    if (!force && age - lastMaskPush < 30) return; // ~30Hz 更新蒙版即可（羽化边缘平滑）
    lastMaskPush = age;
    renderMask(age);
    const url = maskCanvas.toDataURL();
    const seq = ++maskSeq;
    const im = new Image();
    im.onload = () => {
      // 只丢弃"比已应用更旧"的帧（防乱序回退）；绝不能用 seq !== maskSeq 丢弃——
      // 若 Image 解码慢于推帧间隔（30ms），每一帧 onload 触发时 maskSeq 都已递增，
      // 所有帧都会因"不是最新"被丢，setMask 永不执行：
      // materialize 的 mask 永远停在初始全透明 → "只有粒子、没有便签"。
      if (endedLocal || seq < lastAppliedSeq) return;
      lastAppliedSeq = seq;
      setMask(url);
      if (!isDissolve && !clipCleared) {
        clipCleared = true;
        try {
          root.style.clipPath = ""; // mask 已接管显示，解除 materialize 起始的全裁
        } catch {
          /* ignore */
        }
      }
    };
    im.onerror = () => {
      if (endedLocal) return;
      // 解码失败兜底：materialize 解除全裁（mask 用最后成功帧 / 无 mask 则显示本体），
      // 避免"动画消失、等待看门狗后便签直接弹出"。
      if (!isDissolve && !clipCleared) {
        clipCleared = true;
        try {
          root.style.clipPath = "";
        } catch {
          /* ignore */
        }
      }
    };
    im.src = url;
  };

  // 在前沿 (x,y) 生成一粒发光微粒；颜色采样自该生成区域的主题色。age 用于把寿命夹到收尾窗口内。
  const spawn = (x: number, y: number, age: number): void => {
    if (pcount >= maxP) return;
    let life = 900 + Math.random() * 600; // 900~1500ms：细粒子飘散时间显著延长
    const fit = duration - age - 60;
    if (fit < 140) return;
    if (life > fit) life = fit;
    const i = pcount++;
    const sx = x + (Math.random() - 0.5) * (w / ecx);
    px[i] = sx;
    py[i] = y + (Math.random() - 0.5) * 4;
    pang[i] = angleAt(x) + (Math.random() - 0.5) * ((3 * Math.PI) / 180); // 逐粒抖动 ±3°，同区域趋同
    const rv = () => 0.85 + Math.random() * 0.3;
    pv0[i] = (200 + Math.random() * 130) * rv(); // 初速 200~330：被风吹起的起始速度
    pv1[i] = (520 + Math.random() * 260) * rv(); // 末速 520~780：顺风加速飘走
    plife[i] = life;
    page[i] = 0;
    psize[i] = 0.6 + Math.random() * 0.9; // 亮核 ~0.6-1.5px（鸿蒙式细微光点）
    pseed[i] = Math.random() * Math.PI * 2;
    const [r, g, b] = sampleThemeColor(sx, y); // 采样生成区域的主题色
    psprite[i] = spriteIndexFor(r, g, b);
  };

  // ---- 帧循环控制 ----
  // rafId/backupId 是本动画实例的局部句柄（不能是模块级：多个动画实例并存时
  // 共享句柄会导致 A 的 stopLoop 取消掉 B 的 rAF，帧循环互相踩踏、动画卡死）。
  let rafId = 0;
  let backupId = 0;
  let start = 0;
  let started = false;
  let prevNow = 0;
  let lastPaint = 0;
  let endedLocal = false;
  let watchdog = 0;
  let spawnAcc = 0; // 跨帧累积的“应生成粒子数”小数残量

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
    stopLoop();
    if (isDissolve) {
      blankRoot(root);
      onDone();
    } else {
      restoreRoot(root);
      glowActive = false;
      onDone();
    }
  }

  const cleanupAfterHide = () => {
    stopLoop();
    blankRoot(root); // 保持“空画面”供下次呼出
    try {
      canvas.remove();
    } catch {
      /* ignore */
    }
    glowActive = false;
  };

  const finishMaterialize = () => {
    stopLoop();
    restoreRoot(root); // 成形完成：便签完整可见
    try {
      canvas.remove();
    } catch {
      /* ignore */
    }
    glowActive = false;
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
    const age = now - start;

    // ---- 推进随机破碎前沿：渲染 mask + 发射点按各自 T 时刻持续涌出粒子 ----
    pushMask(age, false);
    // materialize：opacity 随帧淡入（0→1，主体时长内完成）——配合 mask 成形，
    // 即使 mask 解码慢/失败也不会卡在空白；dissolve 保持不透明（由 mask 控制消散）。
    if (!isDissolve) {
      let op = age / wipe;
      if (op < 0) op = 0;
      else if (op > 1) op = 1;
      root.style.opacity = op.toFixed(3);
    }
    // 连续发射：每帧从“正处于激活窗口（前沿扫过后的 emitWindow 内）”的发射点中，
    // 按 emitW 加权随机采样若干点生成粒子。这种“全局速率直接落地”的做法不受
    // “每点累积到 1 才发”的阈值限制（旧版因此阈值永远到不了 → 几乎不冒粒子）；
    // 顶/底两道前沿每帧都在冒粒子，随窗口推进连续向中央汇合，中段不会空。
    let activeCount = 0;
    let activeMaxW = 0;
    for (let i = 0; i < ecount; i++) {
      const T = emitT[i];
      if (age >= T && age <= T + emitWindow) {
        activeIdx[activeCount++] = i;
        if (emitW[i] > activeMaxW) activeMaxW = emitW[i];
      }
    }
    if (activeCount > 0) {
      spawnAcc += emitRate * dt * 1000; // 该帧应生成的粒子总数（含小数残量累积）
      let n = Math.floor(spawnAcc);
      spawnAcc -= n;
      if (n > 400) n = 400; // 兜底：节流长帧也不会一次喷爆池子
      for (let k = 0; k < n; k++) {
        // 按 emitW 拒绝采样选一个激活点（权重高的点更常被选中 → 后段/中央更多粒子）
        let idx = activeIdx[(Math.random() * activeCount) | 0];
        for (let tr = 0; tr < 5; tr++) {
          const cand = activeIdx[(Math.random() * activeCount) | 0];
          if (Math.random() * activeMaxW <= emitW[cand]) {
            idx = cand;
            break;
          }
        }
        spawn(emitX[idx], emitY[idx], age);
      }
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
        const last = --pcount;
        if (i !== last) {
          px[i] = px[last]; py[i] = py[last]; pang[i] = pang[last];
          pv0[i] = pv0[last]; pv1[i] = pv1[last]; plife[i] = plife[last];
          page[i] = page[last]; psize[i] = psize[last]; pseed[i] = pseed[last];
          psprite[i] = psprite[last];
        }
        i--;
        continue;
      }
      const speed = pv0[i] + (pv1[i] - pv0[i]) * u * u; // ease-in-quad 柔和加速
      const dx = Math.sin(pang[i]);
      const dy = -Math.cos(pang[i]); // 向上为负 y
      const sway = Math.sin(age * 0.005 + pseed[i]) * 16; // 极轻微左右呼吸摆动
      px[i] += (dx * speed + sway) * dt;
      py[i] += dy * speed * dt;
      const alpha = Math.pow(1 - u, 1.25) * globalFade; // 边升边变淡，自然消散
      if (alpha < 0.02) continue;
      const haloR = psize[i] * (1 - u * 0.25) * 1.6; // 亮核 + 外晕收紧（鸿蒙式细光点），略随生命收缩
      ctx.globalAlpha = alpha;
      ctx.drawImage(spriteList[psprite[i]], px[i] - haloR, py[i] - haloR, haloR * 2, haloR * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    if (age >= duration) {
      ctx.clearRect(0, 0, w, h);
      if (isDissolve) {
        stopLoop();
        try {
          onDone(); // 触发真正隐藏窗口
        } finally {
          window.setTimeout(cleanupAfterHide, 400);
        }
      } else {
        finishMaterialize();
        onDone();
      }
    }
  };

  const step = (now: number) => {
    lastPaint = now;
    frame(now);
    if (!endedLocal) rafId = requestAnimationFrame(step);
  };

  const beginLoop = (): void => {
    if (endedLocal) return;
    // 初始可见态：dissolve 便签本就可见（mask 全可见）；materialize 从空开始
    // （mask 全透明 + clip 全裁 + opacity=0 三重保险：即使首帧 mask 解码慢/失败，
    //  也不会闪现旧内容或卡在空白——opacity 随帧淡入，看门狗外始终有兜底画面）。
    renderMask(0);
    setMask(maskCanvas.toDataURL());
    try {
      root.style.clipPath = isDissolve ? "" : "inset(0 0 100% 0)";
      if (!isDissolve) root.style.opacity = "0"; // materialize：随帧淡入（防卡死兜底）
      root.style.boxShadow = "none";
    } catch {
      /* ignore */
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
    // 看门狗：无论循环是否推进，到时强制收尾，杜绝卡死
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
  };

  // 颜色场就绪后再启动循环（纯色主题立即；背景图 ≤140ms 上限解码），
  // 保证所有粒子都采到最终主题色。期间被取消则不再启动。
  buildColorField(root, w, h).then((f) => {
    if (endedLocal) return;
    field = f;
    beginLoop();
  });

  // 返回“立即中止”句柄（cancelGlowParticles 调用）：停帧、移除覆盖层、复原页面样式。
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
