// src/core/behaviors/behavior_prismChain.ts —— 弹射棱镜：命中后在附近敌人间弹跳、伤害递减。
// 升级节点（连锁闪电/冰毒附着/聚能折返/棱镜往复）全部以 JSON mods 数值开关表达（chainLightning/
// frostVenom/focusReturn/prismRecurse = 1），unlock 字符串仅供生成器展示，行为只读 stats 开关——M2 统一约定。
// 数值契约：伤害/射速/弹速/穿透/寿命/弹跳次数/弹跳范围/递减系数/闪电半径/闪电伤害全部来自
// WeaponStats（weapons/prism.json）；几何量（弹丸半径）与任务书锁定的折返弹固定语义常量
// （ttl 1500 / pierce 999 / 半径 16 / 每跳至多 zap 2 个）允许硬编码。
// 弹上快照约定：fire 时把本波数值/开关快照进弹 data，钩子从弹上读回（升级瞬间已飞行的
// 旧弹按发射时数值结算）；chainCount 单列一份（chainsLeft 会逐跳消耗）。
// 随机契约：零随机（目标选择/弹跳寻的/折返方向全为确定性映射，任意种子可复现）。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM。
//
// 弹跳链语义（锁定）：
// - 直击由框架统一结算（dealDamage(proj.damage) + applyEffectsOnHit + hitIds 去重）；本行为
//   在 onProjectileHit 里按固定顺序做四件事：
//   1) chainsLeft--（每次直击消耗一次弹跳次数）；
//   2) frostVenom=1 → 给幸存的被命中敌人 applyEffect('chill') + applyEffect('poison')
//      （致死一击不附着，与框架 effectsOnHit 同款约定：尸体无意义）；
//   3) chainLightning=1 → 以被命中敌人为圆心，zapRadius 内（圆相交语义，与框架命中判定
//      同款）、不在 proj.hitIds 的敌人按数组序至多 2 个 dealDamage(zapDamage)——zap 目标
//      与直击目标天然不重复（zap 目标不记入 hitIds，故之后仍可被续跳选中直击）；
//   4) 伤害递减：为下一跳重写 proj.damage = baseDamage × falloff^(已命中次数)
//      （已命中次数 = proj.hitIds.length，框架每次直击恰好 push 一个 id）。框架在钩子前
//      已按旧 damage 结算本次，故第 1 跳全额、第 2 跳 ×falloff、第 3 跳 ×falloff²。
// - 续跳：chainsLeft > 0 →
//   第一优先级：chainRange 内最近一个不在 hitIds 的存活敌人；
//   第二优先级（无第一优先级且 prismRecurse=1）：chainRange 内最近一个非刚命中目标自身的存活敌人；
//   无候选 → 弹跳链终结；有 → 速度大小不变、重设速度朝它。
// - 瞄准与预测的分工（T5.2a 锁定）：首跳（fire）对主目标 leadAim 加移动预测提前量（行军
//   怪必中）；弹跳跳转【不加预测】——朝目标当前位置直线飞（弹跳速度快、距离短，且这正是
//   与追踪武器的区分点：追踪弹逐帧转向制导，本弹一旦跳转就不再修正方向）。
// - 聚能折返：弹跳链终结（chainsLeft 用尽或寻的无候选）且 focusReturn=1 → 在死亡点 spawn
//   宽体贯穿光梭（竖直向下发射、速度同、ttl 1500、damage = baseDamage × (1 + 0.25 × N)、
//   pierce 999、radius 16、hitIds 清空——可贯穿扫过敌人、data.returning = 1）；否则弹亡。
// - 折返弹（data.returning=1）：命中只吃框架统一结算（新 hitIds 可再打已打过的敌人——
//   贯穿扫过人群的语义），到 ttl / pierce 用尽正常死亡，不再弹跳/闪电/附着/折返。
// - pierce 给大值（表 999）：弹寿命由 chainsLeft 控制，hitIds 防重复直击；框架穿透路径
//   兜底防永不销毁。
//
// T5.3b 弹道机制接线（牌 → 行为）：
// - 多射（multi_shot 通用牌 → stats.projectileCount +1/张）：一波发射 N 条链弹，采用
//   “主轴保底 + 侧翼交替展开”（单弹间距 6°，第 0 发锁定主目标方向），每条弹独立结算整条弹跳链。
// - 连射（burst_shot 通用牌 → stats.burstWaves 跟发波数 + stats.burstIntervalMs 波间隔）：
//   首波即时发射，跟发波经 core/cards 的 scheduleBurstWaves 入 meta 待发队列，由 update 钩子
//   consumeDueBurstWaves 到点重放 fireVolley——「重放时重新执行 fire 的目标选择与散射逻辑」
//   （锁定语义：重放重新 findTarget + 重新解提前量，快照 stats 结算；无目标波静默跳过）。
// - 分裂（split_shot 通用牌 → data.splitReady）：主弹【首次命中】后在命中点分裂至多
//   splitMaxTargets 枚次级棱镜弹：leadAim 移动预测锁定「最近且互不相同」
//   （pickNearestDistinctEnemies）的存活敌人、与主弹同弹种（同弹速/半径、冰毒附着与连锁
//   闪电随行）但为简化单体（chainsLeft=0：命中一次即亡，不弹跳/不回旋）、伤害 = 主弹伤害
//   × splitDamageFactor、不再分裂（splitDone 旗标）、不经 fire 路径（不吃多射/连射）。
// - dot 频率（dot_freq 通用牌，requiresCard=frost_venom）：冰毒附着的中毒 tick 间隔
//   ÷ stats.dotTickMult（cards 注入 = 1.3^张数）——fire 时把覆盖后的 tickMs 快照进弹上
//   poisonTickMs，命中钩子按快照逐实例覆盖（chill 无 tick，不涉及）；mult<=1 不写覆盖。

import { applyEffect, dealDamage, getEffectDef } from '../effects';
import { pushSfxThrottled, SFX_PUSH_MIN_INTERVAL_MS } from '../events';
import { scheduleBurstWaves, consumeDueBurstWaves } from '../cards';
import { distSq, normalize } from '../math';
import { pickNearestDistinctEnemies, spawnProjectile } from '../projectiles';
import { findTarget, leadAim } from '../targeting';
import type { Enemy, Projectile, SimState } from '../types';
import type { WeaponBehavior } from './registry';
import type { WeaponStats } from '../weapons';

/** 行为分支名（弹丸 behavior 字段与注册表键一致）。 */
const BEHAVIOR_NAME = 'prism_chain';

/** 连锁闪电 VFX 共享 meta 键（值为 PrismZapSegment[] 滚动数组）。 */
export const PRISM_ZAP_VFX_KEY = 'prism_zap_vfx';

/** 连锁闪电单段电弧：起点、终点、留存截止时刻。 */
export interface PrismZapSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  untilMs: number;
}

/** 弹丸半径（px）：几何常量允许硬编码，数值类一律来自数据表。 */
const PRISM_RADIUS = 6;

/** 多射单弹间距角（度）：主轴保底 + 侧翼交替展开步长（行为锁定的几何常量）。 */
const MULTI_VOLLEY_SPREAD_STEP_DEG = 6;

/** 聚能折返固定语义常量（任务书锁定）：ttl 1500ms、pierce 999、宽体半径 16。 */
const FOCUS_RETURN_TTL_MS = 1500;
const FOCUS_RETURN_PIERCE = 999;
const FOCUS_RETURN_RADIUS = 16;

/** 连锁闪电每跳至多 zap 的额外敌人数（任务书锁定）。 */
const ZAP_MAX_TARGETS = 2;

/** 读可选数值键（stats 索引签名与弹上 data 对缺失键都返回 undefined）：显式兜底为 0。 */
function numOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * dot 频率（dot_freq 通用牌）：冰毒附着的中毒 tick 间隔 ÷ stats.dotTickMult（cards 注入
 * = 1.3^张数）。fire 时把覆盖后的 tickMs 快照进弹（mult<=1 时为 0 = 不覆盖，避免把效果表
 * 定义值钉死进实例 data——data 同名键一旦提供过即持久保留）；命中钩子按快照逐实例覆盖。
 */
function poisonTickOverride(stats: WeaponStats): number {
  const mult = numOr0(stats.dotTickMult);
  if (!(mult > 1)) {
    return 0;
  }
  const baseTick = getEffectDef('poison').tickMs;
  if (typeof baseTick !== 'number' || !Number.isFinite(baseTick) || baseTick <= 0) {
    return 0;
  }
  return baseTick / mult;
}

/**
 * 连锁闪电：以刚被直击的敌人为圆心、zapRadius（圆相交语义：dist ≤ radius + e.radius）
 * 内、不在 proj.hitIds 的存活敌人，按数组序取前 zapMaxTargets 个 dealDamage(zapDamage)。
 */
function zapNearby(
  state: SimState,
  proj: Projectile,
  source: Enemy,
  zapRadius: number,
  zapDamage: number,
): void {
  let zapped = 0;
  const enemies = state.enemies;
  const prev = state.meta[PRISM_ZAP_VFX_KEY];
  const list: PrismZapSegment[] = Array.isArray(prev)
    ? (prev as PrismZapSegment[]).filter((seg) => Number.isFinite(seg?.untilMs) && seg.untilMs > state.timeMs)
    : [];

  for (let i = 0; i < enemies.length && zapped < ZAP_MAX_TARGETS; i++) {
    const e = enemies[i];
    if (e.dead || proj.hitIds.indexOf(e.id) !== -1) {
      continue;
    }
    const reach = zapRadius + e.radius;
    if (distSq(source, e) > reach * reach) {
      continue; // 闪电半径外
    }
    dealDamage(state, e, zapDamage);
    list.push({
      x1: source.x,
      y1: source.y,
      x2: e.x,
      y2: e.y,
      untilMs: state.timeMs + 100,
    });
    // zap 命中音效（T4.1）：高频 hit 事件按模拟时间粗滤（30ms 内同名只留首个），
    // 只影响 sfx 事件流密度、不影响 zap 伤害与 VFX 坐标记录。
    pushSfxThrottled(state, 'hit', SFX_PUSH_MIN_INTERVAL_MS);
    zapped += 1;
  }
  state.meta[PRISM_ZAP_VFX_KEY] = list;
}

/**
 * 续跳寻的：
 * - 第一优先级：在 chainRange 内寻找未曾命中（proj.hitIds.indexOf(e.id) === -1）的最近存活敌人。
 * - 第二优先级（当且仅当第一优先级无候选且 allowRecurse === true）：在 chainRange 内寻找非刚命中目标自身（e.id !== currentHitEnemyId）的最近存活敌人。
 * - 若两者均不存在，返回 null。
 */
export function nearestChainTarget(
  state: SimState,
  proj: Projectile,
  chainRange: number,
  currentHitEnemyId: number | string,
  allowRecurse: boolean,
): Enemy | null {
  const rangeSq = chainRange * chainRange;
  let best: Enemy | null = null;
  let bestDistSq = Infinity;
  const enemies = state.enemies;

  // 第一优先级：在 chainRange 内寻找未曾命中的最近存活敌人
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.dead || proj.hitIds.indexOf(e.id) !== -1) {
      continue;
    }
    const d = distSq(proj, e);
    if (d > rangeSq) {
      continue; // 超出弹跳范围
    }
    if (d < bestDistSq) {
      bestDistSq = d;
      best = e;
    }
  }
  if (best !== null) {
    return best;
  }

  // 第二优先级（当且仅当第一优先级无候选且 allowRecurse === true）：
  // 在 chainRange 内寻找非刚命中目标自身的最近存活敌人
  if (allowRecurse) {
    let recurseBest: Enemy | null = null;
    let recurseDistSq = Infinity;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.dead || String(e.id) === String(currentHitEnemyId)) {
        continue;
      }
      const d = distSq(proj, e);
      if (d > rangeSq) {
        continue;
      }
      if (d < recurseDistSq) {
        recurseDistSq = d;
        recurseBest = e;
      }
    }
    return recurseBest;
  }

  return null;
}

/**
 * 发射一波（完整 projectileCount 条链弹，多射/连射重放共用）：findTarget 锁定主目标 →
 * leadAim 提前量 → 从角色向预测点方向小角度扇形发射 N 条棱镜弹。无存活目标 → false。
 * 每枚弹 data 快照本波数值/开关（含分裂与 dot 频率覆盖参数；升级瞬间已飞行的旧弹按
 * 发射时数值结算）。forcedTarget（可选，灼热光束协同开火强制指定）：以它为首跳目标，
 * leadAim 照常、后续弹跳/分裂/折返等内部逻辑照常。
 */
function fireVolley(state: SimState, _weaponId: string, stats: WeaponStats, forcedTarget?: Enemy): boolean {
  const target = forcedTarget ?? findTarget(state);
  if (!target) {
    return false;
  }

  const aim = leadAim(state.character, target, stats.projectileSpeed, state.layout.wallLineY);
  const baseAng = Math.atan2(aim.y - state.character.y, aim.x - state.character.x);
  // 弹数约定（schema：prism.json base 不含 projectileCount 键——「无键 = 单体」）：
  // 多射牌以 add 从 0 起算累加（每张 +1），故链弹数 = 1 + stats.projectileCount。
  const count = 1 + Math.max(0, Math.round(numOr0(stats.projectileCount)));
  const stepRad = (MULTI_VOLLEY_SPREAD_STEP_DEG * Math.PI) / 180;
  const data: Record<string, number> = {
    chainsLeft: numOr0(stats.chainCount),
    chainCount: numOr0(stats.chainCount), // 初值单列：回旋弹伤害公式 baseDamage × falloff^chainCount 用
    baseDamage: numOr0(stats.damage),
    falloff: numOr0(stats.falloff),
    chainRange: numOr0(stats.chainRange),
    chainLightning: stats.chainLightning === 1 ? 1 : 0,
    zapRadius: numOr0(stats.zapRadius),
    zapDamage: numOr0(stats.zapDamage),
    focusReturn: stats.focusReturn === 1 ? 1 : 0,
    prismRecurse: stats.prismRecurse === 1 ? 1 : 0,
    frostVenom: stats.frostVenom === 1 ? 1 : 0,
    poisonTickMs: poisonTickOverride(stats),
    speed: numOr0(stats.projectileSpeed),
    ttlMs: numOr0(stats.ttlMs),
    splitReady: numOr0(stats.splitCount) >= 1 ? 1 : 0,
    splitFactor: numOr0(stats.splitDamageFactor),
    splitMax: numOr0(stats.splitMaxTargets),
    splitDone: 0,
    isSecondary: 0,
  };

  for (let i = 0; i < count; i++) {
    let ang = baseAng;
    if (i > 0) {
      const pair = Math.ceil(i / 2);
      const sign = i % 2 === 1 ? 1 : -1;
      ang = baseAng + sign * pair * stepRad;
    }
    spawnProjectile(state, {
      behavior: BEHAVIOR_NAME,
      x: state.character.x,
      y: state.character.y,
      vx: Math.cos(ang) * stats.projectileSpeed,
      vy: Math.sin(ang) * stats.projectileSpeed,
      radius: PRISM_RADIUS,
      damage: stats.damage,
      pierceLeft: stats.pierce, // 大值：弹跳链用 hitIds 防重复，寿命由 chainsLeft 控制
      bouncesLeft: 0,
      hitIds: [],
      ttlMs: stats.ttlMs,
      effectsOnHit: [],
      data,
    });
  }
  return true;
}

/**
 * 首次命中分裂（split_shot 牌，splitReady=1 且未分裂过）：在命中点分裂至多 splitMax 枚
 * 次级棱镜弹——leadAim 移动预测各锁一个「最近且互不相同」的存活敌人、同弹种（弹速/半径/
 * 冰毒附着/连锁闪电随行）但为简化单体（chainsLeft=0：命中一次即亡，不弹跳/不回旋）、
 * 伤害 = 主弹当前伤害 × splitFactor（首跳时 = baseDamage）、splitReady=0 封死再分裂、
 * 不经 fire 路径（不吃多射/连射）。
 */
function splitOnHit(state: SimState, proj: Projectile, hitEnemy: Enemy): void {
  const d = proj.data;
  if (numOr0(d.splitReady) !== 1 || numOr0(d.splitDone) === 1 || numOr0(d.isSecondary) === 1) {
    return; // 未拿分裂牌 / 已分裂过 / 次级弹（每弹至多一次）
  }
  d.splitDone = 1; // 抢先置位：次级弹与同帧后续命中都不再分裂
  const factor = numOr0(d.splitFactor);
  const speed = numOr0(d.speed);
  const ttlMs = numOr0(d.ttlMs);
  // 排除刚被命中的敌人 + 次级弹 hitIds 预置该 id：穿越出生重叠圈后奔向各自目标（见 projectiles 助手注释）。
  const targets = pickNearestDistinctEnemies(state, proj.x, proj.y, numOr0(d.splitMax), [hitEnemy.id]);
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const aim = leadAim(proj, t, speed, state.layout.wallLineY);
    const dir = normalize({ x: aim.x - proj.x, y: aim.y - proj.y });
    const damage = proj.damage * factor;
    spawnProjectile(state, {
      behavior: BEHAVIOR_NAME,
      x: proj.x,
      y: proj.y,
      vx: dir.x * speed,
      vy: dir.y * speed,
      radius: PRISM_RADIUS,
      damage,
      pierceLeft: 1, // 次级弹锁定单一目标：命中 1 个即亡（寿命由 chainsLeft=0 控制）
      bouncesLeft: 0,
      hitIds: [hitEnemy.id], // 预置主弹命中目标：穿越出生重叠圈不重复结算
      ttlMs,
      effectsOnHit: [],
      data: {
        ...d, // 同弹种：冰毒附着/连锁闪电/递减参数随行
        chainsLeft: 0, // 简化单体：命中一次即亡（不弹跳、不回旋）
        chainCount: 0,
        focusReturn: 0,
        prismRecurse: 0,
        baseDamage: damage, // 次级弹自己的伤害基准（递减重写公式用）
        speed,
        ttlMs,
        splitReady: 0, // 封死再分裂
        splitDone: 1,
        isSecondary: 1,
      },
    });
  }
}

export const behavior: WeaponBehavior = {
  name: BEHAVIOR_NAME,

  /**
   * 发射一波（完整 projectileCount 条链弹，多射/连射共用）：按统一优先级锁定主目标
   * （findTarget 无偏好：attack 贴墙高威胁层 > 最近），从角色位置向「leadAim 提前量预测点」
   * 方向小角度扇形发射 N 条棱镜弹（首跳加移动预测，行军主目标必中；多射为同目标错角，
   * 横向覆盖由弹跳链负责；弹跳跳转不加预测，见 onProjectileHit）。pierce 取表值 999
   * （寿命由弹上 chainsLeft 控制）；每枚弹 data 快照本波数值/开关。无存活目标：不发射并
   * 返回 false（fire 据此把该武器 cooldownMs 归 0——重试标记，与 piercing_bolt 同语义）。
   * forcedTarget 为协同开火强制指定目标（仅主波消费：连射跟发波重放走自身目标选择）。
   */
  fire(state, weaponId, stats, forcedTarget?) {
    if (!fireVolley(state, weaponId, stats, forcedTarget)) {
      const ws = state.weaponStates[weaponId];
      if (ws) {
        ws.cooldownMs = 0; // 归 0：解释器随后 += interval 推进节奏，本帧内不重复触发
      }
      return;
    }
    scheduleBurstWaves(state, weaponId, BEHAVIOR_NAME, stats);
  },

  /**
   * 每帧钩子：消费连射待发波——到期波重放 fireVolley（重新 findTarget + 完整一波链弹）。
   */
  update(state, dtMs) {
    void dtMs; // 连射重放不随帧缩放：到期判定用 state.timeMs 绝对时间轴
    consumeDueBurstWaves<WeaponStats>(state, BEHAVIOR_NAME, (wid, st) => {
      fireVolley(state, wid, st);
    });
  },

  /**
   * 弹跳链命中钩子（框架已按旧 proj.damage 结算完本次伤害 + effectsOnHit 附着）：
   * 顺序固定 = 分裂（首跳且拿牌）→ chainsLeft-- → frostVenom 附着（dot 频率覆盖 poison
   * tick）→ chainLightning 闪电 → 伤害递减重写 → 续跳寻的（重设速度朝新目标，速度大小
   * 不变）/ 次数用尽回旋或弹亡。
   */
  onProjectileHit(state, proj, enemy) {
    const d = proj.data;

    // 回旋弹（data.returning=1）：只吃框架统一结算（新 hitIds 可再打已打过的敌人——
    // 回旋扫过人群），不再弹跳/闪电/附着/回旋，到 ttl / pierce 用尽正常死亡。
    if (numOr0(d.returning) === 1) {
      return;
    }

    // 0) 首次命中分裂（split_shot 牌）：在命中点（主弹当前伤害仍为 baseDamage）分裂次级
    //    单体棱镜弹，主弹照常继续弹跳链。
    splitOnHit(state, proj, enemy);

    // 1) 弹跳次数：每次直击消耗一次。
    d.chainsLeft = numOr0(d.chainsLeft) - 1;

    // 2) 冰/毒附着（frostVenom=1）：给幸存的被命中敌人挂 chill + poison
    //    （致死一击不附着，与框架 effectsOnHit 同款约定：尸体无意义；chill 无 tick，
    //    poison 的 tick 间隔按 dot 频率牌经弹上 poisonTickMs 快照逐实例覆盖）。
    if (numOr0(d.frostVenom) === 1 && !enemy.dead) {
      applyEffect(state, enemy, 'chill');
      const poisonData: Record<string, number> = {
        weaponDamage: numOr0(d.baseDamage),
      };
      if (numOr0(d.poisonTickMs) > 0) {
        poisonData.tickMs = numOr0(d.poisonTickMs);
      }
      applyEffect(state, enemy, 'poison', poisonData);
    }

    // 3) 连锁闪电（chainLightning=1）：以被命中敌人为圆心的 zapRadius 内、不在 hitIds 的
    //    至多 2 个额外敌人受 zapDamage（zap 目标不记入 hitIds，与直击目标天然不重复）。
    if (numOr0(d.chainLightning) === 1) {
      zapNearby(state, proj, enemy, numOr0(d.zapRadius), numOr0(d.zapDamage));
    }

    // 4) 伤害递减：为下一跳重写（框架已按旧 damage 结算本次）：
    //    第 n 次命中后 proj.damage = baseDamage × falloff^n（第 1 跳全额、第 2 跳 ×falloff…）。
    proj.damage = numOr0(d.baseDamage) * Math.pow(numOr0(d.falloff), proj.hitIds.length);

    const next =
      d.chainsLeft > 0
        ? nearestChainTarget(state, proj, numOr0(d.chainRange), enemy.id, numOr0(d.prismRecurse) === 1)
        : null;

    if (d.chainsLeft > 0 && next !== null) {
      // 速度大小不变，重设速度朝新目标的【当前位置】直线飞——弹跳不加预测（T5.2a 锁定：
      // 与追踪武器的区分点；弹跳速度快、距离短，跳转后不再修正方向）。
      const speed = Math.hypot(proj.vx, proj.vy);
      const dir = normalize({ x: next.x - proj.x, y: next.y - proj.y });
      proj.vx = dir.x * speed;
      proj.vy = dir.y * speed;
      return;
    }

    // 弹跳终止（d.chainsLeft <= 0 || next === null）：
    if (numOr0(d.focusReturn) === 1) {
      const n = proj.hitIds.length;
      const damage = numOr0(d.baseDamage) * (1 + 0.25 * n);
      const speed = Math.hypot(proj.vx, proj.vy);
      spawnProjectile(state, {
        behavior: BEHAVIOR_NAME,
        x: proj.x,
        y: proj.y,
        vx: 0,
        vy: speed,
        radius: FOCUS_RETURN_RADIUS,
        damage,
        pierceLeft: FOCUS_RETURN_PIERCE,
        bouncesLeft: 0,
        hitIds: [],
        ttlMs: FOCUS_RETURN_TTL_MS,
        effectsOnHit: [],
        data: { ...d, focusReturn: 0, prismRecurse: 0, returning: 1 },
      });
    }
    proj.dead = true;
  },
};
