// src/core/waves.test.ts —— 波次时间轴解释器测试：
// 给定时间点刷怪构成符合表（真实 waves.json + 小 timeline 切段）、爆发波按时一次性触发、
// 血量/密度膨胀系数、clock 参数（loopCount 换轮重触发 / loopScale 密度血量同乘）、
// dt 追补（长帧累计 + 爆发波只触发一次）、同种子可复现、over 停摆、waves.json 结构护栏。
// 夹具约定：自建 EnemyTypeData 表（二进制精确 perSec 保证计数断言无浮点误差）；
// 默认时钟路径按 step.ts 同款顺序推进（先 timeMs += dt 再调 updateWaves）。

import { describe, expect, it } from 'vitest';
import { loadEnemyTypes } from '../data/enemies';
import wavesJson from '../data/waves.json';
import type { EnemyTypeData } from './enemies';
import { createSimState } from './simState';
import type { Enemy, SimState } from './types';
import { calculateSpawnMargin, updateWaves, WAVE_CLOCK_META_KEY, type WavesConfig } from './waves';

/** 测试夹具敌人表：mook=杂兵 hp10、brute=爆发怪 hp40、bigboss=首领 hp900。 */
const TYPES: Record<string, EnemyTypeData> = {
  mook: {
    id: 'mook', name: '杂兵', shape: 'square', color: 0x00ff00,
    hp: 10, speed: 50, damage: 5, attackIntervalMs: 1000, xp: 1, radius: 10, isBoss: false,
  },
  brute: {
    id: 'brute', name: '爆发怪', shape: 'triangle', color: 0xff0000,
    hp: 40, speed: 45, damage: 10, attackIntervalMs: 1500, xp: 2, radius: 14, isBoss: false,
  },
  bigboss: {
    id: 'bigboss', name: '首领', shape: 'star', color: 0xff8800,
    hp: 900, speed: 40, damage: 40, attackIntervalMs: 1200, xp: 30, radius: 30, isBoss: true,
  },
};

/** 构造 WavesConfig：endlessLoop/scaling 给任务契约同款缺省，hpPerSec 可覆盖。 */
function makeConfig(timeline: WavesConfig['timeline'], hpPerSec = 0.01): WavesConfig {
  return {
    campaignDurationSec: 600,
    timeline,
    endlessLoop: { loopFromSec: 540, scalingPerLoop: 1.35 },
    scaling: { hpPerSec },
  };
}

/** 一帧推进：与 step.ts 同款顺序（timeMs 先 += dt 再调子系统）→ 默认时钟读到含本帧 dt 的时间。 */
function frame(state: SimState, dtMs: number, config: WavesConfig, types: Record<string, EnemyTypeData> = TYPES): void {
  state.timeMs += dtMs;
  updateWaves(state, dtMs, config, types);
}

function countBy(state: SimState, typeId: string): number {
  return state.enemies.filter((e) => e.typeId === typeId).length;
}

function bossesOf(state: SimState): Enemy[] {
  return state.enemies.filter((e) => e.isBoss);
}

/** 真实数据表：waves.json + enemies.json（验收「给定时间点刷怪构成符合表」用真表跑）。 */
const REAL = wavesJson as unknown as WavesConfig;
const REAL_TYPES = loadEnemyTypes();

describe('匀速段：给定时间点刷怪构成符合表', () => {
  it('真实 waves.json：开局 ≤3s 见怪（T3.6b 修复：静默开局被试玩否决）——首段 fromSec=0、runner、perSec 0.6~1.2 温和开场', () => {
    // 结构面：首段必须从 0s 起刷 runner，perSec 0.6~1.2（开局 ≤3s 见怪 + 前 2 分钟墙压温和）。
    const first = REAL.timeline[0]!;
    expect(first.fromSec).toBe(0);
    expect(first.spawn!.enemy).toBe('runner');
    expect(first.spawn!.perSec).toBeGreaterThanOrEqual(0.6);
    expect(first.spawn!.perSec).toBeLessThanOrEqual(1.2);
    // 行为面：perSec=0.9 → 累加器约 1.1s 攒出首只，3s 内必见怪且全是 runner。
    // 「前 10s 墙不掉血」不由本测试保证——由 balance.test.ts 的行军下界断言兜底
    // （首怪从刷怪线行军至墙线 ≥13s，10s 内任何刷怪都不可能抵墙）。
    const state = createSimState(42);
    for (let i = 0; i < 3; i++) {
      frame(state, 1000, REAL, REAL_TYPES); // t=1..3s
    }
    expect(state.enemies.length).toBeGreaterThanOrEqual(1);
    for (const e of state.enemies) {
      expect(e.typeId).toBe('runner');
    }
  });

  it('真实 waves.json：t=85 首个爆发波帧恰好 8 个 standard、无 boss（前期爆发波刻意不带 Boss）；t=195 首个带 Boss 的爆发波 = 10 standard + 1 boss_1', () => {
    const state = createSimState(42);
    for (let i = 0; i < 84; i++) {
      frame(state, 1000, REAL, REAL_TYPES);
    }
    expect(countBy(state, 'standard')).toBe(0);
    frame(state, 1000, REAL, REAL_TYPES); // t=85：跨过首个爆发波节点
    expect(countBy(state, 'standard')).toBe(8);
    expect(countBy(state, 'runner')).toBeGreaterThan(0); // 0s 起的匀速段照常推进
    expect(bossesOf(state).length).toBe(0);
    for (let i = 0; i < 110; i++) {
      frame(state, 1000, REAL, REAL_TYPES); // t=86..195
    }
    expect(countBy(state, 'boss_1')).toBe(1);
    expect(countBy(state, 'runner')).toBeGreaterThanOrEqual(7); // 爆发 10 standard + 匀速段 runner
    expect(bossesOf(state).length).toBe(1);
  });

  it('真实 waves.json：301~329s 新增全是 tank（tank 段混入），t=330 切到 runner', () => {
    // 本用例验证时间轴切段构成（无战斗、敌人只增不减），330s 累计存活会超过全局护栏
    // 默认值——显式关闭 maxEnemies 以隔离被测契约（护栏行为由「敌人数量上限护栏」组覆盖）。
    const state = createSimState(7, { maxEnemies: Infinity });
    for (let i = 0; i < 300; i++) {
      frame(state, 1000, REAL, REAL_TYPES);
    }
    const mark = state.enemies.length;
    for (let i = 0; i < 29; i++) {
      frame(state, 1000, REAL, REAL_TYPES); // t=301..329：当前段 = tank@300
    }
    expect(state.enemies.length).toBeGreaterThan(mark);
    for (let i = mark; i < state.enemies.length; i++) {
      expect(state.enemies[i].typeId).toBe('tank');
    }
    const mark2 = state.enemies.length;
    frame(state, 1000, REAL, REAL_TYPES); // t=330：当前段切到 runner@330
    expect(state.enemies.length).toBeGreaterThan(mark2);
    for (let i = mark2; i < state.enemies.length; i++) {
      expect(state.enemies[i].typeId).toBe('runner');
    }
  });

  it('小 timeline：50s 起切段后新刷的是 brute，旧段 mook 不再刷（按表构造）', () => {
    const config = makeConfig([
      { fromSec: 0, spawn: { enemy: 'mook', perSec: 1 } },
      { fromSec: 50, spawn: { enemy: 'brute', perSec: 2 } },
    ]);
    const state = createSimState(1);
    for (let i = 0; i < 50; i++) {
      frame(state, 1000, config);
    }
    // perSec=1 二进制精确：前 49 帧每帧 1 只 mook；第 50 帧段已切为 brute，每帧 2 只
    expect(state.enemies.length).toBe(51);
    expect(countBy(state, 'mook')).toBe(49);
    expect(countBy(state, 'brute')).toBe(2);
    expect(state.enemies[48].typeId).toBe('mook');
    expect(state.enemies[49].typeId).toBe('brute');
    expect(state.enemies[50].typeId).toBe('brute');
  });
});

describe('爆发波：按时一次性触发', () => {
  it('跨过 fromSec 的帧恰好出现 count 个 + 1 个 boss；下一帧不重复触发', () => {
    const config = makeConfig([
      { fromSec: 0, spawn: { enemy: 'mook', perSec: 0.25 } },
      { fromSec: 30, burst: { enemy: 'brute', count: 5, boss: 'bigboss', strengthFactor: 0.5 } },
    ]);
    const state = createSimState(3);
    for (let i = 0; i < 30; i++) {
      frame(state, 1000, config);
    }
    // perSec=0.25：前 28 帧刷 7 只 mook；爆发帧 acc=0.5 不刷 mook → 恰好 +5 brute +1 boss
    expect(countBy(state, 'mook')).toBe(7);
    expect(countBy(state, 'brute')).toBe(5);
    expect(countBy(state, 'bigboss')).toBe(1);
    expect(bossesOf(state).length).toBe(1);
    expect(state.enemies.length).toBe(13);

    // strengthFactor=0.5 只压杂兵：brute hp = 40×0.5×(1+0.01×30) = 26；boss hp = 900×1.3 = 1170
    for (const e of state.enemies) {
      if (e.typeId === 'brute') {
        expect(e.maxHp).toBeCloseTo(26, 9);
      }
      if (e.typeId === 'bigboss') {
        expect(e.maxHp).toBeCloseTo(1170, 6);
        expect(e.isBoss).toBe(true);
      }
    }

    // 下一帧：爆发波不重复触发（brute/boss 数量不变），mook 累加器照常推进
    frame(state, 1000, config);
    expect(countBy(state, 'brute')).toBe(5);
    expect(countBy(state, 'bigboss')).toBe(1);
    expect(state.enemies.length).toBe(13);
    frame(state, 1000, config); // t=32：mook acc 恰好再满 1 → +1
    expect(countBy(state, 'mook')).toBe(8);
    expect(countBy(state, 'brute')).toBe(5);
  });

  it('无 boss、缺省 strengthFactor=1 的爆发波：hp = 表值 × 时间膨胀，不刷 boss', () => {
    const config = makeConfig([{ fromSec: 10, burst: { enemy: 'brute', count: 3 } }]);
    const state = createSimState(5);
    for (let i = 0; i < 10; i++) {
      frame(state, 1000, config);
    }
    expect(countBy(state, 'brute')).toBe(3);
    expect(bossesOf(state).length).toBe(0);
    for (const e of state.enemies) {
      expect(e.maxHp).toBeCloseTo(44, 9); // 40 × (1 + 0.01×10)
    }
  });

  it('同一帧跨过多条爆发波：全部按时间轴顺序各触发一次', () => {
    const config = makeConfig([
      { fromSec: 1, burst: { enemy: 'brute', count: 3, boss: 'bigboss' } },
      { fromSec: 2, burst: { enemy: 'brute', count: 4, boss: 'bigboss' } },
    ]);
    const state = createSimState(9);
    frame(state, 3000, config); // 单帧 3s 跨过 1s 与 2s 两条
    expect(countBy(state, 'brute')).toBe(7);
    expect(countBy(state, 'bigboss')).toBe(2);
  });
});

describe('血量膨胀系数', () => {
  it('同类型敌人在 t=10 与 t=100 刷出，后者 maxHp 更大且符合公式', () => {
    const config = makeConfig([{ fromSec: 0, spawn: { enemy: 'mook', perSec: 1 } }]);
    const early = createSimState(11);
    updateWaves(early, 1000, config, TYPES, { timelineSec: 10, loopCount: 0, loopScale: 1 });
    const late = createSimState(11);
    updateWaves(late, 1000, config, TYPES, { timelineSec: 100, loopCount: 0, loopScale: 1 });

    expect(early.enemies.length).toBe(1);
    expect(late.enemies.length).toBe(1);
    expect(early.enemies[0].maxHp).toBeCloseTo(11, 9); // 10 × (1 + 0.01×10)
    expect(late.enemies[0].maxHp).toBeCloseTo(20, 9); // 10 × (1 + 0.01×100)
    expect(late.enemies[0].maxHp).toBeGreaterThan(early.enemies[0].maxHp);
    expect(early.enemies[0].hp).toBe(early.enemies[0].maxHp);
  });
});

describe('clock 参数（T3.4 消费面）', () => {
  it('loopScale=1.35：刷怪密度与血量同乘 1.35，累加器小数跨帧保留', () => {
    const config = makeConfig([{ fromSec: 0, spawn: { enemy: 'mook', perSec: 1 } }], 0);
    const base = createSimState(13);
    updateWaves(base, 10000, config, TYPES, { timelineSec: 10, loopCount: 0, loopScale: 1 });
    expect(base.enemies.length).toBe(10);
    expect(base.enemies[0].maxHp).toBeCloseTo(10, 9);

    const scaled = createSimState(13);
    updateWaves(scaled, 10000, config, TYPES, { timelineSec: 10, loopCount: 0, loopScale: 1.35 });
    // acc = 1×10×1.35 = 13.5 → 取整 13 只
    expect(scaled.enemies.length).toBe(13);
    for (const e of scaled.enemies) {
      expect(e.maxHp).toBeCloseTo(13.5, 9); // 10 × 1.35
    }
    // 下一帧 acc 从 0.5 续：+1.35 → 1.85 → 再刷 1 只
    updateWaves(scaled, 1000, config, TYPES, { timelineSec: 11, loopCount: 0, loopScale: 1.35 });
    expect(scaled.enemies.length).toBe(14);
  });

  it('loopCount 换轮后爆发波重触发（键含 loopCount），同轮不重复', () => {
    const config = makeConfig([{ fromSec: 5, burst: { enemy: 'brute', count: 3, boss: 'bigboss' } }]);
    const state = createSimState(17);

    updateWaves(state, 1000, config, TYPES, { timelineSec: 6, loopCount: 0, loopScale: 1 });
    expect(countBy(state, 'brute')).toBe(3);
    expect(countBy(state, 'bigboss')).toBe(1);

    updateWaves(state, 1000, config, TYPES, { timelineSec: 7, loopCount: 0, loopScale: 1 });
    expect(countBy(state, 'brute')).toBe(3); // 同轮不重复

    // 新循环：时间轴回拨（回退检测按 0 起点重置），fromSec=5 尚未跨过 → 不触发
    updateWaves(state, 1000, config, TYPES, { timelineSec: 2, loopCount: 1, loopScale: 1.35 });
    expect(countBy(state, 'brute')).toBe(3);

    // 再跨过 fromSec=5：loopCount=1 的键未 fire → 重触发
    updateWaves(state, 1000, config, TYPES, { timelineSec: 6, loopCount: 1, loopScale: 1.35 });
    expect(countBy(state, 'brute')).toBe(6);
    expect(countBy(state, 'bigboss')).toBe(2);
  });

  it('clock 缺省 = 线性时间 { state.timeMs/1000, 0, 1 }', () => {
    const config = makeConfig([{ fromSec: 0, spawn: { enemy: 'mook', perSec: 1 } }]);
    const state = createSimState(19);
    state.timeMs = 10000; // 调用方（step）先行推进过的时间
    frame(state, 1000, config); // 本帧时间轴位置 = 11s
    expect(state.enemies.length).toBe(1);
    expect(state.enemies[0].maxHp).toBeCloseTo(11.1, 9); // 10 × (1 + 0.01×11)：证明用的是 timeMs/1000
  });

  it('loopScale > 1 时敌人 xp 按比例缩放', () => {
    const config = makeConfig([{ fromSec: 0, spawn: { enemy: 'mook', perSec: 1 } }], 0);
    const state = createSimState(13);
    updateWaves(state, 1000, config, TYPES, { timelineSec: 1, loopCount: 1, loopScale: 2.0 });
    expect(state.enemies.length).toBe(2);
    expect(state.enemies[0].xp).toBe(2); // mook base xp 1 * 2.0 = 2
    expect(state.enemies[1].xp).toBe(2);
  });

  it('meta 契约：每帧把收到的 clock 原样存入 meta[WAVE_CLOCK_META_KEY]；clock 缺省与 over 停摆不写', () => {
    const config = makeConfig([{ fromSec: 0, spawn: { enemy: 'mook', perSec: 1 } }]);

    // 有 clock：原样存引用（gems.xpToNext 据此读 loopScale）
    const withClock = createSimState(31);
    const clock = { timelineSec: 560, loopCount: 2, loopScale: 4 };
    updateWaves(withClock, 1000, config, TYPES, clock);
    expect(withClock.meta[WAVE_CLOCK_META_KEY]).toBe(clock); // 存引用本身
    expect(withClock.meta[WAVE_CLOCK_META_KEY]).toEqual({ timelineSec: 560, loopCount: 2, loopScale: 4 });

    // 无 clock（默认线性时钟）不写：gems 侧按缺失回退 loopScale=1
    const bare = createSimState(31);
    updateWaves(bare, 1000, config, TYPES);
    expect(bare.meta[WAVE_CLOCK_META_KEY]).toBeUndefined();

    // over 停摆：提前 return 不写（此时经验也不再结算，读旧值无副作用）
    const over = createSimState(31);
    over.over = 'defeat';
    updateWaves(over, 1000, config, TYPES, { timelineSec: 1, loopCount: 0, loopScale: 2 });
    expect(over.meta[WAVE_CLOCK_META_KEY]).toBeUndefined();
  });
});

describe('dt 追补', () => {
  it('单帧 2000ms：正确累计刷怪数、爆发波仍只触发一次', () => {
    const config = makeConfig([
      { fromSec: 0, spawn: { enemy: 'mook', perSec: 1 } },
      { fromSec: 1, burst: { enemy: 'brute', count: 5, boss: 'bigboss' } },
    ]);
    const long = createSimState(23);
    frame(long, 2000, config); // t=2：acc=2 → 2 mook；跨过 fromSec=1 → 爆发波恰一次
    expect(countBy(long, 'mook')).toBe(2);
    expect(countBy(long, 'brute')).toBe(5);
    expect(countBy(long, 'bigboss')).toBe(1);
    frame(long, 2000, config); // t=4：再 +2 mook，爆发波不重复
    expect(countBy(long, 'mook')).toBe(4);
    expect(countBy(long, 'brute')).toBe(5);
    expect(countBy(long, 'bigboss')).toBe(1);

    // 对照：同时间走 4 个 1s 短帧，总量与爆发波次数完全一致
    const short = createSimState(23);
    for (let i = 0; i < 4; i++) {
      frame(short, 1000, config);
    }
    expect(countBy(short, 'mook')).toBe(4);
    expect(countBy(short, 'brute')).toBe(5);
    expect(countBy(short, 'bigboss')).toBe(1);
  });
});

describe('结束停摆与可复现', () => {
  it('over 非 null 直接 return：不刷怪、不初始化游标', () => {
    const config = makeConfig([{ fromSec: 0, spawn: { enemy: 'mook', perSec: 1 } }]);
    const state = createSimState(29);
    state.over = 'defeat';
    updateWaves(state, 1000, config, TYPES);
    expect(state.enemies.length).toBe(0);
    expect(state.meta.waves).toBeUndefined();
  });

  it('同种子可复现：真实 waves.json 两遍刷怪序列快照一致', () => {
    const run = (): SimState => {
      const state = createSimState(2026);
      for (let i = 0; i < 230; i++) {
        frame(state, 1000, REAL, REAL_TYPES); // t→230s：含 85/160/195s 三条爆发波（195 带 Boss）与多次切段
      }
      return state;
    };
    const a = run();
    const b = run();
    const snap = (s: SimState): Array<{ typeId: string; x: number; y: number; maxHp: number; isBoss: boolean }> =>
      s.enemies.map((e) => ({ typeId: e.typeId, x: e.x, y: e.y, maxHp: e.maxHp, isBoss: e.isBoss }));
    expect(snap(a)).toEqual(snap(b));
    // 序列非平凡：数量可观、恰含 195s 一只 Boss、x 全在 [margin, width-margin)
    expect(a.enemies.length).toBeGreaterThan(50);
    expect(countBy(a, 'boss_1')).toBe(1);
    for (const e of a.enemies) {
      const margin = calculateSpawnMargin(REAL_TYPES[e.typeId]!);
      expect(e.x).toBeGreaterThanOrEqual(margin);
      expect(e.x).toBeLessThan(a.layout.width - margin);
      expect(e.y).toBe(a.layout.spawnLineY);
    }
  });

  it('calculateSpawnMargin: 普通怪 Math.max(radius + 10, 32)，Boss Math.max(radius * 1.5 + 24, 72)', () => {
    expect(calculateSpawnMargin({ ...TYPES.mook, radius: 10, isBoss: false })).toBe(32); // max(20, 32) = 32
    expect(calculateSpawnMargin({ ...TYPES.mook, radius: 30, isBoss: false })).toBe(40); // max(40, 32) = 40
    expect(calculateSpawnMargin({ ...TYPES.bigboss, radius: 20, isBoss: true })).toBe(72); // max(54, 72) = 72
    expect(calculateSpawnMargin({ ...TYPES.bigboss, radius: 40, isBoss: true })).toBe(84); // max(84, 72) = 84
  });
});

describe('waves.json 数据契约护栏（T3.6 平衡校准后的结构约束）', () => {
  it('顶层字段与时间轴有序、引用的敌人 id 全部存在', () => {
    expect(REAL.campaignDurationSec).toBe(600);
    // T5.2b 重校准：轨道炮 hitscan 化后整体清场能力上调，血量膨胀系数 0.0042 → 0.0052
    // M3 翻倍重校准：血量膨胀系数 0.0052 → 0.008，endless 循环参数 1.08 → 1.22
    expect(REAL.scaling).toEqual({ hpPerSec: 0.0096 });
    expect(REAL.endlessLoop).toEqual({ loopFromSec: 560, scalingPerLoop: 2.0 });
    expect(REAL.timeline.length).toBeGreaterThan(0);
    let prev = -Infinity;
    for (const entry of REAL.timeline) {
      expect(entry.fromSec).toBeGreaterThanOrEqual(prev);
      expect(entry.fromSec).toBeLessThanOrEqual(REAL.campaignDurationSec);
      prev = entry.fromSec;
      expect(entry.spawn !== undefined || entry.burst !== undefined).toBe(true);
      if (entry.spawn !== undefined) {
        expect(REAL_TYPES[entry.spawn.enemy]).toBeDefined();
        expect(entry.spawn.perSec).toBeGreaterThan(0);
      }
      if (entry.burst !== undefined) {
        expect(REAL_TYPES[entry.burst.enemy]).toBeDefined();
        if (entry.burst.boss !== undefined) {
          expect(REAL_TYPES[entry.burst.boss]).toBeDefined();
          expect(REAL_TYPES[entry.burst.boss].isBoss).toBe(true);
        }
      }
    }
  });

  it('爆发波节奏：9 个、count 6~55、间隔 25~130s；195s 前与 550s/575s 脉冲不带 Boss，其余带 boss_1', () => {
    const bursts = REAL.timeline.filter((e) => e.burst !== undefined);
    expect(bursts.length).toBeGreaterThanOrEqual(8);
    expect(bursts.length).toBeLessThanOrEqual(11);
    for (let i = 0; i < bursts.length; i++) {
      const b = bursts[i].burst!;
      expect(b.count).toBeGreaterThanOrEqual(6);
      expect(b.count).toBeLessThanOrEqual(55);
      expect(b.strengthFactor).toBeGreaterThanOrEqual(0.4);
      expect(b.strengthFactor).toBeLessThanOrEqual(1);
      if (bursts[i].fromSec < 195 || bursts[i].fromSec === 550 || bursts[i].fromSec === 575) {
        // 前期爆发波刻意无 Boss：Boss 33/s 的墙压在蓄能狙成型前不可反制。
        // 550 与 575 为纯群怪脉冲无 boss
        expect(b.boss).toBeUndefined();
      } else {
        expect(b.boss).toBe('boss_1');
      }
      if (i > 0) {
        const gap = bursts[i].fromSec - bursts[i - 1].fromSec;
        expect(gap).toBeGreaterThanOrEqual(25); // 波间留出压力消化窗口
        expect(gap).toBeLessThanOrEqual(130); // 节奏不断档
      }
    }
  });

  it('前松后紧：开局即刷怪（首段 fromSec=0、perSec 0.6~1.2 温和起步）、前段温和（runner/standard ≤ 2.25）、中段上压（≤ 3.75 且 300s 起混入 tank）、尾段以爆发波为主（3 条且逐波到 600s）', () => {
    const spawns = REAL.timeline.filter((e) => e.spawn !== undefined);
    const first = spawns[0]!;
    // 开局不空场：首段从 0s 起刷（T3.6b 修复：47s 静默开局被试玩否决）。
    // perSec ≥ 0.34 保证首刷期望 ≤3s；≤1.2 保证前 2 分钟墙压温和（行军 ≥13s + 首攻冷却）。
    expect(first.fromSec).toBe(0);
    expect(first.spawn!.enemy).toBe('runner');
    expect(first.spawn!.perSec).toBeGreaterThanOrEqual(0.6);
    expect(first.spawn!.perSec).toBeLessThanOrEqual(1.2);

    const front = spawns.filter((e) => e.fromSec < 180);
    const mid = spawns.filter((e) => e.fromSec >= 180 && e.fromSec < 420);
    const climax = spawns.filter((e) => e.fromSec >= 420 && e.fromSec <= REAL.campaignDurationSec);

    for (const e of front) {
      expect(['runner', 'standard']).toContain(e.spawn!.enemy);
      expect(e.spawn!.perSec).toBeLessThanOrEqual(2.25);
    }
    for (const e of mid) {
      expect(e.spawn!.perSec).toBeLessThanOrEqual(3.75);
    }
    expect(mid.some((e) => e.spawn!.enemy === 'tank')).toBe(true);
    for (const e of climax) {
      if (e.spawn!.enemy !== 'tank') {
        // 尾段匀速密度让位于爆发波：温和的底线密度 + 高频爆发波构成高潮。
        // 怪物提升 1.5 倍后尾段高潮 perSec 提升到了 7.5
        expect(e.spawn!.perSec).toBeGreaterThanOrEqual(0.7);
        expect(e.spawn!.perSec).toBeLessThanOrEqual(7.5);
      }
    }
    expect(climax.some((e) => e.spawn!.enemy === 'tank')).toBe(true);
    const climaxBursts = REAL.timeline.filter((e) => e.burst !== undefined && e.fromSec >= 415);
    expect(climaxBursts.length).toBeGreaterThanOrEqual(3);
    expect(climaxBursts[climaxBursts.length - 1]!.fromSec).toBeGreaterThanOrEqual(570); // 末波压哨
  });
});

describe('敌人数量上限护栏（T3 性能封顶）', () => {
  it('匀速段：存活数到 maxEnemies 停刷；额度恢复后按正常节奏续刷（每帧至多 1 只，不爆发补刷）', () => {
    const config = makeConfig([{ fromSec: 0, spawn: { enemy: 'mook', perSec: 1 } }], 0);
    const state = createSimState(13, { maxEnemies: 5 });
    for (let i = 0; i < 10; i++) {
      frame(state, 1000, config);
    }
    expect(state.enemies.length).toBe(5); // 拟刷 10 只被钳到 5

    // 额度用尽：连续多帧不再增（perSec=1 二进制精确，钳制帧 acc 只留小数尾 0）
    frame(state, 1000, config);
    expect(state.enemies.length).toBe(5);

    // 击杀 2 只腾出额度（尸体留在数组里不占额度——护栏只数 !dead）：随后两帧各刷 1 只，
    // 回满 5 后停——若累加器积累了欠账，这里会一次爆发补刷 2+ 只。
    state.enemies[0].dead = true;
    state.enemies[1].dead = true;
    frame(state, 1000, config);
    expect(state.enemies.length).toBe(6);
    frame(state, 1000, config);
    expect(state.enemies.length).toBe(7);
    frame(state, 1000, config);
    expect(state.enemies.length).toBe(7);
  });

  it('匀速段小数尾：钳制帧 acc 只保留小数尾，额度恢复帧恰好补 1 只', () => {
    const config = makeConfig([{ fromSec: 0, spawn: { enemy: 'mook', perSec: 1.5 } }], 0);
    const state = createSimState(13, { maxEnemies: 2 });
    frame(state, 1000, config); // acc=1.5 → 刷 1（budget 2→1，acc 留 0.5）
    expect(state.enemies.length).toBe(1);
    frame(state, 1000, config); // acc=2.0 → 拟刷 2 钳到 1（被钳掉的 1 只丢弃，acc 只留小数尾）
    expect(state.enemies.length).toBe(2);
    frame(state, 1000, config); // 额度用尽：acc=1.5 → 整数欠账丢弃只留 0.5
    frame(state, 1000, config);
    expect(state.enemies.length).toBe(2);
    // 腾 1 额度：恢复帧恰好刷 1 只（欠账若被积累会一次补刷多只）
    state.enemies[0].dead = true;
    frame(state, 1000, config);
    expect(state.enemies.length).toBe(3);
  });

  it('爆发波：杂兵钳到剩余额度（被钳掉的直接丢弃不补刷），boss 不受上限约束照常刷', () => {
    const config = makeConfig([{ fromSec: 10, burst: { enemy: 'brute', count: 5, boss: 'bigboss' } }]);
    const state = createSimState(5, { maxEnemies: 3 });
    for (let i = 0; i < 10; i++) {
      frame(state, 1000, config);
    }
    expect(countBy(state, 'brute')).toBe(3); // 5 杂兵钳到额度 3，2 只丢弃
    expect(countBy(state, 'bigboss')).toBe(1); // 杂兵已顶满额度，boss 仍照常刷（总额 4 > 3）
    expect(state.enemies.length).toBe(4);
    frame(state, 1000, config); // firedBurstKeys 已置位：不重触发、无补刷
    expect(state.enemies.length).toBe(4);
  });

  it('maxEnemies <= 0 或非有限 → 视为不设上限（防御坏表，正常刷怪）', () => {
    const config = makeConfig([{ fromSec: 0, spawn: { enemy: 'mook', perSec: 1 } }], 0);
    const zero = createSimState(13, { maxEnemies: 0 });
    const infinite = createSimState(13, { maxEnemies: Infinity });
    for (let i = 0; i < 10; i++) {
      frame(zero, 1000, config);
      frame(infinite, 1000, config);
    }
    expect(zero.enemies.length).toBe(10);
    expect(infinite.enemies.length).toBe(10);
  });
});
