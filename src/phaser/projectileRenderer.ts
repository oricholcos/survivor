// src/phaser/projectileRenderer.ts —— 弹丸渲染 T6b：预烘焙纹理 + 池化 ADD Image。
// 背景：原 renderWorld 每帧对每颗活弹在 glow 层（ADD Graphics）矢量重绘（drawProjectile：
// 泛光线/尾焰圆/自旋菱形等 3~8 条图元），Phaser Graphics 逐帧 JS 重灌命令缓冲 + CPU 三角化，
// 活弹数百时（core maxProjectiles=600）是最大剩余渲染瓶颈。本模块沿用 T6a enemyRenderer 的
// 「纹理烘焙 + 固定池」参照模式：create 时按 behavior 分类把弹体（glow 光晕烘进贴图，径向
// 渐变用多圈同心 alpha 圆近似）烘成贴图，运行期只对池化 Image 做 setTexture / setPosition /
// setRotation / setScale / setAlpha / setVisible 属性覆写——稳态每帧零对象分配、零创建销毁、
// 零三角化。
//
// 烘焙贴图清单（generateTexture 一次性；弹丸颜色按 behavior 固定，无需 tint）：
//   proj_bolt_charge   charge_sniper 亮白长针（横向长条 64×16，+x=弹头方向；rotation 对准
//                      速度方向；长度 44 为行为常量已烘进贴图，scaleX 恒 1）
//   proj_dot_scatter   scatter_shot 橙黄光点（34×34，基准弹体半径 6，scale=有效半径/6）
//   proj_missile       homing_missile 品红导弹带尾焰（40×20，+x=弹头方向；rotation 对准
//                      速度方向只为尾焰方向正确；data.bomblet=1 时整体 scale=0.7）
//   proj_dot_mortar    mortar 绿色光点（32×32，基准半径 6；母弹画在贝塞尔视觉弧线上）
//   proj_prism         prism_chain 紫电自旋菱形（96×96，基准绘制半径 24=聚能折返宽体弹
//                      radius 16×1.5；rotation=自旋角、scale=绘制半径/24，顶点从 angle0=0
//                      起烘，与原 fillPoly(spin) 逐顶点一致）
//   proj_prism_tail    prism 弹尾小电弧（32×16，+x=速度方向；原逐帧抖动折点改为固定折点）
//   proj_dot_fallback  未知 behavior 兜底暖白光点（28×28，基准半径 6）
// 分层契约：池化 Image 挂 glow 层（depth 4 起微步进、ADD 混合，与 glowGfx / 状态降级光环
// 同层；ADD 混合可交换，层内先后不影响合成结果）。?fx=0 只关相机 bloom，不涉及本模块。
// meta VFX（光束/电弧/榴弹落点引导等）仍走 glowGfx 矢量绘制（数量少，见 mainScene）。
import Phaser from 'phaser';
import type { Projectile, SimState } from '../core/types';
import { bezier, fillPoly, projectileStyle, type ProjectileStyle } from './fx';

// —— 纹理键 ——
const KEY_BOLT = 'proj_bolt_charge';
const KEY_SCATTER = 'proj_dot_scatter';
const KEY_MISSILE = 'proj_missile';
const KEY_MORTAR = 'proj_mortar';
const KEY_PRISM = 'proj_prism';
const KEY_PRISM_TAIL = 'proj_prism_tail';
const KEY_FALLBACK = 'proj_dot_fallback';

// —— 分层深度 ——
/** 池槽微深度步进（与 enemyRenderer 同值）：类别间距远大于全部槽跨度，槽序=绘制序。 */
const SLOT_DEPTH_EPS = 0.00001;
/** 弹丸池深度基线：glow 层（glowGfx=4、状态降级光环同基线；ADD 可交换）。 */
const DEPTH_BASE = 4;

/** 追猎导弹素材宽度 px（重导出缩小版，长边=宽）。 */
const MISSILE_SPRITE_WIDTH = 128;
/** 迫击航弹素材宽度 px（重导出缩小版，长边=宽）。 */
const MORTAR_SPRITE_WIDTH = 128;

/** 光点贴图基准弹体半径（各行为弹丸 core 半径均为 6；运行期 scale = 有效半径 / 6）。 */
const REF_DOT_RADIUS = 6;
/** 菱形贴图基准绘制半径 = 聚能折返宽体弹 radius 16 × 1.5（当前最大的 prism 绘制半径）。 */
const REF_PRISM_RADIUS = 24;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 弹丸速度朝向角（原 drawProjectile 约定：速度近零时朝向正上 ny=-1）。 */
function headingAngle(p: Projectile): number {
  return p.vx * p.vx + p.vy * p.vy > 1e-12 ? Math.atan2(p.vy, p.vx) : -Math.PI / 2;
}

// —— 烘焙期几何（一次性，非热路径；允许局部分配） ——

/** 烘焙用直线段。 */
function bakeLine(
  g: Phaser.GameObjects.Graphics,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  color: number,
  alpha: number,
): void {
  g.lineStyle(width, color, alpha);
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x2, y2);
  g.strokePath();
}

/**
 * 烘焙一枚「泛光光点」贴图（几何与原 drawProjectile 各光点分支逐值一致）：
 * 外圈大半径低 alpha 泛光 + 内芯亮圆 +（可选）白热芯点。光点居中于 size×size 贴图，
 * 运行期 setScale = 有效弹体半径 / refR。
 */
function bakeGlowDot(
  g: Phaser.GameObjects.Graphics,
  key: string,
  size: number,
  st: ProjectileStyle,
  refR: number,
  outerMul: number,
  outerAlpha: number,
  coreAlpha: number,
  hotMul: number, // 0 = 无白热芯点
  hotAlpha: number,
): void {
  const c = size / 2;
  g.fillStyle(st.outer, outerAlpha);
  g.fillCircle(c, c, refR * outerMul);
  g.fillStyle(st.core, coreAlpha);
  g.fillCircle(c, c, refR);
  if (hotMul > 0) {
    g.fillStyle(st.hot, hotAlpha);
    g.fillCircle(c, c, refR * hotMul);
  }
  g.generateTexture(key, size, size);
  g.clear();
}

/** 烘焙 charge_sniper 亮白长针：横向长条（+x=弹头），枢轴=弹丸坐标=纹理中心。 */
function bakeBolt(g: Phaser.GameObjects.Graphics, key: string, st: ProjectileStyle): void {
  const W = 64;
  const H = 16;
  const cx = W / 2;
  const cy = H / 2;
  const LEN = 44; // 原行为常量：弹尾 40% 在后、弹头 60% 在前
  bakeLine(g, cx - LEN * 0.4, cy, cx + LEN * 0.6, cy, 6, st.outer, 0.22);
  bakeLine(g, cx - LEN * 0.4, cy, cx + LEN * 0.6, cy, 2, st.core, 1);
  g.fillStyle(st.hot, 0.9);
  g.fillCircle(cx + LEN * 0.6, cy, 2 * 0.8 + 1);
  // 弹头方向 22px 处的淡光晕点（原 charge_sniper 分支的额外 fillCircle）。
  g.fillStyle(st.core, 0.5);
  g.fillCircle(cx + 22, cy, 3.5);
  g.generateTexture(key, W, H);
  g.clear();
}

/**
 * 烘焙 prism_chain 自旋菱形：顶点从 angle0=0 起（与原 fillPoly(…, spin) 同基准，
 * 运行期 setRotation(spin) 逐顶点复现原自旋姿态）；基准半径取当前最大绘制半径
 * （聚能折返宽体弹 radius 16 × 1.5 = 24），普通链弹按比例缩小。
 */
function bakePrism(g: Phaser.GameObjects.Graphics, key: string, st: ProjectileStyle): void {
  const S = 96;
  const c = S / 2;
  const r = REF_PRISM_RADIUS;
  fillPoly(g, c, c, r * 1.9, 4, 0, st.outer, 0.28);
  fillPoly(g, c, c, r, 4, 0, st.core, 0.95);
  fillPoly(g, c, c, r * 0.4, 4, 0, st.hot, 0.9);
  g.generateTexture(key, S, S);
  g.clear();
}

/** 烘焙 prism 弹尾小电弧：+x=速度方向、电弧拖在 -x 侧；折点取固定抖动值。 */
function bakePrismTail(g: Phaser.GameObjects.Graphics, key: string, st: ProjectileStyle): void {
  const W = 32;
  const H = 16;
  const cx = W / 2;
  const cy = H / 2;
  // 原为逐帧正弦抖动折点（幅度 3 / 4）；烘焙取固定折点（+2 / -2.5），保留「折线电弧」观感。
  g.lineStyle(1.5, st.core, 0.5);
  g.beginPath();
  g.moveTo(cx - 4, cy);
  g.lineTo(cx - 9, cy + 2);
  g.lineTo(cx - 14, cy - 2.5);
  g.strokePath();
  g.generateTexture(key, W, H);
  g.clear();
}

/** 启动期烘焙全部弹丸纹理（create 时一次；已存在即整组跳过，防重复 generateTexture）。 */
function ensureProjectileTextures(scene: Phaser.Scene): void {
  if (scene.textures.exists(KEY_BOLT)) {
    return;
  }
  const g = scene.make.graphics({ x: 0, y: 0 });

  bakeBolt(g, KEY_BOLT, projectileStyle('charge_sniper'));
  bakeGlowDot(g, KEY_SCATTER, 34, projectileStyle('scatter_shot'), REF_DOT_RADIUS, 2.6, 0.22, 1, 0.45, 0.9);
  bakePrism(g, KEY_PRISM, projectileStyle('prism_chain'));
  bakePrismTail(g, KEY_PRISM_TAIL, projectileStyle('prism_chain'));
  bakeGlowDot(g, KEY_FALLBACK, 28, projectileStyle('__unknown__'), REF_DOT_RADIUS, 2, 0.2, 1, 0, 0);

  g.destroy();
}

// —— mortar 母弹视觉弧（自 mainScene 迁入；scratch 复用，每帧零对象分配） ——

/** mortarVisualPos 的复用返回点（模块级 scratch：热路径零分配）。 */
const visualScratch = { x: 0, y: 0 };

/**
 * 迫击榴弹母弹的视觉位置：沿「角色→落点」的二次贝塞尔弧取点（progress = 1 - ttl/总飞行
 * 时长），与虚线弧线提示/落点危险圈严格贴合；模拟弹体本身直线 noCollide 飞行、只在落点
 * 结算，视觉弧不参与任何判定。非（有效母弹）返回 null：按模拟位置画普通绿点。
 */
function mortarVisualPos(p: Projectile, s: SimState): { x: number; y: number } | null {
  if (p.data.bomblet === 1) {
    return null;
  }
  const tx = p.data.tx;
  const ty = p.data.ty;
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
    return null;
  }
  const ch = s.character;
  const speed = Math.hypot(p.vx, p.vy);
  const dist = Math.hypot(tx - ch.x, ty - ch.y);
  if (speed <= 1e-6 || dist <= 20) {
    return null;
  }
  const totalMs = (dist / speed) * 1000;
  const t = totalMs > 0 ? clamp01(1 - p.ttlMs / totalMs) : 0;
  const h = Math.min(200, Math.max(60, dist * 0.32));
  const cx = (ch.x + tx) / 2;
  const cy = (ch.y + ty) / 2 - h;
  visualScratch.x = bezier(ch.x, cx, tx, t);
  visualScratch.y = bezier(ch.y, cy, ty, t);
  return visualScratch;
}

// —— 池槽 ——

/** 一枚弹丸的池化对象组：主贴图 + 弹尾辅贴图（辅贴图仅 prism_chain 使用，其余恒隐藏）。 */
interface ProjectileSlot {
  main: Phaser.GameObjects.Image;
  aux: Phaser.GameObjects.Image;
}

/**
 * 弹丸渲染器：create 时烘焙纹理并建满固定容量池，此后每帧只做属性覆写。
 * 容量 = config.maxProjectiles + 余量（core 硬上限 600 → 池 640， absorb 同帧内的
 * 瞬时超额）；超出池容量的弹丸按数组序截断不渲染（防御路径，core 护栏内不会发生）。
 * 本渲染器无状态（无寿命计时），每帧 sync 全量覆写可见性，无需 clear。
 */
export class ProjectileRenderer {
  private readonly slots: ProjectileSlot[] = [];

  constructor(scene: Phaser.Scene, capacity: number) {
    ensureProjectileTextures(scene);

    // 弹丸池：深度一次设好、此后不再改动（不触发显示列表重排）。
    for (let i = 0; i < capacity; i++) {
      const d = DEPTH_BASE + i * SLOT_DEPTH_EPS;
      const main = scene.add
        .image(0, -200, KEY_FALLBACK)
        .setOrigin(0.5, 0.5)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setVisible(false)
        .setDepth(d);
      const aux = scene.add
        .image(0, -200, KEY_PRISM_TAIL)
        .setOrigin(0.5, 0.5)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setVisible(false)
        .setDepth(d + SLOT_DEPTH_EPS * 0.5);
      this.slots.push({ main, aux });
    }
  }

  /**
   * 每帧同步：按 state.projectiles 数组顺序占用池槽（跳 dead；数组序 = 槽序，与原立即
   * 模式绘制顺序一致）。只做 setTexture/setPosition/setRotation/setScale/setAlpha/
   * setVisible，稳态零对象分配、零创建零销毁。未占用槽位全部隐藏。
   */
  sync(s: SimState): void {
    const slots = this.slots;
    const projs = s.projectiles;
    const timeMs = s.timeMs;
    let slot = 0;

    for (let i = 0; i < projs.length; i++) {
      const p = projs[i];
      if (p.dead) {
        continue; // 尸体标记：渲染必须跳过（与原 renderWorld 一致）
      }
      if (slot >= slots.length) {
        break; // 超出池容量：按数组序截断（防御路径，core maxProjectiles + 余量内不会发生）
      }
      const st = slots[slot];
      const main = st.main;

      // 每分支全量覆写 texture/position/rotation/scale/alpha：槽位跨帧复用可能切换弹种，
      // 不允许残留上一发弹的任何属性。
      switch (p.behavior) {
        case 'charge_sniper': {
          // 亮白长针：横向长条贴图 rotation 对准速度方向（长度 44 为行为常量，scaleX 恒 1）。
          main
            .setTexture(KEY_BOLT)
            .setPosition(p.x, p.y)
            .setRotation(headingAngle(p))
            .setScale(1)
            .setAlpha(1)
            .setVisible(true);
          st.aux.setVisible(false);
          break;
        }
        case 'scatter_shot': {
          // 橙黄光点：圆贴图按弹半径缩放（原内芯钳制 max(2.2, r)）。
          main
            .setTexture(KEY_SCATTER)
            .setPosition(p.x, p.y)
            .setRotation(0)
            .setScale(Math.max(2.2, p.radius) / REF_DOT_RADIUS)
            .setAlpha(1)
            .setVisible(true);
          st.aux.setVisible(false);
          break;
        }
        case 'homing_missile': {
          // 追猎导弹：预加载素材 (+x=弹头朝向)，rotation 对准速度方向；子弹（bomblet=1）0.7 缩放
          const missileScale = (32 / MISSILE_SPRITE_WIDTH) * (p.data.bomblet === 1 ? 0.7 : 1);
          main
            .setTexture(KEY_MISSILE)
            .setPosition(p.x, p.y)
            .setRotation(headingAngle(p))
            .setScale(missileScale)
            .setAlpha(0.85 + 0.15 * Math.sin(timeMs / 30 + p.id * 1.7))
            .setVisible(true);
          st.aux.setVisible(false);
          break;
        }
        case 'prism_chain': {
          // 紫电自旋菱形：rotation = 自旋角（与原 spin = timeMs*0.004 + id*1.3 一致）；
          // scale 按绘制半径映射（聚能折返宽体弹 radius 16 → 1.0，普通链弹 radius 6 → 0.375）。
          main
            .setTexture(KEY_PRISM)
            .setPosition(p.x, p.y)
            .setRotation(timeMs * 0.004 + p.id * 1.3)
            .setScale(Math.max(4, p.radius * 1.5) / REF_PRISM_RADIUS)
            .setAlpha(1)
            .setVisible(true);
          // 弹尾小电弧：+x=速度方向辅贴图（烘焙固定折点）；原尺寸不随半径缩放，scale 恒 1。
          st.aux
            .setTexture(KEY_PRISM_TAIL)
            .setPosition(p.x, p.y)
            .setRotation(headingAngle(p))
            .setScale(1)
            .setAlpha(1)
            .setVisible(true);
          break;
        }
        case 'mortar': {
          // 迫击航弹：母弹沿贝塞尔视觉弧线上飞行，子弹沿模拟坐标飞行；素材朝向沿飞行速度方向
          const vp = mortarVisualPos(p, s);
          const mortarScale = (28 / MORTAR_SPRITE_WIDTH) * (p.radius / 6);
          main
            .setTexture(KEY_MORTAR)
            .setPosition(vp ? vp.x : p.x, vp ? vp.y : p.y)
            .setRotation(headingAngle(p))
            .setScale(mortarScale)
            .setAlpha(1)
            .setVisible(true);
          st.aux.setVisible(false);
          break;
        }
        default: {
          // 未知 behavior 兜底：暖白光点（原钳制 max(2, r)；r<3 时外圈钳制差异可忽略）。
          main
            .setTexture(KEY_FALLBACK)
            .setPosition(p.x, p.y)
            .setRotation(0)
            .setScale(Math.max(2, p.radius) / REF_DOT_RADIUS)
            .setAlpha(1)
            .setVisible(true);
          st.aux.setVisible(false);
          break;
        }
      }

      slot += 1;
    }

    // 隐藏本帧未占用的槽位（可见性标记，渲染器直接跳过）。
    for (let i = slot; i < slots.length; i++) {
      const st = slots[i];
      st.main.setVisible(false);
      st.aux.setVisible(false);
    }
  }
}
