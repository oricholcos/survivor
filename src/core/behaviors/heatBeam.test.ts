// src/core/behaviors/heatBeam.test.ts —— 灼热光束行为契约（T5.3a 牌池制更新）：
// 持续 tick 伤害（同线敌人每 tick 掉血、无弹丸）、穿透宽度判定（线上全部受伤/宽度外/射程外）、
// 过热槽（连续 fire 至阈值挂 overheat + 泄能、updateWeapons 实际间隔 ×1.6、update 散热、到期恢复）、
// 双束（两个方向同时被照、目标不足只一条）、灼烧（burn 挂槽 + 逐实例覆盖每跳 2 + 真实跳 DoT）、
// 折射（+30° 固定偏角短束上的敌人受伤、主束折射副束不折射）、VFX meta 约定、
// 数值全部来自 weapons/heat_beam.json 真实表（宽度/射程成长走范围强化牌；双束/灼痕/折射+1/
// 散热强化为专属牌；等级语义改为牌组）、解释器集成、同种子可复现（零随机）。
import { describe, expect, it } from 'vitest';
import { loadEffectDefs } from '../../data/effects';
import { loadWeaponDefs } from '../../data/weapons';
import { hasEffect, overheatFactor, updateEffects } from '../effects';
import { createSimState } from '../simState';
import type { Enemy, SimState } from '../types';
import { addWeapon, getWeaponStats, updateWeapons } from '../weapons';
import type { WeaponDef, WeaponStats } from '../weapons';
import { behavior } from './behavior_heatBeam';
import type { HeatBeamVfx } from './behavior_heatBeam';
import './index'; // 副作用：自动发现注册
import { getBehavior } from './registry';

// 副作用：把 effects.json 真实效果表注册进 core/effects（burn/overheat 效果槽依赖）。
loadEffectDefs();

/** 构造一个静止敌人夹具（数值仅存在于测试夹具）。 */
function makeEnemy(state: SimState, x: number, y: number, hp = 100): Enemy {
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
    isBoss: false,
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
 * 以真实数据表 heat_beam.json 的指定牌组 stats 直调 fire 一次。
 * T5.3a：等级→牌组——cards 数组即该武器已吃的牌（重复项 = 可重复牌多张）。
 */
function fireOnce(state: SimState, cards: string[] = []): WeaponStats {
  const def = loadWeaponDefs().heat_beam;
  if (!state.weaponStates.heat_beam) {
    state.weaponStates.heat_beam = { level: 0, cooldownMs: 0, cards: {} };
  }
  const ws = state.weaponStates.heat_beam;
  ws.cards = {};
  for (const cardId of cards) {
    ws.cards[cardId] = (ws.cards[cardId] ?? 0) + 1;
  }
  ws.level = cards.length;
  const stats = getWeaponStats(def, state, 'heat_beam');
  behavior.fire(state, 'heat_beam', stats);
  return stats;
}

/** 读某武器的过热槽热量（懒初始化前视为 0）。 */
function heatOf(state: SimState, weaponId = 'heat_beam'): number {
  const slot = state.meta[`heat_beam_heat:${weaponId}`] as { heat?: number } | undefined;
  return slot && typeof slot.heat === 'number' ? slot.heat : 0;
}

/** 读某武器的 VFX meta 条目。 */
function vfxOf(state: SimState, weaponId = 'heat_beam'): HeatBeamVfx | undefined {
  return state.meta[`heat_beam_vfx:${weaponId}`] as HeatBeamVfx | undefined;
}

describe('持续 tick 伤害（无弹丸瞬时线段）', () => {
  it('同一直线上两个敌人每个 tick 各掉 stats.damage；两次 fire 两次扣血（穿透不计数）', () => {
    const state = createSimState(1); // 角色 (360, 1220)
    addWeapon(state, 'heat_beam');
    const a = makeEnemy(state, 360, 900); // 正上方：最近目标，主束竖直向上
    const b = makeEnemy(state, 360, 750); // 同一条线上更远：同样被照
    const stats = fireOnce(state);

    expect(stats.damage).toBe(3); // base 表值
    expect(a.hp).toBeCloseTo(97, 6);
    expect(b.hp).toBeCloseTo(97, 6);
    expect(state.projectiles).toHaveLength(0); // 无弹丸：纯瞬时线段判定

    fireOnce(state); // 第二个 tick 再扣一次
    expect(a.hp).toBeCloseTo(94, 6);
    expect(b.hp).toBeCloseTo(94, 6);
    expect(heatOf(state)).toBeCloseTo(24, 9); // 积热 12×2
  });

  it('三个同线敌人全部受伤（pierce=0 也不限制命中数）；热量逐次累积', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    const a = makeEnemy(state, 360, 1150);
    const b = makeEnemy(state, 360, 900);
    const c = makeEnemy(state, 360, 705); // 段终点 (360,700) 之内
    fireOnce(state);
    expect(a.hp).toBeCloseTo(97, 6);
    expect(b.hp).toBeCloseTo(97, 6);
    expect(c.hp).toBeCloseTo(97, 6);
    expect(heatOf(state)).toBeCloseTo(12, 9);
  });

  it('无敌人：不开火（无 VFX、不积热）、冷却归 0；解释器随后推进一个 intervalMs', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    state.weaponStates.heat_beam.cooldownMs = 77;
    fireOnce(state);
    expect(state.weaponStates.heat_beam.cooldownMs).toBe(0); // 重试标记
    expect(vfxOf(state)).toBeUndefined();
    expect(heatOf(state)).toBe(0);

    updateWeapons(state, 16, { heat_beam: loadWeaponDefs().heat_beam });
    expect(state.weaponStates.heat_beam.cooldownMs).toBe(120); // 0 → fire 归 0 → += 120
  });

  it('当所有敌人都超出 beamRange 时不开火、不积热、冷却归 0', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    const enemy = makeEnemy(state, 360, 600); // distance 1220 - 600 = 620 > beamRange (520)
    state.weaponStates.heat_beam.cooldownMs = 500;

    fireOnce(state);

    expect(enemy.hp).toBe(100);
    expect(vfxOf(state)).toBeUndefined();
    expect(heatOf(state)).toBe(0);
    expect(state.weaponStates.heat_beam.cooldownMs).toBe(0);
  });
});

describe('穿透宽度判定（点到线段距离 ≤ 半宽 + radius）', () => {
  it('宽度内（偏移 15 ≤ 7+10）受伤；宽度外（偏移 30 > 17）不受伤', () => {
    const state = createSimState(1);
    const main = makeEnemy(state, 360, 900); // 最近：主束竖直向上（过主目标延伸到射程）
    const inside = makeEnemy(state, 375, 800); // 垂直偏移 15（比主目标远：不抢目标）
    const outside = makeEnemy(state, 390, 800); // 垂直偏移 30
    fireOnce(state);
    expect(main.hp).toBeCloseTo(97, 6);
    expect(inside.hp).toBeCloseTo(97, 6);
    expect(outside.hp).toBe(100);
  });

  it('射程外不受伤：段终点延长线上的敌人与角色身后的敌人都照不到', () => {
    const state = createSimState(1);
    const main = makeEnemy(state, 360, 1150); // 距 70：最近，主束竖直向上（段 1220→700）
    const beyond = makeEnemy(state, 360, 600); // 段终点 (360,700) 之外 100 > 17
    const behind = makeEnemy(state, 360, 1400); // 角色身后 180（投影钳到段起点）
    fireOnce(state);
    expect(main.hp).toBeCloseTo(97, 6);
    expect(beyond.hp).toBe(100);
    expect(behind.hp).toBe(100);
  });

  it('宽度随范围强化牌（半宽 7 → 2 张后 10.08）：偏移 19 的敌人无牌不中、2 张后中', () => {
    const base = createSimState(1);
    const m1 = makeEnemy(base, 360, 900); // 最近：主束竖直向上
    const e1 = makeEnemy(base, 379, 800); // 偏移 19 > 7+10
    fireOnce(base);
    expect(m1.hp).toBeCloseTo(97, 6);
    expect(e1.hp).toBe(100);

    const widened = createSimState(1);
    makeEnemy(widened, 360, 900);
    const e2 = makeEnemy(widened, 379, 800); // 19 ≤ 10.08+10
    const stats = fireOnce(widened, ['range_up', 'range_up']);
    expect(stats.beamWidth).toBeCloseTo(14 * 1.44, 9); // 20.16
    expect(e2.hp).toBeCloseTo(97, 6);
  });

  it('射程随范围强化牌（520 → 2 张后 748.8）：y=650 的敌人无牌照不到、2 张后照到', () => {
    // 单敌人状态：光束朝它发射并过它延伸；无双束 → 只吃一次伤害。
    const base = createSimState(1);
    const e1 = makeEnemy(base, 360, 650); // base 段终点 y=700：距段 50 > 17（目标自身也在射程外）
    fireOnce(base);
    expect(e1.hp).toBe(100);

    const extended = createSimState(1);
    const e2 = makeEnemy(extended, 360, 650); // 段终点 y=471.2：650 在段上
    const stats = fireOnce(extended, ['range_up', 'range_up']);
    expect(stats.beamRange).toBeCloseTo(748.8, 9);
    expect(stats.damage).toBe(3);
    expect(e2.hp).toBeCloseTo(97, 6);
  });
});

describe('过热槽（积累 → 泄能 → 散热 → 恢复）', () => {
  it('连续 fire：heat 逐次 +heatPerShot；达阈值（100）当次挂 overheat（factor 1.6）并泄能归 0', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    makeEnemy(state, 360, 900, 1e6);
    const ws = state.weaponStates.heat_beam;

    for (let i = 1; i <= 8; i++) {
      fireOnce(state); // 每次 +12：8 次后 96 < 100
      expect(hasEffect(ws, 'overheat')).toBe(false);
    }
    expect(heatOf(state)).toBeCloseTo(96, 9);

    fireOnce(state); // 96+12 = 108 ≥ 100
    expect(hasEffect(ws, 'overheat')).toBe(true);
    expect(overheatFactor(ws)).toBeCloseTo(1.6, 12); // 效果表 intervalFactor
    expect(heatOf(state)).toBe(0); // 泄能
    expect(ws.effects?.[0]?.untilMs).toBe(state.timeMs + 2500); // 效果表 durationMs
  });

  it('overheat 期间解释器实际开火间隔 = intervalMs × 1.6（对照组无过热为 intervalMs）', () => {
    const def = loadWeaponDefs().heat_beam;
    const defs = { heat_beam: def };

    const hot = createSimState(1);
    addWeapon(hot, 'heat_beam');
    makeEnemy(hot, 360, 900, 1e6);
    const stats = getWeaponStats(def, hot, 'heat_beam');
    for (let i = 0; i < 9; i++) {
      behavior.fire(hot, 'heat_beam', stats); // 第 9 次触发过热
    }
    expect(hasEffect(hot.weaponStates.heat_beam, 'overheat')).toBe(true);

    updateWeapons(hot, 16, defs);
    // 冷却 0-16 → fire → += 120×1.6 = 192 → 176（无过热应为 104）
    expect(hot.weaponStates.heat_beam.cooldownMs).toBeCloseTo(176, 9);

    const cool = createSimState(1);
    addWeapon(cool, 'heat_beam');
    makeEnemy(cool, 360, 900, 1e6);
    updateWeapons(cool, 16, defs);
    expect(cool.weaponStates.heat_beam.cooldownMs).toBe(104); // -16 + 120
  });

  it('update 散热：heat -= coolPerSec × dtSec，下限 0（不为负）；散热强化牌加快散热', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    makeEnemy(state, 360, 900, 1e6);
    fireOnce(state);
    fireOnce(state); // heat 24（coolPerSec 快照 20）

    behavior.update!(state, 1000);
    expect(heatOf(state)).toBeCloseTo(4, 9); // 24 - 20×1

    behavior.update!(state, 1000);
    expect(heatOf(state)).toBe(0); // 4 - 20 → 钳到 0

    behavior.update!(state, 500);
    expect(heatOf(state)).toBe(0); // 已空：保持 0

    // 散热强化牌（+6/张）：coolPerSec 26，同样热量一秒散不完。
    const boosted = createSimState(1);
    addWeapon(boosted, 'heat_beam');
    makeEnemy(boosted, 360, 900, 1e6);
    fireOnce(boosted, ['cooling_up', 'cooling_up']);
    fireOnce(boosted, ['cooling_up', 'cooling_up']); // heat 24，快照 coolPerSec 20+12=32
    behavior.update!(boosted, 1000);
    expect(heatOf(boosted)).toBe(0); // 24 - 32 → 钳到 0
  });

  it('效果到期后 overheatFactor 恢复 1（updateEffects 清理武器效果槽）', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    makeEnemy(state, 360, 900, 1e6);
    for (let i = 0; i < 9; i++) {
      fireOnce(state);
    }
    const ws = state.weaponStates.heat_beam;
    expect(hasEffect(ws, 'overheat')).toBe(true);

    state.timeMs += 2500; // overheat durationMs（效果表值）
    updateEffects(state, 2500);
    expect(hasEffect(ws, 'overheat')).toBe(false);
    expect(overheatFactor(ws)).toBe(1);
  });
});

describe('双束（dual_beam 专属牌）', () => {
  it('两个不同方向的敌人同时被照（各掉一次伤害）；两线之间的旁观者不受伤；VFX 两段', () => {
    const state = createSimState(1);
    const up = makeEnemy(state, 360, 900); // 距 320：最近 → 主束竖直向上
    const right = makeEnemy(state, 700, 1220); // 距 340：次近 → 副束水平向右
    const bystander = makeEnemy(state, 600, 800); // 距 ~497：比两个目标都远，两条线都不在
    const stats = fireOnce(state, ['dual_beam']);

    expect(stats.dualBeam).toBe(1);
    expect(up.hp).toBeCloseTo(97, 6);
    expect(right.hp).toBeCloseTo(97, 6);
    expect(bystander.hp).toBe(100);

    const vfx = vfxOf(state);
    expect(vfx?.segments).toHaveLength(2);
    expect(vfx?.segments[0]).toEqual({ x1: 360, y1: 1220, x2: 360, y2: 700 }); // 主束：射程 520
    expect(vfx?.segments[1]).toEqual({ x1: 360, y1: 1220, x2: 880, y2: 1220 }); // 副束
  });

  it('目标不足两条时只发一条：单敌人只掉一次伤害（不双倍）、VFX 一段', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    const only = makeEnemy(state, 360, 900, 1e6);
    fireOnce(state, ['dual_beam']);
    expect(only.hp).toBeCloseTo(1e6 - 3, 6);
    expect(vfxOf(state)?.segments).toHaveLength(1);
  });
});

describe('灼烧（scorch 灼痕牌）', () => {
  it('被照敌人挂 burn 且 data.damagePerTick 逐实例覆盖为 2；DoT 真实逐跳掉血', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    const e = makeEnemy(state, 360, 900, 1e6);
    fireOnce(state, ['scorch']);

    expect(e.hp).toBeCloseTo(1e6 - 3, 6); // 直击 base damage 3
    expect(e.effects).toHaveLength(1);
    const burn = e.effects[0];
    expect(burn.kind).toBe('burn');
    expect(burn.stacks).toBe(1);
    expect(burn.data.damagePerTick).toBe(2); // 逐实例覆盖（效果表默认 3）
    expect(burn.untilMs).toBe(state.timeMs + 3000); // 效果表 durationMs

    state.timeMs += 500; // burn tickMs
    updateEffects(state, 500);
    expect(e.hp).toBeCloseTo(1e6 - 3 - 2, 6); // 每跳 2 而非 3
  });

  it('无灼痕牌不挂 burn；灼烧重复施加 refresh=reset 保持单实例', () => {
    const plain = createSimState(1);
    const e1 = makeEnemy(plain, 360, 900, 1e6);
    fireOnce(plain);
    expect(e1.effects).toHaveLength(0);

    const scorched = createSimState(1);
    const e4 = makeEnemy(scorched, 360, 900, 1e6);
    fireOnce(scorched, ['scorch']);
    fireOnce(scorched, ['scorch']);
    expect(e4.effects).toHaveLength(1); // reset 语义：不叠实例
    expect(e4.effects[0].kind).toBe('burn');
    expect(e4.effects[0].data.damagePerTick).toBe(2);
  });

  it('被光束直击致死的敌人不挂灼烧（尸体无意义）', () => {
    const state = createSimState(1);
    const frail = makeEnemy(state, 360, 900, 3); // hp 恰等于一 tick 伤害
    fireOnce(state, ['scorch']);
    expect(frail.dead).toBe(true);
    expect(frail.effects).toHaveLength(0);
  });
});

describe('折射（refract_up 折射+1 牌）', () => {
  // 主束竖直向上：终点 E=(360,700)；折射方向 = (0,-1) 旋转 +30° = (sin30, -cos30)，
  // 折射段长 520×0.5=260，终点 F≈(490, 474.8334)，中点 M≈(425, 587.4167)。
  const REFRACT_MID = { x: 425, y: 587.416697508023 };
  const REFRACT_END_Y = 474.833395016046;

  // 纯折射夹具（base 直接带 refraction=1、无 dualBeam）：隔离折射几何，不被双束干扰。
  const refractDef: WeaponDef = {
    id: 'refract_only',
    name: '折射光束',
    behavior: 'heat_beam',
    maxLevel: 10,
    base: {
      damage: 3, intervalMs: 120, projectileSpeed: 0, pierce: 0, ttlMs: 0,
      beamWidth: 14, beamRange: 520, heatPerShot: 12, coolPerSec: 20, overheatThreshold: 100,
      refraction: 1,
    },
    rangeKeys: [],
    cards: [],
  };
  function fireRefract(state: SimState): void {
    state.weaponStates.refract_only = { level: 0, cooldownMs: 0, cards: {} };
    behavior.fire(state, 'refract_only', getWeaponStats(refractDef, state, 'refract_only'));
  }

  it('折射段上的敌人受伤（构造在折射段中点）；-30° 镜像侧的敌人不受伤', () => {
    const state = createSimState(1);
    const main = makeEnemy(state, 360, 900, 1e6); // 主目标（竖直向上）
    const onRefract = makeEnemy(state, REFRACT_MID.x, REFRACT_MID.y, 1e6);
    const mirrored = makeEnemy(state, 200, 500, 1e6); // -30° 侧放在更远处（300px外或不干扰）
    fireRefract(state);

    expect(main.hp).toBeCloseTo(1e6 - 3, 6);
    expect(onRefract.hp).toBeCloseTo(1e6 - 3, 6); // 折射段独立结算同样伤害
    expect(mirrored.hp).toBe(1e6); // 主束与折射段都照不到
  });

  it('每次开火都结算折射段（两次 fire 双倍）；VFX 第二段 = 主束终点折转 +30°、长 260', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 900, 1e6);
    const onRefract = makeEnemy(state, REFRACT_MID.x, REFRACT_MID.y, 1e6);
    fireRefract(state);
    fireRefract(state);
    expect(onRefract.hp).toBeCloseTo(1e6 - 6, 6);

    const vfx = vfxOf(state, 'refract_only');
    expect(vfx?.segments).toHaveLength(2);
    expect(vfx?.segments[0]).toEqual({ x1: 360, y1: 1220, x2: 360, y2: 700 }); // 主束
    expect(vfx?.segments[1]?.x1).toBeCloseTo(360, 9); // 从主束终点折出
    expect(vfx?.segments[1]?.y1).toBeCloseTo(700, 9);
    expect(vfx?.segments[1]?.x2).toBeCloseTo(490, 9);
    expect(vfx?.segments[1]?.y2).toBeCloseTo(REFRACT_END_Y, 9);
    expect(vfx?.untilMs).toBe(state.timeMs + 80); // VFX 留存 80ms
  });

  it('真实表：双束 + 折射叠加（副束不折射，VFX 三段），折射段敌人真实受伤', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 900, 1e6); // 最近 → 主束竖直向上
    makeEnemy(state, 700, 1220, 1e6); // 次近 → 副束水平向右
    const onRefract = makeEnemy(state, REFRACT_MID.x, REFRACT_MID.y, 1e6); // 折射段上
    const stats = fireOnce(state, ['dual_beam', 'scorch', 'refract_up']);

    expect(stats.refraction).toBe(1);
    expect(onRefract.hp).toBeCloseTo(1e6 - 3, 6); // 只被折射段照到（副束目标是 right）

    const vfx = vfxOf(state);
    expect(vfx?.segments).toHaveLength(3);
    expect(vfx?.segments[1]?.x2).toBeCloseTo(490, 9); // 第 2 段是主束折射段
    expect(vfx?.segments[2]).toEqual({ x1: 360, y1: 1220, x2: 880, y2: 1220 }); // 副束仍满射程
  });
});

describe('数值全部来自 weapons/heat_beam.json（真实表驱动，T5.3a 牌池制）', () => {
  const def = loadWeaponDefs().heat_beam;

  it('表身份：id/name/behavior/maxLevel=10，behavior 已自动发现注册', () => {
    expect(def.id).toBe('heat_beam');
    expect(def.name).toBe('灼热光束');
    expect(def.behavior).toBe('heat_beam');
    expect(def.maxLevel).toBe(10);
    expect(getBehavior('heat_beam')).toBe(behavior); // import.meta.glob 自动注册
  });

  it('牌目录：专属牌在前（dual_beam/scorch/refract_up/cooling_up），通用牌合并追加；rangeKeys=光束宽+射程', () => {
    expect(def.cards.slice(0, 4).map((c) => c.id)).toEqual(['dual_beam', 'scorch', 'refract_up', 'cooling_up']);
    const ids = def.cards.map((c) => c.id);
    for (const genericId of ['dmg_up', 'spd_up', 'range_up', 'dot_freq']) {
      expect(ids).toContain(genericId);
    }
    expect(ids).not.toContain('multi_shot'); // 光束不吃弹道牌
    const dot = def.cards.find((c) => c.id === 'dot_freq')!;
    expect(dot.requiresCard).toBe('scorch'); // dot频率前置：灼痕
    expect(def.rangeKeys).toEqual(['beamWidth', 'beamRange']);
  });

  it('base 数值随表；牌组 stats 注入（宽度/射程乘区、散热 add、开关 set）', () => {
    expect(def.base).toMatchObject({
      damage: 3, intervalMs: 120, projectileSpeed: 0, pierce: 0, ttlMs: 0,
      beamWidth: 14, beamRange: 520, heatPerShot: 12, coolPerSec: 20, overheatThreshold: 100,
    });

    const shoot = (cards: string[]): WeaponStats => {
      const state = createSimState(1);
      makeEnemy(state, 360, 900, 1e6);
      return fireOnce(state, cards);
    };
    const boosted = shoot(['cooling_up', 'cooling_up']);
    expect(boosted.coolPerSec).toBe(32); // 20 + 6×2
    expect(shoot(['range_up']).beamWidth).toBeCloseTo(16.8, 9);
    expect(shoot(['range_up']).beamRange).toBeCloseTo(624, 9);
    expect(shoot(['dual_beam']).dualBeam).toBe(1);
  });

  it('alt def（不同数值）驱动同一行为：伤害/宽度/射程/过热参数全部随表', () => {
    const altDef: WeaponDef = {
      id: 'alt_heat',
      name: '替换光束',
      behavior: 'heat_beam',
      maxLevel: 10,
      base: {
        damage: 9, intervalMs: 200, projectileSpeed: 0, pierce: 0, ttlMs: 0,
        beamWidth: 40, beamRange: 300, heatPerShot: 50, coolPerSec: 5, overheatThreshold: 100,
      },
      rangeKeys: [],
      cards: [],
    };
    const state = createSimState(1);
    addWeapon(state, 'alt_heat');
    const altStats = getWeaponStats(altDef, state, 'alt_heat');

    // 伤害 9、宽度 40（半宽 20+10=30：偏移 25 命中）、射程 300（终点 y=920）。
    const onLine = makeEnemy(state, 360, 1000, 1e6);
    const wide = makeEnemy(state, 385, 1000, 1e6); // 偏移 25 ≤ 30
    const farOut = makeEnemy(state, 360, 850, 1e6); // 距段 70 > 30
    behavior.fire(state, 'alt_heat', altStats);
    expect(onLine.hp).toBeCloseTo(1e6 - 9, 6);
    expect(wide.hp).toBeCloseTo(1e6 - 9, 6);
    expect(farOut.hp).toBe(1e6);
    expect(heatOf(state, 'alt_heat')).toBeCloseTo(50, 9);

    // 过热参数随表：heatPerShot 50 / threshold 100 → 第 2 发达 100 → 挂 overheat + 泄能。
    behavior.fire(state, 'alt_heat', altStats);
    expect(heatOf(state, 'alt_heat')).toBe(0);
    expect(hasEffect(state.weaponStates.alt_heat, 'overheat')).toBe(true);
    expect(overheatFactor(state.weaponStates.alt_heat)).toBeCloseTo(1.6, 12);
  });
});

describe('解释器集成（updateWeapons 节奏 + 过热循环）', () => {
  it('首帧开火节奏正确；长跑中过热至少触发一次、总伤为 damage 整数倍且在上界内', () => {
    const def = loadWeaponDefs().heat_beam;
    const defs = { heat_beam: def };
    const state = createSimState(1);
    const tank = makeEnemy(state, 360, 900, 1e6);
    addWeapon(state, 'heat_beam');

    updateWeapons(state, 16, defs);
    expect(tank.hp).toBeCloseTo(1e6 - 3, 6);
    expect(state.weaponStates.heat_beam.cooldownMs).toBe(104); // -16 + 120

    let sawOverheat = false;
    for (let f = 0; f < 300; f++) { // 300×16 = 4800ms
      updateWeapons(state, 16, defs);
      state.timeMs += 16;
      updateEffects(state, 16);
      if (hasEffect(state.weaponStates.heat_beam, 'overheat')) {
        sawOverheat = true;
      }
    }
    expect(sawOverheat).toBe(true); // 过热循环真实发生
    const dealt = 1e6 - tank.hp;
    expect(dealt).toBeGreaterThan(0);
    expect(dealt % 3).toBe(0); // 每 tick 恰 3 点
    expect(dealt).toBeLessThanOrEqual(3 * 41); // 4800ms / 120ms = 40 次 + 首帧 1 次的上界
  });
});

describe('可复现（行为零随机：不读 rng，任意种子同结果）', () => {
  /** 固定场景：双束+灼烧+折射+范围×2 全开连打 12 tick + 散热/DoT 推进的全量结果快照。 */
  function scenario(seed: number): {
    aHp: number; bHp: number; cHp: number; effects: Array<Record<string, unknown>>;
    heat: number; overheat: boolean; nextId: number; projectiles: number;
  } {
    const state = createSimState(seed);
    addWeapon(state, 'heat_beam');
    const a = makeEnemy(state, 360, 900, 1e6); // 主束目标
    const b = makeEnemy(state, 700, 1220, 1e6); // 副束目标
    const c = makeEnemy(state, 379, 900, 1e6); // 偏移 19 ≤ 2 张范围牌后半宽 10.08+10=20.08：主束照到
    for (let i = 0; i < 12; i++) {
      fireOnce(state, ['dual_beam', 'scorch', 'refract_up', 'range_up', 'range_up']);
      state.timeMs += 120;
      updateEffects(state, 120);
      behavior.update!(state, 120); // 散热
    }
    return {
      aHp: a.hp,
      bHp: b.hp,
      cHp: c.hp,
      effects: a.effects.map((x) => ({ kind: x.kind, stacks: x.stacks, data: { ...x.data } })),
      heat: heatOf(state),
      overheat: hasEffect(state.weaponStates.heat_beam, 'overheat'),
      nextId: state.nextId,
      projectiles: state.projectiles.length,
    };
  }

  it('同种子两次全流程一致；异种子也一致（确定性映射，全程不消耗 rng）', () => {
    expect(scenario(42)).toEqual(scenario(42));
    expect(scenario(42)).toEqual(scenario(7));
  });
});

// —— T5.3b 接线：折射叠层（按牌张数循环）/ dot 频率（灼痕 tick 间隔 ÷1.3） ——

describe('折射叠层与智能寻敌（refract_up 牌：300px内最近寻敌，无敌人时回退 +30°）', () => {
  it('2 张折射+1 → VFX 3 段（主束 + 2 段链式折射）；300px内无敌人时回退 +30° 旋转续射', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1100); // 主束目标（距 (360,700) 400px > 300px）
    fireOnce(state, ['refract_up', 'refract_up']);

    const vfx = vfxOf(state)!;
    expect(vfx.segments).toHaveLength(3); // 主束 + 折射段×2
    const [m, r1, r2] = vfx.segments;
    expect(m.x2).toBeCloseTo(360, 6);
    expect(m.y2).toBeCloseTo(700, 6);
    const rad30 = (30 * Math.PI) / 180;
    expect(r1.x1).toBeCloseTo(360, 6);
    expect(r1.y1).toBeCloseTo(700, 6);
    expect(r1.x2).toBeCloseTo(360 + 260 * Math.sin(rad30), 6);
    expect(r1.y2).toBeCloseTo(700 - 260 * Math.cos(rad30), 6);
    const rad60 = (60 * Math.PI) / 180;
    expect(r2.x1).toBeCloseTo(r1.x2, 6);
    expect(r2.y1).toBeCloseTo(r1.y2, 6);
    expect(r2.x2).toBeCloseTo(r1.x2 + 260 * Math.sin(rad60), 6);
    expect(r2.y2).toBeCloseTo(r1.y2 - 260 * Math.cos(rad60), 6);
  });

  it('智能寻敌：折射段在300px内搜寻距端点最近的存活敌人并发射', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1100, 1e6); // 主目标（在远处，300px内无干扰）
    const targetNearRefract = makeEnemy(state, 425, 587.4166, 1e6); // 在折射 300px 内
    fireOnce(state, ['refract_up']);

    expect(targetNearRefract.hp).toBeCloseTo(1e6 - 3, 6);
  });
});

describe('dot 频率（dot_freq 牌，requiresCard=scorch：灼痕 tick 间隔 ÷1.3）', () => {
  it('1 张 dot 频率：灼烧实例 tickMs = 500/1.3，首跳在 384.6ms（而非 500ms）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 900, 1e6);
    fireOnce(state, ['scorch', 'dot_freq']);
    expect(e.hp).toBeCloseTo(1e6 - 3, 6); // 光束直击
    expect(e.effects[0].kind).toBe('burn');
    expect(e.effects[0].data.damagePerTick).toBe(2); // 灼痕逐实例覆盖保持
    expect(e.effects[0].data.tickMs).toBeCloseTo(500 / 1.3, 9); // dot 频率覆盖

    // 首跳时序：384.6ms 已跳（-2），300ms 未跳
    const mid = createSimState(1);
    const em = makeEnemy(mid, 360, 900, 1e6);
    fireOnce(mid, ['scorch', 'dot_freq']);
    mid.timeMs += 300;
    updateEffects(mid, 300);
    expect(em.hp).toBeCloseTo(1e6 - 3, 6); // 未到 384.6：无 DoT 跳
    mid.timeMs += 84.7;
    updateEffects(mid, 84.7);
    expect(em.hp).toBeCloseTo(1e6 - 3 - 2, 6); // 384.7 ≥ 384.6：首跳
  });

  it('2 张 dot 频率：tickMs = 500/1.3²；无 dot 频率牌不写 tickMs 键（保持效果表节奏）', () => {
    const two = createSimState(1);
    const e2 = makeEnemy(two, 360, 900, 1e6);
    fireOnce(two, ['scorch', 'dot_freq', 'dot_freq']);
    expect(e2.effects[0].data.tickMs).toBeCloseTo(500 / 1.3 / 1.3, 9);

    const none = createSimState(1);
    const e0 = makeEnemy(none, 360, 900, 1e6);
    fireOnce(none, ['scorch']);
    expect('tickMs' in e0.effects[0].data).toBe(false); // 不钉死效果表定义值
    expect(e0.effects[0].data.damagePerTick).toBe(2);
  });
});
