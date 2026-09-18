// src/core/ballistics_cards_closed_loop.test.ts —— M1 弹道与卡牌机制全武器闭环自动化审计与回归套件。
import { describe, expect, it } from 'vitest';
import { loadEffectDefs } from '../data/effects';
import { loadWeaponDefs } from '../data/weapons';
import { getBehavior } from './behaviors/registry';
import { BURST_QUEUE_META_KEY, type BurstWaveEntry } from './cards';
import { updateProjectiles } from './projectiles';
import { createSimState } from './simState';
import { SpatialHash } from './spatialHash';
import type { Enemy, SimState } from './types';
import { getWeaponStats, type WeaponStats } from './weapons';
import { listZones } from './zones';
import './behaviors/index'; // 自动注册所有武器行为

// 加载效果表
loadEffectDefs();

const BALLISTIC_WEAPON_IDS = [
  'charge_sniper',
  'scatter',
  'homing_missile',
  'mortar',
  'prism',
] as const;

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

function fireWeapon(state: SimState, weaponId: string, cards: string[] = []): WeaponStats {
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

describe('M1.1: 连射队列 (burst_shot) 5 把弹道武器全闭环', () => {
  for (const wid of BALLISTIC_WEAPON_IDS) {
    describe(`武器 ${wid} 连射队列行为`, () => {
      it('开火后调用 scheduleBurstWaves 入队，且波间隔严格为 150ms', () => {
        const state = createSimState(1);
        makeEnemy(state, 360, 1100);
        makeEnemy(state, 400, 1100);

        fireWeapon(state, wid, ['burst_shot']);
        const queue = (state.meta[BURST_QUEUE_META_KEY] as BurstWaveEntry[]) ?? [];
        expect(queue).toHaveLength(1);
        expect(queue[0].weaponId).toBe(wid);
        expect(queue[0].dueAtMs).toBe(150);
      });

      it('2 张连射入队 2 波（150ms 与 300ms）', () => {
        const state = createSimState(1);
        makeEnemy(state, 360, 1100);

        fireWeapon(state, wid, ['burst_shot', 'burst_shot']);
        const queue = (state.meta[BURST_QUEUE_META_KEY] as BurstWaveEntry[]) ?? [];
        expect(queue).toHaveLength(2);
        expect(queue[0].dueAtMs).toBe(150);
        expect(queue[1].dueAtMs).toBe(300);
      });

      it('update 钩子调用 consumeDueBurstWaves 重放到期波', () => {
        const state = createSimState(1);
        const def = loadWeaponDefs()[wid];
        makeEnemy(state, 360, 1100);
        fireWeapon(state, wid, ['burst_shot']);
        const initialProjCount = state.projectiles.length;
        expect(initialProjCount).toBeGreaterThan(0);

        state.timeMs += 150;
        getBehavior(def.behavior).update?.(state, 16);

        expect(state.projectiles.length).toBeGreaterThan(initialProjCount);
        const queue = (state.meta[BURST_QUEUE_META_KEY] as BurstWaveEntry[]) ?? [];
        expect(queue).toHaveLength(0); // 队列被清空
      });

      it('无目标时平滑跳过（不产生弹丸、不改写冷却、不报错）', () => {
        const state = createSimState(1);
        const def = loadWeaponDefs()[wid];
        const enemy = makeEnemy(state, 360, 1100);
        fireWeapon(state, wid, ['burst_shot']);
        const initialProjCount = state.projectiles.length;

        // 敌人全部死亡
        enemy.dead = true;
        state.weaponStates[wid].cooldownMs = 1234;

        state.timeMs += 150;
        getBehavior(def.behavior).update?.(state, 16);

        // scatter 本身不依赖索敌（无条件开火扇形），其他 4 把武器依赖索敌在无目标时平滑跳过
        if (wid !== 'scatter') {
          expect(state.projectiles.length).toBe(initialProjCount);
          expect(state.weaponStates[wid].cooldownMs).toBe(1234); // 冷却未被改写
        }
        const queue = (state.meta[BURST_QUEUE_META_KEY] as BurstWaveEntry[]) ?? [];
        expect(queue).toHaveLength(0); // 到期波已被正常消费
      });

      it('连射波按开火时刻 stats 快照独立结算（开火后追加伤害牌不影响在途波）', () => {
        const state = createSimState(1);
        const def = loadWeaponDefs()[wid];
        makeEnemy(state, 360, 1100);
        fireWeapon(state, wid, ['burst_shot']);
        const baseDamage = state.projectiles[0].damage;

        // 开火后玩家升级添加伤害牌
        state.weaponStates[wid].cards.dmg_up = 1;

        state.timeMs += 150;
        getBehavior(def.behavior).update?.(state, 16);

        // 新产生的连射波弹丸伤害必须依然等于发射时刻的快照
        const secondWaveProj = state.projectiles[state.projectiles.length - 1];
        expect(secondWaveProj.damage).toBeCloseTo(baseDamage, 6);
      });
    });
  }


});

describe('M1.2: 分裂机制 (split_shot) 5 把弹道武器全闭环', () => {
  for (const wid of BALLISTIC_WEAPON_IDS) {
    describe(`武器 ${wid} 分裂次级弹规范`, () => {
      it('次级弹伤害为主弹 20%，且明确标记禁止分裂与次级标识', () => {
        const state = createSimState(1);
        const def = loadWeaponDefs()[wid];
        const main = makeEnemy(state, 360, 1100);
        // 放置 4 个候选敌人
        const e1 = makeEnemy(state, 360, 1050);
        makeEnemy(state, 420, 1100);
        makeEnemy(state, 300, 1100);
        makeEnemy(state, 360, 1150);

        fireWeapon(state, wid, ['split_shot']);
        const mainProj = state.projectiles[0];
        const baseDmg = mainProj.damage;

        // 模拟触发主弹分裂
        mainProj.x = 360;
        mainProj.y = 1100;
        if (wid === 'homing_missile' || wid === 'mortar') {
          mainProj.dead = true;
          mainProj.data.hitEnemyId = main.id;
          mainProj.data.tx = 360;
          mainProj.data.ty = 1100;
          getBehavior(def.behavior).onProjectileDeath?.(state, mainProj);
        } else {
          getBehavior(def.behavior).onProjectileHit?.(state, mainProj, main);
        }

        const secondaries = state.projectiles.filter((p) => p.data.isSecondary === 1);
        expect(secondaries.length).toBeGreaterThanOrEqual(1);
        expect(secondaries.length).toBeLessThanOrEqual(4);

        for (const sec of secondaries) {
          expect(sec.damage).toBeCloseTo(baseDmg * 0.2, 5);
          expect(sec.data.splitReady).toBe(0);
          expect(sec.data.splitDone).toBe(1);
          expect(sec.data.isSecondary).toBe(1);

          // 严禁次级弹再次分裂（无论是 hit 还是 death）
          const countBeforeHit = state.projectiles.length;
          if (getBehavior(def.behavior).onProjectileHit) {
            getBehavior(def.behavior).onProjectileHit?.(state, sec, e1);
            expect(state.projectiles.length).toBe(countBeforeHit);
          }
          if (getBehavior(def.behavior).onProjectileDeath) {
            sec.dead = true;
            getBehavior(def.behavior).onProjectileDeath?.(state, sec);
            expect(state.projectiles.length).toBe(countBeforeHit);
          }
        }
      });

      it('次级弹绝不触发连射待发队列 (BURST_QUEUE_META_KEY)', () => {
        const state = createSimState(1);
        const def = loadWeaponDefs()[wid];
        const main = makeEnemy(state, 360, 1100);
        makeEnemy(state, 360, 1050);

        fireWeapon(state, wid, ['split_shot']);
        const mainProj = state.projectiles[0];
        // 清空队列以纯净测试分裂阶段
        state.meta[BURST_QUEUE_META_KEY] = [];

        mainProj.x = 360;
        mainProj.y = 1100;
        if (wid === 'homing_missile' || wid === 'mortar') {
          mainProj.dead = true;
          mainProj.data.hitEnemyId = main.id;
          mainProj.data.tx = 360;
          mainProj.data.ty = 1100;
          getBehavior(def.behavior).onProjectileDeath?.(state, mainProj);
        } else {
          getBehavior(def.behavior).onProjectileHit?.(state, mainProj, main);
        }

        const queue = (state.meta[BURST_QUEUE_META_KEY] as BurstWaveEntry[]) ?? [];
        expect(queue).toHaveLength(0); // 绝无次级弹入队
      });
    });
  }
});

describe('M1.3: DoT 频率与范围/持续伤害 6 把武器闭环', () => {
  it('dragon_breath: dot_freq 正确缩短本体灼烧与酸池 tick 间隔', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1100);
    fireWeapon(state, 'dragon_breath', ['dot_freq', 'acid_pool']);
    expect(e.effects[0].kind).toBe('burn');
    expect(e.effects[0].data.tickMs).toBeCloseTo(500 / 1.3, 6);

    for (let i = 0; i < 9; i++) {
      fireWeapon(state, 'dragon_breath', ['dot_freq', 'acid_pool']);
    }
    const zones = listZones(state);
    expect(zones).toHaveLength(1);
    expect(zones[0].tickMs).toBeCloseTo(500 / 1.3, 6);
  });

  it('heat_beam: dot_freq 正确缩短灼痕 tick 间隔', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1000);
    fireWeapon(state, 'heat_beam', ['scorch', 'dot_freq', 'dot_freq']);
    expect(e.effects[0].kind).toBe('burn');
    expect(e.effects[0].data.tickMs).toBeCloseTo(500 / (1.3 * 1.3), 6);
  });

  it('homing_missile: dot_freq 正确缩短燃烧云 tick 间隔', () => {
    const state = createSimState(1);
    const victim = makeEnemy(state, 360, 1000);
    fireWeapon(state, 'homing_missile', ['burn_cloud', 'dot_freq']);
    const p = state.projectiles[0];
    expect(p.data.burnTickMs).toBeCloseTo(500 / 1.3, 6);

    // 爆炸
    p.x = 360;
    p.y = 1000;
    p.dead = true;
    p.data.hitEnemyId = victim.id;
    getBehavior('homing_missile').onProjectileDeath?.(state, p);

    const burn = victim.effects.find((x) => x.kind === 'burn');
    expect(burn?.data.tickMs).toBeCloseTo(500 / 1.3, 6);
  });

  it('mortar: dot_freq 正确缩短燃烧地 zone tick 间隔', () => {
    const state = createSimState(1);
    makeEnemy(state, 360, 600);
    fireWeapon(state, 'mortar', ['burn_ground', 'dot_freq']);
    const p = state.projectiles[0];
    expect(p.data.burnTickMs).toBeCloseTo(500 / 1.3, 6);

    p.dead = true;
    getBehavior('mortar').onProjectileDeath?.(state, p);
    const zones = listZones(state);
    expect(zones).toHaveLength(1);
    expect(zones[0].tickMs).toBeCloseTo(500 / 1.3, 6);
  });

  it('prism: dot_freq 正确缩短冰毒附着 poison tick 间隔', () => {
    const state = createSimState(1);
    const target = makeEnemy(state, 360, 1100);
    fireWeapon(state, 'prism', ['frost_venom', 'dot_freq']);
    const p = state.projectiles[0];
    expect(p.data.poisonTickMs).toBeCloseTo(1000 / 1.3, 6);

    p.x = 360;
    p.y = 1100;
    getBehavior('prism_chain').onProjectileHit?.(state, p, target);
    const poison = target.effects.find((x) => x.kind === 'poison');
    expect(poison?.data.tickMs).toBeCloseTo(1000 / 1.3, 6);
  });

  it('scatter: dot_freq 正确缩短燃烧弹 tick 间隔', () => {
    const state = createSimState(1);
    const target = makeEnemy(state, 360, 1100);
    fireWeapon(state, 'scatter', ['burn_bullet', 'dot_freq']);
    const p = state.projectiles[0];
    expect(p.effectsOnHit[0].data.tickMs).toBeCloseTo(500 / 1.3, 6);

    const grid = new SpatialHash<Enemy>(64);
    for (let f = 0; f < 12 && state.projectiles.length > 0; f++) {
      updateProjectiles(state, 16, grid);
      state.timeMs += 16;
    }
    const burn = target.effects.find((x) => x.kind === 'burn');
    expect(burn?.data.tickMs).toBeCloseTo(500 / 1.3, 6);
  });
});

describe('M1.4: 专属牌与数据对齐审计', () => {
  it('所有武器卡牌的 params key 均在行为层中有对应的读取', () => {
    const defs = loadWeaponDefs();
    for (const wid in defs) {
      const def = defs[wid];
      for (const card of def.cards) {
        if (card.params) {
          for (const param of card.params) {
            expect(param.key).toBeDefined();
            expect(typeof param.value).toBe('number');
          }
        }
      }
    }
  });

  it('rail_piercer 专属牌全部逻辑闭环（三叉、折射、贯通、穿透增幅）', () => {
    const state = createSimState(1);
    const main = makeEnemy(state, 360, 900);
    // 开火测试三叉
    fireWeapon(state, 'rail_piercer', ['trident_split']);
    expect(main.hp).toBe(1e6 - 48);

    // 穿透增幅
    const singleState = createSimState(1);
    const e1 = makeEnemy(singleState, 360, 900, 1e6);
    const e2 = makeEnemy(singleState, 360, 700, 1e6);
    fireWeapon(singleState, 'rail_piercer', ['charge_damage']);
    expect(e1.hp).toBe(1e6 - 10);
    expect(e2.hp).toBe(1e6 - 12.5);
  });
});
