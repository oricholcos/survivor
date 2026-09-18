// src/core/events.test.ts —— 事件队列 API：入队、按序取出、消费后清空；高频 sfx 节流推送契约。
import { describe, expect, it } from 'vitest';
import {
  drainEvents,
  pushEvent,
  pushSfxThrottled,
  type GameEvent,
} from './events';
import { createSimState } from './simState';

describe('事件队列', () => {
  it('pushEvent 入队、drainEvents 按入队顺序读出', () => {
    const state = createSimState(1);

    pushEvent(state, { kind: 'enemySpawned', typeId: 'grunt', isBoss: false });
    pushEvent(state, { kind: 'levelUp', level: 2 });
    pushEvent(state, { kind: 'sfx', name: 'hit' });

    const drained: GameEvent[] = drainEvents(state);
    expect(drained).toEqual([
      { kind: 'enemySpawned', typeId: 'grunt', isBoss: false },
      { kind: 'levelUp', level: 2 },
      { kind: 'sfx', name: 'hit' },
    ]);
  });

  it('消费后清空：再次 drain 返回空数组', () => {
    const state = createSimState(1);

    pushEvent(state, { kind: 'victory' });
    expect(drainEvents(state)).toEqual([{ kind: 'victory' }]);
    expect(drainEvents(state)).toEqual([]);
    expect(state.events).toEqual([]);
  });

  it('空队列直接 drain 返回空数组', () => {
    const state = createSimState(1);

    expect(drainEvents(state)).toEqual([]);
  });

  it('全事件种类可入队且字段保真', () => {
    const state = createSimState(1);

    pushEvent(state, { kind: 'gameOver' });
    pushEvent(state, { kind: 'victory' });
    pushEvent(state, { kind: 'levelUp', level: 3 });
    pushEvent(state, { kind: 'enemyKilled', enemyId: 11, typeId: 'boss_giant', x: 12.5, y: 1159.5, isBoss: true });
    pushEvent(state, { kind: 'enemySpawned', typeId: 'grunt', isBoss: false });
    pushEvent(state, { kind: 'wallDamaged', amount: 7, hp: 993 });
    pushEvent(state, { kind: 'bossDefeated' });
    pushEvent(state, { kind: 'sfx', name: 'explosion' });

    expect(drainEvents(state)).toEqual([
      { kind: 'gameOver' },
      { kind: 'victory' },
      { kind: 'levelUp', level: 3 },
      { kind: 'enemyKilled', enemyId: 11, typeId: 'boss_giant', x: 12.5, y: 1159.5, isBoss: true },
      { kind: 'enemySpawned', typeId: 'grunt', isBoss: false },
      { kind: 'wallDamaged', amount: 7, hp: 993 },
      { kind: 'bossDefeated' },
      { kind: 'sfx', name: 'explosion' },
    ]);
  });

  it('drain 后新事件入队独立于上一批', () => {
    const state = createSimState(1);

    pushEvent(state, { kind: 'victory' });
    drainEvents(state);
    pushEvent(state, { kind: 'bossDefeated' });

    expect(state.events).toEqual([{ kind: 'bossDefeated' }]);
    expect(drainEvents(state)).toEqual([{ kind: 'bossDefeated' }]);
    expect(drainEvents(state)).toEqual([]);
  });
});

describe('pushSfxThrottled 节流推送', () => {
  it('窗口内首个通过、后续同名丢弃（不分配事件对象）', () => {
    const state = createSimState(1);
    state.timeMs = 100;

    pushSfxThrottled(state, 'hit', 30);
    pushSfxThrottled(state, 'hit', 30);
    pushSfxThrottled(state, 'hit', 30);

    // 仅首个事件入队，后续同窗口请求直接丢弃
    expect(state.events).toEqual([{ kind: 'sfx', name: 'hit' }]);
  });

  it('跨窗口恢复：不足间隔仍丢弃，间隔达到后再次放行（基准为上次放行时刻）', () => {
    const state = createSimState(1);
    state.timeMs = 100;
    pushSfxThrottled(state, 'hit', 30);

    // 被丢弃的请求不推进间隔基准：110/120 的尝试不影响判定
    state.timeMs = 110;
    pushSfxThrottled(state, 'hit', 30);
    state.timeMs = 120;
    pushSfxThrottled(state, 'hit', 30);
    expect(state.events).toEqual([{ kind: 'sfx', name: 'hit' }]);

    state.timeMs = 129; // 129 - 100 = 29 < 30：距上次「放行」不足间隔，仍丢弃
    pushSfxThrottled(state, 'hit', 30);
    expect(state.events).toHaveLength(1);

    state.timeMs = 130; // 恰好 30ms：跨窗口恢复放行
    pushSfxThrottled(state, 'hit', 30);
    expect(state.events).toEqual([
      { kind: 'sfx', name: 'hit' },
      { kind: 'sfx', name: 'hit' },
    ]);
  });

  it('不同 name 互不影响：各自独立计时', () => {
    const state = createSimState(1);
    state.timeMs = 100;

    pushSfxThrottled(state, 'shoot', 30);
    pushSfxThrottled(state, 'hit', 30); // 同一时刻不同名：各自的首个事件都通过
    pushSfxThrottled(state, 'shoot', 30); // shoot 窗口内丢弃
    pushSfxThrottled(state, 'hit', 30); // hit 窗口内丢弃

    expect(state.events).toEqual([
      { kind: 'sfx', name: 'shoot' },
      { kind: 'sfx', name: 'hit' },
    ]);
  });

  it('meta 状态隔离：不同 state 各自独立；节流记录随 state 重建（restart 等价全新窗口）', () => {
    const a = createSimState(1);
    const b = createSimState(2);
    a.timeMs = 100;
    b.timeMs = 100;

    pushSfxThrottled(a, 'hit', 30);
    pushSfxThrottled(b, 'hit', 30); // b 的首个 hit 不受 a 的记录影响
    pushSfxThrottled(a, 'hit', 30); // a 窗口内丢弃

    expect(a.events).toEqual([{ kind: 'sfx', name: 'hit' }]);
    expect(b.events).toEqual([{ kind: 'sfx', name: 'hit' }]);

    // restart 语义 = createSimState 重建 state（meta 归零）：新局首个事件恒通过
    const fresh = createSimState(1);
    fresh.timeMs = 100;
    pushSfxThrottled(fresh, 'hit', 30);
    expect(fresh.events).toEqual([{ kind: 'sfx', name: 'hit' }]);
  });

  it('节流不影响普通事件：pushEvent 的 sfx 与其他事件照常入队', () => {
    const state = createSimState(1);
    state.timeMs = 100;

    pushSfxThrottled(state, 'hit', 30);
    pushEvent(state, { kind: 'sfx', name: 'hit' }); // 原始 push 不受节流约束（低频 sfx 专用）
    pushEvent(state, { kind: 'enemyKilled', enemyId: 1, typeId: 'runner', x: 0, y: 0, isBoss: false });

    expect(state.events).toEqual([
      { kind: 'sfx', name: 'hit' },
      { kind: 'sfx', name: 'hit' },
      { kind: 'enemyKilled', enemyId: 1, typeId: 'runner', x: 0, y: 0, isBoss: false },
    ]);
  });
});
