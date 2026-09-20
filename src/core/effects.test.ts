// src/core/effects.test.ts —— 通用效果槽引擎逐类断言：
// 燃烧逐 tick（间隔/总伤害/来源致死走 dealDamage）、击退冲量方向与钳制、减速乘区（含叠层
// 与多实例 min）、眩晕停行动（行军不位移 / 攻击态不攻击且冷却冻结）、标记受伤加成、
// 黑洞向爆心位移（120px 上限 + 2s 免疫、墙线钳制）、过热间隔拉长与到期恢复、叠层/互斥/refresh 语义、
// 同种子可复现、applyEffectsOnHit 模板实例化、弹丸命中集成（dealDamage 改道 + effectsOnHit）。
// 数值来源：内置效果走 src/data/effects.json（经 loadEffectDefs 注册）；
// 仅组合规则测试注入两个夹具定义（web / frostbite），数值仅存在于本测试文件。

import { describe, expect, it } from 'vitest';
import { registerBehavior } from './behaviors/registry';
import {
  applyEffect,
  applyEffectsOnHit,
  damageTakenFactor,
  dealDamage,
  effectStacks,
  getEffectDef,
  hasEffect,
  isStunned,
  listEffectDefs,
  overheatFactor,
  registerEffectDef,
  speedMultiplier,
  updateEffects,
} from './effects';
import { loadEffectDefs } from '../data/effects';
import { spawnEnemy, updateEnemies, type EnemyTypeData } from './enemies';
import { drainEvents } from './events';
import { killHooks, spawnProjectile, updateProjectiles } from './projectiles';
import { createSimState } from './simState';
import { SpatialHash } from './spatialHash';
import type { EffectInstance, Enemy, SimState } from './types';
import { updateWallCombat } from './wall';
import { addWeapon, updateWeapons, type WeaponDef } from './weapons';

// 内置效果定义表（effects.json）注册进 core/effects 注册表。
loadEffectDefs();

// 组合规则夹具定义（非内置 kind；数值仅存在于本测试）：
// web —— 无互斥组的第二减速源，用于锁定「多实例 speedFactor 取 min」；
// frostbite —— slow_family 组内与 chill 同 potency 的第三者，用于锁定「同强拒绝新效果」。
registerEffectDef({
  id: 'web',
  name: '蛛网',
  durationMs: 3000,
  maxStacks: 1,
  refresh: 'reset',
  speedFactor: 0.8,
});
registerEffectDef({
  id: 'frostbite',
  name: '冻伤',
  durationMs: 1000,
  maxStacks: 1,
  refresh: 'reset',
  speedFactor: 0.9,
  exclusiveGroup: 'slow_family',
  potency: 1,
});

/** 推进效果系统一帧（updateEffects 不推进 timeMs——step 才推进；单测手动对齐）。 */
function advance(state: SimState, dtMs: number): void {
  state.timeMs += dtMs;
  updateEffects(state, dtMs);
}

/** 敌人夹具（静止、不在场地上自动行动；数值仅存在于测试）。 */
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

/** 贴墙攻击态敌人夹具（同 wall.test 款式）。 */
function makeAttacker(state: SimState, overrides?: Partial<Enemy>): Enemy {
  const e: Enemy = {
    id: state.nextId++,
    typeId: 'tester',
    name: '测试怪',
    x: 360,
    y: 1160,
    radius: 12,
    hp: 10,
    maxHp: 10,
    speed: 0,
    damage: 5,
    attackIntervalMs: 1000,
    attackCooldownMs: 1000,
    state: 'attack',
    isBoss: false,
    xp: 1,
    color: 0xff0000,
    shape: 'box',
    effects: [],
    dead: false,
    ...overrides,
  };
  state.enemies.push(e);
  return e;
}

/** 行军敌人类型夹具（同 enemies.test 款式）。 */
function makeType(overrides?: Partial<EnemyTypeData>): EnemyTypeData {
  return {
    id: 'testling',
    name: '测试怪',
    shape: 'square',
    color: 0x00ff00,
    hp: 30,
    speed: 60,
    damage: 5,
    attackIntervalMs: 1000,
    xp: 1,
    radius: 12,
    isBoss: false,
    ...overrides,
  };
}

describe('数据表与注册表', () => {
  it('loadEffectDefs 注册全部 10 个内置 kind；关键定义数值与 effects.json 一致', () => {
    const names = listEffectDefs();
    for (const kind of [
      'burn', 'poison', 'slow', 'chill', 'stun',
      'mark', 'knockback', 'blackhole', 'overheat', 'corrode',
    ]) {
      expect(names).toContain(kind);
    }
    expect(getEffectDef('burn')).toEqual({
      id: 'burn', name: '燃烧', durationMs: 3000, tickMs: 500,
      maxStacks: 1, refresh: 'reset', damagePerTick: 3,
    });
    expect(getEffectDef('knockback')).toEqual({
      id: 'knockback', name: '击退', durationMs: 0,
      maxStacks: 1, refresh: 'reset', force: 60,
    });
    expect(getEffectDef('slow').exclusiveGroup).toBe('slow_family');
    expect(getEffectDef('chill').exclusiveGroup).toBe('slow_family');
  });

  it('未注册 kind：applyEffect / getEffectDef 抛错（尽早暴露拼写错误）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 0, 0);
    expect(() => applyEffect(state, e, 'definitely_not_registered_xyz')).toThrow();
    expect(() => getEffectDef('definitely_not_registered_xyz')).toThrow();
  });
});

describe('burn 燃烧：逐 tick 结算', () => {
  it('每 500ms 一跳、每跳 3 点：3000ms 内恰好 6 跳共 18 点，随后到期移除', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 400, 600, 100);
    applyEffect(state, e, 'burn');
    expect(hasEffect(e, 'burn')).toBe(true);
    expect(effectStacks(e, 'burn')).toBe(1);

    for (let k = 1; k <= 6; k++) {
      advance(state, 500);
      expect(e.hp).toBe(100 - 3 * k); // 每跳精确扣 3
    }
    // 第 6 跳恰落在 untilMs 当帧：先结算后移除
    expect(e.hp).toBe(82);
    expect(hasEffect(e, 'burn')).toBe(false);
  });

  it('data.damagePerTick 逐实例覆盖定义值', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 0, 0, 25);
    applyEffect(state, e, 'burn', { damagePerTick: 10 });
    advance(state, 500);
    expect(e.hp).toBe(15);
  });

  it('DoT 致死走 dealDamage：enemyKilled 事件 + killHooks 恰好一次，尸体不再结算', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 400, 600, 5);
    const hooked: Enemy[] = [];
    const hook = (s: SimState, enemy: Enemy): void => {
      hooked.push(enemy);
      s.meta.hookRan = true;
    };
    killHooks.push(hook);
    try {
      applyEffect(state, e, 'burn');
      advance(state, 500); // 5-3=2
      expect(e.dead).toBe(false);
      advance(state, 500); // 2-3 → 死亡
      expect(e.dead).toBe(true);
      expect(hooked).toEqual([e]); // 恰好一次
      expect(state.meta.hookRan).toBe(true);
      expect(drainEvents(state)).toEqual([
        { kind: 'enemyKilled', enemyId: e.id, typeId: 'tester', x: 400, y: 600, isBoss: false },
      ]);
      // 尸体效果已清空：后续帧不再结算、不重复触发
      expect(e.effects.length).toBe(0);
      advance(state, 500);
      expect(hooked).toEqual([e]);
      expect(drainEvents(state)).toEqual([]);
    } finally {
      const idx = killHooks.indexOf(hook);
      if (idx >= 0) {
        killHooks.splice(idx, 1);
      }
    }
  });
});

describe('knockback 击退：即时冲量', () => {
  it('击退方向强制竖直向上，受 maxHp 抗性缩放（默认 hp=100 时 res = 40/100 = 0.4，force=60，位移 24）；不占用效果槽', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 600); // 默认 hp=100, maxHp=100 -> res = 0.4
    applyEffect(state, e, 'knockback', {});
    expect(e.x).toBe(360);
    expect(e.y).toBe(576); // 600 - 60 * 0.4 = 576
    expect(hasEffect(e, 'knockback')).toBe(false); // durationMs=0：即时结算不挂实例
  });

  it('data.force 覆盖定义值，高血量怪物抗性衰减（maxHp=200 -> res=0.2）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 600, 200); // maxHp = 200 -> res = 40/200 = 0.2
    applyEffect(state, e, 'knockback', { force: 200 });
    expect(e.x).toBe(360); // 竖直向上不改变 x
    expect(e.y).toBe(600 - 200 * 0.2); // 600 - 40 = 560
  });

  it('钳制：不越过上方出生线 spawnLineY (-40)', () => {
    const state = createSimState(1);
    const atTop = makeEnemy(state, 360, 10, 40);
    applyEffect(state, atTop, 'knockback', { force: 100 });
    expect(atTop.y).toBe(state.layout.spawnLineY); // spawnLineY 是 -40
  });
});

describe('slow/chill 减速乘区', () => {
  it('march 敌人挂 slow 后一帧位移减半（集成 updateEnemies）', () => {
    const state = createSimState(7);
    const grid = new SpatialHash<Enemy>(64);
    const e = spawnEnemy(state, makeType({ speed: 100 }), 360);
    applyEffect(state, e, 'slow');

    updateEnemies(state, 1000, grid);
    expect(e.y).toBe(-40 + 50); // 100 * 1s * 0.5
    expect(e.state).toBe('march');
  });

  it('chill 叠 2 层 = 0.75²；到期后速度恢复', () => {
    const state = createSimState(7);
    const grid = new SpatialHash<Enemy>(64);
    const e = spawnEnemy(state, makeType({ speed: 100 }), 360);
    applyEffect(state, e, 'chill');
    applyEffect(state, e, 'chill');
    expect(effectStacks(e, 'chill')).toBe(2);
    expect(speedMultiplier(e)).toBeCloseTo(0.5625, 12);

    updateEnemies(state, 1000, grid);
    expect(e.y).toBeCloseTo(-40 + 56.25, 9);

    advance(state, 2500); // chill（2500ms）到期
    expect(hasEffect(e, 'chill')).toBe(false);
    updateEnemies(state, 1000, grid);
    expect(e.y).toBeCloseTo(-40 + 56.25 + 100, 9); // 恢复全速
  });

  it('多减速源并存取 min（web 0.8 + slow 0.5 → 0.5）；强源到期后退居次强', () => {
    const state = createSimState(7);
    const grid = new SpatialHash<Enemy>(64);
    const e = spawnEnemy(state, makeType({ speed: 100 }), 360);
    applyEffect(state, e, 'slow'); // 2000ms
    applyEffect(state, e, 'web'); // 3000ms（夹具）
    expect(speedMultiplier(e)).toBe(0.5); // min(0.5, 0.8)

    updateEnemies(state, 1000, grid);
    expect(e.y).toBeCloseTo(-40 + 50, 9);

    advance(state, 2000); // slow 到期，web 仍在
    updateEnemies(state, 1000, grid);
    expect(e.y).toBeCloseTo(-40 + 50 + 80, 9); // 0.8 × 100

    advance(state, 1000); // web 也到期
    updateEnemies(state, 1000, grid);
    expect(e.y).toBeCloseTo(-40 + 50 + 80 + 100, 9); // 恢复全速
  });

  it('Boss 减速抗性：slow 降低 25%（speedMultiplier = 0.75），chill 降低 12.5%（单层 0.875，两层 0.765625）', () => {
    const state = createSimState(7);
    const boss = spawnEnemy(state, makeType({ id: 'boss_test', isBoss: true, speed: 100 }), 360);
    applyEffect(state, boss, 'slow');
    expect(speedMultiplier(boss)).toBe(0.75); // 普通怪为 0.5，Boss 为 0.75

    const bossChill = spawnEnemy(state, makeType({ id: 'boss_chill', isBoss: true, speed: 100 }), 360);
    applyEffect(state, bossChill, 'chill');
    expect(speedMultiplier(bossChill)).toBe(0.875); // 普通怪为 0.75，Boss 为 0.875
    applyEffect(state, bossChill, 'chill');
    expect(speedMultiplier(bossChill)).toBeCloseTo(0.765625, 6); // 0.875^2
  });
});

describe('stun 眩晕：停行动', () => {
  it('march 敌人眩晕：不位移、不转攻击态；到期恢复行军', () => {
    const state = createSimState(7);
    const grid = new SpatialHash<Enemy>(64);
    const e = spawnEnemy(state, makeType({ speed: 100 }), 360);
    applyEffect(state, e, 'stun'); // 800ms
    expect(isStunned(e)).toBe(true);

    updateEnemies(state, 1000, grid);
    expect(e.y).toBe(state.layout.spawnLineY); // 纹丝未动
    expect(e.state).toBe('march');

    advance(state, 800);
    expect(isStunned(e)).toBe(false);
    updateEnemies(state, 1000, grid);
    expect(e.y).toBe(state.layout.spawnLineY + 100);
  });

  it('attack 敌人眩晕：不攻击且冷却冻结；到期后按剩余冷却恢复攻击', () => {
    const state = createSimState(1, { wallMaxHp: 1000 });
    const e = makeAttacker(state, { attackCooldownMs: 100, attackIntervalMs: 1000 });
    applyEffect(state, e, 'stun'); // 800ms

    updateWallCombat(state, 800); // 眩晕全程：不攻击
    expect(state.wall.hp).toBe(1000);
    expect(e.attackCooldownMs).toBe(100); // 冷却被冻结
    expect(drainEvents(state)).toEqual([]);

    advance(state, 800); // 眩晕到期
    updateWallCombat(state, 100); // 剩余冷却走完 → 恰好一击
    expect(state.wall.hp).toBe(995);
    expect(e.attackCooldownMs).toBe(1000); // 0 + attackIntervalMs
  });

  it('Boss 眩晕抗性：持续时间缩短为 400ms（普通怪 800ms）', () => {
    const state = createSimState(7);
    const boss = spawnEnemy(state, makeType({ id: 'boss_stun', isBoss: true, speed: 100 }), 360);
    applyEffect(state, boss, 'stun');
    expect(isStunned(boss)).toBe(true);

    advance(state, 400); // 400ms 后即到期
    expect(isStunned(boss)).toBe(false);
  });
});

describe('mark/corrode 受伤加成（dealDamage 乘区）', () => {
  it('mark：伤害 ×1.25', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 0, 0, 100);
    applyEffect(state, e, 'mark');
    expect(damageTakenFactor(e)).toBeCloseTo(1.25, 12);

    dealDamage(state, e, 10);
    expect(e.hp).toBe(87.5);
  });

  it('corrode 叠 2 层 = 1.15²，与 mark 叠乘', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 0, 0, 100);
    applyEffect(state, e, 'mark');
    applyEffect(state, e, 'corrode');
    applyEffect(state, e, 'corrode');
    expect(effectStacks(e, 'corrode')).toBe(2);

    dealDamage(state, e, 10);
    expect(e.hp).toBeCloseTo(100 - 10 * 1.25 * 1.15 * 1.15, 9);
  });

  it('dealDamage 致死：事件 + killHooks 恰好一次；0/负伤害与已死亡为无操作', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 400, 600, 12);
    let kills = 0;
    const hook = (): void => {
      kills += 1;
    };
    killHooks.push(hook);
    try {
      applyEffect(state, e, 'mark');
      dealDamage(state, e, 10); // 12 - 12.5 → 死亡
      expect(e.dead).toBe(true);
      expect(kills).toBe(1);
      expect(drainEvents(state)).toEqual([
        { kind: 'enemyKilled', enemyId: e.id, typeId: 'tester', x: 400, y: 600, isBoss: false },
      ]);

      dealDamage(state, e, 10); // 尸体：无操作
      dealDamage(state, makeEnemy(state, 0, 0, 10), 0); // 0 伤害：无操作
      expect(kills).toBe(1);
      expect(drainEvents(state)).toEqual([]);
    } finally {
      const idx = killHooks.indexOf(hook);
      if (idx >= 0) {
        killHooks.splice(idx, 1);
      }
    }
  });
});

describe('blackhole 黑洞：向爆心位移（G2a 拉拽治理）', () => {
  it('向爆心位移至多 120px：距离 200 的敌人只向心移动 120（不再瞬移到爆心）；不占效果槽', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 300, 600);
    applyEffect(state, e, 'blackhole', { centerX: 500, centerY: 600 });

    // dist 200 > 120：位移 = min(200, 120) = 120 → x 300→420，方向指向爆心
    expect(e.x).toBe(420);
    expect(e.y).toBe(600);
    expect(hasEffect(e, 'blackhole')).toBe(false); // 即时效果不挂实例
  });

  it('距离 ≤ 120px 时恰落至爆心；贴着爆心的敌人纹丝不动', () => {
    const state = createSimState(1);
    const near = makeEnemy(state, 560, 600); // dist 60 ≤ 120
    applyEffect(state, near, 'blackhole', { centerX: 500, centerY: 600 });
    expect(near.x).toBe(500);
    expect(near.y).toBe(600);

    const atCenter = makeEnemy(state, 500, 600); // dist 0：无位移
    applyEffect(state, atCenter, 'blackhole', { centerX: 500, centerY: 600 });
    expect(atCenter.x).toBe(500);
    expect(atCenter.y).toBe(600);
  });

  it('拉拽受场地边界钳制：贴墙攻击态不被拉过墙线，两侧不超出屏幕', () => {
    const state = createSimState(1);
    const e = makeAttacker(state, {}); // y = wallLineY（1160）
    // 爆心在墙线下方 140px：位移 120 → 1280，被钳回墙线
    applyEffect(state, e, 'blackhole', { centerX: e.x, centerY: 1300 });
    expect(e.y).toBe(state.layout.wallLineY);

    const e2 = makeEnemy(state, 100, 500);
    // 爆心在屏幕左外 150px：位移 120 → -20，被钳制在 0
    applyEffect(state, e2, 'blackhole', { centerX: -50, centerY: 500 });
    expect(e2.x).toBe(0);
  });

  it('per-enemy 拉拽免疫 2s：免疫期内第二次爆炸不再位移（连换爆心也不动）；到期后恢复可拉', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 300, 600);
    applyEffect(state, e, 'blackhole', { centerX: 500, centerY: 600 });
    expect(e.x).toBe(420); // 首次拉拽：向爆心位移 120

    applyEffect(state, e, 'blackhole', { centerX: 500, centerY: 700 }); // 100ms 后再爆：免疫
    expect(e.x).toBe(420);
    expect(e.y).toBe(600);

    state.timeMs += 1999; // 仍在免疫期内（首次拉拽 t=0，截止 t=2000）
    applyEffect(state, e, 'blackhole', { centerX: 500, centerY: 700 });
    expect(e.x).toBe(420);

    state.timeMs += 1; // 恰过 2s：免疫到期
    applyEffect(state, e, 'blackhole', { centerX: 500, centerY: 700 });
    // 距爆心 hypot(80, 100) ≈ 128 > 120：向爆心位移 120（方向归一化）
    const dist = Math.hypot(80, 100);
    expect(e.x).toBeCloseTo(420 + (80 / dist) * 120, 6);
    expect(e.y).toBeCloseTo(600 + (100 / dist) * 120, 6);
  });

  it('贴心命中（位移 0）同样盖免疫戳：2s 内换爆心的爆炸拉不动它', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 500, 600);
    applyEffect(state, e, 'blackhole', { centerX: 500, centerY: 600 }); // 已在爆心：0 位移
    expect(e.x).toBe(500);

    applyEffect(state, e, 'blackhole', { centerX: 700, centerY: 600 }); // 2s 内换爆心：免疫
    expect(e.x).toBe(500);
    expect(e.y).toBe(600);

    state.timeMs += 2000;
    applyEffect(state, e, 'blackhole', { centerX: 700, centerY: 600 }); // 到期：可拉
    expect(e.x).toBe(620); // dist 200 → 位移 120
  });
});

describe('overheat 过热：开火间隔乘区', () => {
  /** 每帧推进：效果 tick → 武器（与 session hook 顺序一致）。 */
  function tickAll(state: SimState, dtMs: number, defs: Record<string, WeaponDef>): void {
    state.timeMs += dtMs;
    updateEffects(state, dtMs);
    updateWeapons(state, dtMs, defs);
  }

  it('挂 overheat 后开火间隔 ×1.6；到期后恢复原间隔', () => {
    let fires = 0;
    registerBehavior({
      name: 'fx_overheat_counter',
      fire: () => {
        fires += 1;
      },
    });
    const def: WeaponDef = {
      id: 'oh',
      name: '过热枪',
      behavior: 'fx_overheat_counter',
      maxLevel: 10,
      base: { damage: 1, intervalMs: 800, projectileSpeed: 100, pierce: 1, ttlMs: 100 },
      rangeKeys: [],
      cards: [],
    };
    const defs = { oh: def };
    const state = createSimState(1);
    addWeapon(state, 'oh');
    const ws = state.weaponStates.oh;

    applyEffect(state, ws, 'overheat'); // t=0，until 2500
    expect(overheatFactor(ws)).toBeCloseTo(1.6, 12);

    tickAll(state, 50, defs); // t=50：首击，冷却 += 800×1.6 = 1280 → 1230
    expect(fires).toBe(1);
    expect(ws.cooldownMs).toBe(1230);

    while (state.timeMs < 1250) {
      tickAll(state, 50, defs); // 冷却 1230 → 30，不开火
    }
    expect(fires).toBe(1);

    tickAll(state, 50, defs); // t=1300：第二击（无过热本应在 t=850）
    expect(fires).toBe(2);
    expect(ws.cooldownMs).toBe(-20 + 1280); // 1260

    while (state.timeMs < 2500) {
      tickAll(state, 50, defs); // 期间不开火；t=2500 时 overheat 到期移除
    }
    expect(hasEffect(ws, 'overheat')).toBe(false);
    expect(overheatFactor(ws)).toBe(1);

    tickAll(state, 50, defs); // t=2550：冷却 60 → 10，仍不开火
    expect(fires).toBe(2);
    tickAll(state, 50, defs); // t=2600：第三击，冷却 += 800（间隔已恢复）
    expect(fires).toBe(3);
    expect(ws.cooldownMs).toBe(760); // -40 + 800（若仍过热会是 -40 + 1280）
  });

  it('data.intervalFactor 逐实例覆盖定义值；武器载体到期由 updateEffects 清理', () => {
    const state = createSimState(1);
    addWeapon(state, 'w');
    const ws = state.weaponStates.w;
    applyEffect(state, ws, 'overheat', { intervalFactor: 3 });
    expect(overheatFactor(ws)).toBe(3);
    advance(state, 2500);
    expect(hasEffect(ws, 'overheat')).toBe(false);
    expect(overheatFactor(ws)).toBe(1);
  });
});

describe('叠层 / 互斥 / refresh 语义', () => {
  it('poison refresh=add：叠至 3 层封顶，每跳伤害 = damagePerTick × 层数', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 0, 0, 100);
    applyEffect(state, e, 'poison');
    applyEffect(state, e, 'poison');
    applyEffect(state, e, 'poison');
    applyEffect(state, e, 'poison'); // 超上限：封顶 3
    expect(effectStacks(e, 'poison')).toBe(3);

    advance(state, 1000);
    expect(e.hp).toBe(94); // 每跳 2×3=6
    advance(state, 1000);
    expect(e.hp).toBe(88);
  });

  it('refresh=reset：层数重置为 1，untilMs 重算（重复施加重新武装计时）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 0, 0, 100);
    applyEffect(state, e, 'slow');
    advance(state, 1500); // t=1500
    applyEffect(state, e, 'slow'); // 重置：until = 1500 + 2000 = 3500
    expect(effectStacks(e, 'slow')).toBe(1);

    advance(state, 1000); // t=2500：若无重算早已过期（until 2000）
    expect(hasEffect(e, 'slow')).toBe(true);
    advance(state, 1000); // t=3500：到期
    expect(hasEffect(e, 'slow')).toBe(false);
  });

  it('互斥 slow_family：chill 在场时施加 slow → 替换（potency 2 > 1）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 0, 0);
    applyEffect(state, e, 'chill');
    applyEffect(state, e, 'slow');
    expect(hasEffect(e, 'chill')).toBe(false);
    expect(hasEffect(e, 'slow')).toBe(true);
    expect(speedMultiplier(e)).toBe(0.5);
  });

  it('互斥 slow_family：slow 在场时施加 chill → 拒绝（1 ≤ 2，组内保持现状）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 0, 0);
    applyEffect(state, e, 'slow');
    applyEffect(state, e, 'chill');
    expect(hasEffect(e, 'slow')).toBe(true);
    expect(hasEffect(e, 'chill')).toBe(false);
    expect(speedMultiplier(e)).toBe(0.5);
  });

  it('互斥同强拒绝：slow 在场时施加同组同 potency 的 frostbite → 拒绝', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 0, 0);
    applyEffect(state, e, 'slow');
    applyEffect(state, e, 'frostbite'); // potency 1 ≤ 2 → 拒绝
    expect(hasEffect(e, 'frostbite')).toBe(false);
    expect(hasEffect(e, 'slow')).toBe(true);
  });

  it('同 kind 重复施加不触发互斥（chill 可叠 2 层）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 0, 0);
    applyEffect(state, e, 'chill');
    applyEffect(state, e, 'chill');
    expect(effectStacks(e, 'chill')).toBe(2);
  });

  it('burn 与 poison（无互斥组）可共存；mark 与 corrode 可共存', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 0, 0, 100);
    applyEffect(state, e, 'burn');
    applyEffect(state, e, 'poison');
    applyEffect(state, e, 'mark');
    applyEffect(state, e, 'corrode');
    expect(e.effects.map((f) => f.kind)).toEqual(['burn', 'poison', 'mark', 'corrode']);
  });
});

describe('同种子可复现', () => {
  it('同种子同操作序列：刷怪/挂效果/击退/DoT 致死的全程状态完全一致', () => {
    const type = makeType({ speed: 60, hp: 10 });
    const run = (): SimState => {
      const s = createSimState(20240913);
      const grid = new SpatialHash<Enemy>(64);
      for (let i = 0; i < 3; i++) {
        spawnEnemy(s, type, s.rng.range(60, 660)); // 刷怪位置走种子 RNG
      }
      for (let f = 0; f < 100; f++) {
        s.timeMs += 50;
        updateEffects(s, 50);
        updateEnemies(s, 50, grid);
        if (f === 3) {
          for (const e of s.enemies) {
            applyEffect(s, e, 'burn');
          }
        }
        if (f === 10) {
          applyEffect(s, s.enemies[0], 'knockback', { dirX: 0, dirY: -1 });
        }
      }
      return s;
    };

    const s1 = run();
    const s2 = run();
    const snap = (s: SimState): unknown => ({
      timeMs: s.timeMs,
      enemies: s.enemies.map((e) => ({
        x: e.x, y: e.y, hp: e.hp, dead: e.dead, state: e.state, effects: e.effects,
      })),
      events: drainEvents(s),
    });
    expect(snap(s1)).toEqual(snap(s2));

    // 且效果确实参与了过程：有敌人被烧死、0 号被击退过（非平凡路径）
    const burned = s1.enemies.filter((e) => e.dead).length;
    expect(burned).toBeGreaterThan(0);
  });
});

describe('applyEffectsOnHit：模板 → 实例', () => {
  it('untilMs 按当前时刻重算、data 深拷贝、模板 stacks 不参与；模板不被污染', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 0, 0, 1000);
    const template: EffectInstance = {
      kind: 'burn',
      untilMs: -999, // 模板的 untilMs 不参与
      stacks: 5, // 模板的 stacks 不参与
      data: { damagePerTick: 9, weaponLevel: 3 },
    };
    applyEffectsOnHit(state, e, [template]);

    expect(e.effects.length).toBe(1);
    const inst = e.effects[0];
    expect(inst.kind).toBe('burn');
    expect(inst.untilMs).toBe(3000); // state.timeMs(0) + durationMs(3000)
    expect(inst.stacks).toBe(1);
    expect(inst.data.damagePerTick).toBe(9); // data 拷贝且覆盖定义值 3
    expect(inst.data.weaponLevel).toBe(3);
    expect(template.data).toEqual({ damagePerTick: 9, weaponLevel: 3 }); // 深拷贝：模板未被污染
    expect(template.untilMs).toBe(-999);
    expect(template.stacks).toBe(5);

    // 覆盖后的每跳伤害生效（t=500 第一跳）
    advance(state, 500);
    expect(e.hp).toBe(991); // 1000 - 9

    // untilMs 随施加时刻重算：t=500 施加 slow → 500 + 2000 = 2500
    applyEffectsOnHit(state, e, [{ kind: 'slow', untilMs: 0, stacks: 1, data: {} }]);
    const slow = e.effects.find((f) => f.kind === 'slow');
    expect(slow?.untilMs).toBe(2500);
  });
});

describe('弹丸命中集成（dealDamage 改道 + effectsOnHit）', () => {
  it('命中伤害走 dealDamage（mark 加成生效）；命中后模板附着到敌人', () => {
    const state = createSimState(1);
    const grid = new SpatialHash<Enemy>(64);
    const e = makeEnemy(state, 400, 600, 50);
    applyEffect(state, e, 'mark'); // 受伤 ×1.25

    const p = spawnProjectile(state, {
      x: 300,
      y: 600,
      vx: 100,
      vy: 0,
      damage: 10,
      pierceLeft: 5,
      ttlMs: 5000,
      effectsOnHit: [{ kind: 'slow', untilMs: 0, stacks: 1, data: {} }],
    });

    updateProjectiles(state, 1000, grid);
    expect(e.hp).toBeCloseTo(50 - 12.5, 9); // 10 × 1.25（dealDamage 改道生效）
    expect(hasEffect(e, 'slow')).toBe(true); // effectsOnHit 附着
    const slow = e.effects.find((f) => f.kind === 'slow');
    expect(slow?.untilMs).toBe(2000); // 命中时刻（timeMs=0）+ durationMs(2000)
    expect(p.pierceLeft).toBe(4);

    // 附着的减速真正作用于行军
    e.state = 'march';
    e.speed = 100;
    updateEnemies(state, 1000, grid);
    expect(e.y).toBe(600 + 50); // 减速一半
  });

  it('击杀弹的致死一击不附着效果（尸体无意义），事件与 killHooks 语义不变', () => {
    const state = createSimState(1);
    const grid = new SpatialHash<Enemy>(64);
    const e = makeEnemy(state, 400, 600, 10);
    let kills = 0;
    const hook = (): void => {
      kills += 1;
    };
    killHooks.push(hook);
    try {
      spawnProjectile(state, {
        x: 300,
        y: 600,
        vx: 100,
        vy: 0,
        damage: 10,
        pierceLeft: 5,
        ttlMs: 5000,
        effectsOnHit: [{ kind: 'burn', untilMs: 0, stacks: 1, data: {} }],
      });
      updateProjectiles(state, 1000, grid);
      expect(e.dead).toBe(true);
      expect(kills).toBe(1);
      expect(hasEffect(e, 'burn')).toBe(false);
      expect(drainEvents(state)).toEqual([
        { kind: 'enemyKilled', enemyId: e.id, typeId: 'tester', x: 400, y: 600, isBoss: false },
      ]);
    } finally {
      const idx = killHooks.indexOf(hook);
      if (idx >= 0) {
        killHooks.splice(idx, 1);
      }
    }
  });
});
