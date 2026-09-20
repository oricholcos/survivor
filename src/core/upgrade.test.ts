// src/core/upgrade.test.ts —— 三选一牌池生成器（T5.3a）的行为契约。
// 覆盖：新武器卡（栏未满）/ 牌候选构成（绑定武器、尊重上限·前置·一次性）、
// 满级武器解锁前不进候选、解锁后上限全失效且 once 牌仍移除、
// 选项不重复、同种子可复现与不同种子大概率不同、applyUpgrade 两类 option 各自生效
// （card → cards++ 且 level+1、>10 允许；new_weapon → 0 级起步）、中文文案可直接供 UI 渲染。
// 武器 defs 用手写字面量夹具（cards 即合并后的目录），不依赖真实数据表。
import { describe, expect, it } from 'vitest';
import {
  applyUpgrade,
  buildCardDescription,
  rollUpgradeOptions,
  sanitizeUnlimitedCardDescription,
} from './upgrade';
import type { UpgradeOption } from './upgrade';
import type { WeaponDef } from './weapons';
import {
  allMaxedUnlocked,
  isWeaponMaxed,
  MAX_WEAPON_LEVEL,
  type WeaponCardDef as CardDef,
} from './cards';
import { createSimState } from './simState';
import type { Rng, SimState } from './types';
import { loadCardDefs } from '../data/cards';
import { loadWeaponDefs } from '../data/weapons';

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
/** 牌夹具：maxCount + hardMax 双上限牌（解锁前 maxCount、突破后 hardMax 永久封顶）。 */
function hardMaxCard(id: string, maxCount: number, hardMax: number): CardDef {
  return {
    id,
    name: `硬上限牌${id}`,
    description: `${id} 效果（可叠 ${maxCount} 次，突破后上限 ${hardMax} 次）`,
    maxCount,
    hardMax,
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

  it('解锁后 hardMax 硬上限：达硬上限的牌不重现；未达上限的牌照常进池（解锁前后一致）', () => {
    const defs: Record<string, WeaponDef> = {
      wh: makeDef('wh', [hardMaxCard('wh_hm', 2, 4), statCard('dmg_up')]),
      wa: makeDef('wa', [statCard('dmg_up')]),
      wb: makeDef('wb', [statCard('dmg_up')]),
      wc: makeDef('wc', [statCard('dmg_up')]),
    };
    const state = createSimState(1);
    state.rng = zeroRng();
    ownWeapon(state, 'wh', 10, { wh_hm: 4, dmg_up: 6 }); // wh_hm 已达 hardMax 4
    ownWeapon(state, 'wa', 10, { dmg_up: 10 });
    ownWeapon(state, 'wb', 10, { dmg_up: 10 });
    ownWeapon(state, 'wc', 10, { dmg_up: 10 });
    expect(allMaxedUnlocked(state, defs)).toBe(true);

    const options = rollUpgradeOptions(state, defs, 99);
    const whCards = options
      .filter((o) => o.kind === 'card' && o.weaponId === 'wh')
      .map((o) => (o as { cardId: string }).cardId);
    expect(whCards).toEqual(['dmg_up']); // wh_hm 达硬上限：解锁后也不重现

    // 解锁前同样生效：持有数达到 hardMax 即移除（即便未达 maxCount 语义的解锁门槛）。
    const early = createSimState(1);
    early.rng = zeroRng();
    ownWeapon(early, 'wh', 4, { wh_hm: 4 });
    const earlyOptions = rollUpgradeOptions(early, defs, 99);
    expect(earlyOptions.filter((o) => o.kind === 'card' && (o as { cardId: string }).cardId === 'wh_hm')).toHaveLength(0);
  });

  it('解锁后文案清洗只对无 hardMax 的牌执行：hardMax 牌保留两段上限说明', () => {
    const defs: Record<string, WeaponDef> = {
      wh: makeDef('wh', [hardMaxCard('wh_hm', 2, 4), repCard('wh_rep', 2)]),
      wa: makeDef('wa', [statCard('dmg_up')]),
      wb: makeDef('wb', [statCard('dmg_up')]),
      wc: makeDef('wc', [statCard('dmg_up')]),
    };
    const state = createSimState(1);
    state.rng = zeroRng();
    ownWeapon(state, 'wh', 10, { wh_hm: 2, wh_rep: 2 }); // 双牌均达解锁前上限
    ownWeapon(state, 'wa', 10, { dmg_up: 10 });
    ownWeapon(state, 'wb', 10, { dmg_up: 10 });
    ownWeapon(state, 'wc', 10, { dmg_up: 10 });

    const options = rollUpgradeOptions(state, defs, 99);
    const hmOpt = options.find(
      (o) => o.kind === 'card' && o.weaponId === 'wh' && (o as { cardId: string }).cardId === 'wh_hm',
    ) as Extract<UpgradeOption, { kind: 'card' }> | undefined;
    expect(hmOpt).toBeDefined(); // hardMax 4 > 持有 2：解锁后重现
    expect(hmOpt!.description).toBe('wh_hm 效果（可叠 2 次，突破后上限 4 次）'); // 文案原样保留

    const repOpt = options.find(
      (o) => o.kind === 'card' && o.weaponId === 'wh' && (o as { cardId: string }).cardId === 'wh_rep',
    ) as Extract<UpgradeOption, { kind: 'card' }> | undefined;
    expect(repOpt).toBeDefined(); // 无 hardMax：解锁后上限失效重现
    expect(repOpt!.description).toBe('wh_rep ×N'); // 照旧清洗（上限字样已剥除）
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
    expect(state.weaponStates.w5).toEqual({ level: 0, cooldownMs: 0, cards: {}, cardsVersion: 0 });

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

describe('前置依赖 (requiresCard) 与 互斥 (excludes) 约束生成器严格遵守', () => {
  const DEFS_CONSTRAINTS: Record<string, WeaponDef> = {
    wc: makeDef('wc', [
      onceCard('prereq'),
      {
        id: 'dependent',
        name: '后置依赖牌',
        description: '需持有 prereq',
        requiresCard: 'prereq',
        params: [{ key: 'damage', value: 1.5, op: 'mul' }],
      },
      {
        id: 'mode_exclusive',
        name: '质变互斥牌',
        description: '排除 excluded_card',
        once: true,
        excludes: ['excluded_card'],
        params: [{ key: 'mode', value: 1, op: 'set' }],
      },
      {
        id: 'excluded_card',
        name: '被排斥牌',
        description: '与 mode_exclusive 互斥',
        params: [{ key: 'damage', value: 1.2, op: 'mul' }],
      },
      statCard('generic_dmg'),
    ]),
  };

  it('未获得 prereq 时，dependent 绝对不出现在 roll 选项中', () => {
    const state = createSimState(1);
    state.rng = zeroRng();
    ownWeapon(state, 'wc', 0, {});
    const options = rollUpgradeOptions(state, DEFS_CONSTRAINTS, 99);
    const cardIds = options
      .filter((o) => o.kind === 'card' && o.weaponId === 'wc')
      .map((o) => (o as { cardId: string }).cardId);

    expect(cardIds).not.toContain('dependent');
    expect(cardIds).toContain('prereq');
    expect(cardIds).toContain('excluded_card');
    expect(cardIds).toContain('mode_exclusive');
    expect(cardIds).toContain('generic_dmg');
  });

  it('获得 prereq 后，dependent 正常出现在 roll 选项中，且 prereq (once) 移除', () => {
    const state = createSimState(1);
    state.rng = zeroRng();
    ownWeapon(state, 'wc', 1, { prereq: 1 });
    const options = rollUpgradeOptions(state, DEFS_CONSTRAINTS, 99);
    const cardIds = options
      .filter((o) => o.kind === 'card' && o.weaponId === 'wc')
      .map((o) => (o as { cardId: string }).cardId);

    expect(cardIds).toContain('dependent');
    expect(cardIds).not.toContain('prereq'); // once 牌移除
  });

  it('持有 mode_exclusive 后，excluded_card 被彻底移出候选池', () => {
    const state = createSimState(1);
    state.rng = zeroRng();
    ownWeapon(state, 'wc', 1, { mode_exclusive: 1 });
    const options = rollUpgradeOptions(state, DEFS_CONSTRAINTS, 99);
    const cardIds = options
      .filter((o) => o.kind === 'card' && o.weaponId === 'wc')
      .map((o) => (o as { cardId: string }).cardId);

    expect(cardIds).not.toContain('excluded_card');
    expect(cardIds).not.toContain('mode_exclusive'); // once 牌自身也移出
    expect(cardIds).toContain('prereq');
    expect(cardIds).toContain('generic_dmg');
  });



  it('真实武器数据表（scatter dot_freq requires burn_bullet）：三选一严格遵守', () => {
    const realDefs = loadWeaponDefs();
    const state = createSimState(1);
    state.rng = zeroRng();
    ownWeapon(state, 'scatter', 0, {});

    // 未拿 burn_bullet 时，dot_freq 不得入选
    let options = rollUpgradeOptions(state, realDefs, 99);
    let scatterCards = options
      .filter((o) => o.kind === 'card' && o.weaponId === 'scatter')
      .map((o) => (o as { cardId: string }).cardId);
    expect(scatterCards).not.toContain('dot_freq');

    // 吃下 burn_bullet 后，dot_freq 进入候选
    state.weaponStates.scatter.cards.burn_bullet = 1;
    state.weaponStates.scatter.level = 1;
    options = rollUpgradeOptions(state, realDefs, 99);
    scatterCards = options
      .filter((o) => o.kind === 'card' && o.weaponId === 'scatter')
      .map((o) => (o as { cardId: string }).cardId);
    expect(scatterCards).toContain('dot_freq');
  });
});

describe('牌池中绝无旧被动牌（纯武器牌池重构验证）', () => {
  it('真实数据表中全部武器 defs 均无旧被动牌定义，每张牌均绑定武器', () => {
    const defs = loadWeaponDefs();
    for (const wid in defs) {
      const def = defs[wid];
      expect(def.cards.length).toBeGreaterThan(0);
      for (const card of def.cards) {
        expect(card.id).toBeDefined();
        expect(typeof card.name).toBe('string');
        // 绝不含 passive kind
        expect((card as { kind?: string }).kind).not.toBe('passive');
      }
    }
  });

  it('跨 50 种随机种子及不同武器持有状态下，rollUpgradeOptions 仅产生 new_weapon 或 card', () => {
    const defs = loadWeaponDefs();
    for (let seed = 1; seed <= 50; seed++) {
      const state = createSimState(seed);
      if (seed % 2 === 0) {
        ownWeapon(state, 'rail_piercer', 0);
      }
      if (seed % 3 === 0) {
        ownWeapon(state, 'scatter', 3, { burn_bullet: 1 });
      }
      const options = rollUpgradeOptions(state, defs, 3);
      for (const opt of options) {
        expect(['new_weapon', 'card']).toContain(opt.kind);
        if (opt.kind === 'card') {
          expect(state.weaponStates[opt.weaponId]).toBeDefined();
          const def = defs[opt.weaponId];
          expect(def.cards.some((c) => c.id === opt.cardId)).toBe(true);
        }
      }
    }
  });
});

describe('牌池升级流完整生命周期：0级起步 -> 选牌等级提升 -> 满级限制 -> 4把满级 -> 解锁无限牌池', () => {
  it('完整模拟：0级武器 -> 每次选牌level+1 -> 单把满级禁卡 -> 满4把禁新武器 -> 4把全满解锁无限牌池 -> 超出10级继续提升', () => {
    const defs = loadWeaponDefs();
    const state = createSimState(42);
    expect(state.config.maxWeaponSlots).toBe(4);
    expect(MAX_WEAPON_LEVEL).toBe(10);

    // 1. 开局：0 把武器
    expect(Object.keys(state.weaponStates)).toHaveLength(0);
    let options = rollUpgradeOptions(state, defs, 3);
    expect(options.every((o) => o.kind === 'new_weapon')).toBe(true);

    // 2. 选择第 1 把武器：rail_piercer -> 0 级起步
    const w1Opt = options.find((o) => o.kind === 'new_weapon' && o.weaponId === 'rail_piercer') ?? options[0];
    applyUpgrade(state, w1Opt, defs);
    const w1 = w1Opt.weaponId;
    expect(state.weaponStates[w1]).toBeDefined();
    expect(state.weaponStates[w1].level).toBe(0);
    expect(state.weaponStates[w1].cards).toEqual({});

    // 3. 为 w1 连选 10 张牌，验证每次 level+1
    for (let expectedLevel = 1; expectedLevel <= 10; expectedLevel++) {
      options = rollUpgradeOptions(state, defs, 99);
      const cardOpt = options.find((o) => o.kind === 'card' && o.weaponId === w1);
      expect(cardOpt).toBeDefined();
      applyUpgrade(state, cardOpt!, defs);
      expect(state.weaponStates[w1].level).toBe(expectedLevel);
    }

    // 4. w1 满级（10 级）检查：此时只有 1 把武器，未达到 4 把，无限牌池未解锁
    expect(isWeaponMaxed(state, w1, defs)).toBe(true);
    expect(allMaxedUnlocked(state, defs)).toBe(false);

    // 满级武器在未解锁前绝不进候选池！
    options = rollUpgradeOptions(state, defs, 99);
    expect(options.some((o) => o.kind === 'card' && o.weaponId === w1)).toBe(false);

    // 5. 获得第 2 把武器，升至 10 级
    const w2Opt = options.find((o) => o.kind === 'new_weapon')!;
    expect(w2Opt).toBeDefined();
    applyUpgrade(state, w2Opt, defs);
    const w2 = w2Opt.weaponId;
    expect(state.weaponStates[w2].level).toBe(0);
    for (let lvl = 1; lvl <= 10; lvl++) {
      options = rollUpgradeOptions(state, defs, 99);
      const card = options.find((o) => o.kind === 'card' && o.weaponId === w2)!;
      applyUpgrade(state, card, defs);
    }
    expect(isWeaponMaxed(state, w2, defs)).toBe(true);
    expect(allMaxedUnlocked(state, defs)).toBe(false);

    // 6. 获得第 3 把武器，升至 10 级
    options = rollUpgradeOptions(state, defs, 99);
    const w3Opt = options.find((o) => o.kind === 'new_weapon')!;
    applyUpgrade(state, w3Opt, defs);
    const w3 = w3Opt.weaponId;
    expect(state.weaponStates[w3].level).toBe(0);
    for (let lvl = 1; lvl <= 10; lvl++) {
      options = rollUpgradeOptions(state, defs, 99);
      const card = options.find((o) => o.kind === 'card' && o.weaponId === w3)!;
      applyUpgrade(state, card, defs);
    }
    expect(isWeaponMaxed(state, w3, defs)).toBe(true);
    expect(allMaxedUnlocked(state, defs)).toBe(false);

    // 7. 获得第 4 把武器：此时拥有武器数已达 maxWeaponSlots (4)
    options = rollUpgradeOptions(state, defs, 99);
    const w4Opt = options.find((o) => o.kind === 'new_weapon')!;
    applyUpgrade(state, w4Opt, defs);
    const w4 = w4Opt.weaponId;
    expect(Object.keys(state.weaponStates)).toHaveLength(4);
    expect(state.weaponStates[w4].level).toBe(0);

    // 武器栏已满：候选池中不得再出现任何 new_weapon 选项！
    options = rollUpgradeOptions(state, defs, 99);
    expect(options.some((o) => o.kind === 'new_weapon')).toBe(false);

    // 8. 升级第 4 把武器至 9 级：仍未全部满级，未解锁
    for (let lvl = 1; lvl <= 9; lvl++) {
      options = rollUpgradeOptions(state, defs, 99);
      const card = options.find((o) => o.kind === 'card' && o.weaponId === w4)!;
      applyUpgrade(state, card, defs);
    }
    expect(state.weaponStates[w4].level).toBe(9);
    expect(allMaxedUnlocked(state, defs)).toBe(false);

    // 第 10 级：吃下最后一张牌
    options = rollUpgradeOptions(state, defs, 99);
    const card10 = options.find((o) => o.kind === 'card' && o.weaponId === w4)!;
    applyUpgrade(state, card10, defs);
    expect(state.weaponStates[w4].level).toBe(10);

    // 9. 临界突变：4 把武器全部满 10 级！无限牌池立即解锁！
    expect(allMaxedUnlocked(state, defs)).toBe(true);

    // 10. 验证解锁后无限牌池特权：
    options = rollUpgradeOptions(state, defs, 99);
    const unlockedWeaponsInPool = new Set(
      options.filter((o) => o.kind === 'card').map((o) => o.weaponId),
    );
    // 全部 4 把武器重新进池！
    expect(unlockedWeaponsInPool.has(w1)).toBe(true);
    expect(unlockedWeaponsInPool.has(w2)).toBe(true);
    expect(unlockedWeaponsInPool.has(w3)).toBe(true);
    expect(unlockedWeaponsInPool.has(w4)).toBe(true);

    // 选一张 w1 的牌，验证等级突破 10 级并达到 11、12 级
    const w1CardPost = options.find((o) => o.kind === 'card' && o.weaponId === w1)!;
    applyUpgrade(state, w1CardPost, defs);
    expect(state.weaponStates[w1].level).toBe(11);

    options = rollUpgradeOptions(state, defs, 99);
    const w1CardPost2 = options.find((o) => o.kind === 'card' && o.weaponId === w1)!;
    applyUpgrade(state, w1CardPost2, defs);
    expect(state.weaponStates[w1].level).toBe(12);

    // 解锁状态依旧保持
    expect(allMaxedUnlocked(state, defs)).toBe(true);
    // 依然无新武器
    expect(rollUpgradeOptions(state, defs, 99).some((o) => o.kind === 'new_weapon')).toBe(false);
  });

  describe('突破上限卡牌描述清洗与分裂牌过滤', () => {
    it('sanitizeUnlimitedCardDescription 清洗上限文本，保留正常文案', () => {
      expect(sanitizeUnlimitedCardDescription('同时多发射 1 枚弹丸（可叠 4 次）')).toBe('同时多发射 1 枚弹丸');
      expect(sanitizeUnlimitedCardDescription('开火后跟发 1 波齐射（每波完整再发一轮弹丸），波间隔 150ms（可叠 2 次）')).toBe(
        '开火后跟发 1 波齐射（每波完整再发一轮弹丸），波间隔 150ms',
      );
      expect(sanitizeUnlimitedCardDescription('该武器爆炸半径 ×1.2（可叠 5 次）')).toBe('该武器爆炸半径 ×1.2');
      expect(sanitizeUnlimitedCardDescription('灼痕的灼烧每跳间隔 ÷1.3（可叠 3 次）')).toBe('灼痕的灼烧每跳间隔 ÷1.3');
      // 「，上限 n 次」尾缀形式（合成的旧文案样本，覆盖清洗规则分支）：
      expect(sanitizeUnlimitedCardDescription('每次命中且折射计数>0时，折向300px内最近未受击敌人（折射-1，穿透-1，上限4次）')).toBe('每次命中且折射计数>0时，折向300px内最近未受击敌人（折射-1，穿透-1）');
      expect(sanitizeUnlimitedCardDescription('穿透 +1（可叠 4 次）')).toBe('穿透 +1');
      expect(sanitizeUnlimitedCardDescription('c1 ×N（上限 2）')).toBe('c1 ×N');
      expect(sanitizeUnlimitedCardDescription('该武器伤害 ×1.3（可叠加）')).toBe('该武器伤害 ×1.3（可叠加）');
      expect(sanitizeUnlimitedCardDescription('散热速率 +6/s（基础 20/s；热量满 100 过热，开火间隔 ×1.6 持续 2.5s）（可叠 2 次）')).toBe(
        '散热速率 +6/s（基础 20/s；热量满 100 过热，开火间隔 ×1.6 持续 2.5s）',
      );
      expect(sanitizeUnlimitedCardDescription('开火瞬间若锁定目标当前生命 ≥ 60% 最大生命，本波伤害 ×1.5（残血目标不增伤；与处决强化乘区叠加；一次性）')).toBe(
        '开火瞬间若锁定目标当前生命 ≥ 60% 最大生命，本波伤害 ×1.5（残血目标不增伤；与处决强化乘区叠加；一次性）',
      );
    });

    it('真实表解锁无限牌池后：无 hardMax 牌文案照旧清洗、hardMax 牌保留两段上限，且已持有分裂牌（split_shot）不再出现', () => {
      const realDefs = loadWeaponDefs();
      const state = createSimState(1);
      // 拥有 4 把武器且全部满 10 级
      const wIds = ['mortar', 'charge_sniper', 'rail_piercer', 'prism'];
      for (const id of wIds) {
        state.weaponStates[id] = {
          level: 10,
          cooldownMs: 0,
          cards: {
            multi_shot: 4,
            split_shot: 1, // 已持有一张分裂牌
          },
        };
      }
      expect(allMaxedUnlocked(state, realDefs)).toBe(true);

      const options = rollUpgradeOptions(state, realDefs, 99);
      // 1. 绝不包含已持有的 split_shot
      const splitOptions = options.filter((o) => o.kind === 'card' && o.cardId === 'split_shot');
      expect(splitOptions).toHaveLength(0);

      // 2. multi_shot 持有 4 < hardMax 8：解锁后依然进池，且因 hardMax 永久生效，
      //    两段上限文案原样保留（不做突破清洗）；描述为按武器生成的实体名词（榴弹壳体）。
      const multiMortar = options.find((o) => o.kind === 'card' && o.weaponId === 'mortar' && o.cardId === 'multi_shot');
      expect(multiMortar).toBeDefined();
      expect(multiMortar!.description).toBe('同时多发射 1 枚榴弹壳体（可叠 4 次，突破后上限 8 次）');

      // 3. 不变式：凡保留「可叠 n 次」（带数字）文案的选项必是 hardMax 牌（带「突破后上限」两段说明）；
      //    dmg_up 等「（可叠加，上限 n 次）」措辞为纯 hardMax 牌，不在此列。
      for (const o of options) {
        if (o.kind === 'card' && /（?可叠\s*\d+\s*次/.test(o.description)) {
          expect(o.description).toContain('突破后上限');
        }
      }
    });
  });
});

describe('通用牌逐武器文案生成器（任务四：映射表驱动、无武器特判）', () => {
  const REAL_DEFS = loadWeaponDefs();

  /** 取某武器合并牌池里的通用牌 def（loadWeaponDefs 已把 cards.json 按 applyTo 合并进 def.cards）。 */
  function genericOf(weaponId: string, cardId: string): CardDef {
    const card = REAL_DEFS[weaponId].cards.find((c) => c.id === cardId);
    if (!card) {
      throw new Error(`武器 ${weaponId} 牌池缺少通用牌 ${cardId}`);
    }
    return card;
  }

  it('multi_shot：同一牌在不同武器生成不同弹体名词（弹丸/榴弹壳体/链弹/导弹；狙击已移出 applyTo）', () => {
    expect(buildCardDescription(REAL_DEFS.scatter, genericOf('scatter', 'multi_shot'))).toBe(
      '同时多发射 1 枚弹丸（可叠 4 次，突破后上限 8 次）',
    );
    expect(buildCardDescription(REAL_DEFS.mortar, genericOf('mortar', 'multi_shot'))).toBe(
      '同时多发射 1 枚榴弹壳体（可叠 4 次，突破后上限 8 次）',
    );
    expect(buildCardDescription(REAL_DEFS.prism, genericOf('prism', 'multi_shot'))).toBe(
      '同时多发射 1 枚链弹（可叠 4 次，突破后上限 8 次）',
    );
    expect(buildCardDescription(REAL_DEFS.homing_missile, genericOf('homing_missile', 'multi_shot'))).toContain('枚导弹');
    // 任务三：蓄能狙击已移出三张通用牌的 applyTo——牌池里根本没有 multi_shot。
    expect(REAL_DEFS.charge_sniper.cards.find((c) => c.id === 'multi_shot')).toBeUndefined();
  });

  it('burst_shot：跟发波文案带各武器弹体名词；波数/间隔数值来自牌表 params（狙击已移出 applyTo）', () => {
    const nouns: Record<string, string> = {
      scatter: '弹丸',
      homing_missile: '导弹',
      mortar: '榴弹壳体',
      prism: '链弹',
    };
    for (const wid of Object.keys(nouns)) {
      expect(buildCardDescription(REAL_DEFS[wid], genericOf(wid, 'burst_shot'))).toBe(
        `开火后跟发 1 波齐射（每波完整再发一轮${nouns[wid]}），波间隔 150ms（跟发波重新索敌，无目标自动跳过）（可叠 2 次，突破后上限 4 次）`,
      );
    }
    expect(REAL_DEFS.charge_sniper.cards.find((c) => c.id === 'burst_shot')).toBeUndefined();
  });

  it('split_shot：主/次弹名词与分裂触发点随武器（霰弹=弹丸命中后、榴弹=母弹爆炸后；狙击已移出 applyTo）', () => {
    expect(buildCardDescription(REAL_DEFS.scatter, genericOf('scatter', 'split_shot'))).toBe(
      '弹丸命中后分裂出至多 4 枚次级弹丸：各 20% 伤害、锁定最近的 4 个不同敌人（次级弹不再分裂、不触发多射与连射；本牌一次性）',
    );
    expect(buildCardDescription(REAL_DEFS.mortar, genericOf('mortar', 'split_shot'))).toContain('母弹爆炸后分裂出至多 4 枚次级榴弹');
    expect(buildCardDescription(REAL_DEFS.homing_missile, genericOf('homing_missile', 'split_shot'))).toContain('导弹爆炸后分裂出至多 4 枚次级导弹');
    expect(buildCardDescription(REAL_DEFS.prism, genericOf('prism', 'split_shot'))).toContain('主弹命中后分裂出至多 4 枚次级棱镜弹');
    expect(REAL_DEFS.charge_sniper.cards.find((c) => c.id === 'split_shot')).toBeUndefined();
  });

  it('range_up：逐键列出该武器会被强化的范围名（heat_beam 为索敌半径）', () => {
    expect(buildCardDescription(REAL_DEFS.scatter, genericOf('scatter', 'range_up'))).toBe(
      '该武器扇角 ×1.2（可叠 5 次，突破后上限 8 次）',
    );
    expect(buildCardDescription(REAL_DEFS.homing_missile, genericOf('homing_missile', 'range_up'))).toBe(
      '该武器爆炸半径 ×1.2（可叠 5 次，突破后上限 8 次）',
    );
    expect(buildCardDescription(REAL_DEFS.mortar, genericOf('mortar', 'range_up'))).toBe(
      '该武器爆炸半径 ×1.2（可叠 5 次，突破后上限 8 次）',
    );
    expect(buildCardDescription(REAL_DEFS.prism, genericOf('prism', 'range_up'))).toBe(
      '该武器弹跳范围 ×1.2（可叠 5 次，突破后上限 8 次）',
    );
    expect(buildCardDescription(REAL_DEFS.heat_beam, genericOf('heat_beam', 'range_up'))).toBe(
      '该武器索敌半径 ×1.2（可叠 5 次，突破后上限 8 次）',
    );
  });

  it('dot_freq：按武器生成对应持续伤害名（与各武器 requiresCard 附着牌一一对应）', () => {
    expect(buildCardDescription(REAL_DEFS.heat_beam, genericOf('heat_beam', 'dot_freq'))).toBe(
      '灼痕的灼烧每跳间隔 ÷1.3（可叠 3 次，突破后上限 6 次）',
    );
    expect(buildCardDescription(REAL_DEFS.scatter, genericOf('scatter', 'dot_freq'))).toContain('燃烧弹的燃烧每跳间隔 ÷1.3');
    expect(buildCardDescription(REAL_DEFS.homing_missile, genericOf('homing_missile', 'dot_freq'))).toContain('燃烧云的燃烧');
    expect(buildCardDescription(REAL_DEFS.mortar, genericOf('mortar', 'dot_freq'))).toContain('燃烧地的燃烧');
    expect(buildCardDescription(REAL_DEFS.prism, genericOf('prism', 'dot_freq'))).toContain('冰毒附着的中毒');
  });

  it('映射表驱动、无武器特判：名词表没有的武器优雅回退 JSON 原文案（新武器漏配表不崩溃）', () => {
    const future = makeDef('future_weapon', [genericOf('scatter', 'multi_shot')]);
    const card = genericOf('scatter', 'multi_shot');
    expect(buildCardDescription(future, card)).toBe(card.description);
  });

  it('文案数值随牌表参数：改 params/上限即随文案变化（数据驱动非硬编码）', () => {
    const multi: CardDef = {
      ...genericOf('scatter', 'multi_shot'),
      params: [{ key: 'projectileCount', value: 2, op: 'add' }],
      maxCount: 3,
      hardMax: 6,
    };
    expect(buildCardDescription(REAL_DEFS.scatter, multi)).toBe('同时多发射 2 枚弹丸（可叠 3 次，突破后上限 6 次）');

    const split: CardDef = {
      ...genericOf('scatter', 'split_shot'),
      params: [
        { key: 'splitCount', value: 1, op: 'add' },
        { key: 'splitDamageFactor', value: 0.3, op: 'set' },
        { key: 'splitMaxTargets', value: 2, op: 'set' },
      ],
    };
    expect(buildCardDescription(REAL_DEFS.scatter, split)).toContain('至多 2 枚次级弹丸：各 30% 伤害');
  });

  it('表完备性：各动态通用牌 applyTo 内的每把武器都生成逐武器文案（新增武器漏配表即刻红）', () => {
    const dynamic = ['multi_shot', 'burst_shot', 'split_shot', 'range_up', 'dot_freq'];
    for (const raw of loadCardDefs()) {
      if (!dynamic.includes(raw.id)) {
        continue;
      }
      for (const wid of raw.applyTo) {
        if (wid === 'all') {
          continue; // 动态文案必须逐武器配置映射表，不支持 all 兜底
        }
        const def = REAL_DEFS[wid];
        expect(def, `武器 ${wid} 应存在于武器表`).toBeDefined();
        const desc = buildCardDescription(def, genericOf(wid, raw.id));
        expect(desc, `武器 ${wid} 的 ${raw.id} 应为逐武器生成文案`).not.toBe(raw.description);
      }
    }
  });

  it('与 sanitizeUnlimitedCardDescription 清洗兼容：生成文案的上限后缀可被正确清洗/保留', () => {
    // 无 hardMax 的生成文案（单段式后缀）→ 突破后清洗为纯净描述：
    const noHardMax: CardDef = { ...genericOf('scatter', 'multi_shot') };
    delete noHardMax.hardMax;
    const desc = buildCardDescription(REAL_DEFS.scatter, noHardMax);
    expect(desc).toBe('同时多发射 1 枚弹丸（可叠 4 次）');
    expect(sanitizeUnlimitedCardDescription(desc)).toBe('同时多发射 1 枚弹丸');

    // hardMax 生成文案（两段式后缀）→ rollUpgradeOptions 对 hardMax 牌不清洗，原样保留：
    expect(buildCardDescription(REAL_DEFS.scatter, genericOf('scatter', 'multi_shot'))).toContain('突破后上限 8 次');
  });

  it('端到端：rollUpgradeOptions 产出逐武器生成的文案（零随机抽 scatter 牌池）', () => {
    const state = createSimState(1);
    state.rng = zeroRng();
    ownWeapon(state, 'scatter');
    const options = rollUpgradeOptions(state, REAL_DEFS, 99);
    const multi = options.find(
      (o) => o.kind === 'card' && o.weaponId === 'scatter' && (o as { cardId: string }).cardId === 'multi_shot',
    ) as Extract<UpgradeOption, { kind: 'card' }> | undefined;
    expect(multi).toBeDefined();
    expect(multi!.description).toBe('同时多发射 1 枚弹丸（可叠 4 次，突破后上限 8 次）');

    const range = options.find(
      (o) => o.kind === 'card' && (o as { cardId: string }).cardId === 'range_up',
    ) as Extract<UpgradeOption, { kind: 'card' }> | undefined;
    expect(range).toBeDefined();
    expect(range!.description).toBe('该武器扇角 ×1.2（可叠 5 次，突破后上限 8 次）');

    // dot_freq 前置（requiresCard=burn_bullet）未满足：不进池
    expect(options.some((o) => o.kind === 'card' && (o as { cardId: string }).cardId === 'dot_freq')).toBe(false);
  });

  it('端到端：持有燃烧弹后 dot_freq 进池且文案为逐武器生成（灼痕→燃烧弹随武器而异）', () => {
    const state = createSimState(1);
    state.rng = zeroRng();
    ownWeapon(state, 'scatter', 1, { burn_bullet: 1 });
    const options = rollUpgradeOptions(state, REAL_DEFS, 99);
    const dot = options.find(
      (o) => o.kind === 'card' && (o as { cardId: string }).cardId === 'dot_freq',
    ) as Extract<UpgradeOption, { kind: 'card' }> | undefined;
    expect(dot).toBeDefined();
    expect(dot!.description).toBe('燃烧弹的燃烧每跳间隔 ÷1.3（可叠 3 次，突破后上限 6 次）');
  });
});
