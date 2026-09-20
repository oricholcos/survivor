// src/core/simState.ts —— SimState 工厂。
// 随机解耦：本模块不 import rng.ts，而是通过模块级可替换工厂注入 RNG；
// 默认用自包含的最简确定性实现（LCG）保证测试可复现，引导层用
// setRngFactory(createRng) 替换为 rng.ts 的 mulberry32。纯 TypeScript，禁止 phaser / DOM。

import type { Layout, Rng, SimConfig, SimState } from './types';

/** 默认布局（测试用缺省；正式数值后续来自 JSON，由引导层注入）。 */
const DEFAULT_LAYOUT: Layout = { width: 720, height: 1280, wallLineY: 1160, spawnLineY: -40 };

/** 默认配置（测试用缺省；正式数值后续来自 JSON，由引导层注入）。 */
const DEFAULT_CONFIG: SimConfig = {
  xpBase: 5,
  xpTier1Step: 4,
  xpTier2Step: 8,
  gemFlySpeed: 600,
  dropFlySpeed: 600,
  repairDropChance: 0.02,
  repairHeal: 30,
  wallMaxHp: 1600,
  maxWeaponSlots: 4,
  // 全局实体数量护栏（T3 性能封顶）：与 src/data/config.json 同值——远高于正常对局
  // 并发峰值（campaign 峰值 ≈70 敌 / ≈100 弹），只在无尽后期死亡螺旋时封顶。
  maxProjectiles: 600,
  maxEnemies: 350,
};

/**
 * 默认 RNG 工厂：自包含 LCG（Numerical Recipes 常数），最简确定性实现，
 * 仅供测试与兜底。语义与 rng.ts 的 Rng 约定一致（int 对 maxExclusive<=0 恒返 0，
 * pick 对空数组抛错），保证结构性满足 Rng 接口。
 */
function createLcgRng(seed: number): Rng {
  // 归整到 int32；归整结果为 0 时用黄金比例常数扰动，避免 LCG 全零退化序列。
  let s = seed | 0;
  if (s === 0) {
    s = 0x9e3779b9;
  }

  const next = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return (s >>> 0) / 4294967296;
  };

  return {
    next,

    int(maxExclusive: number): number {
      // 约定与 rng.ts 一致：maxExclusive <= 0 恒返回 0（不抛错，热路径安全）。
      if (maxExclusive <= 0) {
        return 0;
      }
      return Math.floor(next() * maxExclusive);
    },

    range(min: number, max: number): number {
      return min + next() * (max - min);
    },

    pick<T>(list: readonly T[]): T {
      if (list.length === 0) {
        throw new Error('rng.pick: 空数组无可选元素');
      }
      return list[Math.floor(next() * list.length)];
    },
  };
}

/** 模块级可替换 RNG 工厂：默认 LCG，引导层经 setRngFactory 替换为 rng.ts 的 createRng。 */
let rngFactory: (seed: number) => Rng = createLcgRng;

/** 替换 RNG 工厂（引导层启动时调用一次：setRngFactory(createRng)）。 */
export function setRngFactory(fn: (seed: number) => Rng): void {
  rngFactory = fn;
}

// —— 第二独立随机流（战斗期掷点专用，任务三「爆头」引入） ——
// 契约（锁定）：
// - 种子 = 会话种子 XOR 0x9E3779B9（黄金比例常数），走固定 LCG（createLcgRng）——
//   刻意不经过 rngFactory：引导层把工厂替换为 mulberry32 只影响 state.rng 主随机流，
//   战斗期掷点流不受引导层注入影响，任意引导下同种子同序列。
// - 绝不消费 state.rng（升级三选一 / 开局武器抽取 / 修复包判定等主随机流序列零扰动）。
// - 存于 state.meta 单键（meta 为自由扩展袋，不扩 SimState 类型契约）；同种子全程可复现。

/** 第二独立随机流的 meta 单键（值为 Rng 实例）。 */
export const BATTLE_RNG_META_KEY = 'battle_rng';

/** 战斗期掷点流的种子扰动常数（黄金比例；与会话种子 XOR 后作 LCG 种子）。 */
const BATTLE_RNG_SEED_XOR = 0x9e3779b9;

/**
 * 取一局的战斗期随机流（懒创建，幂等）：种子 = 会话种子 XOR 0x9E3779B9 的固定 LCG。
 * 仅战斗期掷点（当前唯一消费方：蓄能狙击【爆头】）使用；测试可整体替换该 meta 键值注入桩。
 */
export function getBattleRng(state: SimState): Rng {
  let rng = state.meta[BATTLE_RNG_META_KEY] as Rng | undefined;
  if (!rng) {
    rng = createLcgRng((state.seed ^ BATTLE_RNG_SEED_XOR) | 0);
    state.meta[BATTLE_RNG_META_KEY] = rng;
  }
  return rng;
}

/**
 * 创建一局初始 SimState。
 * @param seed 随机种子（同种子 → 同序列 → 全程可复现）
 * @param config 可选配置覆盖，逐字段浅合并进默认配置
 */
export function createSimState(seed: number, config?: Partial<SimConfig>): SimState {
  const mergedConfig: SimConfig = { ...DEFAULT_CONFIG, ...config };
  const layout: Layout = { ...DEFAULT_LAYOUT };
  const state: SimState = {
    layout,
    config: mergedConfig,
    seed,
    rng: rngFactory(seed),
    timeMs: 0,
    over: null,
    character: { x: layout.width / 2, y: layout.height - 60 },
    wall: { hp: mergedConfig.wallMaxHp, maxHp: mergedConfig.wallMaxHp },
    enemies: [],
    projectiles: [],
    gems: [],
    drops: [],
    progress: { xp: 0, level: 1 },
    weaponStates: {},
    hooks: [],
    events: [],
    nextId: 1,
    meta: {},
  };
  // 第二独立随机流（战斗期掷点专用）：随局建立，种子 = 会话种子 XOR 0x9E3779B9（见上契约）。
  state.meta[BATTLE_RNG_META_KEY] = createLcgRng((seed ^ BATTLE_RNG_SEED_XOR) | 0);
  return state;
}
