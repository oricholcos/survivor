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
//   --neon-green   #8dffb0   「被动」徽章
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
.ov-kind--passive {
  color: var(--neon-green);
  border-color: rgba(141, 255, 176, 0.55);
  background: rgba(141, 255, 176, 0.08);
  text-shadow: 0 0 8px rgba(141, 255, 176, 0.45);
}
.ov-name { font-size: 18px; font-weight: 700; color: var(--text-bright); }
.ov-desc { font-size: 13px; line-height: 1.55; color: var(--text-dim); }

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
`;
