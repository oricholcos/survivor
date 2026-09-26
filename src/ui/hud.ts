// src/ui/hud.ts —— 电脑端外置 HUD 面板（M45）。
// 在电脑宽屏模式（左侧有充足黑边空间时）在画布左侧外部渲染战斗状态：
// 1. 基础信息：模式、存活时间（含历史最佳）、当前等级、累计击杀；
// 2. 经验进度条（霓虹发光）；
// 3. 拥有武器胶囊芯片列表：支持点击直接切换禁用/开启已拥有武器；
// 当处于移动端/窄屏模式时自动隐藏，由画布内 HUD 兜底渲染。

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
   * 每帧由视图层同步状态与位置。
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

  let isExplicitlyVisible = true;

  function setVisible(visible: boolean): void {
    isExplicitlyVisible = visible;
    if (!visible) {
      container.classList.add('ov-hidden');
    }
  }

  function destroy(): void {
    container.remove();
  }

  function update(
    state: SimState,
    sessionMode: GameMode,
    bestEndlessMs: number | null,
    kills: number,
    canvas: HTMLCanvasElement | null,
  ): boolean {
    if (!isExplicitlyVisible || !canvas) {
      container.classList.add('ov-hidden');
      return false;
    }

    const rect = canvas.getBoundingClientRect();
    const leftSpace = rect.left;

    // 屏幕左侧黑边空间不足（移动端竖屏或超窄视口）：隐藏外部面板，由画布内渲染
    if (leftSpace < PC_HUD_MIN_LEFT_SPACE) {
      container.classList.add('ov-hidden');
      return false;
    }

    container.classList.remove('ov-hidden');

    // 响应式动态定位到画布左侧空白处（红框位置）：
    // 距画布左侧留 20px 间距，垂直从画布顶部下方 16px 起
    const panelWidth = Math.min(260, Math.max(160, leftSpace - 32));
    container.style.width = `${panelWidth}px`;
    container.style.top = `${Math.max(16, rect.top + 16)}px`;
    container.style.left = `${Math.max(12, rect.left - panelWidth - 20)}px`;

    // 渲染文本：模式 / 存活时间 / 等级 / 击杀
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

    modeEl.textContent = modeText;
    timeEl.textContent = timeText;
    levelEl.textContent = `等级 ${state.progress.level}`;
    killsEl.textContent = `击杀 ${kills}`;

    // 经验条百分比
    const need = xpToNext(state);
    const xpPct = need > 0 && Number.isFinite(need) ? clamp01(state.progress.xp / need) : 0;
    xpFill.style.width = `${(xpPct * 100).toFixed(1)}%`;

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

    // 隐藏多余的节点
    for (let i = ids.length; i < chipNodes.length; i++) {
      chipNodes[i].button.style.display = 'none';
    }

    // 原地精准更新节点属性，绝不重建 DOM
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
      node.button.style.display = '';
      node.button.dataset.weaponId = id;

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

      node.disabledSpan.style.display = isDisabled ? '' : 'none';

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
