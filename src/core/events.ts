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

/** 按入队顺序取出全部事件并清空队列（消费后再次调用返回空数组）。 */
export function drainEvents(state: SimState): GameEvent[] {
  const drained = state.events;
  state.events = [];
  return drained;
}
