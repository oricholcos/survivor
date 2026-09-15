// src/core/weapons.test.ts —— 武器解释器框架行为契约（T5.3a 牌池制）：
// addWeapon 0 级起步 + 空牌表、getWeaponStats 牌乘区/开关解析（委托 buildWeaponStats）、
// updateWeapons 冷却节奏与长 dt 追补（乘区后间隔照常推进）、缺 def 跳过、
// addWeapon 幂等、行为注册表（未注册抛错 / 同名后注册者胜 / 自动发现已注册）。
import { describe, expect, it } from 'vitest';
import { getBehavior, listBehaviors, registerBehavior } from './behaviors/registry';
import { createSimState } from './simState';
import { addWeapon, getWeaponStats, updateWeapons } from './weapons';
import type { WeaponDef } from './weapons';
import type { WeaponCardDef } from './cards';

/** 牌夹具小工具：params 乘区/开关牌。 */
function card(id: string, params?: WeaponCardDef['params']): WeaponCardDef {
  return { id, name: id, description: '', params };
}

/** 构造一个 WeaponDef 夹具（base 与任务书 rail_piercer 同构；cards/rangeKeys 齐全）。 */
function makeDef(overrides?: Partial<WeaponDef>): WeaponDef {
  return {
    id: 'test_gun',
    name: '测试枪',
    behavior: 'fake_never',
    maxLevel: 10,
    base: { damage: 10, intervalMs: 800, projectileSpeed: 900, pierce: 2, ttlMs: 2000 },
    rangeKeys: [],
    cards: [],
    ...overrides,
  };
}

describe('addWeapon：0 级起步 + 空牌表', () => {
  it('新增武器 = { level: 0, cooldownMs: 0, cards: {} }（T5.3a：武器 0 级起步，成长全靠牌）', () => {
    const state = createSimState(1);
    addWeapon(state, 'w');
    expect(state.weaponStates.w).toEqual({ level: 0, cooldownMs: 0, cards: {} });
  });

  it('重复添加不覆盖已有等级/冷却/牌表（幂等）', () => {
    const state = createSimState(1);
    addWeapon(state, 'w');
    expect(state.weaponStates.w).toEqual({ level: 0, cooldownMs: 0, cards: {} });

    // 模拟吃牌与战斗中的冷却推进
    state.weaponStates.w.level = 3;
    state.weaponStates.w.cooldownMs = 123;
    state.weaponStates.w.cards.dmg_up = 3;

    addWeapon(state, 'w');
    expect(state.weaponStates.w.level).toBe(3);
    expect(state.weaponStates.w.cooldownMs).toBe(123);
    expect(state.weaponStates.w.cards.dmg_up).toBe(3);
  });
});

describe('getWeaponStats：牌乘区与开关（委托 buildWeaponStats）', () => {
  const def = makeDef({
    rangeKeys: ['blastRadius'],
    base: { damage: 10, intervalMs: 800, projectileSpeed: 900, pierce: 2, ttlMs: 2000, blastRadius: 100 },
    cards: [
      card('dmg_up', [{ key: 'damage', value: 1.3, op: 'mul' }]),
      card('spd_up', [{ key: 'intervalMs', value: 1.3, op: 'div' }]),
      card('range_up', undefined), // kind 牌：range_mult 由 rangeKeys 消费
      card('pierce_up', [{ key: 'pierce', value: 1, op: 'add' }]),
      card('mech', [{ key: 'trident', value: 1, op: 'set' }]),
    ],
  });
  // range_up 用 kind 表达（与真实表同构：params 与 kind 互斥）。
  (def.cards[2] as WeaponCardDef).kind = 'range_mult';
  (def.cards[2] as WeaponCardDef).value = 1.2;

  it('0 级无牌 = base 原值', () => {
    const state = createSimState(1);
    addWeapon(state, 'test_gun');
    expect(getWeaponStats(def, state, 'test_gun')).toEqual({
      damage: 10,
      intervalMs: 800,
      projectileSpeed: 900,
      pierce: 2,
      ttlMs: 2000,
      blastRadius: 100,
    });
  });

  it('伤害/攻速/范围乘区按牌张数叠乘；add/set 开关键照常注入', () => {
    const state = createSimState(1);
    addWeapon(state, 'test_gun');
    const ws = state.weaponStates.test_gun;
    ws.cards.dmg_up = 2;
    ws.cards.spd_up = 1;
    ws.cards.range_up = 2;
    ws.cards.pierce_up = 3;
    ws.cards.mech = 1;

    const stats = getWeaponStats(def, state, 'test_gun');
    expect(stats.damage).toBeCloseTo(10 * 1.3 * 1.3, 9);
    expect(stats.intervalMs).toBeCloseTo(800 / 1.3, 9);
    expect(stats.blastRadius).toBeCloseTo(100 * 1.2 * 1.2, 9); // rangeKeys 数据驱动
    expect(stats.pierce).toBe(5); // base 2 + 3
    expect(stats.trident).toBe(1); // 专属牌开关（沿用 stats.xxx 命名）
    expect(stats.projectileSpeed).toBe(900); // 未触及键保持 base
  });

  it('weaponStates 缺条目（ghost）→ 纯 base 不抛错', () => {
    const state = createSimState(1);
    expect(getWeaponStats(def, state, 'ghost').damage).toBe(10);
  });
});

describe('updateWeapons 冷却节奏', () => {
  it('intervalMs=800、每次 step 50ms：开火发生在第 1、16、32 步（+= 追加冷却语义）', () => {
    let fires = 0;
    registerBehavior({
      name: 'fake_cadence',
      fire: () => {
        fires++;
      },
    });
    const defs = { t: makeDef({ id: 't', behavior: 'fake_cadence' }) };
    const state = createSimState(1);
    addWeapon(state, 't');

    // 第 1 步：冷却 0 → 扣 50 → -50 → 开火，冷却 += 800 → 750
    updateWeapons(state, 50, defs);
    expect(fires).toBe(1);
    expect(state.weaponStates.t.cooldownMs).toBe(750);

    // 第 2~15 步：750 - 14×50 = 50 > 0，不开火
    for (let i = 0; i < 14; i++) {
      updateWeapons(state, 50, defs);
    }
    expect(fires).toBe(1);

    // 第 16 步：冷却归 0 → 第二次开火。
    // 若解释器是「重置为 interval」而非「+= interval」，此处会在第 17 步才开火——本断言锁定 += 语义。
    updateWeapons(state, 50, defs);
    expect(fires).toBe(2);
    expect(state.weaponStates.t.cooldownMs).toBe(800);

    // 第 17~31 步不开火，第 32 步第三次开火（此后每 16 步一次）
    for (let i = 0; i < 15; i++) {
      updateWeapons(state, 50, defs);
    }
    expect(fires).toBe(2);
    updateWeapons(state, 50, defs);
    expect(fires).toBe(3);
  });

  it('牌攻速乘区实际生效：spd_up 1 张 → 间隔 800/1.3，开火节奏按乘区后间隔推进', () => {
    let fires = 0;
    registerBehavior({
      name: 'fake_spd',
      fire: () => {
        fires++;
      },
    });
    const defs = {
      t: makeDef({
        id: 't',
        behavior: 'fake_spd',
        cards: [card('spd_up', [{ key: 'intervalMs', value: 1.3, op: 'div' }])],
      }),
    };
    const state = createSimState(1);
    addWeapon(state, 't');
    state.weaponStates.t.cards.spd_up = 1;

    updateWeapons(state, 50, defs); // 首帧开火：冷却 += 800/1.3 - 50
    expect(fires).toBe(1);
    expect(state.weaponStates.t.cooldownMs).toBeCloseTo(800 / 1.3 - 50, 9);
  });

  it('长 dt 追补：intervalMs=100、一次 dt=250ms 恰好追补开火 3 次，冷却落至 50', () => {
    let fires = 0;
    registerBehavior({
      name: 'fake_catchup',
      fire: () => {
        fires++;
      },
    });
    const defs = {
      c: makeDef({
        id: 'c',
        behavior: 'fake_catchup',
        base: { damage: 1, intervalMs: 100, projectileSpeed: 100, pierce: 1, ttlMs: 100 },
      }),
    };
    const state = createSimState(1);
    addWeapon(state, 'c');

    // 冷却轨迹：0 → -250(fire) → -150(fire) → -50(fire) → 50（循环至 > 0）
    updateWeapons(state, 250, defs);
    expect(fires).toBe(3);
    expect(state.weaponStates.c.cooldownMs).toBe(50);
  });

  it('defs 里缺某武器 id：跳过该武器不抛错，冷却照常扣减', () => {
    let fires = 0;
    registerBehavior({
      name: 'fake_never',
      fire: () => {
        fires++;
      },
    });
    const state = createSimState(1);
    addWeapon(state, 'ghost'); // weaponStates 有 ghost，defs 里没有
    const defs = { real: makeDef({ id: 'real', behavior: 'fake_never' }) }; // real 只在 defs，不在 weaponStates

    expect(() => updateWeapons(state, 50, defs)).not.toThrow();
    expect(fires).toBe(0);
    expect(state.weaponStates.ghost.cooldownMs).toBe(-50); // 已扣减但跳过开火
  });
});

describe('行为注册表', () => {
  it('getBehavior 未注册名抛错', () => {
    expect(() => getBehavior('definitely_not_registered_xyz')).toThrow();
  });

  it('同名注册后注册者胜', () => {
    const v1 = { name: 'override_me', fire: () => {} };
    const v2 = { name: 'override_me', fire: () => {} };
    registerBehavior(v1);
    expect(getBehavior('override_me')).toBe(v1);
    registerBehavior(v2);
    expect(getBehavior('override_me')).toBe(v2);
  });

  it('listBehaviors 包含注入行为与自动发现注册的 piercing_bolt', () => {
    registerBehavior({ name: 'override_me', fire: () => {} });
    const names = listBehaviors();
    expect(names).toContain('override_me');
    // weapons.ts 副作用 import behaviors/index → behavior_*.ts 已自动发现注册
    expect(names).toContain('piercing_bolt');
  });
});
