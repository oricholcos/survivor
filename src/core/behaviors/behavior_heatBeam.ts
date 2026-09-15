// src/core/behaviors/behavior_heatBeam.ts —— 灼热光束：无弹丸的瞬时线段激光 + 过热槽。
// 每 tick 从角色朝最近存活敌人发射一条 beamRange 长的光束（过目标延伸到满射程），线段上
// （点到线段距离 ≤ beamWidth/2 + enemy.radius）所有存活敌人受 stats.damage——穿透不计数、
// 无上限。升级节点（宽幅/双束/灼烧/折射）全部以 JSON mods 数值开关表达（beamWidth/dualBeam/
// scorch/refraction），unlock 字符串仅供生成器展示，行为只读 stats 开关——M2 统一约定。
// 数值契约：伤害/射速/光束宽/射程/积热/散热/过热阈值全部来自 WeaponStats（weapons/heat_beam.json）；
// 任务锁定常量：折射偏角 30°、折射段长 = beamRange×0.5、灼烧逐实例覆盖每跳 2、VFX 留存 80ms。
//
// 语义（锁定）：
// - 无存活敌人：不开火（不积热、不写 VFX），cooldownMs 归 0（与 piercing_bolt 同款重试标记）；
// - dualBeam=1：对「第二近」敌人方向再发一条同样的光束（同宽同伤同射程，不折射）；目标不足
//   两条时只发主束；
// - scorch=1：每个被照到且未被本束击杀的敌人 applyEffect('burn', {damagePerTick: 2})
//   （逐实例覆盖效果表默认 3 的小值；致死一击不附着——尸体无意义，与燃烧云同款约定）；
//   dot 频率牌（dot_freq，requiresCard=scorch）把灼烧 tick 间隔 ÷ stats.dotTickMult
//   （cards 注入 = 1.3^张数，effect.data.tickMs 逐实例覆盖；mult<=1 不写键，避免把效果表
//   定义值钉死进实例 data）；
// - refraction 折射（refract_up 折射+1 牌，可叠层 maxCount=2）：主光束在终点处再折射一段
//   （长度 beamRange×0.5、方向 = 主方向旋转固定 +30°），同宽同伤同灼烧语义、独立完整判定
//   （同一点被两段都照到则各结算一次）；副束不折射。层数 = 折射+1 牌张数（getCardCount；
//   alt def 无牌时 stats.refraction=1 开关兜底为 1 层）——T5.3b 由「===1 开关」改为按层数
//   循环：每层从上一段终点再偏转 +30° 续射一段（链式）；
// - 过热槽：state.meta['heat_beam_heat:'+weaponId] = { heat, coolPerSec }（懒初始化）。
//   fire：heat += heatPerShot，heat ≥ overheatThreshold → 对 state.weaponStates[weaponId]
//   applyEffect('overheat')（开火间隔 ×1.6 由解释器经 overheatFactor 消费）并把 heat 归 0（泄能）；
//   update（散热钩子）：heat -= coolPerSec × dtSec，下限 0。coolPerSec 取最近一次 fire 时
//   的快照（update 钩子拿不到 stats，与弹上快照同款约定）。散热强化牌（cooling_up）给
//   stats.coolPerSec +6/张（add 乘区，解释入口同源）。当前仅 heat_beam 一把武器使用
//   本行为，update 每帧恰被调用一次、按前缀遍历恰好冷却本武器的热量。
// - VFX 约定（M4 视图消费，模拟层只写不读）：fire 时写
//   state.meta['heat_beam_vfx:'+weaponId] = { segments: [{x1,y1,x2,y2},...], untilMs: timeMs + 80 }，
//   段序 = [主束, 折射段×层数?, 副束?]。
// 随机契约：零随机（目标选择/折射方向全为确定性映射，任意种子可复现）。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM。

import { applyEffect, dealDamage, getEffectDef } from '../effects';
import { getCardCount } from '../cards';
import { distSq, normalize } from '../math';
import { SpatialHash } from '../spatialHash';
import type { Enemy, SimState } from '../types';
import type { WeaponBehavior } from './registry';

// 瞄准说明（T5.2a，不接 targeting.leadAim 的原因）：灼热光束是无弹丸的瞬时线段激光
// （hitscan）——光束从角色到目标零飞行时间，命中结算发生在开火同一帧，不存在「弹在途
// 期间目标继续移动」的问题，故无需移动预测。

/** VFX 单条线段（视图层消费的几何快照）。 */
export interface HeatBeamSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** VFX meta 条目：本次开火产生的全部光束线段 + 留存截止时刻（state.timeMs 时间轴）。 */
export interface HeatBeamVfx {
  segments: HeatBeamSegment[];
  untilMs: number;
}

/** 过热槽 meta 条目：heat 当前热量；coolPerSec 为最近一次 fire 的散热速率快照。 */
export interface HeatBeamHeatSlot {
  heat: number;
  coolPerSec: number;
}

/** meta 键前缀：过热槽与 VFX 均按 weaponId 分键（'heat_beam_heat:'+weaponId 等）。 */
const HEAT_KEY_PREFIX = 'heat_beam_heat:';
const VFX_KEY_PREFIX = 'heat_beam_vfx:';

/** 折射偏角（度）：主方向旋转的固定角度（任务锁定的确定性几何常量）。 */
const REFRACT_ANGLE_DEG = 30;

/** 折射段长度占主光束射程的比例（任务锁定）。 */
const REFRACT_LENGTH_FACTOR = 0.5;

/** 灼烧逐实例覆盖的燃烧每跳伤害（任务锁定的小值；效果表默认 3）。 */
const SCORCH_BURN_DPT = 2;

/** VFX 留存时长 ms：视图在 untilMs 前渲染光束（任务锁定，表现常量非平衡数值）。 */
const VFX_TTL_MS = 80;

/** 读可选数值键：stats 索引签名对缺失键运行时返回 undefined，显式兜底为 0。 */
function numOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 取（懒初始化）某武器的过热槽 meta 条目。 */
function getHeatSlot(state: SimState, weaponId: string): HeatBeamHeatSlot {
  const key = HEAT_KEY_PREFIX + weaponId;
  let slot = state.meta[key] as HeatBeamHeatSlot | undefined;
  if (!slot) {
    slot = { heat: 0, coolPerSec: 0 };
    state.meta[key] = slot;
  }
  return slot;
}

/** 点到线段距离平方（t 投影钳制在 [0,1]；零长线段退化为点到点距离）。 */
function pointSegDistSq(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) {
    t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const ex = px - (x1 + t * dx);
  const ey = py - (y1 + t * dy);
  return ex * ex + ey * ey;
}

// —— 模块级光束查询网格 ——
// fire 钩子拿不到 updateProjectiles 的网格参数，按框架约定自建/复用一个模块级 SpatialHash。
// 新鲜度戳 = (state, timeMs)：同一状态同一时刻只重建一次（惰性构建）。敌人在武器阶段静止
// （行军与效果位移都发生在更早的钩子），帧内构建的网格对全部光束判定精确有效；光束不位移
// 敌人，多次 fire 共用同帧网格安全。尸体由结算处 e.dead 过滤。
const beamGrid = new SpatialHash<Enemy>(64);
let beamGridState: SimState | null = null;
let beamGridTimeMs = NaN; // NaN !== 任何值：强制首帧重建
let beamGridMaxRadius = 0; // 存活敌人最大半径（粗筛查询半径用）

function ensureBeamGrid(state: SimState): SpatialHash<Enemy> {
  if (beamGridState !== state || beamGridTimeMs !== state.timeMs) {
    beamGrid.clear();
    let maxR = 0;
    const enemies = state.enemies;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.dead) {
        continue;
      }
      beamGrid.insert(e, e.x, e.y, e.radius);
      if (e.radius > maxR) {
        maxR = e.radius;
      }
    }
    beamGridMaxRadius = maxR;
    beamGridState = state;
    beamGridTimeMs = state.timeMs;
  }
  return beamGrid;
}

/**
 * 沿线段结算：所有「点到线段距离 ≤ halfWidth + enemy.radius」的存活敌人 dealDamage(damage)；
 * scorch 开启时对未被本束击杀者挂灼烧（逐实例覆盖小值每跳 2；dot 频率牌把 tick 间隔
 * ÷ stats.dotTickMult——scorchTickMs>0 时经 effect.data.tickMs 逐实例覆盖）。
 * 粗筛：以线段中点为圆心、半径 = 半长 + halfWidth + 最大敌人半径 的圆必包含整条碰撞胶囊
 * （胶囊内任一点到中点距离 ≤ 半长 + 半宽 + 敌人半径），网格一次查询无漏报；
 * 精确判定交给点到线段距离过滤（粗筛命中 ≠ 受伤）。
 */
function damageAlongSegment(
  state: SimState,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  halfWidth: number,
  damage: number,
  scorch: boolean,
  scorchTickMs: number,
): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const halfLen = Math.sqrt(dx * dx + dy * dy) / 2;
  const hits = ensureBeamGrid(state).queryCircle(
    (x1 + x2) / 2,
    (y1 + y2) / 2,
    halfLen + halfWidth + beamGridMaxRadius,
  );
  for (let i = 0; i < hits.length; i++) {
    const e = hits[i];
    if (e.dead) {
      continue; // 本帧已被其他束/弹击杀：跳过
    }
    const reach = halfWidth + e.radius;
    if (pointSegDistSq(e.x, e.y, x1, y1, x2, y2) > reach * reach) {
      continue; // 宽度外：粗筛命中但不受伤
    }
    dealDamage(state, e, damage);
    if (scorch && !e.dead) {
      applyEffect(
        state,
        e,
        'burn',
        scorchTickMs > 0 ? { damagePerTick: SCORCH_BURN_DPT, tickMs: scorchTickMs } : { damagePerTick: SCORCH_BURN_DPT },
      );
    }
  }
}

/**
 * 发射一条光束：从角色过 target 延伸到 range 满射程，结算线上敌人并写入 VFX 线段。
 * refractLayers = 折射层数（0 = 不折射）：在终点处再折射一段（+30° 固定偏角、长度
 * range×0.5），每层从上一段终点再偏转 +30° 续射一段（链式），同样结算。
 * 目标与角色重合（零向量无方向）：跳过该束（不产生线段、不结算）。
 */
function castBeam(
  state: SimState,
  target: Enemy,
  range: number,
  halfWidth: number,
  damage: number,
  scorch: boolean,
  scorchTickMs: number,
  segments: HeatBeamSegment[],
  refractLayers: number,
): void {
  const cx = state.character.x;
  const cy = state.character.y;
  const dir = normalize({ x: target.x - cx, y: target.y - cy });
  if (dir.x === 0 && dir.y === 0) {
    return; // 零向量无方向（normalize 契约兜底）：跳过该束
  }
  const ex = cx + dir.x * range;
  const ey = cy + dir.y * range;
  segments.push({ x1: cx, y1: cy, x2: ex, y2: ey });
  damageAlongSegment(state, cx, cy, ex, ey, halfWidth, damage, scorch, scorchTickMs);

  if (refractLayers <= 0) {
    return;
  }
  // 折射段：主方向旋转固定 +30°、长度 range×0.5，同宽同伤同灼烧、独立完整判定；
  // 可叠层：每层从上一段终点再偏转 +30° 续射一段（链式）。
  const rad = (REFRACT_ANGLE_DEG * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rLen = range * REFRACT_LENGTH_FACTOR;
  let rx = dir.x * cos - dir.y * sin;
  let ry = dir.x * sin + dir.y * cos;
  let ox = ex;
  let oy = ey;
  for (let l = 0; l < refractLayers; l++) {
    const fx = ox + rx * rLen;
    const fy = oy + ry * rLen;
    segments.push({ x1: ox, y1: oy, x2: fx, y2: fy });
    damageAlongSegment(state, ox, oy, fx, fy, halfWidth, damage, scorch, scorchTickMs);
    ox = fx;
    oy = fy;
    const nx = rx * cos - ry * sin;
    const ny = rx * sin + ry * cos;
    rx = nx;
    ry = ny;
  }
}

/** 距角色最近与次近的存活敌人（distSq 单趟扫描；平距取数组先出现者，确定性）。 */
function twoNearest(state: SimState): [Enemy | null, Enemy | null] {
  let best: Enemy | null = null;
  let bestDistSq = Infinity;
  let second: Enemy | null = null;
  let secondDistSq = Infinity;
  const enemies = state.enemies;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.dead) {
      continue;
    }
    const d = distSq(state.character, e);
    if (d < bestDistSq) {
      second = best;
      secondDistSq = bestDistSq;
      best = e;
      bestDistSq = d;
    } else if (d < secondDistSq) {
      second = e;
      secondDistSq = d;
    }
  }
  return [best, second];
}

export const behavior: WeaponBehavior = {
  name: 'heat_beam',

  /**
   * 每 tick 开火：选最近敌人定主束方向（过目标延伸到 beamRange），结算线上所有敌人；
   * dualBeam=1 且存在第二近敌人 → 对其方向再发一条同样的光束（不折射）。
   * 折射层数 = 折射+1 牌张数（getCardCount；alt def 无牌时 stats.refraction 开关兜底 1 层）。
   * 无存活敌人：不开火、冷却归 0（重试标记）。随后写入 VFX meta、积累过热（达阈值泄能）。
   */
  fire(state, weaponId, stats) {
    const [primary, secondTarget] = twoNearest(state);
    if (!primary) {
      const ws = state.weaponStates[weaponId];
      if (ws) {
        ws.cooldownMs = 0; // 归 0：解释器随后 += interval 推进节奏，本帧内不重复触发
      }
      return;
    }

    const halfWidth = numOr0(stats.beamWidth) / 2;
    const range = numOr0(stats.beamRange);
    const scorch = stats.scorch === 1;
    const refractLayers = Math.max(stats.refraction === 1 ? 1 : 0, getCardCount(state, weaponId, 'refract_up'));
    // dot 频率（dot_freq 牌，requiresCard=scorch）：灼烧 tick 间隔 ÷ stats.dotTickMult
    // （cards 注入 = 1.3^张数；mult<=1 不覆盖——避免把效果表定义值钉死进实例 data）。
    let scorchTickMs = 0;
    const mult = numOr0(stats.dotTickMult);
    if (scorch && mult > 1) {
      const baseTick = getEffectDef('burn').tickMs;
      if (typeof baseTick === 'number' && Number.isFinite(baseTick) && baseTick > 0) {
        scorchTickMs = baseTick / mult;
      }
    }
    const segments: HeatBeamSegment[] = [];

    castBeam(state, primary, range, halfWidth, stats.damage, scorch, scorchTickMs, segments, refractLayers);
    if (stats.dualBeam === 1 && secondTarget) {
      castBeam(state, secondTarget, range, halfWidth, stats.damage, scorch, scorchTickMs, segments, 0);
    }

    // VFX（M4 视图消费；只写 meta 不碰视图文件）。
    const vfx: HeatBeamVfx = { segments, untilMs: state.timeMs + VFX_TTL_MS };
    state.meta[VFX_KEY_PREFIX + weaponId] = vfx;

    // 过热槽：积热 → 达阈值泄能（overheat 挂武器效果槽，间隔 ×1.6 由解释器消费）。
    const slot = getHeatSlot(state, weaponId);
    slot.coolPerSec = numOr0(stats.coolPerSec); // update 钩子拿不到 stats：快照供散热读回
    slot.heat += numOr0(stats.heatPerShot);
    if (slot.heat >= numOr0(stats.overheatThreshold)) {
      slot.heat = 0; // 泄能
      const ws = state.weaponStates[weaponId];
      if (ws) {
        applyEffect(state, ws, 'overheat');
      }
    }
  },

  /**
   * 每帧散热：对本行为的全部过热槽 heat -= coolPerSec × dtSec，下限 0。
   * coolPerSec 读最近一次 fire 的快照（缺失/非法按 0 处理，即不散热）。
   */
  update(state, dtMs) {
    if (state.over !== null) {
      return;
    }
    const dtSec = dtMs / 1000;
    if (!Number.isFinite(dtSec) || dtSec <= 0) {
      return; // 非法/零 dt：不散热（也不会把 heat 推成负数）
    }
    for (const key in state.meta) {
      if (key.indexOf(HEAT_KEY_PREFIX) !== 0) {
        continue;
      }
      const slot = state.meta[key] as HeatBeamHeatSlot;
      if (typeof slot.heat !== 'number' || !Number.isFinite(slot.heat) || slot.heat <= 0) {
        continue;
      }
      const cool = numOr0(slot.coolPerSec);
      if (cool <= 0) {
        continue;
      }
      slot.heat = Math.max(0, slot.heat - cool * dtSec);
    }
  },
};
