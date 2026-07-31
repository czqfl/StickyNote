"""
桌面便签 (Sticky Note) — 精致版 + 历史便签
- 始终悬浮在桌面最顶层（绿点=置顶，灰圈=取消）
- 可直接输入 / 编辑文本，支持撤销
- 鼠标移到窗口边缘或四角（光标变双向箭头）拖动即可改大小
- 圆角 + 阴影 + 无边框，干净不毛刺
- 每个便签都是独立文件，自动保存；标题栏「历史」可查看 / 重新打开 / 删除旧便签
- 数据存于用户 AppData\\StickyNotes\\，exe 放哪都能正常读写

运行: python sticky_note.py
"""

import ctypes
import glob
import json
import os
import time
import tkinter as tk
import tkinter.messagebox as mb

# 数据存储目录（打包后也可写，放在用户 AppData 下）
APPDATA = os.getenv("APPDATA") or os.path.expanduser("~")
STORAGE_DIR = os.path.join(APPDATA, "StickyNotes")
os.makedirs(STORAGE_DIR, exist_ok=True)

# ===== 设计系统 =====
# 配色 — 克制暖白，层次分明
BG          = "#FFFEFB"   # 便签纸底色（暖白）
BG_BAR      = "#F7F4EE"   # 标题栏底色
BG_HOVER    = "#EFE9DF"   # 通用悬停
BG_ACTIVE   = "#E4DCCF"   # 按下态
BORDER      = "#EBE5DA"   # 分隔线 / 边框
TEXT_FG     = "#3A3A3A"   # 正文文字
TEXT_SUB    = "#A39C90"   # 副文字（时间、提示）
TEXT_HINT   = "#C8C2B6"   # 最弱层文字
ACCENT      = "#6B9FD9"   # 强调色（选区、光标）
PIN_ON      = "#5BAE6F"   # 置顶：绿
PIN_OFF     = "#C8C2B6"   # 未置顶：灰
DANGER      = "#DD5247"   # 删除文字
DANGER_BG   = "#FBE7E5"   # 删除悬停底
SELECT_BG   = "#D6E4F0"   # 文本选区

# 字体 — YaHei UI 专为界面设计，字形更收敛精致
F_TITLE    = ("Microsoft YaHei UI", 9, "bold")
F_BODY     = ("Microsoft YaHei UI", 11)
F_BODY_SM  = ("Microsoft YaHei UI", 10)
F_CAP      = ("Microsoft YaHei UI", 8)
F_ICON     = ("Microsoft YaHei UI", 10)
F_ICON_X   = ("Microsoft YaHei UI", 11, "bold")
F_ICON_LG  = ("Microsoft YaHei UI", 13, "bold")

BAR_H       = 36           # 标题栏高度
BTN_PADX    = 10           # 按钮左右内距
BTN_GAP     = 3            # 按钮间距
MIN_W, MIN_H = 220, 150


def _note_path(note_id):
    return os.path.join(STORAGE_DIR, f"sticky_note_{note_id}.json")


def apply_premium_style(win):
    """Windows：圆角 + 柔和阴影。非 Windows 直接跳过。"""
    if os.name != "nt":
        return
    try:
        wid = int(win.winfo_id())
        try:
            parent = ctypes.windll.user32.GetParent(wid)
            if parent:
                wid = parent
        except Exception:
            pass
        hwnd = ctypes.c_void_p(wid)
        # 圆角
        DWMWA_WINDOW_CORNER_PREFERENCE = 33
        val = ctypes.c_int(2)  # DWMWCP_ROUND
        ctypes.windll.dwmapi.DwmSetWindowAttribute(
            hwnd, DWMWA_WINDOW_CORNER_PREFERENCE,
            ctypes.byref(val), ctypes.sizeof(val))
        # 柔和阴影
        GCL_STYLE = -26
        CS_DROPSHADOW = 0x00020000
        style = ctypes.windll.user32.GetClassLongPtrW(hwnd, GCL_STYLE)
        ctypes.windll.user32.SetClassLongPtrW(hwnd, GCL_STYLE, style | CS_DROPSHADOW)
    except Exception:
        pass


def _open_note(master, note_id):
    """打开(或前置)某个历史便签，避免重复打开同一份。"""
    registry = getattr(master, "open_notes", {})
    inst = registry.get(note_id)
    if inst is not None and inst.winfo_exists():
        inst.lift()
        inst.attributes("-topmost", inst.pinned)
        return inst
    inst = StickyNote(master, note_id)
    registry[note_id] = inst
    return inst


class StickyNote(tk.Toplevel):
    def __init__(self, master, note_id="main"):
        super().__init__(master)
        self.note_id = note_id
        self.data_file = _note_path(note_id)
        self.title("便签")

        self.overrideredirect(True)
        self.attributes("-topmost", True)
        self.configure(bg=BG)
        self.minsize(MIN_W, MIN_H)
        self.geometry("280x220+400+300")

        self.pinned = True
        self._drag = None
        self._resize = None
        self._save_job = None
        self._skip_save = False

        data = self._load()
        if data.get("geometry"):
            self.geometry(data["geometry"])
        self.pinned = data.get("pinned", True)
        self.attributes("-topmost", self.pinned)

        self._build(data)
        self._bind_resize_handles()

        self.bind("<Control-s>", lambda e: self.save())
        self.bind("<FocusOut>", lambda e: self.save())

        getattr(self.master, "open_notes", {})[self.note_id] = self
        self.update_idletasks()
        apply_premium_style(self)
        self.save()

    # ---------------- 数据存取 ----------------
    def _load(self):
        try:
            with open(self.data_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}

    def save(self):
        if getattr(self, "_skip_save", False):
            return
        prev = self._load()
        now = time.time()
        data = {
            "content": self.text.get("1.0", "end-1c"),
            "geometry": self.geometry(),
            "pinned": self.pinned,
            "created": prev.get("created", now),
            "updated": now,
        }
        try:
            with open(self.data_file, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
        except Exception:
            pass

    def _schedule_save(self):
        if self._save_job:
            self.after_cancel(self._save_job)
        self._save_job = self.after(600, self.save)

    def destroy(self):
        self.save()
        getattr(self.master, "open_notes", {}).pop(self.note_id, None)
        super().destroy()

    # ---------------- 界面构建 ----------------
    def _build(self, data):
        # ---- 标题栏 ----
        self.bar = tk.Frame(self, bg=BG_BAR, height=BAR_H)
        self.bar.pack(fill="x")
        self.bar.pack_propagate(False)

        # 左侧：装饰小圆点 + 标题
        dot = tk.Label(self.bar, text="\u25cf", bg=BG_BAR, fg=ACCENT,
                       font=("Microsoft YaHei UI", 7))
        dot.pack(side="left", padx=(14, 6))

        self.title_lbl = tk.Label(self.bar, text="便签", bg=BG_BAR, fg=TEXT_SUB,
                                  font=F_TITLE)
        self.title_lbl.pack(side="left")

        # 右侧按钮（从右到左 pack）
        self.close_btn = tk.Label(self.bar, text="\u2715", bg=BG_BAR, fg=TEXT_SUB,
                                  cursor="hand2", font=F_ICON_X)
        self._pack_btn(self.close_btn, lambda e: self.destroy(),
                       hover_bg=DANGER_BG, hover_fg=DANGER)

        self.pin_btn = tk.Label(self.bar, text="\u25cf", bg=BG_BAR,
                                fg=PIN_ON if self.pinned else PIN_OFF,
                                cursor="hand2", font=("Microsoft YaHei UI", 8, "bold"))
        self._pack_btn(self.pin_btn, self._toggle_pin, hover_bg=BG_HOVER)

        self.new_btn = tk.Label(self.bar, text="\uff0b", bg=BG_BAR, fg=TEXT_SUB,
                                cursor="hand2", font=F_ICON_LG)
        self._pack_btn(self.new_btn, self._new_note, hover_bg=BG_HOVER)

        self.history_btn = tk.Label(self.bar, text="\u2630", bg=BG_BAR, fg=TEXT_SUB,
                                    cursor="hand2", font=F_ICON)
        self._pack_btn(self.history_btn, self._open_history, hover_bg=BG_HOVER)

        # 分隔线
        sep = tk.Frame(self, bg=BORDER, height=1)
        sep.pack(fill="x")

        # ---- 正文 ----
        self.text = tk.Text(self, bg=BG, fg=TEXT_FG, relief="flat", bd=0,
                            padx=16, pady=14, wrap="word",
                            font=F_BODY, insertbackground=ACCENT,
                            selectbackground=SELECT_BG, selectforeground=TEXT_FG,
                            highlightthickness=0, undo=True,
                            spacing1=4, spacing2=3, spacing3=4)
        self.text.pack(fill="both", expand=True)
        self.text.insert("1.0", data.get("content", ""))
        self.text.bind("<KeyRelease>", lambda e: self._schedule_save())
        self.text.focus_set()

        for w in (self.bar, self.title_lbl, dot):
            w.bind("<Button-1>", self._start_drag)
            w.bind("<B1-Motion>", self._do_drag)
        self.bar.bind("<Double-1>", self._toggle_pin)

    def _pack_btn(self, btn, cmd, hover_bg=BG_HOVER, hover_fg=None):
        btn.pack(side="right", padx=BTN_GAP)
        # 给按钮加内距让点击区域更舒适
        btn.config(padx=BTN_PADX)
        base_fg = btn.cget("fg")

        def enter(e):
            btn.config(bg=hover_bg)
            if hover_fg:
                btn.config(fg=hover_fg)

        def leave(e):
            btn.config(bg=BG_BAR)
            if hover_fg:
                btn.config(fg=base_fg)

        btn.bind("<Enter>", enter)
        btn.bind("<Leave>", leave)
        btn.bind("<Button-1>", cmd)

    # ---------------- 边缘 / 四角 缩放（隐形手柄）----------------
    def _bind_resize_handles(self):
        specs = {
            "n":  dict(relx=0,   rely=0,   relwidth=1, height=6, x=0,  y=0,  cursor="sb_v_double_arrow"),
            "s":  dict(relx=0,   rely=1.0, relwidth=1, height=6, x=0,  y=-6, cursor="sb_v_double_arrow"),
            "w":  dict(relx=0,   rely=0,   relheight=1, width=6, x=0,  y=0,  cursor="sb_h_double_arrow"),
            "e":  dict(relx=1.0, rely=0,   relheight=1, width=6, x=-6, y=0,  cursor="sb_h_double_arrow"),
            "nw": dict(relx=0,   rely=0,   width=10, height=10, x=0,  y=0,  cursor="size_nw_se"),
            "ne": dict(relx=1.0, rely=0,   width=10, height=10, x=-10, y=0, cursor="size_ne_sw"),
            "sw": dict(relx=0,   rely=1.0, width=10, height=10, x=0,  y=-10, cursor="size_ne_sw"),
            "se": dict(relx=1.0, rely=1.0, width=10, height=10, x=-10, y=-10, cursor="size_nw_se"),
        }
        for name, spec in specs.items():
            h = tk.Frame(self, bg=BG, cursor=spec.pop("cursor"))
            h.place(**spec)
            h.bind("<Button-1>", lambda e, m=name: self._start_resize(e, m))
            h.bind("<B1-Motion>", self._do_resize)
            h.bind("<ButtonRelease-1>", lambda e: self.save())

    # ---------------- 拖动 ----------------
    def _start_drag(self, e):
        if e.widget in (self.pin_btn, self.close_btn, self.new_btn, self.history_btn):
            return
        self._drag = (e.x_root, e.y_root, self.winfo_x(), self.winfo_y())

    def _do_drag(self, e):
        if not self._drag:
            return
        sx, sy, ox, oy = self._drag
        self.geometry(f"+{ox + (e.x_root - sx)}+{oy + (e.y_root - sy)}")

    # ---------------- 缩放 ----------------
    def _start_resize(self, e, mode):
        self._resize = (mode, e.x_root, e.y_root,
                        self.winfo_x(), self.winfo_y(),
                        self.winfo_width(), self.winfo_height())

    def _do_resize(self, e):
        if not self._resize:
            return
        mode, sx, sy, ox, oy, ow, oh = self._resize
        dx, dy = e.x_root - sx, e.y_root - sy
        x, y, w, h = ox, oy, ow, oh
        if "e" in mode:
            w = max(MIN_W, ow + dx)
        if "s" in mode:
            h = max(MIN_H, oh + dy)
        if "w" in mode:
            w = max(MIN_W, ow - dx)
            x = ox + (ow - w)
        if "n" in mode:
            h = max(MIN_H, oh - dy)
            y = oy + (oh - h)
        self.geometry(f"{w}x{h}+{x}+{y}")

    # ---------------- 功能 ----------------
    def _toggle_pin(self, e=None):
        self.pinned = not self.pinned
        self.attributes("-topmost", self.pinned)
        self.pin_btn.config(fg=PIN_ON if self.pinned else PIN_OFF)
        self._schedule_save()

    def _new_note(self, e=None):
        x, y = self.winfo_x() + 30, self.winfo_y() + 30
        note = StickyNote(self.master, _new_id())
        note.geometry(f"+{x}+{y}")
        note.lift()

    def _open_history(self, e=None):
        HistoryWindow(self.master)


def _new_id():
    import uuid
    return uuid.uuid4().hex[:6]


class HistoryWindow(tk.Toplevel):
    def __init__(self, master):
        super().__init__(master)
        self.title("历史便签")
        self.overrideredirect(True)
        self.attributes("-topmost", True)
        self.configure(bg=BG)
        self.minsize(300, 180)
        self.geometry("340x460")

        self._drag = None

        # ---- 标题栏 ----
        bar = tk.Frame(self, bg=BG_BAR, height=BAR_H)
        bar.pack(fill="x")
        bar.pack_propagate(False)

        dot = tk.Label(bar, text="\u25cf", bg=BG_BAR, fg=ACCENT,
                       font=("Microsoft YaHei UI", 7))
        dot.pack(side="left", padx=(14, 6))
        tk.Label(bar, text="历史便签", bg=BG_BAR, fg=TEXT_SUB,
                 font=F_TITLE).pack(side="left")

        close = tk.Label(bar, text="\u2715", bg=BG_BAR, fg=TEXT_SUB, cursor="hand2",
                         font=F_ICON_X, padx=BTN_PADX)
        close.pack(side="right", padx=BTN_GAP)

        def c_enter(e): close.config(bg=DANGER_BG, fg=DANGER)
        def c_leave(e): close.config(bg=BG_BAR, fg=TEXT_SUB)
        close.bind("<Enter>", c_enter); close.bind("<Leave>", c_leave)
        close.bind("<Button-1>", lambda e: self.destroy())
        bar.bind("<Button-1>", self._start_drag)
        bar.bind("<B1-Motion>", self._do_drag)

        sep = tk.Frame(self, bg=BORDER, height=1)
        sep.pack(fill="x")

        # ---- 列表区 ----
        list_wrap = tk.Frame(self, bg=BG)
        list_wrap.pack(fill="both", expand=True)

        self.canvas = tk.Canvas(list_wrap, bg=BG, highlightthickness=0, bd=0)
        self.sb = tk.Scrollbar(list_wrap, orient="vertical", width=6,
                               bg=BG, troughcolor=BG,
                               activebackground=BORDER,
                               command=self.canvas.yview)
        self.list_frame = tk.Frame(self.canvas, bg=BG)
        self.inner_id = self.canvas.create_window((0, 0), window=self.list_frame, anchor="nw")
        self.canvas.configure(yscrollcommand=self.sb.set)
        self.canvas.pack(side="left", fill="both", expand=True, padx=(10, 0), pady=10)
        self.sb.pack(side="right", fill="y", padx=(0, 4))

        self.canvas.bind("<Configure>", self._on_canvas_configure)
        self.list_frame.bind("<Configure>",
                             lambda e: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self.canvas.bind("<MouseWheel>",
                         lambda e: self.canvas.yview_scroll(-1 * (e.delta // 120), "units"))
        self.list_frame.bind("<MouseWheel>",
                             lambda e: self.canvas.yview_scroll(-1 * (e.delta // 120), "units"))

        self._populate()
        self.update_idletasks()
        apply_premium_style(self)

    def _on_canvas_configure(self, e):
        # 让内部 frame 宽度跟随 canvas，避免水平滚动条
        self.canvas.itemconfig(self.inner_id, width=e.width)
        self.canvas.configure(scrollregion=self.canvas.bbox("all"))

    # ---------------- 历史列表 ----------------
    def _populate(self):
        for w in self.list_frame.winfo_children():
            w.destroy()

        files = glob.glob(_note_path("*"))
        items = []
        for fp in files:
            try:
                with open(fp, encoding="utf-8") as f:
                    d = json.load(f)
            except Exception:
                continue
            note_id = os.path.basename(fp)[len("sticky_note_"):-len(".json")]
            content = d.get("content", "")
            first = (content.strip().splitlines() or ["(空便签)"])[0]
            snippet = (first[:36] if first else "(空便签)")
            updated = d.get("updated", 0)
            updated_str = time.strftime("%m/%d %H:%M", time.localtime(updated)) if updated else ""
            items.append((updated, note_id, snippet, updated_str))
        items.sort(reverse=True)
        if not items:
            self._empty()
            return
        for _, note_id, snippet, updated_str in items:
            self._add_row(note_id, snippet, updated_str)

    def _empty(self):
        wrap = tk.Frame(self.list_frame, bg=BG)
        wrap.pack(fill="x", pady=48)
        tk.Label(wrap, text="\u270e", bg=BG, fg=TEXT_HINT,
                 font=("Microsoft YaHei UI", 28)).pack()
        tk.Label(wrap, text="还没有历史便签", bg=BG, fg=TEXT_SUB,
                 font=F_BODY_SM).pack(pady=(10, 0))

    def _add_row(self, note_id, snippet, updated_str):
        # 卡片本体（圆角由系统提供，这里用底色 + 内边距营造层次）
        card = tk.Frame(self.list_frame, bg=BG_BAR, cursor="hand2")
        card.pack(fill="x", padx=6, pady=3)

        # 内容区
        info = tk.Frame(card, bg=BG_BAR)
        info.pack(side="left", fill="both", expand=True, padx=14, pady=10)

        lbl_snip = tk.Label(info, text=snippet, bg=BG_BAR, fg=TEXT_FG, font=F_BODY_SM,
                            anchor="w", justify="left", wraplength=240)
        lbl_snip.pack(fill="x")

        lbl_time = tk.Label(info, text=updated_str, bg=BG_BAR, fg=TEXT_SUB,
                            font=F_CAP)
        lbl_time.pack(fill="x", pady=(5, 0))

        # 删除按钮
        delb = tk.Label(card, text="\u2715", bg=BG_BAR, fg=TEXT_HINT, cursor="hand2",
                        font=("Microsoft YaHei UI", 9, "bold"), padx=12)
        delb.pack(side="right", fill="y")

        # 需要统一变色的所有子控件
        _bg_widgets = [card, info, lbl_snip, lbl_time]

        # ---- 删除按钮交互 ----
        def d_enter(e):
            delb.config(fg=DANGER, bg=DANGER_BG)

        def d_leave(e):
            delb.config(fg=TEXT_HINT, bg=BG_BAR)

        delb.bind("<Enter>", d_enter); delb.bind("<Leave>", d_leave)
        delb.bind("<Button-1>", lambda e: self._delete(note_id))

        # ---- 卡片 hover ----
        def r_enter(e):
            for w in _bg_widgets:
                w.config(bg=BG_HOVER)

        def r_leave(e):
            for w in _bg_widgets:
                w.config(bg=BG_BAR)

        card.bind("<Enter>", r_enter); card.bind("<Leave>", r_leave)
        # 点击打开（绑定到所有可点击区域）
        for w in (card, info, lbl_snip, lbl_time):
            w.bind("<Button-1>", lambda e: self._open(note_id))

    def _open(self, note_id):
        _open_note(self.master, note_id)

    def _delete(self, note_id):
        if not mb.askyesno("删除便签", "确定删除该便签？此操作不可恢复。"):
            return
        path = _note_path(note_id)
        try:
            os.remove(path)
        except Exception:
            pass
        registry = getattr(self.master, "open_notes", {})
        inst = registry.get(note_id)
        if inst is not None and inst.winfo_exists():
            inst._skip_save = True
            inst.destroy()
        self._populate()
        self.canvas.configure(scrollregion=self.canvas.bbox("all"))

    # ---------------- 拖动 ----------------
    def _start_drag(self, e):
        self._drag = (e.x_root, e.y_root, self.winfo_x(), self.winfo_y())

    def _do_drag(self, e):
        if not self._drag:
            return
        sx, sy, ox, oy = self._drag
        self.geometry(f"+{ox + (e.x_root - sx)}+{oy + (e.y_root - sy)}")


def main():
    root = tk.Tk()
    root.withdraw()
    root.open_notes = {}
    StickyNote(root, "main")
    root.mainloop()


if __name__ == "__main__":
    main()
