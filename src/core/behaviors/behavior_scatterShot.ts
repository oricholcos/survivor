// src/core/behaviors/behavior_scatterShot.ts —— 扇面霰弹：朝正上方（-y）扇形发射多枚短程弹丸，
// 角度平方分布（越靠中心越密）；升级节点（燃烧弹/击退/弹丸反弹/龙息）全部以 JSON mods 数值
// 开关表达（burnBullet/knockback/bounce/dragonBreath = 1），unlock 字符串仅供生成器展示，
// 行为只读 stats 开关——此约定对全部 M2 武器统一适用。
// 数值契约：伤害/射速/弹速/穿透/寿命/弹数/扇角/弹射范围/弹射次数/击退力全部来自 WeaponStats
// （weapons/*.json）；几何量（弹丸半径）允许硬编码。零随机（角度分布为确定性映射，任意种子可复现）。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM。
//
// T5.3b 弹道机制接线（牌 → 行为）：
// - 连射（burst_shot 通用牌 → stats.burstWaves 跟发波数 + stats.burstIntervalMs 波间隔）：
//   首波即时发射，跟发波经 core/cards 的 scheduleBurstWaves 入 meta 待发队列，由 update 钩子
//   consumeDueBurstWaves 到点重放 fireVolley——「重放时重新执行 fire 的散射逻辑」（锁定语义；
//   霰弹无索敌，重放即再喷一整波完整 projectileCount 枚）。
// - 多射（multi_shot 通用牌 → stats.projectileCount +1/张）：扇形内加弹，映射天然支持（base 5 起）。
// - 分裂（split_shot 通用牌 → stats.splitCount≥1 + splitDamageFactor/splitMaxTargets）：
//   每枚弹丸【首次命中】后在命中点分裂至多 splitMaxTargets 枚次级弹丸：leadAim 移动预测锁定
//   「最近且互不相同」（pickNearestDistinctEnemies）的存活敌人、与主弹同弹种（同弹速/半径/
//   燃烧模板/击退随行；不继承弹丸反弹——次级弹为简化单体）、伤害 = 主弹 × splitDamageFactor、
//   pierce 0、不再分裂（splitDone 旗标）、不经 fire 路径（不吃多射/连射）。每弹至多分裂一次。
// - 龙息模式互斥（dragon_breath_mode 专属牌，stats.dragonBreath=1）：锥形持续伤害，不发弹丸——
//   多射/连射/分裂全部忽略。行为侧双保险：fire 入口按 stats 短路（不发弹、不排波）；重放波
//   额外按当前牌表（getCardCount(dragon_breath_mode)>0）短路——玩家先拿多射/连射再转龙息时，
//   在途待发波不再喷弹（发射时数值结算约定的例外：质变牌立即生效）。
// - dot 频率（dot_freq 通用牌，requiresCard=burn_bullet）：stats.dotTickMult = 1.3^张数（cards
//   注入）——燃烧模板的 tick 间隔 ÷ 本值（effect.data.tickMs 逐实例覆盖；仅 mult>1 时写入，
//   不给实例钉死与效果表无关的间隔）。

import { applyEffect, getEffectDef } from '../effects';
import { scheduleBurstWaves, consumeDueBurstWaves } from '../cards';
import { normalize } from '../math';
import { pickNearestDistinctEnemies, spawnProjectile } from '../projectiles';
import type { EffectInstance, Enemy, Projectile, SimState } from '../types';
import { leadAim } from '../targeting';
import type { WeaponBehavior } from './registry';
import type { WeaponStats } from '../weapons';

// 瞄准说明（T5.2a，不接 targeting.leadAim 的原因）：扇面霰弹固定朝正上方（-y）扇形发射，
// 无目标锁定、无瞄准方向——「提前量」没有附着的目标，本行为天然不涉及移动预测。
// （分裂次级弹例外：次级弹按 split_shot 牌语义用 leadAim 锁定各自目标。）

/** 弹丸半径（px）：几何常量允许硬编码，数值类一律来自数据表。 */
const SCATTER_RADIUS = 6;

/** 击退力缺省值：stats.knockbackForce 缺失时的兜底（真实数值以 scatter.json L4 mods 为准）。 */
const DEFAULT_KNOCKBACK_FORCE = 60;

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

/** dot 频率乘区（stats.dotTickMult 由 cards 注入 = 1.3^张数；缺失/非有限/<=1 兜底为 1）。 */
function dotMult(stats: WeaponStats): number {
  const v = opt(stats, 'dotTickMult');
  return v > 1 ? v : 1;
}

/**
 * 发射一波（完整 projectileCount 枚，连射重放共用）：从角色位置发射 projectileCount 枚弹丸：
 * 均匀参数 t ∈ [-1, 1] 经平方映射偏角 = 半扇角 × t×|t|，中心角度密度最高、边缘稀疏，
 * 奇数枚时正中一枚恰朝正上；ttl 用 stats.ttlMs（短程：飞行距离上限 = projectileSpeed × ttlMs / 1000 px）；
 * 每枚弹的 data 快照本波开关数值（命中/死亡钩子拿不到 stats，从弹上读回）。
 */
function fireVolley(state: SimState, _weaponId: string, stats: WeaponStats): void {
  const count = Math.max(0, Math.round(stats.projectileCount));
  const halfRad = (stats.fanAngleDeg * Math.PI) / 180 / 2;

  // 燃烧弹（L2 unlock，mods 开关 burnBullet=1）：每枚弹命中附着燃烧（伤害用效果表默认值）。
  // 模板仅 kind/data 参与实例化（untilMs/stacks 由效果引擎按当前时刻重算）。
  // dot 频率牌：燃烧 tick 间隔 ÷ dotTickMult（effect.data.tickMs 逐实例覆盖；mult<=1 不写键，
  // 避免把效果表定义值钉死进实例 data——data 同名键一旦提供过即持久保留）。
  const mult = dotMult(stats);
  let burnTickMs = 0;
  if (stats.burnBullet === 1 && mult > 1) {
    const baseTick = getEffectDef('burn').tickMs;
    if (typeof baseTick === 'number' && Number.isFinite(baseTick) && baseTick > 0) {
      burnTickMs = baseTick / mult;
    }
  }
  const effectsOnHit: EffectInstance[] =
    stats.burnBullet === 1
      ? [{ kind: 'burn', untilMs: 0, stacks: 1, data: burnTickMs > 0 ? { tickMs: burnTickMs } : {} }]
      : [];

  // 弹上快照：击退/弹射/分裂开关与所需数值（本次 fire 的等级数值，随弹走）。
  const data: Record<string, number> = {
    knockback: stats.knockback === 1 ? 1 : 0,
    knockbackForce: Number.isFinite(stats.knockbackForce)
      ? stats.knockbackForce
      : DEFAULT_KNOCKBACK_FORCE,
    bounce: stats.bounce === 1 ? 1 : 0,
    bounceRange: stats.bounceRange,
    ttlMs: stats.ttlMs,
    speed: stats.projectileSpeed,
    splitReady: opt(stats, 'splitCount') >= 1 ? 1 : 0,
    splitFactor: opt(stats, 'splitDamageFactor'),
    splitMax: opt(stats, 'splitMaxTargets'),
    splitDone: 0,
    isSecondary: 0,
  };

  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : (2 * i) / (count - 1) - 1; // [-1, 1] 均匀
    const offsetRad = halfRad * t * Math.abs(t); // 平方映射：中心密、边缘疏、确定性零随机
    spawnProjectile(state, {
      behavior: 'scatter_shot',
      x: state.character.x,
      y: state.character.y,
      vx: Math.sin(offsetRad) * stats.projectileSpeed,
      vy: -Math.cos(offsetRad) * stats.projectileSpeed,
      radius: SCATTER_RADIUS,
      damage: stats.damage,
      pierceLeft: stats.pierce,
      bouncesLeft: opt(stats, 'bounceCount'),
      ttlMs: stats.ttlMs,
      effectsOnHit,
      data,
    });
  }
}

export const behavior: WeaponBehavior = {
  name: 'scatter_shot',

  /**
   * 发射一波：检查射程内是否有存活怪物（effRange = projectileSpeed * (ttlMs / 1000)），
   * 若无则不发射、cooldownMs 归 0 并返回；若有则发射并排入连射波。
   */
  fire(state, weaponId, stats) {
    const effRange = stats.projectileSpeed * (stats.ttlMs / 1000);
    const cx = state.character.x;
    const cy = state.character.y;
    let hasEnemyInRange = false;
    const enemies = state.enemies;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.dead) {
        continue;
      }
      const dx = e.x - cx;
      const dy = e.y - cy;
      const distSq = dx * dx + dy * dy;
      if (distSq <= effRange * effRange) {
        hasEnemyInRange = true;
        break;
      }
    }
    if (!hasEnemyInRange) {
      const ws = state.weaponStates[weaponId];
      if (ws) {
        ws.cooldownMs = 0;
      }
      return;
    }

    fireVolley(state, weaponId, stats);
    scheduleBurstWaves(state, weaponId, 'scatter_shot', stats);
  },

  /**
   * 每帧钩子：消费连射待发波——到期波重放 fireVolley（再喷完整 projectileCount 枚；
   * 玩家已转龙息模式则该波作废，见 fireVolley 的双保险短路）。
   */
  update(state, dtMs) {
    void dtMs; // 连射重放不随帧缩放：到期判定用 state.timeMs 绝对时间轴
    consumeDueBurstWaves<WeaponStats>(state, 'scatter_shot', (wid, st) => {
      fireVolley(state, wid, st);
    });
  },

  /**
   * 击退（L4 unlock，mods 开关 knockback=1）：对被命中敌人沿「背向角色 = 弹来向」方向
   * 施加即时冲量（applyEffect('knockback')，force 取弹上快照 knockbackForce）。
   * 致死一击不附效果（与 effectsOnHit 同款约定：尸体无意义）。
   */
  onProjectileHit(state, proj, enemy) {
    if (proj.data.knockback === 1 && !enemy.dead) {
      const dir = normalize({ x: enemy.x - state.character.x, y: enemy.y - state.character.y });
      applyEffect(state, enemy, 'knockback', { dirX: dir.x, dirY: dir.y, force: proj.data.knockbackForce });
    }
    splitOnHit(state, proj, enemy);
  },

  /**
   * 弹丸反弹（L6 unlock，mods 开关 bounce=1）：弹死亡（命中耗尽穿透或 ttl 到期）时若
   * bouncesLeft > 0，找 bounceRange 内最近一个未打过的敌人（不在 hitIds、存活）重设航向；
   * 否则正常死亡。框架约定死亡弹必回池（onProjectileDeath 后无条件 release），故以
   * spawn 一枚续接弹表达「不 dead」：从死亡点朝新目标、ttl 重置、bouncesLeft-1、
   * hitIds/effectsOnHit/data 随行（不重复打同一敌人，链式弹射由 bouncesLeft 封顶）。
   */
  onProjectileDeath(state, proj) {
    if (proj.data.bounce !== 1 || proj.bouncesLeft <= 0) {
      return; // 无弹射开关 / 次数用尽：正常死亡
    }
    const rangeSq = proj.data.bounceRange * proj.data.bounceRange;
    let target: { x: number; y: number } | null = null;
    let bestDistSq = Infinity;
    const enemies = state.enemies;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.dead || proj.hitIds.indexOf(e.id) !== -1) {
        continue;
      }
      const dx = e.x - proj.x;
      const dy = e.y - proj.y;
      const d = dx * dx + dy * dy;
      if (d > rangeSq) {
        continue; // 超出弹射范围
      }
      if (d < bestDistSq) {
        bestDistSq = d;
        target = e;
      }
    }
    if (!target) {
      return; // 范围内无新目标：正常死亡
    }
    const dir = normalize({ x: target.x - proj.x, y: target.y - proj.y });
    spawnProjectile(state, {
      behavior: 'scatter_shot',
      x: proj.x,
      y: proj.y,
      vx: dir.x * proj.data.speed,
      vy: dir.y * proj.data.speed,
      radius: SCATTER_RADIUS,
      damage: proj.damage,
      pierceLeft: proj.pierceLeft,
      bouncesLeft: proj.bouncesLeft - 1,
      hitIds: proj.hitIds, // spawnProjectile 浅拷贝合入：续接弹不重复打同一敌人
      ttlMs: proj.data.ttlMs, // ttl 重置
      effectsOnHit: proj.effectsOnHit,
      data: proj.data,
    });
  },
};

/**
 * 首次命中分裂（split_shot 牌，splitReady=1 且未分裂过）：在命中点分裂至多 splitMax 枚
 * 次级弹丸——leadAim 移动预测各锁一个「最近且互不相同」的存活敌人、同弹种（弹速/半径/
 * 燃烧模板/击退随行）、伤害 = 主弹 × splitFactor、pierce 0、不继承弹射（简化单体）、
 * splitReady=0 封死再分裂、不经 fire 路径（不吃多射/连射）。
 */
function splitOnHit(state: SimState, proj: Projectile, hitEnemy: Enemy): void {
  const d = proj.data;
  if (d.splitReady !== 1 || d.splitDone === 1 || d.isSecondary === 1) {
    return; // 未拿分裂牌 / 已分裂过 / 次级弹（每弹至多一次）
  }
  d.splitDone = 1; // 抢先置位：次级弹与同帧后续命中都不再分裂
  const factor = dataNum(d, 'splitFactor');
  const maxTargets = dataNum(d, 'splitMax');
  const speed = dataNum(d, 'speed');
  const ttlMs = dataNum(d, 'ttlMs');
  // 排除刚被命中的敌人 + 次级弹 hitIds 预置该 id：穿越出生重叠圈后奔向各自目标（见 projectiles 助手注释）。
  const targets = pickNearestDistinctEnemies(state, proj.x, proj.y, maxTargets, [hitEnemy.id]);
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const aim = leadAim(proj, t, speed, state.layout.wallLineY);
    const dir = normalize({ x: aim.x - proj.x, y: aim.y - proj.y });
    spawnProjectile(state, {
      behavior: 'scatter_shot',
      x: proj.x,
      y: proj.y,
      vx: dir.x * speed,
      vy: dir.y * speed,
      radius: SCATTER_RADIUS,
      damage: proj.damage * factor,
      pierceLeft: 0, // 次级弹锁定单一目标
      bouncesLeft: 0, // 不继承弹射：简化单体
      hitIds: [hitEnemy.id],
      ttlMs,
      effectsOnHit: proj.effectsOnHit, // 同弹种：燃烧模板随行（spawnProjectile 浅拷贝）
      data: {
        knockback: d.knockback, // 击退随行（同弹种 on-hit 语义）
        knockbackForce: d.knockbackForce,
        bounce: 0,
        bounceRange: d.bounceRange,
        ttlMs,
        speed,
        splitReady: 0,
        splitFactor: d.splitFactor,
        splitMax: d.splitMax,
        splitDone: 1,
        isSecondary: 1,
      },
    });
  }
}
