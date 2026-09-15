// src/core/behaviors/scatterShot.test.ts —— 扇面霰弹行为契约（T5.3a 牌池制更新）：
// 扇形发射（弹数/全出自角色/夹角 ≤ 半扇角/对称/短程 ttl）、中心更密（平方分布）、
// 专属牌四节点（burnBullet/knockback/bounce_up/dragon_breath_mode 经 stats 开关注入；
// 龙息模式与多射/连射/分裂互斥——牌池侧 excludes 保证，见 core/upgrade.test.ts）、
// 数值全部来自 weapons/scatter.json 真实表（弹数成长走多射牌、扇角走范围强化牌）、
// 行为零随机（任意种子可复现）。
import { describe, expect, it } from 'vitest';
import { loadEffectDefs } from '../../data/effects';
import { loadWeaponDefs } from '../../data/weapons';
import { hasEffect, updateEffects } from '../effects';
import { updateProjectiles } from '../projectiles';
import { createSimState } from '../simState';
import { SpatialHash } from '../spatialHash';
import type { Enemy, SimState } from '../types';
import { addWeapon, getWeaponStats, updateWeapons } from '../weapons';
import type { WeaponDef, WeaponStats } from '../weapons';
import { behavior } from './behavior_scatterShot';
import { BURST_QUEUE_META_KEY, type BurstWaveEntry } from '../cards';
import './index'; // 副作用：自动发现注册
import { getBehavior } from './registry';

// 副作用：把 effects.json 真实效果表注册进 core/effects（burn/knockback 等特效槽依赖）。
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

function makeGrid(): SpatialHash<Enemy> {
  return new SpatialHash<Enemy>(64);
}

/** 弹丸速度与 -y（正上）的夹角（度，带符号，右偏为正）。 */
function angleDeg(p: { vx: number; vy: number }): number {
  return (Math.atan2(p.vx, -p.vy) * 180) / Math.PI;
}

/** 升序排序后的带符号发射角数组。 */
function sortedAngles(state: SimState): number[] {
  return state.projectiles.map(angleDeg).sort((a, b) => a - b);
}

/** 以真实数据表 scatter.json 的指定牌组开火一次（新建状态；无敌人也照喷）。 */
function fireWithCards(cards: string[] = []): { state: SimState; stats: WeaponStats } {
  const def = loadWeaponDefs().scatter;
  const state = createSimState(1); // 角色 (360, 1220)
  state.weaponStates.scatter = { level: cards.length, cooldownMs: 0, cards: {} };
  const ws = state.weaponStates.scatter;
  for (const cardId of cards) {
    ws.cards[cardId] = (ws.cards[cardId] ?? 0) + 1;
  }
  const stats = getWeaponStats(def, state, 'scatter');
  behavior.fire(state, 'scatter', stats);
  return { state, stats };
}

describe('扇形发射（fire 普通态）', () => {
  it('无牌发射 5 枚、全部从角色出发、速度大小 = projectileSpeed、夹角 ≤ 半扇角、短程 ttl', () => {
    const { state, stats } = fireWithCards();
    expect(stats.projectileCount).toBe(5);
    expect(state.projectiles.length).toBe(5);

    for (const p of state.projectiles) {
      expect(p.behavior).toBe('scatter_shot');
      expect(p.x).toBe(360); // state.character.x
      expect(p.y).toBe(1220); // state.character.y：全部从角色出发
      expect(Math.hypot(p.vx, p.vy)).toBeCloseTo(stats.projectileSpeed, 6);
      expect(Math.abs(angleDeg(p))).toBeLessThanOrEqual(stats.fanAngleDeg / 2 + 1e-9);
      expect(p.ttlMs).toBe(stats.ttlMs); // 短程寿命来自表
      expect(p.damage).toBe(stats.damage);
      expect(p.pierceLeft).toBe(stats.pierce);
      expect(p.radius).toBe(6);
      expect(p.bouncesLeft).toBe(0);
    }
  });

  it('扇形对称且（奇数枚）正中一枚恰朝正上：5 枚角度 = [-35, -8.75, 0, 8.75, 35]', () => {
    const { state } = fireWithCards();
    const angles = sortedAngles(state);
    expect(angles).toHaveLength(5);
    expect(angles[0]).toBeCloseTo(-35, 6);
    expect(angles[1]).toBeCloseTo(-8.75, 6);
    expect(angles[2]).toBeCloseTo(0, 9);
    expect(angles[3]).toBeCloseTo(8.75, 6);
    expect(angles[4]).toBeCloseTo(35, 6);
    // 对称性：angles[i] === -angles[n-1-i]
    for (let i = 0; i < angles.length; i++) {
      expect(angles[i]).toBeCloseTo(-angles[angles.length - 1 - i], 9);
    }
    // 正中一枚速度恰为 (0, -speed)
    const center = state.projectiles.find((p) => p.vx === 0);
    expect(center).toBeDefined();
    expect(center!.vy).toBe(-700);
  });

  it('越靠中心越密：中位绝对角 < 扇角/4，内圈间距 < 外圈间距（5 枚与 9 枚双验证）', () => {
    for (const cards of [[], ['multi_shot', 'multi_shot', 'multi_shot', 'multi_shot']]) {
      const { state, stats } = fireWithCards(cards);
      const angles = sortedAngles(state);
      const absAngles = angles.map(Math.abs).sort((a, b) => a - b);
      const median = absAngles[(absAngles.length - 1) / 2];
      expect(median).toBeLessThan(stats.fanAngleDeg / 4); // 中心密度断言
      // 内圈相邻角距 < 外圈相邻角距（越靠中心越密的直接证据）
      const mid = (angles.length - 1) / 2;
      const innerGap = angles[mid + 1] - angles[mid];
      const outerGap = angles[1] - angles[0];
      expect(innerGap).toBeLessThan(outerGap);
    }
    // 具体数值锚定（扇角 70 → 半角 35）：5 枚中位 8.75；9 枚（多射×4）中位 8.75（t=0.5 → 35×0.25）
    expect(sortedAngles(fireWithCards().state).map(Math.abs).sort((a, b) => a - b)[2]).toBeCloseTo(8.75, 6);
    expect(
      sortedAngles(fireWithCards(['multi_shot', 'multi_shot', 'multi_shot', 'multi_shot']).state)
        .map(Math.abs)
        .sort((a, b) => a - b)[4],
    ).toBeCloseTo(8.75, 6);
  });

  it('短程射程：飞行距离上限 = projectileSpeed × ttlMs，模拟至 ttl 耗尽全部消失且不越界', () => {
    const { state, stats } = fireWithCards();
    const range = stats.projectileSpeed * (stats.ttlMs / 1000);
    expect(range).toBeCloseTo(455, 6); // 700 px/s × 650 ms = 455 px：远小于全场（墙距 1060+）
    for (const p of state.projectiles) {
      expect((Math.hypot(p.vx, p.vy) * p.ttlMs) / 1000).toBeCloseTo(range, 4);
    }

    const grid = makeGrid();
    let minY = Infinity;
    for (let f = 0; f < 70; f++) {
      updateProjectiles(state, 10, grid);
      for (const p of state.projectiles) {
        if (p.y < minY) minY = p.y;
      }
    }
    expect(state.projectiles.length).toBe(0); // ttl 用尽全部销毁
    expect(minY).toBeGreaterThanOrEqual(1220 - range - 1e-6); // 从未飞出射程上限
    expect(minY).toBeLessThanOrEqual(1220 - range + stats.projectileSpeed * 0.01 + 1e-6); // 且确实飞满射程
  });
});

describe('专属牌：burn_bullet 燃烧弹', () => {
  it('无牌无模板；燃烧弹牌起每枚弹带燃烧模板（kind/data 生效，untilMs 由效果引擎重算）', () => {
    const plain = fireWithCards();
    for (const p of plain.state.projectiles) {
      expect(p.effectsOnHit).toEqual([]);
    }

    const burning = fireWithCards(['burn_bullet']);
    for (const p of burning.state.projectiles) {
      expect(p.effectsOnHit).toEqual([{ kind: 'burn', untilMs: 0, stacks: 1, data: {} }]);
    }
  });

  it('命中后敌人挂上 burn 效果槽实例，DoT 按效果表逐 tick 扣血', () => {
    const def = loadWeaponDefs().scatter;
    const state = createSimState(1);
    state.weaponStates.scatter = { level: 1, cooldownMs: 0, cards: { burn_bullet: 1 } };
    const e = makeEnemy(state, 360, 800); // 正上方 420px：射程 455 内，仅中央弹能命中
    behavior.fire(state, 'scatter', getWeaponStats(def, state, 'scatter'));

    const grid = makeGrid();
    for (let f = 0; f < 70 && state.projectiles.length > 0; f++) {
      updateProjectiles(state, 10, grid);
    }
    expect(state.projectiles.length).toBe(0);
    expect(e.hp).toBe(96); // 直击伤害 4（base，无伤害牌）
    expect(e.effects).toHaveLength(1);
    expect(e.effects[0].kind).toBe('burn');
    expect(e.effects[0].stacks).toBe(1);

    // burn（效果表：3000ms / 500ms tick / 3 伤）：推进时间结算一跳
    state.timeMs += 500;
    updateEffects(state, 500);
    expect(e.hp).toBe(93);
  });
});

describe('专属牌：knockback 击退', () => {
  it('真实表牌组：正上敌人被中央弹命中后沿背向角色方向（正上）位移 knockbackForce=60', () => {
    const def = loadWeaponDefs().scatter;
    const state = createSimState(1);
    state.weaponStates.scatter = { level: 1, cooldownMs: 0, cards: { knockback: 1 } };
    const e = makeEnemy(state, 360, 800); // 正上 420px：仅中央弹命中（±3.89° 近轴弹垂直距 21.7 > 16）
    behavior.fire(state, 'scatter', getWeaponStats(def, state, 'scatter'));

    const grid = makeGrid();
    for (let f = 0; f < 70 && state.projectiles.length > 0; f++) {
      updateProjectiles(state, 10, grid);
    }
    expect(e.hp).toBe(96); // 仅一次直击（base damage 4）
    expect(e.x).toBe(360);
    expect(e.y).toBe(740); // 背向角色 = 正上，force 60（牌表值 knockbackForce）
  });

  it('击退方向 = 背向角色（弹来向）：单弹夹具验证非轴对齐方向', () => {
    const state = createSimState(1);
    // 偏 12px：仍在直射路径命中容差（6+10=16）内 → 击退方向 = (12, -320) 归一
    const e = makeEnemy(state, 372, 900);
    behavior.fire(state, 'scatter', {
      damage: 4, intervalMs: 1100, projectileSpeed: 700, pierce: 0, ttlMs: 650,
      projectileCount: 1, fanAngleDeg: 0, bounceRange: 200,
      knockback: 1, knockbackForce: 60,
    });

    const grid = makeGrid();
    for (let f = 0; f < 70 && state.projectiles.length > 0; f++) {
      updateProjectiles(state, 10, grid);
    }
    expect(e.hp).toBe(96); // 单弹一击
    const d = Math.hypot(12, -320);
    expect(e.x).toBeCloseTo(372 + (12 / d) * 60, 3); // force 60 沿背向角色方向
    expect(e.y).toBeCloseTo(900 + (-320 / d) * 60, 3);
  });

  it('无击退牌：命中不位移', () => {
    const def = loadWeaponDefs().scatter;
    const state = createSimState(1);
    state.weaponStates.scatter = { level: 0, cooldownMs: 0, cards: {} };
    const e = makeEnemy(state, 360, 800);
    behavior.fire(state, 'scatter', getWeaponStats(def, state, 'scatter'));

    const grid = makeGrid();
    for (let f = 0; f < 70 && state.projectiles.length > 0; f++) {
      updateProjectiles(state, 10, grid);
    }
    expect(e.hp).toBe(96); // base damage 4
    expect(e.x).toBe(360);
    expect(e.y).toBe(800);
  });
});

describe('专属牌：bounce_up 弹丸反弹', () => {
  /** 单弹直线夹具 stats（与表同构、开关齐全，专测弹射链几何）。 */
  function bounceStats(): WeaponStats {
    return {
      damage: 4,
      intervalMs: 1100,
      projectileSpeed: 700,
      pierce: 0,
      ttlMs: 650,
      projectileCount: 1,
      fanAngleDeg: 0,
      bounceRange: 200,
      bounce: 1,
      bounceCount: 2,
    };
  }

  it('死亡边缘重定向到 bounceRange 内最近未打过的敌人：A→B→C 链、各只挨一击、弹射次数用尽即正常死亡', () => {
    const state = createSimState(1);
    const a = makeEnemy(state, 360, 1120); // 直射路径上，先被击中
    const b = makeEnemy(state, 450, 1080); // 距 A 命中点 ~106（< 200），比 C 近
    const c = makeEnemy(state, 500, 1160); // 距 B 命中点 ~96（< 200）
    behavior.fire(state, 'scatter', bounceStats());
    expect(state.projectiles).toHaveLength(1);

    const grid = makeGrid();
    let sawRedirect = false;
    for (let f = 0; f < 300 && state.projectiles.length > 0; f++) {
      updateProjectiles(state, 10, grid);
      if (!sawRedirect && state.projectiles.some((p) => p.hitIds.length > 0)) {
        // 第一次重定向：原弹已死，续接弹继承 hitIds、bouncesLeft-1、ttl 重置、朝新目标
        sawRedirect = true;
        expect(state.projectiles).toHaveLength(1);
        const p2 = state.projectiles[0];
        expect(p2.hitIds).toEqual([a.id]); // 不重复打同一敌人
        expect(p2.bouncesLeft).toBe(1);
        expect(p2.ttlMs).toBe(650 - 10); // ttl 重置为 650；续接弹 spawn 当帧即被处理一跳（框架交换删除约定）
        expect(p2.damage).toBe(4);
        expect(p2.vx).toBeGreaterThan(0); // 朝右上的 B
        expect(p2.vy).toBeLessThan(0);
        expect(Math.hypot(p2.vx, p2.vy)).toBeCloseTo(700, 6);
      }
    }
    expect(sawRedirect).toBe(true);
    expect(state.projectiles).toHaveLength(0); // 弹射 2 次用尽 → 正常死亡
    expect(a.hp).toBe(96); // 各只挨一击（4 伤）
    expect(b.hp).toBe(96);
    expect(c.hp).toBe(96);
    // 恰好 3 枚弹（1 初始 + 2 续接）：id 4/5/6 → nextId 停在 7，无多余 spawn
    expect(state.nextId).toBe(7);
  });

  it('无 bounce 开关：命中后正常死亡，不续接', () => {
    const state = createSimState(1);
    const a = makeEnemy(state, 360, 1120);
    behavior.fire(state, 'scatter', { ...bounceStats(), bounce: 0, bounceCount: 0 });

    const grid = makeGrid();
    for (let f = 0; f < 300 && state.projectiles.length > 0; f++) {
      updateProjectiles(state, 10, grid);
    }
    expect(a.hp).toBe(96);
    expect(state.projectiles).toHaveLength(0);
    expect(state.nextId).toBe(3); // 仅 1 敌 + 1 弹，无续接 spawn
  });
});

describe('专属牌：dragon_breath_mode 龙息模式（质变：锥形持续，不发弹丸）', () => {
  it('龙息模式 fire 不再发弹丸：锥内扣血、锥外/超射程/尸体不扣', () => {
    const def = loadWeaponDefs().scatter;
    const state = createSimState(1);
    state.weaponStates.scatter = { level: 1, cooldownMs: 0, cards: { dragon_breath_mode: 1 } };
    const inCone = makeEnemy(state, 360, 800); // 正上 420 ≤ 455
    const inConeOffAxis = makeEnemy(state, 450, 900); // 距 332、偏角 ~16° < 40°
    const outAngle = makeEnemy(state, 700, 1000); // 距 405 在射程内，但偏角 ~57° > 40°
    const outRange = makeEnemy(state, 360, 700); // 距 520 > 455：方向对但超射程
    const corpse = makeEnemy(state, 360, 900, 50);
    corpse.dead = true;

    const stats = getWeaponStats(def, state, 'scatter');
    behavior.fire(state, 'scatter', stats);

    expect(state.projectiles).toHaveLength(0); // 不对扇形发射弹丸
    expect(inCone.hp).toBe(96); // 100 - 4（base damage）
    expect(inConeOffAxis.hp).toBe(96);
    expect(outAngle.hp).toBe(100);
    expect(outRange.hp).toBe(100);
    expect(corpse.hp).toBe(50);
  });

  it('维持 intervalMs 节奏的持续伤害（经 updateWeapons，base 间隔 1100ms 两跳）', () => {
    const def = loadWeaponDefs().scatter;
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 800);
    addWeapon(state, 'scatter');
    state.weaponStates.scatter.cards.dragon_breath_mode = 1;
    state.weaponStates.scatter.level = 1;
    const defs = { scatter: def };

    updateWeapons(state, 100, defs); // 第 1 跳
    expect(e.hp).toBe(96);
    expect(state.projectiles).toHaveLength(0);

    for (let i = 0; i < 9; i++) {
      updateWeapons(state, 100, defs); // 累计 1000ms：间隔未到
    }
    expect(e.hp).toBe(96);

    updateWeapons(state, 100, defs); // 累计 1100ms = intervalMs → 第 2 跳
    expect(e.hp).toBe(92);
    expect(state.projectiles).toHaveLength(0);
  });
});

describe('数值全部来自 weapons/scatter.json（真实表驱动，T5.3a 牌池制）', () => {
  const def = loadWeaponDefs().scatter;

  it('表身份：id/name/behavior/maxLevel=10，behavior 已自动发现注册', () => {
    expect(def.id).toBe('scatter');
    expect(def.name).toBe('扇面霰弹');
    expect(def.behavior).toBe('scatter_shot');
    expect(def.maxLevel).toBe(10);
    expect(getBehavior('scatter_shot')).toBe(behavior); // import.meta.glob 自动注册
  });

  it('牌目录：专属牌在前（burn_bullet/knockback/bounce_up/dragon_breath_mode），通用牌合并追加', () => {
    expect(def.cards.slice(0, 4).map((c) => c.id)).toEqual(['burn_bullet', 'knockback', 'bounce_up', 'dragon_breath_mode']);
    const ids = def.cards.map((c) => c.id);
    for (const genericId of ['dmg_up', 'spd_up', 'multi_shot', 'burst_shot', 'split_shot', 'range_up', 'dot_freq']) {
      expect(ids).toContain(genericId);
    }
    const dot = def.cards.find((c) => c.id === 'dot_freq')!;
    expect(dot.requiresCard).toBe('burn_bullet'); // dot频率前置：燃烧弹
    expect(def.rangeKeys).toEqual(['fanAngleDeg']); // 范围强化乘扇角
    // 龙息模式互斥声明（牌池侧排除多射/连射/分裂，见 core/cards 的 excludes 语义）。
    const dragon = def.cards.find((c) => c.id === 'dragon_breath_mode')!;
    expect(dragon.excludes).toEqual(['multi_shot', 'burst_shot', 'split_shot']);
    expect(dragon.once).toBe(true);
  });

  it('base 数值随表；弹数/扇角/伤害随牌生效（改 json 即变）', () => {
    expect(def.base).toMatchObject({
      damage: 4, intervalMs: 1100, projectileSpeed: 700, pierce: 0, ttlMs: 650,
      projectileCount: 5, fanAngleDeg: 70, bounceRange: 200,
    });

    expect(fireWithCards().stats.projectileCount).toBe(5);
    expect(fireWithCards(['multi_shot']).stats.projectileCount).toBe(6);
    expect(fireWithCards(['multi_shot', 'multi_shot']).stats.projectileCount).toBe(7);
    expect(fireWithCards(['range_up']).stats.fanAngleDeg).toBeCloseTo(84, 9); // 70 × 1.2
    expect(fireWithCards(['dmg_up']).stats.damage).toBeCloseTo(4 * 1.3, 9);
    // 弹数随牌实际生效：1/2 张多射 → 6/7 枚；龙息模式 → 0 枚（质变）。
    expect(fireWithCards(['multi_shot']).state.projectiles).toHaveLength(6);
    expect(fireWithCards(['multi_shot', 'multi_shot']).state.projectiles).toHaveLength(7);
    expect(fireWithCards(['dragon_breath_mode']).state.projectiles).toHaveLength(0);
  });

  it('改表即变：alt def（不同数值）驱动同一行为', () => {
    const altDef: WeaponDef = {
      id: 'alt_scatter',
      name: '替换霰弹',
      behavior: 'scatter_shot',
      maxLevel: 10,
      base: {
        damage: 33, intervalMs: 500, projectileSpeed: 500, pierce: 1, ttlMs: 300,
        projectileCount: 3, fanAngleDeg: 50, bounceRange: 120,
      },
      rangeKeys: [],
      cards: [{ id: 'multi_shot', name: '多射+1', description: '', params: [{ key: 'projectileCount', value: 1, op: 'add' }] }],
    };
    const state = createSimState(1);
    state.weaponStates.alt_scatter = { level: 0, cooldownMs: 0, cards: {} };
    behavior.fire(state, 'alt_scatter', getWeaponStats(altDef, state, 'alt_scatter'));
    expect(state.projectiles).toHaveLength(3);
    const angles = sortedAngles(state);
    expect(angles[0]).toBeCloseTo(-25, 6); // 半扇角 25°
    expect(angles[1]).toBeCloseTo(0, 9);
    expect(angles[2]).toBeCloseTo(25, 6);
    for (const p of state.projectiles) {
      expect(p.damage).toBe(33);
      expect(Math.hypot(p.vx, p.vy)).toBeCloseTo(500, 6);
      expect(p.ttlMs).toBe(300);
      expect(p.pierceLeft).toBe(1);
    }

    // 多射牌 ×1：3 → 4 枚（projectileCount +1）。
    const state2 = createSimState(1);
    state2.weaponStates.alt_scatter = { level: 1, cooldownMs: 0, cards: { multi_shot: 1 } };
    behavior.fire(state2, 'alt_scatter', getWeaponStats(altDef, state2, 'alt_scatter'));
    expect(state2.projectiles).toHaveLength(4);
  });
});

describe('可复现性（行为零随机：不依赖 rng，任意种子同结果）', () => {
  function volley(seed: number): number[][] {
    const state = createSimState(seed);
    state.weaponStates.scatter = { level: 0, cooldownMs: 0, cards: {} };
    behavior.fire(state, 'scatter', getWeaponStats(loadWeaponDefs().scatter, state, 'scatter'));
    return state.projectiles.map((p) => [p.vx, p.vy, p.ttlMs, p.damage]);
  }

  it('同种子两次发射弹道逐字段一致；异种子也一致（确定性映射）', () => {
    expect(volley(42)).toEqual(volley(42));
    expect(volley(42)).toEqual(volley(7));
  });

  it('龙息结算可复现：同种子（乃至异种子）敌人扣血一致', () => {
    const run = (seed: number) => {
      const state = createSimState(seed);
      state.weaponStates.scatter = { level: 1, cooldownMs: 0, cards: { dragon_breath_mode: 1 } };
      makeEnemy(state, 360, 800);
      makeEnemy(state, 700, 1000);
      behavior.fire(state, 'scatter', getWeaponStats(loadWeaponDefs().scatter, state, 'scatter'));
      return state.enemies.map((e) => e.hp);
    };
    expect(run(42)).toEqual([96, 100]);
    expect(run(42)).toEqual(run(7));
  });
});

// —— T5.3b 弹道机制接线：连射 / 分裂 / 龙息互斥兜底 / dot 频率 ——

/** 以真实数据表 scatter.json 的指定牌组在既有状态上开火一次（敌人由用例自行布置）。 */
function fireScatter(state: SimState, cards: string[]): WeaponStats {
  const def = loadWeaponDefs().scatter;
  state.weaponStates.scatter = { level: cards.length, cooldownMs: 0, cards: {} };
  const ws = state.weaponStates.scatter;
  for (const cardId of cards) {
    ws.cards[cardId] = (ws.cards[cardId] ?? 0) + 1;
  }
  const stats = getWeaponStats(def, state, 'scatter');
  behavior.fire(state, 'scatter', stats);
  return stats;
}

describe('连射（burst_shot 牌：待发波队列重放——再喷完整一波）', () => {
  it('1 张连射：首波 5 枚即时；150ms 后 update 重放 +5 枚（与多射联动：每波完整 N 颗）', () => {
    const state = createSimState(1);
    fireScatter(state, ['burst_shot']);
    expect(state.projectiles).toHaveLength(5);
    expect((state.meta[BURST_QUEUE_META_KEY] as BurstWaveEntry[])).toHaveLength(1);

    state.timeMs += 150;
    behavior.update!(state, 16);
    expect(state.projectiles).toHaveLength(10); // 重放波完整 5 枚
    expect((state.meta[BURST_QUEUE_META_KEY] as BurstWaveEntry[])).toHaveLength(0);

    const linked = createSimState(1);
    fireScatter(linked, ['multi_shot', 'burst_shot']);
    expect(linked.projectiles).toHaveLength(6); // 首波 6 枚（base 5 + 多射 1）
    linked.timeMs += 150;
    behavior.update!(linked, 16);
    expect(linked.projectiles).toHaveLength(12); // 重放波完整 6 枚
  });
});

describe('分裂（split_shot 牌：弹丸首命中分裂次级弹丸）', () => {
  it('中央弹命中后分裂 4 枚：伤害 = 4×0.2 = 0.8、锁定 4 个不同敌人、燃烧模板随行、不再分裂', () => {
    const state = createSimState(1);
    // 布景约定：候选全部放在全部扇形弹（±8.75°/±35°）弹道线之外（横向偏移 > 100px），
    // 保证只有中央弹命中 main、分裂次级弹只命中各自的锁定目标。
    const main = makeEnemy(state, 360, 1100, 1e6); // 中央弹（正上）的命中目标
    const s2 = makeEnemy(state, 100, 1080, 1e6); // 距命中点 261.5（并列先入数组）
    const s3 = makeEnemy(state, 620, 1080, 1e6); // 距命中点 261.5（并列后入数组）
    const s1 = makeEnemy(state, 100, 1000, 1e6); // 距命中点 281.6
    const s4 = makeEnemy(state, 620, 1000, 1e6); // 距命中点 281.6
    const far = makeEnemy(state, 700, 700, 1e6); // 远旁观者
    fireScatter(state, ['split_shot', 'burn_bullet']);

    expect(state.projectiles).toHaveLength(5); // base 5 枚
    const grid = new SpatialHash<Enemy>(64);
    for (let f = 0; f < 80 && state.projectiles.length > 0; f++) {
      updateProjectiles(state, 16, grid);
      state.timeMs += 16;
    }
    // 中央弹命中 main（4 伤）→ 分裂 4 枚次级弹各中 0.8；其余弹丸不命中（几何错开）自然消亡
    expect(state.projectiles).toHaveLength(0);
    expect(main.hp).toBeCloseTo(1e6 - 4, 6);
    expect(s1.hp).toBeCloseTo(1e6 - 0.8, 6);
    expect(s2.hp).toBeCloseTo(1e6 - 0.8, 6);
    expect(s3.hp).toBeCloseTo(1e6 - 0.8, 6);
    expect(s4.hp).toBeCloseTo(1e6 - 0.8, 6);
    expect(far.hp).toBe(1e6);
    // 同弹种：燃烧模板随行（每个被次级弹命中的敌人都挂 burn）
    expect(hasEffect(s1, 'burn')).toBe(true);
  });

  it('未拿分裂牌：命中不分裂（产弹恰 5 枚）', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1100, 1e6);
    const before = state.nextId;
    fireScatter(state, []);
    const grid = new SpatialHash<Enemy>(64);
    for (let f = 0; f < 80 && state.projectiles.length > 0; f++) {
      updateProjectiles(state, 16, grid);
      state.timeMs += 16;
    }
    expect(state.nextId - before).toBe(5);
  });
});

describe('龙息模式互斥（行为侧兜底：多射/连射/分裂全部忽略）', () => {
  it('先拿多射/连射/分裂再拿龙息模式：fire 走锥形（不发弹、不排波）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1100, 1e6); // 锥内
    fireScatter(state, ['multi_shot', 'burst_shot', 'split_shot', 'dragon_breath_mode']);
    expect(state.projectiles).toHaveLength(0); // 不发弹丸
    expect(state.meta[BURST_QUEUE_META_KEY]).toBeUndefined(); // 不排连射波
    expect(e.hp).toBeCloseTo(1e6 - 4, 6); // 锥形直击照常
  });

  it('在途待发波：玩家转龙息后重放波作废（当前牌表兜底短路）', () => {
    const state = createSimState(1);
    fireScatter(state, ['multi_shot', 'burst_shot']); // 首波 6 枚 + 队列 1 波
    expect(state.projectiles).toHaveLength(6);
    state.weaponStates.scatter.cards.dragon_breath_mode = 1; // 转龙息（在途波未重放）
    state.timeMs += 150;
    behavior.update!(state, 16);
    expect(state.projectiles).toHaveLength(6); // 重放波被作废：无新弹
    expect((state.meta[BURST_QUEUE_META_KEY] as BurstWaveEntry[])).toHaveLength(0); // 波已消费（作废）
  });
});

describe('dot 频率（dot_freq 牌，requiresCard=burn_bullet：燃烧 tick 间隔 ÷1.3）', () => {
  it('燃烧模板 tickMs = 500/1.3；命中后效果实例按覆盖节奏跳 DoT', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1100, 1e6);
    fireScatter(state, ['burn_bullet', 'dot_freq']);
    // 弹上模板即带覆盖 tick（4 枚带燃烧模板的弹 + 1 枚分裂无模板? —— 全部 5 枚同模板）
    for (const p of state.projectiles) {
      expect(p.effectsOnHit[0].kind).toBe('burn');
      expect(p.effectsOnHit[0].data.tickMs).toBeCloseTo(500 / 1.3, 9);
    }

    // 端到端：中央弹命中 → 挂 burn（直击 4 伤后首跳 3 伤在 384.6ms）
    const grid = new SpatialHash<Enemy>(64);
    for (let f = 0; f < 12 && state.projectiles.length > 0; f++) {
      updateProjectiles(state, 16, grid);
      state.timeMs += 16;
    }
    expect(hasEffect(e, 'burn')).toBe(true);
    expect(e.effects[0].data.tickMs).toBeCloseTo(500 / 1.3, 9);
    const hpAfterHit = e.hp;
    state.timeMs += 300;
    updateEffects(state, 300);
    expect(e.hp).toBe(hpAfterHit); // 未到 384.6：无跳
    state.timeMs += 84.7;
    updateEffects(state, 84.7);
    expect(e.hp).toBeCloseTo(hpAfterHit - 3, 6); // 首跳（效果表每跳 3）
  });
});
