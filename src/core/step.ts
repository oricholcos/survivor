// src/core/step.ts —— 模拟推进骨架：按注册顺序执行 hooks，纯推进、无渲染副作用。
// 子系统（敌人 AI、武器、拾取等）通过 state.hooks 注册，在每帧 step 内被依次调用。
// 纯 TypeScript，禁止 import phaser / DOM。

import type { SimState } from './types';

/** 单帧 dt 钳制上限（ms）：防切后台 / 长卡顿后模拟时间爆炸。与 dt.ts 约定一致。 */
const MAX_DT_MS = 50;

/**
 * 推进一局模拟一个时间步。
 * 约定：dt = clamp(rawDtMs)（内联钳制）；rawDtMs 非有限（NaN/±Infinity）或负 → 按 0；
 * state.over !== null 时直接 return（模拟停摆，hooks 不再执行）；
 * 否则 timeMs += dt，按注册顺序执行 state.hooks 里的全部子系统，
 * 帧末原地清理 dead 敌人（尸体不残留，见 sweepDeadEnemies）。
 */
export function step(state: SimState, rawDtMs: number): void {
  // 模拟已结束：彻底停摆，不推进时间、不执行子系统。
  if (state.over !== null) {
    return;
  }

  // 内联钳制：非有限 / 负 → 0；超过 50ms → 50。
  let dt: number;
  if (!Number.isFinite(rawDtMs) || rawDtMs <= 0) {
    dt = 0;
  } else {
    dt = rawDtMs > MAX_DT_MS ? MAX_DT_MS : rawDtMs;
  }

  state.timeMs += dt;

  // 按注册顺序执行全部子系统钩子（dt=0 也照常执行：零长帧仍是有效一帧）。
  const hooks = state.hooks;
  for (let i = 0; i < hooks.length; i++) {
    hooks[i](state, dt);
  }

  sweepDeadEnemies(state);
}

/**
 * 帧末尸体清理：写指针单遍原地压缩 state.enemies，移除 dead 敌人（零分配）。
 * 等价性：清理保序；不消费 RNG；所有消费方均跳过 dead（武器索敌/弹丸扫掠/效果
 * tick/区域/墙战/波次预算与视图层渲染），击杀表现（爆裂粒子/音效）由 enemyKilled
 * 事件驱动——纯内存/迭代优化，不改变模拟语义与随机序列。
 * 不清理则死敌只在 enemies.ts 里被标记、永不移出数组，长对局尸体无限堆积：
 * core 各 hooks 与视图层每帧全量扫描 state.enemies，数千具尸体使每帧对同一数组
 * 白付十余次 O(n) 遍历（15 分钟极限生存局实测击杀量级 6000+）。
 */
function sweepDeadEnemies(state: SimState): void {
  const enemies = state.enemies;
  let write = 0;
  for (let read = 0; read < enemies.length; read++) {
    const e = enemies[read];
    if (!e.dead) {
      if (write !== read) {
        enemies[write] = e;
      }
      write++;
    }
  }
  if (write < enemies.length) {
    enemies.length = write;
  }
}
