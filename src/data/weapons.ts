// src/data/weapons.ts —— 武器数据加载层：weapons/*.json + cards.json → WeaponDef 表。
// T5.3a：加载时把 cards.json 的通用牌按 applyTo 合并进每把武器的 def.cards（专属牌在前、
// 通用牌在后，目录序即牌池序）；requires 的 per-武器前置映射解析为 requiresCard。
// 类型从 core/cards、core/weapons 反向 import type（数据层依赖 core 的类型契约）；
// 数值契约：全部数值只存在于 weapons/*.json 与 cards.json，此处零硬编码。禁止 import phaser / DOM。

/// <reference types="vite/client" />
import type { WeaponCardDef } from '../core/cards';
import type { WeaponDef } from '../core/weapons';
import { loadCardDefs, type CardData } from './cards';

/** weapons/*.json 原始结构（cards 段仅含专属牌；通用牌由本模块合并）。 */
type WeaponDefRaw = Omit<WeaponDef, 'cards'> & { cards?: WeaponCardDef[] };

/** eager 收集全部武器定义文件（新增武器 json 零中心改动，自动进表）。 */
const modules = import.meta.glob('./weapons/*.json', { eager: true }) as Record<
  string,
  { default: WeaponDefRaw }
>;

/** 通用牌（cards.json）按 applyTo 分发给某把武器：解析前置映射为该武器的 requiresCard。 */
function genericCardsFor(weaponId: string, cards: CardData[]): WeaponCardDef[] {
  const out: WeaponCardDef[] = [];
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    if (!c.applyTo.includes('all') && !c.applyTo.includes(weaponId)) {
      continue;
    }
    out.push({
      id: c.id,
      name: c.name,
      description: c.description,
      params: c.params,
      kind: c.kind,
      value: c.value,
      maxCount: c.maxCount,
      once: c.once,
      excludes: c.excludes,
      requiresCard: c.requires ? (c.requires[weaponId] ?? null) : null,
    });
  }
  return out;
}

/**
 * 加载武器定义表：键为武器 id（即 weaponStates / addWeapon 用的 weaponId）。
 * def.cards = 专属牌（json 内 cards 段，保持表序）+ 适用通用牌（cards.json 表序）。
 * 返回外层新建映射（表内容为共享只读数据，调用方不得修改，改数值请改 JSON）。
 */
export function loadWeaponDefs(): Record<string, WeaponDef> {
  const generic = loadCardDefs();
  const defs: Record<string, WeaponDef> = {};
  const paths = Object.keys(modules).sort();
  for (let i = 0; i < paths.length; i++) {
    const raw = modules[paths[i]].default;
    defs[raw.id] = { ...raw, cards: [...(raw.cards ?? []), ...genericCardsFor(raw.id, generic)] };
  }
  return defs;
}
