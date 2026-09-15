// src/core/events.test.ts —— 事件队列 API：入队、按序取出、消费后清空。
import { describe, expect, it } from 'vitest';
import { drainEvents, pushEvent, type GameEvent } from './events';
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
