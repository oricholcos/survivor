// src/core/cards.test.ts —— 武器牌池系统（T5.3a）核心契约：
// getCardCount 计数、buildWeaponStats 乘区叠乘（×1.3^n / ÷1.3^n / range 逐键 / params
// set·add·mul·div）与目录序确定性、getWeaponStats 委托、isWeaponMaxed（10 级封顶）、
// allMaxedUnlocked 解锁判定（3 把满 ≠ 解锁 / 4 把满 = 解锁 / 有一把未满 ≠ 解锁）、
// availableCards 池规则（maxCount 上限 / hardMax 硬上限 / once 布尔牌移除 / requiresCard 前置 / excludes
// 互斥·龙息模式 / 解锁后 maxCount 失效但 once·hardMax 仍移除）、dotTickMultiplier。
// 夹具用手写字面量（结构同真实表），不依赖数据层。
import { describe, expect, it } from 'vitest';
import {
  allMaxedUnlocked,
  availableCards,
  buildWeaponStats,
  consumeDueBurstWaves,
  BURST_QUEUE_META_KEY,
  getCardCount,
  dotTickMultiplier,
  MAX_WEAPON_LEVEL,
  isWeaponMaxed,
  scheduleBurstWaves,
  type BurstWaveEntry,
  type WeaponCardDef,
} from './cards';
import { createSimState } from './simState';
import { addWeapon } from './weapons';
import type { SimState } from './types';

/** 构造一把带牌池的武器定义夹具（base 五项 + 自定义键；cards 即合并后的目录）。 */
function makeCardDef(cards: WeaponCardDef[], base?: Record<string, number>, rangeKeys: string[] = []) {
  return {
    base: { damage: 10, intervalMs: 800, projectileSpeed: 900, pierce: 2, ttlMs: 2000, ...base },
    rangeKeys,
    cards,
  };
}

/** 给状态登记一把已拥有武器并吃下指定牌序列（每张 level+1，同 applyUpgrade 语义）。 */
function ownWithCards(state: SimState, id: string, cardIds: string[], level?: number): void {
  addWeapon(state, id);
  const ws = state.weaponStates[id];
  for (const cardId of cardIds) {
    ws.cards[cardId] = (ws.cards[cardId] ?? 0) + 1;
  }
  ws.level = level ?? cardIds.length;
}

describe('getCardCount', () => {
  it('未拥有武器 / 未持有牌 → 0；吃牌后逐张累计', () => {
    const state = createSimState(1);
    expect(getCardCount(state, 'w', 'dmg_up')).toBe(0);

    ownWithCards(state, 'w', ['dmg_up', 'dmg_up', 'spd_up']);
    expect(getCardCount(state, 'w', 'dmg_up')).toBe(2);
    expect(getCardCount(state, 'w', 'spd_up')).toBe(1);
    expect(getCardCount(state, 'w', 'range_up')).toBe(0);
    expect(getCardCount(state, 'other', 'dmg_up')).toBe(0);
  });
});

describe('buildWeaponStats 乘区与开关', () => {
  it('无牌（0 级）= base 原值；返回全新对象不改 def', () => {
    const def = makeCardDef([{ id: 'x', name: 'X', description: '' }]);
    const stats = buildWeaponStats(def, undefined);
    expect(stats).toEqual({ damage: 10, intervalMs: 800, projectileSpeed: 900, pierce: 2, ttlMs: 2000 });
    expect(def.base.damage).toBe(10); // 数据表不被污染
  });

  it('伤害强化 ×1.3 叠乘：2 张 → ×1.3²（mul 按 count 迭代）', () => {
    const def = makeCardDef([
      { id: 'dmg_up', name: '伤害强化', description: '', params: [{ key: 'damage', value: 1.3, op: 'mul' }] },
    ]);
    const stats = buildWeaponStats(def, { cards: { dmg_up: 2 } });
    expect(stats.damage).toBeCloseTo(10 * 1.3 * 1.3, 9);
    expect(stats.intervalMs).toBe(800); // 未触及键保持 base
  });

  it('攻速强化 ÷1.3 叠乘：3 张 → ÷1.3³（div 按 count 迭代）', () => {
    const def = makeCardDef([
      { id: 'spd_up', name: '攻速强化', description: '', params: [{ key: 'intervalMs', value: 1.3, op: 'div' }] },
    ]);
    const stats = buildWeaponStats(def, { cards: { spd_up: 3 } });
    expect(stats.intervalMs).toBeCloseTo(800 / 1.3 / 1.3 / 1.3, 9);
  });

  it('range_mult：按 def.rangeKeys 逐键 ×value^count，键外数值不受影响', () => {
    const def = makeCardDef(
      [{ id: 'range_up', name: '范围强化', description: '', kind: 'range_mult', value: 1.2 }],
      { coneRange: 100, coneAngleDeg: 50, other: 7 },
      ['coneRange', 'coneAngleDeg'],
    );
    const stats = buildWeaponStats(def, { cards: { range_up: 2 } });
    expect(stats.coneRange).toBeCloseTo(100 * 1.44, 9);
    expect(stats.coneAngleDeg).toBeCloseTo(50 * 1.44, 9);
    expect(stats.other).toBe(7);
    expect(stats.damage).toBe(10);
  });

  it('params set/add：set 幂等（count>1 仍为定值）、add 每张累加；add 可叠加在 base 之上', () => {
    const def = makeCardDef([
      {
        id: 'mech',
        name: '机制牌',
        description: '',
        params: [
          { key: 'pierceShot', value: 1, op: 'set' },
          { key: 'pierce', value: 2, op: 'add' },
        ],
      },
    ]);
    const one = buildWeaponStats(def, { cards: { mech: 1 } });
    expect(one.pierceShot).toBe(1);
    expect(one.pierce).toBe(4); // base 2 + 2

    const two = buildWeaponStats(def, { cards: { mech: 2 } });
    expect(two.pierceShot).toBe(1); // set 幂等
    expect(two.pierce).toBe(6); // base 2 + 2×2
  });

  it('多牌组合（目录序应用）：乘区叠乘与开关共存；结果与牌的记录顺序无关（确定性）', () => {
    const def = makeCardDef([
      { id: 'dmg_up', name: '伤害强化', description: '', params: [{ key: 'damage', value: 1.3, op: 'mul' }] },
      { id: 'headshot', name: '斩首', description: '', once: true, params: [{ key: 'headshot', value: 1, op: 'set' }] },
      { id: 'pierce_up', name: '贯通+1', description: '', params: [{ key: 'pierce', value: 1, op: 'add' }] },
    ]);
    const a = buildWeaponStats(def, { cards: { dmg_up: 2, headshot: 1, pierce_up: 1 } });
    const b = buildWeaponStats(def, { cards: { pierce_up: 1, headshot: 1, dmg_up: 2 } }); // 同牌不同插入序
    expect(a).toEqual(b); // 目录序解析：浮点结果与获取顺序无关
    expect(a.damage).toBeCloseTo(10 * 1.3 * 1.3, 9);
    expect(a.pierce).toBe(3);
    expect(a.headshot).toBe(1);
  });

  it('dot_freq 牌注入 stats.dotTickMult = value^count（T5.3b 行为附着点消费）；无牌缺键', () => {
    const def = makeCardDef([{ id: 'dot_freq', name: 'dot频率', description: '', kind: 'dot_freq', value: 1.3 }]);
    expect(buildWeaponStats(def, { cards: {} }).dotTickMult).toBeUndefined(); // 无牌：不写键（行为兜底 1）
    expect(buildWeaponStats(def, { cards: { dot_freq: 1 } }).dotTickMult).toBeCloseTo(1.3, 9);
    expect(buildWeaponStats(def, { cards: { dot_freq: 3 } }).dotTickMult).toBeCloseTo(1.3 ** 3, 9);
  });
});

describe('getWeaponStats 委托（weapons.ts 入口）', () => {
  it('从 state.weaponStates 取牌表解析；武器未登记（ghost）→ 纯 base', () => {
    // 与 core/weapons.ts 的 getWeaponStats 同构的最小委托断言（真实入口在 weapons.test.ts 覆盖）。
    const def = makeCardDef([
      { id: 'dmg_up', name: '伤害强化', description: '', params: [{ key: 'damage', value: 1.3, op: 'mul' }] },
    ]);
    const state = createSimState(1);
    ownWithCards(state, 'w', ['dmg_up']);
    expect(buildWeaponStats(def, state.weaponStates.w).damage).toBeCloseTo(13, 9);
    expect(buildWeaponStats(def, state.weaponStates['ghost']).damage).toBe(10);
  });
});

describe('isWeaponMaxed / allMaxedUnlocked（10 级封顶 + 解锁判定）', () => {
  const defs = { a: { maxLevel: 10 }, b: { maxLevel: 10 }, c: { maxLevel: 10 }, d: { maxLevel: 10 } };

  it('MAX_WEAPON_LEVEL 常量导出且值为 10', () => {
    expect(MAX_WEAPON_LEVEL).toBe(10);
  });

  it('isWeaponMaxed：level 10 封顶（= maxLevel）为满；9 未满；def 缺失视为未满', () => {
    const state = createSimState(1);
    ownWithCards(state, 'a', [], 10);
    ownWithCards(state, 'b', [], 9);
    expect(isWeaponMaxed(state, 'a', defs)).toBe(true);
    expect(isWeaponMaxed(state, 'b', defs)).toBe(false);
    expect(isWeaponMaxed(state, 'ghost', defs)).toBe(false);
  });

  it('isWeaponMaxed：def 未声明 maxLevel 时默认采用 MAX_WEAPON_LEVEL (10)', () => {
    const state = createSimState(1);
    ownWithCards(state, 'no_max', [], 9);
    expect(isWeaponMaxed(state, 'no_max', { no_max: {} })).toBe(false);
    state.weaponStates.no_max.level = 10;
    expect(isWeaponMaxed(state, 'no_max', { no_max: {} })).toBe(true);
  });

  it('isWeaponMaxed：level > 10 时仍返回 true（满级判定不仅等于也大于）', () => {
    const state = createSimState(1);
    ownWithCards(state, 'a', [], 15);
    expect(isWeaponMaxed(state, 'a', defs)).toBe(true);
  });

  it('3 把全满 ≠ 解锁（数量不足 maxWeaponSlots=4）', () => {
    const state = createSimState(1);
    ownWithCards(state, 'a', [], 10);
    ownWithCards(state, 'b', [], 10);
    ownWithCards(state, 'c', [], 10);
    expect(allMaxedUnlocked(state, defs)).toBe(false);
  });

  it('4 把全满 = 解锁；4 把中任一未满 ≠ 解锁', () => {
    const state = createSimState(1);
    ownWithCards(state, 'a', [], 10);
    ownWithCards(state, 'b', [], 10);
    ownWithCards(state, 'c', [], 10);
    ownWithCards(state, 'd', [], 9);
    expect(allMaxedUnlocked(state, defs)).toBe(false);

    state.weaponStates.d.level = 10;
    expect(allMaxedUnlocked(state, defs)).toBe(true);
  });

  it('4 把武器在解锁后继续吃牌升级（如 level 11, 12），解锁状态保持为 true', () => {
    const state = createSimState(1);
    ownWithCards(state, 'a', [], 12);
    ownWithCards(state, 'b', [], 11);
    ownWithCards(state, 'c', [], 10);
    ownWithCards(state, 'd', [], 10);
    expect(allMaxedUnlocked(state, defs)).toBe(true);
  });

  it('解锁数量门槛取 config.maxWeaponSlots（改配置即变）', () => {
    const state = createSimState(1, { maxWeaponSlots: 2 });
    ownWithCards(state, 'a', [], 10);
    ownWithCards(state, 'b', [], 10);
    expect(allMaxedUnlocked(state, { a: { maxLevel: 10 }, b: { maxLevel: 10 } })).toBe(true);
  });
});

describe('availableCards 池规则', () => {
  /** 池断言小工具：返回可用牌 id 列表。 */
  const ids = (def: ReturnType<typeof makeCardDef>, ws: { cards: Record<string, number> }, unlocked: boolean) =>
    availableCards(def, ws, unlocked).map((c) => c.id);

  it('maxCount 上限：达上限的牌在解锁前不出现；解锁后上限全失效（重复可购）', () => {
    const def = makeCardDef([
      { id: 'multi', name: '多射+1', description: '', maxCount: 4, params: [] },
      { id: 'dmg', name: '伤害强化', description: '', params: [] },
    ]);
    const ws = { cards: { multi: 4 } };
    expect(ids(def, ws, false)).toEqual(['dmg']); // multi 达上限 → 移除
    expect(ids(def, ws, true)).toEqual(['multi', 'dmg']); // 解锁后：上限失效
  });

  it('hardMax 硬上限：达上限的牌解锁前后都不出现（与 maxCount 的区别：不随解锁失效）', () => {
    const def = makeCardDef([
      { id: 'dmg', name: '伤害强化', description: '', hardMax: 12, params: [] },
      { id: 'multi', name: '多射+1', description: '', maxCount: 4, hardMax: 8, params: [] },
    ]);
    // 双牌均达 hardMax：解锁前后一律移除。
    const wsFull = { cards: { dmg: 12, multi: 8 } };
    expect(ids(def, wsFull, false)).toEqual([]);
    expect(ids(def, wsFull, true)).toEqual([]);
    // 未达 hardMax：multi 持有 6 > maxCount 4 → 解锁前移除、解锁后放行（直到 hardMax 8）。
    const wsMid = { cards: { dmg: 11, multi: 6 } };
    expect(ids(def, wsMid, false)).toEqual(['dmg']);
    expect(ids(def, wsMid, true)).toEqual(['dmg', 'multi']);
  });

  it('once 布尔牌：拿到一张即从池移除（解锁前后一致）；未拿则在池', () => {
    const def = makeCardDef([
      { id: 'trident', name: '三叉分裂', description: '', once: true, params: [] },
      { id: 'dmg', name: '伤害强化', description: '', params: [] },
    ]);
    expect(ids(def, { cards: {} }, false)).toEqual(['trident', 'dmg']);
    expect(ids(def, { cards: { trident: 1 } }, false)).toEqual(['dmg']);
    expect(ids(def, { cards: { trident: 1 } }, true)).toEqual(['dmg']); // 解锁后仍移除
  });

  it('requiresCard 前置：未拿前置不出现（解锁前后一致）；拿了前置即出现', () => {
    const def = makeCardDef([
      { id: 'burn_bullet', name: '燃烧弹', description: '', once: true, params: [] },
      { id: 'dot_freq', name: 'dot频率', description: '', requiresCard: 'burn_bullet', params: [] },
    ]);
    expect(ids(def, { cards: {} }, false)).toEqual(['burn_bullet']); // 前置未满足：dot_freq 不在池
    // 拿过燃烧弹（once → 本牌从池移除）后前置已满足：dot_freq 出现。
    expect(ids(def, { cards: { burn_bullet: 1 } }, false)).toEqual(['dot_freq']);
    expect(ids(def, { cards: { burn_bullet: 1 } }, true)).toEqual(['dot_freq']); // 前置解锁后仍生效
  });

  it('excludes 互斥（龙息模式）：持有互斥牌期间，被排除的多射/连射/分裂全部移出池', () => {
    const def = makeCardDef([
      { id: 'multi_shot', name: '多射+1', description: '', params: [] },
      { id: 'burst_shot', name: '连射+1', description: '', params: [] },
      { id: 'split_shot', name: '分裂', description: '', params: [] },
      {
        id: 'dragon_breath_mode',
        name: '龙息模式',
        description: '',
        once: true,
        excludes: ['multi_shot', 'burst_shot', 'split_shot'],
        params: [],
      },
      { id: 'dmg', name: '伤害强化', description: '', params: [] },
    ]);
    expect(ids(def, { cards: {} }, false)).toHaveLength(5);
    expect(ids(def, { cards: { dragon_breath_mode: 1 } }, false)).toEqual(['dmg']); // 三张全被互斥
    expect(ids(def, { cards: { dragon_breath_mode: 1 } }, true)).toEqual(['dmg']);
  });

  it('split_shot 分裂牌：持有一张后在解锁前后均从池中移除（不重复刷新）', () => {
    const def = makeCardDef([
      { id: 'split_shot', name: '分裂', description: '', once: true, params: [] },
      { id: 'dmg', name: '伤害强化', description: '', params: [] },
    ]);
    expect(ids(def, { cards: {} }, false)).toEqual(['split_shot', 'dmg']);
    expect(ids(def, { cards: { split_shot: 1 } }, false)).toEqual(['dmg']);
    expect(ids(def, { cards: { split_shot: 1 } }, true)).toEqual(['dmg']); // 解锁后依然不进池
  });

  it('目录序输出（确定性池序）：与 def.cards 声明顺序一致', () => {
    const def = makeCardDef([
      { id: 'b', name: 'B', description: '', params: [] },
      { id: 'a', name: 'A', description: '', params: [] },
    ]);
    expect(ids(def, { cards: {} }, false)).toEqual(['b', 'a']);
  });

  it('持有计数 <= 0 的脏键不触发 once / excludes 排除，也不满足 requiresCard', () => {
    const def = makeCardDef([
      { id: 'once_c', name: '一次性', description: '', once: true, params: [] },
      { id: 'ex_c', name: '互斥源', description: '', excludes: ['target_c'], params: [] },
      { id: 'target_c', name: '被互斥', description: '', params: [] },
      { id: 'req_c', name: '需要前置', description: '', requiresCard: 'once_c', params: [] },
    ]);
    const ws = { cards: { once_c: 0, ex_c: 0 } };
    // once_c count=0 → once_c 在池；ex_c count=0 → target_c 不被互斥；req_c requires once_c 但 once_c count=0 → req_c 不在池
    expect(ids(def, ws, false)).toEqual(['once_c', 'ex_c', 'target_c']);
  });

  it('多重互斥并集：多张持有牌各自排除不同集合，全部生效', () => {
    const def = makeCardDef([
      { id: 'mod_a', name: '模式A', description: '', excludes: ['sub_1', 'sub_2'], params: [] },
      { id: 'mod_b', name: '模式B', description: '', excludes: ['sub_3'], params: [] },
      { id: 'sub_1', name: '子项1', description: '', params: [] },
      { id: 'sub_2', name: '子项2', description: '', params: [] },
      { id: 'sub_3', name: '子项3', description: '', params: [] },
      { id: 'normal', name: '普通', description: '', params: [] },
    ]);
    const ws = { cards: { mod_a: 1, mod_b: 1 } };
    expect(ids(def, ws, false)).toEqual(['mod_a', 'mod_b', 'normal']);
  });
});

describe('dotTickMultiplier（dot 频率助手）', () => {
  const defs = {
    dragon: makeCardDef([{ id: 'dot_freq', name: 'dot频率', description: '', kind: 'dot_freq', value: 1.3 }]),
    plain: makeCardDef([{ id: 'dmg_up', name: '伤害强化', description: '', params: [] }]),
  };

  it('无牌 → 1；n 张 → 1.3^n（消费约定：dot tick 间隔 ÷ 本值）', () => {
    const state = createSimState(1);
    ownWithCards(state, 'dragon', []);
    expect(dotTickMultiplier(state, 'dragon', defs)).toBe(1);

    ownWithCards(state, 'dragon', ['dot_freq', 'dot_freq']);
    expect(dotTickMultiplier(state, 'dragon', defs)).toBeCloseTo(1.69, 9);
  });

  it('无 dot_freq 牌的武器 / 数据表缺该武器 → 1', () => {
    const state = createSimState(1);
    ownWithCards(state, 'plain', ['dmg_up']);
    expect(dotTickMultiplier(state, 'plain', defs)).toBe(1);
    expect(dotTickMultiplier(state, 'ghost', defs)).toBe(1);
  });
});

describe('连射波调度（T5.3b burst_shot 接线：scheduleBurstWaves / consumeDueBurstWaves）', () => {
  /** 读 meta 待发波队列（缺省空数组）。 */
  function queueOf(state: SimState): BurstWaveEntry[] {
    return (state.meta[BURST_QUEUE_META_KEY] as BurstWaveEntry[] | undefined) ?? [];
  }

  it('burstWaves=n → n 个跟发波按 burstIntervalMs 递列入队（FIFO），各持 stats 快照（与原对象隔离）', () => {
    const state = createSimState(1); // timeMs = 0
    const stats: Record<string, number> = { burstWaves: 2, burstIntervalMs: 150, damage: 10 };
    scheduleBurstWaves(state, 'w', 'beh', stats);

    const q = queueOf(state);
    expect(q).toHaveLength(2);
    expect(q[0]).toMatchObject({ weaponId: 'w', behavior: 'beh', dueAtMs: 150 });
    expect(q[1]).toMatchObject({ weaponId: 'w', behavior: 'beh', dueAtMs: 300 });
    expect(q[0].stats.damage).toBe(10);
    stats.damage = 99; // 快照隔离：改原 stats 不影响已入队波
    expect(q[0].stats.damage).toBe(10);
  });

  it('无牌（burstWaves 缺失/0）/ 龙息模式 / 脏波间隔（0/NaN）→ 不排波', () => {
    const state = createSimState(1);
    scheduleBurstWaves(state, 'w', 'beh', {}); // 无牌
    scheduleBurstWaves(state, 'w', 'beh', { burstWaves: 0, burstIntervalMs: 150 });
    scheduleBurstWaves(state, 'w', 'beh', { burstWaves: 2, burstIntervalMs: 150, dragonBreath: 1 }); // 互斥
    scheduleBurstWaves(state, 'w', 'beh', { burstWaves: 2, burstIntervalMs: 0 });
    scheduleBurstWaves(state, 'w', 'beh', { burstWaves: 2, burstIntervalMs: Number.NaN });
    expect(queueOf(state)).toHaveLength(0);
  });

  it('消费：只重放到期波（未到期保留）、按 behavior 认领（他行为波不动）、过期波长帧追赶、原地压实', () => {
    const state = createSimState(1);
    scheduleBurstWaves(state, 'a', 'behA', { burstWaves: 2, burstIntervalMs: 100, damage: 1 });
    scheduleBurstWaves(state, 'b', 'behB', { burstWaves: 1, burstIntervalMs: 100, damage: 2 });

    const fired: string[] = [];
    const consumeA = (): void =>
      consumeDueBurstWaves(state, 'behA', (wid, st) => fired.push(`${wid}:${st.damage}`));

    consumeA(); // t=0：无到期
    expect(fired).toEqual([]);
    expect(queueOf(state)).toHaveLength(3);

    state.timeMs = 100; // behA 第 1 波与 behB 波同时到期：behA 只认领自己的
    consumeA();
    expect(fired).toEqual(['a:1']);
    expect(queueOf(state)).toHaveLength(2); // behA 第 2 波（200）+ behB 波（100）

    state.timeMs = 200;
    consumeA();
    expect(fired).toEqual(['a:1', 'a:1']);
    expect(queueOf(state)).toHaveLength(1); // 仅剩 behB 波

    consumeDueBurstWaves(state, 'behB', (wid, st) => fired.push(`${wid}:${st.damage}`)); // 已过期：照样消费
    expect(fired).toEqual(['a:1', 'a:1', 'b:2']);
    expect(queueOf(state)).toHaveLength(0);
  });

  it('state.over 非 null：不消费（模拟结束防重入，队列原样保留）', () => {
    const state = createSimState(1);
    scheduleBurstWaves(state, 'a', 'beh', { burstWaves: 1, burstIntervalMs: 50 });
    state.timeMs = 100;
    state.over = 'victory';
    let calls = 0;
    consumeDueBurstWaves(state, 'beh', () => {
      calls += 1;
    });
    expect(calls).toBe(0);
    expect(queueOf(state)).toHaveLength(1);
  });
});
