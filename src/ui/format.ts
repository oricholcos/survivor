// src/ui/format.ts —— 数值与时间格式化工具函数。

/**
 * 格式化毫秒时间为 mm:ss 字符串（非负整秒向下取整）。
 */
export function formatTime(timeMs: number): string {
  const totalSec = Math.floor(Math.max(0, timeMs) / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/**
 * 格式化伤害数值：
 * - >= 1,000,000 -> X.XM
 * - >= 1,000 -> X.Xk
 * - 其它 -> 四舍五入取整
 */
export function formatDamageNum(num: number): string {
  if (!Number.isFinite(num) || num <= 0) {
    return '0';
  }
  if (num >= 1_000_000) {
    return (num / 1_000_000).toFixed(1) + 'M';
  }
  if (num >= 1_000) {
    return (num / 1_000).toFixed(1) + 'k';
  }
  return Math.round(num).toString();
}

/**
 * 获取悬浮暂停/构筑详情按钮的显示文本。
 * - 暂停/展开构筑时：显示播放/恢复图标 '▶ 构筑'
 * - 正常战斗运行时：显示暂停图标 '⏸ 构筑'
 */
export function getPauseButtonText(isPaused: boolean): string {
  return isPaused ? '▶ 构筑' : '⏸ 构筑';
}
