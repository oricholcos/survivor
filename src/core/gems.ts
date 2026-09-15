// src/core/gems.ts —— 经验宝石与掉落物（修复包）：击杀掉落、飞行追踪、到达结算与升级信号。
// 击杀 → onEnemyKilled 掉落（必掉 1 颗经验宝石，按概率掉 1 个修复包）；
// updateGems 每帧把宝石朝角色、修复包朝墙线中点匀速推进，到达即结算：
// 宝石 → progress.xp += value（T5.3a：经验被动 xp_up 已随被动系统删除，经验曲线原样保留），
// 帧末统一升级检查（先扣后升、可连升）；
// 修复包 → wall.hp = min(wall.maxHp, wall.hp + value)。
// 随机契约：修复包概率判定走 state.rng.next()，禁 Math.random。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM。

import { pushEvent } from './events';
import { distSq } from './math';
import type { Drop, Enemy, Gem, SimState, Vec } from './types';

/**
 * 升到下一级所需经验：xpBase * xpGrowth^(level - 1)（level 从 1 起，1 级升 2 级需 xpBase）。
 */
export function xpToNext(state: SimState): number {
  return state.config.xpBase * Math.pow(state.config.xpGrowth, state.progress.level - 1);
}

/**
 * 击杀掉落结算（击杀方在敌人死亡时调用一次）：
 * - 必掉 1 颗经验宝石：value=enemy.xp、位置=敌人位置、speed=config.gemFlySpeed；
 * - 另按概率掉 1 个修复包：state.rng.next() < config.repairDropChance →
 *   Drop{kind:'repair', value=config.repairHeal, speed=config.dropFlySpeed}
 *   （repairDropChance=0 时 next()∈[0,1) 恒不小于 0，绝不掉落）。
 */
export function onEnemyKilled(state: SimState, enemy: Enemy): void {
  const gem: Gem = {
    id: state.nextId++,
    x: enemy.x,
    y: enemy.y,
    value: enemy.xp,
    speed: state.config.gemFlySpeed,
    dead: false,
  };
  state.gems.push(gem);

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
 * 推进一帧宝石 / 掉落物（约定：
 * 1) 宝石朝 state.character 匀速飞行，到达 → 标记 dead、移出数组、progress.xp += value；
 * 2) 修复包朝 (layout.width/2, layout.wallLineY) 匀速飞行，到达 → 移出数组，
 *    wall.hp = min(wall.maxHp, wall.hp + value)；
 * 3) 帧末升级检查：xp >= xpToNext → 先扣后升（xp -= 需求，level+1）、pushEvent
 *    levelUp{level}——单帧到账的大额经验可连升多级，事件按升级顺序逐级入队；
 * 4) 数组清理用交换删除（O(1)，被换入者当帧继续处理，同帧多颗宝石可依序到账）；
 * 5) state.over 非 null（模拟已结束）时直接 return（与 enemies/wall/projectiles 同款防重入）。
 */
export function updateGems(state: SimState, dtMs: number): void {
  if (state.over !== null) {
    return;
  }

  const dtSec = dtMs / 1000;

  // 1) 宝石 → 角色：到达即吸收加经验。
  const gems = state.gems;
  for (let i = 0; i < gems.length; ) {
    const gem = gems[i];
    if (stepToward(gem, state.character, gem.speed * dtSec)) {
      gem.dead = true;
      // 经验到账（T5.3a：xp_up 被动已删除，value 原样累加；经验曲线 xpBase/xpGrowth 不变）。
      state.progress.xp += gem.value;
      // 交换删除：末元素换到当前位（当帧继续处理），数组尾弹出，O(1)。
      const last = gems.pop()!;
      if (i < gems.length) {
        gems[i] = last;
      }
    } else {
      i++;
    }
  }

  // 2) 修复包 → 墙线中点：到达即修复（上限钳到 wall.maxHp）。
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

  // 3) 升级检查：先扣后升、可连升多级；需求非正 / 非有限（脏数据）不推进，防死循环。
  const progress = state.progress;
  let need = xpToNext(state);
  while (need > 0 && Number.isFinite(need) && Number.isFinite(progress.xp) && progress.xp >= need) {
    progress.xp -= need;
    progress.level += 1;
    pushEvent(state, { kind: 'levelUp', level: progress.level });
    need = xpToNext(state);
  }
}
