// src/core/victory.test.ts —— 通关模式计时与胜利判定的行为契约：
// 快进 10 分钟恰好一次胜利（纯函数幂等 + step 停摆双验证）、未到点不触发、
// endless 永不胜利、durationMs 参数化、与失败判定先到先得（defeat 不被覆盖）。
import { describe, expect, it } from 'vitest';
import { drainEvents } from './events';
import { createSimState } from './simState';
import { step } from './step';
import type { Enemy, SimState } from './types';
import { updateWallCombat } from './wall';
import { checkVictory, type GameMode } from './victory';

/** 把 checkVictory 包装成 step hook（与集成层接线同形态：hook 只需 state 参数）。 */
function victoryHook(durationMs: number, mode: GameMode): (state: SimState) => void {
  return (state) => {
    checkVictory(state, durationMs, mode);
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

describe('checkVictory campaign：快进模拟到 10 分钟', () => {
  it('hook 接线快进 600_000ms：恰好一次胜利，随后 step 停摆 + 再调 checkVictory 幂等', () => {
    const state = createSimState(7);
    let hookCalls = 0;
    state.hooks.push((s) => {
      hookCalls++;
      checkVictory(s, 600_000, 'campaign');
    });

    // step 有 50ms 钳制：用 50ms 分步，11999 帧累计 599_950ms < 600_000，未到点不触发
    for (let i = 0; i < 11_999 && state.over === null; i++) {
      step(state, 50);
    }
    expect(state.over).toBeNull();
    expect(state.timeMs).toBe(599_950);

    // 第 12000 帧恰好累计 600_000ms：到点触发，victory 事件恰好一个
    step(state, 50);
    expect(state.timeMs).toBe(600_000);
    expect(state.over).toBe('victory');
    expect(drainEvents(state)).toEqual([{ kind: 'victory' }]);

    // ② step 停摆：over 非 null 后不再推进时间、hooks 不执行、事件不再增加
    const frozenTime = state.timeMs;
    step(state, 50);
    step(state, 16);
    step(state, -10); // 非法 dt 同样被停摆挡在门外
    step(state, Number.NaN);
    expect(state.timeMs).toBe(frozenTime);
    expect(hookCalls).toBe(12_000);
    expect(drainEvents(state)).toEqual([]);

    // ① 纯函数幂等：胜利后再调 checkVictory 不覆盖、不重复发事件
    checkVictory(state, 600_000, 'campaign');
    checkVictory(state, 0, 'campaign');
    expect(state.over).toBe('victory');
    expect(drainEvents(state)).toEqual([]);
  });

  it('纯函数幂等（不经 step）：timeMs 已到点的 state 两次调用只发一次 victory', () => {
    const state = createSimState(1);
    state.timeMs = 600_000;

    checkVictory(state, 600_000, 'campaign');
    checkVictory(state, 600_000, 'campaign');

    expect(state.over).toBe('victory');
    expect(drainEvents(state)).toEqual([{ kind: 'victory' }]);
    expect(drainEvents(state)).toEqual([]);
  });
});

describe('checkVictory 触发边界与模式', () => {
  it('campaign 未到点不触发（含只差 1ms 的边界）', () => {
    const state = createSimState(1);
    state.timeMs = 599_999;

    checkVictory(state, 600_000, 'campaign');

    expect(state.over).toBeNull();
    expect(state.events).toEqual([]);
  });

  it('campaign 恰好等于 durationMs 触发（>= 语义）', () => {
    const state = createSimState(1);
    state.timeMs = 600_000;

    checkVictory(state, 600_000, 'campaign');

    expect(state.over).toBe('victory');
    expect(state.events).toEqual([{ kind: 'victory' }]);
  });

  it('endless 模式即使远超时长也不触发（扛到死）', () => {
    const state = createSimState(1);
    state.timeMs = 600_000;
    checkVictory(state, 600_000, 'endless');
    expect(state.over).toBeNull();
    expect(state.events).toEqual([])

    // 再极端：时长 0、时间拉满，endless 依旧永不胜利
    state.timeMs = Number.MAX_SAFE_INTEGER;
    checkVictory(state, 0, 'endless');
    expect(state.over).toBeNull();
    expect(state.events).toEqual([]);
  });

  it.each([1000, 250, 100])(
    'durationMs 参数化（%i ms）：50ms 分步未到点不触发、到点触发恰好一次',
    (durationMs) => {
      const state = createSimState(3);
      state.hooks.push(victoryHook(durationMs, 'campaign'));

      // 首帧 50ms < durationMs（最小用例 100ms）：未到点不触发
      step(state, 50);
      expect(state.over).toBeNull();
      expect(state.events).toEqual([]);

      // 继续快进到累计 >= durationMs：触发恰好一次（50ms 钳制下至多 ceil(durationMs/50) 帧）
      const maxFrames = Math.ceil(durationMs / 50);
      for (let i = 1; i < maxFrames && state.over === null; i++) {
        step(state, 50);
      }
      step(state, 50);
      expect(state.over).toBe('victory');
      expect(drainEvents(state)).toEqual([{ kind: 'victory' }]);
    },
  );

  it('durationMs=1000、16ms 分步：第 63 帧才到点（992ms 不触发、1008ms 触发）', () => {
    const state = createSimState(11);
    state.hooks.push(victoryHook(1000, 'campaign'));

    for (let i = 0; i < 62; i++) {
      step(state, 16); // 62 × 16 = 992ms < 1000ms
    }
    expect(state.over).toBeNull();
    expect(state.events).toEqual([]);

    step(state, 16); // 1008ms >= 1000ms：到点
    expect(state.over).toBe('victory');
    expect(drainEvents(state)).toEqual([{ kind: 'victory' }]);
  });
});

describe('checkVictory 与失败判定并存（先到先得）', () => {
  it("over='defeat' 后调 checkVictory：不覆盖成 victory、不发 victory 事件", () => {
    const state = createSimState(1);
    state.over = 'defeat';
    state.timeMs = 600_000; // 时间与时长条件都满足，但 defeat 先到

    checkVictory(state, 600_000, 'campaign');
    checkVictory(state, 0, 'campaign');

    expect(state.over).toBe('defeat');
    expect(state.events).toEqual([]);
  });

  it('step 集成：同帧墙破与到点并存，墙 hook 先结算 → defeat 先到，不出现 victory', () => {
    const state = createSimState(5, { wallMaxHp: 1000 });
    // 一击破墙的攻击态敌人：attackCooldownMs=200，第 4 帧（累计 200ms）到点攻击破墙
    state.enemies.push(makeAttacker({ damage: 1000, attackIntervalMs: 200, attackCooldownMs: 200 }));
    state.hooks.push(updateWallCombat);
    state.hooks.push(victoryHook(200, 'campaign'));

    for (let i = 0; i < 4; i++) {
      step(state, 50);
    }

    // 前 3 帧累计 150ms < 200ms：墙未破、未到点
    expect(state.over).toBe('defeat'); // 第 4 帧墙先破，defeat 先到
    expect(state.timeMs).toBe(200);
    expect(drainEvents(state)).toEqual([
      { kind: 'wallDamaged', amount: 1000, hp: 0 },
      { kind: 'gameOver' },
    ]);
    expect(state.events).toEqual([]); // 无 victory 事件，defeat 不被覆盖
  });
});
