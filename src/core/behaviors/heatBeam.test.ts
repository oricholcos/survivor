// src/core/behaviors/heatBeam.test.ts —— 灼热光束（单体锁定持续光束 + 协同开火）行为契约：
// 单体锁定结算（线上其他敌人不掉血）、四级优先级（死亡重选时生效）与粘性锁定（G2b：绑定
// 目标存活就保持锁定、出程照打、Boss 进场不夺锁、死亡才重选）、lockRange 索敌半径、
// 加载爬升（两束各自独立、同目标也独立、死亡重选清零）、次级束目标规则（粘性 + 避开主束/
// 无候选时同目标）与 25% 伤害、协同按目标共用计数（同目标共同推进、不同目标各自推进、
// 次级束目标先达 30 以它触发、主束转锁次级目标计数保留合流、死亡路径作废、一跳至多一次
// 触发）、协同齐射（强制锁定组真实触发一次/指定目标生效、霰弹与震波壁垒不锁定、空转恢复
// 冷却、真实开火不恢复、门槛过滤）、协同触发特效与音效（G6：触发写 coordinated_fire_vfx
// 单对象覆写 meta + 一次性 coordinated sfx；未触发/尸体不写不推；覆写取最新；契约常量）、
// 灼痕附着（逐跳 2 伤 + dot 频率覆盖 + 致死不附着）、
// VFX meta 约定、数值全部来自 weapons/heat_beam.json 真实表、解释器集成、同种子可复现（零随机）。
import { describe, expect, it } from 'vitest';
import { loadEffectDefs } from '../../data/effects';
import { loadWeaponDefs } from '../../data/weapons';
import { hasEffect, updateEffects } from '../effects';
import { createSimState } from '../simState';
import type { Enemy, SimState } from '../types';
import { addWeapon, getWeaponStats, updateWeapons } from '../weapons';
import type { WeaponDef, WeaponStats } from '../weapons';
import { behavior } from './behavior_heatBeam';
import { COORDINATED_FIRE_VFX_KEY, COORDINATED_FIRE_VFX_MS } from './behavior_heatBeam';
import type { CoordinatedFireVfx, HeatBeamCounters, HeatBeamVfx } from './behavior_heatBeam';
import { getBehavior, registerBehavior } from './registry';
import './index'; // 副作用：自动发现注册

// 副作用：把 effects.json 真实效果表注册进 core/effects（burn 效果槽依赖）。
loadEffectDefs();

/** 敌人夹具选项（默认静止 march 怪）。 */
interface EnemyOpts {
  hp?: number;
  speed?: number;
  isBoss?: boolean;
  state?: 'march' | 'attack';
}

/** 构造一个静止敌人夹具（数值仅存在于测试夹具）。 */
function makeEnemy(state: SimState, x: number, y: number, opts: EnemyOpts = {}): Enemy {
  const hp = opts.hp ?? 1e6;
  const e: Enemy = {
    id: state.nextId++,
    typeId: 'tester',
    name: '测试怪',
    x,
    y,
    radius: 10,
    hp,
    maxHp: hp,
    speed: opts.speed ?? 0,
    damage: 0,
    attackIntervalMs: 1000,
    attackCooldownMs: 1000,
    state: opts.state ?? 'march',
    isBoss: opts.isBoss ?? false,
    xp: 1,
    color: 0xffffff,
    shape: 'box',
    effects: [],
    dead: false,
  };
  state.enemies.push(e);
  return e;
}

const REAL_DEFS = loadWeaponDefs();

/**
 * 以真实数据表 heat_beam.json 的指定牌组 stats 直调 fire 一次。
 * 牌池制：cards 数组即该武器已吃的牌（重复项 = 可重复牌多张）；直接改写 cards 对象
 * （cardsRef 变化 → stats 缓存按契约重建）并同步自增 cardsVersion。
 */
function fireOnce(state: SimState, cards: string[] = [], weaponId = 'heat_beam'): WeaponStats {
  const def = REAL_DEFS[weaponId];
  if (!state.weaponStates[weaponId]) {
    state.weaponStates[weaponId] = { level: 0, cooldownMs: 0, cards: {}, cardsVersion: 0 };
  }
  const ws = state.weaponStates[weaponId];
  ws.cards = {};
  for (const cardId of cards) {
    ws.cards[cardId] = (ws.cards[cardId] ?? 0) + 1;
  }
  ws.level = cards.length;
  ws.cardsVersion = (ws.cardsVersion ?? 0) + 1;
  const stats = getWeaponStats(def, state, weaponId);
  getBehavior(def.behavior).fire(state, weaponId, stats);
  return stats;
}

/** 读某武器灼热光束计数器 meta 条目（懒初始化前视为 undefined）。 */
function countersOf(state: SimState, weaponId = 'heat_beam'): HeatBeamCounters | undefined {
  return state.meta[`heat_beam_state:${weaponId}`] as HeatBeamCounters | undefined;
}

/** 读某武器的 VFX meta 条目。 */
function vfxOf(state: SimState, weaponId = 'heat_beam'): HeatBeamVfx | undefined {
  return state.meta[`heat_beam_vfx:${weaponId}`] as HeatBeamVfx | undefined;
}

/** 读协同开火触发 VFX meta 条目（G6：单对象覆写式）。 */
function coordinatedVfxOf(state: SimState): CoordinatedFireVfx | undefined {
  return state.meta[COORDINATED_FIRE_VFX_KEY] as CoordinatedFireVfx | undefined;
}

/** 统计事件队列中 'coordinated' sfx 的条数。 */
function coordinatedSfxCount(state: SimState): number {
  return state.events.filter((ev) => ev.kind === 'sfx' && ev.name === 'coordinated').length;
}

// 角色 (360, 1220)；lockRange 365 → 索敌圆上边 y = 855。
describe('单体锁定结算（纯单体：线上/邻近其他敌人不掉血）', () => {
  it('锁定最近目标单体结算 9 伤；同一直线上更远的敌人不掉血；无弹丸', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    const a = makeEnemy(state, 360, 1000); // 距 220：最近 → 主束目标
    const b = makeEnemy(state, 360, 880); // 距 340 ≤ 365：同线更远但仍处索敌半径内
    const stats = fireOnce(state);

    expect(stats.damage).toBe(9); // base 表值（G3 增强）
    expect(a.hp).toBeCloseTo(1e6 - 9, 6);
    expect(b.hp).toBe(1e6); // 纯单体结算：不穿透线上敌人
    expect(state.projectiles).toHaveLength(0); // 无弹丸
  });

  it('全部敌人超出 lockRange（且无存活绑定目标）：不开火（无 VFX）、冷却归 0；解释器随后推进一个 intervalMs', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    const enemy = makeEnemy(state, 360, 850); // 距 370 > 365
    state.weaponStates.heat_beam.cooldownMs = 500;

    fireOnce(state);

    expect(enemy.hp).toBe(1e6);
    expect(vfxOf(state)).toBeUndefined();
    expect(countersOf(state)).toBeUndefined(); // 未推进任何计数
    expect(state.weaponStates.heat_beam.cooldownMs).toBe(0); // 重试标记

    updateWeapons(state, 16, { heat_beam: REAL_DEFS.heat_beam });
    expect(state.weaponStates.heat_beam.cooldownMs).toBe(200); // 0 → fire 归 0 → += 200
  });

  it('四级优先级：Boss > 贴墙 attack > 快速 > 最近（各级压过更近的低级候选；首锁与死亡重选时生效）', () => {
    // Boss 层：更近的普通怪让位。
    const bossCase = createSimState(1);
    const boss = makeEnemy(bossCase, 360, 1100, { isBoss: true }); // 距 120
    const near = makeEnemy(bossCase, 360, 1150); // 距 70：最近但非 Boss
    fireOnce(bossCase);
    expect(boss.hp).toBeCloseTo(1e6 - 9, 6);
    expect(near.hp).toBe(1e6);

    // attack 层：贴墙怪压过快速行军怪。
    const attackCase = createSimState(1);
    const attacker = makeEnemy(attackCase, 300, 1150, { state: 'attack', speed: 10 }); // 距 ~92
    const fast = makeEnemy(attackCase, 360, 1150, { speed: 100 }); // 距 70 ≥ 阈值 80
    fireOnce(attackCase);
    expect(attacker.hp).toBeCloseTo(1e6 - 9, 6);
    expect(fast.hp).toBe(1e6);

    // fast 层：快速怪压过更近的慢速怪。
    const fastCase = createSimState(1);
    const fastFar = makeEnemy(fastCase, 300, 1150, { speed: 100 }); // 距 ~92
    const slowNear = makeEnemy(fastCase, 360, 1180, { speed: 10 }); // 距 40：最近但慢
    fireOnce(fastCase);
    expect(fastFar.hp).toBeCloseTo(1e6 - 9, 6);
    expect(slowNear.hp).toBe(1e6);
  });

  it('死亡重选清零（加载）：主目标死亡转锁新目标后从基础伤害重新爬升', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    const a = makeEnemy(state, 360, 1000); // 距 220：主目标
    const b = makeEnemy(state, 360, 900); // 距 320：次近
    fireOnce(state, ['load_up']);
    fireOnce(state, ['load_up']);
    expect(a.hp).toBeCloseTo(1e6 - 9 - 9.45, 6); // 第 1 跳 9、第 2 跳 9×1.05

    a.dead = true; // 主目标死亡
    fireOnce(state, ['load_up']); // 转锁 b：加载清零 → 恰为基础伤害 9
    expect(b.hp).toBeCloseTo(1e6 - 9, 6);
    expect(countersOf(state)!.mainTargetId).toBe(b.id);
  });
});

describe('加载爬升（两束各自独立；同目标也独立；次级束 25%）', () => {
  it('单敌人（次级束回落同目标）：主束第 k 跳 = 9×(1+0.05×(k-1))，次级束另乘 0.25', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    const a = makeEnemy(state, 360, 1000);
    fireOnce(state, ['load_up', 'second_flash']);
    expect(a.hp).toBeCloseTo(1e6 - 9 - 2.25, 6); // 首跳：9 + 9×0.25

    fireOnce(state, ['load_up', 'second_flash']);
    expect(a.hp).toBeCloseTo(1e6 - 9 - 2.25 - 9.45 - 2.3625, 6); // 主 9×1.05、次 ×0.25

    fireOnce(state, ['load_up', 'second_flash']);
    // 关键独立性断言：主束第 3 跳 = 9×1.1（若两束共用计数应为 9×(1+0.05×4)）。
    expect(a.hp).toBeCloseTo(1e6 - 9 - 2.25 - 9.45 - 2.3625 - 9.9 - 2.475, 6);
  });

  it('双目标各一束：死亡重选只清该束自己的计数（次级束计数跨主束重选保留）', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    const a = makeEnemy(state, 360, 1000); // 主束目标
    const b = makeEnemy(state, 360, 900); // 次级束目标
    fireOnce(state, ['load_up', 'second_flash']);
    fireOnce(state, ['load_up', 'second_flash']);
    expect(a.hp).toBeCloseTo(1e6 - 9 - 9.45, 6);
    expect(b.hp).toBeCloseTo(1e6 - 2.25 - 2.3625, 6);

    a.dead = true; // 主束被迫转锁 b；次级束本来就绑定 b（粘性保持）
    fireOnce(state, ['load_up', 'second_flash']);
    // 主束死亡重选 → 清零重爬：恰 9；次级束未换目标 → 继续爬：9×1.1×0.25。
    expect(b.hp).toBeCloseTo(1e6 - 2.25 - 2.3625 - 9 - 2.475, 6);
    expect(countersOf(state)!.mainLoad).toBe(1);
    expect(countersOf(state)!.secLoad).toBe(3);
  });
});

describe('次级光束目标规则（第二闪光）', () => {
  it('多目标时避开主束目标：主束打最近、次级束打四级优先级次高者；VFX 两段各指其目标', () => {
    const state = createSimState(1);
    const a = makeEnemy(state, 360, 1000); // 距 220：主束
    const b = makeEnemy(state, 360, 900); // 距 320：次级束
    fireOnce(state, ['second_flash']);

    expect(a.hp).toBeCloseTo(1e6 - 9, 6);
    expect(b.hp).toBeCloseTo(1e6 - 2.25, 6); // 主束的 25%

    const vfx = vfxOf(state)!;
    expect(vfx.segments).toHaveLength(2);
    expect(vfx.segments[0]).toEqual({ x1: 360, y1: 1220, x2: 360, y2: 1000 }); // 主束连到目标
    expect(vfx.segments[1]).toEqual({ x1: 360, y1: 1220, x2: 360, y2: 900 }); // 次级束
    expect(vfx.untilMs).toBe(state.timeMs + 80);
  });

  it('排除主束目标后无候选 → 次级束改打主束目标（同目标双束）', () => {
    const state = createSimState(1);
    const only = makeEnemy(state, 360, 1000);
    fireOnce(state, ['second_flash']);
    expect(only.hp).toBeCloseTo(1e6 - 9 - 2.25, 6); // 主 + 次（25%）同落一个目标
    expect(vfxOf(state)!.segments).toHaveLength(2);
    expect(vfxOf(state)!.segments[1].x2).toBe(360);
    expect(vfxOf(state)!.segments[1].y2).toBe(1000);
  });

  it('未持第二闪光：只有主束一段 VFX、一次结算', () => {
    const state = createSimState(1);
    const only = makeEnemy(state, 360, 1000);
    fireOnce(state);
    expect(only.hp).toBeCloseTo(1e6 - 9, 6);
    expect(vfxOf(state)!.segments).toHaveLength(1);
  });
});

describe('粘性锁定（G2b：目标存活就保持锁定并持续结算，死亡才重选）', () => {
  it('被击推出 lockRange 后继续受击：出程照常结算、VFX 延伸、加载继续爬升、冷却不被归 0', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    const a = makeEnemy(state, 360, 1000); // 距 220 ≤ 365：首锁
    state.weaponStates.heat_beam.cooldownMs = 400;
    fireOnce(state, ['load_up']);
    expect(a.hp).toBeCloseTo(1e6 - 9, 6);

    a.y = 700; // 被击退/黑洞等推出索敌半径：距 520 > 365
    const stats = fireOnce(state, ['load_up']);
    expect(stats.lockRange).toBe(365); // 目标确已出程（520 > 365）仍照常开火
    expect(a.hp).toBeCloseTo(1e6 - 9 - 9.45, 6); // 继续结算且加载爬升（第 2 跳 9×1.05）
    expect(countersOf(state)!.mainLoad).toBe(2);
    expect(vfxOf(state)!.segments[0].y2).toBe(700); // VFX 照常延伸到出程目标当前位置
    expect(state.weaponStates.heat_beam.cooldownMs).toBe(400); // 真实开火：冷却未被归 0
  });

  it('Boss 进场不夺锁：存活目标保持锁定（四级优先级只在死亡重选时生效）', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    const a = makeEnemy(state, 360, 1000); // 距 220：首锁
    fireOnce(state);
    const boss = makeEnemy(state, 360, 1100, { isBoss: true }); // 距 120：更近且四级最高优先
    fireOnce(state);
    expect(a.hp).toBeCloseTo(1e6 - 9 - 9, 6); // 主束仍打 a
    expect(boss.hp).toBe(1e6);
    expect(countersOf(state)!.mainTargetId).toBe(a.id);
  });

  it('「无目标」判定只在死亡重选路径：出程目标存活但范围内无其他敌人 ≠ 无目标', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    const a = makeEnemy(state, 360, 1000);
    fireOnce(state); // 绑定 a
    a.y = 700; // 出程（距 520），场上再无其他敌人

    state.weaponStates.heat_beam.cooldownMs = 400;
    fireOnce(state);
    expect(a.hp).toBeCloseTo(1e6 - 9 - 9, 6); // 仍开火（目标存在，只是出程——粘性锁定例外）
    expect(state.weaponStates.heat_beam.cooldownMs).toBe(400); // 未触发「无目标归 0」

    const vfxBefore = vfxOf(state);
    a.dead = true; // 绑定目标死亡：此时才走「无目标」路径
    state.weaponStates.heat_beam.cooldownMs = 400;
    fireOnce(state);
    expect(state.weaponStates.heat_beam.cooldownMs).toBe(0); // 死亡重选无候选 → 冷却归 0
    expect(vfxOf(state)).toBe(vfxBefore); // 未开火：VFX meta 未被重写（同一对象引用）
  });

  it('出程目标死亡后恢复四级优先级重选：范围内的新目标被正常选中', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    const a = makeEnemy(state, 360, 1000);
    fireOnce(state);
    a.y = 700; // 出程
    const b = makeEnemy(state, 360, 1050); // 距 170：范围内
    fireOnce(state);
    expect(a.hp).toBeCloseTo(1e6 - 9 - 9, 6); // 粘性：继续打出程的 a
    expect(b.hp).toBe(1e6);

    a.dead = true;
    fireOnce(state);
    expect(b.hp).toBeCloseTo(1e6 - 9, 6); // 死亡重选：四级优先级在范围内选中 b
    expect(countersOf(state)!.mainTargetId).toBe(b.id);
  });

  it('次级束同粘性规则：自己的目标存活时 Boss 进场也不换；死亡重选避开主束目标', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    const a = makeEnemy(state, 360, 1000); // 主束
    const b = makeEnemy(state, 360, 900); // 次级束（距 320）
    fireOnce(state, ['load_up', 'second_flash']);
    const boss = makeEnemy(state, 360, 1100, { isBoss: true }); // 距 120：排除主束后的最高优先者
    fireOnce(state, ['load_up', 'second_flash']);
    // 旧语义会把次级束转 Boss（四级优先级排除主束后 Boss 最近）；粘性语义保持 b。
    expect(b.hp).toBeCloseTo(1e6 - 2.25 - 2.3625, 6); // 次级束继续爬升（第 2 跳 9×1.05×0.25）
    expect(boss.hp).toBe(1e6);

    b.dead = true; // 次级束绑定死亡 → 重选（避开主束目标 a）→ Boss
    fireOnce(state, ['load_up', 'second_flash']);
    expect(boss.hp).toBeCloseTo(1e6 - 2.25, 6);
    expect(a.hp).toBeCloseTo(1e6 - (9 + 9.45 + 9.9), 6); // 主束全程粘性照打 a（加载爬升 9→9.45→9.9）
    expect(countersOf(state)!.secTargetId).toBe(boss.id);
    expect(countersOf(state)!.secLoad).toBe(1); // 死亡重选：清零重爬
  });
});

describe('协同开火：按目标共用计数与触发', () => {
  it('两束同目标共同推进（+2/跳）：恰第 15 跳达 30 触发齐射（rail 真实命中），随后归零、第 30 跳再触发', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    addWeapon(state, 'rail_piercer');
    state.weaponStates.rail_piercer.cooldownMs = 777; // 真实开火不恢复的对照基准
    const a = makeEnemy(state, 360, 1000);

    // 第 14 跳：累计 28，未触发。
    for (let i = 0; i < 14; i++) {
      fireOnce(state, ['coordinated_fire', 'second_flash']);
    }
    const before14 = a.hp;
    fireOnce(state, ['coordinated_fire', 'second_flash']); // 第 15 跳：30 → 触发
    expect(a.hp).toBeCloseTo(before14 - 9 - 2.25 - 10, 6); // 主 9 + 次 2.25 + rail 10（base 表值）
    expect(state.weaponStates.rail_piercer.cooldownMs).toBe(777); // 真实开火：冷却不被触碰
    expect(countersOf(state)!.coordCounts[String(a.id)]).toBe(0); // 归零重新累计

    // 第 16~29 跳：再攒 28，未触发。
    for (let i = 0; i < 14; i++) {
      fireOnce(state, ['coordinated_fire', 'second_flash']);
    }
    const before30 = a.hp;
    fireOnce(state, ['coordinated_fire', 'second_flash']); // 第 30 跳：第二次触发
    expect(a.hp).toBeCloseTo(before30 - 9 - 2.25 - 10, 6);
  });

  it('不同目标各自推进：主束目标先到 30 以它触发（rail 只中它），次级束目标下一跳以自己触发', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    addWeapon(state, 'rail_piercer');
    const a = makeEnemy(state, 300, 1050); // 距 ~180：主束目标（rail 射线不过 b）
    const b = makeEnemy(state, 420, 1000); // 距 ~228：次级束目标（rail 射线不过 a）

    for (let i = 0; i < 29; i++) {
      fireOnce(state, ['coordinated_fire', 'second_flash']);
    }
    expect(countersOf(state)!.coordCounts[String(a.id)]).toBe(29);
    expect(countersOf(state)!.coordCounts[String(b.id)]).toBe(29);

    const aBefore = a.hp;
    const bBefore = b.hp;
    fireOnce(state, ['coordinated_fire', 'second_flash']); // a 30 → 触发（一跳至多一次：b 同跳达 30 不触发）
    expect(a.hp).toBeCloseTo(aBefore - 9 - 10, 6); // 主束 + rail
    expect(b.hp).toBeCloseTo(bBefore - 2.25, 6); // 只吃次级束（rail 射线不过它）
    expect(countersOf(state)!.coordCounts[String(b.id)]).toBe(30); // 已达阈值但本跳不再触发

    const aBefore2 = a.hp;
    const bBefore2 = b.hp;
    fireOnce(state, ['coordinated_fire', 'second_flash']); // b 31 → 以 b 触发
    expect(b.hp).toBeCloseTo(bBefore2 - 2.25 - 10, 6); // 次级束 + rail
    expect(a.hp).toBeCloseTo(aBefore2 - 9, 6); // 只吃主束
    expect(countersOf(state)!.coordCounts[String(a.id)]).toBe(1); // 上一跳触发后重新累计
  });

  it('主束转锁次级束目标：该目标已有协同计数保留并合流（共同推进）', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    const a = makeEnemy(state, 360, 1000); // 主束
    const b = makeEnemy(state, 360, 900); // 次级束
    for (let i = 0; i < 5; i++) {
      fireOnce(state, ['coordinated_fire', 'second_flash']);
    }
    expect(countersOf(state)!.coordCounts[String(a.id)]).toBe(5);
    expect(countersOf(state)!.coordCounts[String(b.id)]).toBe(5);

    a.dead = true; // 主束转锁 b（次级束排除主束后无候选 → 也打 b）
    fireOnce(state, ['coordinated_fire', 'second_flash']);
    // b 原有 5 保留，本跳两束共同推进 +2 = 7（若重置应为 2）。
    expect(countersOf(state)!.coordCounts[String(b.id)]).toBe(7);
  });

  it('不再被任一束瞄准的目标计数作废（只发生在死亡重选路径）；Boss 进场不夺锁（G2b 粘性）', () => {
    const state = createSimState(1);
    const a = makeEnemy(state, 360, 1000); // 主束（粘性绑定）
    const b = makeEnemy(state, 360, 900); // 次级束
    for (let i = 0; i < 3; i++) {
      fireOnce(state, ['coordinated_fire', 'second_flash']);
    }
    expect(countersOf(state)!.coordCounts[String(a.id)]).toBe(3);
    expect(countersOf(state)!.coordCounts[String(b.id)]).toBe(3);

    const boss = makeEnemy(state, 360, 1100, { isBoss: true }); // Boss 进场（距 120，四级最高优先）
    fireOnce(state, ['coordinated_fire', 'second_flash']);
    // G2b 粘性锁定：a 存活 → 主束不转 Boss；次级束绑定 b 存活且非主束目标 → 也不换。
    expect(countersOf(state)!.mainTargetId).toBe(a.id);
    expect(countersOf(state)!.coordCounts[String(a.id)]).toBe(4);
    expect(countersOf(state)!.coordCounts[String(b.id)]).toBe(4);
    expect(boss.hp).toBe(1e6); // Boss 未被任何束瞄准

    b.dead = true; // 次级束绑定目标死亡 → 重选：四级优先级排除主束目标 a → Boss
    fireOnce(state, ['coordinated_fire', 'second_flash']);
    const counters = countersOf(state)!;
    expect(counters.coordCounts[String(b.id)]).toBeUndefined(); // b 已死且不再被瞄准：计数作废
    expect(counters.coordCounts[String(a.id)]).toBe(5); // 主束粘性照常推进
    expect(counters.coordCounts[String(boss.id)]).toBe(1); // 次级束死亡重选转 Boss
  });

  it('协同齐射全队真实触发一次：导弹 targetId/狙击/棱镜初速指向触发目标、榴弹以它为密度锚点、贯穿炮射线命中', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    for (const wid of ['charge_sniper', 'prism', 'homing_missile', 'mortar', 'rail_piercer']) {
      addWeapon(state, wid);
      state.weaponStates[wid].cooldownMs = 1234; // 真实开火不恢复的对照基准
    }
    const decoy = makeEnemy(state, 600, 700); // 榴弹密度并列裁决靠数组前者（不被热束锁定：距 572 超程）
    const a = makeEnemy(state, 360, 1000); // 热束目标（静态 → 落点/初速都指向它）

    for (let i = 0; i < 14; i++) {
      fireOnce(state, ['coordinated_fire', 'second_flash']);
    }
    expect(state.projectiles).toHaveLength(0); // 触发前全队未开火（各武器冷却未到）

    fireOnce(state, ['coordinated_fire', 'second_flash']); // 第 15 跳触发齐射
    expect(a.hp).toBeCloseTo(1e6 - (14 * 11.25 + 9 + 2.25) - 10, 6); // 热束累计（9+2.25/跳）+ rail 10

    const sniper = state.projectiles.filter((p) => p.behavior === 'charge_sniper');
    const prisms = state.projectiles.filter((p) => p.behavior === 'prism_chain');
    const missiles = state.projectiles.filter((p) => p.behavior === 'homing_missile');
    const shells = state.projectiles.filter((p) => p.behavior === 'mortar');
    expect(sniper).toHaveLength(1); // 每武器恰真实触发一次
    expect(prisms).toHaveLength(1);
    expect(missiles).toHaveLength(1);
    expect(shells).toHaveLength(1);
    expect(missiles[0].data.targetId).toBe(a.id); // 导弹 targetId 指向触发目标
    // 狙击/棱镜初速朝向触发目标（静态目标无提前量偏移）。
    const aimDot = (p: { vx: number; vy: number }): number =>
      p.vx * (a.x - state.character.x) + p.vy * (a.y - state.character.y);
    expect(aimDot(sniper[0])).toBeGreaterThan(0);
    expect(aimDot(prisms[0])).toBeGreaterThan(0);
    // 榴弹以触发目标为密度锚点（正常密度并列会选数组先者的 decoy）。
    expect(shells[0].data.tx).toBeCloseTo(a.x, 6);
    expect(shells[0].data.ty).toBeCloseTo(a.y, 6);
    void decoy;
    // 真实开火不恢复：全部保持快照值。
    for (const wid of ['charge_sniper', 'prism', 'homing_missile', 'mortar', 'rail_piercer']) {
      expect(state.weaponStates[wid].cooldownMs).toBe(1234);
    }
  });

  it('霰弹与震波壁垒不锁定：按各自正常逻辑发动（霰弹朝上扇形、震波发出行进波）', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    addWeapon(state, 'scatter');
    addWeapon(state, 'seismic_wall');
    state.weaponStates.scatter.cooldownMs = 500;
    state.weaponStates.seismic_wall.cooldownMs = 600;
    const a = makeEnemy(state, 300, 1130); // 距 108（霰弹 effRange 455 内）|y-1160|=30 ≤ 260 可达
    const b = makeEnemy(state, 5, 1122); // 距 ~368 > 365：热束够不到；可达（38 ≤ 260）
    const c = makeEnemy(state, 5, 1000); // 距 ~418：热束够不到；可达（160 ≤ 260）但波前未到

    for (let i = 0; i < 14; i++) {
      fireOnce(state, ['coordinated_fire', 'second_flash']);
    }
    expect(state.projectiles).toHaveLength(0);
    expect(b.hp).toBe(1e6); // 触发前不参与任何结算
    expect(c.hp).toBe(1e6);

    fireOnce(state, ['coordinated_fire', 'second_flash']); // 第 15 跳触发（两束同打 a：+2/跳）
    // 霰弹：固定朝上扇形 5 枚（不受目标位置影响——不锁定）。
    const scatterShots = state.projectiles.filter((p) => p.behavior === 'scatter_shot');
    expect(scatterShots).toHaveLength(5);
    for (const p of scatterShots) {
      expect(p.vy).toBeLessThan(0); // 一律朝上
    }
    expect(scatterShots[2].vx).toBeCloseTo(0, 9); // 正中一枚竖直向上（扇形而非指向目标）
    // 震波壁垒：发出行进波，t=0 出生走廊（|y-1160| ≤ 40）在 fire 内立即结算——
    // a/b 都掉 35（G4 增强）；c 在深度 160，波前尚未经过（后续帧才扫到，本 tick 不掉血）。
    expect(a.hp).toBeCloseTo(1e6 - (14 * 11.25 + 9 + 2.25) - 35, 6);
    expect(b.hp).toBeCloseTo(1e6 - 35, 6);
    expect(c.hp).toBe(1e6);
    // 真实开火不恢复冷却。
    expect(state.weaponStates.scatter.cooldownMs).toBe(500);
    expect(state.weaponStates.seismic_wall.cooldownMs).toBe(600);
  });

  it('空转恢复冷却（桩行为空转写 0 → 恢复快照，不影响被触发武器节奏）', () => {
    const realRail = getBehavior('piercing_bolt');
    let stubCalls = 0;
    registerBehavior({
      name: 'piercing_bolt',
      fire: (s, wid) => {
        stubCalls++;
        const ws = s.weaponStates[wid];
        if (ws) {
          ws.cooldownMs = 0; // 借「无目标归 0」约定模拟空转
        }
      },
    });
    try {
      const state = createSimState(1);
      addWeapon(state, 'heat_beam');
      addWeapon(state, 'rail_piercer');
      state.weaponStates.rail_piercer.cooldownMs = 777;
      makeEnemy(state, 360, 1000);

      for (let i = 0; i < 29; i++) {
        fireOnce(state, ['coordinated_fire']);
      }
      expect(stubCalls).toBe(0);
      fireOnce(state, ['coordinated_fire']); // 第 30 跳触发
      expect(stubCalls).toBe(1);
      expect(state.weaponStates.rail_piercer.cooldownMs).toBe(777); // 空转被恢复：节奏不受影响
    } finally {
      registerBehavior(realRail); // 还原真实行为（注册表同名后注册者胜）
    }
  });

  it('门槛过滤（震波壁垒）：触发目标不在其行进波可达范围内 → 震波被跳过（F3 行进波语义；G4 后可达范围 260）', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    addWeapon(state, 'seismic_wall');
    // G4 增强后可达范围 = 行进 220 + 波前厚 40 = 260。a 距墙线 300 > 260：门槛拦下
    //（G4 前该用例用深度 260 拦截，行进距离 160→220 后 260 变为恰可达，故外推到 300）。
    const a = makeEnemy(state, 360, 860); // 距 360 ≤ 365（热束可锁）；|y-1160|=300（不可达）
    const canary = makeEnemy(state, 5, 1122); // 距 ~368 > 365（热束够不到）；可达（38 ≤ 260）——震波若误发，出生走廊必伤它

    for (let i = 0; i < 29; i++) {
      fireOnce(state, ['coordinated_fire']);
    }
    fireOnce(state, ['coordinated_fire']); // 第 30 跳触发：a 不可达 → 震波被门槛跳过
    expect(a.hp).toBeCloseTo(1e6 - 30 * 9, 6); // 只吃热束（无震波 35 伤）
    expect(canary.hp).toBe(1e6); // 可达金丝雀未掉血：震波确实没有发动
    expect(state.meta['seismic_pulse_vfx']).toBeUndefined(); // 无 sweep/VFX
  });

  it('门槛过滤（霰弹）：触发目标超 effRange → 霰弹被跳过（热束射程经范围牌扩到 effRange 之外）', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    addWeapon(state, 'scatter');
    // 2 张范围强化：lockRange = 365×1.2² ≈ 525.6 > 455（霰弹 effRange = 700×0.65）。
    const a = makeEnemy(state, 360, 760); // 距 460：热束（525.6）可锁、霰弹（455）够不到

    for (let i = 0; i < 29; i++) {
      fireOnce(state, ['coordinated_fire', 'range_up', 'range_up']);
    }
    expect(state.projectiles).toHaveLength(0);
    fireOnce(state, ['coordinated_fire', 'range_up', 'range_up']); // 第 30 跳触发
    expect(a.hp).toBeCloseTo(1e6 - 30 * 9, 6); // 只吃热束
    expect(state.projectiles.filter((p) => p.behavior === 'scatter_shot')).toHaveLength(0); // 霰弹被门槛跳过
  });
});

describe('协同开火触发特效与音效（G6：coordinated_fire_vfx 单对象覆写 + 一次性 coordinated sfx）', () => {
  it('契约常量：键名 coordinated_fire_vfx / 留存 350ms（视图「前 60% 扩散、后 40% 淡出」按此消费，两端常量同源导入）', () => {
    expect(COORDINATED_FIRE_VFX_KEY).toBe('coordinated_fire_vfx');
    expect(COORDINATED_FIRE_VFX_MS).toBe(350);
  });

  it('触发时写入 meta（坐标 = 触发目标当前位置、untilMs = 时刻 + 350）+ 一次性 coordinated sfx 入队；触发前不写不推', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    makeEnemy(state, 360, 1000);
    state.timeMs = 1000;

    for (let i = 0; i < 14; i++) {
      fireOnce(state, ['coordinated_fire', 'second_flash']); // 两束同目标 +2/跳：第 14 跳累计 28
    }
    expect(coordinatedVfxOf(state)).toBeUndefined(); // 门槛未达：不写
    expect(coordinatedSfxCount(state)).toBe(0); // 门槛未达：不推

    fireOnce(state, ['coordinated_fire', 'second_flash']); // 第 15 跳：30 → 触发
    expect(coordinatedVfxOf(state)).toEqual({ x: 360, y: 1000, untilMs: 1350 });
    expect(coordinatedSfxCount(state)).toBe(1); // 一次性 sfx 不节流：恰一条
  });

  it('未触发（计数未达 30）不写不推：29 跳后 meta 键不存在、事件队列为空', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    const a = makeEnemy(state, 360, 1000);

    for (let i = 0; i < 29; i++) {
      fireOnce(state, ['coordinated_fire']); // 单束 +1/跳：累计 29 < 30
    }
    expect(state.meta[COORDINATED_FIRE_VFX_KEY]).toBeUndefined();
    expect(state.events).toHaveLength(0);
    expect(countersOf(state)!.coordCounts[String(a.id)]).toBe(29); // 计数照常推进（未达阈值）
  });

  it('单对象覆写：两次触发后 meta 为最新一次的坐标/时刻（无滚动数组、无旧条目残留）', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    const a = makeEnemy(state, 360, 1000);

    for (let i = 0; i < 15; i++) {
      fireOnce(state, ['coordinated_fire', 'second_flash']); // 第 15 跳第一次触发
    }
    expect(coordinatedVfxOf(state)).toEqual({ x: 360, y: 1000, untilMs: state.timeMs + 350 });

    state.timeMs = 5000; // 推进时刻：两次触发的 untilMs 可区分
    a.x = 420; // 触发目标当前位置已变（G2b 粘性锁定：出程照打）
    for (let i = 0; i < 15; i++) {
      fireOnce(state, ['coordinated_fire', 'second_flash']); // 计数归零后再攒 30：第 30 跳第二次触发
    }
    expect(coordinatedVfxOf(state)).toEqual({ x: 420, y: 1000, untilMs: 5350 }); // 覆写为最新一次
    expect(coordinatedSfxCount(state)).toBe(2); // 每次触发恰推一条
  });

  it('目标被本跳击杀（尸体无对象可锁）：计数达标也不触发——不写 meta、不推 sfx', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    makeEnemy(state, 360, 1000, { hp: 270 }); // 30 跳 × 9 伤：恰第 30 跳击杀（计数同跳达 30）

    for (let i = 0; i < 30; i++) {
      fireOnce(state, ['coordinated_fire']);
    }
    expect(state.meta[COORDINATED_FIRE_VFX_KEY]).toBeUndefined(); // 尸体不触发：不写
    expect(coordinatedSfxCount(state)).toBe(0); // 不推（击杀本身的 enemyKilled 事件为既有管线行为，不在断言内）
  });
});

describe('灼痕（scorch 灼痕牌）', () => {
  it('每跳命中给存活锁定目标挂 burn（逐实例覆盖每跳 2）；DoT 真实逐跳掉血', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1000, { hp: 100 });
    fireOnce(state, ['scorch']);

    expect(e.hp).toBeCloseTo(100 - 9, 6); // 直击 base damage 9
    expect(e.effects).toHaveLength(1);
    expect(e.effects[0].kind).toBe('burn');
    expect(e.effects[0].data.damagePerTick).toBe(2); // 逐实例覆盖（效果表默认 3）
    expect(e.effects[0].untilMs).toBe(state.timeMs + 3000);

    state.timeMs += 500;
    updateEffects(state, 500);
    expect(e.hp).toBeCloseTo(100 - 9 - 2, 6); // 每跳保底 2（100*0.02=2）
  });

  it('双束同打一目标：灼烧仍单实例（reset 刷新）；无灼痕牌不挂 burn', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1000);
    fireOnce(state, ['scorch', 'second_flash']);
    fireOnce(state, ['scorch', 'second_flash']);
    expect(e.effects).toHaveLength(1); // 重复命中只刷新
    expect(e.effects[0].data.damagePerTick).toBe(2);

    const plain = createSimState(1);
    const e2 = makeEnemy(plain, 360, 1000);
    fireOnce(plain, ['second_flash']);
    expect(e2.effects).toHaveLength(0);
  });

  it('被直击致死的敌人不挂灼烧（尸体无意义）；dot_freq 缩短灼烧 tick 间隔', () => {
    const state = createSimState(1);
    const frail = makeEnemy(state, 360, 1000, { hp: 5 }); // hp 恰等于一跳伤害
    fireOnce(state, ['scorch']);
    expect(frail.dead).toBe(true);
    expect(frail.effects).toHaveLength(0);

    const fast = createSimState(1);
    const e = makeEnemy(fast, 360, 1000);
    fireOnce(fast, ['scorch', 'dot_freq']);
    expect(e.effects[0].data.tickMs).toBeCloseTo(500 / 1.3, 9);
    expect(e.effects[0].data.damagePerTick).toBe(2);
  });
});

describe('数值全部来自 weapons/heat_beam.json（真实表驱动）', () => {
  const def = REAL_DEFS.heat_beam;

  it('表身份：id/name/behavior/maxLevel=10，behavior 已自动发现注册', () => {
    expect(def.id).toBe('heat_beam');
    expect(def.name).toBe('灼热光束');
    expect(def.behavior).toBe('heat_beam');
    expect(def.maxLevel).toBe(10);
    expect(getBehavior('heat_beam')).toBe(behavior);
  });

  it('牌目录：专属牌（scorch/load_up/coordinated_fire/second_flash）+ 适用通用牌；dot 前置灼痕', () => {
    expect(def.cards.slice(0, 4).map((c) => c.id)).toEqual([
      'scorch',
      'load_up',
      'coordinated_fire',
      'second_flash',
    ]);
    const ids = def.cards.map((c) => c.id);
    for (const genericId of ['dmg_up', 'spd_up', 'range_up', 'dot_freq']) {
      expect(ids).toContain(genericId);
    }
    for (const banned of ['multi_shot', 'burst_shot', 'split_shot', 'dual_beam', 'refract_up', 'cooling_up']) {
      expect(ids).not.toContain(banned); // 光束不吃弹道牌；旧牌（双束/折射/散热）已删除
    }
    const dot = def.cards.find((c) => c.id === 'dot_freq')!;
    expect(dot.requiresCard).toBe('scorch');
    expect(def.rangeKeys).toEqual(['lockRange']);
  });

  it('base 数值随表；旧过热槽/光束宽度键不再存在；牌组 stats 注入与范围乘区', () => {
    expect(def.base).toMatchObject({
      damage: 9,
      intervalMs: 200,
      lockRange: 365,
      fastSpeedThreshold: 80,
      projectileSpeed: 0,
      pierce: 0,
      ttlMs: 0,
    });
    for (const removed of ['beamWidth', 'beamRange', 'heatPerShot', 'coolPerSec', 'overheatThreshold']) {
      expect(def.base[removed]).toBeUndefined();
    }

    const state = createSimState(1);
    makeEnemy(state, 360, 1000);
    expect(fireOnce(state, ['load_up']).loadFactor).toBe(0.05);
    expect(fireOnce(state, ['coordinated_fire']).coordinatedThreshold).toBe(30);
    expect(fireOnce(state, ['second_flash']).secondaryDamageFactor).toBe(0.25);
    expect(fireOnce(state, ['range_up']).lockRange).toBeCloseTo(438, 9); // 365 × 1.2
    expect(fireOnce(state, ['scorch', 'dot_freq', 'dot_freq']).dotTickMult).toBeCloseTo(1.69, 9);
  });

  it('alt def（不同数值）驱动同一行为：伤害/索敌半径/频率全部随表', () => {
    const altDef: WeaponDef = {
      id: 'alt_heat',
      name: '替换光束',
      behavior: 'heat_beam',
      maxLevel: 10,
      base: {
        damage: 9,
        intervalMs: 300,
        lockRange: 500,
        fastSpeedThreshold: 50,
        projectileSpeed: 0,
        pierce: 0,
        ttlMs: 0,
      },
      rangeKeys: ['lockRange'],
      cards: [],
    };
    const state = createSimState(1);
    addWeapon(state, 'alt_heat');
    const altStats = getWeaponStats(altDef, state, 'alt_heat');
    const inRange = makeEnemy(state, 360, 750); // 距 470 ≤ 500
    const outRange = makeEnemy(state, 360, 700); // 距 520 > 500
    getBehavior('heat_beam').fire(state, 'alt_heat', altStats);
    expect(inRange.hp).toBeCloseTo(1e6 - 9, 6);
    expect(outRange.hp).toBe(1e6);
    expect(countersOf(state, 'alt_heat')!.mainLoad).toBe(1); // 计数按 weaponId 分键
  });
});

describe('解释器集成（updateWeapons 节奏）', () => {
  it('首帧真实开火：单体结算 9 伤，冷却 = -16 + 200', () => {
    const def = REAL_DEFS.heat_beam;
    const defs = { heat_beam: def };
    const state = createSimState(1);
    const tank = makeEnemy(state, 360, 1000);
    addWeapon(state, 'heat_beam');

    updateWeapons(state, 16, defs);
    expect(tank.hp).toBeCloseTo(1e6 - 9, 6);
    expect(state.weaponStates.heat_beam.cooldownMs).toBe(184); // -16 + 200
  });

  it('长跑节奏：总伤为「跳伤整数倍」且在上界内；无过热打扰（过热槽已删除）', () => {
    const def = REAL_DEFS.heat_beam;
    const defs = { heat_beam: def };
    const state = createSimState(1);
    const tank = makeEnemy(state, 360, 1000);
    addWeapon(state, 'heat_beam');

    updateWeapons(state, 16, defs);
    for (let f = 0; f < 300; f++) {
      // 300×16 = 4800ms
      updateWeapons(state, 16, defs);
      state.timeMs += 16;
      updateEffects(state, 16);
    }
    const dealt = 1e6 - tank.hp;
    expect(dealt).toBeGreaterThan(0);
    expect(dealt % 9).toBe(0); // 无加载牌：每跳恰 9 点
    expect(dealt).toBeLessThanOrEqual(9 * 26); // 4800ms / 200ms = 24 跳 + 首帧 1 跳的放宽上界
    expect(hasEffect(state.weaponStates.heat_beam, 'overheat')).toBe(false); // 过热槽整套删除
  });
});

describe('可复现（行为零随机：不读 rng，任意种子同结果）', () => {
  /** 固定场景：加载+第二闪光+灼痕连打 6 跳 + DoT 推进的全量结果快照。 */
  function scenario(seed: number): {
    aHp: number;
    bHp: number;
    effects: Array<Record<string, unknown>>;
    counters: HeatBeamCounters;
    nextId: number;
    projectiles: number;
  } {
    const state = createSimState(seed);
    const a = makeEnemy(state, 360, 1000); // 主束目标
    const b = makeEnemy(state, 360, 900); // 次级束目标
    for (let i = 0; i < 6; i++) {
      fireOnce(state, ['load_up', 'second_flash', 'scorch']);
      state.timeMs += 200;
      updateEffects(state, 200);
    }
    return {
      aHp: a.hp,
      bHp: b.hp,
      effects: a.effects.map((x) => ({ kind: x.kind, stacks: x.stacks, data: { ...x.data } })),
      counters: countersOf(state)!,
      nextId: state.nextId,
      projectiles: state.projectiles.length,
    };
  }

  it('同种子两次全流程一致；异种子也一致（确定性映射，全程不消耗 rng）', () => {
    expect(scenario(42)).toEqual(scenario(42));
    expect(scenario(42)).toEqual(scenario(7));
  });
});
