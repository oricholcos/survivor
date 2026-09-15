// src/core/behaviors/behavior_chargeSniper.ts —— 蓄能狙击：长蓄力周期（长间隔单发高伤）、
// 目标优先级制导的高速弹。目标优先级（fire 时锁定，T5.2a 升级为四级）：
//   ① isBoss（多个取最近）→ ② attack 怪（贴墙、正在打墙的高威胁层，取最近）→
//   ③ speed ≥ fastSpeedThreshold 的快速怪（取最近）→ ④ 最近敌人；
// ② 层为用户反馈修复：贴墙怪正在对墙造成真实伤害，必须被常规覆盖，不得被快速怪优先级
// 饿死（旧三级 boss>fast>最近 会让场上任何快速行军怪压过贴墙 tank）。
// 移动预测（T5.2a）：击发瞬间对锁定目标 leadAim 解提前量（1600px/s 弹 vs 行军怪），
// 主目标必中；弹飞出后直线推进、无二次瞄准。
// 无存活敌人不开火，且该武器 cooldownMs 归 0（解释器随后 += interval 推进节奏，下帧重试）。
//
// T5.3b 弹道机制接线（牌 → 行为）：
// - 多射（multi_shot 通用牌 → stats.projectileCount +1/张）：每波发射 N 枚，对主目标
//   leadAim 方向做小角度扇形错开（均匀参数 t ∈ [-1,1]；扇角为本行为锁定的几何常量——
//   狙击 json 无扇角键，数值类参数才必须来自数据表）。整波共享同一伤害快照与效果模板
//   （同一开火瞬间结算，爆头判定对整波一致）。
// - 连射（burst_shot 通用牌 → stats.burstWaves 跟发波数 + stats.burstIntervalMs 波间隔）：
//   首波即时发射，跟发波经 core/cards 的 scheduleBurstWaves 入 meta 待发队列，由 update 钩子
//   consumeDueBurstWaves 到点重放 fireVolley——「重放时重新执行 fire 的目标选择与散射逻辑」
//   （锁定语义：重新四级选目标 + 重新解提前量，快照 stats 结算；无目标波静默跳过）。
// - 分裂（split_shot 通用牌 → stats.splitCount≥1 + splitDamageFactor/splitMaxTargets）：
//   主弹【首次命中】后在命中点分裂至多 splitMaxTargets 枚次级弹：leadAim 移动预测锁定
//   「最近且互不相同」（pickNearestDistinctEnemies）的存活敌人、与主弹同弹种（同弹速/半径/
//   效果模板 mark·slow 随行）、伤害 = 主弹伤害 × splitDamageFactor、锁定单一目标不再穿透、
//   不再分裂（splitDone 旗标）、不经 fire 路径（不吃多射/连射）。每弹至多分裂一次。
// - 暴击死分支清理（T5.3b）：crit 开关与 rng 判定路径已删除——charge_sniper.json 无 crit
//   字段、牌池无暴击牌，行为全程零随机（同种子可复现）。
// 乘区语义（锁定，测试对齐）：proj.damage = stats.damage × headshotMult(触发时)。
//   - headshot（斩首牌 headshot=1）：开火瞬间目标 hp ≥ headshotHpFactor × maxHp
//     （高血目标）→ ×headshotMultiplier；残血目标不增伤；处决强化牌（execute_up）对
//     headshotMultiplier +0.25/张（可重复）。
// 效果槽：effectsOnHit 恒带 mark 模板（命中可标记，标记在伤害结算之后附着——首发不享受加成）；
// slowHit=1（命中减速牌）追加 slow 模板（命中减速）。
// 贯穿：pierceShot=1（贯穿弹牌）→ pierceLeft = stats.pierce（直线贯穿多个；贯穿弹牌同时
// 给 stats.pierce +2/张，可重复）；否则 0（单发即亡）。
// 数值契约：全部数值来自 weapons/charge_sniper.json；几何量（弹丸半径、多射扇角）允许硬编码。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM。

import { scheduleBurstWaves, consumeDueBurstWaves } from '../cards';
import { normalize } from '../math';
import { pickNearestDistinctEnemies, spawnProjectile } from '../projectiles';
import { findTarget, leadAim } from '../targeting';
import type { EffectInstance, Enemy, SimState } from '../types';
import type { WeaponBehavior } from './registry';
import type { WeaponStats } from '../weapons';

/** 弹丸半径（px）：几何常量允许硬编码，数值类一律来自数据表。 */
const SNIPER_RADIUS = 6;

/** 多射扇形全角（度）：主弹 leadAim 方向 ±半角的确定性小角度扇形（行为锁定的几何常量）。 */
const MULTI_VOLLEY_SPREAD_DEG = 8;

/** mark 效果模板（可标记）：untilMs/stacks 由效果引擎按当前时刻重算，模板值不参与结算。 */
const MARK_TEMPLATE: EffectInstance = { kind: 'mark', untilMs: 0, stacks: 1, data: {} };

/** slow 效果模板（命中减速牌）：参数取效果表定义值（speedFactor 0.5）。 */
const SLOW_TEMPLATE: EffectInstance = { kind: 'slow', untilMs: 0, stacks: 1, data: {} };

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
 * 主弹 data 快照：分裂所需数值随弹走（命中钩子拿不到 stats，从弹上读回；升级瞬间已飞行的
 * 旧弹按发射时数值结算）。splitReady=0（未拿分裂牌）时命中钩子直接短路。
 */
function projectileData(stats: WeaponStats): Record<string, number> {
  return {
    splitReady: opt(stats, 'splitCount') >= 1 ? 1 : 0,
    splitFactor: opt(stats, 'splitDamageFactor'),
    splitMax: opt(stats, 'splitMaxTargets'),
    speed: stats.projectileSpeed,
    ttlMs: stats.ttlMs,
    splitDone: 0,
  };
}

/**
 * 发射一波（完整 projectileCount 颗，多射/连射共用）：四级优先级锁定主目标 → leadAim
 * 提前量 → 从角色向预测点方向小角度扇形发射 N 枚。无存活目标 → 返回 false（fire 据此写
 * 冷却归 0；连射重放波静默跳过、不改冷却）。伤害/效果模板对整波一致（同一开火瞬间快照）。
 */
function fireVolley(state: SimState, _weaponId: string, stats: WeaponStats): boolean {
  const target = pickTarget(state, stats);
  if (!target) {
    return false;
  }

  // 伤害快照：乘区顺序 base → 爆头（高血判定）。（暴击路径已随 T5.3b 清理：行为零随机。）
  let damage = stats.damage;
  if (opt(stats, 'headshot') === 1 && target.hp >= opt(stats, 'headshotHpFactor') * target.maxHp) {
    damage *= opt(stats, 'headshotMultiplier');
  }

  // 效果模板：恒带 mark（可标记）；slowHit=1 追加 slow（命中减速）。
  const effectsOnHit: EffectInstance[] = [MARK_TEMPLATE];
  if (opt(stats, 'slowHit') === 1) {
    effectsOnHit.push(SLOW_TEMPLATE);
  }

  const aim = leadAim(state.character, target, stats.projectileSpeed, state.layout.wallLineY);
  const baseAng = Math.atan2(aim.y - state.character.y, aim.x - state.character.x);
  // 弹数约定（schema：charge_sniper.json base 不含 projectileCount 键——「无键 = 单体」）：
  // 多射牌以 add 从 0 起算累加（每张 +1），故完整弹数 = 1 + stats.projectileCount。
  // （scatter/homing 的 base 显式带键：弹数 = 键值本身，不经此公式。）
  const count = 1 + Math.max(0, Math.round(opt(stats, 'projectileCount')));
  const halfSpread = ((MULTI_VOLLEY_SPREAD_DEG / 2) * Math.PI) / 180;
  const data = projectileData(stats);
  const pierceLeft = opt(stats, 'pierceShot') === 1 ? stats.pierce : 0;

  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : (2 * i) / (count - 1) - 1; // [-1, 1] 均匀（奇数枚正中恰为主方向）
    const ang = baseAng + halfSpread * t;
    spawnProjectile(state, {
      behavior: 'charge_sniper',
      x: state.character.x,
      y: state.character.y,
      vx: Math.cos(ang) * stats.projectileSpeed,
      vy: Math.sin(ang) * stats.projectileSpeed,
      radius: SNIPER_RADIUS,
      damage,
      pierceLeft,
      bouncesLeft: 0,
      hitIds: [],
      ttlMs: stats.ttlMs,
      effectsOnHit,
      data,
    });
  }
  return true;
}

export const behavior: WeaponBehavior = {
  name: 'charge_sniper',

  /**
   * 蓄力完毕的击发（intervalMs 即蓄力周期，由解释器按冷却节奏调用）：发射一波
   * （见 fireVolley）；无目标 → 冷却归 0（重试标记）。首波发出后把连射跟发波入待发队列
   * （scheduleBurstWaves：burstWaves>0 才排波）。
   */
  fire(state, weaponId, stats) {
    if (!fireVolley(state, weaponId, stats)) {
      const ws = state.weaponStates[weaponId];
      if (ws) {
        ws.cooldownMs = 0; // 归 0：解释器随后 += interval 推进节奏，本帧内不重复触发
      }
      return;
    }
    scheduleBurstWaves(state, weaponId, 'charge_sniper', stats);
  },

  /**
   * 每帧钩子：消费连射待发波——到期波重放 fireVolley（重新四级选目标 + 重新解提前量，
   * 按开火时的 stats 快照结算；无目标波静默跳过）。
   */
  update(state, dtMs) {
    void dtMs; // 连射重放不随帧缩放：到期判定用 state.timeMs 绝对时间轴
    consumeDueBurstWaves<WeaponStats>(state, 'charge_sniper', (wid, st) => {
      fireVolley(state, wid, st);
    });
  },

  /**
   * 首次命中分裂（split_shot 牌，splitReady=1 且未分裂过）：在命中点分裂至多 splitMax 枚
   * 次级狙击弹——leadAim 移动预测各锁一个「最近且互不相同」的存活敌人、同弹种（弹速/半径/
   * mark·slow 模板随行）、伤害 = 主弹 × splitFactor、pierce 0（锁定单一目标）、splitReady=0
   * 封死再分裂、不经 fire 路径（不吃多射/连射）。此后主弹照常穿透/销毁（框架接管）。
   */
  onProjectileHit(state, proj, enemy) {
    const d = proj.data;
    if (dataNum(d, 'splitReady') !== 1 || dataNum(d, 'splitDone') === 1) {
      return; // 未拿分裂牌 / 已分裂过（每弹至多一次，贯穿弹的后续命中不再分裂）
    }
    const factor = dataNum(d, 'splitFactor');
    const maxTargets = dataNum(d, 'splitMax');
    const speed = dataNum(d, 'speed');
    const ttlMs = dataNum(d, 'ttlMs');
    // 目标选取排除刚被命中的敌人（次级弹从其圆内出生：再锁定它只会在原地空转），
    // 并把该 id 预置进次级弹 hitIds——框架去重让次级弹无伤穿越出生重叠圈后奔向各自目标。
    const targets = pickNearestDistinctEnemies(state, proj.x, proj.y, maxTargets, [enemy.id]);
    d.splitDone = 1; // 每弹至多分裂一次（抢先置位：次级弹与同帧后续命中都不再分裂）
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const aim = leadAim(proj, t, speed, state.layout.wallLineY);
      const dir = normalize({ x: aim.x - proj.x, y: aim.y - proj.y });
      spawnProjectile(state, {
        behavior: 'charge_sniper',
        x: proj.x,
        y: proj.y,
        vx: dir.x * speed,
        vy: dir.y * speed,
        radius: SNIPER_RADIUS,
        damage: proj.damage * factor,
        pierceLeft: 0, // 次级弹锁定单一目标：不再穿透
        bouncesLeft: 0,
        hitIds: [enemy.id], // 预置主弹命中目标：穿越出生重叠圈不重复结算
        ttlMs,
        effectsOnHit: proj.effectsOnHit, // 同弹种：mark/slow 模板随行（spawnProjectile 浅拷贝）
        data: { splitReady: 0, speed, ttlMs, splitDone: 1 },
      });
    }
  },
};
