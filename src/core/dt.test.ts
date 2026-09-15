// src/core/dt.test.ts —— dt 钳制验收测试
import { describe, expect, it } from 'vitest';
import { MAX_DT_MS, clampDt } from './dt';

describe('clampDt', () => {
  it('超过 50ms 钳到 50ms', () => {
    expect(clampDt(1000)).toBe(50);
    expect(clampDt(51)).toBe(50);
    expect(clampDt(50.5)).toBe(50);
  });

  it('恰好 50ms 原样保留（上限含边界）', () => {
    expect(clampDt(50)).toBe(50);
    expect(clampDt(MAX_DT_MS)).toBe(50);
  });

  it('正常值原样保留', () => {
    expect(clampDt(16.6667)).toBe(16.6667);
    expect(clampDt(33.3)).toBe(33.3);
    expect(clampDt(0)).toBe(0);
  });

  it('非有限值（NaN / ±Infinity）按 0 处理', () => {
    expect(clampDt(Number.NaN)).toBe(0);
    expect(clampDt(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampDt(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('负值按 0 处理', () => {
    expect(clampDt(-1)).toBe(0);
    expect(clampDt(-0.0001)).toBe(0);
  });
});
