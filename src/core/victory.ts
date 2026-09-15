// src/core/victory.ts —— 通关模式计时与胜利判定。
// campaign 模式撑满指定时长 → 恰好一次胜利（over='victory' + victory 事件）；
// endless 模式永不胜利（扛到死）。与失败判定先到先得：over 已非 null（含同帧墙破的
// defeat）一律直接 return，不覆盖、不重复发事件；step 侧的 over 停摆是第二重保险。
// 时长数值由调用方传入（campaignDurationSec=600 已在 waves.json，由集成层读取换算 ms），
// 本模块不读 JSON、不硬编码时长。纯 TypeScript，禁止 import phaser 与任何 DOM/BOM。

import { pushEvent } from './events';
import type { SimState } from './types';

/** 游戏模式：campaign 限时通关（timeMs 撑满 durationMs 即胜利）；endless 无尽（永不胜利）。 */
export type GameMode = 'campaign' | 'endless';

/**
 * 通关模式胜利判定（每帧调用：可由引导层包成 hook 注册进 state.hooks，或 step 后调用）。
 * 约定：
 * - state.over 已非 null（defeat 或已 victory）→ 直接 return：先到先得，恰好一次，
 *   victory 不覆盖 defeat；
 * - mode !== 'campaign'（endless）→ 永不胜利，直接 return；
 * - mode === 'campaign' 且 state.timeMs >= durationMs → state.over='victory'、
 *   pushEvent {kind:'victory'}（此后 step 因 over 非 null 停摆，不会再触发）。
 */
export function checkVictory(state: SimState, durationMs: number, mode: GameMode): void {
  // 模拟已结束（失败或已胜利）：直接 return，不覆盖、不重复发事件（先到先得 + 防重入）。
  if (state.over !== null) {
    return;
  }

  // 无尽模式：永不胜利，扛到死。
  if (mode !== 'campaign') {
    return;
  }

  if (state.timeMs >= durationMs) {
    state.over = 'victory';
    pushEvent(state, { kind: 'victory' });
  }
}
