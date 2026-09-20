// src/core/simState.test.ts —— SimState 工厂与 step 推进骨架的行为契约。
import { describe, expect, it } from 'vitest';
import { BATTLE_RNG_META_KEY, createSimState } from './simState';
import { step } from './step';
import type { SimState } from './types';

/** 记录 hook 执行序号的轻量探针。 */
function makeProbe(state: SimState, trace: string[], name: string): void {
  state.hooks.push((s, dtMs) => {
    trace.push(name);
    expect(s).toBe(state);
    expect(typeof dtMs).toBe('number');
  });
}

describe('createSimState', () => {
  it('空局初始字段符合契约', () => {
    const state = createSimState(42);

    expect(state.seed).toBe(42);
    expect(state.layout).toEqual({ width: 720, height: 1280, wallLineY: 1160, spawnLineY: -40 });
    expect(state.config).toEqual({
      xpBase: 5,
      xpTier1Step: 4,
      xpTier2Step: 8,
      gemFlySpeed: 600,
      dropFlySpeed: 600,
      repairDropChance: 0.02,
      repairHeal: 30,
      wallMaxHp: 1600,
      maxWeaponSlots: 4,
      maxProjectiles: 600,
      maxEnemies: 350,
    });
    expect(state.wall).toEqual({ hp: 1600, maxHp: 1600 });
    expect(state.character).toEqual({ x: 360, y: 1220 }); // (width/2, height-60)
    expect(state.enemies).toEqual([]);
    expect(state.projectiles).toEqual([]);
    expect(state.gems).toEqual([]);
    expect(state.drops).toEqual([]);
    expect(state.weaponStates).toEqual({});
    expect(state.hooks).toEqual([]);
    expect(state.events).toEqual([]);
    // meta 随局仅建立第二独立随机流（战斗期掷点专用，种子 = 会话种子 XOR 0x9E3779B9）。
    expect(Object.keys(state.meta)).toEqual([BATTLE_RNG_META_KEY]);
    expect(state.timeMs).toBe(0);
    expect(state.over).toBeNull();
    expect(state.progress).toEqual({ xp: 0, level: 1 });
    // rng 存在且可调用（默认 LCG 自包含实现，确定性可复现）
    expect(typeof state.rng.next()).toBe('number');
    expect(state.rng.int(10)).toBeGreaterThanOrEqual(0);
    expect(state.rng.int(10)).toBeLessThan(10);
  });

  it('Partial<SimConfig> 逐字段覆盖且不影响其余默认值', () => {
    const state = createSimState(7, { wallMaxHp: 500, repairDropChance: 0.1 });

    expect(state.config.wallMaxHp).toBe(500);
    expect(state.config.repairDropChance).toBeCloseTo(0.1);
    expect(state.config.xpBase).toBe(5); // 未覆盖字段保持默认
    expect(state.wall).toEqual({ hp: 500, maxHp: 500 });
  });

  it('同种子两次创建的默认 RNG 序列一致（可复现）', () => {
    const a = createSimState(123);
    const b = createSimState(123);

    const seqA = [a.rng.next(), a.rng.next(), a.rng.next()];
    const seqB = [b.rng.next(), b.rng.next(), b.rng.next()];
    expect(seqB).toEqual(seqA);
  });
});

describe('step 推进骨架', () => {
  it('空局 step(16) 不抛错且 timeMs 前进 16', () => {
    const state = createSimState(1);

    expect(() => step(state, 16)).not.toThrow();
    expect(state.timeMs).toBe(16);
  });

  it('单次 200ms 被钳到 50ms', () => {
    const state = createSimState(1);

    step(state, 200);
    expect(state.timeMs).toBe(50);
  });

  it('非有限 / 负 dt 按 0 处理（仍执行 hooks、时间不动）', () => {
    const state = createSimState(1);
    const trace: string[] = [];
    makeProbe(state, trace, 'a');

    step(state, Number.NaN);
    expect(state.timeMs).toBe(0);
    expect(trace).toEqual(['a']);

    step(state, Number.POSITIVE_INFINITY);
    step(state, -5);
    expect(state.timeMs).toBe(0);
    expect(trace).toEqual(['a', 'a', 'a']);
  });

  it('hooks 按注册顺序执行并收到 dt', () => {
    const state = createSimState(1);
    const trace: string[] = [];
    state.hooks.push((_s, dtMs) => trace.push(`a:${dtMs}`));
    state.hooks.push((_s, dtMs) => trace.push(`b:${dtMs}`));
    state.hooks.push((_s, dtMs) => trace.push(`c:${dtMs}`));

    step(state, 16);
    expect(trace).toEqual(['a:16', 'b:16', 'c:16']);
    expect(state.timeMs).toBe(16);
  });

  it('over 非 null 后 step 停摆：时间不动、hooks 不执行', () => {
    const state = createSimState(1);
    const trace: string[] = [];
    makeProbe(state, trace, 'a');
    step(state, 16);
    expect(state.timeMs).toBe(16);

    state.over = 'defeat';
    step(state, 16);
    expect(state.timeMs).toBe(16); // 不再前进
    expect(trace).toEqual(['a']); // 之前只执行过一次，over 后不再执行

    state.over = 'victory';
    step(state, 100);
    expect(state.timeMs).toBe(16);
    expect(trace).toEqual(['a']);
  });

  it('恰好 50ms 原样保留，不误钳', () => {
    const state = createSimState(1);

    step(state, 50);
    expect(state.timeMs).toBe(50);
  });
});
