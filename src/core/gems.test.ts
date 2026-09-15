// src/core/gems.test.ts —— 经验宝石 / 修复包 / 升级信号的行为契约。
// 覆盖：击杀掉落（宝石字段、概率修复包）→ 追踪飞行（距离单调递减）→ 到达结算
// （加经验 / 回墙血）→ 升级信号（恰好 levelUp、先扣后升、单帧连升）。
import { describe, expect, it } from 'vitest';
import { loadSimConfig } from '../data/config';
import { drainEvents } from './events';
import { onEnemyKilled, updateGems, xpToNext } from './gems';
import { dist } from './math';
import { createSimState } from './simState';
import type { Enemy, Rng } from './types';

/** 构造一个敌人夹具（未覆盖字段取无害占位值，全部数值仅存在于测试夹具）。 */
function makeEnemy(overrides: Partial<Enemy>): Enemy {
  return {
    id: 1,
    typeId: 'tester',
    name: '测试怪',
    x: 0,
    y: 0,
    radius: 12,
    hp: 1,
    maxHp: 1,
    speed: 0,
    damage: 0,
    attackIntervalMs: 1000,
    attackCooldownMs: 1000,
    state: 'march',
    isBoss: false,
    xp: 1,
    color: 0xff0000,
    shape: 'box',
    effects: [],
    dead: false,
    ...overrides,
  };
}

/** 恒返回 0 的确定性 rng stub（结构接口直接赋值）：chance=1 时必掉、chance=0 时必不掉。 */
function zeroRng(): Rng {
  return { next: () => 0, int: () => 0, range: () => 0, pick: (list) => list[0] };
}

describe('src/data/config 加载层', () => {
  it('loadSimConfig 返回 config.json 的数值契约（字段与 SimConfig 一致）', () => {
    expect(loadSimConfig()).toEqual({
      xpBase: 5,
      xpGrowth: 1.4,
      gemFlySpeed: 600,
      dropFlySpeed: 600,
      repairDropChance: 0.02,
      repairHeal: 30,
      wallMaxHp: 3200,
      maxWeaponSlots: 4,
    });
  });
});

describe('xpToNext 经验曲线', () => {
  it('xpBase * xpGrowth^(level-1)，level 从 1 起', () => {
    const state = createSimState(1);
    expect(state.progress.level).toBe(1);
    expect(xpToNext(state)).toBe(5); // 5 * 1.4^0

    state.progress.level = 2;
    expect(xpToNext(state)).toBeCloseTo(7, 10); // 5 * 1.4^1

    state.progress.level = 3;
    expect(xpToNext(state)).toBeCloseTo(9.8, 10); // 5 * 1.4^2

    // 自定义 config：整数曲线精确断言
    const s2 = createSimState(1, { xpBase: 10, xpGrowth: 2 });
    s2.progress.level = 4;
    expect(xpToNext(s2)).toBe(80); // 10 * 2^3
  });
});

describe('onEnemyKilled 击杀掉落', () => {
  it('必掉 1 颗经验宝石：value=敌 xp、位置=敌人位置、speed=config.gemFlySpeed', () => {
    const state = createSimState(1, { repairDropChance: 0 });
    onEnemyKilled(state, makeEnemy({ id: 7, x: 123, y: 456, xp: 9 }));

    expect(state.gems).toHaveLength(1);
    expect(state.drops).toHaveLength(0);
    const gem = state.gems[0];
    expect(gem.id).toBe(1); // nextId 从 1 起自增
    expect(gem.value).toBe(9);
    expect(gem.x).toBe(123);
    expect(gem.y).toBe(456);
    expect(gem.speed).toBe(600);
    expect(gem.dead).toBe(false);
  });

  it('repairDropChance=1 + 恒 0 rng → 必掉修复包，kind/value/speed 取 config', () => {
    const state = createSimState(1, { repairDropChance: 1, repairHeal: 30, dropFlySpeed: 600 });
    state.rng = zeroRng();
    onEnemyKilled(state, makeEnemy({ id: 7, x: 200, y: 500, xp: 3 }));

    expect(state.gems).toHaveLength(1);
    expect(state.drops).toHaveLength(1);
    const drop = state.drops[0];
    expect(drop.id).toBe(2); // 宝石先占 1，修复包占 2
    expect(drop.kind).toBe('repair');
    expect(drop.value).toBe(30);
    expect(drop.speed).toBe(600);
    expect(drop.x).toBe(200);
    expect(drop.y).toBe(500);
    expect(drop.dead).toBe(false);
  });

  it('repairDropChance=0 时绝不掉修复包（rng 恒 0 也不掉）', () => {
    const state = createSimState(1, { repairDropChance: 0 });
    state.rng = zeroRng();
    for (let i = 0; i < 50; i++) {
      onEnemyKilled(state, makeEnemy({ id: i + 1, x: i, y: -i, xp: 1 }));
    }
    expect(state.gems).toHaveLength(50);
    expect(state.drops).toHaveLength(0);
  });
});

describe('宝石飞行与吸收', () => {
  it('完整链路：掉落 → 追踪若干帧 → 到达加经验 → 够升则恰好一个 levelUp 且 xp 结转正确', () => {
    const state = createSimState(1, { repairDropChance: 0 });
    onEnemyKilled(state, makeEnemy({ x: 360, y: 400, xp: 7 }));
    expect(state.gems).toHaveLength(1);
    expect(state.progress.xp).toBe(0);

    // 距离 820px、速度 600px/s → 约 1367ms；100 帧 × 16ms = 1600ms 必到达
    for (let i = 0; i < 100; i++) {
      updateGems(state, 16);
    }

    expect(state.gems).toHaveLength(0); // 到达即移出数组
    // level1 需 5：7 → 先扣后升 level=2，结转 7-5=2
    expect(state.progress.level).toBe(2);
    expect(state.progress.xp).toBe(2);
    expect(drainEvents(state)).toEqual([{ kind: 'levelUp', level: 2 }]);
  });

  it('宝石朝角色飞行：帧间距离严格递减，未到达不加经验、不升级', () => {
    const state = createSimState(1, { repairDropChance: 0 });
    onEnemyKilled(state, makeEnemy({ x: 100, y: 300, xp: 1 }));
    const gem = state.gems[0];

    let prev = dist(gem, state.character);
    expect(prev).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) {
      updateGems(state, 16);
      const cur = dist(gem, state.character);
      expect(cur).toBeLessThan(prev);
      prev = cur;
    }

    // 10 帧只走了约 96px：仍在途中
    expect(state.gems).toHaveLength(1);
    expect(state.progress.xp).toBe(0);
    expect(state.progress.level).toBe(1);
    expect(drainEvents(state)).toEqual([]);
  });

  it('大 dt 单帧：一步吸附到达（不越过目标），xp 恰好加一次', () => {
    const state = createSimState(1, { repairDropChance: 0 });
    onEnemyKilled(state, makeEnemy({ x: 100, y: 300, xp: 1 }));

    updateGems(state, 2000); // 步长 1200px ≥ 距离约 956px → 同帧到达

    expect(state.gems).toHaveLength(0);
    expect(state.progress.xp).toBe(1);
    expect(state.progress.level).toBe(1); // 1 < 5 不升级
    expect(drainEvents(state)).toEqual([]);
  });

  it('同帧多颗宝石到账：xp 合并结算，帧末统一做一次升级判定', () => {
    const state = createSimState(1, { repairDropChance: 0 });
    onEnemyKilled(state, makeEnemy({ id: 1, x: 360, y: 100, xp: 3 }));
    onEnemyKilled(state, makeEnemy({ id: 2, x: 360, y: 110, xp: 3 }));

    updateGems(state, 5000); // 两颗同帧到达：合计 6 ≥ 5 → 恰好升一级、结转 1

    expect(state.gems).toHaveLength(0);
    expect(state.progress.level).toBe(2);
    expect(state.progress.xp).toBe(1);
    expect(drainEvents(state)).toEqual([{ kind: 'levelUp', level: 2 }]);
  });

  it('一次到达连升两级：先扣后升、事件逐级入队、xp 结转正确', () => {
    const state = createSimState(1); // 默认曲线：level1 需 5、level2 需 5*1.4≈7
    onEnemyKilled(state, makeEnemy({ x: 360, y: 400, xp: 13 }));

    updateGems(state, 2000); // 大 dt 同帧到达

    expect(state.gems).toHaveLength(0);
    // 13-5=8 ≥ 7 → 连升到 level3，结转约 1
    expect(state.progress.level).toBe(3);
    expect(state.progress.xp).toBeCloseTo(1, 10);
    expect(drainEvents(state)).toEqual([
      { kind: 'levelUp', level: 2 },
      { kind: 'levelUp', level: 3 },
    ]);
  });

  it('整数曲线下的精确连升：15 xp 一次到达升到 level3、结转恰为 0', () => {
    const state = createSimState(1, { xpBase: 5, xpGrowth: 2 }); // 需求 5 / 10 / 20
    onEnemyKilled(state, makeEnemy({ x: 360, y: 400, xp: 15 }));

    updateGems(state, 2000);

    expect(state.progress.level).toBe(3); // 15-5=10 ≥ 10 → 再升一级
    expect(state.progress.xp).toBe(0);
    expect(drainEvents(state)).toEqual([
      { kind: 'levelUp', level: 2 },
      { kind: 'levelUp', level: 3 },
    ]);
  });
});

describe('修复包飞行与修复', () => {
  it('修复包链路：掉落 → 朝墙线中点飞行（距离递减）→ 到达回血且移出数组', () => {
    const state = createSimState(1, { repairDropChance: 1, repairHeal: 30 });
    state.rng = zeroRng();
    state.wall.hp = 500;
    onEnemyKilled(state, makeEnemy({ x: 200, y: 500, xp: 1 }));
    expect(state.drops).toHaveLength(1);

    // 修复包目标 = (width/2, wallLineY) = (360, 1160)：首帧即朝目标递减
    const target = { x: 360, y: 1160 };
    const drop = state.drops[0];
    const prev = dist(drop, target);
    updateGems(state, 16);
    expect(dist(drop, target)).toBeLessThan(prev);

    // 剩余约 670px、速度 600px/s → 约 1116ms；80 帧共 1280ms 必到达
    for (let i = 0; i < 80; i++) {
      updateGems(state, 16);
    }
    expect(state.drops).toHaveLength(0);
    expect(state.wall.hp).toBe(530); // 500 + repairHeal 30
  });

  it('回复不超过 maxHp：接近满血时钳到上限', () => {
    const state = createSimState(1, { repairDropChance: 1, repairHeal: 30, wallMaxHp: 1000 });
    state.rng = zeroRng();
    state.wall.hp = 990;
    onEnemyKilled(state, makeEnemy({ x: 360, y: 1000, xp: 1 }));

    updateGems(state, 5000); // 大 dt 同帧到达

    expect(state.drops).toHaveLength(0);
    expect(state.wall.hp).toBe(1000); // min(1000, 990+30)
  });
});

describe('updateGems 防重入', () => {
  it('state.over 非 null：停摆（宝石不动、不结算、无事件）', () => {
    const state = createSimState(1, { repairDropChance: 0 });
    onEnemyKilled(state, makeEnemy({ x: 100, y: 300, xp: 1 }));
    state.over = 'defeat';

    updateGems(state, 16);

    expect(state.gems).toHaveLength(1);
    expect(state.gems[0].x).toBe(100);
    expect(state.gems[0].y).toBe(300);
    expect(state.progress.xp).toBe(0);
    expect(drainEvents(state)).toEqual([]);
  });
});
