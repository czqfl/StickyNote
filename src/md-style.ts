// Markdown 预览区样式，全部以「可注入 iframe 的纯文本 CSS」形式提供。
// 这样用户的自定义 CSS（含 body / @media / :root 等文档级选择器）能够完整、
// 隔离地作用于预览区，而绝不会污染便签窗口本身。
//
// 背景：原先自定义主题被直接注入 document.head（全局），导致 body { background }
// 覆盖整个便签窗口，在暗色模式下被染成深蓝（见 issue 反馈“便签周围一层蓝色背景”）。
// 改为独立 iframe 后，这份 CSS 只作用于 iframe 内部文档，问题根治。

/** 默认（暖色）预览排版，对应原先 styles.css 里 .md-preview 的作用域规则。 */
export const DEFAULT_MD_CSS = `
:root {
  --bg: #fffefb;
  --bg-bar: #f7f4ee;
  --border: #ebe5da;
  --text: #3a3a3a;
  --text-sub: #a39c90;
  --accent: #6b9fd9;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 16px;
  font-family: "Microsoft YaHei UI", "PingFang SC", system-ui, -apple-system, sans-serif;
  font-size: 14px;
  line-height: 1.75;
  color: var(--text);
  background: var(--bg);
  word-wrap: break-word;
  min-height: 100vh;
}
h1, h2, h3, h4, h5, h6 { margin: 12px 0 8px; line-height: 1.35; font-weight: 700; color: var(--text); }
h1 { font-size: 22px; }
h2 { font-size: 19px; }
h3 { font-size: 17px; }
h4 { font-size: 15px; }
h5, h6 { font-size: 14px; color: var(--text-sub); }
h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }
p { margin: 8px 0; }
ul, ol { margin: 8px 0; padding-left: 22px; }
li { margin: 3px 0; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 12.5px; background: var(--bg-bar); border: 1px solid var(--border); border-radius: 4px; padding: 1px 4px; color: #b5553a; }
pre { margin: 10px 0; background: var(--bg-bar); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
pre code { background: transparent; border: none; padding: 0; color: var(--text); font-size: 12.5px; line-height: 1.5; }
blockquote { margin: 10px 0; padding: 6px 12px; border-left: 3px solid var(--accent); background: var(--bg-bar); border-radius: 0 6px 6px 0; color: var(--text-sub); }
hr { border: none; border-top: 1px solid var(--border); margin: 14px 0; }
strong { font-weight: 700; }
body::-webkit-scrollbar { width: 6px; }
body::-webkit-scrollbar-track { background: transparent; }
body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
body::-webkit-scrollbar-thumb:hover { background: var(--text-sub); }
`;

/**
 * 深色版默认（暖色）预览排版：当便签整体处于深色主题、且 MD 预览选“默认”时启用，
 * 让预览区与窗口其它部分同为深色，避免出现“深色窗口 + 浅色预览”的割裂感。
 * 仅在 default 主题下随便签主题联动；用户显式选了 github/rose-pine/solarized/custom 时不受影响。
 */
export const DEFAULT_MD_CSS_DARK = `
:root {
  --bg: #23232a;
  --bg-bar: #2d2d35;
  --border: #3c3c45;
  --text: #e6e4df;
  --text-sub: #9a948b;
  --accent: #7fb0e6;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 16px;
  font-family: "Microsoft YaHei UI", "PingFang SC", system-ui, -apple-system, sans-serif;
  font-size: 14px;
  line-height: 1.75;
  color: var(--text);
  background: var(--bg);
  color-scheme: dark;
  word-wrap: break-word;
  min-height: 100vh;
}
h1, h2, h3, h4, h5, h6 { margin: 12px 0 8px; line-height: 1.35; font-weight: 700; color: var(--text); }
h1 { font-size: 22px; }
h2 { font-size: 19px; }
h3 { font-size: 17px; }
h4 { font-size: 15px; }
h5, h6 { font-size: 14px; color: var(--text-sub); }
h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }
p { margin: 8px 0; }
ul, ol { margin: 8px 0; padding-left: 22px; }
li { margin: 3px 0; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 12.5px; background: var(--bg-bar); border: 1px solid var(--border); border-radius: 4px; padding: 1px 4px; color: #e89b7d; }
pre { margin: 10px 0; background: var(--bg-bar); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
pre code { background: transparent; border: none; padding: 0; color: var(--text); font-size: 12.5px; line-height: 1.5; }
blockquote { margin: 10px 0; padding: 6px 12px; border-left: 3px solid var(--accent); background: var(--bg-bar); border-radius: 0 6px 6px 0; color: var(--text-sub); }
hr { border: none; border-top: 1px solid var(--border); margin: 14px 0; }
strong { font-weight: 700; }
body::-webkit-scrollbar { width: 6px; }
body::-webkit-scrollbar-track { background: transparent; }
body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
body::-webkit-scrollbar-thumb:hover { background: var(--text-sub); }
`;

/** 内置主题覆盖（仅变量与设计细节），注入到 iframe 的 md-theme 样式节点。 */
const THEME_CSS: Record<string, string> = {
  github: `
:root {
  --text: #1f2328;
  --bg: #ffffff;
  --bg-bar: #f6f8fa;
  --border: #d0d7de;
  --accent: #0969da;
  --text-sub: #656d76;
}
h1, h2 { border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
code { background: rgba(175, 184, 193, 0.2); }
`,
  "rose-pine": `
:root {
  --text: #e0def4;
  --bg: #191724;
  --bg-bar: #1f1d2e;
  --border: #403d52;
  --accent: #eb6f92;
  --text-sub: #908caa;
  color-scheme: dark;
}
code { background: rgba(255, 255, 255, 0.06); }
blockquote { color: var(--text-sub); }
`,
  solarized: `
:root {
  --text: #657b83;
  --bg: #fdf6e3;
  --bg-bar: #eee8d5;
  --border: #e3dcc3;
  --accent: #268bd2;
  --text-sub: #93a1a1;
}
code { background: var(--bg-bar); }
`,
  "monokai": `
:root {
  --text: #f8f8f2;
  --bg: #272822;
  --bg-bar: #1e1f1c;
  --border: #3e3d39;
  --accent: #66d9ef;
  --text-sub: #75715e;
  color-scheme: dark;
}
code { background: rgba(255, 255, 255, 0.06); }
blockquote { color: var(--text-sub); }
`,
  "ayu-dark": `
:root {
  --text: #e6e1cf;
  --bg: #0a0e14;
  --bg-bar: #0f141b;
  --border: #1c2530;
  --accent: #ffb454;
  --text-sub: #7e8a96;
  color-scheme: dark;
}
code { background: rgba(255, 255, 255, 0.05); }
blockquote { color: var(--text-sub); }
`,
  "solarized-dark": `
:root {
  --text: #93a1a1;
  --bg: #002b36;
  --bg-bar: #013640;
  --border: #0a4853;
  --accent: #2aa198;
  --text-sub: #586e75;
  color-scheme: dark;
}
code { background: rgba(255, 255, 255, 0.06); }
`,
  "github-dark": `
:root {
  --text: #e6edf3;
  --bg: #0d1117;
  --bg-bar: #161b22;
  --border: #30363d;
  --accent: #58a6ff;
  --text-sub: #8b949e;
  color-scheme: dark;
}
h1, h2 { border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
code { background: rgba(110, 118, 129, 0.4); }
`,
};

/**
 * Markdown 预览区的背景图样式（注入 iframe 内独立的 md-bg 样式节点）。
 * 与便签输入区统一的毛玻璃效果：用 ::before 承载模糊后的背景图，用 ::after 叠加一层
 * 主题色蒙版（随背景图存在与否调整）以保证文字可读。二者均用 filter/普通层实现，
 * 不依赖 backdrop-filter，兼容性更稳。
 * 仅当 body 挂上 .has-bg-img 类时生效；图片、透明度、模糊半径由 JS 以
 * --md-bg-img / --md-bg-opacity / --md-blur 注入（--md-blur 跟随毛玻璃强度设置，
 * 与便签输入区同一条映射：0% = 0px，100% = 40px）。
 * 透明主题下（body.md-transparent）：去掉主题色蒙版，呈现「透明 + 高斯模糊」，
 * 与便签输入区在透明主题下的观感一致。
 */
export const MD_BG_CSS = `
body.has-bg-img { background: transparent; }
body.has-bg-img::before {
  content: "";
  position: fixed;
  /* 向外扩展以容纳模糊半径的采样范围（最大 40px），
     否则预览区边缘的模糊会因采样落到图外而减弱 */
  inset: -48px;
  z-index: -1;
  background-image: var(--md-bg-img);
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  filter: blur(var(--md-blur, 16px));
  transform: translateZ(0);
}
body.has-bg-img::after {
  content: "";
  position: fixed;
  inset: 0;
  z-index: -1;
  background: var(--bg);
  /* 不透明度越高（更不透明），蒙版越淡、背景图越清晰；调低则蒙版更厚、便于阅读 */
  opacity: calc(0.82 - var(--md-bg-opacity, 1) * 0.42);
}
/* 透明主题：预览区与便签一致——透明 + 高斯模糊，仅保留一层极淡的蒙版保证文字可读 */
body.has-bg-img.md-transparent::after {
  opacity: 0.12;
}
`;

/**
 * 返回某主题的 CSS 文本，注入 iframe 的 md-theme 样式节点。
 * - default：空（DEFAULT_MD_CSS 已是暖色默认）
 * - github / rose-pine / solarized：内置主题覆盖
 * - custom：返回用户上传的 CSS 原文（完整作用于 iframe 文档，含 body / @media / :root）
 */
export function getThemeCss(theme: string, customCss = ""): string {
  if (theme === "custom") return customCss || "";
  if (theme === "default") return "";
  return THEME_CSS[theme] || "";
}
