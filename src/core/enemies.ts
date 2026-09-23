// src/core/enemies.ts —— 敌人子系统：刷怪（spawnEnemy）、行军与墙前分离（updateEnemies）。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM（ESLint 强制）。
// 确定性契约：全程不使用 rng，遍历顺序固定（enemies 数组顺序），同输入必得同结果。
// 性能契约：分离计算走 SpatialHash 邻域查询（广域过滤），禁止 O(n²) 全量两两对比。

import { isStunned, speedMultiplier } from './effects';
import { pushEvent } from './events';
import { clamp } from './math';
import type { SpatialHash } from './spatialHash';
import type { Enemy, SimState } from './types';

/** 敌人类型数据（数据表 enemies.json 的一个条目；数值契约：正式数值全部来自 JSON）。 */
export interface EnemyTypeData {
  /** 敌人图鉴 id（typeId）。 */
  id: string;
  name: string;
  /** 渲染形状名（视图层用，模拟层不解释）。 */
  shape: string;
  /** 渲染色（视图层用，模拟层不解释）。 */
  color: number;
  hp: number;
  /** 移动速度 px/s。 */
  speed: number;
  /** 每次攻击对墙的伤害。 */
  damage: number;
  /** 攻击间隔 ms。 */
  attackIntervalMs: number;
  /** 击杀掉落经验值。 */
  xp: number;
  radius: number;
  isBoss: boolean;
  /** 击退位移倍率（缺省时回退 maxHp 公式）。 */
  knockbackFactor?: number;
}

/**
 * 在 (x, state.layout.spawnLineY) 刷入一个敌人并返回：
 * - 数值字段从 type 拷贝，hp = maxHp = type.hp；
 * - state='march'；attackCooldownMs = attackIntervalMs（首攻前先走完一个攻击间隔）；
 * - effects=[], dead=false；id 取 state.nextId++（自增）；
 * - pushEvent enemySpawned{typeId, isBoss}。
 */
export function spawnEnemy(state: SimState, type: EnemyTypeData, x: number): Enemy {
  const safeX = clamp(x, type.radius, state.layout.width - type.radius);
  const enemy: Enemy = {
    id: state.nextId++,
    typeId: type.id,
    name: type.name,
    x: safeX,
    y: state.layout.spawnLineY,
    radius: type.radius,
    hp: type.hp,
    maxHp: type.hp,
    speed: type.speed,
    damage: type.damage,
    attackIntervalMs: type.attackIntervalMs,
    attackCooldownMs: type.attackIntervalMs,
    state: 'march',
    isBoss: type.isBoss,
    xp: type.xp,
    color: type.color,
    shape: type.shape,
    effects: [],
    dead: false,
    knockbackFactor: type.knockbackFactor,
  };
  state.enemies.push(enemy);
  pushEvent(state, { kind: 'enemySpawned', typeId: enemy.typeId, isBoss: enemy.isBoss });
  return enemy;
}

/**
 * 推进一帧敌人行为（行军 + 墙前分离）。约定：
 * 1) grid.clear() 后把所有存活敌人按数组顺序 insert（含各自 radius），供本帧分离查询；
 *    重建安排在行军之后：网格坐标必须与分离阶段的实时坐标一致，否则行军位移会作为
 *    系统性偏差污染 queryCircle 的圆相交过滤（行军 offset 大时重叠对会被漏检）；
 * 2) 行军：state='march' 的敌人 y += speed*dtSec；当 y >= wallLineY → y = wallLineY
 *    且 state='attack'（此后 y 不再因行军变化）；
 * 3) 分离：对每个存活敌人以自身实时位置、查询半径取自身 radius 做 queryCircle，
 *    对返回的每个邻居：若 dist < rA + rB，沿两圆连线方向互推（各按重叠量的一半，
 *    分别作用于 x 和 y）；攻击态敌人 y 推移后钳制不超过 wallLineY（不许挤过墙），
 *    行军态不限制；两圆完全重合时连线方向无定义，按数组序确定性约定：前者沿 -x、
 *    后者沿 +x 各推重叠量一半；
 * 4) 同一帧内多对分离叠加允许；遍历顺序固定（enemies 数组顺序），全程不用 rng。
 * 模拟已结束（state.over !== null）时直接 return（与 wall.ts 同款防重入）。
 */
const scratchNeighbors: Enemy[] = [];

export function updateEnemies(state: SimState, dtMs: number, grid: SpatialHash<Enemy>): void {
  if (state.over !== null) {
    return;
  }

  const enemies = state.enemies;
  const wallLineY = state.layout.wallLineY;
  const dtSec = dtMs / 1000;

  // 1) 行军：仅 march 态前进；到墙线即转 attack 并钉在线上（此后 y 不再因行军变化）。
  //    效果槽消费：眩晕（stun）停行动——本帧不位移、不做到墙转攻击判定（攻击态的
  //    攻击冻结由 wall.ts 消费眩晕实现）；减速（slow/chill）位移乘 speedMultiplier。
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.dead || e.state !== 'march') {
      continue;
    }
    if (isStunned(e)) {
      continue;
    }
    e.y += e.speed * dtSec * speedMultiplier(e);
    if (e.y >= wallLineY) {
      e.y = wallLineY;
      e.state = 'attack';
    }
  }

  // 2) 重建空间网格：本帧所有存活敌人按数组顺序 insert（含 radius，供圆相交精确过滤）。
  //    此时网格坐标 = 分离阶段的实时坐标，queryCircle 过滤结果精确无偏差。
  grid.clear();
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e.dead) {
      grid.insert(e, e.x, e.y, e.radius);
    }
  }

  // 3) 分离：网格查询做广域过滤，b.id <= a.id 剪枝保证每对重叠怪只对称推挤一次
  for (let i = 0; i < enemies.length; i++) {
    const a = enemies[i];
    if (a.dead) {
      continue;
    }
    const neighbors = grid.queryCircle(a.x, a.y, a.radius, scratchNeighbors);
    for (let j = 0; j < neighbors.length; j++) {
      const b = neighbors[j];
      if (b.id <= a.id || b.dead) {
        continue;
      }
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const minDist = a.radius + b.radius;
      const distSq = dx * dx + dy * dy;
      if (distSq >= minDist * minDist) {
        continue; // 未重叠（恰好相切也不推）
      }
      const dist = Math.sqrt(distSq);
      const half = (minDist - dist) / 2;
      if (dist > 0) {
        // 沿两圆连线方向互推，各承担重叠量的一半，x/y 分量同时生效。
        const nx = dx / dist;
        const ny = dy / dist;
        a.x -= nx * half;
        a.y -= ny * half;
        b.x += nx * half;
        b.y += ny * half;
      } else {
        // 完全重合：连线无定义，按数组序确定性约定沿 x 轴对半推开。
        a.x -= half;
        b.x += half;
      }
      // x 坐标施加边界钳制：保证在左右边缘高密度怪群推挤时，绝不会被挤出屏幕边缘。
      a.x = clamp(a.x, a.radius, state.layout.width - a.radius);
      b.x = clamp(b.x, b.radius, state.layout.width - b.radius);
      // 攻击态不许被挤过墙；行军态不限制。
      if (a.state === 'attack' && a.y > wallLineY) {
        a.y = wallLineY;
      }
      if (b.state === 'attack' && b.y > wallLineY) {
        b.y = wallLineY;
      }
    }
  }

  // 4) 分离后重构空间网格：确保网格内记录的实体坐标为推挤后的最新物理位置
  grid.clear();
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e.dead) {
      grid.insert(e, e.x, e.y, e.radius);
    }
  }
}
