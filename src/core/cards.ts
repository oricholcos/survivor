// src/core/cards.ts —— 武器牌池系统（T5.3a）：牌数据契约 + 牌计数/上限/解锁判定 + 数值生效。
// 设计（用户拍板）：废除「武器等级+1」覆盖式数值成长，改为牌池制——
// - 武器初始 0 级、最高 10 级：level = 该武器已吃的牌数（0~10），每张牌（通用或专属）level+1；
// - 数值/机制成长全部来自牌：通用牌（src/data/cards.json，绑定到已拥有武器出现）与
//   武器专属牌（src/data/weapons/*.json 的 cards 段，数据层加载时合并进 def.cards）；
// - 全部效果数值/上限/参数在 JSON，core 只定义结构与解释规则（零硬编码数值）。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM；禁 Math.random（本模块无随机）。

import type { SimState } from './types';

/**
 * 牌参数注入条目：把牌的效果写进 WeaponStats（键 = stats 最终键名，零间接映射）。
 * op 语义（按牌的持有张数 count 迭代应用 count 次）：
 * - 'set'：stats[key] = value（幂等：重复应用不变，适合布尔开关/固定参数）；
 * - 'add'：stats[key] += value（可叠数值：每张 +value）；
 * - 'mul'：stats[key] *= value（乘区叠乘：每张 ×value）；
 * - 'div'：stats[key] /= value（除区叠乘：每张 ÷value）。
 */
export interface CardParam {
  key: string;
  value: number;
  op: 'set' | 'add' | 'mul' | 'div';
}

/**
 * 牌定义（进牌池的最小单位）。通用牌与专属牌共用本结构：
 * - 专属牌直接写在 weapons/*.json 的 cards 段；
 * - 通用牌写在 cards.json（带 applyTo 适用武器集合），由 src/data/weapons.ts 加载时
 *   按 applyTo 合并进每把武器的 def.cards（requires 的 per-weapon 映射解析为 requiresCard）。
 */
export interface WeaponCardDef {
  id: string;
  /** 牌名（不含武器名；选项文案由 upgrade.ts 拼成「武器名·牌名」）。 */
  name: string;
  /** 面向玩家的中文效果描述（UI 直接渲染）。 */
  description: string;
  /** stats 参数注入（与 kind 互斥使用：有 params 的牌按参数注入，kind 牌走专用解释）。 */
  params?: CardParam[];
  /** 专用效果 kind：range_mult = 对 def.rangeKeys 逐键 ×value^count；dot_freq = 附着 dot 跳隔 ÷value^count（dotTickMultiplier 消费，不写 stats）。 */
  kind?: 'range_mult' | 'dot_freq';
  /** kind 乘区值（range_mult/dot_freq 用）。 */
  value?: number;
  /** 解锁（集满 4 把全 10 级）前可持有上限；缺省 = 无上限（受 10 级总量自然约束）。 */
  maxCount?: number;
  /** 硬上限：无论解锁前后，持有张数达到 hardMax 即从牌池移除（与 maxCount 的语义区别：
   *  maxCount 只在解锁前生效、突破后失效；hardMax 永远生效，防无限牌池下乘区/弹量失控）。 */
  hardMax?: number;
  /** 纯布尔一次性牌：true = 拿到一张后从牌池移除（解锁前后一致，重复拿无意义）。 */
  once?: boolean;
  /** 互斥：持有本牌（count>0）期间，从该武器牌池移除列出的牌 id（质变牌隔离通用成长牌用）。 */
  excludes?: string[];
  /** 前置牌 id：该武器已持有 ≥1 张 requiresCard 才进牌池（如 dot 频率需先拿对应附着牌；null = 无前置）。 */
  requiresCard?: string | null;
}

/** 武器默认等级上限（T5.3a 牌池制约定：10 级封顶）。 */
export const MAX_WEAPON_LEVEL = 10;

/** 读取某武器已持有的某张牌张数（未拥有武器/未持有 → 0）。 */
export function getCardCount(state: SimState, weaponId: string, cardId: string): number {
  return state.weaponStates[weaponId]?.cards[cardId] ?? 0;
}

/** 武器是否满级（level >= maxLevel；数据表缺该武器 → 不视为满级）。 */
export function isWeaponMaxed(state: SimState, weaponId: string, defs: Record<string, { maxLevel?: number }>): boolean {
  const def = defs[weaponId];
  if (!def) {
    return false;
  }
  const max = typeof def.maxLevel === 'number' ? def.maxLevel : MAX_WEAPON_LEVEL;
  return state.weaponStates[weaponId].level >= max;
}

/**
 * 无限牌池解锁判定（用户拍板）：拥有武器数 ≥ config.maxWeaponSlots 且【全部】达到 maxLevel。
 * 解锁后所有数量上限失效（once 布尔牌仍拿一次即移除；hardMax 硬上限例外，永远生效）；
 * 武器栏上限不变。
 */
export function allMaxedUnlocked(state: SimState, defs: Record<string, { maxLevel?: number }>): boolean {
  const owned = Object.keys(state.weaponStates);
  if (owned.length < state.config.maxWeaponSlots) {
    return false;
  }
  for (let i = 0; i < owned.length; i++) {
    if (!isWeaponMaxed(state, owned[i], defs)) {
      return false;
    }
  }
  return true;
}

/**
 * 某武器当前的可用牌池（def.cards 目录序，确定性）：逐张按
 * ① once/split_shot 已持有 → 移除（解锁前后一致）；② 解锁前 maxCount 达上限 → 移除；
 * ③ hardMax 硬上限达上限 → 移除（解锁前后一致，与 maxCount 的区别：不随无限牌池解锁失效）；
 * ④ requiresCard 前置未满足 → 移除；⑤ 被已持有牌的 excludes 互斥 → 移除。
 * 「未满级武器才有牌」的门由 upgrade.ts 的 isWeaponMaxed 把守（本函数纯牌级规则）。
 */
export function availableCards(def: { cards: WeaponCardDef[] }, ws: { cards: Record<string, number> }, unlocked: boolean): WeaponCardDef[] {
  const held = ws.cards;

  // 已持有牌的互斥并集：任一持有牌 excludes 的牌 id 全部移出池。
  const excluded = new Set<string>();
  for (const id in held) {
    if (held[id] <= 0) {
      continue;
    }
    const card = def.cards.find((c) => c.id === id);
    if (card?.excludes) {
      for (const e of card.excludes) {
        excluded.add(e);
      }
    }
  }

  const out: WeaponCardDef[] = [];
  for (let i = 0; i < def.cards.length; i++) {
    const card = def.cards[i];
    const count = held[card.id] ?? 0;
    if ((card.once || card.id === 'split_shot') && count > 0) {
      continue; // 布尔机制牌与分裂牌：拿到一次即从池移除（解锁前后一致，分裂不重复叠加）
    }
    if (!unlocked && card.maxCount !== undefined && count >= card.maxCount) {
      continue; // 解锁前：达数量上限（解锁后上限全失效）
    }
    if (card.hardMax !== undefined && count >= card.hardMax) {
      continue; // 硬上限：达 hardMax 即移除（解锁前后一致——maxCount 突破后失效，hardMax 永远生效）
    }
    if (card.requiresCard && (held[card.requiresCard] ?? 0) <= 0) {
      continue; // 前置未满足（前置条件解锁后仍生效）
    }
    if (excluded.has(card.id)) {
      continue; // 被已持有牌互斥（excludes 机制）
    }
    out.push(card);
  }
  return out;
}


/**
 * 由武器定义 + 武器状态（牌表）解析出 WeaponStats：base 拷贝 → 按 def.cards 目录序逐牌
 * 应用 count 次效果（params 注入 / range_mult 乘 def.rangeKeys / dot_freq 不写 stats）。
 * 目录序（而非 cards 键序）保证浮点结果与牌的获取顺序无关（确定性）；返回全新对象不改 def。
 */
export function buildWeaponStats(
  def: { base: Record<string, number>; rangeKeys: string[]; cards: WeaponCardDef[] },
  ws: { cards: Record<string, number> } | null | undefined,
): Record<string, number> {
  const stats: Record<string, number> = { ...def.base };
  const held = ws?.cards;
  if (!held) {
    return stats; // 无武器状态（如 ghost 条目）：纯 base
  }
  for (let i = 0; i < def.cards.length; i++) {
    const card = def.cards[i];
    const count = held[card.id] ?? 0;
    if (count <= 0) {
      continue;
    }
    if (card.params) {
      for (let pIdx = 0; pIdx < card.params.length; pIdx++) {
        const p = card.params[pIdx];
        if (p.op === 'set') {
          stats[p.key] = p.value;
        } else if (p.op === 'add') {
          stats[p.key] = (stats[p.key] ?? 0) + p.value * count;
        } else if (p.op === 'mul') {
          stats[p.key] = (stats[p.key] ?? 0) * Math.pow(p.value, count);
        } else {
          stats[p.key] = (stats[p.key] ?? 0) / Math.pow(p.value, count);
        }
      }
    }
    if (card.kind === 'range_mult' && typeof card.value === 'number') {
      const factor = Math.pow(card.value, count);
      for (let k = 0; k < def.rangeKeys.length; k++) {
        const key = def.rangeKeys[k];
        stats[key] = (stats[key] ?? 0) * factor;
      }
    }
    if (card.kind === 'dot_freq' && typeof card.value === 'number') {
      // T5.3b 接线：dot 频率把 value^count 注入 stats.dotTickMult——行为在「附着点」消费
      // （敌附 DoT 经 effect.data.tickMs 逐实例覆盖 tick 间隔、地面 zone 直接把 spawnZone 的
      // tickMs ÷ 本值）。行为拿不到 defs 表，故经 stats 传递而非 dotTickMultiplier(defs 版)。
      stats.dotTickMult = Math.pow(card.value, count);
    }
  }
  return stats;
}

/**
 * dot 频率乘区助手（T5.3a 只做助手+单测，行为接线在下一任务）：
 * 该武器 dot_freq 牌的 value^count（无牌/数据表缺武器 → 1）。消费约定：该武器附着
 * 持续伤害效果时，效果实例的 tick 间隔 ÷ 本值（如燃烧云、燃烧地、冰毒等）。
 */
export function dotTickMultiplier(
  state: SimState,
  weaponId: string,
  defs: Record<string, { base: Record<string, number>; rangeKeys: string[]; cards: WeaponCardDef[] }>,
): number {
  const def = defs[weaponId];
  const held = state.weaponStates[weaponId]?.cards;
  if (!def || !held) {
    return 1;
  }
  const card = def.cards.find((c) => c.kind === 'dot_freq');
  if (!card || typeof card.value !== 'number') {
    return 1;
  }
  return Math.pow(card.value, held[card.id] ?? 0);
}

// —— 连射波调度（T5.3b 弹道机制接线，burst_shot 通用牌的消费端） ——
// 语义（锁定，与任务书一致）：
// - burst_shot 每张给 stats.burstWaves +1（add 乘区，无牌时键缺失按 0）——语义为「跟发波数」：
//   首波开火时即时发射，其后 burstWaves 波按 stats.burstIntervalMs（=150，表值）逐波延迟跟发；
//   「开火后跟发 1 波完整齐射」（cards.json 牌描述，逐武器文案由 upgrade.ts 生成）即
//   1 张牌 = 1 个跟发波（重放 = 完整 projectileCount 的一波，非每颗弹体各跟一发）。
// - 实现为 meta 待发波队列：fire 发完首波后调 scheduleBurstWaves 把跟发波（各带开火时刻的
//   stats 快照）入队；各行为的 update 钩子每帧调 consumeDueBurstWaves，到期波以
//   「重新执行 fire 的目标选择与散射逻辑」重放（快照 stats + 重放时重新选目标——锁定语义，
//   手感自然；无目标时该波静默跳过、不改武器冷却）。
// - 与多射联动：重放走同一 fireVolley，每波都是完整 projectileCount 颗。
// - 不吃多射/连射的次级弹（分裂）不经本队列：分裂由行为钩子直接 spawn。
// - 到期追补：一次 update 消费所有 dueAtMs <= 当前时刻的波（长帧追赶，与 effects/zones 同款）。
// - 队列条目按 weaponId+behavior 认领（同一行为可服务多把武器：重放按条目自带的 weaponId
//   与 stats 快照执行，互不串扰）；队列整体存于单一 meta 键（FIFO、条目量 = 未到期波数，有界）。

/** 连射待发波队列的 meta 键（state.meta 共享单键，值为 BurstWaveEntry[] FIFO）。 */
export const BURST_QUEUE_META_KEY = 'burst_wave_queue';

/** 待发波条目：所属武器/行为、到期时刻、开火时的 stats 快照（重放按快照结算）。 */
export interface BurstWaveEntry {
  weaponId: string;
  behavior: string;
  /** 到期时刻（state.timeMs 时间轴绝对值）。 */
  dueAtMs: number;
  /** 开火时刻的 stats 快照（浅拷贝）：重放波按发射时数值结算，升级只影响下一发。 */
  stats: Record<string, number>;
}

/** 读 stats 可选数值键（索引签名对缺失键返回 undefined）：显式兜底为 0。 */
function statOr0(stats: Record<string, number>, key: string): number {
  const v = stats[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * fire 发完首波后调用：按 stats.burstWaves（跟发波数）把后续波入 meta 队列，第 k 波到期时刻
 * = 当前时刻 + k × stats.burstIntervalMs。无牌（burstWaves <= 0）/ 脏波间隔
 * （<= 0 或非有限）→ 不排波。每波条目各持一份 stats 快照（浅拷贝）。
 */
export function scheduleBurstWaves(
  state: SimState,
  weaponId: string,
  behavior: string,
  stats: Record<string, number>,
): void {
  const waves = Math.round(statOr0(stats, 'burstWaves'));
  if (waves <= 0) {
    return;
  }
  const interval = statOr0(stats, 'burstIntervalMs');
  if (!(interval > 0)) {
    return; // 脏波间隔：不排波（防除零/永不到期条目堆积）
  }
  let queue = state.meta[BURST_QUEUE_META_KEY] as BurstWaveEntry[] | undefined;
  if (!queue) {
    queue = [];
    state.meta[BURST_QUEUE_META_KEY] = queue;
  }
  for (let k = 1; k <= waves; k++) {
    queue.push({ weaponId, behavior, dueAtMs: state.timeMs + interval * k, stats: { ...stats } });
  }
}

/**
 * 行为 update 钩子每帧调用：消费该行为名下全部到期波（dueAtMs <= 当前时刻，FIFO 序逐波
 * replay(weaponId, stats)——重放 = 重新执行 fire 的目标选择与散射逻辑，见上「语义（锁定）」）。
 * 无目标的波由 replay 内部静默跳过（不改武器冷却）。消费后原地压实队列（保序、零重分配）。
 * state.over 非 null（模拟已结束）时直接 return（与各系统同款防重入）。
 */
export function consumeDueBurstWaves<S extends Record<string, number>>(
  state: SimState,
  behavior: string,
  replay: (weaponId: string, stats: S) => void,
): void {
  if (state.over !== null) {
    return;
  }
  const queue = state.meta[BURST_QUEUE_META_KEY] as BurstWaveEntry[] | undefined;
  if (!queue || queue.length === 0) {
    return;
  }
  const now = state.timeMs;
  let kept = 0;
  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    if (entry.behavior === behavior && entry.dueAtMs <= now) {
      replay(entry.weaponId, entry.stats as S);
      continue; // 已消费：压实跳过
    }
    queue[kept++] = entry;
  }
  queue.length = kept;
}
