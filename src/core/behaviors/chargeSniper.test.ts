// src/core/behaviors/chargeSniper.test.ts —— 蓄能狙击行为契约（专属牌池重构后）：
// 目标优先级四级（boss > attack 贴墙高威胁层 > 快速怪 speed≥阈值 > 最近，平距取先出现者）、
// 无敌人不开火且冷却归 0、移动预测（leadAim 提前量：行军主目标必中）、蓄力节奏
// （intervalMs=2000 连续 step 只在累计到点时 fire；禁用攻速强化牌）、mark 恒带模板。
//
// 专属牌池重构：
// - 移除贯穿弹（pierce_shot）与边境折返（border_ricochet）；
// - 保留斩首（headshot）、处决强化（execute_up）、死刑宣告（execution_order）；
// - 爆头（crit_shot）：可叠 5 层，每层 +20% 概率（至多 100% 必爆），550% 伤害倍率；
// - 让子弹飞（bullet_fly）：需爆头。命中时若触发爆头或成功击杀，子弹不销毁并继续直线穿透；
//   未暴击且未击杀时击中即销毁；
// - 狙神（sniper_god）：需让子弹飞。子弹每穿透 1 个敌人，对后续敌人的伤害递增 20%
//   （baseDamage × (1 + penetratedCount × 0.2)）；
// - 死代码清理断言：multi_shot/burst_shot/split_shot/spd_up/range_up 均不进牌池。
// 数值全部来自 weapons/charge_sniper.json 真实表驱动（牌组经 getWeaponStats 注入 stats）。

import { describe, expect, it } from 'vitest';
import { loadEffectDefs } from '../../data/effects';
import { loadCardDefs } from '../../data/cards';
import { loadWeaponDefs } from '../../data/weapons';
import { damageTakenFactor, dealDamage, hasEffect } from '../effects';
import { onEnemyKilled } from '../gems';
import { killHooks, updateProjectiles } from '../projectiles';
import { availableCards } from '../cards';
import { BATTLE_RNG_META_KEY, createSimState } from '../simState';
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
  getSniperKillCount,
} from './behavior_chargeSniper';
import './index'; // 副作用：自动发现注册
import { getBehavior } from './registry';

// 副作用：把 effects.json 真实效果表注册进 core/effects（mark 效果槽依赖）。
loadEffectDefs();
// 经验结算接线（与 session 同款）：死刑宣告经验 ×1.25 的「基础经验」由 onEnemyKilled 结算。
killHooks.push(onEnemyKilled);

interface EnemyOpts {
  hp?: number;
  /** 覆盖 maxHp（与 hp 解耦，构造「残血高上限」目标）。缺省与 hp 相同（满血）。 */
  maxHp?: number;
  speed?: number;
  isBoss?: boolean;
  /** 击杀掉落经验（默认 1；死刑宣告经验断言用）。 */
  xp?: number;
  state?: 'march' | 'attack';
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
 */
function fireOnce(state: SimState, cards: string[] = [], forcedTarget?: Enemy): WeaponStats {
  const def = loadWeaponDefs().charge_sniper;
  if (!state.weaponStates.charge_sniper) {
    state.weaponStates.charge_sniper = { level: 0, cooldownMs: 0, cards: {} };
  }
  const ws = state.weaponStates.charge_sniper;
  ws.cards = {};
  for (const c of cards) {
    ws.cards[c] = (ws.cards[c] ?? 0) + 1;
  }
  ws.level = cards.length;
  const stats = getWeaponStats(def, state, 'charge_sniper');
  behavior.fire(state, 'charge_sniper', stats, forcedTarget);
  return stats;
}

/**
 * 推进模拟若干微帧（默认 16ms/步，避开 50ms 帧上限截断）。
 */
function simulate(
  state: SimState,
  steps: number,
  dtMs = 16,
  onStep?: (s: SimState, stepIndex: number) => void,
): void {
  const grid = new SpatialHash<Enemy>(64);
  for (let i = 0; i < steps; i++) {
    state.timeMs += dtMs;
    grid.clear();
    for (const e of state.enemies) {
      if (!e.dead) {
        grid.insert(e, e.x, e.y, e.radius);
      }
    }
    if (behavior.update) {
      behavior.update(state, dtMs);
    }
    updateProjectiles(state, dtMs, grid);
    onStep?.(state, i);
    if (state.projectiles.length === 0) {
      break;
    }
  }
}

/**
 * 桩替换战斗专用随机流（测试隔离用）。
 */
function stubBattleRng(state: SimState, returns: number[]): number[] {
  let idx = 0;
  const consumed: number[] = [];
  const stub: Rng = {
    next: () => {
      const v = returns[idx] ?? 0.999;
      idx += 1;
      consumed.push(v);
      return v;
    },
    int: () => 0,
    range: () => 0,
    pick: (list) => list[0],
  };
  state.meta[BATTLE_RNG_META_KEY] = stub;
  return consumed;
}

describe('目标优先级四级（四级 findTarget 真实集成）', () => {
  it('① isBoss 优先（全屏最近 boss）：无视距离优先锁定 boss', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1150, { hp: 100 }); // 最近普通怪
    makeEnemy(state, 360, 1140, { speed: 120 }); // 贴墙普通怪
    makeEnemy(state, 360, 1000, { speed: 100 }); // 快速普通怪
    makeEnemy(state, 360, 200, { isBoss: true }); // 远距离 boss
    fireOnce(state);

    expect(state.projectiles).toHaveLength(1);
    const p = state.projectiles[0];
    expect(p.behavior).toBe('charge_sniper');
    expect(p.damage).toBeCloseTo(60, 9);
    // 朝向远处的 boss 射出（vy < 0）
    expect(p.vy).toBeLessThan(0);
  });

  it('② attack 贴墙怪优先（无 boss 时）：贴墙怪正在啃墙，优先于快速怪', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1000, { speed: 120 }); // 快速怪
    const attacker = makeEnemy(state, 360, 1140, { state: 'attack' }); // 贴墙怪
    fireOnce(state);

    const p = state.projectiles[0];
    const dy = attacker.y - state.character.y;
    const dx = attacker.x - state.character.x;
    const expectedAng = Math.atan2(dy, dx);
    expect(Math.atan2(p.vy, p.vx)).toBeCloseTo(expectedAng, 3);
  });

  it('③ 快速怪优先（无 boss 且无贴墙怪）：speed ≥ 80px/s 优先于更近的慢速怪', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1150, { speed: 20 }); // 最近慢速怪
    makeEnemy(state, 360, 800, { speed: 85 }); // 远距离快速怪（≥80）
    fireOnce(state);

    const p = state.projectiles[0];
    expect(p.vy).toBeLessThan(0);
  });

  it('④ 最近怪兜底：无上述高威胁层时锁定最近敌人', () => {
    const state = createSimState(1);
    const near = makeEnemy(state, 360, 1100, { speed: 20 });
    makeEnemy(state, 360, 600, { speed: 20 });
    fireOnce(state);

    const p = state.projectiles[0];
    const dy = near.y - state.character.y;
    const dx = near.x - state.character.x;
    expect(Math.atan2(p.vy, p.vx)).toBeCloseTo(Math.atan2(dy, dx), 3);
  });
});

describe('移动预测（leadAim 提前量：行军主目标必中）', () => {
  it('移动预测命中：march 怪 (600,840) speed 240 → 弹指向预测点 (600,900)、0.25s 精确命中', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 600, 840, { speed: 240, hp: 1000 });
    fireOnce(state); // 无牌：projectileSpeed 1600 / damage 60

    // 提前量精确解：距(240,-380)、v=(0,240)、s=1600 → t=0.25、预测点 (600,900)。
    // 方向 (240,-320)/400 = (0.6,-0.8) → 弹速分量 (960,-1280)。
    expect(state.projectiles[0].vx).toBeCloseTo(960, 6);
    expect(state.projectiles[0].vy).toBeCloseTo(-1280, 6);

    // 逐帧推进（手动行军 + 弹丸直线推进）→ t=0.25s 弹与怪同抵 (600,900)。
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
  it('空场 / 仅剩尸体：不发射且冷却归 0；解释器随后推进一个 intervalMs=2000', () => {
    const state = createSimState(1);
    addWeapon(state, 'charge_sniper');
    state.weaponStates.charge_sniper.cooldownMs = 500;
    behavior.fire(state, 'charge_sniper', getWeaponStats(loadWeaponDefs().charge_sniper, state, 'charge_sniper'));
    expect(state.projectiles).toHaveLength(0);
    expect(state.weaponStates.charge_sniper.cooldownMs).toBe(0);

    const defs = { charge_sniper: loadWeaponDefs().charge_sniper };
    const empty = createSimState(1);
    addWeapon(empty, 'charge_sniper');
    updateWeapons(empty, 100, defs);
    expect(empty.projectiles).toHaveLength(0);
    expect(empty.weaponStates.charge_sniper.cooldownMs).toBeCloseTo(2000, 9); // -100 → 归 0 → +2000
  });
});

describe('蓄力节奏（intervalMs=2000 真实表驱动）', () => {
  it('连续 step 只在累计到点时 fire：首帧 1 发 → 1800ms 内不再发 → 累计 2000ms 第 2 发', () => {
    const defs = { charge_sniper: loadWeaponDefs().charge_sniper };
    const state = createSimState(1);
    makeEnemy(state, 360, 1020, { speed: 90, hp: 1e6 });
    addWeapon(state, 'charge_sniper');

    updateWeapons(state, 100, defs);
    expect(state.projectiles).toHaveLength(1);
    expect(state.weaponStates.charge_sniper.cooldownMs).toBeCloseTo(1900, 9); // -100 + 2000

    for (let i = 0; i < 18; i++) {
      updateWeapons(state, 100, defs); // 累计 1800ms
    }
    expect(state.projectiles).toHaveLength(1);

    updateWeapons(state, 100, defs); // 累计 2000ms：第 2 发
    expect(state.projectiles).toHaveLength(2);
  });

  it('攻速强化已移出狙击牌池：狙击不含 spd_up 通用牌', () => {
    const def = loadWeaponDefs().charge_sniper;
    expect(def.cards.find((c) => c.id === 'spd_up')).toBeUndefined();
  });
});

describe('标记（mark 效果槽联动）', () => {
  it('弹上恒带 mark 模板；命中后敌人挂 mark，后续 dealDamage ×1.25 生效（首发不享受）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1020, { speed: 90, hp: 1000 });
    fireOnce(state);
    expect(state.projectiles[0].effectsOnHit.map((t) => t.kind)).toEqual(['mark']);

    simulate(state, 60);
    expect(e.hp).toBeCloseTo(1000 - 60, 6); // 首发直伤 60
    expect(hasEffect(e, 'mark')).toBe(true); // 命中后附着 mark
    expect(damageTakenFactor(e)).toBeCloseTo(1.25, 9); // mark 易伤 25%

    dealDamage(state, e, 100);
    expect(e.hp).toBeCloseTo(1000 - 60 - 125, 6);
  });
});

describe('爆头（crit_shot 爆头牌：每层 +20% 爆头率，550% 伤害，独立随机流）', () => {
  it('1 层爆头：概率 20%，掷点 < 0.20 判中，总伤 = 弹伤 ×5.5', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1020, { hp: 1e6 });
    fireOnce(state, ['crit_shot']);
    expect(state.projectiles[0].data.critChance).toBeCloseTo(0.2, 9);
    stubBattleRng(state, [0.19]); // < 0.20 判中

    simulate(state, 60);
    expect(e.hp).toBeCloseTo(1e6 - 330, 6); // 60 × 5.5 = 330
  });

  it('1 层爆头：掷点 ≥ 0.20 不判中，造成基础伤害 60', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1020, { hp: 1e6 });
    fireOnce(state, ['crit_shot']);
    stubBattleRng(state, [0.2]); // ≥ 0.20 不判中

    simulate(state, 60);
    expect(e.hp).toBeCloseTo(1e6 - 60, 6);
  });

  it('2 层爆头：概率累加至 40%（0.39 判中，0.40 未判中）', () => {
    const hitState = createSimState(1);
    const e1 = makeEnemy(hitState, 360, 1020, { hp: 1e6 });
    fireOnce(hitState, ['crit_shot', 'crit_shot']);
    expect(hitState.projectiles[0].data.critChance).toBeCloseTo(0.4, 9);
    stubBattleRng(hitState, [0.39]);
    simulate(hitState, 60);
    expect(e1.hp).toBeCloseTo(1e6 - 330, 6);

    const missState = createSimState(1);
    const e2 = makeEnemy(missState, 360, 1020, { hp: 1e6 });
    fireOnce(missState, ['crit_shot', 'crit_shot']);
    stubBattleRng(missState, [0.4]);
    simulate(missState, 60);
    expect(e2.hp).toBeCloseTo(1e6 - 60, 6);
  });

  it('5 层爆头：概率达到 100% 必爆（0.999 依然判中）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1020, { hp: 1e6 });
    fireOnce(state, ['crit_shot', 'crit_shot', 'crit_shot', 'crit_shot', 'crit_shot']);
    expect(state.projectiles[0].data.critChance).toBeCloseTo(1.0, 9);
    stubBattleRng(state, [0.999]);

    simulate(state, 60);
    expect(e.hp).toBeCloseTo(1e6 - 330, 6);
  });

  it('与斩首乘区叠乘：未爆头附加 15% 当前生命，爆头附加 22.5% 当前生命且爆头伤害提升', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1020, { hp: 1000 });
    fireOnce(state, ['headshot', 'crit_shot']);
    expect(state.projectiles[0].damage).toBeCloseTo(60, 9);
    stubBattleRng(state, [0.0]); // 爆头判中

    simulate(state, 60);
    // 直伤 60 + 爆头额外 60*(5.5-1)=270 + 斩首额外 1000*22.5%=225
    // 总伤 = 60 + 270 + 225 = 555
    expect(e.hp).toBeCloseTo(1000 - 555, 6);
  });

  it('独立随机流：主随机流全程零消费', () => {
    const state = createSimState(1);
    let calls = 0;
    state.rng = {
      next: () => { calls += 1; return 0; },
      int: () => 0,
      range: () => 0,
      pick: (list) => list[0],
    };
    makeEnemy(state, 360, 1020, { hp: 1e6 });
    fireOnce(state, ['crit_shot', 'execution_order']);
    simulate(state, 60);
    expect(calls).toBe(0);
  });

  it('秒杀低血量小怪时：即便基础伤害致死，仍正常触发爆头判定、写入 sniper_crit_vfx 与 crit 音效', () => {
    const state = createSimState(1);
    const runner = makeEnemy(state, 360, 1020, { hp: 18 }); // 18 HP runner，会被 60 基伤直接秒杀
    fireOnce(state, ['crit_shot']);
    stubBattleRng(state, [0.1]); // 命中爆头概率（20%）

    simulate(state, 60);
    expect(runner.dead).toBe(true);
    // 验证爆头视觉特效已成功写入 meta
    const vfxList = state.meta['sniper_crit_vfx'] as Array<{ x: number; y: number }>;
    expect(vfxList).toBeDefined();
    expect(vfxList.length).toBeGreaterThan(0);
    expect(vfxList[0].x).toBe(runner.x);
    expect(vfxList[0].y).toBe(runner.y);

    // 验证 crit 音效事件已成功推送
    expect(state.events.some((ev) => ev.kind === 'sfx' && ev.name === 'crit')).toBe(true);
  });
});

describe('斩首（headshot 斩首牌 + execute_up 处决强化牌）', () => {
  it('普通怪附加当前生命值 15% 额外伤害，Boss 附加 10%', () => {
    // 1. 普通怪：1000 血，直伤 60 + 斩首 1000×15% = 150，总伤 210
    const stateNorm = createSimState(1);
    const norm = makeEnemy(stateNorm, 360, 1020, { hp: 1000 });
    fireOnce(stateNorm, ['headshot']);
    simulate(stateNorm, 60);
    expect(norm.hp).toBeCloseTo(1000 - 210, 6);

    // 2. Boss 怪：10000 血，直伤 60 + 斩首 10000×10% = 1000，总伤 1060
    const stateBoss = createSimState(1);
    const boss = makeEnemy(stateBoss, 360, 1020, { hp: 10000, isBoss: true });
    fireOnce(stateBoss, ['headshot']);
    simulate(stateBoss, 60);
    expect(boss.hp).toBeCloseTo(10000 - 1060, 6);
  });

  it('爆头时斩首伤害提升 50%（普通怪 22.5%，Boss 15%）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1020, { hp: 2000 });
    fireOnce(state, ['headshot', 'crit_shot']);
    stubBattleRng(state, [0.0]); // 爆头

    simulate(state, 60);
    // 直伤 60 + 爆头追加 270 + 斩首 2000 * 22.5% = 450，总伤 780
    expect(e.hp).toBeCloseTo(2000 - 780, 6);
  });

  it('处决强化叠加（可重复，+5%/Boss+2%/张）：扩张死刑宣告斩杀线', () => {
    // 1. 普通怪：基础 20% 阈值，拿 1 张处决强化升至 25%
    const state1 = createSimState(1);
    // maxHp 1000，当前 300，吃直击 60 后剩 240
    // 240 / 1000 = 24%：若仅基础 20% 无法处决（240 >= 200），但 25% 阈值下（240 < 250）成功处决
    const e1 = makeEnemy(state1, 360, 1020, { hp: 300, maxHp: 1000 });
    fireOnce(state1, ['execution_order', 'execute_up']);
    simulate(state1, 60);
    expect(e1.dead).toBe(true);

    // 2. 普通怪：拿 2 张处决强化升至 30%
    const state2 = createSimState(1);
    // maxHp 1000，当前 350，吃直击 60 后剩 290
    // 290 / 1000 = 29%：在 30% 阈值下（290 < 300）成功处决
    const e2 = makeEnemy(state2, 360, 1020, { hp: 350, maxHp: 1000 });
    fireOnce(state2, ['execution_order', 'execute_up', 'execute_up']);
    simulate(state2, 60);
    expect(e2.dead).toBe(true);

    // 3. Boss 怪：基础 7% 阈值，拿 1 张处决强化升至 9%
    const stateBoss = createSimState(1);
    // maxHp 10000，当前 920，吃直击 60 后剩 860
    // 860 / 10000 = 8.6%：在 9% 阈值下（860 < 900）成功处决
    const boss = makeEnemy(stateBoss, 360, 1020, { hp: 920, maxHp: 10000, isBoss: true });
    fireOnce(stateBoss, ['execution_order', 'execute_up']);
    simulate(stateBoss, 60);
    expect(boss.dead).toBe(true);
  });
});

describe('死刑宣告（execution_order：20%/Boss 7% 阈值处决 + 经验 ×1.25）', () => {
  it('普通阈值 20%：命中后 hp < 20% maxHp → 处决击杀', () => {
    const executed = createSimState(1);
    const low = makeEnemy(executed, 360, 1020, { hp: 250, maxHp: 1000 }); // 命中后 190 < 200
    fireOnce(executed, ['execution_order']);
    simulate(executed, 60);
    expect(low.dead).toBe(true);
  });

  it('Boss 阈值 7%：Boss 需低于 7% 才处决', () => {
    const boss = createSimState(1);
    const b = makeEnemy(boss, 360, 1020, { hp: 150060, maxHp: 1e6, isBoss: true });
    fireOnce(boss, ['execution_order']);
    simulate(boss, 60);
    expect(b.dead).toBe(false);

    const bossBelow = createSimState(1);
    const bb = makeEnemy(bossBelow, 360, 1020, { hp: 70050, maxHp: 1e6, isBoss: true });
    fireOnce(bossBelow, ['execution_order']);
    simulate(bossBelow, 60);
    expect(bb.dead).toBe(true);
  });

  it('经验 ×1.25 放大击杀经验', () => {
    const executed = createSimState(1);
    executed.progress.level = 10;
    const e = makeEnemy(executed, 360, 1020, { hp: 250, maxHp: 1000, xp: 32 });
    fireOnce(executed, ['execution_order']);
    simulate(executed, 60);
    expect(e.dead).toBe(true);
    expect(executed.progress.xp).toBeCloseTo(40, 9);
  });

  it('协同齐射路径（forcedTarget）同样生效', () => {
    const state = createSimState(1);
    state.progress.level = 10;
    makeEnemy(state, 600, 1150, { hp: 1e6 });
    const forced = makeEnemy(state, 360, 800, { hp: 250, maxHp: 1000, xp: 32 });
    fireOnce(state, ['execution_order'], forced);
    simulate(state, 60);
    expect(forced.dead).toBe(true);
    expect(state.progress.xp).toBeCloseTo(40, 9);
  });

  it('爆头触发时死刑宣告斩杀线提升 50%（基础 20% -> 30%）', () => {
    const state = createSimState(1);
    // maxHp 1000，当前 550。
    // 直伤 60 + 爆头额外 270 = 330 伤，剩 220
    // 220 / 1000 = 22%：在基础 20% 无法处决（220 >= 200），但在爆头放大 1.5 倍（30% 阈值下 220 < 300）成功处决！
    const e = makeEnemy(state, 360, 1020, { hp: 550, maxHp: 1000 });
    fireOnce(state, ['crit_shot', 'execution_order']);
    stubBattleRng(state, [0.0]); // 爆头判中
    simulate(state, 60);
    expect(e.dead).toBe(true);
  });
});

describe('让子弹飞（bullet_fly：爆头穿透 + 击杀成长 + 内置击杀穿透）', () => {
  it('触发爆头时：即使敌人未死，持有让子弹飞则子弹穿透不销毁并继续命中后续敌人', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 360, 1120, { hp: 1e6 });
    const e2 = makeEnemy(state, 360, 1000, { hp: 1e6 });
    fireOnce(state, ['crit_shot', 'bullet_fly']);
    // 第 1 敌判中爆头（0.0 < 0.20），第 2 敌不判中（0.99）
    stubBattleRng(state, [0.0, 0.99]);

    simulate(state, 200);
    expect(e1.hp).toBeCloseTo(1e6 - 330, 6); // 第 1 敌吃爆头
    expect(e2.hp).toBeCloseTo(1e6 - 60, 6); // 第 2 敌吃基础伤害
    expect(state.projectiles).toHaveLength(0); // 第 2 敌未暴击未击杀，子弹销毁
  });

  it('成功击杀时：即使未暴击，子弹穿透不销毁并继续命中后续敌人', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 360, 1120, { hp: 50 }); // 60 伤直接击杀
    const e2 = makeEnemy(state, 360, 1000, { hp: 1e6 });
    fireOnce(state, ['crit_shot', 'bullet_fly']);
    stubBattleRng(state, [0.99, 0.99]); // 全程不暴击

    simulate(state, 200);
    expect(e1.dead).toBe(true); // e1 被直接击杀
    expect(e2.hp).toBeCloseTo(1e6 - 60, 6); // 子弹贯穿继续命中 e2
    expect(state.projectiles).toHaveLength(0); // e2 未暴击未击杀，子弹销毁
  });

  it('处决击杀时：死刑宣告处决致死后子弹穿透不销毁并继续飞行', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 360, 1120, { hp: 250, maxHp: 1000 }); // 命中后 190 < 200 处决
    const e2 = makeEnemy(state, 360, 1000, { hp: 1e6 });
    fireOnce(state, ['crit_shot', 'bullet_fly', 'execution_order']);
    stubBattleRng(state, [0.99, 0.99]); // 未暴击

    simulate(state, 200);
    expect(e1.dead).toBe(true);
    expect(e2.hp).toBeCloseTo(1e6 - 60, 6);
  });

  it('既未暴击又未击杀：子弹命中即销毁，线上后续敌人不受击', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 360, 1120, { hp: 1e6 });
    const e2 = makeEnemy(state, 360, 1000, { hp: 1e6 });
    fireOnce(state, ['crit_shot', 'bullet_fly']);
    stubBattleRng(state, [0.99]); // 未暴击且未击杀

    simulate(state, 200);
    expect(e1.hp).toBeCloseTo(1e6 - 60, 6);
    expect(e2.hp).toBe(1e6); // e2 未受伤害
    expect(state.projectiles).toHaveLength(0);
  });

  it('内置击杀穿透：零牌（未持让子弹飞）击杀小怪时，子弹天生穿透并命中后续敌人', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 360, 1120, { hp: 50 }); // 60 伤直接秒杀
    const e2 = makeEnemy(state, 360, 1000, { hp: 1e6 });
    fireOnce(state, []); // 零牌！

    simulate(state, 200);
    expect(e1.dead).toBe(true);
    expect(e2.hp).toBeCloseTo(1e6 - 60, 6); // 击杀后子弹自动穿透命中 e2！
    expect(state.projectiles).toHaveLength(0);
  });

  it('未持让子弹飞且未击杀（即使爆头）：子弹击中第 1 敌即销毁', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 360, 1120, { hp: 1e6 });
    const e2 = makeEnemy(state, 360, 1000, { hp: 1e6 });
    fireOnce(state, ['crit_shot']); // 未持 bullet_fly
    stubBattleRng(state, [0.0]); // 触发爆头但未击杀

    simulate(state, 200);
    expect(e1.hp).toBeCloseTo(1e6 - 330, 6);
    expect(e2.hp).toBe(1e6); // 未持让子弹飞且未击杀，第 2 敌不中
    expect(state.projectiles).toHaveLength(0);
  });

  it('让子弹飞击杀成长：每杀死一个单位，爆头伤害提升 10%（550% -> 560% -> 570%...）', () => {
    const state = createSimState(1);
    const k1 = makeEnemy(state, 360, 1150, { hp: 10 });
    const k2 = makeEnemy(state, 360, 1100, { hp: 10 });
    const target = makeEnemy(state, 360, 1000, { hp: 1e6 });
    fireOnce(state, ['crit_shot', 'bullet_fly']);
    stubBattleRng(state, [0.99, 0.99, 0.0]); // k1, k2 不暴击致死，target 触发爆头

    simulate(state, 200);
    expect(k1.dead).toBe(true);
    expect(k2.dead).toBe(true);
    // target 受击前已击杀 2 个怪，爆头倍率 = 5.5 + 2 * 0.1 = 5.7 (570%)
    // 直伤 60 + 爆头额外 60 * 4.7 = 282，总伤 342
    expect(target.hp).toBeCloseTo(1e6 - 342, 6);
  });

  it('未持让子弹飞前击杀不叠加，拿到让子弹飞后才开始叠加爆头伤害', () => {
    const state = createSimState(1);
    // 1. 未持让子弹飞，开火击杀 2 个敌人
    const k1 = makeEnemy(state, 360, 1150, { hp: 10 });
    const k2 = makeEnemy(state, 360, 1100, { hp: 10 });
    fireOnce(state, ['crit_shot']);
    stubBattleRng(state, [0.99, 0.99]);
    simulate(state, 200);
    expect(k1.dead).toBe(true);
    expect(k2.dead).toBe(true);
    // 击杀数仍应为 0
    expect(getSniperKillCount(state)).toBe(0);

    // 2. 之后选了让子弹飞，再开火击杀 1 个敌人并贯穿 target 触发爆头
    const k3 = makeEnemy(state, 360, 1150, { hp: 10 });
    const target = makeEnemy(state, 360, 1000, { hp: 1e6 });
    fireOnce(state, ['crit_shot', 'bullet_fly']);
    stubBattleRng(state, [0.99, 0.0]); // k3 致死，target 爆头
    simulate(state, 200);
    expect(k3.dead).toBe(true);
    // 此时仅累计了拿到让子弹飞之后的 1 次击杀
    expect(getSniperKillCount(state)).toBe(1);
    // target 爆头倍率 = 5.5 + 1 * 0.1 = 5.6 (560%)
    // 直伤 60 + 爆头额外 60 * 4.6 = 276，总伤 336
    expect(target.hp).toBeCloseTo(1e6 - 336, 6);
  });
});

describe('狙神（sniper_god：穿透每穿 1 敌后续伤害 +20%）', () => {
  it('每穿透 1 敌伤害递增 20%（第 1 敌 60、第 2 敌 72、第 3 敌 84）', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 360, 1120, { hp: 50 }); // 击杀穿透
    const e2 = makeEnemy(state, 360, 1000, { hp: 50 }); // 击杀穿透
    const e3 = makeEnemy(state, 360, 880, { hp: 1e6 }); // 承接第 3 击
    fireOnce(state, ['sniper_god']); // 不依赖 bullet_fly！
    stubBattleRng(state, [0.99, 0.99, 0.99]); // 不暴击

    simulate(state, 200);
    expect(e1.dead).toBe(true);
    expect(e2.dead).toBe(true);
    // e3 受到伤害 = 60 × (1 + 2 × 0.2) = 84
    expect(e3.hp).toBeCloseTo(1e6 - 84, 6);
  });

  it('穿透增伤与爆头倍率叠乘：第 2 敌受击时若爆头，结合击杀成长造成对应伤害', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 360, 1120, { hp: 50 }); // 基础命中致死击杀穿透
    const e2 = makeEnemy(state, 360, 1000, { hp: 1e6 });
    fireOnce(state, ['crit_shot', 'bullet_fly', 'sniper_god']);
    stubBattleRng(state, [0.99, 0.0]); // e1 不暴击致死，e2 爆头

    simulate(state, 200);
    expect(e1.dead).toBe(true);
    // e1 致死后杀敌数 = 1，爆头倍率 = 5.5 + 1 * 0.1 = 5.6
    // e2 基础伤 60 * (1 + 1 * 0.2) = 72，爆头 5.6 倍 → 72 * 5.6 = 403.2
    expect(e2.hp).toBeCloseTo(1e6 - 403.2, 6);
  });

  it('穿透增伤与斩首乘区叠乘：穿透后第 2 敌基础 72 并追加斩首 15% 当前生命', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 360, 1120, { hp: 50 });
    const e2 = makeEnemy(state, 360, 1000, { hp: 1000 });
    fireOnce(state, ['headshot', 'sniper_god']);

    simulate(state, 200);
    expect(e1.dead).toBe(true);
    // e2 基础伤 72 + 斩首 1000 * 15% = 150，总伤 222
    expect(e2.hp).toBeCloseTo(1000 - 222, 6);
  });
});

describe('表现反馈 meta VFX + 一次性 sfx（G5：爆头星芒环 / 死刑宣告斩杀，不做震屏）', () => {
  function hookScene(cards: string[], rngQueue: number[]): { state: SimState; proj: Projectile } {
    const state = createSimState(1);
    makeEnemy(state, 360, 1020, { hp: 1e7 });
    fireOnce(state, cards);
    stubBattleRng(state, rngQueue);
    return { state, proj: state.projectiles[0] };
  }

  it('契约常量：爆头留存 320ms / 处决留存 300ms', () => {
    expect(SNIPER_CRIT_VFX_MS).toBe(320);
    expect(SNIPER_EXECUTE_VFX_MS).toBe(300);
  });

  it('爆头判中（直调钩子）：写 crit VFX 条目 + 一次性 crit sfx', () => {
    const { state, proj } = hookScene(['crit_shot'], [0.14]);
    state.timeMs = 500;
    behavior.onProjectileHit!(state, proj, state.enemies[0]);

    const list = state.meta[SNIPER_CRIT_VFX_KEY] as SniperHitVfx[];
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({ x: 360, y: 1020, untilMs: 820 });
    expect(state.events).toContainEqual({ kind: 'sfx', name: 'crit' });
  });

  it('爆头未判中：不写 meta、不推 sfx', () => {
    const { state, proj } = hookScene(['crit_shot'], [0.25]);
    state.timeMs = 500;
    behavior.onProjectileHit!(state, proj, state.enemies[0]);

    expect(state.meta[SNIPER_CRIT_VFX_KEY]).toBeUndefined();
    expect(state.events).toHaveLength(0);
  });

  it('死刑宣告触发：写 execute VFX 条目 + 一次性 execute sfx', () => {
    const { state, proj } = hookScene(['execution_order'], []);
    const e = makeEnemy(state, 500, 1100, { hp: 150, maxHp: 1000, xp: 32 });
    state.timeMs = 500;
    behavior.onProjectileHit!(state, proj, e);

    const list = state.meta[SNIPER_EXECUTE_VFX_KEY] as SniperHitVfx[];
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({ x: 500, y: 1100, untilMs: 800 });
    expect(state.events).toContainEqual({ kind: 'sfx', name: 'execute' });
    expect(e.dead).toBe(true);
  });
});

describe('死代码清理（多射/连射/分裂/攻速/减速无残留）', () => {
  it('牌池：multi_shot/burst_shot/split_shot/spd_up 不再适用狙击', () => {
    const raw = loadCardDefs();
    for (const id of ['multi_shot', 'burst_shot', 'split_shot', 'spd_up']) {
      const card = raw.find((c) => c.id === id);
      expect(card, `cards.json 缺 ${id}`).toBeDefined();
      expect(card!.applyTo).not.toContain('charge_sniper');
    }
    const def = loadWeaponDefs().charge_sniper;
    const ids = def.cards.map((c) => c.id);
    expect(ids).not.toContain('multi_shot');
    expect(ids).not.toContain('burst_shot');
    expect(ids).not.toContain('split_shot');
    expect(ids).not.toContain('spd_up');
  });

  it('三选一不再出现：狙击持有者的候选池永不含这些通用牌', () => {
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
    const banned = new Set(['multi_shot', 'burst_shot', 'split_shot', 'spd_up']);
    for (const o of options) {
      if (o.kind === 'card') {
        expect(banned.has(o.cardId)).toBe(false);
      }
    }
  });
});

describe('数值全部来自 weapons/charge_sniper.json（真实表驱动，新牌池）', () => {
  const def = loadWeaponDefs().charge_sniper;

  it('表身份：id/name/behavior/maxLevel=10，behavior 已自动发现注册', () => {
    expect(def.id).toBe('charge_sniper');
    expect(def.name).toBe('蓄能狙击');
    expect(def.behavior).toBe('charge_sniper');
    expect(def.maxLevel).toBe(10);
    expect(getBehavior('charge_sniper')).toBe(behavior);
  });

  it('牌目录：专属牌六张（headshot/execution_order/execute_up/crit_shot/bullet_fly/sniper_god），通用牌仅伤害', () => {
    expect(def.cards.slice(0, 6).map((c) => c.id)).toEqual([
      'headshot',
      'execution_order',
      'execute_up',
      'crit_shot',
      'bullet_fly',
      'sniper_god',
    ]);
    const ids = def.cards.map((c) => c.id);
    expect(ids).toContain('dmg_up');
    for (const banned of ['spd_up', 'multi_shot', 'burst_shot', 'split_shot', 'range_up', 'dot_freq', 'border_ricochet', 'pierce_shot']) {
      expect(ids).not.toContain(banned);
    }
  });

  it('base 数值随表（intervalMs=2000，pierce=0）', () => {
    expect(def.base).toMatchObject({
      damage: 60,
      intervalMs: 2000,
      projectileSpeed: 1600,
      pierce: 0,
      ttlMs: 1200,
      fastSpeedThreshold: 80,
    });
  });

  it('专属牌 once 语义与参数随表：bullet_fly/sniper_god/headshot/execution_order 拿到一张后从牌池移除，crit_shot 可拿 5 次', () => {
    for (const id of ['headshot', 'execution_order', 'bullet_fly', 'sniper_god']) {
      const card = def.cards.find((c) => c.id === id)!;
      expect(card.once, `${id} 应为 once 牌`).toBe(true);
    }
    const critCard = def.cards.find((c) => c.id === 'crit_shot')!;
    expect(critCard.once).toBeUndefined();
    expect(critCard.maxCount).toBe(5);
    expect(critCard.hardMax).toBe(5);

    // 选 1 张 crit_shot 仍在池（maxCount 5）
    const ws1 = { level: 1, cooldownMs: 0, cards: { crit_shot: 1 } };
    expect(availableCards(def, ws1, false).map((c) => c.id)).toContain('crit_shot');
    // 选 5 张 crit_shot 移出池
    const ws5 = { level: 5, cooldownMs: 0, cards: { crit_shot: 5 } };
    expect(availableCards(def, ws5, false).map((c) => c.id)).not.toContain('crit_shot');
  });

  it('升级池前置依赖：未持有 execution_order 时 execute_up 不出现；未持有 crit_shot 时 bullet_fly 不出现；sniper_god 无依赖可直接出现', () => {
    const wsEmpty = { level: 0, cooldownMs: 0, cards: {} };
    const poolEmpty = availableCards(def, wsEmpty, false).map((c) => c.id);
    expect(poolEmpty).not.toContain('execute_up');
    expect(poolEmpty).not.toContain('bullet_fly');
    expect(poolEmpty).toContain('sniper_god');

    const wsExec = { level: 1, cooldownMs: 0, cards: { execution_order: 1 } };
    const poolExec = availableCards(def, wsExec, false).map((c) => c.id);
    expect(poolExec).toContain('execute_up');

    const wsCrit = { level: 1, cooldownMs: 0, cards: { crit_shot: 1 } };
    const poolCrit = availableCards(def, wsCrit, false).map((c) => c.id);
    expect(poolCrit).toContain('bullet_fly');
  });

  it('牌组 stats 注入：伤害乘区、爆头与新牌参数全部随牌', () => {
    const shoot = (cards: string[]): WeaponStats => {
      const state = createSimState(1);
      makeEnemy(state, 360, 1020, { speed: 90, hp: 200, maxHp: 1e6 });
      return fireOnce(state, cards);
    };
    expect(shoot([]).damage).toBeCloseTo(60, 9);
    expect(shoot(['dmg_up']).damage).toBeCloseTo(78, 9);
    expect(shoot(['headshot']).headshotCurrentHpFactor).toBeCloseTo(0.15, 9);
    expect(shoot(['headshot']).headshotBossCurrentHpFactor).toBeCloseTo(0.10, 9);
    expect(shoot(['execution_order']).executionHpFactor).toBeCloseTo(0.2, 9);
    expect(shoot(['execution_order']).executionBossHpFactor).toBeCloseTo(0.07, 9);
    expect(shoot(['execution_order', 'execute_up']).executionHpFactor).toBeCloseTo(0.25, 9);
    expect(shoot(['execution_order', 'execute_up']).executionBossHpFactor).toBeCloseTo(0.09, 9);
    expect(shoot(['execution_order', 'execute_up', 'execute_up']).executionHpFactor).toBeCloseTo(0.3, 9);
    expect(shoot(['execution_order', 'execute_up', 'execute_up']).executionBossHpFactor).toBeCloseTo(0.11, 9);
    expect(shoot(['crit_shot']).critChance).toBeCloseTo(0.2, 9);
    expect(shoot(['crit_shot']).critMultiplier).toBeCloseTo(5.5, 9);
    expect(shoot(['crit_shot']).critSynergyBoost).toBeCloseTo(0.5, 9);
    expect(shoot(['crit_shot', 'crit_shot']).critChance).toBeCloseTo(0.4, 9);
    expect(shoot(['crit_shot', 'crit_shot', 'crit_shot', 'crit_shot', 'crit_shot']).critChance).toBeCloseTo(1.0, 9);
    expect(shoot(['bullet_fly']).bulletFly).toBe(1);
    expect(shoot(['bullet_fly']).killCritAmp).toBeCloseTo(0.1, 9);
    expect(shoot(['sniper_god']).sniperGod).toBe(1);
    expect(shoot(['sniper_god']).penetrateAmp).toBeCloseTo(0.2, 9);
    expect(shoot(['execution_order']).executionXpFactor).toBeCloseTo(1.25, 12);
  });

  it('屏幕外敌人防锁定：仅有屏幕外敌人（y=-40）时不开火且冷却归 0', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, -40);
    fireOnce(state, []);
    expect(state.projectiles).toHaveLength(0);
    expect(state.weaponStates['charge_sniper'].cooldownMs).toBe(0);
  });
});
