// src/core/behaviors/behavior_seismicPulse.ts —— 震波壁垒：全宽度行进波（无索敌、
// 无弹道、零随机）。fire = 从墙线出发向 y 减小方向发出一道扫掠波（sweep）：横贯全屏的
// 波前逐帧向上推进，波前经过谁就结算谁（伤害 + 击退 + 眩晕）。
//
// 行进波几何（F3 锁定）：
// - 波前位置 f(t) = wallLineY − stats.waveDistance × (elapsed / SWEEP_MS)，t = fire 时刻起算；
// - 扫掠总时长 SWEEP_MS = 400ms 为固定几何常量（硬编码于下方常量）：时长不随距离变化，
//   范围强化（rangeKeys = ["waveDistance"]）提高的是波前速度与最终行进距离，不是时长；
// - 波前判定带宽：|e.y − frontY| ≤ stats.bandDepth（bandDepth 语义 = 波前厚度）。
//   取对称式而非 frontY − thickness/2 单边带：延续旧冲击带「|Δy| ≤ bandDepth」的判定公式
//   （阈值语义从「离墙 reach」变为「波前半判定带宽」），恰在边界算在内，与旧契约同形；
// - 每敌每次 sweep 至多结算一次：按 sweep hitIds（Set<enemyId>）去重——击退竖直向上会把
//   幸存者推进波前尚未经过的区域，没有去重会重复掉血；
// - 逐帧结算用「走廊」而非单点带：本帧结算区 = [frontY − thickness, lastFrontY + thickness]
//   （lastFrontY = 上一帧波前位置）。两帧间波前位移可能超过单帧带宽（长帧/掉帧大步长），
//   走廊覆盖「上一帧带 ∪ 本帧带」保证任意 dt 下零漏判；fire 时刻立即按 t=0 走廊
//   [wallLineY − thickness, wallLineY + thickness] 预结算一次（波在墙线出生即触碰贴墙敌人，
//   也保证「fire 了就至少结算过贴墙带」，不依赖下一帧 update）。
// fire 开火门槛（沿用「无目标不开火、冷却归 0」约定，按新几何判定）：可达范围内
// （|e.y − wallLineY| ≤ waveDistance + thickness，即波前终点判定外沿）无存活敌人 →
// 不开火、cooldownMs 归 0（解释器随后 += interval 推进节奏）。可达但波前尚未经过的目标
// 算可达（门槛按最终范围判定，不按 t=0 带判定）。
//
// 结算内容（波前经过时对该敌人，数组序逐个，确定性）：
//   ① 伤害 dealDamage(damage 快照)；持过载共振牌且结算时目标已处于眩晕中（hasEffect(e,'stun')）
//      → 伤害 ×2（判定时刻 = 波前经过该敌人的那一刻；本波自己挂的眩晕不影响本波对该敌人
//      的判定——每敌每 sweep 只结算一次，下一波波前再经过时才吃到 ×2）；
//   ② 击退：幸存者 applyEffect('knockback', { force: knockbackForce })——效果引擎强制竖直
//      向上（推离墙线）+ maxHp 抗性（tank/boss 少退）为既有规则，行为不新写；
//   ③ 眩晕：幸存者 applyEffect('stun')——效果表 800ms、Boss 400ms 为既有规则；
//      持震荡加深牌 → 覆盖值 = 效果表定义值 + stats.stunBonusMs（150/层，经
//      data.durationMs 逐实例覆盖传入；Boss 减半作用于覆盖后的时长，仍在效果引擎内生效）。
// sweep 期间武器正常按 intervalMs 进入下一轮冷却（fire 不改写冷却）；同武器同时最多一个
// 活跃 sweep：meta 单键天然实现「后发覆盖先发」（3.6s 间隔 > 400ms sweep 正常不重叠；
// 防御性约定 = 万一重叠，旧 sweep 被放弃、其城垣共鸣不再结算）。
//
// 城垣共鸣（wallResonanceHeal +4/层 + wallResonanceHits 阈值 8）：按整次 sweep 的累计命中数
// （含被击杀者，hitIds.size；余震不计数）在 sweep 结束时（elapsed ≥ SWEEP_MS）一次性判定
// ≥ 阈值 → healWall(4×层数)，clamp 到 wall.maxHp（healWall 内建）。
//
// 余震（aftershockFactor +0.3/层）：真实开火后经 meta 延时队列，从 fire 时刻起算
// aftershockDelayMs（400ms ≈ sweep 结束点，语义即「波扫完后立即余震」），对「本次 sweep
// 扫过的完整区带（|e.y − wallLineY| ≤ 发射时 waveDistance 快照，几何行进带）」内当时存活的
// 敌人追加：伤害 = 发射时 stats.damage × aftershockFactor 快照、无击退无眩晕；持过载共振 →
// 结算时对仍眩晕的目标 ×2（判定时刻 = 余震结算该敌人时）。队列风格与连射波队列（core/cards
// 的 scheduleBurstWaves/consumeDueBurstWaves）一致：meta 单键 FIFO、到期判定用 state.timeMs
// 绝对时间轴（不随帧缩放）、消费后原地压实（有界清理）、over 停摆防重入。余震只经本行为
// update 钩子消费，与武器冷却节奏无关。
//
// 其余专属牌：震荡加深 stunBonusMs（+150ms/层）见 ③；地裂 bandDepth（+20/层）= 加厚波前
// （判定带宽 +20/层，行进距离不变）；过载共振 overloadResonance（set 1）见 ①。
//
// VFX / sweep 状态（模拟层只写几何、视图只读）：共享单键 meta['seismic_pulse_vfx'] 的值
// 即 sweep 状态本体（SeismicSweepState ⊃ SeismicPulseVfx 视图字段）。留存窗 = sweep 全程
// （400ms）+ 淡出窗（SEISMIC_PULSE_VFX_MS 300ms），untilMs 过后由 update 清理键（有界）。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM。随机契约：零随机（线性扫描 + 数组序
// 结算 + Set 只做成员去重，任意种子可复现）。

import { applyEffect, dealDamage, getEffectDef, hasEffect } from '../effects';
import { healWall } from '../wall';
import { spawnZone } from '../zones';
import type { Enemy, SimState } from '../types';
import type { WeaponBehavior } from './registry';

/** 行为分支名（数据表 behavior 字段与注册表键一致）。 */
const BEHAVIOR_NAME = 'seismic_pulse';

/**
 * 扫掠波总时长 ms（固定几何常量，硬编码）：波前从墙线行进到 wallLineY − waveDistance 恒为
 * 400ms，不随行进距离变化——范围强化提高的是波前速度与最终距离（px/s = waveDistance / 0.4s），
 * 不是时长。数值恰与余震延时（base.aftershockDelayMs 400）一致：余震语义即「波扫完后立即」。
 */
export const SEISMIC_SWEEP_MS = 400;

/** 读可选数值键（stats 索引签名对缺失键返回 undefined）：显式兜底为 0。 */
function numOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 波前位置：t = elapsed（fire 起算，ms），钳制在 [0, SWEEP_MS]（sweep 结束后驻留终点）。 */
function frontYAt(wallLineY: number, waveDistance: number, elapsedMs: number): number {
  const t = Math.min(Math.max(elapsedMs, 0), SEISMIC_SWEEP_MS);
  return wallLineY - waveDistance * (t / SEISMIC_SWEEP_MS);
}

// —— sweep 状态 / VFX（共享单键，M19 视图消费视图字段，模拟层消费全部字段） ——

/** sweep/VFX 共享单键（值为 SeismicSweepState 单对象；与 src/phaser/fx.ts 导出的字面量一致）。 */
export const SEISMIC_PULSE_VFX_KEY = 'seismic_pulse_vfx';

/** sweep 结束后 VFX 淡出留存时长 ms（表现常量非平衡数值；视图按剩余时间线性淡出）。 */
export const SEISMIC_PULSE_VFX_MS = 300;

/** 视图字段（src/phaser/mainScene.drawSeismicPulse 只读这四项）：波前推进与淡出所需几何。 */
export interface SeismicPulseVfx {
  /** sweep 起点（fire 时刻，state.timeMs 绝对时间轴）。 */
  startMs: number;
  /** 行进距离快照（波前终点 = wallLineY − waveDistance）。 */
  waveDistance: number;
  /** 波前厚度快照（判定半带宽 |e.y − frontY| ≤ thickness）。 */
  thickness: number;
  /** 留存截止 = startMs + SEISMIC_SWEEP_MS + SEISMIC_PULSE_VFX_MS。 */
  untilMs: number;
}

/** sweep 状态本体（模拟层全部字段；单键即「同武器至多一个活跃 sweep」的防御）。 */
interface SeismicSweepState extends SeismicPulseVfx {
  weaponId: string;
  /** 城垣共鸣是否已随 sweep 结束结算（恰好一次）。 */
  finished: 0 | 1;
  /** 上一帧波前 y（走廊结算下沿来源；fire 时 = wallLineY）。 */
  lastFrontY: number;
  /** 本 sweep 已结算敌 id（每敌恰一次；击退向上重入去重）。 */
  hitIds: Set<number>;
  /** 发射时快照：单发伤害（过载共振 ×2 前的基础值）。 */
  damage: number;
  /** 发射时快照：击退冲量。 */
  knockbackForce: number;
  /** 发射时快照：震荡加深加层（data.durationMs 覆盖用）。 */
  stunBonusMs: number;
  /** 发射时快照：过载共振开关（1 = 持有）。 */
  overload: 0 | 1;
  /** 发射时快照：城垣共鸣回复量 / 阈值（0 = 未持有）。 */
  resonanceHeal: number;
  resonanceThreshold: number;
  /** 发射时快照：地裂/熔岩裂隙开关（1 = 持有）。 */
  earthSplit: number;
}

// —— 余震延时队列（meta 单键 FIFO，风格对齐 core/cards 的连射波队列） ——

/** 余震待发队列的 meta 键（state.meta 共享单键，值为 AftershockEntry[] FIFO）。 */
export const AFTERSHOCK_QUEUE_META_KEY = 'seismic_aftershock_queue';

/** 余震条目：发射时快照（伤害已乘层数系数、行进带、过载开关），重放按快照结算。 */
export interface AftershockEntry {
  weaponId: string;
  /** 到期时刻（state.timeMs 时间轴绝对值；= fire 时刻 + delayMs）。 */
  dueAtMs: number;
  /** 单次余震伤害（= 发射时 stats.damage × aftershockFactor 快照）。 */
  damage: number;
  /** 行进距离快照（余震带 = |e.y − wallLineY| ≤ waveDistance 的几何行进带）。 */
  waveDistance: number;
  /** 1 = 持有过载共振：结算时对仍眩晕的目标伤害 ×2。 */
  overload: number;
}

/** 追加一条余震待发条目（真实开火时调用；条目量 = 未到期余震数，天然有界）。 */
function scheduleAftershock(
  state: SimState,
  weaponId: string,
  damage: number,
  waveDistance: number,
  overload: boolean,
  delayMs: number,
): void {
  let queue = state.meta[AFTERSHOCK_QUEUE_META_KEY] as AftershockEntry[] | undefined;
  if (!queue) {
    queue = [];
    state.meta[AFTERSHOCK_QUEUE_META_KEY] = queue;
  }
  queue.push({
    weaponId,
    dueAtMs: state.timeMs + delayMs,
    damage,
    waveDistance,
    overload: overload ? 1 : 0,
  });
}

/**
 * 结算一次余震：对「发射时快照的几何行进带」（|e.y − wallLineY| ≤ waveDistance）内当时存活的
 * 敌人逐个 dealDamage（数组序，确定性）。无击退无眩晕；持过载共振（overload=1）且结算时
 * 目标仍处于眩晕中 → 伤害 ×2。已死亡敌人跳过（dealDamage 亦有同款守卫）。
 */
function settleAftershock(state: SimState, entry: AftershockEntry): void {
  const wallLineY = state.layout.wallLineY;
  const enemies = state.enemies;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.dead || Math.abs(e.y - wallLineY) > entry.waveDistance) {
      continue;
    }
    const dmg =
      entry.overload === 1 && hasEffect(e, 'stun') ? entry.damage * 2 : entry.damage;
    dealDamage(state, e, dmg, entry.weaponId);
  }
}

/**
 * 消费全部到期余震（dueAtMs <= 当前时刻，FIFO 序逐条结算），消费后原地压实队列
 * （保序、零重分配）。state.over 非 null（模拟已结束）时直接 return（与连射波队列同款）。
 */
function consumeDueAftershocks(state: SimState): void {
  if (state.over !== null) {
    return;
  }
  const queue = state.meta[AFTERSHOCK_QUEUE_META_KEY] as AftershockEntry[] | undefined;
  if (!queue || queue.length === 0) {
    return;
  }
  const now = state.timeMs;
  let kept = 0;
  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    if (entry.dueAtMs <= now) {
      settleAftershock(state, entry);
      continue; // 已消费：压实跳过
    }
    queue[kept++] = entry;
  }
  queue.length = kept;
}

/** 波前经过附着的眩晕：持震荡加深（stunBonusMs > 0）→ 覆盖值 = 效果表定义值 + 加层；
 *  否则走效果表默认（800ms；Boss 400ms 减半为效果引擎既有规则）。 */
function applySweepStun(state: SimState, e: Enemy, stunBonusMs: number, sourceWeaponId?: string): void {
  if (stunBonusMs > 0) {
    applyEffect(state, e, 'stun', {
      durationMs: getEffectDef('stun').durationMs + stunBonusMs,
    }, sourceWeaponId);
  } else {
    applyEffect(state, e, 'stun', undefined, sourceWeaponId);
  }
}

/**
 * 结算一个纵向走廊 [frontY − thickness, corridorTop] 内未去重过的存活敌人（数组序，确定性）：
 * 伤害（过载共振按结算时刻判定 ×2）→（幸存者）击退 →（幸存者）眩晕；命中者写入 sweep
 * hitIds（每敌每 sweep 恰一次）。corridorTop = lastFrontY + thickness（上一帧带外沿）——
 * 覆盖「上一帧带 ∪ 本帧带」，任意帧步长下波前零漏判。sweep 命中数即 hitIds.size。
 */
function settleSweepCorridor(
  state: SimState,
  sweep: SeismicSweepState,
  frontY: number,
): void {
  const yMin = frontY - sweep.thickness;
  const yMax = sweep.lastFrontY + sweep.thickness;
  const enemies = state.enemies;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.dead || e.y < yMin || e.y > yMax || sweep.hitIds.has(e.id)) {
      continue;
    }
    sweep.hitIds.add(e.id);
    // ① 伤害：过载共振 ×2 判定时刻 = 波前经过该敌人的那一刻（本波自己的眩晕不影响本波
    // 对它的判定——每敌每 sweep 只结算一次）。
    dealDamage(
      state,
      e,
      sweep.overload === 1 && hasEffect(e, 'stun') ? sweep.damage * 2 : sweep.damage,
      sweep.weaponId,
    );
    if (e.dead) {
      continue; // 致死一击不附着 CC（尸体无意义，与 mortar 眩晕同款幸存者判定）
    }
    // ② 击退：效果引擎强制竖直向上（推离墙线）+ maxHp 抗性。
    applyEffect(state, e, 'knockback', { force: sweep.knockbackForce }, sweep.weaponId);
    // ③ 眩晕：效果表默认 / 震荡加深覆盖（Boss 减半作用于覆盖后时长，引擎内生效）。
    applySweepStun(state, e, sweep.stunBonusMs, sweep.weaponId);
  }
}

/** sweep 收尾（恰好一次）：按整次 sweep 累计命中数结算城垣共鸣（含被击杀者；clamp 内建于
 *  healWall）。之后状态仅剩 VFX 淡出窗职责，等 untilMs 到期由 update 清理。 */
function finishSweep(state: SimState, sweep: SeismicSweepState): void {
  if (sweep.finished === 1) {
    return;
  }
  sweep.finished = 1;
  if (sweep.resonanceHeal > 0 && sweep.resonanceThreshold > 0 && sweep.hitIds.size >= sweep.resonanceThreshold) {
    healWall(state, sweep.resonanceHeal);
  }

  // 熔岩裂隙（earthSplit === 1）：波前扫过后在地面留下持续 2.5s 的地裂带
  if (sweep.earthSplit === 1) {
    const centerY = state.layout.wallLineY - sweep.waveDistance / 2;
    // 屏幕宽度 720px，横向并排铺设 4 个覆盖圆（x = 90, 270, 450, 630），半径 110px，无缝覆盖全宽
    const xs = [90, 270, 450, 630];
    for (let i = 0; i < xs.length; i++) {
      spawnZone(state, {
        x: xs[i],
        y: centerY,
        radius: 110,
        durationMs: 2500,
        tickMs: 500,
        damagePerTick: 8,
        effectKind: 'slow',
        color: 0xff5511,
        sourceWeaponId: sweep.weaponId,
      });
    }
  }
}

/**
 * 推进活跃 sweep（update 钩子逐帧调用）：按 state.timeMs 绝对时间轴计算波前位置（不随帧
 * 缩放），结算本帧走廊；elapsed ≥ SWEEP_MS → 收尾（城垣共鸣恰一次）；untilMs 过后清理键
 * （有界清理）。over 停摆由调用方守卫。无活跃 sweep（键缺失）为 no-op。
 */
function advanceActiveSweep(state: SimState): void {
  const sweep = state.meta[SEISMIC_PULSE_VFX_KEY] as SeismicSweepState | undefined;
  if (!sweep) {
    return;
  }
  const elapsed = state.timeMs - sweep.startMs;
  const frontY = frontYAt(state.layout.wallLineY, sweep.waveDistance, elapsed);
  if (elapsed <= SEISMIC_SWEEP_MS) {
    settleSweepCorridor(state, sweep, frontY);
    sweep.lastFrontY = frontY;
  }
  if (elapsed >= SEISMIC_SWEEP_MS) {
    finishSweep(state, sweep);
  }
  if (state.timeMs >= sweep.untilMs) {
    delete state.meta[SEISMIC_PULSE_VFX_KEY]; // 有界清理：留存窗（sweep + 淡出）结束
  }
}

export const behavior: WeaponBehavior = {
  name: BEHAVIOR_NAME,

  /**
   * 发出一道行进波：可达范围（|e.y − wallLineY| ≤ waveDistance + thickness，波前终点判定
   * 外沿）无存活敌人 → 不开火并把该武器 cooldownMs 归 0（解释器随后 += interval 推进节奏，
   * 本帧内不重复触发；不开火不写 sweep/VFX、不排余震）。可达 → 写入 sweep 状态（共享单键
   * 覆盖写 = 同武器至多一个活跃 sweep 的防御）、按 t=0 走廊立即预结算贴墙带、把余震排入
   * 延时队列（从 fire 时刻起算）。本函数不结算城垣共鸣（sweep 结束时按累计命中数结算）。
   * projectileSpeed/pierce/ttlMs 为固定五键占位（表值 0，与 mortar 同款），行为不消费。
   */
  fire(state, weaponId, stats) {
    const waveDistance = numOr0(stats.waveDistance);
    const thickness = numOr0(stats.bandDepth);
    const wallLineY = state.layout.wallLineY;
    const overload = stats.overloadResonance === 1;
    const enemies = state.enemies;

    // 开火门槛：可达范围内（含波前厚度容差）无存活敌人 → 不开火、冷却归 0。
    // 可达但波前尚未经过的目标算可达（按最终范围判定，不按 t=0 带判定）。
    const reach = waveDistance + thickness;
    let reachable = false;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.dead && Math.abs(e.y - wallLineY) <= reach) {
        reachable = true;
        break;
      }
    }
    if (!reachable) {
      const ws = state.weaponStates[weaponId];
      if (ws) {
        ws.cooldownMs = 0; // 归 0：解释器随后 += interval 推进节奏，本帧内不重复触发
      }
      return;
    }

    // sweep 状态（= VFX 条目本体）：单键覆盖写。间隔 3.6s > 400ms sweep 正常不重叠；
    // 万一重叠，旧 sweep 被放弃（其城垣共鸣不再结算）——确定性、至多一个活跃 sweep。
    const sweep: SeismicSweepState = {
      weaponId,
      startMs: state.timeMs,
      waveDistance,
      thickness,
      untilMs: state.timeMs + SEISMIC_SWEEP_MS + SEISMIC_PULSE_VFX_MS,
      finished: 0,
      lastFrontY: wallLineY,
      hitIds: new Set<number>(),
      damage: numOr0(stats.damage),
      knockbackForce: numOr0(stats.knockbackForce),
      stunBonusMs: numOr0(stats.stunBonusMs),
      overload: overload ? 1 : 0,
      resonanceHeal: numOr0(stats.wallResonanceHeal),
      resonanceThreshold: numOr0(stats.wallResonanceHits),
      earthSplit: stats.earthSplit === 1 ? 1 : 0,
    };
    state.meta[SEISMIC_PULSE_VFX_KEY] = sweep;

    // t=0 预结算：波在墙线出生，立即按出生走廊 [wallLineY − thickness, wallLineY + thickness]
    // 结算贴墙带（fire 了就至少结算过贴墙带，不依赖下一帧 update；走廊语义与逐帧一致）。
    settleSweepCorridor(state, sweep, wallLineY);

    // 余震：持余震牌（aftershockFactor > 0）→ 按发射时快照入延时队列（fire 时刻起算）。
    const aftershockFactor = numOr0(stats.aftershockFactor);
    if (aftershockFactor > 0) {
      scheduleAftershock(
        state,
        weaponId,
        numOr0(stats.damage) * aftershockFactor,
        waveDistance,
        overload,
        numOr0(stats.aftershockDelayMs),
      );
    }
  },

  /**
   * 每帧钩子：先消费到期余震（绝对时间轴判定，不随帧缩放），再推进活跃 sweep
   * （逐帧走廊结算 + sweep 收尾 + VFX 留存窗清理）。over 停摆防重入（与连射波队列同款）。
   */
  update(state, dtMs) {
    void dtMs;
    if (state.over !== null) {
      return;
    }
    consumeDueAftershocks(state);
    advanceActiveSweep(state);
  },
};
