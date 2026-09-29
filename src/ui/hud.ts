// src/ui/hud.ts —— 电脑端外置 HUD 面板（M45）。
// 在电脑宽屏模式（左侧有充足黑边空间时）在画布左侧外部渲染战斗状态：
// 1. 基础信息：模式、存活时间（含历史最佳）、当前等级、累计击杀；
// 2. 经验进度条（霓虹发光）；
// 3. 拥有武器胶囊芯片列表：支持点击直接切换禁用/开启已拥有武器；
// 当处于移动端/窄屏模式时自动隐藏，由画布内 HUD 兜底渲染。
//
// 性能约定（P0-2 热路径）：update() 由视图层每帧调用（约 60fps），必须满足：
// 1. 零布局读取：禁止每帧调用 canvas.getBoundingClientRect()；画布矩形只走缓存，
//    仅在「首次拿到画布（懒初始化）」或「window / visualViewport 的 resize 事件」时重算；
// 2. 零冗余 DOM 写入：所有文本、样式、dataset 写入一律先 diff，值变化才落 DOM；
//    面板位置/宽度只在位置重算事件路径（缓存矩形失效后的首个激活帧）写入。

import { xpToNext } from '../core/gems';
import { loadWeaponDefs } from '../data/weapons';
import { formatDamageNum, formatTime } from './format';
import type { SimState } from '../core/types';
import type { GameMode } from '../core/victory';

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

const WEAPON_DEFS = loadWeaponDefs();

/** 触发电脑端外置 HUD 的左侧最小像素阈值（黑边宽度 >= 该值时外置）。 */
export const PC_HUD_MIN_LEFT_SPACE = 180;

export interface ExternalHud {
  element: HTMLElement;
  /**
   * 每帧由视图层同步状态与位置（热路径：零布局读取、零冗余 DOM 写入）。
   * @returns 若处于电脑宽屏外置模式返回 true（画布内 HUD 应隐藏）；若空间不足返回 false（画布内 HUD 应显示）。
   */
  update(
    state: SimState,
    sessionMode: GameMode,
    bestEndlessMs: number | null,
    kills: number,
    canvas: HTMLCanvasElement | null,
  ): boolean;
  setVisible(visible: boolean): void;
  destroy(): void;
}

/**
 * 创建电脑端外置 HUD 面板实例。
 * @param onToggleWeapon 点击武器胶囊芯片切换禁用/启用时的回调函数。
 */
export function createExternalHud(onToggleWeapon?: (weaponId: string) => void): ExternalHud {
  const container = document.createElement('div');
  container.id = 'ov-hud-pc';
  container.className = 'ov-hud-pc ov-hidden';

  // 1. 状态文本区
  const statsBox = document.createElement('div');
  statsBox.className = 'ov-hud-pc-stats';
  const modeEl = document.createElement('div');
  modeEl.className = 'ov-hud-pc-line ov-hud-pc-mode';
  const timeEl = document.createElement('div');
  timeEl.className = 'ov-hud-pc-line ov-hud-pc-time';
  const levelEl = document.createElement('div');
  levelEl.className = 'ov-hud-pc-line ov-hud-pc-level';
  const killsEl = document.createElement('div');
  killsEl.className = 'ov-hud-pc-line ov-hud-pc-kills';
  statsBox.appendChild(modeEl);
  statsBox.appendChild(timeEl);
  statsBox.appendChild(levelEl);
  statsBox.appendChild(killsEl);
  container.appendChild(statsBox);

  // 2. 经验进度条区
  const xpBox = document.createElement('div');
  xpBox.className = 'ov-hud-pc-xp';
  const xpTrack = document.createElement('div');
  xpTrack.className = 'ov-hud-pc-xp-track';
  const xpFill = document.createElement('div');
  xpFill.className = 'ov-hud-pc-xp-fill';
  xpTrack.appendChild(xpFill);
  xpBox.appendChild(xpTrack);
  container.appendChild(xpBox);

  // 3. 武器芯片区：使用事件委托，持久监听 pointerdown / click，解决高频重绘丢失点击问题
  const chipsBox = document.createElement('div');
  chipsBox.className = 'ov-hud-pc-chips';
  container.appendChild(chipsBox);

  // 稳定芯片节点结构池（按顺序复用 DOM，绝不每帧销毁重建）
  interface ChipNode {
    button: HTMLButtonElement;
    nameSpan: HTMLSpanElement;
    disabledSpan: HTMLSpanElement;
    tagSpan: HTMLSpanElement;
    dmgSpan: HTMLSpanElement;
  }
  const chipNodes: ChipNode[] = [];

  // 事件委托：在容器上常驻监听 pointerdown，按下瞬间 0 延迟响应切换，杜绝点击丢失
  chipsBox.addEventListener('pointerdown', (ev) => {
    const target = (ev.target as HTMLElement | null)?.closest<HTMLButtonElement>('.ov-hud-chip');
    if (!target) return;
    const wid = target.dataset.weaponId;
    if (wid && onToggleWeapon) {
      ev.stopPropagation();
      ev.preventDefault();
      onToggleWeapon(wid);
    }
  });
  chipsBox.addEventListener('click', (ev) => {
    ev.stopPropagation();
  });

  document.body.appendChild(container);

  // —— 画布矩形缓存（事件驱动，P0-2）——
  // 只在 refreshLayout() 里读取真实布局（首帧懒初始化 / resize 事件），其余帧一律读缓存。
  let lastCanvas: HTMLCanvasElement | null = null;
  let cachedLeft = 0;
  let cachedTop = 0;
  // true 表示缓存矩形刚失效（首帧 / resize 后），需要在下一个激活帧重写面板位置与宽度
  let layoutDirty = false;

  function refreshLayout(): void {
    const canvas = lastCanvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    cachedLeft = rect.left;
    cachedTop = rect.top;
    layoutDirty = true;
  }

  /** 位置重算事件路径：仅在此重写面板宽度/位置（每帧热路径绝不触碰这三项）。 */
  function applyPanelPosition(): void {
    // 响应式动态定位到画布左侧空白处（红框位置）：
    // 距画布左侧留 20px 间距，垂直从画布顶部下方 16px 起
    const panelWidth = Math.min(260, Math.max(160, cachedLeft - 32));
    container.style.width = `${panelWidth}px`;
    container.style.top = `${Math.max(16, cachedTop + 16)}px`;
    container.style.left = `${Math.max(12, cachedLeft - panelWidth - 20)}px`;
  }

  // resize 监听（window + visualViewport）：移动端地址栏收展会改画布矩形。
  // 具名处理函数，destroy() 用同一引用成对移除；visualViewport 可能不存在，判空降级。
  function handleViewportResize(): void {
    // 只重读矩形并标记脏；面板样式写入推迟到下一次 update 的激活帧（隐藏态不写）
    refreshLayout();
  }

  const win: Window | null = typeof window !== 'undefined' ? window : null;
  if (win) {
    win.addEventListener('resize', handleViewportResize);
    const vv = win.visualViewport ?? null;
    if (vv) {
      vv.addEventListener('resize', handleViewportResize);
    }
  }

  let isExplicitlyVisible = true;

  function hidePanel(): void {
    if (!container.classList.contains('ov-hidden')) {
      container.classList.add('ov-hidden');
    }
  }

  function showPanel(): void {
    if (container.classList.contains('ov-hidden')) {
      container.classList.remove('ov-hidden');
    }
  }

  function setVisible(visible: boolean): void {
    isExplicitlyVisible = visible;
    if (!visible) {
      hidePanel();
    }
  }

  function destroy(): void {
    if (win) {
      win.removeEventListener('resize', handleViewportResize);
      const vv = win.visualViewport ?? null;
      if (vv) {
        vv.removeEventListener('resize', handleViewportResize);
      }
    }
    lastCanvas = null; // 兜底：即使有残留调用也不再触达已移除的画布节点
    container.remove();
  }

  function update(
    state: SimState,
    sessionMode: GameMode,
    bestEndlessMs: number | null,
    kills: number,
    canvas: HTMLCanvasElement | null,
  ): boolean {
    // 显式隐藏或画布缺失：面板隐藏、回退画布内渲染（此分支不写任何面板位置/内容样式）
    if (!isExplicitlyVisible || !canvas) {
      lastCanvas = canvas;
      hidePanel();
      return false;
    }

    // 首次拿到画布（懒初始化）或画布对象被替换：重算一次矩形；其余帧一律用缓存矩形
    if (canvas !== lastCanvas) {
      lastCanvas = canvas;
      refreshLayout();
    }

    // 屏幕左侧黑边空间不足（移动端竖屏或超窄视口）：隐藏外部面板，由画布内渲染
    if (cachedLeft < PC_HUD_MIN_LEFT_SPACE) {
      hidePanel();
      layoutDirty = false;
      return false;
    }

    showPanel();

    // 位置重算事件路径：缓存矩形刚失效（首帧 / resize 后）才重写面板位置与宽度
    if (layoutDirty) {
      applyPanelPosition();
      layoutDirty = false;
    }

    // 渲染文本：模式 / 存活时间 / 等级 / 击杀（全部 diff 后写入，避免每帧替换文本节点）
    let modeText: string;
    let timeText: string;
    if (sessionMode === 'endless') {
      // 极限生存：不分轮数，恒定展示【模式 极限生存】
      modeText = '模式 极限生存';

      const bestStr = bestEndlessMs !== null ? formatTime(bestEndlessMs) : '—';
      timeText = `存活 ${formatTime(state.timeMs)} (最佳 ${bestStr})`;
    } else {
      const bossKills = (state.meta.bossKills as number | undefined) ?? 0;
      modeText = `模式 通关 (${bossKills}/6)`;
      timeText = `存活 ${formatTime(state.timeMs)}`;
    }

    if (modeEl.textContent !== modeText) {
      modeEl.textContent = modeText;
    }
    if (timeEl.textContent !== timeText) {
      timeEl.textContent = timeText;
    }
    const levelText = `等级 ${state.progress.level}`;
    if (levelEl.textContent !== levelText) {
      levelEl.textContent = levelText;
    }
    const killsText = `击杀 ${kills}`;
    if (killsEl.textContent !== killsText) {
      killsEl.textContent = killsText;
    }

    // 经验条百分比（diff 后写入）
    const need = xpToNext(state);
    const xpPct = need > 0 && Number.isFinite(need) ? clamp01(state.progress.xp / need) : 0;
    const xpWidthText = `${(xpPct * 100).toFixed(1)}%`;
    if (xpFill.style.width !== xpWidthText) {
      xpFill.style.width = xpWidthText;
    }

    // 武器胶囊芯片渲染：稳定复用现有 DOM 节点，避免高频清空造成点击丢失
    const wsMap = state.weaponStates;
    const ids = Object.keys(wsMap);

    let totalTeamDamage = 0;
    for (let i = 0; i < ids.length; i++) {
      totalTeamDamage += wsMap[ids[i]].damageDealt ?? 0;
    }

    // 按需补充 DOM 节点
    while (chipNodes.length < ids.length) {
      const button = document.createElement('button');
      button.className = 'ov-hud-chip';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'ov-hud-chip-name';
      button.appendChild(nameSpan);

      const disabledSpan = document.createElement('span');
      disabledSpan.className = 'ov-hud-chip-disabled-tag';
      disabledSpan.textContent = '[已禁用]';
      disabledSpan.style.display = 'none';
      button.appendChild(disabledSpan);

      const tagSpan = document.createElement('span');
      tagSpan.className = 'ov-hud-chip-tag';
      button.appendChild(tagSpan);

      const dmgSpan = document.createElement('span');
      dmgSpan.className = 'ov-hud-chip-dmg';
      button.appendChild(dmgSpan);

      chipsBox.appendChild(button);
      chipNodes.push({ button, nameSpan, disabledSpan, tagSpan, dmgSpan });
    }

    // 隐藏多余的节点（diff 后写入）
    for (let i = ids.length; i < chipNodes.length; i++) {
      if (chipNodes[i].button.style.display !== 'none') {
        chipNodes[i].button.style.display = 'none';
      }
    }

    // 原地精准更新节点属性，绝不重建 DOM（display / dataset 同样 diff 后写入）
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const ws = wsMap[id];
      const def = WEAPON_DEFS[id];
      const level = ws.level;
      const maxed = level >= (def?.maxLevel ?? 10);
      const isDisabled = Boolean(ws.disabled);
      const dmg = ws.damageDealt ?? 0;
      const pct = totalTeamDamage > 0 ? Math.round((dmg / totalTeamDamage) * 100) : 0;
      const dmgStr = formatDamageNum(dmg);
      const tag = maxed ? 'MAX' : `Lv.${level}`;

      const node = chipNodes[i];
      if (node.button.style.display !== '') {
        node.button.style.display = '';
      }
      if (node.button.dataset.weaponId !== id) {
        node.button.dataset.weaponId = id;
      }

      let chipClass = 'ov-hud-chip';
      if (isDisabled) {
        chipClass += ' ov-hud-chip--disabled';
      } else if (maxed) {
        chipClass += ' ov-hud-chip--max';
      } else if (level <= 0) {
        chipClass += ' ov-hud-chip--lv0';
      }
      if (node.button.className !== chipClass) {
        node.button.className = chipClass;
      }

      const expectedTitle = isDisabled ? '【已禁用】点击恢复自动攻击' : '【已启用】点击手动禁用该武器';
      if (node.button.title !== expectedTitle) {
        node.button.title = expectedTitle;
      }

      const expectedName = def?.name ?? id;
      if (node.nameSpan.textContent !== expectedName) {
        node.nameSpan.textContent = expectedName;
      }

      const expectedDisabledDisplay = isDisabled ? '' : 'none';
      if (node.disabledSpan.style.display !== expectedDisabledDisplay) {
        node.disabledSpan.style.display = expectedDisabledDisplay;
      }

      if (node.tagSpan.textContent !== tag) {
        node.tagSpan.textContent = tag;
      }

      const expectedDmg = `${dmgStr} (${pct}%)`;
      if (node.dmgSpan.textContent !== expectedDmg) {
        node.dmgSpan.textContent = expectedDmg;
      }
    }

    return true;
  }

  return {
    element: container,
    update,
    setVisible,
    destroy,
  };
}
