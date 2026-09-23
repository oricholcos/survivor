// src/core/behaviors/behavior_chargeSniper.ts —— 蓄能狙击：长蓄力周期（长间隔单发高伤）、
// 目标优先级制导的高速弹。目标优先级（fire 时锁定）：
//   ① isBoss（多个取最近）→ ② attack 怪（贴墙、正在打墙的高威胁层，取最近）→
//   ③ speed ≥ fastSpeedThreshold 的快速怪（取最近）→ ④ 最近敌人；
// 移动预测：击发瞬间对锁定目标 leadAim 解提前量（1600px/s 弹 vs 行军怪），主目标
// 必中；弹飞出后直线推进、无二次瞄准。无存活敌人不开火，且该武器 cooldownMs 归 0
// （解释器随后 += interval 推进节奏，下帧重试）。
//
// 专属牌池重构：
// - 恒单发且禁用攻速：multi_shot/burst_shot/split_shot/spd_up/range_up 均不适用。
// - 专属牌保留：
//   - 斩首（headshot）：高血量（hp ≥ 60%）伤害 ×1.5（开火瞬间判定）。
//   - 死刑宣告（execution_order）：本武器任何一次击杀经验 ×1.25；残血（<20%/Boss 7%）立即处决。
//   - 处决强化（execute_up）：需死刑宣告，死刑宣告斩杀线 +5%（Boss +2%）/张（可叠 2~4 次）。
// - 重构/新增牌：
//   - 爆头（crit_shot）：可叠 5 层，每层 +20% 爆头率（至多 100% 必爆），伤害倍率恒为 550%。
//     掷点走第二独立随机流（simState.getBattleRng：种子 = 会话种子 XOR 0x9E3779B9 的固定
//     LCG），绝不消费 state.rng，同种子全程可复现。
//   - 让子弹飞（bullet_fly）：需爆头。命中时若触发爆头或成功击杀，子弹不销毁继续直线穿透；
//     未暴击且未击杀时击中即销毁。
//   - 狙神（sniper_god）：需让子弹飞。子弹每穿透 1 个敌人，对后续敌人的伤害递增 20%
//     （baseDamage × (1 + penetratedCount × 0.2)）。
//
// 效果槽：effectsOnHit 恒带 mark 模板（命中可标记，标记在伤害结算之后附着——首发不享受加成）。
// 表现反馈（G5）：爆头判中写金色星芒环 VFX + 'crit' 音效；处决写暗红斩线 VFX + 'execute' 音效。
// 数值契约：全部数值来自 weapons/charge_sniper.json；几何量（弹丸半径）允许硬编码。
// 随机契约：fire 全程零随机；唯一战斗期随机是爆头掷点（独立随机流）。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM。

import { checkLevelUp } from '../gems';
import { dealDamage, damageTakenFactor } from '../effects';
import { pushEvent } from '../events';
import { getBattleRng } from '../simState';
import { killHooks, spawnProjectile } from '../projectiles';
import { findTarget, leadAim } from '../targeting';
import type { EffectInstance, Enemy, SimState } from '../types';
import type { WeaponBehavior } from './registry';
import type { WeaponStats } from '../weapons';

/** 弹丸半径（px）：几何常量允许硬编码，数值类一律来自数据表。 */
const SNIPER_RADIUS = 6;

// —— 爆头 / 死刑宣告 meta VFX（优化轮 G5，视图消费约定见 fx.ts / mainScene.ts） ——

/** 爆头星芒环 VFX 共享 meta 键（值为 SniperHitVfx[] 滚动数组）。 */
export const SNIPER_CRIT_VFX_KEY = 'sniper_crit_vfx';

/** 死刑宣告斩杀 VFX 共享 meta 键（值为 SniperHitVfx[] 滚动数组）。 */
export const SNIPER_EXECUTE_VFX_KEY = 'sniper_execute_vfx';

/** 单条爆头/处决 VFX 条目：命中点坐标 + 留存截止时刻（state.timeMs 时间轴）。 */
export interface SniperHitVfx {
  x: number;
  y: number;
  untilMs: number;
}

/** 爆头 VFX 留存时长（ms）：金色星芒环 + 扩散环的生命周期，视图按剩余时间线性淡出。 */
export const SNIPER_CRIT_VFX_MS = 320;

/** 死刑宣告 VFX 留存时长（ms）：暗红竖贯斩线 + 能量迸散快速淡出。 */
export const SNIPER_EXECUTE_VFX_MS = 300;

/** 单键 VFX 列表长度上限（防刷屏：留存窗口内高频触发时丢弃最旧条目，数组按入队序排列）。 */
const SNIPER_HIT_VFX_CAP = 16;

/**
 * 写一条爆头/处决 VFX（照 PRISM_ZAP 模式）：先过滤过期条目（untilMs ≤ 当前时刻），
 * 再追加新条目；超上限从队首丢弃最旧。列表随 meta 存活（restart 重建 state 自然清零）。
 */
function pushSniperHitVfx(state: SimState, key: string, x: number, y: number, lifeMs: number): void {
  const prev = state.meta[key];
  const list: SniperHitVfx[] = Array.isArray(prev)
    ? (prev as SniperHitVfx[]).filter((v) => Number.isFinite(v?.untilMs) && v.untilMs > state.timeMs)
    : [];
  list.push({ x, y, untilMs: state.timeMs + lifeMs });
  while (list.length > SNIPER_HIT_VFX_CAP) {
    list.shift();
  }
  state.meta[key] = list;
}

/** mark 效果模板（可标记）：untilMs/stacks 由效果引擎按当前时刻重算，模板值不参与结算。 */
const MARK_TEMPLATE: EffectInstance = { kind: 'mark', untilMs: 0, stacks: 1, data: {} };

/** 读 stats 可选数值键：索引签名对缺失键运行时返回 undefined，这里显式兜底为 0。 */
function opt(stats: WeaponStats, key: string): number {
  const v = stats[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 读弹上 data 快照数值键（Record<string, number> 对缺失键返回 undefined）：显式兜底为 0。 */
function dataNum(d: Record<string, number>, key: string): number {
  const v = d[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * 目标优先级选择（findTarget 四级封装）：boss（最近）> attack 贴墙怪（最近）>
 * 快速怪（speed ≥ 阈值，最近）> 最近敌人。返回 null 表示无存活目标。
 */
function pickTarget(state: SimState, stats: WeaponStats): Enemy | null {
  return findTarget(state, {
    preferBoss: true,
    preferFast: true,
    fastSpeedThreshold: opt(stats, 'fastSpeedThreshold'),
  });
}

/**
 * 弹上 data 快照：爆头/死刑宣告/让子弹飞/狙神所需数值随弹走。
 */
function projectileData(stats: WeaponStats, baseDamage: number): Record<string, number> {
  return {
    baseDamage,
    penetratedCount: 0,
    bulletFly: opt(stats, 'bulletFly') === 1 ? 1 : 0,
    sniperGodAmp: opt(stats, 'penetrateAmp'),
    critReady: opt(stats, 'critShot') === 1 ? 1 : 0,
    critChance: opt(stats, 'critChance'),
    critMult: opt(stats, 'critMultiplier'),
    execReady: opt(stats, 'executionOrder') === 1 ? 1 : 0,
    execFactor: opt(stats, 'executionHpFactor'),
    execBossFactor: opt(stats, 'executionBossHpFactor'),
    execXpFactor: opt(stats, 'executionXpFactor'),
  };
}

/**
 * 带击杀经验放大的统一伤害结算（爆头致死/处决两条路径共用）：
 * amount 走 dealDamage 正常路径（正常死亡/事件/killHooks）；若目标因此次伤害死亡，
 * 临时 killHook 追加 enemy.xp × (xpBonusRatio)。
 */
function dealDamageWithKillXpBonus(
  state: SimState,
  enemy: Enemy,
  amount: number,
  xpFactor: number,
  sourceWeaponId?: string,
): void {
  const xpBonusRatio = xpFactor - 1;
  if (!(xpBonusRatio > 0)) {
    dealDamage(state, enemy, amount, sourceWeaponId);
    return;
  }
  const hook = (s: SimState, killed: Enemy): void => {
    if (killed !== enemy) {
      return;
    }
    s.progress.xp += killed.xp * xpBonusRatio;
    checkLevelUp(s);
  };
  killHooks.push(hook);
  try {
    dealDamage(state, enemy, amount, sourceWeaponId);
  } finally {
    const idx = killHooks.indexOf(hook);
    if (idx !== -1) {
      killHooks.splice(idx, 1);
    }
  }
}

/**
 * 处决击杀（死刑宣告命中点判定通过后调用）。
 */
function executeKill(state: SimState, enemy: Enemy, xpFactor: number, sourceWeaponId?: string): void {
  const factor = damageTakenFactor(enemy);
  const neededDamage = factor > 0 ? enemy.hp / factor : enemy.hp;
  dealDamageWithKillXpBonus(state, enemy, neededDamage, xpFactor, sourceWeaponId);
}

/**
 * 发射一发（恒单发）：四级优先级锁定目标 → leadAim 提前量 → 从角色向预测点方向发射。
 */
function fireVolley(state: SimState, weaponId: string, stats: WeaponStats, forcedTarget?: Enemy): boolean {
  const target = forcedTarget ?? pickTarget(state, stats);
  if (!target) {
    return false;
  }

  // 伤害快照：乘区顺序 base → 斩首（高血判定）。
  let damage = stats.damage;
  if (opt(stats, 'headshot') === 1 && target.hp >= opt(stats, 'headshotHpFactor') * target.maxHp) {
    damage *= opt(stats, 'headshotMultiplier');
  }

  const aim = leadAim(state.character, target, stats.projectileSpeed, state.layout.wallLineY);
  const ang = Math.atan2(aim.y - state.character.y, aim.x - state.character.x);

  spawnProjectile(state, {
    behavior: 'charge_sniper',
    weaponId,
    x: state.character.x,
    y: state.character.y,
    vx: Math.cos(ang) * stats.projectileSpeed,
    vy: Math.sin(ang) * stats.projectileSpeed,
    radius: SNIPER_RADIUS,
    damage,
    pierceLeft: 0,
    bouncesLeft: 0,
    hitIds: [],
    ttlMs: stats.ttlMs,
    effectsOnHit: [MARK_TEMPLATE], // 恒带 mark（可标记）
    data: projectileData(stats, damage),
  });
  return true;
}

export const behavior: WeaponBehavior = {
  name: 'charge_sniper',

  /**
   * 蓄力完毕的击发（intervalMs 即蓄力周期，由解释器按冷却节奏调用）。
   */
  fire(state, weaponId, stats, forcedTarget?) {
    if (!fireVolley(state, weaponId, stats, forcedTarget)) {
      const ws = state.weaponStates[weaponId];
      if (ws) {
        ws.cooldownMs = 0; // 归 0：解释器随后 += interval 推进节奏，本帧内不重复触发
      }
    }
  },

  /**
   * 命中点钩子（框架在 dealDamage + effectsOnHit 附着之后、穿透消耗之前调用）：
   * 1. 基础命中直接击杀：若目标已 dead，补加经验差额（死刑宣告）；
   * 2. 爆头判定：掷点判中造成弹伤 ×(倍率−1) 追加伤害，写星芒环 VFX + 'crit' 音效；
   * 3. 死刑宣告：若存活且 hp < 阈值，触发处决击杀，写斩线 VFX + 'execute' 音效；
   * 4. 穿透判定（让子弹飞 & 狙神）：
   *    - 若持有让子弹飞：当触发爆头或成功击杀目标时，置 pierceLeft = 2（使框架扣减后保持 1 存活），
   *      并若持有狙神则递增 penetratedCount 并按 baseDamage × (1 + n × amp) 提升弹伤；
   *    - 若既未爆头又未击杀：置 proj.dead = true 立即销毁。
   */
  onProjectileHit(state, proj, enemy) {
    const d = proj.data;
    let critTriggered = false;
    const initialDead = enemy.dead;

    // ① 爆头判定（只要持有爆头牌，不论是否已经被基础伤害致死，均执行爆头判定以提供满额视听反馈）
    if (dataNum(d, 'critReady') === 1) {
      const chance = dataNum(d, 'critChance');
      const mult = dataNum(d, 'critMult');
      if (chance > 0 && mult > 1 && getBattleRng(state).next() < chance) {
        critTriggered = true;
        pushSniperHitVfx(state, SNIPER_CRIT_VFX_KEY, enemy.x, enemy.y, SNIPER_CRIT_VFX_MS);
        pushEvent(state, { kind: 'sfx', name: 'crit' });

        if (!enemy.dead) {
          const factor = damageTakenFactor(enemy);
          const bonus = factor > 0 ? (proj.damage * (mult - 1)) / factor : proj.damage * (mult - 1);
          dealDamageWithKillXpBonus(state, enemy, bonus, dataNum(d, 'execXpFactor'), proj.weaponId);
        }
      }
    }

    // ② 基础命中直接击杀（且未在爆头追加伤害中重复结算）：补加经验差额
    if (initialDead && dataNum(d, 'execReady') === 1) {
      const xpFactor = dataNum(d, 'execXpFactor');
      if (xpFactor > 1) {
        state.progress.xp += enemy.xp * (xpFactor - 1);
        checkLevelUp(state);
      }
    }

    // ③ 死刑宣告处决（仅在目标依然存活时判定）
    if (!enemy.dead && dataNum(d, 'execReady') === 1) {
      const factor = enemy.isBoss ? dataNum(d, 'execBossFactor') : dataNum(d, 'execFactor');
      if (factor > 0 && enemy.hp < factor * enemy.maxHp) {
        pushSniperHitVfx(state, SNIPER_EXECUTE_VFX_KEY, enemy.x, enemy.y, SNIPER_EXECUTE_VFX_MS);
        pushEvent(state, { kind: 'sfx', name: 'execute' });
        executeKill(state, enemy, dataNum(d, 'execXpFactor'), proj.weaponId);
      }
    }

    // ③ 让子弹飞（bullet_fly）与狙神（sniper_god）穿透与增伤判定
    if (dataNum(d, 'bulletFly') === 1) {
      const canPenetrate = critTriggered || enemy.dead;
      if (canPenetrate) {
        // 赋予穿透：置为 2，projectiles.ts 随后 pierceLeft -= 1 使得余量为 1（存活）
        proj.pierceLeft = 2;

        // 狙神（穿透递增伤）
        const amp = dataNum(d, 'sniperGodAmp');
        if (amp > 0) {
          const nextCount = dataNum(d, 'penetratedCount') + 1;
          d.penetratedCount = nextCount;
          proj.damage = dataNum(d, 'baseDamage') * (1 + nextCount * amp);
        }
      } else {
        // 既未爆头又未击杀：子弹销毁
        proj.dead = true;
      }
    }
  },
};
