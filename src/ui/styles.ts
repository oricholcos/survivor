// src/ui/styles.ts —— DOM 覆盖层统一样式（T4.4 视觉打磨：统一霓虹几何风）。
//
// 纯样式层：只导出 CSS 字符串，由 overlay.ts 注入 <style>（幂等），零外部资源。
// 设计基调与画布霓虹配色对齐（弹丸青 #18c9ff / 导弹品红 #ff2fb0 / 霰弹橙 #ff8f1f）：
// 深蓝黑玻璃拟态面板 + 霓虹描边外发光 + 统一圆角/内边距/阴影 + 入场淡入上浮。
// 所有选择器均基于 overlay.ts 现有 DOM 结构与类名书写，不要求任何标记改动。
//
// 设计 token（CSS 自定义属性，挂在 #ov-root 上）：
//   --neon-cyan    #18c9ff   主色：面板描边 / 主标题 / 主按钮 / 「升级」徽章
//   --neon-magenta #ff2fb0   点缀：标题分隔线 / 无尽终章标题
//   --neon-orange  #ff8f1f   强调点缀（与画布霰弹橙同源，标题分隔线中段）
//   --neon-yellow  #ffe066   数值强调与「新武器」徽章
//   --neon-green   #8dffb0   辅助指示色
//   --neon-teal    #35ffc3   结算「守城成功」标题钩子（.ov-title--win）
//   --neon-red     #ff4d6d   结算「城墙陷落」标题钩子（.ov-title--lose）
//   --glass-bg     rgba(10,17,36,.78)  玻璃拟态面板底色
//   圆角：面板 16px / 按钮与卡片 10px / 徽章胶囊 999px；触控目标高度 ≥ 44px。
//
// 触屏适配（T4.5）：按钮/卡片/遮罩 touch-action: manipulation（消双击缩放延迟）；
// hover 态包 @media (hover: hover)（触屏不粘滞）；.ov-panel 内边距叠加
// env(safe-area-inset-*)（刘海/底部横条）；横屏矮视口压缩纵向排版；
// 画布侧 touch-action: none 与 viewport-fit=cover 在 index.html 配套。

export const OVERLAY_CSS = `
#ov-root {
  --neon-cyan: #18c9ff;
  --neon-magenta: #ff2fb0;
  --neon-orange: #ff8f1f;
  --neon-yellow: #ffe066;
  --neon-green: #8dffb0;
  --neon-teal: #35ffc3;
  --neon-red: #ff4d6d;
  --glass-bg: rgba(10, 17, 36, 0.78);
  --glass-border: rgba(24, 201, 255, 0.5);
  --text-bright: #eaf4ff;
  --text-dim: #9aa7c7;
  --text-faint: #6b7694;
  --radius-panel: 16px;
  --radius-btn: 10px;
  --tap-min: 44px;
  font-family: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', sans-serif;
}

/* —— 遮罩：深色渐晕压暗画布，让玻璃面板浮出 —— */
.ov-panel {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 安全区（T4.5）：iPhone 刘海/圆角/底部横条 env() 叠加进内边距，面板内容不被系统 UI 压住 */
  padding:
    calc(16px + env(safe-area-inset-top, 0px))
    calc(16px + env(safe-area-inset-right, 0px))
    calc(16px + env(safe-area-inset-bottom, 0px))
    calc(16px + env(safe-area-inset-left, 0px));
  /* 触屏（T4.5）：遮罩层禁双击缩放（保留捏合缩放与滚动手势，不动 user-scalable 可访问性） */
  touch-action: manipulation;
  background: radial-gradient(ellipse at 50% 42%, rgba(5, 8, 20, 0.55) 0%, rgba(3, 4, 10, 0.82) 100%);
}
.ov-hidden { display: none !important; }

/* —— 三类面板统一：玻璃拟态 + 霓虹描边外发光 + 入场淡入上浮 —— */
.ov-card {
  box-sizing: border-box;
  margin: auto; /* 面板超高时防顶部裁切（safe 居中） */
  background:
    linear-gradient(160deg, rgba(24, 201, 255, 0.07) 0%, rgba(255, 47, 176, 0.05) 100%),
    var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-panel);
  padding: 32px 38px;
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  box-shadow:
    0 0 28px rgba(24, 201, 255, 0.2),
    0 0 72px rgba(24, 201, 255, 0.08),
    inset 0 1px 0 rgba(24, 201, 255, 0.25),
    inset 0 0 32px rgba(24, 201, 255, 0.05),
    0 18px 48px rgba(0, 0, 0, 0.6);
  color: var(--text-bright);
  text-align: center;
  max-width: min(92vw, 560px);
  max-height: 86vh;
  max-height: 86dvh; /* 动态视口（T4.5）：移动端地址栏收展时跟随，不支持则回落上一行 */
  overflow: auto;
  /* 触屏（T4.5）：卡片整体禁双击缩放（manipulation 仍允许触摸滚动溢出内容） */
  touch-action: manipulation;
  animation: ov-card-in 180ms ease-out;
}
@keyframes ov-card-in {
  from { opacity: 0; transform: translateY(12px) scale(0.985); }
  to { opacity: 1; transform: none; }
}

/* —— 标题体系：青色荧光主标题；结算标题按结局着色 —— */
.ov-title {
  font-size: 30px;
  font-weight: 800;
  letter-spacing: 3px;
  color: #9ff0ff;
  text-shadow:
    0 0 6px rgba(24, 201, 255, 0.85),
    0 0 18px rgba(24, 201, 255, 0.5),
    0 0 42px rgba(24, 201, 255, 0.3);
  margin-bottom: 8px;
}
.ov-title--main { font-size: 44px; letter-spacing: 4px; line-height: 1.2; }
.ov-title--main::after {
  content: '';
  display: block;
  width: 148px;
  height: 2px;
  margin: 12px auto 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, transparent, var(--neon-cyan) 28%, var(--neon-orange) 50%, var(--neon-magenta) 72%, transparent);
  box-shadow: 0 0 10px rgba(24, 201, 255, 0.6);
}
/* 无尽终章（结算强调版式 .ov-score 所在卡）：品红标题（无需逻辑层配合） */
.ov-card:has(.ov-score) .ov-title {
  color: #ff8fd0;
  text-shadow:
    0 0 6px rgba(255, 47, 176, 0.85),
    0 0 18px rgba(255, 47, 176, 0.5),
    0 0 42px rgba(255, 47, 176, 0.3);
}
/* 结局标题钩子（青绿=守城成功 / 红=城墙陷落 / 品红=无尽终章）：
   逻辑层在 showResult 补挂类名即生效（本层不碰 JS）。 */
.ov-title--win {
  color: #7dffd4;
  text-shadow:
    0 0 6px rgba(53, 255, 195, 0.85),
    0 0 18px rgba(53, 255, 195, 0.5),
    0 0 42px rgba(53, 255, 195, 0.3);
}
.ov-title--lose {
  color: #ff8fa0;
  text-shadow:
    0 0 6px rgba(255, 77, 109, 0.85),
    0 0 18px rgba(255, 77, 109, 0.5),
    0 0 42px rgba(255, 77, 109, 0.3);
}
.ov-title--endless {
  color: #ff8fd0;
  text-shadow:
    0 0 6px rgba(255, 47, 176, 0.85),
    0 0 18px rgba(255, 47, 176, 0.5),
    0 0 42px rgba(255, 47, 176, 0.3);
}

.ov-sub { font-size: 14px; color: var(--text-dim); letter-spacing: 2px; margin-bottom: 22px; }
.ov-foot { font-size: 12px; color: var(--text-faint); letter-spacing: 1px; }
.ov-stats { font-size: 18px; line-height: 2; margin-bottom: 20px; color: var(--text-bright); }
.ov-stats b {
  color: var(--neon-yellow);
  font-weight: 700;
  text-shadow: 0 0 10px rgba(255, 224, 102, 0.45);
}
.ov-score {
  font-size: 26px;
  color: var(--neon-yellow);
  font-weight: 700;
  letter-spacing: 1px;
  text-shadow: 0 0 12px rgba(255, 224, 102, 0.5), 0 0 32px rgba(255, 224, 102, 0.25);
}

/* —— 按钮体系：霓虹主按钮 / 弱化次按钮，三态齐全，触控高度 ≥44px —— */
.ov-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-height: var(--tap-min);
  border: 1px solid rgba(24, 201, 255, 0.75);
  background: rgba(24, 201, 255, 0.1);
  color: #a5ecff;
  font-family: inherit;
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 4px;
  line-height: 1.2;
  padding: 10px 34px;
  border-radius: var(--radius-btn);
  cursor: pointer;
  text-shadow: 0 0 8px rgba(24, 201, 255, 0.5);
  /* 触屏（T4.5）：消除快速连点时的双击缩放判定；长按不误选文字（44px 高度见 --tap-min） */
  touch-action: manipulation;
  user-select: none;
  -webkit-user-select: none;
  box-shadow: 0 0 14px rgba(24, 201, 255, 0.18), inset 0 0 14px rgba(24, 201, 255, 0.08);
  transition:
    background 0.15s ease,
    border-color 0.15s ease,
    box-shadow 0.15s ease,
    color 0.15s ease,
    transform 0.06s ease;
}
/* hover 态仅在支持悬停的指针设备生效（T4.5）：触屏点按后不粘滞残留高亮 */
@media (hover: hover) {
  .ov-btn:hover {
    background: rgba(24, 201, 255, 0.2);
    border-color: var(--neon-cyan);
    color: #cff5ff;
    box-shadow: 0 0 22px rgba(24, 201, 255, 0.45), inset 0 0 18px rgba(24, 201, 255, 0.14);
  }
}
.ov-btn:active {
  transform: scale(0.97);
  box-shadow: 0 0 10px rgba(24, 201, 255, 0.3), inset 0 0 10px rgba(24, 201, 255, 0.1);
}
.ov-btn:focus-visible {
  outline: 2px solid var(--neon-cyan);
  outline-offset: 2px;
}
.ov-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  transform: none;
  text-shadow: none;
  box-shadow: none;
}
.ov-modes { display: flex; flex-direction: column; gap: 12px; margin-bottom: 20px; }
.ov-btn--mode {
  width: 100%;
  font-size: 17px;
  letter-spacing: 1px;
  padding: 12px 22px;
}
.ov-btnrow {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  justify-content: center;
}
.ov-btn--ghost {
  border-color: rgba(154, 167, 199, 0.45);
  color: var(--text-dim);
  background: rgba(154, 167, 199, 0.07);
  text-shadow: none;
  box-shadow: none;
}
@media (hover: hover) {
  .ov-btn--ghost:hover {
    border-color: rgba(154, 167, 199, 0.85);
    color: #c6d0e8;
    background: rgba(154, 167, 199, 0.15);
    box-shadow: 0 0 12px rgba(154, 167, 199, 0.2);
  }
}

/* —— 三选一卡片：等宽等高 + hover 抬升描边发光 —— */
.ov-options {
  display: grid;
  grid-auto-rows: 1fr; /* 行等高：三卡对齐 */
  gap: 12px;
  margin-top: 16px;
}
.ov-option {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 6px;
  box-sizing: border-box;
  width: 100%;
  min-height: var(--tap-min);
  text-align: left;
  background: linear-gradient(150deg, rgba(24, 201, 255, 0.08) 0%, rgba(24, 201, 255, 0.03) 100%);
  border: 1px solid rgba(24, 201, 255, 0.3);
  border-radius: var(--radius-btn);
  padding: 12px 16px;
  cursor: pointer;
  color: inherit;
  font: inherit;
  /* 触屏（T4.5）：三选一快速点选不吃双击缩放；长按不误选文字（min-height 见 --tap-min） */
  touch-action: manipulation;
  user-select: none;
  -webkit-user-select: none;
  transition:
    background 0.15s ease,
    border-color 0.15s ease,
    box-shadow 0.15s ease,
    transform 0.15s ease;
}
/* hover 态仅在支持悬停的指针设备生效（T4.5）：触屏点按后不粘滞残留抬升/发光 */
@media (hover: hover) {
  .ov-option:hover {
    background: linear-gradient(150deg, rgba(24, 201, 255, 0.16) 0%, rgba(255, 47, 176, 0.07) 100%);
    border-color: rgba(24, 201, 255, 0.85);
    box-shadow: 0 0 18px rgba(24, 201, 255, 0.32), inset 0 0 14px rgba(24, 201, 255, 0.08);
    transform: translateY(-2px);
  }
}
.ov-option:active { transform: translateY(0) scale(0.99); }
.ov-option:focus-visible {
  outline: 2px solid var(--neon-cyan);
  outline-offset: 2px;
}
.ov-option-top { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.ov-kind {
  flex-shrink: 0;
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid;
  letter-spacing: 1px;
}
.ov-kind--new {
  color: var(--neon-yellow);
  border-color: rgba(255, 224, 102, 0.6);
  background: rgba(255, 224, 102, 0.1);
  text-shadow: 0 0 8px rgba(255, 224, 102, 0.5);
}
.ov-kind--up {
  color: #7fe3ff;
  border-color: rgba(24, 201, 255, 0.6);
  background: rgba(24, 201, 255, 0.1);
  text-shadow: 0 0 8px rgba(24, 201, 255, 0.5);
}
.ov-kind--weapon {
  color: #c084ff;
  border-color: rgba(192, 132, 255, 0.6);
  background: rgba(192, 132, 255, 0.12);
  text-shadow: 0 0 8px rgba(192, 132, 255, 0.45);
}
.ov-kind--unlimited,
.ov-kind--break {
  color: #ff8fd0;
  border-color: rgba(255, 47, 176, 0.7);
  background: rgba(255, 47, 176, 0.16);
  text-shadow: 0 0 8px rgba(255, 47, 176, 0.6);
  font-weight: 700;
}
.ov-name { font-size: 18px; font-weight: 700; color: var(--text-bright); }
.ov-desc { font-size: 13px; line-height: 1.55; color: var(--text-dim); }
.ov-level-indicator {
  font-size: 13px;
  font-weight: 600;
  color: #7fe3ff;
  letter-spacing: 0.5px;
  margin-top: 2px;
}
.ov-level-indicator--break {
  color: #ff8fd0;
  text-shadow: 0 0 6px rgba(255, 47, 176, 0.4);
}
.ov-level-indicator--init {
  color: var(--neon-yellow);
  text-shadow: 0 0 6px rgba(255, 224, 102, 0.35);
}
.ov-sub--unlimited {
  color: #ff8fd0;
  text-shadow: 0 0 8px rgba(255, 47, 176, 0.35);
  margin-bottom: 12px;
}

/* —— 武器伤害统计面板（结算排行榜） —— */
.ov-damage-box {
  margin: 16px 0;
  padding: 12px 14px;
  background: rgba(13, 22, 45, 0.65);
  border: 1px solid rgba(24, 201, 255, 0.25);
  border-radius: 10px;
  text-align: left;
}
.ov-damage-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--neon-cyan);
  letter-spacing: 1px;
  margin-bottom: 8px;
  display: flex;
  justify-content: space-between;
}
.ov-damage-total {
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 400;
}
.ov-damage-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ov-damage-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.ov-damage-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  line-height: 1.2;
}
.ov-damage-name-col {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ov-damage-name {
  color: var(--text-bright);
  font-weight: 600;
}
.ov-damage-badge {
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(24, 201, 255, 0.15);
  color: var(--neon-cyan);
  border: 1px solid rgba(24, 201, 255, 0.35);
}
.ov-damage-badge--max {
  background: rgba(255, 224, 102, 0.18);
  color: var(--neon-yellow);
  border-color: rgba(255, 224, 102, 0.45);
}
.ov-damage-val-col {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.ov-damage-num {
  font-family: Consolas, 'Courier New', monospace;
  font-weight: 700;
  color: #fff;
}
.ov-damage-pct {
  font-size: 11px;
  color: var(--neon-cyan);
  font-family: Consolas, 'Courier New', monospace;
}
.ov-damage-dps {
  font-size: 11px;
  color: var(--text-dim);
  font-family: Consolas, 'Courier New', monospace;
}
.ov-damage-bar-track {
  width: 100%;
  height: 5px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 3px;
  overflow: hidden;
}
.ov-damage-bar-fill {
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, #18c9ff 0%, #ff2fb0 100%);
  box-shadow: 0 0 6px rgba(24, 201, 255, 0.5);
  transition: width 300ms ease-out;
}

/* —— 响应式：窄屏（≤400px）收紧内边距、按钮全宽堆叠 —— */
@media (max-width: 400px) {
  .ov-panel {
    padding:
      calc(10px + env(safe-area-inset-top, 0px))
      calc(10px + env(safe-area-inset-right, 0px))
      calc(10px + env(safe-area-inset-bottom, 0px))
      calc(10px + env(safe-area-inset-left, 0px));
  }
  .ov-card { max-width: 100%; padding: 22px 16px; border-radius: 14px; max-height: 90vh; max-height: 90dvh; }
  .ov-title { font-size: 24px; letter-spacing: 2px; }
  .ov-title--main { font-size: 32px; }
  .ov-btn { width: 100%; padding: 10px 16px; letter-spacing: 2px; }
  .ov-btnrow { flex-direction: column; gap: 10px; }
  .ov-stats { font-size: 16px; }
  .ov-score { font-size: 22px; }
  .ov-option { padding: 10px 12px; }
  .ov-name { font-size: 16px; }
  .ov-desc { font-size: 12px; }
  .ov-damage-box { padding: 8px 10px; margin: 12px 0; }
  .ov-damage-info { font-size: 12px; }
  .ov-damage-dps { display: none; }
}

/* —— 横屏矮视口（T4.5，如 800×360）：压缩纵向空间，Scale.FIT 画布缩小时
      面板仍一屏可读可点（触控目标 min-height/44px 不降级；超高时 .ov-card 兜底滚动） —— */
@media (orientation: landscape) and (max-height: 480px) {
  .ov-card { padding: 14px 24px; }
  .ov-title { font-size: 22px; margin-bottom: 4px; }
  .ov-title--main { font-size: 28px; }
  .ov-title--main::after { margin: 8px auto 0; }
  .ov-sub { margin-bottom: 12px; }
  .ov-stats { font-size: 15px; line-height: 1.7; margin-bottom: 10px; }
  .ov-score { font-size: 19px; }
  .ov-damage-box { margin: 8px 0; padding: 6px 10px; }
  .ov-damage-list { gap: 4px; }
  .ov-options { margin-top: 8px; gap: 8px; }
  .ov-option { min-height: var(--tap-min); padding: 8px 14px; }
  .ov-desc { font-size: 12px; }
  .ov-modes { gap: 10px; margin-bottom: 12px; }
  .ov-btnrow { gap: 10px; }
  .ov-btn { min-height: var(--tap-min); padding: 8px 22px; }
}

/* —— 动效减弱偏好：关闭入场动画与位移 —— */
@media (prefers-reduced-motion: reduce) {
  .ov-card { animation: none; }
  .ov-btn, .ov-option { transition: none; }
  .ov-option:hover, .ov-option:active { transform: none; }
}

/* —— 局中构筑悬浮按钮与构筑面板（模块 A & D） —— */
.ov-pause-btn {
  position: fixed;
  top: calc(10px + env(safe-area-inset-top, 0px));
  right: calc(115px + env(safe-area-inset-right, 0px));
  z-index: 160;
  height: 34px;
  padding: 0 14px;
  border-radius: 999px;
  border: 1px solid rgba(24, 201, 255, 0.45);
  background: rgba(10, 17, 36, 0.85);
  color: #eaf4ff;
  font-size: 13px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  cursor: pointer;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  box-shadow: 0 0 12px rgba(24, 201, 255, 0.2);
  transition: all 0.15s ease;
  touch-action: manipulation;
}
.ov-pause-btn:hover {
  border-color: #18c9ff;
  box-shadow: 0 0 18px rgba(24, 201, 255, 0.45);
  transform: scale(1.03);
}

.ov-panel--inspect {
  z-index: 150;
}

.ov-panel--confirm {
  z-index: 200;
}

.ov-card--confirm {
  max-width: min(88vw, 420px);
  padding: 24px 28px;
}
.ov-card--confirm .ov-title {
  font-size: 22px;
  margin-bottom: 12px;
}
.ov-card--confirm .ov-sub {
  font-size: 14px;
  line-height: 1.5;
  margin-bottom: 20px;
  color: #cdd9e5;
}

.ov-card--inspect {
  max-width: min(94vw, 680px);
  max-height: 88vh;
  max-height: 88dvh;
  padding: 24px 28px;
  text-align: left;
}
.ov-inspect-weapons {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin: 16px 0;
  max-height: 55vh;
  overflow-y: auto;
  padding-right: 6px;
}
.ov-weapon-card {
  background: rgba(15, 23, 42, 0.75);
  border: 1px solid rgba(24, 201, 255, 0.25);
  border-radius: 10px;
  padding: 12px 16px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}
.ov-weapon-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.ov-weapon-title {
  font-size: 15px;
  font-weight: 700;
  color: #18c9ff;
  display: flex;
  align-items: center;
  gap: 8px;
}
.ov-weapon-damage {
  font-size: 13px;
  color: #ffe066;
  font-family: monospace;
}
.ov-stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 6px 12px;
  background: rgba(8, 12, 24, 0.6);
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 8px;
  font-size: 12px;
}
.ov-stat-item {
  display: flex;
  justify-content: space-between;
  color: #9aa7c7;
}
.ov-stat-val {
  color: #eaf4ff;
  font-weight: 600;
  font-family: monospace;
}
.ov-cards-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.ov-card-entry {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
  line-height: 1.4;
  color: #cdd9e5;
}
.ov-card-name {
  font-weight: 600;
  color: #8dffb0;
  white-space: nowrap;
}
.ov-card-count {
  color: #ffe066;
  font-size: 11px;
}
.ov-card-desc {
  color: #9aa7c7;
  flex: 1;
}

.ov-btn--reroll {
  margin-top: 14px;
  background: linear-gradient(135deg, rgba(255, 143, 31, 0.22) 0%, rgba(255, 47, 176, 0.18) 100%);
  border: 1px solid rgba(255, 143, 31, 0.6);
  color: #ffe066;
  font-size: 14px;
  box-shadow: 0 0 16px rgba(255, 143, 31, 0.2);
}
.ov-btn--reroll:hover:not(:disabled) {
  border-color: #ff8f1f;
  box-shadow: 0 0 24px rgba(255, 143, 31, 0.45);
  transform: scale(1.02);
}
.ov-btn--reroll:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  filter: grayscale(80%);
}

.ov-btn--danger {
  background: rgba(255, 77, 109, 0.15);
  border-color: rgba(255, 77, 109, 0.5);
  color: #ff859a;
}
.ov-btn--danger:hover {
  border-color: #ff4d6d;
  box-shadow: 0 0 18px rgba(255, 77, 109, 0.4);
}

/* —— 局内武器禁用/开启切换与卡片禁用态（M45） —— */
.ov-weapon-card--disabled {
  opacity: 0.65;
  border-color: rgba(255, 77, 109, 0.45);
  background: rgba(22, 14, 26, 0.75);
}
.ov-damage-badge--disabled {
  color: #ff6b81 !important;
  border-color: rgba(255, 77, 109, 0.6) !important;
  background: rgba(255, 77, 109, 0.18) !important;
}
.ov-weapon-head-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.ov-btn-toggle {
  box-sizing: border-box;
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid rgba(255, 77, 109, 0.45);
  background: rgba(255, 77, 109, 0.12);
  color: #ff8599;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
  touch-action: manipulation;
}
.ov-btn-toggle:hover {
  border-color: #ff4d6d;
  background: rgba(255, 77, 109, 0.25);
  box-shadow: 0 0 10px rgba(255, 77, 109, 0.3);
}
.ov-btn-toggle--disabled {
  border-color: rgba(24, 201, 255, 0.5);
  background: rgba(24, 201, 255, 0.12);
  color: #a5ecff;
}
.ov-btn-toggle--disabled:hover {
  border-color: #18c9ff;
  background: rgba(24, 201, 255, 0.25);
  box-shadow: 0 0 10px rgba(24, 201, 255, 0.3);
}

/* —— 电脑端外部 HUD 面板（画布左侧外部区域，M45） —— */
.ov-hud-pc {
  position: fixed;
  z-index: 90;
  display: flex;
  flex-direction: column;
  gap: 10px;
  pointer-events: auto;
  user-select: none;
  -webkit-user-select: none;
  font-family: Consolas, "Courier New", monospace;
  color: #dff4ff;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.85);
  box-sizing: border-box;
}
.ov-hud-pc-stats {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 19px;
  line-height: 1.35;
  color: #dff4ff;
}
.ov-hud-pc-line {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ov-hud-pc-xp {
  width: 100%;
  max-width: 224px;
}
.ov-hud-pc-xp-track {
  width: 100%;
  height: 8px;
  background: #0e1e36;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid rgba(24, 201, 255, 0.35);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.6);
}
.ov-hud-pc-xp-fill {
  height: 100%;
  background: linear-gradient(90deg, #18c9ff, #38e1ff);
  box-shadow: 0 0 8px rgba(24, 201, 255, 0.7);
  transition: width 0.08s linear;
}
.ov-hud-pc-chips {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 4px;
}
.ov-hud-chip {
  all: unset;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  height: 32px;
  background: rgba(14, 24, 48, 0.75);
  border: 1px solid rgba(24, 201, 255, 0.4);
  border-radius: 999px;
  color: #f2faff;
  font-size: 13px;
  cursor: pointer;
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  transition: all 0.15s ease;
  width: fit-content;
  max-width: 100%;
  touch-action: manipulation;
}
.ov-hud-chip:hover {
  border-color: #18c9ff;
  background: rgba(24, 201, 255, 0.15);
  box-shadow: 0 0 12px rgba(24, 201, 255, 0.4);
  transform: translateX(2px);
}
.ov-hud-chip--max {
  border-color: rgba(255, 224, 102, 0.6);
  color: #ffe066;
}
.ov-hud-chip--lv0 {
  color: #8da4be;
  border-color: rgba(141, 164, 190, 0.35);
}
.ov-hud-chip--disabled {
  opacity: 0.55;
  border-color: rgba(255, 77, 109, 0.4);
  background: rgba(30, 15, 20, 0.65);
  color: #a89aa0;
  text-decoration: line-through;
}
.ov-hud-chip-disabled-tag {
  font-size: 11px;
  color: #ff6b81;
  text-decoration: none;
  font-weight: 700;
}
`;
