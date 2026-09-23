// src/core/behaviors/behavior_heatBeam.ts —— 灼热光束：单体锁定持续光束 + 协同开火。
// 从「线上全体结算的瞬时激光」重做为「锁定一个目标按固定频率反复跳伤害」：
// 主束绑定一个目标单体结算（纯单体，不穿透线上其他敌人）——G2b 极强粘性锁定：绑定目标
// 存活期间永远保持锁定（出程照打），仅其死亡时才按四级优先级（Boss > 贴墙 > 快速 > 最近）
// 在 lockRange 内重选；持【第二闪光】牌时再发一道次级光束（同粘性规则、避开主束目标，
// 无候选则改打主束目标），伤害为主束的 25%。靠【加载】在同一目标上爬升伤害，
// 靠【协同开火】驱动全队齐射。
//
// 锁定语义（G2b 极强粘性锁定，用户明确要求）：
// - 只要当前绑定目标存活，就永远保持锁定并继续结算——即使它被击退/黑洞等效果移出
//   lockRange 也照常打击（加载/协同计数照常爬升、VFX 照常延伸到其当前位置）；
// - 仅当绑定目标死亡才重选：按既有四级优先级（preferBoss+preferFast+lockRange 过滤）在
//   范围内选新目标；范围内无敌人 → 不开火、cooldownMs 归 0（与 piercing_bolt 同款重试
//   标记），不写 VFX、不推进任何计数。「无目标」判定只存在于死亡重选路径——绑定目标
//   存活但其他敌人全部离开射程不算无目标（粘性锁定的约定例外：目标存在只是出程）；
// - 次级束同规则：自己的绑定目标存活且非主束目标 → 保持；死亡或处于「回打主束」回退态
//   时按四级优先级排除主束目标重选（排除后无候选 → 改打主束目标——避开主束的规则保持）；
// - 换目标只发生在死亡重选路径：加载清零 / 协同计数作废等既有规则照旧在该路径生效。
//
// 计数模型（存 meta 键 heat_beam_state:<weaponId>，按 weaponId 分键；重启新局 meta 为空自然清理）：
// - 加载计数——每束各自独立（load_up 牌注入 stats.loadFactor = 0.05）：
//   主束维护「当前绑定目标的连续命中数」mainLoad，次级束维护 secLoad；任一束换绑定目标
//   → 只清零该束自己的计数。即使两束攻击同一目标，加载层数也各自独立计算。
//   主束单跳伤害 = damage × (1 + loadFactor × n)；次级束单跳伤害 = damage × (1 + loadFactor × n)
//   × secondaryDamageFactor（0.25）。n 为本跳【之前】已连续命中数（首跳 n=0 全额，每跳 +5%）。
//   无【加载】牌时 loadFactor 缺失按 0 → 恒为基础伤害。
// - 协同计数——按目标 id 共用（coordinated_fire 牌注入 stats.coordinatedThreshold = 30）：
//   coordCounts 按目标 id 记录命中数，活跃至多两份（主束目标一份、次级束目标一份）；两束攻击
//   同一目标时两束命中推进同一份（每束每跳各 +1 = 共同计数）。每次 fire 前把「不再被任一束
//   瞄准」的目标计数作废删除（某束换走且另一束也不在打 → 作废；主束转锁到次级束正在打的目标
//   → 该目标已有计数保留，改为两束共同推进）。任一目标计数 ≥ 阈值 → 以该目标为对象触发一次
//   协同齐射，该目标计数归零重新累计。同 tick 两目标同时达阈值：按结算顺序主束目标先判、
//   一跳内至多触发一次（先到先触发，自由裁量见 heatBeam.test.ts）。
//   目标已死亡不触发齐射（尸体无对象可锁）。
//
// 次级光束（持第二闪光牌）：与主束同 tick 发射、同频率（一次 fire 内两束各结算一跳）；
// 目标 = findTarget 同参排除主束当前锁定目标后的最高优先者；排除后无候选 → 攻击主束目标。
//
// 【协同开火】触发语义（coordinated_fire 牌）：触发发生在灼热光束的 fire 内——遍历 fire 开始
// 时 weaponStates 键快照中其他所有已拥有武器（键快照防迭代中新增；灼热光束自身跳过——协同
// 判定只存在于本行为 fire 内，被触发武器的 fire 不会再触发协同，天然防递归）：
// - 前置门槛：触发目标在该武器的索敌范围内。rail_piercer / prism / charge_sniper /
//   homing_missile / mortar 为全场索敌恒真；scatter 为 effRange = projectileSpeed × ttlMs / 1000
//   （其 fire 自身还有同款判定，双保险）；seismic_wall 为目标在其行进波可达范围内
//   （|y − wallLineY| ≤ waveDistance + bandDepth——行进距离 + 波前厚度判定外沿，与该行为
//   fire 开火门槛同一几何，F3 行进波语义；用该武器当前真实 stats）。
// - 不锁定组（霰弹 scatter_shot、震波壁垒 seismic_pulse）：不强制指定目标，按各自正常 fire
//   发动（霰弹固定朝上扇形；震波壁垒发出行进波，目标过门槛即终将被波前扫到）。
// - 强制锁定组（其余五把）：以触发目标为 forcedTarget 走真实 fire 流程（各行为 fireVolley 的
//   findTarget 调用点接受覆盖，内部其他逻辑照常——连射跟发波照常入队、分裂/弹跳照常）。
// - 冷却豁免：调用前快照 ws.cooldownMs，若该武器本次为空转（借解释器约定判定：调用前
//   cooldownMs ≠ 0 且调用后 == 0）则恢复快照；真实开火不恢复——强制齐射不影响被触发武器
//   的冷却与索敌节奏。
// - 触发目标若在齐射中途被先结算的武器击杀：终止剩余齐射（后续武器无从锁定，自由裁量）。
// - 分层说明：本行为是 core 层唯一 import 数据加载层（loadWeaponDefs）的位置——协同齐射需要
//   全武器定义表（行为名 + getWeaponStats 输入），而行为 fire 签名拿不到 defs；数据层为纯
//   TS+JSON（无 phaser/DOM），加载器为 vite 编译期 import.meta.glob。懒加载 + 模块级缓存，
//   仅在真实触发协同时调用。getWeaponStats 的 runtime 反向 import（weapons.ts → behaviors/index
//   → 本文件 → weapons.ts）为 ESM 活绑定循环：本文件所有 weapons.ts 绑定都只在 fire 运行期
//   使用（模块求值期零引用），且 getWeaponStats 为函数声明（提升），循环安全。
//
// 灼痕（scorch 牌，once）：每束每跳命中后给存活的锁定目标 applyEffect('burn',
// { damagePerTick: 2 })（致死一击不附着——尸体无意义；dot 频率牌 dot_freq
// requiresCard=scorch 把 tick 间隔 ÷ stats.dotTickMult，经 effect.data.tickMs 逐实例覆盖，
// mult<=1 不写键——语义与旧版一致）。
//
// 清理说明：旧版过热槽整套删除（heat_beam_heat:* meta、update 散热钩子、overheat
// applyEffect）；weapons.ts 解释器的 overheatFactor 消费保持不动（通用机制）。
// VFX：meta 键 heat_beam_vfx:<weaponId> 结构保留（segments + untilMs），段序 = [主束, 次级束?]，
// 主束/次级束均从角色连到各自锁定目标（单体束，不再延伸到满射程）；视图层 drawHeatBeam 用
// 固定视觉宽度常量 + 次级束区分色。协同开火触发特效（G6）：真实触发齐射的瞬间向共享单键
// coordinated_fire_vfx 覆写一条 { x, y, untilMs }（坐标 = 触发目标当前位置、留存 350ms，
// 导出常量 COORDINATED_FIRE_VFX_MS 供视图同源导入）并推一次性 'coordinated' 音效（不节流，
// 与 crit/execute 同约定）；门槛未达 / 空转 / 目标本跳已死等不触发场景不写。
// 随机契约：零随机（目标选择/计数推进全为确定性映射，任意种子可复现）。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM。

import { loadWeaponDefs } from '../../data/weapons';
import { applyEffect, dealDamage, getEffectDef } from '../effects';
import { pushEvent } from '../events';
import { distSq } from '../math';
import { findTarget } from '../targeting';
import type { FindTargetOpts } from '../targeting';
import type { Enemy, SimState } from '../types';
import { getWeaponStats } from '../weapons';
import type { WeaponDef, WeaponStats } from '../weapons';
import { getBehavior } from './registry';
import type { WeaponBehavior } from './registry';

/** VFX 单条线段（视图层消费的几何快照）。 */
export interface HeatBeamSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** VFX meta 条目：本次开火产生的全部光束线段（段序 = [主束, 次级束?]）+ 留存截止时刻。 */
export interface HeatBeamVfx {
  segments: HeatBeamSegment[];
  untilMs: number;
}

/**
 * 计数器 meta 条目（heat_beam_state:<weaponId>）：
 * - mainTargetId / mainLoad：主束当前绑定目标 id（0 = 无绑定）与其连续命中数；
 * - secTargetId / secLoad：次级束当前绑定目标 id（0 = 无绑定/未持第二闪光）与其连续命中数；
 * - coordCounts：协同计数（目标 id 字符串键 → 命中数；活跃至多两份，随束绑定增删）。
 */
export interface HeatBeamCounters {
  mainTargetId: number;
  mainLoad: number;
  secTargetId: number;
  secLoad: number;
  coordCounts: Record<string, number>;
}

/** 计数器 meta 键前缀（按 weaponId 分键）。 */
const STATE_KEY_PREFIX = 'heat_beam_state:';
/** VFX meta 键前缀（按 weaponId 分键，与视图层 fx.ts 的 HEAT_BEAM_VFX_PREFIX 一致）。 */
const VFX_KEY_PREFIX = 'heat_beam_vfx:';

/** 灼热光束自身武器 id（协同齐射遍历时跳过）。 */
const HEAT_BEAM_WEAPON_ID = 'heat_beam';

/** 灼烧逐实例覆盖的燃烧每跳伤害（任务锁定的小值；效果表默认 3）。 */
const SCORCH_BURN_DPT = 2;

/** VFX 留存时长 ms：视图在 untilMs 前渲染光束（任务锁定，表现常量非平衡数值）。 */
const VFX_TTL_MS = 80;

// —— 协同开火触发特效（G6，视图消费约定见 fx.ts / mainScene.ts）——
// 单对象覆写式（同震波 sweep 共享单键风格）：同屏至多一个活跃触发脉冲，每次触发整对象
// 覆写，无滚动数组、无逐帧清理（两次触发间隔 ≥ 数秒，过期条目在下次触发前由视图按
// untilMs 跳过，内存占用为单个小对象）。

/** 协同开火触发 VFX 共享 meta 键（值为 CoordinatedFireVfx 单对象；与 src/phaser/fx.ts 导出的字面量一致）。 */
export const COORDINATED_FIRE_VFX_KEY = 'coordinated_fire_vfx';

/** 协同开火触发 VFX 留存时长 ms（表现常量非平衡数值；视图按「前 60% 扩散、后 40% 淡出」消费）。 */
export const COORDINATED_FIRE_VFX_MS = 350;

/** 协同开火触发 VFX 条目：触发目标坐标快照（写入瞬间的当前位置）+ 留存截止时刻（state.timeMs 时间轴）。 */
export interface CoordinatedFireVfx {
  x: number;
  y: number;
  untilMs: number;
}

/**
 * 不锁定组行为名（协同齐射时不接受强制指定目标、按各自正常逻辑发动）：
 * 霰弹固定朝上扇形、震波壁垒对整条墙线带结算；门槛判定见 passesGate。
 */
const NON_LOCKING_BEHAVIORS: Record<string, boolean> = {
  scatter_shot: true,
  seismic_pulse: true,
};

/** 读可选数值键：stats 索引签名对缺失键运行时返回 undefined，显式兜底为 0。 */
function numOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// —— 全武器定义表（协同齐射用；core 层唯一的数据加载层依赖，见文件头「分层说明」） ——
// 懒加载 + 模块级缓存：defs 表为静态只读数据，进程内加载一次。
let defsCache: Record<string, WeaponDef> | null = null;
function weaponDefs(): Record<string, WeaponDef> {
  if (!defsCache) {
    defsCache = loadWeaponDefs();
  }
  return defsCache;
}

/** 取（懒初始化）某武器的计数器 meta 条目。 */
function getCounters(state: SimState, weaponId: string): HeatBeamCounters {
  const key = STATE_KEY_PREFIX + weaponId;
  let c = state.meta[key] as HeatBeamCounters | undefined;
  if (!c || typeof c !== 'object' || !c.coordCounts || typeof c.coordCounts !== 'object') {
    c = { mainTargetId: 0, mainLoad: 0, secTargetId: 0, secLoad: 0, coordCounts: {} };
    state.meta[key] = c;
  }
  return c;
}

/** 只读读取某武器的计数器 meta 条目（不懒初始化：无目标路径绝不创建计数器条目）。 */
function peekCounters(state: SimState, weaponId: string): HeatBeamCounters | undefined {
  return state.meta[STATE_KEY_PREFIX + weaponId] as HeatBeamCounters | undefined;
}

/**
 * 按 id 查找存活敌人（G2b 粘性锁定的绑定解析）：锁定不持久持有敌人引用，每次 fire 按
 * meta 里的绑定 id 现查（core 从不把尸体移出 state.enemies，外层清理也保序——以 !dead
 * 判活即可）；已死亡/不存在 → null（触发死亡重选）。
 */
function findAliveEnemyById(state: SimState, id: number): Enemy | null {
  const enemies = state.enemies;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e.dead && e.id === id) {
      return e;
    }
  }
  return null;
}

/**
 * 主束目标解析（G2b 粘性锁定）：上次绑定的主束目标仍存活 → 无条件继续锁定（即使被击退/
 * 黑洞等移出 lockRange 也照打）；已死亡/无绑定 → findTarget 四级优先级重选（无候选 → null =
 * 「无目标」：不开火、冷却归 0）。
 */
function resolveMainTarget(
  state: SimState,
  weaponId: string,
  findOpts: FindTargetOpts,
): Enemy | null {
  const prevId = peekCounters(state, weaponId)?.mainTargetId ?? 0;
  if (prevId !== 0) {
    const bound = findAliveEnemyById(state, prevId);
    if (bound) {
      return bound; // 粘性：目标存活就持续锁定，出程照打
    }
  }
  return findTarget(state, findOpts); // 死亡重选 / 首次锁定
}

/**
 * 次级束目标解析（G2b 粘性锁定 + 避开主束规则保持）：自己的绑定目标存活且非主束目标 →
 * 保持（粘性）；绑定死亡、无绑定、或处于「回打主束」的回退态（绑定 = 主束目标）→ 按四级
 * 优先级排除主束目标重选；排除后无候选 → 回退改打主束目标（既有约定）。
 */
function resolveSecTarget(
  state: SimState,
  counters: HeatBeamCounters,
  main: Enemy,
  findOpts: FindTargetOpts,
): Enemy {
  const prevId = counters.secTargetId;
  if (prevId !== 0 && prevId !== main.id) {
    const bound = findAliveEnemyById(state, prevId);
    if (bound) {
      return bound; // 粘性：自己的目标存活就持续锁定（且避开主束目标）
    }
  }
  return findTarget(state, { ...findOpts, excludeId: main.id }) ?? main;
}

/** dot 频率（dot_freq 牌，requiresCard=scorch）：灼烧 tick 间隔 ÷ stats.dotTickMult
 *  （cards 注入 = 1.3^张数；mult<=1 返回 0 = 不覆盖，避免把效果表定义值钉死进实例 data）。 */
function scorchTickOverride(stats: WeaponStats): number {
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

/** 协同计数 +1（每束每跳命中一次）。 */
function advanceCoord(counters: HeatBeamCounters, id: number): void {
  const key = String(id);
  counters.coordCounts[key] = (counters.coordCounts[key] ?? 0) + 1;
}

/**
 * 协同齐射门槛：触发目标在该武器的索敌范围内。
 * scatter_shot = effRange（projectileSpeed × ttlMs / 1000）内；seismic_pulse = 目标在其行进波
 * 可达范围内（|y − wallLineY| ≤ waveDistance + bandDepth：行进距离 + 波前厚度判定外沿——
 * F3 行进波语义，与该行为 fire 开火门槛同一几何，波前最终会扫到其位置；stats 为该武器
 * 当前真实数值）；其余（rail_piercer / prism / charge_sniper / homing_missile / mortar）
 * 全场索敌恒真。
 */
function passesGate(state: SimState, behaviorName: string, stats: WeaponStats, target: Enemy): boolean {
  if (behaviorName === 'scatter_shot') {
    const effRange = numOr0(stats.projectileSpeed) * (numOr0(stats.ttlMs) / 1000);
    if (!(effRange > 0)) {
      return false;
    }
    return distSq(state.character, target) <= effRange * effRange;
  }
  if (behaviorName === 'seismic_pulse') {
    const reach = numOr0(stats.waveDistance) + numOr0(stats.bandDepth);
    return Math.abs(target.y - state.layout.wallLineY) <= reach;
  }
  return true;
}

/**
 * 触发一次协同齐射：遍历 fire 开始时的 weaponStates 键快照（防迭代中新增键），对其他所有
 * 已拥有武器按门槛过滤后真实发动（不锁定组正常 fire / 强制锁定组传 forcedTarget）；
 * 空转（调用前 cooldownMs ≠ 0 且调用后 == 0）恢复快照冷却。触发目标在齐射中途死亡 →
 * 终止剩余齐射。灼热光束自身跳过：协同判定只存在于本行为 fire 内 → 天然防递归。
 */
function triggerCoordinatedVolley(state: SimState, triggerTarget: Enemy, keySnapshot: string[]): void {
  const defs = weaponDefs();
  for (let i = 0; i < keySnapshot.length; i++) {
    const wid = keySnapshot[i];
    if (wid === HEAT_BEAM_WEAPON_ID) {
      continue; // 灼热光束自身跳过
    }
    if (triggerTarget.dead) {
      break; // 目标已被先结算的武器击杀：后续武器无从锁定，终止剩余齐射
    }
    const def = defs[wid];
    const ws = state.weaponStates[wid];
    if (!def || !ws) {
      continue; // 数据表缺失 / ghost 条目：跳过
    }
    const stats = getWeaponStats(def, state, wid); // 齐射用各武器当前真实 stats（缓存契约：只读）
    if (!passesGate(state, def.behavior, stats, triggerTarget)) {
      continue; // 前置门槛未过：该武器本次不参与
    }
    const behavior = getBehavior(def.behavior);
    const cooldownBefore = ws.cooldownMs;
    if (NON_LOCKING_BEHAVIORS[def.behavior]) {
      behavior.fire(state, wid, stats); // 不锁定组：按各自正常逻辑发动
    } else {
      behavior.fire(state, wid, stats, triggerTarget); // 强制锁定组：以触发目标走真实 fire
    }
    if (ws.cooldownMs === 0 && cooldownBefore !== 0) {
      ws.cooldownMs = cooldownBefore; // 空转恢复：不影响被触发武器的冷却与索敌节奏
    }
  }
}

export const behavior: WeaponBehavior = {
  name: 'heat_beam',

  /**
   * 每 tick 开火（G2b 粘性锁定）：上次绑定的主束目标存活 → 无条件继续锁定（出程照打）；
   * 死亡/无绑定 → 四级优先级在 lockRange 内重选（无候选 = 「无目标」→ 冷却归 0、不写任何
   * 状态）。持第二闪光时次级束同粘性规则（自己的目标存活且非主束目标 → 保持；否则排除
   * 主束目标重选，无候选 → 主束目标）。两束同 tick 各结算一跳：伤害按各束当前加载层数 →
   * 灼痕附着（幸存目标）→ 该束加载 +1 → 协同计数推进；换绑定目标只清该束自己的加载计数、
   * 作废不再被瞄准目标的协同计数（先作废后推进；换目标只发生在死亡重选路径）。任一目标
   * 协同计数达阈值（主束目标先判、一跳至多一次）→ 以它触发协同齐射并归零；触发瞬间写
   * 协同 VFX（coordinated_fire_vfx 单键覆写，G6）+ 一次性 'coordinated' 音效。
   * 最后写 VFX meta（段序 = [主束, 次级束?]，从角色连到各自目标——出程目标照常延伸）。
   */
  fire(state, weaponId, stats) {
    const lockRange = numOr0(stats.lockRange);
    const findOpts = {
      preferBoss: true,
      preferFast: true,
      fastSpeedThreshold: numOr0(stats.fastSpeedThreshold),
      maxRange: lockRange,
    };

    const main = resolveMainTarget(state, weaponId, findOpts);
    if (!main) {
      const ws = state.weaponStates[weaponId];
      if (ws) {
        ws.cooldownMs = 0; // 归 0：解释器随后 += interval 推进节奏，本帧内不重复触发
      }
      return; // 无目标：不开火、不写 VFX、不建/不推进计数（绑定与计数跨空档保留，换目标才清）
    }

    const counters = getCounters(state, weaponId);

    // fire 开始时的 weaponStates 键快照（协同齐射迭代用，防迭代中新增键）。
    const keySnapshot = Object.keys(state.weaponStates);

    const scorch = stats.scorch === 1;
    const scorchTickMs = scorch ? scorchTickOverride(stats) : 0;
    const loadFactor = numOr0(stats.loadFactor); // 加载牌注入 0.05；无牌缺失按 0
    const secFactor = numOr0(stats.secondaryDamageFactor); // 第二闪光牌注入 0.25
    const hasSec = stats.secondFlash === 1 && secFactor > 0;
    // 次级束目标（G2b 粘性 + 避开主束规则保持，见 resolveSecTarget）。
    const secTarget = hasSec ? resolveSecTarget(state, counters, main, findOpts) : null;

    // 协同计数作废（先于推进）：不再被任一束瞄准的目标计数删除
    // （某束换走且另一束不在打 / 目标已死亡；主束转锁次级束目标 → 该目标计数保留合流）。
    const keptIds = secTarget ? [main.id, secTarget.id] : [main.id];
    for (const id in counters.coordCounts) {
      if (keptIds.indexOf(Number(id)) === -1) {
        delete counters.coordCounts[id];
      }
    }

    const cx = state.character.x;
    const cy = state.character.y;
    const segments: HeatBeamSegment[] = [];
    const baseDamage = numOr0(stats.damage);

    // —— 主束：伤害（当前层数）→ 灼痕 → 加载 +1 → 协同 +1 ——
    segments.push({ x1: cx, y1: cy, x2: main.x, y2: main.y });
    if (counters.mainTargetId !== main.id) {
      counters.mainTargetId = main.id;
      counters.mainLoad = 0; // 换目标：只清主束自己的加载计数
    }
    dealDamage(state, main, baseDamage * (1 + loadFactor * counters.mainLoad), weaponId);
    if (scorch && !main.dead) {
      applyEffect(
        state,
        main,
        'burn',
        scorchTickMs > 0
          ? { damagePerTick: SCORCH_BURN_DPT, tickMs: scorchTickMs }
          : { damagePerTick: SCORCH_BURN_DPT },
        weaponId,
      );
    }
    counters.mainLoad += 1;
    advanceCoord(counters, main.id);

    // —— 次级束（持第二闪光牌）：同 tick 发射、同频率；伤害 = 主束式 × 25%，加载独立 ——
    if (secTarget) {
      segments.push({ x1: cx, y1: cy, x2: secTarget.x, y2: secTarget.y });
      if (counters.secTargetId !== secTarget.id) {
        counters.secTargetId = secTarget.id;
        counters.secLoad = 0; // 换目标：只清次级束自己的加载计数
      }
      dealDamage(state, secTarget, baseDamage * (1 + loadFactor * counters.secLoad) * secFactor, weaponId);
      if (scorch && !secTarget.dead) {
        applyEffect(
          state,
          secTarget,
          'burn',
          scorchTickMs > 0
            ? { damagePerTick: SCORCH_BURN_DPT, tickMs: scorchTickMs }
            : { damagePerTick: SCORCH_BURN_DPT },
          weaponId,
        );
      }
      counters.secLoad += 1;
      advanceCoord(counters, secTarget.id);
    }

    // VFX（视图消费；只写 meta 不碰视图文件）。段序 = [主束, 次级束?]。
    const vfx: HeatBeamVfx = { segments, untilMs: state.timeMs + VFX_TTL_MS };
    state.meta[VFX_KEY_PREFIX + weaponId] = vfx;

    // —— 协同开火触发：主束目标先判、次级束目标后判，一跳内至多一次（先到先触发） ——
    const threshold = numOr0(stats.coordinatedThreshold);
    if (stats.coordinatedFire === 1 && threshold > 0) {
      const candidates = secTarget && secTarget.id !== main.id ? [main, secTarget] : [main];
      for (let i = 0; i < candidates.length; i++) {
        const cand = candidates[i];
        if (cand.dead) {
          continue; // 尸体无对象可锁：不触发（其计数待下次 fire 作废）
        }
        const count = counters.coordCounts[String(cand.id)] ?? 0;
        if (count >= threshold) {
          counters.coordCounts[String(cand.id)] = 0; // 归零重新累计
          // 表现反馈（G6）：触发瞬间写协同 VFX（单对象覆写，坐标 = 触发目标当前位置）+
          // 推一次性 'coordinated' 音效（不节流，与 crit/execute 同约定；在齐射前入队 →
          // 音序为「蓄势-齐发」先于齐射枪声）。不写的场景：门槛未达（本分支未进）、
          // 空转（无目标不开火的提前 return / 未持协同牌）、目标在本跳已死亡（上方
          // cand.dead continue 不触发）。写入时机 = 触发本身：齐射中途目标被先结算的
          // 武器击杀终止不回滚本条目——视图随 untilMs 自然过期，无需特判（用户要求
          // 感知的「协同」一刻即触发时刻，齐射致死恰是玩家最该看到脉冲的情形）。
          const vfx: CoordinatedFireVfx = {
            x: cand.x,
            y: cand.y,
            untilMs: state.timeMs + COORDINATED_FIRE_VFX_MS,
          };
          state.meta[COORDINATED_FIRE_VFX_KEY] = vfx;
          pushEvent(state, { kind: 'sfx', name: 'coordinated' });
          triggerCoordinatedVolley(state, cand, keySnapshot);
          break; // 一跳内至多一次协同齐射
        }
      }
    }
  },
};
