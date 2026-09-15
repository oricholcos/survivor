// src/core/dt.ts —— 帧间隔钳制
// 毫秒 dt 输入：非有限值（NaN / ±Infinity）按 0 处理；负值按 0 处理；
// 超过上限 50ms 钳到 50ms（防止切后台 / 长卡顿后模拟时间爆炸）。
// 纯 TypeScript，禁止 import phaser / DOM。

/** dt 钳制上限（毫秒）。 */
export const MAX_DT_MS = 50;

/**
 * 钳制毫秒 dt：返回值恒在 [0, 50]。
 * - NaN / Infinity / -Infinity → 0
 * - 负值（含 -0）→ 0
 * - 超过 50ms → 50（恰好 50 原样保留）
 */
export function clampDt(rawMs: number): number {
  if (!Number.isFinite(rawMs)) {
    return 0;
  }
  if (rawMs <= 0) {
    return 0;
  }
  return rawMs > MAX_DT_MS ? MAX_DT_MS : rawMs;
}
