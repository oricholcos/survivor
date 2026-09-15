// src/core/targeting.test.ts —— 瞄准数学 + 统一目标选择契约：
// interceptPoint 二次方程精确解（静止退化 / 匀速直线精确交点 / 迎面同速线性退化 / 两正根取
// 较小者 / 追不上 null / 脏弹速 null）、targetVelocity（march 向下含减速乘区 / attack 贴墙
// 静止 / 眩晕静止）、leadAim（预测点 / 无解退化当前位置）、findTarget 四级优先级
// （boss > attack 贴墙高威胁层 > fast > 最近）——重点复现并锁定用户反馈：场上有贴墙怪 +
// 更近的行军怪 → 必须选贴墙怪（旧实现会被任何快速行军怪饿死贴墙怪）。
import { describe, expect, it } from 'vitest';
import { loadEffectDefs } from '../data/effects';
import { createSimState } from './simState';
import { findTarget, interceptPoint, leadAim, targetVelocity } from './targeting';
import type { Enemy, SimState } from './types';

// 副作用：把 effects.json 真实效果表注册进 core/effects（slow/chill 的 speedFactor 乘区依赖）。
loadEffectDefs();

interface EnemyOpts {
  speed?: number;
  state?: 'march' | 'attack';
  isBoss?: boolean;
  dead?: boolean;
}

/** 构造一个敌人夹具（数值仅存在于测试夹具；state 控制行军/贴墙）。 */
function makeEnemy(state: SimState, x: number, y: number, opts: EnemyOpts = {}): Enemy {
  const e: Enemy = {
    id: state.nextId++,
    typeId: 'tester',
    name: '测试怪',
    x,
    y,
    radius: 10,
    hp: 100,
    maxHp: 100,
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
    dead: opts.dead ?? false,
  };
  state.enemies.push(e);
  return e;
}

describe('targetVelocity（目标当前速度）', () => {
  it('march 怪：竖直向下 (0, speed)，与 enemies.ts 行军位移同式', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 500, { speed: 90 });
    expect(targetVelocity(e)).toEqual({ x: 0, y: 90 });
  });

  it('march 怪挂 slow：位移乘 speedMultiplier（0.5）→ (0, 45)', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 500, { speed: 90 });
    e.effects.push({ kind: 'slow', untilMs: Number.MAX_SAFE_INTEGER, stacks: 1, data: {} });
    expect(targetVelocity(e)).toEqual({ x: 0, y: 45 });
  });

  it('march 怪挂 chill（speedFactor 0.75）→ (0, 67.5)', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 500, { speed: 90 });
    e.effects.push({ kind: 'chill', untilMs: Number.MAX_SAFE_INTEGER, stacks: 1, data: {} });
    expect(targetVelocity(e)).toEqual({ x: 0, y: 67.5 });
  });

  it('attack 怪（贴墙攻击城墙）：y 钉在墙线不再移动 → (0, 0)', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 360, 1160, { speed: 90, state: 'attack' });
    expect(targetVelocity(e)).toEqual({ x: 0, y: 0 });
  });

  it('眩晕（任意状态）停位移 → (0, 0)；march 零速怪也 → (0, 0)', () => {
    const state = createSimState(1);
    const stunned = makeEnemy(state, 360, 500, { speed: 90 });
    stunned.effects.push({ kind: 'stun', untilMs: Number.MAX_SAFE_INTEGER, stacks: 1, data: {} });
    expect(targetVelocity(stunned)).toEqual({ x: 0, y: 0 });

    const still = makeEnemy(state, 360, 500, { speed: 0 });
    expect(targetVelocity(still)).toEqual({ x: 0, y: 0 });
  });
});

describe('interceptPoint（提前量二次方程）', () => {
  it('静止目标退化：t = |Δ|/s，返回目标当前位置', () => {
    // |(300,400)| = 500 = 100×5 → t=5，预测点 = 当前位置。
    expect(interceptPoint({ x: 0, y: 0 }, { x: 300, y: 400 }, { x: 0, y: 0 }, 100)).toEqual({
      x: 300,
      y: 400,
    });
  });

  it('匀速直线目标精确交点：取正根中较小者（另一根为负被拒绝）', () => {
    // 目标 (300,600) 以 (0,-100) 接近原点，弹速 250：
    // (v·v−s²)t² + 2(Δ·v)t + |Δ|² = −52500t² − 120000t + 450000 = 0 → 根 {2, −30/7}，取 t=2。
    // 预测点 = (300, 600) + (0,−100)×2 = (300, 400)，验证 |(300,400)| = 500 = 250×2 ✓。
    expect(interceptPoint({ x: 0, y: 0 }, { x: 300, y: 600 }, { x: 0, y: -100 }, 250)).toEqual({
      x: 300,
      y: 400,
    });
  });

  it('迎面同速（弹速 = 目标速率）退化为一次方程：仍有唯一正根', () => {
    // 目标 (0,400) 以 (0,-100) 迎面接近，弹速 100：a=0 → b·t+c=0 → t=2 → (0,200)。
    expect(interceptPoint({ x: 0, y: 0 }, { x: 0, y: 400 }, { x: 0, y: -100 }, 100)).toEqual({
      x: 0,
      y: 200,
    });
  });

  it('两正根取较小者（目标快于弹但正在接近：先进入射程再离开）', () => {
    // 目标 (0,300) 以 (0,-150) 接近，弹速 100：a=12500 > 0，根 {6, 1.2} → 取 t=1.2 → (0,120)。
    expect(interceptPoint({ x: 0, y: 0 }, { x: 0, y: 300 }, { x: 0, y: -150 }, 100)).toEqual({
      x: 0,
      y: 120,
    });
  });

  it('目标逃离且比弹快 → 两根皆负 → null；横向掠过且更快 → 无实根 → null', () => {
    // 正远离：(0,-100) 处以 (0,-200) 逃离，弹速 100 → 根 {−1/3, −1} → null。
    expect(interceptPoint({ x: 0, y: 0 }, { x: 0, y: -100 }, { x: 0, y: -200 }, 100)).toBeNull();
    // 无实根：(100,0) 处横向 (0,50) 掠过，弹速 40 → disc < 0 → null。
    expect(interceptPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 50 }, 40)).toBeNull();
  });

  it('脏弹速 s <= 0 → null（调用方退化为直接瞄准）', () => {
    expect(interceptPoint({ x: 0, y: 0 }, { x: 300, y: 400 }, { x: 0, y: 0 }, 0)).toBeNull();
    expect(interceptPoint({ x: 0, y: 0 }, { x: 300, y: 400 }, { x: 0, y: 0 }, -5)).toBeNull();
  });
});

describe('leadAim（主目标瞄准点）', () => {
  it('march 怪：返回预测命中点（提前量）', () => {
    // 怪 (300,-600) 以 100px/s 向下行军，弹速 250 → 预测点 (300,-400)（t=2，3-4-5 验证）。
    const state = createSimState(1);
    const e = makeEnemy(state, 300, -600, { speed: 100 });
    expect(leadAim({ x: 0, y: 0 }, e, 250)).toEqual({ x: 300, y: -400 });
  });

  it('attack 怪（速度 0）：退化为当前位置（直接瞄准）', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 300, 400, { speed: 999, state: 'attack' });
    expect(leadAim({ x: 0, y: 0 }, e, 250)).toEqual({ x: 300, y: 400 });
  });

  it('无解（追不上）：退化为当前位置，保证「一定瞄准主目标」不劣化', () => {
    const state = createSimState(1);
    const e = makeEnemy(state, 0, 100, { speed: 200 }); // 在原点下方行军远离，快于弹速 100
    expect(leadAim({ x: 0, y: 0 }, e, 100)).toEqual({ x: 0, y: 100 });
  });

  it('maxY（墙线域钳制）：预测点越过行军可达域 → 钳到 (x, maxY)，覆盖「到墙即停」语义', () => {
    // 怪 (0,110) 以 100px/s 向下行军、弹速 300 → t=0.55、预测点 (0,165)；
    // 传 maxY=120（墙线）：怪必然在 y=120 处停靠 → 瞄准点钳到 (0,120)。
    const state = createSimState(1);
    const e = makeEnemy(state, 0, 110, { speed: 100 });
    expect(leadAim({ x: 0, y: 0 }, e, 300, 120)).toEqual({ x: 0, y: 120 });
    // 预测点在域内时钳制不生效。
    const mid = makeEnemy(state, 0, 0, { speed: 100 });
    expect(leadAim({ x: 0, y: -100 }, mid, 300, 120)).toEqual({ x: 0, y: 50 }); // 100+100t=300t → t=0.5 → y=50
  });
});

describe('findTarget 四级优先级（boss > attack 贴墙 > fast > 最近）', () => {
  it('用户反馈复现：场上有贴墙怪（attack）+ 更近的行军怪 → 选贴墙怪', () => {
    // 贴墙 tank 在墙线上打墙（距角色 345px），行军怪已逼近到 70px：
    // 旧行为（纯最近/或 fast 优先）都会放过贴墙怪；修复后 attack 高威胁层必被覆盖。
    const state = createSimState(1); // 角色 (360, 1220)，墙线 y=1160
    const tank = makeEnemy(state, 700, 1160, { speed: 20, state: 'attack' });
    makeEnemy(state, 365, 1150, { speed: 90 }); // 行军怪 dist ≈ 70 < tank 345
    expect(findTarget(state)).toBe(tank);
  });

  it('attack 层压过快速怪（preferFast 开启也在其后）：贴墙 tank + 行军 runner → tank', () => {
    const state = createSimState(1);
    const tank = makeEnemy(state, 700, 1160, { speed: 20, state: 'attack' });
    makeEnemy(state, 360, 1020, { speed: 120 }); // 快速行军怪 dist 200 < tank 345
    expect(findTarget(state, { preferFast: true, fastSpeedThreshold: 80 })).toBe(tank);
  });

  it('boss 层最高：行军 boss 与贴墙怪并存 → boss（多个 boss 取最近）', () => {
    const state = createSimState(1);
    makeEnemy(state, 100, 1000, { isBoss: true, speed: 40 }); // 近 boss dist 360
    makeEnemy(state, 1000, 1000, { isBoss: true, speed: 40 }); // 远 boss
    const tank = makeEnemy(state, 360, 1160, { state: 'attack' }); // 贴墙怪 dist 60
    expect(findTarget(state, { preferBoss: true })).not.toBe(tank);
    expect(findTarget(state, { preferBoss: true })!.isBoss).toBe(true);
    expect(findTarget(state, { preferBoss: true })!.x).toBe(100); // 最近 boss
  });

  it('完整层级级联：boss → attack → fast → 最近 march，逐层移除后依次让位', () => {
    const state = createSimState(1);
    const boss = makeEnemy(state, 100, 1000, { isBoss: true, speed: 40 });
    const tank = makeEnemy(state, 700, 1160, { speed: 20, state: 'attack' });
    const runner = makeEnemy(state, 360, 1020, { speed: 120 }); // fast，dist 200
    const standard = makeEnemy(state, 360, 1180, { speed: 45 }); // 最近 march，dist 40
    const opts = { preferBoss: true, preferFast: true, fastSpeedThreshold: 80 } as const;

    expect(findTarget(state, opts)).toBe(boss);
    boss.dead = true;
    expect(findTarget(state, opts)).toBe(tank); // 贴墙怪压过快速怪
    tank.dead = true;
    expect(findTarget(state, opts)).toBe(runner); // 无 boss/贴墙怪才轮到快速怪
    runner.dead = true;
    expect(findTarget(state, opts)).toBe(standard); // 兜底最近
  });

  it('无偏好（弹道武器默认）：无贴墙怪时取最近 march 怪；贴墙怪存在时优先贴墙怪', () => {
    const near = createSimState(1);
    const standard = makeEnemy(near, 360, 1180, { speed: 45 });
    makeEnemy(near, 360, 1020, { speed: 120 });
    expect(findTarget(near)).toBe(standard); // 纯 march 场：等价旧「最近」实现

    const withTank = createSimState(1);
    const tank = makeEnemy(withTank, 700, 1160, { speed: 20, state: 'attack' });
    makeEnemy(withTank, 360, 1180, { speed: 45 });
    expect(findTarget(withTank)).toBe(tank); // attack 层无偏好也生效
  });

  it('死亡敌人全部跳过 → null；同层平距取数组先出现者（严格 < 比较）', () => {
    const empty = createSimState(1);
    makeEnemy(empty, 360, 1180, { dead: true });
    expect(findTarget(empty)).toBeNull();

    const tie = createSimState(1);
    const first = makeEnemy(tie, 260, 1220, { speed: 45 }); // dist 100
    makeEnemy(tie, 460, 1220, { speed: 45 }); // dist 100（并列，后入数组）
    expect(findTarget(tie)).toBe(first);
  });
});
