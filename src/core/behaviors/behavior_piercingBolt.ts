// src/core/behaviors/behavior_piercingBolt.ts —— 轨道贯穿炮：直线穿透射线（hitscan）。
// T5.2b 用户反馈落地：「轨道炮应该做成射线，而不是所有武器都是子弹」——开火瞬间从角色沿
// 瞄准方向放出贯穿全场的光束，对线上敌人立即结算伤害；视觉上是一道闪现的射线而非飞行子弹
// （本行为不再产生任何弹丸，弹道渲染分支由视图层删除、改读 VFX meta）。
//
// 瞄准说明（T5.2b，不再接 targeting.leadAim 的原因）：射线无在途时间，开火同一帧即结算命中，
// 不存在「弹在途期间目标继续移动」的预测问题——方向直接取 findTarget 主目标的当前位置；
// 主目标到射线所在直线的垂距恒为 0（< 判定阈值），天然在受击候选列，无提前量误差。
//
// 贯穿语义（与旧弹丸穿透一致）：沿射线方向按「距线段起点的投影距离升序」收集线上敌人
// （点到射线所在直线的垂距 ≤ BEAM_HALF_WIDTH + enemy.radius，射线只向瞄准方向发射，
// 反向半轴不算），每条射线段最多命中 max(1, stats.pierce) 个——pierce=n 命中 n 个，与
// updateProjectiles 的 pierceLeft 递减语义同款（pierce<=0 保底命中 1 个，不出现空放）。
// 伤害统一走 dealDamage（效果引擎结算受伤乘区/扣血/击杀事件/killHooks，与弹丸命中路径等价）。
//
// T5.3b 轨道炮专属牌接线（全部由 weapons/rail_piercer.json cards 段驱动）：
// - 三叉分裂（trident_split → stats.trident + stats.tridentAngleDeg）：主射线外补
//   trident 对侧射线（+k×角 与 −k×角，k = 1..trident；trident=1 即经典三叉 ±10°），
//   各自独立结算、各穿 pierce 个（同一条走廊间的敌人可能被相邻射线各结算一次——
//   「各自独立结算」的既定语义）。
// - 折射+1（refract_up 可叠层 → stats.refract=层数 + refractAngleDeg/refractLengthFactor）：
//   主射线终点偏转 30° 续射「主射线 × refractLengthFactor」长度的一段，每层再从上一段终点
//   偏转续射（链式）；每段独立结算（各穿 pierce 个）。层数 = stats.refract。
// - 跳弹（ricochet → stats.ricochet + stats.ricochetRange）：主射线穿透链打完后，从最后
//   受击者向 ricochetRange 内「本轮未受击」的最近敌人弹射一次追加结算（全额伤害，射线段
//   直达并进入 VFX；只对该敌人结算一次，不沿段续算）。主射线无受击者则不跳弹。
// - 蓄力增伤（charge_damage → stats.chargeDamagePerStack + chargeDamageMaxStacks）：
//   连续命中同一目标叠层——meta 按 weaponId 分键 {targetId, stacks}，命中非当前目标即清零
//   重计；伤害在 dealDamage 前按当前层数放大（×(1 + perStack × 层数)，首发无加成、命中后
//   +1 层封顶 maxStacks——每层 +8% 至 +80%）。本武器全部射线（主/侧/折射/跳弹）共享同一槽。
// - dot 频率：本武器无 dot 附着牌（cards.json applyTo 未收录 rail_piercer），无接线——确认项。
//
// 无存活目标（或主目标与角色重合、无方向）：不开火，该武器 cooldownMs 归 0（任务书约定的
// 重试标记，解释器随后 += interval 推进节奏，本帧内不重复触发）。
//
// VFX 约定（M4 视图消费，模拟层只写不读）：fire 时写
//   state.meta['rail_vfx:'+weaponId] = { segments: [{x1,y1,x2,y2},...], untilMs: timeMs + 100 }
//   （段序 = [主射线, 侧射线×2N?, 折射段×N?, 跳弹段?]；视图按剩余留存时间线性淡出）。
//
// 数值契约：伤害/射速/穿透来自 WeaponStats（weapons/rail_piercer.json）；projectileSpeed/
// ttlMs 不再被本行为消费（hitscan 无弹道，字段保留兼容 WeaponStats 五项 schema）。
// 几何量（射线半宽、射线长度由 layout 对角推导）允许硬编码。
// 随机契约：零随机。纯 TypeScript，禁止 import phaser 与任何 DOM/BOM。

import { dealDamage } from '../effects';
import { normalize } from '../math';
import { findTarget } from '../targeting';
import type { Enemy, SimState, Vec } from '../types';
import type { WeaponBehavior } from './registry';
import type { WeaponStats } from '../weapons';

/** 射线半宽（px）：线上判定阈值 = 半宽 + enemy.radius（几何常量允许硬编码）。 */
const BEAM_HALF_WIDTH = 5;

/** VFX 单条线段（视图层消费的几何快照）。 */
export interface RailSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** VFX meta 条目：本次开火的射线线段 + 留存截止时刻（state.timeMs 时间轴）。 */
export interface RailVfx {
  segments: RailSegment[];
  untilMs: number;
}

/** 蓄力增伤槽 meta 条目：当前连续命中目标与层数（换目标清零）。 */
export interface RailChargeSlot {
  targetId: number;
  stacks: number;
}

/** meta 键前缀：VFX 与蓄力槽均按 weaponId 分键（'rail_vfx:'+weaponId 等）。 */
const VFX_KEY_PREFIX = 'rail_vfx:';
const CHARGE_KEY_PREFIX = 'rail_charge:';

/** VFX 留存时长 ms（任务锁定：100ms 闪现射线，视图线性淡出）。 */
const VFX_TTL_MS = 100;

/** 读 stats 可选数值键：索引签名对缺失键运行时返回 undefined，这里显式兜底为 0。 */
function opt(stats: WeaponStats | Record<string, number>, key: string): number {
  const v = stats[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 取（懒初始化）某武器的蓄力增伤槽 meta 条目。 */
function getChargeSlot(state: SimState, weaponId: string): RailChargeSlot {
  const key = CHARGE_KEY_PREFIX + weaponId;
  let slot = state.meta[key] as RailChargeSlot | undefined;
  if (!slot) {
    slot = { targetId: -1, stacks: 0 };
    state.meta[key] = slot;
  }
  return slot;
}

/** 方向向量旋转 +rad（逆时针数学约定，与 heat_beam 折射同款旋转矩阵；确定性）。 */
function rotateDir(dir: Vec, rad: number): Vec {
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: dir.x * cos - dir.y * sin, y: dir.x * sin + dir.y * cos };
}

/**
 * 收集线段走廊上的存活敌人并按「沿线段投影距离」升序返回（后续截断交给调用方）。
 * 判定：投影 t = (e-起点)·dir ∈ (0, len]（起点不算——上一段起点由上一段结算，主射线起点
 * 即角色侧后方自然排除）且垂距 |cross| ≤ BEAM_HALF_WIDTH + radius。
 * 等距平局保持数组序（sort 稳定），全程确定性。
 */
function collectSegmentEnemies(
  state: SimState,
  ox: number,
  oy: number,
  dir: Vec,
  len: number,
): Enemy[] {
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
      continue; // 起点侧后方 / 超出线段长度：不受击
    }
    const perp = Math.abs(rx * dir.y - ry * dir.x);
    if (perp > BEAM_HALF_WIDTH + e.radius) {
      continue; // 线外（含更近但不在走廊上的敌人）：不受击
    }
    candidates.push({ e, t });
  }
  candidates.sort((a, b) => a.t - b.t);
  return candidates.map((c) => c.e);
}

export const behavior: WeaponBehavior = {
  name: 'piercing_bolt',

  /**
   * 开火（hitscan）：findTarget 锁定主目标 → 方向 = 指向其当前位置（即时命中无在途，
   * 无需提前量）→ 从角色放出长度贯穿全场的主射线，对线上敌人按距角色投影升序逐个结算，
   * 最多 max(1, stats.pierce) 个（旧弹丸穿透语义）。随后按牌结出侧射线（三叉）、折射段
   * （可叠层链式续射）与跳弹段（穿透链末位追加结算），全部进入 VFX meta。
   */
  fire(state, weaponId, stats) {
    const target = findTarget(state);

    if (!target) {
      const ws = state.weaponStates[weaponId];
      if (ws) {
        ws.cooldownMs = 0; // 归 0：解释器随后 += interval 推进节奏，本帧内不重复触发
      }
      return;
    }

    const cx = state.character.x;
    const cy = state.character.y;
    const dir = normalize({ x: target.x - cx, y: target.y - cy });
    if (dir.x === 0 && dir.y === 0) {
      // 主目标与角色重合（normalize 契约兜底返回零向量）：无方向可射，按无目标重试。
      const ws = state.weaponStates[weaponId];
      if (ws) {
        ws.cooldownMs = 0;
      }
      return;
    }

    // 射线长度：布局「画布顶到出生线」全走廊对角线——从角色出发任意方向都覆盖全场敌人
    // （含尚在出生线 y=spawnLineY 的新刷怪），贯穿语义不设中途截断。
    const range = Math.hypot(state.layout.width, state.layout.height - state.layout.spawnLineY);

    // 蓄力增伤槽（charge_damage 牌）：本武器全部射线共享单槽（任何射线命中非当前目标即清零）。
    const perStack = opt(stats, 'chargeDamagePerStack');
    const maxStacks = Math.max(0, Math.round(opt(stats, 'chargeDamageMaxStacks')));
    const charge = perStack > 0 && maxStacks > 0 ? getChargeSlot(state, weaponId) : null;
    const damagedIds: number[] = []; // 本轮全部受击者 id（跳弹排除「未受击敌人」用）

    /** 统一命中入口：蓄力增伤放大（换目标清零 → 当前层数放大 → 命中后 +1 层封顶）。 */
    const hitEnemy = (enemy: Enemy, amount: number): void => {
      if (enemy.dead) {
        return; // 尸体不结算（同帧被其他射线击杀的重复候选）
      }
      if (charge) {
        if (charge.targetId !== enemy.id) {
          charge.targetId = enemy.id;
          charge.stacks = 0; // 换目标清零
        }
        dealDamage(state, enemy, amount * (1 + perStack * Math.min(charge.stacks, maxStacks)));
        charge.stacks = Math.min(charge.stacks + 1, maxStacks); // 命中后 +1 层（首发无加成）
      } else {
        dealDamage(state, enemy, amount);
      }
      if (damagedIds.indexOf(enemy.id) === -1) {
        damagedIds.push(enemy.id);
      }
    };

    /** 结算一条射线段：写 VFX 线段、走廊内按投影升序至多 max(1, pierce) 个受击；返回最后受击者。 */
    const settleRay = (ox: number, oy: number, rayDir: Vec, len: number): Enemy | null => {
      const ex = ox + rayDir.x * len;
      const ey = oy + rayDir.y * len;
      segments.push({ x1: ox, y1: oy, x2: ex, y2: ey });
      const online = collectSegmentEnemies(state, ox, oy, rayDir, len);
      const maxHits = Math.max(1, Math.floor(stats.pierce));
      const hitCount = Math.min(maxHits, online.length);
      let last: Enemy | null = null;
      for (let i = 0; i < hitCount; i++) {
        const e = online[i];
        hitEnemy(e, stats.damage);
        last = e; // 最后受击者 = 链上最后一个被结算的敌人（含被打死者）
      }
      return last;
    };

    const segments: RailSegment[] = [];

    // 主射线：贯穿全场。
    const mainLast = settleRay(cx, cy, dir, range);

    // 三叉分裂（trident_split 牌）：±k×tridentAngleDeg 侧射线，各自独立结算、各穿 pierce 个。
    const trident = Math.max(0, Math.round(opt(stats, 'trident')));
    const sideRad = (opt(stats, 'tridentAngleDeg') * Math.PI) / 180;
    for (let k = 1; k <= trident; k++) {
      settleRay(cx, cy, rotateDir(dir, sideRad * k), range);
      settleRay(cx, cy, rotateDir(dir, -sideRad * k), range);
    }

    // 折射+1（refract_up 可叠层）：主射线终点偏 30° 续射半程；每层再从上一段终点偏转续射
    // （链式）。每段独立结算（各穿 pierce 个）。
    const layers = Math.max(0, Math.round(opt(stats, 'refract')));
    if (layers > 0) {
      const rad = (opt(stats, 'refractAngleDeg') * Math.PI) / 180;
      const refractLen = range * opt(stats, 'refractLengthFactor');
      let ox = cx + dir.x * range;
      let oy = cy + dir.y * range;
      let rdir = rotateDir(dir, rad);
      for (let l = 0; l < layers; l++) {
        settleRay(ox, oy, rdir, refractLen);
        ox += rdir.x * refractLen;
        oy += rdir.y * refractLen;
        rdir = rotateDir(rdir, rad);
      }
    }

    // 跳弹（ricochet 牌）：主射线穿透链打完后，从最后受击者向 ricochetRange 内本轮未受击的
    // 最近敌人弹射一次追加结算（全额伤害；射线段直达、进入 VFX；只对该敌人结算一次）。
    const ricochet = Math.max(0, Math.round(opt(stats, 'ricochet')));
    if (ricochet >= 1 && mainLast) {
      const rangeSq = opt(stats, 'ricochetRange') * opt(stats, 'ricochetRange');
      let best: Enemy | null = null;
      let bestDistSq = Infinity;
      const enemies = state.enemies;
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        if (e.dead || damagedIds.indexOf(e.id) !== -1) {
          continue; // 尸体 / 本轮已受击者：不跳
        }
        const dx = e.x - mainLast.x;
        const dy = e.y - mainLast.y;
        const d = dx * dx + dy * dy;
        if (d > rangeSq) {
          continue; // 超出跳弹范围
        }
        if (d < bestDistSq) {
          bestDistSq = d;
          best = e;
        }
      }
      if (best) {
        segments.push({ x1: mainLast.x, y1: mainLast.y, x2: best.x, y2: best.y });
        hitEnemy(best, stats.damage);
      }
    }

    // VFX（M4 视图消费；只写 meta 不碰视图文件）。
    const vfx: RailVfx = {
      segments,
      untilMs: state.timeMs + VFX_TTL_MS,
    };
    state.meta[VFX_KEY_PREFIX + weaponId] = vfx;
  },
};
