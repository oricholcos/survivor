// src/data/cards.ts —— 通用牌表加载层：cards.json → CardData[]。
// 表 A（通用牌）定义适用武器集合（applyTo）与 per-武器前置（requires）；数据层不解析效果，
// 只按 applyTo 把通用牌分发进各武器的 def.cards（见 src/data/weapons.ts 的合并）。
// 类型从 core/cards 反向 import type（数据层依赖 core 的类型契约）；
// 数值契约：全部数值只存在于 cards.json，此处零硬编码。禁止 import phaser / DOM。

import type { WeaponCardDef } from '../core/cards';
import cardsJson from './cards.json';

/** cards.json 原始条目（通用牌）：applyTo / requires 是数据层分发字段，加载时按武器解析。 */
export interface CardData {
  id: string;
  name: string;
  description: string;
  /** stats 参数注入（与 kind 互斥，见 core/cards 的 CardParam）。 */
  params?: WeaponCardDef['params'];
  /** 专用效果 kind（range_mult / dot_freq）。 */
  kind?: WeaponCardDef['kind'];
  /** kind 乘区值。 */
  value?: number;
  /** 适用武器集合：['all'] = 全部武器，否则为武器 id 白名单。 */
  applyTo: string[];
  /** 解锁前可持有上限；缺省 = 无上限。 */
  maxCount?: number;
  /** 纯布尔一次性牌：拿到一张后从牌池移除。 */
  once?: boolean;
  /** 互斥：持有本牌期间从该武器牌池移除的牌 id。 */
  excludes?: string[];
  /** per-武器前置牌映射：weaponId → 前置牌 id（不在表内的武器无前置，如龙息天然可用 dot频率）。 */
  requires?: Record<string, string>;
}

/**
 * 加载通用牌表（表 A）。返回逐项浅拷贝的新数组（表内容为共享只读数据，
 * 调用方不得修改，改数值请改 cards.json）。
 * 断言说明：resolveJsonModule 对 JSON 里的 op 推断为宽 string，这里收窄为 CardData 的
 * 字面量联合（数据契约由 cards.json 与 CardData 类型共同锁定，加载时不做运行时校验）。
 */
export function loadCardDefs(): CardData[] {
  return (cardsJson as unknown as CardData[]).map((c) => ({ ...c }));
}
