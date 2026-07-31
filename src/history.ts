import { listNotes, deleteNote, openNoteWindow, closeWindow, startDragging, getOpenNotes } from "./api";
import { getSettings, onSettingsChanged } from "./settings";
import { applyPanelWithGlass } from "./panel-bg";

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

  // 套用全局外观主题（浅色 / 透明 / 深色），并使历史窗口与便签使用同一套
  // 背景管线（自定义背景图 / 透明主题壁纸 + 高斯模糊 + 按钮亮度自适应）。
  async function applyThemeAndBg() {
    try {
      const s = await getSettings();
      const root = document.documentElement;
      root.classList.remove("theme-dark");
      if ((s.theme || "light") === "dark") root.classList.add("theme-dark");
      const hw = document.querySelector(".history-window") as HTMLElement | null;
      if (!hw) return;
      // 内容区透出背景的程度（近不透明，保证列表可读）
      hw.style.setProperty("--note-panel-alpha", "0.9");
      hw.style.setProperty("--note-bar-alpha", "0.9");
      await applyPanelWithGlass(hw, s);
    } catch (e) {
      console.error("读取主题失败:", e);
    }
  }
  applyThemeAndBg();
  // 设置变更（如切主题/换背景/调模糊）时历史窗口即时跟随
  onSettingsChanged(applyThemeAndBg);

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
