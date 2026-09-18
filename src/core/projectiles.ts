// src/core/projectiles.ts —— 弹丸系统：对象池 spawn / 直线推进 / 圆形碰撞 / 穿透计数 / 击杀钩子
// / 行为生命周期钩子（onProjectileHit / onProjectileDeath）/ noCollide 直通旗标。
// 性能契约：弹丸全部走模块级对象池（acquire/release，稳态零分配）；
// 碰撞查询走 SpatialHash（每帧 clear + 重插全部存活敌人），禁止 O(n²) 全量对比；
// 全局数量护栏：超过 config.maxProjectiles 时帧首按 id 最小优先回收超额弹（见 updateProjectiles 注释 7)）。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM；本文件无随机。

import { getBehavior } from './behaviors/registry';
import { pushSfxThrottled, SFX_PUSH_MIN_INTERVAL_MS } from './events';
import { applyEffectsOnHit, dealDamage } from './effects';
import { Pool } from './objectPool';
import type { SpatialHash } from './spatialHash';
import type { Enemy, Projectile, SimState } from './types';

/** 弹丸对象池：factory 给全字段默认值；release 时 reset 清洗全部字段（数组原地清空复用）。 */
export const projectilePool: Pool<Projectile> = new Pool<Projectile>({
  factory: () => ({
    id: 0,
    behavior: '',
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    radius: 6,
    damage: 0,
    pierceLeft: 0,
    bouncesLeft: 0,
    hitIds: [],
    ttlMs: 0,
    effectsOnHit: [],
    data: {},
    dead: false,
  }),
  reset: (p) => {
    p.id = 0;
    p.behavior = '';
    p.x = 0;
    p.y = 0;
    p.vx = 0;
    p.vy = 0;
    p.radius = 6;
    p.damage = 0;
    p.pierceLeft = 0;
    p.bouncesLeft = 0;
    p.hitIds.length = 0; // 数组/映射字段原地清空，零重分配
    p.ttlMs = 0;
    p.effectsOnHit.length = 0;
    for (const k in p.data) {
      delete p.data[k];
    }
    p.dead = false;
  },
});

/**
 * 从池里取一枚弹丸并 push 进 state.projectiles：
 * - 必填 x/y/vx/vy（位置与速度 px/s）；其余字段缺省取默认：
 *   radius=6、ttlMs=2000、pierceLeft=0、bouncesLeft=0、hitIds=[]、effectsOnHit=[]、data={}；
 * - opts 给出的数组/映射字段做浅拷贝合入（弹丸不持有调用方数组的引用）；
 * - id = state.nextId++（自增），dead=false。
 */
export function spawnProjectile(
  state: SimState,
  opts: Partial<Projectile> & Pick<Projectile, 'x' | 'y' | 'vx' | 'vy'>,
): Projectile {
  // acquire 保证干净态：复用实例必过 reset，新建实例由 factory 产出即干净。
  const p = projectilePool.acquire();

  p.id = state.nextId++;
  p.behavior = opts.behavior ?? '';
  p.x = opts.x;
  p.y = opts.y;
  p.vx = opts.vx;
  p.vy = opts.vy;
  p.radius = opts.radius ?? 6;
  p.damage = opts.damage ?? 0;
  p.pierceLeft = opts.pierceLeft ?? 0;
  p.bouncesLeft = opts.bouncesLeft ?? 0;
  p.ttlMs = opts.ttlMs ?? 2000;
  if (opts.hitIds) {
    for (let i = 0; i < opts.hitIds.length; i++) {
      p.hitIds.push(opts.hitIds[i]);
    }
  }
  if (opts.effectsOnHit) {
    for (let i = 0; i < opts.effectsOnHit.length; i++) {
      p.effectsOnHit.push(opts.effectsOnHit[i]);
    }
  }
  if (opts.data) {
    for (const k in opts.data) {
      p.data[k] = opts.data[k];
    }
  }
  p.dead = false;

  state.projectiles.push(p);
  return p;
}

/** 敌人死亡钩子（击杀掉宝石/修复包/Boss 奖励等后续注册）：死亡结算时按注册顺序依次调用。 */
export const killHooks: Array<(state: SimState, enemy: Enemy) => void> = [];

// 命中查询结果暂存缓冲（T5 热路径微优化：queryCircle 的 out 复用约定，每帧零分配）。
// 复用安全性审计（锁定）：命中循环内对同一 grid 无嵌套查询——dealDamage → killHooks
// （经验/修墙/Boss 奖励）与 applyEffectsOnHit / onProjectileHit（分裂/zap 均为线性扫描或
// 行为自有模块级网格）都不反查该网格；onProjectileDeath（迫击/导弹爆炸查询）只在命中
// 循环退出后才触发。结果仅在本枚弹的命中循环内使用，用完即弃。
const hitScratch: Enemy[] = [];

/**
 * 分裂次级弹目标选取（T5.3b split_shot 通用牌的共用助手，五把弹道武器共用）：
 * 从分裂点 (x, y) 出发，取「最近且互不相同」的至多 maxTargets 个存活敌人——逐轮 distSq
 * 全量扫描取当前最近者、选中即排除（平距取数组先出现者，确定性）；候选不足时有几个取几个。
 * excludeIds：额外的排除 id 列表（如「刚被主弹命中的敌人」——次级弹从其圆内出生，若再锁定它
 * 只会在原地空转，故目标选取与主弹当前命中目标互异；配合次级弹 hitIds 预置该 id，让次级弹
 * 穿越出生重叠圈不被去重外的前置命中截杀）。
 * 语义锁定（cards.json split_shot 牌描述）：「锁定最近 4 个不同敌人」——只约束彼此互异。
 * 纯查询无副作用、零随机；O(maxTargets × 敌人数)（maxTargets = 牌值 4，开销可忽略）。
 */
export function pickNearestDistinctEnemies(
  state: SimState,
  x: number,
  y: number,
  maxTargets: number,
  excludeIds?: number[],
): Enemy[] {
  const max = Math.max(0, Math.round(Number.isFinite(maxTargets) ? maxTargets : 0));
  const picked: Enemy[] = [];
  const enemies = state.enemies;
  const excluded = excludeIds ?? [];
  while (picked.length < max) {
    let best: Enemy | null = null;
    let bestDistSq = Infinity;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.dead || picked.indexOf(e) !== -1) {
        continue;
      }
      if (excluded.indexOf(e.id) !== -1) {
        continue;
      }
      const dx = e.x - x;
      const dy = e.y - y;
      const d = dx * dx + dy * dy;
      if (d < bestDistSq) {
        bestDistSq = d;
        best = e;
      }
    }
    if (!best) {
      break; // 存活敌人耗尽
    }
    picked.push(best);
  }
  return picked;
}

/**
 * 推进一帧弹丸（约定：
 * 1) grid.clear() 后把所有存活敌人按数组顺序 insert（含各自 radius），供本帧命中查询；
 * 2) 每枚弹：x += vx*dtSec、y += vy*dtSec、ttlMs -= dtMs；ttl 到期（<=0）→ dead（当帧不再命中）；
 * 3) 存活弹且非 noCollide 才参与命中：queryCircle(弹位置, 弹radius) 命中敌人（网格按圆相交
 *    精确过滤；T5 起结果复用模块级 hitScratch 缓冲，见其注释的安全性审计），hitIds 去重后
 *    每次命中：dealDamage（统一伤害入口，效果引擎结算扣血/击杀/
 *    事件/killHooks），随后 applyEffectsOnHit 把 effectsOnHit 模板附着到未死亡的敌人；再调
 *    行为命中钩子 onProjectileHit（伤害与附着结算完、穿透消耗之前；钩子可把弹标记 dead——
 *    标记后立即跳出，本帧剩余命中候选不再结算）；每次命中 pierceLeft -= 1，用尽（<=0）→
 *    弹 dead（即 pierce=2 总共命中 2 个敌人；pierce<=0 也能命中 1 个，保底不出现永不销毁）；
 * 4) noCollide 旗标（proj.data.noCollide === 1）：不参与命中结算，直线飞到 ttl（迫击榴弹
 *    「越过前排」等语义用）；死亡钩子照常在 ttl 到点触发；
 * 5) dead 弹（ttl 耗尽或穿透用尽，两条路径都恰好一次）先调行为死亡钩子 onProjectileDeath
 *    （此刻弹字段仍为死亡时刻值），再 release 回池；state.projectiles 清理用交换删除
 *    （O(1)，被换入者当帧继续处理）；
 * 6) 遍历顺序固定（数组顺序），全程不用 rng。
 * 7) 全局弹丸数量护栏（T3 性能封顶，防死亡螺旋）：帧首（over 检查之后、grid 重建之前）
 *    若 state.projectiles.length > config.maxProjectiles，把「id 最小的前超额数枚存活弹」
 *    只设 ttlMs = 0（不直接置 dead、不动其他字段）——它们在本帧循环内走标准 ttl 耗尽
 *    死亡路径：ttl<=0 → dead → onProjectileDeath 恰好一次 → 回池。行为钩子语义不破坏
 *    （迫击炮弹提前引爆、分裂弹正常消亡）。帧中分裂等新增弹导致的瞬间超额留到下一帧
 *    帧首回收。maxProjectiles <= 0 或非有限视为不设上限。
 * 行为钩子查找：proj.behavior 为空串（池默认，无所属行为）→ 无钩子；非空未注册名 → 抛错
 * （与 weapons.ts 的 fire 分发路径同款「数据表拼错尽早暴露」约定）。
 * state.over 非 null（模拟已结束）时直接 return（与 enemies/wall 同款防重入）。
 */
export function updateProjectiles(state: SimState, dtMs: number, grid: SpatialHash<Enemy>): void {
  if (state.over !== null) {
    return;
  }

  const enemies = state.enemies;
  const projectiles = state.projectiles;
  const dtSec = dtMs / 1000;

  // 0) 全局弹丸数量护栏：超额数通常很小，逐轮全量扫描取当前最小 id（确定性；ids 唯一）。
  //    候选限定「未 dead 且 ttl > 0」的存活弹：帧首存活弹恒有 ttl > 0（上一帧 ttl<=0 者已
  //    就地回收），标记 ttl=0 后即退出候选集，不会重复选中。
  const maxProjectiles = state.config.maxProjectiles;
  if (Number.isFinite(maxProjectiles) && maxProjectiles > 0 && projectiles.length > maxProjectiles) {
    const excess = projectiles.length - maxProjectiles;
    for (let k = 0; k < excess; k++) {
      let minIdx = -1;
      let minId = Infinity;
      for (let i = 0; i < projectiles.length; i++) {
        const p = projectiles[i]!;
        if (!p.dead && p.ttlMs > 0 && p.id < minId) {
          minId = p.id;
          minIdx = i;
        }
      }
      if (minIdx < 0) {
        break; // 无存活弹可标记（余下全是死弹，本帧循环会回收），防御性兜底
      }
      // 只归零 ttl：让标准 ttl 耗尽路径完成死亡（当帧循环内 dead → 钩子 → 回池）。
      projectiles[minIdx]!.ttlMs = 0;
    }
  }

  // 1) 重建空间网格（网格坐标 = 本帧命中查询阶段的实时坐标）。
  grid.clear();
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e.dead) {
      grid.insert(e, e.x, e.y, e.radius);
    }
  }

  // 2) 逐弹推进与命中；i 不自增即交换删除后原地重查（换入者未处理过）。
  for (let i = 0; i < projectiles.length; ) {
    const p = projectiles[i];
    // 行为钩子查找：空串（池默认）→ 无钩子；非空未注册名 → 抛错（尽早暴露）。
    const behavior = p.behavior === '' ? undefined : getBehavior(p.behavior);

    // 位移 + 寿命。
    p.x += p.vx * dtSec;
    p.y += p.vy * dtSec;
    p.ttlMs -= dtMs;
    if (p.ttlMs <= 0) {
      p.dead = true;
    } else if (p.data.noCollide !== 1) {
      // noCollide 弹（data.noCollide === 1）跳过整段命中结算，直线飞到 ttl。
      // T5：hits 复用模块级 hitScratch（见其注释的嵌套查询安全性审计），每帧零分配。
      const hits = grid.queryCircle(p.x, p.y, p.radius, hitScratch);
      for (let h = 0; h < hits.length; h++) {
        const enemy = hits[h];
        if (enemy.dead) {
          continue; // 本帧已被其他弹击杀：跳过
        }
        if (p.data.prismRecurse === 1 && p.data.returning !== 1) {
          if (p.hitIds.length > 0 && p.hitIds[p.hitIds.length - 1] === enemy.id) {
            continue;
          }
        } else {
          if (p.hitIds.indexOf(enemy.id) !== -1) {
            continue; // hitIds 去重：同一弹不重复伤害同一敌人
          }
        }

        p.hitIds.push(enemy.id);
        // 统一伤害入口（效果引擎）：受伤乘区（mark/corrode）+ 击杀结算
        // （hp<=0 → dead、pushEvent enemyKilled、依次调用 killHooks，行为与原内联实现等价）。
        dealDamage(state, enemy, p.damage);
        // 命中附着：把 effectsOnHit 模板实例化到敌人（untilMs 按当前时刻重算、data 深拷贝、
        // 走叠层/互斥规则）；击杀弹的致死一击不再附着（尸体无意义）。
        if (!enemy.dead) {
          applyEffectsOnHit(state, enemy, p.effectsOnHit);
        }

        // 音效事件（T4.1）：每次去重后的命中 push 一次 hit。门控：仅带 behavior 的
        // 弹丸发声——生产弹丸一律由行为 spawn 且带 behavior，无主裸弹（池默认空
        // behavior）不发声。推送经 pushSfxThrottled 按模拟时间粗滤（30ms 内同名只留
        // 首个），只影响 sfx 事件流密度、不影响命中结算；播放端节流器仍做细合并。
        if (p.behavior !== '') {
          pushSfxThrottled(state, 'hit', SFX_PUSH_MIN_INTERVAL_MS);
        }

        // 行为命中钩子：伤害与附着结算完、穿透消耗之前调用。钩子可把弹标记 dead
        // （如命中即爆）：标记后立即跳出，本帧剩余命中候选不再结算、穿透不再消耗，
        // 弹走下方死亡路径（onProjectileDeath 恰好一次 → 回池）。
        if (behavior?.onProjectileHit) {
          behavior.onProjectileHit(state, p, enemy);
          if (p.dead) {
            break;
          }
        }

        // 穿透结算：每次命中消耗 1，用尽即销毁（命中弹本身的这一击已结算）。
        p.pierceLeft -= 1;
        if (p.pierceLeft <= 0) {
          p.dead = true;
          break;
        }
      }
    }

    if (p.dead) {
      // 行为死亡钩子：ttl 耗尽与穿透用尽两条死亡路径都在回池之前恰好触发一次
      // （此刻弹字段仍为死亡时刻值，release 的 reset 尚未清洗）。
      if (behavior?.onProjectileDeath) {
        behavior.onProjectileDeath(state, p);
      }
      projectilePool.release(p);
      // 交换删除：末元素换到当前位（当帧继续处理），数组尾弹出，O(1)。
      const last = projectiles.pop()!;
      if (i < projectiles.length) {
        projectiles[i] = last;
      }
    } else {
      i++;
    }
  }
}
