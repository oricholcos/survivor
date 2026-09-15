// src/core/rng.ts —— 种子随机数（mulberry32）
// 随机契约：全项目禁 Math.random（ESLint 强制），一切随机必须经由本文件的种子 RNG，
// 保证「同种子 → 同序列 → 同一局完全可复现」。纯 TypeScript，禁止 import phaser / DOM。

/** RNG 对外接口：SimState 将结构性持有它（签名不得改名）。 */
export interface Rng {
  /** 均匀分布浮点，恒在 [0, 1)。 */
  next(): number;
  /** 均匀整数，恒在 [0, maxExclusive)；maxExclusive <= 0 时恒返回 0（明确约定，不抛错）。 */
  int(maxExclusive: number): number;
  /** 均匀浮点，恒在 [min, max)；要求 max >= min（相等时恒返回 min）。 */
  range(min: number, max: number): number;
  /** 等概率取一；空数组抛 Error（明确约定，见 rng.test.ts）。 */
  pick<T>(list: readonly T[]): T;
}

/** mulberry32 状态步进常数（经典实现，bryc 版）。 */
const STEP = 0x6d2b79f5;

/**
 * seed 经 |0 归整后为 0 时的替代种子。
 * mulberry32 在状态 a=0 时首值恒为 0（退化情形），这里用黄金比例常数扰动，
 * 使 seed=0 也有正常分布，且依旧完全确定（固定常数 → 固定序列）。
 */
const ZERO_SEED_PERTURB = 0x9e3779b9;

/** 由整数种子创建确定性 RNG：同种子两次实例化产出完全相同的调用序列。 */
export function createRng(seed: number): Rng {
  // 归整到 int32：非整数种子被截断、NaN|0 === 0，任意输入即被确定化。
  let a = seed | 0;
  if (a === 0) {
    a = ZERO_SEED_PERTURB;
  }

  const next = (): number => {
    a = (a + STEP) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,

    int(maxExclusive: number): number {
      // 约定：maxExclusive <= 0 时恒返回 0（不抛错，保证模拟热路径安全）。
      if (maxExclusive <= 0) {
        return 0;
      }
      // floor(next()*max)：next() < 1 保证结果严格小于 maxExclusive；
      // 该写法对超大 maxExclusive 存在可忽略的模偏差，对游戏量级足够。
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
