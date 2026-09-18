// src/core/types.ts —— 一局模拟的全部实体与状态类型（纯类型层，无运行时代码）。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM（ESLint 强制）。
// 本文件是模拟层的公共契约：字段名与语义不得改名，后续子系统一律按此结构读写。

import type { GameEvent } from './events';

/** RNG 结构性接口：由 rng.ts 的 createRng 返回值满足它；simState.ts 的默认工厂实现也满足它。 */
export interface Rng {
  /** 均匀分布浮点，恒在 [0, 1)。 */
  next(): number;
  /** 均匀整数，恒在 [0, maxExclusive)。 */
  int(maxExclusive: number): number;
  /** 均匀浮点，恒在 [min, max)。 */
  range(min: number, max: number): number;
  /** 等概率取一。 */
  pick<T>(list: readonly T[]): T;
}

/** 二维向量 / 坐标点。 */
export interface Vec {
  x: number;
  y: number;
}

/** 一局的固定布局（画布与关键水平线，单位 px）。 */
export interface Layout {
  width: number;
  height: number;
  /** 城墙所在水平线 y：敌人到线转攻击，工程单位在线后修墙。 */
  wallLineY: number;
  /** 敌人出生线 y（画布上方之外）。 */
  spawnLineY: number;
}

/** 一局的可调参数（数值契约：正式数值来自 JSON，由引导层注入；这里的默认值仅供测试）。 */
export interface SimConfig {
  xpBase: number;
  xpTier1Step: number;
  xpTier2Step: number;
  xpGrowth?: number;
  /** 宝石自动飞向角色 / 掉落物飞向城墙的速度 px/s。 */
  gemFlySpeed: number;
  dropFlySpeed: number;
  /** 击杀掉修复包概率（0~1）、修复量。 */
  repairDropChance: number;
  repairHeal: number;
  /** 城墙血量上限（T5.3a 校准 3200：牌池制把成长从等级曲线大步跳跃改为每牌 ×1.3 复利，
   *  弹道机制接线 + 怪物翻倍前的过渡期由墙体补偿部分输出缺口；balance.test 是回归护栏）。 */
  wallMaxHp: number;
  /** 武器栏上限：拥有武器数达到该值后，升级选项不再出现新武器。 */
  maxWeaponSlots: number;
  /** 全局弹丸数量硬上限（性能封顶护栏，防死亡螺旋）：updateProjectiles 帧首若超额，
   *  把 id 最小的超额弹 ttl 归零、走标准 ttl 耗尽死亡路径回收。取值须远高于正常对局
   *  并发峰值（实测 campaign 峰值 ≈100）；<=0 或非有限视为不设上限。 */
  maxProjectiles: number;
  /** 全局存活敌人数量硬上限（性能封顶护栏，防死亡螺旋）：updateWaves 帧首统计存活敌数，
   *  匀速段与爆发波杂兵按剩余额度钳制（被钳掉的直接丢弃），boss 不受限。取值须远高于
   *  正常对局并发峰值（实测 campaign 峰值 ≈70、自动 endless 峰值 ≈300）；<=0 或非有限
   *  视为不设上限。 */
  maxEnemies: number;
}

/** 附着在实体上的效果实例（减速、灼烧等），到期由子系统移除。 */
export interface EffectInstance {
  /** 效果种类名（如 'slow' / 'burn'），子系统按名解释。 */
  kind: string;
  /** 失效时刻（state.timeMs 时间轴上的绝对毫秒）。 */
  untilMs: number;
  /** 叠加层数。 */
  stacks: number;
  /** 效果自定义数值参数（如减速比率、每跳伤害）。 */
  data: Record<string, number>;
}

/** 敌人。 */
export interface Enemy {
  id: number;
  /** 敌人图鉴 id（数据表键）。 */
  typeId: string;
  name: string;
  x: number;
  y: number;
  radius: number;
  hp: number;
  maxHp: number;
  /** 移动速度 px/s。 */
  speed: number;
  /** 每次攻击对墙的伤害。 */
  damage: number;
  /** 攻击间隔 ms。 */
  attackIntervalMs: number;
  /** 距下次攻击的剩余冷却 ms。 */
  attackCooldownMs: number;
  /** 行军中 / 到墙转攻击。 */
  state: 'march' | 'attack';
  isBoss: boolean;
  /** 击杀掉落经验值。 */
  xp: number;
  /** 渲染色（视图层用，模拟层不解释）。 */
  color: number;
  /** 渲染形状名（视图层用，模拟层不解释）。 */
  shape: string;
  effects: EffectInstance[];
  dead: boolean;
}

/** 投射物（武器发射的子弹）。 */
export interface Projectile {
  id: number;
  /** 所属武器行为分支名（step 子系统按此分发更新逻辑）。 */
  behavior: string;
  x: number;
  y: number;
  /** 速度分量 px/s。 */
  vx: number;
  vy: number;
  radius: number;
  damage: number;
  /** 剩余穿透次数。 */
  pierceLeft: number;
  /** 剩余弹射次数。 */
  bouncesLeft: number;
  /** 已命中敌人 id（防重复伤害）。 */
  hitIds: number[];
  /** 剩余存活时间 ms。 */
  ttlMs: number;
  /** 命中时附着到敌人的效果模板。 */
  effectsOnHit: EffectInstance[];
  /** 行为分支自定义字段（如目标引用计数、相位等）。 */
  data: Record<string, number>;
  dead: boolean;
}

/** 单把武器的角色侧状态（weaponStates 的值）。
 *  T5.3a 牌池制：level = 该武器已吃的牌数（0~10，解锁后可 >10），成长全部来自 cards——
 *  cards 为「牌 id → 已吃张数」，数值/机制生效见 core/cards.ts 的 buildWeaponStats。 */
export interface WeaponState {
  level: number;
  /** 距下次开火的剩余冷却 ms。 */
  cooldownMs: number;
  /** 挂在武器上的效果槽（如 overheat；懒初始化，未挂过效果时缺省）。 */
  effects?: EffectInstance[];
  /** 牌表：牌 id → 已持有张数（addWeapon 初始化为 {}）。 */
  cards: Record<string, number>;
  /** 牌表版本号（getWeaponStats 的 stats 缓存失效键）：addWeapon 初始化 0，applyUpgrade
   *  每次改写 cards 后 +1；缺省（undefined）按 0 处理。缓存契约见 core/weapons.ts——
   *  绕过 applyUpgrade 直接改写 cards 的代码必须同步自增本字段，否则 stats 缓存不失效。 */
  cardsVersion?: number;
}

/** 经验宝石：飞向角色被吸收。 */
export interface Gem {
  id: number;
  x: number;
  y: number;
  value: number;
  /** 飞行速度 px/s（默认取 config.gemFlySpeed）。 */
  speed: number;
  dead: boolean;
}

/** 掉落物：目前仅修复包，飞向城墙被拾取。 */
export interface Drop {
  id: number;
  kind: 'repair';
  x: number;
  y: number;
  /** 修复量（默认取 config.repairHeal）。 */
  value: number;
  /** 飞行速度 px/s（默认取 config.dropFlySpeed）。 */
  speed: number;
  dead: boolean;
}

/** 一局模拟的完整状态：step(state, dt) 的唯一输入输出载体。 */
export interface SimState {
  layout: Layout;
  config: SimConfig;
  /** 本局随机种子（复现用）。 */
  seed: number;
  rng: Rng;
  /** 本局累计时间 ms。 */
  timeMs: number;
  /** 非 null 时 step 停摆（模拟结束：失败或胜利）。 */
  over: null | 'defeat' | 'victory';
  /** 角色（友军地面单位），钉在底边中央。 */
  character: Vec;
  /** 城墙血量。 */
  wall: { hp: number; maxHp: number };
  enemies: Enemy[];
  projectiles: Projectile[];
  gems: Gem[];
  drops: Drop[];
  /** 角色成长进度：当前经验与等级。 */
  progress: { xp: number; level: number };
  /** 武器栏：武器 id → 等级/冷却/牌表（见 WeaponState）。 */
  weaponStates: Record<string, WeaponState>;
  /** 子系统注册点：step 按注册顺序依次调用。 */
  hooks: Array<(state: SimState, dtMs: number) => void>;
  /** 事件队列（由 events.ts 的函数操作）。 */
  events: GameEvent[];
  /** 实体自增 id（分配后自增）。 */
  nextId: number;
  /** 各系统扩展状态（波次游标等），键由各子系统自行约定。 */
  meta: Record<string, unknown>;
}
