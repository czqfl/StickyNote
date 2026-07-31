import { listNotes, deleteNote, openNoteWindow, closeWindow, startDragging, getOpenNotes } from "./api";
import { getSettings } from "./settings";

export function mountHistoryApp() {
  const app = document.getElementById("app")!;
  app.innerHTML = `
    <div class="history-window">
      <div class="titlebar">
        <div class="titlebar-left">
          <span class="dot">\u25cf</span>
          <span class="title-text">历史便签</span>
        </div>
        <div class="titlebar-right">
          <button class="icon-btn close" id="btn-close" title="关闭">\u2715</button>
        </div>
      </div>
      <div class="history-list" id="history-list"></div>
    </div>
  `;

  const listEl = document.getElementById("history-list")!;
  const titlebar = document.querySelector(".titlebar")!;
  const btnClose = document.getElementById("btn-close")!;

  // 套用全局外观主题（浅色 / 透明 / 深色），使历史窗口与便签保持一致
  getSettings()
    .then((s) => {
      const themeRoot = document.documentElement;
      // 仅 dark 挂主题类；transparent 由下方半透明底色处理
      themeRoot.classList.remove("theme-dark");
      const theme = s.theme || "light";
      if (theme === "dark") {
        themeRoot.classList.add("theme-dark");
      }
      const hw = document.querySelector(".history-window") as HTMLElement | null;
      if (!hw) return;

      // 透明主题：历史窗口不做实时截屏模糊（它非截屏目标），仅用一层很淡的半透明实底色，
      // 配合窗口透明（若开启）呈现轻盈的悬浮卡片感。
      if (s.theme === "transparent") {
        hw.classList.remove("has-bg");
        hw.style.background = "color-mix(in srgb, var(--bg) 90%, transparent)";
        return;
      }

      // 套用全局默认背景图（与便签窗口一致）
      const rawBg = s.bg_image || "";
      if (rawBg) {
        const apply = async (bg: string) => {
          let url = bg;
          if (!bg.startsWith("data:")) {
            try {
              const { readBgImage } = await import("./api");
              url = await readBgImage(bg);
            } catch (e) {
              return;
            }
          }
          hw.style.setProperty("--note-bg-img", `url("${url}")`);
          hw.classList.add("has-bg");
        };
        apply(rawBg);
      } else {
        hw.classList.remove("has-bg");
        hw.style.removeProperty("--note-bg-img");
      }
    })
    .catch((e) => console.error("读取主题失败:", e));

  // 拖拽
  titlebar.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest(".icon-btn")) return;
    startDragging();
  });

  btnClose.addEventListener("click", () => {
    closeWindow().catch((e) => console.error("关闭失败:", e));
  });

  async function render() {
    let items;
    try {
      items = await listNotes();
    } catch (err) {
      console.error("加载列表失败:", err);
      listEl.innerHTML = `<div class="empty-state"><div class="empty-text">加载失败，请重试</div></div>`;
      return;
    }

    // 读取“打开中”的便签集合：只有已关闭的便签才允许删除，
    // 打开中的便签删除会导致窗口把内容写回而“复活”，故禁用其删除按钮。
    let openSet = new Set<string>();
    try {
      const open = await getOpenNotes();
      openSet = new Set(open);
    } catch (err) {
      console.error("读取打开状态失败:", err);
    }

    listEl.innerHTML = "";

    if (items.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">\u270e</div>
          <div class="empty-text">还没有历史便签</div>
        </div>
      `;
      return;
    }

    items.forEach((item) => {
      const isOpen = openSet.has(item.id);
      const card = document.createElement("div");
      card.className = "history-card" + (isOpen ? " open-note" : "");
      const title = (item.title || "").trim();
      // 有标题：标题为主行、内容摘要为副行；无标题：直接以内容摘要为主行
      const primary = title || item.snippet;
      const secondary = title ? `<div class="card-snippet">${escapeHtml(item.snippet)}</div>` : "";
      const statusTag = isOpen ? `<div class="card-status">打开中</div>` : "";
      // 所有便签都显示删除按钮：后端 delete_note 会先向窗口发 note-deleted
      // （前端停止保存并关闭窗口），再删文件，故即使便签还开着也能安全删除、不会复活。
      const delBtnHtml = `<button class="card-delete" title="删除">\u2715</button>`;
      card.innerHTML = `
        <div class="card-info">
          <div class="card-title">${escapeHtml(primary)}</div>
          ${secondary}
          <div class="card-time">${escapeHtml(item.updatedStr)}</div>
          ${statusTag}
        </div>
        ${delBtnHtml}
      `;

      card.addEventListener("click", () => {
        openNoteWindow(item.id).catch((e) => console.error("打开便签失败:", e));
      });

      const delBtn = card.querySelector(".card-delete")! as HTMLButtonElement;

      // 两次点击确认删除（替代不可用的 confirm 弹窗）
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (delBtn.classList.contains("confirming")) {
          try {
            await deleteNote(item.id);
            render();
          } catch (err) {
            console.error("删除失败:", err);
            delBtn.classList.remove("confirming");
            delBtn.textContent = "\u2715";
          }
        } else {
          delBtn.classList.add("confirming");
          delBtn.textContent = "确认?";
          setTimeout(() => {
            if (delBtn.isConnected) {
              delBtn.classList.remove("confirming");
              delBtn.textContent = "\u2715";
            }
          }, 3000);
        }
      });

      listEl.appendChild(card);
    });
  }

  render();
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
