// src/core/waves.ts —— waves.json 时间轴解释器：匀速刷怪段 + 爆发波节点 + 血量/密度膨胀。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM（ESLint 强制）。
// 确定性契约：一切随机（刷怪 x 位置）走 state.rng，禁 Math.random；
// 同配置同种子必得同刷怪序列（spawn 顺序：先本帧匀速段、后时间轴顺序的爆发波）。
//
// 语义约定（契约来源：survivor-tasks.md T3.1）：
// - 时钟：clock 缺省时为线性时间 { timelineSec: state.timeMs/1000, loopCount: 0, loopScale: 1 }。
//   与 step.ts 的推进顺序一致（timeMs 先 += dt 再调 hooks），默认时钟读到的是「含本帧 dt」的时间轴位置；
//   无尽模式的真实时钟（timelineSec 循环回绕 / loopCount / loopScale 递增）由 T3.4 提供并传入，本文件只消费。
// - 匀速段：取 fromSec <= timelineSec 的最后一个含 spawn 的条目为当前段（同帧跨段整段用新段的 perSec）；
//   spawnAcc += perSec × dtSec × loopScale（loopScale 做密度膨胀），acc >= 1 时取整次数刷怪并扣减。
// - 爆发波：条目 fromSec 首次被 timelineSec 跨过（上一帧 timelineSec < fromSec <= 本帧 timelineSec）
//   且未 fire 时一次性触发：刷 count 个 burst 敌人（hp × strengthFactor，只压低杂兵）+ 可选 boss 一只
//   （boss 只吃时间/循环膨胀，不吃 strengthFactor）。firedBurstKeys 的键含 loopCount，跨循环可重触发；
//   检测到时间轴回退（新循环把 timelineSec 拨回回绕点 loopFromSec）时，按回绕后的位置
//   重新检测跨段：只重触发回绕点之后的「表尾循环段」内爆发波（T3.6 修复，见 waves.test 与 balance.test）。
// - 血量膨胀：本帧所有 spawn 的敌人 hp/maxHp × (1 + scaling.hpPerSec × timelineSec) × loopScale
//   （先经 spawnEnemy 以 type.hp 落地，再改写 hp/maxHp）。
// - 模拟已结束（state.over !== null）直接 return（与 enemies.ts / wall.ts 同款防重入）。
// - campaignDurationSec 与 endlessLoop 字段属于数据契约：通关判定在 T3.3、循环时钟在 T3.4 消费，
//   本解释器不解释它们。

import { pushEvent } from './events';
import { spawnEnemy } from './enemies';
import type { EnemyTypeData } from './enemies';
import type { Enemy, SimState } from './types';

/** 匀速段规则：以 perSec（只/秒）的速率持续刷 enemy。 */
export interface WaveSpawnRule {
  enemy: string;
  perSec: number;
}

/** 爆发波规则：跨过 fromSec 时一次性刷 count 个 enemy（hp × strengthFactor）+ 可选 boss 一只。 */
export interface WaveBurst {
  enemy: string;
  count: number;
  boss?: string;
  /** 杂兵强度系数（缺省 1；只作用于 count 个杂兵，不作用于 boss）。 */
  strengthFactor?: number;
}

/** 时间轴条目：fromSec 起生效；可含匀速段、爆发波或两者兼有。 */
export interface WaveTimelineEntry {
  fromSec: number;
  spawn?: WaveSpawnRule;
  burst?: WaveBurst;
}

/** waves.json 顶层结构（数值契约：全部数值只存在于 waves.json）。 */
export interface WavesConfig {
  /** 通关模式总时长（秒）：本解释器不消费，通关判定（T3.3）与循环时钟（T3.4）使用。 */
  campaignDurationSec: number;
  /** 时间轴（建议按 fromSec 升序排列；解释器对 burst 触发按数组顺序、spawn 段取「最后一个匹配」）。 */
  timeline: WaveTimelineEntry[];
  /** 无尽循环配置：loopFromSec 起按 scalingPerLoop 逐轮膨胀（真实时钟由 T3.4 实现）。 */
  endlessLoop?: { loopFromSec: number; scalingPerLoop: number };
  /** 血量随时间线性膨胀：因子 = 1 + hpPerSec × timelineSec。 */
  scaling: { hpPerSec: number };
}

/** 波次时钟输入：T3.4 为无尽模式提供真实实现，本解释器只消费。
 *  timelineSec：时间轴位置（秒，循环模式下在轮内回绕）；loopCount：已进入的循环轮数
 *  （爆发波触发键含它，跨轮可重触发）；loopScale：本轮膨胀系数（密度与血量同乘）。 */
export interface WaveClockInput {
  timelineSec: number;
  loopCount: number;
  loopScale: number;
}

/** 波次游标（存 state.meta.waves，懒初始化）。 */
export interface WavesMeta {
  /** 匀速段刷怪小数累加器：>= 1 时取整刷怪并扣减整数部分。 */
  spawnAcc: number;
  /** 上一帧 timelineSec（爆发波跨段检测基准；首帧按 0 起点计，故 fromSec=0 的爆发波不触发；
   *  回退时改记回绕后的位置——回绕点之前的爆发波不随循环重触发）。 */
  lastTimelineSec: number;
  /** 已触发的爆发波键（`${loopCount}:${时间轴条目下标}`），防同轮重复触发。 */
  firedBurstKeys: Record<string, true>;
}

/** 把 spawnEnemy 刚落地的敌人按膨胀因子改写 hp/maxHp（spawnEnemy 内部 hp = maxHp = type.hp），无尽模式 loopScale > 1 时敌经验按比例缩放。 */
function applyHpScale(enemy: Enemy, factor: number, loopScale: number = 1): void {
  enemy.hp = enemy.maxHp = enemy.maxHp * factor;
  if (loopScale > 1) {
    enemy.xp = Math.max(1, Math.round(enemy.xp * loopScale));
  }
}

/** 读取（或懒初始化）state.meta.waves 游标。 */
function getMeta(state: SimState): WavesMeta {
  let meta = state.meta.waves as WavesMeta | undefined;
  if (meta === undefined) {
    meta = { spawnAcc: 0, lastTimelineSec: 0, firedBurstKeys: {} };
    state.meta.waves = meta;
  }
  return meta;
}

/**
 * 动态计算敌人出生安全边距：普通怪 Math.max(radius + 10, 32)；Boss Math.max(radius * 1.5 + 24, 72)。
 */
export function calculateSpawnMargin(type: EnemyTypeData): number {
  return type.isBoss
    ? Math.max(type.radius * 1.5 + 24, 72)
    : Math.max(type.radius + 10, 32);
}

/**
 * 推进一帧波次刷怪。约定：
 * 1) state.over !== null 直接 return；clock 缺省用线性时间（state.timeMs/1000）；
 * 2) 匀速段：当前段 = fromSec <= timelineSec 的最后一个含 spawn 条目；
 *    spawnAcc += perSec × dtSec × loopScale，acc >= 1 时取整刷怪（x = rng.range(margin, width-margin)）；
 *    段敌人 id 不在 enemyTypes 时整段跳过（防御坏表，不污染累加器）；
 * 3) 爆发波：按时间轴顺序，对〈上一帧 timelineSec < fromSec <= 本帧 timelineSec〉且未 fire 的
 *    条目各触发一次（同帧跨多条全触发）；时间轴回退（新循环）时按回绕后位置重新检测；
 * 4) 本帧所有 spawn 的敌人 hp/maxHp × (1 + scaling.hpPerSec × timelineSec) × loopScale，
 *    burst 杂兵额外 × strengthFactor（boss 不乘）；
 * 5) 帧末把 lastTimelineSec 置为 timelineSec。
 */
export function updateWaves(
  state: SimState,
  dtMs: number,
  config: WavesConfig,
  enemyTypes: Record<string, EnemyTypeData>,
  clock?: WaveClockInput,
): void {
  if (state.over !== null) {
    return;
  }

  const timelineSec = clock !== undefined ? clock.timelineSec : state.timeMs / 1000;
  const loopCount = clock !== undefined ? clock.loopCount : 0;
  const loopScale = clock !== undefined ? clock.loopScale : 1;

  const meta = getMeta(state);

  // 时间轴回退（无尽模式新循环把时间轴拨回回绕点 loopFromSec 附近）：按回绕后的位置
  // 重新检测跨段——只重触发回绕点之后的段内爆发波（〈表尾循环段〉语义）。
  // 若按 0 起点重置，回绕点之前的时间轴爆发波会在回绕帧被误判为〈刚跨过〉而全部
  // 同时重触发（如 loopFromSec=540 时 85~525s 的爆发波会在 601s 一帧内齐射）。
  if (timelineSec < meta.lastTimelineSec) {
    meta.lastTimelineSec = timelineSec;
  }

  // 血量膨胀因子（时间线性 + 循环系数）。
  const hpScale = (1 + config.scaling.hpPerSec * timelineSec) * loopScale;

  // 1) 匀速段：fromSec <= timelineSec 的最后一个含 spawn 的条目为当前段。
  let spawnRule: WaveSpawnRule | undefined;
  const timeline = config.timeline;
  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i];
    if (entry.fromSec <= timelineSec && entry.spawn !== undefined) {
      spawnRule = entry.spawn;
    }
  }
  if (spawnRule !== undefined) {
    const type = enemyTypes[spawnRule.enemy];
    if (type !== undefined) {
      meta.spawnAcc += spawnRule.perSec * (dtMs / 1000) * loopScale;
      const n = Math.floor(meta.spawnAcc);
      if (n >= 1) {
        meta.spawnAcc -= n;
        const margin = calculateSpawnMargin(type);
        for (let k = 0; k < n; k++) {
          applyHpScale(spawnEnemy(state, type, state.rng.range(margin, state.layout.width - margin)), hpScale, loopScale);
        }
      }
    }
  }

  // 2) 爆发波：按时间轴顺序检测跨段触发（同帧跨多条全触发，触发顺序 = 数组顺序）。
  for (let i = 0; i < timeline.length; i++) {
    const burst = timeline[i].burst;
    if (burst === undefined) {
      continue;
    }
    const fromSec = timeline[i].fromSec;
    if (!(meta.lastTimelineSec < fromSec && fromSec <= timelineSec)) {
      continue;
    }
    const key = `${loopCount}:${i}`;
    if (meta.firedBurstKeys[key] === true) {
      continue;
    }
    meta.firedBurstKeys[key] = true;
    // 音效事件（T4.1）：爆发波警示音，每波触发恰好一次（在刷怪前 push，即使敌型缺失也不漏）。
    pushEvent(state, { kind: 'sfx', name: 'burst' });

    const type = enemyTypes[burst.enemy];
    if (type !== undefined) {
      const factor = (burst.strengthFactor !== undefined ? burst.strengthFactor : 1) * hpScale;
      const margin = calculateSpawnMargin(type);
      for (let k = 0; k < burst.count; k++) {
        applyHpScale(spawnEnemy(state, type, state.rng.range(margin, state.layout.width - margin)), factor, loopScale);
      }
    }
    if (burst.boss !== undefined) {
      const bossType = enemyTypes[burst.boss];
      if (bossType !== undefined) {
        // boss 只吃时间/循环膨胀，不吃 strengthFactor（强度系数只压低杂兵）。
        const margin = calculateSpawnMargin(bossType);
        applyHpScale(spawnEnemy(state, bossType, state.rng.range(margin, state.layout.width - margin)), hpScale, loopScale);
      }
    }
  }

  meta.lastTimelineSec = timelineSec;
}
