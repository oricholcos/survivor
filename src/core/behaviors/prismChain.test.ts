// src/core/behaviors/prismChain.test.ts —— 弹射棱镜行为契约（T5.3a 牌池制更新）：
// 弹跳目标不重复（hitIds 集合递增、同一敌人不挨两次直击）、伤害递减曲线（第 n 次命中
// × falloff^(n-1)：10/8/6.4）、次数用尽/链不及销毁、连锁闪电（zapRadius 内至多 2 个、
// 与直击目标不重复）、冰/毒附着（chill+poison 同挂效果槽、致死一击不附着）、
// 回旋返回（链条用尽生成朝角色的回旋弹、再扫人群、不再回旋）、
// 首跳提前量命中移动目标 + 弹跳朝当前位置直线不加预测（T5.2a：弹道 vs 追踪的区分点）、
// 数值全部来自 weapons/prism.json 真实表驱动（弹跳次数成长走弹跳+1牌、递减系数走链路稳定牌；
// 等级语义改为牌组）、同种子可复现。
import { describe, expect, it } from 'vitest';
import { loadEffectDefs } from '../../data/effects';
import { loadWeaponDefs } from '../../data/weapons';
import { dealDamage, hasEffect, updateEffects } from '../effects';
import { normalize, scale } from '../math';
import { spawnProjectile, updateProjectiles } from '../projectiles';
import { createSimState } from '../simState';
import { SpatialHash } from '../spatialHash';
import type { Enemy, Projectile, SimState } from '../types';
import { addWeapon, getWeaponStats, updateWeapons } from '../weapons';
import type { WeaponStats } from '../weapons';
import { PRISM_ZAP_VFX_KEY, behavior, type PrismZapSegment } from './behavior_prismChain';
import './index'; // 副作用：自动发现注册
import { getBehavior } from './registry';

// 副作用：把 effects.json 真实效果表注册进 core/effects（chill/poison 特效槽依赖）。
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

/**
 * 逐帧推进弹丸（prism_chain 无 update 钩子，帧序与生产一致），弹丸清空即提前收束。
 * 每帧推进 state.timeMs（效果 untilMs / 毒 DoT tick 都在 state.timeMs 时间轴上）。
 */
function simulate(state: SimState, frames: number, dt = 16): void {
  const grid = new SpatialHash<Enemy>(64);
  for (let f = 0; f < frames && state.projectiles.length > 0; f++) {
    updateProjectiles(state, dt, grid);
    state.timeMs += dt;
  }
}

/** 以真实数据表 prism.json 的指定牌组开火一次（需先放好目标敌人）。 */
function fireWithCards(state: SimState, cards: string[] = []): WeaponStats {
  const def = loadWeaponDefs().prism;
  if (!state.weaponStates.prism) {
    state.weaponStates.prism = { level: 0, cooldownMs: 0, cards: {} };
  }
  const ws = state.weaponStates.prism;
  ws.cards = {};
  for (const cardId of cards) {
    ws.cards[cardId] = (ws.cards[cardId] ?? 0) + 1;
  }
  ws.level = cards.length;
  const stats = getWeaponStats(def, state, 'prism');
  behavior.fire(state, 'prism', stats);
  return stats;
}

/** 与真实表无牌 fire 快照同构的弹上 data（直调钩子用，开关可覆盖）。 */
function prismData(overrides?: Record<string, number>): Record<string, number> {
  return {
    chainsLeft: 3,
    chainCount: 3,
    baseDamage: 10,
    falloff: 0.8,
    chainRange: 150,
    chainLightning: 0,
    zapRadius: 90,
    zapDamage: 4,
    focusReturn: 0,
    prismRecurse: 0,
    frostVenom: 0,
    ...overrides,
  };
}

describe('弹跳链基础（无牌：chainCount=3 / falloff=0.8 / 无机制牌）', () => {
  it('三连跳各次伤害 10 / 8 / 6.4（第 n 次命中 × falloff^(n-1)），次数用尽弹消失、无 focusReturn 不产折返', () => {
    const state = createSimState(1); // 角色 (360, 1220)
    const e1 = makeEnemy(state, 360, 1120); // 距角色 100，纵列排布、间距 120 < chainRange 150
    const e2 = makeEnemy(state, 360, 1000);
    const e3 = makeEnemy(state, 360, 880);
    const nextIdAfterSetup = state.nextId;

    fireWithCards(state);
    expect(state.projectiles).toHaveLength(1);

    simulate(state, 120);

    expect(state.projectiles).toHaveLength(0); // 恰 3 次命中后 chainsLeft 用尽 → 弹亡
    // 伤害递减曲线：800px/s × 16ms = 12.8px/帧，各跳直击结算 10 / 10×0.8 / 10×0.8²。
    expect(e1.hp).toBeCloseTo(100 - 10, 6);
    expect(e2.hp).toBeCloseTo(100 - 8, 6);
    expect(e3.hp).toBeCloseTo(100 - 6.4, 6);
    expect(state.nextId - nextIdAfterSetup).toBe(1); // 全程只产 1 枚弹：无折返、无续弹
  });

  it('伤害递减实现直证：钩子在每次直击后为下一跳重写 proj.damage = baseDamage × falloff^已命中次数', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1120, 100000);
    makeEnemy(state, 360, 1000, 100000);
    makeEnemy(state, 360, 880, 100000);
    fireWithCards(state);
    const grid = new SpatialHash<Enemy>(64);

    // 逐帧记录弹上 damage 的「 distinct 序列」：初始 10 → 第 1 跳后 8 → 第 2 跳后 6.4
    // （第 3 跳当帧弹亡回池，5.12 只存在于回旋弹公式，主弹上观测不到）。
    const seen: number[] = [];
    for (let f = 0; f < 120 && state.projectiles.length > 0; f++) {
      updateProjectiles(state, 16, grid);
      state.timeMs += 16;
      const p = state.projectiles[0];
      if (p && seen[seen.length - 1] !== p.damage) {
        seen.push(p.damage);
      }
    }
    expect(seen).toHaveLength(3);
    expect(seen[0]).toBe(10);
    expect(seen[1]).toBeCloseTo(10 * 0.8, 9);
    expect(seen[2]).toBeCloseTo(10 * 0.8 * 0.8, 9);
  });

  it('弹跳目标不重复（2 张弹跳+1：chainCount=5）：hitIds 集合逐跳递增、每跳恰新增一个未打过的敌人', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 360, 1120, 100000);
    const e2 = makeEnemy(state, 360, 1000, 100000);
    const e3 = makeEnemy(state, 360, 880, 100000);
    fireWithCards(state, ['bounce_up', 'bounce_up']); // chainCount 5 > 敌人数：3 连跳后 range 内无新目标自毁
    const grid = new SpatialHash<Enemy>(64);

    // 逐帧采集命中后的 hitIds 快照（第 3 跳当帧弹亡回池，观测不到——由 hp 锁定）。
    const snapshots: number[][] = [];
    let lastLen = 0;
    for (let f = 0; f < 120 && state.projectiles.length > 0; f++) {
      updateProjectiles(state, 16, grid);
      state.timeMs += 16;
      const p = state.projectiles[0];
      if (p && p.hitIds.length > lastLen) {
        snapshots.push([...p.hitIds]);
        lastLen = p.hitIds.length;
      }
    }
    expect(state.projectiles).toHaveLength(0); // 次数未用尽、无新目标 → 链终止销毁
    expect(snapshots).toEqual([[e1.id], [e1.id, e2.id]]); // 集合严格递增、只增新 id
    for (const snap of snapshots) {
      expect(new Set(snap).size).toBe(snap.length); // 无重复 id
    }
    // hp 锁定「同一敌人不挨两次直击」：各恰吃一跳（falloff 仍 0.8）。
    expect(e1.hp).toBeCloseTo(100000 - 10, 6);
    expect(e2.hp).toBeCloseTo(100000 - 8, 6);
    expect(e3.hp).toBeCloseTo(100000 - 6.4, 6);
  });

  it('chainRange 外无续跳目标 → 弹即亡：链不及第二敌人（180px > 150px）', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 360, 1120);
    const e2 = makeEnemy(state, 360, 950); // 距 e1 命中点 ~180 > chainRange 150
    const nextIdAfterSetup = state.nextId;

    fireWithCards(state);
    simulate(state, 120);

    expect(state.projectiles).toHaveLength(0);
    expect(e1.hp).toBeCloseTo(90, 6); // 恰 1 跳
    expect(e2.hp).toBe(100); // 链不及：无伤
    expect(state.nextId - nextIdAfterSetup).toBe(1); // 无续弹
  });

  it('链路稳定牌（+0.05/张）：递减系数变缓（3 张 → falloff 0.95），第 2/3 跳伤害相应提高', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 360, 1120, 100000);
    const e2 = makeEnemy(state, 360, 1000, 100000);
    const e3 = makeEnemy(state, 360, 880, 100000);
    fireWithCards(state, ['link_stable', 'link_stable', 'link_stable']);

    simulate(state, 120);

    expect(e1.hp).toBeCloseTo(100000 - 10, 6);
    expect(e2.hp).toBeCloseTo(100000 - 10 * 0.95, 9);
    expect(e3.hp).toBeCloseTo(100000 - 10 * 0.95 * 0.95, 9);
  });
});

describe('首跳提前量与弹跳不预测（T5.2a：弹道 vs 追踪的区分点）', () => {
  it('首跳对 march 怪加提前量：弹指向预测点 (600,900) 而非当前位置 (600,820)，0.5s 精确命中', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 600, 820);
    e.speed = 160; // march：向下 160px/s

    fireWithCards(state); // projectileSpeed 800

    expect(state.projectiles).toHaveLength(1);
    const p = state.projectiles[0];
    // 提前量精确解：Δ=(240,-400)、v=(0,160)、s=800 → t=0.5、预测点 (600,900)，
    // 方向 (240,-320)/400 = (0.6,-0.8) → 弹速分量 (480,-640)。
    // 无提前量版本会瞄准当前位置 (600,820)（方向 ≈ (411.6,-686.0)），断言可区分。
    expect(p.vx).toBeCloseTo(480, 6);
    expect(p.vy).toBeCloseTo(-640, 6);

    // 逐帧推进（手动行军 + 弹丸直线推进，帧序与生产一致）→ t=0.5s 弹与怪同达 (600,900)。
    const grid = new SpatialHash<Enemy>(64);
    for (let f = 0; f < 60 && state.projectiles.length > 0; f++) {
      e.y += 160 * 0.016;
      updateProjectiles(state, 16, grid);
      state.timeMs += 16;
    }
    expect(e.hp).toBe(90); // 主目标必中：100 - 10（首跳全额）
  });

  it('弹跳不加预测：续跳朝目标「当前位置」直线飞（直调钩子锁定方向），短距弹跳仍真实命中', () => {
    const state = createSimState(1);
    const hit = makeEnemy(state, 500, 760, 100000); // 已被打过（hitIds），不参与续跳
    const next = makeEnemy(state, 560, 880);
    next.speed = 160; // march：向下 160px/s

    const proj = spawnProjectile(state, {
      behavior: 'prism_chain',
      x: 500,
      y: 800,
      vx: 0,
      vy: -800,
      damage: 10,
      pierceLeft: 999,
      ttlMs: 4000,
      data: prismData({ chainsLeft: 2 }), // 直击消耗 1 次后仍剩 1：触发续跳
    });
    proj.hitIds.push(hit.id); // 模拟框架：直击结算后（push 完成）才调钩子
    behavior.onProjectileHit!(state, proj, hit);

    // 续跳方向 = 朝 next 的当前位置 (560,880)：(60,80)/100 = (0.6,0.8) × 800 = (480,640)。
    // 若加预测（next 以 160px/s 行军、飞行 100/800=0.125s → 预测点 (560,900)），
    // 方向为 (60,100)/116.6 ≈ (411.6,685.6)——断言锁定「弹跳不加预测」。
    expect(proj.vx).toBeCloseTo(480, 6);
    expect(proj.vy).toBeCloseTo(640, 6);

    // 弹跳距离短（100px、0.125s）：朝当前位置直线飞仍命中行军中的 next（与追踪武器的
    // 区分点：跳转后方向不再修正，命中靠短距离 + 收益于目标迎面/相向位移）。
    const grid = new SpatialHash<Enemy>(64);
    for (let f = 0; f < 20 && state.projectiles.length > 0; f++) {
      next.y += 160 * 0.016;
      updateProjectiles(state, 16, grid);
      state.timeMs += 16;
    }
    expect(next.hp).toBe(92); // 续跳直击 8（伤害递减 10 × 0.8^1）
  });
});

describe('连锁闪电（chain_lightning 牌）', () => {
  it('zapRadius 内至多 zap 2 个：数组序前 2 个候选受 zapDamage（致死），第 3 个被上限截断', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 360, 1120); // 直击目标（hp 100）
    const z0 = makeEnemy(state, 360, 1040, 4); // 距 e1 80 ≤ 90+10：zap 候选 1（zap 即死）
    const z1 = makeEnemy(state, 440, 1130, 4); // 距 e1 ~80.6：zap 候选 2（zap 即死）
    const z2 = makeEnemy(state, 300, 1130, 1000); // 距 e1 ~60.8：候选 3（超 2 个上限 → 不 zap）
    const z3 = makeEnemy(state, 560, 1130, 4); // 距 e1 200：zap 半径外
    fireWithCards(state, ['chain_lightning']);

    simulate(state, 120);

    // 直击 10；e1 在 hitIds 绝不被 zap（zap 目标与直击目标不重复）。
    expect(e1.hp).toBeCloseTo(90, 6);
    expect(z0.dead).toBe(true); // zap 4 ≥ hp 4
    expect(z1.dead).toBe(true);
    // 上限截断：第 3 候选没被 zap；它同时是距命中点最近的续跳目标，吃直击 8。
    expect(z2.dead).toBe(false);
    expect(z2.hp).toBeCloseTo(1000 - 8, 6);
    // z3 在 zap 半径与续跳范围（z2 命中点 251px > 150）之外：无伤。
    expect(z3.hp).toBe(4);
    expect(state.projectiles).toHaveLength(0);
  });

  it('逐跳闪电结算：hop1 zap 2 个邻域敌人；hop2/hop3 的 zap 正确排除 hitIds 成员与半径外目标', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 360, 1120, 1000);
    const a1 = makeEnemy(state, 360, 1040, 1000); // 距 e1 80：hop1 zap；hop3 直击
    const a2 = makeEnemy(state, 440, 1130, 1000); // 距 e1 ~80.6：hop1 zap；距命中点 80 < 90.4 → hop2 直击
    fireWithCards(state, ['chain_lightning']);

    simulate(state, 120);

    expect(state.projectiles).toHaveLength(0); // 3 跳用尽
    // e1：直击 10，从不吃 zap（hitIds 排除）。
    expect(e1.hp).toBeCloseTo(990, 6);
    // a2：hop1 zap 5 (50% of 10) + 直击 8（第 2 跳）。hop2 的 zap 以 a2 为圆心：a1 距其 ~120 > 90+10 不及。
    expect(a2.hp).toBeCloseTo(1000 - 5 - 8, 6);
    // a1：hop1 zap 5 + 直击 6.4（第 3 跳）。hop3 的 zap：e1/a2 均已在 hitIds。
    expect(a1.hp).toBeCloseTo(1000 - 5 - 6.4, 6);
  });

  it('连锁闪电反馈闭环：伤害结算、meta[PRISM_ZAP_VFX_KEY] 坐标记录、sfx: hit 事件触发及过期清理', () => {
    const state = createSimState(1);
    state.timeMs = 100;
    // 注入一条已过期的旧 VFX 条目（untilMs = 50 <= state.timeMs），验证会被过滤淘汰
    state.meta[PRISM_ZAP_VFX_KEY] = [
      { x1: 0, y1: 0, x2: 10, y2: 10, untilMs: 50 },
    ];

    const e1 = makeEnemy(state, 360, 1120, 100); // 直击目标
    const z1 = makeEnemy(state, 360, 1060, 50); // 距 e1 60px，在 zapRadius 90 内
    const proj: Projectile = {
      id: 1,
      behavior: 'prism_chain',
      x: e1.x,
      y: e1.y,
      vx: 0,
      vy: -800,
      radius: 6,
      damage: 10,
      pierceLeft: 999,
      bouncesLeft: 0,
      hitIds: [],
      ttlMs: 4000,
      effectsOnHit: [],
      dead: false,
      data: {
        chainsLeft: 3,
        chainCount: 3,
        baseDamage: 10,
        falloff: 0.8,
        chainRange: 150,
        chainLightning: 1,
        zapRadius: 90,
        zapDamage: 4,
      },
    };

    proj.hitIds.push(e1.id);
    dealDamage(state, e1, proj.damage);
    behavior.onProjectileHit!(state, proj, e1);

    // 1. 伤害结算验证（e1 直击 10，z1 受 zap 伤害 4）
    expect(e1.hp).toBeCloseTo(90, 6);
    expect(z1.hp).toBeCloseTo(50 - 4, 6);

    // 2. meta[PRISM_ZAP_VFX_KEY] 坐标记录与过期清理验证
    const vfxList = state.meta[PRISM_ZAP_VFX_KEY] as PrismZapSegment[];
    expect(Array.isArray(vfxList)).toBe(true);
    // 旧的 untilMs=50 条目已被过滤淘汰
    expect(vfxList.some((seg) => seg.untilMs === 50)).toBe(false);
    // 包含新记录的 z1 zap 段：起点 e1、终点 z1、untilMs = timeMs + 100
    const seg = vfxList.find((s) => s.x1 === e1.x && s.y1 === e1.y && s.x2 === z1.x && s.y2 === z1.y);
    expect(seg).toBeDefined();
    expect(seg!.untilMs).toBe(100 + 100);

    // 3. sfx: hit 事件触发验证
    const hitEvents = state.events.filter((ev) => ev.kind === 'sfx' && ev.name === 'hit');
    expect(hitEvents.length).toBeGreaterThanOrEqual(1);

    // 4. 过期清理再次验证：推进时间至现有条目过期（> 200），再次触发 zap 确认旧条目被清理
    state.timeMs = 300;
    const z2 = makeEnemy(state, 360, 1050, 50);
    behavior.onProjectileHit!(state, proj, e1);
    const afterList = state.meta[PRISM_ZAP_VFX_KEY] as PrismZapSegment[];
    expect(afterList.every((s) => s.untilMs > 300)).toBe(true);
    expect(afterList.some((s) => s.x2 === z2.x && s.y2 === z2.y)).toBe(true);
    expect(afterList.some((s) => s.untilMs === 200)).toBe(false);
  });

  it('连锁闪电方案 A 增强：动态伤害随面板成长、受范围强化放大、连携传导冰毒', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 360, 1120, 1000); // 首跳目标
    const e2 = makeEnemy(state, 400, 1120, 1000); // 距 e1 40px：在 e1 zap 范围内(挨 6.5)，随后吃 hop2 直击(10.4)
    const e3 = makeEnemy(state, 440, 1120, 1000); // 距 e2 40px：hop3 直击(8.32)
    // z1 距 e1 95px（基础 90px 不及，但拿了 1 张 range_up 后 zapRadius=108px，可波及；距 e1 远于 e2 故不吃直击）
    const z1 = makeEnemy(state, 360, 1025, 1000);

    // 拿伤害强化 (damage 10*1.3=13) + 范围强化 (zapRadius 90*1.2=108) + 连锁闪电 + 冰毒附着
    fireWithCards(state, ['dmg_up', 'range_up', 'chain_lightning', 'frost_venom']);
    simulate(state, 120);

    // 1. 直击与弹跳正常推进：首跳 13、次跳 10.4 (+ e1 的 zap 6.5)、三跳 8.32 (+ e1、e2 的 zap 各 6.5)
    expect(e1.hp).toBeCloseTo(1000 - 13, 6);
    expect(e2.hp).toBeCloseTo(1000 - 10.4 - 6.5, 6);
    expect(e3.hp).toBeCloseTo(1000 - 8.32 - 13, 6);



    // 2. 动态伤害：基伤 13，zap 伤害为 13 × 0.5 = 6.5（仅受 zap，未受直击）
    expect(z1.hp).toBeCloseTo(1000 - 6.5, 6);

    // 3. 冰毒传导：z1 作为闪电受击者，同步挂上 chill 与 poison
    expect(hasEffect(z1, 'chill')).toBe(true);
    expect(hasEffect(z1, 'poison')).toBe(true);
  });
});

describe('冰/毒附着（frost_venom 牌）', () => {
  it('端到端：命中幸存者同时挂 chill+poison 实例（随效果表时长）、致死一击不附着；毒真实跳 DoT', () => {
    const state = createSimState(1);
    const doomed = makeEnemy(state, 360, 1150, 5); // 距角色更近：首跳直击即死（10 ≥ 5）
    const tank = makeEnemy(state, 360, 1120, 10000); // 续跳目标：幸存 → 附着
    fireWithCards(state, ['frost_venom']);

    simulate(state, 120);

    expect(doomed.dead).toBe(true);
    expect(doomed.effects).toHaveLength(0); // 致死一击不附着（尸体无意义，与框架同款约定）
    expect(tank.dead).toBe(false);
    // 仅冰毒牌（无连锁闪电）：hop1 直击 doomed（致死），hop2 续跳直击 tank（8）。
    expect(tank.hp).toBeCloseTo(10000 - 8, 6);
    // 效果槽同时出现 chill 与 poison 两个实例（chill 先挂）。
    expect(tank.effects.map((x) => x.kind)).toEqual(['chill', 'poison']);
    expect(tank.effects[0].stacks).toBe(1);
    expect(tank.effects[1].stacks).toBe(1);
    expect(tank.effects[0].untilMs).toBeGreaterThan(state.timeMs); // 随效果表 durationMs 武装
    expect(tank.effects[1].untilMs).toBeGreaterThan(state.timeMs);
    // poison（1000ms tick / 每跳每层 25% 武器面板伤害 = 10 * 0.25 = 2.5）真实结算一跳。
    state.timeMs += 1000;
    updateEffects(state, 1000);
    expect(tank.hp).toBeCloseTo(10000 - 8 - 2.5, 6);
  });

  it('直调钩子（timeMs=0）：幸存者 untilMs = 效果表 durationMs；死者不挂；下一跳伤害已递减', () => {
    const state = createSimState(1); // timeMs = 0
    const alive = makeEnemy(state, 360, 1120, 10000);
    const dead = makeEnemy(state, 400, 1120, 5);
    dead.dead = true;

    const proj = spawnProjectile(state, {
      behavior: 'prism_chain',
      x: 360,
      y: 1130,
      vx: 0,
      vy: -800,
      damage: 10,
      pierceLeft: 999,
      ttlMs: 4000,
      data: prismData({ frostVenom: 1 }),
    });
    proj.hitIds.push(alive.id); // 模拟框架：直击结算后（push 完成）才调钩子
    behavior.onProjectileHit!(state, proj, alive);

    expect(alive.effects.map((x) => x.kind)).toEqual(['chill', 'poison']);
    expect(alive.effects[0].untilMs).toBe(2500); // chill durationMs（effects.json）
    expect(alive.effects[1].untilMs).toBe(5000); // poison durationMs
    expect(proj.damage).toBeCloseTo(10 * 0.8, 9); // 第 1 跳后为下一跳重写 8
    expect(proj.dead).toBe(true); // 链及范围内无新目标（alive 已在 hitIds）→ 弹亡

    const proj2 = spawnProjectile(state, {
      behavior: 'prism_chain',
      x: 400,
      y: 1130,
      vx: 0,
      vy: -800,
      damage: 10,
      pierceLeft: 999,
      ttlMs: 4000,
      data: prismData({ frostVenom: 1 }),
    });
    proj2.hitIds.push(dead.id);
    behavior.onProjectileHit!(state, proj2, dead);
    expect(dead.effects).toHaveLength(0); // 致死一击不附着
  });
});

describe('聚能折返（focus_return 牌）', () => {
  it('直调钩子与属性契约：宽体光梭属性（radius=16、pierce=999、ttl=1500、hitIds清空、竖直向下、returning=1）', () => {
    const state = createSimState(1); // 角色 (360, 1220)
    const e = makeEnemy(state, 360, 1120, 10000);
    const proj = spawnProjectile(state, {
      behavior: 'prism_chain',
      x: 500,
      y: 800,
      vx: 0,
      vy: -800,
      damage: 6.4,
      pierceLeft: 999,
      ttlMs: 4000,
      data: prismData({ chainsLeft: 1, focusReturn: 1 }), // 第 3 跳后 chainsLeft 恰为 0
    });
    proj.hitIds.push(1001, 1002, e.id); // 模拟框架已直击 3 次

    behavior.onProjectileHit!(state, proj, e);

    expect(proj.dead).toBe(true); // 原弹走死亡路径
    expect(state.projectiles).toHaveLength(2);
    const beam = state.projectiles[1];
    expect(beam.behavior).toBe('prism_chain');
    expect(beam.x).toBe(500); // 死亡点出生
    expect(beam.y).toBe(800);
    expect(beam.vx).toBe(0); // 竖直向下发射、速度大小不变
    expect(beam.vy).toBeCloseTo(800, 9);
    expect(Math.hypot(beam.vx, beam.vy)).toBeCloseTo(800, 9);
    expect(beam.radius).toBe(16); // 宽体贯穿光梭
    expect(beam.pierceLeft).toBe(999);
    expect(beam.ttlMs).toBe(1500);
    expect(beam.hitIds).toEqual([]); // 清空：可贯穿扫过敌人
    expect(beam.data.returning).toBe(1);
    expect(beam.data.focusReturn).toBe(0);
    expect(beam.data.prismRecurse).toBe(0);
  });

  it('伤害公式：命中 1 次为 1.25 倍基础伤害，命中 3 次为 1.75 倍（baseDamage × (1 + 0.25 × N)）', () => {
    // 命中 1 次: N=1 -> 10 * 1.25 = 12.5
    const state1 = createSimState(1);
    const e1 = makeEnemy(state1, 360, 1120, 10000);
    const proj1 = spawnProjectile(state1, {
      behavior: 'prism_chain',
      x: 360,
      y: 1120,
      vx: 0,
      vy: -800,
      damage: 10,
      pierceLeft: 999,
      ttlMs: 4000,
      data: prismData({ chainsLeft: 0, focusReturn: 1 }),
    });
    proj1.hitIds.push(e1.id);
    behavior.onProjectileHit!(state1, proj1, e1);
    expect(state1.projectiles).toHaveLength(2);
    expect(state1.projectiles[1].damage).toBeCloseTo(10 * 1.25, 9);

    // 命中 3 次: N=3 -> 10 * 1.75 = 17.5
    const state3 = createSimState(1);
    const e3 = makeEnemy(state3, 360, 880, 10000);
    const proj3 = spawnProjectile(state3, {
      behavior: 'prism_chain',
      x: 360,
      y: 880,
      vx: 0,
      vy: -800,
      damage: 6.4,
      pierceLeft: 999,
      ttlMs: 4000,
      data: prismData({ chainsLeft: 1, focusReturn: 1 }),
    });
    proj3.hitIds.push(101, 102, e3.id);
    behavior.onProjectileHit!(state3, proj3, e3);
    expect(state3.projectiles).toHaveLength(2);
    expect(state3.projectiles[1].damage).toBeCloseTo(10 * 1.75, 9);
  });

  it('重点测试：怪群不足导致提前终止（如只有 1 个怪，打单体 Boss/孤立怪）时，也能稳定生成折返弹（验证修复截断漏洞）', () => {
    const state = createSimState(1); // 角色 (360, 1220)
    const boss = makeEnemy(state, 360, 1120, 100000); // 孤立 Boss，周围无任何其他怪
    const nextIdAfterSetup = state.nextId;

    fireWithCards(state, ['focus_return']); // 初始 chainsLeft=3
    // 主弹发射并命中 boss
    simulate(state, 120);

    // 截断漏洞修复验证：主弹命中 1 次后虽然 chainsLeft 仍大于 0，但因无后续目标弹跳提前终止，依然成功生成折返弹！
    // 弹丸总数自增：主弹 1 枚 + 折返弹 1 枚 = 2 枚
    expect(state.nextId - nextIdAfterSetup).toBe(2);
    // 折返光梭从 boss 命中点 (360, 1120) 飞向角色 (360, 1220)，因 hitIds 清空且贯穿，再扫 boss 一次：
    // 首跳 10 伤，折返光梭 10 * (1 + 0.25 * 1) = 12.5 伤，boss 总扣血 22.5
    expect(boss.hp).toBeCloseTo(100000 - 10 - 12.5, 6);
  });

  it('端到端：弹跳耗尽触发折返并在折返路上以宽体贯穿扫过敌人', () => {
    // 3 个敌人纵列排布，刚好弹完 3 跳耗尽次数触发折返
    const state = createSimState(1);
    const e1 = makeEnemy(state, 360, 1120, 10000);
    const e2 = makeEnemy(state, 360, 1000, 10000);
    const e3 = makeEnemy(state, 360, 880, 10000);
    const nextIdAfterSetup = state.nextId;

    fireWithCards(state, ['focus_return']);
    simulate(state, 200);

    expect(state.projectiles).toHaveLength(0); // 折返光梭飞过角色后超时销毁
    // 3 跳直击：10, 8, 6.4；折返光梭伤害 10 * (1 + 0.25 * 3) = 17.5 从 e3 折返飞向角色，沿途贯穿 e2、e1
    expect(e3.hp).toBeCloseTo(10000 - 6.4 - 17.5, 6);
    expect(e2.hp).toBeCloseTo(10000 - 8 - 17.5, 6);
    expect(e1.hp).toBeCloseTo(10000 - 10 - 17.5, 6);
    expect(state.nextId - nextIdAfterSetup).toBe(2); // 主弹 1 枚 + 折返光梭 1 枚
  });

  it('次数用尽且无折返牌不产折返弹；折返弹被 returning 拦截后走框架死亡路径（无二次折返）', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1120, 100000);
    makeEnemy(state, 360, 1000, 100000);
    makeEnemy(state, 360, 880, 100000);
    const nextIdAfterSetup = state.nextId;
    fireWithCards(state);
    simulate(state, 300);
    expect(state.projectiles).toHaveLength(0);
    expect(state.nextId - nextIdAfterSetup).toBe(1); // 仅主弹：无折返
  });
});

describe('聚能超载（focus_overload 牌）', () => {
  it('持有 focus_return + focus_overload：弹跳终结时发射 2 道平行贯穿光梭，横向偏移 ±16px 且附带 0.6s 眩晕', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1120, 10000);
    const bystanderLeft = makeEnemy(state, 344, 1180, 10000); // 恰在 -16px 光梭路线上
    const bystanderRight = makeEnemy(state, 376, 1180, 10000); // 恰在 +16px 光梭路线上
    const nextIdAfterSetup = state.nextId;

    fireWithCards(state, ['focus_return', 'focus_overload']);
    // 主弹直击 target (360, 1120) 后周围无新敌人，弹跳终止触发聚能折返
    simulate(state, 200);

    expect(state.projectiles).toHaveLength(0);
    // 产弹：主弹 1 枚 + 终结双光梭 2 枚 = 3
    expect(state.nextId - nextIdAfterSetup).toBe(3);

    // 检查旁观者是否受到光梭附带的眩晕效果
    expect(bystanderLeft.effects.some((eff) => eff.kind === 'stun')).toBe(true);
    expect(bystanderRight.effects.some((eff) => eff.kind === 'stun')).toBe(true);
  });

  it('未持有 focus_overload（仅持有 focus_return）：仅发射 1 道中心光梭且无眩晕', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1120, 10000);
    const nextIdAfterSetup = state.nextId;

    fireWithCards(state, ['focus_return']);
    simulate(state, 200);

    expect(state.projectiles).toHaveLength(0);
    expect(state.nextId - nextIdAfterSetup).toBe(2); // 主弹 1 + 单光梭 1
  });

  it('未持有 focus_return 时（即使单独持有 focus_overload）：不发射任何折返光梭', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1120, 10000);
    const nextIdAfterSetup = state.nextId;

    fireWithCards(state, ['focus_overload']);
    simulate(state, 200);

    expect(state.projectiles).toHaveLength(0);
    expect(state.nextId - nextIdAfterSetup).toBe(1); // 仅主弹 1 枚，无折返光梭
  });
});

describe('数值全部来自 weapons/prism.json（真实表驱动，T5.3a 牌池制）', () => {
  const def = loadWeaponDefs().prism;

  it('表身份：id/name/behavior/maxLevel=10，behavior 已自动发现注册', () => {
    expect(def.id).toBe('prism');
    expect(def.name).toBe('弹射棱镜');
    expect(def.behavior).toBe('prism_chain');
    expect(def.maxLevel).toBe(10);
    expect(getBehavior('prism_chain')).toBe(behavior); // import.meta.glob 自动注册
  });

  it('牌目录：专属牌在前（bounce_up/chain_lightning/frost_venom/focus_return/focus_overload/link_stable），通用牌合并追加', () => {
    expect(def.cards.slice(0, 6).map((c) => c.id)).toEqual([
      'bounce_up', 'chain_lightning', 'frost_venom', 'focus_return', 'focus_overload', 'link_stable',
    ]);
    const ids = def.cards.map((c) => c.id);
    for (const genericId of ['dmg_up', 'spd_up', 'multi_shot', 'burst_shot', 'split_shot', 'range_up', 'dot_freq']) {
      expect(ids).toContain(genericId);
    }
    const dot = def.cards.find((c) => c.id === 'dot_freq')!;
    expect(dot.requiresCard).toBe('frost_venom'); // dot频率前置：冰毒附着
    const overload = def.cards.find((c) => c.id === 'focus_overload')!;
    expect(overload.requiresCard).toBe('focus_return'); // 聚能超载前置：聚能折返
    expect(def.rangeKeys).toEqual(['chainRange', 'zapRadius']); // 范围强化乘弹跳距离与闪电半径
  });

  it('base 数值随表；弹跳次数/递减系数/范围随牌叠加（改 json 即变）', () => {
    expect(def.base).toMatchObject({
      damage: 10, intervalMs: 1200, projectileSpeed: 800, pierce: 999, ttlMs: 4000,
      chainCount: 3, chainRange: 150, falloff: 0.8, zapRadius: 90, zapRatio: 0.5,
    });

    const run = (cards: string[]) => {
      const state = createSimState(1);
      makeEnemy(state, 360, 700);
      const stats = fireWithCards(state, cards);
      expect(state.projectiles).toHaveLength(1);
      return { p: state.projectiles[0], stats };
    };
    // 直接断言牌组 stats（复用 fireWithCards 的状态构造）。
    const statsOf = (cards: string[]): WeaponStats => {
      const s = createSimState(1);
      makeEnemy(s, 360, 700);
      return fireWithCards(s, cards);
    };
    const p1 = run([]).p;
    expect(p1.damage).toBe(10);
    expect(p1.pierceLeft).toBe(999); // 表值大值：寿命由 chainsLeft 控制
    expect(p1.ttlMs).toBe(4000);
    expect(Math.hypot(p1.vx, p1.vy)).toBeCloseTo(800, 9);
    expect(p1.radius).toBe(6);
    expect(p1.data).toMatchObject({
      chainsLeft: 3, chainCount: 3, baseDamage: 10, falloff: 0.8, chainRange: 150,
      chainLightning: 0, zapRadius: 90, zapRatio: 0.5, focusReturn: 0, focusOverload: 0, frostVenom: 0,
    });

    expect(statsOf(['bounce_up', 'bounce_up']).chainCount).toBe(5); // 弹跳+1 ×2
    const pMax = statsOf([
      'bounce_up', 'bounce_up', 'bounce_up',
      'link_stable', 'link_stable', 'link_stable',
      'chain_lightning', 'frost_venom', 'focus_return', 'focus_overload', 'range_up',
    ]);
    expect(pMax.chainCount).toBe(6); // 3 + 3（弹跳+1）
    expect(pMax.falloff).toBeCloseTo(0.95, 9); // 0.8 + 0.05×3
    expect(pMax.chainLightning).toBe(1);
    expect(pMax.frostVenom).toBe(1);
    expect(pMax.focusReturn).toBe(1);
    expect(pMax.focusOverload).toBe(1);
    expect(pMax.chainRange).toBeCloseTo(180, 9); // 150 × 1.2（范围强化乘弹跳距离）
    expect(pMax.zapRadius).toBeCloseTo(108, 9); // 90 × 1.2（范围强化乘闪电半径）
  });

  it('alt def（不同数值）驱动同一行为', () => {
    const altDef = {
      id: 'alt_prism',
      name: '替换棱镜',
      behavior: 'prism_chain',
      maxLevel: 10,
      base: {
        damage: 30, intervalMs: 900, projectileSpeed: 600, pierce: 5, ttlMs: 2500,
        chainCount: 2, chainRange: 200, falloff: 0.5, zapRadius: 60, zapDamage: 9,
      },
      rangeKeys: [],
      cards: [],
    };
    const alt = createSimState(1);
    makeEnemy(alt, 400, 800);
    alt.weaponStates.alt_prism = { level: 0, cooldownMs: 0, cards: {} };
    behavior.fire(alt, 'alt_prism', getWeaponStats(altDef, alt, 'alt_prism'));
    expect(alt.projectiles).toHaveLength(1);
    const p = alt.projectiles[0];
    expect(p.damage).toBe(30);
    expect(p.pierceLeft).toBe(5);
    expect(p.ttlMs).toBe(2500);
    expect(Math.hypot(p.vx, p.vy)).toBeCloseTo(600, 9);
    expect(p.data).toMatchObject({
      chainsLeft: 2, chainCount: 2, baseDamage: 30, falloff: 0.5, chainRange: 200,
      zapRadius: 60, zapDamage: 9, chainLightning: 0, focusReturn: 0, focusOverload: 0, frostVenom: 0,
    });
  });

  it('解释器集成：无敌人不开火且冷却归 0（重试）、有敌人按 intervalMs 节奏开火并直击', () => {
    // 无目标：fire 归 0 → 解释器 += intervalMs（1200）→ 下帧重试，零产弹。
    const noTarget = createSimState(1);
    addWeapon(noTarget, 'prism');
    noTarget.weaponStates.prism.cooldownMs = 500;
    behavior.fire(noTarget, 'prism', getWeaponStats(def, noTarget, 'prism'));
    expect(noTarget.projectiles).toHaveLength(0);
    expect(noTarget.weaponStates.prism.cooldownMs).toBe(0);
    updateWeapons(noTarget, 16, { prism: def });
    expect(noTarget.weaponStates.prism.cooldownMs).toBe(1200);
    expect(noTarget.projectiles).toHaveLength(0);

    // 有目标：第 1 帧开火 1 枚，直击最近敌人后链及范围内无新目标弹亡；960ms 内不二次开火。
    const state = createSimState(1);
    const tank = makeEnemy(state, 360, 700, 100000);
    addWeapon(state, 'prism');
    const grid = new SpatialHash<Enemy>(64);
    updateWeapons(state, 16, { prism: def });
    expect(state.projectiles).toHaveLength(1);
    expect(state.weaponStates.prism.cooldownMs).toBe(1200 - 16);
    for (let f = 0; f < 59; f++) {
      updateWeapons(state, 16, { prism: def });
      updateProjectiles(state, 16, grid);
      state.timeMs += 16;
    }
    expect(tank.hp).toBeCloseTo(100000 - 10, 6); // 恰 1 跳直击
    expect(state.projectiles).toHaveLength(0);
    expect(state.weaponStates.prism.cooldownMs).toBe(1200 - 60 * 16); // 尚未到第二次开火
  });
});

describe('可复现（行为零随机：不读 rng，任意种子同结果）', () => {
  /** 固定场景：弹跳×2+冰毒+折返+超载（chainCount=5）打满 300 帧的全量结果快照。 */
  function scenario(seed: number): { hp: number[]; nextId: number; leftover: number } {
    const state = createSimState(seed);
    makeEnemy(state, 360, 1120);
    makeEnemy(state, 360, 1000);
    makeEnemy(state, 360, 880);
    makeEnemy(state, 360, 760);
    makeEnemy(state, 360, 640); // 5 连跳恰用尽次数 → 触发折返
    makeEnemy(state, 700, 300); // 远处旁观者：链与折返均不及
    fireWithCards(state, ['bounce_up', 'bounce_up', 'frost_venom', 'focus_return', 'focus_overload']);
    simulate(state, 300);
    return { hp: state.enemies.map((e) => e.hp), nextId: state.nextId, leftover: state.projectiles.length };
  }

  it('同种子两次全流程一致；异种子也一致（确定性映射，全程不消耗 rng）', () => {
    expect(scenario(42)).toEqual(scenario(42));
    expect(scenario(42)).toEqual(scenario(7));
  });
});

// —— T5.3b 弹道机制接线：多射错角 / 连射 / 分裂单体次级弹 / dot 频率 ——

describe('多射（multi_shot 牌：主轴保底 0° + 侧翼 6° 交替展开）', () => {
  it('1 张多射发 2 条链弹（第 0 发 -90°，第 1 发 -84°）、各自独立弹跳链；无牌恒 1 条', () => {
    const two = createSimState(1);
    makeEnemy(two, 360, 1100, 1e6); // 静止主目标正上：主方向 -90°
    fireWithCards(two, ['multi_shot']);
    expect(two.projectiles).toHaveLength(2);
    const ang0 = (Math.atan2(two.projectiles[0].vy, two.projectiles[0].vx) * 180) / Math.PI;
    const ang1 = (Math.atan2(two.projectiles[1].vy, two.projectiles[1].vx) * 180) / Math.PI;
    expect(ang0).toBeCloseTo(-90, 6);
    expect(ang1).toBeCloseTo(-84, 6);
    for (const p of two.projectiles) {
      expect(p.damage).toBe(10);
      expect(p.data.chainsLeft).toBe(3); // 各自独立整条弹跳链
    }

    const one = createSimState(1);
    makeEnemy(one, 360, 1100, 1e6);
    fireWithCards(one);
    expect(one.projectiles).toHaveLength(1);
  });
});

describe('连射（burst_shot 牌：待发波队列重放——重新选目标）', () => {
  it('1 张连射：首波 1 条；150ms 后 update 重放（旧目标已死 → 打新最近）', () => {
    const state = createSimState(1);
    const a = makeEnemy(state, 360, 1100, 1e6); // 最近
    const b = makeEnemy(state, 460, 1100, 1e6); // 次近
    fireWithCards(state, ['burst_shot']);
    expect(state.projectiles).toHaveLength(1);

    a.dead = true;
    state.timeMs += 150;
    behavior.update!(state, 16);
    expect(state.projectiles).toHaveLength(2);
    // 重放正对新最近者 b（静止 → leadAim 退化为直接瞄准 (460,1100)）
    const expected = scale(normalize({ x: b.x - 360, y: b.y - 1220 }), 800);
    expect(state.projectiles[1].vx).toBeCloseTo(expected.x, 6);
    expect(state.projectiles[1].vy).toBeCloseTo(expected.y, 6);
  });
});

describe('分裂（split_shot 牌：主弹首命中分裂次级单体棱镜弹）', () => {
  it('命中点分裂 4 枚：伤害 = 10×0.2 = 2、chainsLeft 0（命中一次即亡）、锁定 4 个不同目标、不再分裂', () => {
    const state = createSimState(1);
    const main = makeEnemy(state, 360, 1100, 1e6); // 距角色 120：开火目标
    const s1 = makeEnemy(state, 360, 1040, 1e6); // 距命中点 60
    const s2 = makeEnemy(state, 400, 1060, 1e6); // 距命中点 44.7（并列先入数组）
    const s3 = makeEnemy(state, 320, 1060, 1e6); // 距命中点 44.7（并列后入数组）
    const s4 = makeEnemy(state, 410, 1100, 1e6); // 距命中点 50
    fireWithCards(state, ['split_shot']);
    const p = state.projectiles[0];
    p.x = 360;
    p.y = 1100;
    behavior.onProjectileHit!(state, p, main);

    const secondaries = state.projectiles.slice(1);
    expect(secondaries).toHaveLength(4);
    for (const sec of secondaries) {
      expect(sec.damage).toBeCloseTo(2, 9); // 10 × 0.2
      expect(sec.data.chainsLeft).toBe(0); // 简化单体：命中一次即亡（不弹跳/不回旋）
      expect(sec.data.splitReady).toBe(0); // 封死再分裂
      expect(sec.data.splitDone).toBe(1);
      expect(sec.hitIds).toEqual([main.id]); // 预置主弹命中目标
      expect(sec.pierceLeft).toBe(1);
    }
    // 方向 → 目标一一对应（排除刚命中的 main；s2/s3 并列取数组序）
    const targets = [s2, s3, s4, s1];
    const matched = new Set<number>();
    for (const sec of secondaries) {
      const dir = normalize({ x: sec.vx, y: sec.vy });
      const hit = targets.find((t) => {
        const to = normalize({ x: t.x - 360, y: t.y - 1100 });
        return Math.abs(to.x - dir.x) < 1e-9 && Math.abs(to.y - dir.y) < 1e-9;
      });
      expect(hit).toBeDefined();
      expect(matched.has(hit!.id)).toBe(false);
      matched.add(hit!.id);
    }
    expect(p.data.chainsLeft).toBe(2); // 主弹照常继续弹跳链（分裂不消耗弹跳次数）
  });

  it('候选不足 → 有几个锁几个；无候选（仅主目标）→ 不产次级弹', () => {
    const state = createSimState(1);
    const main = makeEnemy(state, 360, 1100, 1e6);
    const other = makeEnemy(state, 360, 1040, 1e6);
    fireWithCards(state, ['split_shot']);
    const p = state.projectiles[0];
    p.x = 360;
    p.y = 1100;
    behavior.onProjectileHit!(state, p, main);
    const secondaries = state.projectiles.filter((q) => q !== p);
    expect(secondaries).toHaveLength(1); // 锁 other
    const dir = normalize({ x: secondaries[0].vx, y: secondaries[0].vy });
    const to = normalize({ x: other.x - 360, y: other.y - 1100 });
    expect(dir.x).toBeCloseTo(to.x, 9);
    expect(dir.y).toBeCloseTo(to.y, 9);

    const only = createSimState(1);
    const target = makeEnemy(only, 360, 1100, 1e6);
    fireWithCards(only, ['split_shot']);
    const q = only.projectiles[0];
    q.x = 360;
    q.y = 1100;
    behavior.onProjectileHit!(only, q, target);
    expect(only.projectiles.filter((x) => x !== q)).toHaveLength(0); // 排除后无候选
  });
});

describe('dot 频率（dot_freq 牌，requiresCard=frost_venom：中毒 tick 间隔 ÷1.3）', () => {
  it('弹上 poisonTickMs = 1000/1.3；冰毒附着的 poison 实例按覆盖节奏跳 DoT（chill 无 tick）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1100, 1e6);
    fireWithCards(state, ['frost_venom', 'dot_freq']);
    expect(state.projectiles[0].data.poisonTickMs).toBeCloseTo(1000 / 1.3, 9);

    simulate(state, 30); // 首跳命中（800px/s × 120px ≈ 150ms）
    expect(e.hp).toBeCloseTo(1e6 - 10, 6); // 直击
    const kinds = e.effects.map((x) => x.kind);
    expect(kinds).toContain('chill');
    expect(kinds).toContain('poison');
    const poison = e.effects.find((x) => x.kind === 'poison')!;
    expect(poison.data.tickMs).toBeCloseTo(1000 / 1.3, 9); // dot 频率覆盖
    expect('tickMs' in e.effects.find((x) => x.kind === 'chill')!.data).toBe(false); // chill 无 tick

    // 首跳时序：769.2ms 才跳（单跳 25% 武器面板伤害 = 10 * 0.25 = 2.5）
    state.timeMs += 500;
    updateEffects(state, 500);
    expect(e.hp).toBeCloseTo(1e6 - 10, 6); // 500 < 769.2：无跳
    state.timeMs += 269.3;
    updateEffects(state, 269.3);
    expect(e.hp).toBeCloseTo(1e6 - 10 - 2.5, 6); // 累计 769.3 ≥ 769.2：首跳
  });
});
