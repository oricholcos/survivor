// src/core/damageStats.test.ts —— 全口径伤害统计与归因专项单测。

import { describe, expect, it } from 'vitest';
import { createSimState } from './simState';
import type { SimState, Enemy } from './types';
import { addWeapon, type WeaponStats } from './weapons';
import { applyEffect, dealDamage, updateEffects } from './effects';
import { updateZones } from './zones';
import { SpatialHash } from './spatialHash';
import { getBehavior } from './behaviors/registry';

import { loadEffectDefs } from '../data/effects';

// 确保行为与效果定义注册
loadEffectDefs();
import './behaviors/behavior_chargeSniper';
import './behaviors/behavior_heatBeam';
import './behaviors/behavior_homingMissile';
import './behaviors/behavior_mortar';
import './behaviors/behavior_piercingBolt';
import './behaviors/behavior_prismChain';
import './behaviors/behavior_scatterShot';
import './behaviors/behavior_seismicPulse';

function makeEnemy(state: SimState, x: number, y: number, hp = 10000): Enemy {
  const e: Enemy = {
    id: state.nextId++,
    typeId: 'swarmer',
    name: '测试怪',
    x,
    y,
    radius: 16,
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

describe('全口径伤害统计系统（All-Caliber Damage Attribution）', () => {
  it('dealDamage: 基础直击与穿透直接累加至 weaponStates[weaponId].damageDealt', () => {
    const state = createSimState(1);
    addWeapon(state, 'scatter');
    addWeapon(state, 'rail_piercer');

    const e1 = makeEnemy(state, 360, 200, 1000);
    const e2 = makeEnemy(state, 360, 250, 1000);

    dealDamage(state, e1, 150, 'scatter');
    dealDamage(state, e2, 300, 'rail_piercer');

    expect(state.weaponStates['scatter'].damageDealt).toBe(150);
    expect(state.weaponStates['rail_piercer'].damageDealt).toBe(300);

    // 易伤/标记放大生效（mark 效果提供 1.25x 易伤，实际扣血量 100 * 1.25 = 125 归属）
    applyEffect(state, e1, 'mark');
    dealDamage(state, e1, 100, 'scatter');
    expect(state.weaponStates['scatter'].damageDealt).toBe(150 + 125);
  });

  it('DoT 持续伤害：tickEffectList 中的灼烧与中毒每跳伤害正确溯源到源武器', () => {
    const state = createSimState(1);
    addWeapon(state, 'mortar');
    addWeapon(state, 'prism');

    const e = makeEnemy(state, 360, 200, 1000);

    // 挂上 mortar 来源的灼烧（每跳 50 点，间隔 200ms）
    applyEffect(state, e, 'burn', { damagePerTick: 50, tickMs: 200 }, 'mortar');
    // 挂上 prism 来源的中毒（基于武器伤害 100 点，每跳 100 * 0.25 = 25 点，间隔 200ms）
    applyEffect(state, e, 'poison', { weaponDamage: 100, tickMs: 200 }, 'prism');

    // 推进 200ms 触发一跳
    state.timeMs += 200;
    updateEffects(state, 200);

    expect(state.weaponStates['mortar'].damageDealt).toBe(50);
    expect(state.weaponStates['prism'].damageDealt).toBe(25);
  });

  it('尸爆（burnExplosion）与次级传染灼烧：100% 继承原灼烧的 sourceWeaponId', () => {
    const state = createSimState(1);
    addWeapon(state, 'homing_missile');

    const eTarget = makeEnemy(state, 360, 200, 100);
    makeEnemy(state, 365, 200, 1000); // eNearby

    // 挂上 homing_missile 的灼烧
    applyEffect(state, eTarget, 'burn', { damagePerTick: 30, tickMs: 200 }, 'homing_missile');

    // 击杀 eTarget，触发尸爆直击周围目标
    dealDamage(state, eTarget, 1000, 'homing_missile');
    expect(eTarget.dead).toBe(true);

    // 尸爆已产生伤害并挂下次级灼烧，源武器均为 homing_missile
    const dmgBefore = state.weaponStates['homing_missile'].damageDealt ?? 0;
    // 推进一跳 DoT 让次级传染灼烧跳伤
    state.timeMs += 500;
    updateEffects(state, 500);
    const dmgAfter = state.weaponStates['homing_missile'].damageDealt ?? 0;
    expect(dmgAfter).toBeGreaterThan(dmgBefore);
  });

  it('地面区域（Zone）：迫击炮燃烧地与震波熔岩裂隙伤害正确归属于源武器', () => {
    const state = createSimState(1);
    addWeapon(state, 'seismic_wall');

    const b = getBehavior('seismic_pulse');
    // 激活熔岩裂隙（earthSplit: 1）
    const stats: WeaponStats = {
      damage: 100,
      bandDepth: 40,
      waveDistance: 200,
      knockbackForce: 100,
      stunBonusMs: 0,
      overloadResonance: 0,
      wallResonanceHeal: 0,
      wallResonanceHits: 0,
      earthSplit: 1,
    } as unknown as WeaponStats;

    makeEnemy(state, 360, 1100, 1000);
    b.fire(state, 'seismic_wall', stats);

    // 推进 400ms，完成 sweep 并生成 4 个熔岩裂隙 Zone
    state.timeMs += 400;
    b.update?.(state, 400);

    const initialDmg = state.weaponStates['seismic_wall'].damageDealt ?? 0;
    expect(initialDmg).toBeGreaterThan(0); // sweep 本身命中了 1100 处的敌人

    // 在熔岩裂隙处放置新敌人
    makeEnemy(state, 90, state.layout.wallLineY - 100, 1000);

    // 构建空间网格推进 Zone 结算
    const grid = new SpatialHash<Enemy>(64);
    for (const e of state.enemies) {
      if (!e.dead) grid.insert(e, e.x, e.y, e.radius);
    }
    updateZones(state, 500, grid);

    const afterDmg = state.weaponStates['seismic_wall'].damageDealt ?? 0;
    expect(afterDmg).toBeGreaterThan(initialDmg);
  });

  it('协同齐射：次级武器开火的伤害自归因于实际开火武器，而非主导的灼热光束', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    addWeapon(state, 'rail_piercer');

    makeEnemy(state, 360, 200, 10000);

    const hb = getBehavior('heat_beam');
    const stats: WeaponStats = {
      damage: 10,
      fireRate: 5,
      interval: 200,
      coordinatedFire: 1,
      coordinatedThreshold: 1, // 1 跳即触发齐射
      scorch: 0,
      secondFlash: 0,
      damageLoadRate: 0,
      heatSpikeChance: 0,
    } as unknown as WeaponStats;

    hb.fire(state, 'heat_beam', stats);

    // 验证：灼热光束造成了主束伤害，而轨道贯穿炮也独立结算并归属了贯穿伤害
    const hbDmg = state.weaponStates['heat_beam'].damageDealt ?? 0;
    const rpDmg = state.weaponStates['rail_piercer'].damageDealt ?? 0;

    expect(hbDmg).toBe(10);
    expect(rpDmg).toBeGreaterThan(0); // rail_piercer 打出了独立伤害并自归属
  });

  it('蓄力狙击：爆头暴击与死刑宣告处决全额归属于 charge_sniper', () => {
    const state = createSimState(1);
    addWeapon(state, 'charge_sniper');

    const sniper = getBehavior('charge_sniper');
    const stats: WeaponStats = {
      damage: 100,
      critShot: 1,
      critChance: 1.0,
      critMultiplier: 2.0,
      executionOrder: 1,
      executionHpFactor: 0.5,
      projectileSpeed: 1000,
      ttlMs: 2000,
    } as unknown as WeaponStats;

    // 敌人 300 血，被直击 100 + 爆头追加 100 + 处决 100 = 300 击杀
    const e = makeEnemy(state, 360, 200, 300);
    sniper.fire(state, 'charge_sniper', stats);

    // 弹丸向前飞行命中
    const p = state.projectiles[0];
    expect(p).toBeDefined();
    expect(p.weaponId).toBe('charge_sniper');

    // 模拟框架先结算基础直击伤害
    dealDamage(state, e, p.damage, p.weaponId);

    // 命中钩子结算爆头与死刑宣告
    sniper.onProjectileHit?.(state, p, e);

    const dmg = state.weaponStates['charge_sniper'].damageDealt ?? 0;
    expect(dmg).toBe(300);
    expect(e.dead).toBe(true);
  });

  it('棱镜往复与折返光梭：连锁闪电与折返光梭弹丸均归属于 prism', () => {
    const state = createSimState(1);
    addWeapon(state, 'prism');

    const prism = getBehavior('prism_chain');
    const stats: WeaponStats = {
      damage: 50,
      chainCount: 1,
      chainRange: 200,
      falloff: 0.8,
      chainLightning: 1,
      zapRadius: 100,
      zapDamage: 20,
      focusReturn: 1,
      focusOverload: 1,
      projectileSpeed: 500,
      ttlMs: 2000,
    } as unknown as WeaponStats;

    const e1 = makeEnemy(state, 360, 300, 1000);
    const e2 = makeEnemy(state, 380, 300, 1000); // 闪电受击者

    prism.fire(state, 'prism', stats);
    const p = state.projectiles[0];
    expect(p.weaponId).toBe('prism');

    // 主弹命中 e1，触发闪电打 e2，并终止弹跳生成双折返光梭
    prism.onProjectileHit?.(state, p, e1);

    const dmg = state.weaponStates['prism'].damageDealt ?? 0;
    expect(dmg).toBeGreaterThanOrEqual(20); // e2 受到 zap 伤害归属于 prism
    expect(e2.hp).toBeLessThan(1000);

    // 检查折返光梭的 weaponId
    const returnProjs = state.projectiles.filter((proj) => proj.data.returning === 1);
    expect(returnProjs.length).toBe(2);
    expect(returnProjs[0].weaponId).toBe('prism');
    expect(returnProjs[1].weaponId).toBe('prism');
  });
});
