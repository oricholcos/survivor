// src/core/behaviors/registry.ts —— 武器行为注册表。
// 行为分支 = 「怎么发射一波」的策略对象：解释器（core/weapons.ts 的 updateWeapons）
// 在冷却到点时按 def.behavior 名分发。注册表模块级单例；同名后注册者胜，便于测试注入覆盖。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM。

import type { Enemy, Projectile, SimState } from '../types';
import type { WeaponStats } from '../weapons';

/** 武器行为分支：fire = 发射一波（可能发射 0 枚，如无目标时）；可选生命周期钩子见各字段注释。 */
export interface WeaponBehavior {
  name: string;
  /** 发射一波。stats 为解析后的武器数值；weaponId 供行为回写 weaponStates（如无目标归 0 冷却）。 */
  fire(state: SimState, weaponId: string, stats: WeaponStats): void;
  /**
   * 每帧行为更新（可选）：updateWeapons 在冷却判定之前调用，仅当某把已拥有武器指向该行为
   * （数据表缺该武器 def 时跳过）。适合轨道弹旋转、召唤物跟随等逐帧持续逻辑。
   */
  update?(state: SimState, dtMs: number): void;
  /**
   * 弹丸命中钩子（可选）：单次命中结算完（dealDamage + effectsOnHit 附着之后、穿透消耗之前）
   * 调用。钩子可把 proj.dead 置 true（如命中即爆）：此后本帧不再结算剩余命中候选、穿透不再
   * 消耗，弹走死亡路径（onProjectileDeath 恰好一次 → 回池）。
   */
  onProjectileHit?(state: SimState, proj: Projectile, enemy: Enemy): void;
  /**
   * 弹丸死亡钩子（可选）：弹死亡（ttl 耗尽或穿透用尽，两条路径都恰好触发一次）、release 回池
   * 之前调用（此刻 proj 字段仍为死亡时刻值，未被池 reset 清洗）。适合落地爆炸、死亡留地面
   * 区域（zones.spawnZone）等。
   */
  onProjectileDeath?(state: SimState, proj: Projectile): void;
}

const registry = new Map<string, WeaponBehavior>();

/** 注册行为（同名后注册者胜）。 */
export function registerBehavior(b: WeaponBehavior): void {
  registry.set(b.name, b);
}

/** 取行为；未注册抛错（数据表 behavior 名拼错时尽早暴露，而不是静默哑火）。 */
export function getBehavior(name: string): WeaponBehavior {
  const b = registry.get(name);
  if (!b) {
    throw new Error(`getBehavior: 未注册的武器行为 "${name}"`);
  }
  return b;
}

/** 已注册行为名列表（升序输出，便于测试与调试）。 */
export function listBehaviors(): string[] {
  return [...registry.keys()].sort();
}
