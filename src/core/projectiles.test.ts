// src/core/projectiles.test.ts —— 弹丸系统行为契约：
// 命中扣血 + hitIds 去重、穿透后继续命中第二个、超穿透上限销毁、击杀事件与 killHooks、
// 对象池复用（弹死后新 spawn 复用同一实例引用）、全局弹丸数量护栏（超限按 id 最小回收）。
import { describe, expect, it } from 'vitest';
import './behaviors/index'; // 副作用 import：注册全部真实行为（迫击炮爆炸用例）
import { registerBehavior } from './behaviors/registry';
import { drainEvents } from './events';
import {
  killHooks,
  pickNearestDistinctEnemies,
  projectilePool,
  spawnProjectile,
  updateProjectiles,
} from './projectiles';
import { createSimState } from './simState';
import { SpatialHash } from './spatialHash';
import type { Enemy, SimState } from './types';

/** 构造一个静止敌人夹具（数值仅存在于测试夹具）。 */
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

describe('updateProjectiles 命中与穿透', () => {
  it('命中扣血；停留原地重复查询不重复扣血（hitIds 去重）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 400, 600, 50);
    const p = spawnProjectile(state, { x: 300, y: 600, vx: 100, vy: 0, damage: 10, pierceLeft: 5, ttlMs: 5000 });

    // dt 1s：x 300 → 400，与敌人（半径 10）圆相交 → 命中
    updateProjectiles(state, 1000, makeGrid());
    expect(e.hp).toBe(40);
    expect(p.dead).toBe(false);
    expect(p.pierceLeft).toBe(4); // 命中一次消耗 1
    expect(p.hitIds).toEqual([e.id]);

    // 原地滞留再查两帧：hitIds 去重，不重复扣血
    updateProjectiles(state, 0, makeGrid());
    updateProjectiles(state, 0, makeGrid());
    expect(e.hp).toBe(40);
    expect(p.pierceLeft).toBe(4);
  });

  it('穿透后继续命中与弹同一直线上的第二个敌人', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 400, 600, 50);
    const e2 = makeEnemy(state, 500, 600, 50);
    const p = spawnProjectile(state, { x: 300, y: 600, vx: 400, vy: 0, damage: 10, pierceLeft: 2, ttlMs: 5000 });

    // 第一帧 x=400：命中 e1，pierceLeft 2→1，弹继续存活
    updateProjectiles(state, 250, makeGrid());
    const activeAfterFirstFrame = projectilePool.activeCount;
    expect(e1.hp).toBe(40);
    expect(e2.hp).toBe(50);
    expect(p.dead).toBe(false);

    // 第二帧 x=500：命中 e2，pierceLeft 1→0 → 弹销毁回池（release 已 reset，观察移除与回池）
    updateProjectiles(state, 250, makeGrid());
    expect(e2.hp).toBe(40);
    expect(state.projectiles.length).toBe(0);
    expect(projectilePool.activeCount).toBe(activeAfterFirstFrame - 1);
  });

  it('超穿透上限销毁：pierce=2 命中 2 个后 dead，不再伤第 3 个', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 400, 600, 50);
    const e2 = makeEnemy(state, 500, 600, 50);
    const e3 = makeEnemy(state, 600, 600, 50);
    spawnProjectile(state, { x: 300, y: 600, vx: 400, vy: 0, damage: 10, pierceLeft: 2, ttlMs: 5000 });

    updateProjectiles(state, 250, makeGrid()); // 命中 e1
    updateProjectiles(state, 250, makeGrid()); // 命中 e2 → pierceLeft 0 → 销毁
    expect(state.projectiles.length).toBe(0); // 已回池移除

    // 第三帧：弹已消失，e3 不受伤
    updateProjectiles(state, 250, makeGrid());
    expect(e1.hp).toBe(40);
    expect(e2.hp).toBe(40);
    expect(e3.hp).toBe(50);
  });
});

describe('击杀结算', () => {
  it('死亡敌人触发 enemyKilled 事件与 killHooks 回调（各恰好一次）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 400, 600, 10);
    const hookedEnemies: Enemy[] = [];
    const hook = (s: SimState, enemy: Enemy): void => {
      hookedEnemies.push(enemy);
      s.meta.hookRan = true;
    };
    killHooks.push(hook);
    try {
      spawnProjectile(state, { x: 300, y: 600, vx: 100, vy: 0, damage: 10, pierceLeft: 5, ttlMs: 5000 });
      updateProjectiles(state, 1000, makeGrid());

      expect(e.dead).toBe(true);
      expect(hookedEnemies).toEqual([e]); // 恰好一次，且拿到敌人引用
      expect(state.meta.hookRan).toBe(true);
      expect(drainEvents(state)).toEqual([
        { kind: 'enemyKilled', enemyId: e.id, typeId: 'tester', x: 400, y: 600, isBoss: false },
      ]);
    } finally {
      const idx = killHooks.indexOf(hook);
      if (idx >= 0) {
        killHooks.splice(idx, 1); // 模块级钩子表：测试后清理，避免跨用例污染
      }
    }
  });
});

describe('对象池复用', () => {
  it('弹死后新 spawn 复用同一实例引用，且字段被清洗/覆盖', () => {
    const state = createSimState(1);
    const pooledBefore = projectilePool.pooledCount; // 池为模块级单例：用相对值断言，不受前序用例影响
    const p1 = spawnProjectile(state, { x: 0, y: 0, vx: 100, vy: 0, ttlMs: 50 });
    const activeBefore = projectilePool.activeCount;

    // dt 100ms > ttl 50ms：寿命到期 → dead → release 回池（release 会 reset 清洗字段，
    // 死亡的可观测信号 = 从场上移除 + 池内空闲数 +1）
    updateProjectiles(state, 100, makeGrid());
    expect(state.projectiles.length).toBe(0);
    expect(projectilePool.pooledCount).toBe(pooledBefore + 1);
    expect(projectilePool.activeCount).toBe(activeBefore - 1);

    const p2 = spawnProjectile(state, {
      behavior: 'reused_bolt',
      x: 5,
      y: 7,
      vx: -50,
      vy: 25,
      damage: 7,
      radius: 9,
      pierceLeft: 3,
      ttlMs: 900,
    });
    expect(p2).toBe(p1); // LIFO：复用同一实例引用
    expect(p2.id).toBe(2); // id 重新分配（state.nextId++）
    expect(p2.behavior).toBe('reused_bolt');
    expect(p2.x).toBe(5);
    expect(p2.vx).toBe(-50);
    expect(p2.damage).toBe(7);
    expect(p2.radius).toBe(9);
    expect(p2.pierceLeft).toBe(3);
    expect(p2.hitIds).toEqual([]); // 复用前已清洗
    expect(p2.dead).toBe(false);
  });
});

describe('pickNearestDistinctEnemies（T5.3b 分裂次级弹目标选取助手）', () => {
  it('最近优先且互不相同：逐轮取当前最近者、选中即排除（平距取数组先出现者）', () => {
    const state = createSimState(1);
    // 距 (500, 800)：a=50、b=100、c=150（数组序 a<b<c）
    const a = makeEnemy(state, 500, 750, 1e6);
    const b = makeEnemy(state, 500, 700, 1e6);
    const c = makeEnemy(state, 500, 650, 1e6);
    const picked = pickNearestDistinctEnemies(state, 500, 800, 3);
    expect(picked).toEqual([a, b, c]); // 严格按距离升序、互不重复

    // 平距裁决：两点同距 → 数组先出现者先选中
    const state2 = createSimState(1);
    const left = makeEnemy(state2, 460, 800, 1e6); // 距 40（先入数组）
    makeEnemy(state2, 540, 800, 1e6); // 距 40（后入数组）
    expect(pickNearestDistinctEnemies(state2, 500, 800, 2)[0]).toBe(left);
  });

  it('maxTargets 截断（4 个候选只取 3 → 3 个）；候选不足 → 有几个取几个', () => {
    const state = createSimState(1);
    const a = makeEnemy(state, 500, 790, 1e6);
    const b = makeEnemy(state, 500, 780, 1e6);
    const c = makeEnemy(state, 500, 770, 1e6);
    makeEnemy(state, 500, 760, 1e6);
    expect(pickNearestDistinctEnemies(state, 500, 800, 3)).toEqual([a, b, c]);

    const few = createSimState(1);
    const x = makeEnemy(few, 500, 790, 1e6);
    expect(pickNearestDistinctEnemies(few, 500, 800, 4)).toEqual([x]); // 1 个候选也要 1 枚次级弹
    expect(pickNearestDistinctEnemies(few, 500, 800, 4)).toHaveLength(1); // 幂等：不改变状态
  });

  it('死者跳过；空场/非法 maxTargets → 空数组', () => {
    const state = createSimState(1);
    const corpse = makeEnemy(state, 500, 790, 1e6);
    corpse.dead = true;
    const alive = makeEnemy(state, 500, 780, 1e6);
    expect(pickNearestDistinctEnemies(state, 500, 800, 4)).toEqual([alive]);

    const empty = createSimState(1);
    expect(pickNearestDistinctEnemies(empty, 500, 800, 4)).toEqual([]);
    expect(pickNearestDistinctEnemies(empty, 500, 800, Number.NaN)).toEqual([]);
    expect(pickNearestDistinctEnemies(empty, 500, 800, -3)).toEqual([]);
  });
});

// —— F2 扫掠碰撞（隧穿修复）测试 ——
// 修复前的命中判定是离散点查询：每步先移动弹（x += vx*dt），再对「新位置」做 queryCircle。
// 弹速 1600px/s（蓄能狙击 base）× 帧上限 50ms → 单步位移 80px，远超命中阈值
// （弹 6 + 敌 10~34 ≈ 16~40px）：低速档/掉帧时弹会从相邻两采样点之间穿过敌人（隧穿），
// 表现为「高速弹穿过主目标不掉血」。扫掠碰撞改为「本步位移线段」对敌圆的点-线段距离判交，
// 命中按沿段先后次序结算，任意 dt 下满足不变式「弹轨迹与敌圆相交则至少结算一次」。
describe('弹丸扫掠碰撞（F2 隧穿修复）', () => {
  it('隧穿复现：高速弹 + 粗 dt（50ms），敌位于相邻两离散采样点之间——修复前必漏、修复后必中', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 440, 600, 1e6);
    // 弹速 1600px/s、dt 50ms → 单步位移恒 80px，离散采样点恒为 x=80k；
    // 敌心 x=440 距最近采样点（400 与 480）均 40px > 阈值 16px（弹 6 + 敌 10）
    // → 修复前任何一帧的点查询都不会命中，弹径直穿过并飞到 ttl。
    spawnProjectile(state, { x: 0, y: 600, vx: 1600, vy: 0, damage: 10, pierceLeft: 0, ttlMs: 5000 });
    for (let f = 0; f < 12 && state.projectiles.length > 0; f++) {
      updateProjectiles(state, 50, makeGrid());
    }
    expect(e.hp).toBe(1e6 - 10); // 扫掠段 [400,480] 覆盖敌心：必中
    expect(state.projectiles).toHaveLength(0); // 非穿透弹命中即销毁回池
  });

  it('段上两敌按沿段先后次序结算：先碰到的先结算，穿透计数按次扣减', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 420, 600, 1e6); // 段 [400,480] 上 t=0.25（先碰到）
    const e2 = makeEnemy(state, 470, 600, 1e6); // t=0.875（后碰到）
    // pierceLeft 5 > 2：两敌结算后弹仍存活（死亡弹已回池 reset，hitIds 不可观测）
    const p = spawnProjectile(state, { x: 400, y: 600, vx: 1600, vy: 0, damage: 10, pierceLeft: 5, ttlMs: 5000 });
    updateProjectiles(state, 50, makeGrid());

    expect(e1.hp).toBe(1e6 - 10); // 修复前点查询只够到 e2（|480-470|=10≤16）、漏掉 e1
    expect(e2.hp).toBe(1e6 - 10);
    expect(p.hitIds).toEqual([e1.id, e2.id]); // 严格按沿段先后次序
    expect(p.pierceLeft).toBe(3); // 每次命中扣 1（5 - 2）
    expect(state.projectiles).toHaveLength(1);
  });

  it('非穿透弹只结算段上最近（最先碰到）的一敌即销毁，后续敌不受波及', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 420, 600, 1e6);
    const e2 = makeEnemy(state, 470, 600, 1e6);
    spawnProjectile(state, { x: 400, y: 600, vx: 1600, vy: 0, damage: 10, pierceLeft: 0, ttlMs: 5000 });
    updateProjectiles(state, 50, makeGrid());

    expect(e1.hp).toBe(1e6 - 10); // 最近（t 最小）者先结算
    expect(e2.hp).toBe(1e6); // 非穿透：第一击即亡，第二敌不结算
    expect(state.projectiles).toHaveLength(0);
  });

  it('敌恰在线段延长线上但不相交：本帧不结算，下帧进入段内才结算', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 530, 600, 1e6); // 距段 [400,480] 终点 50px > 阈值 16px
    spawnProjectile(state, { x: 400, y: 600, vx: 1600, vy: 0, damage: 10, pierceLeft: 0, ttlMs: 5000 });
    updateProjectiles(state, 50, makeGrid());
    expect(e.hp).toBe(1e6); // 延长线上不相交：不提前结算

    updateProjectiles(state, 50, makeGrid()); // 段 [480,560] 覆盖敌心 530
    expect(e.hp).toBe(1e6 - 10);
    expect(state.projectiles).toHaveLength(0); // 非穿透命中即销毁回池
  });

  it('两敌重叠（同 t）都相交：按敌 id 升序确定性结算，穿透弹两敌都中', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 440, 590, 1e6); // 垂距 10 ≤ 16，t 与 e2 相同
    const e2 = makeEnemy(state, 440, 610, 1e6);
    const p = spawnProjectile(state, { x: 400, y: 600, vx: 1600, vy: 0, damage: 10, pierceLeft: 5, ttlMs: 5000 });
    updateProjectiles(state, 50, makeGrid());

    expect(e1.hp).toBe(1e6 - 10);
    expect(e2.hp).toBe(1e6 - 10);
    expect(p.hitIds).toEqual([e1.id, e2.id]); // 并列 t → id 升序（确定性裁决）
  });

  it('一段内敌人多于剩余计数：按沿段次序结算至计数耗尽，余敌不受波及', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 410, 600, 1e6);
    const e2 = makeEnemy(state, 440, 600, 1e6);
    const e3 = makeEnemy(state, 470, 600, 1e6);
    spawnProjectile(state, { x: 400, y: 600, vx: 1600, vy: 0, damage: 10, pierceLeft: 1, ttlMs: 5000 });
    updateProjectiles(state, 50, makeGrid());

    expect(e1.hp).toBe(1e6 - 10);
    expect(e2.hp).toBe(1e6); // 计数已在 e1 耗尽
    expect(e3.hp).toBe(1e6);
    expect(state.projectiles).toHaveLength(0);
  });

  it('不变式：任意 dt 下一帧轨迹与敌圆相交则至少结算一次（1~50ms 全档）', () => {
    for (const dt of [1, 3, 8, 16.6, 33, 50]) {
      const state = createSimState(1);
      const e = makeEnemy(state, 440, 600, 1e6);
      const p = spawnProjectile(state, { x: 0, y: 600, vx: 1600, vy: 0, damage: 10, pierceLeft: 0, ttlMs: 10000 });
      // 以「弹仍在场上」为循环条件：命中即回池 reset（p.dead/p.x 被清洗），不可据 p 字段判停。
      while (state.projectiles.length > 0 && p.x < 500) {
        updateProjectiles(state, dt, makeGrid());
      }
      expect(e.hp, `dt=${dt}ms：轨迹扫过敌圆必须至少结算一次`).toBe(1e6 - 10);
      expect(state.projectiles, `dt=${dt}ms：非穿透弹命中后销毁`).toHaveLength(0);
    }
  });

  it('零长帧（dt=0）退化为原位置点查询：hitIds 去重不重复扣血（原契约保持）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 406, 600, 1e6); // 距弹 6px ≤ 16：相交
    const p = spawnProjectile(state, { x: 400, y: 600, vx: 0, vy: 0, damage: 10, pierceLeft: 5, ttlMs: 5000 });
    updateProjectiles(state, 0, makeGrid());
    updateProjectiles(state, 0, makeGrid());
    expect(e.hp).toBe(1e6 - 10); // 恰好一次
    expect(p.pierceLeft).toBe(4);
  });

  it('命中钩子改变速度（如弹跳转向）时立即打断扫掠：后续原轨迹敌人不受波及', () => {
    const state = createSimState(1);
    const e1 = makeEnemy(state, 420, 600, 100);
    const e2 = makeEnemy(state, 460, 600, 100);
    registerBehavior({
      name: 'turn_on_hit_test',
      fire: () => {},
      onProjectileHit: (_s, p) => {
        // 击中后转向 90 度向上
        p.vx = 0;
        p.vy = -1000;
      },
    });

    spawnProjectile(state, {
      behavior: 'turn_on_hit_test',
      x: 400,
      y: 600,
      vx: 1600,
      vy: 0,
      damage: 10,
      pierceLeft: 5,
      ttlMs: 5000,
    });

    // 这一帧位移线段从 400 到 480，原本包含 e1(420) 和 e2(460)
    updateProjectiles(state, 50, makeGrid());

    // e1 应该受击并触发转向
    expect(e1.hp).toBe(90);
    // e2 在原轨迹后续，但不应受击（转向打断了扫掠）
    expect(e2.hp).toBe(100);
    expect(state.projectiles).toHaveLength(1);
    expect(state.projectiles[0]!.vx).toBe(0);
    expect(state.projectiles[0]!.vy).toBe(-1000);
  });
});

describe('全局弹丸数量护栏（T3 性能封顶）', () => {
  /** 注册一个只记录死亡时刻字段快照的测试行为（registry 同名后注册者胜，测试名唯一不污染他人）。 */
  function spyDeathBehavior(): Array<{ id: number; ttlMs: number; damage: number; pierceLeft: number }> {
    const deaths: Array<{ id: number; ttlMs: number; damage: number; pierceLeft: number }> = [];
    registerBehavior({
      name: 'cap_test_bolt',
      fire: () => {},
      onProjectileDeath: (_state, p) => {
        deaths.push({ id: p.id, ttlMs: p.ttlMs, damage: p.damage, pierceLeft: p.pierceLeft });
      },
    });
    return deaths;
  }

  it('超限：id 最小的超额弹只归零 ttl 走标准死亡路径（钩子恰好一次、其余字段不动、未超限弹零影响）', () => {
    const deaths = spyDeathBehavior();
    const state = createSimState(1, { maxProjectiles: 2 });
    for (let i = 0; i < 3; i++) {
      spawnProjectile(state, {
        behavior: 'cap_test_bolt',
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        damage: 7,
        pierceLeft: 3,
        ttlMs: 5000,
      });
    }
    expect(state.projectiles.map((p) => p.id)).toEqual([1, 2, 3]);

    updateProjectiles(state, 1000, makeGrid());

    // 超额 1 枚：id 最小的 1 号弹被回收。钩子在 ttl 耗尽路径上收到 ttl<=0（证明走的是
    // ttl 归零而非直接置 dead——直接置 dead 的话钩子看到的仍是原 ttl 5000），
    // 伤害/穿透等字段未被护栏篡改；且恰好触发一次。
    expect(deaths).toEqual([{ id: 1, ttlMs: -1000, damage: 7, pierceLeft: 3 }]);
    // 未超限弹零影响：{2,3} 存活、寿命只按正常 dt 递减（交换删除会重排数组序，比集合）。
    expect([...state.projectiles].map((p) => p.id).sort((a, b) => a - b)).toEqual([2, 3]);
    expect(state.projectiles.map((p) => p.ttlMs)).toEqual([4000, 4000]);
  });

  it('超额多枚：一帧内全部按 id 升序回收（4 弹 max=2 → 1、2 号回收，3、4 号存活）', () => {
    const deaths = spyDeathBehavior();
    const state = createSimState(1, { maxProjectiles: 2 });
    for (let i = 0; i < 4; i++) {
      spawnProjectile(state, { behavior: 'cap_test_bolt', x: 0, y: 0, vx: 0, vy: 0, ttlMs: 5000 });
    }
    updateProjectiles(state, 1000, makeGrid());
    expect(deaths.map((d) => d.id)).toEqual([1, 2]); // id 最小的前超额数枚，顺序确定
    expect([...state.projectiles].map((p) => p.id).sort((a, b) => a - b)).toEqual([3, 4]);
  });

  it('未超限（length === max）零影响：无标记、无死亡、寿命正常递减', () => {
    const deaths = spyDeathBehavior();
    const state = createSimState(1, { maxProjectiles: 2 });
    spawnProjectile(state, { behavior: 'cap_test_bolt', x: 0, y: 0, vx: 0, vy: 0, ttlMs: 5000 });
    spawnProjectile(state, { behavior: 'cap_test_bolt', x: 0, y: 0, vx: 0, vy: 0, ttlMs: 5000 });
    updateProjectiles(state, 1000, makeGrid());
    expect(deaths).toEqual([]);
    expect(state.projectiles.map((p) => p.ttlMs)).toEqual([4000, 4000]);
  });

  it('行为钩子语义不破坏：被回收的迫击炮弹走 ttl 死亡路径提前引爆（AoE 爆炸照常结算）', () => {
    const state = createSimState(1, { maxProjectiles: 1 });
    const e = makeEnemy(state, 500, 800, 100);
    // 迫击炮弹（id 1，noCollide 曲射弹，落点快照在 data）：被护栏回收 → ttl 归零 →
    // onProjectileDeath 在落点引爆全额 AoE。
    spawnProjectile(state, {
      behavior: 'mortar',
      x: 400,
      y: 700,
      vx: 0,
      vy: 0,
      damage: 10,
      ttlMs: 5000,
      data: { tx: 500, ty: 800, aoeRadius: 60, splashFactor: 1, splitReady: 0 },
    });
    spawnProjectile(state, { x: 0, y: 0, vx: 0, vy: 0, ttlMs: 5000 }); // 裸弹（id 2）
    updateProjectiles(state, 1000, makeGrid());
    expect(e.hp).toBe(90); // 爆炸伤害 10 × splashFactor 1 全额结算
    expect(state.projectiles).toHaveLength(1); // 榴弹已回池，只剩未超限的裸弹
    // makeEnemy 占用 id 1 → 榴弹 id 2（被回收）、裸弹 id 3。
    expect(state.projectiles[0]!.behavior).toBe('');
    expect(state.projectiles[0]!.id).toBe(3);
  });
});
