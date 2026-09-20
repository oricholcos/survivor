// src/core/behaviors/behavior_piercingBolt.ts —— 轨道贯穿炮：直线穿透射线（hitscan）。

import { dealDamage } from '../effects';
import { distSq, normalize } from '../math';
import { findTarget } from '../targeting';
import type { Enemy, SimState, Vec } from '../types';
import type { WeaponBehavior } from './registry';
import type { WeaponStats } from '../weapons';

/** 射线半宽（px）：线上判定阈值 = 半宽 + enemy.radius。 */
const BEAM_HALF_WIDTH = 5;

/** VFX 单条线段（视图层消费的几何快照）。 */
export interface RailSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** VFX meta 条目：本次开火的射线线段 + 留存截止时刻。 */
export interface RailVfx {
  segments: RailSegment[];
  untilMs: number;
}

const VFX_KEY_PREFIX = 'rail_vfx:';
const VFX_TTL_MS = 100;

function opt(stats: WeaponStats | Record<string, number>, key: string): number {
  const v = stats[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * 收集线段走廊上的存活敌人并按「沿线段投影距离」升序返回。
 */
function collectSegmentEnemies(
  state: SimState,
  ox: number,
  oy: number,
  dir: Vec,
  len: number,
): Array<{ e: Enemy; t: number }> {
  const candidates: Array<{ e: Enemy; t: number }> = [];
  const enemies = state.enemies;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.dead) {
      continue;
    }
    const rx = e.x - ox;
    const ry = e.y - oy;
    const t = rx * dir.x + ry * dir.y;
    if (t <= 0 || t > len) {
      continue;
    }
    const perp = Math.abs(rx * dir.y - ry * dir.x);
    if (perp > BEAM_HALF_WIDTH + e.radius) {
      continue;
    }
    candidates.push({ e, t });
  }
  candidates.sort((a, b) => a.t - b.t);
  return candidates;
}

export const behavior: WeaponBehavior = {
  name: 'piercing_bolt',

  fire(state, weaponId, stats, forcedTarget?) {
    // forcedTarget（灼热光束协同开火强制指定）：主射线指向它，三叉等分支照常。
    const target = forcedTarget ?? findTarget(state);
    if (!target) {
      const ws = state.weaponStates[weaponId];
      if (ws) {
        ws.cooldownMs = 0;
      }
      return;
    }

    const cx = state.character.x;
    const cy = state.character.y;
    const range = Math.hypot(state.layout.width, state.layout.height - state.layout.spawnLineY);

    const damagedIds: number[] = [];
    const segments: RailSegment[] = [];
    let refractLeft = Math.max(0, Math.round(opt(stats, 'refract')));

    const hitEnemy = (enemy: Enemy, amount: number): void => {
      if (enemy.dead) {
        return;
      }
      dealDamage(state, enemy, amount);
      if (damagedIds.indexOf(enemy.id) === -1) {
        damagedIds.push(enemy.id);
      }
    };

    const settleRay = (ox: number, oy: number, rayDir: Vec, len: number, baseDamage: number): { last: Enemy | null; endPoint: Vec } => {
      const candidates = collectSegmentEnemies(state, ox, oy, rayDir, len);
      let pierceLeft = Math.max(1, Math.floor(opt(stats, 'pierce')));
      let penetratedCount = 0;
      let last: Enemy | null = null;
      let endPoint: Vec = { x: ox + rayDir.x * len, y: oy + rayDir.y * len };

      const raySegIndex = segments.length;
      segments.push({ x1: ox, y1: oy, x2: endPoint.x, y2: endPoint.y });

      for (let i = 0; i < candidates.length; i++) {
        const item = candidates[i];
        const e = item.e;
        if (e.dead) {
          continue;
        }

        const amp = opt(stats, 'penetrateAmp');
        const damage = baseDamage * (1 + penetratedCount * amp);
        hitEnemy(e, damage);
        penetratedCount++;
        last = e;

        if (refractLeft > 0 && pierceLeft > 0) {
          let best: Enemy | null = null;
          let bestDistSq = Infinity;
          const enemies = state.enemies;
          for (let j = 0; j < enemies.length; j++) {
            const candidateEnemy = enemies[j];
            if (candidateEnemy.dead || damagedIds.indexOf(candidateEnemy.id) !== -1) {
              continue;
            }
            const d = distSq({ x: e.x, y: e.y }, candidateEnemy);
            if (d <= 300 * 300 && d < bestDistSq) {
              bestDistSq = d;
              best = candidateEnemy;
            }
          }

          if (best) {
            refractLeft -= 1;
            pierceLeft -= 1;
            const rDir = normalize({ x: best.x - e.x, y: best.y - e.y });
            if (rDir.x !== 0 || rDir.y !== 0) {
              settleRay(e.x, e.y, rDir, range, baseDamage);
            }
          } else {
            pierceLeft -= 1;
          }
        } else {
          pierceLeft -= 1;
        }

        if (pierceLeft <= 0) {
          endPoint = { x: e.x, y: e.y };
          segments[raySegIndex].x2 = endPoint.x;
          segments[raySegIndex].y2 = endPoint.y;
          break;
        }
      }

      return { last, endPoint };
    };

    const isTrident = opt(stats, 'trident') === 1;
    if (isTrident) {
      const others: Enemy[] = [];
      const enemies = state.enemies;
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        if (e.dead || e.id === target.id) {
          continue;
        }
        others.push(e);
      }
      others.sort((a, b) => distSq({ x: cx, y: cy }, a) - distSq({ x: cx, y: cy }, b));

      const targets = [target];
      if (others.length > 0) targets.push(others[0]);
      if (others.length > 1) targets.push(others[1]);

      if (targets.length === 1) {
        const dir = normalize({ x: target.x - cx, y: target.y - cy });
        if (dir.x !== 0 || dir.y !== 0) {
          const aggDamage = stats.damage * 1.6;
          settleRay(cx, cy, dir, range, aggDamage);
          settleRay(cx, cy, dir, range, aggDamage);
          settleRay(cx, cy, dir, range, aggDamage);
        } else {
          const ws = state.weaponStates[weaponId];
          if (ws) ws.cooldownMs = 0;
          return;
        }
      } else {
        for (let i = 0; i < targets.length; i++) {
          const t = targets[i];
          const dir = normalize({ x: t.x - cx, y: t.y - cy });
          if (dir.x !== 0 || dir.y !== 0) {
            settleRay(cx, cy, dir, range, stats.damage);
          }
        }
      }
    } else {
      const dir = normalize({ x: target.x - cx, y: target.y - cy });
      if (dir.x === 0 && dir.y === 0) {
        const ws = state.weaponStates[weaponId];
        if (ws) ws.cooldownMs = 0;
        return;
      }
      settleRay(cx, cy, dir, range, stats.damage);
    }

    const vfx: RailVfx = {
      segments,
      untilMs: state.timeMs + VFX_TTL_MS,
    };
    state.meta[VFX_KEY_PREFIX + weaponId] = vfx;
  },
};

