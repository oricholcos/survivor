// src/core/behaviors/dragonBreath.test.ts —— 龙息锥行为契约（T5.3a 牌池制更新）：
// 锥形范围判定（朝正上、半角 coneAngleDeg/2、射程 coneRange：正上近/远、恰在射程上、
// 恰在半角内、偏角过大、超射程、角色侧后方、与角色重合、死者跳过）、
// 持续伤害 tick（多次 fire 多次扣血 + updateWeapons 的 intervalMs 节奏 + 无敌人不开火冷却归 0）、
// 基础灼烧（burn 逐实例覆盖每跳 1 + 真实 DoT 跳）、粘油（slow 挂槽 speedMultiplier 0.5）、
// 爆燃（预挂 burn 受伤 ×2 / 未燃烧 ×1 / 与 corrode 受伤乘区叠乘）、
// 酸池（每 10 个 fire tick 在锥形中点落 corrode 区域：参数随表、zone tick 受伤 + 腐蚀叠层、
// 到期消失、计数只在真实开火时累计）、推退（沿背向角色单位向量位移 pushForce）、
// VFX meta 约定、数值全部来自 weapons/dragon_breath.json 真实表（alt def 驱动同一行为；
// 等级语义改为牌组：粘油/爆燃/酸池/推退为专属牌，锥角/射程成长走范围强化牌）、
// 解释器集成（长跑伤害恒等式 + 酸池按节奏落区）、同种子可复现（零随机）。
import { describe, expect, it } from 'vitest';
import { loadEffectDefs } from '../../data/effects';
import { loadWeaponDefs } from '../../data/weapons';
import {
  applyEffect,
  damageTakenFactor,
  hasEffect,
  speedMultiplier,
  updateEffects,
} from '../effects';
import { listZones, updateZones } from '../zones';
import { SpatialHash } from '../spatialHash';
import { createSimState } from '../simState';
import type { Enemy, SimState } from '../types';
import { addWeapon, getWeaponStats, updateWeapons } from '../weapons';
import type { WeaponDef, WeaponStats } from '../weapons';
import { behavior } from './behavior_dragonBreath';
import type { DragonBreathVfx } from './behavior_dragonBreath';
import './index'; // 副作用：自动发现注册
import { getBehavior } from './registry';

// 副作用：把 effects.json 真实效果表注册进 core/effects（burn/slow/corrode/knockback 依赖）。
loadEffectDefs();

/** 角色缺省位（createSimState：宽 720 高 1280 的底边中央）。 */
const CX = 360;
const CY = 1220;

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

/**
 * 以真实数据表 dragon_breath.json 的指定牌组 stats 直调 fire 一次。
 * T5.3a：等级→牌组——cards 数组即该武器已吃的牌（重复项 = 可重复牌多张）。
 */
function fireOnce(state: SimState, cards: string[] = []): WeaponStats {
  const def = loadWeaponDefs().dragon_breath;
  if (!state.weaponStates.dragon_breath) {
    state.weaponStates.dragon_breath = { level: 0, cooldownMs: 0, cards: {} };
  }
  const ws = state.weaponStates.dragon_breath;
  ws.cards = {};
  for (const cardId of cards) {
    ws.cards[cardId] = (ws.cards[cardId] ?? 0) + 1;
  }
  ws.level = cards.length;
  const stats = getWeaponStats(def, state, 'dragon_breath');
  behavior.fire(state, 'dragon_breath', stats);
  return stats;
}

/** 从角色出发、与正上（-y）轴夹角 angleDeg、距离 d 的点（与行为锥形判定同构的几何构造）。 */
function conePoint(angleDeg: number, d: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: CX + d * Math.sin(rad), y: CY - d * Math.cos(rad) };
}

/** 读某武器的 VFX meta 条目。 */
function vfxOf(state: SimState, weaponId = 'dragon_breath'): DragonBreathVfx | undefined {
  return state.meta[`dragon_breath_vfx:${weaponId}`] as DragonBreathVfx | undefined;
}

/** 读某武器的酸池计数器（懒初始化前视为 0）。 */
function acidTicksOf(state: SimState, weaponId = 'dragon_breath'): number {
  const slot = state.meta[`dragon_breath_acid:${weaponId}`] as { ticks?: number } | undefined;
  return slot && typeof slot.ticks === 'number' ? slot.ticks : 0;
}

function makeGrid(): SpatialHash<Enemy> {
  return new SpatialHash<Enemy>(64);
}

/** 模拟真实管线里 updateEnemies 的网格重建：存活敌人全部插入（敌人静止，灌一次即可）。 */
function fillGrid(state: SimState, grid: SpatialHash<Enemy>): void {
  grid.clear();
  for (let i = 0; i < state.enemies.length; i++) {
    const e = state.enemies[i];
    if (!e.dead) {
      grid.insert(e, e.x, e.y, e.radius);
    }
  }
}

describe('锥形范围判定（无牌：半角 25°、射程 230，按敌人圆心）', () => {
  it('正上近/远两个敌人各掉 stats.damage 2；无弹丸产生', () => {
    const state = createSimState(1);
    const near = makeEnemy(state, 360, 1100); // 距 120，轴向
    const far = makeEnemy(state, 360, 1020); // 距 200，轴向
    const stats = fireOnce(state);

    expect(stats.damage).toBe(2); // base 表值
    expect(near.hp).toBeCloseTo(98, 6);
    expect(far.hp).toBeCloseTo(98, 6);
    expect(state.projectiles).toHaveLength(0); // 无弹丸：纯锥形即时判定
  });

  it('恰在射程边界（距 230 = coneRange）命中；超射程（240）不命中', () => {
    const state = createSimState(1);
    const edge = makeEnemy(state, 360, 990); // 1220-990 = 230：恰在射程上（含等号）
    const beyond = makeEnemy(state, 360, 980); // 距 240
    fireOnce(state);
    expect(edge.hp).toBeCloseTo(98, 6);
    expect(beyond.hp).toBe(100);
  });

  it('半角内（24°）命中；偏角过大（26°、水平 90°）不命中', () => {
    const state = createSimState(1);
    const in24 = makeEnemy(state, conePoint(24, 100).x, conePoint(24, 100).y); // 24° < 25°
    const out26 = makeEnemy(state, conePoint(26, 100).x, conePoint(26, 100).y); // 26° > 25°
    const horizontal = makeEnemy(state, 500, 1220); // 距 140 < 230，但 -dy/d = 0
    fireOnce(state);
    expect(in24.hp).toBeCloseTo(98, 6);
    expect(out26.hp).toBe(100);
    expect(horizontal.hp).toBe(100);
  });

  it('角色侧后方不命中（-dy/d ≤ 0 被不等式自然拒绝）；锥内有主目标证明开火已发生', () => {
    const state = createSimState(1);
    const main = makeEnemy(state, 360, 1100); // 轴向：主目标
    const below = makeEnemy(state, 360, 1400); // 正下方（+y）
    const behindLeft = makeEnemy(state, 200, 1300); // 左后下
    fireOnce(state);
    expect(main.hp).toBeCloseTo(98, 6);
    expect(below.hp).toBe(100);
    expect(behindLeft.hp).toBe(100);
  });

  it('锥角随范围强化牌（50° → 60°）：27° 偏角无牌不中、1 张范围牌后中（伤害不变）', () => {
    const base = createSimState(1);
    makeEnemy(base, 360, 1100); // 主目标：证明开火已发生
    const p1 = makeEnemy(base, conePoint(27, 150).x, conePoint(27, 150).y); // 27° > 25°
    fireOnce(base);
    expect(p1.hp).toBe(100);

    const widened = createSimState(1);
    makeEnemy(widened, 360, 1100);
    const p2 = makeEnemy(widened, conePoint(27, 150).x, conePoint(27, 150).y); // 27° < 30°
    const stats = fireOnce(widened, ['range_up']);
    expect(stats.coneAngleDeg).toBeCloseTo(60, 9); // 50 × 1.2
    expect(stats.damage).toBe(2); // 范围牌不动伤害
    expect(p2.hp).toBeCloseTo(98, 6);
  });

  it('射程随范围强化牌（230 → 276）：距 250 的敌人无牌不中、1 张范围牌后中', () => {
    const base = createSimState(1);
    makeEnemy(base, 360, 1150);
    const p1 = makeEnemy(base, 360, 970); // 距 250
    fireOnce(base);
    expect(p1.hp).toBe(100);

    const extended = createSimState(1);
    makeEnemy(extended, 360, 1150);
    const p2 = makeEnemy(extended, 360, 970); // 距 250 ≤ 276
    const stats = fireOnce(extended, ['range_up']);
    expect(stats.coneRange).toBeCloseTo(276, 9); // 230 × 1.2
    expect(p2.hp).toBeCloseTo(98, 6);
  });

  it('与角色重合的敌人不判定（无方向）；死者跳过；仅重合敌人 = 锥内无目标不开火', () => {
    const solo = createSimState(1);
    const merged = makeEnemy(solo, 360, 1220); // 与角色重合
    fireOnce(solo);
    expect(merged.hp).toBe(100);
    expect(vfxOf(solo)).toBeUndefined(); // 锥内无有效目标：不开火

    const state = createSimState(1);
    const dead = makeEnemy(state, 360, 1100, 5);
    dead.dead = true;
    const live = makeEnemy(state, 360, 1050);
    fireOnce(state);
    expect(dead.hp).toBe(5); // 死者不结算
    expect(live.hp).toBeCloseTo(98, 6);
  });
});

describe('持续伤害 tick 与开火节奏', () => {
  it('多次 fire 多次扣血：两次 fire 共扣 2×stats.damage', () => {
    const state = createSimState(1);
    const tank = makeEnemy(state, 360, 1100, 1e6);
    fireOnce(state);
    fireOnce(state);
    expect(tank.hp).toBeCloseTo(1e6 - 4, 6);
  });

  it('intervalMs 节奏经 updateWeapons 驱动：到点才开火（base 间隔 150）', () => {
    const defs = { dragon_breath: loadWeaponDefs().dragon_breath };
    const state = createSimState(1);
    addWeapon(state, 'dragon_breath');
    const tank = makeEnemy(state, 360, 1100, 1e6);

    updateWeapons(state, 16, defs); // 冷却 0-16 → fire #1 → += 150
    expect(tank.hp).toBeCloseTo(1e6 - 2, 6);
    expect(state.weaponStates.dragon_breath.cooldownMs).toBe(134);

    updateWeapons(state, 118, defs); // 134-118 = 16 > 0：不开火
    expect(tank.hp).toBeCloseTo(1e6 - 2, 6);

    updateWeapons(state, 16, defs); // 16-16 = 0 → fire #2 → 150
    expect(tank.hp).toBeCloseTo(1e6 - 4, 6);
    expect(state.weaponStates.dragon_breath.cooldownMs).toBe(150);
  });

  it('无敌人不开火：冷却归 0（重试标记）、无 VFX、无酸池计数；解释器随后推进一个 interval', () => {
    const defs = { dragon_breath: loadWeaponDefs().dragon_breath };
    const state = createSimState(1);
    addWeapon(state, 'dragon_breath');
    state.weaponStates.dragon_breath.cooldownMs = 77;

    fireOnce(state);
    expect(state.weaponStates.dragon_breath.cooldownMs).toBe(0);
    expect(vfxOf(state)).toBeUndefined();
    expect(acidTicksOf(state)).toBe(0);

    updateWeapons(state, 16, defs);
    expect(state.weaponStates.dragon_breath.cooldownMs).toBe(150); // 0 → fire 归 0 → += 150
  });

  it('敌人存在但全在锥外：同样不开火（冷却归 0、不写 VFX、不掉血）', () => {
    const state = createSimState(1);
    addWeapon(state, 'dragon_breath');
    state.weaponStates.dragon_breath.cooldownMs = 77;
    const below = makeEnemy(state, 360, 1400);

    fireOnce(state);
    expect(below.hp).toBe(100);
    expect(state.weaponStates.dragon_breath.cooldownMs).toBe(0);
    expect(vfxOf(state)).toBeUndefined();
  });
});

describe('基础灼烧（龙息本体语义，逐实例覆盖每跳 1）', () => {
  it('锥内敌人挂 burn：data.damagePerTick = 1（覆盖效果表默认 3）、真实 DoT 逐跳掉血', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1100, 1e6);
    fireOnce(state);

    expect(e.hp).toBeCloseTo(1e6 - 2, 6); // 直击 base damage 2
    expect(e.effects).toHaveLength(1);
    const burn = e.effects[0];
    expect(burn.kind).toBe('burn');
    expect(burn.stacks).toBe(1);
    expect(burn.data.damagePerTick).toBe(1); // 逐实例覆盖（效果表默认 3）
    expect(burn.untilMs).toBe(state.timeMs + 3000); // 效果表 durationMs

    state.timeMs += 500; // burn tickMs
    updateEffects(state, 500);
    expect(e.hp).toBeCloseTo(1e6 - 2 - 1, 6); // 每跳 1 而非 3
  });

  it('每 tick 重复施加 refresh=reset：单实例不叠层、数值保持覆盖值 1', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1100, 1e6);
    fireOnce(state);
    fireOnce(state);
    fireOnce(state);
    expect(e.effects).toHaveLength(1);
    expect(e.effects[0].kind).toBe('burn');
    expect(e.effects[0].stacks).toBe(1);
    expect(e.effects[0].data.damagePerTick).toBe(1);
  });

  it('被直击致死的敌人不挂灼烧（尸体无意义）', () => {
    const state = createSimState(1);
    const frail = makeEnemy(state, 360, 1100, 2); // hp 恰等于一 tick 伤害
    fireOnce(state);
    expect(frail.dead).toBe(true);
    expect(frail.effects).toHaveLength(0);
  });
});

describe('粘油（sticky_oil 专属牌）', () => {
  it('粘油牌命中挂 slow：speedMultiplier 0.5（<1）；slow 与 burn 双槽共存', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1100, 1e6);
    const stats = fireOnce(state, ['sticky_oil']);

    expect(stats.stickyOil).toBe(1);
    expect(e.effects.map((x) => x.kind)).toEqual(['slow', 'burn']);
    expect(speedMultiplier(e)).toBeCloseTo(0.5, 12); // 效果表 speedFactor
  });

  it('无粘油牌：不挂 slow（仅灼烧）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1100, 1e6);
    fireOnce(state);
    expect(hasEffect(e, 'slow')).toBe(false);
    expect(speedMultiplier(e)).toBe(1);
    expect(e.effects.map((x) => x.kind)).toEqual(['burn']);
  });

  it('slow 到期恢复（updateEffects 清理）：burn 不受影响继续留存', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1100, 1e6);
    fireOnce(state, ['sticky_oil']);

    state.timeMs += 2000; // slow durationMs
    updateEffects(state, 2000);
    expect(hasEffect(e, 'slow')).toBe(false);
    expect(speedMultiplier(e)).toBe(1);
    expect(hasEffect(e, 'burn')).toBe(true); // burn 3000ms 仍在期
  });
});

describe('爆燃（blast_ignite 专属牌）', () => {
  it('预挂 burn 的敌人受伤 ×2（先乘后结算），未燃烧的 ×1', () => {
    const burning = createSimState(1);
    const eb = makeEnemy(burning, 360, 1100, 1e6);
    applyEffect(burning, eb, 'burn'); // 预挂燃烧
    fireOnce(burning, ['blast_ignite']);
    expect(eb.hp).toBeCloseTo(1e6 - 4, 6); // base damage 2 × 2

    const fresh = createSimState(1);
    const ef = makeEnemy(fresh, 360, 1100, 1e6);
    fireOnce(fresh, ['blast_ignite']);
    expect(ef.hp).toBeCloseTo(1e6 - 2, 6); // 未燃烧 ×1
  });

  it('无爆燃牌：燃烧敌人仍 ×1（开关随牌生效）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1100, 1e6);
    applyEffect(state, e, 'burn');
    fireOnce(state, ['sticky_oil']); // 用粘油牌隔离爆燃开关
    expect(e.hp).toBeCloseTo(1e6 - 2, 6); // 不翻倍
  });

  it('爆燃与 corrode 受伤乘区叠乘：2 × 2 × 1.15 = 4.6', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1100, 1e6);
    applyEffect(state, e, 'burn');
    applyEffect(state, e, 'corrode');
    expect(damageTakenFactor(e)).toBeCloseTo(1.15, 12);
    fireOnce(state, ['blast_ignite']);
    expect(e.hp).toBeCloseTo(1e6 - 4 * 1.15, 6);
  });
});

describe('酸池（acid_pool 专属牌）', () => {
  it('每 10 个 fire tick 在锥形中点落区：参数随表（radius=230×0.35=80.5 等）且计数归 0', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1100, 1e6); // 锥内常驻目标：维持每 tick 真实开火
    const stats = fireOnce(state, ['acid_pool']); // fire #1
    expect(stats.acidPool).toBe(1);
    expect(stats.coneRange).toBe(230); // 无范围牌：锥距保持 base

    for (let i = 0; i < 8; i++) {
      fireOnce(state, ['acid_pool']); // #2-#9：累计 9 tick
    }
    expect(listZones(state)).toEqual([]); // 9 tick：未达 10 不落区
    expect(acidTicksOf(state)).toBe(9);

    fireOnce(state, ['acid_pool']); // 第 10 tick：落区
    const zones = listZones(state);
    expect(zones).toHaveLength(1);
    expect(zones[0]).toMatchObject({
      x: 360,
      y: 1220 - 230 / 2, // 锥形中点（轴向半程）
      radius: 230 * 0.35, // 80.5
      durationMs: 2500,
      tickMs: 500,
      damagePerTick: 2,
      effectKind: 'corrode',
    });
    expect(acidTicksOf(state)).toBe(0); // 落区后计数归 0

    for (let i = 0; i < 9; i++) {
      fireOnce(state, ['acid_pool']);
    }
    expect(listZones(state)).toHaveLength(1); // 计数重新累计中：无新区
    fireOnce(state, ['acid_pool']);
    expect(listZones(state)).toHaveLength(2); // 再满 10 tick：第 2 片酸池
  });

  it('zone 持续期间敌人受伤 + 挂 corrode（受伤乘区 >1）；腐蚀又放大本武器直击', () => {
    const state = createSimState(1);
    const grid = makeGrid();
    const tank = makeEnemy(state, 360, 1100, 1e6); // 距酸池圆心 (360,1085) 15：在区域内
    for (let i = 0; i < 10; i++) {
      fireOnce(state, ['acid_pool', 'blast_ignite']); // 直击 2 + 爆燃：首击未燃烧 ×1=2，此后 ×2=4
    }
    expect(tank.hp).toBeCloseTo(1e6 - (2 + 9 * 4), 6);

    fillGrid(state, grid);
    updateZones(state, 500, grid); // zone 第 1 跳
    expect(tank.hp).toBeCloseTo(1e6 - (2 + 9 * 4) - 2, 6); // damagePerTick 2（附着在结算后）
    expect(hasEffect(tank, 'corrode')).toBe(true);
    expect(damageTakenFactor(tank)).toBeCloseTo(1.15, 12);

    updateZones(state, 500, grid); // 第 2 跳：corrode 1 层 ×1.15；跳后叠到 2 层
    expect(tank.hp).toBeCloseTo(1e6 - (2 + 9 * 4) - 2 - 2 * 1.15, 6);
    expect(damageTakenFactor(tank)).toBeCloseTo(1.3225, 12);

    fireOnce(state, ['acid_pool', 'blast_ignite']); // 直击：爆燃 ×2 × corrode 2 层 → 4 × 1.3225
    expect(tank.hp).toBeCloseTo(1e6 - (2 + 9 * 4) - 2 - 2 * 1.15 - 4 * 1.3225, 6);
  });

  it('zone 到期消失：2500ms 恰结算 5 跳后移除，此后不再受伤', () => {
    const state = createSimState(1);
    const grid = makeGrid();
    const tank = makeEnemy(state, 360, 1100, 1e6);
    for (let i = 0; i < 10; i++) {
      fireOnce(state, ['acid_pool']);
    }
    fillGrid(state, grid);

    // 5 跳（500..2500）：corrode 逐跳叠层（上限 2）→ 2 + 2×1.15 + 3×(2×1.3225)
    for (let i = 0; i < 5; i++) {
      updateZones(state, 500, grid);
    }
    const zoneTotal = 2 + 2 * 1.15 + 3 * (2 * 1.3225);
    expect(tank.hp).toBeCloseTo(1e6 - 20 - zoneTotal, 6);
    expect(listZones(state)).toEqual([]); // elapsed 2500 ≥ durationMs：移除

    const frozen = tank.hp;
    updateZones(state, 500, grid);
    expect(tank.hp).toBe(frozen); // 已移除：不再结算
  });

  it('计数只在真实开火时累计：锥内无敌人不计数（不开火不落区）', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1400); // 锥外
    for (let i = 0; i < 15; i++) {
      fireOnce(state, ['acid_pool']);
    }
    expect(listZones(state)).toEqual([]);
    expect(acidTicksOf(state)).toBe(0);
  });
});

describe('推退（push_back 专属牌）', () => {
  it('正上敌人沿背向角色方向（-y）位移 pushForce 25，且直击照常结算', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1000, 1e6); // 距 220
    const stats = fireOnce(state, ['push_back']);

    expect(stats.pushBack).toBe(1);
    expect(stats.pushForce).toBe(25); // pushForce 在 base（表值）
    expect(e.hp).toBeCloseTo(1e6 - 2, 6); // base damage 2
    expect(e.x).toBe(360);
    expect(e.y).toBeCloseTo(975, 9); // 1000 - 25
  });

  it('斜向敌人沿径向单位向量推（归一化方向 × force）', () => {
    const state = createSimState(1);
    const p = conePoint(20, 100);
    const e = makeEnemy(state, p.x, p.y, 1e6);
    fireOnce(state, ['push_back']);
    const rad = (20 * Math.PI) / 180;
    expect(e.x).toBeCloseTo(p.x + 25 * Math.sin(rad), 9);
    expect(e.y).toBeCloseTo(p.y - 25 * Math.cos(rad), 9);
  });

  it('无推退牌：位置不动（开关随牌生效）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1000, 1e6);
    fireOnce(state, ['acid_pool']);
    expect(e.x).toBe(360);
    expect(e.y).toBe(1000);
  });

  it('推退后不残留 knockback 效果实例（durationMs 0 即时结算）；粘油+推退双开共存', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1000, 1e6);
    fireOnce(state, ['sticky_oil', 'push_back']);
    expect(hasEffect(e, 'knockback')).toBe(false);
    expect(e.effects.map((x) => x.kind)).toEqual(['slow', 'burn']); // stickyOil + 灼烧
  });
});

describe('VFX meta 约定（M4 视图消费）', () => {
  it('fire 写 meta[dragon_breath_vfx:id] = {untilMs: timeMs+80, coneRange, coneAngleDeg}', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1100);
    fireOnce(state);
    expect(vfxOf(state)).toEqual({ untilMs: 80, coneRange: 230, coneAngleDeg: 50 });

    const widened = createSimState(1);
    makeEnemy(widened, 360, 1100);
    fireOnce(widened, ['range_up', 'range_up']);
    expect(vfxOf(widened)).toEqual({ untilMs: 80, coneRange: 230 * 1.44, coneAngleDeg: 50 * 1.44 });
  });

  it('重复 fire 覆盖同一条目（单键、untilMs 随当前时刻刷新）；无敌人不写', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1100, 1e6);
    fireOnce(state);
    state.timeMs = 1000;
    fireOnce(state);
    const vfx = vfxOf(state);
    expect(vfx?.untilMs).toBe(1080); // 1000 + 80
    expect(Object.keys(state.meta).filter((k) => k.indexOf('dragon_breath_vfx:') === 0)).toHaveLength(1);

    const empty = createSimState(1);
    fireOnce(empty);
    expect(vfxOf(empty)).toBeUndefined();
  });
});

describe('数值全部来自 weapons/dragon_breath.json（真实表驱动，T5.3a 牌池制）', () => {
  const def = loadWeaponDefs().dragon_breath;

  it('表身份：id/name/behavior/maxLevel=10，behavior 已自动发现注册', () => {
    expect(def.id).toBe('dragon_breath');
    expect(def.name).toBe('龙息锥');
    expect(def.behavior).toBe('dragon_breath');
    expect(def.maxLevel).toBe(10);
    expect(getBehavior('dragon_breath')).toBe(behavior); // import.meta.glob 自动注册
  });

  it('牌目录：专属牌在前（sticky_oil/blast_ignite/acid_pool/push_back，全部 once），通用牌合并追加', () => {
    expect(def.cards.slice(0, 4).map((c) => c.id)).toEqual(['sticky_oil', 'blast_ignite', 'acid_pool', 'push_back']);
    for (const c of def.cards.slice(0, 4)) {
      expect(c.once).toBe(true);
    }
    const ids = def.cards.map((c) => c.id);
    // 龙息锥通用牌：伤害/攻速 + 范围强化（rangeKeys=锥角+射程）+ dot频率（龙息天然无前置）。
    for (const genericId of ['dmg_up', 'spd_up', 'range_up', 'dot_freq']) {
      expect(ids).toContain(genericId);
    }
    expect(ids).not.toContain('multi_shot'); // 射线/锥形武器不吃弹道牌
    const dot = def.cards.find((c) => c.id === 'dot_freq')!;
    expect(dot.requiresCard).toBeNull(); // 龙息天然可用
    expect(def.rangeKeys).toEqual(['coneRange', 'coneAngleDeg']);
  });

  it('base 数值随表；专属牌开关经 stats 注入（改 json 即变）', () => {
    expect(def.base).toMatchObject({
      damage: 2, intervalMs: 150, projectileSpeed: 0, pierce: 0, ttlMs: 0,
      coneRange: 230, coneAngleDeg: 50,
      acidPoolEveryTicks: 10, acidPoolRadiusFactor: 0.35,
      acidPoolDurationMs: 2500, acidPoolTickMs: 500, acidPoolDamage: 2,
    });

    const state = createSimState(1);
    makeEnemy(state, 360, 1100, 1e6);
    const all = fireOnce(state, ['sticky_oil', 'blast_ignite', 'acid_pool', 'push_back']);
    expect(all.stickyOil).toBe(1);
    expect(all.blastIgnite).toBe(1);
    expect(all.acidPool).toBe(1);
    expect(all.pushBack).toBe(1);
    expect(all.coneRange).toBe(230); // 范围强化未拿：几何参数保持 base
  });

  it('alt def（不同数值）驱动同一行为：锥角/射程/推力/酸池参数全部随表', () => {
    const altDef: WeaponDef = {
      id: 'alt_dragon',
      name: '替换龙息',
      behavior: 'dragon_breath',
      maxLevel: 10,
      base: {
        damage: 4, intervalMs: 100, projectileSpeed: 0, pierce: 0, ttlMs: 0,
        coneRange: 150, coneAngleDeg: 90, pushBack: 1, pushForce: 40,
        acidPool: 1, acidPoolEveryTicks: 2, acidPoolRadiusFactor: 0.5,
        acidPoolDurationMs: 1000, acidPoolTickMs: 250, acidPoolDamage: 3,
      },
      rangeKeys: [],
      cards: [],
    };
    const state = createSimState(1);
    state.weaponStates.alt_dragon = { level: 0, cooldownMs: 0, cards: {} };
    const altStats = getWeaponStats(altDef, state, 'alt_dragon');

    const hit = makeEnemy(state, conePoint(40, 100).x, conePoint(40, 100).y, 1e6); // 40° < 45°
    const wide = makeEnemy(state, conePoint(50, 100).x, conePoint(50, 100).y, 1e6); // 50° > 45°
    const far = makeEnemy(state, 360, 1060, 1e6); // 距 160 > 150

    behavior.fire(state, 'alt_dragon', altStats); // 第 1 tick：命中 + 推退 40
    expect(hit.hp).toBeCloseTo(1e6 - 4, 6);
    expect(wide.hp).toBe(1e6);
    expect(far.hp).toBe(1e6);
    const rad = (40 * Math.PI) / 180;
    expect(hit.x).toBeCloseTo(conePoint(40, 100).x + 40 * Math.sin(rad), 9);
    expect(hit.y).toBeCloseTo(conePoint(40, 100).y - 40 * Math.cos(rad), 9);

    behavior.fire(state, 'alt_dragon', altStats); // 第 2 tick：达 everyTicks=2 → 落区
    expect(hit.hp).toBeCloseTo(1e6 - 8, 6);
    const zones = listZones(state);
    expect(zones).toHaveLength(1);
    expect(zones[0]).toMatchObject({
      x: 360,
      y: 1220 - 150 / 2,
      radius: 150 * 0.5, // 75
      durationMs: 1000,
      tickMs: 250,
      damagePerTick: 3,
      effectKind: 'corrode',
    });
    expect(acidTicksOf(state, 'alt_dragon')).toBe(0); // 计数按 weaponId 分键并归 0
  });
});

describe('解释器集成（updateWeapons 节奏 + 酸池长跑）', () => {
  it('长跑：伤害恒等式（首击 ×1 此后爆燃 ×2）+ 酸池恰按每 10 tick 落区', () => {
    const def = loadWeaponDefs().dragon_breath;
    const defs = { dragon_breath: def };
    const state = createSimState(1);
    addWeapon(state, 'dragon_breath');
    state.weaponStates.dragon_breath.cards.blast_ignite = 1; // 爆燃 + 酸池、无推退（牌池制）
    state.weaponStates.dragon_breath.cards.acid_pool = 1;
    state.weaponStates.dragon_breath.level = 2;
    const tank = makeEnemy(state, 360, 1100, 1e6); // 静止轴向（无推退）

    for (let i = 0; i < 200; i++) {
      updateWeapons(state, 16, defs); // 200×16 = 3200ms
    }

    // fire 数 = 酸池已落区数 × 10 + 当前计数（计数只在真实开火时 +1）
    const zones = listZones(state).length; // 未调 updateZones：区域只增不减
    const fires = zones * 10 + acidTicksOf(state);
    expect(fires).toBeGreaterThanOrEqual(20);
    expect(fires).toBeLessThanOrEqual(24); // 3200/150 ≈ 21.3 + 首帧
    expect(zones).toBe(Math.floor(fires / 10));
    // 伤害恒等式：第 1 次直击 2（无灼烧 ×1），此后每 tick 爆燃 ×2 = 4（无 DoT：未调 updateEffects）
    expect(1e6 - tank.hp).toBe(2 + 4 * (fires - 1));
    expect(state.projectiles).toHaveLength(0);
  });
});

describe('可复现（行为零随机：不读 rng，任意种子同结果）', () => {
  /** 固定场景：粘油+爆燃+酸池全开 12 tick 开火 + 4 tick 停火推进的全量结果快照。 */
  function scenario(seed: number): Record<string, unknown> {
    const state = createSimState(seed);
    addWeapon(state, 'dragon_breath');
    const grid = makeGrid();
    const a = makeEnemy(state, 360, 1100, 1e6); // 轴向主目标
    const bp = conePoint(20, 100);
    const b = makeEnemy(state, bp.x, bp.y, 1e6); // 20° 偏角
    applyEffect(state, b, 'burn'); // 预挂燃烧：爆燃 ×2 路径

    for (let i = 0; i < 12; i++) {
      fireOnce(state, ['sticky_oil', 'blast_ignite', 'acid_pool']);
      state.timeMs += 150;
      updateEffects(state, 150);
      fillGrid(state, grid);
      updateZones(state, 150, grid);
    }
    for (let i = 0; i < 4; i++) {
      // 停火 idle：灼烧 DoT 与酸池 tick 继续推进
      state.timeMs += 150;
      updateEffects(state, 150);
      fillGrid(state, grid);
      updateZones(state, 150, grid);
    }

    const snapEffects = (e: Enemy) =>
      e.effects.map((x) => ({ kind: x.kind, stacks: x.stacks, data: { ...x.data } }));
    return {
      aHp: a.hp,
      bHp: b.hp,
      aX: a.x,
      aY: a.y,
      bX: b.x,
      bY: b.y,
      aEffects: snapEffects(a),
      bEffects: snapEffects(b),
      aSpeed: speedMultiplier(a),
      bSpeed: speedMultiplier(b),
      aFactor: damageTakenFactor(a),
      bFactor: damageTakenFactor(b),
      zones: JSON.stringify(listZones(state)),
      vfxUntilMs: vfxOf(state)?.untilMs,
      acidTicks: acidTicksOf(state),
      nextId: state.nextId,
      projectiles: state.projectiles.length,
    };
  }

  it('同种子两次全流程一致；异种子也一致（确定性映射，全程不消耗 rng）', () => {
    expect(scenario(42)).toEqual(scenario(42));
    expect(scenario(7)).toEqual(scenario(42));
  });
});

// —— T5.3b dot 频率接线（dot_freq 牌：本体灼烧 + 酸池 tick 间隔 ÷1.3^张数） ——

describe('dot 频率（dot_freq 牌：龙息无前置——本体即附着灼烧）', () => {
  it('1 张 dot 频率：本体灼烧 tickMs = 500/1.3（damagePerTick 1 保持），首跳在 384.6ms', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1100, 1e6); // 锥内正上
    fireOnce(state, ['dot_freq']);
    expect(e.hp).toBeCloseTo(1e6 - 2, 6); // 直击
    expect(e.effects[0].kind).toBe('burn');
    expect(e.effects[0].data.damagePerTick).toBe(1); // 龙息小值覆盖保持
    expect(e.effects[0].data.tickMs).toBeCloseTo(500 / 1.3, 9); // dot 频率覆盖

    // 首跳时序：384.6ms 已跳（-1），300ms 未跳
    const mid = createSimState(1);
    const em = makeEnemy(mid, 360, 1100, 1e6);
    fireOnce(mid, ['dot_freq']);
    mid.timeMs += 300;
    updateEffects(mid, 300);
    expect(em.hp).toBeCloseTo(1e6 - 2, 6); // 未到 384.6：无 DoT 跳
    mid.timeMs += 84.7;
    updateEffects(mid, 84.7);
    expect(em.hp).toBeCloseTo(1e6 - 2 - 1, 6); // 384.7 ≥ 384.6：首跳
  });

  it('无 dot 频率牌：灼烧实例不写 tickMs 键（保持效果表节奏）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1100, 1e6);
    fireOnce(state);
    expect('tickMs' in e.effects[0].data).toBe(false);
    expect(e.effects[0].data.damagePerTick).toBe(1);
  });

  it('酸池 + dot 频率：zone tickMs = 500/1.3（spawnZone 逐实例参数直除）', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 1100, 1e6);
    fireOnce(state, ['acid_pool', 'dot_freq']); // #1
    for (let i = 0; i < 9; i++) {
      fireOnce(state, ['acid_pool', 'dot_freq']); // #2-#10：落区
    }
    const zones = listZones(state);
    expect(zones).toHaveLength(1);
    expect(zones[0].tickMs).toBeCloseTo(500 / 1.3, 9); // 酸池节奏随 dot 频率
    expect(zones[0].damagePerTick).toBe(2); // 表值保持
  });
});
