// src/core/gems.test.ts —— 经验结算 / 修复包 / 升级信号的行为契约。
// 覆盖：击杀即时结算经验（无 Gem 实体直接加 xp、升级信号、先扣后升、单帧连升）→
// 修复包掉落（概率掉落、朝墙线飞行、到达回血）。
import { describe, expect, it } from 'vitest';
import { loadSimConfig } from '../data/config';
import { drainEvents } from './events';
import { checkLevelUp, onEnemyKilled, updateGems, xpToNext } from './gems';
import { dist } from './math';
import { createSimState } from './simState';
import { WAVE_CLOCK_META_KEY } from './waves';
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
      xpTier1Step: 4,
      xpTier2Step: 8,
      gemFlySpeed: 600,
      dropFlySpeed: 600,
      repairDropChance: 0.02,
      repairHeal: 30,
      wallMaxHp: 1600,
      maxWeaponSlots: 4,
      maxProjectiles: 600,
      maxEnemies: 350,
    });
  });
});

describe('xpToNext 经验曲线', () => {
  it('两段线性递增且 40 级后无限延续：Lv.1=5, Lv.10=41, Lv.11=49, Lv.40=281, Lv.41=289, Lv.42=297', () => {
    const state = createSimState(1);
    expect(state.progress.level).toBe(1);
    expect(xpToNext(state)).toBe(5); // Lv.1

    state.progress.level = 2;
    expect(xpToNext(state)).toBe(9); // Lv.2

    state.progress.level = 10;
    expect(xpToNext(state)).toBe(41); // Lv.10

    state.progress.level = 11;
    expect(xpToNext(state)).toBe(49); // Lv.11

    state.progress.level = 40;
    expect(xpToNext(state)).toBe(281); // Lv.40 = 41 + 30*8

    state.progress.level = 41;
    expect(xpToNext(state)).toBe(289); // Lv.41：第二段曲线继续（无平顶）

    state.progress.level = 42;
    expect(xpToNext(state)).toBe(297); // Lv.42：每级再 +8

    state.progress.level = 100;
    expect(xpToNext(state)).toBe(761); // Lv.100：41 + 90*8，曲线无限延续

    // 旧指数配置回退：若显式配置 xpGrowth 且 xpTier1Step 为 undefined
    const s2 = createSimState(1, { xpBase: 10, xpGrowth: 2, xpTier1Step: undefined as unknown as number });
    s2.progress.level = 4;
    expect(xpToNext(s2)).toBe(80); // 10 * 2^3
  });

  it('meta 存波次时钟时按 loopScale 缩放（无尽需求膨胀），loopScale=1 数值不变', () => {
    const state = createSimState(1);
    state.progress.level = 40;
    expect(xpToNext(state)).toBe(281); // 无 meta 基线

    state.meta[WAVE_CLOCK_META_KEY] = { timelineSec: 560, loopCount: 0, loopScale: 1 };
    expect(xpToNext(state)).toBe(281); // loopScale=1：通关模式数值完全不变

    state.meta[WAVE_CLOCK_META_KEY] = { timelineSec: 560, loopCount: 1, loopScale: 2 };
    expect(xpToNext(state)).toBe(562); // 281 * 2（第 1 轮循环）

    state.meta[WAVE_CLOCK_META_KEY] = { timelineSec: 560, loopCount: 3, loopScale: 8 };
    expect(xpToNext(state)).toBe(2248); // 281 * 8（第 3 轮循环）

    state.progress.level = 5;
    expect(xpToNext(state)).toBe(168); // Lv.1 段同样缩放：(5 + 4*4) * 8
  });

  it('脏 loopScale（非有限 / <= 0）防御回退 1', () => {
    const state = createSimState(1);
    state.progress.level = 11;
    const need = 49; // 41 + 1*8

    state.meta[WAVE_CLOCK_META_KEY] = { timelineSec: 10, loopCount: 0, loopScale: Number.NaN };
    expect(xpToNext(state)).toBe(need);

    state.meta[WAVE_CLOCK_META_KEY] = { timelineSec: 10, loopCount: 0, loopScale: Number.POSITIVE_INFINITY };
    expect(xpToNext(state)).toBe(need);

    state.meta[WAVE_CLOCK_META_KEY] = { timelineSec: 10, loopCount: 0, loopScale: 0 };
    expect(xpToNext(state)).toBe(need);

    state.meta[WAVE_CLOCK_META_KEY] = { timelineSec: 10, loopCount: 0, loopScale: -2 };
    expect(xpToNext(state)).toBe(need);
  });
});

describe('onEnemyKilled 击杀掉落与经验结算', () => {
  it('直接增加经验且 gems 为空：progress.xp 立即增加并产生 levelUp 事件，不产生 Gem 实体', () => {
    const state = createSimState(1, { repairDropChance: 0 });
    onEnemyKilled(state, makeEnemy({ id: 7, x: 123, y: 456, xp: 9 }));

    expect(state.gems).toHaveLength(0);
    expect(state.drops).toHaveLength(0);
    // level1 需 5：9 xp 直接到账并升级，结转 9-5=4
    expect(state.progress.level).toBe(2);
    expect(state.progress.xp).toBe(4);
    expect(drainEvents(state)).toEqual([{ kind: 'levelUp', level: 2 }]);
  });

  it('repairDropChance=1 + 恒 0 rng → 必掉修复包，kind/value/speed 取 config', () => {
    const state = createSimState(1, { repairDropChance: 1, repairHeal: 30, dropFlySpeed: 600 });
    state.rng = zeroRng();
    onEnemyKilled(state, makeEnemy({ id: 7, x: 200, y: 500, xp: 3 }));

    expect(state.gems).toHaveLength(0);
    expect(state.drops).toHaveLength(1);
    const drop = state.drops[0];
    expect(drop.id).toBe(1);
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
    expect(state.gems).toHaveLength(0);
    expect(state.drops).toHaveLength(0);
    // 50 点经验已自动升级并累积
    expect(state.progress.level).toBeGreaterThan(1);
  });
});

describe('击杀经验即时结算与升级信号', () => {
  it('击杀敌人：xp 立即到账，够升则恰好一个 levelUp 且 xp 结转正确，gems 始终为空', () => {
    const state = createSimState(1, { repairDropChance: 0 });
    onEnemyKilled(state, makeEnemy({ x: 360, y: 400, xp: 7 }));
    expect(state.gems).toHaveLength(0);
    // level1 需 5：7 → 先扣后升 level=2，结转 7-5=2
    expect(state.progress.level).toBe(2);
    expect(state.progress.xp).toBe(2);
    expect(drainEvents(state)).toEqual([{ kind: 'levelUp', level: 2 }]);
  });

  it('未达到升级所需经验：经验累加但不触发 levelUp', () => {
    const state = createSimState(1, { repairDropChance: 0 });
    onEnemyKilled(state, makeEnemy({ x: 100, y: 300, xp: 1 }));
    expect(state.gems).toHaveLength(0);
    expect(state.progress.xp).toBe(1);
    expect(state.progress.level).toBe(1);
    expect(drainEvents(state)).toEqual([]);
  });

  it('多次击杀经验累积：逐步累加并在满足条件时升级', () => {
    const state = createSimState(1, { repairDropChance: 0 });
    onEnemyKilled(state, makeEnemy({ id: 1, x: 360, y: 100, xp: 3 }));
    expect(state.progress.xp).toBe(3);
    expect(state.progress.level).toBe(1);
    expect(drainEvents(state)).toEqual([]);

    onEnemyKilled(state, makeEnemy({ id: 2, x: 360, y: 110, xp: 3 }));
    // 合计 6 ≥ 5 → 恰好升一级、结转 1
    expect(state.gems).toHaveLength(0);
    expect(state.progress.level).toBe(2);
    expect(state.progress.xp).toBe(1);
    expect(drainEvents(state)).toEqual([{ kind: 'levelUp', level: 2 }]);
  });

  it('一次击杀大额经验连升两级：先扣后升、事件逐级入队、xp 结转正确', () => {
    const state = createSimState(1); // 默认曲线：level1 需 5、level2 需 9
    onEnemyKilled(state, makeEnemy({ x: 360, y: 400, xp: 16 }));

    expect(state.gems).toHaveLength(0);
    // 16-5=11 ≥ 9 → 连升到 level3，结转 2
    expect(state.progress.level).toBe(3);
    expect(state.progress.xp).toBe(2);
    expect(drainEvents(state)).toEqual([
      { kind: 'levelUp', level: 2 },
      { kind: 'levelUp', level: 3 },
    ]);
  });

  it('默认曲线下的精确连升：14 xp 一次击杀升到 level3、结转恰为 0', () => {
    const state = createSimState(1); // 需求 5 + 9 = 14
    onEnemyKilled(state, makeEnemy({ x: 360, y: 400, xp: 14 }));

    expect(state.progress.level).toBe(3); // 14-5=9 ≥ 9 → 再升一级
    expect(state.progress.xp).toBe(0);
    expect(drainEvents(state)).toEqual([
      { kind: 'levelUp', level: 2 },
      { kind: 'levelUp', level: 3 },
    ]);
  });

  it('checkLevelUp 独立调用支持兜底升级', () => {
    const state = createSimState(1);
    state.progress.xp = 10;
    checkLevelUp(state);
    expect(state.progress.level).toBe(2);
    expect(state.progress.xp).toBe(5); // 10 - 5 = 5 (< 9)
    expect(drainEvents(state)).toEqual([{ kind: 'levelUp', level: 2 }]);
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
  it('state.over 非 null：停摆（修复包不动、不结算）', () => {
    const state = createSimState(1, { repairDropChance: 1, repairHeal: 30 });
    state.rng = zeroRng();
    onEnemyKilled(state, makeEnemy({ x: 200, y: 500, xp: 1 }));
    expect(state.drops).toHaveLength(1);
    state.over = 'defeat';

    updateGems(state, 16);

    expect(state.drops).toHaveLength(1);
    expect(state.drops[0].x).toBe(200);
    expect(state.drops[0].y).toBe(500);
    expect(state.wall.hp).toBe(state.config.wallMaxHp);
    expect(drainEvents(state)).toEqual([]);
  });
});
