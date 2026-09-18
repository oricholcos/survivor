// src/core/behaviors/homingMissile.test.ts —— 追猎导弹行为契约（T5.3a 牌池制更新）：
// 追踪转向（限步、命中）、目标死亡重定向、全场无敌人保持直线、命中即爆 AoE（splash 系数）、
// 多射（multi_shot 牌：projectileCount +1/张，扇形错开）、燃烧云（burn 挂槽）、
// 优先精英（prefer_elite 牌选 Boss）、子母弹已随牌池制删除（stats.cluster 无牌可点亮，路径永不再触发）、
// 数值全部来自 weapons/homing_missile.json 真实表、同种子可复现。
import { describe, expect, it } from 'vitest';
import { loadEffectDefs } from '../../data/effects';
import { loadWeaponDefs } from '../../data/weapons';
import { updateEffects } from '../effects';
import { spawnProjectile, updateProjectiles } from '../projectiles';
import { createSimState } from '../simState';
import { SpatialHash } from '../spatialHash';
import type { Enemy, SimState } from '../types';
import { addWeapon, getWeaponStats, updateWeapons } from '../weapons';
import type { WeaponStats } from '../weapons';
import { behavior } from './behavior_homingMissile';
import './index'; // 副作用：自动发现注册
import { getBehavior } from './registry';

// 副作用：把 effects.json 真实效果表注册进 core/effects（burn 特效槽依赖）。
loadEffectDefs();

/** 构造一个静止敌人夹具（数值仅存在于测试夹具）。 */
function makeEnemy(state: SimState, x: number, y: number, hp = 100, isBoss = false): Enemy {
  const e: Enemy = {
    id: state.nextId++,
    typeId: 'tester',
    name: '测试怪',
    x,
    y,
    radius: 10,
    hp,
    maxHp: hp,
    speed: 0,
    damage: 0,
    attackIntervalMs: 1000,
    attackCooldownMs: 1000,
    state: 'march',
    isBoss,
    xp: 1,
    color: 0xffffff,
    shape: 'box',
    effects: [],
    dead: false,
  };
  state.enemies.push(e);
  return e;
}

/** 速度方向角（度，atan2 约定：-90 = 正上）。 */
function angleDeg(p: { vx: number; vy: number }): number {
  return (Math.atan2(p.vy, p.vx) * 180) / Math.PI;
}

/**
 * 模拟若干帧（与生产钩子同序：行为 update 在前、弹丸推进命中在后），
 * 弹丸清空即提前收束。每帧推进 state.timeMs（死亡爆炸网格按 (state, timeMs) 重建）。
 */
function simulate(state: SimState, frames: number, dt = 16): void {
  const grid = new SpatialHash<Enemy>(64);
  for (let f = 0; f < frames && state.projectiles.length > 0; f++) {
    behavior.update!(state, dt);
    updateProjectiles(state, dt, grid);
    state.timeMs += dt;
  }
}

/** 以真实数据表 homing_missile.json 的指定牌组开火一次（需先放好目标敌人）。 */
function fireWithCards(state: SimState, cards: string[] = []): WeaponStats {
  const def = loadWeaponDefs().homing_missile;
  if (!state.weaponStates.homing_missile) {
    state.weaponStates.homing_missile = { level: 0, cooldownMs: 0, cards: {} };
  }
  const ws = state.weaponStates.homing_missile;
  ws.cards = {};
  for (const cardId of cards) {
    ws.cards[cardId] = (ws.cards[cardId] ?? 0) + 1;
  }
  ws.level = cards.length;
  const stats = getWeaponStats(def, state, 'homing_missile');
  behavior.fire(state, 'homing_missile', stats);
  return stats;
}

/** 直调死亡钩子用的爆炸弹夹具（data 与真实表无牌 fire 快照同构，开关可覆盖）。 */
function makeBlastProj(
  state: SimState,
  x: number,
  y: number,
  damage: number,
  dataOverrides?: Record<string, number>,
): ReturnType<typeof spawnProjectile> {
  return spawnProjectile(state, {
    behavior: 'homing_missile',
    x,
    y,
    vx: 0,
    vy: -500,
    damage,
    pierceLeft: 0,
    ttlMs: 3000,
    data: {
      targetId: -1,
      aoeRadius: 70,
      splashFactor: 0.6,
      burnCloud: 0,
      burnTickMs: 0,
      ttlMs: 3000,
      turnRateDegPerSec: 240,
      projectileSpeed: 500,
      splitReady: 0,
      ...dataOverrides,
    },
  });
}

describe('追踪转向（update 钩子）', () => {
  it('初速偏离目标 60°：直线弹必然脱靶（最近距 ≈ 520px >> 16px 判定径），追踪后命中目标', () => {
    const state = createSimState(1); // 角色 (360, 1220)
    const e = makeEnemy(state, 360, 620); // 正上方 600px
    fireWithCards(state);
    expect(state.projectiles).toHaveLength(1);

    // 人为把初速拧偏 +60°（-90° → -30°），模拟离轴发射。
    const p = state.projectiles[0];
    const rad = (-90 + 60) * (Math.PI / 180);
    p.vx = Math.cos(rad) * 500;
    p.vy = Math.sin(rad) * 500;
    expect(p.data.targetId).toBe(e.id);

    simulate(state, 200);

    expect(state.projectiles).toHaveLength(0); // 命中即毁，无残留
    // 锁定语义：直击 12 + 爆炸溅射 12×0.6=7.2（直击幸存目标仍在半径内、同样吃溅射）。
    expect(e.hp).toBeCloseTo(100 - 12 - 12 * 0.6, 6);
    expect(e.dead).toBe(false);
    expect(e.effects).toHaveLength(0); // 无燃烧云牌
  });

  it('转向角速度钳制（不瞬转）：240°/s × 16ms 一帧至多转 3.84°，速度大小保持', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 620);
    fireWithCards(state);
    const p = state.projectiles[0];
    const rad = (-90 + 60) * (Math.PI / 180); // 偏 +60°：朝向 -30°，目标在 -90°
    p.vx = Math.cos(rad) * 500;
    p.vy = Math.sin(rad) * 500;

    behavior.update!(state, 16);

    const maxStepDeg = 240 * (16 / 1000); // 表值 turnRateDegPerSec=240
    expect(angleDeg(p)).toBeCloseTo(-90 + 60 - maxStepDeg, 9); // 恰好转一步，未瞬转到 -90°
    expect(Math.hypot(p.vx, p.vy)).toBeCloseTo(500, 9); // 转向不改速度大小
  });

  it('目标死亡后重定向最近敌人：data.targetId 换新、逐帧转向直至命中新目标', () => {
    const state = createSimState(1);
    const a = makeEnemy(state, 360, 900); // 距角色 320：开火时的最近目标
    const b = makeEnemy(state, 700, 1100); // 距角色 ~360.5、离轴：重定向目标
    fireWithCards(state);
    const p = state.projectiles[0];
    expect(p.data.targetId).toBe(a.id);
    expect(angleDeg(p)).toBeCloseTo(-90, 9); // 初始直指 A

    a.dead = true; // 目标暴毙
    behavior.update!(state, 16);
    expect(p.data.targetId).toBe(b.id); // 重定向记忆写回
    expect(angleDeg(p)).toBeCloseTo(-90 + 3.84, 9); // 朝 B 限步转了一帧

    simulate(state, 200);
    expect(state.projectiles).toHaveLength(0);
    expect(a.hp).toBe(100); // 尸体不再被打（网格只收存活敌人）
    expect(b.hp).toBeCloseTo(100 - 12 - 12 * 0.6, 6); // B 被直击 + 溅射
  });

  it('全场无敌人：保持直线（方向与速度不变、targetId 不漂移），ttl 到期爆炸后清场', () => {
    const state = createSimState(1);
    const a = makeEnemy(state, 360, 800);
    fireWithCards(state);
    const p = state.projectiles[0];
    a.dead = true;
    const vx0 = p.vx; // fire 经 cos(-π/2)×500 产出 ≈3e-14 的横向分量：记录初值逐帧比对

    for (let f = 0; f < 3; f++) {
      behavior.update!(state, 16);
      expect(p.vx).toBe(vx0); // 无目标分支不改速度：逐字段原样
      expect(p.vy).toBe(-500);
      expect(p.data.targetId).toBe(a.id);
    }

    simulate(state, 300);
    expect(state.projectiles).toHaveLength(0); // ttl 3000ms 耗尽 → 爆炸（无目标可伤）→ 清场
  });
});

describe('爆炸 AoE（onProjectileDeath）', () => {
  it('半径内存活敌人受 damage × splashFactor=0.6，半径外与尸体不受伤；无燃烧云不附着', () => {
    const state = createSimState(1);
    const inner = makeEnemy(state, 500, 850); // 距爆心 50 ≤ 70+10（圆相交判定）
    const outer = makeEnemy(state, 500, 1000); // 距爆心 200：半径外
    const corpse = makeEnemy(state, 510, 810, 50);
    corpse.dead = true;
    const before = state.nextId;

    const proj = makeBlastProj(state, 500, 800, 12);
    proj.dead = true; // 对齐真实死亡路径
    behavior.onProjectileDeath!(state, proj);

    expect(inner.hp).toBeCloseTo(100 - 12 * 0.6, 6); // 92.8：只吃溅射（直击由框架在命中时结算）
    expect(outer.hp).toBe(100);
    expect(corpse.hp).toBe(50);
    expect(inner.effects).toHaveLength(0); // 无燃烧云开关
    expect(state.nextId).toBe(before + 1); // 仅夹具弹本身，无新弹
  });

  it('多个敌人在半径内全部吃溅射（逐个 dealDamage）', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 500, 830);
    const e2 = makeEnemy(state, 560, 800);
    makeBlastProj(state, 500, 800, 12).dead = true;
    behavior.onProjectileDeath!(state, state.projectiles[0]);
    expect(e1.hp).toBeCloseTo(100 - 7.2, 6);
    expect(e2.hp).toBeCloseTo(100 - 7.2, 6);
  });
});

describe('多射（multi_shot 牌：projectileCount +1/张）', () => {
  it('无牌发 1 枚正对目标；1 张多射发 2 枚主轴保底 0°（-90°）与侧翼 +12°（-78°）', () => {
    const base = createSimState(1);
    makeEnemy(base, 360, 700);
    fireWithCards(base);
    expect(base.projectiles).toHaveLength(1);
    expect(angleDeg(base.projectiles[0])).toBeCloseTo(-90, 9);

    const multi = createSimState(1);
    const t2 = makeEnemy(multi, 360, 700);
    const stats2 = fireWithCards(multi, ['multi_shot']);
    expect(stats2.projectileCount).toBe(2);
    expect(multi.projectiles).toHaveLength(2);
    expect(angleDeg(multi.projectiles[0])).toBeCloseTo(-90, 9);
    expect(angleDeg(multi.projectiles[1])).toBeCloseTo(-78, 9);
    expect(multi.projectiles.map(angleDeg).sort((a, b) => a - b)).toEqual([-90, -78]);
    for (const p of multi.projectiles) {
      expect(p.behavior).toBe('homing_missile');
      expect(p.x).toBe(360);
      expect(p.y).toBe(1220); // 全部从角色出发
      expect(Math.hypot(p.vx, p.vy)).toBeCloseTo(500, 9);
      expect(p.data.targetId).toBe(t2.id); // 同一目标、扇形错开
      expect(p.damage).toBe(12);
      expect(p.ttlMs).toBe(3000);
      expect(p.pierceLeft).toBe(0); // 命中即毁
      expect(p.radius).toBe(6);
    }
  });

  it('2 张多射发 3 枚；伤害/AoE 乘区随牌走（dmg_up/范围强化独立生效）', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 700);
    const stats = fireWithCards(state, ['multi_shot', 'multi_shot', 'dmg_up', 'range_up']);
    expect(state.projectiles).toHaveLength(3);
    expect(state.projectiles.map(angleDeg).sort((a, b) => a - b)).toEqual([-102, -90, -78]);
    for (const p of state.projectiles) {
      expect(p.damage).toBeCloseTo(12 * 1.3, 9);
      expect(p.data.aoeRadius).toBeCloseTo(70 * 1.2, 9);
      expect(p.data.splashFactor).toBe(stats.splashFactor);
      expect(p.data.turnRateDegPerSec).toBe(stats.turnRateDegPerSec);
    }
  });

  it('无敌人不开火且冷却归 0（与 piercing_bolt 同语义）；经解释器后冷却推进一个 intervalMs', () => {
    const state = createSimState(1);
    addWeapon(state, 'homing_missile');
    state.weaponStates.homing_missile.cooldownMs = 500;
    behavior.fire(state, 'homing_missile', getWeaponStats(loadWeaponDefs().homing_missile, state, 'homing_missile'));
    expect(state.projectiles).toHaveLength(0);
    expect(state.weaponStates.homing_missile.cooldownMs).toBe(0);

    // 解释器路径：fire 归 0 → += intervalMs（1400）→ 下帧重试。
    updateWeapons(state, 16, { homing_missile: loadWeaponDefs().homing_missile });
    expect(state.weaponStates.homing_missile.cooldownMs).toBe(1400);
    expect(state.projectiles).toHaveLength(0);
  });
});

describe('子母弹已删除（T5.3b：分裂由 split_shot 牌驱动，cluster/bomblet 路径不存在）', () => {
  it('牌目录不含 cluster 相关牌；真实表 fire 快照不含 cluster/bomblet 键、无 bomblet 数值', () => {
    const def = loadWeaponDefs().homing_missile;
    expect(def.cards.map((c) => c.id)).not.toContain('cluster');
    expect(def.base.bombletCount).toBeUndefined();
    expect(def.base.bombletDamage).toBeUndefined();

    const state = createSimState(1);
    makeEnemy(state, 360, 700);
    fireWithCards(state, ['multi_shot', 'burn_cloud', 'prefer_elite']); // 全部专属+多射全开
    for (const p of state.projectiles) {
      expect('cluster' in p.data).toBe(false); // 死分支已删除：快照不再携带旧子母弹键
      expect('bomblet' in p.data).toBe(false);
      expect(p.data.splitReady).toBe(0); // 未拿分裂牌
    }
    expect(state.nextId).toBe(4); // 1 敌夹具 + 2 弹（多射），无子母弹
  });

  it('端到端：命中爆炸后全部弹体消亡（无分裂产弹）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 700, 12); // 血量恰被直击（12）打死的脆皮
    const nextIdAfterSetup = state.nextId;
    fireWithCards(state);
    expect(state.projectiles).toHaveLength(1); // 单发

    simulate(state, 200);

    expect(e.dead).toBe(true); // 直击 12 ≥ hp 12
    expect(state.projectiles).toHaveLength(0); // 全部爆完
    expect(state.nextId - nextIdAfterSetup).toBe(1); // 仅 1 母弹，无子母弹
  });
});

describe('燃烧云（burn_cloud 牌）', () => {
  it('爆炸半径内存活敌人挂 burn（效果槽实例、效果表默认数值并真实跳 DoT）；被溅射击杀者不挂', () => {
    const state = createSimState(1); // timeMs = 0
    const survivor = makeEnemy(state, 500, 850); // 距爆心 50：吃 7.2 幸存
    const doomed = makeEnemy(state, 500, 820, 5); // 距 20：7.2 直接烧死
    const outside = makeEnemy(state, 500, 1050); // 距 250：半径外
    const proj = makeBlastProj(state, 500, 800, 12, { burnCloud: 1 });
    proj.dead = true;
    behavior.onProjectileDeath!(state, proj);

    expect(survivor.hp).toBeCloseTo(92.8, 6);
    expect(survivor.effects).toHaveLength(1);
    expect(survivor.effects[0].kind).toBe('burn');
    expect(survivor.effects[0].stacks).toBe(1);
    expect(survivor.effects[0].untilMs).toBe(state.timeMs + 3000); // 效果表 durationMs
    expect(doomed.dead).toBe(true);
    expect(doomed.effects).toHaveLength(0); // 致死一击不附着（尸体无意义）
    expect(outside.hp).toBe(100);
    expect(outside.effects).toHaveLength(0);

    // burn（effects.json：500ms tick / 每跳 3）真实结算一跳。
    state.timeMs += 500;
    updateEffects(state, 500);
    expect(survivor.hp).toBeCloseTo(89.8, 6);
  });

  it('端到端（燃烧云牌）：命中爆炸后目标挂 burn、扣血 12+7.2', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 700, 10000);
    fireWithCards(state, ['burn_cloud']);
    simulate(state, 200);
    expect(state.projectiles).toHaveLength(0);
    expect(e.hp).toBeCloseTo(10000 - 12 - 12 * 0.6, 6);
    expect(e.effects).toHaveLength(1);
    expect(e.effects[0].kind).toBe('burn');
  });

  it('真实表（多射+燃烧云）：弹上快照 burnCloud=1，全流程后目标挂 burn、产弹恰 2 枚', () => {
    const state = createSimState(1);
    const tank = makeEnemy(state, 360, 700, 100000);
    const nextIdAfterSetup = state.nextId;
    fireWithCards(state, ['multi_shot', 'burn_cloud']);
    expect(state.projectiles).toHaveLength(2); // 多射 2 枚
    for (const p of state.projectiles) {
      expect(p.data.burnCloud).toBe(1);
    }

    simulate(state, 300);

    expect(state.projectiles).toHaveLength(0); // 全部爆完
    expect(tank.effects.map((x) => x.kind)).toEqual(['burn']); // 燃烧云生效（refresh reset → 单实例）
    expect(tank.effects[0].stacks).toBe(1);
    expect(tank.hp).toBeLessThan(100000); // 直击+溅射有战果
    expect(tank.hp).toBeGreaterThanOrEqual(100000 - 2 * (12 + 7.2)); // 理论伤害下界（恰两发全额）
    expect(state.nextId - nextIdAfterSetup).toBe(2); // 恰 2 枚弹，无分裂
  });
});

describe('优先精英（prefer_elite 牌）', () => {
  it('场上有 Boss：即使 Boss 更远也选 Boss（多个取最近）', () => {
    const state = createSimState(1);
    const near = makeEnemy(state, 380, 1150); // 距角色 ~70.7（普通怪）
    const farBoss = makeEnemy(state, 360, 400, 100, true); // 距 820 的 Boss
    fireWithCards(state, ['prefer_elite', 'multi_shot']); // 多射 2 枚：扇形 ±12°、均值正对 Boss
    expect(state.projectiles.map((p) => p.data.targetId)).toEqual([farBoss.id, farBoss.id]);
    expect(state.projectiles.map((p) => p.data.targetId)).not.toContain(near.id);
    const angles = state.projectiles.map(angleDeg).sort((x, y) => x - y);
    expect(angles[0]).toBeCloseTo(-90, 6);
    expect(angles[1]).toBeCloseTo(-78, 6);

    // 两个 Boss 取最近。
    const state2 = createSimState(1);
    const bossA = makeEnemy(state2, 360, 800, 100, true); // 距 420：更近
    makeEnemy(state2, 360, 500, 100, true); // 距 720
    fireWithCards(state2, ['prefer_elite']);
    expect(state2.projectiles[0].data.targetId).toBe(bossA.id);
  });

  it('无牌选最近普通敌人；prefer_elite 且无 Boss 回落最近敌人', () => {
    const plain = createSimState(1);
    const near = makeEnemy(plain, 380, 1150);
    makeEnemy(plain, 360, 400, 100, true); // Boss 在场但无优先锁定牌
    fireWithCards(plain);
    expect(plain.projectiles[0].data.targetId).toBe(near.id);

    const noBoss = createSimState(1);
    const fallback = makeEnemy(noBoss, 380, 1150);
    fireWithCards(noBoss, ['prefer_elite']);
    expect(noBoss.projectiles[0].data.targetId).toBe(fallback.id);
  });
});

describe('数值全部来自 weapons/homing_missile.json（真实表驱动，T5.3a 牌池制）', () => {
  const def = loadWeaponDefs().homing_missile;

  it('表身份：id/name/behavior/maxLevel=10，behavior 已自动发现注册', () => {
    expect(def.id).toBe('homing_missile');
    expect(def.name).toBe('追猎导弹');
    expect(def.behavior).toBe('homing_missile');
    expect(def.maxLevel).toBe(10);
    expect(getBehavior('homing_missile')).toBe(behavior); // import.meta.glob 自动注册
  });

  it('牌目录：专属牌在前（burn_cloud/prefer_elite），弹道五武器通用牌合并追加；rangeKeys=AoE 半径', () => {
    expect(def.cards.slice(0, 2).map((c) => c.id)).toEqual(['burn_cloud', 'prefer_elite']);
    const ids = def.cards.map((c) => c.id);
    for (const genericId of ['dmg_up', 'spd_up', 'multi_shot', 'burst_shot', 'split_shot', 'range_up', 'dot_freq']) {
      expect(ids).toContain(genericId);
    }
    const dot = def.cards.find((c) => c.id === 'dot_freq')!;
    expect(dot.requiresCard).toBe('burn_cloud'); // dot频率前置：燃烧云
    expect(def.rangeKeys).toEqual(['aoeRadius']);
  });

  it('base 数值随表（子母弹字段已删除）；多射/伤害/范围随牌生效（改 json 即变）', () => {
    expect(def.base).toMatchObject({
      damage: 12, intervalMs: 1400, projectileSpeed: 500, pierce: 0, ttlMs: 3000,
      aoeRadius: 70, splashFactor: 0.6, turnRateDegPerSec: 240,
      projectileCount: 1, volleySpreadDeg: 24,
    });
    expect(def.base.bombletCount).toBeUndefined();
    expect(def.base.cluster).toBeUndefined();

    const run = (cards: string[]) => {
      const state = createSimState(1);
      makeEnemy(state, 360, 700);
      fireWithCards(state, cards);
      return {
        count: state.projectiles.length,
        damage: state.projectiles[0].damage,
        aoe: state.projectiles[0].data.aoeRadius,
        ttl: state.projectiles[0].ttlMs,
      };
    };
    expect(run([])).toMatchObject({ count: 1, damage: 12, aoe: 70, ttl: 3000 });
    expect(run(['multi_shot'])).toMatchObject({ count: 2, damage: 12, aoe: 70 });
    expect(run(['multi_shot', 'multi_shot'])).toMatchObject({ count: 3, damage: 12 });
    expect(run(['dmg_up', 'range_up'])).toMatchObject({ count: 1, damage: 12 * 1.3, aoe: 70 * 1.2 });
  });

  it('alt def（不同数值）驱动同一行为', () => {
    const altDef = {
      id: 'alt_homing',
      name: '替换导弹',
      behavior: 'homing_missile',
      maxLevel: 10,
      base: {
        damage: 40, intervalMs: 900, projectileSpeed: 800, pierce: 0, ttlMs: 1500,
        aoeRadius: 120, splashFactor: 0.5, turnRateDegPerSec: 600, projectileCount: 2,
        volleySpreadDeg: 40,
      },
      rangeKeys: [],
      cards: [],
    };
    const alt = createSimState(1);
    alt.weaponStates.alt_homing = { level: 0, cooldownMs: 0, cards: {} };
    makeEnemy(alt, 400, 800);
    behavior.fire(alt, 'alt_homing', getWeaponStats(altDef, alt, 'alt_homing'));
    expect(alt.projectiles).toHaveLength(2);
    for (const p of alt.projectiles) {
      expect(p.damage).toBe(40);
      expect(p.ttlMs).toBe(1500);
      expect(Math.hypot(p.vx, p.vy)).toBeCloseTo(800, 9);
      expect(p.data.aoeRadius).toBe(120);
      expect(p.data.splashFactor).toBe(0.5);
    }
  });
});

describe('解释器集成（updateWeapons 驱动 update 钩子与开火节奏）', () => {
  it('经 updateWeapons 的追踪命中：离轴导弹被逐帧 update 拉回目标；节奏严格按 intervalMs', () => {
    const def = loadWeaponDefs().homing_missile;
    const state = createSimState(1);
    const tank = makeEnemy(state, 360, 700, 100000);
    addWeapon(state, 'homing_missile');
    const defs = { homing_missile: def };
    const grid = new SpatialHash<Enemy>(64);

    // 第 1 帧：update（空跑）→ 冷却 0-16 → fire 1 枚 → 冷却 += 1400 - 16 = 1384。
    updateWeapons(state, 16, defs);
    expect(state.projectiles).toHaveLength(1);
    expect(state.weaponStates.homing_missile.cooldownMs).toBe(1384);

    // 拧偏 +60°：若 update 钩子未被解释器调用，直线弹必然脱靶（hp 不动）。
    const p = state.projectiles[0];
    const rad = (-90 + 60) * (Math.PI / 180);
    p.vx = Math.cos(rad) * 500;
    p.vy = Math.sin(rad) * 500;

    // 第 2..87 帧（累计 1392ms < 1400ms）：追踪命中（直击 12 + 溅射 7.2），且不二次开火。
    for (let f = 0; f < 86; f++) {
      updateWeapons(state, 16, defs);
      updateProjectiles(state, 16, grid);
      state.timeMs += 16;
    }
    expect(tank.hp).toBeCloseTo(100000 - 12 - 12 * 0.6, 6);
    expect(state.projectiles).toHaveLength(0); // 已命中，第二发未到点
    expect(state.weaponStates.homing_missile.cooldownMs).toBe(8);

    // 第 88 帧（累计 1408ms ≥ 1400ms）：第二波开火（无多射牌：单发）。
    updateWeapons(state, 16, defs);
    expect(state.projectiles).toHaveLength(1);
    expect(tank.hp).toBeCloseTo(100000 - 19.2, 6); // 第二发仍在途
  });
});

describe('可复现（行为零随机：不读 rng，任意种子同结果）', () => {
  /** 固定场景：多射+燃烧云双发打满 300 帧的全量结果快照。 */
  function scenario(seed: number): { hp: number; otherHp: number; nextId: number; leftover: number } {
    const state = createSimState(seed);
    const a = makeEnemy(state, 360, 620); // 最近目标
    const b = makeEnemy(state, 650, 300); // 远处旁观者
    fireWithCards(state, ['multi_shot', 'burn_cloud']);
    simulate(state, 300);
    return { hp: a.hp, otherHp: b.hp, nextId: state.nextId, leftover: state.projectiles.length };
  }

  it('同种子两次全流程一致；异种子也一致（确定性映射，全程不消耗 rng）', () => {
    expect(scenario(42)).toEqual(scenario(42));
    expect(scenario(42)).toEqual(scenario(7));
  });
});

// —— T5.3b 弹道机制接线：连射 / 分裂 / dot 频率 ——

describe('连射（burst_shot 牌：待发波队列重放——重新选目标再发完整一波）', () => {
  it('1 张连射：首波 1 枚；150ms 后 update 重放第 2 波（旧目标已死 → 打新最近）', () => {
    const state = createSimState(1);
    const a = makeEnemy(state, 360, 700, 1e6); // 最近
    const b = makeEnemy(state, 460, 700, 1e6); // 次近
    fireWithCards(state, ['burst_shot']);
    expect(state.projectiles).toHaveLength(1);
    expect(state.projectiles[0].data.targetId).toBe(a.id);

    a.dead = true; // 重放时重新执行目标选择
    state.timeMs += 150;
    behavior.update!(state, 16);
    expect(state.projectiles).toHaveLength(2);
    expect(state.projectiles[1].data.targetId).toBe(b.id); // 重放波锁定新目标
  });
});

describe('分裂（split_shot 牌：爆炸后分裂次级导弹——「追猎分裂追猎」）', () => {
  it('爆炸点分裂 4 枚：伤害 = 12×0.2 = 2.4、锁定 4 个不同目标、追踪制导随行、不再分裂', () => {
    const state = createSimState(1);
    // 候选全部放在爆炸溅射半径（70+10）之外，保证只吃次级弹直击 + 自爆溅射
    const n1 = makeEnemy(state, 500, 690, 1e6); // 距爆心 110（最近）
    const n2 = makeEnemy(state, 620, 800, 1e6); // 距爆心 120（并列先入数组）
    const n3 = makeEnemy(state, 380, 800, 1e6); // 距爆心 120（并列后入数组）
    const n4 = makeEnemy(state, 500, 930, 1e6); // 距爆心 130
    const proj = makeBlastProj(state, 500, 800, 12, { splitReady: 1, splitFactor: 0.2, splitMax: 4 });
    const before = state.nextId;
    proj.dead = true;
    behavior.onProjectileDeath!(state, proj);
    state.projectiles = state.projectiles.filter((p) => p !== proj); // 移除直调夹具（生产管线由框架回收）

    expect(state.projectiles).toHaveLength(4); // 4 枚次级导弹
    const targetIds = state.projectiles.map((p) => p.data.targetId);
    expect(new Set(targetIds).size).toBe(4); // 互不相同
    expect(targetIds).toContain(n1.id);
    expect(targetIds).toContain(n4.id);
    for (const sec of state.projectiles) {
      expect(sec.damage).toBeCloseTo(2.4, 9); // 12 × 0.2
      expect(sec.data.splitReady).toBe(0); // 封死再分裂
      expect(sec.data.aoeRadius).toBe(70); // 同弹种：AoE 溅射随行
      expect(Math.hypot(sec.vx, sec.vy)).toBeCloseTo(500, 9); // 同弹速
    }

    // 端到端：次级导弹被 update 钩子追踪制导，各命中锁定目标（直击 2.4 + 自爆溅射 1.44）
    const grid = new SpatialHash<Enemy>(64);
    for (let f = 0; f < 120 && state.projectiles.length > 0; f++) {
      behavior.update!(state, 16);
      updateProjectiles(state, 16, grid);
      state.timeMs += 16;
    }
    expect(state.projectiles).toHaveLength(0);
    for (const n of [n1, n2, n3, n4]) {
      expect(n.hp).toBeCloseTo(1e6 - 2.4 - 2.4 * 0.6, 6);
    }
    expect(state.nextId - before).toBe(4); // 不再分裂：恰 4 枚次级弹
  });

  it('命中即爆的分裂：排除刚被炸的目标并预置 hitIds（次级弹穿越出生重叠圈不重复结算）', () => {
    const state = createSimState(1);
    const victim = makeEnemy(state, 500, 800, 1e6); // 被炸目标（爆炸点在其圆心）
    const others = [
      makeEnemy(state, 500, 690, 1e6),
      makeEnemy(state, 620, 800, 1e6),
      makeEnemy(state, 380, 800, 1e6),
      makeEnemy(state, 500, 930, 1e6),
    ];
    const proj = makeBlastProj(state, 500, 800, 12, {
      splitReady: 1, splitFactor: 0.2, splitMax: 4, targetId: victim.id, hitEnemyId: victim.id,
    });
    proj.dead = true;
    behavior.onProjectileDeath!(state, proj);
    state.projectiles = state.projectiles.filter((p) => p !== proj); // 移除直调夹具

    expect(state.projectiles).toHaveLength(4);
    for (const sec of state.projectiles) {
      expect(sec.data.targetId).not.toBe(victim.id); // 排除刚被炸的目标
      expect(others.some((o) => o.id === sec.data.targetId)).toBe(true); // 锁定 4 个 others
      expect(sec.hitIds).toEqual([victim.id]); // 预置：穿越出生重叠圈不重复结算
    }
  });
});

describe('dot 频率（dot_freq 牌，requiresCard=burn_cloud：燃烧云 tick 间隔 ÷1.3）', () => {
  it('弹上快照 burnTickMs = 500/1.3；爆炸附着的燃烧实例按覆盖节奏跳 DoT', () => {
    const fire = createSimState(1);
    makeEnemy(fire, 360, 700, 1e6);
    fireWithCards(fire, ['burn_cloud', 'dot_freq']);
    for (const p of fire.projectiles) {
      expect(p.data.burnTickMs).toBeCloseTo(500 / 1.3, 9); // fire 时快照覆盖值
    }

    const state = createSimState(1);
    const survivor = makeEnemy(state, 500, 850, 1e6); // 距爆心 50：吃溅射 + 燃烧
    const proj = makeBlastProj(state, 500, 800, 12, { burnCloud: 1, burnTickMs: 500 / 1.3 });
    proj.dead = true;
    behavior.onProjectileDeath!(state, proj);
    expect(survivor.hp).toBeCloseTo(1e6 - 7.2, 6); // 溅射
    expect(survivor.effects[0].kind).toBe('burn');
    expect(survivor.effects[0].data.tickMs).toBeCloseTo(500 / 1.3, 9);

    state.timeMs += 384.7;
    updateEffects(state, 384.7);
    expect(survivor.hp).toBeCloseTo(1e6 - 7.2 - 3, 6); // 首跳在 384.6ms（效果表每跳 3）
  });
});
