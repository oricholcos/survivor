// src/core/rng.test.ts —— 种子 RNG 验收测试
import { describe, expect, it } from 'vitest';
import { createRng } from './rng';

describe('createRng（mulberry32 种子 RNG）', () => {
  it('同种子两次实例化产出完全相同的序列（逐值断言）', () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA: number[] = [];
    const seqB: number[] = [];
    for (let i = 0; i < 64; i++) {
      seqA.push(a.next());
      seqB.push(b.next());
    }
    expect(seqA).toEqual(seqB);

    // 逐值严格断言（toBe，Object.is 精确比较）
    const c = createRng(42);
    for (let i = 0; i < 64; i++) {
      expect(c.next()).toBe(seqA[i]);
    }
  });

  it('不同种子产出不同序列', () => {
    const a = createRng(1);
    const b = createRng(2);
    let differ = false;
    for (let i = 0; i < 32; i++) {
      if (a.next() !== b.next()) {
        differ = true;
        break;
      }
    }
    expect(differ).toBe(true);
  });

  it('seed=0 正常工作：确定、非退化、落在 [0,1)', () => {
    const a = createRng(0);
    const b = createRng(0);
    const s1: number[] = [];
    const s2: number[] = [];
    for (let i = 0; i < 16; i++) {
      s1.push(a.next());
      s2.push(b.next());
    }
    expect(s1).toEqual(s2);
    // 非退化：不是全 0，也不是常数序列
    expect(s1.some((v) => v !== 0)).toBe(true);
    expect(new Set(s1).size).toBeGreaterThan(1);
    for (const v of s1) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('next() 恒在 [0,1)（大样本）', () => {
    const rng = createRng(2024);
    for (let i = 0; i < 10000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('int(1) 恒为 0', () => {
    const rng = createRng(7);
    for (let i = 0; i < 1000; i++) {
      expect(rng.int(1)).toBe(0);
    }
  });

  it('int(maxExclusive) 产出 [0, maxExclusive) 内的整数并覆盖到上边界', () => {
    const rng = createRng(7);
    for (let i = 0; i < 2000; i++) {
      const v = rng.int(5);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(5);
    }
    // 足够多样本应覆盖 0..max-1 全部取值
    const rng2 = createRng(99);
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      seen.add(rng2.int(3));
    }
    expect([...seen].sort((x, y) => x - y)).toEqual([0, 1, 2]);
  });

  it('int(maxExclusive <= 0) 恒为 0（明确约定，不抛错）', () => {
    const rng = createRng(3);
    expect(rng.int(0)).toBe(0);
    expect(rng.int(-5)).toBe(0);
  });

  it('range(min, max) 产出 [min, max) 浮点', () => {
    const rng = createRng(11);
    for (let i = 0; i < 2000; i++) {
      const v = rng.range(-2.5, 3.5);
      expect(v).toBeGreaterThanOrEqual(-2.5);
      expect(v).toBeLessThan(3.5);
    }
  });

  it('range(min, min) 恒返回 min', () => {
    const rng = createRng(11);
    for (let i = 0; i < 100; i++) {
      expect(rng.range(4, 4)).toBe(4);
    }
  });

  it('pick 返回列表中的元素', () => {
    const rng = createRng(5);
    const list = ['a', 'b', 'c'] as const;
    for (let i = 0; i < 500; i++) {
      expect(list).toContain(rng.pick(list));
    }
  });

  it('pick 单元素列表恒返回该元素', () => {
    const rng = createRng(5);
    for (let i = 0; i < 100; i++) {
      expect(rng.pick([42])).toBe(42);
    }
  });

  it('pick 空数组抛错（明确约定）', () => {
    const rng = createRng(5);
    expect(() => rng.pick([])).toThrowError(/空数组/);
  });

  it('混合调用 next/int/range/pick 的完整序列也可复现', () => {
    const run = (): unknown[] => {
      const rng = createRng(123);
      const out: unknown[] = [];
      out.push(rng.next());
      out.push(rng.int(10));
      out.push(rng.range(-1, 1));
      out.push(rng.pick([1, 2, 3, 4]));
      out.push(rng.next());
      return out;
    };
    expect(run()).toEqual(run());
  });
});
