// src/core/behaviors/piercingBolt.test.ts —— 轨道贯穿炮行为契约（T5.2b hitscan 化；T5.3a 牌池制更新）：
// 即时射线：开火同一帧结算伤害（主目标必中、无在途、无提前量）、不再产生弹丸、
// 线上敌人按投影距离升序贯穿、pierce 用尽截断、线外/身后更近怪不受击、
// 无目标不开火且冷却归 0、VFX meta 写入、伤害/穿透/射速全部来自 WeaponDef
// （等级语义改为牌组：伤害成长走伤害强化牌、穿透成长走贯通+1牌；改表即变）、
// 穿透伤害走 dealDamage 统一入口（enemyKilled 事件 + killHooks 触发）。
import { describe, expect, it } from 'vitest';
import { createSimState } from '../simState';
import type { Enemy, SimState } from '../types';
import { addWeapon, getWeaponStats, updateWeapons } from '../weapons';
import type { WeaponDef, WeaponStats } from '../weapons';
import { loadWeaponDefs } from '../../data/weapons';
import { killHooks } from '../projectiles';
import { behavior } from './behavior_piercingBolt';
import './index'; // 副作用：自动发现注册
import { getBehavior } from './registry';

/** 构造一个敌人夹具（march 静止默认；speed 可指定行军）。 */
function makeEnemy(state: SimState, x: number, y: number, hp = 100, speed = 0): Enemy {
  const e: Enemy = {
    id: state.nextId++,
    typeId: 'tester',
    name: '测试怪',
    x,
    y,
    radius: 10,
    hp,
    maxHp: hp,
    speed,
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

/** 基础 stats 夹具（与 rail_piercer base 同构）。 */
function makeStats(overrides?: Partial<WeaponStats>): WeaponStats {
  return { damage: 10, intervalMs: 800, projectileSpeed: 900, pierce: 2, ttlMs: 2000, ...overrides };
}

describe('即时射线（hitscan）', () => {
  it('主目标开火同一帧即扣血（无在途时间）：不再产生任何弹丸', () => {
    const state = createSimState(1); // 角色 (360, 1220)
    const e = makeEnemy(state, 360, 520, 100, 240); // 行军怪也照样：开火帧立即结算

    behavior.fire(state, 'rail_piercer', makeStats());

    expect(state.projectiles).toHaveLength(0); // hitscan：本行为不再发射弹丸
    expect(e.hp).toBe(90); // 100 - 10：开火同一帧已结算，无需推进任何帧
    expect(e.dead).toBe(false);
  });

  it('方向 = 指向主目标当前位置（即时命中无需提前量）：3-4-5 三角验证射线走向', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 520); // 远（t=700）
    const near = makeEnemy(state, 540, 980); // 近：dist 300，方向 (180,-240)/300=(0.6,-0.8)

    // 近者被 findTarget 锁定为主目标（它恰在射线上垂距 0 → 必中）。
    behavior.fire(state, 'rail_piercer', makeStats({ pierce: 3 }));

    expect(near.hp).toBe(90);
    // VFX 射线终点沿主目标方向贯穿全场（x2/y2 在主目标方向延长线上）。
    const vfx = state.meta['rail_vfx:rail_piercer'] as { segments: Array<{ x1: number; y1: number; x2: number; y2: number }>; untilMs: number };
    const seg = vfx.segments[0];
    expect(seg.x1).toBe(360);
    expect(seg.y1).toBe(1220);
    // (0.6,-0.8) 方向：x2 = 360 + 0.6·range（range = 布局走廊对角线，见实现）。
    const range = Math.hypot(state.layout.width, state.layout.height - state.layout.spawnLineY);
    expect(seg.x2).toBeCloseTo(360 + 0.6 * range, 6);
    expect(seg.y2).toBeCloseTo(1220 - 0.8 * range, 6);
  });

  it('线上顺序命中：投影距离近者先结算（首个致死消耗命中名额，后续继续贯穿）', () => {
    const state = createSimState(1);
    const a = makeEnemy(state, 360, 1020, 10); // t=200，hp 10：一发致死
    const b = makeEnemy(state, 360, 720, 100); // t=500
    const c = makeEnemy(state, 360, 420, 100); // t=800

    behavior.fire(state, 'rail_piercer', makeStats({ pierce: 3 }));

    expect(a.dead).toBe(true); // 第 1 名额：a 被打死（致死也消耗名额，与旧弹丸语义一致）
    expect(b.hp).toBe(90); // 第 2 名额：b 扣 10
    expect(c.hp).toBe(90); // 第 3 名额：pierce=3 恰好覆盖线上全部 3 个
  });

  it('pierce 用尽截断：pierce=2 只结算线上投影最近的前 2 个，第 3 个不受击', () => {
    const state = createSimState(1);
    const a = makeEnemy(state, 360, 1020); // t=200
    const b = makeEnemy(state, 360, 720); // t=500
    const c = makeEnemy(state, 360, 420); // t=800

    behavior.fire(state, 'rail_piercer', makeStats({ pierce: 2 }));

    expect(a.hp).toBe(90);
    expect(b.hp).toBe(90);
    expect(c.hp).toBe(100); // 名额用尽：线上更远者不受击
  });

  it('线外更近怪不受击、角色身后怪不受击：射线锁死主目标方向，直线贯穿不拐弯', () => {
    const state = createSimState(1);
    // 主目标用 attack 贴墙怪（findTarget 高威胁层，压过更近的 march 怪）：(500,1160)。
    const target = makeEnemy(state, 500, 1160);
    target.state = 'attack';
    // march 怪距角色 124px（比主目标 152px 近），但到主目标射线（方向 (140,-60)/152.3）
    // 的垂距 ≈98.5px > 判定阈 15：不在走廊上 → 不受击、也不会把射线改瞄向自己。
    const offline = makeEnemy(state, 390, 1100);
    const behind = makeEnemy(state, 360, 1400); // 角色身后（t<0）：不受击

    behavior.fire(state, 'rail_piercer', makeStats({ pierce: 4 }));

    expect(target.hp).toBe(90);
    expect(offline.hp).toBe(100);
    expect(behind.hp).toBe(100);
  });

  it('无存活目标不开火：不写 VFX 且冷却归 0（重试标记）', () => {
    const state = createSimState(1);
    addWeapon(state, 'rail_piercer');
    state.weaponStates.rail_piercer.cooldownMs = 500;

    behavior.fire(state, 'rail_piercer', makeStats());

    expect(state.projectiles).toHaveLength(0);
    expect(state.meta['rail_vfx:rail_piercer']).toBeUndefined();
    expect(state.weaponStates.rail_piercer.cooldownMs).toBe(0);
  });

  it('仅剩死亡敌人视为无目标：不开火', () => {
    const state = createSimState(1);
    const corpse = makeEnemy(state, 361, 1219);
    corpse.dead = true;
    addWeapon(state, 'rail_piercer');
    state.weaponStates.rail_piercer.cooldownMs = 500;

    behavior.fire(state, 'rail_piercer', makeStats());

    expect(state.weaponStates.rail_piercer.cooldownMs).toBe(0);
  });

  it('VFX meta 写入：meta["rail_vfx:<weaponId>"] = { segments:[{x1,y1,x2,y2}], untilMs: timeMs+100 }', () => {
    const state = createSimState(1);
    state.timeMs = 12345;
    makeEnemy(state, 360, 1000); // 正上方 → 射线 (0,-1)

    behavior.fire(state, 'rail_piercer', makeStats());

    const vfx = state.meta['rail_vfx:rail_piercer'] as {
      segments: Array<{ x1: number; y1: number; x2: number; y2: number }>;
      untilMs: number;
    };
    expect(vfx).toBeDefined();
    expect(vfx.untilMs).toBe(12345 + 100);
    expect(vfx.segments).toHaveLength(1);
    const seg = vfx.segments[0];
    expect(seg.x1).toBe(360);
    expect(seg.y1).toBe(1220);
    expect(seg.x2).toBe(360); // 正上方向：终点 x 不变
    expect(seg.y2).toBeLessThan(state.layout.spawnLineY); // 贯穿出生线：全场覆盖
  });
});

describe('数值全部来自 WeaponDef（改表即变，T5.3a 牌池制）', () => {
  /** 夹具 def：与 rail_piercer 不同数值，证明伤害/穿透随 def 而非行为内硬编码。 */
  const altDef: WeaponDef = {
    id: 'alt_gun',
    name: '替换枪',
    behavior: 'piercing_bolt',
    maxLevel: 10,
    base: { damage: 33, intervalMs: 300, projectileSpeed: 500, pierce: 5, ttlMs: 4000 },
    rangeKeys: [],
    cards: [],
  };

  it('两个不同 def 分别跑：伤害/穿透随 def 变（pierce=5 命中 5 个）', () => {
    const state = createSimState(1);
    for (const y of [1000, 900, 800, 700, 600, 500]) {
      makeEnemy(state, 360, y); // 6 个线上敌人
    }
    state.weaponStates.rail_like = { level: 0, cooldownMs: 0, cards: {} };
    behavior.fire(state, 'rail_piercer', getWeaponStats(makeRailDefLike(), state, 'rail_like'));
    expect(state.enemies[0].hp).toBe(90); // damage 10
    expect(state.enemies[5].hp).toBe(100); // pierce 2：只前 2 个

    const state2 = createSimState(1);
    for (const y of [1000, 900, 800, 700, 600, 500]) {
      makeEnemy(state2, 360, y);
    }
    state2.weaponStates.alt_gun = { level: 0, cooldownMs: 0, cards: {} };
    behavior.fire(state2, 'alt_gun', getWeaponStats(altDef, state2, 'alt_gun'));
    expect(state2.enemies[0].hp).toBe(67); // damage 33
    expect(state2.enemies[4].hp).toBe(67); // pierce 5：前 5 个全中
    expect(state2.enemies[5].hp).toBe(100); // 第 6 个截断
  });

  it('真实数据表 rail_piercer.json：base 与牌组数值驱动射线（改 json 即变）', () => {
    const railDef = loadWeaponDefs().rail_piercer;
    expect(railDef).toBeDefined();

    // 无牌 = base：damage 10 / pierce 4
    const s1 = createSimState(1);
    for (const y of [1000, 900, 800]) {
      makeEnemy(s1, 360, y);
    }
    s1.weaponStates.rail_piercer = { level: 0, cooldownMs: 0, cards: {} };
    behavior.fire(s1, 'rail_piercer', getWeaponStats(railDef, s1, 'rail_piercer'));
    expect(s1.enemies[0].hp).toBe(90);
    expect(s1.enemies[1].hp).toBe(90);
    expect(s1.enemies[2].hp).toBe(90);

    // 牌组 [伤害强化 +2 张贯通]：damage 13、pierce 4 → 3 个线上敌人全中
    const s3 = createSimState(1);
    for (const y of [1000, 900, 800]) {
      makeEnemy(s3, 360, y);
    }
    s3.weaponStates.rail_piercer = { level: 3, cooldownMs: 0, cards: { dmg_up: 1, pierce_up: 2 } };
    behavior.fire(s3, 'rail_piercer', getWeaponStats(railDef, s3, 'rail_piercer'));
    expect(s3.enemies[0].hp).toBeCloseTo(100 - 13, 6); // 100 - 10×1.3
    expect(s3.enemies[2].hp).toBeCloseTo(100 - 13, 6); // pierce 4 ≥ 3：全中
  });

  it('射速来自数据表 intervalMs：经 updateWeapons 驱动真实开火节奏', () => {
    const railDef = loadWeaponDefs().rail_piercer;
    const state = createSimState(1);
    makeEnemy(state, 360, 1000, 100000); // 高血量目标：始终有目标、始终开火
    addWeapon(state, 'rail_piercer');

    const defs = { rail_piercer: railDef };
    // 第 1 步（100ms）：冷却 0 → -100 → 开火，冷却 += 800 → 700
    updateWeapons(state, 100, defs);
    expect(state.enemies[0].hp).toBe(100000 - 10);

    // 第 2~7 步（累计 700ms）：不开火
    for (let i = 0; i < 6; i++) {
      updateWeapons(state, 100, defs);
    }
    expect(state.enemies[0].hp).toBe(100000 - 10);

    // 第 8 步（累计 800ms）：第二次开火 —— 节奏完全由 json 的 intervalMs=800 决定
    updateWeapons(state, 100, defs);
    expect(state.enemies[0].hp).toBe(100000 - 20);
  });

  it('自动发现注册：getBehavior("piercing_bolt") 即本文件 behavior（同一实例）', () => {
    expect(getBehavior('piercing_bolt')).toBe(behavior);
  });
});

describe('伤害走 dealDamage 统一入口', () => {
  it('致死一击触发 enemyKilled 事件与 killHooks（与弹丸命中路径等价）', () => {
    const state = createSimState(1);
    const doomed = makeEnemy(state, 360, 1000, 10); // hp 10 < damage 10：必死
    const killed: number[] = [];
    const hook = (s: SimState, e: Enemy): void => {
      killed.push(e.id);
      expect(s).toBe(state);
    };
    killHooks.push(hook);

    try {
      behavior.fire(state, 'rail_piercer', makeStats());
    } finally {
      const idx = killHooks.indexOf(hook);
      if (idx >= 0) {
        killHooks.splice(idx, 1); // 测试自清理：不污染同文件其他用例
      }
    }

    expect(doomed.dead).toBe(true);
    expect(killed).toEqual([doomed.id]);
    expect(state.events.some((ev) => ev.kind === 'enemyKilled')).toBe(true);
  });
});

/** rail_piercer 的同构夹具（不依赖数据层的独立 def，供第一组断言使用）。 */
function makeRailDefLike(): WeaponDef {
  return {
    id: 'rail_like',
    name: '轨道同构',
    behavior: 'piercing_bolt',
    maxLevel: 10,
    base: { damage: 10, intervalMs: 800, projectileSpeed: 900, pierce: 2, ttlMs: 2000 },
    rangeKeys: [],
    cards: [],
  };
}

// —— 轨道炮专属牌接线：智能折射 / 穿透增幅 / 三叉分裂 ——

describe('智能折射（refract 牌：命中后折向300px内最近未受击敌人，折射-1，穿透-1，上限4次）', () => {
  it('命中触发折射，300px内最近未受击敌人受到伤害，折射与穿透消耗', () => {
    const state = createSimState(1);
    const m1 = makeEnemy(state, 360, 900); // 主目标
    const r1 = makeEnemy(state, 500, 900); // 距 m1 140 ≤ 300：折射目标
    behavior.fire(state, 'rail_piercer', makeStats({ pierce: 2, refract: 1 }));

    expect(m1.hp).toBe(90);
    expect(r1.hp).toBe(90);
    const vfx = state.meta['rail_vfx:rail_piercer'] as { segments: unknown[] };
    expect(vfx.segments.length).toBeGreaterThanOrEqual(2);
  });
});

describe('穿透增幅（penetrateAmp 牌：射线每贯穿一个敌人，后续伤害提升25%）', () => {
  it('第1个怪100%、第2个怪125%、第3个怪150%', () => {
    const state = createSimState(1);
    const a = makeEnemy(state, 360, 1000, 100);
    const b = makeEnemy(state, 360, 800, 100);
    const c = makeEnemy(state, 360, 600, 100);

    behavior.fire(state, 'rail_piercer', makeStats({ pierce: 3, penetrateAmp: 0.25 }));

    expect(a.hp).toBe(90);   // 10 * (1 + 0 * 0.25) = 10
    expect(b.hp).toBe(87.5); // 10 * (1 + 1 * 0.25) = 12.5 -> 100 - 12.5 = 87.5
    expect(c.hp).toBe(85);   // 10 * (1 + 2 * 0.25) = 15.0 -> 100 - 15 = 85
  });
});

describe('三叉分裂（trident 牌：多目标锁定分束或单目标聚合打击）', () => {
  it('单怪聚合打击：基础伤害乘1.6（16伤），记录3段聚合线段', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 900, 100);

    behavior.fire(state, 'rail_piercer', makeStats({ trident: 1, pierce: 1 }));

    expect(e.hp).toBe(100 - 48); // 3 rays * 16 = 48 total damage
    const vfx = state.meta['rail_vfx:rail_piercer'] as { segments: unknown[] };
    expect(vfx.segments).toHaveLength(3);
  });

  it('多怪分散锁定打击：锁定场上威胁最高的至多3个不同敌人各射一道贯穿线', () => {
    const state = createSimState(1);
    const t1 = makeEnemy(state, 360, 900, 100);
    const t2 = makeEnemy(state, 500, 900, 100);
    const t3 = makeEnemy(state, 220, 900, 100);

    behavior.fire(state, 'rail_piercer', makeStats({ trident: 1, pierce: 1 }));

    expect(t1.hp).toBe(90);
    expect(t2.hp).toBe(90);
    expect(t3.hp).toBe(90);
    const vfx = state.meta['rail_vfx:rail_piercer'] as { segments: unknown[] };
    expect(vfx.segments).toHaveLength(3);
  });
});

