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
import type { Rng, SimState } from './types';

/** 升级三选一的一个选项（视图层按 kind 分支渲染与点击应用；文案为面向玩家的中文）。 */
export type UpgradeOption =
  | { kind: 'new_weapon'; weaponId: string; name: string; description: string }
  | { kind: 'card'; weaponId: string; cardId: string; name: string; description: string };

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
 * 突破上限后卡牌描述清洗：
 * 剥除文案中包含的上限或叠下次限制说明（如“（可叠 4 次）”、“（上限 4 次）”、“（上限 2）”、“，上限4次”），
 * 避免误导玩家（实际在突破上限后已可无限刷新），同时保留正常语义（如“（可叠加）”）。
 */
export function sanitizeUnlimitedCardDescription(desc: string): string {
  let res = desc.replace(/[（(]\s*(?:可叠\s*\d+\s*次|上限\s*\d+\s*次?)\s*[）)]/g, '');
  res = res.replace(/[,，、]\s*上限\s*\d+\s*次?/g, '');
  return res.trim();
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
 * - card → name=`${def.name}·${card.name}`（如「轨道贯穿炮·伤害强化」）、description=牌表文案。
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
      // 文案清洗只对没有 hardMax 的牌执行：hardMax 牌的上限在突破后依然真实存在，
      // 描述中的两段上限说明（可叠 n 次 / 突破后上限 m 次）必须原样保留，否则误导玩家。
      const desc = unlocked && card.hardMax === undefined ? sanitizeUnlimitedCardDescription(card.description) : card.description;
      candidates.push({
        kind: 'card',
        weaponId,
        cardId: card.id,
        name: `${def.name}·${card.name}`,
        description: desc,
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
