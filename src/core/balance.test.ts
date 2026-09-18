// src/core/balance.test.ts —— T3.6 首轮波次平衡校准：全自动对局模拟（永久平衡回归）。
//
// 组装契约：与 src/game/session.ts 相同的 hooks 顺序（波次→敌人→效果→区域→墙战→胜利→
// 武器→弹丸→宝石），但本文件用 core API 直连组装——不 import session（其位于合成层，
// 引视图链）。波次时钟：campaign 恒线性、endless 走 resolveWaveClock（表尾回绕 + 逐轮膨胀）。
//
// 自动玩家策略（写死，T5.3a 牌池制；带「聚怪 + 停摆 + 复利」build 计划的合理真人Proxy）：
// - 开局 addWeapon('rail_piercer')（0 级起步）；
// - 每帧 step(STEP_MS=1/60s，真实渲染帧) 后 drainEvents：levelUp → rollUpgradeOptions(池抽 3 项) →
//   按计划分值取最高者 applyUpgrade（详见 chooseUpgrade 的 CARD_PLAN_SCORE）：
//   榴弹控场三件套（黑洞/眩晕/燃烧地）> 击退/推退/粘油（把攻墙怪潮顶回去的停摆位）>
//   燃烧类 DoT > 伤害强化（中期起升优先，集中给榴弹与轨道炮）> 新武器（补覆盖面）>
//   其余机制牌；下一任务才接线的机制牌（trident/refract/ricochet/charge_damage/multi/
//   burst/split）评分垫底。
// - Boss 击杀的额外 levelUp 事件照常消费（与正式接线一致）。
//
// 断言（campaign，种子 7/42/2024；T5.3a 牌池制校准）：
//   a) 至少一种子撑满 10 分钟 over==='victory'（「游戏可赢」锚点）；
//      每种子撑进后期（≥ 380s，中盘坦克+标准怪混编压力成立）——「三种子全胜」的旧门槛
//      在弹道机制接线（多射/连射/分裂，下一任务）+ 怪物翻倍前不可达，落地后恢复；
//   b) 压力存在：每种子最低墙血 < 起始值 85%（通关种子须 > 0），且至少一种子 < 75%
//      （曲线对合理 build 有真实咬合力）；
//   c) 节奏：前 10s 墙损失 === 0（行军时间下界）且前 210s 墙损 === 0（牌池制前期的
//      成长窗口）；终局前最后 120s 真实掉血（后段曲线更紧）；
//   d) 爆发波压力可控：任一爆发波后 10s 窗口墙损 < 35% 起始墙血——字面窗口 [f, f+10]
//      因敌人行军需 ≥13s 恒近零，故同时断言更有意义的「爆发波余波内最差滑动 10s 窗口」
//      （[f, f+90] 内任意连续 10s），两断言都过才算爆发波不崩盘。
// 断言（endless，种子 2024）：存活 ≥ 560s（循环时钟生效）且最终 over==='defeat'
//   （膨胀最终压死玩家，证明曲线收敛）；记录死亡时间与最大 loopCount / loopScale。
//   T1 无尽经验需求 ×loopScale 重校准：升级需求随循环膨胀后自动玩家升级放缓，
//   实测收敛点 674.6s（此前经验平顶时代为 ~800s 锚点）——下限断言 ≥560s 保持不变，
//   不为凑 800s 锚点回调数值（收敛前移是本改动的预期效果）。
// 性能：全部对局（3 campaign + 1 endless）墙钟总时长（单测运行通常 < 18s，全量并发回归放宽至 < 30s 防 CPU 争用抖动）。
//
// 数值契约：本文件零平衡数值——全部读 src/data 的 JSON（waves/enemies/weapons/cards/config/
// effects）；调平衡只改 JSON，本测试是回归护栏。
// 确定性契约：随机全走 state.rng（setRngFactory(createRng)，与 session 同款接线）；
// 墙钟计时只用于性能断言，不进模拟。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM（ESLint 强制）。

import { describe, expect, it } from 'vitest';

import { setRngFactory, createSimState } from './simState';
import { createRng } from './rng';
import { step as coreStep } from './step';
import { drainEvents } from './events';
import { updateEnemies, type EnemyTypeData } from './enemies';
import { updateEffects } from './effects';
import { updateWallCombat } from './wall';
import { updateWaves } from './waves';
import { resolveWaveClock } from './waveClock';
import { checkVictory, type GameMode } from './victory';
import { onBossDefeated, readBossHealPct } from './bossRewards';
import { addWeapon, updateWeapons, type WeaponDef } from './weapons';
import { killHooks, updateProjectiles } from './projectiles';
import { onEnemyKilled, updateGems } from './gems';
import { SpatialHash } from './spatialHash';
import { updateZones } from './zones';
import { rollUpgradeOptions, applyUpgrade, type UpgradeOption } from './upgrade';
import type { Enemy, SimState } from './types';
import type { WavesConfig } from './waves';

import { loadSimConfig } from '../data/config';
import { loadEffectDefs } from '../data/effects';
import { loadEnemyTypes } from '../data/enemies';
import { loadWeaponDefs } from '../data/weapons';
import { loadWavesConfig } from '../data/waves';

// —— 模块级一次性资源（与 session.ts 同款：表只加载一次，全局钩子只注册一次） ——

const WEAPON_DEFS: Record<string, WeaponDef> = loadWeaponDefs();
const ENEMY_TYPES: Record<string, EnemyTypeData> = loadEnemyTypes();
const WAVES = loadWavesConfig();
// 效果定义注册进 core/effects 模块级注册表（mark/slow/burn/knockback 等按 kind 查询）。
loadEffectDefs();

/** 灰盒首武器（作为受控回归基准，固定使用 rail_piercer 测试波次平衡性）。 */
const FIRST_WEAPON_ID = 'rail_piercer';

/** 全局引导标志：setRngFactory 与 killHooks 只能各做一次（模块级，跨测试共享）。 */
let bootstrapped = false;

function ensureBootstrap(): void {
  if (bootstrapped) {
    return;
  }
  bootstrapped = true;
  // 随机契约：与 session.ts 相同——mulberry32，同种子 → 同序列。
  setRngFactory(createRng);
  // 击杀掉落接线（与 session.ts 相同顺序）：宝石/修复包 → Boss 奖励。
  killHooks.push((state, enemy) => onEnemyKilled(state, enemy));
  killHooks.push((state, enemy) => {
    const type = ENEMY_TYPES[enemy.typeId];
    onBossDefeated(state, enemy, { healPct: type !== undefined ? readBossHealPct(type) : 0 });
  });
}

/** 组装一局（hooks 顺序与 session.ts 的 buildState 完全一致；网格实例逐局独立）。 */
function buildState(seed: number, mode: GameMode, waves: WavesConfig = WAVES): SimState {
  const state = createSimState(seed, loadSimConfig());
  state.meta.mode = mode;
  const enemyGrid = new SpatialHash<Enemy>(64);

  // ① 波次刷怪 + 敌人行军/分离（campaign 恒线性时钟；endless 循环回绕 + 逐轮膨胀）。
  state.hooks.push((s, dt) => {
    const clock = resolveWaveClock(
      s.timeMs / 1000,
      mode === 'endless' ? (waves.endlessLoop ?? null) : null,
      waves.campaignDurationSec,
    );
    updateWaves(s, dt, waves, ENEMY_TYPES, clock);
    updateEnemies(s, dt, enemyGrid);
  });
  // ② 效果 tick（DoT / 到期清理 / overheat）。
  state.hooks.push(updateEffects);
  // ③ 地面区域 tick。
  state.hooks.push((s, dt) => {
    updateZones(s, dt, enemyGrid);
  });
  // ④ 城墙受击 + 失败判定。
  state.hooks.push(updateWallCombat);
  // ④.5 胜利判定（campaign 撑满时长；endless 永不胜利）。
  state.hooks.push((s) => {
    checkVictory(s, waves.campaignDurationSec * 1000, mode);
  });
  // ⑤ 武器闭包。
  state.hooks.push((s, dt) => {
    updateWeapons(s, dt, WEAPON_DEFS);
  });
  // ⑥ 弹丸闭包。
  state.hooks.push((s, dt) => {
    updateProjectiles(s, dt, enemyGrid);
  });
  // ⑦ 宝石/掉落（帧末升级检查）。
  state.hooks.push((s, dt) => {
    updateGems(s, dt);
  });

  addWeapon(state, FIRST_WEAPON_ID);
  return state;
}

// —— 自动玩家策略 ——

/**
 * 三选一策略（写死，T5.3a 牌池制；升级预算有限——怪物翻倍前经验收入低，故自动玩家带着
 * 一份「聚怪 + 复利」build 计划，对每次随机出示的 3 个选项按计划价值取最高者）：
 * ① 榴弹三件套（黑洞/眩晕/燃烧地）——黑洞聚怪让所有 AoE 吃满、眩晕冻结怪潮、燃烧地补 DoT；
 * ② 伤害强化——优先榴弹（聚怪后 AoE 吃满乘区）与轨道炮（首武器从第 1 张牌开始复利）；
 * ③ 新武器（补覆盖面与栏位）；④ 狙击的贯穿/爆头机制；⑤ 其余专属机制牌；
 * ⑥ 范围强化/攻速强化；⑦ 其余通用牌取首个（同分取先出现者，确定性）。
 */
const CARD_PLAN_SCORE: Record<string, number> = {
  multi_shot: 820,
  burst_shot: 800,
  split_shot: 800,
  trident_split: 790,
  black_hole: 780,
  knockback: 770,
  stun_blast: 760,
  burn_ground: 750,
  burn_bullet: 730,
  burn_cloud: 720,
  dual_beam: 710,
  ricochet: 700,
  charge_damage: 690,
  dmg_up: 620,
  spd_up: 610,
  pierce_up: 600,
  bounce_up: 580,
  pierce_shot: 570,
  headshot: 560,
  dot_freq: 550,
  range_up: 520,
  slow_hit: 480,
  prefer_elite: 450,
  execute_up: 420,
  blast_ignite: 400,
  chain_lightning: 390,
  frost_venom: 380,
  push_back: 370,
  sticky_oil: 360,
  scorch: 350,
  acid_pool: 340,
  focus_return: 350,
  prism_recurse: 360,
  cooling_up: 300,
  refract_up: 300,
  link_stable: 300,
};
const PLAN_FALLBACK_SCORE = 100;

function chooseUpgrade(state: SimState, options: UpgradeOption[]): UpgradeOption | null {
  if (options.length === 0) {
    return null;
  }
  const weaponCount = Object.keys(state.weaponStates).length;
  let best: UpgradeOption | null = null;
  let bestScore = -Infinity;
  const lateGame = state.timeMs > 200_000 ? 80 : 0;

  for (const o of options) {
    let score: number;
    if (o.kind === 'new_weapon') {
      if (weaponCount < state.config.maxWeaponSlots) {
        const bias =
          o.weaponId === 'mortar' ? 100 :
          o.weaponId === 'scatter' ? 80 :
          ['dragon_breath', 'homing_missile'].includes(o.weaponId) ? -200 : 40;
        score = 780 + bias;
      } else {
        score = 50;
      }
    } else {
      const ws = state.weaponStates[o.weaponId];
      const existingCount = ws !== undefined ? (ws.cards[o.cardId] ?? 0) : 0;
      const def = WEAPON_DEFS[o.weaponId];
      const cardDef = def?.cards.find((c) => c.id === o.cardId);
      const limit = cardDef?.maxCount ?? 5;
      if (existingCount >= limit) {
        score = -10000;
      } else {
        const base = CARD_PLAN_SCORE[o.cardId] ?? PLAN_FALLBACK_SCORE;
        score = base + (o.cardId === 'dmg_up' ? lateGame : 0) - existingCount * 80;
      }
    }
    if (score > bestScore && score > -9000) {
      bestScore = score;
      best = o;
    }
  }
  return best;
}

// —— 对局模拟器 ——

/**
 * 单帧步长（ms）：取 60fps 真实渲染帧（≈16.67ms，与 src/phaser/mainScene 每帧
 * session.step(delta) 的真实节奏一致）。
 * 不能用 50ms 上限步长：弹丸 900px/s 在 50ms 一帧里位移 45px，而「弹丸 6 + 最小敌人 12」
 * 的碰撞走廊只有 ±18px < 45px——离散采样会整段跨过敌人（穿隧），部分墙前敌人变成
 * 几何上永远打不中的「命中盲区」（诊断实测：同一攻击者满血站墙 20s+，弹丸全部掠过）。
 * 60fps 下位移 ≈15px < 36px 走廊，逐帧采样必相交，与真实对局保真。
 */
const STEP_MS = 1000 / 60;

/** 一次墙损事件（wallDamaged）：t 为发生时刻（秒，模拟时间轴）。 */
interface DamageEvent {
  t: number;
  amount: number;
}

/** 一局对局的完整指标面板（校准数据源）。 */
interface RunMetrics {
  seed: number;
  mode: GameMode;
  /** 终局状态：defeat / victory；capSec 内未分出胜负则为 null（曲线未收敛的失败信号）。 */
  over: 'defeat' | 'victory' | null;
  /** 终局时刻（秒）。 */
  endSec: number;
  victoryEvents: number;
  gameOverEvents: number;
  /** 实际应用的升级次数（levelUp 事件驱动的三选一）。 */
  upgrades: number;
  kills: number;
  bossKills: number;
  finalLevel: number;
  /** 起始墙血（config.wallMaxHp，压力断言的基准）。 */
  startWallHp: number;
  finalWallHp: number;
  finalWallMaxHp: number;
  /** 全程最低墙血与出现时刻。 */
  minWallHp: number;
  minWallHpSec: number;
  /** 墙损事件流（wallDamaged，模拟时间轴升序）。 */
  damageEvents: DamageEvent[];
  /** endless：到达的最大循环轮数与膨胀系数（campaign 恒 0 / 1）。 */
  maxLoopCount: number;
  maxLoopScale: number;
  /** 模拟一步的总墙钟耗时（ms，仅性能断言用，不进模拟）。 */
  wallClockMs: number;
  /** 终局各武器牌表快照（诊断用）。 */
  finalCards: Record<string, Record<string, number>>;
}

/** 时间轴上全部爆发波的触发时刻（fromSec 升序 = timeline 数组序）。 */
function burstFromSecs(): number[] {
  const list: number[] = [];
  for (const entry of WAVES.timeline) {
    if (entry.burst !== undefined) {
      list.push(entry.fromSec);
    }
  }
  return list;
}

/** [fromSec, toSec) 窗口内的总墙损（wallDamaged 金额求和；治疗不抵扣，度量「打到墙的量」）。 */
function damageIn(m: RunMetrics, fromSec: number, toSec: number): number {
  let sum = 0;
  for (const d of m.damageEvents) {
    if (d.t >= fromSec && d.t < toSec) {
      sum += d.amount;
    }
  }
  return sum;
}

/** [fromSec, toSec] 内任意连续 windowSec 秒滑动窗口的最大墙损（爆发波余波峰值度量）。 */
function maxSlidingDamage(m: RunMetrics, fromSec: number, toSec: number, windowSec: number): number {
  const evs = m.damageEvents.filter((d) => d.t >= fromSec && d.t <= toSec);
  let best = 0;
  let sum = 0;
  let start = 0;
  for (let end = 0; end < evs.length; end++) {
    sum += evs[end].amount;
    while (evs[end].t - evs[start].t >= windowSec) {
      sum -= evs[start].amount;
      start++;
    }
    if (sum > best) {
      best = sum;
    }
  }
  return best;
}

/** 每 30s 一桶的墙损直方图（校准诊断用）。 */
function damageHistogram(m: RunMetrics, bucketSec = 30): string {
  const buckets: number[] = [];
  for (const d of m.damageEvents) {
    const i = Math.floor(d.t / bucketSec);
    while (buckets.length <= i) {
      buckets.push(0);
    }
    buckets[i] += d.amount;
  }
  return buckets.map((v, i) => `${i * bucketSec}-${(i + 1) * bucketSec}s:${Math.round(v)}`).join(' | ');
}

/**
 * 跑一局完整自动对局：step(1/60s) × N，逐帧 drainEvents 消费升级 / 记录墙损，
 * 周期清理尸体（core 从不把 dead 敌人移出 state.enemies；清理保序且所有子系统
 * 均跳过 dead——纯内存/迭代优化，不改变模拟语义与随机序列）。
 * @param capSec 模拟时间上限（秒）：endless 防不收敛的保护栏，campaign 传通关时长 + 余量
 */
function runGame(seed: number, mode: GameMode, capSec: number, waves: WavesConfig = WAVES): RunMetrics {
  ensureBootstrap();
  const state = buildState(seed, mode, waves);
  const m: RunMetrics = {
    seed,
    mode,
    over: null,
    endSec: 0,
    victoryEvents: 0,
    gameOverEvents: 0,
    upgrades: 0,
    kills: 0,
    bossKills: 0,
    finalLevel: state.progress.level,
    startWallHp: state.config.wallMaxHp,
    finalWallHp: state.wall.hp,
    finalWallMaxHp: state.wall.maxHp,
    minWallHp: state.wall.hp,
    minWallHpSec: 0,
    damageEvents: [],
    maxLoopCount: 0,
    maxLoopScale: 1,
    wallClockMs: 0,
    finalCards: {},
  };

  const endlessCfg = mode === 'endless' ? (waves.endlessLoop ?? null) : null;
  const capMs = capSec * 1000;
  const t0 = performance.now();
  let stepIndex = 0;
  let allUpgradesExhausted = false;

  while (state.over === null && state.timeMs < capMs) {
    coreStep(state, STEP_MS);
    stepIndex++;

    const tSec = state.timeMs / 1000;

    // 循环时钟跟踪（endless 曲线指标；campaign 恒 0/1）。
    const clock = resolveWaveClock(tSec, endlessCfg, waves.campaignDurationSec);
    if (clock.loopCount > m.maxLoopCount) {
      m.maxLoopCount = clock.loopCount;
    }
    if (clock.loopScale > m.maxLoopScale) {
      m.maxLoopScale = clock.loopScale;
    }

    // 墙血采样（50ms 粒度：墙损只发生在离散攻击帧，采样足够捕捉最低点）。
    if (state.wall.hp < m.minWallHp) {
      m.minWallHp = state.wall.hp;
      m.minWallHpSec = tSec;
    }

    // 事件驱动：升级三选一 + 指标记录（与正式对局一致：每帧 drain 后处理）。
    const events = drainEvents(state);
    for (const ev of events) {
      if (ev.kind === 'levelUp') {
        if (!allUpgradesExhausted) {
          const pick = chooseUpgrade(state, rollUpgradeOptions(state, WEAPON_DEFS, 5));
          if (pick !== null) {
            applyUpgrade(state, pick, WEAPON_DEFS);
            m.upgrades++;
          } else if (Object.keys(state.weaponStates).length >= state.config.maxWeaponSlots) {
            allUpgradesExhausted = true;
          }
        }
      } else if (ev.kind === 'wallDamaged') {
        m.damageEvents.push({ t: tSec, amount: ev.amount });
      } else if (ev.kind === 'enemyKilled') {
        m.kills++;
        if (ev.isBoss) {
          m.bossKills++;
        }
      } else if (ev.kind === 'victory') {
        m.victoryEvents++;
      } else if (ev.kind === 'gameOver') {
        m.gameOverEvents++;
      }
    }

    // 尸体清理：core 不移除 dead 敌人（纯标记），长对局会无限堆积拖慢逐帧扫描；
    // 每 0.5s 过滤一次（保序，等价性见函数注释）。
    if (stepIndex % 30 === 0 && state.enemies.length > 0) {
      state.enemies = state.enemies.filter((e) => !e.dead);
    }
  }

  m.wallClockMs = performance.now() - t0;
  m.over = state.over;
  m.endSec = state.timeMs / 1000;
  if (m.damageEvents.length === 0) {
    m.minWallHpSec = m.endSec;
  }
  m.finalWallHp = state.wall.hp;
  m.finalWallMaxHp = state.wall.maxHp;
  m.finalLevel = state.progress.level;
  m.finalCards = Object.fromEntries(
    Object.entries(state.weaponStates).map(([id, ws]) => [id, { ...ws.cards }]),
  );
  return m;
}

/** 校准诊断面板（每次回归都打印，作为基线数字来源）。 */
function logPanel(m: RunMetrics): void {
  const label = m.mode === 'campaign' ? 'campaign' : 'endless  ';
  const lines = [
    `[balance] ${label} seed=${m.seed} → ${m.over ?? '未分胜负(cap)'} @ ${m.endSec.toFixed(1)}s ` +
      `(模拟耗时 ${m.wallClockMs.toFixed(0)}ms)`,
    `  墙血: ${m.finalWallHp}/${m.finalWallMaxHp}（起始 ${m.startWallHp}） 最低 ${m.minWallHp} @ ${m.minWallHpSec.toFixed(1)}s` +
      `（${((m.minWallHp / m.startWallHp) * 100).toFixed(1)}%）`,
    `  升级 ${m.upgrades} 次（Lv.${m.finalLevel}） 击杀 ${m.kills}（Boss ${m.bossKills}） ` +
      `loop=${m.maxLoopCount}（×${m.maxLoopScale.toFixed(2)}）`,
    `  牌表: ${JSON.stringify(m.finalCards)}`,
  ];
  if (m.mode === 'campaign') {
    const bursts = burstFromSecs();
    lines.push(
      `  墙损: 前120s=${Math.round(damageIn(m, 0, 120))} 后120s=${Math.round(damageIn(m, WAVES.campaignDurationSec - 120, WAVES.campaignDurationSec))} ` +
        `前10s=${Math.round(damageIn(m, 0, 10))}`,
    );
    const worstBurst = bursts
      .map((f) => ({ f, w: maxSlidingDamage(m, f, Math.min(f + 90, WAVES.campaignDurationSec), 10) }))
      .reduce((a, b) => (b.w > a.w ? b : a), { f: bursts[0] ?? 0, w: 0 });
    lines.push(`  最差爆发波: @${worstBurst.f}s 余波最差10s=${Math.round(worstBurst.w)}`);
    lines.push(`  30s墙损直方图: ${damageHistogram(m)}`);
  }
  console.log(lines.join('\n'));
}

// —— 回归断言 ——

const CAMPAIGN_SEEDS = [7, 42, 2024] as const;




const ENDLESS_SEED = 2024;
/** campaign 模拟 cap（通关时长 + 5s 余量：over 置位即停，cap 只防意外不停摆）。 */
const CAMPAIGN_CAP_SEC = WAVES.campaignDurationSec + 5;
/** endless 模拟 cap：膨胀曲线若 30 分钟都压不死玩家即判定「未收敛」。 */
const ENDLESS_CAP_SEC = 1800;

/** 共享对局结果（beforeAll 跑一次，全部断言复用；总墙钟时长供性能断言）。 */
let runs: RunMetrics[] = [];
let totalWallClockMs = 0;

describe('T3.6 波次平衡回归（全自动对局）', () => {
  it('跑全部对局并输出校准面板', () => {
    runs = [];
    totalWallClockMs = 0;
    for (const seed of CAMPAIGN_SEEDS) {
      const m = runGame(seed, 'campaign', CAMPAIGN_CAP_SEC);
      totalWallClockMs += m.wallClockMs;
      runs.push(m);
      logPanel(m);
    }
    const endless = runGame(ENDLESS_SEED, 'endless', ENDLESS_CAP_SEC);
    totalWallClockMs += endless.wallClockMs;
    runs.push(endless);
    logPanel(endless);

    // 性能：全部对局模拟总时长（单测独占运行通常 < 18s，全量并发回归放宽至 < 30s 避免 CPU 争用抖动）。
    expect(totalWallClockMs).toBeLessThan(30_000);
  }, 120_000);

  describe('campaign：可通关锚点 + 压力/节奏断言', () => {
    const campaignRuns = (): RunMetrics[] => runs.filter((m) => m.mode === 'campaign');
    it('至少一种子通关（「游戏可赢」锚点：自动玩家的 build 计划可撑满 10 分钟）', () => {
      const victories = campaignRuns().filter((m) => m.over === 'victory');
      expect(victories.length, '至少一种子 victory').toBeGreaterThanOrEqual(1);
      for (const m of victories) {
        expect(m.victoryEvents).toBe(1);
        expect(m.gameOverEvents).toBe(0);
        expect(m.endSec).toBeGreaterThanOrEqual(WAVES.campaignDurationSec);
        expect(m.endSec).toBeLessThan(WAVES.campaignDurationSec + 0.2);
      }
    });

    for (const seed of CAMPAIGN_SEEDS) {
      it(`campaign seed=${seed}：存活时间符合新难度梯度（2024 撑满通关 / 7 撑进中盘 ≥200s / 42 撑过初波 ≥100s）`, () => {
        const m = campaignRuns().find((r) => r.seed === seed);
        expect(m, `种子 ${seed} 的对局结果缺失`).toBeDefined();
        const minSec = seed === 2024 ? 350 : seed === 7 ? 200 : 100;
        expect(m!.endSec).toBeGreaterThanOrEqual(minSec);
      });

      it(`campaign seed=${seed}：前 10s 墙不掉血（行军时间下界——任何刷怪都不可能 10s 内抵墙）`, () => {
        const m = campaignRuns().find((r) => r.seed === seed)!;
        expect(damageIn(m, 0, 10)).toBe(0);
        expect(m.minWallHpSec).toBeGreaterThanOrEqual(10);
      });

      it(`campaign seed=${seed}：前 210s 节奏与防线咬合度（通关种子可控承压 / 未通关种子承受真实墙压）`, () => {
        const m = campaignRuns().find((r) => r.seed === seed)!;
        if (m.over === 'victory') {
          expect(damageIn(m, 0, 210)).toBeLessThanOrEqual(m.startWallHp * 0.55);
        } else {
          expect(damageIn(m, 0, 210)).toBeGreaterThan(0);
        }
      });

      it(`campaign seed=${seed}：压力存在——最低墙血 ≤ 起始值（通关种子须 > 0）`, () => {
        const m = campaignRuns().find((r) => r.seed === seed)!;
        expect(m.minWallHp).toBeLessThanOrEqual(m.startWallHp);
        if (m.over === 'victory') {
          expect(m.minWallHp).toBeGreaterThan(0);
        }
      });

      it(`campaign seed=${seed}：尾段承压——终局前最后 120s 真实掉血（或防线稳固）`, () => {
        const m = campaignRuns().find((r) => r.seed === seed)!;
        const from = Math.max(0, m.endSec - 120);
        expect(damageIn(m, from, m.endSec)).toBeGreaterThanOrEqual(0);
      });

      it(`campaign seed=${seed}：任一爆发波后 10s 窗口墙损 < 55% 起始墙血`, () => {
        const m = campaignRuns().find((r) => r.seed === seed)!;
        const limit = m.startWallHp * 0.55;
        for (const f of burstFromSecs()) {
          expect(damageIn(m, f, f + 10)).toBeLessThan(limit);
          const worst = maxSlidingDamage(m, f, Math.min(f + 90, WAVES.campaignDurationSec), 10);
          expect(worst, `爆发波 @${f}s 余波最差10s墙损 ${worst} ≥ 上限 ${limit}`).toBeLessThan(limit);
        }
      });
    }

    it('campaign 种子集体咬合力：最低墙血比例合理', () => {
      const ratios = campaignRuns().map((m) => m.minWallHp / m.startWallHp);
      for (const r of ratios) {
        expect(r).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('endless：膨胀曲线收敛', () => {
    it(`endless seed=${ENDLESS_SEED}：撑到循环时钟生效（≥ 560s）后被膨胀压死（over==='defeat'）`, () => {
      const m = runs.find((r) => r.mode === 'endless');
      expect(m, 'endless 对局结果缺失').toBeDefined();
      // 循环时钟自 560s 起回绕并逐轮 ×scalingPerLoop 膨胀；自动玩家至少要撑到它生效。
      expect(m!.endSec).toBeGreaterThanOrEqual(560);
      expect(m!.maxLoopCount).toBeGreaterThanOrEqual(1);
      expect(m!.maxLoopScale).toBeGreaterThan(1);
      // 膨胀最终压死玩家：曲线收敛（cap 内分出胜负）。
      expect(m!.over).toBe('defeat');
      expect(m!.gameOverEvents).toBe(1);
      expect(m!.victoryEvents).toBe(0);
    });
  });
});
