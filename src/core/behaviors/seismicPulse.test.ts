// src/core/behaviors/seismicPulse.test.ts —— 震波壁垒行进波契约（F3）：
// 数据表身份（新键 waveDistance 220（G4 增强，原 160）/ bandDepth 语义改波前厚度 40 / rangeKeys=["waveDistance"]）、
// 波前推进几何（t=0 出生走廊、t=400ms 恰达 wallLineY − waveDistance、扫掠时长恒 400ms 不随
// 距离变、走廊结算零漏判）、波前经过才结算（未到不受伤）、每敌每 sweep 恰一次（击退向上
// 重入不重复）、波前厚度边界（恰在边界算在内、最大可达 = 行进距离 + 厚度）、范围强化 ×1.2
// 作用于 waveDistance、地裂 +20/层作用于厚度且不影响行进距离、无可达目标不开火冷却归 0
// （可达但波前未到算可达）、结算次序（伤害 → 幸存者击退 → 幸存者眩晕、致死不附着、maxHp
// 抗性分级、Boss 眩晕减半）、震荡加深覆盖（data.durationMs 逐实例覆盖 + Boss 减半作用于
// 覆盖后时长）、过载共振 ×2（结算时判定 = 波前经过该敌人的那一刻）、城垣共鸣（整次 sweep
// 累计命中数含被击杀者、sweep 结束时结算、clamp）、余震（fire 起算 400ms / 30%×层数 / 无 CC /
// 行进带快照重扫）、sweep 重叠防御（单键覆盖写、hitIds 按 sweep 重建）、over 停摆、同种子
// 可复现、VFX/sweep 共享单键（视图字段 + 留存窗清理）、数值全部来自 weapons/seismic_wall.json
// 真实表、解释器集成与自动注册。
import { describe, expect, it } from 'vitest';
import { loadEffectDefs } from '../../data/effects';
import { loadWeaponDefs } from '../../data/weapons';
import { applyEffect, hasEffect, isStunned } from '../effects';
import { createSimState } from '../simState';
import type { Enemy, SimState } from '../types';
import { addWeapon, getWeaponStats, updateWeapons } from '../weapons';
import type { WeaponStats } from '../weapons';
import {
  behavior,
  AFTERSHOCK_QUEUE_META_KEY,
  SEISMIC_PULSE_VFX_KEY,
  SEISMIC_SWEEP_MS,
} from './behavior_seismicPulse';
import './index'; // 副作用：自动发现注册
import { getBehavior } from './registry';

// 副作用：把 effects.json 真实效果表注册进 core/effects（stun/knockback 槽依赖）。
loadEffectDefs();

const WALL_Y = 1160; // createSimState(1) 的 layout.wallLineY（与旧夹具一致）
const SWEEP_VFX_KEY = SEISMIC_PULSE_VFX_KEY;

/** 构造一个静止敌人夹具（数值仅存在于测试夹具）。 */
function makeEnemy(state: SimState, x: number, y: number, hp = 1000, isBoss = false): Enemy {
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
    isBoss,
    xp: 1,
    color: 0xffffff,
    shape: 'box',
    effects: [],
    dead: false,
  };
  state.enemies.push(e);
  return e;
}

/** 距墙线的深度（正 = 在墙线上方）。敌人 y = WALL_Y − depth。 */
function atDepth(state: SimState, x: number, depth: number, hp = 1000, isBoss = false): Enemy {
  return makeEnemy(state, x, WALL_Y - depth, hp, isBoss);
}

/** 以真实数据表 seismic_wall.json 的指定牌组开火一次（牌表整体替换 → stats 缓存必然失效重建）。 */
function fireSeismic(state: SimState, cards: string[] = []): WeaponStats {
  const def = loadWeaponDefs().seismic_wall;
  if (!state.weaponStates.seismic_wall) {
    addWeapon(state, 'seismic_wall');
  }
  const ws = state.weaponStates.seismic_wall;
  ws.cards = {};
  for (const cardId of cards) {
    ws.cards[cardId] = (ws.cards[cardId] ?? 0) + 1;
  }
  ws.level = cards.length;
  const stats = getWeaponStats(def, state, 'seismic_wall');
  behavior.fire(state, 'seismic_wall', stats);
  return stats;
}

/** 推进模拟时间到 t 并跑一次行为 update 钩子（余震到期 / 波前推进均用 state.timeMs 绝对时间轴）。 */
function tickAt(state: SimState, tMs: number): void {
  state.timeMs = tMs;
  behavior.update?.(state, 16);
}

describe('数据表契约（weapons/seismic_wall.json）', () => {
  it('base 数值随表：35 伤 / 2.4s / 行进 220 / 波前厚 40 / 击退 110 / 余震延时 400ms / 固定五键占位（G4 增强后）', () => {
    const state = createSimState(1);
    atDepth(state, 360, 0);
    const stats = fireSeismic(state);
    expect(stats.damage).toBe(35);
    expect(stats.intervalMs).toBe(2400);
    expect(stats.waveDistance).toBe(220);
    expect(stats.bandDepth).toBe(40);
    expect(stats.knockbackForce).toBe(110);
    expect(stats.aftershockDelayMs).toBe(400);
    expect(stats.projectileSpeed).toBe(0);
    expect(stats.pierce).toBe(0);
    expect(stats.ttlMs).toBe(0);
  });

  it('rangeKeys 身份断言 = ["waveDistance"]（范围强化改作用行进距离）', () => {
    expect(loadWeaponDefs().seismic_wall.rangeKeys).toEqual(['waveDistance']);
  });

  it('地裂 +20/层叠加 bandDepth（波前厚度）且不影响 waveDistance；范围强化 ×1.2 只乘 waveDistance', () => {
    const state = createSimState(1);
    atDepth(state, 360, 0);
    expect(fireSeismic(state, ['earth_split'])).toMatchObject({ bandDepth: 60, waveDistance: 220 });
    expect(fireSeismic(state, ['earth_split', 'earth_split'])).toMatchObject({
      bandDepth: 80,
      waveDistance: 220,
    });
    expect(fireSeismic(state, ['range_up'])).toMatchObject({ waveDistance: 264, bandDepth: 40 }); // 220 × 1.2
    expect(fireSeismic(state, ['range_up', 'range_up'])).toMatchObject({
      bandDepth: 40,
    });
    expect(fireSeismic(state, ['range_up', 'range_up']).waveDistance).toBeCloseTo(316.8, 6); // 220 × 1.2²
    expect(fireSeismic(state, ['earth_split', 'range_up'])).toMatchObject({
      waveDistance: 264, // 范围强化只作用行进距离
      bandDepth: 60, // 地裂只加厚波前
    });
  });

  it('扫掠总时长为导出几何常量 400ms（SEISMIC_SWEEP_MS，硬编码不随距离变化）', () => {
    expect(SEISMIC_SWEEP_MS).toBe(400);
  });

  it('行为经 import.meta.glob 自动发现注册为 seismic_pulse', () => {
    expect(getBehavior('seismic_pulse')).toBe(behavior);
  });
});

describe('波前推进几何', () => {
  it('t=0 出生走廊 [墙线−40, 墙线+40]：贴墙带立即结算（恰在厚度上算在内、再深一点不算）', () => {
    const state = createSimState(1);
    const edge = atDepth(state, 360, 40); // |−40 − 0| = 40 ≤ 40：在出生带内
    const tooDeep = atDepth(state, 360, 40.01); // 40.01 > 40：波前未到
    const onWall = atDepth(state, 100, 0); // 距离 0：在内
    fireSeismic(state);

    expect(edge.hp).toBe(965); // 1000 − 35
    expect(onWall.hp).toBe(965);
    expect(tooDeep.hp).toBe(1000); // 波前尚未经过：不结算
    expect(hasEffect(tooDeep, 'stun')).toBe(false);
    expect(tooDeep.effects.length).toBe(0);
  });

  it('全 x 宽度全覆盖且无数量上限：12 只分散敌人全部在 fire 时被出生带结算', () => {
    const state = createSimState(1);
    const enemies: Enemy[] = [];
    for (let i = 0; i < 12; i++) {
      enemies.push(atDepth(state, i * 65, 10)); // x 0..715 横跨全场，深度 10 ≤ 40
    }
    fireSeismic(state);

    for (const e of enemies) {
      expect(e.hp).toBe(965);
    }
  });

  it('波前未到不受伤、经过恰好结算：深度 100 的敌人在 elapsed≈200ms 的走廊才掉血', () => {
    const state = createSimState(1);
    const e = atDepth(state, 360, 100); // y = 1060
    fireSeismic(state);
    expect(e.hp).toBe(1000); // fire：出生带（≤40）不含

    tickAt(state, 100); // 波前 1160 − 55 = 1105，走廊 [1065, 1200]：1060 尚未到
    expect(e.hp).toBe(1000);

    tickAt(state, 200); // 波前 1050，走廊 [1010, 1145]：1060 ∈ 走廊 → 结算
    expect(e.hp).toBe(965);
  });

  it('t=400ms 波前恰达 wallLineY − waveDistance；最大可达 = 行进距离 + 厚度（终点判定外沿恰在内、再深不算）', () => {
    const state = createSimState(1);
    const atEnd = atDepth(state, 360, 220); // y = 940 = 波前终点：恰在内
    const atMaxReach = atDepth(state, 200, 260); // 220 + 40 = 260（终点判定外沿）：恰在内
    const beyond = atDepth(state, 100, 261); // 261 > 260：永远打不到
    fireSeismic(state);

    tickAt(state, 400); // sweep 结束：走廊 [900, 1200]（波前驻留 940）
    expect(atEnd.hp).toBe(965);
    expect(atMaxReach.hp).toBe(965);
    expect(beyond.hp).toBe(1000);
  });

  it('扫掠时长恒 400ms 不随距离变：范围强化提高波前速度（同一深度更早到达），终点时刻不变', () => {
    // 基础 220：深度 150（y=1010）的敌人在 elapsed=200 的走廊 [1010, 1112] 恰好被覆盖。
    const base = createSimState(1);
    const slow = atDepth(base, 360, 150);
    fireSeismic(base);
    tickAt(base, 160); // 波前 1160 − 88 = 1072，走廊 [1032, 1200]：1010 未到
    expect(slow.hp).toBe(1000);
    tickAt(base, 200); // 波前 1050，走廊 [1010, 1112]：1010 恰在内 → 到达
    expect(slow.hp).toBe(965);

    // range_up ×1.2（264）：同一深度更早到达（波前速度 660px/s vs 550px/s）。
    const boosted = createSimState(1);
    const fast = atDepth(boosted, 360, 150);
    fireSeismic(boosted, ['range_up']);
    tickAt(boosted, 160); // 波前 1160 − 105.6 = 1054.4，走廊 [1014.4, 1200]：1010 仍未到
    expect(fast.hp).toBe(1000);
    tickAt(boosted, 200); // 波前 1160 − 132 = 1028，走廊 [988, 1094.4]：1010 ∈ → 已到达
    expect(fast.hp).toBe(965);

    // 时长恒定：两种距离的 sweep 都在 elapsed=400 结束（波前驻留、不再新增结算）。
    const late = atDepth(boosted, 100, 190); // 190 ≤ 264 + 40：终点走廊内
    tickAt(boosted, 400);
    expect(late.hp).toBe(965);
    const afterEnd = atDepth(boosted, 200, 5); // sweep 结束后新出现的贴墙敌：不再结算
    tickAt(boosted, 416);
    expect(afterEnd.hp).toBe(1000);
  });
});

describe('每敌每 sweep 恰一次（击退向上重入去重）', () => {
  it('被击退进未经过区域的敌人不重复结算：恰掉一次血、恰一次击退位移', () => {
    const state = createSimState(1);
    const e = atDepth(state, 360, 30, 100); // maxHp 100 → 抗性 0.4 → 击退 110×0.4 = 44px 向上
    fireSeismic(state);
    expect(e.hp).toBe(65); // 100 − 35：恰一次结算
    expect(e.y).toBeCloseTo(WALL_Y - 30 - 44, 6); // 深度 30 → 74：已进入波前未经过区域

    tickAt(state, 100);
    tickAt(state, 200);
    tickAt(state, 400);
    expect(e.hp).toBe(65); // 去重：恰一次结算
    expect(e.y).toBeCloseTo(WALL_Y - 74, 6); // 无第二次击退位移
  });
});

describe('结算次序：伤害 → 幸存者击退 → 幸存者眩晕', () => {
  it('幸存者被竖直向上击退（maxHp 抗性随表生效）并附着眩晕 800ms', () => {
    const state = createSimState(1);
    const e = atDepth(state, 360, 10, 1000); // maxHp 1000 → res = 40/1000 = 0.04
    fireSeismic(state);

    expect(e.hp).toBe(965);
    expect(e.y).toBeCloseTo(WALL_Y - 10 - 110 * 0.04, 6); // 击退 110 × 抗性 0.04 = 4.4px 向上
    expect(isStunned(e)).toBe(true);
    expect(e.effects[0].kind).toBe('stun');
    expect(e.effects[0].untilMs).toBe(800); // timeMs 0 + 效果表 800ms
  });

  it('maxHp 抗性分级：普通 100 血退 44px、400 血退 11px、Boss 眩晕减半 400ms', () => {
    const state = createSimState(1);
    const normal = atDepth(state, 100, 10, 100); // res = 0.4
    const tank = atDepth(state, 300, 10, 400); // res = 0.1
    const boss = atDepth(state, 500, 10, 4000, true); // res = 0.01
    fireSeismic(state);

    expect(normal.y).toBeCloseTo(WALL_Y - 10 - 44, 6);
    expect(tank.y).toBeCloseTo(WALL_Y - 10 - 11, 6);
    expect(boss.y).toBeCloseTo(WALL_Y - 10 - 1.1, 6);
    expect(boss.effects[0].untilMs).toBe(400); // Boss 减半（既有规则）
  });

  it('致死一击不附着 CC（幸存者判定）：被波前震死的敌人无击退无眩晕', () => {
    const state = createSimState(1);
    const frail = atDepth(state, 360, 10, 35); // 恰好被 35 伤击杀
    fireSeismic(state);

    expect(frail.dead).toBe(true);
    expect(frail.effects.length).toBe(0);
    expect(frail.y).toBe(WALL_Y - 10); // 未被位移
  });
});

describe('无可达目标不开火且 cooldownMs 归 0', () => {
  it('可达范围（行进 220 + 厚度 40 = 260）内无存活敌人：冷却归 0、不写 sweep/VFX、不排余震', () => {
    const state = createSimState(1);
    atDepth(state, 360, 261); // 恰在可达范围外
    const stats = fireSeismic(state, ['aftershock', 'wall_resonance']);
    const ws = state.weaponStates.seismic_wall;

    expect(ws.cooldownMs).toBe(0); // fire 写入的归 0 标记
    expect(state.meta[SWEEP_VFX_KEY]).toBeUndefined();
    expect(state.meta[AFTERSHOCK_QUEUE_META_KEY]).toBeUndefined();
    expect(stats.damage).toBe(35); // stats 照常返回（解释器照常 += interval）
  });

  it('全场无敌：同样归 0', () => {
    const state = createSimState(1);
    fireSeismic(state);
    expect(state.weaponStates.seismic_wall.cooldownMs).toBe(0);
  });

  it('可达但波前尚未经过的目标算可达（开火门槛按最终范围判定）：写 sweep、不改写冷却、波前到达后结算', () => {
    const state = createSimState(1);
    addWeapon(state, 'seismic_wall');
    state.weaponStates.seismic_wall.cooldownMs = 500; // 非零快照：验证真实开火不改写冷却
    const e = atDepth(state, 360, 150); // 150 ≤ 200：可达，但在出生带（≤40）外
    fireSeismic(state);

    expect(state.meta[SWEEP_VFX_KEY]).toBeDefined(); // 真实开火：sweep 已发出
    expect(state.weaponStates.seismic_wall.cooldownMs).toBe(500); // fire 不改写冷却
    expect(e.hp).toBe(1000); // 波前未到

    tickAt(state, 400);
    expect(e.hp).toBe(965); // 波前最终扫到
  });

  it('解释器集成：无目标冷却归 0 后 += interval → 2400；真实开火不改写 → 2384', () => {
    const defs = loadWeaponDefs();
    // 无目标：fire 归 0（重试标记）→ 解释器 += 3600。
    const idle = createSimState(1);
    addWeapon(idle, 'seismic_wall');
    updateWeapons(idle, 16, defs);
    expect(idle.weaponStates.seismic_wall.cooldownMs).toBe(2400);

    // 真实开火：fire 不改写冷却（-16）→ += 3600 → 3584。
    const real = createSimState(1);
    addWeapon(real, 'seismic_wall');
    atDepth(real, 360, 10, 1000);
    updateWeapons(real, 16, defs);
    expect(real.weaponStates.seismic_wall.cooldownMs).toBe(2384);
    expect(real.enemies[0].hp).toBe(965); // t=0 出生走廊在 fire 内立即结算
  });
});

describe('过载共振（结算时判定 ×2）', () => {
  it('波前经过时已处于眩晕中的目标伤害 ×2（70），未眩晕目标照常 35', () => {
    const state = createSimState(1);
    const stunned = atDepth(state, 100, 10, 1000);
    applyEffect(state, stunned, 'stun'); // 预先眩晕（模拟上一轮波残留）
    const plain = atDepth(state, 400, 10, 1000);
    fireSeismic(state, ['overload_resonance']);

    expect(stunned.hp).toBe(1000 - 70);
    expect(plain.hp).toBe(1000 - 35);
  });

  it('判定时刻 = 波前经过该敌人的那一刻：深处预眩晕目标在波前抵达时才吃 ×2；本波自己震晕的不重复结算', () => {
    const state = createSimState(1);
    const deep = atDepth(state, 360, 100, 1000);
    applyEffect(state, deep, 'stun'); // 预先眩晕
    const near = atDepth(state, 100, 10, 1000);
    fireSeismic(state, ['overload_resonance']);

    expect(near.hp).toBe(965); // 出生带结算时未眩晕 → 35（本波挂的眩晕不影响本次判定）
    expect(deep.hp).toBe(1000); // 波前未到
    tickAt(state, 200); // 波前抵达深度 100 → 判定时仍处于预置眩晕 → ×2
    expect(deep.hp).toBe(1000 - 70);
  });

  it('无过载共振牌：眩晕中的目标也只吃 35', () => {
    const state = createSimState(1);
    const e = atDepth(state, 100, 10, 1000);
    applyEffect(state, e, 'stun');
    fireSeismic(state);
    expect(e.hp).toBe(965);
  });
});

describe('城垣共鸣（整次 sweep 累计命中 ≥ 8，sweep 结束时结算）', () => {
  function spreadEight(state: SimState, hp = 1000): Enemy[] {
    const list: Enemy[] = [];
    for (let i = 0; i < 8; i++) {
      list.push(atDepth(state, i * 80, i * 20, hp)); // 深度 0..140：出生带只盖住前 3 个
    }
    return list;
  }

  it('fire 时不结算回复；sweep 结束（elapsed=400）按累计命中数（≥8）回复 4×层数', () => {
    const state = createSimState(1);
    spreadEight(state);
    state.wall.hp = 1500;
    fireSeismic(state, ['wall_resonance']);
    expect(state.wall.hp).toBe(1500); // sweep 未结束：不结算

    tickAt(state, 400); // 8 个全部被波前扫过 → sweep 收尾结算
    expect(state.wall.hp).toBe(1504);
  });

  it('命中 7 个不回复', () => {
    const state = createSimState(1);
    for (let i = 0; i < 7; i++) {
      atDepth(state, i * 80, i * 20);
    }
    state.wall.hp = 1500;
    fireSeismic(state, ['wall_resonance']);
    tickAt(state, 400);
    expect(state.wall.hp).toBe(1500);
  });

  it('被本波击杀的敌人计入命中数；余震命中不计数、也不触发第二次回复', () => {
    const state = createSimState(1);
    spreadEight(state, 22); // 全部会被本波（而非余震）震杀
    state.wall.hp = 1500;
    fireSeismic(state, ['wall_resonance', 'aftershock']);
    tickAt(state, 160); // 波前逐帧推进：击杀深度 ≤128 段
    tickAt(state, 320); // 击杀剩余段（8 个全部死于本波）
    tickAt(state, 400); // 余震先到期（全灭 → 无伤害无计数）；随后 sweep 收尾按命中数 8 回复
    expect(state.wall.hp).toBe(1504);

    tickAt(state, 416); // 无第二次回复
    expect(state.wall.hp).toBe(1504);
  });

  it('2 层回复 8 hp，clamp 到墙血上限', () => {
    const state = createSimState(1);
    spreadEight(state);
    state.wall.hp = state.wall.maxHp - 3; // 1597
    fireSeismic(state, ['wall_resonance', 'wall_resonance']);
    tickAt(state, 400);
    expect(state.wall.hp).toBe(state.wall.maxHp); // 1597 + 8 → clamp 1600
  });
});

describe('余震（meta 延时队列，fire 时刻起算 400ms ≈ 波扫完）', () => {
  it('fire 后恰 400ms 到期：30% 伤害快照结算、无击退无眩晕、到期前不结算', () => {
    const state = createSimState(1);
    const e = atDepth(state, 360, 10, 1000);
    fireSeismic(state, ['aftershock']);

    expect(e.hp).toBe(965); // 出生带 35
    const yAfterSweep = e.y;
    const stunUntilAfterSweep = e.effects[0].untilMs;

    tickAt(state, 399);
    expect(e.hp).toBe(965); // 未到期

    tickAt(state, 400);
    expect(e.hp).toBeCloseTo(965 - 35 * 0.3, 6); // 余震 = 35 × 30%
    expect(e.y).toBe(yAfterSweep); // 无击退（不再位移）
    expect(e.effects[0].untilMs).toBe(stunUntilAfterSweep); // 眩晕未被刷新/重挂
    expect(e.effects).toHaveLength(1); // 无新 CC 实例
    expect(state.meta[AFTERSHOCK_QUEUE_META_KEY]).toEqual([]); // 消费后压实清空
  });

  it('余震只对结算时「发射时行进带快照」（≤ waveDistance）内当时存活的敌人结算', () => {
    const state = createSimState(1);
    const inBand = atDepth(state, 100, 20, 1000); // 出生带内：fire 即被扫
    const movedIn = atDepth(state, 400, 260, 1000); // 发射时在可达外沿（260），波前尚未扫到
    const movedOut = atDepth(state, 600, 100, 1000); // 发射时在行进带内
    fireSeismic(state, ['aftershock']);
    expect(inBand.hp).toBe(965);

    tickAt(state, 320); // 波前扫到深度 100：movedOut 被结算（走廊 [944, 1200]）
    expect(movedOut.hp).toBe(965);

    movedIn.y = WALL_Y - 20; // sweep 已过该区（波前深度已 176）：本 sweep 不再结算它
    movedOut.y = 900; // 移出行进带（260 > 220）
    tickAt(state, 400); // 余震按行进带（≤220）重扫

    expect(inBand.hp).toBeCloseTo(965 - 10.5, 6); // 出生带内：被扫 + 余震
    expect(movedIn.hp).toBeCloseTo(1000 - 10.5, 6); // sweep 未扫到（入带太晚）；余震按快照带重扫命中
    expect(movedOut.hp).toBe(965); // 已离开行进带：余震不命中
  });

  it('层数线性放大：3 层 = 90% 伤害；无余震牌则队列为空', () => {
    const state = createSimState(1);
    const e = atDepth(state, 360, 10, 1000);
    fireSeismic(state, ['aftershock', 'aftershock', 'aftershock']);
    tickAt(state, 400);
    expect(e.hp).toBeCloseTo(965 - 35 * 0.9, 6);

    const noCard = createSimState(1);
    const e2 = atDepth(noCard, 360, 10, 1000);
    fireSeismic(noCard);
    tickAt(noCard, 400);
    expect(e2.hp).toBe(965);
    expect(noCard.meta[AFTERSHOCK_QUEUE_META_KEY]).toBeUndefined();
  });

  it('持过载共振时，余震对结算时仍眩晕的目标伤害 ×2（6.6 → 13.2）', () => {
    const state = createSimState(1);
    const e = atDepth(state, 360, 10, 1000);
    fireSeismic(state, ['aftershock', 'overload_resonance']);
    tickAt(state, 400);
    // 出生带 35 → 965；余震时眩晕（800ms）未过期 → 10.5 × 2。
    expect(e.hp).toBeCloseTo(965 - 35 * 0.3 * 2, 6);
  });
});

describe('震荡加深（data.durationMs 逐实例覆盖）', () => {
  it('1 层 950ms、2 层 1100ms（基础 800 + 150×层数）', () => {
    const state = createSimState(1);
    const one = atDepth(state, 100, 10);
    fireSeismic(state, ['stun_deepen']);
    expect(one.effects[0].untilMs).toBe(950);

    const state2 = createSimState(1);
    const two = atDepth(state2, 100, 10);
    fireSeismic(state2, ['stun_deepen', 'stun_deepen']);
    expect(two.effects[0].untilMs).toBe(1100);
  });

  it('Boss 减半作用于覆盖后的时长：2 层 1100 → 550；无牌 Boss 保持既有 400', () => {
    const state = createSimState(1);
    const boss = atDepth(state, 100, 10, 4000, true);
    fireSeismic(state, ['stun_deepen', 'stun_deepen']);
    expect(boss.effects[0].untilMs).toBe(550);

    const state2 = createSimState(1);
    const plainBoss = atDepth(state2, 100, 10, 4000, true);
    fireSeismic(state2);
    expect(plainBoss.effects[0].untilMs).toBe(400);
  });
});

describe('sweep 重叠防御与停摆/复现', () => {
  it('连续 fire 覆盖写共享单键：旧 sweep 被放弃（共鸣只结算一次）、hitIds 按 sweep 重建（同敌可被下一波再结算）', () => {
    const state = createSimState(1);
    for (let i = 0; i < 8; i++) {
      atDepth(state, i * 80, i * 20, 1000); // 深度 0..140
    }
    state.wall.hp = 1500;
    fireSeismic(state, ['wall_resonance']); // sweep 1：出生带结算前 3 个
    fireSeismic(state, ['wall_resonance']); // sweep 2 覆盖 sweep 1（重叠防御）：再结算前 3 个
    tickAt(state, 400); // sweep 2 收尾：走廊覆盖全部 8 个 → 命中 8 → 回复恰一次

    expect(state.enemies[0].hp).toBe(1000 - 35 * 2); // fire1（sweep1）+ fire2（sweep2）各结算一次：hitIds 按 sweep 重建
    expect(state.enemies[5].hp).toBe(965); // 深度 100：仅 sweep 2 的结束走廊扫到
    expect(state.wall.hp).toBe(1504); // 只有 sweep 2 的共鸣被结算（旧 sweep 放弃 → 恰一次回复）
  });

  it('over 后停摆：不推进波前、不消费余震', () => {
    const state = createSimState(1);
    const e = atDepth(state, 360, 100, 1000); // 出生带外：只有波前推进才能结算
    fireSeismic(state, ['aftershock']);
    state.over = 'defeat';

    tickAt(state, 400);
    expect(e.hp).toBe(1000); // 波前未推进、余震未消费
  });

  it('零随机同种子可复现：同种子同脚本两局逐敌 hp/y 全等', () => {
    const run = (): { hp: number[]; y: number[] } => {
      const state = createSimState(7);
      for (let i = 0; i < 8; i++) {
        atDepth(state, i * 70, 10 + i * 25, 100 + i * 37);
      }
      fireSeismic(state, ['aftershock', 'stun_deepen']);
      tickAt(state, 160);
      tickAt(state, 400);
      return {
        hp: state.enemies.map((e) => e.hp),
        y: state.enemies.map((e) => e.y),
      };
    };
    const a = run();
    const b = run();
    expect(b.hp).toEqual(a.hp);
    expect(b.y).toEqual(a.y);
  });
});

describe('VFX / sweep 共享单键', () => {
  it('真实开火写 { startMs, waveDistance, thickness, untilMs }；无目标不写；厚度/行进随牌快照', () => {
    const state = createSimState(1);
    atDepth(state, 360, 10, 1000);
    fireSeismic(state);
    expect(state.meta[SWEEP_VFX_KEY]).toMatchObject({
      startMs: 0,
      waveDistance: 220,
      thickness: 40,
      untilMs: SEISMIC_SWEEP_MS + 300, // sweep 全程 + 淡出留存
    });

    const state2 = createSimState(1);
    atDepth(state2, 360, 10, 1000);
    fireSeismic(state2, ['earth_split', 'earth_split', 'range_up']);
    expect(state2.meta[SWEEP_VFX_KEY]).toMatchObject({ waveDistance: 264, thickness: 80 });

    const idle = createSimState(1);
    fireSeismic(idle);
    expect(idle.meta[SWEEP_VFX_KEY]).toBeUndefined();
  });

  it('留存窗 = sweep（400ms）+ 淡出（300ms）：untilMs 前保留、到点由 update 清理（有界）', () => {
    const state = createSimState(1);
    atDepth(state, 360, 10, 1000);
    fireSeismic(state);

    tickAt(state, 699);
    expect(state.meta[SWEEP_VFX_KEY]).toBeDefined(); // 淡出窗内保留

    tickAt(state, 700);
    expect(state.meta[SWEEP_VFX_KEY]).toBeUndefined(); // timeMs ≥ untilMs：清理
  });
});
