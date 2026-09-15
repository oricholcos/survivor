// src/core/zones.test.ts —— 通用地面区域系统契约（T2.1b）：
// spawnZone 字段全拷贝（调用方改写 spec 不影响区域）、meta 懒初始化、tick 节奏
// （tickMs 内的 step 只在到点结算 + 长 dt 追补 + 最后一跳恰落在到期当帧）、
// 范围判定（区域内受伤 + effectKind 附着、区域外不受影响）、致死一击不附着、
// 到期移除、over 停摆、确定性（同种子两遍快照一致）。
import { describe, expect, it } from 'vitest';
import { hasEffect, registerEffectDef, speedMultiplier } from './effects';
import { drainEvents } from './events';
import { createSimState } from './simState';
import { SpatialHash } from './spatialHash';
import type { Enemy, SimState } from './types';
import { listZones, spawnZone, updateZones, type ZoneSpec } from './zones';

// 测试夹具效果定义：speedFactor 0.5（区域 effectData 可逐实例覆盖为 0.25）。
registerEffectDef({
  id: 'zone_probe_slow',
  name: '区域探测减速',
  durationMs: 1000,
  maxStacks: 2,
  refresh: 'add',
  speedFactor: 0.5,
});

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

/** 模拟真实管线里 updateEnemies 的网格重建：存活敌人全部插入。 */
function fillGrid(state: SimState, grid: SpatialHash<Enemy>): void {
  grid.clear();
  for (let i = 0; i < state.enemies.length; i++) {
    const e = state.enemies[i];
    if (!e.dead) {
      grid.insert(e, e.x, e.y, e.radius);
    }
  }
}

/** 区域参数夹具：圆心 (400,600) 半径 100、时长 2000、tick 500、每跳 10 伤害。 */
function zoneSpec(overrides?: Partial<ZoneSpec>): ZoneSpec {
  return {
    x: 400,
    y: 600,
    radius: 100,
    durationMs: 2000,
    tickMs: 500,
    damagePerTick: 10,
    ...overrides,
  };
}

describe('spawnZone：懒初始化与字段全拷贝', () => {
  it('meta.zones 首次 spawn 时才创建；spec 后续改写不影响区域（effectData 逐键拷贝）', () => {
    const state = createSimState(1);
    const grid = makeGrid();

    // 无区域：update 零开销安全（不抛错、不懒创建数组）。
    updateZones(state, 100, grid);
    expect(state.meta.zones).toBeUndefined();
    expect(listZones(state)).toEqual([]);

    const spec = zoneSpec({ effectKind: 'zone_probe_slow', effectData: { speedFactor: 0.25 } });
    spawnZone(state, spec);
    expect(state.meta.zones).toBeDefined();

    // 调用方改写 spec（含 effectData 深层键）：区域不受影响。
    spec.x = 9999;
    spec.radius = 1;
    spec.damagePerTick = 999;
    if (spec.effectData) {
      spec.effectData.speedFactor = 0.9;
    }

    const zones = listZones(state);
    expect(zones.length).toBe(1);
    expect(zones[0].x).toBe(400);
    expect(zones[0].y).toBe(600);
    expect(zones[0].radius).toBe(100);
    expect(zones[0].durationMs).toBe(2000);
    expect(zones[0].tickMs).toBe(500);
    expect(zones[0].damagePerTick).toBe(10);
    expect(zones[0].effectKind).toBe('zone_probe_slow');
    expect(zones[0].effectData).toEqual({ speedFactor: 0.25 });
    expect(zones[0].color).toBeUndefined();
  });
});

describe('tick 节奏', () => {
  it('tickMs 内的 step 只在到点结算（首跳在 spawn 后一个 tickMs）', () => {
    const state = createSimState(1);
    const grid = makeGrid();
    const e = makeEnemy(state, 400, 600, 1000);
    spawnZone(state, zoneSpec({ tickMs: 500, damagePerTick: 10 }));
    fillGrid(state, grid); // 敌人静止：网格灌一次即可（updateZones 不清网格）

    updateZones(state, 100, grid); // elapsed 100 < 500
    expect(e.hp).toBe(1000);
    updateZones(state, 399, grid); // elapsed 499 < 500：不结算
    expect(e.hp).toBe(1000);
    updateZones(state, 1, grid); // elapsed 500：第 1 跳
    expect(e.hp).toBe(990);
    updateZones(state, 499, grid); // elapsed 999：不结算
    expect(e.hp).toBe(990);
    updateZones(state, 1, grid); // elapsed 1000：第 2 跳
    expect(e.hp).toBe(980);
  });

  it('长 dt 追补：一次 step 跨过多个跳点时按跳点数追补结算', () => {
    const state = createSimState(1);
    const grid = makeGrid();
    const e = makeEnemy(state, 400, 600, 1000);
    spawnZone(state, zoneSpec({ tickMs: 500, durationMs: 5000, damagePerTick: 10 }));
    fillGrid(state, grid);

    updateZones(state, 1200, grid); // 跳点 500、1000 两跳都到期
    expect(e.hp).toBe(980);
  });
});

describe('范围判定与效果附着', () => {
  it('区域内敌人受伤并附着 effectKind（effectData 覆盖定义值）；区域外不受影响', () => {
    const state = createSimState(1);
    const inside = makeEnemy(state, 420, 610, 100); // 距圆心约 22px
    const outside = makeEnemy(state, 700, 600, 100); // 距圆心 300px
    spawnZone(
      state,
      zoneSpec({ effectKind: 'zone_probe_slow', effectData: { speedFactor: 0.25 } }),
    );
    const grid = makeGrid();
    fillGrid(state, grid);

    updateZones(state, 500, grid); // 第 1 跳

    expect(inside.hp).toBe(90);
    expect(hasEffect(inside, 'zone_probe_slow')).toBe(true);
    expect(speedMultiplier(inside)).toBeCloseTo(0.25, 12); // effectData 覆盖 def 的 0.5
    expect(outside.hp).toBe(100);
    expect(hasEffect(outside, 'zone_probe_slow')).toBe(false);
    expect(speedMultiplier(outside)).toBe(1);
  });

  it('致死一击不再附着效果（与弹丸命中同款语义）；击杀走统一伤害入口出事件', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 400, 600, 5);
    spawnZone(state, zoneSpec({ damagePerTick: 10, effectKind: 'zone_probe_slow' }));
    const grid = makeGrid();
    fillGrid(state, grid);

    updateZones(state, 500, grid);

    expect(e.dead).toBe(true);
    expect(hasEffect(e, 'zone_probe_slow')).toBe(false);
    expect(drainEvents(state)).toEqual([
      { kind: 'enemyKilled', enemyId: e.id, typeId: 'tester', x: 400, y: 600, isBoss: false },
    ]);
  });
});

describe('到期移除', () => {
  it('durationMs 内按节奏结算；到期当帧不再结算并从 listZones 消失，此后无伤害', () => {
    const state = createSimState(1);
    const grid = makeGrid();
    const e = makeEnemy(state, 400, 600, 1000);
    spawnZone(state, zoneSpec({ durationMs: 1200, tickMs: 500, damagePerTick: 10 }));
    fillGrid(state, grid);

    updateZones(state, 500, grid); // elapsed 500：第 1 跳（500 <= 1200）
    expect(e.hp).toBe(990);
    updateZones(state, 500, grid); // elapsed 1000：第 2 跳
    expect(e.hp).toBe(980);
    expect(listZones(state).length).toBe(1);

    updateZones(state, 500, grid); // elapsed 1500 >= 1200：跳点 1500 超时长不结算，区域移除
    expect(e.hp).toBe(980);
    expect(listZones(state)).toEqual([]);

    updateZones(state, 500, grid); // 已移除：不再结算
    expect(e.hp).toBe(980);
  });
});

describe('防重入与确定性', () => {
  it('state.over 非 null 时停摆（不结算、不移除）', () => {
    const state = createSimState(1);
    const grid = makeGrid();
    const e = makeEnemy(state, 400, 600, 1000);
    spawnZone(state, zoneSpec());
    state.over = 'defeat';

    updateZones(state, 500, grid);

    expect(e.hp).toBe(1000);
    expect(listZones(state).length).toBe(1);
  });

  it('同种子两遍：区域快照（含内部推进字段）与敌人状态完全一致', () => {
    /** 一遍完整流程：敌人位置走 state.rng（同种子 → 同序列），双区域 + 7 帧推进。 */
    function runOnce(): { zoneSnap: string; hp: number[]; stacks: string[] } {
      const state = createSimState(42);
      const grid = makeGrid();
      for (let i = 0; i < 6; i++) {
        makeEnemy(state, state.rng.range(300, 500), state.rng.range(500, 700), 100);
      }
      spawnZone(state, zoneSpec()); // (400,600) r100，tick 500，时长 2000
      spawnZone(
        state,
        zoneSpec({ x: 450, y: 620, radius: 80, durationMs: 1600, tickMs: 300, damagePerTick: 4 }),
      );
      for (let f = 0; f < 7; f++) {
        state.timeMs += 200;
        fillGrid(state, grid);
        updateZones(state, 200, grid); // 累计 elapsed 1400：两区域均存活
      }
      return {
        zoneSnap: JSON.stringify(listZones(state)),
        hp: state.enemies.map((e) => e.hp),
        stacks: state.enemies.map((e) =>
          e.effects.map((fx) => `${fx.kind}:${fx.stacks}`).join(','),
        ),
      };
    }

    const a = runOnce();
    const b = runOnce();
    expect(a.zoneSnap).toBe(b.zoneSnap);
    expect(a.hp).toEqual(b.hp);
    expect(a.stacks).toEqual(b.stacks);

    // 快照应包含真实的推进痕迹（非平凡快照）：两区域都在场且推进字段已前进。
    const zones = JSON.parse(a.zoneSnap) as Array<{ x: number; nextTickAt: number; elapsedMs: number }>;
    expect(zones.length).toBe(2);
    expect(zones[0]).toMatchObject({ x: 400, nextTickAt: 1500, elapsedMs: 1400 });
    expect(zones[1]).toMatchObject({ x: 450, nextTickAt: 1500, elapsedMs: 1400 });
  });
});
