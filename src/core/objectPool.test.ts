// src/core/objectPool.test.ts —— 泛型对象池验收测试
// 随机契约：禁用 Math.random，混合压测的随机序列由确定性 LCG（线性同余）生成，同种子全程可复现。
import { describe, expect, it } from 'vitest';
import { Pool } from './objectPool';

/** 确定性 LCG（与 spatialHash.test.ts 同参数，非 Math.random，满足可复现性契约）。 */
function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 简单计数实体 + 配套池：factory / reset 都带调用计数，供断言「工厂只在池空时调用」等约定。 */
function makeCountedPool(initial?: number) {
  let created = 0;
  let resets = 0;
  const pool = new Pool<{ n: number }>({
    factory: () => {
      created += 1;
      return { n: created };
    },
    reset: (o) => {
      resets += 1;
      o.n = -1;
    },
    initial,
  });
  return {
    pool,
    get created(): number {
      return created;
    },
    get resets(): number {
      return resets;
    },
  };
}

/** 带多个可变字段的测试实体（脏状态清洗的观察对象）。 */
interface Bullet {
  x: number;
  y: number;
  hp: number;
  alive: boolean;
}

const BULLET_DEFAULTS = { x: 0, y: 0, hp: 3, alive: false } as const;

function makeBulletPool(initial = 0): Pool<Bullet> {
  return new Pool<Bullet>({
    factory: () => ({ ...BULLET_DEFAULTS }),
    reset: (b) => {
      b.x = BULLET_DEFAULTS.x;
      b.y = BULLET_DEFAULTS.y;
      b.hp = BULLET_DEFAULTS.hp;
      b.alive = BULLET_DEFAULTS.alive;
    },
    initial,
  });
}

describe('Pool 泛型对象池', () => {
  it('构造与预热：initial 只调用 factory initial 次，实例全部停在池内', () => {
    const { pool, created, resets } = makeCountedPool(5);
    expect(created).toBe(5);
    expect(resets).toBe(0); // 预热不经 reset（工厂产出即干净态）
    expect(pool.pooledCount).toBe(5);
    expect(pool.activeCount).toBe(0);
  });

  it('构造校验：factory / reset 必须是函数；initial 必须为非负整数', () => {
    const okFactory = (): { n: number } => ({ n: 0 });
    const okReset = (o: { n: number }): void => {
      o.n = 0;
    };
    const badFactory = undefined as unknown as () => { n: number };
    const badReset = undefined as unknown as (o: { n: number }) => void;

    expect(() => new Pool({ factory: badFactory, reset: okReset })).toThrow(TypeError);
    expect(() => new Pool({ factory: okFactory, reset: badReset })).toThrow(TypeError);
    expect(() => new Pool({ factory: okFactory, reset: okReset, initial: -1 })).toThrow(RangeError);
    expect(() => new Pool({ factory: okFactory, reset: okReset, initial: 2.5 })).toThrow(RangeError);
    expect(() => new Pool({ factory: okFactory, reset: okReset, initial: Number.NaN })).toThrow(RangeError);
    expect(() => new Pool({ factory: okFactory, reset: okReset, initial: Number.POSITIVE_INFINITY })).toThrow(
      RangeError,
    );
    expect(() => new Pool({ factory: okFactory, reset: okReset, initial: 0 })).not.toThrow();
    expect(() => new Pool({ factory: okFactory, reset: okReset })).not.toThrow();
  });

  it('acquire 优先复用：预热充足时工厂零调用；池空后才新建', () => {
    const h = makeCountedPool(2);
    expect(h.created).toBe(2);

    h.pool.acquire();
    h.pool.acquire();
    expect(h.created).toBe(2); // 全部复用预热实例
    expect(h.pool.pooledCount).toBe(0);
    expect(h.pool.activeCount).toBe(2);

    h.pool.acquire(); // 池空 → 唯一允许的新建路径
    expect(h.created).toBe(3);
    expect(h.pool.activeCount).toBe(3);
  });

  it('工厂只在池空时调用：调用次数完全可预测', () => {
    const h = makeCountedPool();
    const a = h.pool.acquire(); // 空池 → 新建
    const b = h.pool.acquire(); // 空池 → 新建
    expect(h.created).toBe(2);

    h.pool.release(a);
    h.pool.release(b);
    h.pool.acquire(); // 有空闲 → 复用
    h.pool.acquire(); // 有空闲 → 复用
    expect(h.created).toBe(2);

    h.pool.acquire(); // 又空 → 新建 1 个
    expect(h.created).toBe(3);
  });

  it('循环 acquire/release：复用同一实例（引用相等），工厂只在首次调用', () => {
    const h = makeCountedPool();
    const first = h.pool.acquire();
    expect(h.created).toBe(1);

    h.pool.release(first);
    expect(h.pool.pooledCount).toBe(1);
    expect(h.pool.activeCount).toBe(0);

    const second = h.pool.acquire();
    expect(second).toBe(first); // 引用相等：复用而非新建
    expect(h.created).toBe(1);
  });

  it('多实例循环：release 后再 acquire 复用同一批实例（引用相等），工厂不增长', () => {
    const h = makeCountedPool();
    const round1 = [h.pool.acquire(), h.pool.acquire(), h.pool.acquire()];
    expect(h.created).toBe(3);
    expect(new Set(round1).size).toBe(3); // 在场实例互不相同（不会把同一实例发两份）

    for (const o of round1) h.pool.release(o);
    expect(h.pool.pooledCount).toBe(3);
    expect(h.pool.activeCount).toBe(0);

    const round2 = [h.pool.acquire(), h.pool.acquire(), h.pool.acquire()];
    expect(h.created).toBe(3); // 零新建
    for (const o of round2) expect(round1).toContain(o); // 同一批实例（引用比较）
    expect(h.pool.pooledCount).toBe(0);
    expect(h.pool.activeCount).toBe(3);
  });

  it('LIFO 出池（锁定约定）：最后归还的最先被复用，缓存友好', () => {
    const { pool } = makeCountedPool();
    const a = pool.acquire();
    const b = pool.acquire();
    const c = pool.acquire();
    pool.release(a);
    pool.release(b);
    pool.release(c);

    expect(pool.acquire()).toBe(c);
    expect(pool.acquire()).toBe(b);
    expect(pool.acquire()).toBe(a);
    expect(pool.activeCount).toBe(3);
    expect(pool.pooledCount).toBe(0);
  });

  it('activeCount / pooledCount 随 acquire/release 精确变化', () => {
    const { pool } = makeCountedPool();
    const a = pool.acquire();
    expect(pool.activeCount).toBe(1);
    expect(pool.pooledCount).toBe(0);

    const b = pool.acquire();
    expect(pool.activeCount).toBe(2);

    pool.release(a);
    expect(pool.activeCount).toBe(1);
    expect(pool.pooledCount).toBe(1);

    pool.release(b);
    expect(pool.activeCount).toBe(0);
    expect(pool.pooledCount).toBe(2);

    pool.acquire();
    expect(pool.activeCount).toBe(1);
    expect(pool.pooledCount).toBe(1);
  });

  it('reset 生效：release 后池内实例立即被清洗，再 acquire 无脏状态残留', () => {
    const pool = makeBulletPool();
    const b = pool.acquire();
    expect(b).toEqual(BULLET_DEFAULTS); // 新建即默认态

    b.x = 999;
    b.y = -5;
    b.hp = 0;
    b.alive = true; // 制造脏状态

    pool.release(b);
    expect(b).toEqual(BULLET_DEFAULTS); // 验收点：release 后 reset 已生效，无脏状态残留

    const b2 = pool.acquire();
    expect(b2).toBe(b); // 复用同一实例
    expect(b2).toEqual(BULLET_DEFAULTS); // 脏状态不会泄漏给下一个使用者
  });

  it('reset 时机：release 恰好执行一次；新建不经 reset；复用出池不重复执行', () => {
    const h = makeCountedPool();
    const a = h.pool.acquire(); // 新建
    expect(h.resets).toBe(0);

    h.pool.release(a);
    expect(h.resets).toBe(1);

    h.pool.acquire(); // 复用：release 时已清洗，出池不再重复 reset
    expect(h.resets).toBe(1);

    h.pool.release(a);
    expect(h.resets).toBe(2);
  });

  it('重复 release 同一对象：明确抛错（锁定约定），不会二次入池、计数不受污染', () => {
    const h = makeCountedPool();
    const a = h.pool.acquire();
    h.pool.release(a);
    expect(h.pool.pooledCount).toBe(1);
    expect(h.pool.activeCount).toBe(0);

    expect(() => h.pool.release(a)).toThrowError(/重复归还|外来源/);
    expect(h.pool.pooledCount).toBe(1); // 没有二次入池
    expect(h.pool.activeCount).toBe(0);
    expect(h.created).toBe(1);
  });

  it('release 非本池对象：明确抛错，两池状态都不变；属主池仍可正常归还', () => {
    const a = makeCountedPool();
    const b = makeCountedPool();

    const neverAcquired = { n: 42 }; // 从未经过任何池
    expect(() => a.pool.release(neverAcquired)).toThrowError(/重复归还|外来源/);

    const held = b.pool.acquire();
    expect(() => a.pool.release(held)).toThrowError(/重复归还|外来源/); // 其他池的对象

    expect(a.pool.activeCount).toBe(0);
    expect(a.pool.pooledCount).toBe(0);
    expect(b.pool.activeCount).toBe(1); // B 的在外状态没有被误伤

    expect(() => b.pool.release(held)).not.toThrow(); // 仍可正常归还给属主池
    expect(b.pool.pooledCount).toBe(1);
    expect(b.pool.activeCount).toBe(0);
  });

  it('池不无限增长：大量 acquire 后全部 release，pooledCount 收敛到峰值且工厂调用数恒定', () => {
    const h = makeCountedPool();
    const pool = h.pool;
    const N = 10_000;

    const batch: Array<{ n: number }> = [];
    for (let i = 0; i < N; i++) batch.push(pool.acquire());
    expect(pool.activeCount).toBe(N);
    expect(h.created).toBe(N); // 池空 → 每次都新建

    for (const o of batch) pool.release(o);
    expect(pool.activeCount).toBe(0);
    expect(pool.pooledCount).toBe(N); // 收敛到峰值 N

    // 再跑两轮完整循环：零新建、池大小不变 → 收敛，不会无限增长
    for (let round = 0; round < 2; round++) {
      const batch2: Array<{ n: number }> = [];
      for (let i = 0; i < N; i++) batch2.push(pool.acquire());
      expect(h.created).toBe(N); // 全程复用，工厂零新调用
      expect(pool.activeCount).toBe(N);
      expect(pool.pooledCount).toBe(0);
      for (const o of batch2) pool.release(o);
      expect(pool.pooledCount).toBe(N);
    }

    // 部分归还场景：池容量收敛到「当前在场峰值」，也不单调增长
    const live: Array<{ n: number }> = [];
    for (let i = 0; i < N; i++) live.push(pool.acquire());
    for (let i = 0; i < N / 2; i++) pool.release(live[i]);
    expect(pool.pooledCount).toBe(N / 2);
    for (let i = N / 2; i < N; i++) pool.release(live[i]);
    expect(pool.pooledCount).toBe(N);
    expect(h.created).toBe(N);
  });

  it('确定性混合压测：acquire 永不发放在场实例；activeCount + pooledCount === 工厂累计创建数', () => {
    const rng = makeLcg(20260913);
    const h = makeCountedPool();
    const pool = h.pool;
    const live = new Set<{ n: number }>();

    for (let i = 0; i < 5000; i++) {
      if (rng() < 0.55 || live.size === 0) {
        const o = pool.acquire();
        expect(live.has(o)).toBe(false); // 复用只可能来自空闲池，绝不会发放在场实例
        live.add(o);
      } else {
        const victim = [...live][0];
        live.delete(victim);
        pool.release(victim);
      }
      expect(pool.activeCount).toBe(live.size);
      expect(pool.activeCount + pool.pooledCount).toBe(h.created); // 不变量
    }

    for (const o of live) pool.release(o);
    expect(pool.activeCount).toBe(0);
    expect(pool.pooledCount).toBe(h.created); // 全部收敛进池
  });
});
