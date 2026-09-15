// src/core/projectiles.test.ts —— 弹丸系统行为契约：
// 命中扣血 + hitIds 去重、穿透后继续命中第二个、超穿透上限销毁、击杀事件与 killHooks、
// 对象池复用（弹死后新 spawn 复用同一实例引用）。
import { describe, expect, it } from 'vitest';
import { drainEvents } from './events';
import {
  killHooks,
  pickNearestDistinctEnemies,
  projectilePool,
  spawnProjectile,
  updateProjectiles,
} from './projectiles';
import { createSimState } from './simState';
import { SpatialHash } from './spatialHash';
import type { Enemy, SimState } from './types';

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

describe('updateProjectiles 命中与穿透', () => {
  it('命中扣血；停留原地重复查询不重复扣血（hitIds 去重）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 400, 600, 50);
    const p = spawnProjectile(state, { x: 300, y: 600, vx: 100, vy: 0, damage: 10, pierceLeft: 5, ttlMs: 5000 });

    // dt 1s：x 300 → 400，与敌人（半径 10）圆相交 → 命中
    updateProjectiles(state, 1000, makeGrid());
    expect(e.hp).toBe(40);
    expect(p.dead).toBe(false);
    expect(p.pierceLeft).toBe(4); // 命中一次消耗 1
    expect(p.hitIds).toEqual([e.id]);

    // 原地滞留再查两帧：hitIds 去重，不重复扣血
    updateProjectiles(state, 0, makeGrid());
    updateProjectiles(state, 0, makeGrid());
    expect(e.hp).toBe(40);
    expect(p.pierceLeft).toBe(4);
  });

  it('穿透后继续命中与弹同一直线上的第二个敌人', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 400, 600, 50);
    const e2 = makeEnemy(state, 500, 600, 50);
    const p = spawnProjectile(state, { x: 300, y: 600, vx: 400, vy: 0, damage: 10, pierceLeft: 2, ttlMs: 5000 });

    // 第一帧 x=400：命中 e1，pierceLeft 2→1，弹继续存活
    updateProjectiles(state, 250, makeGrid());
    const activeAfterFirstFrame = projectilePool.activeCount;
    expect(e1.hp).toBe(40);
    expect(e2.hp).toBe(50);
    expect(p.dead).toBe(false);

    // 第二帧 x=500：命中 e2，pierceLeft 1→0 → 弹销毁回池（release 已 reset，观察移除与回池）
    updateProjectiles(state, 250, makeGrid());
    expect(e2.hp).toBe(40);
    expect(state.projectiles.length).toBe(0);
    expect(projectilePool.activeCount).toBe(activeAfterFirstFrame - 1);
  });

  it('超穿透上限销毁：pierce=2 命中 2 个后 dead，不再伤第 3 个', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 400, 600, 50);
    const e2 = makeEnemy(state, 500, 600, 50);
    const e3 = makeEnemy(state, 600, 600, 50);
    spawnProjectile(state, { x: 300, y: 600, vx: 400, vy: 0, damage: 10, pierceLeft: 2, ttlMs: 5000 });

    updateProjectiles(state, 250, makeGrid()); // 命中 e1
    updateProjectiles(state, 250, makeGrid()); // 命中 e2 → pierceLeft 0 → 销毁
    expect(state.projectiles.length).toBe(0); // 已回池移除

    // 第三帧：弹已消失，e3 不受伤
    updateProjectiles(state, 250, makeGrid());
    expect(e1.hp).toBe(40);
    expect(e2.hp).toBe(40);
    expect(e3.hp).toBe(50);
  });
});

describe('击杀结算', () => {
  it('死亡敌人触发 enemyKilled 事件与 killHooks 回调（各恰好一次）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 400, 600, 10);
    const hookedEnemies: Enemy[] = [];
    const hook = (s: SimState, enemy: Enemy): void => {
      hookedEnemies.push(enemy);
      s.meta.hookRan = true;
    };
    killHooks.push(hook);
    try {
      spawnProjectile(state, { x: 300, y: 600, vx: 100, vy: 0, damage: 10, pierceLeft: 5, ttlMs: 5000 });
      updateProjectiles(state, 1000, makeGrid());

      expect(e.dead).toBe(true);
      expect(hookedEnemies).toEqual([e]); // 恰好一次，且拿到敌人引用
      expect(state.meta.hookRan).toBe(true);
      expect(drainEvents(state)).toEqual([
        { kind: 'enemyKilled', enemyId: e.id, typeId: 'tester', x: 400, y: 600, isBoss: false },
      ]);
    } finally {
      const idx = killHooks.indexOf(hook);
      if (idx >= 0) {
        killHooks.splice(idx, 1); // 模块级钩子表：测试后清理，避免跨用例污染
      }
    }
  });
});

describe('对象池复用', () => {
  it('弹死后新 spawn 复用同一实例引用，且字段被清洗/覆盖', () => {
    const state = createSimState(1);
    const pooledBefore = projectilePool.pooledCount; // 池为模块级单例：用相对值断言，不受前序用例影响
    const p1 = spawnProjectile(state, { x: 0, y: 0, vx: 100, vy: 0, ttlMs: 50 });
    const activeBefore = projectilePool.activeCount;

    // dt 100ms > ttl 50ms：寿命到期 → dead → release 回池（release 会 reset 清洗字段，
    // 死亡的可观测信号 = 从场上移除 + 池内空闲数 +1）
    updateProjectiles(state, 100, makeGrid());
    expect(state.projectiles.length).toBe(0);
    expect(projectilePool.pooledCount).toBe(pooledBefore + 1);
    expect(projectilePool.activeCount).toBe(activeBefore - 1);

    const p2 = spawnProjectile(state, {
      behavior: 'reused_bolt',
      x: 5,
      y: 7,
      vx: -50,
      vy: 25,
      damage: 7,
      radius: 9,
      pierceLeft: 3,
      ttlMs: 900,
    });
    expect(p2).toBe(p1); // LIFO：复用同一实例引用
    expect(p2.id).toBe(2); // id 重新分配（state.nextId++）
    expect(p2.behavior).toBe('reused_bolt');
    expect(p2.x).toBe(5);
    expect(p2.vx).toBe(-50);
    expect(p2.damage).toBe(7);
    expect(p2.radius).toBe(9);
    expect(p2.pierceLeft).toBe(3);
    expect(p2.hitIds).toEqual([]); // 复用前已清洗
    expect(p2.dead).toBe(false);
  });
});

describe('pickNearestDistinctEnemies（T5.3b 分裂次级弹目标选取助手）', () => {
  it('最近优先且互不相同：逐轮取当前最近者、选中即排除（平距取数组先出现者）', () => {
    const state = createSimState(1);
    // 距 (500, 800)：a=50、b=100、c=150（数组序 a<b<c）
    const a = makeEnemy(state, 500, 750, 1e6);
    const b = makeEnemy(state, 500, 700, 1e6);
    const c = makeEnemy(state, 500, 650, 1e6);
    const picked = pickNearestDistinctEnemies(state, 500, 800, 3);
    expect(picked).toEqual([a, b, c]); // 严格按距离升序、互不重复

    // 平距裁决：两点同距 → 数组先出现者先选中
    const state2 = createSimState(1);
    const left = makeEnemy(state2, 460, 800, 1e6); // 距 40（先入数组）
    makeEnemy(state2, 540, 800, 1e6); // 距 40（后入数组）
    expect(pickNearestDistinctEnemies(state2, 500, 800, 2)[0]).toBe(left);
  });

  it('maxTargets 截断（4 个候选只取 3 → 3 个）；候选不足 → 有几个取几个', () => {
    const state = createSimState(1);
    const a = makeEnemy(state, 500, 790, 1e6);
    const b = makeEnemy(state, 500, 780, 1e6);
    const c = makeEnemy(state, 500, 770, 1e6);
    makeEnemy(state, 500, 760, 1e6);
    expect(pickNearestDistinctEnemies(state, 500, 800, 3)).toEqual([a, b, c]);

    const few = createSimState(1);
    const x = makeEnemy(few, 500, 790, 1e6);
    expect(pickNearestDistinctEnemies(few, 500, 800, 4)).toEqual([x]); // 1 个候选也要 1 枚次级弹
    expect(pickNearestDistinctEnemies(few, 500, 800, 4)).toHaveLength(1); // 幂等：不改变状态
  });

  it('死者跳过；空场/非法 maxTargets → 空数组', () => {
    const state = createSimState(1);
    const corpse = makeEnemy(state, 500, 790, 1e6);
    corpse.dead = true;
    const alive = makeEnemy(state, 500, 780, 1e6);
    expect(pickNearestDistinctEnemies(state, 500, 800, 4)).toEqual([alive]);

    const empty = createSimState(1);
    expect(pickNearestDistinctEnemies(empty, 500, 800, 4)).toEqual([]);
    expect(pickNearestDistinctEnemies(empty, 500, 800, Number.NaN)).toEqual([]);
    expect(pickNearestDistinctEnemies(empty, 500, 800, -3)).toEqual([]);
  });
});
