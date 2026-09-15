// src/core/behaviors/behavior_homingMissile.ts —— 追猎导弹：追踪转向 + 命中即爆 + AoE 溅射，
// 升级节点（燃烧云/优先精英）全部以 JSON mods 数值开关表达（burnCloud/preferElite），
// unlock 字符串仅供生成器展示，行为只读 stats 开关——M2 统一约定。
// 数值契约：伤害/射速/弹速/寿命/AoE 半径/溅射系数/转向速度/弹数/扇形错开角全部来自
// WeaponStats（weapons/homing_missile.json）；几何量（弹丸半径）允许硬编码。
// 弹上快照约定：fire 时把本波数值/开关快照进每枚弹 data，钩子从弹上读回（升级瞬间已飞行的
// 旧弹按发射时数值结算）；死亡爆炸的伤害取 proj.damage（发射时的伤害快照）× 弹上 splashFactor。
// 随机契约：零随机（目标选择/扇形错开/分裂锁敌全为确定性映射，任意种子可复现）。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM。
//
// 爆炸/分裂语义（锁定）：
// - 弹命中即毁（onProjectileHit 置 dead），爆炸统一在 onProjectileDeath 结算（ttl 到期、
//   穿透用尽、命中即毁三条死亡路径都会爆炸——ttl 打空枪也落地炸）；
// - 爆炸：以死亡点为圆心、data.aoeRadius 为半径，网格查询（SpatialHash 圆相交语义
//   dist <= aoeRadius + enemy.radius，与弹丸命中判定同款）内所有【存活】敌人受
//   proj.damage × data.splashFactor；刚被直击的幸存目标若仍在半径内同样吃溅射
//   （即直击总伤 = damage × (1 + splashFactor)，不排除 hitIds）；
// - burnCloud=1：对爆炸半径内存活敌人（先结算溅射伤害、未被击杀者）applyEffect('burn')，
//   数值用效果表默认（dot 频率牌把 tick 间隔 ÷ dotTickMult，经弹上 burnTickMs 快照逐实例覆盖）；
// - 分裂（split_shot 通用牌 → data.splitReady）：爆炸（死亡钩子）后从爆炸点分裂至多
//   splitMaxTargets 枚次级导弹：初速按 leadAim 移动预测指向「最近且互不相同」
//   （pickNearestDistinctEnemies）的锁定目标、其后照常被 update 钩子逐帧追踪制导
//   （「追猎分裂追猎」：同弹速/同半径/同 AoE 溅射/燃烧云随行）、伤害 = 主弹伤害 ×
//   splitDamageFactor、不再分裂（splitReady=0 封死）、不经 fire 路径（不吃多射/连射）。
//   （旧子母弹 cluster/bomblet 死分支已随 T5.3b 删除：stats.cluster 无牌可点亮，分裂由
//   split_shot 牌统一驱动。）

import { applyEffect, dealDamage, getEffectDef } from '../effects';
import { scheduleBurstWaves, consumeDueBurstWaves } from '../cards';
import { pickNearestDistinctEnemies, spawnProjectile } from '../projectiles';
import { SpatialHash } from '../spatialHash';
import { leadAim } from '../targeting';
import type { Enemy, SimState } from '../types';
import type { WeaponBehavior } from './registry';
import type { WeaponStats } from '../weapons';

// 瞄准说明（T5.2a，主弹不接 targeting.leadAim 的原因）：追踪弹开火后由弹上 turnRateDegPerSec
// 逐帧转向制导，初速方向只是齐射扇形的散布基准——命中由持续追踪保证，无需开火瞬间解
// 提前量；这正是与弹道武器（直线弹 + 开火瞬间移动预测）的分工。
// （分裂次级弹例外：次级导弹初速按 split_shot 牌语义 leadAim 预测指向锁定目标，其后照常
// 由 update 钩子逐帧追踪制导——「追猎分裂追猎」。）

/** 行为分支名（弹丸 behavior 字段与注册表键一致）。 */
const BEHAVIOR_NAME = 'homing_missile';

/** 弹丸半径（px）：几何常量允许硬编码，数值类一律来自数据表。 */
const MISSILE_RADIUS = 6;

/** 读可选数值键（stats 索引签名与弹上 data 对缺失键都返回 undefined）：显式兜底为 0。 */
function numOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// —— 模块级爆炸查询网格 ——
// 死亡钩子拿不到 updateProjectiles 的网格参数，按框架约定自建/复用一个模块级 SpatialHash。
// 新鲜度戳 = (state, timeMs)：同一状态同一时刻只重建一次（惰性构建：本帧首次有弹死亡时付
// 一次 clear+insert，与 updateProjectiles 每帧重建同成本）。敌人在武器/弹丸阶段之间静止
// （行军与效果位移都发生在更早的钩子），故帧内构建的网格对全部死亡爆炸精确有效；
// 命中的尸体由爆炸结算处的 e.dead 过滤（与框架网格同款约定）。
const blastGrid = new SpatialHash<Enemy>(64);
let blastGridState: SimState | null = null;
let blastGridTimeMs = NaN; // NaN !== 任何值：强制首帧重建

function ensureBlastGrid(state: SimState): SpatialHash<Enemy> {
  if (blastGridState !== state || blastGridTimeMs !== state.timeMs) {
    blastGrid.clear();
    const enemies = state.enemies;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.dead) {
        blastGrid.insert(e, e.x, e.y, e.radius);
      }
    }
    blastGridState = state;
    blastGridTimeMs = state.timeMs;
  }
  return blastGrid;
}

/** 按 id 找存活敌人（线性扫描，找不到/非有限 id 返回 null）。 */
function findAliveEnemyById(state: SimState, id: number): Enemy | null {
  if (!Number.isFinite(id)) {
    return null;
  }
  const enemies = state.enemies;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e.dead && e.id === id) {
      return e;
    }
  }
  return null;
}

/** 距 (x, y) 最近的存活敌人（distSq 扫描，无开方；平距取数组先出现者，确定性）。 */
function nearestAliveEnemy(state: SimState, x: number, y: number): Enemy | null {
  let best: Enemy | null = null;
  let bestDistSq = Infinity;
  const enemies = state.enemies;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.dead) {
      continue;
    }
    const dx = e.x - x;
    const dy = e.y - y;
    const d = dx * dx + dy * dy;
    if (d < bestDistSq) {
      bestDistSq = d;
      best = e;
    }
  }
  return best;
}

/** 目标选择：preferElite=1 → 最近 Boss 优先，场上无 Boss 回落最近敌人；否则最近敌人。 */
function selectTarget(state: SimState, preferElite: boolean): Enemy | null {
  if (preferElite) {
    let bestBoss: Enemy | null = null;
    let bestBossDistSq = Infinity;
    const enemies = state.enemies;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.dead || !e.isBoss) {
        continue;
      }
      const dx = e.x - state.character.x;
      const dy = e.y - state.character.y;
      const d = dx * dx + dy * dy;
      if (d < bestBossDistSq) {
        bestBossDistSq = d;
        bestBoss = e;
      }
    }
    if (bestBoss) {
      return bestBoss;
    }
  }
  return nearestAliveEnemy(state, state.character.x, state.character.y);
}

/**
 * dot 频率（dot_freq 通用牌，requiresCard=burn_cloud）：燃烧云附着燃烧的 tick 间隔
 * ÷ stats.dotTickMult（cards 注入 = 1.3^张数）。fire 时把覆盖后的 tickMs 快照进弹
 * （mult<=1 时为 0 = 不覆盖，避免把效果表定义值钉死进实例 data——data 同名键一旦提供过
 * 即持久保留）；死亡钩子按快照逐实例覆盖。
 */
function burnTickOverride(stats: WeaponStats): number {
  const mult = numOr0(stats.dotTickMult);
  if (!(mult > 1)) {
    return 0;
  }
  const baseTick = getEffectDef('burn').tickMs;
  if (typeof baseTick !== 'number' || !Number.isFinite(baseTick) || baseTick <= 0) {
    return 0;
  }
  return baseTick / mult;
}

/**
 * 发射一波（完整 projectileCount 枚，连射重放共用）：选目标（见 selectTarget）→ 发射
 * stats.projectileCount 枚导弹，初始方向朝目标、多发按 stats.volleySpreadDeg 小角度扇形错开
 * （均匀参数 t ∈ [-1, 1]）。无存活目标 → 返回 false（fire 据此写冷却归 0；重放波静默跳过）。
 * pierce 恒 0（命中即毁，爆炸在死亡钩子统一结算）；每枚弹 data 快照本波数值/开关。
 */
function fireVolley(state: SimState, _weaponId: string, stats: WeaponStats): boolean {
  const target = selectTarget(state, stats.preferElite === 1);
  if (!target) {
    return false;
  }

  const count = Math.max(0, Math.round(numOr0(stats.projectileCount)));
  const aim = Math.atan2(target.y - state.character.y, target.x - state.character.x);
  const halfSpread = (numOr0(stats.volleySpreadDeg) * Math.PI) / 180 / 2;

  // 弹上快照：追踪/爆炸/分裂所需的本波数值与开关（死亡钩子拿不到 stats，从弹上读回）。
  const data: Record<string, number> = {
    targetId: target.id,
    aoeRadius: numOr0(stats.aoeRadius),
    splashFactor: numOr0(stats.splashFactor),
    burnCloud: stats.burnCloud === 1 ? 1 : 0,
    burnTickMs: burnTickOverride(stats),
    ttlMs: stats.ttlMs,
    turnRateDegPerSec: numOr0(stats.turnRateDegPerSec),
    projectileSpeed: numOr0(stats.projectileSpeed),
    splitReady: numOr0(stats.splitCount) >= 1 ? 1 : 0,
    splitFactor: numOr0(stats.splitDamageFactor),
    splitMax: numOr0(stats.splitMaxTargets),
  };

  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : (2 * i) / (count - 1) - 1; // [-1, 1] 均匀
    const ang = aim + halfSpread * t;
    spawnProjectile(state, {
      behavior: BEHAVIOR_NAME,
      x: state.character.x,
      y: state.character.y,
      vx: Math.cos(ang) * stats.projectileSpeed,
      vy: Math.sin(ang) * stats.projectileSpeed,
      radius: MISSILE_RADIUS,
      damage: stats.damage,
      pierceLeft: 0, // 命中即毁：与表 pierce 0 一致，穿透路径不参与
      bouncesLeft: 0,
      hitIds: [],
      ttlMs: stats.ttlMs,
      effectsOnHit: [],
      data,
    });
  }
  return true;
}

export const behavior: WeaponBehavior = {
  name: BEHAVIOR_NAME,

  /**
   * 发射一波：见 fireVolley。无存活目标：不发射，并把该武器 cooldownMs 归 0（与 piercing_bolt
   * 同语义的重试标记）。首波发出后把连射跟发波排入待发队列（重放时重新选目标再发完整一波）。
   */
  fire(state, weaponId, stats) {
    if (!fireVolley(state, weaponId, stats)) {
      const ws = state.weaponStates[weaponId];
      if (ws) {
        ws.cooldownMs = 0; // 归 0：解释器随后 += interval 推进节奏，本帧内不重复触发
      }
      return;
    }
    scheduleBurstWaves(state, weaponId, BEHAVIOR_NAME, stats);
  },

  /**
   * 每帧钩子（次序锁定：先消费连射待发波，再做追踪转向——重放新弹当帧即被制导）：
   * 1) 连射待发波到期重放 fireVolley（重新选目标 + 完整 projectileCount 枚）；
   * 2) 对本行为所有存活弹，把当前速度方向朝 data.targetId 对应敌人旋转，角速度钳制在
   *    data.turnRateDegPerSec（角度限步、不瞬转；速度大小保持不变）。目标死亡/缺失 →
   *    重定向最近敌人（新目标 id 写回 data.targetId 记忆）；全场无敌人 → 保持直线。
   *    转向读弹上快照：升级换挡不影响已飞行的旧弹（分裂次级弹同款被制导——「追猎分裂追猎」）。
   */
  update(state, dtMs) {
    consumeDueBurstWaves<WeaponStats>(state, BEHAVIOR_NAME, (wid, st) => {
      fireVolley(state, wid, st);
    });

    const projectiles = state.projectiles;
    for (let i = 0; i < projectiles.length; i++) {
      const p = projectiles[i];
      if (p.behavior !== BEHAVIOR_NAME || p.dead) {
        continue;
      }
      const speedSq = p.vx * p.vx + p.vy * p.vy;
      if (speedSq <= 0) {
        continue; // 零速无方向：无从旋转
      }
      const speed = Math.sqrt(speedSq);

      // 解析目标：按 id 找存活敌人；死亡/缺失 → 重定向最近敌人并记忆新 id。
      let target = findAliveEnemyById(state, p.data.targetId);
      if (!target) {
        target = nearestAliveEnemy(state, p.x, p.y);
        if (!target) {
          continue; // 全场无敌人：保持直线
        }
        p.data.targetId = target.id;
      }

      // 限步转向：有符号角差 wrap 到 (-π, π]，每帧至多转 turnRate × dt 度。
      const cur = Math.atan2(p.vy, p.vx);
      const des = Math.atan2(target.y - p.y, target.x - p.x);
      const diff = Math.atan2(Math.sin(des - cur), Math.cos(des - cur));
      let maxStep = ((numOr0(p.data.turnRateDegPerSec) * Math.PI) / 180) * (dtMs / 1000);
      if (!Number.isFinite(maxStep) || maxStep < 0) {
        maxStep = 0; // 脏数据兜底：不转（保持直线），绝不让 NaN 穿透钳制
      }
      const turn = diff > maxStep ? maxStep : diff < -maxStep ? -maxStep : diff;
      const next = cur + turn;
      p.vx = Math.cos(next) * speed;
      p.vy = Math.sin(next) * speed;
    }
  },

  /**
   * 命中即毁：伤害与附着已由框架结算完（dealDamage + applyEffectsOnHit），这里只标记死亡，
   * 爆炸统一在 onProjectileDeath 做（标记后本帧不再结算剩余命中候选、弹走死亡路径）。
   */
  onProjectileHit(_state, proj, enemy) {
    // 记录命中目标：死亡钩子的分裂用它排除「刚被炸的目标」并预置次级弹 hitIds
    // （次级弹从爆炸点出生——通常在该敌人圆内——预置去重让其无伤穿越后奔向各自目标）。
    proj.data.hitEnemyId = enemy.id;
    proj.dead = true;
  },

  /**
   * 死亡爆炸（ttl 耗尽 / 命中即毁 / 穿透用尽三条路径统一在此）：
   * 1) 爆炸：data.aoeRadius 内所有存活敌人受 proj.damage × data.splashFactor（网格圆相交
   *    语义，与弹丸命中判定同款）；burnCloud=1 时对未被溅射击杀者挂燃烧（dot 频率牌经
   *    弹上 burnTickMs 快照逐实例覆盖 tick 间隔）；
   * 2) 分裂（split_shot 牌）：爆炸点向「最近且互不相同」的至多 splitMax 个存活敌人
   *    各发一枚次级导弹（初速 leadAim 预测、其后 update 钩子照常追踪制导，
   *    splitReady=0 封死再分裂）。
   */
  onProjectileDeath(state, proj) {
    const d = proj.data;

    // 1) 爆炸：半径内存活敌人统一吃溅射；燃烧只挂幸存者（致死一击附着尸体无意义）。
    const hits = ensureBlastGrid(state).queryCircle(proj.x, proj.y, numOr0(d.aoeRadius));
    const burnData = numOr0(d.burnTickMs) > 0 ? { tickMs: numOr0(d.burnTickMs) } : undefined;
    for (let i = 0; i < hits.length; i++) {
      const e = hits[i];
      if (e.dead) {
        continue; // 本帧已被其他弹/爆炸击杀：跳过
      }
      dealDamage(state, e, proj.damage * numOr0(d.splashFactor));
      if (d.burnCloud === 1 && !e.dead) {
        applyEffect(state, e, 'burn', burnData);
      }
    }

    // 2) 分裂（split_shot 牌）：爆炸点向「最近且互不相同」的至多 splitMax 个存活敌人
    //    各发一枚次级导弹（初速 leadAim 预测、其后 update 钩子照常追踪制导）。
    if (numOr0(d.splitReady) !== 1) {
      return;
    }
    const speed = numOr0(d.projectileSpeed);
    const ttlMs = numOr0(d.ttlMs);
    // 排除刚被炸的目标 + 次级弹 hitIds 预置该 id：穿越出生重叠圈后奔向各自目标
    // （hitEnemyId 在命中即毁时记录；ttl 空爆无命中目标 → 不排除不预置）。
    const hitId = numOr0(d.hitEnemyId);
    const exclude = hitId !== 0 ? [hitId] : undefined;
    const seed = hitId !== 0 ? [hitId] : [];
    const targets = pickNearestDistinctEnemies(state, proj.x, proj.y, numOr0(d.splitMax), exclude);
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      // 次级弹初速按 leadAim 预测点解（移动预测锁定；追踪制导随后逐帧修正，与主弹同弹种）。
      const aim = leadAim(proj, t, speed, state.layout.wallLineY);
      const ang = Math.atan2(aim.y - proj.y, aim.x - proj.x);
      spawnProjectile(state, {
        behavior: BEHAVIOR_NAME,
        x: proj.x,
        y: proj.y,
        vx: Math.cos(ang) * speed,
        vy: Math.sin(ang) * speed,
        radius: MISSILE_RADIUS,
        damage: proj.damage * numOr0(d.splitFactor),
        pierceLeft: 0,
        bouncesLeft: 0,
        hitIds: seed,
        ttlMs,
        effectsOnHit: [],
        data: {
          targetId: t.id,
          aoeRadius: numOr0(d.aoeRadius),
          splashFactor: numOr0(d.splashFactor),
          burnCloud: numOr0(d.burnCloud),
          burnTickMs: numOr0(d.burnTickMs),
          ttlMs,
          turnRateDegPerSec: numOr0(d.turnRateDegPerSec),
          projectileSpeed: speed,
          splitReady: 0, // 封死再分裂：次级弹不再分裂
          splitFactor: numOr0(d.splitFactor),
          splitMax: numOr0(d.splitMax),
        },
      });
    }
  },
};
