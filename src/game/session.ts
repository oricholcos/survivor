// src/game/session.ts —— 一局（GameSession）的组装根（合成层）：
// 本目录是合成根，允许同时 import core + data（视图 src/phaser 经由本模块拿到 SimState）。
//
// 职责：
// - 模块级一次性接线：setRngFactory(createRng)（随机契约）、killHooks 注册 onEnemyKilled
//   （击杀掉宝石/修复包）与 onBossDefeated（Boss 击杀：墙回复 + 额外一次三选一）。
//   全局表只注册一次（模块级标志防 restart 重复 push）。
// - 组装一局 SimState：按固定顺序注册 hooks：
//   ① 波次刷怪（waves.json 时间轴：通关线性 / 无尽循环时钟）+ 敌人行军/墙前分离
//   ② 效果 tick（DoT/黑洞/到期清理）③ 地面区域 tick（区域内敌人周期伤害 + 效果附着）
//   ④ 城墙受击 ④.5 胜利判定（campaign 撑满时长 → victory；endless 永不胜利）
//   ⑤ 武器闭包 ⑥ 弹丸闭包 ⑦ 宝石/掉落。
// - 双模式（T3.5）：createSession(seed?, mode) 决定本局模式（mode 只读，restart 保持不变）；
//   无尽模式的波次时钟走 resolveWaveClock（表尾循环回绕 + 逐轮膨胀），通关模式恒线性。
// - restart：新建 state 并重建 hooks（defs / 敌人类型表 / SpatialHash 实例复用）；
//   hooks 重建时重新捕获当前 session.mode（胜利判定与循环时钟按当前局模式接线）。
//
// 弹丸与敌人共用同一个 SpatialHash 实例是安全的：updateEnemies 与 updateProjectiles
// 都在各自开头 grid.clear() + 重插全部存活敌人，互不残留跨帧引用。

import { setRngFactory, createSimState } from '../core/simState';
import { createRng } from '../core/rng';
import { step as coreStep } from '../core/step';
import { drainEvents, type GameEvent } from '../core/events';
import { updateEnemies, type EnemyTypeData } from '../core/enemies';
import { updateEffects } from '../core/effects';
import { updateWallCombat } from '../core/wall';
import { updateWaves } from '../core/waves';
import { resolveWaveClock } from '../core/waveClock';
import { checkVictory, type GameMode } from '../core/victory';
import { onBossDefeated, readBossHealPct } from '../core/bossRewards';
import { addWeapon, updateWeapons, type WeaponDef } from '../core/weapons';
import { killHooks, updateProjectiles } from '../core/projectiles';
import { onEnemyKilled, updateGems } from '../core/gems';
import { SpatialHash } from '../core/spatialHash';
import { updateZones } from '../core/zones';
import type { Enemy, SimState } from '../core/types';
import { loadSimConfig } from '../data/config';
import { loadEffectDefs } from '../data/effects';
import { loadEnemyTypes } from '../data/enemies';
import { loadWeaponDefs } from '../data/weapons';
import { loadWavesConfig } from '../data/waves';

/** 一局的组装根：视图层只看得到这个接口（state 每帧读取，restart 后自动指向新 state）。 */
export interface GameSession {
  state: SimState;
  /**
   * 本局模式：创建时确定；restart 保持当前模式（切换模式请回菜单另开一局）。
   * campaign = 限时通关（撑满 waves.campaignDurationSec 获胜）；endless = 无尽（扛到死）。
   */
  readonly mode: GameMode;
  /** 推进一帧模拟；paused 为 true 时不推进（升级面板用）。 */
  step(rawDtMs: number): void;
  /** 取走本帧全部游戏事件（转发 core drainEvents，顺序保持入队顺序）。 */
  drain(): GameEvent[];
  /** true 时 step 不推进模拟（升级三选一面板期间冻结）。 */
  paused: boolean;
  /**
   * 轻量事件出口（T4.1 起为监听器列表的兼容转发口，@deprecated）：
   * 读取时返回内部监听器列表的分发函数（列表为空 → null）。mainScene 每帧 drain 后
   * 把事件逐个转发至此；restart 不清空列表。新代码请用 addEventListener 注册。
   */
  readonly onEvent: ((ev: GameEvent) => void) | null;
  /**
   * 注册一个事件监听器（T4.1 事件总线小改）：监听器进入列表、按注册顺序逐个回调；
   * 返回退订函数。restart 不清空列表；「返回菜单」销毁当前局时由注册方调用退订
   * （不退订也无泄漏：旧 session 整体废弃时列表随之回收，但显式退订语义更清晰）。
   */
  addEventListener(fn: (ev: GameEvent) => void): () => void;
  /** 重建一局：新建 state、重建 hooks（保持当前 mode）；传同一种子可完整复现同一局。 */
  restart(seed?: number): void;
}

/** 默认种子：仅合成层允许用 Date.now（core 层禁用；Math.random 全项目 ESLint 禁用）。 */
function defaultSeed(): number {
  return Date.now() % 2 ** 31;
}

// —— 模块级一次性资源：数据表只加载一次（内容共享只读），空间网格跨 restart 复用 ——

const WEAPON_DEFS: Record<string, WeaponDef> = loadWeaponDefs();
const ENEMY_TYPES: Record<string, EnemyTypeData> = loadEnemyTypes();
// 波次配置（waves.json）：时间轴 / 通关时长 / 无尽循环 / 血量膨胀，解释器按帧消费。
const WAVES = loadWavesConfig();
// 效果定义表：加载即注册进 core/effects 的模块级注册表（applyEffect / updateEffects 按 kind 查询）。
loadEffectDefs();
const ENEMY_GRID = new SpatialHash<Enemy>(64);

/** 开局排除的近程武器（射程过近，不适合作为首把武器）。 */
export const EXCLUDED_INITIAL_WEAPONS = [
  'scatter',
  'heat_beam',
  'seismic_wall',
] as const;

/** 开局候选初始武器池（5 把远程武器，按字典序固定）。 */
export const INITIAL_WEAPON_CANDIDATES = [
  'charge_sniper',
  'homing_missile',
  'mortar',
  'prism',
  'rail_piercer',
] as const;

/** 模块级一次性引导标志：setRngFactory 与 killHooks 全局表只能各做一次。 */
let bootstrapped = false;

function ensureBootstrap(): void {
  if (bootstrapped) {
    return;
  }
  bootstrapped = true;
  // 随机契约：引导层把 RNG 工厂换成 core 的 mulberry32（同种子 → 同序列）。
  setRngFactory(createRng);
  // 击杀掉落接线：敌人死亡 → 掉 1 颗经验宝石（概率掉修复包）。只 push 一次。
  killHooks.push((state, enemy) => onEnemyKilled(state, enemy));
  // Boss 击杀奖励接线（T3.1）：死亡结算 → 墙回复（enemies.json 的 bossHealPct）+ 额外一次三选一
  // （onBossDefeated 仅对 isBoss 生效且幂等）。防御：typeId 不在类型表时按 healPct=0 处理。
  killHooks.push((state, enemy) => {
    const type = ENEMY_TYPES[enemy.typeId];
    onBossDefeated(state, enemy, { healPct: type !== undefined ? readBossHealPct(type) : 0 });
  });
}

/**
 * 组装一局 SimState：注册 hooks（依序）+ 开局武器。
 * mode 随局捕获进各闭包（波次时钟 / 胜利判定）；restart 重建 hooks 时按当前局模式重建。
 */
function buildState(seed: number, mode: GameMode): SimState {
  const state = createSimState(seed, loadSimConfig());
  // 模式随局写入 meta（视图/结算层可从 state 读取；权威来源是 session.mode）。
  state.meta.mode = mode;

  // ① 波次刷怪（waves.json 时间轴解释器）→ 敌人行军 + 墙前分离（内部 clear+重建 ENEMY_GRID）。
  //    时钟：通关模式恒线性；无尽模式用循环时钟（表尾 campaignDurationSec 后从 loopFromSec
  //    回绕、每轮 × scalingPerLoop 膨胀，爆发波跨轮可重触发）。
  //    updateWaves 刷出的敌人随后由 updateEnemies 一并推进并重建网格；over 非 null 时两者
  //    各自内部防重入直接返回。
  state.hooks.push((s, dt) => {
    const clock = resolveWaveClock(
      s.timeMs / 1000,
      mode === 'endless' ? (WAVES.endlessLoop ?? null) : null,
      WAVES.campaignDurationSec,
    );
    updateWaves(s, dt, WAVES, ENEMY_TYPES, clock);
    updateEnemies(s, dt, ENEMY_GRID);
  });

  // ② 效果 tick：DoT 周期结算 / 黑洞拉扯 / 到期清理 / 武器 overheat 到期
  //    （排敌人之后、墙战之前：本帧行军吃到最新减速，眩晕敌人在墙战前被冻结）。
  state.hooks.push(updateEffects);

  // ③ 地面区域 tick：区域内敌人周期伤害 + 效果附着（毒圈/火圈等，参数由武器行为经
  //    zones.spawnZone 从武器 JSON 传入）。与敌人共用 ENEMY_GRID：此刻网格由 ① 的
  //    updateEnemies 重建，② 里被 DoT 击杀的残留死敌由 updateZones 内部 dead 过滤。
  state.hooks.push((s, dt) => {
    updateZones(s, dt, ENEMY_GRID);
  });

  // ④ 城墙受击结算与失败判定（墙破 → over='defeat'，step 停摆）。
  state.hooks.push(updateWallCombat);

  // ④.5 胜利判定（T3.3，注册在墙战之后：失败与胜利先到先得——over 已非 null 时
  //     checkVictory 直接返回，victory 不覆盖 defeat）。campaign 撑满时长 → over='victory'
  //     + victory 事件；endless 永不胜利（扛到死）。
  state.hooks.push((s) => {
    checkVictory(s, WAVES.campaignDurationSec * 1000, mode);
  });

  // ⑤ 武器闭包：冷却节奏 + 行为分发 + 行为每帧 update 钩子（defs 数据表只加载一次）。
  state.hooks.push((s, dt) => {
    updateWeapons(s, dt, WEAPON_DEFS);
  });

  // ⑥ 弹丸闭包：推进 + 命中 + 击杀 + 行为命中/死亡钩子（与敌人共用 ENEMY_GRID：
  //    各自先 clear 后重插，时序不冲突）。
  state.hooks.push((s, dt) => {
    updateProjectiles(s, dt, ENEMY_GRID);
  });

  // ⑦ 宝石/掉落：宝石飞向角色加经验（帧末升级检查）、修复包飞向墙中点修墙。
  state.hooks.push((s, dt) => {
    updateGems(s, dt);
  });

  // 开局初始武器：从候选远程武器池中确定性抽取 1 把（同种子同序列）。
  const initialWeaponId = state.rng.pick(INITIAL_WEAPON_CANDIDATES);
  addWeapon(state, initialWeaponId);

  return state;
}

/**
 * 创建一局组装完毕、随时可 step 的 GameSession。
 * @param seed 随机种子（缺省 Date.now 派生；传同一种子可完整复现同一局）
 * @param mode 本局模式（缺省 'campaign'；决定胜利判定与无尽循环时钟，restart 保持不变）
 */
export function createSession(seed?: number, mode: GameMode = 'campaign'): GameSession {
  ensureBootstrap();

  let currentSeed = seed ?? defaultSeed();
  let state = buildState(currentSeed, mode);
  let paused = false;

  // 事件监听器列表（T4.1）：restart 不清空；旧单回调 onEvent 读取时转发到此列表。
  const eventListeners: Array<(ev: GameEvent) => void> = [];
  const dispatchEvent = (ev: GameEvent): void => {
    for (let i = 0; i < eventListeners.length; i++) {
      eventListeners[i](ev);
    }
  };

  const session: GameSession = {
    get state(): SimState {
      return state;
    },

    // 只读字段：本局模式在创建时确定（restart 闭包捕获同一 mode，不随重开改变）。
    mode,

    step(rawDtMs: number): void {
      if (!paused) {
        coreStep(state, rawDtMs); // dt 钳制与 over 停摆由 core step 负责
      }
    },

    drain(): GameEvent[] {
      return drainEvents(state);
    },

    get paused(): boolean {
      return paused;
    },

    set paused(value: boolean) {
      paused = value;
    },

    get onEvent(): ((ev: GameEvent) => void) | null {
      // @deprecated 兼容出口：mainScene 每帧 drain 后逐事件调用；内部转发到监听器列表。
      return eventListeners.length > 0 ? dispatchEvent : null;
    },

    addEventListener(fn: (ev: GameEvent) => void): () => void {
      eventListeners.push(fn);
      return () => {
        const idx = eventListeners.indexOf(fn);
        if (idx >= 0) {
          eventListeners.splice(idx, 1);
        }
      };
    },

    restart(nextSeed?: number): void {
      // 不传种子 → 取新种子开新局（重开按钮语义）；传同一种子 → 完整复现同一局。
      // mode 保持当前模式（同模式重开）；hooks 重建时按该 mode 重新接线时钟与胜利判定。
      currentSeed = nextSeed ?? defaultSeed();
      state = buildState(currentSeed, mode); // 重建 hooks；defs / 类型表 / ENEMY_GRID 复用
      paused = false;
    },
  };

  return session;
}
