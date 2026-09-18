// 主场景：霓虹几何渲染（T4.3，在 T1.11 灰盒骨架上升级，结构不变）。
// SimState → Phaser Graphics 每帧重绘（立即模式，无对象级 sprite）；三层 Graphics 分工：
//   bg（depth 0）：静态背景，create 时一次性绘制星点/网格/结界光带，不逐帧重算；
//   gfx（depth 1，常规混合）：地面区域、墙、宝石/修复包、敌人、角色本体、HUD 条；
//   glow（depth 2，ADD 叠加混合）：弹丸/光束/轨道射线/龙息锥/榴弹爆炸/角色光晕/死亡爆裂/
//   枪口闪光/红 vignette。
// 主循环对接：update 内 step（paused 时冻结模拟、渲染照常）→ drainEvents → 渲染当前帧。
// 事件消费约定：全部事件逐个转发给 session.onEvent（src/ui 的 DOM 覆盖层注册）；
// 场景内部消化：击杀计数（HUD 用）+ 视觉反馈（enemyKilled 死亡爆裂/Boss 冲击波、
// wallDamaged 震屏/墙体红闪/红 vignette）。受击白闪无事件可用，在渲染层按
// 「敌人 hp 较上一帧下降」检测（T4.3 约定）；开火反馈用「新弹丸 id 出现」触发枪口闪光。
import Phaser from 'phaser';
import { xpToNext } from '../core/gems';
import { listZones } from '../core/zones';
import { getWeaponStats } from '../core/weapons';
import type { HeatBeamVfx } from '../core/behaviors/behavior_heatBeam';
import type { DragonBreathVfx } from '../core/behaviors/behavior_dragonBreath';
import type { RailVfx } from '../core/behaviors/behavior_piercingBolt';
import type { MortarBlastVfx } from '../core/behaviors/behavior_mortar';
import type { PrismZapSegment } from '../core/behaviors/behavior_prismChain';
import type { GameEvent } from '../core/events';
import type { Enemy, Projectile, SimState } from '../core/types';
import type { GameSession } from '../game/session';
import { loadWeaponDefs } from '../data/weapons';
import { loadEnemyTypes } from '../data/enemies';
import {
  DRAGON_BREATH_VFX_PREFIX,
  DeathBurst,
  HEAT_BEAM_VFX_PREFIX,
  MORTAR_BLAST_VFX_KEY,
  MuzzleFlashes,
  PRISM_ZAP_COLORS,
  PRISM_ZAP_VFX_KEY,
  RAIL_VFX_PREFIX,
  RingWaves,
  STATUS_EFFECT_COLORS,
  darken,
  drawStaticBackground,
  fillPoly,
  projectileStyle,
  zoneColor,
  type ProjectileStyle,
} from './fx';

// —— 布局/样式常量（视图层允许硬编码；页面深色底 #05050d） ——

const WALL_THICKNESS = 20; // 墙体横条高度
const WALL_BAR_MARGIN = 40; // 墙血条左右留边
const WALL_BAR_HEIGHT = 8;
const WALL_BAR_OFFSET = 20; // 墙血条距墙线的上移量
const ENEMY_HP_BAR_HEIGHT = 4;
const CHARACTER_RADIUS = 14;
const HUD_X = 16;
const HUD_Y = 12;
const XP_BAR_Y = 188; // 五行 HUD 文本下方（模式/时间/等级/击杀/武器列表）
const XP_BAR_WIDTH = 224;
const XP_BAR_HEIGHT = 8;

/** 城墙低血量警示阈值（<30% 常驻红色脉冲）。 */
const WALL_LOW_PCT = 0.3;
/** 敌人受击白闪时长 ms（hp 下降检测触发）。 */
const ENEMY_FLASH_MS = 120;
/** 城墙受击红闪时长 ms（与 wallDamaged 事件触发的震屏时长同量级）。 */
const WALL_FLASH_MS = 150;
/** meta VFX 留存 80ms（core 任务锁定常量），视图按剩余时间线性淡出。 */
const META_VFX_FADE_MS = 80;
/** 轨道炮射线留存 100ms（core rail VFX 任务锁定常量），视图按剩余时间线性淡出。 */
const RAIL_VFX_FADE_MS = 100;
/** 榴弹爆炸 VFX 留存 320ms（与 core MORTAR_BLAST_VFX_MS 一致），淡出与冲击环扩张共用。 */
const MORTAR_BLAST_FADE_MS = 320;
/**
 * 龙息锥视图侧驻留时长：core 的 dragon_breath meta 仅留存 80ms，而喷射 tick 间隔 150ms，
 * 逐帧淡出会出现「锥形闪烁有间隙」的观感——视图在每次读到新鲜 meta 时把本地驻留延长到
 * 150ms（T5.2b 可感知度加强：持续喷射期间锥形连续可见 + 高 alpha 内芯，停喷后自然淡出）。
 */
const DRAGON_CONE_VIEW_HOLD_MS = 150;

const COLOR_TRACK = 0x1a1f2e; // 血条/经验条底槽
const COLOR_XP_FILL = 0x8be9fd;
const COLOR_CHARACTER = 0xffe066;
const COLOR_CHARACTER_STROKE = 0xfff6c0; // 角色亮描边（霓虹高光）
const COLOR_BOSS_RING = 0xffd24a; // Boss 旋转外圈光环
const COLOR_BOSS_RING_INNER = 0xffe9b0;

/** 武器定义表（HUD 武器列表行 + 灼热光束宽度取值用；数据表只加载一次、内容共享只读）。 */
const WEAPON_DEFS = loadWeaponDefs();
/** 敌人图鉴（死亡爆裂碎片的颜色/形状按 typeId 取值；只加载一次）。 */
const ENEMY_TYPES = loadEnemyTypes();

// —— 调试速度参数（?speed=N，src/main.ts 解析后经 setStepsPerFrame 注入；GUI 验收用）——

/** 每渲染帧推进的模拟子步数（默认 1 = 原速；N>1 时每帧连推 N 个 core step）。 */
let stepsPerFrameConfig = 1;

/**
 * 注入调试速度（main.ts 在 startGame 之前调用；场景构造时捕获生效值）。
 * N 钳制到 1~20：非法值忽略，保持原速。
 */
export function setStepsPerFrame(n: number): void {
  if (Number.isInteger(n) && n >= 1) {
    stepsPerFrameConfig = Math.min(n, 20);
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 墙/墙血条颜色：pct=1 → 青，pct=0 → 红（RGB 线性插值）。 */
function healthColor(pct: number): number {
  const t = clamp01(pct);
  const r = Math.round(255 + (54 - 255) * t);
  const g = Math.round(64 + (226 - 64) * t);
  const b = Math.round(64 + (255 - 64) * t);
  return (r << 16) | (g << 8) | b;
}

/** 敌人血条颜色：pct=1 → 绿，pct=0 → 红。 */
function hpBarColor(pct: number): number {
  const t = clamp01(pct);
  const r = Math.round(255 * (1 - t));
  const g = Math.round(40 + 180 * t);
  return (r << 16) | (g << 8) | 0x28;
}

// 多边形顶点 scratch：预分配复用，避免每帧为每个敌人分配点对象（fill/strokePoints 需切片）。
const MAX_POLY_POINTS = 10;
const polyScratch: Array<{ x: number; y: number }> = Array.from({ length: MAX_POLY_POINTS }, () => ({
  x: 0,
  y: 0,
}));

/** 正多边形顶点写入 scratch（顶点从正上方起），返回顶点数。 */
function regularPolyInto(cx: number, cy: number, r: number, sides: number, rot = 0): number {
  for (let i = 0; i < sides; i++) {
    const a = -Math.PI / 2 + rot + (i * 2 * Math.PI) / sides;
    const p = polyScratch[i];
    p.x = cx + Math.cos(a) * r;
    p.y = cy + Math.sin(a) * r;
  }
  return sides;
}

/** 五角星顶点写入 scratch（外接圆半径 r，内半径 0.45r），返回顶点数 10。 */
function starInto(cx: number, cy: number, r: number, rot = 0): number {
  const inner = r * 0.45;
  for (let i = 0; i < MAX_POLY_POINTS; i++) {
    const a = -Math.PI / 2 + rot + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? r : inner;
    const p = polyScratch[i];
    p.x = cx + Math.cos(a) * rad;
    p.y = cy + Math.sin(a) * rad;
  }
  return MAX_POLY_POINTS;
}

/** 正多边形填充（scratch 复用版：敌人热路径用）。 */
function fillRegularPolygon(
  g: Phaser.GameObjects.Graphics,
  cx: number,
  cy: number,
  r: number,
  sides: number,
): void {
  const n = regularPolyInto(cx, cy, r, sides);
  g.fillPoints(polyScratch.slice(0, n), true);
}

/** 正多边形描边（scratch 复用版）。 */
function strokeRegularPolygon(
  g: Phaser.GameObjects.Graphics,
  cx: number,
  cy: number,
  r: number,
  sides: number,
): void {
  const n = regularPolyInto(cx, cy, r, sides);
  g.strokePoints(polyScratch.slice(0, n), true);
}

/** 五角星填充。 */
function fillStar(g: Phaser.GameObjects.Graphics, cx: number, cy: number, r: number): void {
  starInto(cx, cy, r);
  g.fillPoints(polyScratch, true);
}

/** 五角星描边。 */
function strokeStar(g: Phaser.GameObjects.Graphics, cx: number, cy: number, r: number): void {
  starInto(cx, cy, r);
  g.strokePoints(polyScratch, true);
}

/** 直线段描边（发光层/光束通用小工具）。 */
function strokeLine(
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

/** 二次贝塞尔分量（迫击榴弹的视觉下坠弧线用）。 */
function bezier(p0: number, pc: number, p1: number, t: number): number {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * pc + t * t * p1;
}

// —— 敌人霓虹几何形 ——

/**
 * Boss 旋转外圈光环：4 段宽微光弧 + 4 段亮弧同速正转，内圈细环反转（state.timeMs 驱动）。
 */
function drawBossRings(g: Phaser.GameObjects.Graphics, e: Enemy, r: number, timeMs: number): void {
  const spin = (timeMs / 1000) * 1.5;
  const ringR = r + 9;
  const arcLen = Math.PI / 3.2;
  for (let pass = 0; pass < 2; pass++) {
    g.lineStyle(pass === 0 ? 7 : 2.5, COLOR_BOSS_RING, pass === 0 ? 0.14 : 0.9);
    for (let i = 0; i < 4; i++) {
      const a0 = spin + (i * Math.PI) / 2;
      g.beginPath();
      g.arc(e.x, e.y, ringR, a0, a0 + arcLen);
      g.strokePath();
    }
  }
  const a1 = -spin * 1.7;
  g.lineStyle(1.5, COLOR_BOSS_RING_INNER, 0.5);
  g.beginPath();
  g.arc(e.x, e.y, r + 4, a1, a1 + Math.PI * 1.4);
  g.strokePath();
}

/** 按图鉴 shape 填充敌人几何形（color/alpha 由调用方给，白闪复用同一形状）。 */
function fillEnemyShape(
  g: Phaser.GameObjects.Graphics,
  e: Enemy,
  r: number,
  color: number,
  alpha: number,
): void {
  g.fillStyle(color, alpha);
  switch (e.shape) {
    case 'triangle':
      fillRegularPolygon(g, e.x, e.y, r, 3);
      break;
    case 'square':
      g.fillRect(e.x - r * 0.8, e.y - r * 0.8, r * 1.6, r * 1.6);
      break;
    case 'hexagon':
      fillRegularPolygon(g, e.x, e.y, r, 6);
      break;
    case 'star':
      fillStar(g, e.x, e.y, r);
      break;
    default:
      g.fillCircle(e.x, e.y, r);
      break;
  }
}

/** 按图鉴 shape 描边敌人几何形（高饱和霓虹描边 / 微光外圈复用）。 */
function strokeEnemyShape(
  g: Phaser.GameObjects.Graphics,
  e: Enemy,
  r: number,
  width: number,
  color: number,
  alpha: number,
): void {
  g.lineStyle(width, color, alpha);
  switch (e.shape) {
    case 'triangle':
      strokeRegularPolygon(g, e.x, e.y, r, 3);
      break;
    case 'square':
      g.strokeRect(e.x - r * 0.8, e.y - r * 0.8, r * 1.6, r * 1.6);
      break;
    case 'hexagon':
      strokeRegularPolygon(g, e.x, e.y, r, 6);
      break;
    case 'star':
      strokeStar(g, e.x, e.y, r);
      break;
    default:
      g.strokeCircle(e.x, e.y, r);
      break;
  }
}

/**
 * 画一只敌人：霓虹几何风——暗色填充（图鉴色向暗底收缩）+ 高饱和描边 + 微光外圈；
 * Boss（星形）加旋转外圈光环 + 更醒目的血条（加宽加高 + 金色描边框）；
 * flashAlpha > 0 时叠加受击白闪（hp 下降检测，渲染层实现）；头顶细血条保留。
 */
function drawEnemy(
  g: Phaser.GameObjects.Graphics,
  e: Enemy,
  flashAlpha: number,
  timeMs: number,
): void {
  const r = e.isBoss ? e.radius * 1.15 : e.radius;
  if (e.isBoss) {
    drawBossRings(g, e, r, timeMs);
  }

  // 微光外圈（宽幅低 alpha）→ 高饱和描边 → 暗色填充 → 受击白闪。
  strokeEnemyShape(g, e, r + 2.5, 5, e.color, 0.16);
  strokeEnemyShape(g, e, r, 2.5, e.color, 1);
  fillEnemyShape(g, e, r - 1.2, darken(e.color, 0.3), 1);
  if (flashAlpha > 0) {
    fillEnemyShape(g, e, r - 1.2, 0xffffff, 0.85 * flashAlpha);
  }

  // 头顶血条（Boss 更醒目：加宽加高 + 金色描边框）。
  const pct = e.maxHp > 0 ? clamp01(e.hp / e.maxHp) : 0;
  const barW = e.isBoss ? e.radius * 2.8 : e.radius * 2;
  const barH = e.isBoss ? 6 : ENEMY_HP_BAR_HEIGHT;
  const barY = e.y - r - (e.isBoss ? 22 : 10);
  if (e.isBoss) {
    g.lineStyle(1.5, COLOR_BOSS_RING, 0.55);
    g.strokeRect(e.x - barW / 2 - 2, barY - 2, barW + 4, barH + 4);
  }
  g.fillStyle(COLOR_TRACK, 1);
  g.fillRect(e.x - barW / 2, barY, barW, barH);
  g.fillStyle(hpBarColor(pct), 1);
  g.fillRect(e.x - barW / 2, barY, barW * pct, barH);
}

/**
 * 绘制敌人状态异常视觉特效（纯几何、零 GC 分配、ADD 叠加发光层）：
 * - 减速（slow / chill）：冰蓝微弱脉动冷光描边与外轮廓冰霜圈；
 * - 冰毒 / 中毒（poison / chill+poison）：霓虹毒绿周身升腾消散微粒；若 chill+poison，外圈冰蓝，内侧绿雾微粒；
 * - 灼烧（burn）：亮橙红高频脉动烈焰描边 + 向上抖动的微型火星菱形；
 * - 眩晕（stun）：金黄暖白头顶悬浮双段旋转虚线光环与微型星辉，明确行动停摆反馈。
 */
export function drawEnemyStatusEffects(
  glow: Phaser.GameObjects.Graphics,
  e: Enemy,
  timeMs: number,
): void {
  if (e.dead || e.effects.length === 0) {
    return;
  }

  let hasSlow = false;
  let hasChill = false;
  let hasPoison = false;
  let hasBurn = false;
  let hasStun = false;

  for (let i = 0; i < e.effects.length; i++) {
    const k = e.effects[i].kind;
    if (k === 'slow') {
      hasSlow = true;
    } else if (k === 'chill') {
      hasChill = true;
    } else if (k === 'poison') {
      hasPoison = true;
    } else if (k === 'burn') {
      hasBurn = true;
    } else if (k === 'stun') {
      hasStun = true;
    }
  }

  if (!hasSlow && !hasChill && !hasPoison && !hasBurn && !hasStun) {
    return;
  }

  const r = e.isBoss ? e.radius * 1.15 : e.radius;

  // 1) 减速 / 冰附着（slow / chill）：冰蓝微弱脉动冷光描边与外轮廓冰霜圈
  if (hasSlow || hasChill) {
    const pulse = 0.5 + 0.5 * Math.sin(timeMs * 0.005 + e.id * 0.7);
    strokeEnemyShape(glow, e, r, 2, STATUS_EFFECT_COLORS.chillCore, 0.55 + 0.25 * pulse);
    strokeEnemyShape(glow, e, r + 2.5, 4, STATUS_EFFECT_COLORS.chillOuter, 0.2 + 0.15 * pulse);

    const frostR = r + 5 + 2 * pulse;
    glow.lineStyle(1.5, STATUS_EFFECT_COLORS.chillOuter, 0.4 + 0.2 * pulse);
    glow.strokeCircle(e.x, e.y, frostR);

    // 冰霜结晶晶芒（6 芒）
    const rot = (timeMs * 0.0008) % (Math.PI * 2);
    for (let k = 0; k < 6; k++) {
      const angle = rot + (k * Math.PI) / 3;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const r1 = frostR - 1.5;
      const r2 = frostR + 3.5;
      glow.lineStyle(1.2, STATUS_EFFECT_COLORS.chillCore, 0.45 + 0.2 * pulse);
      glow.beginPath();
      glow.moveTo(e.x + cosA * r1, e.y + sinA * r1);
      glow.lineTo(e.x + cosA * r2, e.y + sinA * r2);
      glow.strokePath();
    }
  }

  // 2) 冰毒 / 中毒（poison / chill+poison）：霓虹毒绿升腾消散微粒；若同时持有 chill+poison，外圈冰蓝，内侧升腾绿雾微粒
  if (hasPoison) {
    if (!hasSlow && !hasChill) {
      const poisonPulse = 0.5 + 0.5 * Math.sin(timeMs * 0.006 + e.id);
      glow.lineStyle(1.5, STATUS_EFFECT_COLORS.poisonOuter, 0.35 + 0.15 * poisonPulse);
      glow.strokeCircle(e.x, e.y, r + 2.5);
    }

    // 周身利用 timeMs 周期升腾消散的绿色毒素微粒（利用模数计算当前进度，零 GC 分配）
    const cycleMs = 850;
    for (let k = 0; k < 5; k++) {
      const offset = (k * 170 + e.id * 113) % cycleMs;
      const prog = ((timeMs + offset) % cycleMs) / cycleMs; // 0..1
      const startY = e.y + r * 0.35;
      const endY = e.y - r * 1.3;
      const py = startY + (endY - startY) * prog;
      const sway = Math.sin(prog * Math.PI * 2 + k * 1.25 + e.id) * (r * 0.3);
      const spread = ((k - 2) / 2) * (r * 0.55);
      const px = e.x + spread + sway;
      const alpha = Math.sin(prog * Math.PI) * 0.75;
      const pRadius = 1.2 + (1 - prog) * 1.6;
      const pCol = k % 2 === 0 ? STATUS_EFFECT_COLORS.poisonCore : STATUS_EFFECT_COLORS.poisonOuter;
      glow.fillStyle(pCol, alpha);
      glow.fillCircle(px, py, pRadius);
    }
  }

  // 3) 灼烧（burn）：亮橙红高频脉动烈焰描边 + 向上抖动的微型火星三角/细菱形
  if (hasBurn) {
    const burnPulse = 0.5 + 0.5 * Math.sin(timeMs * 0.024 + e.id * 4.3);
    strokeEnemyShape(glow, e, r + 1.8 + burnPulse * 2, 2.5, STATUS_EFFECT_COLORS.burnOuter, 0.6 + 0.3 * burnPulse);
    strokeEnemyShape(glow, e, r, 1.5, STATUS_EFFECT_COLORS.burnCore, 0.75 + 0.25 * burnPulse);

    // 向上抖动的微型火星细菱形/三角
    const sparkCycle = 420;
    for (let k = 0; k < 4; k++) {
      const offset = (k * 105 + e.id * 67) % sparkCycle;
      const prog = ((timeMs + offset) % sparkCycle) / sparkCycle; // 0..1
      const sy = e.y - r * 0.2 - prog * (r * 1.1 + 14);
      const jitter = Math.sin(timeMs * 0.038 + k * 2.3 + e.id) * 3.5;
      const sx = e.x + ((k - 1.5) / 1.5) * (r * 0.6) + jitter;
      const sAlpha = (1 - prog) * 0.85;
      const d = 2.0 + (1 - prog) * 1.2;

      // 细菱形火星
      glow.fillStyle(STATUS_EFFECT_COLORS.burnCore, sAlpha);
      glow.beginPath();
      glow.moveTo(sx, sy - d * 1.5);
      glow.lineTo(sx + d * 0.7, sy);
      glow.lineTo(sx, sy + d * 1.0);
      glow.lineTo(sx - d * 0.7, sy);
      glow.closePath();
      glow.fillPath();

      // 微型白热点
      glow.fillStyle(0xffffff, sAlpha * 0.9);
      glow.fillCircle(sx, sy - d * 0.3, 0.6);
    }
  }

  // 4) 眩晕（stun）：金黄暖白头顶悬浮双段旋转虚线光环与微型星辉，明确行动停摆反馈
  if (hasStun) {
    const haloY = e.y - r - (e.isBoss ? 26 : 14);
    const haloX = e.x;
    const haloR = Math.max(9, r * 0.6);
    const haloRy = haloR * 0.36;
    const rot = (timeMs * 0.005) % (Math.PI * 2);

    for (let seg = 0; seg < 2; seg++) {
      const startAngle = rot + seg * Math.PI;
      const endAngle = startAngle + Math.PI * 0.55;
      glow.lineStyle(2, STATUS_EFFECT_COLORS.stunRing, 0.9);
      glow.beginPath();
      for (let s = 0; s <= 6; s++) {
        const a = startAngle + ((endAngle - startAngle) * s) / 6;
        const px = haloX + Math.cos(a) * haloR;
        const py = haloY + Math.sin(a) * haloRy;
        if (s === 0) {
          glow.moveTo(px, py);
        } else {
          glow.lineTo(px, py);
        }
      }
      glow.strokePath();

      // 头顶微型星辉
      const starAngle = endAngle + 0.15;
      const sx = haloX + Math.cos(starAngle) * (haloR + 1.5);
      const sy = haloY + Math.sin(starAngle) * (haloRy + 1);
      const starPulse = 0.5 + 0.5 * Math.sin(timeMs * 0.012 + seg * 3);
      const starSize = 2.2 + starPulse * 1.2;

      glow.lineStyle(1.2, STATUS_EFFECT_COLORS.stunStar, 0.95);
      glow.beginPath();
      glow.moveTo(sx - starSize, sy);
      glow.lineTo(sx + starSize, sy);
      glow.moveTo(sx, sy - starSize);
      glow.lineTo(sx, sy + starSize);
      glow.strokePath();

      glow.fillStyle(STATUS_EFFECT_COLORS.stunStar, 0.95);
      glow.fillCircle(sx, sy, 0.8);
    }
  }
}

// —— 弹丸霓虹形态（behavior → 形状/颜色映射，配色表见 fx.ts） ——

/** 直线型弹丸（贯穿长条 / 狙击长针）：外圈泛光粗线 + 内芯亮线 + 弹头白热点。 */
function drawBolt(
  g: Phaser.GameObjects.Graphics,
  p: Projectile,
  nx: number,
  ny: number,
  st: ProjectileStyle,
  length: number,
  outerW: number,
  coreW: number,
): void {
  const tailX = p.x - nx * length * 0.4;
  const tailY = p.y - ny * length * 0.4;
  const headX = p.x + nx * length * 0.6;
  const headY = p.y + ny * length * 0.6;
  strokeLine(g, tailX, tailY, headX, headY, outerW, st.outer, 0.22);
  strokeLine(g, tailX, tailY, headX, headY, coreW, st.core, 1);
  g.fillStyle(st.hot, 0.9);
  g.fillCircle(headX, headY, coreW * 0.8 + 1);
}

/** 导弹（品红带尾焰）：速度反方向三节渐隐尾焰圆 + 弹体亮芯，弹头白热点。 */
function drawMissile(
  g: Phaser.GameObjects.Graphics,
  p: Projectile,
  nx: number,
  ny: number,
  st: ProjectileStyle,
  timeMs: number,
): void {
  const bomblet = p.data.bomblet === 1;
  const scale = bomblet ? 0.7 : 1;
  const flicker = 0.75 + 0.25 * Math.sin(timeMs / 30 + p.id * 1.7);
  for (let k = 0; k < 3; k++) {
    const d = (4 + k * 5.5) * scale;
    g.fillStyle(st.outer, (0.4 - k * 0.12) * flicker);
    g.fillCircle(p.x - nx * d, p.y - ny * d, (3.4 - k * 0.9) * scale);
  }
  const r = bomblet ? 2.2 : 3.2;
  g.fillStyle(st.outer, 0.3);
  g.fillCircle(p.x, p.y, r * 2.6);
  g.fillStyle(st.core, 1);
  g.fillCircle(p.x, p.y, r);
  g.fillStyle(st.hot, 0.9);
  g.fillCircle(p.x + nx * r * 0.6, p.y + ny * r * 0.6, r * 0.5);
}

/** 棱镜（紫电小菱形）：自旋菱形三层（泛光/亮芯/白核）+ 弹尾两段抖动小电弧。 */
function drawPrism(
  g: Phaser.GameObjects.Graphics,
  p: Projectile,
  nx: number,
  ny: number,
  st: ProjectileStyle,
  timeMs: number,
): void {
  const spin = (timeMs / 1000) * 4 + p.id * 1.3;
  const r = Math.max(4, p.radius * 1.5);
  // 弹尾小电弧：横向抖动由 id 定相（确定性，视图纯装饰）。
  const j1 = Math.sin(timeMs / 45 + p.id * 2.1) * 3;
  const j2 = Math.sin(timeMs / 60 + p.id * 3.7) * 4;
  const px = -ny;
  const py = nx;
  g.lineStyle(1.5, st.core, 0.5);
  g.beginPath();
  g.moveTo(p.x - nx * 4, p.y - ny * 4);
  g.lineTo(p.x - nx * 9 + px * j1, p.y - ny * 9 + py * j1);
  g.lineTo(p.x - nx * 14 + px * j2, p.y - ny * 14 + py * j2);
  g.strokePath();
  // 菱形本体三层。
  fillPoly(g, p.x, p.y, r * 1.9, 4, spin, st.outer, 0.28);
  fillPoly(g, p.x, p.y, r, 4, spin, st.core, 0.95);
  fillPoly(g, p.x, p.y, r * 0.4, 4, spin, st.hot, 0.9);
}

/**
 * 迫击榴弹的视觉位置：母弹（data.bomblet !== 1）沿「角色→落点」的二次贝塞尔弧取点
 * （progress = 1 - ttl/总飞行时长），与虚线弧线提示/落点危险圈严格贴合；
 * 模拟弹体本身直线 noCollide 飞行、只在落点结算，视觉弧不参与任何判定。
 * 非（有效母弹）返回 null：按模拟位置画普通绿点。
 */
function mortarVisualPos(p: Projectile, s: SimState): { x: number; y: number } | null {
  if (p.behavior !== 'mortar' || p.data.bomblet === 1) {
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
  return { x: bezier(ch.x, cx, tx, t), y: bezier(ch.y, cy, ty, t) };
}

/** 画一枚弹丸（ADD 发光层内）：按 behavior 分形态。未知行为回落暖白小亮点。 */
function drawProjectile(
  g: Phaser.GameObjects.Graphics,
  p: Projectile,
  s: SimState,
): void {
  const st = projectileStyle(p.behavior);
  const speed = Math.hypot(p.vx, p.vy);
  const nx = speed > 1e-6 ? p.vx / speed : 0;
  const ny = speed > 1e-6 ? p.vy / speed : -1;

  switch (p.behavior) {
    case 'charge_sniper': // 亮白长针
      drawBolt(g, p, nx, ny, st, 44, 6, 2);
      g.fillStyle(st.core, 0.5);
      g.fillCircle(p.x + nx * 22, p.y + ny * 22, 3.5);
      break;
    case 'scatter_shot': // 橙黄小点
      g.fillStyle(st.outer, 0.22);
      g.fillCircle(p.x, p.y, Math.max(2, p.radius) * 2.6);
      g.fillStyle(st.core, 1);
      g.fillCircle(p.x, p.y, Math.max(2.2, p.radius));
      g.fillStyle(st.hot, 0.9);
      g.fillCircle(p.x, p.y, Math.max(1.2, p.radius * 0.45));
      break;
    case 'homing_missile': // 品红带尾焰
      drawMissile(g, p, nx, ny, st, s.timeMs);
      break;
    case 'prism_chain': // 紫电小菱形
      drawPrism(g, p, nx, ny, st, s.timeMs);
      break;
    case 'mortar': {
      // 绿色圆点：母弹画在视觉弧线上（与弧线提示/落点圈贴合），子榴弹按模拟位置。
      const vp = mortarVisualPos(p, s);
      const x = vp ? vp.x : p.x;
      const y = vp ? vp.y : p.y;
      const r = Math.max(2.6, p.radius);
      g.fillStyle(st.outer, 0.22);
      g.fillCircle(x, y, r * 2.4);
      g.fillStyle(st.core, 1);
      g.fillCircle(x, y, r);
      g.fillStyle(st.hot, 0.85);
      g.fillCircle(x, y, r * 0.45);
      break;
    }
    default:
      g.fillStyle(st.outer, 0.2);
      g.fillCircle(p.x, p.y, Math.max(3, p.radius) * 2);
      g.fillStyle(st.core, 1);
      g.fillCircle(p.x, p.y, Math.max(2, p.radius));
      break;
  }
}

export class MainScene extends Phaser.Scene {
  private readonly session: GameSession;
  /** 调试速度：构造时捕获的每帧子步数（main.ts 读 ?speed=N 后经 setStepsPerFrame 注入）。 */
  private readonly stepsPerFrame: number;
  /** 相机 postFX 降级开关（?fx=0 关闭；Canvas 渲染器下 postFX 不可用，自动跳过）。 */
  private readonly fxEnabled: boolean;

  private bgGfx!: Phaser.GameObjects.Graphics; // 静态背景（一次性）
  private gfx!: Phaser.GameObjects.Graphics; // 常规混合：场景实体
  private glowGfx!: Phaser.GameObjects.Graphics; // ADD 混合：发光层
  private hudText!: Phaser.GameObjects.Text;
  /** 击杀数：从 enemyKilled 事件累计（视图侧派生值，随 state 替换重置）。 */
  private kills = 0;
  /** 上一次见到的 SimState 引用：session.restart() 整体替换 state 时重置派生计数与特效。 */
  private lastState: SimState | null = null;

  // —— 池化特效（fx.ts：环形缓冲，容量硬上限） ——
  private readonly deathBurst = new DeathBurst();
  private readonly muzzle = new MuzzleFlashes();
  private readonly waves = new RingWaves();

  // —— 受击/开火反馈的轻量跟踪 ——
  /** 敌人 id → 白闪截止时刻（state.timeMs 时间轴）。 */
  private readonly flashUntil = new Map<number, number>();
  /** 敌人 id → 上一帧 hp：下降即触发白闪。 */
  private readonly lastHp = new Map<number, number>();
  /** trackEnemyHits 的复用集合（避免每帧分配）。 */
  private readonly seenIds = new Set<number>();
  /** 弹丸 id 水位线：新弹丸出现 → 角色处枪口闪光（开火反馈）。 */
  private lastProjectileId = 0;
  /** 榴弹爆炸 meta 条目水位线（untilMs 单调递增）：新条目 → 冲击环入池，防重复入池。 */
  private blastWatermark = 0;
  /** 龙息锥视图侧驻留（meta 键 → 截止时刻）：喷射间隙维持锥形连续可见。 */
  private readonly dragonConeHoldUntil = new Map<string, number>();
  /** 城墙受击红闪：截止时刻 + 强度 0..1（幅度随 wallDamaged.amount）。 */
  private wallFlashUntilMs = 0;
  private wallFlashStrength = 0;
  /** 受击红 vignette：截止时刻 + 强度 0..1。 */
  private vignetteUntilMs = 0;
  private vignetteStrength = 0;

  constructor(session: GameSession, fxEnabled = true) {
    super('main');
    this.session = session;
    this.stepsPerFrame = stepsPerFrameConfig;
    this.fxEnabled = fxEnabled;
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#05050d');
    this.bgGfx = this.add.graphics().setDepth(0);
    this.gfx = this.add.graphics().setDepth(1);
    this.glowGfx = this.add.graphics().setDepth(2).setBlendMode(Phaser.BlendModes.ADD);
    const layout = this.session.state.layout;
    drawStaticBackground(this.bgGfx, layout.width, layout.height, layout.wallLineY);
    this.hudText = this.add
      .text(HUD_X, HUD_Y, '', {
        fontFamily: 'Consolas, "Courier New", monospace',
        fontSize: '26px',
        color: '#dff4ff',
        lineSpacing: 6,
      })
      .setDepth(10)
      .setShadow(0, 2, 'rgba(0,0,0,0.85)', 3);
    this.lastState = this.session.state;
    this.applyCameraBloom();
  }

  /** 相机轻度 bloom：让发光元素泛光。?fx=0 或 Canvas 渲染器（postFX 不可用）时跳过。 */
  private applyCameraBloom(): void {
    if (!this.fxEnabled || this.game.renderer.type !== Phaser.WEBGL) {
      return;
    }
    const postFX = this.cameras.main.postFX;
    if (!postFX) {
      return;
    }
    postFX.addBloom(0xffffff, 1, 1, 1, 0.85, 4);
  }

  override update(_time: number, delta: number): void {
    // restart 检测：state 被整体替换时重置本场景累计的派生值与全部瞬时特效。
    if (this.session.state !== this.lastState) {
      this.lastState = this.session.state;
      this.kills = 0;
      this.resetFx();
    }

    // 主循环对接：paused 时冻结模拟（升级面板用），渲染照常进行。
    // 调试速度（?speed=N）：每渲染帧连推 N 个子步——每个子步独立经过 core step 的
    // dt 钳制与 over 停摆，波形判定/升级暂停语义不变（paused 只在帧首检查，三选一
    // 面板弹出后从下一渲染帧起冻结，子步内不插入 drain）。
    if (!this.session.paused) {
      for (let i = 0; i < this.stepsPerFrame; i++) {
        this.session.step(delta);
      }
    }

    this.consumeEvents(this.session.drain());

    // 粒子推进：paused 冻结；帧长钳 50ms 防后台切回时大步跳变。
    const dt = this.session.paused ? 0 : Math.min(delta, 50);
    this.deathBurst.update(dt);
    this.muzzle.update(dt);
    this.waves.update(dt);

    this.renderWorld();
  }

  /** 换局清空：新 state 的 timeMs 从 0 起，全部瞬时特效与跟踪表作废。 */
  private resetFx(): void {
    this.flashUntil.clear();
    this.lastHp.clear();
    this.lastProjectileId = 0;
    this.blastWatermark = 0;
    this.dragonConeHoldUntil.clear();
    this.wallFlashUntilMs = 0;
    this.wallFlashStrength = 0;
    this.vignetteUntilMs = 0;
    this.vignetteStrength = 0;
    this.deathBurst.clear();
    this.muzzle.clear();
    this.waves.clear();
  }

  /**
   * 事件消费（每帧 drain 后调用）：先逐个转发给 session.onEvent（DOM 覆盖层，
   * levelUp 三选一 / gameOver 结算 / restart 都由它接管），再做场景内部消化：
   * 击杀计数 + 死亡爆裂粒子（Boss 加冲击波环）+ 墙受击震屏/红闪/vignette。
   * 转发与内部消化同帧同步执行：覆盖层在转发中置 paused=true 后，剩余事件仍会继续送达。
   */
  private consumeEvents(events: GameEvent[]): void {
    const s = this.session.state;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      this.session.onEvent?.(ev);
      switch (ev.kind) {
        case 'enemyKilled':
          this.kills += 1;
          // 死亡爆裂：碎片颜色/形状取被杀敌人的图鉴定义（Boss 加量加冲击波）。
          this.deathBurst.spawn(
            ev.x,
            ev.y,
            ENEMY_TYPES[ev.typeId]?.color ?? 0xffffff,
            ENEMY_TYPES[ev.typeId]?.shape ?? 'dot',
            ev.isBoss ? 16 : 7,
            ev.isBoss ? 1.5 : 1,
          );
          if (ev.isBoss) {
            this.waves.spawn(ev.x, ev.y, ENEMY_TYPES[ev.typeId]?.color ?? 0xffd24a, 16, 520, 520);
          }
          break;
        case 'levelUp':
          // DOM 覆盖层接管：暂停模拟 + 三选一面板（src/ui/overlay.ts）。
          break;
        case 'gameOver':
        case 'victory':
          // DOM 覆盖层接管：双模式结算面板（victory=守城成功 / gameOver=城墙陷落或
          // 无尽终章，见 src/ui/overlay.ts；模拟层已停摆：state.over 非 null）。
          break;
        case 'bossDefeated':
          // Boss 击杀表现已在 enemyKilled(isBoss) 处理（爆裂 + 冲击波）；
          // 墙回复提示由 DOM 覆盖层负责。
          break;
        case 'wallDamaged': {
          // 震屏（幅度随伤害量、短促）+ 墙体红闪 + 屏幕边缘红 vignette 一闪。
          const intensity = Math.min(0.014, 0.0025 + ev.amount * 0.00035);
          this.cameras.main.shake(130, intensity, false);
          this.wallFlashUntilMs = s.timeMs + WALL_FLASH_MS;
          this.wallFlashStrength = clamp01(ev.amount / 30);
          this.vignetteUntilMs = s.timeMs + 170;
          this.vignetteStrength = Math.max(this.vignetteStrength, clamp01(ev.amount / 26));
          break;
        }
        case 'enemySpawned':
        case 'sfx':
          // sfx 按名播放音效由并行任务负责（core 事件层），视图层不消费。
          break;
      }
    }
  }

  /**
   * 受击白闪跟踪：无「敌人受击」事件可用（不许改 core），在渲染层按 hp 帧间下降检测。
   * dead 敌人不触发；消失的敌人随手清理跟踪表（防长期游玩无界增长）。
   */
  private trackEnemyHits(s: SimState): void {
    const now = s.timeMs;
    this.seenIds.clear();
    for (let i = 0; i < s.enemies.length; i++) {
      const e = s.enemies[i];
      this.seenIds.add(e.id);
      const prev = this.lastHp.get(e.id);
      if (!e.dead && prev !== undefined && e.hp < prev) {
        this.flashUntil.set(e.id, now + ENEMY_FLASH_MS);
      }
      this.lastHp.set(e.id, e.hp);
    }
    for (const id of this.lastHp.keys()) {
      if (!this.seenIds.has(id)) {
        this.lastHp.delete(id);
        this.flashUntil.delete(id);
      }
    }
  }

  /** 开火反馈：新弹丸 id 出现 → 角色处枪口闪光（每帧至多 3 次，防霰弹连发堆叠过曝）。 */
  private detectNewProjectiles(s: SimState): void {
    let maxId = this.lastProjectileId;
    let spawned = 0;
    for (let i = 0; i < s.projectiles.length; i++) {
      const p = s.projectiles[i];
      if (p.id > maxId) {
        maxId = p.id;
        if (spawned < 3) {
          this.muzzle.spawn(s.character.x, s.character.y, 70);
          spawned += 1;
        }
      }
    }
    this.lastProjectileId = maxId;
  }

  /** 霓虹几何渲染当前帧：Graphics 立即模式整帧重绘（bg 静态层不重绘）。 */
  private renderWorld(): void {
    const g = this.gfx;
    const glow = this.glowGfx;
    const s = this.session.state;
    g.clear();
    glow.clear();

    this.trackEnemyHits(s);
    this.detectNewProjectiles(s);

    // —— 常规混合层：地面区域 → 榴弹落点提示 → 墙 → 修复包 → 敌人 → 角色 → HUD 条 ——
    this.drawZones(g, s);
    this.drawMortarGuides(g, s);
    this.drawWall(g, s);
    this.drawDrops(g, glow, s);

    for (let i = 0; i < s.enemies.length; i++) {
      const e = s.enemies[i];
      if (e.dead) {
        continue; // 尸体标记：渲染必须跳过
      }
      const until = this.flashUntil.get(e.id) ?? 0;
      const flash = until > s.timeMs ? clamp01((until - s.timeMs) / ENEMY_FLASH_MS) : 0;
      drawEnemy(g, e, flash, s.timeMs);
    }

    this.drawCharacter(g, glow, s);

    // —— ADD 发光层：meta VFX（光束/龙息锥）→ 敌人状态特效 → 弹丸 → 池化粒子 → 红 vignette ——
    this.drawMetaVfx(glow, s);
    for (let i = 0; i < s.enemies.length; i++) {
      const e = s.enemies[i];
      if (!e.dead && e.effects.length > 0) {
        drawEnemyStatusEffects(glow, e, s.timeMs);
      }
    }
    for (let i = 0; i < s.projectiles.length; i++) {
      const p = s.projectiles[i];
      if (!p.dead) {
        drawProjectile(glow, p, s);
      }
    }
    this.deathBurst.draw(glow);
    this.waves.draw(glow);
    this.muzzle.draw(glow);
    this.drawVignette(glow, s);

    this.renderHud(s);
  }

  /** 地面区域（meta.zones，listZones 只读）：半透明圆 + 边缘脉动。燃烧地=橙、酸池=绿。 */
  private drawZones(g: Phaser.GameObjects.Graphics, s: SimState): void {
    const zones = listZones(s);
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      const col = zoneColor(z.effectKind, z.color);
      const pulse = 0.5 + 0.5 * Math.sin(s.timeMs / 140 + z.x * 0.11 + z.y * 0.07);
      g.fillStyle(col, 0.13 + 0.05 * pulse);
      g.fillCircle(z.x, z.y, z.radius);
      g.lineStyle(2, col, 0.3 + 0.35 * pulse);
      g.strokeCircle(z.x, z.y, z.radius);
      g.lineStyle(1, col, 0.18);
      g.strokeCircle(z.x, z.y, z.radius * 0.66);
    }
  }

  /**
   * 迫击榴弹落点提示（母弹专用）：落点危险圈（半径 = data.aoeRadius，脉动 + 十字刻度）
   * + 「角色→落点」的虚线下坠弧线（二次贝塞尔隔段绘制，与弹体视觉弧线同一几何）。
   */
  private drawMortarGuides(g: Phaser.GameObjects.Graphics, s: SimState): void {
    const ch = s.character;
    for (let i = 0; i < s.projectiles.length; i++) {
      const p = s.projectiles[i];
      if (p.behavior !== 'mortar' || p.data.bomblet === 1) {
        continue;
      }
      const tx = p.data.tx;
      const ty = p.data.ty;
      const aoe = p.data.aoeRadius;
      if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
        continue;
      }
      const pulse = 0.5 + 0.5 * Math.sin(s.timeMs / 120);
      if (Number.isFinite(aoe) && aoe > 0) {
        g.lineStyle(1.5, 0x2fe05e, 0.25 + 0.3 * pulse);
        g.strokeCircle(tx, ty, aoe);
        g.lineStyle(1, 0x2fe05e, 0.35);
        for (let k = 0; k < 4; k++) {
          const a = (k * Math.PI) / 2;
          strokeLine(
            g,
            tx + Math.cos(a) * (aoe + 3),
            ty + Math.sin(a) * (aoe + 3),
            tx + Math.cos(a) * (aoe + 9),
            ty + Math.sin(a) * (aoe + 9),
            1,
            0x2fe05e,
            0.4,
          );
        }
      }
      const speed = Math.hypot(p.vx, p.vy);
      const dist = Math.hypot(tx - ch.x, ty - ch.y);
      if (speed <= 1e-6 || dist <= 20) {
        continue;
      }
      const h = Math.min(200, Math.max(60, dist * 0.32));
      const cx = (ch.x + tx) / 2;
      const cy = (ch.y + ty) / 2 - h;
      g.lineStyle(1.5, 0x2fe05e, 0.3);
      const STEPS = 18;
      let prevX = ch.x;
      let prevY = ch.y;
      for (let k = 1; k <= STEPS; k++) {
        const t = k / STEPS;
        const bx = bezier(ch.x, cx, tx, t);
        const by = bezier(ch.y, cy, ty, t);
        if (k % 2 === 1) {
          g.beginPath();
          g.moveTo(prevX, prevY);
          g.lineTo(bx, by);
          g.strokePath();
        }
        prevX = bx;
        prevY = by;
      }
    }
  }

  /** 墙：横条（血量青→红渐变）+ 顶缘高光 + 低血红色脉冲 + 受击红闪 + 上方血条。 */
  private drawWall(g: Phaser.GameObjects.Graphics, s: SimState): void {
    const layout = s.layout;
    const wallPct = s.wall.maxHp > 0 ? clamp01(s.wall.hp / s.wall.maxHp) : 0;
    const wallColor = healthColor(wallPct);
    const now = s.timeMs;

    g.fillStyle(wallColor, 0.95);
    g.fillRect(0, layout.wallLineY, layout.width, WALL_THICKNESS);
    g.fillStyle(0xffffff, 0.4); // 顶缘霓虹高光线
    g.fillRect(0, layout.wallLineY, layout.width, 2);

    if (wallPct < WALL_LOW_PCT) {
      // 低血（<30%）常驻红色脉冲警示。
      const pulse = 0.5 + 0.5 * Math.sin(now / 220);
      g.fillStyle(0xff2020, 0.18 + 0.28 * pulse);
      g.fillRect(0, layout.wallLineY, layout.width, WALL_THICKNESS);
    }
    if (now < this.wallFlashUntilMs) {
      // 受击红闪：短促，幅度随 wallDamaged.amount。
      const fade = clamp01((this.wallFlashUntilMs - now) / WALL_FLASH_MS);
      g.fillStyle(0xff3b30, 0.55 * fade * (0.4 + 0.6 * this.wallFlashStrength));
      g.fillRect(0, layout.wallLineY, layout.width, WALL_THICKNESS);
    }

    // 墙血条：墙上方细条（低血时外框同步脉冲）。
    const barW = layout.width - WALL_BAR_MARGIN * 2;
    const barY = layout.wallLineY - WALL_BAR_OFFSET;
    g.fillStyle(COLOR_TRACK, 1);
    g.fillRect(WALL_BAR_MARGIN, barY, barW, WALL_BAR_HEIGHT);
    g.fillStyle(wallColor, 1);
    g.fillRect(WALL_BAR_MARGIN, barY, barW * wallPct, WALL_BAR_HEIGHT);
    if (wallPct < WALL_LOW_PCT) {
      const pulse = 0.5 + 0.5 * Math.sin(now / 220);
      g.lineStyle(1.5, 0xff4040, 0.35 + 0.5 * pulse);
      g.strokeRect(WALL_BAR_MARGIN - 2, barY - 2, barW + 4, WALL_BAR_HEIGHT + 4);
    }
  }

  /** 修复包：白底方块 + 红十字 + 淡蓝描边 + ADD 微光。 */
  private drawDrops(
    g: Phaser.GameObjects.Graphics,
    glow: Phaser.GameObjects.Graphics,
    s: SimState,
  ): void {
    for (let i = 0; i < s.drops.length; i++) {
      const d = s.drops[i];
      glow.fillStyle(0xffffff, 0.1);
      glow.fillCircle(d.x, d.y, 13);
      g.fillStyle(0xf2f8ff, 0.95);
      g.fillRect(d.x - 7.5, d.y - 7.5, 15, 15);
      g.lineStyle(1.5, 0x8fd8ff, 0.9);
      g.strokeRect(d.x - 7.5, d.y - 7.5, 15, 15);
      g.fillStyle(0xff3b3b, 1);
      g.fillRect(d.x - 1.5, d.y - 5, 3, 10);
      g.fillRect(d.x - 5, d.y - 1.5, 10, 3);
    }
  }

  /** 角色：本体 + 亮描边 + 白色内核 + 呼吸光晕（ADD，正弦驱动）。 */
  private drawCharacter(
    g: Phaser.GameObjects.Graphics,
    glow: Phaser.GameObjects.Graphics,
    s: SimState,
  ): void {
    const cx = s.character.x;
    const cy = s.character.y;
    const breath = 0.5 + 0.5 * Math.sin(s.timeMs / 620);
    glow.fillStyle(COLOR_CHARACTER, 0.09 + 0.05 * breath);
    glow.fillCircle(cx, cy, 22 + 3 * breath);
    glow.fillStyle(COLOR_CHARACTER_STROKE, 0.07);
    glow.fillCircle(cx, cy, 32 + 4 * breath);
    g.fillStyle(COLOR_CHARACTER, 1);
    g.fillCircle(cx, cy, CHARACTER_RADIUS);
    g.lineStyle(2.5, COLOR_CHARACTER_STROKE, 1);
    g.strokeCircle(cx, cy, CHARACTER_RADIUS);
    glow.fillStyle(0xffffff, 0.75);
    glow.fillCircle(cx, cy - 3, 3.5);
  }

  /** meta VFX 分发（视图只读 meta，逐键前缀匹配；条目结构运行时守卫）。 */
  private drawMetaVfx(g: Phaser.GameObjects.Graphics, s: SimState): void {
    this.drawScatterDragonHint(g, s);
    for (const key in s.meta) {
      if (key.startsWith(HEAT_BEAM_VFX_PREFIX)) {
        this.drawHeatBeam(g, s, key.slice(HEAT_BEAM_VFX_PREFIX.length), s.meta[key]);
      } else if (key.startsWith(DRAGON_BREATH_VFX_PREFIX)) {
        this.drawDragonCone(g, s, key, s.meta[key]);
      } else if (key.startsWith(RAIL_VFX_PREFIX)) {
        this.drawRailBeam(g, s, s.meta[key]);
      }
    }
    this.drawMortarBlasts(g, s);
    this.drawPrismZapArcs(g, s);
  }

  /**
   * 霰弹 L8 龙息模式的常驻锥形提示：该模式不发弹丸且 core 未为其约定 meta VFX 键
   * （不可改 core），视图侧从武器定义按当前等级派生锥形几何（与 core breathCone 同式：
   * 顶点=角色、朝正上、半角 fanAngleDeg/2、射程 = projectileSpeed × ttlMs），低 alpha
   * 常驻渲染，避免「武器已切龙息但画面零表现」的观感断层。
   */
  private drawScatterDragonHint(g: Phaser.GameObjects.Graphics, s: SimState): void {
    const ids = Object.keys(s.weaponStates);
    for (let i = 0; i < ids.length; i++) {
      const def = WEAPON_DEFS[ids[i]];
      const ws = s.weaponStates[ids[i]];
      if (!def || !ws || def.behavior !== 'scatter_shot') {
        continue;
      }
      const stats = getWeaponStats(def, s, ids[i]);
      if (stats.dragonBreath !== 1 || !(stats.ttlMs > 0) || !(stats.projectileSpeed > 0)) {
        continue;
      }
      const ax = s.character.x;
      const ay = s.character.y;
      const R = stats.projectileSpeed * stats.ttlMs * 0.001;
      const half = (stats.fanAngleDeg * Math.PI) / 360;
      const dir = -Math.PI / 2;
      const e1 = dir - half;
      const e2 = dir + half;
      const flicker = 0.8 + 0.2 * Math.sin(s.timeMs / 90);
      g.fillStyle(0xff7a1a, 0.07 * flicker);
      g.fillPoints(
        [
          { x: ax, y: ay },
          { x: ax + Math.cos(e1) * R, y: ay + Math.sin(e1) * R },
          { x: ax + Math.cos(e2) * R, y: ay + Math.sin(e2) * R },
        ],
        true,
      );
      g.lineStyle(1.5, 0xffc46a, 0.22 * flicker);
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(ax + Math.cos(e1) * R, ay + Math.sin(e1) * R);
      g.moveTo(ax, ay);
      g.lineTo(ax + Math.cos(e2) * R, ay + Math.sin(e2) * R);
      g.strokePath();
    }
  }

  /**
   * 灼热光束（meta['heat_beam_vfx:<id>'] = { segments, untilMs }）：
   * 三层线段（宽泛光/中橙/白热芯）+ 两端白热点，按剩余留存时间线性淡出；
   * 光束宽度取该武器当前等级数值（数据表缺失回落 14）。
   */
  private drawHeatBeam(
    g: Phaser.GameObjects.Graphics,
    s: SimState,
    weaponId: string,
    raw: unknown,
  ): void {
    const vfx = raw as HeatBeamVfx | undefined;
    if (!vfx || !Array.isArray(vfx.segments)) {
      return;
    }
    const remain = vfx.untilMs - s.timeMs;
    if (remain <= 0) {
      return;
    }
    const fade = clamp01(remain / META_VFX_FADE_MS);
    let width = 14;
    const def = WEAPON_DEFS[weaponId];
    const ws = s.weaponStates[weaponId];
    if (def && ws) {
      const stats = getWeaponStats(def, s, weaponId);
      if (typeof stats.beamWidth === 'number' && stats.beamWidth > 0) {
        width = stats.beamWidth;
      }
    }
    for (let i = 0; i < vfx.segments.length; i++) {
      const seg = vfx.segments[i];
      if (!seg || !Number.isFinite(seg.x1 + seg.y1 + seg.x2 + seg.y2)) {
        continue;
      }
      strokeLine(g, seg.x1, seg.y1, seg.x2, seg.y2, width + 10, 0xff4d1a, 0.16 * fade);
      strokeLine(g, seg.x1, seg.y1, seg.x2, seg.y2, Math.max(3, width * 0.55), 0xff9d2e, 0.55 * fade);
      strokeLine(g, seg.x1, seg.y1, seg.x2, seg.y2, 2.5, 0xffe8b0, 0.95 * fade);
      g.fillStyle(0xffe8b0, 0.5 * fade);
      g.fillCircle(seg.x1, seg.y1, width * 0.3);
      g.fillCircle(seg.x2, seg.y2, width * 0.3);
    }
  }

  /**
   * 轨道贯穿炮射线（meta['rail_vfx:<id>'] = { segments, untilMs }，T5.2b hitscan 化）：
   * 该武器不再发射弹丸（drawProjectile 已无其分支），开火表现 = 一道贯穿全场的闪现射线。
   * 三层线段（宽青泛光 / 亮青内芯 / 白热芯）+ 射线根部白热枪口热点（hitscan 无弹丸、
   * 不再触发「新弹丸」枪口闪光，开火反馈画在射线根部），按剩余留存时间线性淡出。
   */
  private drawRailBeam(g: Phaser.GameObjects.Graphics, s: SimState, raw: unknown): void {
    const vfx = raw as RailVfx | undefined;
    if (!vfx || !Array.isArray(vfx.segments)) {
      return;
    }
    const remain = vfx.untilMs - s.timeMs;
    if (remain <= 0) {
      return;
    }
    const fade = clamp01(remain / RAIL_VFX_FADE_MS);
    const st = projectileStyle('piercing_bolt');
    for (let i = 0; i < vfx.segments.length; i++) {
      const seg = vfx.segments[i];
      if (!seg || !Number.isFinite(seg.x1 + seg.y1 + seg.x2 + seg.y2)) {
        continue;
      }
      strokeLine(g, seg.x1, seg.y1, seg.x2, seg.y2, 16, st.outer, 0.3 * fade);
      strokeLine(g, seg.x1, seg.y1, seg.x2, seg.y2, 7, st.core, 0.85 * fade);
      strokeLine(g, seg.x1, seg.y1, seg.x2, seg.y2, 2.5, st.hot, fade);
      g.fillStyle(st.hot, 0.8 * fade);
      g.fillCircle(seg.x1, seg.y1, 6);
      g.fillStyle(0xffffff, 0.5 * fade);
      g.fillCircle(seg.x1, seg.y1, 3);
    }
  }

  /**
   * 迫击榴弹落地爆炸（meta['mortar_blast_vfx'] = MortarBlastVfx[]，T5.2b）：
   * 母弹与子榴弹每次落地爆炸一条目。表现两层：
   * - 冲击波环：新条目（untilMs 超过水位线）入 RingWaves 池（绿系，半径从 0.25×aoe
   *   扩张到 aoe），扩张动画由池驱动；
   * - 中心闪光：白芯 + 绿晕随剩余留存时间线性淡出、随时间微微扩张（落地瞬间最亮）。
   * 水位线防同一条目重复入池；换局 resetFx 归零。
   */
  private drawMortarBlasts(g: Phaser.GameObjects.Graphics, s: SimState): void {
    const list = s.meta[MORTAR_BLAST_VFX_KEY];
    if (!Array.isArray(list)) {
      return;
    }
    const st = projectileStyle('mortar');
    let maxUntil = this.blastWatermark;
    for (let i = 0; i < list.length; i++) {
      const b = list[i] as MortarBlastVfx | undefined;
      if (!b || !Number.isFinite(b.x + b.y + b.radius + b.untilMs)) {
        continue;
      }
      if (b.untilMs > maxUntil) {
        maxUntil = b.untilMs;
      }
      const remain = b.untilMs - s.timeMs;
      if (remain <= 0) {
        continue; // 已过期：不再渲染（core 侧写入时滚动淘汰）
      }
      if (b.untilMs > this.blastWatermark) {
        // 新爆炸：冲击波环入池，寿命 = 留存时长，终径 = 爆炸半径。
        const r0 = Math.max(6, b.radius * 0.25);
        const r1 = Math.max(r0 + 1, b.radius);
        this.waves.spawn(b.x, b.y, st.outer, r0, (r1 - r0) / (MORTAR_BLAST_FADE_MS / 1000), MORTAR_BLAST_FADE_MS);
      }
      const fade = clamp01(remain / MORTAR_BLAST_FADE_MS);
      const grow = 1 + (1 - fade) * 1.6;
      g.fillStyle(st.core, 0.4 * fade);
      g.fillCircle(b.x, b.y, Math.max(10, b.radius * 0.34) * grow);
      g.fillStyle(st.hot, 0.9 * fade);
      g.fillCircle(b.x, b.y, Math.max(4, b.radius * 0.14) * grow);
    }
    this.blastWatermark = maxUntil;
  }

  /**
   * 弹射棱镜连锁闪电电弧（meta['prism_zap_vfx'] = PrismZapSegment[]）：
   * 每次连锁闪电直击额外目标时记录一条线段，留存 100ms 线性淡出。
   * 取两怪中点沿垂线法向量做抖动折点，绘制 3 段式折线电弧；
   * 双层发光线：外圈粗线（width: 3.5, color: 0x8a3cff）+ 内芯亮线（width: 1.5, color: 0xffffff）+ 两端高亮光斑。
   */
  private drawPrismZapArcs(g: Phaser.GameObjects.Graphics, s: SimState): void {
    const list = s.meta[PRISM_ZAP_VFX_KEY];
    if (!Array.isArray(list)) {
      return;
    }
    for (let i = 0; i < list.length; i++) {
      const seg = list[i] as PrismZapSegment | undefined;
      if (!seg || !Number.isFinite(seg.x1 + seg.y1 + seg.x2 + seg.y2 + seg.untilMs)) {
        continue;
      }
      const remain = seg.untilMs - s.timeMs;
      if (remain <= 0) {
        continue;
      }
      const fade = clamp01(remain / 100);
      const dx = seg.x2 - seg.x1;
      const dy = seg.y2 - seg.y1;
      const dist = Math.hypot(dx, dy);
      if (dist < 1) {
        continue;
      }
      const nx = -dy / dist;
      const ny = dx / dist;
      const jitter = Math.sin(s.timeMs * 0.05 + i * 2.3 + seg.x1) * Math.min(12, dist * 0.25);
      const p1x = seg.x1 + dx * 0.33 + nx * jitter;
      const p1y = seg.y1 + dy * 0.33 + ny * jitter;
      const p2x = seg.x1 + dx * 0.67 - nx * jitter * 0.8;
      const p2y = seg.y1 + dy * 0.67 - ny * jitter * 0.8;

      // 外圈粗线（width: 3.5, color: 0x8a3cff, alpha 随 fade）
      g.lineStyle(3.5, PRISM_ZAP_COLORS.outer, 0.85 * fade);
      g.beginPath();
      g.moveTo(seg.x1, seg.y1);
      g.lineTo(p1x, p1y);
      g.lineTo(p2x, p2y);
      g.lineTo(seg.x2, seg.y2);
      g.strokePath();

      // 内芯亮线（width: 1.5, color: 0xffffff, alpha 随 fade）
      g.lineStyle(1.5, PRISM_ZAP_COLORS.hot, fade);
      g.beginPath();
      g.moveTo(seg.x1, seg.y1);
      g.lineTo(p1x, p1y);
      g.lineTo(p2x, p2y);
      g.lineTo(seg.x2, seg.y2);
      g.strokePath();

      // 两端高亮光斑
      g.fillStyle(PRISM_ZAP_COLORS.core, 0.6 * fade);
      g.fillCircle(seg.x1, seg.y1, 4);
      g.fillCircle(seg.x2, seg.y2, 4);
      g.fillStyle(PRISM_ZAP_COLORS.hot, 0.9 * fade);
      g.fillCircle(seg.x1, seg.y1, 2);
      g.fillCircle(seg.x2, seg.y2, 2);
    }
  }

  /**
   * 龙息锥（meta['dragon_breath_vfx:<id>'] = { untilMs, coneRange, coneAngleDeg }）：
   * 顶点 = 角色位、朝正上。双层锥面（宽外锥 + 窄内芯）+ 两缘亮线 + 射程端弧，
   * 火焰闪烁 + 淡出。T5.2b 可感知度加强：core meta 仅留存 80ms 而喷射 tick 间隔 150ms，
   * 逐帧淡出会在 tick 之间出现「锥形闪烁断层」——视图在每次读到新鲜 meta 时把本地驻留
   * 延长到 DRAGON_CONE_VIEW_HOLD_MS（持续喷射期间连续可见，停喷后 150ms 自然淡出），
   * 并整体上调 alpha（外锥/内芯/边缘线），内芯改为高 alpha 窄锥突出火焰核心。
   */
  private drawDragonCone(g: Phaser.GameObjects.Graphics, s: SimState, key: string, raw: unknown): void {
    const vfx = raw as DragonBreathVfx | undefined;
    if (!vfx || !(vfx.coneRange > 0) || !(vfx.coneAngleDeg > 0)) {
      return;
    }
    const holdUntil = Math.max(
      this.dragonConeHoldUntil.get(key) ?? 0,
      s.timeMs + DRAGON_CONE_VIEW_HOLD_MS,
    );
    this.dragonConeHoldUntil.set(key, holdUntil);
    const remain = holdUntil - s.timeMs;
    if (remain <= 0) {
      return;
    }
    const fade = clamp01(remain / DRAGON_CONE_VIEW_HOLD_MS);
    const flicker = 0.85 + 0.15 * Math.sin(s.timeMs / 33);
    const ax = s.character.x;
    const ay = s.character.y;
    const dir = -Math.PI / 2; // 朝正上
    const half = (vfx.coneAngleDeg * Math.PI) / 360; // 半角（全角/2）
    const R = vfx.coneRange;
    const e1 = dir - half;
    const e2 = dir + half;
    const x1 = ax + Math.cos(e1) * R;
    const y1 = ay + Math.sin(e1) * R;
    const x2 = ax + Math.cos(e2) * R;
    const y2 = ay + Math.sin(e2) * R;

    g.fillStyle(0xff7a1a, 0.24 * fade * flicker);
    g.fillPoints(
      [
        { x: ax, y: ay },
        { x: x1, y: y1 },
        { x: x2, y: y2 },
      ],
      true,
    );
    const half2 = half * 0.55;
    g.fillStyle(0xffc46a, 0.45 * fade * flicker);
    g.fillPoints(
      [
        { x: ax, y: ay },
        { x: ax + Math.cos(dir - half2) * R, y: ay + Math.sin(dir - half2) * R },
        { x: ax + Math.cos(dir + half2) * R, y: ay + Math.sin(dir + half2) * R },
      ],
      true,
    );
    const half3 = half * 0.22;
    g.fillStyle(0xffedb0, 0.5 * fade * flicker);
    g.fillPoints(
      [
        { x: ax, y: ay },
        { x: ax + Math.cos(dir - half3) * R, y: ay + Math.sin(dir - half3) * R },
        { x: ax + Math.cos(dir + half3) * R, y: ay + Math.sin(dir + half3) * R },
      ],
      true,
    );
    g.lineStyle(2.5, 0xffc46a, 0.85 * fade);
    g.beginPath();
    g.moveTo(ax, ay);
    g.lineTo(x1, y1);
    g.lineTo(x2, y2);
    g.strokePath();
    g.beginPath();
    g.arc(ax, ay, R, e1, e2);
    g.strokePath();
  }

  /**
   * 屏幕边缘红色 vignette：wallDamaged 后一闪（强度随伤害量）；
   * 墙低血（<30%）时叠加常驻微弱红色脉冲。三层内缩矩形模拟渐隐边缘（ADD 红光）。
   */
  private drawVignette(g: Phaser.GameObjects.Graphics, s: SimState): void {
    const now = s.timeMs;
    let intensity = 0;
    if (now < this.vignetteUntilMs) {
      intensity = clamp01((this.vignetteUntilMs - now) / 170) * (0.35 + 0.65 * this.vignetteStrength);
    }
    const wallPct = s.wall.maxHp > 0 ? clamp01(s.wall.hp / s.wall.maxHp) : 0;
    if (wallPct < WALL_LOW_PCT) {
      intensity = Math.max(intensity, 0.05 + 0.04 * Math.sin(now / 220));
    }
    if (intensity <= 0.005) {
      return;
    }
    const w = s.layout.width;
    const h = s.layout.height;
    g.lineStyle(18, 0xff2020, 0.3 * intensity);
    g.strokeRect(9, 9, w - 18, h - 18);
    g.lineStyle(12, 0xff2020, 0.18 * intensity);
    g.strokeRect(24, 24, w - 48, h - 48);
    g.lineStyle(8, 0xff2020, 0.1 * intensity);
    g.strokeRect(40, 40, w - 80, h - 80);
  }

  /**
   * HUD 武器列表行：如「武器 轨道贯穿炮 Lv.1」，多把武器以「、」连接
   * （顺序 = weaponStates 键序，确定性）。数据表缺该武器 id 时退回显示 id（不抛错）。
   */
  private weaponLine(s: SimState): string {
    const ids = Object.keys(s.weaponStates);
    if (ids.length === 0) {
      return '武器 无';
    }
    const parts: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const name = WEAPON_DEFS[id]?.name ?? id;
      parts.push(`${name} Lv.${s.weaponStates[id].level}`);
    }
    return `武器 ${parts.join('、')}`;
  }

  /** HUD（左上角等宽字体）：当前模式 / 存活时间 mm:ss / 等级 / 击杀数 / 武器列表 + 细经验条。 */
  private renderHud(s: SimState): void {
    const modeLabel = this.session.mode === 'endless' ? '无尽' : '通关';
    this.hudText.setText(
      `模式 ${modeLabel}\n存活 ${this.formatTime(s.timeMs)}\n等级 ${s.progress.level}\n击杀 ${this.kills}\n${this.weaponLine(s)}`,
    );

    const need = xpToNext(s);
    const xpPct = need > 0 && Number.isFinite(need) ? clamp01(s.progress.xp / need) : 0;
    const g = this.gfx;
    g.fillStyle(COLOR_TRACK, 1);
    g.fillRect(HUD_X, XP_BAR_Y, XP_BAR_WIDTH, XP_BAR_HEIGHT);
    g.fillStyle(COLOR_XP_FILL, 1);
    g.fillRect(HUD_X, XP_BAR_Y, XP_BAR_WIDTH * xpPct, XP_BAR_HEIGHT);
  }

  private formatTime(timeMs: number): string {
    const totalSec = Math.floor(Math.max(0, timeMs) / 1000);
    const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const ss = String(totalSec % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }
}
