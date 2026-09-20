// src/core/behaviors/behavior_chargeSniper.ts —— 蓄能狙击：长蓄力周期（长间隔单发高伤）、
// 目标优先级制导的高速弹。目标优先级（fire 时锁定，T5.2a 起为四级）：
//   ① isBoss（多个取最近）→ ② attack 怪（贴墙、正在打墙的高威胁层，取最近）→
//   ③ speed ≥ fastSpeedThreshold 的快速怪（取最近）→ ④ 最近敌人；
// ② 层为用户反馈修复：贴墙怪正在对墙造成真实伤害，必须被常规覆盖，不得被快速怪优先级
// 饿死。移动预测：击发瞬间对锁定目标 leadAim 解提前量（1600px/s 弹 vs 行军怪），主目标
// 必中；弹飞出后直线推进、无二次瞄准。无存活敌人不开火，且该武器 cooldownMs 归 0
// （解释器随后 += interval 推进节奏，下帧重试）。
//
// 牌池重构（任务三，锁定）：多射/连射/分裂三张通用牌不再适用狙击（cards.json applyTo 移除），
// 行为层对应的扇形展开、连射调度（scheduleBurstWaves / update 消费）、命中分裂、命中减速
// 全部删除——本行为恒单发（fireVolley 只 spawn 一枚）。专属牌保留：贯穿弹（pierce_shot）、
// 斩首（headshot）、处决强化（execute_up）；新增三张一次性专属牌：
//
// - 爆头（crit_shot）：每次命中实例（每弹每敌）独立掷点，15% 概率造成 550% 伤害。
//   掷点走第二独立随机流（simState.getBattleRng：种子 = 会话种子 XOR 0x9E3779B9 的固定
//   LCG），绝不消费 state.rng——升级三选一 / 开局武器抽取 / 修复包判定等主随机流序列零
//   扰动，同种子全程可复现。判定点在 onProjectileHit（框架已在命中点结算基础伤害）：
//   判中 → 追加结算一次 dealDamage，追加量按命中点受伤乘区折算为「实际结算值恒 =
//   弹伤 × (爆头倍率 − 1)」——首次命中（mark 恰在基础结算后附着）总伤精确 = 弹伤 × 倍率，
//   与斩首乘区（已在 fire 时乘进弹伤）叠乘语义精确成立。
// - 死刑宣告（execution_order）：本武器的任何一次击杀，该次击杀经验 ×xpFactor
//   （补充轮 H2 扩展后语义；一次死亡只放大一次，三条路径互斥天然不叠加）：
//   ① 基础命中直接击杀（含边境折返多次命中中的任何一次）——onProjectileHit 入口检测
//      enemy.dead（死亡必因本命中实例的基础 dealDamage，论证见函数内注释），直接补加
//      经验差额 enemy.xp × (xpFactor − 1)（净效果与临时 killHook 等价）；
//   ② 爆头追伤击杀——爆头 dealDamage 前挂临时 killHook（链尾、按敌人身份过滤、
//      finally 移除）放大；
//   ③ 处决阈值击杀——目标存活且 hp < 20% maxHp（isBoss 时 7%，严格小于）→ 致命
//      dealDamage 走正常死亡/事件/killHooks 路径并以临时 killHook 放大（原有语义不变）。
//   互斥性：一次死亡只由第一个把 hp 打到 ≤0 的 dealDamage 造成——基础命中致死则爆头/
//   处决分支被尸体短路 return；爆头致死则处决分支被短路；处决只在目标仍存活时触发，
//   因此同一次死亡至多被放大一次。②③ 复用 dealDamageWithKillXpBonus 的临时 killHook
//   实现。覆盖范围：主弹、边境折返多次命中、以及被灼热光束【协同开火】强制触发的狙击
//   齐射（forcedTarget 只改目标选择，弹仍由本行为 spawn，命中钩子照常生效）。
// - 边境折返（border_ricochet）：命中计数 = 1 + 2×贯穿弹张数（stats.pierce = base 0 +
//   2/张，恰为 2×张数），发射时以 pierceLeft 快照进弹（框架穿透路径天然满足：每次命中
//   −1、归零的那次命中结算完后就地销毁）；撞地图边缘必反弹、不消耗计数——镜面反射在
//   update 钩子做（解释器的武器钩子先于弹丸位移执行：扫描本行为弹，判断「下一帧位移将
//   越界且速度朝向该边缘」则翻转垂直分量并把位置钳回界内）。边缘：上 y ≤ 0、左 x ≤ 0、
//   右 x ≥ layout.width、下 = 墙线 y ≥ layout.wallLineY；计数归零即销毁 → 飞行中的弹
//   计数必然 ≥1，不存在「计数为 0 撞边」。
//   补充轮 H1 取消 ttl 封顶：持牌发射的弹 ttlMs = Infinity（语义常量，见 fireVolley 注释）
//   ——命中计数不耗尽就不会消失，反弹飞行直至计数耗尽那一次命中结算完销毁；未持牌的弹
//   （含普通弹、未选该牌时的所有弹）ttl 1200ms 完全不变。边界：计数 1（0 张贯穿弹）的弹
//   仍首个命中即毁；空场极端下未命中弹会一直反弹累积，由 maxProjectiles=600 全局护栏
//   （帧首按最小 id 回收）兜底。
//   反射只在行为的 update 钩子做而弹丸位移在 updateProjectiles（session 钩子序 ⑤→⑥），
//   故反射判定用的是「本帧将要发生的位移」，弹不会先于反射越界飞走。
//
// 效果槽：effectsOnHit 恒带 mark 模板（命中可标记，标记在伤害结算之后附着——首发不享受
// 加成）；旧命中减速（slowHit/SLOW_TEMPLATE）随牌删除而删除。
// 乘区语义（锁定，测试对齐）：proj.damage = stats.damage × headshotMult(触发时)。
//   - headshot（斩首牌 headshot=1）：开火瞬间目标 hp ≥ headshotHpFactor × maxHp
//     （高血目标）→ ×headshotMultiplier；残血目标不增伤；处决强化牌（execute_up）对
//     headshotMultiplier +0.25/张（可重复）。
// 表现反馈（优化轮 G5）：爆头判中 / 死刑宣告触发时向 meta 写 VFX 条目（照 PRISM_ZAP 模式：
// { x, y, untilMs } 滚动数组、写入时过滤过期、长度上限 16 防刷屏）并推一次性 sfx 事件
// （'crit' / 'execute'，不节流——两者都是稀有一次性反馈，非高频 hit/shoot）。模拟层只写
// 纯数据（坐标 + 截止时刻），视图消费见 fx.ts / mainScene.ts；零随机（表现写入挂在确定性
// 的判定点上，不引入任何新随机）。不做震屏（用户明确要求）。
// 数值契约：全部数值来自 weapons/charge_sniper.json；几何量（弹丸半径）允许硬编码。
// 随机契约：fire/update 全程零随机；唯一战斗期随机是爆头掷点（独立随机流，见上）。
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
export const SNIPER_CRIT_VFX_MS = 200;

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
 * 弹上 data 快照：爆头/死刑宣告所需数值随弹走（命中钩子拿不到 stats，从弹上读回；
 * 升级瞬间已飞行的旧弹按发射时数值结算）。开关键为 0 时命中钩子对应段直接短路。
 */
function projectileData(stats: WeaponStats): Record<string, number> {
  return {
    border: opt(stats, 'borderRicochet') === 1 ? 1 : 0,
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
 * 带击杀经验放大的统一伤害结算（H2，爆头致死/处决两条路径共用）：
 * amount 走 dealDamage 正常路径（正常死亡/事件/killHooks）；若目标因此次伤害死亡，
 * 临时 killHook（链尾、按敌人身份过滤、finally 移除）追加 enemy.xp × (xpBonusRatio)
 * ——击杀总经验 = enemy.xp × xpFactor 且只放大这一次（绝不影响其他击杀；临时钩子恒在
 * 链尾，先注册的 onEnemyKilled/Boss 奖励钩子照常先行）。xpFactor ≤ 1（脏数据/未持牌
 * 快照为 0）→ 不放大，仍正常结算。
 */
function dealDamageWithKillXpBonus(state: SimState, enemy: Enemy, amount: number, xpFactor: number): void {
  const xpBonusRatio = xpFactor - 1;
  if (!(xpBonusRatio > 0)) {
    dealDamage(state, enemy, amount);
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
    dealDamage(state, enemy, amount);
  } finally {
    const idx = killHooks.indexOf(hook);
    if (idx !== -1) {
      killHooks.splice(idx, 1);
    }
  }
}

/**
 * 处决击杀（死刑宣告命中点判定通过后调用）：致命 dealDamage 走统一伤害入口
 * （正常死亡/事件/killHooks 路径）；金额 = 当前 hp × 1000（保险常数：mark/corrode 等
 * 受伤乘区为有限正数，任何情形下都致命）；该次击杀经验 ×xpFactor（H2 路径③，
 * 复用 dealDamageWithKillXpBonus 的临时 killHook 放大）。
 */
function executeKill(state: SimState, enemy: Enemy, xpFactor: number): void {
  dealDamageWithKillXpBonus(state, enemy, enemy.hp * 1000, xpFactor);
}

/**
 * 发射一发（恒单发）：四级优先级锁定目标 → leadAim 提前量 → 从角色向预测点方向发射。
 * 无存活目标 → 返回 false（fire 据此写冷却归 0）。forcedTarget（可选，灼热光束协同开火
 * 强制指定）：以它覆盖 pickTarget——以它为目标射出，斩首判定/提前量/命中钩子等内部
 * 逻辑照常。
 */
function fireVolley(state: SimState, _weaponId: string, stats: WeaponStats, forcedTarget?: Enemy): boolean {
  const target = forcedTarget ?? pickTarget(state, stats);
  if (!target) {
    return false;
  }

  // 伤害快照：乘区顺序 base → 爆头（高血判定）。
  let damage = stats.damage;
  if (opt(stats, 'headshot') === 1 && target.hp >= opt(stats, 'headshotHpFactor') * target.maxHp) {
    damage *= opt(stats, 'headshotMultiplier');
  }

  const aim = leadAim(state.character, target, stats.projectileSpeed, state.layout.wallLineY);
  const ang = Math.atan2(aim.y - state.character.y, aim.x - state.character.x);
  const border = opt(stats, 'borderRicochet') === 1;
  // 穿透/命中计数快照：边境折返 = 1 + 2×贯穿弹张数（stats.pierce = base 0 + 2/张，
  // 恰等于 2×张数）；无边境折返 = 旧贯穿语义（pierceShot 开关 → stats.pierce；否则 0
  // 单发即亡）。
  const pierceLeft = border
    ? 1 + Math.max(0, stats.pierce)
    : opt(stats, 'pierceShot') === 1
      ? stats.pierce
      : 0;

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
    // H1 取消 ttl 封顶：持边境折返的弹 ttlMs = Infinity——语义常量（非数据表数值）：
    // updateProjectiles 的 ttlMs -= dtMs 保持 Infinity、ttl <= 0 恒假，弹不再有寿命上限，
    // 生命周期完全由命中计数驱动（计数耗尽那一次命中结算完就地销毁）。未持边境折返的弹
    // （含普通弹、未选该牌时的所有弹）ttl 1200ms 完全不变。核查记录：ttlMs 不参与任何
    // 序列化/排序（maxProjectiles 回收按最小 id 而非 ttl），唯一消费点是 ttl <= 0 死亡
    // 判定与「ttl > 0 可回收」护栏候选判定——Infinity 对两者语义正确；空场极端下未命中
    // 弹会一直反弹累积，由 maxProjectiles=600 护栏兜底回收。
    ttlMs: border ? Number.POSITIVE_INFINITY : stats.ttlMs,
    effectsOnHit: [MARK_TEMPLATE], // 恒带 mark（可标记）
    data: projectileData(stats),
  });
  return true;
}

/**
 * 边境折返镜面反射（update 钩子每帧调用，先于弹丸位移）：
 * 扫描本行为的边境折返弹，对「下一帧位移将越过边缘且速度朝向该边缘」的轴翻转垂直速度
 * 分量并把位置钳回界内（镜面反射，不消耗命中计数）。速度朝向守卫的必要性：角色
 * (y = height − 60) 位于墙线（wallLineY）下方，弹出生时在墙线以南上行——下边缘反射
 * 只对「向下撞线」生效，上行穿越不受影响；严格不等号 + 钳位保证钳位帧后速度必然向内，
 * 零长帧（dt=0）不会误翻转、无逐帧抖动。计数归零即销毁 → 飞行中的弹计数必然 ≥1，
 * 不存在「计数为 0 撞边」。持边境折返的弹无 ttl 到期（H1，见 fireVolley 注释）——反射
 * 可无限次发生直至计数耗尽；未持牌弹无 border 快照、不进本扫描（ttl 1200ms 照旧）。
 */
function reflectBorderRicochets(state: SimState, dtMs: number): void {
  if (!(dtMs > 0)) {
    return; // 零长帧无位移：不判定
  }
  const width = state.layout.width;
  const wallLineY = state.layout.wallLineY;
  const dtSec = dtMs / 1000;
  const projectiles = state.projectiles;
  for (let i = 0; i < projectiles.length; i++) {
    const p = projectiles[i];
    if (p.dead || p.behavior !== 'charge_sniper' || p.data.border !== 1) {
      continue;
    }
    const nx = p.x + p.vx * dtSec;
    const ny = p.y + p.vy * dtSec;
    // 左右边缘（每轴独立判定：角点同帧双反射合法）。
    if (nx < 0 && p.vx < 0) {
      p.x = 0;
      p.vx = -p.vx;
    } else if (nx > width && p.vx > 0) {
      p.x = width;
      p.vx = -p.vx;
    }
    // 上边缘 / 下边缘（墙线）。
    if (ny < 0 && p.vy < 0) {
      p.y = 0;
      p.vy = -p.vy;
    } else if (ny > wallLineY && p.vy > 0) {
      p.y = wallLineY;
      p.vy = -p.vy;
    }
  }
}

export const behavior: WeaponBehavior = {
  name: 'charge_sniper',

  /**
   * 蓄力完毕的击发（intervalMs 即蓄力周期，由解释器按冷却节奏调用）：发射一发
   * （见 fireVolley）；无目标 → 冷却归 0（重试标记）。forcedTarget 为协同开火强制指定
   * 目标（灼热光束【协同开火】触发齐射时传入，死刑宣告/爆头在该路径照常生效）。
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
   * 每帧钩子（先于弹丸位移执行，见 reflectBorderRicochets 注释）：边境折返镜面反射。
   */
  update(state, dtMs) {
    reflectBorderRicochets(state, dtMs);
  },

  /**
   * 命中点钩子（框架在 dealDamage + effectsOnHit 附着之后、穿透消耗之前调用，每次命中
   * 实例一次）：① 基础命中直接击杀（H2 路径①）——目标已 dead 时补加经验差额，该次
   * 击杀经验 ×1.25；② 爆头——独立随机流掷点，判中追加结算弹伤 ×(倍率−1) 的伤害（见
   * 文件头折算说明），与斩首乘区叠乘，持死刑宣告时追伤致死同样放大该次击杀经验（H2
   * 路径②），判中同时写金色星芒环 VFX + 一次性 'crit' 音效（G5）；③ 死刑宣告——目标
   * 存活且 hp < 20% maxHp（Boss 7%）→ 处决击杀，该次击杀经验 ×1.25（H2 路径③），
   * 触发时写暗红竖贯斩线 VFX + 一次性 'execute' 音效（G5，不做震屏）。三段判定对本武器
   * 一切伤害实例生效（主弹/边境折返多次命中/协同齐射强制触发的弹）；一次死亡只放大一次
   * （见文件头互斥性论证）。
   */
  onProjectileHit(state, proj, enemy) {
    const d = proj.data;
    if (enemy.dead) {
      // H2 路径①：基础命中直接击杀。死亡必因本命中实例的基础 dealDamage——
      // settleSweptHits 对已 dead 敌人跳过命中（本钩子不会被旧尸体触发），命中实例内
      // dealDamage 之后的 effectsOnHit 附着只挂效果、不即时扣血；故钩子入口的 dead
      // 唯一来源是基础命中致死。此处直接补加经验差额 enemy.xp × (xpFactor − 1)：
      // 净效果 = 该次击杀经验 ×xpFactor，与临时 killHook 等价（临时钩子若能在基础
      // dealDamage 前挂载，也只会作为链尾钩子在 onEnemyKilled/Boss 奖励之后结算，
      // 补加时点完全一致——基础 dealDamage 在框架层先于本钩子执行，无法前置挂载，
      // 见函数头与文件头说明）。无双重放大：目标已 dead，下方爆头/处决分支被本
      // return 短路（处决前提即目标存活）。
      if (dataNum(d, 'execReady') === 1) {
        const xpFactor = dataNum(d, 'execXpFactor');
        if (xpFactor > 1) {
          state.progress.xp += enemy.xp * (xpFactor - 1);
          checkLevelUp(state);
        }
      }
      return; // 尸体不再判定爆头/处决
    }

    // ① 爆头：每次命中实例独立掷点（第二独立随机流，绝不消费 state.rng）。
    if (dataNum(d, 'critReady') === 1) {
      const chance = dataNum(d, 'critChance');
      const mult = dataNum(d, 'critMult');
      if (chance > 0 && mult > 1 && getBattleRng(state).next() < chance) {
        // 表现反馈（G5）：星芒环 VFX + 一次性音效（掷点判中即写，与后续伤害结算无关）。
        pushSniperHitVfx(state, SNIPER_CRIT_VFX_KEY, enemy.x, enemy.y, SNIPER_CRIT_VFX_MS);
        pushEvent(state, { kind: 'sfx', name: 'crit' });
        // 追加量按命中点受伤乘区折算：实际结算值恒 = 弹伤 × (mult − 1)，
        // 首次命中（mark 恰在基础结算后附着）总伤精确 = 弹伤 × mult。
        const factor = damageTakenFactor(enemy);
        const bonus = factor > 0 ? (proj.damage * (mult - 1)) / factor : proj.damage * (mult - 1);
        // H2 路径②：爆头追伤致死同样放大该次击杀经验（临时 killHook，与处决共用
        // 实现）；未持死刑宣告时弹上 execXpFactor 快照为 0 → 退化为普通 dealDamage。
        dealDamageWithKillXpBonus(state, enemy, bonus, dataNum(d, 'execXpFactor'));
        if (enemy.dead) {
          return; // 爆头已击杀：尸体不再判定死刑宣告
        }
      }
    }

    // ② 死刑宣告：hp < 20% maxHp（isBoss 时 7%），严格小于；处决走正常死亡路径。
    if (dataNum(d, 'execReady') === 1) {
      const factor = enemy.isBoss ? dataNum(d, 'execBossFactor') : dataNum(d, 'execFactor');
      if (factor > 0 && enemy.hp < factor * enemy.maxHp) {
        // 表现反馈（G5）：斩杀 VFX + 一次性音效（触发即写；不做震屏——用户明确要求）。
        pushSniperHitVfx(state, SNIPER_EXECUTE_VFX_KEY, enemy.x, enemy.y, SNIPER_EXECUTE_VFX_MS);
        pushEvent(state, { kind: 'sfx', name: 'execute' });
        executeKill(state, enemy, dataNum(d, 'execXpFactor'));
      }
    }
  },
};
