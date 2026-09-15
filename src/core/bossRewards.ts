// src/core/bossRewards.ts —— Boss 击杀奖励：墙回复（maxHp × healPct）+ 额外一次三选一
// （pushEvent levelUp，UI 按该事件弹升级面板）。纯 TypeScript，禁止 import phaser 与 DOM。
// 数值契约：回复比例只存在于 enemies.json（仅 Boss 条目携带 bossHealPct），本文件零硬编码；
// 无随机（确定性：同输入必得同结果）。
// 接线说明：本文件只交付纯函数；正式生效由后续集成任务把 onBossDefeated 注册进
// projectiles.ts 的 killHooks（死亡结算时按注册顺序依次调用）：
//   killHooks.push((state, enemy) => {
//     const type = ENEMY_TYPES[enemy.typeId];
//     onBossDefeated(state, enemy, { healPct: readBossHealPct(type) });
//   });

import { pushEvent } from './events';
import type { EnemyTypeData } from './enemies';
import type { Enemy, SimState } from './types';
import { healWall } from './wall';

/**
 * Boss 击杀奖励规格（引导层 / 集成层按 enemies.json 组装后传入 onBossDefeated）。
 */
export interface BossRewardSpec {
  /** 击杀 Boss 后的墙回复比例（相对 wall.maxHp；回复量走 healWall，钳到 maxHp）。 */
  healPct: number;
}

/**
 * 读取敌人类型数据中的可选 Boss 字段 bossHealPct（击杀后墙回复比例）：有则取、无则 0。
 * EnemyTypeData 本身未声明该字段（普通怪条目不携带；类型契约文件不可改），
 * 用交叉类型读可选字段——enemies.json 仅 Boss 条目带 bossHealPct。
 */
export function readBossHealPct(type: EnemyTypeData & { bossHealPct?: number }): number {
  return type.bossHealPct ?? 0;
}

/**
 * Boss 击杀奖励结算（测试可直接调用；正式路径经 killHooks 在敌人死亡结算时触发）。约定：
 * - 仅 enemy.isBoss 生效：非 Boss 直接 return（不回血、不发事件、不占防重标记）；
 * - 恰好一次：state.meta.bossRewarded = Record<enemyId, true> 防重，同一敌人重复调用幂等
 *   （第二次起不再回血、不再发事件）；
 * - 生效时依次：
 *   1) healWall(state, wall.maxHp × spec.healPct)——统一治疗入口，上限钳到 wall.maxHp
 *      （healPct 再大回复也不越 maxHp）；
 *   2) pushEvent { kind: 'bossDefeated' }；
 *   3) pushEvent { kind: 'levelUp', level: state.progress.level }——额外一次三选一，
 *      UI 按 levelUp 事件弹升级面板（level 为结算时刻的当前等级）。
 */
export function onBossDefeated(state: SimState, enemy: Enemy, spec: BossRewardSpec): void {
  // 仅 Boss 生效：非 Boss 直接返回。
  if (!enemy.isBoss) {
    return;
  }

  // 恰好一次防重：meta.bossRewarded[enemy.id] 已置位 → 幂等返回。
  let rewarded = state.meta.bossRewarded as Record<number, true> | undefined;
  if (rewarded !== undefined && rewarded[enemy.id] === true) {
    return;
  }
  if (rewarded === undefined) {
    rewarded = {};
    state.meta.bossRewarded = rewarded;
  }
  rewarded[enemy.id] = true;

  // 墙回复 = maxHp × healPct（走 healWall：钳到 wall.maxHp，回复不越上限）。
  healWall(state, state.wall.maxHp * spec.healPct);

  // 事件顺序：bossDefeated（击杀反馈）→ levelUp（额外一次三选一）。
  pushEvent(state, { kind: 'bossDefeated' });
  pushEvent(state, { kind: 'levelUp', level: state.progress.level });
}
