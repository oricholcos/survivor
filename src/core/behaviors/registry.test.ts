// src/core/behaviors/registry.test.ts —— WeaponBehavior 生命周期钩子契约（T2.1b）：
// update 每帧被调（仅当武器已拥有且 def 存在）、onProjectileHit 在 dealDamage + effectsOnHit
// 结算后、穿透消耗之前收到 proj+enemy、钩子把弹标记 dead 后穿透逻辑兼容、onProjectileDeath
// 在 ttl 与 pierce 两条死亡路径都恰好一次且在回池之前（字段未被 reset）、noCollide 弹穿过
// 敌人不造成伤害且 ttl 到点触发死亡钩子。
import { describe, expect, it } from 'vitest';
import { hasEffect, registerEffectDef } from '../effects';
import { projectilePool, spawnProjectile, updateProjectiles } from '../projectiles';
import { createSimState } from '../simState';
import { SpatialHash } from '../spatialHash';
import type { Enemy, Projectile, SimState } from '../types';
import { addWeapon, updateWeapons } from '../weapons';
import type { WeaponDef } from '../weapons';
import { registerBehavior } from './registry';

/** 构造一个 WeaponDef 夹具（数值仅存在于测试夹具）。 */
function makeDef(behavior: string, id = 'test_gun'): WeaponDef {
  return {
    id,
    name: '测试枪',
    behavior,
    maxLevel: 10,
    base: { damage: 10, intervalMs: 800, projectileSpeed: 900, pierce: 2, ttlMs: 2000 },
    rangeKeys: [],
    cards: [],
  };
}

/** 构造一个静止敌人夹具（与 projectiles.test.ts 同构）。 */
function makeEnemy(state: SimState, x: number, y: number, hp = 100): Enemy {
  const e: Enemy = {
    id: state.nextId++,
    typeId: 'tester',
    name: '测试怪',
    x,
    y,
    radius: 10,
    hp,
    maxHp: hp,
    speed: 0,
    damage: 0,
    attackIntervalMs: 1000,
    attackCooldownMs: 1000,
    state: 'march',
    isBoss: false,
    xp: 1,
    color: 0xffffff,
    shape: 'box',
    effects: [],
    dead: false,
  };
  state.enemies.push(e);
  return e;
}

function makeGrid(): SpatialHash<Enemy> {
  return new SpatialHash<Enemy>(64);
}

/** 命中钩子探针记录：验证调用时机用的快照字段。 */
interface HitProbe {
  enemy: Enemy;
  /** 钩子时刻敌人血量（dealDamage 已结算则 < maxHp）。 */
  hpAtHook: number;
  /** 钩子时刻 effectsOnHit 是否已附着。 */
  hasEffectAtHook: boolean;
  /** 钩子时刻穿透剩余次数（穿透消耗之前则等于初值）。 */
  pierceAtHook: number;
  projId: number;
}

describe('update 钩子（weapons.ts 消费点）', () => {
  it('每帧被调一次（收到 dtMs），仅当该武器已拥有且 def 存在', () => {
    const calls: number[] = [];
    registerBehavior({
      name: 'hook_update_probe',
      fire: () => {},
      update: (_s, dtMs) => {
        calls.push(dtMs);
      },
    });
    const defs = { w: makeDef('hook_update_probe') };

    // 已拥有：每帧一次，先于冷却判定（本用例只断言调用节奏与参数）。
    const state = createSimState(1);
    addWeapon(state, 'w');
    updateWeapons(state, 50, defs);
    updateWeapons(state, 30, defs);
    expect(calls).toEqual([50, 30]);

    // 未拥有该武器：不调。
    const state2 = createSimState(1);
    updateWeapons(state2, 50, defs);
    expect(calls).toEqual([50, 30]);

    // def 缺失（weaponStates 有 ghost、defs 没有）：跳过钩子，不抛错。
    const state3 = createSimState(1);
    addWeapon(state3, 'ghost');
    expect(() => updateWeapons(state3, 50, defs)).not.toThrow();
    expect(calls).toEqual([50, 30]);

    // 模拟已结束：整体停摆，不调。
    const state4 = createSimState(1);
    addWeapon(state4, 'w');
    state4.over = 'defeat';
    updateWeapons(state4, 50, defs);
    expect(calls).toEqual([50, 30]);
  });
});

describe('onProjectileHit 钩子（projectiles.ts 消费点）', () => {
  it('在 dealDamage 与 effectsOnHit 结算之后、穿透消耗之前收到 proj + enemy', () => {
    registerEffectDef({
      id: 'hook_probe_effect',
      name: '钩子探测效果',
      durationMs: 1000,
      maxStacks: 1,
      refresh: 'reset',
    });
    let probe: HitProbe | null = null;
    registerBehavior({
      name: 'hook_hit_probe',
      fire: () => {},
      onProjectileHit: (_s, proj, enemy) => {
        probe = {
          enemy,
          hpAtHook: enemy.hp,
          hasEffectAtHook: hasEffect(enemy, 'hook_probe_effect'),
          pierceAtHook: proj.pierceLeft,
          projId: proj.id,
        };
      },
    });

    const state = createSimState(1);
    const e = makeEnemy(state, 400, 600, 50);
    const p = spawnProjectile(state, {
      behavior: 'hook_hit_probe',
      x: 300,
      y: 600,
      vx: 100,
      vy: 0,
      damage: 10,
      pierceLeft: 5,
      ttlMs: 5000,
      effectsOnHit: [{ kind: 'hook_probe_effect', untilMs: 0, stacks: 1, data: {} }],
    });

    updateProjectiles(state, 1000, makeGrid()); // x 300 → 400：命中

    expect(probe).toEqual({
      enemy: e,
      hpAtHook: 40, // 伤害已在钩子前结算（50 - 10）
      hasEffectAtHook: true, // effectsOnHit 已在钩子前附着
      pierceAtHook: 5, // 穿透尚未消耗
      projId: p.id,
    });
    // 钩子之后穿透照常消耗。
    expect(p.pierceLeft).toBe(4);
    expect(p.dead).toBe(false);
  });

  it('钩子把弹标记 dead：本帧剩余命中候选不再结算、穿透不再消耗，死亡路径恰好一次', () => {
    const hits: Projectile[] = [];
    const deaths: Projectile[] = [];
    registerBehavior({
      name: 'hook_hit_boom',
      fire: () => {},
      onProjectileHit: (_s, proj) => {
        hits.push(proj);
        proj.dead = true; // 命中即爆
      },
      onProjectileDeath: (_s, proj) => {
        deaths.push(proj);
      },
    });

    const state = createSimState(1);
    // 两敌同帧都在查询圆内（395/408 距弹 400 分别 5px/8px ≤ 6+10）：钩子击杀后第二个不再结算。
    const e1 = makeEnemy(state, 395, 600);
    const e2 = makeEnemy(state, 408, 600);
    const p = spawnProjectile(state, {
      behavior: 'hook_hit_boom',
      x: 300,
      y: 600,
      vx: 400,
      vy: 0,
      damage: 10,
      pierceLeft: 5,
      ttlMs: 5000,
    });

    updateProjectiles(state, 250, makeGrid());

    expect(e1.hp).toBe(90); // 首个候选：伤害已结算
    expect(e2.hp).toBe(100); // 剩余候选：弹已 dead，跳过
    expect(hits).toEqual([p]);
    expect(deaths).toEqual([p]); // 死亡钩子恰好一次
    expect(state.projectiles.length).toBe(0); // 已回池移除

    // 后续帧不再触发。
    updateProjectiles(state, 250, makeGrid());
    expect(deaths).toEqual([p]);
  });
});

describe('onProjectileDeath 钩子（projectiles.ts 消费点）', () => {
  it('ttl 耗尽路径：恰好一次、release 回池之前（钩子里读到未被 reset 的字段）', () => {
    let deathSnap: { x: number; ttlMs: number; hitCount: number; id: number } | null = null;
    registerBehavior({
      name: 'hook_death_ttl',
      fire: () => {},
      onProjectileDeath: (_s, proj) => {
        deathSnap = { x: proj.x, ttlMs: proj.ttlMs, hitCount: proj.hitIds.length, id: proj.id };
      },
    });

    const state = createSimState(1);
    const p = spawnProjectile(state, {
      behavior: 'hook_death_ttl',
      x: 100,
      y: 0,
      vx: 200,
      vy: 0,
      ttlMs: 50,
    });
    const pid = p.id; // 回池 reset 会把 id 清 0：期望值必须在更新前捕获
    const pooledBefore = projectilePool.pooledCount;

    updateProjectiles(state, 100, makeGrid()); // ttl 50 - 100 → 到期

    // 钩子拿到的是死亡时刻值（reset 会把 x 归 0、ttlMs 归 0、清空 hitIds）——证明在回池之前。
    expect(deathSnap).toEqual({ x: 120, ttlMs: -50, hitCount: 0, id: pid });
    expect(state.projectiles.length).toBe(0);
    expect(projectilePool.pooledCount).toBe(pooledBefore + 1);
  });

  it('pierce 用尽路径：恰好一次，与 ttl 路径互斥（不重复触发）', () => {
    const deaths: Projectile[] = [];
    registerBehavior({
      name: 'hook_death_pierce',
      fire: () => {},
      onProjectileDeath: (_s, proj) => {
        deaths.push(proj);
      },
    });

    const state = createSimState(1);
    const e = makeEnemy(state, 400, 600, 100000); // 大血量：不被击杀
    const p = spawnProjectile(state, {
      behavior: 'hook_death_pierce',
      x: 300,
      y: 600,
      vx: 400,
      vy: 0,
      damage: 10,
      pierceLeft: 0, // 保底命中 1 个后销毁
      ttlMs: 5000,
    });

    updateProjectiles(state, 250, makeGrid()); // x 300 → 400：命中 → pierce -1 → dead

    expect(e.hp).toBe(99990);
    expect(deaths).toEqual([p]); // 恰好一次（ttl 未到期，不叠加触发）
    expect(state.projectiles.length).toBe(0);

    updateProjectiles(state, 250, makeGrid());
    expect(deaths).toEqual([p]); // 后续帧不再触发
  });
});

describe('noCollide 直通旗标（proj.data.noCollide === 1）', () => {
  it('穿过敌人不造成伤害、不触发 onProjectileHit；ttl 到点死亡触发 onProjectileDeath', () => {
    let hitCalls = 0;
    const deaths: number[] = []; // 记录死亡钩子时刻的弹 x
    registerBehavior({
      name: 'hook_nocollide',
      fire: () => {},
      onProjectileHit: () => {
        hitCalls += 1;
      },
      onProjectileDeath: (_s, proj) => {
        deaths.push(proj.x);
      },
    });

    const state = createSimState(1);
    const e = makeEnemy(state, 400, 600, 50); // 弹道正中
    const p = spawnProjectile(state, {
      behavior: 'hook_nocollide',
      x: 300,
      y: 600,
      vx: 400,
      vy: 0,
      damage: 10,
      pierceLeft: 3,
      ttlMs: 600,
      data: { noCollide: 1 },
    });

    // 第 1 帧：x 300 → 400，与敌人重叠但不参与命中结算。
    updateProjectiles(state, 250, makeGrid());
    expect(p.x).toBe(400); // 穿过了敌人位置
    expect(e.hp).toBe(50); // 不造成伤害
    expect(hitCalls).toBe(0); // 不触发命中钩子
    expect(p.dead).toBe(false);

    // 第 2 帧：ttl 350 - 400 → 到期死亡，死亡钩子照常触发（直线飞到 ttl）。
    updateProjectiles(state, 400, makeGrid());
    expect(deaths).toEqual([560]); // x 400 + 400*0.4，钩子时刻未被 reset
    expect(state.projectiles.length).toBe(0);
    updateProjectiles(state, 100, makeGrid());
    expect(deaths).toEqual([560]); // 恰好一次
  });
});
