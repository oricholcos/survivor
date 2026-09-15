// src/core/spatialHash.test.ts —— 均匀空间网格验收测试
// 随机契约：禁用 Math.random，随机序列由确定性 LCG（线性同余）生成，同种子全程可复现。
import { describe, expect, it } from 'vitest';
import { SpatialHash } from './spatialHash';

/** 确定性 LCG（数值分析经典参数，非 Math.random，满足可复现性契约）。 */
function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 被插入的最小测试对象（游戏实体在真实用法中即此形态）。 */
interface Probe {
  x: number;
  y: number;
  r: number;
}

/** 建一个带初始内容的网格的便捷封装。 */
function makeHash(cellSize: number, entries: Array<[Probe, number, number, number?]>): SpatialHash<Probe> {
  const hash = new SpatialHash<Probe>(cellSize);
  for (const [p, x, y, radius] of entries) hash.insert(p, x, y, radius);
  return hash;
}

describe('SpatialHash 均匀空间网格', () => {
  it('构造：cellSize 必须为正有限数', () => {
    expect(() => new SpatialHash<number>(0)).toThrow(RangeError);
    expect(() => new SpatialHash<number>(-10)).toThrow(RangeError);
    expect(() => new SpatialHash<number>(Number.NaN)).toThrow(RangeError);
    expect(() => new SpatialHash<number>(64)).not.toThrow();
  });

  it('基本查询：若干点插入后按圆查询返回正确邻居集合', () => {
    const a: Probe = { x: 10, y: 10, r: 0 };
    const b: Probe = { x: 40, y: 40, r: 0 };
    const c: Probe = { x: 120, y: 100, r: 0 };
    const d: Probe = { x: 300, y: 300, r: 0 };
    const hash = makeHash(50, [
      [a, a.x, a.y],
      [b, b.x, b.y],
      [c, c.x, c.y],
      [d, d.x, d.y],
    ]);

    // 查询 (0,0) r=50：a 距离 ≈14.1 命中；b 距离 ≈56.6 落在同格候选内但被精确过滤排除
    expect(new Set(hash.queryCircle(0, 0, 50))).toEqual(new Set([a]));
    // 查询 (100,100) r=60：c 命中；b 距离 ≈84.9 排除
    expect(new Set(hash.queryCircle(100, 100, 60))).toEqual(new Set([c]));
    // 查询 (50,50) r=20：b 命中
    expect(new Set(hash.queryCircle(50, 50, 20))).toEqual(new Set([b]));
    // 附近无任何对象 → 空
    expect(hash.queryCircle(-500, -500, 30)).toEqual([]);
    // 返回的是 item 本体引用
    const hit = hash.queryCircle(10, 10, 1);
    expect(hit.length).toBe(1);
    expect(hit[0]).toBe(a);
    // 每次查询返回新建数组，互不共享、也不复用内部桶
    expect(hash.queryCircle(10, 10, 1)).not.toBe(hit);
    hit.push(b);
    expect(hash.queryCircle(10, 10, 1).length).toBe(1);
  });

  it('insert 记录 radius：queryCircle 按「圆与圆相交」精确过滤', () => {
    const big: Probe = { x: 5, y: 5, r: 5 };
    const point: Probe = { x: 5, y: 5, r: 0 };
    // 同一位置两个 item：一个半径 5、一个点。查询圆与点距离 10：> 6（不含点）但 <= 11（含大圆）
    const hash = makeHash(10, [
      [big, 5, 5, 5],
      [point, 5, 5],
    ]);
    expect(new Set(hash.queryCircle(15, 5, 6))).toEqual(new Set([big]));
    // 再靠近一点：距离 7 <= 8，点也命中
    expect(new Set(hash.queryCircle(12, 5, 8))).toEqual(new Set([big, point]));
  });

  it('边界用例：恰好相切（dist == r + radius）算相交', () => {
    // 点 item：距离 10 == 查询半径 10
    const p: Probe = { x: 10, y: 0, r: 0 };
    // 圆 item：距离 16 == 12 + 4
    const c: Probe = { x: 16, y: 0, r: 4 };
    const hash = makeHash(10, [
      [p, 10, 0],
      [c, 16, 0, 4],
    ]);
    // r=10：p 恰好相切命中；c 距离 16 > 10 + 4 未命中
    expect(new Set(hash.queryCircle(0, 0, 10))).toEqual(new Set([p]));
    // r=12：p 距离 10 <= 12；c 恰好相切（16 == 12 + 4）
    expect(new Set(hash.queryCircle(0, 0, 12))).toEqual(new Set([p, c]));
  });

  it('边界用例：差一点不相切不算相交', () => {
    const p: Probe = { x: 10, y: 0, r: 0 };
    const c: Probe = { x: 16, y: 0, r: 4 };
    const hash = makeHash(10, [
      [p, 10, 0],
      [c, 16, 0, 4],
    ]);
    // 距离 10 > 9.999999；距离 16 > 9.999999 + 4 → 都不相交
    expect(hash.queryCircle(0, 0, 9.999999)).toEqual([]);
    // c 差一点不相切（16 > 11.999999 + 4）被精确过滤排除；p 在圆内正常返回
    expect(new Set(hash.queryCircle(0, 0, 11.999999))).toEqual(new Set([p]));
    // 查询 (5,8) r=8：p 距离 √89 ≈ 9.43 > 8、c 距离 √185 ≈ 13.6 > 8+4，
    // 且两者格子都在查询覆盖范围内 → 靠精确过滤排除而非格子过滤
    expect(hash.queryCircle(5, 8, 8)).toEqual([]);
  });

  it('边界用例：空网格查询返回空；负半径返回空', () => {
    const hash = new SpatialHash<Probe>(64);
    expect(hash.queryCircle(0, 0, 100)).toEqual([]);
    expect(hash.queryCircle(-1e5, 1e5, 500)).toEqual([]);
    hash.insert({ x: 0, y: 0, r: 0 }, 0, 0);
    expect(hash.queryCircle(0, 0, -5)).toEqual([]);
    expect(hash.queryCircle(Number.NaN, 0, 5)).toEqual([]);
  });

  it('跨格对象不重复返回', () => {
    const a: Probe = { x: 0, y: 0, r: 30 }; // 覆盖 4×4 个格子（cellSize 16）
    const b: Probe = { x: 8, y: 8, r: 24 }; // 与 a 重叠多格
    const hash = makeHash(16, [
      [a, 0, 0, 30],
      [b, 8, 8, 24],
    ]);

    // 大查询圆覆盖 a、b 的全部格子
    const big = hash.queryCircle(0, 0, 50);
    expect(big.length).toBe(2);
    expect(new Set(big)).toEqual(new Set([a, b]));
    expect(new Set(big).size).toBe(big.length); // 无重复

    // 从不同圆心多次查询，覆盖 a/b 跨据的部分格子，均只返回一次
    for (const [qx, qy, qr] of [
      [-20, 0, 10],
      [20, 20, 15],
      [-30, -30, 45],
      [12, -12, 20],
    ] as const) {
      const res = hash.queryCircle(qx, qy, qr);
      expect(new Set(res).size).toBe(res.length);
    }
    // (-20,0) r=10：a 距离 20 <= 40 命中；b 距离 28 > 34? → 28 <= 34 命中
    expect(new Set(hash.queryCircle(-20, 0, 10))).toEqual(new Set([a, b]));
  });

  it('clear 后查询为空、可重新插入', () => {
    const a: Probe = { x: 10, y: 10, r: 0 };
    const b: Probe = { x: 20, y: 20, r: 5 };
    const hash = makeHash(32, [
      [a, 10, 10],
      [b, 20, 20, 5],
    ]);
    expect(hash.queryCircle(15, 15, 20).length).toBe(2);

    hash.clear();
    expect(hash.queryCircle(15, 15, 1000)).toEqual([]);

    // clear 后可重新插入（新对象、新位置）
    const c: Probe = { x: -40, y: 60, r: 0 };
    hash.insert(c, -40, 60);
    expect(new Set(hash.queryCircle(-40, 60, 5))).toEqual(new Set([c]));
    // 旧位置附近查不到任何东西（r=30 不足以触达 (-40,60)，距离 ≈70.7）
    expect(hash.queryCircle(10, 10, 30)).toEqual([]);
  });

  it('按帧 clear + insert 循环复用：100 帧后结果仍与暴力过滤一致', () => {
    const rand = makeLcg(20260913);
    const items: Probe[] = [];
    const hash = new SpatialHash<Probe>(40);
    for (let i = 0; i < 120; i++) {
      const p: Probe = { x: rand() * 800 - 400, y: rand() * 800 - 400, r: rand() * 20 };
      items.push(p);
      hash.insert(p, p.x, p.y, p.r);
    }
    const qx = 30;
    const qy = -10;
    const qr = 90;
    const expected = items.filter((p) => {
      const dx = p.x - qx;
      const dy = p.y - qy;
      const rr = qr + p.r;
      return dx * dx + dy * dy <= rr * rr;
    });

    for (let frame = 0; frame < 100; frame++) {
      hash.clear();
      for (const p of items) hash.insert(p, p.x, p.y, p.r);
    }
    const actual = hash.queryCircle(qx, qy, qr);
    expect(actual.length).toBe(expected.length);
    expect(new Set(actual)).toEqual(new Set(expected));
    expect(new Set(actual).size).toBe(actual.length);
  });

  it('大坐标/负坐标格子索引正确', () => {
    const far: Probe = { x: -5, y: 1300, r: 0 };
    const tiny: Probe = { x: -0.5, y: -0.5, r: 0 }; // 落在 (-1,-1) 格
    const huge: Probe = { x: 50000, y: -80000, r: 10 };
    const neg: Probe = { x: -30, y: -30, r: 0 };
    const hash = makeHash(64, [
      [far, -5, 1300],
      [tiny, -0.5, -0.5],
      [huge, 50000, -80000, 10],
      [neg, -30, -30],
    ]);

    expect(new Set(hash.queryCircle(-5, 1300, 1))).toEqual(new Set([far]));
    expect(hash.queryCircle(100, 1300, 10)).toEqual([]);
    expect(new Set(hash.queryCircle(-1, -1, 1))).toEqual(new Set([tiny]));
    expect(new Set(hash.queryCircle(50000, -80000, 5))).toEqual(new Set([huge]));
    expect(hash.queryCircle(-79990, 50000, 50)).toEqual([]);
    expect(new Set(hash.queryCircle(-25, -25, 10))).toEqual(new Set([neg]));
  });

  it('remove：增量移除后查询不再返回，且幂等、对未插入项安全', () => {
    const a: Probe = { x: 200, y: 200, r: 0 }; // 远离 big，查询区域互不干扰
    const big: Probe = { x: 0, y: 0, r: 25 }; // 跨多格
    const ghost: Probe = { x: 1, y: 1, r: 0 }; // 从未插入
    const hash = makeHash(20, [
      [a, 200, 200],
      [big, 0, 0, 25],
    ]);
    expect(new Set(hash.queryCircle(200, 200, 10))).toEqual(new Set([a]));

    hash.remove(a, 200, 200);
    expect(hash.queryCircle(200, 200, 30)).toEqual([]);
    hash.remove(a, 200, 200); // 幂等：二次移除安全
    hash.remove(ghost, 1, 1); // 从未插入：安全 no-op

    // 跨格 item 移除后，其覆盖的所有格子都查不到
    hash.remove(big, 0, 0, 25);
    for (const [qx, qy] of [
      [0, 0],
      [24, 24],
      [-24, -24],
      [24, -24],
    ] as const) {
      expect(hash.queryCircle(qx, qy, 30)).toEqual([]);
    }

    // remove 后可重新插入（槽位复用路径）
    const a2: Probe = { x: 55, y: 55, r: 0 };
    hash.insert(a2, 55, 55);
    expect(new Set(hash.queryCircle(55, 55, 3))).toEqual(new Set([a2]));
  });

  it('remove：参数与 insert 记录不一致时仍无泄漏（按记录兜底）', () => {
    const a: Probe = { x: 0, y: 0, r: 30 };
    const hash = makeHash(16, [[a, 0, 0, 30]]);
    // 用错误位置/半径移除：不能残留任何格子引用
    hash.remove(a, 500, 500, 1);
    expect(hash.queryCircle(0, 0, 60)).toEqual([]);
    expect(hash.queryCircle(30, 0, 30)).toEqual([]);
    // 兜底后重新插入同对象，位置移动语义正确
    hash.insert(a, 100, 100, 5);
    expect(new Set(hash.queryCircle(100, 100, 10))).toEqual(new Set([a]));
  });

  it('重复 insert 同一 item 视为移动：旧位置不再返回、新位置只返回一次', () => {
    const a: Probe = { x: 10, y: 10, r: 8 };
    const hash = makeHash(20, [[a, 10, 10, 8]]);

    hash.insert(a, 200, 200, 8); // 移动
    expect(hash.queryCircle(10, 10, 100)).toEqual([]);
    const hits = hash.queryCircle(200, 200, 10);
    expect(hits.length).toBe(1);
    expect(hits[0]).toBe(a);
  });

  it('随机一致性：网格查询结果与 O(n²) 暴力精确过滤完全一致（确定性 LCG）', () => {
    const rand = makeLcg(19900707);
    const CELL = 40;
    const hash = new SpatialHash<Probe>(CELL);
    const items: Probe[] = [];
    for (let i = 0; i < 300; i++) {
      const p: Probe = { x: rand() * 1000 - 500, y: rand() * 1000 - 500, r: rand() * 30 };
      items.push(p);
      hash.insert(p, p.x, p.y, p.r);
    }

    for (let q = 0; q < 60; q++) {
      const qx = rand() * 1200 - 600;
      const qy = rand() * 1200 - 600;
      const qr = rand() * 120;
      const actual = hash.queryCircle(qx, qy, qr);
      const expected = items.filter((p) => {
        const dx = p.x - qx;
        const dy = p.y - qy;
        const rr = qr + p.r;
        return dx * dx + dy * dy <= rr * rr;
      });
      // 长度一致（排除漏报与重复）+ 集合一致（排除误报/错引）
      expect(actual.length).toBe(expected.length);
      expect(new Set(actual)).toEqual(new Set(expected));
      expect(new Set(actual).size).toBe(actual.length);
    }
  });
});
