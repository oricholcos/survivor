// src/phaser/fx.ts —— 霓虹几何视觉的特效辅助层（T4.3）。
// 职责：
// - 霓虹配色表：弹丸 behavior → 发光形态/颜色映射（视图层允许硬编码的设计常量）；
// - 池化粒子系统：死亡爆裂几何碎片（环形缓冲，容量上限 200）、枪口闪光（上限 24）、
//   Boss 击杀冲击波环（上限 8）——全部预分配对象 + 游标覆写，任何时刻不超上限；
// - 静态背景：微光星点 + 暗网格 + 墙上结界光带（create 时一次性绘制，不逐帧重算）；
// - ?fx=0 降级开关解析（URL 解析按任务约定放在 phaser 视图层）。
// 约束：全项目 ESLint 禁用 Math.random——本层用固定种子的 mulberry32 取「伪随机」
// （粒子方向/星点位置均为纯视觉，不影响模拟可复现性：core 事件照常、视图自身确定性衰减）。
// 本文件只被 src/phaser 引用；允许 import phaser 与 DOM。
import Phaser from 'phaser';

// —— 霓虹配色表 ——

/**
 * 弹丸发光双层配色：outer = 外圈大半透明泛光色（ADD 叠加），core = 内芯亮色。
 * 设计基调（survivor-design.md）：深色底 + 高饱和发光弹丸，弹种间色相拉满区分。
 */
export interface ProjectileStyle {
  /** 外圈泛光色（低 alpha 大半径）。 */
  outer: number;
  /** 内芯亮色（高 alpha 小半径）。 */
  core: number;
  /** 芯中最亮的白热点色。 */
  hot: number;
}

/** 弹丸 behavior → 配色（缺省行为回落暖白小亮点）。 */
export const PROJECTILE_STYLES: Record<string, ProjectileStyle> = {
  piercing_bolt: { outer: 0x18c9ff, core: 0x7deaff, hot: 0xdcffff }, // 轨道贯穿炮：青色射线（hitscan 光束，渲染走 meta VFX，不再有飞行弹）
  scatter_shot: { outer: 0xff8f1f, core: 0xffc94d, hot: 0xfff3c4 }, // 扇面霰弹：橙黄小点
  homing_missile: { outer: 0xff2fb0, core: 0xff7ad9, hot: 0xffd9f4 }, // 追猎导弹：品红带尾焰
  prism_chain: { outer: 0x8a3cff, core: 0xc084ff, hot: 0xecd9ff }, // 弹射棱镜：紫电小菱形
  mortar: { outer: 0x2fe05e, core: 0x7dffa0, hot: 0xe2ffe2 }, // 迫击榴弹：绿色圆点+弧线提示
  charge_sniper: { outer: 0xdfe9ff, core: 0xffffff, hot: 0xffffff }, // 蓄能狙击：亮白长针
};

/** 兜底配色（未知 behavior）：暖白小亮点（原灰盒弹丸观感）。 */
export const FALLBACK_PROJECTILE_STYLE: ProjectileStyle = {
  outer: 0xfff176,
  core: 0xfff9c4,
  hot: 0xffffff,
};

export function projectileStyle(behavior: string): ProjectileStyle {
  return PROJECTILE_STYLES[behavior] ?? FALLBACK_PROJECTILE_STYLE;
}

/** 地面区域 effectKind → 颜色（燃烧地=橙、酸池=绿；缺省用 zone.color / 冰蓝兜底）。 */
export function zoneColor(effectKind: string | undefined, fallback: number | undefined): number {
  if (effectKind === 'burn') {
    return 0xff7a1a;
  }
  if (effectKind === 'corrode') {
    return 0x66ff33;
  }
  return fallback ?? 0x49c9ff;
}

/** meta 键前缀/键（与 core/behaviors 约定一致，视图只读）。 */
export const HEAT_BEAM_VFX_PREFIX = 'heat_beam_vfx:';
export const DRAGON_BREATH_VFX_PREFIX = 'dragon_breath_vfx:';
/** 轨道贯穿炮 hitscan 射线（T5.2b）：按 weaponId 分键，值为 { segments, untilMs }。 */
export const RAIL_VFX_PREFIX = 'rail_vfx:';
/** 迫击榴弹落地爆炸（T5.2b）：共享单键，值为 MortarBlastVfx[] 滚动数组。 */
export const MORTAR_BLAST_VFX_KEY = 'mortar_blast_vfx';
/** 弹射棱镜连锁闪电（T5.3c）：共享单键，值为 PrismZapSegment[] 滚动数组。 */
export const PRISM_ZAP_VFX_KEY = 'prism_zap_vfx';

/** 连锁闪电霓虹色彩配置（外圈粗线 / 内芯亮线 / 中心白热）。 */
export const PRISM_ZAP_COLORS = {
  outer: 0x8a3cff,
  core: 0xd8b4fe,
  hot: 0xffffff,
};

/** 血条/经验条底槽色（T6a 自 mainScene 迁入：敌人池化血条的槽 tint 与墙/经验条共用）。 */
export const COLOR_TRACK = 0x1a1f2e;

/** 状态异常霓虹视觉配色表（纯几何零素材反馈）：冰冻蓝、毒素绿、灼烧橙红、眩晕金黄等。 */
export const STATUS_EFFECT_COLORS = {
  // 减速 / 冰附着：冰蓝微弱冷光
  chillOuter: 0x38bdf8,
  chillCore: 0x7deaff,
  // 毒素 / 冰毒：霓虹毒绿
  poisonOuter: 0x22c55e,
  poisonCore: 0x4ade80,
  // 灼烧：高频脉动烈焰橙红
  burnOuter: 0xff7a1a,
  burnCore: 0xff5722,
  // 眩晕：金黄光环与暖白星辉
  stunRing: 0xfacc15,
  stunStar: 0xffffff,
};

export const COLOR_STATUS_CHILL_OUTER = 0x38bdf8;
export const COLOR_STATUS_CHILL_CORE = 0x7deaff;
export const COLOR_STATUS_POISON_OUTER = 0x22c55e;
export const COLOR_STATUS_POISON_CORE = 0x4ade80;
export const COLOR_STATUS_BURN_OUTER = 0xff7a1a;
export const COLOR_STATUS_BURN_CORE = 0xff5722;
export const COLOR_STATUS_STUN_RING = 0xfacc15;
export const COLOR_STATUS_STUN_STAR = 0xffffff;

// —— 降级开关：?fx=0 关闭相机 postFX（默认开） ——

/** 解析 URL ?fx 参数：缺省/其他值 → 开；'0'/'false'/'off'（大小写不敏感）→ 关。 */
export function fxEnabledFromUrl(search: string = window.location.search): boolean {
  const raw = new URLSearchParams(search).get('fx');
  if (raw === null) {
    return true;
  }
  const v = raw.toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

// —— 固定种子 PRNG（视图层专用；替代被禁用的 Math.random） ——

/** mulberry32：返回 [0,1) 均匀浮点的确定性 PRNG 工厂。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 二次贝塞尔分量（迫击榴弹的视觉下坠弧线用；T6b 自 mainScene 迁入共享）。 */
export function bezier(p0: number, pc: number, p1: number, t: number): number {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * pc + t * t * p1;
}

/** 颜色向暗底色收缩：factor=0 → 纯暗底，1 → 原色（霓虹「暗填充+亮描边」用）。 */
export function darken(color: number, factor: number): number {
  const baseR = 7;
  const baseG = 7;
  const baseB = 15;
  const r = Math.round(baseR + (((color >> 16) & 0xff) - baseR) * factor);
  const g = Math.round(baseG + (((color >> 8) & 0xff) - baseG) * factor);
  const b = Math.round(baseB + ((color & 0xff) - baseB) * factor);
  return (r << 16) | (g << 8) | b;
}

// —— 静态背景：星点 + 网格 + 墙上结界光带 ——

/**
 * 一次性绘制到专用 Graphics（create 时调用，之后不再重绘）：
 * 暗色细网格（增强纵深）+ 微光星点（少量亮星带十字光）+ 墙线上方的结界微光带。
 */
export function drawStaticBackground(
  g: Phaser.GameObjects.Graphics,
  width: number,
  height: number,
  wallLineY: number,
): void {
  g.clear();

  // 网格：72px 间距，极低 alpha 的蓝紫色细线。
  g.lineStyle(1, 0x2a3a6a, 0.1);
  for (let x = 0; x <= width; x += 72) {
    g.beginPath();
    g.moveTo(x + 0.5, 0);
    g.lineTo(x + 0.5, height);
    g.strokePath();
  }
  for (let y = 0; y <= height; y += 72) {
    g.beginPath();
    g.moveTo(0, y + 0.5);
    g.lineTo(width, y + 0.5);
    g.strokePath();
  }

  // 星点：约 110 颗，多数为暗淡小点，少量亮星加十字光芒。
  const rnd = mulberry32(0x51ae_f00d);
  const tints = [0x9fd8ff, 0xd9c9ff, 0xffe9b0, 0xffffff];
  for (let i = 0; i < 110; i++) {
    const x = rnd() * width;
    const y = rnd() * (wallLineY - 10); // 星点不压到墙体与底部署业区
    const r = 0.5 + rnd() * 1.3;
    const alpha = 0.06 + rnd() * 0.26;
    g.fillStyle(tints[Math.floor(rnd() * tints.length)] ?? 0xffffff, alpha);
    g.fillCircle(x, y, r);
    if (rnd() < 0.12) {
      // 亮星十字光（静态、一次绘制）。
      g.lineStyle(1, 0xbfe9ff, alpha * 0.55);
      g.beginPath();
      g.moveTo(x - r * 4, y);
      g.lineTo(x + r * 4, y);
      g.moveTo(x, y - r * 4);
      g.lineTo(x, y + r * 4);
      g.strokePath();
    }
  }

  // 墙上结界光带：墙线上方向上逐条衰减的青色微光（防御纵深暗示）。
  for (let i = 0; i < 6; i++) {
    g.fillStyle(0x1de5ff, 0.045 - i * 0.007);
    g.fillRect(0, wallLineY - (i + 1) * 9, width, 9);
  }
}

// —— 池化粒子：死亡爆裂几何碎片 ——

type ShardShape = 'triangle' | 'square' | 'hexagon' | 'dot';

export interface Fragment {
  alive: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  rotSpeed: number;
  /** 剩余寿命 ms（随渲染帧衰减；paused 时冻结）。 */
  lifeMs: number;
  maxLifeMs: number;
  size: number;
  color: number;
  shape: ShardShape;
}

/**
 * 死亡爆裂碎片池：环形缓冲覆写最旧条目，容量硬上限 FRAGMENT_CAP（200）。
 * spawn 由 enemyKilled 事件触发（普通怪 7 片 / Boss 16 片），draw 在 ADD 混合的
 * glow Graphics 上绘制旋转淡出的小几何片。
 */
export class DeathBurst {
  static readonly FRAGMENT_CAP = 200;
  private readonly frags: Fragment[];
  private cursor = 0;
  private readonly rng = mulberry32(0x5eef_00d1);

  constructor(capacity: number = DeathBurst.FRAGMENT_CAP) {
    this.frags = Array.from({ length: capacity }, () => ({
      alive: false,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      rot: 0,
      rotSpeed: 0,
      lifeMs: 0,
      maxLifeMs: 1,
      size: 3,
      color: 0xffffff,
      shape: 'dot' as ShardShape,
    }));
  }

  /** 在 (x,y) 爆出一圈碎片：color 取被杀敌人的图鉴色，shardShape 取其图鉴形状。 */
  spawn(
    x: number,
    y: number,
    color: number,
    shardShape: string,
    count: number,
    speedScale: number,
  ): void {
    const shape: ShardShape =
      shardShape === 'triangle' || shardShape === 'square' || shardShape === 'hexagon'
        ? shardShape
        : 'dot';
    for (let i = 0; i < count; i++) {
      const f = this.frags[this.cursor];
      this.cursor = (this.cursor + 1) % this.frags.length; // 环形覆写最旧碎片：上限恒定
      const ang = this.rng() * Math.PI * 2;
      const speed = (60 + this.rng() * 180) * speedScale;
      f.alive = true;
      f.x = x;
      f.y = y;
      f.vx = Math.cos(ang) * speed;
      f.vy = Math.sin(ang) * speed - 40 * speedScale; // 稍向上抛洒，随后被阻力+上抛衰减
      f.rot = this.rng() * Math.PI * 2;
      f.rotSpeed = (this.rng() - 0.5) * 12;
      f.maxLifeMs = 380 + this.rng() * 320;
      f.lifeMs = f.maxLifeMs;
      f.size = 2.5 + this.rng() * 3.5;
      f.color = color;
      f.shape = shape;
    }
  }

  /** 推进全部碎片（dtMs 为渲染帧间隔；paused 传 0 冻结）。阻力按帧长指数衰减。 */
  update(dtMs: number): void {
    if (dtMs <= 0) {
      return;
    }
    const drag = Math.exp(-dtMs / 260);
    for (let i = 0; i < this.frags.length; i++) {
      const f = this.frags[i];
      if (!f.alive) {
        continue;
      }
      f.lifeMs -= dtMs;
      if (f.lifeMs <= 0) {
        f.alive = false;
        continue;
      }
      f.x += (f.vx * dtMs) / 1000;
      f.y += (f.vy * dtMs) / 1000;
      f.vx *= drag;
      f.vy = f.vy * drag + 140 * (dtMs / 1000); // 轻微下坠
      f.rot += (f.rotSpeed * dtMs) / 1000;
    }
  }

  /** 在 ADD 混合 Graphics 上绘制存活碎片（外圈淡光 + 内芯亮片）。 */
  draw(g: Phaser.GameObjects.Graphics): void {
    for (let i = 0; i < this.frags.length; i++) {
      const f = this.frags[i];
      if (!f.alive) {
        continue;
      }
      const t = f.lifeMs / f.maxLifeMs;
      const alpha = t * t;
      g.fillStyle(f.color, alpha * 0.35);
      g.fillCircle(f.x, f.y, f.size * 1.9);
      g.fillStyle(f.color, alpha);
      this.fillShard(g, f, f.size);
      if (t > 0.55) {
        g.fillStyle(0xffffff, (t - 0.55) * 1.6);
        this.fillShard(g, f, f.size * 0.45);
      }
    }
  }

  private fillShard(g: Phaser.GameObjects.Graphics, f: Fragment, r: number): void {
    switch (f.shape) {
      case 'triangle':
        fillPolyShape(g, f.x, f.y, r, 3, f.rot);
        break;
      case 'square':
        fillPolyShape(g, f.x, f.y, r, 4, f.rot + Math.PI / 4);
        break;
      case 'hexagon':
        fillPolyShape(g, f.x, f.y, r, 6, f.rot);
        break;
      default:
        g.fillCircle(f.x, f.y, r * 0.8);
        break;
    }
  }

  /** restart 换局时清空（新 state 的 timeMs 从 0 起，避免旧粒子跨局残留）。 */
  clear(): void {
    for (let i = 0; i < this.frags.length; i++) {
      this.frags[i].alive = false;
    }
  }
}

/** 正多边形填充（顶点从 angle0 起；色值/透明度由调用方给，省一次 fillStyle 来回）。 */
export function fillPoly(
  g: Phaser.GameObjects.Graphics,
  cx: number,
  cy: number,
  r: number,
  sides: number,
  angle0: number,
  color: number,
  alpha: number,
): void {
  g.fillStyle(color, alpha);
  fillPolyShape(g, cx, cy, r, sides, angle0);
}

/** 正多边形描边（顶点从 angle0 起）。 */
export function strokePoly(
  g: Phaser.GameObjects.Graphics,
  cx: number,
  cy: number,
  r: number,
  sides: number,
  angle0: number,
  color: number,
  alpha: number,
): void {
  g.lineStyle(1.5, color, alpha);
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < sides; i++) {
    const a = angle0 + (i * 2 * Math.PI) / sides;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  g.strokePoints(pts, true);
}

/** 正多边形填充（使用调用方已设的 fillStyle）。 */
function fillPolyShape(
  g: Phaser.GameObjects.Graphics,
  cx: number,
  cy: number,
  r: number,
  sides: number,
  angle0: number,
): void {
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < sides; i++) {
    const a = angle0 + (i * 2 * Math.PI) / sides;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  g.fillPoints(pts, true);
}

// —— 枪口闪光（开火反馈：检测「场景内新弹丸出现」时在出生点闪光） ——

interface Flash {
  alive: boolean;
  x: number;
  y: number;
  lifeMs: number;
  maxLifeMs: number;
}

/** 枪口闪光池：容量 24 环形覆写。draw 输出双圈白热闪光（ADD）。 */
export class MuzzleFlashes {
  private readonly flashes: Flash[];
  private cursor = 0;

  constructor(capacity = 24) {
    this.flashes = Array.from({ length: capacity }, () => ({
      alive: false,
      x: 0,
      y: 0,
      lifeMs: 0,
      maxLifeMs: 1,
    }));
  }

  spawn(x: number, y: number, lifeMs = 70): void {
    const f = this.flashes[this.cursor];
    this.cursor = (this.cursor + 1) % this.flashes.length;
    f.alive = true;
    f.x = x;
    f.y = y;
    f.maxLifeMs = lifeMs;
    f.lifeMs = lifeMs;
  }

  update(dtMs: number): void {
    for (let i = 0; i < this.flashes.length; i++) {
      const f = this.flashes[i];
      if (!f.alive) {
        continue;
      }
      f.lifeMs -= dtMs;
      if (f.lifeMs <= 0) {
        f.alive = false;
      }
    }
  }

  draw(g: Phaser.GameObjects.Graphics): void {
    for (let i = 0; i < this.flashes.length; i++) {
      const f = this.flashes[i];
      if (!f.alive) {
        continue;
      }
      const t = f.lifeMs / f.maxLifeMs;
      g.fillStyle(0xffe9a0, t * 0.4);
      g.fillCircle(f.x, f.y - 6, 15 * (2 - t));
      g.fillStyle(0xffffff, t * 0.9);
      g.fillCircle(f.x, f.y - 6, 5.5 * (2 - t));
    }
  }

  clear(): void {
    for (let i = 0; i < this.flashes.length; i++) {
      this.flashes[i].alive = false;
    }
  }
}

// —— 冲击波环（Boss 击杀等大事件） ——

interface Wave {
  alive: boolean;
  x: number;
  y: number;
  lifeMs: number;
  maxLifeMs: number;
  radius0: number;
  speed: number;
  color: number;
}

/**
 * 扩张圆环池：容量 32 环形覆写（T5.2b 扩容：榴弹爆炸每发都入池，集束齐落一波可达 5+ 环，
 * 加上 Boss 冲击波，8 容量会互相覆写丢帧）。Boss 击杀金色冲击波 + 榴弹爆炸绿系冲击环共用。
 */
export class RingWaves {
  private readonly waves: Wave[];
  private cursor = 0;

  constructor(capacity = 32) {
    this.waves = Array.from({ length: capacity }, () => ({
      alive: false,
      x: 0,
      y: 0,
      lifeMs: 0,
      maxLifeMs: 1,
      radius0: 10,
      speed: 400,
      color: 0xffffff,
    }));
  }

  spawn(x: number, y: number, color: number, radius0 = 12, speed = 420, lifeMs = 460): void {
    const w = this.waves[this.cursor];
    this.cursor = (this.cursor + 1) % this.waves.length;
    w.alive = true;
    w.x = x;
    w.y = y;
    w.color = color;
    w.radius0 = radius0;
    w.speed = speed;
    w.maxLifeMs = lifeMs;
    w.lifeMs = lifeMs;
  }

  update(dtMs: number): void {
    for (let i = 0; i < this.waves.length; i++) {
      const w = this.waves[i];
      if (!w.alive) {
        continue;
      }
      w.lifeMs -= dtMs;
      if (w.lifeMs <= 0) {
        w.alive = false;
      }
    }
  }

  draw(g: Phaser.GameObjects.Graphics): void {
    for (let i = 0; i < this.waves.length; i++) {
      const w = this.waves[i];
      if (!w.alive) {
        continue;
      }
      const t = w.lifeMs / w.maxLifeMs;
      const r = w.radius0 + w.speed * ((w.maxLifeMs - w.lifeMs) / 1000);
      g.lineStyle(6, w.color, t * 0.22);
      g.strokeCircle(w.x, w.y, r);
      g.lineStyle(2, w.color, t * 0.8);
      g.strokeCircle(w.x, w.y, r);
    }
  }

  clear(): void {
    for (let i = 0; i < this.waves.length; i++) {
      this.waves[i].alive = false;
    }
  }
}
