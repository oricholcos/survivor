// src/core/behaviors/behavior_dragonBreath.ts —— 龙息锥：无弹丸、锥形范围的即时持续灼烧。
// 每 tick 从角色朝正上（-y）喷一个锥形（顶点在角色、半角 coneAngleDeg/2、射程 coneRange），
// 锥内所有存活敌人逐个结算：直击伤害 + 基础灼烧附着 + 各升级节点特效。持续喷射节奏由
// 解释器按 intervalMs 反复调 fire 维持（intervalMs 很小 → 快速 tick 模拟锥形持续伤害）。
// 升级节点（粘油/爆燃/酸池/推退）全部以 JSON mods 数值开关表达（stickyOil/blastIgnite/
// acidPool/pushBack = 1），unlock 字符串仅供生成器展示，行为只读 stats 开关——M2 统一约定。
// 数值契约：伤害/射速/锥角/射程/推力/酸池节奏与参数全部来自 WeaponStats
// （weapons/dragon_breath.json）；任务锁定常量：基础灼烧逐实例覆盖每跳 1、VFX 留存 80ms。
// 零随机（锥形判定/酸池落点全为确定性映射，任意种子可复现）。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM。
//
// 语义（锁定）：
// - 锥形判定按敌人圆心（不含 enemy.radius，与 scatter_shot 的龙息模式同款）：
//   距角色 d ≤ coneRange 且 与 -y 轴夹角 ≤ 半角（即 -dy/d ≥ cos(半角)）——恰在射程上
//   （d = coneRange）与恰在半角上（-dy/d = cos(半角)）都算锥内；与角色重合（d ≈ 0）
//   无方向、角色侧后方（-dy/d ≤ 0）自然被不等式拒绝；
// - 锥内无存活敌人：不开火（不结算、不附着、不写 VFX、不累计酸池计数），cooldownMs
//   归 0（与 heat_beam / piercing_bolt 同款重试标记，解释器随后 += interval 推进节奏）；
// - 基础灼烧（龙息本体语义）：每 tick 给锥内存活敌人 applyEffect('burn',
//   { damagePerTick: 1 })（小值逐实例覆盖效果表默认 3；重复施加 refresh=reset 不叠实例）；
//   致死一击不附着——尸体无意义（与弹丸命中/灼热光束同款约定）；
// - stickyOil=1（粘油）：命中（未被本 tick 击杀）的敌人 applyEffect('slow')
//   （效果表 speedFactor 0.5，与 burn 不同槽共存）；
// - blastIgnite=1（爆燃）：已在燃烧（hasEffect(enemy,'burn')，含此前 tick 的龙息灼烧与
//   其他来源）的敌人本武器直击伤害 ×2——先乘后经 dealDamage 统一入口结算（仍吃
//   corrode/mark 受伤乘区叠乘）；未燃烧的 ×1；
// - acidPool=1（酸池）：按 weaponId 的 meta 计数器每累计 acidPoolEveryTicks 个 fire tick
//   在锥形中点（角色正上方 coneRange/2）spawnZone：radius = coneRange ×
//   acidPoolRadiusFactor、durationMs = acidPoolDurationMs、tickMs = acidPoolTickMs、
//   damagePerTick = acidPoolDamage、effectKind 'corrode'（地面残留，首跳在 spawn 后一个
//   tickMs；到期由 zones 系统移除）。计数只在真实开火时累计，命中人数无关；
// - pushBack=1（推退）：命中（未被本 tick 击杀）的敌人沿「背向角色 = 径向外」单位向量
//   applyEffect('knockback', { dirX, dirY, force: pushForce })——小力连续推，每 tick 位移
//   pushForce px（即时效果不占效果槽，场地钳制由效果引擎负责）；
// - VFX 约定（M4 视图消费，模拟层只写不读）：fire 时写
//   state.meta['dragon_breath_vfx:'+weaponId] =
//     { untilMs: timeMs + 80, coneRange, coneAngleDeg }
//   （锥形顶点 = 角色当前位、朝向恒为正上，视图按角色位 + 这两个参数重建几何）。
//   酸池计数器 meta['dragon_breath_acid:'+weaponId] = { ticks } 同按 weaponId 分键。
//
// T5.3b dot 频率接线（dot_freq 通用牌，applyTo 含 dragon_breath 且无前置——龙息本体即
// 附着灼烧）：stats.dotTickMult = 1.3^张数（cards 注入）。消费点两处：
// - 本体灼烧：applyEffect('burn', {damagePerTick: 1, tickMs?})——burn 的 tick 间隔
//   ÷ dotTickMult（effect.data.tickMs 逐实例覆盖；mult<=1 不写键，避免把效果表定义值
//   钉死进实例 data——data 同名键一旦提供过即持久保留）；
// - 酸池 zone：spawnZone 的 tickMs ÷ dotTickMult（zone tick 本就是逐实例参数）。

import { applyEffect, dealDamage, getEffectDef, hasEffect } from '../effects';
import { normalize } from '../math';
import { spawnZone } from '../zones';
import type { Enemy, SimState } from '../types';
import type { WeaponBehavior } from './registry';

// 瞄准说明（T5.2a，不接 targeting.leadAim 的原因）：龙息锥是无弹丸的即时锥形判定
// （hitscan）——每 tick 直接对锥内敌人结算伤害，无飞行弹道、无「在途时间」，故无需
// 移动预测；锥形朝向恒为正上也不随目标转动。

/** VFX meta 条目：本 tick 锥形喷射的几何参数 + 留存截止时刻（state.timeMs 时间轴）。 */
export interface DragonBreathVfx {
  /** 留存截止时刻：视图在 untilMs 前渲染锥形。 */
  untilMs: number;
  /** 锥形射程（px）。 */
  coneRange: number;
  /** 锥形全角（度）：半角 = coneAngleDeg / 2。 */
  coneAngleDeg: number;
}

/** 酸池计数器 meta 条目：ticks = 自上次落区以来累计的真实开火 tick 数。 */
export interface DragonBreathAcidSlot {
  ticks: number;
}

/** meta 键前缀：VFX 与酸池计数均按 weaponId 分键（'dragon_breath_vfx:'+weaponId 等）。 */
const VFX_KEY_PREFIX = 'dragon_breath_vfx:';
const ACID_KEY_PREFIX = 'dragon_breath_acid:';

/** 基础灼烧逐实例覆盖的燃烧每跳伤害（任务锁定的小值；效果表默认 3）。 */
const BREATH_BURN_DPT = 1;

/** VFX 留存时长 ms：视图在 untilMs 前渲染锥形（任务锁定，表现常量非平衡数值）。 */
const VFX_TTL_MS = 80;

/** 与角色重合判定的距离下限：低于该值视为无方向（与 scatter_shot 龙息模式同款）。 */
const COINCIDENT_EPS = 1e-9;

/** 读可选数值键：stats 索引签名对缺失键运行时返回 undefined，显式兜底为 0。 */
function numOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 取（懒初始化）某武器的酸池计数器 meta 条目。 */
function getAcidSlot(state: SimState, weaponId: string): DragonBreathAcidSlot {
  const key = ACID_KEY_PREFIX + weaponId;
  let slot = state.meta[key] as DragonBreathAcidSlot | undefined;
  if (!slot) {
    slot = { ticks: 0 };
    state.meta[key] = slot;
  }
  return slot;
}

/**
 * 锥形判定（按敌人圆心）：与 -y 轴夹角 ≤ 半角（-dy/d ≥ cos(半角)，恰在半角上算在内）
 * 且 距角色 d ≤ range（恰在射程上算在内）。d ≈ 0 无方向跳过；侧后方 -dy/d ≤ 0 自然拒绝。
 */
function inCone(ex: number, ey: number, cx: number, cy: number, range: number, cosHalf: number): boolean {
  const dx = ex - cx;
  const dy = ey - cy;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d > range || d <= COINCIDENT_EPS) {
    return false; // 超射程 / 与角色重合无方向
  }
  return -dy / d >= cosHalf;
}

/** 收集锥内全部存活敌人（数组序单趟扫描，确定性；不含 enemy.radius 的圆心判定）。 */
function collectConeTargets(state: SimState, range: number, cosHalf: number): Enemy[] {
  const cx = state.character.x;
  const cy = state.character.y;
  const targets: Enemy[] = [];
  const enemies = state.enemies;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.dead) {
      continue;
    }
    if (inCone(e.x, e.y, cx, cy, range, cosHalf)) {
      targets.push(e);
    }
  }
  return targets;
}

export const behavior: WeaponBehavior = {
  name: 'dragon_breath',

  /**
   * 每 tick 喷射：锥内无存活敌人 → 不开火（冷却归 0 重试）；否则对锥内所有存活敌人
   * 逐个结算——爆燃 ×2 先乘后结算 → 粘油 slow → 基础灼烧 burn(每跳 1) → 推退 knockback
   * （后三者只附着给未被本 tick 击杀者）。随后 acidPool=1 按累计 tick 落腐蚀酸池、
   * 写 VFX meta。全程零随机。
   */
  fire(state, weaponId, stats) {
    const cx = state.character.x;
    const cy = state.character.y;
    const range = numOr0(stats.coneRange);
    const halfRad = (numOr0(stats.coneAngleDeg) * Math.PI) / 180 / 2;
    const targets = collectConeTargets(state, range, Math.cos(halfRad));

    if (targets.length === 0) {
      const ws = state.weaponStates[weaponId];
      if (ws) {
        ws.cooldownMs = 0; // 归 0：解释器随后 += interval 推进节奏，本帧内不重复触发
      }
      return;
    }

    const damage = numOr0(stats.damage);
    const blast = stats.blastIgnite === 1;
    const oil = stats.stickyOil === 1;
    const push = stats.pushBack === 1;
    const pushForce = numOr0(stats.pushForce);

    // dot 频率（dot_freq 牌）：本体灼烧与酸池的 tick 间隔 ÷ dotTickMult（cards 注入
    // = 1.3^张数；mult<=1 不覆盖 burn 的 tick——避免把效果表定义值钉死进实例 data）。
    const mult0 = numOr0(stats.dotTickMult);
    const mult = mult0 > 1 ? mult0 : 1;
    let burnTickMs = 0;
    if (mult > 1) {
      const baseTick = getEffectDef('burn').tickMs;
      if (typeof baseTick === 'number' && Number.isFinite(baseTick) && baseTick > 0) {
        burnTickMs = baseTick / mult;
      }
    }
    const burnData: Record<string, number> =
      burnTickMs > 0 ? { damagePerTick: BREATH_BURN_DPT, tickMs: burnTickMs } : { damagePerTick: BREATH_BURN_DPT };

    for (let i = 0; i < targets.length; i++) {
      const e = targets[i];
      // 爆燃：已在燃烧的敌人直击 ×2（先乘后经统一伤害入口结算，corrode/mark 乘区照常叠乘）。
      dealDamage(state, e, blast && hasEffect(e, 'burn') ? damage * 2 : damage);
      if (e.dead) {
        continue; // 致死一击不附着（尸体无意义，与弹丸命中同款约定）
      }
      // 粘油：命中挂 slow（效果表 speedFactor 0.5，与 burn 不同槽共存）。
      if (oil) {
        applyEffect(state, e, 'slow');
      }
      // 基础灼烧（龙息本体语义）：每 tick 附着，小值逐实例覆盖每跳 1（tick 间隔随 dot 频率牌）。
      applyEffect(state, e, 'burn', burnData);
      // 推退：沿「背向角色 = 径向外」单位向量小力连续推（即时效果，不占效果槽）。
      if (push && pushForce > 0) {
        const dir = normalize({ x: e.x - cx, y: e.y - cy });
        applyEffect(state, e, 'knockback', { dirX: dir.x, dirY: dir.y, force: pushForce });
      }
    }

    // 酸池：每累计 acidPoolEveryTicks 个真实开火 tick 在锥形中点落腐蚀地面区域（地面残留；
    // tick 间隔 ÷ dot 频率乘区）。
    if (stats.acidPool === 1) {
      const every = numOr0(stats.acidPoolEveryTicks);
      if (every > 0) {
        const slot = getAcidSlot(state, weaponId);
        slot.ticks += 1;
        if (slot.ticks >= every) {
          slot.ticks = 0;
          spawnZone(state, {
            x: cx,
            y: cy - range / 2, // 锥形中点（轴向半程）
            radius: range * numOr0(stats.acidPoolRadiusFactor),
            durationMs: numOr0(stats.acidPoolDurationMs),
            tickMs: numOr0(stats.acidPoolTickMs) / mult,
            damagePerTick: numOr0(stats.acidPoolDamage),
            effectKind: 'corrode',
          });
        }
      }
    }

    // VFX（M4 视图消费；只写 meta 不碰视图文件）。
    const vfx: DragonBreathVfx = {
      untilMs: state.timeMs + VFX_TTL_MS,
      coneRange: range,
      coneAngleDeg: numOr0(stats.coneAngleDeg),
    };
    state.meta[VFX_KEY_PREFIX + weaponId] = vfx;
  },
};
