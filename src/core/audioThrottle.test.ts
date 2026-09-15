// src/core/audioThrottle.test.ts —— 音效节流器（T4.1）：同名最小间隔、异名独立、
// 滑动窗口总量上限、时间回退防御、reset 清空、自定义配置。
import { describe, expect, it } from 'vitest';
import { createSfxThrottle } from './audioThrottle';

describe('sfx 节流器：同名最小间隔', () => {
  it('首次请求放行', () => {
    const t = createSfxThrottle({ minIntervalMs: { shoot: 60 } });
    expect(t.tryPlay('shoot', 1000)).toBe(true);
  });

  it('间隔内丢弃、达到间隔后放行（边界：恰好 interval 放行）', () => {
    const t = createSfxThrottle({ minIntervalMs: { shoot: 60 } });
    expect(t.tryPlay('shoot', 100)).toBe(true);
    expect(t.tryPlay('shoot', 130)).toBe(false); // 30ms < 60ms：丢弃
    expect(t.tryPlay('shoot', 159)).toBe(false); // 59ms：仍丢弃
    expect(t.tryPlay('shoot', 160)).toBe(true); // 恰好 60ms：放行
  });

  it('不同音效名互不影响（各自独立计间隔）', () => {
    const t = createSfxThrottle({ minIntervalMs: { shoot: 60, hit: 40 } });
    expect(t.tryPlay('shoot', 100)).toBe(true);
    expect(t.tryPlay('hit', 110)).toBe(true); // 异名不受 shoot 间隔影响
    expect(t.tryPlay('hit', 120)).toBe(false); // hit 自身 40ms 内
    expect(t.tryPlay('shoot', 120)).toBe(false); // shoot 自身 60ms 内
  });

  it('未配置的名字使用缺省间隔', () => {
    const t = createSfxThrottle({ minIntervalMs: { shoot: 60 }, defaultMinIntervalMs: 50 });
    expect(t.tryPlay('unknown_sfx', 100)).toBe(true);
    expect(t.tryPlay('unknown_sfx', 149)).toBe(false); // 49ms < 50ms 缺省
    expect(t.tryPlay('unknown_sfx', 150)).toBe(true);
  });

  it('被丢弃的请求不重置间隔基准（连续快速点击后仍需等满间隔）', () => {
    const t = createSfxThrottle({ minIntervalMs: { shoot: 60 } });
    expect(t.tryPlay('shoot', 100)).toBe(true);
    expect(t.tryPlay('shoot', 110)).toBe(false); // 丢弃（不写基准）
    expect(t.tryPlay('shoot', 140)).toBe(false); // 仍按 100 计基准：40ms < 60ms
    expect(t.tryPlay('shoot', 160)).toBe(true);
  });
});

describe('sfx 节流器：滑动窗口总量上限', () => {
  it('窗口内超过 maxPerWindow 丢弃（异名合并计数），进入新窗口后恢复', () => {
    // defaultMinIntervalMs=0：隔离间隔因素，单独验证窗口总量规则。
    const t = createSfxThrottle({ minIntervalMs: {}, defaultMinIntervalMs: 0, windowMs: 20, maxPerWindow: 3 });
    expect(t.tryPlay('a', 0)).toBe(true);
    expect(t.tryPlay('b', 5)).toBe(true);
    expect(t.tryPlay('c', 10)).toBe(true);
    expect(t.tryPlay('d', 15)).toBe(false); // 本窗口已放行 3 个：丢弃
    expect(t.tryPlay('a', 18)).toBe(false); // 同窗口（18 < 20）：仍受窗口上限拦
    expect(t.tryPlay('d', 25)).toBe(true); // 25 >= 0+20：新窗口，恢复放行
  });

  it('窗口按放行时刻滑动（非固定栅格）', () => {
    const t = createSfxThrottle({ minIntervalMs: {}, windowMs: 20, maxPerWindow: 1 });
    expect(t.tryPlay('a', 100)).toBe(true);
    expect(t.tryPlay('b', 115)).toBe(false); // 115 < 120：同一窗口
    expect(t.tryPlay('b', 125)).toBe(true); // 125 >= 120：新窗口（起点滑到 125）
    expect(t.tryPlay('c', 140)).toBe(false); // 140 < 145：窗口从 125 起算
    expect(t.tryPlay('c', 145)).toBe(true);
  });

  it('窗口未满时同名仍受间隔约束（两级规则叠加）', () => {
    const t = createSfxThrottle({ minIntervalMs: { shoot: 60 }, windowMs: 20, maxPerWindow: 3 });
    expect(t.tryPlay('shoot', 0)).toBe(true);
    expect(t.tryPlay('other', 5)).toBe(true); // 窗口未满，异名放行
    expect(t.tryPlay('shoot', 10)).toBe(false); // 窗口未满但 shoot 间隔不足
  });
});

describe('sfx 节流器：时间与状态', () => {
  it('时间回退（nowMs 小于窗口起点）防御：开新窗口，不误判同窗口', () => {
    const t = createSfxThrottle({ minIntervalMs: {}, windowMs: 20, maxPerWindow: 1 });
    expect(t.tryPlay('a', 100)).toBe(true);
    expect(t.tryPlay('b', 50)).toBe(true); // 回退到 50：视为新窗口（异常时钟防御）
  });

  it('reset 清空全部状态：同名立即可再放行，窗口计数归零', () => {
    const t = createSfxThrottle({ minIntervalMs: { shoot: 60 }, windowMs: 20, maxPerWindow: 1 });
    expect(t.tryPlay('shoot', 0)).toBe(true);
    expect(t.tryPlay('shoot', 1)).toBe(false);
    t.reset();
    expect(t.tryPlay('shoot', 1)).toBe(true); // 间隔与窗口状态均已清空
  });

  it('缺省配置可用（无参创建）', () => {
    const t = createSfxThrottle();
    expect(t.tryPlay('shoot', 0)).toBe(true);
    expect(t.tryPlay('shoot', 10)).toBe(false); // 缺省间隔 30ms 内丢弃
    expect(t.tryPlay('shoot', 40)).toBe(true); // 40-0 >= 30：放行（窗口已随时刻滑动）
  });

  it('间隔为 0 的名字永不被间隔拦截', () => {
    const t = createSfxThrottle({ minIntervalMs: { free: 0 }, windowMs: 1000, maxPerWindow: 10 });
    expect(t.tryPlay('free', 0)).toBe(true);
    expect(t.tryPlay('free', 0)).toBe(true);
    expect(t.tryPlay('free', 0)).toBe(true);
  });
});
