// src/core/enemies.test.ts —— 敌人子系统测试：刷怪字段拷贝/事件入队、行军到墙转攻击、
// 重叠分离与攻击态墙线钳制、同种子可复现、不同速度位移比例。
// 夹具约定：直接构造 EnemyTypeData 字面量与 createSimState，更新时自建 SpatialHash 传入。

import { describe, expect, it } from 'vitest';
import { spawnEnemy, updateEnemies, type EnemyTypeData } from './enemies';
import { drainEvents } from './events';
import { createSimState } from './simState';
import { SpatialHash } from './spatialHash';
import type { Enemy, SimState } from './types';

/** 测试夹具：敌人类型模板（数值仅为本测试服务，可用 overrides 覆盖任意字段）。 */
function makeType(overrides?: Partial<EnemyTypeData>): EnemyTypeData {
  return {
    id: 'testling',
    name: '测试怪',
    shape: 'square',
    color: 0x00ff00,
    hp: 30,
    speed: 60,
    damage: 5,
    attackIntervalMs: 1000,
    xp: 1,
    radius: 12,
    isBoss: false,
    ...overrides,
  };
}

/** 建场景：指定种子，在给定 x 列表各刷一个同类型敌人（x 相同即出生重叠）。 */
function makeState(seed: number, xs: number[], type: EnemyTypeData): SimState {
  const state = createSimState(seed);
  for (const x of xs) {
    spawnEnemy(state, type, x);
  }
  return state;
}

/** 两敌人欧氏距离。 */
function distOf(a: Enemy, b: Enemy): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

describe('spawnEnemy', () => {
  it('字段从 type 拷贝、出生在 spawnLineY、state=march、首攻冷却为一个攻击间隔', () => {
    const state = createSimState(42);
    const type = makeType({
      id: 'grunt',
      name: '小兵',
      shape: 'triangle',
      color: 0x123456,
      hp: 33,
      speed: 70,
      damage: 9,
      attackIntervalMs: 800,
      xp: 4,
      radius: 14,
      isBoss: false,
    });

    const e = spawnEnemy(state, type, 111);

    expect(e.id).toBe(1);
    expect(state.nextId).toBe(2);
    expect(e.typeId).toBe('grunt');
    expect(e.name).toBe('小兵');
    expect(e.x).toBe(111);
    expect(e.y).toBe(state.layout.spawnLineY);
    expect(e.radius).toBe(14);
    expect(e.hp).toBe(33);
    expect(e.maxHp).toBe(33);
    expect(e.speed).toBe(70);
    expect(e.damage).toBe(9);
    expect(e.attackIntervalMs).toBe(800);
    expect(e.attackCooldownMs).toBe(800);
    expect(e.state).toBe('march');
    expect(e.isBoss).toBe(false);
    expect(e.xp).toBe(4);
    expect(e.color).toBe(0x123456);
    expect(e.shape).toBe('triangle');
    expect(e.effects).toEqual([]);
    expect(e.dead).toBe(false);
  });

  it('id 连续自增；enemySpawned 事件按序入队、drain 后清空', () => {
    const state = createSimState(42);
    const grunt = makeType({ id: 'grunt', isBoss: false });
    const boss = makeType({ id: 'boss_x', isBoss: true });

    const e1 = spawnEnemy(state, grunt, 10);
    const e2 = spawnEnemy(state, boss, 20);
    const e3 = spawnEnemy(state, grunt, 30);

    expect(e1.id).toBe(1);
    expect(e2.id).toBe(2);
    expect(e3.id).toBe(3);
    expect(state.nextId).toBe(4);

    expect(drainEvents(state)).toEqual([
      { kind: 'enemySpawned', typeId: 'grunt', isBoss: false },
      { kind: 'enemySpawned', typeId: 'boss_x', isBoss: true },
      { kind: 'enemySpawned', typeId: 'grunt', isBoss: false },
    ]);
    expect(drainEvents(state)).toEqual([]);
  });

  it('传入越界 x 坐标时被安全钳制在 [radius, width - radius]', () => {
    const state = createSimState(42);
    const type = makeType({ radius: 15 });
    const width = state.layout.width;

    const leftOutOfBounds = spawnEnemy(state, type, -50);
    expect(leftOutOfBounds.x).toBe(15);

    const leftTouch = spawnEnemy(state, type, 5);
    expect(leftTouch.x).toBe(15);

    const normal = spawnEnemy(state, type, 200);
    expect(normal.x).toBe(200);

    const rightOutOfBounds = spawnEnemy(state, type, width + 100);
    expect(rightOutOfBounds.x).toBe(width - 15);

    const rightTouch = spawnEnemy(state, type, width - 2);
    expect(rightTouch.x).toBe(width - 15);
  });
});

describe('updateEnemies 行军到墙', () => {
  it('未到墙线保持 march，一帧位移 = speed * dtSec', () => {
    const state = createSimState(7);
    const grid = new SpatialHash<Enemy>(64);
    const e = spawnEnemy(state, makeType({ speed: 100 }), 360);

    // -40 + 100 * (6000/1000) = 560，精确落点
    updateEnemies(state, 6000, grid);

    expect(e.state).toBe('march');
    expect(e.y).toBe(560);
  });

  it('step 到 wallLineY 后转 attack；继续 step 多次 y 坐标不再变化', () => {
    const state = createSimState(7);
    const grid = new SpatialHash<Enemy>(64);
    const e = spawnEnemy(state, makeType({ speed: 100 }), 360);

    // -40 + 100 * (12000/1000) = 1160 = wallLineY，恰好一步精确落线
    updateEnemies(state, 12000, grid);
    expect(e.state).toBe('attack');
    expect(e.y).toBe(state.layout.wallLineY);

    for (let i = 0; i < 5; i++) {
      updateEnemies(state, 1000, grid);
      expect(e.state).toBe('attack');
      expect(e.y).toBe(state.layout.wallLineY);
    }
  });

  it('一步跨过墙线时被钉在 wallLineY，不冲过线', () => {
    const state = createSimState(7);
    const grid = new SpatialHash<Enemy>(64);
    // speed 90、dt 10000ms → 位移 900，落点 -40 + 900 = 860 未到线；
    // 再走一步必越线 → 钉在 1160
    const e = spawnEnemy(state, makeType({ speed: 90 }), 360);
    updateEnemies(state, 10000, grid);
    expect(e.state).toBe('march');
    updateEnemies(state, 10000, grid);
    expect(e.state).toBe('attack');
    expect(e.y).toBe(state.layout.wallLineY);
  });
});

describe('updateEnemies 分离', () => {
  it('同位置重叠敌人一步后明显分离（dist >= 两半径和）', () => {
    const state = createSimState(9);
    const grid = new SpatialHash<Enemy>(64);
    const type = makeType({ speed: 60, radius: 12 });
    spawnEnemy(state, type, 360);
    spawnEnemy(state, type, 360);

    updateEnemies(state, 500, grid);

    const [a, b] = state.enemies;
    const d = distOf(a, b);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeGreaterThanOrEqual(a.radius + b.radius - 1e-9);
  });

  it('攻击态敌人被分离推移后不挤过墙线，上方行军怪被向上推开', () => {
    const state = createSimState(1);
    const grid = new SpatialHash<Enemy>(64);
    const type = makeType({ speed: 60, radius: 12 });

    const a = spawnEnemy(state, type, 360);
    // -40 + 60 * (20000/1000) = 1160：a 先行军到墙转攻击
    updateEnemies(state, 20000, grid);
    expect(a.state).toBe('attack');

    // 夹具：再刷一个并放到 a 正上方制造重叠（仍为 march 态）
    const b = spawnEnemy(state, type, 360);
    b.y = state.layout.wallLineY - 4;

    updateEnemies(state, 16, grid);

    expect(a.y).toBe(state.layout.wallLineY); // a 被向下推但被钳回墙线
    expect(b.y).toBeLessThan(state.layout.wallLineY); // b 被向上推离墙线
  });

  it('多对重叠同帧叠加：三个近距敌人互不重合地散开且确定性收敛', () => {
    const state = createSimState(5);
    const grid = new SpatialHash<Enemy>(64);
    const type = makeType({ speed: 90, radius: 12 });
    spawnEnemy(state, type, 360);
    spawnEnemy(state, type, 360);
    spawnEnemy(state, type, 366);

    for (let i = 0; i < 60; i++) {
      updateEnemies(state, 200, grid);
    }

    const [a, b, c] = state.enemies;
    // 出生重合的一对保持分离
    expect(distOf(a, b)).toBeGreaterThanOrEqual(a.radius + b.radius - 1e-6);
    // 三者两两不再明显重叠
    expect(distOf(a, c)).toBeGreaterThanOrEqual(a.radius + c.radius - 1e-6);
    expect(distOf(b, c)).toBeGreaterThanOrEqual(b.radius + c.radius - 1e-6);
    // 攻击态敌人不越过墙线
    for (const e of state.enemies) {
      if (e.state === 'attack') {
        expect(e.y).toBeLessThanOrEqual(state.layout.wallLineY);
      }
    }
  });

  it('同种子同初始位置多步模拟：最终坐标完全一致（可复现）', () => {
    const type = makeType({ speed: 90, radius: 12 });
    const run = (): SimState => makeState(2024, [360, 360, 366], type);

    const s1 = run();
    const s2 = run();
    const g1 = new SpatialHash<Enemy>(64);
    const g2 = new SpatialHash<Enemy>(64);

    for (let i = 0; i < 120; i++) {
      updateEnemies(s1, 200, g1);
      updateEnemies(s2, 200, g2);
    }

    const snap = (s: SimState): Array<{ x: number; y: number; state: string }> =>
      s.enemies.map((e) => ({ x: e.x, y: e.y, state: e.state }));
    expect(snap(s1)).toEqual(snap(s2));

    // 分离确实发生：三个敌人位置互不相同
    for (let i = 0; i < s1.enemies.length; i++) {
      for (let j = i + 1; j < s1.enemies.length; j++) {
        expect(distOf(s1.enemies[i], s1.enemies[j])).toBeGreaterThan(1e-6);
      }
    }
    // 坐标始终有限
    for (const e of s1.enemies) {
      expect(Number.isFinite(e.x)).toBe(true);
      expect(Number.isFinite(e.y)).toBe(true);
    }
  });

  it('互不干扰的两路敌人各自行军到墙、全部转攻击且钉在墙线上', () => {
    const state = createSimState(11);
    const grid = new SpatialHash<Enemy>(64);
    const type = makeType({ speed: 90, radius: 12 });
    spawnEnemy(state, type, 360);
    spawnEnemy(state, type, 360); // 出生重合的一对
    spawnEnemy(state, type, 100); // 远离的一路

    for (let i = 0; i < 120; i++) {
      updateEnemies(state, 200, grid);
    }

    for (const e of state.enemies) {
      expect(e.state).toBe('attack');
      expect(e.y).toBe(state.layout.wallLineY);
    }
    const [a, b] = state.enemies;
    expect(distOf(a, b)).toBeGreaterThanOrEqual(a.radius + b.radius - 1e-9);
  });

  it('怪群高密度推挤时，所有怪物的 x 坐标依然保持在 [radius, width - radius] 内部，未被挤出屏幕', () => {
    const state = createSimState(99);
    const grid = new SpatialHash<Enemy>(64);
    const radius = 16;
    const type = makeType({ radius, speed: 50 });
    const width = state.layout.width;

    // 在左边缘极度拥挤处刷入 10 只怪（全部集中在左边界 x = radius）
    for (let i = 0; i < 10; i++) {
      spawnEnemy(state, type, radius);
    }
    // 在右边缘极度拥挤处刷入 10 只怪（全部集中在右边界 x = width - radius）
    for (let i = 0; i < 10; i++) {
      spawnEnemy(state, type, width - radius);
    }

    // 持续推挤模拟多步
    for (let step = 0; step < 100; step++) {
      updateEnemies(state, 100, grid);
      for (const e of state.enemies) {
        expect(e.x).toBeGreaterThanOrEqual(e.radius);
        expect(e.x).toBeLessThanOrEqual(width - e.radius);
      }
    }
  });
});

describe('updateEnemies 速度', () => {
  it('不同速度敌人一帧位移与 speed 成正比', () => {
    const state = createSimState(3);
    spawnEnemy(state, makeType({ id: 'slow', speed: 40, radius: 10 }), 120);
    spawnEnemy(state, makeType({ id: 'fast', speed: 120, radius: 10 }), 600);

    const y0 = state.layout.spawnLineY;
    updateEnemies(state, 500, new SpatialHash<Enemy>(64));

    const dSlow = state.enemies[0].y - y0; // 40 * 0.5 = 20
    const dFast = state.enemies[1].y - y0; // 120 * 0.5 = 60
    expect(dSlow).toBeCloseTo(20, 9);
    expect(dFast).toBeCloseTo(60, 9);
    expect(dFast / dSlow).toBeCloseTo(3, 9); // 位移比 = 速度比
  });
});
