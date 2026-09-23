// src/core/weapons.ts —— 武器定义类型 + 牌池数值解析 + 解释器（冷却节奏与行为分发）。
// 武器即数据：WeaponDef（src/data/weapons/*.json + cards.json 合并）→ getWeaponStats 解析
// 牌乘区/开关 → updateWeapons 按冷却节奏分发到 getBehavior(def.behavior).fire。
// T5.3a：废除「武器等级+1」覆盖式 levels 数值成长——武器初始 0 级、每吃一张牌 level+1
// （0~10 级封顶，解锁后可 >10），全部数值/机制成长由牌注入（见 core/cards.ts）。
// T5 热路径微优化：getWeaponStats 按牌表版本缓存（见下「stats 缓存契约」）。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM。
// 随机契约：本文件不使用 rng；散布等随机由各行为分支经 state.rng 自行实现。
//
// stats 缓存契约（T5，锁定）：
// - 缓存存 state.meta 单键 weapon_stats_cache（weaponId → { version, cardsRef, stats }）；
//   命中条件 = ws.cardsVersion 相同【且】ws.cards 对象引用相同——双保险：version 自增覆盖
//   applyUpgrade 的原地改写，cardsRef 比对覆盖「整体替换 ws / 替换 cards 对象」的路径。
// - 失效责任：牌表唯一合法改写入口是 applyUpgrade（自增 cardsVersion）；绕过它直接改写
//   ws.cards 的代码（如测试夹具）必须同步自增 ws.cardsVersion，否则拿到过期 stats。
// - 返回对象被同版本多次调用共享（零分配）：所有消费方（8 个行为 fire/update、视图层
//   mainScene、scheduleBurstWaves 的快照浅拷贝）均【只读】stats，禁止改写返回对象——
//   改写会跨帧污染缓存（已全量审计，见 T5 汇报）。
// - weaponStates 缺条目（ghost）路径不缓存：保持 buildWeaponStats 纯 base 现状。
// - 确定性：缓存只影响对象身份与分配次数，不影响任何数值（同输入同输出）；restart 新建
//   state → meta 为空 → 缓存随局重建，不跨局泄漏。

import './behaviors/index'; // 副作用 import：触发 behavior_*.ts 自动发现与注册（新增行为零中心改动）
import { getBehavior } from './behaviors/registry';
import { pushSfxThrottled, SFX_PUSH_MIN_INTERVAL_MS } from './events';
import { overheatFactor } from './effects';
import { buildWeaponStats } from './cards';
import type { WeaponCardDef } from './cards';
import type { SimState, WeaponState } from './types';

/** 解析后的武器数值：固定五项 + 各武器自定义数值键 + 牌注入的开关/参数键（值一律为 number）。 */
export interface WeaponStats {
  damage: number;
  intervalMs: number;
  projectileSpeed: number;
  pierce: number;
  ttlMs: number;
  [key: string]: number;
}

/** 武器定义（src/data/weapons/*.json 结构 + cards.json 合并后的牌池）。 */
export interface WeaponDef {
  id: string;
  name: string;
  /** 解释器行为分支名（behaviors 注册表键，如 'piercing_bolt'）。 */
  behavior: string;
  /** 满级牌数（= 该武器最多吃的牌数；T5.3a 全表统一 10）。 */
  maxLevel: number;
  /** 0 级基础数值（含自定义数值键；牌的乘区/开关在其上叠加）。 */
  base: WeaponStats;
  /** 该武器的「范围参数」键（范围强化牌按此逐键 ×1.2^count；数据驱动，不硬编码武器清单）。 */
  rangeKeys: string[];
  /** 该武器的牌池（专属牌 + 数据层按 applyTo 合并进来的通用牌），目录序即池序。 */
  cards: WeaponCardDef[];
}

/** stats 缓存的 meta 单键（state.meta 共享，值 = Record<weaponId, WeaponStatsCacheEntry>）。 */
export const WEAPON_STATS_CACHE_META_KEY = 'weapon_stats_cache';

/** stats 缓存条目：version = 构建时的 ws.cardsVersion、cardsRef = 构建时的 ws.cards 引用。 */
interface WeaponStatsCacheEntry {
  version: number;
  cardsRef: Record<string, number>;
  stats: WeaponStats;
}

/**
 * 解析某武器的当前数值：委托 buildWeaponStats（base × 牌乘区 × 牌开关，见 core/cards.ts）。
 * T5 热路径缓存：同武器同牌表版本（ws.cardsVersion 相同且 ws.cards 引用相同）直接返回
 * 缓存对象（零分配、跨调用共享同一引用——消费方必须只读，见文件头「stats 缓存契约」）；
 * 版本不匹配（applyUpgrade 吃牌）时重建并写缓存。weaponStates 缺该武器条目（ghost）时
 * 返回纯 base 全新对象，不缓存（保持既有行为）。
 */
export function getWeaponStats(def: WeaponDef, state: SimState, weaponId: string): WeaponStats {
  const ws = state.weaponStates[weaponId];
  if (!ws) {
    return buildWeaponStats(def, undefined) as WeaponStats; // ghost：纯 base，不缓存
  }
  let cache = state.meta[WEAPON_STATS_CACHE_META_KEY] as Record<string, WeaponStatsCacheEntry> | undefined;
  if (!cache) {
    cache = {};
    state.meta[WEAPON_STATS_CACHE_META_KEY] = cache;
  }
  const cached = cache[weaponId];
  const version = ws.cardsVersion ?? 0;
  if (cached && cached.version === version && cached.cardsRef === ws.cards) {
    return cached.stats;
  }
  const stats = buildWeaponStats(def, ws) as WeaponStats;
  cache[weaponId] = { version, cardsRef: ws.cards, stats };
  return stats;
}

/**
 * 给角色添加武器：weaponStates[weaponId] = { level: 0, cooldownMs: 0, cards: {}, cardsVersion: 0 }。
 * T5.3a：武器 0 级起步（level = 已吃牌数），刚获得时无任何牌、以 base 数值作战。
 * T5：cardsVersion = stats 缓存失效键（见文件头「stats 缓存契约」）；新条目版本 0 与
 * 空牌表一致，无需预热缓存（首次 getWeaponStats 未命中时按空表构建）。
 * 幂等：已存在则原样保留（不覆盖等级/冷却/牌表/版本号）。
 */
export function addWeapon(state: SimState, weaponId: string): void {
  if (state.weaponStates[weaponId]) {
    return;
  }
  const ws: WeaponState = { level: 0, cooldownMs: 0, cards: {}, cardsVersion: 0, damageDealt: 0 };
  state.weaponStates[weaponId] = ws;
}

/**
 * 推进一帧武器系统：对 weaponStates 里每把武器（按 keys 顺序，确定性）：
 * 0) 数据表存在该武器 def → 先调 getBehavior(def.behavior).update?.(state, dtMs)（每帧行为
 *    更新钩子，在冷却扣减与开火判定之前；def 缺失跳过该钩子，冷却仍照常扣减）；
 * 1) cooldownMs -= dtMs；
 * 2) 数据表缺该武器 id → 跳过该武器（不抛错；冷却已照常扣减，恢复注册后自然追赶）；
 * 3) 冷却 <= 0 → stats = getWeaponStats(def, state, weaponId)（牌乘区/开关已含在内），
 *    getBehavior(def.behavior).fire(...)，然后 cooldownMs += stats.intervalMs；
 *    若加完仍 <= 0 继续开火（长 dt 追补语义），循环至 cooldownMs > 0。
 *    fire 可改写 cooldownMs（如无目标归 0），以其改写后值为累加基准。
 * state.over 非 null（模拟已结束）时直接 return（与 enemies/wall 同款防重入）。
 */
export function updateWeapons(state: SimState, dtMs: number, defs: Record<string, WeaponDef>): void {
  if (state.over !== null) {
    return;
  }

  const states = state.weaponStates;
  const ids = Object.keys(states);
  for (let i = 0; i < ids.length; i++) {
    const weaponId = ids[i];
    const def = defs[weaponId];

    // 每帧行为更新钩子：仅当该武器已拥有（weaponStates 有条目）且数据表存在 def 时调用，
    // 先于冷却扣减与开火判定。行为未注册 → 抛错（与 fire 分发路径同款尽早暴露约定）。
    if (def) {
      getBehavior(def.behavior).update?.(state, dtMs);
    }

    const ws = states[weaponId];
    ws.cooldownMs -= dtMs;

    if (!def) {
      continue; // 数据表缺该武器：跳过，不抛错。
    }

    // 冷却到点开火 + 追加间隔。正常数据（间隔为正且有限）循环必然终止；脏数据
    // （间隔非正 / 冷却被推成非有限）下冷却无法前进到正数，限制为每帧至多开火一次
    // 并跳出，防死循环（与 wall.ts 同款约定）。
    let fireCount = 0;
    while (ws.cooldownMs <= 0 && fireCount < 20) {
      fireCount++;
      const stats = getWeaponStats(def, state, weaponId);
      // 音效事件（T4.1）：仅真实开火 push 一次 shoot（每波一次）。
      // 空转判定用文档契约「fire 可改写 cooldownMs（如无目标归 0）」：全部带目标判定的
      // 行为在无目标时把 cooldownMs 改写归 0，真实开火不改写——据此前后快照区分，
      // 不改变任何模拟行为。推送经 pushSfxThrottled 按模拟时间粗滤（30ms 内同名只留
      // 首个），只影响 sfx 事件流密度、不影响开火与模拟结算；播放端节流器仍做细合并。
      const cooldownBeforeFire = ws.cooldownMs;
      getBehavior(def.behavior).fire(state, weaponId, stats);
      if (!(ws.cooldownMs === 0 && cooldownBeforeFire !== 0)) {
        pushSfxThrottled(state, 'shoot', SFX_PUSH_MIN_INTERVAL_MS);
      }
      // 效果槽消费：过热（overheat）惩罚乘区——开火间隔拉长（data 可逐实例覆盖定义值）。
      // 下限 16ms（防极高攻速无限牌池把间隔除到 ~0 导致单帧几千亿次循环爆掉执行时）。
      const intervalMs = Math.max(16, stats.intervalMs * overheatFactor(ws));
      ws.cooldownMs += intervalMs;

      if (ws.cooldownMs <= 0 && !(intervalMs > 0 && Number.isFinite(ws.cooldownMs))) {
        break;
      }
    }
    if (ws.cooldownMs <= 0) {
      ws.cooldownMs = 16;
    }
  }
}
