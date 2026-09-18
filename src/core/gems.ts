// src/core/gems.ts —— 经验结算与掉落物（修复包）：击杀即时结算经验、修复包掉落与飞行追踪。
// 击杀 → onEnemyKilled 直接增加经验（progress.xp += enemy.xp）并立即 checkLevelUp，
// 按概率掉落修复包至 state.drops；
// updateGems 推进修复包朝墙线中点匀速飞行，到达即修复城墙；
// 帧末保留 checkLevelUp(state) 作为兜底升级检查。
// 随机契约：修复包概率判定走 state.rng.next()，禁 Math.random。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM。

import { pushEvent } from './events';
import { distSq } from './math';
import type { Drop, Enemy, SimState, Vec } from './types';

/**
 * 升到下一级所需经验：支持两段线性递增与软上限，同时保留旧指数回退。
 */
export function xpToNext(state: SimState): number {
  const cfg = state.config;
  const level = state.progress.level;
  if (cfg.xpGrowth !== undefined && cfg.xpTier1Step === undefined) {
    return cfg.xpBase * Math.pow(cfg.xpGrowth, level - 1);
  }
  const capLevel = cfg.xpCapLevel ?? 40;
  const capVal = cfg.xpCap ?? 280;
  if (level > capLevel) {
    return capVal;
  }
  const base = cfg.xpBase ?? 5;
  const step1 = cfg.xpTier1Step ?? 4;
  const step2 = cfg.xpTier2Step ?? 8;
  if (level <= 10) {
    return base + (level - 1) * step1;
  }
  const tier1Max = base + 9 * step1;
  return tier1Max + (level - 10) * step2;
}

/**
 * 通用升级检查函数：先扣后升、可连升多级；需求非正 / 非有限（脏数据）不推进，防死循环。
 */
export function checkLevelUp(state: SimState): void {
  const progress = state.progress;
  let need = xpToNext(state);
  while (need > 0 && Number.isFinite(need) && Number.isFinite(progress.xp) && progress.xp >= need) {
    progress.xp -= need;
    progress.level += 1;
    pushEvent(state, { kind: 'levelUp', level: progress.level });
    need = xpToNext(state);
  }
}

/**
 * 击杀掉落与经验结算（击杀方在敌人死亡时调用一次）：
 * - 直接结算经验：progress.xp += enemy.xp，随后立即调用 checkLevelUp；
 * - 另按概率掉 1 个修复包：state.rng.next() < config.repairDropChance →
 *   Drop{kind:'repair', value=config.repairHeal, speed=config.dropFlySpeed}
 *   （repairDropChance=0 时 next()∈[0,1) 恒不小于 0，绝不掉落）。
 */
export function onEnemyKilled(state: SimState, enemy: Enemy): void {
  // 直接结算经验
  state.progress.xp += enemy.xp;
  checkLevelUp(state);

  if (state.rng.next() < state.config.repairDropChance) {
    const drop: Drop = {
      id: state.nextId++,
      kind: 'repair',
      x: enemy.x,
      y: enemy.y,
      value: state.config.repairHeal,
      speed: state.config.dropFlySpeed,
      dead: false,
    };
    state.drops.push(drop);
  }
}

/**
 * 朝目标点匀速步进一步（步进不越过目标）：
 * 剩余距离平方 <= 步长平方（distSq 判到达）→ 吸附到目标点并返回 true（本步到达）；
 * 否则沿单位方向前进 stepLen 并返回 false。
 */
function stepToward(mover: Vec, target: Vec, stepLen: number): boolean {
  const d2 = distSq(mover, target);
  if (stepLen * stepLen >= d2) {
    mover.x = target.x;
    mover.y = target.y;
    return true;
  }
  const d = Math.sqrt(d2);
  mover.x += ((target.x - mover.x) / d) * stepLen;
  mover.y += ((target.y - mover.y) / d) * stepLen;
  return false;
}

/**
 * 推进一帧掉落物（约定：
 * 1) 修复包朝 (layout.width/2, layout.wallLineY) 匀速飞行，到达 → 移出数组，
 *    wall.hp = min(wall.maxHp, wall.hp + value)；
 * 2) 帧末调用 checkLevelUp(state) 作为兜底升级检查；
 * 3) 数组清理用交换删除（O(1)，被换入者当帧继续处理）；
 * 4) state.over 非 null（模拟已结束）时直接 return。
 */
export function updateGems(state: SimState, dtMs: number): void {
  if (state.over !== null) {
    return;
  }

  const dtSec = dtMs / 1000;

  // 修复包 → 墙线中点：到达即修复（上限钳到 wall.maxHp）。
  const drops = state.drops;
  if (drops.length > 0) {
    const target: Vec = { x: state.layout.width / 2, y: state.layout.wallLineY };
    for (let i = 0; i < drops.length; ) {
      const drop = drops[i];
      if (stepToward(drop, target, drop.speed * dtSec)) {
        drop.dead = true;
        state.wall.hp = Math.min(state.wall.maxHp, state.wall.hp + drop.value);
        const last = drops.pop()!;
        if (i < drops.length) {
          drops[i] = last;
        }
      } else {
        i++;
      }
    }
  }

  // 帧末兜底升级检查
  checkLevelUp(state);
}
