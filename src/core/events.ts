// src/core/events.ts —— 游戏事件类型与事件队列 API。
// 模拟层唯一的对外副作用通道：step 内部不发声音、不改视图，只往 state.events 压事件；
// 引导层每帧 step 后 drainEvents 取走消费。纯 TypeScript，禁止 import phaser / DOM。

import type { SimState } from './types';

/** 一局模拟可能产生的全部事件。 */
export type GameEvent =
  | { kind: 'gameOver' }
  | { kind: 'victory' }
  | { kind: 'levelUp'; level: number }
  | { kind: 'enemyKilled'; enemyId: number; typeId: string; x: number; y: number; isBoss: boolean }
  | { kind: 'enemySpawned'; typeId: string; isBoss: boolean }
  | { kind: 'wallDamaged'; amount: number; hp: number }
  | { kind: 'bossDefeated' }
  | { kind: 'sfx'; name: string };

/** 向队尾压入一个事件（保持入队顺序）。 */
export function pushEvent(state: SimState, ev: GameEvent): void {
  state.events.push(ev);
}

// —— 高频 sfx 节流推送（T4）——

/**
 * 高频 sfx（hit/shoot）推送节流的最小间隔（模拟 ms）。
 * 这是音频/视图层关注点而非平衡数值：节流只影响 sfx 事件流密度（事件对象分配与
 * 逐个派发的量），不影响任何模拟结算（伤害、击杀、掉落、冷却等全部照常）。
 * 播放端 src/audio/audioThrottle.ts 仍有更细的合并（同名间隔 + 滑窗总量上限），
 * 两层不冲突：push 点粗滤 + 播放端细合并。
 */
export const SFX_PUSH_MIN_INTERVAL_MS = 30;

/** state.meta 中存放「sfx 名 → 上次推送的模拟时刻 ms」的键（restart 随 state 重建，无跨局泄漏）。 */
const SFX_THROTTLE_META_KEY = 'sfx_throttle_last_ms';

/**
 * 按名节流地推送一个 sfx 事件：
 * - 节流窗口基于模拟时间 state.timeMs（非墙钟），保确定性契约；
 * - 同名事件距上次推送不足 minIntervalMs 则直接丢弃（不分配事件对象，不进队列）；
 * - 每个 name 的首个事件恒通过；被丢弃的请求不推进间隔基准（与音频侧
 *   audioThrottle「放行时才写入」语义一致）；
 * - 节流状态存 state.meta[sfx_throttle_last_ms]（Record<name, lastTimeMs>），
 *   restart 重建 state 后自然归零。
 */
export function pushSfxThrottled(state: SimState, name: string, minIntervalMs: number): void {
  let lastMs = state.meta[SFX_THROTTLE_META_KEY] as Record<string, number> | undefined;
  if (lastMs === undefined) {
    lastMs = {};
    state.meta[SFX_THROTTLE_META_KEY] = lastMs;
  }
  const prev = lastMs[name];
  if (prev !== undefined && state.timeMs - prev < minIntervalMs) {
    return; // 节流窗口内：丢弃，不分配事件对象
  }
  lastMs[name] = state.timeMs;
  state.events.push({ kind: 'sfx', name });
}

/** 按入队顺序取出全部事件并清空队列（消费后再次调用返回空数组）。 */
export function drainEvents(state: SimState): GameEvent[] {
  const drained = state.events;
  state.events = [];
  return drained;
}
