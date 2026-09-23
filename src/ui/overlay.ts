// src/ui/overlay.ts —— DOM 覆盖层（T1.11 v0 + T3.5 双模式）。
//
// 三个覆盖面板（深色半透明底 + 圆角卡片 + 高亮描边，样式由本模块注入 <style>，
// 不依赖任何外部资源；面板居中悬浮，不遮挡画布左上角 HUD 关键信息）：
// 1) 开局菜单（T3.5）：页面加载即显示（此时尚无一局，视图也未启动）。两个模式按钮——
//    点「通关模式」/「无尽模式」→ 经 launch(mode) 组装新局并启动视图，隐藏菜单开局；
//    底部为真实纪录摘要（T4.2：无尽最长 / 通关达成 / 最高击杀，无纪录时显示引导文案；
//    initUi 与每次「返回菜单」时刷新）。
// 2) 升级三选一：收到 levelUp 事件 → paused=true 弹面板；点选 → applyUpgrade；
//    同帧多级（事件队列还有 levelUp）依次再弹；全部处理完 → paused=false 恢复。
// 3) 结算（T3.5 按模式分支；T4.2 加纪录对比）：
//    - campaign 胜利（victory 事件）→「守城成功！」+ 存活时间（撑满 10 分钟显示 10:00）
//      + 通关状态（首次「首次通关！」标记 / 此后「已通关」）+ 击杀对比；
//    - campaign 失败（gameOver）→「城墙陷落」+ 存活时间 + 击杀对比；
//    - endless 只有失败流（gameOver）→「无尽终章」+ 存活时间（作为分数强调显示，
//      刷新最长存活时加「新纪录！」标记）+ 历史最佳存活 + 击杀对比。
//    按钮：「同模式重开」（session.restart()，mode 不变）/「返回菜单」（销毁当前局回菜单，
//    可再开任意模式）。
//
// 纪录结算（T4.2）：victory / gameOver 时调 recordResult（src/game/records，localStorage
// `survivor.records.v1` 持久化、异常降级）刷新纪录；返回的 flags 驱动「新纪录！」「首次通关！」标记。
//
// 事件来源：mainScene 每帧 drain 后经 session.onEvent 转发到本模块的 handleEvent
//（事件出口闭包按局捕获各自的 session：restart 沿用，返回菜单随旧局一起废弃）。
// 击杀数在本层独立累计（enemyKilled 事件），随开局/重开归零，与 HUD 侧计数互不干扰。

import type { GameEvent } from '../core/events';
import type { GameMode } from '../core/victory';
import {
  applyUpgrade,
  consumeReroll,
  getRerollsRemaining,
  rollUpgradeOptions,
  type UpgradeOption,
} from '../core/upgrade';
import type { GameSession } from '../game/session';
import { loadRecords, recordResult } from '../game/records';
import { loadWeaponDefs } from '../data/weapons';
import { getWeaponStats } from '../core/weapons';
import { allMaxedUnlocked } from '../core/cards';
import { OVERLAY_CSS } from './styles';
import { formatDamageNum, formatTime } from './format';

// —— 数据表：只加载一次（内容共享只读；与 game/session.ts 同款约定） ——

const WEAPON_DEFS = loadWeaponDefs();

/** 开局请求（由合成入口 src/main.ts 提供）：按模式组装新局并启动视图；destroy 销毁当前局。 */
export interface SessionLaunch {
  session: GameSession;
  /** 销毁当前局（含 Phaser 视图）：「返回菜单」时调用，之后可再开任意模式。 */
  destroy(): void;
}

// —— 样式（T4.4 抽取到 src/ui/styles.ts 统一霓虹风格；本模块仅负责注入 <style>） ——

/** 注入覆盖层样式（幂等：已存在则跳过）。 */
function injectOverlayStyle(): void {
  if (document.getElementById('ov-style')) {
    return;
  }
  const style = document.createElement('style');
  style.id = 'ov-style';
  style.textContent = OVERLAY_CSS;
  document.head.appendChild(style);
}

/** 建 DOM 元素的小工具（可选 className 与 textContent）。 */
function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function show(panel: HTMLElement): void {
  panel.classList.remove('ov-hidden');
}

function hide(panel: HTMLElement): void {
  panel.classList.add('ov-hidden');
}

/** 升级选项的 kind 小标签文案与配色类名。 */
function kindBadge(option: UpgradeOption): { text: string; className: string } {
  switch (option.kind) {
    case 'new_weapon':
      return { text: '新武器', className: 'ov-kind ov-kind--weapon' };
    case 'card':
      return { text: '武器牌', className: 'ov-kind ov-kind--up' };
  }
}

/** 纪录标记小徽章（「新纪录！」「首次通关！」，复用升级选项的高亮胶囊样式类）。 */
function recordBadge(text: string): HTMLElement {
  return el('span', 'ov-kind ov-kind--new', text);
}

/**
 * 挂载覆盖面板并接管事件流；由 src/main.ts 调用（T3.5 起传入开局工厂 launch）。
 * 页面加载只显示开局菜单（尚无一局）；点模式按钮 → launch(mode) 组装新局并开局。
 */
export function initUi(launch: (mode: GameMode) => SessionLaunch): void {
  injectOverlayStyle();

  // —— 覆盖层运行状态（激活局的派生值；开局/重开时归位，返回菜单时销毁） ——
  let session: GameSession | null = null; // 当前激活局（菜单态为 null）
  let destroySession: (() => void) | null = null; // 销毁当前局（含视图）
  let upgradeOpen = false; // 三选一面板显示中（期间 session.paused === true）
  let pendingLevels: number[] = []; // 待处理的 levelUp 队列（同帧多级依次再弹）
  let gameEnded = false; // 结算面板显示中
  let kills = 0; // 本局击杀数（enemyKilled 事件独立累计）

  const root = el('div'); // 纯容器：各面板自行控制显隐（root 常驻，不携带 ov-hidden）
  root.id = 'ov-root';

  // —— 面板一：开局菜单（双模式入口） ——
  const startPanel = el('div', 'ov-panel');
  const startCard = el('div', 'ov-card');
  startCard.appendChild(el('div', 'ov-title ov-title--main', '城墙 survivor'));
  startCard.appendChild(el('div', 'ov-sub', '抵御进攻，守住城墙'));
  const modeBox = el('div', 'ov-modes');
  const campaignBtn = el('button', 'ov-btn ov-btn--mode', '通关模式（消灭 6 只领主首领获胜）');
  const endlessBtn = el('button', 'ov-btn ov-btn--mode', '无尽模式（扛到死，冲击最长存活）');
  modeBox.appendChild(campaignBtn);
  modeBox.appendChild(endlessBtn);
  startCard.appendChild(modeBox);
  // 历史最佳摘要（T4.2 纪录系统）：填真实纪录，initUi 与每次「返回菜单」时刷新。
  const recordsSummary = el('div', 'ov-foot');
  startCard.appendChild(recordsSummary);
  startPanel.appendChild(startCard);

  // —— 悬浮暂停/构筑详情按钮（模块 A：右上角常驻悬浮，局内显示） ——
  const pauseBtn = el('button', 'ov-pause-btn ov-hidden', '⏸ 构筑');

  // —— 面板二：升级三选一 ——
  const levelupPanel = el('div', 'ov-panel ov-hidden');
  const levelupCard = el('div', 'ov-card');
  levelupCard.appendChild(el('div', 'ov-title', '升级！选择一项'));
  const levelupSub = el('div', 'ov-sub');
  levelupCard.appendChild(levelupSub);
  const optionsBox = el('div', 'ov-options');
  levelupCard.appendChild(optionsBox);
  // 模块 D：三选一重掷按钮（每局固定 2 次）
  const rerollBtn = el('button', 'ov-btn ov-btn--reroll') as HTMLButtonElement;
  levelupCard.appendChild(rerollBtn);
  levelupPanel.appendChild(levelupCard);

  // —— 面板二点五：局中构筑详情面板（模块 A：点击打开并自动暂停，关闭后继续） ——
  const inspectPanel = el('div', 'ov-panel ov-hidden');
  const inspectCard = el('div', 'ov-card ov-card--inspect');
  inspectCard.appendChild(el('div', 'ov-title', '战斗暂停 · 构筑详情'));
  const inspectWeaponsBox = el('div', 'ov-inspect-weapons');
  inspectCard.appendChild(inspectWeaponsBox);
  const inspectBtnRow = el('div', 'ov-btnrow');
  const inspectResumeBtn = el('button', 'ov-btn', '继续游戏');
  const inspectRestartBtn = el('button', 'ov-btn ov-btn--ghost', '重新开始');
  const inspectQuitBtn = el('button', 'ov-btn ov-btn--danger', '返回主界面');
  inspectBtnRow.appendChild(inspectResumeBtn);
  inspectBtnRow.appendChild(inspectRestartBtn);
  inspectBtnRow.appendChild(inspectQuitBtn);
  inspectCard.appendChild(inspectBtnRow);
  inspectPanel.appendChild(inspectCard);

  // —— 面板三：结算（标题/统计按模式与胜负动态填充；含纪录对比行 T4.2） ——
  const overPanel = el('div', 'ov-panel ov-hidden');
  const overCard = el('div', 'ov-card');
  const overTitle = el('div', 'ov-title');
  const overTime = el('div', 'ov-stats');
  const overRecord = el('div', 'ov-stats ov-hidden'); // 纪录对比行（无内容时隐藏，避免空档）
  const overKills = el('div', 'ov-stats');
  const overDamageBox = el('div', 'ov-damage-box ov-hidden');
  overCard.appendChild(overTitle);
  overCard.appendChild(overTime);
  overCard.appendChild(overRecord);
  overCard.appendChild(overKills);
  overCard.appendChild(overDamageBox);
  const overBtnRow = el('div', 'ov-btnrow');
  const restartBtn = el('button', 'ov-btn', '同模式重开');
  const menuBtn = el('button', 'ov-btn ov-btn--ghost', '返回菜单');
  overBtnRow.appendChild(restartBtn);
  overBtnRow.appendChild(menuBtn);
  overCard.appendChild(overBtnRow);
  overPanel.appendChild(overCard);

  root.appendChild(pauseBtn);
  root.appendChild(startPanel);
  root.appendChild(levelupPanel);
  root.appendChild(inspectPanel);
  root.appendChild(overPanel);
  document.body.appendChild(root);

  let inspectOpen = false; // 构筑详情面板展开中

  // —— 本局派生值归位（开局 / 重开共用）。 ——
  function resetRunState(): void {
    kills = 0;
    pendingLevels = [];
    upgradeOpen = false;
    inspectOpen = false;
    gameEnded = false;
    hide(inspectPanel);
  }

  // —— 菜单纪录摘要（T4.2）：填真实纪录；三行紧凑展示，无任何纪录时显示引导文案。 ——
  // 调用点：initUi 初始化 + 每次「返回菜单」（回菜单即可看到刚打出的最新纪录）。
  function renderRecordsSummary(): void {
    const records = loadRecords();
    const hasAny = records.bestEndlessMs !== null || records.campaignCleared || records.bestKills > 0;
    if (!hasAny) {
      recordsSummary.textContent = '暂无纪录，开启第一局！';
      return;
    }
    recordsSummary.textContent = '';
    const endlessBest = records.bestEndlessMs !== null ? formatTime(records.bestEndlessMs) : '—';
    recordsSummary.appendChild(el('div', undefined, `无尽最长 ${endlessBest}`));
    recordsSummary.appendChild(
      el('div', undefined, `通关：${records.campaignCleared ? '已达成' : '未达成'}`),
    );
    recordsSummary.appendChild(el('div', undefined, `最高击杀 ${records.bestKills}`));
  }

  // —— 局中构筑详情面板渲染 ——
  function renderInspectPanel(s: GameSession): void {
    inspectWeaponsBox.textContent = '';
    const state = s.state;
    const wsMap = state.weaponStates;
    const ids = Object.keys(wsMap);
    if (ids.length === 0) {
      inspectWeaponsBox.appendChild(el('div', 'ov-sub', '暂未拥有任何武器'));
      return;
    }

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const ws = wsMap[id];
      const def = WEAPON_DEFS[id];
      if (!def) {
        continue;
      }
      const stats = getWeaponStats(def, state, id);
      const isMax = ws.level >= (def.maxLevel ?? 10);

      const card = el('div', 'ov-weapon-card');

      // 头部：武器名称 + 等级徽章 + 累计输出
      const head = el('div', 'ov-weapon-head');
      const title = el('div', 'ov-weapon-title');
      title.appendChild(el('span', undefined, def.name));
      title.appendChild(
        el(
          'span',
          isMax ? 'ov-damage-badge ov-damage-badge--max' : 'ov-damage-badge',
          isMax ? 'MAX' : `Lv.${ws.level}`,
        ),
      );
      head.appendChild(title);
      head.appendChild(el('span', 'ov-weapon-damage', `累计输出 ${formatDamageNum(ws.damageDealt ?? 0)}`));
      card.appendChild(head);

      // 数值网格：实时解析后的伤害、攻速、间隔、穿透、弹速
      const grid = el('div', 'ov-stats-grid');
      const statItems = [
        { label: '单发伤害', val: `${Math.round(stats.damage)}` },
        { label: '攻击间隔', val: `${(stats.intervalMs / 1000).toFixed(2)}s` },
        { label: '攻击频次', val: `${(1000 / stats.intervalMs).toFixed(1)}/s` },
        { label: '弹体穿透', val: `${Math.round(stats.pierce)}` },
        { label: '弹体速度', val: `${Math.round(stats.projectileSpeed)}` },
      ];
      for (const item of statItems) {
        const itemEl = el('div', 'ov-stat-item');
        itemEl.appendChild(el('span', undefined, item.label));
        itemEl.appendChild(el('span', 'ov-stat-val', item.val));
        grid.appendChild(itemEl);
      }
      card.appendChild(grid);

      // 已选强化卡牌列表
      const cardsList = el('div', 'ov-cards-list');
      const heldCardIds = Object.keys(ws.cards || {});
      let hasCards = false;
      for (let cIdx = 0; cIdx < heldCardIds.length; cIdx++) {
        const cardId = heldCardIds[cIdx];
        const count = ws.cards[cardId];
        if (count <= 0) {
          continue;
        }
        hasCards = true;
        const cardDef = def.cards.find((c) => c.id === cardId);
        const entry = el('div', 'ov-card-entry');
        entry.appendChild(el('span', 'ov-card-name', cardDef?.name ?? cardId));
        entry.appendChild(el('span', 'ov-card-count', `×${count}`));
        entry.appendChild(el('span', 'ov-card-desc', cardDef?.description ?? ''));
        cardsList.appendChild(entry);
      }
      if (!hasCards) {
        cardsList.appendChild(el('div', 'ov-foot', '暂未装配强化卡牌'));
      }
      card.appendChild(cardsList);

      inspectWeaponsBox.appendChild(card);
    }
  }

  function openInspect(): void {
    if (session === null || gameEnded || inspectOpen) {
      return;
    }
    inspectOpen = true;
    session.paused = true;
    renderInspectPanel(session);
    show(inspectPanel);
  }

  function closeInspect(): void {
    if (!inspectOpen) {
      return;
    }
    inspectOpen = false;
    hide(inspectPanel);
    if (session !== null && !upgradeOpen && !gameEnded) {
      session.paused = false;
    }
  }

  // —— 开局：按模式组装新局并启动视图（点模式按钮）。 ——
  function startMode(mode: GameMode): void {
    if (destroySession !== null) {
      destroySession(); // 防御：菜单态正常无激活局（返回菜单路径已销毁）
      destroySession = null;
    }
    const launched = launch(mode);
    const s = launched.session;
    session = s;
    destroySession = launched.destroy;
    resetRunState();
    // 事件出口（T4.1 改为监听器列表注册）：闭包捕获本局会话；restart 沿用（列表挂在
    // session 上不被清空）；返回菜单销毁旧局时随旧 session 一起废弃，新局另行注册。
    s.addEventListener((ev) => handleEvent(ev, s));
    s.paused = false; // 开局
    hide(startPanel);
    show(pauseBtn);
  }

  // —— 三选一：打开一次（含选项渲染）。保持暂停，直到队列清空。 ——
  function renderOptions(s: GameSession, options: UpgradeOption[]): void {
    const unlocked = allMaxedUnlocked(s.state, WEAPON_DEFS);
    if (unlocked) {
      levelupSub.textContent = '无限牌池已激活（突破上限）';
      levelupSub.className = 'ov-sub ov-sub--unlimited';
    } else {
      levelupSub.textContent = '';
      levelupSub.className = 'ov-sub';
    }

    const remainingRerolls = getRerollsRemaining(s.state);
    rerollBtn.textContent = `重掷卡牌 (剩余 ${remainingRerolls} 次)`;
    rerollBtn.disabled = remainingRerolls <= 0;

    optionsBox.textContent = '';
    for (let i = 0; i < options.length; i++) {
      const option = options[i];
      const card = el('button', 'ov-option');
      const top = el('div', 'ov-option-top');

      if (option.kind === 'new_weapon') {
        const badge = kindBadge(option);
        top.appendChild(el('span', badge.className, badge.text));
        top.appendChild(el('span', 'ov-name', `解锁新武器 · ${option.name}`));
        card.appendChild(top);
        card.appendChild(el('div', 'ov-desc', option.description));
        card.appendChild(el('div', 'ov-level-indicator ov-level-indicator--init', '初始等级 Lv.0'));
      } else {
        const curLv = s.state.weaponStates[option.weaponId]?.level ?? 0;
        const nextLv = curLv + 1;
        const countBadge =
          option.maxCount !== undefined &&
          option.maxCount > 1 &&
          !option.description.includes(`/${option.maxCount}）`)
            ? `（${option.currentCount ?? 0}/${option.maxCount}）`
            : '';
        if (curLv >= 10) {
          top.appendChild(el('span', 'ov-kind ov-kind--break', '突破上限'));
          top.appendChild(el('span', 'ov-name', `${option.name}${countBadge}`));
          card.appendChild(top);
          card.appendChild(el('div', 'ov-desc', option.description));
          card.appendChild(el('div', 'ov-level-indicator ov-level-indicator--break', `等级突破 Lv.${curLv} → Lv.${nextLv}`));
        } else {
          top.appendChild(el('span', 'ov-kind ov-kind--up', '武器牌'));
          top.appendChild(el('span', 'ov-name', `${option.name}${countBadge}`));
          card.appendChild(top);
          card.appendChild(el('div', 'ov-desc', option.description));
          card.appendChild(el('div', 'ov-level-indicator', `强化升级 Lv.${curLv} → Lv.${nextLv}`));
        }
      }

      card.addEventListener('click', () => {
        onOptionPicked(s, option);
      });
      optionsBox.appendChild(card);
    }
  }

  function openNextUpgrade(s: GameSession): void {
    if (pendingLevels.length === 0 || gameEnded) {
      return;
    }
    upgradeOpen = true;
    s.paused = true; // 面板显示期间冻结模拟（HUD 时间停走的观察标志）
    renderOptions(s, rollUpgradeOptions(s.state, WEAPON_DEFS));
    show(levelupPanel);
  }

  // 点选一个选项：应用 → 弹出队列里剩余的 levelUp（依次再弹）或收面板恢复模拟。
  function onOptionPicked(s: GameSession, option: UpgradeOption): void {
    if (!upgradeOpen) {
      return;
    }
    applyUpgrade(s.state, option, WEAPON_DEFS);
    pendingLevels.shift();
    if (pendingLevels.length > 0) {
      renderOptions(s, rollUpgradeOptions(s.state, WEAPON_DEFS)); // 保持暂停
    } else {
      upgradeOpen = false;
      hide(levelupPanel);
      s.paused = false; // 全部处理完恢复
    }
  }

  /** 结算标题着色（T4.5 点亮 styles.ts 预置钩子）：win=青绿 / lose=红 / endless=品红。
   *  className 整体赋值：每次显示先覆盖旧类，天然清掉上一次结算遗留的结局钩子类。 */
  function setOutcomeTitle(text: string, variant: 'win' | 'lose' | 'endless'): void {
    overTitle.className = `ov-title ov-title--${variant}`;
    overTitle.textContent = text;
  }

  // —— 结算：按模式与胜负填充标题/统计（state.over 非 null，模拟已自停）+ 纪录结算（T4.2）。 ——
  function showResult(s: GameSession, kind: 'victory' | 'gameOver'): void {
    const won = kind === 'victory';
    // 纪录结算：终局即刷新并持久化（localStorage 异常时降级内存态）；
    // 返回 flags 驱动下方「新纪录！」「首次通关！」标记，records 为更新后的最新值。
    const settled = recordResult(s.mode, s.state.timeMs, kills, won);
    const records = settled.records;

    if (won) {
      // campaign 胜利：撑满 10 分钟（timeMs 恰过 durationMs，向下取整即显示 10:00）。
      setOutcomeTitle('守城成功！', 'win');
      overTime.className = 'ov-stats';
      overTime.textContent = `存活时间 ${formatTime(s.state.timeMs)}`;
    } else if (s.mode === 'endless') {
      // 无尽终章：存活时间即分数，强调显示。
      setOutcomeTitle('无尽终章', 'endless');
      overTime.className = 'ov-stats ov-score';
      overTime.textContent = `本局存活 ${formatTime(s.state.timeMs)}`;
    } else {
      // campaign 失败：墙破。
      setOutcomeTitle('城墙陷落', 'lose');
      overTime.className = 'ov-stats';
      overTime.textContent = `存活时间 ${formatTime(s.state.timeMs)}`;
    }

    // 无尽模式刷新最长存活 → 「本局存活」旁加「新纪录！」标记。
    if (s.mode === 'endless' && settled.newBestEndless) {
      overTime.appendChild(recordBadge('新纪录！'));
    }

    // 纪录对比行（T4.2）：endless 展示历史最佳存活；campaign 胜利展示通关状态
    //（首次「首次通关！」标记 / 此后「已通关」；失败无通关行）；无内容时隐藏整行。
    const recordLines: HTMLElement[] = [];
    if (s.mode === 'endless') {
      if (records.bestEndlessMs !== null) {
        recordLines.push(el('div', undefined, `历史最佳 ${formatTime(records.bestEndlessMs)}`));
      }
    } else if (won) {
      const clearLine = el('div');
      if (settled.firstClear) {
        clearLine.appendChild(recordBadge('首次通关！'));
      } else {
        clearLine.textContent = '已通关';
      }
      recordLines.push(clearLine);
    }
    overRecord.textContent = '';
    for (const line of recordLines) {
      overRecord.appendChild(line);
    }
    overRecord.className = recordLines.length > 0 ? 'ov-stats' : 'ov-stats ov-hidden';

    // 击杀对比（两模式共用）：本局 vs 历史最佳，刷新时加「新纪录！」标记。
    overKills.textContent = `本局击杀 ${kills} / 历史最佳 ${records.bestKills}`;
    if (settled.newBestKills) {
      overKills.appendChild(recordBadge('新纪录！'));
    }

    // 武器伤害统计排行榜（方案 A：霓虹进度条 + 总伤 + 占比 + DPS）
    renderDamageStats(s, overDamageBox);

    show(overPanel);
  }

  function renderDamageStats(s: GameSession, container: HTMLElement): void {
    container.textContent = '';
    const state = s.state;
    const wsMap = state.weaponStates;
    const ids = Object.keys(wsMap);
    if (ids.length === 0) {
      container.className = 'ov-damage-box ov-hidden';
      return;
    }

    let totalTeamDamage = 0;
    const list: Array<{ id: string; level: number; damage: number; name: string; maxLevel: number }> = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const ws = wsMap[id];
      const dmg = ws.damageDealt ?? 0;
      totalTeamDamage += dmg;
      const def = WEAPON_DEFS[id];
      list.push({
        id,
        level: ws.level,
        damage: dmg,
        name: def?.name ?? id,
        maxLevel: def?.maxLevel ?? 10,
      });
    }

    list.sort((a, b) => b.damage - a.damage);

    const titleRow = el('div', 'ov-damage-title');
    titleRow.appendChild(el('span', undefined, '武器伤害统计'));
    titleRow.appendChild(el('span', 'ov-damage-total', `全队总伤 ${formatDamageNum(totalTeamDamage)}`));
    container.appendChild(titleRow);

    const listEl = el('div', 'ov-damage-list');
    const battleSec = Math.max(1, state.timeMs / 1000);

    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const pct = totalTeamDamage > 0 ? (item.damage / totalTeamDamage) * 100 : 0;
      const dps = item.damage / battleSec;
      const maxed = item.level >= item.maxLevel;

      const itemEl = el('div', 'ov-damage-item');
      const infoEl = el('div', 'ov-damage-info');

      const nameCol = el('div', 'ov-damage-name-col');
      nameCol.appendChild(el('span', 'ov-damage-name', item.name));
      const badge = el(
        'span',
        maxed ? 'ov-damage-badge ov-damage-badge--max' : 'ov-damage-badge',
        maxed ? 'MAX' : `Lv.${item.level}`,
      );
      nameCol.appendChild(badge);
      infoEl.appendChild(nameCol);

      const valCol = el('div', 'ov-damage-val-col');
      valCol.appendChild(el('span', 'ov-damage-dps', `${formatDamageNum(dps)}/s`));
      valCol.appendChild(el('span', 'ov-damage-num', formatDamageNum(item.damage)));
      valCol.appendChild(el('span', 'ov-damage-pct', `(${pct.toFixed(0)}%)`));
      infoEl.appendChild(valCol);

      itemEl.appendChild(infoEl);

      const track = el('div', 'ov-damage-bar-track');
      const fill = el('div', 'ov-damage-bar-fill');
      fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
      track.appendChild(fill);
      itemEl.appendChild(track);

      listEl.appendChild(itemEl);
    }

    container.appendChild(listEl);
    container.className = 'ov-damage-box';
  }

  // —— 局终了公共流（victory / gameOver 先到先得、均恰好一次，此处防御重复）。 ——
  function endGame(s: GameSession, kind: 'victory' | 'gameOver'): void {
    if (gameEnded) {
      return;
    }
    gameEnded = true;
    hide(pauseBtn);
    if (inspectOpen) {
      inspectOpen = false;
      hide(inspectPanel);
    }
    pendingLevels.length = 0; // 极端时序（同帧先弹升级又终局）：丢弃未处理升级
    if (upgradeOpen) {
      upgradeOpen = false;
      hide(levelupPanel);
      s.paused = false;
    }
    showResult(s, kind);
  }

  // —— 事件出口（session.onEvent）：mainScene 每帧 drain 后逐个转发到这里。 ——
  function handleEvent(ev: GameEvent, s: GameSession): void {
    switch (ev.kind) {
      case 'enemyKilled':
        kills += 1;
        break;
      case 'levelUp':
        // 结算后的 levelUp 不再弹面板（终局帧不会再产生升级，防御性忽略）。
        if (gameEnded) {
          break;
        }
        pendingLevels.push(ev.level);
        if (!upgradeOpen) {
          openNextUpgrade(s);
        }
        break;
      case 'victory':
      case 'gameOver':
        // 双模式结算分支（见 showResult）：victory 仅 campaign 可能产生；
        // gameOver 在 campaign 显示「城墙陷落」、endless 显示「无尽终章」。
        endGame(s, ev.kind);
        break;
      default:
        // bossDefeated / enemySpawned / wallDamaged / sfx：v0 不处理（后续任务）。
        break;
    }
  }

  // —— 按钮接线 ——
  campaignBtn.addEventListener('click', () => {
    startMode('campaign');
  });

  endlessBtn.addEventListener('click', () => {
    startMode('endless');
  });

  // 悬浮暂停/构筑详情按钮点击
  pauseBtn.addEventListener('click', () => {
    if (inspectOpen) {
      closeInspect();
    } else {
      openInspect();
    }
  });

  // 重掷按钮点击（消耗 1 次重掷机会并重掷三选一卡牌）
  rerollBtn.addEventListener('click', () => {
    if (session === null || !upgradeOpen) {
      return;
    }
    if (getRerollsRemaining(session.state) <= 0) {
      return;
    }
    const consumed = consumeReroll(session.state);
    if (consumed) {
      renderOptions(session, rollUpgradeOptions(session.state, WEAPON_DEFS));
    }
  });

  // 构筑详情面板控制按钮
  inspectResumeBtn.addEventListener('click', () => {
    closeInspect();
  });

  inspectRestartBtn.addEventListener('click', () => {
    if (session === null) {
      return;
    }
    closeInspect();
    resetRunState();
    session.restart();
    show(pauseBtn);
  });

  // 游戏途中返回主界面（用户拍板：游戏途中返回严格不更新纪录，绕过 recordResult）
  inspectQuitBtn.addEventListener('click', () => {
    closeInspect();
    resetRunState();
    hide(pauseBtn);
    if (destroySession !== null) {
      destroySession();
      destroySession = null;
    }
    session = null;
    renderRecordsSummary();
    show(startPanel);
  });

  // 同模式重开：restart 保持当前 mode（新种子新局）；不重建视图（场景检测 state
  // 替换后自动复位派生计数）。
  restartBtn.addEventListener('click', () => {
    if (session === null || !gameEnded) {
      return;
    }
    resetRunState();
    hide(overPanel);
    session.restart(); // 不传种子 → 新种子开新局；restart 内部 paused=false，直接进入新一局
    show(pauseBtn);
  });

  // 返回菜单：销毁当前局（含 Phaser 视图），回开局菜单——可再开任意模式。
  menuBtn.addEventListener('click', () => {
    if (!gameEnded) {
      return;
    }
    resetRunState();
    hide(overPanel);
    hide(pauseBtn);
    if (destroySession !== null) {
      destroySession();
      destroySession = null;
    }
    session = null;
    renderRecordsSummary(); // 回菜单刷新纪录摘要（刚结束的局可能已刷新纪录）
    show(startPanel);
  });

  // —— 初始态：只显示开局菜单（尚无一局，模拟自然不推进；开局发生在 startMode 内）。 ——
  renderRecordsSummary(); // 菜单纪录摘要首填（T4.2）
  show(startPanel);
}
