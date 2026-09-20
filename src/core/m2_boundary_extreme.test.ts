// src/core/m2_boundary_extreme.test.ts —— M2 里程碑：机制组合极端边界与高并发内存稳定性验证。
// 覆盖：
// 1. 连射待发队列 (burst_shot) 在开火后怪物瞬间全灭时的平滑表现与队列清理；
// 2. 分裂弹 (split_shot) 在无可用存活目标（全部敌人死亡/仅有被排除目标）时的零报错与优雅降级；
// 3. 多射4层 + 连射2层高并发弹幕下的弹丸完整生命周期闭环与对象池复用稳定性。
import { describe, expect, it } from 'vitest';
import { loadEffectDefs } from '../data/effects';
import { loadWeaponDefs } from '../data/weapons';
import { getBehavior } from './behaviors/registry';
import { BURST_QUEUE_META_KEY, type BurstWaveEntry } from './cards';
import { projectilePool, updateProjectiles } from './projectiles';
import { createSimState } from './simState';
import { SpatialHash } from './spatialHash';
import type { Enemy, SimState } from './types';
import { getWeaponStats, type WeaponStats } from './weapons';
import './behaviors/index'; // 自动加载并注册所有武器行为

loadEffectDefs();

// 任务三：蓄能狙击已移出多射/连射/分裂三张通用牌的 applyTo（恒单发、无连射调度、
// 无分裂），极端边界场景只覆盖仍在池内的四把弹道武器。
const BALLISTIC_WEAPONS = ['scatter', 'homing_missile', 'mortar', 'prism'] as const;

function makeEnemy(state: SimState, x: number, y: number, hp = 1e6): Enemy {
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

function fireWeaponWithCards(state: SimState, weaponId: string, cards: string[] = []): WeaponStats {
  const defs = loadWeaponDefs();
  const def = defs[weaponId];
  if (!def) {
    throw new Error(`Weapon not found: ${weaponId}`);
  }
  state.weaponStates[weaponId] = { level: cards.length, cooldownMs: 0, cards: {} };
  const ws = state.weaponStates[weaponId];
  for (const c of cards) {
    ws.cards[c] = (ws.cards[c] ?? 0) + 1;
  }
  const stats = getWeaponStats(def, state, weaponId);
  const beh = getBehavior(def.behavior);
  beh.fire(state, weaponId, stats);
  return stats;
}

describe('M2 极端边界 1: 开火后怪物瞬间全灭时连射波的表现', () => {
  for (const wid of BALLISTIC_WEAPONS) {
    it(`武器 ${wid}: 开火后怪物全灭，跟发波到期不崩溃、不产生脏弹、队列正常清空`, () => {
      const state = createSimState(1);
      const def = loadWeaponDefs()[wid];
      const beh = getBehavior(def.behavior);

      const target = makeEnemy(state, 360, 1100);
      // 开火 1 次，配置 2 层连射（共排入 2 个跟发波：150ms 和 300ms）
      fireWeaponWithCards(state, wid, ['burst_shot', 'burst_shot']);

      const queueBefore = (state.meta[BURST_QUEUE_META_KEY] as BurstWaveEntry[]) ?? [];
      expect(queueBefore).toHaveLength(2);
      const initialProjCount = state.projectiles.length;

      // 瞬间全灭：怪死亡且从敌人列表中清除
      target.dead = true;
      state.enemies = [];

      // 时间推进至 150ms（第一波到期）
      state.timeMs += 150;
      beh.update?.(state, 16);

      const queueMid = (state.meta[BURST_QUEUE_META_KEY] as BurstWaveEntry[]) ?? [];
      expect(queueMid).toHaveLength(1);

      // 索敌武器不因无怪而报错，也不生成锁定失败的孤儿弹丸
      if (wid !== 'scatter') {
        expect(state.projectiles.length).toBe(initialProjCount);
      }

      // 时间推进至 300ms（第二波到期）
      state.timeMs += 150;
      beh.update?.(state, 16);

      const queueEnd = (state.meta[BURST_QUEUE_META_KEY] as BurstWaveEntry[]) ?? [];
      expect(queueEnd).toHaveLength(0); // 全部消费完毕，无残留
    });
  }

  it('游戏已结算 (state.over != null) 时，连射波重放被短路保护', () => {
    const state = createSimState(1);
    const def = loadWeaponDefs().prism;
    const beh = getBehavior(def.behavior);

    makeEnemy(state, 360, 1100);
    fireWeaponWithCards(state, 'prism', ['burst_shot']);

    // 游戏在跟发波到达前判定胜负
    state.timeMs += 150;
    state.over = 'defeat';

    const projCountBefore = state.projectiles.length;
    beh.update?.(state, 16);

    // 未产生新弹丸，防止游戏结算后污染状态
    expect(state.projectiles.length).toBe(projCountBefore);
  });
});

describe('M2 极端边界 2: 无可用分裂目标时次级弹不异常报错', () => {
  for (const wid of BALLISTIC_WEAPONS) {
    it(`武器 ${wid}: 全场敌人均已死亡（0 个存活可用目标）时，触发分裂不报错且次级弹生成为 0`, () => {
      const state = createSimState(1);
      const def = loadWeaponDefs()[wid];
      const beh = getBehavior(def.behavior);

      const enemy = makeEnemy(state, 360, 1100);
      fireWeaponWithCards(state, wid, ['split_shot']);
      expect(state.projectiles.length).toBeGreaterThan(0);

      const mainProj = state.projectiles[0];
      mainProj.x = 360;
      mainProj.y = 1100;

      // 敌人在分裂触发前或当下已死亡
      enemy.dead = true;

      if (wid === 'homing_missile' || wid === 'mortar') {
        mainProj.dead = true;
        mainProj.data.hitEnemyId = enemy.id;
        mainProj.data.tx = 360;
        mainProj.data.ty = 1100;
        expect(() => beh.onProjectileDeath?.(state, mainProj)).not.toThrow();
      } else {
        expect(() => beh.onProjectileHit?.(state, mainProj, enemy)).not.toThrow();
      }

      // 次级弹生成数量应为 0（无可用存活目标）
      const secondaries = state.projectiles.filter((p) => p.data.isSecondary === 1);
      expect(secondaries).toHaveLength(0);
      // 主弹的分裂标记已被抢先置位，绝无死循环
      expect(mainProj.data.splitDone).toBe(1);
    });

    if (wid !== 'mortar') {
      it(`武器 ${wid}: 场上仅有被命中主怪时，该怪被 excludeIds 排除，次级弹数量为 0 且无报错`, () => {
        const state = createSimState(1);
        const def = loadWeaponDefs()[wid];
        const beh = getBehavior(def.behavior);

        const soleEnemy = makeEnemy(state, 360, 1100);
        fireWeaponWithCards(state, wid, ['split_shot']);

        const mainProj = state.projectiles[0];
        mainProj.x = 360;
        mainProj.y = 1100;

        if (wid === 'homing_missile') {
          mainProj.dead = true;
          mainProj.data.hitEnemyId = soleEnemy.id;
          mainProj.data.tx = 360;
          mainProj.data.ty = 1100;
          beh.onProjectileDeath?.(state, mainProj);
        } else {
          beh.onProjectileHit?.(state, mainProj, soleEnemy);
        }

        const secondaries = state.projectiles.filter((p) => p.data.isSecondary === 1);
        expect(secondaries).toHaveLength(0);
        expect(mainProj.data.splitDone).toBe(1);
      });
    }
  }
});

describe('M2 极端边界 3: 多射4层 + 连射2层高并发下的弹丸生命周期与内存稳定性', () => {
  it('scatter 9枚/波 × 3波密集弹幕：经完整物理更新与网格碰撞，所有弹丸正常死亡回池，无泄漏无脏数据', () => {
    const state = createSimState(1);
    const grid = new SpatialHash<Enemy>(64);

    // 放置 20 个高血量敌人分散在射程内以通过防空放判定
    for (let i = 0; i < 20; i++) {
      makeEnemy(state, 200 + i * 16, 900 + (i % 5) * 40, 1e6);
    }

    // 装备 4 张多射 + 2 张连射 + 1 张分裂 + 1 张反弹
    fireWeaponWithCards(state, 'scatter', [
      'multi_shot',
      'multi_shot',
      'multi_shot',
      'multi_shot',
      'burst_shot',
      'burst_shot',
      'split_shot',
      'bounce_up',
    ]);

    // 首波应有 base 5 + 4 = 9 枚弹丸
    expect(state.projectiles).toHaveLength(9);

    // 推进足够长的周期（300帧 × 16ms = 4.8s），确保首发、两次跟发波（150ms/300ms）、分裂弹及反弹弹丸全部完成完整生命周期
    const beh = getBehavior('scatter_shot');
    for (
      let f = 0;
      f < 300 &&
      (state.projectiles.length > 0 ||
        (((state.meta[BURST_QUEUE_META_KEY] as BurstWaveEntry[]) ?? []).length > 0));
      f++
    ) {
      beh.update?.(state, 16);
      updateProjectiles(state, 16, grid);
      state.timeMs += 16;
    }

    // 所有弹丸应当均已到达寿命或碰撞耗尽，全部安全回池！
    expect(state.projectiles).toHaveLength(0);
    // 待发队列全部清空
    const queue = (state.meta[BURST_QUEUE_META_KEY] as BurstWaveEntry[]) ?? [];
    expect(queue).toHaveLength(0);

    // 验证对象池复用稳定性：新从池中 acquire 的实例必须是干净的，没有上轮残留
    const fresh = projectilePool.acquire();
    expect(fresh.hitIds).toHaveLength(0);
    expect(fresh.effectsOnHit).toHaveLength(0);
    expect(Object.keys(fresh.data)).toHaveLength(0);
    expect(fresh.dead).toBe(false);
    projectilePool.release(fresh);
  });
});


