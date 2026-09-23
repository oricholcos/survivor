// src/core/waveClock.test.ts —— 无尽模式波次时钟测试：
// 通关模式恒线性、表尾后按规则循环（轮内连续推进单调递增、轮间回绕落回 (loopFromSec, timelineEndSec]）、
// loopCount 每过 unit +1、loopScale = scalingPerLoop ** k 逐轮单调递增、
// 边界（恰等表尾 / 表尾+1 进环起点 / 浮点噪声容差）、脏配置防御（unit<=0、scalingPerLoop<=1、NaN）、
// 返回形态与 waves.ts 消费端 WaveClockInput 匹配。
// 夹具约定：endlessLoop 用真实 waves.json 同款数值（loopFromSec 540 / scalingPerLoop 1.35 / 表尾 600s），
// 循环单位 unit = 60，整数秒采样保证断言无浮点误差。

import { describe, expect, it } from 'vitest';
import type { WaveClockInput } from './waves';
import { resolveWaveClock, type EndlessConfig, type WaveClockResult } from './waveClock';

/** 夹具无尽配置：与真实 waves.json 的 endlessLoop 字段同数值。 */
const ENDLESS: EndlessConfig = { loopFromSec: 540, scalingPerLoop: 1.35 };
/** 夹具表尾：真实 waves.json 的 campaignDurationSec。 */
const END_SEC = 600;
/** 循环单位：unit = timelineEndSec − loopFromSec = 60（表尾循环段时长）。 */
const UNIT = END_SEC - ENDLESS.loopFromSec;

/** 便捷调用：默认夹具配置。 */
function clockAt(elapsedSec: number, endless: EndlessConfig | null = ENDLESS, endSec = END_SEC): WaveClockResult {
  return resolveWaveClock(elapsedSec, endless, endSec);
}

/** 线性时钟期望值（通关模式 / 未进环 / 脏配置路径的统一形态）。 */
function linear(elapsedSec: number): WaveClockResult {
  return { timelineSec: elapsedSec, loopCount: 0, loopScale: 1, densityScale: 1 };
}

/** 形态契约：返回值必须可直接赋给 waves.ts 的 WaveClockInput（编译期检查 + 运行时透传）。 */
function asClockInput(result: WaveClockResult): WaveClockInput {
  return result;
}

describe('通关模式（endless=null）恒线性', () => {
  it('任意 elapsed（含越过表尾）都原样透传，不进环', () => {
    expect(resolveWaveClock(0, null, END_SEC)).toEqual(linear(0));
    expect(resolveWaveClock(300.5, null, END_SEC)).toEqual(linear(300.5));
    expect(resolveWaveClock(END_SEC, null, END_SEC)).toEqual(linear(END_SEC));
    expect(resolveWaveClock(999.5, null, END_SEC)).toEqual(linear(999.5));
  });
});

describe('未越过表尾：endless 非 null 也恒线性', () => {
  it('elapsed < timelineEndSec：线性', () => {
    expect(clockAt(0)).toEqual(linear(0));
    expect(clockAt(539)).toEqual(linear(539));
    expect(clockAt(599.5)).toEqual(linear(599.5));
  });

  it('elapsed 恰等于 timelineEndSec：不进环（边界）', () => {
    expect(clockAt(END_SEC)).toEqual(linear(END_SEC));
  });
});

describe('表尾后按规则循环：轮内连续推进、轮间回绕', () => {
  it('第 1 轮（601..660s）：timelineSec 落在 (540, 600] 且随 elapsed 逐秒严格递增', () => {
    let prev = ENDLESS.loopFromSec; // 回绕基准：轮内首样本（541）须大于它（600 → 541 的回退是预期回绕）
    for (let e = END_SEC + 1; e <= END_SEC + UNIT; e++) {
      const r = clockAt(e);
      expect(r.loopCount).toBe(1);
      expect(r.timelineSec).toBe(e - UNIT); // 闭式：541..600
      expect(r.timelineSec).toBeGreaterThan(ENDLESS.loopFromSec);
      expect(r.timelineSec).toBeLessThanOrEqual(END_SEC);
      expect(r.timelineSec).toBeGreaterThan(prev); // 轮内单调递增，不跳变
      prev = r.timelineSec;
    }
    expect(prev).toBe(END_SEC); // 第 1 轮终点恰为表尾
  });

  it('轮间回绕点正确：轮末=表尾，+1s 回到 loopFromSec+1', () => {
    expect(clockAt(END_SEC + UNIT).timelineSec).toBe(END_SEC); // 660 → 600（第 1 轮末）
    expect(clockAt(END_SEC + UNIT + 1).timelineSec).toBe(ENDLESS.loopFromSec + 1); // 661 → 541（第 2 轮起点）
    expect(clockAt(END_SEC + 2 * UNIT).timelineSec).toBe(END_SEC); // 720 → 600（第 2 轮末）
    expect(clockAt(END_SEC + 2 * UNIT + 1).timelineSec).toBe(ENDLESS.loopFromSec + 1); // 721 → 541（第 3 轮起点）
  });

  it('多轮闭式核对：第 k 轮整数秒 timelineSec = elapsed − k×unit', () => {
    for (let k = 1; k <= 5; k++) {
      for (let e = END_SEC + (k - 1) * UNIT + 1; e <= END_SEC + k * UNIT; e++) {
        const r = clockAt(e);
        expect(r.loopCount).toBe(k);
        expect(r.timelineSec).toBe(e - k * UNIT);
        expect(r.timelineSec).toBeGreaterThan(ENDLESS.loopFromSec);
        expect(r.timelineSec).toBeLessThanOrEqual(END_SEC);
      }
    }
  });

  it('小数 elapsed 轮内连续推进：无取整跳变', () => {
    expect(clockAt(END_SEC + 0.5).timelineSec).toBe(ENDLESS.loopFromSec + 0.5); // 600.5 → 540.5
    expect(clockAt(END_SEC + 1.5).timelineSec).toBe(ENDLESS.loopFromSec + 1.5); // 601.5 → 541.5
    expect(clockAt(END_SEC + 30.25).timelineSec).toBe(ENDLESS.loopFromSec + 30.25); // 630.25 → 570.25
  });

  it('多轮循环小数与跨轮帧步长严格连续单调：无首秒跳空与越界', () => {
    // 跨第 1 轮到第 2 轮（660s 前后，以 16ms 步长模拟真实 60fps 帧推进）
    let prev = 599.9;
    for (let t = END_SEC + UNIT - 0.1; t <= END_SEC + UNIT + 2.0; t += 0.016) {
      const r = clockAt(t);
      expect(r.timelineSec).toBeGreaterThanOrEqual(ENDLESS.loopFromSec);
      expect(r.timelineSec).toBeLessThanOrEqual(END_SEC);
      if (t > END_SEC + UNIT && prev > 599.0 && r.timelineSec < 545.0) {
        // 发生跨轮回绕：上一帧在 600 附近，本帧平滑回绕到 540 起点，且首秒连续推进
        expect(r.loopCount).toBe(2);
      }
      prev = r.timelineSec;
    }
    // 精确浮点断言第 2 轮与第 3 轮首秒
    expect(clockAt(END_SEC + UNIT + 0.2).timelineSec).toBeCloseTo(ENDLESS.loopFromSec + 0.2, 5);
    expect(clockAt(END_SEC + UNIT + 0.5).timelineSec).toBeCloseTo(ENDLESS.loopFromSec + 0.5, 5);
    expect(clockAt(END_SEC + 2 * UNIT + 0.35).timelineSec).toBeCloseTo(ENDLESS.loopFromSec + 0.35, 5);
  });
});

describe('loopCount 与 loopScale 逐轮膨胀', () => {
  it('loopCount 每过 unit +1（轮界两侧核对）', () => {
    expect(clockAt(END_SEC + 1).loopCount).toBe(1);
    expect(clockAt(END_SEC + UNIT).loopCount).toBe(1);
    expect(clockAt(END_SEC + UNIT + 1).loopCount).toBe(2);
    expect(clockAt(END_SEC + 2 * UNIT).loopCount).toBe(2);
    expect(clockAt(END_SEC + 2 * UNIT + 1).loopCount).toBe(3);
    expect(clockAt(END_SEC + 5 * UNIT).loopCount).toBe(5);
  });

  it('loopScale = scalingPerLoop ** k，多轮数值精确', () => {
    expect(clockAt(END_SEC + 1).loopScale).toBe(1.35); // k=1
    expect(clockAt(END_SEC + UNIT + 1).loopScale).toBeCloseTo(1.8225, 10); // k=2
    expect(clockAt(END_SEC + 2 * UNIT + 1).loopScale).toBeCloseTo(2.460375, 10); // k=3
    expect(clockAt(END_SEC + 3 * UNIT + 1).loopScale).toBeCloseTo(3.32150625, 10); // k=4
  });

  it('长程采样：loopCount / loopScale 均单调不减且 loopScale = 1.35 ** loopCount', () => {
    let prevCount = 0;
    let prevScale = 1;
    for (let e = END_SEC + 1; e <= END_SEC + 10 * UNIT; e++) {
      const r = clockAt(e);
      expect(r.loopCount).toBeGreaterThanOrEqual(prevCount);
      expect(r.loopScale).toBeGreaterThanOrEqual(prevScale);
      expect(r.loopScale).toBeCloseTo(ENDLESS.scalingPerLoop ** r.loopCount, 10);
      prevCount = r.loopCount;
      prevScale = r.loopScale;
    }
    expect(prevCount).toBe(10);
  });
});

describe('边界用例', () => {
  it('恰等表尾不进环；表尾 +1s 为循环第 1 轮起点', () => {
    expect(clockAt(END_SEC)).toEqual(linear(END_SEC));
    expect(clockAt(END_SEC + 1)).toEqual({
      timelineSec: ENDLESS.loopFromSec + 1,
      loopCount: 1,
      loopScale: 1.35,
      densityScale: 1.35,
    });
  });

  it('浮点容差：表尾处 1e-12 级噪声不进环，越过容差后正常进环', () => {
    expect(clockAt(END_SEC + 1e-12)).toEqual(linear(END_SEC + 1e-12));
    const r = clockAt(END_SEC + 1e-8);
    expect(r.loopCount).toBe(1);
    expect(r.timelineSec).toBeCloseTo(ENDLESS.loopFromSec, 6); // 540.00000001
    expect(r.loopScale).toBe(1.35);
    expect(r.densityScale).toBe(1.35);
  });
});

describe('脏配置防御：按无循环处理，恒返回线性结果', () => {
  it('unit <= 0（loopFromSec >= timelineEndSec）', () => {
    expect(resolveWaveClock(900, { loopFromSec: 600, scalingPerLoop: 1.35 }, 600)).toEqual(linear(900));
    expect(resolveWaveClock(900, { loopFromSec: 650, scalingPerLoop: 1.35 }, 600)).toEqual(linear(900));
  });

  it('scalingPerLoop <= 1（不膨胀）', () => {
    expect(resolveWaveClock(900, { loopFromSec: 540, scalingPerLoop: 1 }, 600)).toEqual(linear(900));
    expect(resolveWaveClock(900, { loopFromSec: 540, scalingPerLoop: 0.8 }, 600)).toEqual(linear(900));
  });

  it('脏数值 NaN（loopFromSec 为 NaN → unit 非有限）', () => {
    const r = resolveWaveClock(900, { loopFromSec: Number.NaN, scalingPerLoop: 1.35 }, 600);
    expect(r.loopCount).toBe(0);
    expect(r.loopScale).toBe(1);
    expect(r.densityScale).toBe(1);
    expect(r.timelineSec).toBe(900);
  });
});

describe('与 waves 消费端形态匹配', () => {
  it('返回对象恰含 timelineSec / loopCount / loopScale / densityScale 四个 number 字段', () => {
    for (const r of [clockAt(300), clockAt(END_SEC + 1), clockAt(END_SEC + 90)]) {
      expect(Object.keys(r).sort()).toEqual(['densityScale', 'loopCount', 'loopScale', 'timelineSec']);
      expect(typeof r.timelineSec).toBe('number');
      expect(typeof r.loopCount).toBe('number');
      expect(typeof r.loopScale).toBe('number');
      expect(typeof r.densityScale).toBe('number');
    }
  });

  it('结果可直接作为 updateWaves 的 clock 参数（WaveClockInput 结构兼容）', () => {
    const clock = asClockInput(clockAt(END_SEC + 1));
    expect(clock.timelineSec).toBe(ENDLESS.loopFromSec + 1);
    expect(clock.loopCount).toBe(1);
    expect(clock.loopScale).toBe(1.35);
    expect(clock.densityScale).toBe(1.35);
  });
});

describe('densityPerLoop 与 densityScale（M24 密度解耦）', () => {
  it('densityPerLoop 缺省时回退为 scalingPerLoop（densityScale 恒等 loopScale）', () => {
    const r1 = clockAt(END_SEC + 1);
    expect(r1.densityScale).toBe(r1.loopScale);
    const r2 = clockAt(END_SEC + 2 * UNIT + 1);
    expect(r2.densityScale).toBe(r2.loopScale);
  });

  it('指定合法 densityPerLoop 时逐轮计算，与 loopScale 解耦', () => {
    const config: EndlessConfig = { loopFromSec: 560, scalingPerLoop: 1.45, densityPerLoop: 1.08 };
    const r1 = resolveWaveClock(601, config, 600);
    expect(r1.loopCount).toBe(1);
    expect(r1.loopScale).toBe(1.45);
    expect(r1.densityScale).toBe(1.08);

    const r2 = resolveWaveClock(641, config, 600); // 600 + 40 + 1 = 2 轮起点
    expect(r2.loopCount).toBe(2);
    expect(r2.loopScale).toBeCloseTo(1.45 ** 2, 10);
    expect(r2.densityScale).toBeCloseTo(1.08 ** 2, 10);
    expect(r2.densityScale).not.toBe(r2.loopScale);
  });

  it('通关/线性分支下 densityScale 恒为 1', () => {
    const config: EndlessConfig = { loopFromSec: 560, scalingPerLoop: 1.45, densityPerLoop: 1.08 };
    expect(resolveWaveClock(300, config, 600).densityScale).toBe(1);
    expect(resolveWaveClock(600, config, 600).densityScale).toBe(1);
    expect(resolveWaveClock(700, null, 600).densityScale).toBe(1);
  });

  it('脏配置防呆：densityPerLoop <= 1 或 NaN 时安全回退为 scalingPerLoop', () => {
    const dirtyLte1: EndlessConfig = { loopFromSec: 560, scalingPerLoop: 1.45, densityPerLoop: 1 };
    const r1 = resolveWaveClock(601, dirtyLte1, 600);
    expect(r1.densityScale).toBe(1.45);

    const dirtyNaN: EndlessConfig = { loopFromSec: 560, scalingPerLoop: 1.45, densityPerLoop: Number.NaN };
    const r2 = resolveWaveClock(601, dirtyNaN, 600);
    expect(r2.densityScale).toBe(1.45);
  });
});
