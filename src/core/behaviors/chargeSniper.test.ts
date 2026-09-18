// src/core/behaviors/chargeSniper.test.ts —— 蓄能狙击行为契约（T5.3a 牌池制更新）：
// 目标优先级四级（boss > attack 贴墙高威胁层 > 快速怪 speed≥阈值 > 最近，平距取先出现者；
// T5.2a：attack 层压过 fast——贴墙 tank 正在打墙，不再被任何行军快速怪饿死）、无敌人不开火
// 且冷却归 0、移动预测（leadAim 提前量：行军主目标必中）、蓄力节奏（intervalMs=2400 连续
// step 只在累计到点时 fire；攻速强化牌按 ÷1.3 乘区缩短）、mark 恒带模板 + 命中后 dealDamage
// ×1.25 联动（首发不享受）、贯穿（贯穿弹牌：pierce +2/张，直线贯穿多个）、爆头（斩首牌：
// 高血 ×1.5；处决强化牌：倍率 +0.25/张）、命中减速（slow_hit 牌：slow 挂槽 speedMultiplier<1
// 且与 mark 共存）、暴击全面移除（数据与行为都不再消费 rng）、
// 数值全部来自 weapons/charge_sniper.json 真实表驱动（牌组经 getWeaponStats 注入 stats）。
import { describe, expect, it } from 'vitest';
import { loadEffectDefs } from '../../data/effects';
import { loadWeaponDefs } from '../../data/weapons';
import { damageTakenFactor, dealDamage, hasEffect, speedMultiplier } from '../effects';
import { normalize, scale } from '../math';
import { updateProjectiles } from '../projectiles';
import { createSimState } from '../simState';
import { SpatialHash } from '../spatialHash';
import type { Enemy, SimState } from '../types';
import { addWeapon, getWeaponStats, updateWeapons } from '../weapons';
import type { WeaponStats } from '../weapons';
import { behavior } from './behavior_chargeSniper';
import { availableCards, BURST_QUEUE_META_KEY, type BurstWaveEntry } from '../cards';
import './index'; // 副作用：自动发现注册
import { getBehavior } from './registry';

// 副作用：把 effects.json 真实效果表注册进 core/effects（mark/slow 效果槽依赖）。
loadEffectDefs();

interface EnemyOpts {
  hp?: number;
  /** 覆盖 maxHp（与 hp 解耦，构造「残血高上限」目标）。缺省与 hp 相同（满血）。 */
  maxHp?: number;
  speed?: number;
  isBoss?: boolean;
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
    xp: 1,
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
 * T5.3a：等级→牌组——cards 数组即该武器已吃的牌（重复项 = 可重复牌多张）。
 */
function fireOnce(state: SimState, cards: string[] = []): WeaponStats {
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
  behavior.fire(state, 'charge_sniper', stats);
  return stats;
}

/**
 * 逐帧推进弹丸（帧序与生产一致），弹清空或帧数用尽即止；每帧推进 state.timeMs
 * （效果 untilMs 在 state.timeMs 时间轴上）。
 */
function simulate(state: SimState, frames: number, dt = 8): void {
  const grid = new SpatialHash<Enemy>(64);
  for (let f = 0; f < frames && state.projectiles.length > 0; f++) {
    updateProjectiles(state, dt, grid);
    state.timeMs += dt;
  }
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

    // attack 怪速度 (0,0)：提前量退化为直接瞄准当前位置——旧三级优先级（boss>fast>最近）
    // 在此场景会打快速 runner，四级把 attack 层插到 fast 之前。
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
      updateWeapons(state, 100, defs); // 累计 1800ms：1800 - 1846.15 < 0？→ 未到点不开火
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

describe('暴击全面移除（T5.3a：数据与行为都不再消费 rng）', () => {
  it('真实表 base 无 critChance/critMultiplier；任何牌组下 stats 也不含 crit 键', () => {
    const def = loadWeaponDefs().charge_sniper;
    expect(def.base.critChance).toBeUndefined();
    expect(def.base.critMultiplier).toBeUndefined();
    for (const cards of [[], ['pierce_shot'], ['headshot', 'execute_up', 'execute_up'], ['slow_hit']]) {
      const state = createSimState(1);
      const stats = fireOnce(state, cards);
      expect(stats.crit).toBeUndefined();
      expect(stats.critChance).toBeUndefined();
      expect(stats.critMultiplier).toBeUndefined();
    }
  });

  it('零随机消耗：任何牌组 fire 都不掷 rng（确定性，与旧暴击 rng 判定不同）', () => {
    let calls = 0;
    const state = createSimState(1);
    state.rng = {
      next: () => {
        calls += 1;
        return 0;
      },
      int: () => 0,
      range: () => 0,
      pick: (list) => list[0],
    };
    makeEnemy(state, 360, 1020, { speed: 90, hp: 1e6 });
    fireOnce(state, ['pierce_shot', 'headshot']);
    expect(calls).toBe(0); // 暴击删除后本行为全程零随机
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

describe('爆头（headshot 斩首牌 + execute_up 处决强化牌）', () => {
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

describe('命中减速（slow_hit 牌）', () => {
  it('slow_hit 弹追加 slow 模板：命中敌人挂 slow（speedMultiplier 0.5 < 1）且与 mark 共存', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1020, { speed: 90, hp: 200, maxHp: 1000 });
    fireOnce(state, ['slow_hit']);
    expect(state.projectiles[0].effectsOnHit.map((t) => t.kind)).toEqual(['mark', 'slow']);

    simulate(state, 200);
    expect(e.hp).toBeCloseTo(140, 6); // 60 伤害，未致死可挂效果
    expect(hasEffect(e, 'slow')).toBe(true);
    expect(speedMultiplier(e)).toBeCloseTo(0.5, 12); // effects.json speedFactor
    expect(hasEffect(e, 'mark')).toBe(true); // mark 恒带：双效果共存
  });

  it('对照无 slow_hit：只有 mark，不挂 slow', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1020, { speed: 90, hp: 200, maxHp: 1000 });
    fireOnce(state, ['headshot']); // 用斩首牌隔离 slow_hit 开关（残血目标爆头不触发）
    expect(state.projectiles[0].effectsOnHit.map((t) => t.kind)).toEqual(['mark']);

    simulate(state, 200);
    expect(hasEffect(e, 'slow')).toBe(false);
    expect(speedMultiplier(e)).toBe(1);
  });
});

describe('数值全部来自 weapons/charge_sniper.json（真实表驱动，T5.3a 牌池制）', () => {
  const def = loadWeaponDefs().charge_sniper;

  it('表身份：id/name/behavior/maxLevel=10，behavior 已自动发现注册', () => {
    expect(def.id).toBe('charge_sniper');
    expect(def.name).toBe('蓄能狙击');
    expect(def.behavior).toBe('charge_sniper');
    expect(def.maxLevel).toBe(10);
    expect(getBehavior('charge_sniper')).toBe(behavior); // import.meta.glob 自动注册
  });

  it('牌目录：专属牌在前（pierce_shot/headshot/execute_up/slow_hit），通用牌由数据层合并追加', () => {
    expect(def.cards.slice(0, 4).map((c) => c.id)).toEqual(['pierce_shot', 'headshot', 'execute_up', 'slow_hit']);
    const ids = def.cards.map((c) => c.id);
    // 弹道五武器通用牌（数据层按 applyTo 合并）：伤害/攻速/多射/连射/分裂。
    for (const genericId of ['dmg_up', 'spd_up', 'multi_shot', 'burst_shot', 'split_shot']) {
      expect(ids).toContain(genericId);
    }
    // 狙击无范围概念：范围强化/dot频率不适用（applyTo 未收录）。
    expect(ids).not.toContain('range_up');
    expect(ids).not.toContain('dot_freq');
  });

  it('base 数值随表（暴击字段已删除；爆头参数在斩首牌 params 而非 base）', () => {
    expect(def.base).toMatchObject({
      damage: 60, intervalMs: 2400, projectileSpeed: 1600, pierce: 0, ttlMs: 1200, fastSpeedThreshold: 80,
    });
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

  it('升级池前置依赖：未持有 headshot 时 execute_up 绝对不出现；持有 headshot（≥1）时正常进入可选池', () => {
    const wsWithout = { level: 0, cooldownMs: 0, cards: {} };
    const poolWithout = availableCards(def, wsWithout, false).map((c) => c.id);
    expect(poolWithout).not.toContain('execute_up');

    const wsWith = { level: 1, cooldownMs: 0, cards: { headshot: 1 } };
    const poolWith = availableCards(def, wsWith, false).map((c) => c.id);
    expect(poolWith).toContain('execute_up');
  });

  it('牌组 stats 注入：伤害乘区与开关全部随牌（改 json 即变）', () => {
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
  });
});

// —— T5.3b 弹道机制接线：多射 / 连射 / 分裂 ——

describe('多射（multi_shot 牌：主轴保底 0° + 侧翼 4° 交替展开）', () => {
  it('1 张多射发 2 枚（第 0 发 -90°，第 1 发 -86°）；同伤害同效果模板；2 张多射发 3 枚', () => {
    const two = createSimState(1);
    makeEnemy(two, 360, 1020, { hp: 1e6 }); // 静止主目标正上：主方向 -90°
    fireOnce(two, ['multi_shot']);
    expect(two.projectiles).toHaveLength(2);
    const ang0 = (Math.atan2(two.projectiles[0].vy, two.projectiles[0].vx) * 180) / Math.PI;
    const ang1 = (Math.atan2(two.projectiles[1].vy, two.projectiles[1].vx) * 180) / Math.PI;
    expect(ang0).toBeCloseTo(-90, 6); // 第 0 发严格锁定主目标方向（0 偏差必中）
    expect(ang1).toBeCloseTo(-86, 6); // 第 1 发侧翼 +4°
    for (const p of two.projectiles) {
      expect(p.damage).toBeCloseTo(60, 9); // 整波同一伤害快照
      expect(p.effectsOnHit.map((t) => t.kind)).toEqual(['mark']);
      expect(Math.hypot(p.vx, p.vy)).toBeCloseTo(1600, 6);
    }

    const three = createSimState(1);
    makeEnemy(three, 360, 1020, { hp: 1e6 });
    fireOnce(three, ['multi_shot', 'multi_shot']);
    expect(three.projectiles).toHaveLength(3);
  });

  it('无牌恒 1 枚（base 无 projectileCount 键，缺省兜底 1）', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1020, { hp: 1e6 });
    fireOnce(state);
    expect(state.projectiles).toHaveLength(1);
  });
});

describe('连射（burst_shot 牌：meta 待发波队列 + update 重放）', () => {
  it('1 张连射：首波即时 1 枚；150ms 后 update 重放第 2 波——重放重新选目标（旧目标已死 → 打新最近）', () => {
    const state = createSimState(1);
    const a = makeEnemy(state, 360, 1150, { hp: 1e6 }); // 最近（正上）
    const b = makeEnemy(state, 460, 1150, { hp: 1e6 }); // 次近
    fireOnce(state, ['burst_shot']);
    expect(state.projectiles).toHaveLength(1);
    expect(state.projectiles[0].vx).toBeCloseTo(0, 6); // 首波指向 a
    expect(state.projectiles[0].damage).toBeCloseTo(60, 9);

    const queue = state.meta[BURST_QUEUE_META_KEY] as BurstWaveEntry[];
    expect(queue).toHaveLength(1); // 1 张牌 = 1 个跟发波
    expect(queue[0].dueAtMs).toBeCloseTo(150, 9);

    a.dead = true; // 重放时重新执行目标选择：a 已死 → 打新最近 b
    state.timeMs += 150;
    behavior.update!(state, 16);
    expect(state.projectiles).toHaveLength(2);
    const expected = scale(normalize({ x: b.x - 360, y: b.y - 1220 }), 1600);
    expect(state.projectiles[1].vx).toBeCloseTo(expected.x, 6);
    expect(state.projectiles[1].vy).toBeCloseTo(expected.y, 6);
    expect(state.meta[BURST_QUEUE_META_KEY] as BurstWaveEntry[]).toHaveLength(0); // 队列清空
  });

  it('2 张连射 → 2 个跟发波（150/300ms 各一波）；与多射联动：每波都是完整 N 颗', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1020, { hp: 1e6 });
    fireOnce(state, ['burst_shot', 'burst_shot', 'multi_shot']);
    expect(state.projectiles).toHaveLength(2); // 首波 2 枚

    state.timeMs += 150;
    behavior.update!(state, 16);
    expect(state.projectiles).toHaveLength(4); // 第 2 波完整 2 枚

    state.timeMs += 150;
    behavior.update!(state, 16);
    expect(state.projectiles).toHaveLength(6); // 第 3 波完整 2 枚
  });

  it('重放按开火时的 stats 快照结算：发射后补伤害牌不影响在途波', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1020, { hp: 1e6 });
    fireOnce(state, ['burst_shot']); // 快照 damage 60
    state.weaponStates.charge_sniper.cards.dmg_up = 1; // 此后的 fire 才是 78

    state.timeMs += 150;
    behavior.update!(state, 16);
    expect(state.projectiles[1].damage).toBeCloseTo(60, 9); // 重放波按快照
  });

  it('重放时无目标：波静默跳过（不产弹、不改冷却）', () => {
    const state = createSimState(1);
    const a = makeEnemy(state, 360, 1020, { hp: 1e6 });
    fireOnce(state, ['burst_shot']);
    a.dead = true;
    state.weaponStates.charge_sniper.cooldownMs = 2400; // 预置冷却：重放不得改写
    state.timeMs += 150;
    behavior.update!(state, 16);
    expect(state.projectiles).toHaveLength(1); // 仅首波在途弹：重放波无目标静默跳过
    expect(state.weaponStates.charge_sniper.cooldownMs).toBe(2400);
  });
});

describe('分裂（split_shot 牌：主弹首命中分裂次级弹）', () => {
  /** 布景：主目标 (360,1100) 最近；s2/s3（44.72px）并列次近（数组序裁决）、s4（50px）、s1（60px）更远。 */
  function splitScene() {
    const state = createSimState(1);
    const main = makeEnemy(state, 360, 1100, { hp: 1e6 }); // 距角色 120：开火目标 & 命中点
    const s1 = makeEnemy(state, 360, 1040, { hp: 1e6 }); // 距命中点 60（第 5 近：不该被锁定）
    const s2 = makeEnemy(state, 400, 1060, { hp: 1e6 }); // 距命中点 44.72（并列先入数组）
    const s3 = makeEnemy(state, 320, 1060, { hp: 1e6 }); // 距命中点 44.72（并列后入数组）
    const s4 = makeEnemy(state, 410, 1100, { hp: 1e6 }); // 距命中点 50
    const far = makeEnemy(state, 700, 700, { hp: 1e6 }); // 远旁观者
    fireOnce(state, ['split_shot']);
    const p = state.projectiles[0];
    p.x = 360; // 模拟主弹飞抵命中点（框架在命中时把弹推进到该处后调钩子）
    p.y = 1100;
    return { state, main, s1, s2, s3, s4, far, p };
  }

  it('命中点分裂 4 枚：伤害 = 60×0.2 = 12、锁定 [s2, s3, s4, s1]（最近且互不相同、排除刚命中目标）', () => {
    const { state, main, s1, s2, s3, s4, far, p } = splitScene();
    behavior.onProjectileHit!(state, p, main);

    expect(state.projectiles).toHaveLength(5); // 主弹 + 4 枚次级弹
    const secondaries = state.projectiles.slice(1);
    for (const sec of secondaries) {
      expect(sec.damage).toBeCloseTo(12, 9); // 60 × splitDamageFactor 0.2
      expect(sec.pierceLeft).toBe(0); // 次级弹锁定单一目标：不再穿透
      expect(sec.effectsOnHit.map((t) => t.kind)).toEqual(['mark']); // 同弹种：mark 模板随行
      expect(sec.data.splitReady).toBe(0); // 封死再分裂
      expect(sec.data.splitDone).toBe(1);
      expect(sec.hitIds).toEqual([main.id]); // 预置主弹命中目标：穿越出生重叠圈不重复结算
      expect(Math.hypot(sec.vx, sec.vy)).toBeCloseTo(1600, 6); // 同弹速
    }
    // 方向 → 目标一一对应（排除刚命中的 main；最近且互不相同：s2/s3(44.72 并列取数组序) > s4(50) > s1(60)）
    const targets = [s2, s3, s4, s1];
    const matched = new Set<number>();
    for (const sec of secondaries) {
      const dir = normalize({ x: sec.vx, y: sec.vy });
      const hit = targets.find((t) => {
        const to = normalize({ x: t.x - 360, y: t.y - 1100 });
        return Math.abs(to.x - dir.x) < 1e-9 && Math.abs(to.y - dir.y) < 1e-9;
      });
      expect(hit).toBeDefined();
      expect(matched.has(hit!.id)).toBe(false); // 互不相同
      matched.add(hit!.id);
    }
    expect(far.hp).toBe(1e6);

    // 端到端：次级弹穿越主目标重叠圈（hitIds 预置去重）各命中一次（12 伤），不再分裂
    const grid = new SpatialHash<Enemy>(64);
    for (let f = 0; f < 40 && state.projectiles.length > 0; f++) {
      updateProjectiles(state, 8, grid);
      state.timeMs += 8;
    }
    expect(state.projectiles).toHaveLength(0);
    expect(main.hp).toBeCloseTo(1e6 - 60, 6); // 主弹直击；次级弹预置去重不在原地空转
    expect(s2.hp).toBeCloseTo(1e6 - 12, 6);
    expect(s3.hp).toBeCloseTo(1e6 - 12, 6);
    expect(s4.hp).toBeCloseTo(1e6 - 12, 6);
    expect(s1.hp).toBeCloseTo(1e6 - 12, 6);
  });

  it('候选不足 → 有几个锁几个（排除主目标后仅 1 个 → 1 枚次级弹）；未拿分裂牌 → 不分裂', () => {
    const state = createSimState(1);
    const main = makeEnemy(state, 360, 1100, { hp: 1e6 });
    const other = makeEnemy(state, 360, 1040, { hp: 1e6 });
    fireOnce(state, ['split_shot']);
    const p = state.projectiles[0];
    p.x = 360;
    p.y = 1100;
    behavior.onProjectileHit!(state, p, main);
    expect(state.projectiles).toHaveLength(2); // 主弹 + 1 枚次级弹（锁 other）
    const sec = state.projectiles[1];
    const dir = normalize({ x: sec.vx, y: sec.vy });
    const to = normalize({ x: other.x - 360, y: other.y - 1100 });
    expect(dir.x).toBeCloseTo(to.x, 9); // 次级弹方向指向 other
    expect(dir.y).toBeCloseTo(to.y, 9);

    const only = createSimState(1);
    const target = makeEnemy(only, 360, 1100, { hp: 1e6 });
    fireOnce(only, ['split_shot']);
    const q = only.projectiles[0];
    q.x = 360;
    q.y = 1100;
    behavior.onProjectileHit!(only, q, target);
    expect(only.projectiles).toHaveLength(1); // 排除刚命中目标后无候选：不产次级弹

    const plain = createSimState(1);
    const plainTarget = makeEnemy(plain, 360, 1100, { hp: 1e6 });
    fireOnce(plain);
    const raw = plain.projectiles[0];
    raw.x = 360;
    raw.y = 1100;
    behavior.onProjectileHit!(plain, raw, plainTarget);
    expect(plain.projectiles).toHaveLength(1); // 无分裂牌：无次级弹
  });

  it('不吃多射/连射：次级弹数量恒 = splitMax 封顶（每主弹 4 枚）、分裂不入连射待发队列', () => {
    const state = createSimState(1);
    const a = makeEnemy(state, 360, 1150, { hp: 1e6 }); // 距 70：最近
    const b = makeEnemy(state, 360, 1100, { hp: 1e6 }); // 距 120
    makeEnemy(state, 400, 1080, { hp: 1e6 });
    makeEnemy(state, 320, 1080, { hp: 1e6 });
    makeEnemy(state, 410, 1150, { hp: 1e6 });
    fireOnce(state, ['split_shot', 'multi_shot', 'burst_shot']);
    expect(state.projectiles).toHaveLength(2); // 多射：主波 2 枚
    const queue = state.meta[BURST_QUEUE_META_KEY] as BurstWaveEntry[];
    expect(queue).toHaveLength(1); // 连射：1 个跟发波已排入

    // 两枚主弹分别命中（不同命中点）→ 各分裂 4 枚（不吃多射加成）
    const first = state.projectiles[0];
    first.x = a.x;
    first.y = a.y;
    behavior.onProjectileHit!(state, first, a);
    const second = state.projectiles[1];
    second.x = b.x;
    second.y = b.y;
    behavior.onProjectileHit!(state, second, b);
    expect(state.projectiles).toHaveLength(10); // 2 主弹 + 8 次级弹（2×4，多射不加倍次级弹数）
    expect(state.meta[BURST_QUEUE_META_KEY] as BurstWaveEntry[]).toHaveLength(1); // 分裂不吃连射：队列不变
    for (const sec of state.projectiles.slice(2)) {
      expect(sec.data.splitReady).toBe(0);
    }
  });
});
