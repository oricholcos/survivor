// src/core/targeting.ts —— 弹道武器瞄准数学（移动预测）+ 统一目标选择（四级优先级）。
// 职责一（移动预测）：直射弹道武器（piercing_bolt / prism_chain 首跳 / charge_sniper）在
// 开火瞬间按目标当前速度解提前量（interceptPoint 二次方程精确解），保证匀速直线移动的
// 主目标必中；穿透延续与弹跳跳转不重新瞄准（单纯走直线）——以此与追踪武器（homing_missile
// 的逐帧转向制导）区分开。这是用户试玩反馈的核心手感修复之一。
// 职责二（统一目标选择）：findTarget 把各行为文件重复实现的「最近敌人」扫描收敛为一份
// 四级优先级实现，并修复用户反馈的贴墙目标问题：attack 怪（贴到城墙、正在打墙）是场上
// 最高威胁（wall.ts 每帧在对墙结算真实伤害），必须被各武器的目标选择正常覆盖，不得被
// 「快速怪/精英怪」这类跳跃式优先级饿死（旧 charge_sniper 三级优先级 boss>fast>最近
// 会让场上任何一只快速行军怪压过贴墙 tank——除非近处没有其他怪，贴墙怪永远轮不到）。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM；零随机（全确定性映射）。
// 瞄准算法本身无数值参数：二次方程求解是数学，不是数值表。

import { isStunned, speedMultiplier } from './effects';
import { distSq } from './math';
import type { Vec2 } from './math';
import type { Enemy, SimState } from './types';

/**
 * 目标当前速度（px/s）：弹道提前量预测用。
 * - march 怪：(0, speed × speedMultiplier)——竖直向下，与 enemies.ts 的行军位移完全同式
 *   （slow/chill 减速乘区计入，减速怪提前量同步缩小）；
 * - attack 怪（贴墙）：y 钉在墙线不再因行军变化 → (0, 0)；
 * - 眩晕（stun，任意状态）：enemies.ts 眩晕停位移 → (0, 0)。
 */
export function targetVelocity(enemy: Enemy): Vec2 {
  if (enemy.state === 'attack' || isStunned(enemy)) {
    return { x: 0, y: 0 };
  }
  return { x: 0, y: enemy.speed * speedMultiplier(enemy) };
}

/**
 * 解最早命中时刻的拦截点：求 t 使 |Δ + v·t| = s·t（Δ = targetPos - origin，v = targetVel，
 * s = 弹速），取非负根中较小者（最早命中）。展开即一元二次方程：
 *   (v·v − s²)·t² + 2(Δ·v)·t + |Δ|² = 0
 * - s <= 0（脏数据）或无实根 / 无非负根（目标逃离且比弹快）→ null，调用方退化为直接瞄准；
 * - v·v === s²（弹速与目标速率相等）退化为一次方程 b·t + c = 0（仅接近时可达）；
 * - 静止目标（v = 0）自然退化为 t = |Δ|/s → 返回 targetPos 本身。
 * 返回预测命中点 targetPos + v·t（不是 t 本身）。按圆心对圆心的精确解计算；实际命中判定
 * 另有弹丸/敌人半径的圆相交余量，余量只会让命中更稳，不影响提前量方向的正确性。
 */
export function interceptPoint(
  origin: Vec2,
  targetPos: Vec2,
  targetVel: Vec2,
  speed: number,
): Vec2 | null {
  if (!(speed > 0)) {
    return null;
  }
  const dx = targetPos.x - origin.x;
  const dy = targetPos.y - origin.y;
  const a = targetVel.x * targetVel.x + targetVel.y * targetVel.y - speed * speed;
  const b = 2 * (dx * targetVel.x + dy * targetVel.y);
  const c = dx * dx + dy * dy;

  let t: number | null = null;
  if (a === 0) {
    // 一次方程 b·t + c = 0（弹速与目标速率相等的退化：仅迎面/接近时可达）。
    if (b === 0) {
      // Δ = 0 且 |v| = s：任意 t 都是解（弹与目标同点同速），取 t=0 即当前位置。
      return c === 0 ? { x: targetPos.x, y: targetPos.y } : null;
    }
    t = -c / b;
    if (t < 0) {
      return null; // 唯一根为负：正在远离
    }
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) {
      return null; // 无实根：追不上（如横向掠过且目标比弹快）
    }
    const sq = Math.sqrt(disc);
    const t1 = (-b - sq) / (2 * a);
    const t2 = (-b + sq) / (2 * a);
    // a 的符号不定（弹快于目标为负、慢于目标为正），两根大小关系随符号翻转：
    // 收集全部非负根取较小者（最早命中时刻）。
    if (t1 >= 0 && (t === null || t1 < t)) {
      t = t1;
    }
    if (t2 >= 0 && (t === null || t2 < t)) {
      t = t2;
    }
    if (t === null) {
      return null; // 两根皆负：目标正在远离且已错过
    }
  }
  return { x: targetPos.x + targetVel.x * t, y: targetPos.y + targetVel.y * t };
}

/**
 * 弹道主目标的瞄准点：interceptPoint 有解 → 返回预测命中点（移动预测）；
 * 无解（脏弹速 / 追不上）→ 退化为目标当前位置（直接瞄准），保证「一定瞄准主目标」的
 * 语义不劣化——提前量只为命中移动目标服务，绝不把弹打到没有目标的方向。
 *
 * maxY（行军可达域下界，调用方传 layout.wallLineY）：行军怪到墙即停（enemies.ts 把 y 钉在
 * wallLineY 转攻击），恒速假设在墙边界处失效——预测点若越过墙线，怪实际必然停靠在墙线上
 * （x 不变，行军纯竖直），故把瞄准点钳到 (x, maxY)。该点在原弹道路径上且更近：怪无论中途
 * 停墙还是提前被截都能被这条路径覆盖，避免围墙时段成排浪费弹道（平衡回归实测会破防）。
 */
export function leadAim(origin: Vec2, enemy: Enemy, speed: number, maxY?: number): Vec2 {
  const pos: Vec2 = { x: enemy.x, y: enemy.y };
  const p = interceptPoint(origin, pos, targetVelocity(enemy), speed);
  if (!p) {
    return pos;
  }
  if (maxY !== undefined && p.y > maxY) {
    return { x: p.x, y: maxY };
  }
  return p;
}

/** findTarget 可选项（charge_sniper 等带偏好的武器传入；缺省即「attack 层 + 最近」）。 */
export interface FindTargetOpts {
  /** isBoss 最优先（多个取最近）。 */
  preferBoss?: boolean;
  /** speed ≥ fastSpeedThreshold 的快速怪次优先（取最近）。 */
  preferFast?: boolean;
  /** 快速怪速率阈值（px/s；与 charge_sniper 表键同名同语义，缺省 0 即全员算快速）。 */
  fastSpeedThreshold?: number;
  /** 最大索敌射程（px）；设置时超出此距离的敌人不作为目标候选。 */
  maxRange?: number;
  /** 排除的敌人 id（灼热光束次级束选目标时排除主束当前锁定目标）；四级优先级各层一律跳过。 */
  excludeId?: number;
}

/**
 * 统一目标选择（供各弹道武器复用，消除各行为文件重复实现的「最近敌人」扫描）。
 *
 * 四级优先级（锁定，targeting.test.ts 逐层锁序）：
 *   ① boss（preferBoss 开时；多个取最近）
 *   ② attack 怪（贴墙、正在攻击城墙——高威胁层，取最近）
 *   ③ 快速怪（preferFast 开时；speed ≥ fastSpeedThreshold，取最近）
 *   ④ 最近敌人（march 怪兜底）
 *
 * attack 层必须排在 fast 之前（用户反馈修复）：贴墙怪正在对墙造成真实伤害（wall.ts 每帧
 * 结算），是场上最高威胁；旧三级优先级（boss > fast > 最近）会让任何远处快速行军怪饿死
 * 贴墙 tank——「除非近距离没有其他怪否则不会被锁定」。故无论是否开偏好，attack 怪一律
 * 优先于一切 march 怪被常规覆盖；同级（同层）内取距角色最近者，平距取数组先出现者
 * （严格 < 比较，与各行为旧实现同款确定性约定）。全部层级都无存活目标 → null。
 */
export function findTarget(state: SimState, opts?: FindTargetOpts): Enemy | null {
  const preferBoss = opts?.preferBoss === true;
  const preferFast = opts?.preferFast === true;
  const threshold = opts?.fastSpeedThreshold ?? 0;
  const maxRangeSq = opts?.maxRange !== undefined && opts.maxRange > 0 ? opts.maxRange * opts.maxRange : Infinity;
  const excludeId = opts?.excludeId;

  let boss: Enemy | null = null;
  let bossDistSq = Infinity;
  let attack: Enemy | null = null;
  let attackDistSq = Infinity;
  let fast: Enemy | null = null;
  let fastDistSq = Infinity;
  let any: Enemy | null = null;
  let anyDistSq = Infinity;

  const enemies = state.enemies;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.dead) {
      continue;
    }
    if (excludeId !== undefined && e.id === excludeId) {
      continue; // 被排除的敌人：四级优先级各层一律不作为候选
    }
    const d = distSq(state.character, e);
    if (d > maxRangeSq) {
      continue;
    }
    if (preferBoss && e.isBoss && d < bossDistSq) {
      bossDistSq = d;
      boss = e;
    }
    // 高威胁层：贴墙怪正在打墙，压过一切 march 怪（含快速怪）。
    if (e.state === 'attack' && d < attackDistSq) {
      attackDistSq = d;
      attack = e;
    }
    // attack 怪同时满足速度阈值时也留在本层做候选——但它必然已被上面更高优先级的
    // attack 层覆盖，两层语义不冲突（到达 fast 层比较时场上必无 attack 怪）。
    if (preferFast && e.speed >= threshold && d < fastDistSq) {
      fastDistSq = d;
      fast = e;
    }
    if (d < anyDistSq) {
      anyDistSq = d;
      any = e;
    }
  }
  return boss ?? attack ?? fast ?? any;
}
