// 主场景：霓虹几何渲染（T4.3；T6a 敌人 / T6b 弹丸渲染升级为预烘焙纹理 + 池化 Image，结构不变）。
// SimState → 混合式每帧重绘：敌人本体/白闪/血条走 enemyRenderer 的池化 Image（零矢量
// 三角化），弹丸走 projectileRenderer 的池化 ADD Image（零矢量三角化），其余保持 Graphics
// 立即模式。分层（depth 从低到高）：
//   bg（depth 0）：静态背景，create 时一次性绘制星点/网格/结界光带，不逐帧重算；
//   underGfx（depth 1，常规混合）：地面区域、榴弹落点提示、墙、修复包、Boss 光环/血条金框；
//   敌人池化 Image（depth 2~2.16，enemyRenderer 管理）：本体 → 白闪剪影 → 血条槽 → 血条填充；
//   overGfx（depth 3，常规混合）：角色本体、HUD 条；
//   glow（depth 4，ADD 叠加混合）：meta VFX（光束/榴弹爆炸）/敌人状态特效
//   （矢量或降级光环）/弹丸池化 Image（projectileRenderer，T6b）/角色光晕/死亡爆裂/
//   枪口闪光/红 vignette。
// 主循环对接：update 内 step（paused 时冻结模拟、渲染照常）→ drainEvents → 渲染当前帧。
// 事件消费约定：全部事件逐个转发给 session.onEvent（src/ui 的 DOM 覆盖层注册）；
// 场景内部消化：击杀计数（HUD 用）+ 视觉反馈（enemyKilled 死亡爆裂/Boss 冲击波、
// wallDamaged 震屏/墙体红闪/红 vignette）。受击白闪无事件可用，在渲染层按
// 「敌人 hp 较上一帧下降」检测（T4.3 约定）；开火反馈用「新弹丸 id 出现」触发枪口闪光。
import Phaser from 'phaser';
import { xpToNext } from '../core/gems';
import { listZones } from '../core/zones';
import type { CoordinatedFireVfx, HeatBeamVfx } from '../core/behaviors/behavior_heatBeam';
import { COORDINATED_FIRE_VFX_MS } from '../core/behaviors/behavior_heatBeam';
import type { RailVfx } from '../core/behaviors/behavior_piercingBolt';
import type { MortarBlastVfx } from '../core/behaviors/behavior_mortar';
import type { PrismZapSegment } from '../core/behaviors/behavior_prismChain';
import {
  SNIPER_CRIT_VFX_MS,
  SNIPER_EXECUTE_VFX_MS,
  type SniperHitVfx,
} from '../core/behaviors/behavior_chargeSniper';
import { SEISMIC_SWEEP_MS, type SeismicPulseVfx } from '../core/behaviors/behavior_seismicPulse';
import type { GameEvent } from '../core/events';
import type { Enemy, SimState } from '../core/types';
import type { GameSession } from '../game/session';
import { loadWeaponDefs } from '../data/weapons';
import { loadEnemyTypes } from '../data/enemies';
import {
  AURA_POOL_CAP,
  EnemyRenderer,
  ENEMY_FLASH_MS,
  STATUS_FX_VECTOR_THRESHOLD,
} from './enemyRenderer';
import { ProjectileRenderer } from './projectileRenderer';
import {
  COORDINATED_COLORS,
  COORDINATED_FIRE_VFX_KEY,
  DeathBurst,
  HEAT_BEAM_VFX_PREFIX,
  MORTAR_BLAST_VFX_KEY,
  MuzzleFlashes,
  PRISM_ZAP_COLORS,
  PRISM_ZAP_VFX_KEY,
  RAIL_VFX_PREFIX,
  RingWaves,
  SEISMIC_PULSE_COLORS,
  SEISMIC_PULSE_VFX_KEY,
  SNIPER_CRIT_COLORS,
  SNIPER_CRIT_VFX_KEY,
  SNIPER_EXECUTE_COLORS,
  SNIPER_EXECUTE_VFX_KEY,
  STATUS_EFFECT_COLORS,
  COLOR_TRACK,
  bezier,
  drawStaticBackground,
  projectileStyle,
  zoneColor,
} from './fx';

// —— 布局/样式常量（视图层允许硬编码；页面深色底 #05050d） ——

const WALL_THICKNESS = 20; // 墙体横条高度
const WALL_BAR_MARGIN = 40; // 墙血条左右留边
const WALL_BAR_HEIGHT = 8;
const WALL_BAR_OFFSET = 20; // 墙血条距墙线的上移量
const CHARACTER_RADIUS = 14;
const HUD_X = 16;
const HUD_Y = 12;
const XP_BAR_Y = 188; // 四行 HUD 文本下方（模式/时间/等级/击杀；武器行已改为胶囊芯片，见 G1）
const XP_BAR_WIDTH = 224;
const XP_BAR_HEIGHT = 8;

// —— 武器胶囊芯片（G1）：每武器一枚独立芯片，替代原五行 HUD 的「武器 A、B、…」拼接行 ——

/**
 * 芯片竖排锚定经验条【下方】（裁量）：经验条上方仅剩 ~54px 空隙，放不下多枚芯片；
 * 下方到墙线（wallLineY=1160）有巨大余量。栏位上限 config.maxWeaponSlots = 4
 * （upgrade.ts 以「拥有数 < maxWeaponSlots」限制新武器出现）→ 单列至多 4 枚 ≈ 100px 高
 * （底部 ≈ y 304），任何武器数都不可能溢出画布，无需两列折行兜底（8 把假设亦只需 ~200px）。
 */
const CHIP_X = HUD_X;
const CHIP_START_Y = XP_BAR_Y + XP_BAR_HEIGHT + 10; // 206：经验条下沿留 10px 间隙
const CHIP_HEIGHT = 20;
const CHIP_STRIDE = 25; // 芯片高 20 + 行距 5
const CHIP_PAD_X = 9; // 芯片文本左右内边距（宽度随文本自适应）
const CHIP_RADIUS = 10;
/** 芯片底色（深底，霓虹描边风格与全局一致）。 */
const CHIP_BG = 0x0b1120;

/** 芯片三档配色：Lv.0 灰调（未强化）/ Lv.1~9 常规白（霓虹青描边）/ 满级金描边 MAX。 */
const CHIP_STYLE_LV0 = { stroke: 0x5a6478, text: '#8f98ab' };
const CHIP_STYLE_STD = { stroke: 0x6fc3ff, text: '#f2faff' };
const CHIP_STYLE_MAX = { stroke: 0xffd24a, text: '#ffe89a' };

/** 城墙低血量警示阈值（<30% 常驻红色脉冲）。 */
const WALL_LOW_PCT = 0.3;
/** 城墙受击红闪时长 ms（与 wallDamaged 事件触发的震屏时长同量级）。 */
const WALL_FLASH_MS = 150;
/** meta VFX 留存 80ms（core 任务锁定常量），视图按剩余时间线性淡出。 */
const META_VFX_FADE_MS = 80;
/** 灼热光束固定视觉宽度 px（单体锁定束：不再从 stats.beamWidth 读取——该键已随重做删除）。 */
const HEAT_BEAM_DRAW_WIDTH = 10;
/** 轨道炮射线留存 100ms（core rail VFX 任务锁定常量），视图按剩余时间线性淡出。 */
const RAIL_VFX_FADE_MS = 100;
/** 榴弹爆炸 VFX 留存 320ms（与 core MORTAR_BLAST_VFX_MS 一致），淡出与冲击环扩张共用。 */
const MORTAR_BLAST_FADE_MS = 320;
/** 震波壁垒 sweep 结束后的淡出留存 300ms（与 core SEISMIC_PULSE_VFX_MS 一致），按剩余留存线性淡出。 */
const SEISMIC_PULSE_FADE_MS = 300;
/** 震波壁垒震屏参数（轻微，复用 wallDamaged 的相机 shake 基建；一次性、水位线防重复）。 */
const SEISMIC_SHAKE_MS = 160;
const SEISMIC_SHAKE_INTENSITY = 0.005;
/**
 * 榴弹爆炸中心闪光的 glow 层活动实例上限（T6b）：meta 列表由 core 滚动淘汰过期条目
 * （数组按入队序排列），但留存窗口内条目数本身无界——视图侧只画最近 32 条（跳过最旧，
 * 与 DeathBurst/RingWaves 等池类的「超限丢弃最旧」语义一致），中心闪光至多 2 个圆/条，
 * 封顶高密度连爆帧的矢量绘制量。冲击环入池另由 RingWaves 自身容量兜底。
 */
const MORTAR_BLAST_DRAW_CAP = 32;

const COLOR_XP_FILL = 0x8be9fd;
const COLOR_CHARACTER = 0xffe066;
const COLOR_CHARACTER_STROKE = 0xfff6c0; // 角色亮描边（霓虹高光）

/** 武器定义表（HUD 武器列表行名称用；数据表只加载一次、内容共享只读）。 */
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

// 多边形顶点 scratch：预分配复用，避免每帧为每个敌人分配点对象（strokePoints 需切片）。
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

// —— 敌人霓虹几何形 ——

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

export class MainScene extends Phaser.Scene {
  private readonly session: GameSession;
  /** 调试速度：构造时捕获的每帧子步数（main.ts 读 ?speed=N 后经 setStepsPerFrame 注入）。 */
  private readonly stepsPerFrame: number;
  /** 相机 postFX 降级开关（?fx=0 关闭；Canvas 渲染器下 postFX 不可用，自动跳过）。 */
  private readonly fxEnabled: boolean;

  private bgGfx!: Phaser.GameObjects.Graphics; // 静态背景（一次性）
  private underGfx!: Phaser.GameObjects.Graphics; // 常规混合·底层：区域/墙/修复包/Boss 覆盖层
  private overGfx!: Phaser.GameObjects.Graphics; // 常规混合·顶层：角色/HUD 条
  private glowGfx!: Phaser.GameObjects.Graphics; // ADD 混合：发光层
  /** 敌人渲染器（T6a）：预烘焙纹理 + 池化 Image（本体/白闪/血条/降级光环）。 */
  private enemyRenderer!: EnemyRenderer;
  /** 弹丸渲染器（T6b）：预烘焙纹理 + 池化 ADD Image（按 behavior 分弹种贴图）。 */
  private projectileRenderer!: ProjectileRenderer;
  private hudText!: Phaser.GameObjects.Text;
  /** 武器胶囊芯片底（G1）：仅武器键集/等级 diff 变化时才 clear+重绘，稳态零写入。 */
  private chipGfx!: Phaser.GameObjects.Graphics;
  /** 武器胶囊芯片文本常驻池（G1）：按需懒建、复用、隐藏多余，不逐帧 new 对象。 */
  private chipTexts: Phaser.GameObjects.Text[] = [];
  /** 芯片 diff 基准（G1）：上帧的武器 id 序与等级序（仅变化时更新）。 */
  private chipIds: string[] = [];
  private chipLevels: number[] = [];
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
  /** 震波壁垒脉冲 meta 水位线（untilMs 单调递增）：新脉冲 → 一次轻微震屏，防重复触发。 */
  private seismicWatermark = 0;
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
    this.underGfx = this.add.graphics().setDepth(1);
    this.overGfx = this.add.graphics().setDepth(3);
    this.glowGfx = this.add.graphics().setDepth(4).setBlendMode(Phaser.BlendModes.ADD);
    const layout = this.session.state.layout;
    drawStaticBackground(this.bgGfx, layout.width, layout.height, layout.wallLineY);
    // 敌人渲染池（T6a）：create 时按图鉴逐类型烘焙本体/白闪/光环纹理，并建满固定容量池。
    // 容量 = maxEnemies + 34 余量（core 实体护栏封顶 350 → 池 384）；上限 512 防坏配置爆池。
    const cfgMax = this.session.state.config.maxEnemies;
    const poolCap =
      Number.isFinite(cfgMax) && cfgMax > 0 ? Math.min(cfgMax + 34, 512) : 384;
    this.enemyRenderer = new EnemyRenderer(this, ENEMY_TYPES, poolCap, AURA_POOL_CAP);
    // 弹丸渲染池（T6b）：create 时按 behavior 烘焙弹体贴图（glow 光晕烘进贴图），并建满
    // 固定容量池（ADD Image）。容量 = maxProjectiles + 40 余量（core 硬上限 600 → 池 640，
    // 吸收同帧内的瞬时超额）；上限 640 防坏配置爆池。
    const cfgMaxProj = this.session.state.config.maxProjectiles;
    const projPoolCap =
      Number.isFinite(cfgMaxProj) && cfgMaxProj > 0 ? Math.min(cfgMaxProj + 40, 640) : 640;
    this.projectileRenderer = new ProjectileRenderer(this, projPoolCap);
    this.hudText = this.add
      .text(HUD_X, HUD_Y, '', {
        fontFamily: 'Consolas, "Courier New", monospace',
        fontSize: '26px',
        color: '#dff4ff',
        lineSpacing: 6,
      })
      .setDepth(10)
      .setShadow(0, 2, 'rgba(0,0,0,0.85)', 3);
    // 武器胶囊芯片层（G1）：depth 同 hudText（10），压在敌人/弹丸之上；仅 diff 变化时重绘。
    this.chipGfx = this.add.graphics().setDepth(10);
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
    this.seismicWatermark = 0;
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

  /**
   * 霓虹几何渲染当前帧（bg 静态层不重绘）：underGfx/overGfx/glow 三个 Graphics 立即
   * 模式整帧重绘 + 敌人/弹丸走 enemyRenderer / projectileRenderer 池化 Image
   * （T6a/T6b，零矢量三角化）。
   */
  private renderWorld(): void {
    const under = this.underGfx;
    const over = this.overGfx;
    const glow = this.glowGfx;
    const s = this.session.state;
    under.clear();
    over.clear();
    glow.clear();

    this.trackEnemyHits(s);
    this.detectNewProjectiles(s);

    // —— 常规混合·底层：地面区域 → 榴弹落点提示 → 墙 → 修复包 → Boss 光环/血条金框 ——
    this.drawZones(under, s);
    this.drawMortarGuides(under, s);
    this.drawWall(under, s);
    this.drawDrops(under, glow, s);
    this.enemyRenderer.drawBossOverlays(under, s);

    // —— 池化敌人 Image（本体/白闪/血条，数组序 = 槽序 = 绘制序，与原立即模式一致）——
    // 状态特效降级开关：状态敌 ≤ 阈值逐敌绘制矢量微粒/冰晶（视觉最丰富）；超阈值整体
    // 切换为预烘焙光环贴图（ADD 池化 Image + 正弦脉动），高密度局不做大量矢量 tessellation。
    const useVectorStatusFx =
      this.enemyRenderer.countStatusEnemies(s) <= STATUS_FX_VECTOR_THRESHOLD;
    this.enemyRenderer.sync(s, this.flashUntil, s.timeMs, !useVectorStatusFx);

    // —— 常规混合·顶层：角色（在敌人之后画，与原层级一致） ——
    this.drawCharacter(over, glow, s);

    // —— ADD 发光层：meta VFX（光束）→ 敌人状态特效 → 弹丸 → 池化粒子 → 红 vignette ——
    this.drawMetaVfx(glow, s);
    if (useVectorStatusFx) {
      for (let i = 0; i < s.enemies.length; i++) {
        const e = s.enemies[i];
        if (!e.dead && e.effects.length > 0) {
          drawEnemyStatusEffects(glow, e, s.timeMs);
        }
      }
    }
    // （降级路径：状态光环已由 EnemyRenderer 以池化 ADD Image 绘制在本层；ADD 混合
    // 可交换，与弹丸的层内先后顺序不影响合成结果。）
    // 弹丸（T6b）：池化 ADD Image 逐帧属性覆写（烘焙纹理含 glow 光晕），移除原逐弹
    // 矢量重绘——活弹数百时 Graphics tessellation 是最大渲染瓶颈，现稳态零三角化零分配。
    this.projectileRenderer.sync(s);
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
    for (const key in s.meta) {
      if (key.startsWith(HEAT_BEAM_VFX_PREFIX)) {
        this.drawHeatBeam(g, s, key.slice(HEAT_BEAM_VFX_PREFIX.length), s.meta[key]);
      } else if (key.startsWith(RAIL_VFX_PREFIX)) {
        this.drawRailBeam(g, s, s.meta[key]);
      } else if (key === SEISMIC_PULSE_VFX_KEY) {
        this.drawSeismicPulse(g, s, s.meta[key]);
      }
    }
    this.drawMortarBlasts(g, s);
    this.drawPrismZapArcs(g, s);
    this.drawSniperCritBursts(g, s);
    this.drawSniperExecutes(g, s);
    this.drawCoordinatedFire(g, s);
  }

  /**
   * 灼热光束（meta['heat_beam_vfx:<id>'] = { segments, untilMs }，段序 = [主束, 次级束?]）：
   * 单体锁定持续光束——主束从角色连到锁定目标（三层线段：宽泛光/中橙/白热芯），
   * 次级束（index ≥ 1，持第二闪光牌）用紫罗兰区分色同款三层；两端白热点，
   * 按剩余留存时间线性淡出。视觉宽度为固定常量（单体束不再从 stats 读 beamWidth）。
   */
  private drawHeatBeam(
    g: Phaser.GameObjects.Graphics,
    s: SimState,
    weaponId: string,
    raw: unknown,
  ): void {
    void weaponId; // 视觉宽度为固定常量：不再按武器 stats 读取（保留参数与分发签名一致）
    const vfx = raw as HeatBeamVfx | undefined;
    if (!vfx || !Array.isArray(vfx.segments)) {
      return;
    }
    const remain = vfx.untilMs - s.timeMs;
    if (remain <= 0) {
      return;
    }
    const fade = clamp01(remain / META_VFX_FADE_MS);
    for (let i = 0; i < vfx.segments.length; i++) {
      const seg = vfx.segments[i];
      if (!seg || !Number.isFinite(seg.x1 + seg.y1 + seg.x2 + seg.y2)) {
        continue;
      }
      // 段序 = [主束, 次级束?]：主束橙色系，次级束紫罗兰区分色。
      const outer = i === 0 ? 0xff4d1a : 0x9d5cff;
      const core = i === 0 ? 0xff9d2e : 0xc084ff;
      const hot = i === 0 ? 0xffe8b0 : 0xf2e6ff;
      strokeLine(g, seg.x1, seg.y1, seg.x2, seg.y2, HEAT_BEAM_DRAW_WIDTH + 10, outer, 0.16 * fade);
      strokeLine(g, seg.x1, seg.y1, seg.x2, seg.y2, Math.max(3, HEAT_BEAM_DRAW_WIDTH * 0.55), core, 0.55 * fade);
      strokeLine(g, seg.x1, seg.y1, seg.x2, seg.y2, 2.5, hot, 0.95 * fade);
      g.fillStyle(hot, 0.5 * fade);
      g.fillCircle(seg.x1, seg.y1, HEAT_BEAM_DRAW_WIDTH * 0.3);
      g.fillCircle(seg.x2, seg.y2, HEAT_BEAM_DRAW_WIDTH * 0.3);
    }
  }

  /**
   * 轨道贯穿炮射线（meta['rail_vfx:<id>'] = { segments, untilMs }，T5.2b hitscan 化）：
   * 该武器不再发射弹丸，开火表现 = 一道贯穿全场的闪现射线。
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
   * 震波壁垒行进波（meta['seismic_pulse_vfx'] = sweep 状态本体，共享单键；视图只读
   * SeismicPulseVfx 视图字段 { startMs, waveDistance, thickness, untilMs }）：横贯全屏的
   * 亮波前从墙线出发向上行进——波前位置 = wallLineY − waveDistance × min(elapsed, 400ms)/400ms，
   * 与模拟层共享同一几何常量 SEISMIC_SWEEP_MS（扫掠时长恒定，范围强化提高的是波前速度与
   * 最终距离）；已扫过区带（墙线 → 波前）以半透明金橙填充随行进增长，sweep 结束
   * （400ms）后波前驻留终点、整体按剩余留存时间线性淡出。新 sweep（startMs 水位线判定，
   * 一次性）触发一次轻微震屏（复用 wallDamaged 的 cameras.main.shake 基建，幅度约其一半）。
   * 余震不写 VFX，无次要表现。
   */
  private drawSeismicPulse(g: Phaser.GameObjects.Graphics, s: SimState, raw: unknown): void {
    const vfx = raw as SeismicPulseVfx | undefined;
    if (
      !vfx ||
      !Number.isFinite(vfx.startMs + vfx.waveDistance + vfx.thickness + vfx.untilMs) ||
      vfx.waveDistance < 0
    ) {
      return;
    }
    const remain = vfx.untilMs - s.timeMs;
    if (remain <= 0) {
      return;
    }
    if (vfx.startMs > this.seismicWatermark) {
      this.seismicWatermark = vfx.startMs;
      this.cameras.main.shake(SEISMIC_SHAKE_MS, SEISMIC_SHAKE_INTENSITY, false);
    }
    const fade = clamp01(remain / SEISMIC_PULSE_FADE_MS);
    // 波前推进：与模拟层同几何（elapsed 钳制在扫掠时长内），sweep 结束后驻留终点随 fade 淡出。
    const elapsed = s.timeMs - vfx.startMs;
    const progress = clamp01(elapsed / SEISMIC_SWEEP_MS);
    const wallY = s.layout.wallLineY;
    const frontY = wallY - vfx.waveDistance * progress;
    // 已扫过区带：从波前到墙线的半透明金橙填充（行进波的可视行进痕迹，随行进增长）。
    const swept = wallY - frontY;
    if (swept > 0) {
      g.fillStyle(SEISMIC_PULSE_COLORS.outer, 0.1 * fade);
      g.fillRect(0, frontY, s.layout.width, swept);
    }
    // 波前：三层横线（宽泛光 / 亮芯 / 白热）。
    strokeLine(g, 0, frontY, s.layout.width, frontY, 14, SEISMIC_PULSE_COLORS.outer, 0.3 * fade);
    strokeLine(g, 0, frontY, s.layout.width, frontY, 6, SEISMIC_PULSE_COLORS.core, 0.8 * fade);
    strokeLine(g, 0, frontY, s.layout.width, frontY, 2, SEISMIC_PULSE_COLORS.hot, fade);
    // 波前厚度提示：上沿一条微弱辅助线（勾出 |y − 波前| ≤ thickness 的判定带视觉边界）。
    strokeLine(
      g, 0, frontY - vfx.thickness, s.layout.width, frontY - vfx.thickness,
      2, SEISMIC_PULSE_COLORS.outer, 0.12 * fade,
    );
    // 墙线能量线：随 fade 淡出的金色亮线（震源）。
    strokeLine(g, 0, wallY, s.layout.width, wallY, 4, SEISMIC_PULSE_COLORS.core, 0.5 * fade);
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
    // 活动条目计数：超上限时跳过最旧条目不画（数组按入队序排列，头部即最旧）。
    let liveCount = 0;
    for (let i = 0; i < list.length; i++) {
      const b = list[i] as MortarBlastVfx | undefined;
      if (b && Number.isFinite(b.x + b.y + b.radius + b.untilMs) && b.untilMs > s.timeMs) {
        liveCount += 1;
      }
    }
    const skipOldest = Math.max(0, liveCount - MORTAR_BLAST_DRAW_CAP);
    let liveSeen = 0;
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
      if (liveSeen++ < skipOldest) {
        continue; // 超上限的最旧条目：跳过不画（确定性丢弃最旧）
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
   * 蓄能狙击爆头星芒环（meta['sniper_crit_vfx'] = SniperHitVfx[]，G5）：
   * 每次爆头判中由模拟层记录一条命中点条目，留存 200ms（core SNIPER_CRIT_VFX_MS 同源，
   * 导入常量避免两处漂移）线性淡出。表现 = 金色星芒 8 道（内端随进度外移、光芒伸长，
   * 「甩出」感）+ 扩散环 + 白热中心点；全部为条目序号与剩余时间的纯函数，零分配立即
   * 模式重绘；条目间基角按序号错开，同帧多爆头不重叠成同一形态。
   */
  private drawSniperCritBursts(g: Phaser.GameObjects.Graphics, s: SimState): void {
    const list = s.meta[SNIPER_CRIT_VFX_KEY];
    if (!Array.isArray(list)) {
      return;
    }
    for (let i = 0; i < list.length; i++) {
      const v = list[i] as SniperHitVfx | undefined;
      if (!v || !Number.isFinite(v.x + v.y + v.untilMs)) {
        continue;
      }
      const remain = v.untilMs - s.timeMs;
      if (remain <= 0) {
        continue; // 已过期：不再渲染（core 侧写入时滚动淘汰）
      }
      const t = 1 - clamp01(remain / SNIPER_CRIT_VFX_MS); // 0→1 生命进度
      const fade = clamp01(remain / SNIPER_CRIT_VFX_MS);
      const innerR = 3 + 14 * t;
      const rayLen = 7 + 9 * t;
      const rot = i * 0.4;
      for (let k = 0; k < 8; k++) {
        const a = rot + (k * Math.PI) / 4;
        const cosA = Math.cos(a);
        const sinA = Math.sin(a);
        strokeLine(
          g,
          v.x + cosA * (innerR - 1.5),
          v.y + sinA * (innerR - 1.5),
          v.x + cosA * (innerR + rayLen + 2),
          v.y + sinA * (innerR + rayLen + 2),
          4.5,
          SNIPER_CRIT_COLORS.outer,
          0.22 * fade,
        );
        strokeLine(
          g,
          v.x + cosA * innerR,
          v.y + sinA * innerR,
          v.x + cosA * (innerR + rayLen),
          v.y + sinA * (innerR + rayLen),
          2,
          SNIPER_CRIT_COLORS.core,
          0.85 * fade,
        );
      }
      // 扩散环：半径随进度增长、透明度衰减（双层：宽泛光 + 亮芯）。
      const ringR = 5 + 26 * t;
      g.lineStyle(5, SNIPER_CRIT_COLORS.outer, 0.18 * fade);
      g.strokeCircle(v.x, v.y, ringR + 2);
      g.lineStyle(2.5, SNIPER_CRIT_COLORS.core, 0.55 * fade);
      g.strokeCircle(v.x, v.y, ringR);
      // 白热中心点：命中瞬间最亮，随进度收缩。
      g.fillStyle(SNIPER_CRIT_COLORS.hot, 0.9 * fade);
      g.fillCircle(v.x, v.y, Math.max(0.5, 3.5 * (1 - t)));
    }
  }

  /**
   * 蓄能狙击死刑宣告斩杀（meta['sniper_execute_vfx'] = SniperHitVfx[]，G5）：
   * 处决触发时由模拟层记录目标坐标，留存 300ms（core SNIPER_EXECUTE_VFX_MS 同源）快速
   * 淡出。表现两层：
   * - 暗红竖贯斩线：从目标上方（钳回屏内）贯穿到战场底部（墙线），三层线宽（宽泛光 /
   *   亮芯 / 灼白高光）；
   * - 红色能量迸散：目标位置 8 道短斩痕向外放射（确定性：等分角 + 条目序号偏移基角），
   *   随进度外扩淡出。
   * 与共享 DeathBurst 池无关（独立轻量绘制）；不做震屏（用户明确要求，本函数无相机操作）。
   */
  private drawSniperExecutes(g: Phaser.GameObjects.Graphics, s: SimState): void {
    const list = s.meta[SNIPER_EXECUTE_VFX_KEY];
    if (!Array.isArray(list)) {
      return;
    }
    const wallY = s.layout.wallLineY;
    for (let i = 0; i < list.length; i++) {
      const v = list[i] as SniperHitVfx | undefined;
      if (!v || !Number.isFinite(v.x + v.y + v.untilMs)) {
        continue;
      }
      const remain = v.untilMs - s.timeMs;
      if (remain <= 0) {
        continue;
      }
      const t = 1 - clamp01(remain / SNIPER_EXECUTE_VFX_MS);
      const fade = clamp01(remain / SNIPER_EXECUTE_VFX_MS);
      // 竖贯斩线：目标上方 120px（不足则钳回屏顶）一直切到墙线。
      const topY = Math.max(0, v.y - 120);
      strokeLine(g, v.x, topY, v.x, wallY, 12, SNIPER_EXECUTE_COLORS.outer, 0.3 * fade);
      strokeLine(g, v.x, topY, v.x, wallY, 5, SNIPER_EXECUTE_COLORS.core, 0.75 * fade);
      strokeLine(g, v.x, topY, v.x, wallY, 1.8, SNIPER_EXECUTE_COLORS.hot, 0.95 * fade);
      // 能量迸散：8 道放射短斩痕。
      const innerR = 5 + 16 * t;
      const len = 6 + 14 * t;
      const rot = i * 0.55 + 0.35;
      for (let k = 0; k < 8; k++) {
        const a = rot + (k * Math.PI) / 4;
        const cosA = Math.cos(a);
        const sinA = Math.sin(a);
        strokeLine(
          g,
          v.x + cosA * innerR,
          v.y + sinA * innerR,
          v.x + cosA * (innerR + len),
          v.y + sinA * (innerR + len),
          2.2,
          SNIPER_EXECUTE_COLORS.core,
          0.7 * fade,
        );
      }
      g.fillStyle(SNIPER_EXECUTE_COLORS.hot, 0.8 * fade);
      g.fillCircle(v.x, v.y, Math.max(0.5, 4 * (1 - t)));
    }
  }

  /**
   * 灼热光束协同开火触发脉冲（meta['coordinated_fire_vfx'] = CoordinatedFireVfx 单对象，G6）：
   * 任一目标协同计数达阈值触发全队齐射的瞬间由模拟层覆写一条（坐标 = 触发目标当前位置，
   * 单键覆写 = 同屏至多一个活跃脉冲），留存 350ms（core COORDINATED_FIRE_VFX_MS 同源导入，
   * 避免 350 语义两处漂移），前 60% 扩散、后 40% 淡出。表现两层：
   * - 触发目标：金/青双色扩散双环（金外环领先、青内环跟随）+ 8 道交替金/青短芒（「同步
   *   脉冲」感）+ 白热中心点；
   * - 玩家（画布固定角色位）：小型同色响应双环（表示「全队收到」），随扩散微微放大。
   * 全部为条目坐标与剩余时间的纯函数，零分配立即模式重绘；不做震屏（与 G5 同约定）。
   * 齐射被目标中途死亡终止时模拟层不回滚条目：本函数只认 untilMs，自然过期，无需特判。
   */
  private drawCoordinatedFire(g: Phaser.GameObjects.Graphics, s: SimState): void {
    const v = s.meta[COORDINATED_FIRE_VFX_KEY] as CoordinatedFireVfx | undefined;
    if (!v || !Number.isFinite(v.x + v.y + v.untilMs)) {
      return;
    }
    const remain = v.untilMs - s.timeMs;
    if (remain <= 0) {
      return; // 已过期：不再渲染（模拟层下次触发覆写，无需视图清理）
    }
    const t = 1 - clamp01(remain / COORDINATED_FIRE_VFX_MS); // 0→1 生命进度
    // 前 60% 扩散（0→1）、后 40% 淡出（1→0）。
    const expand = clamp01(t / 0.6);
    const fade = t < 0.6 ? 1 : clamp01(1 - (t - 0.6) / 0.4);

    // —— 触发目标：金/青双色扩散双环（金外环领先、青内环跟随）——
    const goldR = 6 + 36 * expand;
    const cyanR = 2 + 26 * expand;
    g.lineStyle(5, COORDINATED_COLORS.goldOuter, 0.22 * fade);
    g.strokeCircle(v.x, v.y, goldR + 2);
    g.lineStyle(2.5, COORDINATED_COLORS.goldCore, 0.7 * fade);
    g.strokeCircle(v.x, v.y, goldR);
    g.lineStyle(4, COORDINATED_COLORS.cyanOuter, 0.2 * fade);
    g.strokeCircle(v.x, v.y, cyanR + 2);
    g.lineStyle(2, COORDINATED_COLORS.cyanCore, 0.65 * fade);
    g.strokeCircle(v.x, v.y, cyanR);

    // —— 8 道短芒：交替金/青，随扩散外移伸长（基角固定等分，确定性）——
    const innerR = 4 + 12 * expand;
    const rayLen = 5 + 8 * expand;
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      const cosA = Math.cos(a);
      const sinA = Math.sin(a);
      const rayColor = k % 2 === 0 ? COORDINATED_COLORS.goldCore : COORDINATED_COLORS.cyanCore;
      strokeLine(
        g,
        v.x + cosA * innerR,
        v.y + sinA * innerR,
        v.x + cosA * (innerR + rayLen),
        v.y + sinA * (innerR + rayLen),
        2,
        rayColor,
        0.8 * fade,
      );
    }
    // 白热中心点：触发瞬间最亮，随进度收缩。
    g.fillStyle(COORDINATED_COLORS.hot, 0.9 * fade);
    g.fillCircle(v.x, v.y, Math.max(0.5, 3.5 * (1 - t)));

    // —— 玩家响应环（画布固定角色位）：小型同色响应双环，「全队收到」 ——
    const px = s.character.x;
    const py = s.character.y;
    const pGoldR = 5 + 4 * expand;
    const pCyanR = 11 + 7 * expand;
    g.lineStyle(3, COORDINATED_COLORS.cyanOuter, 0.16 * fade);
    g.strokeCircle(px, py, pCyanR + 1.5);
    g.lineStyle(1.5, COORDINATED_COLORS.cyanCore, 0.55 * fade);
    g.strokeCircle(px, py, pCyanR);
    g.lineStyle(1.5, COORDINATED_COLORS.goldCore, 0.4 * fade);
    g.strokeCircle(px, py, pGoldR);
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

  /** HUD（左上角等宽字体）：当前模式 / 存活时间 mm:ss / 等级 / 击杀数 + 细经验条；武器列表改为胶囊芯片（G1）。 */
  private renderHud(s: SimState): void {
    const bossKills = (s.meta.bossKills as number | undefined) ?? 0;
    const modeLabel =
      this.session.mode === 'endless'
        ? '模式 无尽'
        : `模式 通关 (${bossKills}/6)`;
    this.hudText.setText(
      `${modeLabel}\n存活 ${this.formatTime(s.timeMs)}\n等级 ${s.progress.level}\n击杀 ${this.kills}`,
    );
    this.syncWeaponChips(s);

    const need = xpToNext(s);
    const xpPct = need > 0 && Number.isFinite(need) ? clamp01(s.progress.xp / need) : 0;
    const g = this.overGfx;
    g.fillStyle(COLOR_TRACK, 1);
    g.fillRect(HUD_X, XP_BAR_Y, XP_BAR_WIDTH, XP_BAR_HEIGHT);
    g.fillStyle(COLOR_XP_FILL, 1);
    g.fillRect(HUD_X, XP_BAR_Y, XP_BAR_WIDTH * xpPct, XP_BAR_HEIGHT);
  }

  /**
   * 武器胶囊芯片同步（G1）：每帧与 weaponStates 的键序/等级逐项 diff——无变化零写入
   * （Text 不 setText / 不改样式，chipGfx 不重绘），仅键集或任一等级变化时更新对应芯片
   * 并整帧重绘芯片底。芯片文本为常驻池：按需懒建、复用、隐藏多余，不逐帧 new 对象。
   * 布局：竖排左对齐锚定经验条下方（CHIP_START_Y 起、CHIP_STRIDE 行距），宽度按文本
   * 自适应 + 内边距；栏位上限 config.maxWeaponSlots = 4 → 单列至多 4 枚（详见 CHIP_START_Y
   * 处注释），不溢出画布。武器顺序 = weaponStates 键序（addWeapon 插入序，确定性）；
   * 数据表缺该武器 id 时退回显示 id（不抛错）。
   * 等级表现：Lv.0 灰调（未强化）/ Lv.1~9 常规白 / 达到该武器 maxLevel 金描边 +「MAX」
   * 角标替代 Lv.n 字样（无解锁后的 Lv.11+ 歧义：满级即 MAX，突破上限继续叠牌仍是满级）。
   */
  private syncWeaponChips(s: SimState): void {
    const ids = Object.keys(s.weaponStates);

    // —— diff：键序与等级逐项比对（长度 + 每项值），无变化直接返回（零写入） ——
    let changed = ids.length !== this.chipIds.length || ids.length !== this.chipLevels.length;
    if (!changed) {
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (id !== this.chipIds[i] || s.weaponStates[id].level !== this.chipLevels[i]) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) {
      return;
    }

    // —— 同步芯片文本（仅变化项 setText/改样式/改位；新增项懒建） ——
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const level = s.weaponStates[id].level;
      if (
        i < this.chipTexts.length &&
        id === this.chipIds[i] &&
        level === this.chipLevels[i] &&
        this.chipTexts[i].visible
      ) {
        continue; // 该芯片无变化
      }
      const text = this.chipTexts[i] ?? this.createChipText();
      const def = WEAPON_DEFS[id];
      const maxed = level >= (def?.maxLevel ?? 10);
      const style = maxed ? CHIP_STYLE_MAX : level <= 0 ? CHIP_STYLE_LV0 : CHIP_STYLE_STD;
      text.setText(maxed ? `${def?.name ?? id} MAX` : `${def?.name ?? id} Lv.${level}`);
      text.setColor(style.text);
      text.setPosition(
        CHIP_X + CHIP_PAD_X,
        CHIP_START_Y + i * CHIP_STRIDE + (CHIP_HEIGHT - text.height) / 2,
      );
      text.setVisible(true);
    }
    for (let i = ids.length; i < this.chipTexts.length; i++) {
      this.chipTexts[i].setVisible(false); // 武器减少（换局等）：多余芯片隐藏（池保留复用）
    }

    // —— 重绘芯片底（仅 diff 变化时）：圆角描边底，宽度随当前文本自适应 ——
    const g = this.chipGfx;
    g.clear();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const level = s.weaponStates[id].level;
      const def = WEAPON_DEFS[id];
      const maxed = level >= (def?.maxLevel ?? 10);
      const style = maxed ? CHIP_STYLE_MAX : level <= 0 ? CHIP_STYLE_LV0 : CHIP_STYLE_STD;
      const w = (this.chipTexts[i]?.width ?? 0) + CHIP_PAD_X * 2;
      const y = CHIP_START_Y + i * CHIP_STRIDE;
      g.fillStyle(CHIP_BG, 0.55);
      g.fillRoundedRect(CHIP_X, y, w, CHIP_HEIGHT, CHIP_RADIUS);
      g.lineStyle(1.5, style.stroke, maxed ? 1 : 0.85);
      g.strokeRoundedRect(CHIP_X, y, w, CHIP_HEIGHT, CHIP_RADIUS);
    }

    // —— 记录 diff 基准（Object.keys 每帧返回新数组，可安全持有） ——
    this.chipIds = ids;
    const levels: number[] = [];
    for (let i = 0; i < ids.length; i++) {
      levels.push(s.weaponStates[ids[i]].level);
    }
    this.chipLevels = levels;
  }

  /** 新建一枚芯片文本（常驻池懒建；字体/投影基线与 hudText 一致，仅字号缩小）。 */
  private createChipText(): Phaser.GameObjects.Text {
    const text = this.add
      .text(0, 0, '', {
        fontFamily: 'Consolas, "Courier New", monospace',
        fontSize: '14px',
        color: '#f2faff',
      })
      .setDepth(10)
      .setShadow(0, 1, 'rgba(0,0,0,0.85)', 2);
    this.chipTexts.push(text);
    return text;
  }

  private formatTime(timeMs: number): string {
    const totalSec = Math.floor(Math.max(0, timeMs) / 1000);
    const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const ss = String(totalSec % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }
}
