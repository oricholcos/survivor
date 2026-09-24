// src/core/behaviors/behavior_mortar.ts —— 迫击榴弹：飞行时间制曲射炮弹（noCollide 越过前排）
// + 落地爆炸 AoE，升级节点（燃烧地/眩晕/黑洞）全部以 JSON mods 数值开关表达
// （burnGround/stunBlast/blackHole），unlock 字符串仅供生成器展示，行为只读 stats 开关——
// M2 统一约定。数值契约：伤害/射速/飞行时长/AoE 半径/密度查询半径/燃烧地参数/
// 黑洞拉拽速度全部来自 WeaponStats（weapons/mortar.json）；几何量（弹丸半径、多射壳体
// 错开半径）允许硬编码。随机契约：零随机（密度选点/并列裁决/多射壳体环/分裂锁敌全为
// 确定性映射，任意种子可复现）。纯 TypeScript，禁止 import phaser 与任何 DOM/BOM。
//
// 选点语义（锁定）：对每个存活敌人经模块级网格 queryCircle(e.x, e.y, densityRadius) 统计
// 「密度半径内邻居数」（圆相交语义，含自身），取计数最多者为落点锚点；并列取敌人数组序
// 靠前者（严格大于才替换，确定性）。无敌人在场 → 不开火且 cooldownMs 归 0（与
// piercing_bolt/homing_missile 同语义的重试标记）。
// 落点提前量（T5.2a 锁定）：落点 = 密度锚点当前位置 + targetVelocity(锚点) × flightSec——
// 怪群行军向下，飞行 900ms 期间锚点会继续位移，按锚点当前速度预测怪群到达点（attack 贴墙
// 锚点/眩晕锚点速度为 0 → 落点即当前位置；slow/chill 减速计入）；落点钳制在行军可达域内
// （x ∈ [0, width]、y ≤ wallLineY——怪到墙即停，永不低于墙线，贴墙怪群预测不越界浪费落点）。
//
// 弹道语义（锁定）：fire 把落点 (tx, ty) 快照进弹 data，速度 = (落点 - 角色) / flightSec、
// ttl = flightMs（到点即落地）；noCollide=1 → 弹不参与命中结算、直线飞过前排敌人，
// 「抛物线」只是 M4 视图层按 tx/ty/进度画的弧线，core 直线位移。死亡爆炸圆心一律取弹上
// (tx, ty) 落点快照（而非死亡时刻 proj.x/y）——离散帧推进的最后一帧可能轻微过冲，
// 落点快照让爆炸圆心与选点目标严格重合。
//
// T5.3b 弹道机制接线（牌 → 行为）：
// - 多射（multi_shot 通用牌 → stats.projectileCount +1/张）：一波发射 N 枚壳体，落点在
//   密度中心预测落点周围小半径环上均匀错开（起点朝正上、相邻夹角 2π/N；单枚时恰为预测
//   落点本身——错开半径为本行为锁定的几何常量），各壳体独立落地爆炸、独立 AoE。
// - 连射（burst_shot 通用牌 → stats.burstWaves 跟发波数 + stats.burstIntervalMs 波间隔）：
//   首波即时发射，跟发波经 core/cards 的 scheduleBurstWaves 入 meta 待发队列，由 update 钩子
//   consumeDueBurstWaves 到点重放 fireVolley——「重放时重新执行 fire 的选点与散射逻辑」
//   （锁定语义：重放重新做密度选点 + 重新解提前量，快照 stats 结算；无目标波静默跳过）。
// - 分裂（split_shot 通用牌 → data.splitReady）：母弹落地爆炸（死亡钩子）后从爆炸点分裂至多
//   splitMaxTargets 枚次级榴弹：leadAim 移动预测锁定「最近且互不相同」（pickNearestDistinctEnemies）
//   的存活敌人、与主弹同弹种（noCollide 曲射壳体、同落速、燃烧地/眩晕/黑洞随行）、
//   伤害 = 母弹伤害 × splitDamageFactor、AoE = 母弹 AoE × splitDamageFactor（「短飞行后落
//   小 AoE」：短飞行 = 爆炸点到 leadAim 预测落点的实际距离 ÷ 主弹落速，无独立数值）、
//   不再分裂（splitReady=0 封死）、不经 fire 路径（不吃多射/连射）。
//   （旧集束 cluster/bomblet 死分支已随 T5.3b 删除：stats.cluster 无牌可点亮，分裂由
//   split_shot 牌统一驱动——次级榴弹语义即旧子榴弹「短飞行后落小 AoE」的牌驱动版。）
// - dot 频率（dot_freq 通用牌，requiresCard=burn_ground）：燃烧地 zone 的 tick 间隔
//   ÷ stats.dotTickMult（cards 注入 = 1.3^张数）——fire 时把 ÷ 后的 tickMs 快照进弹上
//   burnTickMs，死亡钩子照常传给 spawnZone（zone tick 本就是逐实例参数）。
//
// 爆炸/继承语义（锁定）：
// - onProjectileDeath（本弹只有 ttl 到期一条死亡路径）依次结算：
//   ⓪ 爆炸 VFX：写 meta['mortar_blast_vfx']（滚动数组，条目 {x,y,radius,untilMs}，
//      留存 320ms；视图渲染冲击环 + 中心闪光，T5.2b 补爆炸表现）；
//   ① 爆炸伤害：落点 aoeRadius（圆相交语义）内所有存活敌人 dealDamage(proj.damage ×
//      splashFactor)，splashFactor=1 即全额；
//   ② 眩晕：stunBlast=1 → 幸存者 applyEffect('stun')（致死一击不附着，尸体无意义）；
//   ③ 黑洞：blackHole=1 → 幸存者 applyEffect('blackhole', {centerX/centerY=落点})——
//      先炸后拉：幸存者向爆心位移至多 120px（G2a 治理），同一敌人 2s 内免疫再次拉拽；
//   ④ 燃烧地：burnGround=1 → spawnZone（radius=aoeRadius×burnRadiusFactor、
//      durationMs/tickMs（含 dot 频率 ÷ 乘区）/damagePerTick/effectKind='burn' 全部表值）；
//   ⑤ 分裂：splitReady=1 且本弹是母弹（splitReady=0 的次级弹到此为止）→ 从爆炸点向
//      「最近且互不相同」的至多 splitMax 个存活敌人各发一枚次级榴弹（短飞行后落小 AoE）。

import { applyEffect, dealDamage } from '../effects';
import { scheduleBurstWaves, consumeDueBurstWaves } from '../cards';
import { clamp } from '../math';
import { pickNearestDistinctEnemies, spawnProjectile } from '../projectiles';
import { SpatialHash } from '../spatialHash';
import { isEnemyLockable, leadAim, targetVelocity } from '../targeting';
import type { Enemy, SimState } from '../types';
import type { WeaponBehavior } from './registry';
import type { WeaponStats } from '../weapons';
import { spawnZone } from '../zones';

/** 行为分支名（弹丸 behavior 字段与注册表键一致）。 */
const BEHAVIOR_NAME = 'mortar';

// —— 落地爆炸 VFX（M4 视图消费，模拟层只写不读） ——
// T5.2b 用户反馈：「榴弹……落地瞬间只有弹丸消失，没有冲击波/闪光」→ 每次落地爆炸
// （母弹与次级榴弹都算）写一条 {x,y,radius,untilMs} 进共享 meta 键；视图渲染绿色冲击环
// + 中心闪光。数组滚动淘汰：写入前丢弃已过期条目，长度有界（留存窗口内的爆炸数）。

/** 爆炸 VFX 共享 meta 键（值为 MortarBlastVfx[]，按写入时间升序）。 */
export const MORTAR_BLAST_VFX_KEY = 'mortar_blast_vfx';

/** 爆炸 VFX 留存时长 ms（表现常量非平衡数值；视图按剩余时间线性淡出）。 */
export const MORTAR_BLAST_VFX_MS = 320;

/** 爆炸 VFX 单条目：落点、爆炸半径（= aoeRadius 快照）、留存截止时刻。 */
export interface MortarBlastVfx {
  x: number;
  y: number;
  radius: number;
  untilMs: number;
}

/** 追加一条爆炸 VFX：先淘汰已过期条目再 push（数组长度有界，零随机）。 */
function recordBlastVfx(state: SimState, x: number, y: number, radius: number): void {
  const now = state.timeMs;
  const prev = state.meta[MORTAR_BLAST_VFX_KEY];
  const kept: MortarBlastVfx[] = Array.isArray(prev)
    ? (prev as MortarBlastVfx[]).filter((b) => Number.isFinite(b?.untilMs) && b.untilMs > now)
    : [];
  kept.push({ x, y, radius, untilMs: now + MORTAR_BLAST_VFX_MS });
  state.meta[MORTAR_BLAST_VFX_KEY] = kept;
}

/** 弹丸半径（px）：几何常量允许硬编码，数值类一律来自数据表。 */
const SHELL_RADIUS = 6;

/** 多射壳体落点错开半径（px）：密度中心预测落点周围的确定性小环（行为锁定的几何常量）。 */
const MULTI_VOLLEY_SPREAD_PX = 40;

/** 读可选数值键（stats 索引签名与弹上 data 对缺失键都返回 undefined）：显式兜底为 0。 */
function numOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** dot 频率乘区（stats.dotTickMult 由 cards 注入 = 1.3^张数；缺失/非有限/<=1 兜底为 1）。 */
function dotMult(stats: WeaponStats): number {
  const v = numOr0(stats.dotTickMult);
  return v > 1 ? v : 1;
}

// —— 模块级查询网格（密度选点与死亡爆炸共用） ——
// fire 与 onProjectileDeath 都拿不到各系统的网格参数，按框架约定自建/复用一个模块级
// SpatialHash。新鲜度戳 = (state, timeMs)：同一状态同一时刻只重建一次（惰性构建）。
// 敌人在武器/弹丸阶段之间静止（行军与效果位移都发生在更早的钩子），故帧内构建的网格
// 对密度统计与死亡爆炸都精确有效；已死敌人不入网格，查询结果再按 e.dead 过滤兜底。
const queryGrid = new SpatialHash<Enemy>(64);
let queryGridState: SimState | null = null;
let queryGridTimeMs = NaN; // NaN !== 任何值：强制首帧重建
const scratchNear: Enemy[] = [];
const scratchHits: Enemy[] = [];

function ensureQueryGrid(state: SimState): SpatialHash<Enemy> {
  if (queryGridState !== state || queryGridTimeMs !== state.timeMs) {
    queryGrid.clear();
    const enemies = state.enemies;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.dead) {
        queryGrid.insert(e, e.x, e.y, e.radius);
      }
    }
    queryGridState = state;
    queryGridTimeMs = state.timeMs;
  }
  return queryGrid;
}

/**
 * 选「怪密度最高处」：逐个存活敌人统计 densityRadius 内邻居数（网格圆相交语义，含自身），
 * 取计数最多者；并列取数组序靠前（严格大于才替换）。无敌人在场返回 null。
 */
function densestEnemy(state: SimState, densityRadius: number): Enemy | null {
  const grid = ensureQueryGrid(state);
  let best: Enemy | null = null;
  let bestCount = -1;
  const enemies = state.enemies;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.dead || !isEnemyLockable(e)) {
      continue;
    }
    const near = grid.queryCircle(e.x, e.y, densityRadius, scratchNear);
    let count = 0;
    for (let n = 0; n < near.length; n++) {
      if (!near[n].dead && isEnemyLockable(near[n])) {
        count++;
      }
    }
    if (count > bestCount) {
      bestCount = count;
      best = e;
    }
  }
  return best;
}

/** 落地爆炸死亡弹的 data 快照（母弹与次级榴弹同构：开关与数值全随发射时快照）。 */
function blastData(d: Record<string, number>): Record<string, number> {
  return {
    noCollide: 1,
    tx: numOr0(d.tx),
    ty: numOr0(d.ty),
    aoeRadius: numOr0(d.aoeRadius),
    splashFactor: numOr0(d.splashFactor),
    burnGround: numOr0(d.burnGround),
    stunBlast: numOr0(d.stunBlast),
    blackHole: numOr0(d.blackHole),
    splitReady: numOr0(d.splitReady),
    splitFactor: numOr0(d.splitFactor),
    splitMax: numOr0(d.splitMax),
    splitDone: numOr0(d.splitDone),
    isSecondary: numOr0(d.isSecondary),
    burnRadiusFactor: numOr0(d.burnRadiusFactor),
    burnDurationMs: numOr0(d.burnDurationMs),
    burnTickMs: numOr0(d.burnTickMs),
    burnDamagePerTick: numOr0(d.burnDamagePerTick),
    pullPerSec: numOr0(d.pullPerSec),
  };
}

/**
 * 发射一波（完整 projectileCount 枚壳体，连射重放共用）：选「怪密度最高处」锚点
 * （见 densestEnemy），预测落点 = 锚点当前位置 + targetVelocity(锚点) × flightSec（钳制在
 * 行军可达域内）；多射时 N 枚壳体落点在预测落点周围小半径环上均匀错开（单枚恰为预测落点），
 * 各壳体独立速度 = (各自落点 - 角色) / flightSec、同一 ttl = flightMs 同时落地、独立 AoE。
 * 无敌人在场 → 返回 false（fire 据此写冷却归 0；重放波静默跳过）。弹上快照本波数值/开关
 * （死亡钩子拿不到 stats，从弹上读回；升级瞬间已飞行的旧弹按发射时数值结算）。
 * projectileSpeed 为飞行时间制占位（表值 0），行为不消费。
 * forcedTarget（可选，灼热光束协同开火强制指定）：以它为密度锚点（落点预测照常），
 * 多射壳体环/分裂/燃烧地等内部逻辑照常。
 */
function fireVolley(state: SimState, weaponId: string, stats: WeaponStats, forcedTarget?: Enemy): boolean {
  const target = forcedTarget ?? densestEnemy(state, numOr0(stats.densityRadius));
  if (!target) {
    return false;
  }

  const flightMs = numOr0(stats.flightMs);
  const flightSec = flightMs / 1000;
  // 落点提前量：锚点速度 × 飞行时长（attack/眩晕锚点速度 0 → 落点即当前位置）。
  // 钳制：x 在场内 [0, width]；y 钳到行军可达域——怪到墙即停、永远不会低于墙线，
  // 预测越界（贴墙怪群）→ 落点钳到墙线，正好覆盖停靠在墙上的怪群。
  const vel = targetVelocity(target);
  const tx = clamp(target.x + vel.x * flightSec, 0, state.layout.width);
  const ty = clamp(
    target.y + vel.y * flightSec,
    0,
    Math.min(state.layout.wallLineY, state.layout.height),
  );

  // 弹数约定（schema：mortar.json base 不含 projectileCount 键——「无键 = 单体」）：
  // 多射牌以 add 从 0 起算累加（每张 +1），故壳体数 = 1 + stats.projectileCount。
  const count = 1 + Math.max(0, Math.round(numOr0(stats.projectileCount)));
  const mult = dotMult(stats);
  // 弹上快照（全波共享）：爆炸/燃烧地/分裂所需数值与开关。dot 频率：燃烧地 tick 间隔
  // ÷ dotTickMult（快照进 burnTickMs，死亡钩子照常传 spawnZone）。
  const shared = blastData({
    aoeRadius: numOr0(stats.aoeRadius),
    splashFactor: 1, // 落地爆炸全额伤害
    burnGround: stats.burnGround === 1 ? 1 : 0,
    stunBlast: stats.stunBlast === 1 ? 1 : 0,
    blackHole: stats.blackHole === 1 ? 1 : 0,
    splitReady: numOr0(stats.splitCount) >= 1 ? 1 : 0,
    splitFactor: numOr0(stats.splitDamageFactor),
    splitMax: numOr0(stats.splitMaxTargets),
    burnRadiusFactor: numOr0(stats.burnRadiusFactor),
    burnDurationMs: numOr0(stats.burnDurationMs),
    burnTickMs: numOr0(stats.burnTickMs) / mult,
    burnDamagePerTick: numOr0(stats.burnDamagePerTick),
    pullPerSec: numOr0(stats.blackHolePullPerSec),
  });

  for (let i = 0; i < count; i++) {
    // 多射壳体环：均匀错开（起点朝正上、相邻夹角 2π/count）；单枚时零偏移恰为预测落点。
    const ang = count === 1 ? 0 : -Math.PI / 2 + (i * 2 * Math.PI) / count;
    const ox = count === 1 ? 0 : Math.cos(ang) * MULTI_VOLLEY_SPREAD_PX;
    const oy = count === 1 ? 0 : Math.sin(ang) * MULTI_VOLLEY_SPREAD_PX;
    const sx = clamp(tx + ox, 0, state.layout.width);
    const sy = clamp(ty + oy, 0, Math.min(state.layout.wallLineY, state.layout.height));
    // 飞行时长 <= 0（脏数据）：零速弹 ttl 0 即死，爆炸仍在落点快照处结算。
    const vx = flightSec > 0 ? (sx - state.character.x) / flightSec : 0;
    const vy = flightSec > 0 ? (sy - state.character.y) / flightSec : 0;

    spawnProjectile(state, {
      weaponId,
      behavior: BEHAVIOR_NAME,
      x: state.character.x,
      y: state.character.y,
      vx,
      vy,
      radius: SHELL_RADIUS,
      damage: numOr0(stats.damage),
      pierceLeft: 0, // noCollide 直通弹：命中结算路径不参与
      bouncesLeft: 0,
      hitIds: [],
      ttlMs: flightMs,
      effectsOnHit: [],
      data: blastData({ ...shared, tx: sx, ty: sy }),
    });
  }
  return true;
}

export const behavior: WeaponBehavior = {
  name: BEHAVIOR_NAME,

  /**
   * 发射一波曲射炮弹（见 fireVolley）。无敌人在场：不开火并把该武器 cooldownMs 归 0
   * （解释器随后 += interval 推进节奏，本帧内不重复触发）。首波发出后把连射跟发波排入
   * 待发队列（重放时重新密度选点 + 重新解提前量，再发完整一波壳体）。
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
   * 每帧钩子：消费连射待发波——到期波重放 fireVolley（重新密度选点 + 完整一波壳体）。
   */
  update(state, dtMs) {
    void dtMs; // 连射重放不随帧缩放：到期判定用 state.timeMs 绝对时间轴
    consumeDueBurstWaves<WeaponStats>(state, BEHAVIOR_NAME, (wid, st) => {
      fireVolley(state, wid, st);
    });
  },

  /**
   * 落地爆炸（本弹仅 ttl 到期一条死亡路径），次序锁定：先炸（①全额 AoE 伤害）后拉
   * （③黑洞只挂幸存者、持续向爆心拉拽聚怪），详见文件头「爆炸/继承语义」。
   * 爆炸圆心 = 弹上 (tx, ty) 落点快照（与选点目标严格重合，不受离散帧过冲影响）。
   * 分裂仅母弹（data.splitReady=1）；次级榴弹（splitReady=0）到此为止，总数封顶。
   */
  onProjectileDeath(state, proj) {
    const d = proj.data;
    const tx = numOr0(d.tx);
    const ty = numOr0(d.ty);
    const aoe = numOr0(d.aoeRadius);

    // ⓪ 爆炸 VFX：落地瞬间即写（冲击波/闪光由视图渲染，母弹与次级榴弹都表现）。
    recordBlastVfx(state, tx, ty, aoe);

    // ① 爆炸伤害：落点 aoeRadius 内所有存活敌人（圆相交语义，与弹丸命中判定同款）。
    const hits = ensureQueryGrid(state).queryCircle(tx, ty, aoe, scratchHits);
    for (let i = 0; i < hits.length; i++) {
      const e = hits[i];
      if (e.dead) {
        continue; // 本帧已被其他弹/爆炸击杀：跳过
      }
      dealDamage(state, e, proj.damage * numOr0(d.splashFactor), proj.weaponId);
    }

    // ② 眩晕：幸存者挂 stun（效果表默认数值）。
    if (d.stunBlast === 1) {
      for (let i = 0; i < hits.length; i++) {
        const e = hits[i];
        if (!e.dead) {
          applyEffect(state, e, 'stun', undefined, proj.weaponId);
        }
      }
    }

    // ③ 黑洞：幸存者向爆心位移至多 120px（先炸后拉；同一敌人 2s 内免疫再次拉拽，
    //    详见 core/effects.ts 的 G2a 拉拽治理——多射/分裂多次爆炸不再反复瞬移怪群）。
    if (d.blackHole === 1) {
      for (let i = 0; i < hits.length; i++) {
        const e = hits[i];
        if (!e.dead) {
          applyEffect(state, e, 'blackhole', {
            centerX: tx,
            centerY: ty,
          }, proj.weaponId);
        }
      }
    }

    // ④ 燃烧地：落点留一片燃烧区域（半径/时长/节奏/每跳伤害全表值，tick 附着 burn；
    //    tickMs 已在 fire 时按 dot 频率 ÷ 乘区快照）。
    if (d.burnGround === 1) {
      spawnZone(state, {
        x: tx,
        y: ty,
        radius: aoe * numOr0(d.burnRadiusFactor),
        durationMs: numOr0(d.burnDurationMs),
        tickMs: numOr0(d.burnTickMs),
        damagePerTick: numOr0(d.burnDamagePerTick),
        effectKind: 'burn',
        sourceWeaponId: proj.weaponId,
      });
    }

    // ⑤ 分裂（split_shot 牌）：母弹爆炸点向「最近且互不相同」的至多 splitMax 个存活敌人
    //    各发一枚次级榴弹——leadAim 预测落点（短飞行 = 爆炸点到预测落点的实际距离 ÷ 主弹
    //    落速）、AoE = 母弹 × splitFactor（小 AoE）、伤害 = 母弹 × splitFactor、
    //    燃烧地/眩晕/黑洞随行（①~④ 继承）、splitReady=0 封死再分裂。
    if (numOr0(d.splitReady) !== 1 || numOr0(d.splitDone) === 1 || numOr0(d.isSecondary) === 1) {
      return;
    }
    d.splitDone = 1;
    d.splitReady = 0;
    const speed = Math.hypot(proj.vx, proj.vy); // 与主弹同落速（同弹种；飞行时间制弹速即落地速度）
    const factor = numOr0(d.splitFactor);
    const targets = pickNearestDistinctEnemies(state, tx, ty, numOr0(d.splitMax));
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const landing = leadAim({ x: tx, y: ty }, t, speed, state.layout.wallLineY);
      const dist = Math.hypot(landing.x - tx, landing.y - ty);
      const sec = speed > 0 && dist > 0 ? dist / speed : 0; // 短飞行时长（距离/落速，无独立数值）
      const vx = sec > 0 ? (landing.x - tx) / sec : 0;
      const vy = sec > 0 ? (landing.y - ty) / sec : 0;
      spawnProjectile(state, {
        weaponId: proj.weaponId,
        behavior: BEHAVIOR_NAME,
        x: tx,
        y: ty,
        vx,
        vy,
        radius: SHELL_RADIUS,
        damage: proj.damage * factor,
        pierceLeft: 0,
        bouncesLeft: 0,
        hitIds: [],
        ttlMs: sec * 1000, // 到点即落地（noCollide 直通；sec=0 → 落点即爆炸点原地炸）
        effectsOnHit: [],
        data: blastData({
          tx: landing.x,
          ty: landing.y,
          aoeRadius: aoe * factor, // 小 AoE：母弹 AoE × splitFactor
          splashFactor: numOr0(d.splashFactor),
          burnGround: numOr0(d.burnGround),
          stunBlast: numOr0(d.stunBlast),
          blackHole: numOr0(d.blackHole),
          splitReady: 0, // 封死再分裂：次级榴弹不再分裂
          splitDone: 1,
          isSecondary: 1,
          splitFactor: factor,
          splitMax: numOr0(d.splitMax),
          burnRadiusFactor: numOr0(d.burnRadiusFactor),
          burnDurationMs: numOr0(d.burnDurationMs),
          burnTickMs: numOr0(d.burnTickMs),
          burnDamagePerTick: numOr0(d.burnDamagePerTick),
          pullPerSec: numOr0(d.pullPerSec),
        }),
      });
    }
  },
};
