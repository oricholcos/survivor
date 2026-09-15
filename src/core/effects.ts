// src/core/effects.ts —— 通用效果槽引擎（横切层）：统一挂载 / 叠层 / 互斥 / 到期 / 周期结算。
// 效果定义（EffectDef）全部来自 src/data/effects.json（经 data/effects.ts 注册进本模块注册表），
// 本文件零硬编码数值；测试可经 registerEffectDef 注入夹具定义。
//
// 互斥规则（选定并锁定）：
// - 同 exclusiveGroup 内**不同 kind** 的效果互斥，组内只保留一个；
// - 比较强度 potency（缺省 1）：新效果 potency 严格大于旧效果 → 移除旧效果、挂上新效果；
//   否则拒绝新效果（保留旧效果）。同 potency 先到者留。同 kind 重复施加不触发互斥，
//   走 refresh 叠层/刷新语义。
// - 内置组：slow 与 chill 同组 'slow_family'（slow potency 2 > chill 1，取更强减速）。
//
// refresh 语义（锁定）：
// - 'reset'：同 kind 重复施加 → stacks 重置为 1，untilMs 重算；
// - 'add'：同 kind 重复施加 → stacks +1（上限 maxStacks 钳制），untilMs 同样重算
//   （EffectInstance 只有单一 untilMs，重复施加即重新武装计时）。
//
// 即时效果（durationMs <= 0，当前仅 knockback）：不挂实例，apply 时立即按
// data.dirX/dirY（单位向量，由武器行为提供，如背向来源）× force 推移载体位置；
// 敌人钳制在 [spawnLineY, wallLineY] × [0, width] 内（不穿墙、不出边界）。
//
// 叠层乘区规则（锁定）：
// - speedFactor（slow/chill）：每实例 factor^stacks（每层再乘一次），多实例并存取 min（最强减速生效）；
// - damageTakenFactor（mark/corrode）：每实例 factor^stacks，多实例叠乘；
// - intervalFactor（overheat）：每实例 factor^stacks（maxStacks=1 即定义值）。
//
// 数值参数读取优先级：effect.data 同名键（逐实例覆盖，M2 武器按需传入）→ EffectDef 定义值。
// 确定性契约：不用 rng；性能契约：tick 零大对象分配（实例数组交换删除、无逐帧临时对象）。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM（ESLint 强制）。
// 注意：本模块与 projectiles.ts 存在双向引用（dealDamage 调 killHooks / 命中调 dealDamage），
// 双方都只在函数体内使用对方导出（ESM 活绑定，无模块初始化期依赖），循环安全。

import { pushEvent } from './events';
import { clamp } from './math';
import { killHooks } from './projectiles';
import type { EffectInstance, Enemy, Projectile, SimState } from './types';

/** 效果定义（src/data/effects.json 一个条目的结构契约；id = EffectInstance.kind）。 */
export interface EffectDef {
  /** 效果种类名（即 EffectInstance.kind，注册表键）。 */
  id: string;
  /** 显示名。 */
  name: string;
  /** 持续时长 ms；<= 0 为即时效果（不挂实例，apply 时立即结算，如 knockback 冲量）。 */
  durationMs: number;
  /** 周期结算间隔 ms（DoT 类）；缺省/0 = 无周期结算。 */
  tickMs?: number;
  /** 叠层上限（>= 1）。 */
  maxStacks: number;
  /** 重复施加语义：'reset' 重置为 1 层 / 'add' 加 1 层（上限钳制）。 */
  refresh: 'reset' | 'add';
  /** 互斥组名：同组不同 kind 互斥（组内只留一个）；缺省不参与互斥。 */
  exclusiveGroup?: string;
  /** 互斥强度（缺省 1）：新效果 potency 严格大于组内旧效果才替换，否则拒绝。 */
  potency?: number;
  // —— 可选数值参数（消费方按 kind 解释；effect.data 同名键可逐实例覆盖）——
  /** burn/poison：每 tick 每 层 伤害。 */
  damagePerTick?: number;
  /** slow/chill：速度乘区（^stacks，多实例取 min）。 */
  speedFactor?: number;
  /** mark/corrode：受伤乘区（^stacks，多实例叠乘）。 */
  damageTakenFactor?: number;
  /** knockback：冲量位移 px（沿 data.dirX/dirY 单位向量）。 */
  force?: number;
  /** blackhole：向 data.centerX/centerY 拉扯速度 px/s。 */
  pullPerSec?: number;
  /** overheat：开火间隔乘区。 */
  intervalFactor?: number;
}

/**
 * 结构化效果载体：有 effects 数组即可挂效果（Enemy 天然满足；weaponStates 值经
 * types.ts 的可选 effects 字段满足——applyEffect 首次挂载时懒初始化该数组）。
 * 带 x/y 的载体（敌人/弹丸）额外可被击退冲量与黑洞拉扯位移。
 */
export type EffectBearer = Enemy | Projectile | { effects?: EffectInstance[]; x?: number; y?: number };

/** 效果定义注册表（模块级单例；data/effects.ts 加载 JSON 后注册，测试可注入夹具）。 */
const effectDefs: Record<string, EffectDef> = {};

/** 注册单个效果定义（同 id 后注册者胜）。 */
export function registerEffectDef(def: EffectDef): void {
  effectDefs[def.id] = def;
}

/** 批量注册效果定义（键 → 定义；以 def.id 为注册键）。 */
export function registerEffectDefs(defs: Record<string, EffectDef>): void {
  for (const key in defs) {
    registerEffectDef(defs[key]);
  }
}

/** 取效果定义；未注册抛错（数据表 kind 拼错尽早暴露，而非静默哑火）。 */
export function getEffectDef(kind: string): EffectDef {
  const def = effectDefs[kind];
  if (!def) {
    throw new Error(`effects: 未注册的效果定义 "${kind}"`);
  }
  return def;
}

/** 已注册效果定义 id 列表（升序，便于测试与调试）。 */
export function listEffectDefs(): string[] {
  return Object.keys(effectDefs).sort();
}

// —— 内部工具 ——

/** 取载体的效果数组（懒初始化：weaponStates 等可选字段载体首次挂载时补建空数组）。 */
function listOf(bearer: EffectBearer): EffectInstance[] {
  const b = bearer as { effects?: EffectInstance[] };
  let list = b.effects;
  if (!list) {
    list = [];
    b.effects = list;
  }
  return list;
}

/** 读取载体的 effects 数组（只读路径：不存在返回 undefined，绝不创建）。 */
function peekList(bearer: EffectBearer): EffectInstance[] | undefined {
  return (bearer as { effects?: EffectInstance[] }).effects;
}

/** 数值参数读取：effect.data 同名键（有限数）优先，否则取 EffectDef 定义值（有限数）。 */
function paramNum(def: EffectDef, inst: EffectInstance, key: string): number | undefined {
  const fromData = inst.data[key];
  if (typeof fromData === 'number' && Number.isFinite(fromData)) {
    return fromData;
  }
  const raw = (def as unknown as Record<string, unknown>)[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/** 载体是否为已死亡敌人（DoT 击杀后终止该载体剩余效果处理）。 */
function isDeadEnemy(bearer: EffectBearer): boolean {
  const b = bearer as { dead?: boolean };
  return b.dead === true;
}

/**
 * DoT tick 间隔（T5.3b dot 频率牌接线）：effect.data.tickMs（逐实例覆盖，附着点传入——
 * 如 dot 频率牌把该武器附着的 DoT tick 间隔 ÷1.3^张数）优先，否则 EffectDef 定义值。
 * 与 paramNum 同款「data 同名键逐实例覆盖 → def 定义值」优先级；是否 tick 仍由 def.tickMs 把关
 * （data.tickMs 只覆盖间隔，不能把无 tick 效果变成 tick 效果）。
 */
function tickIntervalOf(def: EffectDef, data: Record<string, number> | undefined): number {
  const fromData = data?.tickMs;
  if (typeof fromData === 'number' && Number.isFinite(fromData) && fromData > 0) {
    return fromData;
  }
  return def.tickMs ?? 0;
}

/** 把带位置的载体钳制在场地内：x ∈ [0, width]，y ∈ [spawnLineY, wallLineY]（敌人不穿墙）。 */
function clampInArena(state: SimState, bearer: EffectBearer): void {
  const b = bearer as { x?: number; y?: number };
  if (typeof b.x !== 'number' || typeof b.y !== 'number') {
    return;
  }
  b.x = clamp(b.x, 0, state.layout.width);
  b.y = clamp(b.y, state.layout.spawnLineY, state.layout.wallLineY);
}

/** 即时效果结算（durationMs <= 0）：有 force 参数即按 dirX/dirY × force 冲量位移。 */
function applyInstant(
  state: SimState,
  bearer: EffectBearer,
  def: EffectDef,
  data?: Record<string, number>,
): void {
  const dataForce = data?.force;
  const force =
    typeof dataForce === 'number' && Number.isFinite(dataForce) ? dataForce : def.force;
  if (typeof force !== 'number' || !Number.isFinite(force)) {
    return; // 无冲量参数：无即时位移语义
  }
  const b = bearer as { x?: number; y?: number };
  if (typeof b.x !== 'number' || typeof b.y !== 'number') {
    return; // 无位置载体（如武器）：冲量无处作用
  }
  const dirX = data?.dirX ?? 0;
  const dirY = data?.dirY ?? 0;
  if (dirX === 0 && dirY === 0) {
    return; // 零向量无方向：不位移（方向契约由调用方提供，如背向来源的单位向量）
  }
  b.x += dirX * force;
  b.y += dirY * force;
  clampInArena(state, b);
}

/** 黑洞拉扯：每帧向 data.centerX/centerY 位移 pullPerSec*dtSec（不越过中心，场地钳制）。 */
function applyPull(
  state: SimState,
  bearer: EffectBearer,
  inst: EffectInstance,
  pullPerSec: number,
  dtSec: number,
): void {
  const b = bearer as { x?: number; y?: number };
  if (typeof b.x !== 'number' || typeof b.y !== 'number') {
    return;
  }
  const cx = inst.data.centerX;
  const cy = inst.data.centerY;
  if (typeof cx !== 'number' || typeof cy !== 'number' || !Number.isFinite(cx) || !Number.isFinite(cy)) {
    return; // 无中心参数：不拉（中心由武器行为提供）
  }
  const dx = cx - b.x;
  const dy = cy - b.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist <= 1e-9) {
    return; // 已在中心
  }
  const move = Math.min(pullPerSec * dtSec, dist);
  b.x += (dx / dist) * move;
  b.y += (dy / dist) * move;
  clampInArena(state, b);
}

/**
 * 统一伤害入口（弹丸命中、DoT tick、未来的近战/AoE 一律走这里）：
 * amount × damageTakenFactor（mark/corrode，每实例 ^stacks、多实例叠乘）→ enemy.hp -=；
 * hp <= 0 且未 dead → dead = true、pushEvent enemyKilled{enemyId,typeId,x,y,isBoss}、
 * 依次调用 projectiles.ts 的 killHooks（击杀掉落等）。
 * amount 非有限或 <= 0、敌人已死亡 → 无操作（防脏数据与重复结算）。
 */
export function dealDamage(state: SimState, enemy: Enemy, amount: number): void {
  if (enemy.dead || !Number.isFinite(amount) || amount <= 0) {
    return;
  }
  enemy.hp -= amount * damageTakenFactor(enemy);
  if (enemy.hp <= 0 && !enemy.dead) {
    enemy.dead = true;
    pushEvent(state, {
      kind: 'enemyKilled',
      enemyId: enemy.id,
      typeId: enemy.typeId,
      x: enemy.x,
      y: enemy.y,
      isBoss: enemy.isBoss,
    });
    for (let k = 0; k < killHooks.length; k++) {
      killHooks[k](state, enemy);
    }
  }
}

/**
 * 向载体施加一个效果（defId → EffectDef）：
 * 1) durationMs <= 0 → 即时效果（knockback 冲量），不挂实例；
 * 2) 同 kind 已存在 → refresh 语义（'add' 加层至 maxStacks / 'reset' 重置 1 层），
 *    untilMs 一律按 state.timeMs + durationMs 重算，data 逐键合并进 effect.data
 *    （提供过的键持久保留，不因后续施加缺参而丢失）；tick 类效果重排下一跳；
 * 3) 无同 kind 且定义了 exclusiveGroup → 组内已有其他 kind 时按 potency 强弱
 *    决定替换（新 > 旧 → 移除旧、挂新）或拒绝（新 <= 旧 → 无操作）；
 * 4) 否则挂新实例 {kind, untilMs, stacks: 1, data: {...data}}（data 深拷贝进实例）。
 * 未知 defId → 抛错（尽早暴露数据表拼写错误）。
 */
export function applyEffect(
  state: SimState,
  bearer: EffectBearer,
  defId: string,
  data?: Record<string, number>,
): void {
  const def = effectDefs[defId];
  if (!def) {
    throw new Error(`applyEffect: 未注册的效果定义 "${defId}"`);
  }

  // 即时效果：不占效果槽。
  if (def.durationMs <= 0) {
    applyInstant(state, bearer, def, data);
    return;
  }

  const list = listOf(bearer);

  // 1) 同 kind：叠层 / 刷新。
  for (let i = 0; i < list.length; i++) {
    const inst = list[i];
    if (inst.kind !== defId) {
      continue;
    }
    if (def.refresh === 'add') {
      if (inst.stacks < def.maxStacks) {
        inst.stacks += 1;
      }
    } else {
      inst.stacks = 1;
    }
    inst.untilMs = state.timeMs + def.durationMs;
    if (data) {
      for (const k in data) {
        inst.data[k] = data[k];
      }
    }
    if (def.tickMs !== undefined && def.tickMs > 0) {
      inst.data.nextTickAt = state.timeMs + tickIntervalOf(def, inst.data); // 重复施加重排下一跳（data.tickMs 可逐实例覆盖间隔）
    }
    return;
  }

  // 2) 互斥组：组内已有其他 kind → 强者胜（新 > 旧替换，否则拒绝）。
  if (def.exclusiveGroup !== undefined) {
    for (let i = list.length - 1; i >= 0; i--) {
      const other = effectDefs[list[i].kind];
      if (!other || other.exclusiveGroup !== def.exclusiveGroup || list[i].kind === defId) {
        continue;
      }
      if ((def.potency ?? 1) > (other.potency ?? 1)) {
        list.splice(i, 1); // 新效果更强：移除旧效果，继续挂新
      } else {
        return; // 不强于旧效果：拒绝（组内保持现状）
      }
    }
  }

  // 3) 挂新实例（data 深拷贝：实例不持有调用方对象引用）。
  const inst: EffectInstance = {
    kind: defId,
    untilMs: state.timeMs + def.durationMs,
    stacks: 1,
    data: {},
  };
  if (data) {
    for (const k in data) {
      inst.data[k] = data[k];
    }
  }
  if (def.tickMs !== undefined && def.tickMs > 0) {
    inst.data.nextTickAt = state.timeMs + tickIntervalOf(def, inst.data); // 首跳在 apply 后一个 tick 周期（data.tickMs 可逐实例覆盖间隔）
  }
  list.push(inst);
}

/**
 * 弹丸命中附着：把 effectsOnHit 模板逐条实例化到敌人。
 * 模板仅取 kind 与 data（data 深拷贝进实例）；untilMs 一律按 state.timeMs + def.durationMs
 * 重算，模板的 untilMs / stacks 不参与（叠层与互斥规则同 applyEffect）。
 */
export function applyEffectsOnHit(
  state: SimState,
  enemy: Enemy,
  templates: EffectInstance[],
): void {
  for (let i = 0; i < templates.length; i++) {
    const t = templates[i];
    applyEffect(state, enemy, t.kind, t.data);
  }
}

/**
 * 单载体效果推进：周期结算（tick 先于过期判定——最后一跳恰落在 untilMs 当帧仍结算，
 * burn 3000/500 恰好 6 跳）、黑洞拉扯（每帧）、到期移除（交换删除，O(1)）。
 * DoT 击杀载体（敌人）→ 清空剩余效果并终止（防尸体继续结算）。
 * 未注册 kind 的残留实例直接移除（防泄漏）。
 */
function tickEffectList(
  state: SimState,
  bearer: EffectBearer,
  list: EffectInstance[],
  dtSec: number,
): void {
  const now = state.timeMs;
  for (let i = 0; i < list.length; ) {
    const inst = list[i];
    const def = effectDefs[inst.kind];
    if (!def) {
      // 未注册 kind：无法解释，清除（注册表被替换等极端情形的兜底）。
      const last = list.pop()!;
      if (i < list.length) {
        list[i] = last;
      }
      continue;
    }

    // 持续位移类（blackhole）：每帧拉扯。
    const pull = paramNum(def, inst, 'pullPerSec');
    if (pull !== undefined) {
      applyPull(state, bearer, inst, pull, dtSec);
    }

    // 周期结算类（burn/poison）：追补所有已到期的跳（跳点不超过 untilMs）。
    // tick 间隔 = tickIntervalOf（data.tickMs 逐实例覆盖 → def 定义值，dot 频率牌消费点）。
    if (def.tickMs !== undefined && def.tickMs > 0) {
      const tickMs = tickIntervalOf(def, inst.data);
      let next = inst.data.nextTickAt;
      while (
        typeof next === 'number' &&
        Number.isFinite(next) &&
        next <= now &&
        next <= inst.untilMs
      ) {
        const dmg = paramNum(def, inst, 'damagePerTick');
        const target = bearer as Enemy;
        if (
          dmg !== undefined &&
          dmg > 0 &&
          typeof target.hp === 'number' && // 仅敌人载体结算 DoT（tick 类效果不挂武器）
          !isDeadEnemy(bearer)
        ) {
          dealDamage(state, target, dmg * inst.stacks); // 每层各结算一次伤害
        }
        next += tickMs;
        inst.data.nextTickAt = next;
      }
      if (isDeadEnemy(bearer)) {
        list.length = 0; // DoT 致死：清空尸体剩余效果
        return;
      }
    }

    // 到期移除（交换删除：末元素换到当前位继续处理）。
    if (inst.untilMs <= now) {
      const last = list.pop()!;
      if (i < list.length) {
        list[i] = last;
      }
      continue;
    }
    i++;
  }
}

/**
 * 推进一帧效果系统（由引导层注册进 hooks：敌人之后、墙战之前）：
 * - 敌人：周期结算（DoT）、黑洞拉扯、到期清理；
 * - 武器（weaponStates.effects，如 overheat）：到期清理（无 tick/位移语义）。
 * state.over 非 null（模拟已结束）时直接 return（与 enemies/wall 同款防重入）。
 * 不推进 state.timeMs（step 负责）；dtMs 仅供位移类换算秒。
 */
export function updateEffects(state: SimState, dtMs: number): void {
  if (state.over !== null) {
    return;
  }

  const dtSec = dtMs / 1000;

  const enemies = state.enemies;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.dead || e.effects.length === 0) {
      continue;
    }
    tickEffectList(state, e, e.effects, dtSec);
  }

  // 武器载体（overheat 等挂点）：仅到期清理；无 effects 字段（未挂过效果）直接跳过。
  const wsMap = state.weaponStates;
  for (const id in wsMap) {
    const ws = wsMap[id];
    if (ws.effects !== undefined && ws.effects.length > 0) {
      tickEffectList(state, ws, ws.effects, dtSec);
    }
  }
}

// —— 查询乘区（消费点：enemies/wall/weapons 与 M2 武器行为） ——

/** 通用乘区收集：每实例 factor^stacks；多实例按 combine 合并（min 取最强 / product 叠乘）。 */
function collectFactor(
  bearer: EffectBearer,
  key: string,
  combine: 'min' | 'product',
): number {
  const list = peekList(bearer);
  if (!list || list.length === 0) {
    return 1;
  }
  let result = combine === 'min' ? Infinity : 1;
  let any = false;
  for (let i = 0; i < list.length; i++) {
    const inst = list[i];
    const def = effectDefs[inst.kind];
    if (!def) {
      continue;
    }
    const raw = paramNum(def, inst, key);
    if (raw === undefined) {
      continue;
    }
    any = true;
    const factor = Math.pow(raw, inst.stacks);
    result = combine === 'min' ? Math.min(result, factor) : result * factor;
  }
  if (!any) {
    return 1;
  }
  return result;
}

/** 速度乘区（enemies.ts 行军消费）：slow/chill 每实例 ^stacks，多实例取 min；无效果 = 1。 */
export function speedMultiplier(bearer: EffectBearer): number {
  return collectFactor(bearer, 'speedFactor', 'min');
}

/** 受伤乘区（dealDamage 消费）：mark/corrode 每实例 ^stacks，多实例叠乘；无效果 = 1。 */
export function damageTakenFactor(bearer: EffectBearer): number {
  return collectFactor(bearer, 'damageTakenFactor', 'product');
}

/** 开火间隔乘区（weapons.ts 消费）：overheat 定义值（data 可逐实例覆盖）；无效果 = 1。 */
export function overheatFactor(bearer: EffectBearer): number {
  return collectFactor(bearer, 'intervalFactor', 'product');
}

/** 载体是否带有指定 kind 的效果实例（存在性判断，到期清理由 updateEffects 负责）。 */
export function hasEffect(bearer: EffectBearer, kind: string): boolean {
  const list = peekList(bearer);
  if (!list) {
    return false;
  }
  for (let i = 0; i < list.length; i++) {
    if (list[i].kind === kind) {
      return true;
    }
  }
  return false;
}

/** 载体指定 kind 的叠层数；无该效果 = 0。 */
export function effectStacks(bearer: EffectBearer, kind: string): number {
  const list = peekList(bearer);
  if (!list) {
    return 0;
  }
  for (let i = 0; i < list.length; i++) {
    if (list[i].kind === kind) {
      return list[i].stacks;
    }
  }
  return 0;
}

/** 是否眩晕（enemies.ts 停位移 / wall.ts 停攻击消费）。 */
export function isStunned(bearer: EffectBearer): boolean {
  return hasEffect(bearer, 'stun');
}
