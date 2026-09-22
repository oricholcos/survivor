// src/core/victory.test.ts —— 通关模式 Boss 击杀与胜利判定的行为契约：
// 击杀指定数量 Boss（如 6 只）恰好一次胜利（纯函数幂等 + step 停摆双验证）、未杀满不触发、
// 即使时间撑满 10 分钟只要 Boss 未杀满也不触发、endless 永不胜利、targetBossKills 参数化、
// 与失败判定先到先得（defeat 不被覆盖）。
import { describe, expect, it } from 'vitest';
import { drainEvents } from './events';
import { createSimState } from './simState';
import { step } from './step';
import type { Enemy, SimState } from './types';
import { updateWallCombat } from './wall';
import { checkVictory, type GameMode } from './victory';

/** 把 checkVictory 包装成 step hook（与集成层接线同形态：hook 只需 state 参数）。 */
function victoryHook(targetBossKills: number, mode: GameMode): (state: SimState) => void {
  return (state) => {
    checkVictory(state, targetBossKills, mode);
  };
}

/** 构造一个贴墙攻击态敌人（夹具：未覆盖字段取无害占位值，全部数值仅存在于测试夹具）。 */
function makeAttacker(overrides: Partial<Enemy>): Enemy {
  return {
    id: 1,
    typeId: 'tester',
    name: '测试怪',
    x: 360,
    y: 1160,
    radius: 12,
    hp: 10,
    maxHp: 10,
    speed: 0,
    damage: 5,
    attackIntervalMs: 1000,
    attackCooldownMs: 1000,
    state: 'attack',
    isBoss: false,
    xp: 1,
    color: 0xff0000,
    shape: 'box',
    effects: [],
    dead: false,
    ...overrides,
  };
}

describe('checkVictory campaign：击杀固定数量 Boss 胜利', () => {
  it('hook 接线：未达到 6 只 Boss 不触发胜利；达到 6 之后恰好一次胜利，随后 step 停摆 + 幂等', () => {
    const state = createSimState(7);
    let hookCalls = 0;
    state.hooks.push((s) => {
      hookCalls++;
      checkVictory(s, 6, 'campaign');
    });

    // 快进模拟时间至 10 分钟（600_000ms），但未击杀满 6 只 Boss（仅 5 只）
    state.meta.bossKills = 5;
    for (let i = 0; i < 12_000 && state.over === null; i++) {
      step(state, 50);
    }
    expect(state.over).toBeNull();
    expect(state.timeMs).toBe(600_000);
    expect(state.events).toEqual([]);

    // 击杀第 6 只 Boss：下一次 step/checkVictory 立即触发胜利
    state.meta.bossKills = 6;
    step(state, 50);
    expect(state.over).toBe('victory');
    expect(drainEvents(state)).toEqual([{ kind: 'victory' }]);

    // ② step 停摆：over 非 null 后不再推进时间、hooks 不执行、事件不再增加
    const frozenTime = state.timeMs;
    const recordedCalls = hookCalls;
    step(state, 50);
    step(state, 16);
    step(state, -10);
    step(state, Number.NaN);
    expect(state.timeMs).toBe(frozenTime);
    expect(hookCalls).toBe(recordedCalls);
    expect(drainEvents(state)).toEqual([]);

    // ① 纯函数幂等：胜利后再调 checkVictory 不覆盖、不重复发事件
    checkVictory(state, 6, 'campaign');
    checkVictory(state, 1, 'campaign');
    expect(state.over).toBe('victory');
    expect(drainEvents(state)).toEqual([]);
  });

  it('纯函数幂等（不经 step）：已满足条件的 state 两次调用只发一次 victory', () => {
    const state = createSimState(1);
    state.meta.bossKills = 6;

    checkVictory(state, 6, 'campaign');
    checkVictory(state, 6, 'campaign');

    expect(state.over).toBe('victory');
    expect(drainEvents(state)).toEqual([{ kind: 'victory' }]);
    expect(drainEvents(state)).toEqual([]);
  });
});

describe('checkVictory 触发边界与模式', () => {
  it('campaign 未达目标数量不触发（5 < 6）', () => {
    const state = createSimState(1);
    state.meta.bossKills = 5;

    checkVictory(state, 6, 'campaign');

    expect(state.over).toBeNull();
    expect(state.events).toEqual([]);
  });

  it('campaign 恰好等于 targetBossKills 触发（>= 语义）', () => {
    const state = createSimState(1);
    state.meta.bossKills = 6;

    checkVictory(state, 6, 'campaign');

    expect(state.over).toBe('victory');
    expect(state.events).toEqual([{ kind: 'victory' }]);
  });

  it('endless 模式即使击杀远超目标数量也不触发（扛到死）', () => {
    const state = createSimState(1);
    state.meta.bossKills = 100;
    checkVictory(state, 6, 'endless');
    expect(state.over).toBeNull();
    expect(state.events).toEqual([]);

    // 目标 0、击杀满，endless 依旧永不胜利
    checkVictory(state, 0, 'endless');
    expect(state.over).toBeNull();
    expect(state.events).toEqual([]);
  });

  it.each([1, 3, 5])(
    'targetBossKills 参数化（%i 只）：击杀满立即触发恰好一次',
    (target) => {
      const state = createSimState(3);
      state.hooks.push(victoryHook(target, 'campaign'));

      state.meta.bossKills = target - 1;
      step(state, 50);
      expect(state.over).toBeNull();
      expect(state.events).toEqual([]);

      state.meta.bossKills = target;
      step(state, 50);
      expect(state.over).toBe('victory');
      expect(drainEvents(state)).toEqual([{ kind: 'victory' }]);
    },
  );
});

describe('checkVictory 与失败判定并存（先到先得）', () => {
  it("over='defeat' 后调 checkVictory：不覆盖成 victory、不发 victory 事件", () => {
    const state = createSimState(1);
    state.over = 'defeat';
    state.meta.bossKills = 6;

    checkVictory(state, 6, 'campaign');
    checkVictory(state, 0, 'campaign');

    expect(state.over).toBe('defeat');
    expect(state.events).toEqual([]);
  });

  it('step 集成：同帧墙破与击杀并存，墙 hook 先结算 → defeat 先到，不出现 victory', () => {
    const state = createSimState(5, { wallMaxHp: 1000 });
    // 一击破墙的攻击态敌人：attackCooldownMs=200，第 4 帧（累计 200ms）到点攻击破墙
    state.enemies.push(makeAttacker({ damage: 1000, attackIntervalMs: 200, attackCooldownMs: 200 }));
    state.hooks.push(updateWallCombat);
    state.hooks.push(victoryHook(1, 'campaign'));

    // 前 3 帧累积
    for (let i = 0; i < 3; i++) {
      step(state, 50);
    }
    // 第 4 帧墙破的同时，假定击杀达到 1
    state.meta.bossKills = 1;
    step(state, 50);

    expect(state.over).toBe('defeat'); // 第 4 帧墙先破，defeat 先到
    expect(drainEvents(state)).toEqual([
      { kind: 'wallDamaged', amount: 1000, hp: 0 },
      { kind: 'gameOver' },
    ]);
    expect(state.events).toEqual([]); // 无 victory 事件，defeat 不被覆盖
  });
});
