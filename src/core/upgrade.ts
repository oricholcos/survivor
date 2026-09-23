// src/core/upgrade.ts —— 三选一生成器：牌池选项的抽取（roll）与应用（apply）。
// T5.3a 牌池制（用户拍板）：废除「武器升级 + 被动」两类选项，只留两类——
// - new_weapon：新武器（未拥有 且 武器栏未满；开局首武器 0 级起步）；
// - card：武器牌（绑定某把已拥有武器；通用牌与专属牌统一走 def.cards 目录）。
// 生成规则：每把未满级武器 → 其可用牌池（尊重上限/前置/互斥/一次性）；集满
// maxWeaponSlots 把且全部满级 → 无限牌池解锁：所有数量上限失效（可叠/带参数牌无限
// 重复），纯布尔 once 牌仍拿一次即从池移除，hardMax 硬上限例外（永远生效）；已满级
// 武器解锁前不进候选。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM。
// 随机契约：抽取全流程只用 state.rng（同种子同状态产出可复现），禁用 Math.random。

import { addWeapon } from './weapons';
import type { WeaponDef } from './weapons';
import { allMaxedUnlocked, availableCards, isWeaponMaxed } from './cards';
import type { WeaponCardDef } from './cards';
import type { Rng, SimState } from './types';

/** 升级三选一的一个选项（视图层按 kind 分支渲染与点击应用；文案为面向玩家的中文）。 */
export type UpgradeOption =
  | { kind: 'new_weapon'; weaponId: string; name: string; description: string }
  | {
      kind: 'card';
      weaponId: string;
      cardId: string;
      name: string;
      description: string;
      currentCount?: number;
      maxCount?: number;
    };

/**
 * 从池中不重复随机抽 count 个（部分 Fisher-Yates：只洗前 take 位， rng 消耗次数确定）。
 * 池不足 count 时返回整个洗好的池（截断到池长）。不修改原数组。
 */
function pickWithoutReplacement<T>(pool: readonly T[], count: number, rng: Rng): T[] {
  const items = pool.slice();
  const take = Math.min(Math.max(count, 0), items.length);
  for (let i = 0; i < take; i++) {
    const j = i + rng.int(items.length - i);
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
  items.length = take;
  return items;
}

/**
 * 选牌时卡牌描述处理：
 * 为有上限且可多次叠加的卡牌呈现当前已选数量与上限（格式：（已选/最大））。
 * 唯一牌（once / maxLimit <= 1）与无上限卡牌不追加计数。
 * 若已有旧上限说明（如（可叠...）、（上限...）、（一次性）），统一替换为（已选/最大）或清洗剥除。
 */
export function formatCardDescriptionWithLimit(
  desc: string,
  currentCount: number,
  maxLimit: number | undefined,
): string {
  const capRegex = /[（(]\s*(?:(?:可叠加[，,]\s*)?(?:可叠\s*\d+\s*次(?:[，,]\s*突破后上限\s*\d+\s*次)?|上限\s*\d+\s*次?)|一次性)\s*[）)]/g;
  if (maxLimit === undefined || maxLimit <= 1) {
    return desc.replace(capRegex, '').trim();
  }
  const countTag = `（${currentCount}/${maxLimit}）`;
  if (capRegex.test(desc)) {
    return desc.replace(capRegex, countTag);
  }
  return `${desc}${countTag}`;
}

/**
 * 突破上限后卡牌描述清洗：
 * 剥除文案中包含的上限或叠下次限制说明（如“（可叠 4 次）”、“（上限 4 次）”、“（上限 2）”、“，上限4次”），
 * 避免误导玩家（实际在突破上限后已可无限刷新），同时保留正常语义（如“（可叠加）”）。
 */
export function sanitizeUnlimitedCardDescription(desc: string): string {
  let res = desc.replace(/[（(]\s*(?:可叠\s*\d+\s*次|上限\s*\d+\s*次?)\s*[）)]/g, '');
  res = res.replace(/[,，、]\s*上限\s*\d+\s*次?/g, '');
  return res.trim();
}

// —— 通用牌逐武器文案生成器（任务四） ——
// 通用牌（cards.json）的描述按当前武器动态拼装；全部逐武器差异来自下方三张映射表，
// 生成器本体不含任何 weaponId 特判分支（新武器接入通用牌 = 补一行表数据，零代码改动）。
// 只生成文案，不触碰任何数值行为；上限后缀保持 M17 契约格式——hardMax 牌固定两段式
// 「（可叠 n 次，突破后上限 m 次）」（sanitize 不清洗），仅 maxCount 牌单段式「（可叠 n 次）」
// （突破后由 sanitizeUnlimitedCardDescription 清洗，与既有清洗规则完全兼容）。

/** 范围键 → 中文名：范围强化牌逐键列出该武器会被强化的范围名（未映射键回退原始键名）。 */
const RANGE_KEY_ZH: Record<string, string> = {
  lockRange: '索敌半径',
  waveDistance: '行进距离',
  bandDepth: '冲击带深度',
  chainRange: '弹跳范围',
  zapRadius: '闪电半径',
  aoeRadius: '爆炸半径',
  fanAngleDeg: '扇角',
  beamWidth: '光束宽度',
  beamRange: '光束射程',
};

/** 逐武器弹体名词（多射/连射/分裂共用）。splitSite = 分裂触发点（命中后=直击分裂、
 *  爆炸后=死亡爆炸分裂）。语义逐一对齐 src/core/behaviors/*.ts 现状：
 *  霰弹=弹丸、榴弹=榴弹壳体（母弹/次级榴弹）、棱镜=链弹、导弹=导弹。
 *  （任务三：蓄能狙击已移出三张通用牌的 applyTo，条目随之删除；守卫测试按
 *  「applyTo 内武器必须配表」把守——若未来重新收录狙击，此处漏配会即刻红。） */
interface VolleyNouns {
  /** 多射/连射的「单体」名词（一波齐射中的一枚）。 */
  single: string;
  /** 分裂牌的主弹名词。 */
  main: string;
  /** 分裂牌的次级弹名词。 */
  secondary: string;
  /** 分裂触发点短语。 */
  splitSite: string;
}

const VOLLEY_NOUNS: Record<string, VolleyNouns> = {
  scatter: { single: '弹丸', main: '弹丸', secondary: '次级弹丸', splitSite: '命中后' },
  homing_missile: { single: '导弹', main: '导弹', secondary: '次级导弹', splitSite: '爆炸后' },
  mortar: { single: '榴弹壳体', main: '母弹', secondary: '次级榴弹', splitSite: '爆炸后' },
  prism: { single: '链弹', main: '主弹', secondary: '次级棱镜弹', splitSite: '命中后' },
};

/** 逐武器 dot 名（dot 频率牌缩短跳伤间隔的持续伤害名；对应各武器 requiresCard 附着牌）。 */
const DOT_NAMES: Record<string, string> = {
  heat_beam: '灼痕的灼烧',
  homing_missile: '燃烧云的燃烧',
  mortar: '燃烧地的燃烧',
  prism: '冰毒附着的中毒',
  scatter: '燃烧弹的燃烧',
};

/** 叠层上限后缀：hardMax 牌固定两段式（M17 契约，清洗规则永不触碰）；仅 maxCount 牌
 *  单段式（突破后由 sanitizeUnlimitedCardDescription 剥除）；once/无上限牌无后缀。 */
function capSuffix(card: WeaponCardDef): string {
  if (card.hardMax !== undefined) {
    return `（可叠 ${card.maxCount ?? card.hardMax} 次，突破后上限 ${card.hardMax} 次）`;
  }
  if (card.maxCount !== undefined) {
    return `（可叠 ${card.maxCount} 次）`;
  }
  return '';
}

/** 读牌 params 中指定键的数值（缺失/非法返回 undefined）：文案数值随表，零硬编码。 */
function cardParam(card: WeaponCardDef, key: string): number | undefined {
  const p = card.params?.find((c) => c.key === key);
  return p && Number.isFinite(p.value) ? p.value : undefined;
}

/** 按牌 id 查通用牌生成器（映射表驱动）；未配置生成器的通用牌原样使用 JSON 文案。 */
const GENERIC_CARD_DESC: Record<string, (def: WeaponDef, card: WeaponCardDef) => string> = {
  multi_shot: (def, card) => {
    const noun = VOLLEY_NOUNS[def.id];
    if (!noun) {
      return card.description;
    }
    const n = cardParam(card, 'projectileCount') ?? 1;
    return `同时多发射 ${n} 枚${noun.single}${capSuffix(card)}`;
  },
  burst_shot: (def, card) => {
    const noun = VOLLEY_NOUNS[def.id];
    if (!noun) {
      return card.description;
    }
    const waves = cardParam(card, 'burstWaves') ?? 1;
    const interval = cardParam(card, 'burstIntervalMs') ?? 150;
    return `开火后跟发 ${waves} 波齐射（每波再发一轮${noun.single}），波间隔 ${interval}ms${capSuffix(card)}`;
  },
  split_shot: (def, card) => {
    const noun = VOLLEY_NOUNS[def.id];
    if (!noun) {
      return card.description;
    }
    const targets = cardParam(card, 'splitMaxTargets') ?? 4;
    const factor = cardParam(card, 'splitDamageFactor');
    const pct = factor !== undefined ? Math.round(factor * 100) : 20;
    return `${noun.main}${noun.splitSite}分裂出至多 ${targets} 枚${noun.secondary}：各 ${pct}% 伤害、锁定最近的 ${targets} 个不同敌人（一次性）`;
  },
  range_up: (def, card) => {
    const names = def.rangeKeys.map((k) => RANGE_KEY_ZH[k] ?? k);
    if (names.length === 0) {
      return card.description; // 无范围键武器不在本牌 applyTo；防御性回退
    }
    return `该武器${names.join('、')} ×${card.value ?? 1.2}${capSuffix(card)}`;
  },
  dot_freq: (def, card) => {
    const dot = DOT_NAMES[def.id];
    if (!dot) {
      return card.description;
    }
    return `${dot}每跳间隔 ÷${card.value ?? 1.3}${capSuffix(card)}`;
  },
};

/**
 * 生成一张牌在某把武器上的面向玩家描述：
 * - 通用牌（GENERIC_CARD_DESC 表内有生成器的 id）→ 按映射表逐武器拼装；
 * - 专属牌与缺表项的武器 → 原样返回牌表 JSON 文案（新武器未补名词表时优雅退化）。
 * 纯函数：只读 def/card，不产生任何数值副作用。
 */
export function buildCardDescription(def: WeaponDef, card: WeaponCardDef): string {
  const builder = GENERIC_CARD_DESC[card.id];
  return builder ? builder(def, card) : card.description;
}

/**
 * 生成一次升级的选项列表（默认 3 个，互不重复）。
 *
 * 候选池构造（确定性：新武器按 defs 表序，牌按「defs 表序 × def.cards 目录序」）：
 * 1) new_weapon：未拥有 且 拥有数 < state.config.maxWeaponSlots（解锁后栏已满，天然不出现）；
 * 2) card：已拥有武器 且（解锁前未满级 / 解锁后不限）→ availableCards(def, ws, unlocked)；
 * 3) 全流程只用 state.rng：同种子同状态产出可复现。
 *
 * name/description 约定（面向玩家的中文，UI 直接渲染）：
 * - new_weapon → name=def.name、description=「新武器」；
 * - card → name=`${def.name}·${card.name}`（如「轨道贯穿炮·伤害强化」）、
 *   description=牌表文案（通用牌经 buildCardDescription 按当前武器动态拼装；
 *   有上限的卡牌格式化呈现当前已选数量（已选/最大））。
 */
export function rollUpgradeOptions(state: SimState, defs: Record<string, WeaponDef>, count = 3): UpgradeOption[] {
  if (count <= 0) {
    return [];
  }

  const owned = state.weaponStates;
  const slotsFull = Object.keys(owned).length >= state.config.maxWeaponSlots;
  const unlocked = allMaxedUnlocked(state, defs);

  const candidates: UpgradeOption[] = [];

  // 1) 新武器候选（defs 表序）。
  const ids = Object.keys(defs);
  for (let i = 0; i < ids.length; i++) {
    const weaponId = ids[i];
    if (!owned[weaponId] && !slotsFull) {
      candidates.push({ kind: 'new_weapon', weaponId, name: defs[weaponId].name, description: '新武器' });
    }
  }

  // 2) 牌候选（defs 表序 × 目录序；解锁前已满级武器不进候选——它已无成长空间）。
  for (let i = 0; i < ids.length; i++) {
    const weaponId = ids[i];
    const def = defs[weaponId];
    const ws = owned[weaponId];
    if (!def || !ws) {
      continue;
    }
    if (!unlocked && isWeaponMaxed(state, weaponId, defs)) {
      continue;
    }
    const cards = availableCards(def, ws, unlocked);
    for (let c = 0; c < cards.length; c++) {
      const card = cards[c];
      const currentCount = ws.cards[card.id] ?? 0;
      let maxLimit: number | undefined;
      if (unlocked) {
        if (card.hardMax !== undefined) {
          maxLimit = card.hardMax;
        }
      } else {
        if (card.maxCount !== undefined) {
          maxLimit = card.maxCount;
        } else if (card.hardMax !== undefined) {
          maxLimit = card.hardMax;
        }
      }

      // 文案两步：① 通用牌按武器动态生成（buildCardDescription；专属牌原样）；
      // ② 清洗只对没有 hardMax 的牌执行：hardMax 牌的上限在突破后依然真实存在；
      // ③ 有上限且可多次叠加的卡牌在选牌时呈现当前已选数量（已选/最大），唯一牌（once）不追加计数。
      const baseDesc = buildCardDescription(def, card);
      const cleanedDesc = unlocked && card.hardMax === undefined ? sanitizeUnlimitedCardDescription(baseDesc) : baseDesc;
      const desc = formatCardDescriptionWithLimit(cleanedDesc, currentCount, card.once ? undefined : maxLimit);
      candidates.push({
        kind: 'card',
        weaponId,
        cardId: card.id,
        name: `${def.name}·${card.name}`,
        description: desc,
        currentCount,
        maxCount: card.once ? undefined : maxLimit,
      });
    }
  }

  return pickWithoutReplacement(candidates, count, state.rng);
}

/**
 * 应用一个升级选项（三选一面板点选时调用）：
 * - new_weapon → addWeapon（0 级、空牌表、冷却 0；幂等）；
 * - card → 该武器 cards[cardId]++ 且 level+1（每张牌使武器 level+1；解锁后 level
 *   继续涨、>10 允许——上限门在 roll 侧：解锁前满级武器不进候选）。
 * 校验：card 选项要求武器已拥有；提供 defs 时再校验武器定义存在且 cardId 在其牌池内
 * （防脏选项写入非法牌），非法抛错。
 */
export function applyUpgrade(state: SimState, option: UpgradeOption, defs?: Record<string, WeaponDef>): void {
  if (option.kind === 'new_weapon') {
    addWeapon(state, option.weaponId);
    return;
  }

  const ws = state.weaponStates[option.weaponId];
  if (!ws) {
    throw new Error(`applyUpgrade: 武器未拥有，无法吃牌: ${option.weaponId}`);
  }
  if (defs) {
    const def = defs[option.weaponId];
    if (!def) {
      throw new Error(`applyUpgrade: 武器定义缺失: ${option.weaponId}`);
    }
    if (!def.cards.some((c) => c.id === option.cardId)) {
      throw new Error(`applyUpgrade: 牌 ${option.cardId} 不在武器 ${option.weaponId} 的牌池内`);
    }
  }
  ws.cards[option.cardId] = (ws.cards[option.cardId] ?? 0) + 1;
  ws.level += 1;
  // T5 stats 缓存失效键：牌表已改写 → 版本自增，getWeaponStats 下次调用按新牌表重建
  // （见 core/weapons.ts 文件头「stats 缓存契约」；绕过本函数改写 cards 的代码须同步自增）。
  ws.cardsVersion = (ws.cardsVersion ?? 0) + 1;
}

// —— 三选一重掷（Reroll）机制 ——

/** 每局固定初始重掷次数。 */
export const INITIAL_REROLLS = 2;

/** state.meta 中保存剩余重掷次数的键。 */
export const REROLLS_META_KEY = 'rerolls_remaining';

/** 获取当前局剩余的重掷次数。 */
export function getRerollsRemaining(state: SimState): number {
  const val = state.meta[REROLLS_META_KEY];
  return typeof val === 'number' && Number.isFinite(val) ? val : INITIAL_REROLLS;
}

/** 消耗一次重掷机会；成功返回 true，若无剩余次数返回 false。 */
export function consumeReroll(state: SimState): boolean {
  const current = getRerollsRemaining(state);
  if (current <= 0) {
    return false;
  }
  state.meta[REROLLS_META_KEY] = current - 1;
  return true;
}

/** 重置重掷次数为初始值（开局/重启时调用）。 */
export function resetRerolls(state: SimState): void {
  state.meta[REROLLS_META_KEY] = INITIAL_REROLLS;
}
