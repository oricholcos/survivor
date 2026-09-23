// src/core/zones.ts —— 通用地面区域系统（毒圈/火圈/黏油等静态 AoE 区域的横切层）：
// 区域 = 位置 + 半径 + 时长 + tick 节奏；每 tick 对区域内敌人走统一伤害入口 dealDamage，
// 可选附着一个效果（effectKind → effects 注册表）。zone 参数（半径/伤害/时长等）由武器
// 行为从 WeaponStats（即 weapons/*.json）传参进来，本文件零硬编码数值。
//
// 时间语义（与 effects.ts 的 DoT tick 同款约定）：
// - 首跳在 spawn 后一个 tickMs（「tickMs 内的 step 只在到点结算」，不立即结算）；
// - 追补所有已到期的跳，但跳点不超过 durationMs（最后一跳恰落在到期当帧仍结算）；
// - elapsedMs >= durationMs 时区域移除（交换删除，O(1)）。
//
// 确定性契约：全程不用 rng；区域数组按 spawn 顺序遍历，敌人经 SpatialHash.queryCircle
// 返回（同一种子同插入序 → 同序）；性能契约：按帧 clear+重插的高频用法，tick 结算走网格。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM（ESLint 强制）。

import { applyEffect, dealDamage } from './effects';
import type { SpatialHash } from './spatialHash';
import type { Enemy, SimState } from './types';

/** 一个地面区域的静态参数（武器 JSON 传参；字段全拷贝进区域实例）。 */
export interface ZoneSpec {
  /** 圆心 x（px）。 */
  x: number;
  /** 圆心 y（px）。 */
  y: number;
  /** 半径（px；与敌人圆相交算在区域内，同弹丸命中语义）。 */
  radius: number;
  /** 存活时长 ms（到期移除；tick 点不超过该时长）。 */
  durationMs: number;
  /** 伤害结算间隔 ms（首跳在 spawn 后一个 tickMs）。 */
  tickMs: number;
  /** 每 tick 对区域内每个敌人的伤害（走 dealDamage 统一入口）。 */
  damagePerTick: number;
  /** 每 tick 附着到区域内存活敌人的效果种类名（effects 注册表键）；缺省不附着。 */
  effectKind?: string;
  /** 附着效果的数值参数（applyEffect 的 data，逐键深拷贝进效果实例）。 */
  effectData?: Record<string, number>;
  /** 渲染色（视图层用，模拟层不解释）。 */
  color?: number;
  /** 产生此区域的源武器 ID（伤害统计全口径归因溯源）。 */
  sourceWeaponId?: string;
}

/** meta.zones 存储的运行时条目：ZoneSpec 全字段拷贝 + 内部推进字段（视图层不解释）。 */
interface ZoneRuntime extends ZoneSpec {
  /** 内部：下一跳结算时刻（自 spawn 起算的相对 ms；首跳 = tickMs）。 */
  nextTickAt: number;
  /** 内部：自 spawn 起累计存活 ms（>= durationMs 时移除）。 */
  elapsedMs: number;
}

/** 读路径共享空数组（meta 尚无 zones 时返回；调用方不得改写）。 */
const EMPTY_ZONES: ZoneSpec[] = [];

/** 取区域数组（读路径：不存在返回 undefined，绝不创建）。 */
function peekZones(state: SimState): ZoneRuntime[] | undefined {
  return state.meta.zones as ZoneRuntime[] | undefined;
}

/** 取区域数组（写路径：模块级懒初始化，首次 spawn 时才在 state.meta 上建数组）。 */
function zonesOf(state: SimState): ZoneRuntime[] {
  let zones = peekZones(state);
  if (!zones) {
    zones = [];
    state.meta.zones = zones;
  }
  return zones;
}

/**
 * 在 state.meta.zones（懒初始化数组）追加一个区域：spec 字段全拷贝
 * （effectData 逐键浅拷贝），区域不持有调用方对象引用；调用后改写 spec 不影响区域。
 * 首跳在 spawn 后一个 tickMs。
 */
export function spawnZone(state: SimState, spec: ZoneSpec): void {
  zonesOf(state).push({
    x: spec.x,
    y: spec.y,
    radius: spec.radius,
    durationMs: spec.durationMs,
    tickMs: spec.tickMs,
    damagePerTick: spec.damagePerTick,
    effectKind: spec.effectKind,
    effectData: spec.effectData ? { ...spec.effectData } : undefined,
    color: spec.color,
    sourceWeaponId: spec.sourceWeaponId,
    nextTickAt: spec.tickMs,
    elapsedMs: 0,
  });
}

const scratchZoneHits: Enemy[] = [];

/** 单次 tick 结算：对区域内（圆相交，同弹丸命中语义）敌人逐个结算；数组序固定（确定性）。 */
function settleTick(state: SimState, zone: ZoneRuntime, grid: SpatialHash<Enemy>): void {
  const hits = grid.queryCircle(zone.x, zone.y, zone.radius, scratchZoneHits);
  for (let h = 0; h < hits.length; h++) {
    const enemy = hits[h];
    if (enemy.dead) {
      continue; // 本帧已被其他系统击杀：跳过（网格由调用方重建，可能残留已死敌人）
    }
    // 统一伤害入口（受伤乘区 mark/corrode、击杀事件与 killHooks 均由其结算）。
    dealDamage(state, enemy, zone.damagePerTick, zone.sourceWeaponId);
    // 效果附着：致死一击不再附着（尸体无意义，与弹丸命中同款语义）。
    if (zone.effectKind !== undefined && !enemy.dead) {
      applyEffect(state, enemy, zone.effectKind, zone.effectData, zone.sourceWeaponId);
    }
  }
}

/**
 * 推进一帧区域系统（由引导层注册进 hooks：效果 tick 之后、墙战之前）：
 * - 每区域 elapsedMs += dtMs，追补所有已到期且不超过 durationMs 的跳（每跳对区域内敌人
 *   dealDamage + 可选 applyEffect）；脏数据（tickMs <= 0 / 非有限）每帧至多结算一跳，防死循环；
 * - elapsedMs >= durationMs → 移除（交换删除，O(1)）；被换入者当帧继续处理；
 * - 遍历顺序固定（区域数组序 × 网格查询序），全程不用 rng。
 * state.over 非 null（模拟已结束）时直接 return（与 enemies/wall 同款防重入）；
 * meta 无区域时零开销返回（不懒创建数组）。
 */
export function updateZones(state: SimState, dtMs: number, grid: SpatialHash<Enemy>): void {
  if (state.over !== null) {
    return;
  }
  const zones = peekZones(state);
  if (!zones || zones.length === 0) {
    return;
  }

  for (let i = 0; i < zones.length; ) {
    const zone = zones[i];
    zone.elapsedMs += dtMs;

    // 周期结算：追补所有已到期的跳（跳点不超过 durationMs——最后一跳恰落在到期当帧仍结算，
    // 与 effects.ts 的 burn「next <= untilMs」同款语义）。脏 tickMs 每帧至多一跳防死循环。
    while (zone.nextTickAt <= zone.elapsedMs && zone.nextTickAt <= zone.durationMs) {
      settleTick(state, zone, grid);
      zone.nextTickAt += zone.tickMs;
      if (!(zone.tickMs > 0 && Number.isFinite(zone.nextTickAt))) {
        break;
      }
    }

    // 到期移除（交换删除：末元素换到当前位继续处理）。
    if (zone.elapsedMs >= zone.durationMs) {
      const last = zones.pop()!;
      if (i < zones.length) {
        zones[i] = last;
      }
      continue;
    }
    i++;
  }
}

/**
 * 当前全部存活区域（供视图渲染 M4）：返回内部数组（或共享空数组）的只读引用，
 * 调用方不得增删/改写元素；运行时字段 nextTickAt / elapsedMs 会被一并带出，视图层不解释。
 */
export function listZones(state: SimState): ZoneSpec[] {
  return peekZones(state) ?? EMPTY_ZONES;
}
