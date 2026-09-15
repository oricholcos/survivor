// src/ui/soundToggle.ts —— 右上角音效开关小按钮（T4.1）。
// 固定定位在视口右上角（z-index 高于覆盖面板，任意界面都可点；小尺寸不遮画布关键区）。
// 点击 → setEnabled 切换（持久化在 src/audio/sfx 内）+ 文案切换 + 开启时 uiClick 反馈
// （关闭时静音：playSfx 内部按 enabled 拦截）。样式本模块注入，零外部资源。
import { isSfxEnabled, playSfx, setEnabled } from '../audio/sfx';

const TOGGLE_CSS = `
#sfx-toggle {
  position: fixed;
  /* 安全区（T4.5）：刘海屏/横屏贴边时避开系统 UI（env 不支持时回落 0px） */
  top: calc(10px + env(safe-area-inset-top, 0px));
  right: calc(10px + env(safe-area-inset-right, 0px));
  z-index: 120;
  box-sizing: border-box;
  min-height: 44px;
  padding: 8px 18px;
  font-size: 13px;
  letter-spacing: 1px;
  color: #a5ecff;
  background: rgba(10, 17, 36, 0.82);
  border: 1px solid rgba(24, 201, 255, 0.45);
  border-radius: 999px;
  cursor: pointer;
  font-family: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', sans-serif;
  text-shadow: 0 0 8px rgba(24, 201, 255, 0.4);
  /* 触屏（T4.5）：快速连点不吃双击缩放判定；长按不误选文字 */
  touch-action: manipulation;
  user-select: none;
  -webkit-user-select: none;
  box-shadow: 0 0 12px rgba(24, 201, 255, 0.15), inset 0 0 10px rgba(24, 201, 255, 0.06);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  opacity: 0.92;
  transition: opacity 0.15s, background 0.15s, border-color 0.15s, box-shadow 0.15s, transform 0.06s;
}
/* hover 态仅在支持悬停的指针设备生效（T4.5）：触屏点按后不粘滞残留高亮 */
@media (hover: hover) {
  #sfx-toggle:hover {
    opacity: 1;
    background: rgba(24, 201, 255, 0.14);
    border-color: rgba(24, 201, 255, 0.85);
    box-shadow: 0 0 18px rgba(24, 201, 255, 0.35), inset 0 0 12px rgba(24, 201, 255, 0.1);
  }
}
#sfx-toggle:active {
  transform: scale(0.96);
}
#sfx-toggle:focus-visible {
  outline: 2px solid #18c9ff;
  outline-offset: 2px;
}
`;

/** 挂载音效开关按钮（幂等：已存在则跳过）。由 src/main.ts 在 initUi 之前调用。 */
export function initSoundToggle(): void {
  if (document.getElementById('sfx-toggle') !== null) {
    return;
  }
  const style = document.createElement('style');
  style.id = 'sfx-toggle-style';
  style.textContent = TOGGLE_CSS;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.id = 'sfx-toggle';
  btn.type = 'button';
  const label = (): string => (isSfxEnabled() ? '音效：开' : '音效：关');
  btn.textContent = label();

  btn.addEventListener('click', () => {
    const next = !isSfxEnabled();
    setEnabled(next);
    btn.textContent = label();
    if (next) {
      playSfx('uiClick'); // 开启反馈；关闭时 playSfx 按 enabled 拦截，天然静音
    }
  });
  document.body.appendChild(btn);
}
