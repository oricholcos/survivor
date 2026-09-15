// src/core/upgrade.test.ts —— 三选一牌池生成器（T5.3a）的行为契约。
// 覆盖：新武器卡（栏未满）/ 牌候选构成（绑定武器、尊重上限·前置·一次性）、
// 满级武器解锁前不进候选、解锁后上限全失效且 once 牌仍移除、
// 选项不重复、同种子可复现与不同种子大概率不同、applyUpgrade 两类 option 各自生效
// （card → cards++ 且 level+1、>10 允许；new_weapon → 0 级起步）、中文文案可直接供 UI 渲染。
// 武器 defs 用手写字面量夹具（cards 即合并后的目录），不依赖真实数据表。
import { describe, expect, it } from 'vitest';
import { applyUpgrade, rollUpgradeOptions } from './upgrade';
import type { UpgradeOption } from './upgrade';
import type { WeaponDef } from './weapons';
import type { WeaponCardDef as CardDef } from './cards';
import { createSimState } from './simState';
import type { Rng, SimState } from './types';

/** 牌夹具：一次性布尔牌。 */
function onceCard(id: string): CardDef {
  return { id, name: `布尔牌${id}`, description: `${id} 效果`, once: true, params: [{ key: id, value: 1, op: 'set' }] };
}
/** 牌夹具：带上限的可重复参数牌。 */
function repCard(id: string, maxCount: number): CardDef {
  return {
    id,
    name: `叠加牌${id}`,
    description: `${id} ×N（上限 ${maxCount}）`,
    maxCount,
    params: [{ key: id, value: 1, op: 'add' }],
  };
}
/** 牌夹具：无上限数值牌（如伤害强化）。 */
function statCard(id: string): CardDef {
  return { id, name: `数值牌${id}`, description: `${id} 乘区`, params: [{ key: 'damage', value: 1.3, op: 'mul' }] };
}

/** 构造武器定义夹具（maxLevel 10、cards 即合并后的牌目录）。 */
function makeDef(id: string, cards: CardDef[]): WeaponDef {
  return {
    id,
    name: `武器${id}`,
    behavior: 'piercing_bolt',
    maxLevel: 10,
    base: { damage: 1, intervalMs: 100, projectileSpeed: 100, pierce: 0, ttlMs: 100 },
    rangeKeys: [],
    cards,
  };
}

/** 六把武器；w1 牌目录齐全（一次性 + 上限 + 数值），其余各带一张数值牌（键序 w1..w6 确定性）。 */
const DEFS: Record<string, WeaponDef> = {
  w1: makeDef('w1', [onceCard('w1_bool'), repCard('w1_rep', 2), statCard('dmg_up')]),
  w2: makeDef('w2', [statCard('dmg_up')]),
  w3: makeDef('w3', [statCard('dmg_up')]),
  w4: makeDef('w4', [statCard('dmg_up')]),
  w5: makeDef('w5', [statCard('dmg_up')]),
  w6: makeDef('w6', [statCard('dmg_up')]),
};

/** 恒返回 0 的确定性 rng stub（结构接口直接赋值）：抽取退化为「按候选序取前 count 个」。 */
function zeroRng(): Rng {
  return { next: () => 0, int: () => 0, range: () => 0, pick: (list) => list[0] };
}

/** 给状态登记一把已拥有武器（0 级空牌表；可选直接吃牌/设级）。 */
function ownWeapon(state: SimState, id: string, level = 0, cards: Record<string, number> = {}): void {
  state.weaponStates[id] = { level, cooldownMs: 0, cards: { ...cards } };
}

/** 对一组种子逐个建同构状态并 roll，收集全部结果序列。 */
function rollManySeeds(seeds: number[], setup: (state: SimState) => void): UpgradeOption[][] {
  return seeds.map((seed) => {
    const state = createSimState(seed);
    setup(state);
    return rollUpgradeOptions(state, DEFS);
  });
}

/** 选项主体 id：new_weapon → 武器 id；card → `${weaponId}:${cardId}`（互不重复断言用）。 */
function subjectId(option: UpgradeOption): string {
  return option.kind === 'new_weapon' ? option.weaponId : `${option.weaponId}:${option.cardId}`;
}

const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);

describe('rollUpgradeOptions 候选池构成', () => {
  it('0 把武器：全部是新武器卡（表序前 3；确定性 stub）', () => {
    const state = createSimState(1);
    state.rng = zeroRng();
    const options = rollUpgradeOptions(state, DEFS);
    expect(options).toHaveLength(3);
    expect(options).toEqual([
      { kind: 'new_weapon', weaponId: 'w1', name: '武器w1', description: '新武器' },
      { kind: 'new_weapon', weaponId: 'w2', name: '武器w2', description: '新武器' },
      { kind: 'new_weapon', weaponId: 'w3', name: '武器w3', description: '新武器' },
    ]);
  });

  it('1 把武器（栏未满）：新武器 + 该武器的牌混合；随机种子下两类都出现且构成合法', () => {
    for (const options of rollManySeeds(SEEDS, (state) => ownWeapon(state, 'w1'))) {
      expect(options).toHaveLength(3);
      for (const option of options) {
        expect(['new_weapon', 'card']).toContain(option.kind);
        if (option.kind === 'card') {
          expect(option.weaponId).toBe('w1'); // 牌绑定已拥有武器
          expect(['w1_bool', 'w1_rep', 'dmg_up']).toContain(option.cardId);
        }
      }
    }
    const kinds = new Set(
      rollManySeeds(SEEDS, (state) => ownWeapon(state, 'w1'))
        .flat()
        .map((o) => o.kind),
    );
    expect(kinds.has('new_weapon')).toBe(true);
    expect(kinds.has('card')).toBe(true);
  });

  it('牌绑定未拥有武器不出现（牌池只对已拥有武器开放）', () => {
    for (const options of rollManySeeds(SEEDS, (state) => ownWeapon(state, 'w1'))) {
      for (const option of options) {
        if (option.kind === 'card') {
          expect(option.weaponId).not.toMatch(/^w[2-6]$/);
        }
      }
    }
  });

  it('解锁前上限牌达上限不再出现；同武器其他牌照常', () => {
    const state = createSimState(1);
    state.rng = zeroRng();
    ownWeapon(state, 'w1', 2, { w1_rep: 2 }); // w1_rep（上限 2）已拉满
    const options = rollUpgradeOptions(state, DEFS, 99); // 取全池
    const w1Cards = options.filter((o) => o.kind === 'card' && o.weaponId === 'w1');
    expect(w1Cards.map((o) => (o as { cardId: string }).cardId).sort()).toEqual(['dmg_up', 'w1_bool']);
  });

  it('一次性布尔牌拿过即从池移除（重复拿无意义）', () => {
    const state = createSimState(1);
    state.rng = zeroRng();
    ownWeapon(state, 'w1', 1, { w1_bool: 1 });
    const options = rollUpgradeOptions(state, DEFS, 99);
    const w1Cards = options.filter((o) => o.kind === 'card' && o.weaponId === 'w1');
    expect(w1Cards.map((o) => (o as { cardId: string }).cardId).sort()).toEqual(['dmg_up', 'w1_rep']);
  });

  it('解锁前满级武器不进候选（无成长空间）；其余武器照常', () => {
    const state = createSimState(1);
    state.rng = zeroRng();
    ownWeapon(state, 'w1', 10, { dmg_up: 10 });
    const options = rollUpgradeOptions(state, DEFS, 99);
    for (const option of options) {
      if (option.kind === 'card') {
        expect(option.weaponId).not.toBe('w1');
      }
    }
    // 其余候选：w2..w6 的 5 张新武器卡（未拥有武器的牌不入池）
    expect(options).toHaveLength(5);
  });

  it('3 把满级 + 1 把未满（栏满）：只有未满武器出牌，无新武器，未解锁', () => {
    const state = createSimState(1);
    state.rng = zeroRng();
    ownWeapon(state, 'w1', 10, { dmg_up: 10 });
    ownWeapon(state, 'w2', 10, { dmg_up: 10 });
    ownWeapon(state, 'w3', 10, { dmg_up: 10 });
    ownWeapon(state, 'w4', 3, { dmg_up: 3 });
    const options = rollUpgradeOptions(state, DEFS, 99);
    // 栏满：无新武器；解锁判定 false：满级武器（w1..w3）不进候选，只有 w4 的 dmg_up。
    expect(options).toEqual([
      { kind: 'card', weaponId: 'w4', cardId: 'dmg_up', name: '武器w4·数值牌dmg_up', description: 'dmg_up 乘区' },
    ]);
  });

  it('解锁后（4 把全满级）：上限全开——达上限的可重复牌重现、once 牌仍移除、无新武器', () => {
    const state = createSimState(1);
    state.rng = zeroRng();
    ownWeapon(state, 'w1', 10, { w1_bool: 1, w1_rep: 2, dmg_up: 7 });
    ownWeapon(state, 'w2', 10, { dmg_up: 10 });
    ownWeapon(state, 'w3', 10, { dmg_up: 10 });
    ownWeapon(state, 'w4', 10, { dmg_up: 10 });
    const options = rollUpgradeOptions(state, DEFS, 99);
    const w1Cards = options
      .filter((o) => o.kind === 'card' && o.weaponId === 'w1')
      .map((o) => (o as { cardId: string }).cardId)
      .sort();
    expect(w1Cards).toEqual(['dmg_up', 'w1_rep']); // 上限失效：w1_rep 重现；once 的 w1_bool 仍移除
    expect(options.some((o) => o.kind === 'new_weapon')).toBe(false); // 栏满
    // w2..w4 的 dmg_up 解锁后同样无限重复。
    for (const id of ['w2', 'w3', 'w4']) {
      expect(options).toContainEqual({
        kind: 'card',
        weaponId: id,
        cardId: 'dmg_up',
        name: `武器${id}·数值牌dmg_up`,
        description: 'dmg_up 乘区',
      });
    }
  });

  it('count 参数可覆盖默认 3；候选不足时返回全池不抛错；count<=0 返回空', () => {
    const state = createSimState(1);
    state.rng = zeroRng();
    ownWeapon(state, 'w1');
    expect(rollUpgradeOptions(state, DEFS, 0)).toEqual([]);
    expect(rollUpgradeOptions(state, DEFS, 5)).toHaveLength(5); // 全池 8 > 5：恰取 5
    expect(rollUpgradeOptions(state, DEFS, 99)).toHaveLength(8); // 全池 = 5 新武器（w2..w6）+ w1 的 3 张牌
  });

  it('全池构成（确定性）：新武器在表序前段、w1 的牌按目录序在后段，且互不重复', () => {
    const state = createSimState(1);
    state.rng = zeroRng();
    ownWeapon(state, 'w1');
    const options = rollUpgradeOptions(state, DEFS, 99);
    expect(options).toHaveLength(8);
    const ids = options.map(subjectId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(0, 5)).toEqual(['w2', 'w3', 'w4', 'w5', 'w6']); // 新武器在表序前段（w1 已拥有）
    expect(ids.slice(5)).toEqual(['w1:w1_bool', 'w1:w1_rep', 'w1:dmg_up']); // w1 牌按目录序
  });
});

describe('选项不重复', () => {
  it('同一武器同一牌不会出现两个选项（30 种子 × 混合态）', () => {
    for (const options of rollManySeeds(SEEDS, (state) => {
      ownWeapon(state, 'w1');
      ownWeapon(state, 'w2', 2, { dmg_up: 2 });
    })) {
      const ids = options.map(subjectId);
      expect(new Set(ids).size).toBe(ids.length);
      const signatures = options.map((o) => JSON.stringify(o));
      expect(new Set(signatures).size).toBe(signatures.length);
    }
  });
});

describe('同种子可复现 / 不同种子大概率不同', () => {
  const setup = (state: SimState): void => {
    ownWeapon(state, 'w1');
    ownWeapon(state, 'w2', 2, { dmg_up: 2 });
  };

  it('同种子同状态两次 roll 的结果序列完全一致', () => {
    for (const seed of [1, 7, 123, 999]) {
      const a = createSimState(seed);
      const b = createSimState(seed);
      setup(a);
      setup(b);
      expect(rollUpgradeOptions(a, DEFS)).toEqual(rollUpgradeOptions(b, DEFS));
    }
  });

  it('不同种子产出（大概率）不同：24 种子中至少出现 12 种不同结果序列', () => {
    const signatures = rollManySeeds(Array.from({ length: 24 }, (_, i) => i + 1), setup).map((options) =>
      JSON.stringify(options),
    );
    expect(new Set(signatures).size).toBeGreaterThanOrEqual(12);
  });
});

describe('applyUpgrade 两类 option 各自生效', () => {
  it('new_weapon → addWeapon：0 级 / 空牌表 / 冷却 0，且幂等不覆盖', () => {
    const state = createSimState(1);
    applyUpgrade(state, { kind: 'new_weapon', weaponId: 'w5', name: '武器w5', description: '新武器' });
    expect(state.weaponStates.w5).toEqual({ level: 0, cooldownMs: 0, cards: {} });

    // 幂等（addWeapon 契约）：已拥有时不重置
    state.weaponStates.w5.level = 4;
    applyUpgrade(state, { kind: 'new_weapon', weaponId: 'w5', name: '武器w5', description: '新武器' });
    expect(state.weaponStates.w5.level).toBe(4);
  });

  it('card → cards[cardId]++ 且 level+1；可连吃；同牌重复计数', () => {
    const state = createSimState(1);
    ownWeapon(state, 'w1');
    applyUpgrade(state, { kind: 'card', weaponId: 'w1', cardId: 'dmg_up', name: '', description: '' });
    applyUpgrade(state, { kind: 'card', weaponId: 'w1', cardId: 'dmg_up', name: '', description: '' });
    applyUpgrade(state, { kind: 'card', weaponId: 'w1', cardId: 'w1_bool', name: '', description: '' });
    expect(state.weaponStates.w1.cards.dmg_up).toBe(2);
    expect(state.weaponStates.w1.cards.w1_bool).toBe(1);
    expect(state.weaponStates.w1.level).toBe(3); // 每张牌 level+1
  });

  it('解锁后 level > 10 允许（上限门在 roll 侧，apply 不硬拦）', () => {
    const state = createSimState(1);
    ownWeapon(state, 'w1', 10, { dmg_up: 10 });
    applyUpgrade(state, { kind: 'card', weaponId: 'w1', cardId: 'dmg_up', name: '', description: '' }, DEFS);
    expect(state.weaponStates.w1.level).toBe(11);
    expect(state.weaponStates.w1.cards.dmg_up).toBe(11);
  });

  it('非法输入抛错：武器未拥有 / 牌不在该武器牌池（提供 defs 时）', () => {
    const state = createSimState(1);
    // 武器未拥有
    expect(() =>
      applyUpgrade(state, { kind: 'card', weaponId: 'w6', cardId: 'dmg_up', name: '', description: '' }),
    ).toThrow();
    // 牌不在该武器牌池（w2 只有 dmg_up）
    ownWeapon(state, 'w2');
    expect(() =>
      applyUpgrade(state, { kind: 'card', weaponId: 'w2', cardId: 'w1_bool', name: '', description: '' }, DEFS),
    ).toThrow();
    // 不提供 defs：只校验武器已拥有，牌 id 不校验（调用方契约）
    expect(() =>
      applyUpgrade(state, { kind: 'card', weaponId: 'w2', cardId: 'w1_bool', name: '', description: '' }),
    ).not.toThrow();
  });

  it('端到端：roll 出的选项逐个 apply 不抛错且状态合法推进（拥有数随 new_weapon 增加、牌表随 card 增长）', () => {
    const state = createSimState(42);
    ownWeapon(state, 'w1');
    const options = rollUpgradeOptions(state, DEFS);
    expect(options).toHaveLength(3);

    const ownedBefore = Object.keys(state.weaponStates).length;
    const levelBefore = state.weaponStates.w1.level;
    for (const option of options) {
      applyUpgrade(state, option, DEFS);
    }
    const cardOptions = options.filter((o) => o.kind === 'card');
    const newOptions = options.filter((o) => o.kind === 'new_weapon');
    expect(Object.keys(state.weaponStates).length).toBe(ownedBefore + newOptions.length);
    expect(state.weaponStates.w1.level).toBe(levelBefore + cardOptions.filter((o) => o.weaponId === 'w1').length);
  });
});

describe('面向玩家的中文文案（UI 直接渲染）', () => {
  it('new_weapon：name=武器名、description=「新武器」；card：name=「武器名·牌名」、description=牌表效果文案', () => {
    const state = createSimState(1);
    state.rng = zeroRng();
    ownWeapon(state, 'w1', 1, { w1_bool: 1 });
    const options = rollUpgradeOptions(state, DEFS, 99);
    const cardOption = options.find((o) => o.kind === 'card' && (o as { cardId: string }).cardId === 'w1_rep') as
      | Extract<UpgradeOption, { kind: 'card' }>
      | undefined;
    expect(cardOption).toBeDefined();
    expect(cardOption!.name).toBe('武器w1·叠加牌w1_rep');
    expect(cardOption!.description).toBe('w1_rep ×N（上限 2）');

    const fresh = createSimState(1);
    fresh.rng = zeroRng();
    const newOption = rollUpgradeOptions(fresh, DEFS, 3)[0];
    expect(newOption).toMatchObject({ kind: 'new_weapon', name: '武器w1', description: '新武器' });
  });
});
