// src/core/wall.ts —— 城墙受击结算与失败判定。
// 攻击态敌人按各自实体字段（damage / attackIntervalMs / attackCooldownMs）对墙结算伤害；
// 墙血归零 → 恰好一次 gameOver 事件并置 over='defeat'（本函数入口防重入 + step 停摆双保险）。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM；数值全部来自敌人实体字段，无硬编码。

import { isStunned } from './effects';
import { pushEvent } from './events';
import type { SimState } from './types';

/**
 * 结算一帧的城墙受击。
 * 约定：
 * - 仅处理 state==='attack' 且未 dead 的敌人，按 state.enemies 数组顺序依次结算（确定性）；
 * - 每个敌人 attackCooldownMs -= dtMs，到点（<= 0）即攻击一次：wall.hp -= enemy.damage
 *   （下限 0），并 pushEvent wallDamaged{amount, hp}；随后 attackCooldownMs +=
 *   enemy.attackIntervalMs（用 += 保证长 dt 下的节奏正确：一帧内到点的多次攻击依序追补结算，
 *   即最多追补到本帧 dt 用尽为止）；
 * - wall.hp 归 0 → wall.hp=0、state.over='defeat'、pushEvent gameOver 恰好一次，
 *   并立即中止本帧后续结算（含同帧其余敌人）；
 * - state.over 已非 null（模拟已结束）时直接 return（防重入）。
 */
export function updateWallCombat(state: SimState, dtMs: number): void {
  // 模拟已结束：彻底不结算（step 侧停摆之外的自身防重入）。
  if (state.over !== null) {
    return;
  }

  const wall = state.wall;
  const enemies = state.enemies;

  // 数组顺序遍历：同帧到点的多个敌人依序结算。
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.dead || e.state !== 'attack') {
      continue;
    }
    // 效果槽消费：眩晕（stun）完全停行动——冷却冻结（不扣减），本帧不攻击。
    if (isStunned(e)) {
      continue;
    }

    e.attackCooldownMs -= dtMs;

    // 冷却到点攻击：循环追补（+= 间隔）。正常数据（间隔为正且有限）循环必然终止；
    // 脏数据（间隔非正 / 冷却被推成非有限）下冷却无法前进到正数，限制为每帧至多
    // 结算一次并跳出，防死循环。
    while (e.attackCooldownMs <= 0) {
      wall.hp = Math.max(0, wall.hp - e.damage);
      pushEvent(state, { kind: 'wallDamaged', amount: e.damage, hp: wall.hp });

      if (wall.hp <= 0) {
        // 墙破：恰好一次 gameOver，随后立即停止本帧一切后续结算。
        state.over = 'defeat';
        pushEvent(state, { kind: 'gameOver' });
        return;
      }

      e.attackCooldownMs += e.attackIntervalMs;

      if (
        e.attackCooldownMs <= 0 &&
        !(e.attackIntervalMs > 0 && Number.isFinite(e.attackCooldownMs))
      ) {
        break;
      }
    }
  }
}

/**
 * 治疗城墙（修复包拾取、Boss 技能等后续系统的统一入口）：
 * wall.hp = min(wall.maxHp, wall.hp + amount)，上限钳到 wall.maxHp。
 */
export function healWall(state: SimState, amount: number): void {
  state.wall.hp = Math.min(state.wall.maxHp, state.wall.hp + amount);
}
