// src/core/audioThrottle.ts —— 音效节流器（纯逻辑，可 vitest 直测）。
// 高射速武器（榴弹/激光/穿透连射）会在同一帧或极短窗口内产生大量 sfx 事件，
// 全部直通音频引擎会把声音糊爆；本模块按两级规则决定每个请求「放行 / 丢弃」：
// 1) 同名最小间隔：距该音效上次放行不足 interval 的请求丢弃（如 shoot 60ms、hit 40ms）；
// 2) 滑动窗口总量上限：长度 windowMs（≈一帧时长）的窗口内最多放行 maxPerWindow 个
//    （同名 + 异名合并计数），防止极端帧（同时命中几十个敌人）声音数量爆炸。
// 纯 TypeScript：时间一律由调用方以 nowMs 注入（禁 Date.now / Math.random，可复现性契约），
// 无 DOM/BOM 依赖、无 WebAudio（合成引擎在 src/audio/sfx.ts，本模块只做决策）。

/** 节流器配置（全部可缺省，缺省值见 createSfxThrottle）。 */
export interface SfxThrottleOptions {
  /** 音效名 → 最小播放间隔（ms）：距上次放行不足间隔的同类请求丢弃。 */
  minIntervalMs?: Record<string, number>;
  /** 未在 minIntervalMs 列出的音效名使用的缺省间隔（ms）。 */
  defaultMinIntervalMs?: number;
  /** 滑动窗口长度（ms，≈一帧时长）：窗口内放行总数受 maxPerWindow 约束。 */
  windowMs?: number;
  /** 每个滑动窗口内最多放行的音效总数（同名 + 异名合并计数）。 */
  maxPerWindow?: number;
}

/** 音效节流器：tryPlay 决定放行/丢弃，reset 清空全部状态。 */
export interface SfxThrottle {
  /**
   * 请求播放一个音效：true = 放行（内部记录本次时刻），false = 节流丢弃。
   * nowMs 应为单调时钟（如 performance.now）；同帧的批量事件天然聚在同一窗口。
   */
  tryPlay(name: string, nowMs: number): boolean;
  /** 清空全部节流状态（重开一局 / 时间基准变更时调用）。 */
  reset(): void;
}

/** 创建音效节流器。缺省参数：defaultMinIntervalMs=30、windowMs=20（约一帧）、maxPerWindow=8。 */
export function createSfxThrottle(options: SfxThrottleOptions = {}): SfxThrottle {
  const minIntervalMs = options.minIntervalMs ?? {};
  const defaultMinIntervalMs = options.defaultMinIntervalMs ?? 30;
  const windowMs = options.windowMs ?? 20;
  const maxPerWindow = options.maxPerWindow ?? 8;

  // 音效名 → 最近一次放行时刻（ms）；放行时才写入（被丢弃的请求不占用间隔基准）。
  let lastPlayMs: Record<string, number> = {};
  // 当前滑动窗口起点（-Infinity = 尚无放行：任意 nowMs 都开启新窗口）。
  let windowStartMs = -Infinity;
  // 当前窗口内已放行数量。
  let windowCount = 0;

  return {
    tryPlay(name: string, nowMs: number): boolean {
      // 滑动窗口推进：nowMs 越过窗口右端（或时间回退，防御异常时钟）则开新窗口。
      if (nowMs < windowStartMs || nowMs >= windowStartMs + windowMs) {
        windowStartMs = nowMs;
        windowCount = 0;
      }
      // 窗口总量上限：已满则本窗口内后续请求全部丢弃（间隔基准不更新）。
      if (windowCount >= maxPerWindow) {
        return false;
      }
      // 同名最小间隔：不足间隔的请求丢弃。
      const last = lastPlayMs[name];
      if (last !== undefined && nowMs - last < (minIntervalMs[name] ?? defaultMinIntervalMs)) {
        return false;
      }
      lastPlayMs[name] = nowMs;
      windowCount += 1;
      return true;
    },

    reset(): void {
      lastPlayMs = {};
      windowStartMs = -Infinity;
      windowCount = 0;
    },
  };
}
