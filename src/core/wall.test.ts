// src/core/wall.test.ts —— 城墙受击结算 / 失败判定 / healWall 的行为契约。
import { describe, expect, it } from 'vitest';
import { drainEvents } from './events';
import { createSimState } from './simState';
import { step } from './step';
import type { Enemy } from './types';
import { healWall, updateWallCombat } from './wall';

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

describe('updateWallCombat 攻击节奏', () => {
  it('攻击间隔内多次 step 只扣一次血（2000ms 间隔，16ms 分步）', () => {
    const state = createSimState(1);
    state.enemies.push(makeAttacker({ damage: 4, attackIntervalMs: 2000, attackCooldownMs: 2000 }));
    state.hooks.push(updateWallCombat);

    // 124 × 16 = 1984ms < 2000ms：尚未到点，不扣血、无事件
    for (let i = 0; i < 124; i++) {
      step(state, 16);
    }
    expect(state.wall.hp).toBe(state.config.wallMaxHp);
    expect(state.events).toEqual([]);

    // 第 125 步累计 2000ms：冷却到点，恰好扣一次
    step(state, 16);
    expect(state.wall.hp).toBe(state.config.wallMaxHp - 4);
    expect(drainEvents(state)).toEqual([{ kind: 'wallDamaged', amount: 4, hp: state.config.wallMaxHp - 4 }]);

    // 下一轮：再等满 2000ms 才第二次扣血
    for (let i = 0; i < 124; i++) {
      step(state, 16);
    }
    expect(state.wall.hp).toBe(state.config.wallMaxHp - 4);
    step(state, 16);
    expect(state.wall.hp).toBe(state.config.wallMaxHp - 8);
    expect(drainEvents(state)).toEqual([{ kind: 'wallDamaged', amount: 4, hp: state.config.wallMaxHp - 8 }]);
  });

  it('伤害与节奏来自敌人实体字段：两个不同字段敌人扣血量 / 首击时刻随之不同', () => {
    // 敌 A：低伤高频（damage=3，interval=300）
    const a = createSimState(1);
    a.enemies.push(makeAttacker({ damage: 3, attackIntervalMs: 300, attackCooldownMs: 300 }));
    a.hooks.push(updateWallCombat);
    // 敌 B：高伤低频（damage=30，interval=1200）
    const b = createSimState(1);
    b.enemies.push(makeAttacker({ damage: 30, attackIntervalMs: 1200, attackCooldownMs: 1200 }));
    b.hooks.push(updateWallCombat);

    // step 对 dt 有 50ms 钳制，用 50ms 分步推进
    for (let i = 0; i < 6; i++) {
      step(a, 50);
      step(b, 50);
    }
    // 累计 300ms：A 已到点扣 3，B 的 1200ms 未到点不扣
    expect(a.wall.hp).toBe(a.config.wallMaxHp - 3);
    expect(b.wall.hp).toBe(b.config.wallMaxHp);

    // 累计 1200ms：A 共攻击 4 次（300/600/900/1200），B 恰好首击
    for (let i = 0; i < 18; i++) {
      step(a, 50);
      step(b, 50);
    }
    expect(a.wall.hp).toBe(a.config.wallMaxHp - 3 * 4);
    expect(b.wall.hp).toBe(b.config.wallMaxHp - 30);

    // 事件金额逐一等于各自实体的 damage 字段
    for (const ev of drainEvents(a)) {
      expect(ev).toEqual({ kind: 'wallDamaged', amount: 3, hp: expect.any(Number) });
    }
    expect(drainEvents(b)).toEqual([{ kind: 'wallDamaged', amount: 30, hp: b.config.wallMaxHp - 30 }]);
  });

  it('长 dt 单帧：一帧内到点的多次攻击按 += 间隔依序追补，落点相位正确', () => {
    const state = createSimState(1);
    state.enemies.push(makeAttacker({ damage: 3, attackIntervalMs: 500, attackCooldownMs: 0 }));

    // 一次 2000ms：0/500/1000/1500/2000 五个到点 → 5 次攻击
    updateWallCombat(state, 2000);
    expect(state.wall.hp).toBe(state.config.wallMaxHp - 3 * 5);
    expect(state.events.filter((ev) => ev.kind === 'wallDamaged')).toHaveLength(5);

    // 冷却落回正常相位：再过 499ms 不攻击，补 1ms 恰好到点
    updateWallCombat(state, 499);
    expect(state.wall.hp).toBe(state.config.wallMaxHp - 15);
    updateWallCombat(state, 1);
    expect(state.wall.hp).toBe(state.config.wallMaxHp - 18);
  });
});

describe('updateWallCombat 失败判定', () => {
  it('墙血归 0：恰好一次 gameOver、over=defeat，之后 step 停摆且事件不再增加', () => {
    const state = createSimState(1, { wallMaxHp: 10 });
    let hookCalls = 0;
    state.hooks.push(() => {
      hookCalls += 1;
    });
    state.hooks.push(updateWallCombat);
    state.enemies.push(makeAttacker({ damage: 25, attackIntervalMs: 1000, attackCooldownMs: 1000 }));

    // step 对 dt 有 50ms 钳制：用 16ms 分步推进，63 × 16 = 1008ms ≥ 1000ms 首击到点
    for (let i = 0; i < 63; i++) {
      step(state, 16);
    }
    expect(state.wall.hp).toBe(0);
    expect(state.over).toBe('defeat');
    expect(state.timeMs).toBe(1008);
    const callsAtDefeat = hookCalls;
    expect(callsAtDefeat).toBeGreaterThan(0);
    expect(drainEvents(state)).toEqual([
      { kind: 'wallDamaged', amount: 25, hp: 0 },
      { kind: 'gameOver' },
    ]);

    // 之后反复 step：时间不动、hook 不再执行、事件不再增加
    for (let i = 0; i < 5; i++) {
      step(state, 16);
    }
    expect(state.timeMs).toBe(1008);
    expect(hookCalls).toBe(callsAtDefeat);
    expect(drainEvents(state)).toEqual([]);

    // 直接再调 updateWallCombat 也防重入：冷却已到点也不扣血、不发事件
    updateWallCombat(state, 16);
    expect(state.wall.hp).toBe(0);
    expect(state.over).toBe('defeat');
    expect(drainEvents(state)).toEqual([]);
  });

  it('同帧多敌依次结算：墙破后本帧后续敌人不再攻击，gameOver 恰好一次', () => {
    const state = createSimState(1, { wallMaxHp: 10 });
    state.enemies.push(
      makeAttacker({ id: 1, damage: 6, attackCooldownMs: 0 }),
      makeAttacker({ id: 2, damage: 6, attackCooldownMs: 0 }),
      makeAttacker({ id: 3, damage: 6, attackCooldownMs: 0 }),
    );

    updateWallCombat(state, 16);
    expect(state.over).toBe('defeat');
    // 第 1、2 个敌人依次结算；第 2 击破墙后第 3 个不再结算
    expect(drainEvents(state)).toEqual([
      { kind: 'wallDamaged', amount: 6, hp: 4 },
      { kind: 'wallDamaged', amount: 6, hp: 0 },
      { kind: 'gameOver' },
    ]);
  });
});

describe('updateWallCombat 同帧依序结算', () => {
  it('多个攻击态敌人同帧到点，按数组顺序依次扣血；行军态 / 死亡敌人不参与', () => {
    const state = createSimState(1);
    state.enemies.push(
      makeAttacker({ id: 1, damage: 5, attackCooldownMs: 0 }),
      makeAttacker({ id: 2, damage: 9, attackCooldownMs: 0 }),
      makeAttacker({ id: 3, damage: 2, attackCooldownMs: 0 }),
      // 不参与结算的两类：行军态、已死亡
      makeAttacker({ id: 4, damage: 100, state: 'march', attackCooldownMs: 0 }),
      makeAttacker({ id: 5, damage: 100, dead: true, attackCooldownMs: 0 }),
    );

    updateWallCombat(state, 16);
    expect(state.over).toBeNull();
    expect(state.wall.hp).toBe(state.config.wallMaxHp - 16);
    // 事件顺序 = 数组顺序，hp 逐击递减
    expect(drainEvents(state)).toEqual([
      { kind: 'wallDamaged', amount: 5, hp: state.config.wallMaxHp - 5 },
      { kind: 'wallDamaged', amount: 9, hp: state.config.wallMaxHp - 14 },
      { kind: 'wallDamaged', amount: 2, hp: state.config.wallMaxHp - 16 },
    ]);
  });
});

describe('healWall', () => {
  it('回复叠加且不超过 maxHp', () => {
    const state = createSimState(1, { wallMaxHp: 100 });
    state.wall.hp = 40;

    healWall(state, 30);
    expect(state.wall.hp).toBe(70);

    // 超上限部分被钳掉
    healWall(state, 100);
    expect(state.wall.hp).toBe(100);

    // 已满血再回复仍是 maxHp
    healWall(state, 25);
    expect(state.wall.hp).toBe(100);
  });

  it('受损后修复包回复，回复量取自调用方', () => {
    const state = createSimState(1, { wallMaxHp: 100 });
    state.enemies.push(makeAttacker({ damage: 10, attackCooldownMs: 0 }));

    updateWallCombat(state, 16);
    expect(state.wall.hp).toBe(90);

    healWall(state, 5);
    expect(state.wall.hp).toBe(95);
  });
});
