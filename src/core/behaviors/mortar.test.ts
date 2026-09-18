// src/core/behaviors/mortar.test.ts —— 迫击榴弹行为契约（T5.3a 牌池制更新）：
// 密度最高点选点（并列取数组序靠前、无敌不开火冷却归 0）、落点提前量（T5.2a：落点 =
// 密度锚点 + 锚点速度 × 飞行时长，attack/slow/钳制各退化路径）、noCollide 越过前排 +
// 落点 AoE（圆相交边界、尸体不结算）、燃烧地（zone 参数随表、逐 tick 伤害 + 挂 burn、
// 到期移除、burn 槽真实跳 DoT）、眩晕 / 黑洞（效果槽实例 + 黑洞朝落点拉拽位移）、
// 集束已随牌池制删除（stats.cluster 无牌可点亮，路径永不再触发）、
// 数值全部来自 weapons/mortar.json 真实表（等级语义改为牌组）、解释器集成、同种子可复现。
import { describe, expect, it } from 'vitest';
import { loadEffectDefs } from '../../data/effects';
import { loadWeaponDefs } from '../../data/weapons';
import { hasEffect, isStunned, updateEffects } from '../effects';
import { spawnProjectile, updateProjectiles } from '../projectiles';
import { createSimState } from '../simState';
import { SpatialHash } from '../spatialHash';
import type { Enemy, SimState } from '../types';
import { addWeapon, getWeaponStats, updateWeapons } from '../weapons';
import type { WeaponStats } from '../weapons';
import { behavior } from './behavior_mortar';
import './index'; // 副作用：自动发现注册
import { getBehavior } from './registry';
import { listZones, updateZones } from '../zones';

// 副作用：把 effects.json 真实效果表注册进 core/effects（burn/stun/blackhole 槽依赖）。
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

/** 把全部存活敌人插入新网格（模拟生产管线 updateEnemies/updateProjectiles 的网格重建）。 */
function fillGrid(state: SimState): SpatialHash<Enemy> {
  const grid = new SpatialHash<Enemy>(64);
  for (let i = 0; i < state.enemies.length; i++) {
    const e = state.enemies[i];
    if (!e.dead) {
      grid.insert(e, e.x, e.y, e.radius);
    }
  }
  return grid;
}

/**
 * 模拟若干帧弹丸推进（迫击榴弹无 update 钩子：core 直线位移到落点），
 * 弹丸清空即提前收束。每帧推进 state.timeMs（行为网格按 (state, timeMs) 重建）。
 */
function simulate(state: SimState, frames: number, dt = 16): void {
  const grid = new SpatialHash<Enemy>(64);
  for (let f = 0; f < frames && state.projectiles.length > 0; f++) {
    updateProjectiles(state, dt, grid);
    state.timeMs += dt;
  }
}

/** 以真实数据表 mortar.json 的指定牌组开火一次（需先放好目标敌人）。 */
function fireWithCards(state: SimState, cards: string[] = []): WeaponStats {
  const def = loadWeaponDefs().mortar;
  if (!state.weaponStates.mortar) {
    state.weaponStates.mortar = { level: 0, cooldownMs: 0, cards: {} };
  }
  const ws = state.weaponStates.mortar;
  ws.cards = {};
  for (const cardId of cards) {
    ws.cards[cardId] = (ws.cards[cardId] ?? 0) + 1;
  }
  ws.level = cards.length;
  const stats = getWeaponStats(def, state, 'mortar');
  behavior.fire(state, 'mortar', stats);
  return stats;
}

/** 直调死亡钩子用的落地弹夹具（data 与真实表无牌 fire 快照同构，开关可覆盖）。 */
function makeShell(
  state: SimState,
  x: number,
  y: number,
  damage: number,
  dataOverrides?: Record<string, number>,
): ReturnType<typeof spawnProjectile> {
  return spawnProjectile(state, {
    behavior: 'mortar',
    x,
    y,
    vx: 0,
    vy: 0,
    radius: 6,
    damage,
    pierceLeft: 0,
    ttlMs: 900,
    effectsOnHit: [],
    data: {
      noCollide: 1,
      tx: x,
      ty: y,
      aoeRadius: 90,
      splashFactor: 1,
      burnGround: 0,
      stunBlast: 0,
      blackHole: 0,
      splitReady: 0,
      burnRadiusFactor: 0.8,
      burnDurationMs: 3000,
      burnTickMs: 500,
      burnDamagePerTick: 3,
      pullPerSec: 300,
      ...dataOverrides,
    },
  });
}

describe('落点选取（怪密度最高处）', () => {
  it('3 敌聚 A 区、1 敌在 B 区 → 落点在 A（tx/ty = A 区数组序靠前者）；弹从角色出发、速度 = 距离/飞行时长', () => {
    const state = createSimState(1); // 角色 (360, 1220)
    const a1 = makeEnemy(state, 360, 500); // A 区锚点（数组序最先）
    makeEnemy(state, 380, 510);
    makeEnemy(state, 340, 520);
    makeEnemy(state, 650, 400); // B 区孤狼
    const stats = fireWithCards(state);

    expect(state.projectiles).toHaveLength(1);
    const p = state.projectiles[0];
    expect(p.behavior).toBe('mortar');
    expect(p.x).toBe(360);
    expect(p.y).toBe(1220); // 从角色位置发射
    expect(p.data.tx).toBe(a1.x); // 落点 = 密度最高的 A 区（并列取数组序靠前）
    expect(p.data.ty).toBe(a1.y);
    expect(p.data.noCollide).toBe(1); // 越过前排直通旗标
    expect(p.data.splitReady).toBe(0); // 未拿分裂牌：非分裂母弹
    expect(p.data.splashFactor).toBe(1); // 落地全额伤害
    expect(p.damage).toBe(stats.damage);
    expect(p.ttlMs).toBe(stats.flightMs); // 飞行时间制：ttl = flightMs
    // 速度 = (落点 - 角色) / flightSec：dist 720px / 0.9s = 800px/s，方向正上。
    expect(p.vy).toBeCloseTo((500 - 1220) / 0.9, 6);
    expect(p.vx).toBeCloseTo(0, 6);
    expect(Math.hypot(p.vx, p.vy)).toBeCloseTo(720 / 0.9, 6);
  });

  it('两个等密度簇 → 并列取数组序靠前（确定性裁决）', () => {
    const state = createSimState(1);
    makeEnemy(state, 200, 600); // 簇 1（先入数组）
    makeEnemy(state, 220, 600);
    makeEnemy(state, 500, 600); // 簇 2（后入数组，同密度）
    makeEnemy(state, 520, 600);
    fireWithCards(state);
    expect(state.projectiles[0].data.tx).toBe(200);
    expect(state.projectiles[0].data.ty).toBe(600);
  });

  it('无敌人在场：不开火且冷却归 0；经解释器后冷却推进一个 intervalMs（1800）', () => {
    const state = createSimState(1);
    addWeapon(state, 'mortar');
    state.weaponStates.mortar.cooldownMs = 500;
    behavior.fire(state, 'mortar', getWeaponStats(loadWeaponDefs().mortar, state, 'mortar'));
    expect(state.projectiles).toHaveLength(0);
    expect(state.weaponStates.mortar.cooldownMs).toBe(0);

    // 解释器路径：fire 归 0 → += intervalMs（1800）→ 下帧重试。
    updateWeapons(state, 16, { mortar: loadWeaponDefs().mortar });
    expect(state.weaponStates.mortar.cooldownMs).toBe(1800);
    expect(state.projectiles).toHaveLength(0);
  });
});

describe('落点提前量（T5.2a：怪群行军预测）', () => {
  it('march 怪群：落点 = 密度中心 + 锚点速度 × 飞行时长（flightMs 900 → 下移 90px）', () => {
    const state = createSimState(1); // 角色 (360, 1220)
    makeEnemy(state, 360, 500); // A 区锚点（数组序最先）
    makeEnemy(state, 380, 510);
    makeEnemy(state, 340, 520);
    for (const e of state.enemies) {
      e.speed = 100; // 整簇同速行军：锚点速度参与怪群到达点预测
    }
    fireWithCards(state); // flightMs 900

    const p = state.projectiles[0];
    expect(p.data.tx).toBe(360); // 行军速度纯竖直：tx 不变
    expect(p.data.ty).toBe(590); // 500 + 100 × 0.9：预测怪群到达点
    expect(p.vy).toBeCloseTo((590 - 1220) / 0.9, 6); // 速度 = (落点 - 角色) / flightSec
  });

  it('贴墙 attack 怪群：锚点速度 0 → 落点 = 当前位置（不越过墙线浪费落点）', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1160); // A 区锚点（数组序最先）
    makeEnemy(state, 380, 1160);
    for (const e of state.enemies) {
      e.state = 'attack'; // 已贴墙正在打墙：y 钉在墙线
      e.speed = 300;
    }
    fireWithCards(state);

    expect(state.projectiles[0].data.tx).toBe(360);
    expect(state.projectiles[0].data.ty).toBe(1160); // 不加行军位移（速度 0）
  });

  it('slow 减速计入提前量（speedFactor 0.5 → 下移 45px）；落点钳制在行军可达域（y ≤ 墙线）', () => {
    const state = createSimState(1);
    const a1 = makeEnemy(state, 360, 500);
    a1.speed = 100;
    a1.effects.push({ kind: 'slow', untilMs: Number.MAX_SAFE_INTEGER, stacks: 1, data: {} });
    fireWithCards(state);
    expect(state.projectiles[0].data.ty).toBe(545); // 500 + (100×0.5) × 0.9

    // 钳制：贴着场底的行军怪预测点（1450）越界 → 钳到墙线 1160（怪到墙即停，
    // 怪群永远到不了墙线以下——落点钉在墙线正好覆盖停靠/抵达的怪群）。
    const edge = createSimState(1);
    const lo = makeEnemy(edge, 360, 1270);
    lo.speed = 200;
    fireWithCards(edge);
    expect(edge.projectiles[0].data.ty).toBe(1160);
    expect(edge.projectiles[0].data.tx).toBe(360); // x 对称钳 [0, width]（行军速度纯竖直）
  });
});

describe('越过前排 + 落点 AoE（noCollide 直通）', () => {
  it('弹穿越前排敌人不结算命中；400ms 时恰位于前排位置仍未受伤；落地后半径内受伤、半径外不受伤', () => {
    const state = createSimState(1); // 角色 (360, 1220)
    const a1 = makeEnemy(state, 360, 500); // A 区目标（落点）
    const a2 = makeEnemy(state, 365, 505);
    const front = makeEnemy(state, 360, 900); // 前排：恰在角色→落点的飞行路径上
    const outer = makeEnemy(state, 700, 500); // 距落点 340：AoE 半径外
    const before = state.nextId;
    fireWithCards(state);

    // 飞行 400ms：位移 800px/s × 0.4s = 320px → 弹恰位于前排 (360, 900)，前排不掉血。
    simulate(state, 25);
    expect(state.projectiles).toHaveLength(1); // ttl 900-400=500：仍在途
    expect(state.projectiles[0].y).toBeCloseTo(900, 6);
    expect(front.hp).toBe(100); // noCollide：越过前排，不参与命中结算

    simulate(state, 100); // 到点落地爆炸
    expect(state.projectiles).toHaveLength(0); // 恰 1 枚母弹，无残留无分裂
    expect(state.nextId - before).toBe(1);
    expect(a1.hp).toBeCloseTo(100 - 18, 6); // 落点半径内：全额 18（splashFactor=1）
    expect(a2.hp).toBeCloseTo(100 - 18, 6); // 距爆心 ~7.07 ≤ 90+10（圆相交）
    expect(front.hp).toBe(100); // 距爆心 400：半径外且全程未被直击
    expect(outer.hp).toBe(100);
    expect(listZones(state)).toHaveLength(0); // 无燃烧地牌
  });

  it('AoE 边界（圆相交语义 dist ≤ aoe + enemy.radius）；尸体不结算；范围强化牌扩 AoE', () => {
    const state = createSimState(1);
    const inner = makeEnemy(state, 500, 895); // 距爆心 95 ≤ 90+10：受伤
    const edgeOut = makeEnemy(state, 500, 905); // 距 105 > 100：base 不受伤
    const far = makeEnemy(state, 500, 1100); // 距 300：不受伤
    const corpse = makeEnemy(state, 505, 805, 50);
    corpse.dead = true;

    const shell = makeShell(state, 500, 800, 18);
    shell.dead = true; // 对齐真实死亡路径
    behavior.onProjectileDeath!(state, shell);

    expect(inner.hp).toBeCloseTo(100 - 18, 6);
    expect(edgeOut.hp).toBe(100);
    expect(far.hp).toBe(100);
    expect(corpse.hp).toBe(50); // 尸体不入网格、不重复结算
    expect(listZones(state)).toHaveLength(0);

    // 范围强化牌：aoeRadius 90×1.2=108 → 距 105 的 edgeOut 也进圆（108+10）。
    const state2 = createSimState(1);
    const widened = makeEnemy(state2, 500, 905); // 距 105 ≤ 108+10
    const shell2 = makeShell(state2, 500, 800, 18, { aoeRadius: 108 });
    shell2.dead = true;
    behavior.onProjectileDeath!(state2, shell2);
    expect(widened.hp).toBeCloseTo(100 - 18, 6);
  });
});

describe('燃烧地（burn_ground 专属牌）', () => {
  it('爆炸后产生 zone：圆心 = 落点、radius = aoe×0.8、时长/节奏/每跳伤害随表、effectKind burn', () => {
    const state = createSimState(1);
    const shell = makeShell(state, 500, 800, 18, { burnGround: 1 });
    shell.dead = true;
    behavior.onProjectileDeath!(state, shell);

    const zones = listZones(state);
    expect(zones).toHaveLength(1);
    expect(zones[0].x).toBe(500);
    expect(zones[0].y).toBe(800);
    expect(zones[0].radius).toBeCloseTo(90 * 0.8, 9); // aoeRadius × burnRadiusFactor
    expect(zones[0].durationMs).toBe(3000);
    expect(zones[0].tickMs).toBe(500);
    expect(zones[0].damagePerTick).toBe(3);
    expect(zones[0].effectKind).toBe('burn');
  });

  it('范围内敌人逐 tick 受伤 + 挂 burn；区域外不受影响；durationMs 到期移除', () => {
    const state = createSimState(1);
    const inside = makeEnemy(state, 500, 850); // 距区域圆心 50 ≤ 72+10：在燃烧地内
    const outside = makeEnemy(state, 500, 1000); // 距 200：区域外
    const shell = makeShell(state, 500, 800, 18, { burnGround: 1 });
    shell.dead = true;
    behavior.onProjectileDeath!(state, shell);

    const grid = fillGrid(state);
    for (let i = 0; i < 6; i++) {
      state.timeMs += 500;
      updateZones(state, 500, grid);
    }
    // 落地爆炸 18（距爆心 50 ≤ 90+10）+ 6 跳燃烧地（最后一跳恰落在到期当帧）× 每跳 3。
    expect(inside.hp).toBeCloseTo(100 - 18 - 6 * 3, 6);
    expect(hasEffect(inside, 'burn')).toBe(true);
    expect(inside.effects[0].kind).toBe('burn');
    expect(inside.effects[0].untilMs).toBe(3000 + 3000); // 末次附着（timeMs 3000）+ 效果表时长
    expect(outside.hp).toBe(100); // 距爆心 200：爆炸与燃烧地都够不着
    expect(outside.effects).toHaveLength(0);

    state.timeMs += 500; // 第 7 个 tick 周期：区域已到期移除
    updateZones(state, 500, grid);
    expect(listZones(state)).toHaveLength(0);
    expect(inside.hp).toBeCloseTo(64, 6); // 不再受伤
  });

  it('zone 附着的是真实 burn 槽：效果引擎按效果表数值跳 DoT', () => {
    const state = createSimState(1);
    const victim = makeEnemy(state, 500, 850);
    const shell = makeShell(state, 500, 800, 18, { burnGround: 1 });
    shell.dead = true;
    behavior.onProjectileDeath!(state, shell);

    state.timeMs += 500;
    updateZones(state, 500, fillGrid(state));
    expect(victim.hp).toBeCloseTo(100 - 18 - 3, 6); // 落地爆炸 18 + 燃烧地首跳 3

    state.timeMs += 500;
    updateEffects(state, 500); // burn（effects.json：500ms tick / 每跳 3）真实结算一跳
    expect(victim.hp).toBeCloseTo(76, 6);
  });
});

describe('旧集束已删除（T5.3b：分裂由 split_shot 牌驱动，cluster/bomblet 路径不存在）', () => {
  it('牌目录不含 cluster；真实表 base 无子榴弹字段；fire 快照不含 cluster/bomblet 键且不产子榴弹', () => {
    const def = loadWeaponDefs().mortar;
    expect(def.cards.map((c) => c.id)).not.toContain('cluster');
    expect(def.base.bombletCount).toBeUndefined();
    expect(def.base.bombletDamage).toBeUndefined();

    const state = createSimState(1);
    const a1 = makeEnemy(state, 360, 500); // 落点锚
    makeEnemy(state, 365, 505);
    const before = state.nextId;
    fireWithCards(state, ['burn_ground', 'stun_blast', 'black_hole']); // 全部专属牌全开

    const p = state.projectiles[0];
    expect('cluster' in p.data).toBe(false); // 死分支已删除：快照不再携带旧集束键
    expect('bomblet' in p.data).toBe(false);
    expect(p.data.burnGround).toBe(1);
    expect(p.data.stunBlast).toBe(1);
    expect(p.data.blackHole).toBe(1);

    simulate(state, 100);
    expect(state.projectiles).toHaveLength(0); // 仅母弹爆完，无子榴弹
    expect(state.nextId - before).toBe(1); // 恰 1 枚弹
    expect(a1.hp).toBeCloseTo(100 - 18, 6);
  });
});

describe('眩晕（stun_blast 专属牌）', () => {
  it('爆炸半径内存活敌人挂 stun 效果槽实例（效果表时长 800ms）；被击杀者与半径外不挂', () => {
    const state = createSimState(1);
    const survivor = makeEnemy(state, 500, 870); // 距爆心 70 ≤ 100：吃 18 幸存
    const doomed = makeEnemy(state, 500, 805, 10); // 距 5：直接炸死
    const outside = makeEnemy(state, 500, 1000); // 距 200：半径外
    const shell = makeShell(state, 500, 800, 18, { stunBlast: 1 });
    shell.dead = true;
    behavior.onProjectileDeath!(state, shell);

    expect(survivor.hp).toBeCloseTo(100 - 18, 6);
    expect(survivor.effects).toHaveLength(1);
    expect(survivor.effects[0].kind).toBe('stun');
    expect(survivor.effects[0].stacks).toBe(1);
    expect(survivor.effects[0].untilMs).toBe(state.timeMs + 800); // 效果表 durationMs
    expect(isStunned(survivor)).toBe(true);
    expect(doomed.dead).toBe(true);
    expect(doomed.effects).toHaveLength(0); // 致死一击不附着（尸体无意义）
    expect(outside.hp).toBe(100);
    expect(outside.effects).toHaveLength(0);
  });

  it('端到端（燃烧地+眩晕牌全开）：弹上快照双开关、落地后目标挂 stun 且留燃烧地', () => {
    const state = createSimState(1);
    const a1 = makeEnemy(state, 360, 500);
    makeEnemy(state, 365, 505);
    const before = state.nextId;
    fireWithCards(state, ['burn_ground', 'stun_blast']);

    const p = state.projectiles[0];
    expect(p.data.stunBlast).toBe(1);
    expect(p.data.burnGround).toBe(1);
    expect(p.data.blackHole).toBe(0);

    simulate(state, 100);

    expect(state.nextId - before).toBe(1); // 无集束：仅母弹
    expect(a1.hp).toBeCloseTo(100 - 18, 6);
    expect(a1.effects.map((e) => e.kind)).toEqual(['stun']); // 爆炸挂 stun（黑洞未开）
    expect(listZones(state)).toHaveLength(1); // 燃烧地生效
  });
});

describe('黑洞（black_hole 专属牌）', () => {
  it('幸存者被瞬间拉至落点（centerX/Y = 落点）；即时效果不占效果槽', () => {
    const state = createSimState(1);
    const victim = makeEnemy(state, 595, 800); // 距爆心 95 ≤ 100：吃 18 幸存
    const bystander = makeEnemy(state, 500, 1000); // 距 200：半径外
    const shell = makeShell(state, 500, 800, 18, { stunBlast: 1, blackHole: 1 });
    shell.dead = true;
    behavior.onProjectileDeath!(state, shell);

    // 效果槽实例：先炸（18）后挂 stun；黑洞为即时效果（瞬间拉拽至中心，不占效果槽）
    expect(victim.hp).toBeCloseTo(100 - 18, 6);
    expect(victim.effects.map((e) => e.kind)).toEqual(['stun']);
    expect(victim.x).toBe(500); // 瞬间拉拽到落点 x
    expect(victim.y).toBe(800); // 瞬间拉拽到落点 y

    // 半径外旁观者：无效果、无位移。
    expect(bystander.hp).toBe(100);
    expect(bystander.effects).toHaveLength(0);
    expect(bystander.x).toBe(500);
    expect(bystander.y).toBe(1000);
  });

  it('端到端（全专属牌全开）：弹上快照 blackHole=1，落地后目标瞬间拉至落点且挂 stun 与留燃烧地', () => {
    const state = createSimState(1);
    const a1 = makeEnemy(state, 360, 500);
    makeEnemy(state, 365, 505);
    fireWithCards(state, ['burn_ground', 'stun_blast', 'black_hole']);

    const p = state.projectiles[0];
    expect(p.data.blackHole).toBe(1);
    expect(p.data.stunBlast).toBe(1);
    expect(p.data.burnGround).toBe(1);
    expect('cluster' in p.data).toBe(false); // 旧集束键已随 T5.3b 删除

    simulate(state, 100);

    expect(a1.effects.map((e) => e.kind)).toEqual(['stun']); // stun 挂槽，blackhole 为即时拉拽
    expect(a1.x).toBe(360); // 母弹落点
    expect(a1.y).toBe(500);
    expect(listZones(state)).toHaveLength(1); // 燃烧地照常（无集束：恰 1 片）
  });
});

describe('数值全部来自 weapons/mortar.json（真实表驱动，T5.3a 牌池制）', () => {
  const def = loadWeaponDefs().mortar;

  it('表身份：id/name/behavior/maxLevel=10，behavior 已自动发现注册', () => {
    expect(def.id).toBe('mortar');
    expect(def.name).toBe('迫击榴弹');
    expect(def.behavior).toBe('mortar');
    expect(def.maxLevel).toBe(10);
    expect(getBehavior('mortar')).toBe(behavior); // import.meta.glob 自动注册
  });

  it('牌目录：专属牌在前（burn_ground/stun_blast/black_hole），弹道+范围+dot 通用牌合并追加', () => {
    expect(def.cards.slice(0, 3).map((c) => c.id)).toEqual(['burn_ground', 'stun_blast', 'black_hole']);
    const ids = def.cards.map((c) => c.id);
    for (const genericId of ['dmg_up', 'spd_up', 'multi_shot', 'burst_shot', 'split_shot', 'range_up', 'dot_freq']) {
      expect(ids).toContain(genericId);
    }
    const dot = def.cards.find((c) => c.id === 'dot_freq')!;
    expect(dot.requiresCard).toBe('burn_ground'); // dot频率前置：燃烧地
    expect(def.rangeKeys).toEqual(['aoeRadius']);
  });

  it('base 数值随表（子榴弹字段已删除）；伤害/范围乘区随牌生效（改 json 即变）', () => {
    expect(def.base).toMatchObject({
      damage: 18, intervalMs: 1800, projectileSpeed: 0, pierce: 0, ttlMs: 0,
      flightMs: 900, aoeRadius: 90, densityRadius: 110,
      burnRadiusFactor: 0.8, burnDurationMs: 3000, burnTickMs: 500, burnDamagePerTick: 3,
      blackHolePullPerSec: 300,
    });
    expect(def.base.bombletCount).toBeUndefined();
    expect(def.base.cluster).toBeUndefined();

    const run = (cards: string[]) => {
      const state = createSimState(1);
      makeEnemy(state, 360, 620); // 距角色 600px
      const stats = fireWithCards(state, cards);
      const p = state.projectiles[0];
      return { damage: p.damage, aoe: p.data.aoeRadius, ttl: p.ttlMs, speed: Math.hypot(p.vx, p.vy), stats };
    };
    expect(run([])).toMatchObject({ damage: 18, aoe: 90, ttl: 900, speed: 600 / 0.9 });
    expect(run(['dmg_up'])).toMatchObject({ damage: 18 * 1.3, aoe: 90 });
    expect(run(['range_up'])).toMatchObject({ damage: 18, aoe: 108 });
    expect(run(['range_up', 'range_up', 'dmg_up'])).toMatchObject({ damage: 18 * 1.3, aoe: 90 * 1.44 });
  });

  it('alt def（不同数值）驱动同一行为，零硬编码', () => {
    const altDef = {
      id: 'alt_mortar',
      name: '替换榴弹',
      behavior: 'mortar',
      maxLevel: 10,
      base: {
        damage: 40, intervalMs: 1200, projectileSpeed: 0, pierce: 0, ttlMs: 0,
        flightMs: 500, aoeRadius: 120, densityRadius: 200,
        burnRadiusFactor: 0.5, burnDurationMs: 1000, burnTickMs: 250, burnDamagePerTick: 5,
        blackHolePullPerSec: 999,
        burnGround: 1, stunBlast: 1, blackHole: 1,
      },
      rangeKeys: [],
      cards: [],
    };
    const alt = createSimState(1);
    makeEnemy(alt, 400, 800);
    alt.weaponStates.alt_mortar = { level: 0, cooldownMs: 0, cards: {} };
    behavior.fire(alt, 'alt_mortar', getWeaponStats(altDef, alt, 'alt_mortar'));
    expect(alt.projectiles).toHaveLength(1);
    const shell = alt.projectiles[0];
    expect(shell.damage).toBe(40);
    expect(shell.ttlMs).toBe(500);
    expect(Math.hypot(shell.vx, shell.vy)).toBeCloseTo(Math.sqrt(40 * 40 + 420 * 420) / 0.5, 6); // 距角色 sqrt(40²+420²) / 0.5s
    expect(shell.data.aoeRadius).toBe(120);
    for (const key of ['burnGround', 'stunBlast', 'blackHole'] as const) {
      expect(shell.data[key]).toBe(1);
    }
    // 死亡 → 燃烧地参数随 alt 表（radius = 120×0.5 = 60）、黑洞即时拉拽（不占效果槽）、无集束分裂。
    shell.dead = true;
    behavior.onProjectileDeath!(alt, shell);
    const zone = listZones(alt)[0];
    expect(zone.radius).toBeCloseTo(60, 9);
    expect(zone.durationMs).toBe(1000);
    expect(zone.tickMs).toBe(250);
    expect(zone.damagePerTick).toBe(5);
    expect(alt.enemies[0].effects.find((e) => e.kind === 'blackhole')).toBeUndefined();
    expect(alt.enemies[0].x).toBe(400);
    expect(alt.enemies[0].y).toBe(800);
    expect(alt.projectiles).toHaveLength(1); // 仅夹具壳：无集束分裂
  });
});

describe('解释器集成（updateWeapons 驱动开火节奏）', () => {
  it('冷却到点开火一枚曲射炮弹（冷却 += intervalMs - dt）；落点爆炸走完整管线', () => {
    const def = loadWeaponDefs().mortar;
    const state = createSimState(1);
    const a1 = makeEnemy(state, 360, 500);
    makeEnemy(state, 365, 505);
    addWeapon(state, 'mortar');
    const defs = { mortar: def };

    updateWeapons(state, 16, defs);
    expect(state.projectiles).toHaveLength(1);
    expect(state.weaponStates.mortar.cooldownMs).toBe(1800 - 16);
    const p = state.projectiles[0];
    expect(p.data.tx).toBe(360); // 密度选点：A 区锚点
    expect(p.data.ty).toBe(500);
    expect(p.damage).toBe(18);
    expect(p.ttlMs).toBe(900);

    simulate(state, 100);
    expect(state.projectiles).toHaveLength(0);
    expect(a1.hp).toBeCloseTo(100 - 18, 6); // 落地全额爆炸
    expect(listZones(state)).toHaveLength(0); // 无燃烧地牌
  });

  it('无敌人在场：经解释器不开火、冷却恰推进一个 intervalMs（fire 归 0 → += 1800）', () => {
    const state = createSimState(1);
    addWeapon(state, 'mortar');
    const defs = { mortar: loadWeaponDefs().mortar };
    updateWeapons(state, 16, defs);
    expect(state.projectiles).toHaveLength(0);
    expect(state.weaponStates.mortar.cooldownMs).toBe(1800);

    updateWeapons(state, 16, defs); // 依旧无敌：不开火，冷却照常递减（1784 > 0 不触发开火）
    expect(state.projectiles).toHaveLength(0);
    expect(state.weaponStates.mortar.cooldownMs).toBe(1800 - 16);
  });
});

describe('可复现（行为零随机：不读 rng，任意种子同结果）', () => {
  /** 固定场景：全专属牌全开打满弹道 + 燃烧地/黑洞拉拽 4 个 tick 周期的全量结果快照。 */
  function scenario(seed: number): {
    a1: { hp: number; x: number; y: number; effects: string[] };
    a2: { hp: number; x: number; y: number };
    frontHp: number;
    outerHp: number;
    nextId: number;
    leftover: number;
    zones: Array<[number, number, number, number, number, number, string | undefined]>;
  } {
    const state = createSimState(seed);
    const a1 = makeEnemy(state, 360, 500); // A 区（落点）
    const a2 = makeEnemy(state, 380, 510);
    const front = makeEnemy(state, 360, 900); // 前排
    const outer = makeEnemy(state, 700, 500); // 旁观者
    fireWithCards(state, ['burn_ground', 'stun_blast', 'black_hole']);
    simulate(state, 120); // 母弹落地爆炸

    const grid = new SpatialHash<Enemy>(64);
    for (let i = 0; i < 4; i++) {
      grid.clear();
      for (let j = 0; j < state.enemies.length; j++) {
        const e = state.enemies[j];
        if (!e.dead) {
          grid.insert(e, e.x, e.y, e.radius);
        }
      }
      state.timeMs += 500;
      updateEffects(state, 500); // 黑洞拉拽 + burn DoT
      updateZones(state, 500, grid); // 燃烧地 tick
    }
    return {
      a1: { hp: a1.hp, x: a1.x, y: a1.y, effects: a1.effects.map((e) => e.kind) },
      a2: { hp: a2.hp, x: a2.x, y: a2.y },
      frontHp: front.hp,
      outerHp: outer.hp,
      nextId: state.nextId,
      leftover: state.projectiles.length,
      zones: listZones(state).map(
        (z) => [z.x, z.y, z.radius, z.durationMs, z.tickMs, z.damagePerTick, z.effectKind] as const,
      ) as Array<[number, number, number, number, number, number, string | undefined]>,
    };
  }

  it('同种子两次全流程一致；异种子也一致（确定性映射，全程不消耗 rng）', () => {
    const first = scenario(42);
    expect(scenario(42)).toEqual(first);
    expect(scenario(7)).toEqual(first);
    // 结果有意义性抽查：爆炸/燃烧地/DoT 真实结算、无集束（恰 1 弹 1 区）。
    expect(first.a1.hp).toBeLessThan(82); // 母弹 18 后又被燃烧地 + burn DoT 持续掉血
    expect(first.frontHp).toBe(100); // 前排全程无伤（noCollide 越过 + 半径外）
    expect(first.outerHp).toBe(100);
    expect(first.nextId).toBe(6); // 4 敌 + 1 母弹：下一分配 id = 6
    expect(first.zones).toHaveLength(1); // 母弹燃烧地
    expect(first.zones[0][2]).toBeCloseTo(72, 9);
  });
});

// —— T5.3b 弹道机制接线：多射壳体环 / 连射 / 分裂小 AoE / dot 频率 ——

describe('多射（multi_shot 牌：壳体落点在密度中心周围小半径环上错开）', () => {
  it('1 张多射：2 枚壳体落点 = 预测落点 ±40px（起点朝正上的环）、同时落地、各自独立 AoE', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 500); // 密度锚（数组序最先）
    makeEnemy(state, 380, 510);
    makeEnemy(state, 340, 520);
    fireWithCards(state, ['multi_shot']);

    expect(state.projectiles).toHaveLength(2);
    const landings = state.projectiles.map((p) => [p.data.tx, p.data.ty]).sort((x, y) => x[1] - y[1]);
    expect(landings[0]).toEqual([360, 460]); // 中心 (360,500) − 40（环起点朝正上）
    expect(landings[1]).toEqual([360, 540]); // 中心 + 40
    for (const p of state.projectiles) {
      expect(p.ttlMs).toBe(900); // 同一飞行时长：同时落地
      expect(p.data.aoeRadius).toBe(90); // 各自独立 AoE（同表值）
    }
  });

  it('2 张多射：3 枚壳体（环上均匀 120° 间隔）', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 500);
    fireWithCards(state, ['multi_shot', 'multi_shot']);
    expect(state.projectiles).toHaveLength(3);
    const ys = state.projectiles.map((p) => p.data.ty).sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(500 - 40, 9); // 环顶
    expect(ys[1]).toBeCloseTo(500 + 40 * Math.sin((30 * Math.PI) / 180), 9); // 环上两点
  });
});

describe('连射（burst_shot 牌：待发波队列重放——重新密度选点）', () => {
  it('1 张连射：首波 1 枚；150ms 后 update 重放第 2 枚（同密度簇再选点）', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 500);
    makeEnemy(state, 380, 510);
    fireWithCards(state, ['burst_shot']);
    expect(state.projectiles).toHaveLength(1);

    state.timeMs += 150;
    behavior.update!(state, 16);
    expect(state.projectiles).toHaveLength(2);
    expect(state.projectiles[1].data.tx).toBe(360); // 重放重新选点：仍落密度簇
  });
});

describe('分裂（split_shot 牌：母弹爆炸点分裂次级榴弹——短飞行后落小 AoE）', () => {
  it('爆炸点分裂 4 枚：伤害/AoE = ×0.2、leadAim 锁 4 个不同目标、不再分裂、燃烧地随行', () => {
    const state = createSimState(1);
    // 布景：e1/e2/e3 在母弹 AoE（90+10）内（先吃母弹爆炸 18）；outside 在 AoE 外（500,950 距 150）
    // 且为第 4 近 → 被次级弹锁定、只吃次级弹小 AoE 3.6。
    const e1 = makeEnemy(state, 500, 760, 1e6); // 距爆心 40
    const e2 = makeEnemy(state, 570, 800, 1e6); // 距爆心 70
    const e3 = makeEnemy(state, 430, 800, 1e6); // 距爆心 70
    const outside = makeEnemy(state, 500, 950, 1e6); // 距爆心 150：母弹 AoE 外、第 4 近

    const shell = makeShell(state, 500, 800, 18, {
      splitReady: 1, splitFactor: 0.2, splitMax: 4, burnGround: 1,
    });
    shell.vy = -600 / 0.9; // 主弹落速（飞行时间制）：从角色上方 600px 落下
    shell.dead = true;
    behavior.onProjectileDeath!(state, shell);
    state.projectiles = state.projectiles.filter((p) => p !== shell); // 移除直调夹具（防框架二次触发死亡钩子）

    // 4 枚次级榴弹：从爆炸点出发、leadAim 各锁一个最近且互不相同的目标
    const secondaries = state.projectiles.filter((p) => p !== shell);
    expect(secondaries).toHaveLength(4);
    for (const sec of secondaries) {
      expect(sec.damage).toBeCloseTo(3.6, 9); // 18 × 0.2
      expect(sec.data.aoeRadius).toBeCloseTo(18, 9); // 小 AoE：90 × 0.2
      expect(sec.data.splitReady).toBe(0); // 封死再分裂
      expect(sec.data.noCollide).toBe(1); // 同弹种：noCollide 曲射壳体
      expect(sec.data.burnGround).toBe(1); // 燃烧地随行
    }
    // 落点各不相同（leadAim 锁定各自目标；静止目标 → 落点即目标位置）
    const landings = new Set(secondaries.map((p) => `${p.data.tx},${p.data.ty}`));
    expect(landings.size).toBe(4);

    // 端到端：次级榴弹落地小 AoE 爆炸 + 燃烧地，不再分裂
    const spawned = state.nextId;
    const grid = fillGrid(state);
    for (let f = 0; f < 60 && state.projectiles.length > 0; f++) {
      updateProjectiles(state, 16, grid);
      state.timeMs += 16;
    }
    expect(state.nextId - spawned).toBe(0); // 不再分裂
    for (const e of [e1, e2, e3]) {
      expect(e.hp).toBeCloseTo(1e6 - 18 - 3.6, 6); // 母弹爆炸 + 次级弹小 AoE
    }
    expect(outside.hp).toBeCloseTo(1e6 - 3.6, 6); // 母弹 AoE 外：只吃次级弹小 AoE
  });

  it('未拿分裂牌：爆炸不产次级榴弹（恰 1 弹 1 燃烧地）', () => {
    const state = createSimState(1);
    makeEnemy(state, 500, 850, 1e6);
    const shell = makeShell(state, 500, 800, 18, { burnGround: 1 });
    shell.dead = true;
    behavior.onProjectileDeath!(state, shell);
    const alive = state.projectiles.filter((p) => p !== shell);
    expect(alive).toHaveLength(0);
    expect(listZones(state)).toHaveLength(1);
  });
});

describe('dot 频率（dot_freq 牌，requiresCard=burn_ground：燃烧地 tick 间隔 ÷1.3）', () => {
  it('弹上 burnTickMs 与落地 zone 的 tickMs = 500/1.3；每跳伤害保持表值', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 500);
    const victim = makeEnemy(state, 500, 850, 1e6); // 先建：入密度网格（网格按 (state, timeMs) 缓存）
    fireWithCards(state, ['burn_ground', 'dot_freq']);
    expect(state.projectiles[0].data.burnTickMs).toBeCloseTo(500 / 1.3, 9); // fire 时快照

    const shell = makeShell(state, 500, 800, 18, { burnGround: 1, burnTickMs: 500 / 1.3 });
    shell.dead = true;
    behavior.onProjectileDeath!(state, shell);
    const zone = listZones(state)[0];
    expect(zone.tickMs).toBeCloseTo(500 / 1.3, 9); // zone tick 逐实例参数直除
    expect(zone.damagePerTick).toBe(3);

    state.timeMs += 384.7;
    updateZones(state, 384.7, fillGrid(state));
    expect(victim.hp).toBeCloseTo(1e6 - 18 - 3, 6); // 母弹爆炸 + 首跳（384.6ms）
  });
});
