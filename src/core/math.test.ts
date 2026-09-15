// src/core/math.test.ts —— 向量/几何纯函数验收测试
import { describe, expect, it } from 'vitest';
import {
  add,
  clamp,
  dist,
  distSq,
  dot,
  len,
  lenSq,
  normalize,
  scale,
  sub,
} from './math';

describe('math 向量纯函数', () => {
  it('add / sub / scale 基本运算', () => {
    expect(add({ x: 1, y: 2 }, { x: 10, y: 20 })).toEqual({ x: 11, y: 22 });
    expect(sub({ x: 10, y: 20 }, { x: 1, y: 2 })).toEqual({ x: 9, y: 18 });
    expect(scale({ x: 3, y: -2 }, 2)).toEqual({ x: 6, y: -4 });
    expect(scale({ x: 1, y: 1 }, 0)).toEqual({ x: 0, y: 0 });
  });

  it('len / lenSq：勾股定理（3-4-5）', () => {
    expect(lenSq({ x: 3, y: 4 })).toBe(25);
    expect(len({ x: 3, y: 4 })).toBe(5);
    expect(len({ x: -3, y: 4 })).toBe(5);
    expect(len({ x: 0, y: 0 })).toBe(0);
  });

  it('normalize：单位化且保持方向', () => {
    const u = normalize({ x: 3, y: 4 });
    expect(len(u)).toBeCloseTo(1);
    expect(u.x).toBeCloseTo(0.6);
    expect(u.y).toBeCloseTo(0.8);

    const n = normalize({ x: 0, y: -7 });
    expect(n.x).toBeCloseTo(0);
    expect(n.y).toBeCloseTo(-1);
  });

  it('normalize：零向量约定返回 {x:0, y:0}，不产生 NaN', () => {
    expect(normalize({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  it('dist / distSq：毕氏定理（毕达哥拉斯）', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 3, y: 4 };
    expect(distSq(a, b)).toBe(25);
    expect(dist(a, b)).toBe(5);
    expect(dist(b, a)).toBe(5);
    expect(dist(a, a)).toBe(0);
  });

  it('dot：垂直为 0、平行取长度乘积', () => {
    expect(dot({ x: 1, y: 0 }, { x: 0, y: 1 })).toBe(0);
    expect(dot({ x: 2, y: 0 }, { x: 3, y: 0 })).toBe(6);
    expect(dot({ x: 1, y: 2 }, { x: 3, y: 4 })).toBe(11);
  });

  it('clamp：区间内原样、越界钳到边界', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it('纯函数：不修改入参', () => {
    const a = { x: 1, y: 2 };
    const b = { x: 3, y: 4 };
    add(a, b);
    sub(a, b);
    scale(a, 2);
    normalize(a);
    expect(a).toEqual({ x: 1, y: 2 });
    expect(b).toEqual({ x: 3, y: 4 });
  });
});
