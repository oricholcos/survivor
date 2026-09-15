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

    // 无牌 = base：damage 10 / pierce 2
    const s1 = createSimState(1);
    for (const y of [1000, 900, 800]) {
      makeEnemy(s1, 360, y);
    }
    s1.weaponStates.rail_piercer = { level: 0, cooldownMs: 0, cards: {} };
    behavior.fire(s1, 'rail_piercer', getWeaponStats(railDef, s1, 'rail_piercer'));
    expect(s1.enemies[0].hp).toBe(90);
    expect(s1.enemies[1].hp).toBe(90);
    expect(s1.enemies[2].hp).toBe(100);

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

// —— T5.3b 轨道炮专属牌接线：三叉 / 折射叠层 / 跳弹 / 蓄力增伤 ——

describe('三叉分裂（trident_split 牌：±10° 侧射线独立结算）', () => {
  it('主射线 + ±10° 各一条侧射线（VFX 3 段）；各射线独立结算、各穿 pierce 个', () => {
    const state = createSimState(1);
    // 主目标 (360,900) 距角色 320（最近 → 主射线正上）；侧线敌人在 ±10° 线上更远（t=900）
    const main = makeEnemy(state, 360, 900);
    const rad = (10 * Math.PI) / 180;
    const right = makeEnemy(state, 360 + 900 * Math.sin(rad), 1220 - 900 * Math.cos(rad));
    const left = makeEnemy(state, 360 - 900 * Math.sin(rad), 1220 - 900 * Math.cos(rad));

    behavior.fire(state, 'rail_piercer', makeStats({ trident: 1, tridentAngleDeg: 10 }));

    expect(main.hp).toBe(90); // 主射线 10 伤
    expect(right.hp).toBe(90); // +10° 侧射线独立结算
    expect(left.hp).toBe(90); // -10° 侧射线独立结算
    const vfx = state.meta['rail_vfx:rail_piercer'] as { segments: unknown[] };
    expect(vfx.segments).toHaveLength(3); // 主 + 双侧
  });

  it('侧射线各穿 pierce 个（pierce=2：每条侧线上 2 个敌人全中）；对照无牌只有主射线 1 段', () => {
    const state = createSimState(1);
    const rad = (10 * Math.PI) / 180;
    const main = makeEnemy(state, 360, 700); // 距 520：主射线正上（比侧线敌人近）
    // +10° 线上 t=600/t=800 两个、-10° 线上 t=600/t=800 两个（都比主目标远）
    makeEnemy(state, 360 + 600 * Math.sin(rad), 1220 - 600 * Math.cos(rad));
    makeEnemy(state, 360 + 800 * Math.sin(rad), 1220 - 800 * Math.cos(rad));
    makeEnemy(state, 360 - 600 * Math.sin(rad), 1220 - 600 * Math.cos(rad));
    makeEnemy(state, 360 - 800 * Math.sin(rad), 1220 - 800 * Math.cos(rad));

    behavior.fire(state, 'rail_piercer', makeStats({ trident: 1, tridentAngleDeg: 10 }));
    expect(main.hp).toBe(90); // 主射线
    for (let i = 1; i < state.enemies.length; i++) {
      // 每条侧线各自独立结算、各穿 pierce=2 个：线上的 2 个敌人各中 1 发（pierce=1 时更远者会被截断）
      expect(state.enemies[i].hp).toBe(90);
    }

    // 对照无牌：±10° 线上的敌人不受击、VFX 仅主射线 1 段
    const plain = createSimState(1);
    makeEnemy(plain, 360, 700); // 主射线目标（最近）
    makeEnemy(plain, 360 + 600 * Math.sin(rad), 1220 - 600 * Math.cos(rad)); // 侧线位置
    behavior.fire(plain, 'rail_piercer', makeStats());
    expect(plain.enemies[1].hp).toBe(100);
    const vfx = plain.meta['rail_vfx:rail_piercer'] as { segments: unknown[] };
    expect(vfx.segments).toHaveLength(1);
  });
});

describe('折射+1（refract_up 牌可叠层：终点偏 30° 续射半程、链式续段）', () => {
  it('1 层：主射线终点续一段（长 = range×0.5、方向 +30°）；2 层：再从上一段终点 +30° 续一段', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 600); // 主射线需有目标才开火
    behavior.fire(state, 'rail_piercer', makeStats({ refract: 2, refractAngleDeg: 30, refractLengthFactor: 0.5 }));

    const vfx = state.meta['rail_vfx:rail_piercer'] as {
      segments: Array<{ x1: number; y1: number; x2: number; y2: number }>;
    };
    expect(vfx.segments).toHaveLength(3); // 主 + 2 段折射
    const range = Math.hypot(720, 1280 - -40);
    const [m, r1, r2] = vfx.segments;
    // 主射线：角色 (360,1220) → 正上满射程
    expect(m.x2).toBeCloseTo(360, 6);
    expect(m.y2).toBeCloseTo(1220 - range, 6);
    // 折射段 1：主射线终点、方向 (sin30, -cos30)、长 range×0.5
    expect(r1.x1).toBeCloseTo(m.x2, 6);
    expect(r1.y1).toBeCloseTo(m.y2, 6);
    expect(r1.x2).toBeCloseTo(m.x2 + range * 0.5 * Math.sin((30 * Math.PI) / 180), 6);
    expect(r1.y2).toBeCloseTo(m.y2 - range * 0.5 * Math.cos((30 * Math.PI) / 180), 6);
    // 折射段 2：上一段终点再 +30°（累计 60°）
    expect(r2.x1).toBeCloseTo(r1.x2, 6);
    expect(r2.y1).toBeCloseTo(r1.y2, 6);
    expect(r2.x2).toBeCloseTo(r1.x2 + range * 0.5 * Math.sin((60 * Math.PI) / 180), 6);
    expect(r2.y2).toBeCloseTo(r1.y2 - range * 0.5 * Math.cos((60 * Math.PI) / 180), 6);
  });

  it('折射段独立结算：段中点敌人受伤（几何精确放置）', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 600); // 主射线目标
    const range = Math.hypot(720, 1280 - -40);
    const rad = (30 * Math.PI) / 180;
    const half = range * 0.5;
    // 折射段中点 = 主射线终点 (360, 1220-range) + (half/2)×方向(sin30, -cos30)
    const onRefract = makeEnemy(
      state,
      360 + (half / 2) * Math.sin(rad),
      1220 - range - (half / 2) * Math.cos(rad),
    );

    behavior.fire(state, 'rail_piercer', makeStats({ refract: 1, refractAngleDeg: 30, refractLengthFactor: 0.5 }));
    expect(onRefract.hp).toBe(90); // 折射段中点敌人受伤
  });
});

describe('跳弹（ricochet 牌：主射线穿透链末位向范围内未受击者追加结算）', () => {
  it('主链打完（pierce=1 命中最近）→ 从最后受击者向 200px 内未受击最近者跳弹（全额伤害 + VFX 段）', () => {
    const state = createSimState(1);
    const onRay = makeEnemy(state, 360, 600); // 距 620：主射线上（pierce 1 只中它）
    const near = makeEnemy(state, 500, 600); // 距 onRay 140 ≤ 200：跳弹目标（距角色 635.6 更远）
    makeEnemy(state, 500, 350); // 距 onRay 286.5 > 200：范围外不跳（距角色 881 更远）

    behavior.fire(state, 'rail_piercer', makeStats({ pierce: 1, ricochet: 1, ricochetRange: 200 }));

    expect(onRay.hp).toBe(90);
    expect(near.hp).toBe(90); // 跳弹追加全额结算
    expect(state.enemies[2].hp).toBe(100); // 范围外不受击
    const vfx = state.meta['rail_vfx:rail_piercer'] as {
      segments: Array<{ x1: number; y1: number; x2: number; y2: number }>;
    };
    expect(vfx.segments).toHaveLength(2); // 主射线 + 跳弹段
    expect(vfx.segments[1].x1).toBeCloseTo(onRay.x, 6);
    expect(vfx.segments[1].y1).toBeCloseTo(onRay.y, 6);
    expect(vfx.segments[1].x2).toBeCloseTo(near.x, 6);
    expect(vfx.segments[1].y2).toBeCloseTo(near.y, 6);
  });

  it('跳弹不重复结算已受击者；主射线无受击者不跳弹', () => {
    const state = createSimState(1);
    // 主射线上 2 个敌人（pierce 2 全中）：跳弹必须落在两者之外的未受击者
    makeEnemy(state, 360, 600);
    makeEnemy(state, 360, 400);
    makeEnemy(state, 360, 300); // 距最后受击者 (360,400) 100 ≤ 200：第三个被跳弹命中
    behavior.fire(state, 'rail_piercer', makeStats({ pierce: 2, ricochet: 1, ricochetRange: 200 }));
    expect(state.enemies.map((e) => e.hp)).toEqual([90, 90, 90]); // 链 2 + 跳弹 1

    // 范围内无未受击者：链已覆盖 → 不产生跳弹段
    const all = createSimState(1);
    makeEnemy(all, 360, 600);
    makeEnemy(all, 360, 400);
    makeEnemy(all, 360, 150); // 距最后受击者 (360,400) 250 > 200：链外且跳弹不及
    behavior.fire(all, 'rail_piercer', makeStats({ pierce: 2, ricochet: 1, ricochetRange: 200 }));
    expect(all.enemies.map((e) => e.hp)).toEqual([90, 90, 100]);
    const allVfx = all.meta['rail_vfx:rail_piercer'] as { segments: unknown[] };
    expect(allVfx.segments).toHaveLength(1); // 仅主射线：无跳弹段
  });
});

describe('蓄力增伤（charge_damage 牌：连续命中同一目标叠层、换目标清零）', () => {
  it('连续开火同一目标：首发无加成 → 第 2 连击 ×1.08、第 3 连击 ×1.16；槽位按 weaponId 记 {targetId, stacks}', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 600, 1e6);
    const stats = makeStats({ chargeDamagePerStack: 0.08, chargeDamageMaxStacks: 10 });

    behavior.fire(state, 'rail_piercer', stats);
    expect(e.hp).toBeCloseTo(1e6 - 10, 6); // 首发无加成
    behavior.fire(state, 'rail_piercer', stats);
    expect(e.hp).toBeCloseTo(1e6 - 10 - 10.8, 6); // 第 2 连击 ×1.08
    behavior.fire(state, 'rail_piercer', stats);
    expect(e.hp).toBeCloseTo(1e6 - 10 - 10.8 - 11.6, 6); // 第 3 连击 ×1.16

    const slot = state.meta['rail_charge:rail_piercer'] as { targetId: number; stacks: number };
    expect(slot.targetId).toBe(e.id);
    expect(slot.stacks).toBe(3);
  });

  it('层数封顶 maxStacks（10 层 = +80%，不超上限）；换目标清零重计；无牌不建槽', () => {
    const state = createSimState(1);
    const a = makeEnemy(state, 360, 600, 1e6);
    const stats = makeStats({ chargeDamagePerStack: 0.08, chargeDamageMaxStacks: 10 });
    behavior.fire(state, 'rail_piercer', stats); // 首发无加成（stacks 0→1）
    (state.meta['rail_charge:rail_piercer'] as { stacks: number }).stacks = 10; // 置满：封顶状态
    behavior.fire(state, 'rail_piercer', stats);
    expect(a.hp).toBeCloseTo(1e6 - 10 - 18, 6); // ×1.8 封顶（+80%）
    expect((state.meta['rail_charge:rail_piercer'] as { stacks: number }).stacks).toBe(10); // 恰在 maxStacks

    // 换目标：清零重计（a 死亡 → 打 b：首发无加成 10）
    a.dead = true;
    const b = makeEnemy(state, 360, 700, 1e6);
    behavior.fire(state, 'rail_piercer', stats);
    expect(b.hp).toBeCloseTo(1e6 - 10, 6);
    const slot = state.meta['rail_charge:rail_piercer'] as { targetId: number; stacks: number };
    expect(slot.targetId).toBe(b.id);
    expect(slot.stacks).toBe(1);

    // 无牌：不建槽、伤害恒定
    const plain = createSimState(1);
    const c = makeEnemy(plain, 360, 600, 1e6);
    for (let i = 0; i < 3; i++) {
      behavior.fire(plain, 'rail_piercer', makeStats());
    }
    expect(c.hp).toBeCloseTo(1e6 - 30, 6);
    expect(plain.meta['rail_charge:rail_piercer']).toBeUndefined();
  });
});
