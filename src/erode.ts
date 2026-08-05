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

let rafId = 0;
let backupId = 0;

/** 立即结束侵蚀动画并复原页面（关闭动画开始前调用，避免与呼出动画同时改 mask/透明度）。 */
export function cancelErode(): void {
  if (!eroding && !materializing) return;
  eroding = false;
  materializing = false;
  cancelAnimationFrame(rafId);
  if (backupId) {
    window.clearInterval(backupId);
    backupId = 0;
  }
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
  const safeDone = () => {
    if (done) return;
    done = true;
    eroding = false;
    onDone();
  };
  const watchdog = window.setTimeout(safeDone, 4000);
  try {
    runErode(root, "dissolve", particleDensity, () => {
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
  if (materializing) return;
  materializing = true;
  try {
    runErode(root, "materialize", particleDensity, () => {
      /* materialize 收尾在 runErode 内自行复原，无需额外 onDone */
    });
  } catch (e) {
    console.error("侵蚀成形动画异常:", e);
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
): void {
  const isDissolve = direction === "dissolve";
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;

  // ---- 时序参数 ----
  const wipe = 1000; // 消散 / 成形主体时长 ms（用户要求约 1 秒）
  const featherMs = 90; // 羽化软边时间带宽（越大边缘越柔）
  const tailMs = isDissolve ? 380 : 120; // 余烬飘散收尾（成形更短）
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
    return;
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
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    finishEarly();
    return;
  }
  ctx.scale(dpr, dpr);

  // 暖色余烬精灵（中心白热点 → 橙 → 透明）
  const SS = 10;
  const sprite = document.createElement("canvas");
  sprite.width = SS;
  sprite.height = SS;
  {
    const sctx = sprite.getContext("2d");
    if (sctx) {
      const g = sctx.createRadialGradient(SS / 2, SS / 2, 0, SS / 2, SS / 2, SS / 2);
      g.addColorStop(0, "rgba(255,240,210,1)");
      g.addColorStop(0.35, "rgba(255,170,80,0.8)");
      g.addColorStop(1, "rgba(255,120,40,0)");
      sctx.fillStyle = g;
      sctx.fillRect(0, 0, SS, SS);
    }
  }

  // 发射点网格：位于侵蚀前沿处，向上升腾火星
  const density = Math.max(0, Math.min(100, particleDensity)) / 100;
  const emitSpacing = 16;
  const ecx = Math.ceil(w / emitSpacing);
  const ecy = Math.ceil(h / emitSpacing);
  const emitX = new Float32Array(ecx * ecy);
  const emitY = new Float32Array(ecx * ecy);
  const emitT = new Float32Array(ecx * ecy); // 各发射点被前沿扫到的时刻
  let ecount = 0;
  for (let iy = 0; iy < ecy; iy++) {
    for (let ix = 0; ix < ecx; ix++) {
      const nx = (ix + 0.5) * emitSpacing;
      const ny = (iy + 0.5) * emitSpacing;
      emitX[ecount] = nx;
      emitY[ecount] = ny;
      let T = dissolveTimeAt(nx, ny);
      if (!isDissolve) T = wipe - T; // materialize 反转
      emitT[ecount] = T;
      ecount++;
    }
  }

  // 余烬粒子池（SoA + swap-remove）
  const maxEmbers = Math.round(120 + density * 480);
  const ex = new Float32Array(maxEmbers);
  const ey = new Float32Array(maxEmbers);
  const evx = new Float32Array(maxEmbers);
  const evy = new Float32Array(maxEmbers);
  const elife = new Float32Array(maxEmbers);
  const eage = new Float32Array(maxEmbers);
  const esize = new Float32Array(maxEmbers);
  const eseed = new Float32Array(maxEmbers);
  let emberCount = 0;

  const spawnEmber = (x: number, y: number) => {
    if (emberCount >= maxEmbers) return;
    const i = emberCount++;
    ex[i] = x + (Math.random() - 0.5) * 8;
    ey[i] = y + (Math.random() - 0.5) * 6;
    evx[i] = (Math.random() - 0.5) * 26;
    evy[i] = -(50 + Math.random() * 90); // 向上升腾
    elife[i] = 380 + Math.random() * 480;
    eage[i] = 0;
    esize[i] = 1.2 + Math.random() * 2.4;
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

  // 蒙版替换：先解码（new Image onload）再 set，避免逐帧 dataURL 闪烁
  let lastMaskPush = -1;
  const pushMask = (age: number, force: boolean): void => {
    if (!force && age - lastMaskPush < 30) return; // ~30Hz 更新蒙版即可（羽化边缘平滑）
    lastMaskPush = age;
    renderMask(age);
    const url = maskCanvas.toDataURL();
    const im = new Image();
    im.onload = () => {
      if (!endedLocal) setMask(url);
    };
    im.src = url;
  };

  // 全局透明度淡出：dissolve 1→0；materialize 0→1
  const applyOpacity = (age: number): void => {
    let p = age / wipe;
    if (p < 0) p = 0;
    else if (p > 1) p = 1;
    const o = isDissolve ? 1 - p : p;
    root.style.opacity = o.toFixed(3);
  };

  // ---- 帧循环 ----
  let start = 0;
  let started = false;
  let prevNow = 0;
  let lastPaint = 0;
  let endedLocal = false;

  const stopLoop = () => {
    endedLocal = true;
    cancelAnimationFrame(rafId);
    if (backupId) {
      window.clearInterval(backupId);
      backupId = 0;
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
    materializing = false;
  };

  const frame = (now: number) => {
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

    // ---- 余烬：发射 + 更新 + 绘制 ----
    ctx.clearRect(0, 0, w, h);
    if (age < wipe + 60) {
      for (let i = 0; i < ecount; i++) {
        const T = emitT[i];
        // 前沿正扫到该发射点（T 刚过 age 一小段窗口）时持续喷火星
        if (T <= age && T + 130 > age && Math.random() < 0.5) {
          spawnEmber(emitX[i], emitY[i]);
        }
      }
    }
    ctx.globalCompositeOperation = "lighter";
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
      const sway = Math.sin(a * 0.006 + eseed[i]) * 22;
      ex[i] += (evx[i] + sway) * dt;
      ey[i] += evy[i] * dt;
      const life01 = a / life;
      const alpha = (1 - life01) * 0.9;
      if (alpha < 0.02) continue;
      ctx.globalAlpha = alpha;
      const r = esize[i];
      ctx.drawImage(sprite, ex[i] - r, ey[i] - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    if (age >= duration) {
      if (isDissolve) {
        ctx.clearRect(0, 0, w, h);
        stopLoop();
        try {
          onDone(); // 触发真正隐藏窗口
        } finally {
          window.setTimeout(cleanupAfterHide, 400);
        }
      } else {
        window.clearInterval(backupId);
        ctx.clearRect(0, 0, w, h);
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

  // materialize：先备好首帧蒙版（全透明）再开启动画，避免露出便签旧内容造成闪现。
  // dissolve：首帧蒙版本就接近全可见，直接开始即可。
  if (isDissolve) {
    renderMask(0);
    setMask(maskCanvas.toDataURL());
    rafId = requestAnimationFrame(step);
    backupId = window.setInterval(() => {
      if (endedLocal) return;
      const now = performance.now();
      if (now - lastPaint > 60) {
        lastPaint = now;
        frame(now);
      }
    }, 40);
  } else {
    renderMask(0); // age=0：materialize 全透明（空画面）
    const url = maskCanvas.toDataURL();
    const im = new Image();
    im.onload = () => {
      if (endedLocal) return;
      setMask(url); // 空蒙版就位后再清掉 flame 残留的 clip-path，从空开始成形
      try {
        root.style.clipPath = "";
      } catch {
        /* ignore */
      }
      lastMaskPush = 0;
      rafId = requestAnimationFrame(step);
      backupId = window.setInterval(() => {
        if (endedLocal) return;
        const now = performance.now();
        if (now - lastPaint > 60) {
          lastPaint = now;
          frame(now);
        }
      }, 40);
    };
    im.src = url;
  }
}
