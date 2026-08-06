// 便签「粒子光效」统一动画：鸿蒙通知删除同款 —— 界面碎裂成大量发光微粒，
// 区域化朝相近方向加速上升、边升边淡出，全程带光晕辉光。
// ----------------------------------------------------------------------------
// 触发：关闭窗口（dissolve）/ 呼出窗口（materialize，互为倒放）。
// 两个方向**共用同一套粒子系统** → 粒子的形态 / 大小 / 颜色表现完全一致（仅运动方向相反）。
//
// 视觉要点（三方向同时发起 · 中心归聚）：
// - 每次播放**同时**从三个方向发起消散：底部向上 + 上部向下为必选，左右随机择一侧（向对侧）；
//   三前沿各自朝画布中心推进，取「最早到达」(min) 为该点消散时刻 → 便签向中心收缩并消失（归聚于中心）。
// - 前沿形态：
//   ① 上侧 / 左右选侧：水平山脊状，带轻微起伏、远观如山峰细波（少量峰谷、连续无锯齿）；
//   ② 底部：方状尖峰——中线附近提前消解，自底部升起一座尖塔（三角硬边=方状）。
// - 粒子方向由「向上」改为「朝中心汇聚」，三向粒子流最终在中心归聚成一团淡出。
// - 粒子向中心汇聚：粒子生成后方向**锁死为朝画布中心**（带轻微角散），三向粒子流最终在中心
//   归聚成一团并淡出；叠加阵风湍流保留风吹沙感，但不再笔直上升。
// - 随机性克制：仅保留粒子大小、速度的 ±20% 微小差异 + 向上方向 ±35° 角发散，不破坏整体上升一致性。
// - 加速飘散：ease-in-quad 二次缓动，初速 ~200-330px/s → 末速 ~520-780px/s（逐粒子 ±20%），
//   附加极轻微横向摆动，柔和不"嗖"地飞走。
// - 颜色（动态主题采样）：构建便签"区域颜色场"（--bg 底色 + has-bg 背景图 cover 为主导，
//   底色仅轻量调和），按粒子**生成区域**采样对应背景颜色（背景是什么颜色粒子就是什么颜色），
//   additive 叠加出辉光，边升边变淡直至自然消散。
// - 形态/大小：不规则沙粒（非完美圆）——每粒随机自转朝向 + 各向异性被风拉长成短条 +
//   噪声扰动边缘与表面亮度，尺寸 0.8~4px 偏细小偶有粗砂；寿命 900~1500ms 飘散持久。
// - 阵风湍流：粒子上升中叠加随生命周期起伏的非周期横向/纵向扰动，模拟风把沙粒吹得忽左忽右，
//   打破"笔直平行上升"的规整感（参考网络常见风吹沙子模拟：高发射率 + 湍流扰动 + 非圆颗粒贴图）。
//
// 工程契约（与 erode.ts 一致）：canvas 覆盖层画粒子（z-index 置顶、pointer-events:none）；
// cancelGlowParticles() 立即中止（停帧+复原页面、不触发 onDone），供"呼出↔关闭"互相打断；
// 看门狗强制收尾，杜绝动画卡死导致窗口无法关闭/成形。

let glowActive = false;
/** 动画代次：每次 runGlow 启动 +1。上一轮动画遗留的延时清理（cleanupAfterHide）凭此作废，
 *  避免快速呼出时把正在播放的新动画便签裁掉/隐藏（见 cleanupAfterHide 守卫）。 */
let glowGen = 0;

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

// ---- 风吹风格：时间场 T 为纯连续函数，不做任何噪声扰动 → 边缘光滑无锯齿 ----

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
  const myGen = ++glowGen; // 本动画实例代次：作废上一轮遗留的延时清理
  const isDissolve = direction === "dissolve";
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  const density = Math.max(0, Math.min(100, particleDensity)) / 100;

  // ---- 时序参数（两方向一致，保证粒子表现完全一致）----
  const wipe = 1100; // 随机时间场 T(x,y) 主体消散/成形时长 ms（顶部+底部双起点相向推进，中央汇合）
  const endFade = 220; // 末端全局淡出带宽，避免被强制收尾硬切
  const duration = wipe + 280; // 总时长 ~1380ms（落在 1000-1400ms 区间）
  const emitWindow = 560; // 每个发射点在前沿扫过后持续涌出粒子的窗口 ms（上飘拖尾，使整片消散区连贯、上下两道在中间衔接）

  // ---- 粒子覆盖层 canvas（WebGL：GPU 单次 draw call 渲染点精灵，替代逐粒 drawImage）----
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
  const glOpts: WebGLContextAttributes = { alpha: true, premultipliedAlpha: false, antialias: false, depth: false };
  const gl = (canvas.getContext("webgl", glOpts) ||
    (canvas.getContext("experimental-webgl" as "webgl", glOpts) as unknown as WebGLRenderingContext | null)) as WebGLRenderingContext | null;
  if (!gl) {
    canvas.remove();
    finishEarly();
    return () => {};
  }
  // 顶点：设备像素坐标 → clip 空间；用 gl_PointSize 当点直径；片元用 gl_PointCoord 画
  // 不规则沙粒（随机自转 + 各向异性拉伸 + 噪声边缘/亮度），替代完美的软圆辉光。
  const VS_SRC = `
    attribute vec2 a_pos;     // 设备像素坐标
    attribute vec2 a_param;   // x=直径(设备px) y=alpha
    attribute vec3 a_color;   // rgb 0~1
    attribute vec3 a_shape;   // x=自转角 y=各向异性 z=噪声种子
    uniform vec2 u_res;       // canvas 设备尺寸
    varying float v_alpha;
    varying vec3 v_color;
    varying float v_rot;
    varying float v_aniso;
    varying float v_seed;
    void main() {
      vec2 clip = (a_pos / u_res) * 2.0 - 1.0;
      clip.y = -clip.y;       // 设备 y 向下，翻转
      gl_Position = vec4(clip, 0.0, 1.0);
      gl_PointSize = a_param.x;
      v_alpha = a_param.y;
      v_color = a_color;
      v_rot = a_shape.x;
      v_aniso = a_shape.y;
      v_seed = a_shape.z;
    }`;
  const FS_SRC = `
    precision mediump float;
    varying float v_alpha;
    varying vec3 v_color;
    varying float v_rot;
    varying float v_aniso;
    varying float v_seed;
    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    void main() {
      vec2 q = gl_PointCoord - vec2(0.5);
      q *= 2.0;                                  // [-1,1]
      float s = sin(v_rot), c = cos(v_rot);
      vec2 r = vec2(q.x * c - q.y * s, q.x * s + q.y * c); // 旋转到颗粒自身朝向
      float stretch = mix(1.0, 2.1, v_aniso);    // 沿长轴(x)拉伸
      float squash  = mix(1.0, 0.5, v_aniso);    // 短轴(y)收窄 → 被风拉成短条
      r.x /= stretch;
      r.y /= squash;
      float rr = length(r);
      float ang = atan(r.y, r.x);
      float wob = 0.10 * sin(ang * 3.0 + v_seed) + 0.06 * sin(ang * 7.0 - v_seed * 1.7); // 不规则轮廓
      float edge = 1.0 + wob;
      float a0 = 1.0 - smoothstep(edge - 0.5, edge, rr); // 柔和但非圆的边缘
      if (a0 <= 0.0) discard;
      float grain = 0.70 + 0.30 * hash(floor(q * 5.0) + v_seed); // 表面颗粒感（粗噪）
      float core  = 1.0 - smoothstep(0.0, 0.6, rr);              // 中心略亮
      float bright = grain * (0.82 + 0.18 * core);
      gl_FragColor = vec4(v_color, v_alpha * a0 * bright);
    }`;
  const compileGL = (type: number, src: string): WebGLShader | null => {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn("[glow] shader compile failed:", gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  };
  const glVS = compileGL(gl.VERTEX_SHADER, VS_SRC);
  const glFS = compileGL(gl.FRAGMENT_SHADER, FS_SRC);
  if (!glVS || !glFS) {
    canvas.remove();
    finishEarly();
    return () => {};
  }
  const glProg = gl.createProgram();
  if (!glProg) {
    canvas.remove();
    finishEarly();
    return () => {};
  }
  gl.attachShader(glProg, glVS);
  gl.attachShader(glProg, glFS);
  gl.linkProgram(glProg);
  if (!gl.getProgramParameter(glProg, gl.LINK_STATUS)) {
    console.warn("[glow] program link failed:", gl.getProgramInfoLog(glProg));
    canvas.remove();
    finishEarly();
    return () => {};
  }
  gl.useProgram(glProg);
  const aPosLoc = gl.getAttribLocation(glProg, "a_pos");
  const aParamLoc = gl.getAttribLocation(glProg, "a_param");
  const aColorLoc = gl.getAttribLocation(glProg, "a_color");
  const aShapeLoc = gl.getAttribLocation(glProg, "a_shape");
  gl.uniform2f(gl.getUniformLocation(glProg, "u_res"), canvas.width, canvas.height);
  const glBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, glBuf);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive 辉光（非预乘）
  let glLost = false;
  const loseGL = () => {
    if (glLost) return;
    glLost = true;
    const ext = gl.getExtension("WEBGL_lose_context");
    if (ext) ext.loseContext();
  };

  // ---- 颜色直接存于粒子（pr/pg/pb，0~1）；WebGL 用程序化点精灵绘制，无需预渲染精灵图 ----

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

  // ---- 消散时间场 T(x,y)：每帧播放随机选取「一个」主方向，前沿为该方向直线推进 +
  //   垂直向地形起伏，告别四边涟漪/完美圆形；三种方向（见文件头说明）。
  // dissolve 语义：T 小=先消散；materialize 用 Tm=wipe-T 反向 → 该侧最后成形。
  const featherMs = 90; // 羽化软边时间带宽
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

  // ---- 三方向同时发起，最终于中心归聚 ----
  // 必选：底部向上 + 上部向下；左右随机择一侧（向对侧）。三前沿各自朝中心推进，
  // 取三者「最早到达」(min) 作为该点消散时刻 → 便签向中心收缩并消失（归聚于中心）。
  // 形态：
  //  · 上侧 / 左右选侧：水平山脊状前沿，横向(或纵向)带轻微起伏、远观如山峰细波；
  //  · 底部：方状尖峰——中线附近提前消解，自底部升起一座尖塔(三角硬边=方状)。
  const cx = w * 0.5;
  const cy = h * 0.5;
  const leftSide = Math.random() < 0.5; // 左右择一侧：true=左→右，false=右→左

  // 山峰起伏参数（每次播放随机，峰谷少、平缓、连续无锯齿、不规则）
  interface CtrlPt { p: number; h: number } // p∈[0,1], h∈[-1,1]
  const K = 3 + (Math.random() < 0.5 ? 0 : 1);
  const mtnPts: CtrlPt[] = [];
  for (let i = 0; i < K; i++) {
    const p = Math.max(0, Math.min(1, ((i + 0.5) + (Math.random() - 0.5) * 0.6) / K));
    mtnPts.push({ p, h: Math.random() * 2 - 1 });
  }
  mtnPts.sort((a, b) => a.p - b.p);
  const mtnAmp = (0.04 + Math.random() * 0.04) * wipe; // 山峰起伏幅度（轻微）
  // 底部尖峰：三角(硬边=方状)缺口，中线附近提前消解 → 自底升起的尖塔
  const spikeAmp = (0.16 + Math.random() * 0.06) * wipe;
  const spikeHalf = (0.10 + Math.random() * 0.05) * w; // 尖峰半宽
  const spikeMod = (x: number): number => {
    const d = Math.abs(x - cx);
    if (d >= spikeHalf) return 0;
    return -spikeAmp * (1 - d / spikeHalf); // 三角：中线最深(最负)，边缘为 0
  };

  // 山峰采样：u∈[0,1] → [-1,1]，段内余弦平滑（C1 连续、无锯齿）
  const mtnSample = (u: number): number => {
    if (u <= mtnPts[0].p) return mtnPts[0].h;
    const last = mtnPts[mtnPts.length - 1];
    if (u >= last.p) return last.h;
    for (let i = 0; i < mtnPts.length - 1; i++) {
      const a = mtnPts[i], b = mtnPts[i + 1];
      if (u >= a.p && u <= b.p) {
        const t = (u - a.p) / (b.p - a.p);
        const s = 0.5 - 0.5 * Math.cos(Math.PI * t); // 余弦平滑，避免锯齿尖角
        return a.h + (b.h - a.h) * s;
      }
    }
    return last.h;
  };

  // 各前沿「到达 (nx,ny) 的时刻」（各自朝中心推进，到中心≈wipe）
  const tTop = (nx: number, ny: number): number => {
    const base = (ny / (h * 0.5)) * wipe;       // 顶部(y=0)先消，到中心(y=h/2)=wipe
    const m = mtnAmp * mtnSample(nx / w);        // 横向山脊起伏
    return base + m;
  };
  const tBottom = (nx: number, ny: number): number => {
    const base = ((h - ny) / (h * 0.5)) * wipe;  // 底部(y=h)先消，到中心=wipe
    const m = spikeMod(nx);                       // 中线尖峰(负)→提前消解
    return base + m;
  };
  const tSide = (nx: number, ny: number): number => {
    const base = (leftSide ? nx / (w * 0.5) : (w - nx) / (w * 0.5)) * wipe; // 该侧先消，到中心=wipe
    const m = mtnAmp * mtnSample(ny / h);         // 纵向山脊起伏（侧边天空线）
    return base + m;
  };

  // 取三前沿最早到达 → 便签向中心收缩（三者于中心归聚）
  const dissolveTimeAt = (nx: number, ny: number): number => {
    let Tf = Math.min(tTop(nx, ny), tBottom(nx, ny), tSide(nx, ny));
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

  // ---- 粒子漂移方向：一律「向上」飘散 ----
  // 不再沿边缘法线四散：粒子生成后方向锁死为竖直向上（pang=0），仅保留 ±35° 发散角
  // 与轻微恒定向漂移（psway），使所有微粒都朝上方升起、边升边淡出——“被托起升空”的消散感。
  // pang 为「与垂直向上夹角」：0=向上，正值向右；与粒子更新公式 dx=sin(pang)/dy=-cos(pang) 一致。

  // ---- 粒子池（SoA + swap-remove）----
  // 采用「连续发射 + 峰值存活上限」模型：全局发射率由峰值存活数换算，池子只需容纳
  // peakAlive + 余量；不会像旧版"每格一次性爆发"那样被早发光的边缘格子趁池未满占满，
  // 导致中央（最后才扫到）格子被拒、留下一片无粒子空白。两道扫掠得以在中间用粒子衔接。
  const peakAlive = Math.round(2600 + density * 16000); // 峰值存活粒子数 2600 ~ 18600（随强度；最大配置较旧版提升 3 倍）
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
  const pseed = new Float32Array(maxP); // 噪声种子（错相，避免整片颗粒同形）
  const prot = new Float32Array(maxP);  // 颗粒自转朝向
  const paniso = new Float32Array(maxP); // 各向异性（越高越被风拉长）
  const pr = new Float32Array(maxP); // 粒子颜色 0~1（替代精灵索引，交给 GPU 着色器）
  const pg = new Float32Array(maxP);
  const pb = new Float32Array(maxP);
  const glData = new Float32Array(maxP * 10); // 上传缓冲：x,y,size,alpha,r,g,b,rot,aniso,seed（设备像素坐标）
  const psway = new Float32Array(maxP); // 每粒恒定横向漂移速度 px/s（替代逐帧 Math.sin 摆动，省 CPU）
  let pcount = 0;

  // ---- 发射点网格：铺满整面（更密），每个点在前沿扫过后持续涌出粒子（见帧循环）----
  const emitSpacing = 9;
  const ecx = Math.max(2, Math.ceil(w / emitSpacing));
  const ecy = Math.max(2, Math.ceil(h / emitSpacing));
  const emitX = new Float32Array(ecx * ecy);
  const emitY = new Float32Array(ecx * ecy);
  const emitT = new Float32Array(ecx * ecy); // 各发射点被前沿扫到的时刻
  const emitW = new Float32Array(ecx * ecy); // 发射权重：末段前沿大幅降权，避免粒子在终点堆成“墙”
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
      let ww = 1.0 - 0.45 * t01; // 起侧(早消)权重高 → 三向粒子流明显朝中心汇聚
      emitW[ecount] = ww;
      ecount++;
    }
  }
  // 发射点按“被前沿扫到的时刻 T”分桶（binSize ms），避免每帧扫描全部 ~1.2 万点找激活点：
  // 每帧只需遍历落在 [age-emitWindow, age] 区间内的少数桶（~28 个）。
  const binSize = 20;
  const binCount = Math.ceil((wipe + emitWindow) / binSize) + 1;
  const binPts: number[][] = [];
  const binW = new Float32Array(binCount);
  const binMaxW = new Float32Array(binCount);
  for (let b = 0; b < binCount; b++) binPts.push([]);
  for (let i = 0; i < ecount; i++) {
    let b = Math.floor(emitT[i] / binSize);
    if (b < 0) b = 0;
    else if (b >= binCount) b = binCount - 1;
    binPts[b].push(i);
    binW[b] += emitW[i];
    if (emitW[i] > binMaxW[b]) binMaxW[b] = emitW[i];
  }
  const abBins = new Int32Array(binCount); // 帧内激活桶集合（预分配，避免每帧 new）
  const abW = new Float32Array(binCount);
  // 全局发射率：把峰值存活数换算成「粒子/ms」上限（peakAlive / 平均寿命）；
  // 每帧按该速率从“激活窗口内”的发射点中加权采样生成，使整段动画匀速涌出、
  // 顶/底两道前沿同时持续冒粒子并在中央汇合，绝不出现中段空白。
  const emitRate = peakAlive / avgLife; // 粒子/ms

  // ---- mask 裁切：把 T 场逐像素 alpha 渲染到蒙版 canvas，驱动便签平滑消散 ----
  // （前沿为光滑连续曲线、多起点发起；与 erode.ts 同机制，但无随机破碎）
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
    const dxT = cx - sx;            // 朝画布中心汇聚
    const dyT = cy - py[i];
    pang[i] = Math.atan2(dxT, -dyT) + (Math.random() - 0.5) * 0.35; // 朝中心 + 轻微角散
    const rv = () => 0.8 + Math.random() * 0.4; // 速度 ±20% 随机差异
    pv0[i] = (200 + Math.random() * 130) * rv(); // 初速 ~200-330：被风吹起的起始速度
    pv1[i] = (520 + Math.random() * 260) * rv(); // 末速 ~520-780：顺风加速飘走
    plife[i] = life;
    page[i] = 0;
    const r1 = Math.random(), r2 = Math.random();
    psize[i] = 0.8 + r1 * r2 * 3.2; // 沙粒尺寸 0.8~4.0px，偏细小、偶有粗砂（r1*r2 偏置小值）
    pseed[i] = Math.random() * 100.0;  // 形状/噪声种子（错相）
    prot[i] = Math.random() * Math.PI * 2; // 颗粒随机自转朝向
    paniso[i] = Math.random();         // 各向异性：越高被风拉得越长（沙粒条状）
    psway[i] = (Math.random() - 0.5) * 28; // ±14 px/s 恒定向漂移
    const [r, g, b] = sampleThemeColor(sx, y); // 采样生成区域的主题色
    pr[i] = r / 255; pg[i] = g / 255; pb[i] = b / 255; // 主题色直接入粒子，GPU 程序化绘制
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
    loseGL();
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
    // 代次守卫：若已启动新动画（glowGen 改变），本实例的延时清理作废，
    // 否则会把正在播放的新动画便签裁掉/隐藏（快速关闭后立刻呼出时会触发）。
    if (myGen !== glowGen) return;
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
    if (myGen !== glowGen) return; // 已被新动画接管：勿复位其样式
    glowActive = false;
    // 让“便签已完整显现”的最后一帧先提交，再移除覆盖层与复位样式，避免收尾闪一下。
    requestAnimationFrame(() => {
      if (myGen !== glowGen) return; // 期间已启动新动画：勿复位其样式
      try {
        canvas.remove();
      } catch {
        /* ignore */
      }
      restoreRoot(root); // 成形完成：便签完整可见
    });
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

    // ---- 推进平滑消散前沿：渲染 mask + 发射点按各自 T 时刻持续涌出粒子 ----
    pushMask(age, false);
    // materialize：opacity 随帧淡入（0→1，主体时长内完成）——配合 mask 成形，
    // 即使 mask 解码慢/失败也不会卡在空白；dissolve 保持不透明（由 mask 控制消散）。
    if (!isDissolve) {
      let op = age / wipe;
      if (op < 0) op = 0;
      else if (op > 1) op = 1;
      root.style.opacity = op.toFixed(3);
    }
    // 连续发射：从“激活窗口内的发射点”按 emitW 加权采样生成（全局速率直接落地）。
    // 先收集落在 [age-emitWindow, age] 的激活桶（~28 个，远少于全部发射点），再从中选点，
    // 避免每帧扫描 ~1.2 万点；顶/底两道前沿每帧持续冒粒子、向中央连续汇合。
    let abCount = 0;
    let abTotalW = 0;
    const b0 = Math.max(0, Math.floor((age - emitWindow) / binSize));
    const b1 = Math.min(binCount - 1, Math.floor(age / binSize));
    for (let b = b0; b <= b1; b++) {
      if (binW[b] > 0) {
        abBins[abCount] = b;
        abW[abCount] = binW[b];
        abTotalW += binW[b];
        abCount++;
      }
    }
    if (abCount > 0) {
      spawnAcc += emitRate * dt * 1000; // 该帧应生成的粒子总数（含小数残量累积）
      let n = Math.floor(spawnAcc);
      spawnAcc -= n;
      if (n > 600) n = 600; // 兜底：节流长帧也不会一次喷爆池子（密度提升 3 倍后放宽上限）
      for (let k = 0; k < n; k++) {
        // 按桶权重选一个激活桶
        let r = Math.random() * abTotalW;
        let bb = abBins[abCount - 1];
        for (let z = 0; z < abCount; z++) {
          r -= abW[z];
          if (r <= 0) { bb = abBins[z]; break; }
        }
        const pts = binPts[bb];
        // 桶内按 emitW 拒绝采样选一个发射点（权重高的更常被选中 → 后段/中央更多粒子）
        let idx = pts[(Math.random() * pts.length) | 0];
        const mw = binMaxW[bb];
        for (let tr = 0; tr < 4; tr++) {
          const cand = pts[(Math.random() * pts.length) | 0];
          if (Math.random() * mw <= emitW[cand]) { idx = cand; break; }
        }
        spawn(emitX[idx], emitY[idx], age);
      }
    }

    // ---- 粒子：物理更新（CPU，与之前一致）+ GPU 单次 draw call 绘制（additive 辉光）----
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const globalFade = age > duration - endFade ? Math.max(0, (duration - age) / endFade) : 1;
    let drawCount = 0;
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
          prot[i] = prot[last]; paniso[i] = paniso[last];
          pr[i] = pr[last]; pg[i] = pg[last]; pb[i] = pb[last]; psway[i] = psway[last];
        }
        i--;
        continue;
      }
      const speed = pv0[i] + (pv1[i] - pv0[i]) * u * u; // ease-in-quad 柔和加速
      const dx = Math.sin(pang[i]);
      const dy = -Math.cos(pang[i]); // 向上为负 y
      // 阵风湍流：随生命周期与种子起伏的非周期扰动，模拟风把沙粒吹得忽左忽右（不再笔直平行上升）
      const ageSec = a * 0.001;
      const turbX = Math.sin(ageSec * 6.0 + pseed[i]) * 26.0 + Math.sin(ageSec * 2.3 + pseed[i] * 1.9) * 18.0;
      const turbY = Math.sin(ageSec * 5.1 + pseed[i] * 1.3) * 12.0;
      px[i] += (dx * speed + psway[i] + turbX) * dt; // 定向漂移 + 阵风横向扰动
      py[i] += (dy * speed + turbY) * dt;
      const t = 1 - u;
      const alpha = t * t * globalFade; // 边升边变淡（平方衰减）
      if (alpha < 0.02) continue;
      const sz = psize[i] * (1 - u * 0.2) * dpr; // 颗粒直径（设备像素），略随生命收缩
      const o = drawCount * 10;
      glData[o] = px[i] * dpr;          // 设备像素 x
      glData[o + 1] = py[i] * dpr;      // 设备像素 y
      glData[o + 2] = sz;               // 直径（设备像素）作为点大小
      glData[o + 3] = alpha;
      glData[o + 4] = pr[i];
      glData[o + 5] = pg[i];
      glData[o + 6] = pb[i];
      glData[o + 7] = prot[i];          // 自转朝向
      glData[o + 8] = paniso[i];        // 各向异性
      glData[o + 9] = pseed[i];         // 噪声种子
      drawCount++;
    }
    if (drawCount > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, glBuf);
      gl.bufferData(gl.ARRAY_BUFFER, glData.subarray(0, drawCount * 10), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(aPosLoc);
      gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 40, 0);
      gl.enableVertexAttribArray(aParamLoc);
      gl.vertexAttribPointer(aParamLoc, 2, gl.FLOAT, false, 40, 8);
      gl.enableVertexAttribArray(aColorLoc);
      gl.vertexAttribPointer(aColorLoc, 3, gl.FLOAT, false, 40, 16);
      gl.enableVertexAttribArray(aShapeLoc);
      gl.vertexAttribPointer(aShapeLoc, 3, gl.FLOAT, false, 40, 28);
      gl.drawArrays(gl.POINTS, 0, drawCount);
    }

    if (age >= duration) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
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
