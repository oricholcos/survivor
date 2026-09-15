// src/core/bossRewards.test.ts —— Boss 击杀奖励契约：
// Boss 数值来自 enemies.json（boss_1 携带 bossHealPct=T3.6 校准值 0.055、普通怪不带）、击杀奖励恰好一次
// （墙回复一次 + bossDefeated/levelUp 各一个）、非 Boss 无效果、同 Boss 防重幂等、
// 回复钳到 maxHp、levelUp 携带结算时刻的当前等级。
// 夹具约定：敌人一律走 spawnEnemy（实体字段来自 enemies.json），不手搓 Enemy。

import { describe, expect, it } from 'vitest';
import { loadEnemyTypes } from '../data/enemies';
import type { EnemyTypeData } from './enemies';
import { onBossDefeated, readBossHealPct } from './bossRewards';
import { spawnEnemy } from './enemies';
import { drainEvents } from './events';
import { createSimState } from './simState';
import type { Enemy, SimState } from './types';

/** Boss 特有字段交叉类型：EnemyTypeData 无 bossHealPct（types/enemies 契约不可改），读法见 readBossHealPct。 */
type BossTypeData = EnemyTypeData & { bossHealPct?: number };

/** 真实数据表：Boss 数值全部来自 enemies.json（验收「数值来自 JSON」用真表跑）。 */
const TYPES = loadEnemyTypes();

/** 用真实 enemies.json 条目刷一只敌人（spawnEnemy：hp=maxHp、march 态、push enemySpawned）。 */
function spawn(state: SimState, type: EnemyTypeData): Enemy {
  return spawnEnemy(state, type, state.layout.width / 2);
}

describe('Boss 数值来自 enemies.json', () => {
  it('boss_1 条目：isBoss 与战斗数值齐备且 bossHealPct = 0.055（T3.6 校准值）', () => {
    const boss = TYPES['boss_1'] as BossTypeData;
    expect(boss).toBeDefined();
    expect(boss.isBoss).toBe(true);
    expect(boss.hp).toBe(900);
    expect(boss.damage).toBe(36); // T3.6 校准：40 → 36
    expect(boss.speed).toBe(40);
    expect(boss.attackIntervalMs).toBe(1200);
    expect(boss.xp).toBe(30);
    expect(boss.radius).toBe(34);
    expect(boss.bossHealPct).toBe(0.055); // T3.6 校准：0.2 → 0.055
  });

  it('readBossHealPct：boss_1 取 0.055；普通怪条目无该字段 → 取 0', () => {
    expect(readBossHealPct(TYPES['boss_1'])).toBe(0.055);
    expect(readBossHealPct(TYPES['runner'])).toBe(0);
    expect(readBossHealPct(TYPES['standard'])).toBe(0);
    expect(readBossHealPct(TYPES['tank'])).toBe(0);
  });
});

describe('onBossDefeated：击杀奖励结算', () => {
  it('Boss 击杀：墙回复恰好一次 = maxHp × bossHealPct，事件 [bossDefeated, levelUp] 恰好各一个', () => {
    const state = createSimState(42); // 默认 wallMaxHp（T5.3a 校准 3200）
    const boss = spawn(state, TYPES['boss_1']);
    state.wall.hp = 500; // 已损血：缺口 500

    drainEvents(state); // 清掉 spawn 的 enemySpawned，只观察奖励事件
    onBossDefeated(state, boss, { healPct: readBossHealPct(TYPES['boss_1'] as BossTypeData) });

    // 回复量 = maxHp × 0.055（恰好一次，不多不少）
    expect(state.wall.hp).toBe(500 + state.wall.maxHp * 0.055);
    expect(state.wall.hp).toBeCloseTo(500 + state.wall.maxHp * 0.055, 9);
    expect(drainEvents(state)).toEqual([
      { kind: 'bossDefeated' },
      { kind: 'levelUp', level: state.progress.level },
    ]);
  });

  it('非 Boss 敌人：无效果（不回血、无事件、不占防重标记）', () => {
    const state = createSimState(7);
    const mook = spawn(state, TYPES['standard']); // isBoss=false
    state.wall.hp = 500;

    drainEvents(state);
    onBossDefeated(state, mook, { healPct: 1 }); // 即便给满比例也不生效

    expect(state.wall.hp).toBe(500);
    expect(state.events).toEqual([]);
    expect(state.meta.bossRewarded).toBeUndefined(); // 不占防重标记
  });

  it('防重：同一 Boss 重复调用只奖励一次（第二次起不回血、无事件）', () => {
    const state = createSimState(9);
    const boss = spawn(state, TYPES['boss_1']);
    state.wall.hp = 400;

    drainEvents(state);
    onBossDefeated(state, boss, { healPct: 0.2 });
    expect(state.wall.hp).toBe(400 + state.wall.maxHp * 0.2); // 恰好一次
    expect(drainEvents(state)).toEqual([
      { kind: 'bossDefeated' },
      { kind: 'levelUp', level: state.progress.level },
    ]);

    // 重复调用：幂等——墙血不变、无事件，防重标记保持
    onBossDefeated(state, boss, { healPct: 0.2 });
    onBossDefeated(state, boss, { healPct: 0.2 });
    expect(state.wall.hp).toBe(400 + state.wall.maxHp * 0.2);
    expect(state.events).toEqual([]);
    const rewarded = state.meta.bossRewarded as Record<number, true>;
    expect(rewarded[boss.id]).toBe(true);
  });

  it('不同 Boss（不同 id）各自奖励一次，互不挤占', () => {
    const state = createSimState(11);
    const a = spawn(state, TYPES['boss_1']);
    const b = spawn(state, TYPES['boss_1']); // 不同 enemyId
    state.wall.hp = 400;

    drainEvents(state);
    onBossDefeated(state, a, { healPct: 0.2 });
    expect(state.wall.hp).toBe(400 + state.wall.maxHp * 0.2);
    onBossDefeated(state, b, { healPct: 0.2 });
    expect(state.wall.hp).toBe(400 + state.wall.maxHp * 0.4);
    // 两只 Boss 各自完整发一轮 [bossDefeated, levelUp]
    expect(drainEvents(state)).toEqual([
      { kind: 'bossDefeated' },
      { kind: 'levelUp', level: state.progress.level },
      { kind: 'bossDefeated' },
      { kind: 'levelUp', level: state.progress.level },
    ]);
  });

  it('回复钳到 maxHp：回复量大于缺口时不越上限', () => {
    const state = createSimState(13);
    const boss = spawn(state, TYPES['boss_1']);
    state.wall.hp = state.wall.maxHp - 100; // 900/1000：缺口 100

    drainEvents(state);
    onBossDefeated(state, boss, { healPct: 0.9 }); // 拟回复 900 > 缺口 → 钳到 1000

    expect(state.wall.hp).toBe(state.wall.maxHp);
    expect(drainEvents(state).map((e) => e.kind)).toEqual(['bossDefeated', 'levelUp']);
  });

  it('levelUp 事件携带结算时刻的当前 level', () => {
    const state = createSimState(17);
    const boss = spawn(state, TYPES['boss_1']);
    state.progress.level = 7;
    const levelAtKill = state.progress.level;

    drainEvents(state);
    onBossDefeated(state, boss, { healPct: 0.2 });

    const events = drainEvents(state);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ kind: 'bossDefeated' });
    expect(events[1]).toEqual({ kind: 'levelUp', level: levelAtKill });
    expect(events[1]).toEqual({ kind: 'levelUp', level: 7 });
  });
});
