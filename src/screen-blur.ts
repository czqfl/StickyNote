// 高斯模糊（系统级 Acrylic）：零延迟、零错位，由 Windows 在系统层模糊窗口背后内容。
// 强度 0% = 纯透明（关闭 Acrylic）；1~100% = Acrylic 生效，背景透明度随强度增加。
//
// 为什么不用截图+canvas 模糊：截图方案固有延迟（GDI 截屏→JPEG 编码→IPC→解码→绘制，
// 全程 200ms+），且窗口移动时截屏区域与窗口位置必然错位（拖影）。
// Acrylic 由 DWM 在系统合成层实时处理，零延迟、零错位。

import { getCurrentWindow } from "@tauri-apps/api/window";

let applied = false;

/** 启用/更新系统级高斯模糊（Acrylic）。强度 0~100，0 表示关闭。 */
export async function ensureRealtimeBlur(strength: number) {
  try {
    const win = getCurrentWindow();
    if (strength <= 0) {
      if (applied) {
        await win.setEffects({ effects: [] });
        applied = false;
      }
      return;
    }
    if (!applied) {
      await win.setEffects({ effects: ["blur"] as any });
      applied = true;
    }
    // 强度映射到背景透明度：Acrylic 的可见度由窗口背景色 alpha 决定
    const alpha = Math.min(0.4, (strength / 100) * 0.4);
    document.body.style.background = `rgba(255, 253, 248, ${alpha.toFixed(3)})`;
  } catch (e) {
    console.error("设置高斯模糊失败:", e);
  }
}

/** 关闭系统级高斯模糊 */
export function stopRealtimeBlur() {
  if (applied) {
    const win = getCurrentWindow();
    win.setEffects({ effects: [] }).catch(() => {});
    applied = false;
  }
  document.body.style.removeProperty("background");
}
