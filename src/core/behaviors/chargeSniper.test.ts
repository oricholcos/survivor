// src/core/behaviors/chargeSniper.test.ts —— 蓄能狙击行为契约（任务三牌池重构后）：
// 目标优先级四级（boss > attack 贴墙高威胁层 > 快速怪 speed≥阈值 > 最近，平距取先出现者）、
// 无敌人不开火且冷却归 0、移动预测（leadAim 提前量：行军主目标必中）、蓄力节奏
// （intervalMs=2400 连续 step 只在累计到点时 fire；攻速强化牌按 ÷1.3 乘区缩短）、mark 恒带
// 模板 + 命中后 dealDamage ×1.25 联动（首发不享受）、贯穿（贯穿弹牌：pierce +2/张）；
// 新增三张一次性专属牌：
// - 爆头 crit_shot：每次命中实例独立掷点（第二独立随机流，绝不消费 state.rng），判中总伤
//   = 弹伤 ×5.5（与斩首乘区叠乘）；
// - 死刑宣告 execution_order：普通 20% / Boss 7% 阈值（严格 <），处决走正常死亡路径；
//   H2 后本武器任何一次击杀（直接击杀/爆头击杀/边境折返多次命中击杀/处决击杀）该次
//   击杀经验 ×1.25，一次死亡只放大一次（三条路径互斥）；协同齐射 forcedTarget 路径同样生效；
// - 边境折返 border_ricochet：命中计数 = 1 + 2×贯穿弹张数，撞边缘必反弹不消耗计数
//   （镜面反射：上 y≤0 / 左 x≤0 / 右 x≥width / 下=墙线 y≥wallLineY）；H1 后取消 ttl 封顶
//   （持牌弹 ttlMs=Infinity，计数未耗尽永不消失；未持牌弹 ttl 1200ms 照旧）；
// - 表现反馈（G5）：爆头判中写 sniper_crit_vfx meta + 一次性 'crit' sfx；死刑宣告触发写
//   sniper_execute_vfx meta + 一次性 'execute' sfx（列表有界 16 / untilMs 滚动清理 / 未触发不写）；
// 死代码清理断言：多射/连射/分裂/命中减速在牌池与行为层均无残留。
// 数值全部来自 weapons/charge_sniper.json 真实表驱动（牌组经 getWeaponStats 注入 stats）。
import { describe, expect, it } from 'vitest';
import { loadEffectDefs } from '../../data/effects';
import { loadCardDefs } from '../../data/cards';
import { loadWeaponDefs } from '../../data/weapons';
import { damageTakenFactor, dealDamage, hasEffect } from '../effects';
import { onEnemyKilled } from '../gems';
import { normalize, scale } from '../math';
import { killHooks, spawnProjectile, updateProjectiles } from '../projectiles';
import { availableCards, BURST_QUEUE_META_KEY } from '../cards';
import { BATTLE_RNG_META_KEY, createSimState, getBattleRng } from '../simState';
import { rollUpgradeOptions } from '../upgrade';
import { SpatialHash } from '../spatialHash';
import type { Enemy, Projectile, Rng, SimState } from '../types';
import { addWeapon, getWeaponStats, updateWeapons } from '../weapons';
import type { WeaponStats } from '../weapons';
import {
  SNIPER_CRIT_VFX_KEY,
  SNIPER_CRIT_VFX_MS,
  SNIPER_EXECUTE_VFX_KEY,
  SNIPER_EXECUTE_VFX_MS,
  type SniperHitVfx,
  behavior,
} from './behavior_chargeSniper';
import './index'; // 副作用：自动发现注册
import { getBehavior } from './registry';

// 副作用：把 effects.json 真实效果表注册进 core/effects（mark 效果槽依赖）。
loadEffectDefs();
// 经验结算接线（与 session 同款）：死刑宣告经验 ×1.25 的「基础经验」由 onEnemyKilled
// 结算（行为层临时 killHook 只追加 0.25 倍）。killHooks 为 projectiles 模块级单例，
// vitest 按文件隔离模块注册表，此处注册只影响本文件。
killHooks.push(onEnemyKilled);

interface EnemyOpts {
  hp?: number;
  /** 覆盖 maxHp（与 hp 解耦，构造「残血高上限」目标）。缺省与 hp 相同（满血）。 */
  maxHp?: number;
  speed?: number;
  isBoss?: boolean;
  /** 击杀掉落经验（默认 1；死刑宣告经验断言用）。 */
  xp?: number;
}

/** 构造一个静止敌人夹具（数值仅存在于测试夹具）。 */
function makeEnemy(state: SimState, x: number, y: number, opts: EnemyOpts = {}): Enemy {
  const hp = opts.hp ?? 100;
  const e: Enemy = {
    id: state.nextId++,
    typeId: opts.isBoss ? 'boss_1' : 'tester',
    name: '测试怪',
    x,
    y,
    radius: 10,
    hp,
    maxHp: opts.maxHp ?? hp,
    speed: opts.speed ?? 0,
    damage: 0,
    attackIntervalMs: 1000,
    attackCooldownMs: 1000,
    state: 'march',
    isBoss: opts.isBoss ?? false,
    xp: opts.xp ?? 1,
    color: 0xffffff,
    shape: 'box',
    effects: [],
    dead: false,
  };
  state.enemies.push(e);
  return e;
}

/**
 * 以真实数据表 charge_sniper.json 的指定牌组 stats 直调 fire 一次（返回所用 stats）。
 * cards 数组即该武器已吃的牌（重复项 = 可重复牌多张）；forcedTarget 模拟灼热光束
 * 【协同开火】的强制指定目标路径。
 */
function fireOnce(state: SimState, cards: string[] = [], forcedTarget?: Enemy): WeaponStats {
  const def = loadWeaponDefs().charge_sniper;
  if (!state.weaponStates.charge_sniper) {
    state.weaponStates.charge_sniper = { level: 0, cooldownMs: 0, cards: {} };
  }
  const ws = state.weaponStates.charge_sniper;
  ws.cards = {};
  for (const cardId of cards) {
    ws.cards[cardId] = (ws.cards[cardId] ?? 0) + 1;
  }
  ws.level = cards.length;
  const stats = getWeaponStats(def, state, 'charge_sniper');
  behavior.fire(state, 'charge_sniper', stats, forcedTarget);
  return stats;
}

/**
 * 逐帧推进（帧序与生产一致：武器行为 update 钩子【先】于弹丸位移——边境折返反射
 * 依赖该时序），弹清空或帧数用尽即止；每帧推进 state.timeMs。
 */
function simulate(state: SimState, frames: number, dt = 8, observe?: (state: SimState) => void): void {
  const grid = new SpatialHash<Enemy>(64);
  for (let f = 0; f < frames && state.projectiles.length > 0; f++) {
    behavior.update!(state, dt);
    updateProjectiles(state, dt, grid);
    state.timeMs += dt;
    observe?.(state);
  }
}

/** 用有限队列桩替换战斗随机流（按序消费；队列耗尽恒返 0.999 = 不触发 15% 判定）。 */
function stubBattleRng(state: SimState, queue: number[]): number[] {
  const consumed: number[] = [];
  const rng: Rng = {
    next: () => {
      const v = queue.length > 0 ? queue.shift()! : 0.999;
      consumed.push(v);
      return v;
    },
    int: (maxExclusive: number) => (maxExclusive <= 0 ? 0 : Math.floor(rng.next() * maxExclusive)),
    range: (min: number, max: number) => min + rng.next() * (max - min),
    pick: <T>(list: readonly T[]): T => {
      if (list.length === 0) {
        throw new Error('rng.pick: 空数组无可选元素');
      }
      return list[Math.floor(rng.next() * list.length)]!;
    },
  };
  state.meta[BATTLE_RNG_META_KEY] = rng;
  return consumed;
}

describe('目标优先级四级（boss > attack 贴墙 > 快速怪 ≥ 阈值 > 最近）', () => {
  it('runner(快速)/standard(最近)/boss(远) 同场：选 boss（boss 速度 0 → 提前量退化为直接瞄准）', () => {
    const state = createSimState(1); // 角色 (360, 1220)，墙线 y=1160
    makeEnemy(state, 360, 1150, { speed: 45 }); // 最近标准怪 dist 70（行军怪在墙线上方）
    makeEnemy(state, 360, 1020, { speed: 90 }); // 快速怪 dist 200（正上方迎面行军）
    makeEnemy(state, 660, 1140, { isBoss: true, speed: 0 }); // boss dist 310
    fireOnce(state);

    expect(state.projectiles).toHaveLength(1);
    const p = state.projectiles[0];
    expect(p.behavior).toBe('charge_sniper');
    // boss 仍最高优先；速度 0 → 提前量退化为直接瞄准当前位置（行军目标的方向预测由
    // 「移动预测命中」用例与 targeting.test.ts 精确覆盖）。
    const expected = scale(normalize({ x: 660 - 360, y: 1140 - 1220 }), 1600);
    expect(p.vx).toBeCloseTo(expected.x, 6);
    expect(p.vy).toBeCloseTo(expected.y, 6);
    expect(p.x).toBe(360);
    expect(p.y).toBe(1220);
  });

  it('多个 boss 取最近', () => {
    const state = createSimState(1);
    makeEnemy(state, 100, 1140, { isBoss: true, speed: 0 }); // 近 boss dist 283
    makeEnemy(state, 1000, 1140, { isBoss: true, speed: 0 }); // 远 boss
    makeEnemy(state, 360, 1020, { speed: 90 });
    fireOnce(state);

    const expected = scale(normalize({ x: 100 - 360, y: 1140 - 1220 }), 1600); // 指向近 boss
    expect(state.projectiles[0].vx).toBeCloseTo(expected.x, 6);
    expect(state.projectiles[0].vy).toBeCloseTo(expected.y, 6);
  });

  it('attack 层压过快速怪：贴墙 tank（attack 态）+ 行军 runner（fast）→ 选贴墙 tank（用户反馈修复）', () => {
    const state = createSimState(1);
    const tank = makeEnemy(state, 660, 1160, { speed: 20 });
    tank.state = 'attack'; // 贴到墙线上正在打墙（距角色 305.9 > runner 200）
    makeEnemy(state, 360, 1020, { speed: 120 }); // 行军快速怪 dist 200
    fireOnce(state);

    // attack 怪速度 (0,0)：提前量退化为直接瞄准当前位置。
    const expected = scale(normalize({ x: 660 - 360, y: 1160 - 1220 }), 1600);
    expect(state.projectiles[0].vx).toBeCloseTo(expected.x, 6);
    expect(state.projectiles[0].vy).toBeCloseTo(expected.y, 6);
  });

  it('attack 层压过最近 march：贴墙怪更远也优先', () => {
    const state = createSimState(1);
    const tank = makeEnemy(state, 700, 1160, { speed: 20 });
    tank.state = 'attack'; // dist ≈ 345
    makeEnemy(state, 360, 1150, { speed: 45 }); // 最近 march dist 70（正上方迎面行军）
    fireOnce(state);

    const expected = scale(normalize({ x: 700 - 360, y: 1160 - 1220 }), 1600);
    expect(state.projectiles[0].vx).toBeCloseTo(expected.x, 6);
    expect(state.projectiles[0].vy).toBeCloseTo(expected.y, 6);
  });

  it('无 boss/贴墙怪：快速怪压过最近标准怪（视线与速度共线，提前量不改方向）', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1150, { speed: 45 }); // 最近 dist 70
    makeEnemy(state, 360, 1020, { speed: 90 }); // 快速 dist 200（正上方迎面行军）
    fireOnce(state);

    expect(state.projectiles[0].vx).toBeCloseTo(0, 6);
    expect(state.projectiles[0].vy).toBeCloseTo(-1600, 6); // (0, -200)/200：指向快速怪
  });

  it('都无 boss/贴墙怪/快速怪：选最近敌人', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1150, { speed: 45 }); // 最近 dist 70（正上方迎面行军）
    makeEnemy(state, 500, 1150, { speed: 20 }); // dist 156
    fireOnce(state);

    expect(state.projectiles[0].vy).toBeCloseTo(-1600, 6); // (0, -70)/70：指向最近者
  });

  it('速度阈值边界（≥ 语义）：speed 80 恰算快速怪、79 不算 → 退回最近', () => {
    const at = createSimState(1);
    makeEnemy(at, 460, 1150, { speed: 45 }); // 最近 dist 122（横向偏移）
    makeEnemy(at, 360, 1020, { speed: 80 }); // 恰达阈值 dist 200（正上方迎面行军）
    fireOnce(at);
    expect(at.projectiles[0].vx).toBeCloseTo(0, 6); // 打快速怪（正上方）
    expect(at.projectiles[0].vy).toBeCloseTo(-1600, 6);

    const below = createSimState(1);
    makeEnemy(below, 360, 1150, { speed: 45 }); // 最近 dist 70（正上方迎面行军）
    makeEnemy(below, 460, 1100, { speed: 79 }); // 差 1 不算快速（dist 156，横向可区分）
    fireOnce(below);
    expect(below.projectiles[0].vx).toBeCloseTo(0, 6); // 退回最近者（正上方，方向 (0,-1)）
    expect(below.projectiles[0].vy).toBeCloseTo(-1600, 6);
  });

  it('移动预测命中：march 怪 (600,840) speed 240 → 弹指向预测点 (600,900)，0.25s 精确命中', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 600, 840, { speed: 240, hp: 1000 });
    fireOnce(state); // 无牌：projectileSpeed 1600 / damage 60

    // 提前量精确解：Δ=(240,-380)、v=(0,240)、s=1600 → t=0.25、预测点 (600,900)，
    // 方向 (240,-320)/400 = (0.6,-0.8) → 弹速分量 (960,-1280)。
    expect(state.projectiles[0].vx).toBeCloseTo(960, 6);
    expect(state.projectiles[0].vy).toBeCloseTo(-1280, 6);

    // 逐帧推进（手动行军 + 弹丸直线推进）→ t=0.25s 弹与怪同达 (600,900)。
    const grid = new SpatialHash<Enemy>(64);
    for (let f = 0; f < 40 && state.projectiles.length > 0; f++) {
      e.y += 240 * 0.008;
      updateProjectiles(state, 8, grid);
      state.timeMs += 8;
    }
    expect(e.hp).toBe(940); // 主目标必中：1000 - 60
  });
});

describe('无敌人不开火（冷却归 0 重试标记）', () => {
  it('空场 / 仅剩尸体：不发射且冷却归 0；解释器随后推进一个 intervalMs', () => {
    const state = createSimState(1);
    addWeapon(state, 'charge_sniper');
    state.weaponStates.charge_sniper.cooldownMs = 500;
    behavior.fire(state, 'charge_sniper', getWeaponStats(loadWeaponDefs().charge_sniper, state, 'charge_sniper'));
    expect(state.projectiles).toHaveLength(0);
    expect(state.weaponStates.charge_sniper.cooldownMs).toBe(0);

    const corpseState = createSimState(1);
    const corpse = makeEnemy(corpseState, 360, 1020, { speed: 90 });
    corpse.dead = true;
    corpseState.weaponStates.charge_sniper = { level: 0, cooldownMs: 0, cards: {} };
    behavior.fire(
      corpseState,
      'charge_sniper',
      getWeaponStats(loadWeaponDefs().charge_sniper, corpseState, 'charge_sniper'),
    );
    expect(corpseState.projectiles).toHaveLength(0);

    // 解释器集成：fire 归 0 → 以改写后值 0 为累加基准 += intervalMs=2400：下帧自然重试。
    const defs = { charge_sniper: loadWeaponDefs().charge_sniper };
    const empty = createSimState(1);
    addWeapon(empty, 'charge_sniper');
    updateWeapons(empty, 100, defs);
    expect(empty.projectiles).toHaveLength(0);
    expect(empty.weaponStates.charge_sniper.cooldownMs).toBeCloseTo(2400, 9); // -100 → 归 0 → +2400
  });
});

describe('蓄力节奏（intervalMs=2400 真实表驱动）', () => {
  it('连续 step 只在累计到点时 fire：首帧 1 发 → 2200ms 内不再发 → 累计 2400ms 第 2 发', () => {
    const defs = { charge_sniper: loadWeaponDefs().charge_sniper };
    const state = createSimState(1);
    makeEnemy(state, 360, 1020, { speed: 90, hp: 1e6 }); // 始终有目标
    addWeapon(state, 'charge_sniper');

    updateWeapons(state, 100, defs);
    expect(state.projectiles).toHaveLength(1); // 首帧冷却 0 → 开火
    expect(state.weaponStates.charge_sniper.cooldownMs).toBeCloseTo(2300, 9); // -100 + 2400

    for (let i = 0; i < 22; i++) {
      updateWeapons(state, 100, defs); // 累计 2200ms：未到点不开火
    }
    expect(state.projectiles).toHaveLength(1);

    updateWeapons(state, 100, defs); // 累计 2400ms：第 2 发
    expect(state.projectiles).toHaveLength(2);
  });

  it('攻速强化牌实际生效（2400 ÷1.3）：第 2 发提前到累计约 1846ms（乘区后节奏）', () => {
    const defs = { charge_sniper: loadWeaponDefs().charge_sniper };
    const state = createSimState(1);
    makeEnemy(state, 360, 1020, { speed: 90, hp: 1e6 });
    addWeapon(state, 'charge_sniper');
    state.weaponStates.charge_sniper.cards.spd_up = 1; // 攻速强化 ×1：2400/1.3

    updateWeapons(state, 100, defs);
    expect(state.projectiles).toHaveLength(1);
    expect(state.weaponStates.charge_sniper.cooldownMs).toBeCloseTo(2400 / 1.3 - 100, 9);

    for (let i = 0; i < 17; i++) {
      updateWeapons(state, 100, defs); // 累计 1800ms：未到点不开火
    }
    expect(state.projectiles).toHaveLength(1);

    updateWeapons(state, 100, defs); // 累计 1900ms ≥ 1846.15：第 2 发
    expect(state.projectiles).toHaveLength(2);
  });
});

describe('标记（mark 效果槽联动）', () => {
  it('弹上恒带 mark 模板；命中后敌人挂 mark，后续 dealDamage ×1.25 生效（首发不享受）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1020, { speed: 90, hp: 1000 });
    fireOnce(state);
    expect(state.projectiles[0].effectsOnHit).toHaveLength(1);
    expect(state.projectiles[0].effectsOnHit[0].kind).toBe('mark');

    simulate(state, 200);
    expect(e.hp).toBeCloseTo(940, 6); // 首发 60：mark 在伤害结算之后附着，首发不享受加成
    expect(hasEffect(e, 'mark')).toBe(true);
    expect(e.effects[0].stacks).toBe(1);
    expect(damageTakenFactor(e)).toBeCloseTo(1.25, 12); // effects.json damageTakenFactor

    dealDamage(state, e, 100);
    expect(e.hp).toBeCloseTo(940 - 125, 6); // 100 × 1.25：标记增伤联动
  });
});

describe('爆头（crit_shot：独立随机流掷点，550% 伤害，与斩首叠乘）', () => {
  it('数据注入随表：critShot/critChance/critMultiplier 随牌注入 stats（base 无这些键）', () => {
    const def = loadWeaponDefs().charge_sniper;
    expect(def.base.critShot).toBeUndefined();

    const state = createSimState(1);
    makeEnemy(state, 360, 1020, { hp: 1e6 });
    const stats = fireOnce(state, ['crit_shot']);
    expect(stats.critShot).toBe(1);
    expect(stats.critChance).toBeCloseTo(0.15, 12);
    expect(stats.critMultiplier).toBeCloseTo(5.5, 12);
    // 弹上 data 快照随发射时数值走。
    expect(state.projectiles[0].data.critReady).toBe(1);
    expect(state.projectiles[0].data.critChance).toBeCloseTo(0.15, 12);
  });

  it('掷点判中（< 0.15）：命中总伤 = 弹伤 × 5.5 = 330（追加部分按命中点乘区折算）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1020, { hp: 1e6 });
    fireOnce(state, ['crit_shot']);
    stubBattleRng(state, [0.14]); // 0.14 < 0.15：判中

    simulate(state, 60);
    // 基础 60（mark 恰在其后附着）+ 追加实际结算 60×4.5 = 270 → 总伤 330 = 550% 弹伤。
    expect(e.hp).toBeCloseTo(1e6 - 330, 6);
  });

  it('与斩首乘区叠乘：headshot 弹伤 90 → 爆头总伤 90 × 5.5 = 495', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1020, { hp: 1e6 }); // 满血：斩首触发
    fireOnce(state, ['headshot', 'crit_shot']);
    expect(state.projectiles[0].damage).toBeCloseTo(90, 9); // 60 × 1.5
    stubBattleRng(state, [0.0]);

    simulate(state, 60);
    expect(e.hp).toBeCloseTo(1e6 - 495, 6);
  });

  it('掷点未中（≥ 0.15，严格小于）：不追加伤害', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1020, { hp: 1e6 });
    fireOnce(state, ['crit_shot']);
    stubBattleRng(state, [0.15]); // 恰等于概率：不判中

    simulate(state, 60);
    expect(e.hp).toBeCloseTo(1e6 - 60, 6);
  });

  it('每次命中实例独立掷点：贯穿弹两敌，流按序消费（[0.14, 0.95] → 首敌爆头、次敌不爆头）', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 360, 1120, { hp: 1e6 });
    const e2 = makeEnemy(state, 360, 1000, { hp: 1e6 });
    fireOnce(state, ['pierce_shot', 'crit_shot']);
    const consumed = stubBattleRng(state, [0.14, 0.95]);

    simulate(state, 60);
    expect(e1.hp).toBeCloseTo(1e6 - 330, 6); // 第 1 次命中：判中
    expect(e2.hp).toBeCloseTo(1e6 - 60, 6); // 第 2 次命中：不判中（同弹独立掷点）
    expect(consumed).toHaveLength(2); // 恰好两次掷点
  });

  it('独立随机流：同种子两局战斗流序列相同、异种子不同；fire+hit 全程主随机流零消费', () => {
    // 同种子 → 同序列（LCG，种子 = 会话种子 XOR 0x9E3779B9）。
    const a = createSimState(42);
    const b = createSimState(42);
    const seqA = [getBattleRng(a).next(), getBattleRng(a).next(), getBattleRng(a).next()];
    const seqB = [getBattleRng(b).next(), getBattleRng(b).next(), getBattleRng(b).next()];
    expect(seqA).toEqual(seqB);

    // 异种子 → 不同序列（固定种子对，确定性断言）。
    const c = createSimState(1);
    expect(getBattleRng(c).next()).not.toBe(seqA[0]);

    // 主随机流零扰动：持爆头牌 fire + 命中（不击杀）全程 state.rng 一次都不被消费。
    const state = createSimState(1);
    let calls = 0;
    state.rng = {
      next: () => {
        calls += 1;
        return 0;
      },
      int: () => 0,
      range: () => 0,
      pick: (list) => list[0],
    };
    makeEnemy(state, 360, 1020, { hp: 1e6 });
    fireOnce(state, ['crit_shot', 'execution_order', 'border_ricochet', 'pierce_shot']);
    simulate(state, 60);
    expect(calls).toBe(0);
  });

  it('H2 爆头追伤致死：该次击杀经验 ×1.25（60 基础不致死 + 270 追伤致死 → 32 × 1.25 = 40）', () => {
    const state = createSimState(1);
    state.progress.level = 10; // xpToNext(10)=41：32/40 经验都不触发升级，断言干净
    const e = makeEnemy(state, 360, 1020, { hp: 300, maxHp: 2000, xp: 32 });
    fireOnce(state, ['crit_shot', 'execution_order']);
    stubBattleRng(state, [0.14]); // 爆头判中：基础 60（300→240 存活）+ 追伤 270 = 330 ≥ 300 → 击杀

    simulate(state, 60);
    expect(e.dead).toBe(true);
    expect(state.progress.xp).toBeCloseTo(40, 9); // 爆头击杀经验放大（H2 路径②），且恰一次
  });
});

describe('贯穿（pierce_shot 贯穿弹牌：pierce +2/张，可重复）', () => {
  it('1 张贯穿弹：pierce=2，弹直线贯穿 2 个敌人，各挂 mark；穿透耗尽弹亡', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 360, 1120, { hp: 1e6 }); // 最近：瞄准起点
    const e2 = makeEnemy(state, 360, 1000, { hp: 1e6 });
    const e3 = makeEnemy(state, 360, 880, { hp: 1e6 });
    fireOnce(state, ['pierce_shot']);
    expect(state.projectiles).toHaveLength(1);
    expect(state.projectiles[0].pierceLeft).toBe(2);

    simulate(state, 200);
    expect(state.projectiles).toHaveLength(0); // 2 次命中耗尽 pierce
    expect(e1.hp).toBeCloseTo(1e6 - 60, 6);
    expect(e2.hp).toBeCloseTo(1e6 - 60, 6);
    expect(e3.hp).toBe(1e6); // 名额用尽：线上更远者不受击
    expect(hasEffect(e1, 'mark')).toBe(true); // 贯穿途中每个被命中敌人都附着效果模板
    expect(hasEffect(e2, 'mark')).toBe(true);
  });

  it('2 张贯穿弹（可重复）：pierce=4，3 个敌人全中', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 360, 1120, { hp: 1e6 });
    const e2 = makeEnemy(state, 360, 1000, { hp: 1e6 });
    const e3 = makeEnemy(state, 360, 880, { hp: 1e6 });
    fireOnce(state, ['pierce_shot', 'pierce_shot']);
    expect(state.projectiles[0].pierceLeft).toBe(4);

    simulate(state, 200);
    expect(e1.hp).toBeCloseTo(1e6 - 60, 6);
    expect(e2.hp).toBeCloseTo(1e6 - 60, 6);
    expect(e3.hp).toBeCloseTo(1e6 - 60, 6);
  });

  it('对照无牌（无贯穿开关）：pierce 0，只中直线上第一个敌人', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 360, 1120, { hp: 1e6 });
    const e2 = makeEnemy(state, 360, 1000, { hp: 1e6 });
    fireOnce(state);
    expect(state.projectiles[0].pierceLeft).toBe(0);

    simulate(state, 200);
    expect(state.projectiles).toHaveLength(0);
    expect(e1.hp).toBeCloseTo(1e6 - 60, 6);
    expect(e2.hp).toBe(1e6); // 弹在第一击后即亡
  });
});

describe('斩首（headshot 斩首牌 + execute_up 处决强化牌）', () => {
  it('高血目标（hp ≥ 0.6×maxHp）×1.5：满血 boss 弹伤 60×1.5=90', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1020, { isBoss: true, speed: 40, hp: 1e6 });
    fireOnce(state, ['headshot']);
    expect(state.projectiles[0].damage).toBeCloseTo(90, 9);
  });

  it('残血目标（hp < 0.6×maxHp）不增伤；无牌满血也不增伤', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1020, { speed: 90, hp: 200, maxHp: 1000 }); // 0.2 < 0.6
    fireOnce(state, ['headshot']);
    expect(state.projectiles[0].damage).toBeCloseTo(60, 9);

    const plain = createSimState(1);
    makeEnemy(plain, 360, 1020, { speed: 90, hp: 1e6 });
    fireOnce(plain);
    expect(plain.projectiles[0].damage).toBeCloseTo(60, 9); // 无斩首牌：无爆头开关
  });

  it('阈值边界（≥ 语义）：61% 血量增伤、59% 不增伤', () => {
    const above = createSimState(1);
    makeEnemy(above, 360, 1020, { speed: 90, hp: 61, maxHp: 100 });
    fireOnce(above, ['headshot']);
    expect(above.projectiles[0].damage).toBeCloseTo(90, 9);

    const below = createSimState(1);
    makeEnemy(below, 360, 1020, { speed: 90, hp: 59, maxHp: 100 });
    fireOnce(below, ['headshot']);
    expect(below.projectiles[0].damage).toBeCloseTo(60, 9);
  });

  it('处决强化叠加（可重复，+0.25/张）：60 × (1.5+0.25) = 105、2 张 → 60 × 2 = 120', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1020, { isBoss: true, speed: 40, hp: 1e6 });
    fireOnce(state, ['headshot', 'execute_up']);
    expect(state.projectiles[0].damage).toBeCloseTo(60 * 1.75, 9);

    const state2 = createSimState(1);
    makeEnemy(state2, 360, 1020, { isBoss: true, speed: 40, hp: 1e6 });
    fireOnce(state2, ['headshot', 'execute_up', 'execute_up']);
    expect(state2.projectiles[0].damage).toBeCloseTo(120, 9);
  });
});

describe('死刑宣告（execution_order：20%/Boss 7% 阈值处决 + 经验 ×1.25）', () => {
  it('普通阈值 20%：命中后 hp < 20% maxHp → 处决击杀；恰等于 20% 不处决（严格小于）', () => {
    const executed = createSimState(1);
    const low = makeEnemy(executed, 360, 1020, { hp: 250, maxHp: 1000 }); // 命中后 190 < 200
    fireOnce(executed, ['execution_order']);
    simulate(executed, 60);
    expect(low.dead).toBe(true); // 处决：致命 dealDamage 走正常死亡路径

    const boundary = createSimState(1);
    const exact = makeEnemy(boundary, 360, 1020, { hp: 260, maxHp: 1000 }); // 命中后恰 200 = 20%
    fireOnce(boundary, ['execution_order']);
    simulate(boundary, 60);
    expect(exact.dead).toBe(false);
    expect(exact.hp).toBeCloseTo(200, 9);
  });

  it('Boss 阈值 7%：同血量普通怪处决、Boss 不处决；Boss 恰等于 7% 不处决、低于才处决', () => {
    // 同一血量（命中后 15% maxHp）：普通怪 < 20% → 处决；Boss ≥ 7% → 存活。
    const normal = createSimState(1);
    const n = makeEnemy(normal, 360, 1020, { hp: 150060, maxHp: 1e6 });
    fireOnce(normal, ['execution_order']);
    simulate(normal, 60);
    expect(n.dead).toBe(true);

    const boss = createSimState(1);
    const b = makeEnemy(boss, 360, 1020, { hp: 150060, maxHp: 1e6, isBoss: true });
    fireOnce(boss, ['execution_order']);
    simulate(boss, 60);
    expect(b.dead).toBe(false);
    expect(b.hp).toBeCloseTo(150000, 9);

    // Boss 边界：命中后恰 7% 不处决；低于 7% 处决。
    const bossExact = createSimState(1);
    const be = makeEnemy(bossExact, 360, 1020, { hp: 70060, maxHp: 1e6, isBoss: true });
    fireOnce(bossExact, ['execution_order']);
    simulate(bossExact, 60);
    expect(be.dead).toBe(false);
    expect(be.hp).toBeCloseTo(70000, 9);

    const bossBelow = createSimState(1);
    const bb = makeEnemy(bossBelow, 360, 1020, { hp: 70050, maxHp: 1e6, isBoss: true });
    fireOnce(bossBelow, ['execution_order']);
    simulate(bossBelow, 60);
    expect(bb.dead).toBe(true);
  });

  it('经验 ×1.25 只放大该次击杀：处决击杀 xp = 32×1.25 = 40；无牌普通击杀 xp = 32', () => {
    const executed = createSimState(1);
    executed.progress.level = 10; // xpToNext(10)=41：32/40 都不触发升级
    const e = makeEnemy(executed, 360, 1020, { hp: 250, maxHp: 1000, xp: 32 });
    fireOnce(executed, ['execution_order']);
    simulate(executed, 60);
    expect(e.dead).toBe(true);
    expect(executed.progress.xp).toBeCloseTo(40, 9); // 击杀总经验 = 32 × 1.25

    const plain = createSimState(1);
    plain.progress.level = 10;
    const p = makeEnemy(plain, 360, 1020, { hp: 50, xp: 32 }); // 基础命中直接击杀
    fireOnce(plain);
    simulate(plain, 60);
    expect(p.dead).toBe(true);
    expect(plain.progress.xp).toBeCloseTo(32, 9); // 无放大
  });

  it('无死刑宣告牌：低血目标不处决；非本武器弹的直伤也不触发', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1020, { hp: 250, maxHp: 1000 });
    fireOnce(state); // 无牌
    simulate(state, 60);
    expect(e.dead).toBe(false);
    expect(e.hp).toBeCloseTo(190, 9);

    // 处决挂在蓄能狙击弹的命中钩子上：直接 dealDamage（其他武器/DoT 路径）不触发。
    dealDamage(state, e, 100); // 90 < 200：满足阈值但不处决
    expect(e.dead).toBe(false);
  });

  it('协同齐射路径（forcedTarget）同样生效：强制指定目标被处决且经验 ×1.25', () => {
    const state = createSimState(1);
    state.progress.level = 10;
    makeEnemy(state, 600, 1150, { hp: 1e6 }); // 更近的诱饵：证明 forcedTarget 覆盖了 pickTarget
    const forced = makeEnemy(state, 360, 800, { hp: 250, maxHp: 1000, xp: 32 });
    fireOnce(state, ['execution_order'], forced);
    expect(state.projectiles).toHaveLength(1);
    expect(state.projectiles[0].vy).toBeLessThan(0); // 朝强制目标（正上方）射出

    simulate(state, 60);
    expect(forced.dead).toBe(true);
    expect(state.progress.xp).toBeCloseTo(40, 9);
  });

  it('边境折返多次命中各自判定：贯穿线上末位低血目标被处决', () => {
    const state = createSimState(1);
    state.progress.level = 10;
    const e1 = makeEnemy(state, 360, 1120, { hp: 1e6 });
    const e2 = makeEnemy(state, 360, 1000, { hp: 1e6 });
    const e3 = makeEnemy(state, 360, 880, { hp: 250, maxHp: 1000, xp: 32 });
    fireOnce(state, ['border_ricochet', 'pierce_shot', 'execution_order']); // 计数 3
    expect(state.projectiles[0].pierceLeft).toBe(3);

    simulate(state, 200);
    expect(e1.dead).toBe(false);
    expect(e2.dead).toBe(false);
    expect(e3.dead).toBe(true); // 第 3 次命中（计数耗尽那次）判定处决
    expect(e3.hp).toBeLessThanOrEqual(0);
    expect(state.progress.xp).toBeCloseTo(40, 9);
    expect(state.projectiles).toHaveLength(0); // 计数归零就地销毁
  });

  it('H2 直接击杀（基础命中致死）：经验 ×1.25；对照无牌直杀 = 原始经验', () => {
    const withCard = createSimState(1);
    withCard.progress.level = 10;
    const e1 = makeEnemy(withCard, 360, 1020, { hp: 50, xp: 32 }); // 基础命中 60 ≥ 50：直接击杀
    fireOnce(withCard, ['execution_order']);
    simulate(withCard, 60);
    expect(e1.dead).toBe(true);
    expect(withCard.progress.xp).toBeCloseTo(40, 9); // 直接击杀也放大（H2 路径①）

    const plain = createSimState(1);
    plain.progress.level = 10;
    const e2 = makeEnemy(plain, 360, 1020, { hp: 50, xp: 32 });
    fireOnce(plain); // 未持死刑宣告
    simulate(plain, 60);
    expect(e2.dead).toBe(true);
    expect(plain.progress.xp).toBeCloseTo(32, 9); // 未持牌：原始经验不变
  });

  it('H2 直接击杀不双倍：基础命中致死时爆头分支被尸体短路（战斗随机流零消费）', () => {
    const state = createSimState(1);
    state.progress.level = 10;
    const e = makeEnemy(state, 360, 1020, { hp: 50, maxHp: 2000, xp: 32 });
    fireOnce(state, ['crit_shot', 'execution_order']);
    const consumed = stubBattleRng(state, [0.0]); // 若误判爆头必消费（0 < 0.15 判中）

    simulate(state, 60);
    expect(e.dead).toBe(true);
    expect(state.progress.xp).toBeCloseTo(40, 9); // 恰一次 ×1.25（非 32×1.5 双重叠加）
    expect(consumed).toHaveLength(0); // 尸体短路：爆头掷点未被消费
  });

  it('H2 非本武器击杀不受影响：持死刑宣告时他武器/DoT 来源的直伤击杀经验不放大', () => {
    const state = createSimState(1);
    state.progress.level = 10;
    const e = makeEnemy(state, 360, 1020, { hp: 300, maxHp: 1000, xp: 32 });
    fireOnce(state, ['execution_order']);
    simulate(state, 60); // 狙击命中 60 → 240 ≥ 200：不满足处决阈值
    expect(e.dead).toBe(false);

    dealDamage(state, e, 1000); // 模拟非本武器来源的伤害直接击杀（不经命中钩子）
    expect(e.dead).toBe(true);
    expect(state.progress.xp).toBeCloseTo(32, 9); // 放大只挂在蓄能狙击命中钩子上：原始经验
  });

  it('H2 边境折返多次命中各自判定：命中 1 直接击杀放大 → 弹继续飞行 → 命中 3 再次击杀再放大', () => {
    const state = createSimState(1);
    state.progress.level = 20; // xpToNext(20)=81：两次击杀合计 80 不触发升级，断言干净
    const e1 = makeEnemy(state, 360, 1120, { hp: 50, xp: 32 }); // 命中 1：直接击杀（放大）
    const e2 = makeEnemy(state, 360, 1000, { hp: 1e6 }); // 命中 2：未击杀（弹继续）
    const e3 = makeEnemy(state, 360, 880, { hp: 50, xp: 32 }); // 命中 3：击杀（再放大）
    fireOnce(state, ['border_ricochet', 'pierce_shot', 'execution_order']); // 计数 3

    simulate(state, 200);
    expect(e1.dead).toBe(true);
    expect(e2.dead).toBe(false);
    expect(e3.dead).toBe(true);
    expect(state.progress.xp).toBeCloseTo(80, 9); // 两次死亡各自 ×1.25（40 + 40），互不叠加
    expect(state.projectiles).toHaveLength(0); // 计数耗尽就地销毁
  });
});

describe('表现反馈 meta VFX + 一次性 sfx（G5：爆头星芒环 / 死刑宣告斩杀，不做震屏）', () => {
  /** 直调命中钩子前置：造场景 + fireOnce（返回弹），stub 战斗随机流。 */
  function hookScene(cards: string[], rngQueue: number[]): { state: SimState; proj: Projectile } {
    const state = createSimState(1);
    makeEnemy(state, 360, 1020, { hp: 1e7 });
    fireOnce(state, cards);
    stubBattleRng(state, rngQueue);
    return { state, proj: state.projectiles[0] };
  }

  it('契约常量：爆头留存 200ms / 处决留存 300ms（视图按此淡出，两端常量同源导入）', () => {
    expect(SNIPER_CRIT_VFX_MS).toBe(200);
    expect(SNIPER_EXECUTE_VFX_MS).toBe(300);
  });

  it('爆头判中（直调钩子）：写 crit VFX 条目（命中点坐标 + untilMs = 写入时刻 + 200）+ 一次性 crit sfx', () => {
    const { state, proj } = hookScene(['crit_shot'], [0.14]); // 0.14 < 0.15：判中
    state.timeMs = 500;
    behavior.onProjectileHit!(state, proj, state.enemies[0]);

    const list = state.meta[SNIPER_CRIT_VFX_KEY] as SniperHitVfx[];
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({ x: 360, y: 1020, untilMs: 700 }); // 命中点 = 敌坐标
    expect(state.events).toContainEqual({ kind: 'sfx', name: 'crit' });
  });

  it('爆头未判中（≥ 0.15 严格小于）：不写 meta、不推 sfx', () => {
    const { state, proj } = hookScene(['crit_shot'], [0.15]); // 恰等于概率：不判中
    state.timeMs = 500;
    behavior.onProjectileHit!(state, proj, state.enemies[0]);

    expect(state.meta[SNIPER_CRIT_VFX_KEY]).toBeUndefined();
    expect(state.events).toHaveLength(0);
  });

  it('未拿爆头牌：critReady=0 短路（连战斗随机流都不消费），无 meta 无 sfx', () => {
    const { state, proj } = hookScene([], [0]); // rng 队列给 0：若误消费必判中暴露
    state.timeMs = 500;
    behavior.onProjectileHit!(state, proj, state.enemies[0]);

    expect(state.meta[SNIPER_CRIT_VFX_KEY]).toBeUndefined();
    expect(state.events).toHaveLength(0);
  });

  it('死刑宣告触发（直调钩子）：写 execute VFX 条目 + 一次性 execute sfx + 正常处决', () => {
    const { state, proj } = hookScene(['execution_order'], []);
    const e = makeEnemy(state, 500, 1100, { hp: 150, maxHp: 1000, xp: 32 }); // 150 < 20%×1000
    state.timeMs = 500;
    behavior.onProjectileHit!(state, proj, e);

    const list = state.meta[SNIPER_EXECUTE_VFX_KEY] as SniperHitVfx[];
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({ x: 500, y: 1100, untilMs: 800 }); // 目标位置 + 300ms 留存
    expect(state.events).toContainEqual({ kind: 'sfx', name: 'execute' });
    expect(e.dead).toBe(true); // 处决照常（表现写入不影响模拟语义）
  });

  it('死刑宣告未触发（恰等于 20% 阈值不处决）：不写 meta、不推 sfx', () => {
    const { state, proj } = hookScene(['execution_order'], []);
    const e = makeEnemy(state, 500, 1100, { hp: 260, maxHp: 1000 }); // 260 ≥ 200：不触发
    state.timeMs = 500;
    behavior.onProjectileHit!(state, proj, e);

    expect(state.meta[SNIPER_EXECUTE_VFX_KEY]).toBeUndefined();
    expect(e.dead).toBe(false);
    expect(state.events).toHaveLength(0);
  });

  it('爆头全链路（simulate 真实弹飞行）：判中帧写入 meta + sfx 事件进入 state.events', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1020, { hp: 1e6 });
    fireOnce(state, ['crit_shot']);
    stubBattleRng(state, [0.14]);

    simulate(state, 60);
    expect(e.hp).toBeCloseTo(1e6 - 330, 6); // 判中：总伤 = 弹伤 ×5.5（与既有爆头契约一致）
    const list = state.meta[SNIPER_CRIT_VFX_KEY] as SniperHitVfx[];
    expect(list).toHaveLength(1);
    expect(list[0].x).toBeCloseTo(360, 6);
    expect(list[0].y).toBeCloseTo(1020, 6);
    expect(state.events).toContainEqual({ kind: 'sfx', name: 'crit' });
  });

  it('列表有界（上限 16）：留存窗口内 20 次判中只保留最近 16 条；一次性 sfx 不节流（20 条全进队列）', () => {
    const { state, proj } = hookScene(['crit_shot'], Array.from({ length: 20 }, () => 0)); // 全判中
    state.timeMs = 100;
    const e = state.enemies[0];
    for (let i = 0; i < 20; i++) {
      behavior.onProjectileHit!(state, proj, e); // hp 1e7 撑住 20 次爆头（20×330）
    }

    const list = state.meta[SNIPER_CRIT_VFX_KEY] as SniperHitVfx[];
    expect(list).toHaveLength(16); // 丢弃最旧 4 条
    expect(list[0].x).toBeCloseTo(360, 6); // 幸存条目坐标仍正确
    const critSfx = state.events.filter((ev) => ev.kind === 'sfx' && ev.name === 'crit');
    expect(critSfx).toHaveLength(20); // 一次性 sfx 不节流：逐条入队（与 pushSfxThrottled 语义区分）
  });

  it('过期清理：untilMs 过期的条目在下次写入时被滚动过滤（execute 键同模式）', () => {
    const { state, proj } = hookScene(['execution_order'], []);
    state.timeMs = 100;
    const e1 = makeEnemy(state, 500, 1100, { hp: 150, maxHp: 1000 });
    behavior.onProjectileHit!(state, proj, e1); // 条目 untilMs = 400
    expect((state.meta[SNIPER_EXECUTE_VFX_KEY] as SniperHitVfx[]).length).toBe(1);

    state.timeMs = 500; // 第一条已过期（400 < 500）
    const e2 = makeEnemy(state, 600, 1150, { hp: 150, maxHp: 1000 });
    behavior.onProjectileHit!(state, proj, e2); // 新条目 untilMs = 800

    const list = state.meta[SNIPER_EXECUTE_VFX_KEY] as SniperHitVfx[];
    expect(list).toHaveLength(1); // 过期条目被滚动清除
    expect(list[0]).toEqual({ x: 600, y: 1150, untilMs: 800 });
  });
});

describe('边境折返（border_ricochet：计数快照 + 镜面反射 + 无 ttl 上限 H1）', () => {
  it('发射快照：无贯穿弹计数 1；1 张贯穿弹计数 3；2 张贯穿弹计数 5', () => {
    const s0 = createSimState(1);
    makeEnemy(s0, 360, 1020, { hp: 1e6 });
    fireOnce(s0, ['border_ricochet']);
    expect(s0.projectiles[0].pierceLeft).toBe(1);
    expect(s0.projectiles[0].data.border).toBe(1);

    const s1 = createSimState(1);
    makeEnemy(s1, 360, 1020, { hp: 1e6 });
    fireOnce(s1, ['border_ricochet', 'pierce_shot']);
    expect(s1.projectiles[0].pierceLeft).toBe(3); // 1 + 2×1

    const s2 = createSimState(1);
    makeEnemy(s2, 360, 1020, { hp: 1e6 });
    fireOnce(s2, ['border_ricochet', 'pierce_shot', 'pierce_shot']);
    expect(s2.projectiles[0].pierceLeft).toBe(5); // 1 + 2×2
  });

  it('基础计数 1 的脱靶反弹：目标中途死亡 → 弹越上缘反弹（vy 翻转为向下、不越出 y<0），计数不消耗', () => {
    const state = createSimState(1);
    const target = makeEnemy(state, 360, 1020, { hp: 1e6 });
    fireOnce(state, ['border_ricochet']);
    target.dead = true; // 脱靶：场上再无存活敌人

    let sawUp = false;
    let sawDownAfterBounce = false;
    let minY = Infinity;
    let pierceDuringFlight = -1;
    simulate(state, 200, 8, (s) => {
      const p = s.projectiles[0];
      if (!p) {
        return;
      }
      if (p.vy < 0) {
        sawUp = true;
      } else if (sawUp && p.vy > 0) {
        sawDownAfterBounce = true; // 反弹后下行
      }
      minY = Math.min(minY, p.y);
      pierceDuringFlight = p.pierceLeft;
    });

    expect(sawUp).toBe(true);
    expect(sawDownAfterBounce).toBe(true); // 镜面反射：垂直分量翻转
    expect(minY).toBeGreaterThanOrEqual(0); // 位置钳回界内（从不越出 y<0）
    expect(minY).toBeLessThanOrEqual(12.8); // 反射帧贴住上缘（8ms × 1600px/s = 12.8px 步长）
    expect(pierceDuringFlight).toBe(1); // 反弹不消耗命中计数
  });

  it('下边缘 = 墙线：下行弹越线反弹（y 钳回 wallLineY、vy 翻转为向上）', () => {
    const state = createSimState(1);
    makeEnemy(state, 100, 500, { hp: 1e6 }); // 偏侧目标：仅为开火提供索敌
    fireOnce(state, ['border_ricochet']);
    const p = state.projectiles[0];
    p.x = 360; // 手工布景：置于墙线上方 10px 处竖直下行
    p.y = 1150;
    p.vx = 0;
    p.vy = 1600;

    simulate(state, 2);
    expect(p.vy).toBeLessThan(0); // 反弹后向上
    expect(p.y).toBeLessThan(1160); // 已钳回墙线之内（反射帧后框架又向上位移一步）
    expect(p.dead).toBe(false);
  });

  it('左右边缘镜面反射：左缘 vx<0 → 翻转向右、x 钳回 0；右缘对称', () => {
    const left = createSimState(1);
    makeEnemy(left, 100, 500, { hp: 1e6 });
    fireOnce(left, ['border_ricochet']);
    const pl = left.projectiles[0];
    pl.x = 5;
    pl.y = 500;
    pl.vx = -1600;
    pl.vy = 0;
    simulate(left, 1);
    expect(pl.vx).toBeGreaterThan(0); // 翻转向右
    expect(pl.x).toBeCloseTo(12.8, 6); // 0 + 1600×0.008
    expect(pl.dead).toBe(false);

    const right = createSimState(1);
    makeEnemy(right, 100, 500, { hp: 1e6 });
    fireOnce(right, ['border_ricochet']);
    const pr = right.projectiles[0];
    pr.x = 715; // width 720
    pr.y = 500;
    pr.vx = 1600;
    pr.vy = 0;
    simulate(right, 1);
    expect(pr.vx).toBeLessThan(0); // 翻转向左
    expect(pr.x).toBeCloseTo(707.2, 6); // 720 - 12.8
  });

  it('贯穿弹计数消耗与销毁：计数 3 → 命中 3 个敌人后就地销毁（第 3 敌受击）', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 360, 1120, { hp: 1e6 });
    const e2 = makeEnemy(state, 360, 1000, { hp: 1e6 });
    const e3 = makeEnemy(state, 360, 880, { hp: 1e6 });
    fireOnce(state, ['border_ricochet', 'pierce_shot']); // 计数 1 + 2 = 3

    simulate(state, 200);
    expect(e1.hp).toBeCloseTo(1e6 - 60, 6);
    expect(e2.hp).toBeCloseTo(1e6 - 60, 6);
    expect(e3.hp).toBeCloseTo(1e6 - 60, 6); // 第 3 次命中（计数归零那次）正常结算
    expect(state.projectiles).toHaveLength(0); // 就地销毁
  });

  // —— H1（2026-09 补充轮）：持边境折返 → 取消 ttl 封顶；未持牌 → ttl 1200ms 照旧 ——
  it('H1 持边境折返：取消 ttl 封顶——脱靶弹跨过旧 ttl 1200ms 仍存活（计数满额、持续反弹）', () => {
    const state = createSimState(1);
    const target = makeEnemy(state, 360, 1020, { hp: 1e6 });
    fireOnce(state, ['border_ricochet']);
    expect(state.projectiles[0].ttlMs).toBe(Number.POSITIVE_INFINITY); // 发射即无寿命上限（语义常量）
    target.dead = true; // 脱靶：纯折返飞行

    let aliveFrames = 0;
    let pierceAt1200 = -1;
    simulate(state, 300, 8, (s) => {
      const p = s.projectiles[0];
      if (p) {
        aliveFrames++;
        if (s.timeMs >= 1200 && pierceAt1200 === -1) {
          pierceAt1200 = p.pierceLeft;
        }
      }
    });

    expect(aliveFrames).toBe(300); // 300 帧 = 2400ms ≫ 旧 ttl 1200ms：全程在场，从未销毁
    expect(state.timeMs).toBe(2400);
    expect(pierceAt1200).toBe(1); // 跨过旧 ttl 时点时计数仍满额（不因寿命消失）
    expect(state.projectiles).toHaveLength(1); // 计数未耗尽：仍在反弹飞行
  });

  it('H1 对照（未持边境折返）：普通弹 ttl 1200ms 照旧到期销毁', () => {
    const state = createSimState(1);
    const target = makeEnemy(state, 360, 1020, { hp: 1e6 });
    fireOnce(state); // 无边境折返：data.border = 0
    expect(state.projectiles[0].ttlMs).toBe(1200); // 未持牌弹寿命完全不变
    expect(state.projectiles[0].data.border).toBe(0);
    target.dead = true; // 脱靶

    simulate(state, 300, 8);
    expect(state.timeMs).toBe(1200); // 150 帧 × 8ms：恰在 ttl 到期销毁（语义不变）
    expect(state.projectiles).toHaveLength(0);
  });

  it('H1 不变式：持边境折返的弹不存在「计数未耗尽即消失」路径——任意长飞行每帧在场', () => {
    const state = createSimState(1);
    const target = makeEnemy(state, 360, 1020, { hp: 1e6 });
    fireOnce(state, ['border_ricochet', 'pierce_shot', 'pierce_shot']); // 计数 1+4 = 5
    target.dead = true; // 全程脱靶：纯折返飞行（反射→反弹→再反射→…）

    let aliveFrames = 0;
    let minPierce = Infinity;
    simulate(state, 400, 8, (s) => {
      if (s.projectiles.length > 0) {
        aliveFrames++;
        minPierce = Math.min(minPierce, s.projectiles[0].pierceLeft);
      }
    });

    // 400 帧 = 3200ms（旧 ttl 1200ms 的 2.7 倍）：弹每一帧都在场上、计数全程满 5——
    // ttl 已取消，反射/计数扣减/销毁顺序均无提前死亡分支，生命周期只由计数驱动。
    expect(aliveFrames).toBe(400);
    expect(minPierce).toBe(5);
    expect(state.timeMs).toBe(3200);
    expect(state.projectiles).toHaveLength(1);
  });

  it('H1 反弹可达性：上缘反弹后弹可折返命中墙前敌群（原 ttl 封顶下几何不可达），计数耗尽才销毁', () => {
    // 原 F1 几何论据消解：旧 ttl 1200ms 下竖直上射脱靶弹反弹后剩余航程 ≤700px，永远回不到
    // y≈1050~1160 的敌群带；H1 取消封顶后弹无限折返，返程必然扫过墙前敌群带并命中。
    const state = createSimState(1);
    const miss = makeEnemy(state, 360, 1020, { hp: 1e6 }); // 开火索敌用，随即标记死亡（脱靶虚构）
    fireOnce(state, ['border_ricochet', 'pierce_shot', 'pierce_shot']); // 计数 5
    const p = state.projectiles[0];
    p.x = 360; // 手工布景：弹已在半途（y=200）竖直上行——越过了墙前敌群带
    p.y = 200;
    p.vx = 0;
    p.vy = -1600;
    miss.dead = true;
    const e2 = makeEnemy(state, 360, 1100, { hp: 1e6 }); // 返程路径上的墙前敌群

    simulate(state, 300, 8);

    expect(e2.hp).toBeCloseTo(1e6 - 60, 6); // 反弹折返后命中敌群（恰一次：hitIds 去重）
    expect(p.pierceLeft).toBe(4); // 命中消耗 1，未耗尽
    expect(state.timeMs).toBe(2400); // 飞行 2400ms ≫ 旧 ttl 1200ms：寿命上限确实已取消
    expect(state.projectiles).toHaveLength(1); // 计数未耗尽：继续折返飞行（仅在耗尽命中后销毁）
  });

  it('F1 嫌疑排查：maxProjectiles 帧首回收按最小 id（最旧优先）——刚发射的边境弹不会被回收', () => {
    // id 随发射自增（spawnProjectile = state.nextId++）：刚发射的弹 id 最大、最后才被
    // 回收。护栏只在弹量超上限（正常对局峰值 ≈100，上限 600）的死亡螺旋里才触发，
    // 且总是先杀最旧弹——不构成「刚发射的边境弹消失」的路径。
    const state = createSimState(1, { maxProjectiles: 3 });
    makeEnemy(state, 360, 1020, { hp: 1e6 }); // id 1：开火目标
    spawnProjectile(state, { x: -100, y: -100, vx: 0, vy: 0, ttlMs: 5000 }); // id 2（旧裸弹）
    spawnProjectile(state, { x: -100, y: -100, vx: 0, vy: 0, ttlMs: 5000 }); // id 3（旧裸弹）
    fireOnce(state, ['border_ricochet', 'pierce_shot', 'pierce_shot']); // 边境弹 id 4（刚发射），计数 5
    const border = state.projectiles.find((q) => q.id === 4)!;
    expect(border.pierceLeft).toBe(5);
    expect(state.projectiles).toHaveLength(3); // 恰好不超限
    spawnProjectile(state, { x: -100, y: -100, vx: 0, vy: 0, ttlMs: 5000 }); // id 5 → 超限 1

    updateProjectiles(state, 8, new SpatialHash<Enemy>(64));

    // 只有 id 最小的旧裸弹 2 被护栏回收；刚发射的边境弹 4 与其余裸弹都存活。
    expect(state.projectiles.map((q) => q.id).sort((a, b) => a - b)).toEqual([3, 4, 5]);
    const survived = state.projectiles.find((q) => q.id === border.id)!;
    expect(survived.pierceLeft).toBe(5); // 护栏只动 ttl，不碰命中计数
  });

  it('反射只对发射时快照 border=1 的弹生效：拿牌前的旧弹照常飞出场外', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1020, { hp: 1e6 });
    fireOnce(state); // 无边境折返：data.border = 0
    const p = state.projectiles[0];
    expect(p.data.border).toBe(0);
    p.x = 360;
    p.y = 10;
    p.vx = 0;
    p.vy = -1600; // 即将越出上缘

    simulate(state, 2);
    expect(p.vy).toBeLessThan(0); // 未反射：速度原样
    expect(p.y).toBeLessThan(0); // 直接越出场外（框架无边界回收，ttl 照常计时）
  });

  it('零长帧（dt=0）不判定反射：反弹后贴边状态不逐帧抖动', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1020, { hp: 1e6 });
    fireOnce(state, ['border_ricochet']);
    const p = state.projectiles[0];
    p.x = 0; // 恰在上一次反弹的钳位点（速度已向内）
    p.y = 100;
    p.vx = 1600;
    p.vy = 0;

    behavior.update!(state, 0);
    expect(p.vx).toBe(1600); // 速度不被误翻转
    expect(p.x).toBe(0);
  });
});

describe('死代码清理（多射/连射/分裂/命中减速无残留）', () => {
  it('牌池：multi_shot/burst_shot/split_shot 不再适用狙击（cards.json applyTo + 合并牌池双断言）', () => {
    const raw = loadCardDefs();
    for (const id of ['multi_shot', 'burst_shot', 'split_shot']) {
      const card = raw.find((c) => c.id === id);
      expect(card, `cards.json 缺 ${id}`).toBeDefined();
      expect(card!.applyTo).not.toContain('charge_sniper');
    }
    const def = loadWeaponDefs().charge_sniper;
    const ids = def.cards.map((c) => c.id);
    expect(ids).not.toContain('multi_shot');
    expect(ids).not.toContain('burst_shot');
    expect(ids).not.toContain('split_shot');
  });

  it('三选一不再出现：狙击持有者的候选池永不含三张通用牌', () => {
    const state = createSimState(1);
    const zeroRng: Rng = {
      next: () => 0,
      int: () => 0,
      range: (min) => min,
      pick: (list) => list[0],
    };
    state.rng = zeroRng;
    state.weaponStates.charge_sniper = { level: 0, cooldownMs: 0, cards: {} };
    const options = rollUpgradeOptions(state, loadWeaponDefs(), 99);
    expect(options.length).toBeGreaterThan(0);
    const banned = new Set(['multi_shot', 'burst_shot', 'split_shot']);
    for (const o of options) {
      if (o.kind === 'card') {
        expect(banned.has(o.cardId)).toBe(false);
      }
    }
  });

  it('行为残留：强塞通用牌计数也不产生效果（恒单发、无待发波、无次级弹、无 slow 模板）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1020, { hp: 1e6 });
    // 牌计数直接写入 ws（绕过 applyTo）：buildWeaponStats 只解释 def.cards 内的牌 → 全部失效。
    fireOnce(state, ['multi_shot', 'multi_shot', 'multi_shot', 'multi_shot', 'burst_shot', 'burst_shot', 'split_shot', 'slow_hit']);
    expect(state.projectiles).toHaveLength(1); // 恒单发（无扇形展开）
    expect(state.meta[BURST_QUEUE_META_KEY]).toBeUndefined(); // 无连射待发波
    expect(state.projectiles[0].effectsOnHit.map((t) => t.kind)).toEqual(['mark']); // 无 slow 模板
    expect(state.projectiles[0].data.splitReady).toBeUndefined(); // 无分裂快照

    // 命中钩子不再分裂：直调 onProjectileHit 不产生次级弹。
    const p = state.projectiles[0];
    p.x = e.x;
    p.y = e.y;
    behavior.onProjectileHit!(state, p, e);
    expect(state.projectiles).toHaveLength(1);
  });

  it('update 钩子不再消费连射队列：预置到期波条目原样保留（只做边境反射扫描）', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1020, { hp: 1e6 });
    state.meta[BURST_QUEUE_META_KEY] = [
      { weaponId: 'charge_sniper', behavior: 'charge_sniper', dueAtMs: 0, stats: { damage: 60 } },
    ];
    behavior.update!(state, 16);
    expect(state.meta[BURST_QUEUE_META_KEY]).toHaveLength(1); // 未被消费
    expect(state.projectiles).toHaveLength(0); // 也未重放产弹
  });

  it('命中减速已删除：slow_hit 不在牌池、stats 无 slowHit 键', () => {
    const def = loadWeaponDefs().charge_sniper;
    expect(def.cards.find((c) => c.id === 'slow_hit')).toBeUndefined();

    const state = createSimState(1);
    makeEnemy(state, 360, 1020, { hp: 1e6 });
    const stats = fireOnce(state);
    expect(stats.slowHit).toBeUndefined();
  });
});

describe('数值全部来自 weapons/charge_sniper.json（真实表驱动，任务三牌池）', () => {
  const def = loadWeaponDefs().charge_sniper;

  it('表身份：id/name/behavior/maxLevel=10，behavior 已自动发现注册', () => {
    expect(def.id).toBe('charge_sniper');
    expect(def.name).toBe('蓄能狙击');
    expect(def.behavior).toBe('charge_sniper');
    expect(def.maxLevel).toBe(10);
    expect(getBehavior('charge_sniper')).toBe(behavior); // import.meta.glob 自动注册
  });

  it('牌目录：专属牌六张（pierce_shot/headshot/execute_up/crit_shot/execution_order/border_ricochet），通用牌仅伤害/攻速', () => {
    expect(def.cards.slice(0, 6).map((c) => c.id)).toEqual([
      'pierce_shot',
      'headshot',
      'execute_up',
      'crit_shot',
      'execution_order',
      'border_ricochet',
    ]);
    const ids = def.cards.map((c) => c.id);
    // 通用牌（数据层按 applyTo 合并）：任务三后狙击仅剩伤害/攻速两张。
    for (const genericId of ['dmg_up', 'spd_up']) {
      expect(ids).toContain(genericId);
    }
    // 三张弹道通用牌与范围/dot 牌均不适用。
    for (const banned of ['multi_shot', 'burst_shot', 'split_shot', 'range_up', 'dot_freq', 'slow_hit']) {
      expect(ids).not.toContain(banned);
    }
  });

  it('base 数值随表（无 crit/headshot 等开关键；爆头参数在斩首牌 params 而非 base）', () => {
    expect(def.base).toMatchObject({
      damage: 60, intervalMs: 2400, projectileSpeed: 1600, pierce: 0, ttlMs: 1200, fastSpeedThreshold: 80,
    });
    expect(def.base.critShot).toBeUndefined();
    expect(def.base.critChance).toBeUndefined();
    expect(def.base.critMultiplier).toBeUndefined();
    expect(def.base.headshot).toBeUndefined();

    const headshot = def.cards.find((c) => c.id === 'headshot')!;
    expect(headshot.once).toBe(true);
    expect(headshot.params).toEqual([
      { key: 'headshot', value: 1, op: 'set' },
      { key: 'headshotHpFactor', value: 0.6, op: 'set' },
      { key: 'headshotMultiplier', value: 1.5, op: 'set' },
    ]);

    const executeUp = def.cards.find((c) => c.id === 'execute_up')!;
    expect(executeUp.requiresCard).toBe('headshot');
  });

  it('新增三张牌 once 语义与参数随表：拿到一张后从牌池移除', () => {
    for (const id of ['crit_shot', 'execution_order', 'border_ricochet']) {
      const card = def.cards.find((c) => c.id === id)!;
      expect(card.once, `${id} 应为 once 牌`).toBe(true);
    }
    const wsWith = { level: 1, cooldownMs: 0, cards: { crit_shot: 1 } };
    const pool = availableCards(def, wsWith, false).map((c) => c.id);
    expect(pool).not.toContain('crit_shot');
    expect(pool).toContain('execution_order'); // 未持有仍在池
  });

  it('升级池前置依赖：未持有 headshot 时 execute_up 绝对不出现；持有 headshot（≥1）时正常进入可选池', () => {
    const wsWithout = { level: 0, cooldownMs: 0, cards: {} };
    const poolWithout = availableCards(def, wsWithout, false).map((c) => c.id);
    expect(poolWithout).not.toContain('execute_up');

    const wsWith = { level: 1, cooldownMs: 0, cards: { headshot: 1 } };
    const poolWith = availableCards(def, wsWith, false).map((c) => c.id);
    expect(poolWith).toContain('execute_up');
  });

  it('牌组 stats 注入：伤害乘区、贯穿与三张新牌参数全部随牌（改 json 即变）', () => {
    const shoot = (cards: string[]): WeaponStats => {
      const state = createSimState(1);
      makeEnemy(state, 360, 1020, { speed: 90, hp: 200, maxHp: 1e6 });
      return fireOnce(state, cards);
    };
    expect(shoot([]).damage).toBeCloseTo(60, 9);
    expect(shoot(['dmg_up']).damage).toBeCloseTo(78, 9); // 60 × 1.3
    expect(shoot(['dmg_up', 'dmg_up']).damage).toBeCloseTo(60 * 1.3 * 1.3, 9);
    expect(shoot(['headshot']).headshotMultiplier).toBeCloseTo(1.5, 9);
    expect(shoot(['headshot', 'execute_up']).headshotMultiplier).toBeCloseTo(1.75, 9);
    expect(shoot(['pierce_shot']).pierce).toBe(2);
    expect(shoot(['pierce_shot', 'pierce_shot']).pierce).toBe(4);
    expect(shoot(['crit_shot']).critMultiplier).toBeCloseTo(5.5, 12);
    expect(shoot(['execution_order']).executionXpFactor).toBeCloseTo(1.25, 12);
    expect(shoot(['execution_order']).executionHpFactor).toBeCloseTo(0.2, 12);
    expect(shoot(['execution_order']).executionBossHpFactor).toBeCloseTo(0.07, 12);
    expect(shoot(['border_ricochet']).borderRicochet).toBe(1);
  });
});
