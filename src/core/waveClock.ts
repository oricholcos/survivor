// src/core/waveClock.ts —— 无尽模式波次时钟：表尾循环回绕 + 每轮膨胀系数（契约来源：survivor-tasks.md T3.4）。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM（ESLint 强制）；本模块无随机（无需 RNG）。
//
// 语义约定（下游 waves.ts 的 clock 参数按此消费，T3.1 已落地）：
// - 通关模式（endless 为 null）或 elapsed <= timelineEndSec：线性时钟
//   { timelineSec: elapsed, loopCount: 0, loopScale: 1 }，不进循环；
// - elapsed 越过表尾（endless 非 null）：循环单位 unit = timelineEndSec − loopFromSec（表尾循环段），
//   k = ceil((elapsed − timelineEndSec) / unit) 为已进入的循环轮数；
//   timelineSec = loopFromSec + ((elapsed − timelineEndSec − 1) % unit) + 1，
//   落在 (loopFromSec, timelineEndSec] 区间内逐帧连续推进、轮间回绕（回退由 waves.ts 检测并重触发爆发波）；
//   loopScale = scalingPerLoop ** k 逐轮膨胀，单调递增；
// - 防御：unit 过小（含 <= 0 / NaN 等脏配置）或 scalingPerLoop <= 1 按无循环处理，恒返回线性结果。

/** 无尽循环配置（对应 waves.json 的 endlessLoop 字段）。 */
export interface EndlessConfig {
  /** 循环段起点（秒）：表尾 timelineEndSec 与它之间的段逐轮重复。 */
  loopFromSec: number;
  /** 每轮膨胀系数：第 k 轮 loopScale = scalingPerLoop ** k（须 > 1，否则视为无循环）。 */
  scalingPerLoop: number;
  /** 每轮刷怪密度膨胀系数：第 k 轮 densityScale = densityPerLoop ** k（可选，缺省或脏值回退 scalingPerLoop）。 */
  densityPerLoop?: number;
}

/** 波次时钟结果：结构与 waves.ts 的 WaveClockInput 一致，可直接作为其 clock 参数传入。 */
export interface WaveClockResult {
  /** 时间轴位置（秒）：循环模式下在 (loopFromSec, timelineEndSec] 内回绕。 */
  timelineSec: number;
  /** 已进入的循环轮数（表尾后每过 unit +1；爆发波触发键含它，跨轮可重触发）。 */
  loopCount: number;
  /** 本轮膨胀系数（血量与经验同乘，单调递增）。 */
  loopScale: number;
  /** 本轮刷怪密度膨胀系数（与血量解耦，单调递增；通关/未进环模式恒 1）。 */
  densityScale: number;
}

/**
 * 浮点容差：elapsedSec 是逐帧累加的模拟时间，恰在表尾 / 轮界处的浮点噪声
 * （如 600.0000000001）不应触发进环或跳轮，故边界比较统一收敛 1e-9 秒。
 */
const EPSILON = 1e-9;

/**
 * 解析波次时钟：把真实流逝时间映射为「时间轴位置 + 循环轮数 + 膨胀系数」。
 * @param elapsedSec 真实流逝时间（秒，如 state.timeMs / 1000，单调递增不回绕）。
 * @param endless 无尽循环配置；通关模式传 null。
 * @param timelineEndSec 通关表总时长（如 waves.json 的 campaignDurationSec）。
 */
export function resolveWaveClock(
  elapsedSec: number,
  endless: EndlessConfig | null,
  timelineEndSec: number,
): WaveClockResult {
  // 线性结果：通关模式恒线性；脏配置（unit 过小含 NaN、系数不膨胀）按无循环处理；
  // 未越过表尾（含恰等、容差内噪声）也不进环。
  if (endless === null) {
    return { timelineSec: elapsedSec, loopCount: 0, loopScale: 1, densityScale: 1 };
  }
  const unit = timelineEndSec - endless.loopFromSec;
  // !(unit >= EPSILON) 同时拦截 unit <= 0 与 NaN（NaN 参与比较恒 false）。
  if (!(unit >= EPSILON) || endless.scalingPerLoop <= 1 || elapsedSec <= timelineEndSec + EPSILON) {
    return { timelineSec: elapsedSec, loopCount: 0, loopScale: 1, densityScale: 1 };
  }

  // 循环时钟：offset = 表尾后流逝量（> EPSILON 保证）。
  const offset = elapsedSec - timelineEndSec;
  // k = 循环轮数：表尾后每过 unit +1（减 EPSILON 抵消轮界浮点噪声，恰过 unit 仍记为该轮）。
  const loopCount = Math.ceil((offset - EPSILON) / unit);
  // 时间轴回绕位置：落在 (loopFromSec, timelineEndSec]，轮内随 elapsed 严格连续推进。
  const timelineSec = endless.loopFromSec + (offset - (loopCount - 1) * unit);
  // 每轮膨胀：第 k 轮系数 = scalingPerLoop ** k，单调递增。
  const loopScale = endless.scalingPerLoop ** loopCount;
  // 每轮密度膨胀：合法 densityPerLoop（> 1 且有限）独立计算，缺省或脏值（<= 1 / NaN 等）回退 scalingPerLoop。
  const densityPerLoop =
    endless.densityPerLoop !== undefined && Number.isFinite(endless.densityPerLoop) && endless.densityPerLoop > 1
      ? endless.densityPerLoop
      : endless.scalingPerLoop;
  const densityScale = densityPerLoop ** loopCount;
  return { timelineSec, loopCount, loopScale, densityScale };
}
