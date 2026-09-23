// src/phaser/enemyRenderer.ts —— 敌人渲染 T6a：预烘焙纹理 + 池化 Image（T4.3 矢量立即模式升级）。
// 背景：原 renderWorld 每帧对每敌做 3~4 次矢量重绘（微光外圈描边 + 主描边 + 暗色填充 +
// 血条 3 矩形 + Boss 光环），Phaser Graphics 每条命令都要 JS 侧重灌命令缓冲并 CPU 三角化，
// 350 只敌人时是最大渲染瓶颈。本模块把「敌人静态本体」在 create 时逐类型烘焙成贴图，
// 运行时只对池化 Image 做 setPosition / setTexture / setVisible 复用——
// 稳态每帧零对象分配、零创建零销毁、零三角化。
// 纹理清单（generateTexture 一次性烘焙，canvas/webgl 双渲染器通用）：
//   enemy_body_<typeId>   敌人本体（微光外圈 + 高饱和描边 + 暗色填充，与原 drawEnemy 静态层一致）
//   enemy_flash_<typeId>  同尺寸白色剪影（受击白闪：常规叠加 + alpha 渐隐，替代 tintFill 全贴变白）
//   enemy_aura_<kind>     状态特效降级光环 ×4（冰蓝/毒绿/橙红/金色圆环，ADD 层池化 Image）
//   fx_white1             1×1 白纹理（血条：tint 着色 + scaleX 拉伸）
// 分层契约（与原 renderWorld 输出层级一致，见 mainScene.renderWorld）：
//   underGfx（depth 1，常规混合）< 池化敌人 Image（depth 2~2.16，槽序微深度递增保证数组序）
//   < overGfx（depth 3：角色/HUD 条）< glow（depth 4，ADD：meta VFX/状态特效/弹丸/粒子）。
import Phaser from 'phaser';
import type { EnemyTypeData } from '../core/enemies';
import type { Enemy, SimState } from '../core/types';
import { COLOR_TRACK, STATUS_EFFECT_COLORS } from './fx';

// —— Boss 视觉常量（自 mainScene 迁入：Boss 光环/血条金框随本模块的池化血条一起绘制） ——

export const COLOR_BOSS_RING = 0xffd24a; // Boss 旋转外圈光环 / 血条金框
export const COLOR_BOSS_RING_INNER = 0xffe9b0;

/** 敌人受击白闪时长 ms（hp 下降检测触发；mainScene.trackEnemyHits 复用同一常量）。 */
export const ENEMY_FLASH_MS = 120;

/**
 * 状态特效矢量降级阈值：状态敌（持有 slow/chill/poison/burn/stun 之一）数量 ≤ 该值时
 * 逐敌绘制矢量微粒/冰晶（视觉最丰富）；超过阈值整体切换为预烘焙光环贴图（ADD 池化
 * Image + 正弦 alpha 脉动），保证高密度局（core 实体护栏 maxEnemies=350）不做大量
 * 矢量 tessellation。视图层常量（约定允许硬编码），取 350 的 ~23%。
 */
export const STATUS_FX_VECTOR_THRESHOLD = 80;

/** 降级光环池容量：350 敌 × 平均 2 种状态 + 余量；超出按敌人数组序截断（确定性）。 */
export const AURA_POOL_CAP = 768;

// —— 纹理键 ——
export const ENEMY_TEXTURE_MAP: Record<string, string> = {
  runner: 'enemy_runner',
  standard: 'enemy_standard',
  tank: 'enemy_tank',
  boss_1: 'enemy_boss_1',
};

/** 各敌人素材的长边基准像素（用于按 logical radius 进行精准等比 setScale）。 */
export const ENEMY_SPRITE_SIZES: Record<string, number> = {
  runner: 1107,
  standard: 991,
  tank: 1204,
  boss_1: 1015,
};

const AURA_PREFIX = 'enemy_aura_';
const WHITE_KEY = 'fx_white1';
/** 兜底类型：typeId 不在图鉴（坏表防御）时用白色块。 */
const FALLBACK_TYPE = '__fallback';

// —— 分层深度 ——
/** 池槽微深度步长：类别间距（0.05）大于全部槽跨度（512 × 0.00001 = 0.00512），槽序=绘制序。 */
const SLOT_DEPTH_EPS = 0.00001;
const ENEMY_DEPTH_BASE = 2; // 敌人 Image 层（underGfx=1 之上、overGfx=3 之下）
const AURA_DEPTH_BASE = 4; // 降级光环层（与 glow Graphics 同层；ADD 混合与顺序无关）

// —— 血条几何（与原 drawEnemy 逐值一致） ——
const HP_BAR_HEIGHT = 4;
const HP_BAR_HEIGHT_BOSS = 6;
const HP_BAR_GAP = 10; // 血条距本体顶部
const HP_BAR_GAP_BOSS = 22;

// —— 降级光环贴图参数：96×96、圆环半径 40（运行时按敌人半径 setScale 缩放） ——
const AURA_TEX_SIZE = 96;
const AURA_RING_R = 40;
const AURA_SCALE_MARGIN = 7; // 光环半径 = 敌人绘制半径 + 7

/** Boss 本体绘制半径放大系数（与原 drawEnemy 一致）。 */
function bossScale(): number {
  return 1.15;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 敌人血条颜色：pct=1 → 绿，pct=0 → 红（自 mainScene 迁入）。
 * pct 量化到 1/24 步长：Canvas 渲染器的 tint 贴图按颜色缓存，量化后缓存条目有界
 * （≤25 种），WebGL 路径无差别（4px 高血条上 24 级色彩肉眼不可辨）。
 */
export function hpBarColor(pct: number): number {
  const t = Math.round(clamp01(pct) * 24) / 24;
  const r = Math.round(255 * (1 - t));
  const g = Math.round(40 + 180 * t);
  return (r << 16) | (g << 8) | 0x28;
}


/**
 * 启动期烘焙辅助纹理（1x1 白纹理用于血条拉伸，4 种降级状态光环）。
 * 敌人本体已切换为预加载的高品质素材。
 */
function ensureEnemyTextures(scene: Phaser.Scene): void {
  const tex = scene.textures;
  const g = scene.make.graphics({ x: 0, y: 0 });

  // 1×1 白纹理：血条槽/填充的基础贴图（tint 着色 + setScale 拉伸）。
  if (!tex.exists(WHITE_KEY)) {
    g.fillStyle(0xffffff, 1);
    g.fillRect(0, 0, 1, 1);
    g.generateTexture(WHITE_KEY, 1, 1);
    g.clear();
  }

  // 降级状态光环 ×4（色取 fx.ts 状态配色表的外圈色，内芯叠一条白线提亮）。
  bakeAura(g, 'chill', STATUS_EFFECT_COLORS.chillOuter);
  bakeAura(g, 'poison', STATUS_EFFECT_COLORS.poisonOuter);
  bakeAura(g, 'burn', STATUS_EFFECT_COLORS.burnOuter);
  bakeAura(g, 'stun', STATUS_EFFECT_COLORS.stunRing);

  g.destroy();
}

/** 烘焙一张状态光环贴图：软泛光环 + 高亮主环 + 白色内芯线。 */
function bakeAura(g: Phaser.GameObjects.Graphics, kind: string, color: number): void {
  if (g.scene.textures.exists(AURA_PREFIX + kind)) {
    return;
  }
  const c = AURA_TEX_SIZE / 2;
  g.lineStyle(9, color, 0.22);
  g.strokeCircle(c, c, AURA_RING_R);
  g.lineStyle(3, color, 0.9);
  g.strokeCircle(c, c, AURA_RING_R);
  g.lineStyle(1.5, 0xffffff, 0.45);
  g.strokeCircle(c, c, AURA_RING_R);
  g.generateTexture(AURA_PREFIX + kind, AURA_TEX_SIZE, AURA_TEX_SIZE);
  g.clear();
}

// —— Boss Graphics 立即模式覆盖层（Boss 同屏极少，保留矢量绘制） ——

/**
 * Boss 旋转外圈光环：4 段宽微光弧 + 4 段亮弧同速正转，内圈细环反转（state.timeMs 驱动）。
 * 自 mainScene 迁入，逻辑逐行不变。
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

// —— 池槽 ——

/** 一只敌人的池化对象组：本体 / 白闪剪影 / 血条槽 / 血条填充。 */
interface EnemySlot {
  body: Phaser.GameObjects.Image;
  flash: Phaser.GameObjects.Image;
  barTrack: Phaser.GameObjects.Image;
  barFill: Phaser.GameObjects.Image;
}

/** 状态种类位掩码（降级光环用）：bit0 chill(slow/chill)、bit1 poison、bit2 burn、bit3 stun。 */
const KIND_CHILL = 1;
const KIND_POISON = 2;
const KIND_BURN = 4;
const KIND_STUN = 8;
/** 位序 → 光环贴图键（与 KIND_* 位定义一一对应）。 */
const AURA_KEYS = [
  AURA_PREFIX + 'chill',
  AURA_PREFIX + 'poison',
  AURA_PREFIX + 'burn',
  AURA_PREFIX + 'stun',
];

/** 敌人 effects → 视觉状态位掩码（零分配；kind 集合与 drawEnemyStatusEffects 一致）。 */
function statusKindMask(e: Enemy): number {
  let mask = 0;
  const fx = e.effects;
  for (let k = 0; k < fx.length; k++) {
    const kind = fx[k].kind;
    if (kind === 'slow' || kind === 'chill') {
      mask |= KIND_CHILL;
    } else if (kind === 'poison') {
      mask |= KIND_POISON;
    } else if (kind === 'burn') {
      mask |= KIND_BURN;
    } else if (kind === 'stun') {
      mask |= KIND_STUN;
    }
  }
  return mask;
}

/**
 * 敌人渲染器：create 时烘焙纹理并建满固定容量池，此后每帧只做属性覆写。
 * 容量 = maxEnemies + 余量（core 实体护栏封顶 350 → 池 384）；Boss 同池、只按 typeId 换贴图。
 * 超出池容量的敌人按数组序截断不渲染（防御路径：core 护栏内不会发生）。
 */
export class EnemyRenderer {
  private readonly slots: EnemySlot[] = [];
  private readonly auras: Phaser.GameObjects.Image[] = [];
  /** typeId → 纹理键（含兜底；Map.get 返回引用，每帧零字符串拼接分配）。 */
  private readonly bodyKeys = new Map<string, string>();

  constructor(
    scene: Phaser.Scene,
    types: Record<string, EnemyTypeData>,
    capacity: number,
    auraCapacity: number,
  ) {
    ensureEnemyTextures(scene);

    this.bodyKeys.set(FALLBACK_TYPE, WHITE_KEY);
    for (const id in types) {
      this.bodyKeys.set(id, ENEMY_TEXTURE_MAP[id] ?? WHITE_KEY);
    }

    // 敌人池：深度一次设好、此后不再改动（不触发显示列表重排）。
    // 槽内层级：本体 → 白闪 → 血条槽 → 血条填充（类别间距 0.05 > 槽跨度）。
    for (let i = 0; i < capacity; i++) {
      const d = ENEMY_DEPTH_BASE + i * SLOT_DEPTH_EPS;
      const body = scene.add
        .image(0, -200, WHITE_KEY)
        .setOrigin(0.5, 0.5)
        .setVisible(false)
        .setDepth(d);
      const flash = scene.add
        .image(0, -200, WHITE_KEY)
        .setOrigin(0.5, 0.5)
        .setVisible(false)
        .setDepth(d + 0.05);
      const barTrack = scene.add
        .image(0, -200, WHITE_KEY)
        .setOrigin(0, 0.5)
        .setTint(COLOR_TRACK)
        .setVisible(false)
        .setDepth(d + 0.1);
      const barFill = scene.add
        .image(0, -200, WHITE_KEY)
        .setOrigin(0, 0.5)
        .setVisible(false)
        .setDepth(d + 0.15);
      this.slots.push({ body, flash, barTrack, barFill });
    }

    // 降级状态光环池：ADD 层池化 Image（ADD 混合可交换，与 glow 层内其他元素的
    // 绘制先后不影响合成结果）。深度一次设好。
    for (let i = 0; i < auraCapacity; i++) {
      const img = scene.add
        .image(0, -200, AURA_KEYS[0])
        .setOrigin(0.5, 0.5)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setVisible(false)
        .setDepth(AURA_DEPTH_BASE + i * SLOT_DEPTH_EPS);
      this.auras.push(img);
    }
  }

  /**
   * 状态敌计数（持有 slow/chill/poison/burn/stun 之一的存活敌）。
   * 供 mainScene 决定走矢量微粒（≤ 阈值）还是降级光环（> 阈值）。
   */
  countStatusEnemies(s: SimState): number {
    let count = 0;
    const enemies = s.enemies;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.dead || e.effects.length === 0) {
        continue;
      }
      const fx = e.effects;
      for (let k = 0; k < fx.length; k++) {
        const kind = fx[k].kind;
        if (
          kind === 'slow' ||
          kind === 'chill' ||
          kind === 'poison' ||
          kind === 'burn' ||
          kind === 'stun'
        ) {
          count += 1;
          break;
        }
      }
    }
    return count;
  }

  /**
   * 每帧同步：按 state.enemies 数组顺序占用池槽（跳 dead；数组序 = 槽序 = 绘制序，
   * 与原立即模式绘制顺序一致）。只做 setPosition/setTexture/setVisible/setAlpha/
   * setTint/setScale，稳态零对象分配、零创建零销毁。未占用槽位全部隐藏。
   */
  sync(s: SimState, flashUntil: Map<number, number>, timeMs: number, useAuraFx: boolean): void {
    const enemies = s.enemies;
    const slots = this.slots;
    const auras = this.auras;
    let slot = 0;
    let aura = 0;

    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.dead) {
        continue; // 尸体标记：渲染必须跳过（与原 renderWorld 一致）
      }
      if (slot >= slots.length) {
        break; // 超出池容量：按数组序截断（防御路径，core 护栏内不会发生）
      }
      const st = slots[slot];

      // 本体：贴图随 typeId 切换，根据敌人 logic radius 缩放。
      const r = e.isBoss ? e.radius * bossScale() : e.radius;
      const baseSize = ENEMY_SPRITE_SIZES[e.typeId] ?? 1000;
      const scale = (r * 2.2) / baseSize;

      st.body
        .setTexture(this.bodyKeys.get(e.typeId) ?? this.bodyKeys.get(FALLBACK_TYPE) ?? WHITE_KEY)
        .setPosition(e.x, e.y)
        .setScale(scale)
        .setVisible(true);

      // 受击白闪：直接使用 Phaser WebGL 原生 setTintFill(0xffffff) 实现瞬间白闪
      const until = flashUntil.get(e.id) ?? 0;
      if (until > timeMs) {
        st.body.setTintFill(0xffffff);
      } else {
        st.body.clearTint();
      }
      st.flash.setVisible(false);

      // 头顶血条：槽（深色 tint）+ 填充（左中 origin、scaleX=pct、tint 随 pct 渐变）。
      const barW = e.isBoss ? e.radius * 2.8 : e.radius * 2;
      const barH = e.isBoss ? HP_BAR_HEIGHT_BOSS : HP_BAR_HEIGHT;
      const barY = e.y - r - (e.isBoss ? HP_BAR_GAP_BOSS : HP_BAR_GAP);
      st.barTrack.setPosition(e.x - barW / 2, barY + barH / 2).setScale(barW, barH).setVisible(true);
      const pct = e.maxHp > 0 ? clamp01(e.hp / e.maxHp) : 0;
      if (pct > 0) {
        st.barFill
          .setPosition(e.x - barW / 2, barY + barH / 2)
          .setScale(barW * pct, barH)
          .setTint(hpBarColor(pct))
          .setVisible(true);
      } else {
        st.barFill.setVisible(false);
      }

      // 降级状态光环：每种视觉状态一枚 ADD 圆环（正弦 alpha 脉动），池超额按序截断。
      if (useAuraFx && e.effects.length > 0 && aura < auras.length) {
        const mask = statusKindMask(e);
        if (mask !== 0) {
          const ringScale = (r + AURA_SCALE_MARGIN) / AURA_RING_R;
          for (let bit = 0; bit < AURA_KEYS.length && aura < auras.length; bit++) {
            if ((mask & (1 << bit)) === 0) {
              continue;
            }
            auras[aura]
              .setTexture(AURA_KEYS[bit])
              .setPosition(e.x, e.y)
              .setScale(ringScale)
              .setAlpha(0.45 + 0.2 * Math.sin(timeMs * 0.006 + e.id * 1.7 + bit * 2.1))
              .setVisible(true);
            aura += 1;
          }
        }
      }

      slot += 1;
    }

    // 隐藏本帧未占用的槽位（可见性标记，渲染器直接跳过）。
    for (let i = slot; i < slots.length; i++) {
      const st = slots[i];
      st.body.clearTint();
      st.body.setVisible(false);
      st.flash.setVisible(false);
      st.barTrack.setVisible(false);
      st.barFill.setVisible(false);
    }
    for (let i = aura; i < auras.length; i++) {
      auras[i].setVisible(false);
    }
  }

  /**
   * Boss 专属覆盖层（Graphics 立即模式，Boss 同屏极少）：旋转外圈光环 +
   * 加宽血条的金色描边框（血条本体已池化，框比条大 2px 不重叠）。
   * 由 mainScene 画在 underGfx（墙/修复包之后、敌人 Image 与角色之前），与原
   * 「敌人数组序内 Boss 先画」的相对层级一致（光环在敌人本体之下）。
   */
  drawBossOverlays(g: Phaser.GameObjects.Graphics, s: SimState): void {
    const enemies = s.enemies;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.dead || !e.isBoss) {
        continue;
      }
      drawBossRings(g, e, e.radius * bossScale(), s.timeMs);
      const barW = e.radius * 2.8;
      const barH = HP_BAR_HEIGHT_BOSS;
      const barY = e.y - e.radius * bossScale() - HP_BAR_GAP_BOSS;
      g.lineStyle(1.5, COLOR_BOSS_RING, 0.55);
      g.strokeRect(e.x - barW / 2 - 2, barY - 2, barW + 4, barH + 4);
    }
  }
}
