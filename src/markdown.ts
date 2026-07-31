// 轻量、零依赖的 Markdown 渲染器。
// 设计原则：安全优先——所有原始文本先转义，仅渲染白名单内语法；链接仅允许
// http/https/mailto/相对/锚点，其余一律降级为 "#"，避免注入。
// 语法覆盖：标题、粗体、斜体、行内代码、代码块、引用、有序/无序列表、分割线、链接、段落。

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 对单段已转义文本做行内格式化（粗体/斜体/代码/链接）。输入应已是“纯文本（已转义）”。 */
function formatInline(escaped: string): string {
  let out = escaped.replace(/\n/g, "<br/>");
  // 行内代码（优先于其它规则，避免内部字符被二次解析）
  out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  // 粗体
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  // 斜体
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  out = out.replace(/(^|[^_])_([^_]+)_(?!_)/g, "$1<em>$2</em>");
  // 链接 [文本](地址)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
    const safe = /^(https?:|mailto:|\/|#)/i.test(u) ? u : "#";
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${t}</a>`;
  });
  return out;
}

export function renderMarkdown(src: string): string {
  const text = (src || "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  let html = "";
  let i = 0;
  let listType: "" | "ul" | "ol" = "";

  const closeList = () => {
    if (listType) {
      html += `</${listType}>`;
      listType = "";
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // 代码块 ```
    if (trimmed.startsWith("```")) {
      closeList();
      i++;
      const buf: string[] = [];
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过结束的 ```
      html += `<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`;
      continue;
    }

    // 标题 #..######
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      html += `<h${level}>${formatInline(escapeHtml(h[2]))}</h${level}>`;
      i++;
      continue;
    }

    // 分割线
    if (/^\s*([-*_])\1{2,}\s*$/.test(trimmed)) {
      closeList();
      html += "<hr/>";
      i++;
      continue;
    }

    // 引用（可多行）
    if (/^>\s?/.test(line)) {
      closeList();
      const bq: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        bq.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      html += `<blockquote>${renderMarkdown(bq.join("\n"))}</blockquote>`;
      continue;
    }

    // 无序列表
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (listType !== "ul") {
        closeList();
        html += "<ul>";
        listType = "ul";
      }
      html += `<li>${formatInline(escapeHtml(ul[1]))}</li>`;
      i++;
      continue;
    }

    // 有序列表
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (listType !== "ol") {
        closeList();
        html += "<ol>";
        listType = "ol";
      }
      html += `<li>${formatInline(escapeHtml(ol[1]))}</li>`;
      i++;
      continue;
    }

    // 空行
    if (trimmed === "") {
      closeList();
      i++;
      continue;
    }

    // 段落：汇聚连续的普通行
    closeList();
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].trim().startsWith("```") &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*([-*_])\1{2,}\s*$/.test(lines[i].trim())
    ) {
      para.push(lines[i]);
      i++;
    }
    html += `<p>${formatInline(escapeHtml(para.join("\n")))}</p>`;
  }

  closeList();
  return html;
}
