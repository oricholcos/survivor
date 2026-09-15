// src/main.ts —— 合成入口（T3.5 双模式 + T4.1 音效接线）：
// 页面加载先由 src/ui 展示开局菜单（尚无一局）；用户点选模式后经 launch(mode)
// 组装一局 GameSession（src/game）→ 启动 Phaser 视图（src/phaser）→ 事件流由覆盖层接管。
// 「返回菜单」销毁当前局（Phaser Game 一并销毁），可再开任意模式；
// 「同模式重开」走 session.restart()（mode 不变，视图不重建）。
// 音效（T4.1）：initAudio 接线手势解锁（惰性创建 AudioContext）+ initSoundToggle 挂
// 右上角开关；launch 时按局注册事件→音效映射监听（destroy 时退订）。
import { createSession, type GameSession } from './game/session';
import type { GameEvent } from './core/events';
import type { GameMode } from './core/victory';
import { setStepsPerFrame } from './phaser/mainScene';
import { startGame } from './phaser';
import { initAudio, playSfx } from './audio/sfx';
import { initSoundToggle } from './ui/soundToggle';
import { initUi } from './ui';

const containerOrNull = document.getElementById('game');
if (!containerOrNull) {
  throw new Error('找不到画布容器 #game');
}
// 收窄后的容器常量：launch 闭包内使用（TS 不把 throw 守卫的收窄延续进函数体）。
const container: HTMLElement = containerOrNull;

/** 调试速度参数：URL ?speed=N（N=1~20，默认 1）——GUI 验收与数值平衡用；非法值一律回落 1。 */
function readSpeedSteps(): number {
  const raw = new URLSearchParams(window.location.search).get('speed');
  if (raw === null) {
    return 1;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    return 1;
  }
  return Math.min(n, 20);
}

// 调试速度在视图启动前注入场景（场景每渲染帧连推 N 个子步，core dt 钳制不受影响）。
setStepsPerFrame(readSpeedSteps());

/**
 * 事件 → 音效映射监听（T4.1）：core 的 sfx 事件直通 playSfx（同类节流在音频引擎内）；
 * 其余 kind 按语义映射到对应合成音。enemyKilled 不单独发声（命中 hit 已覆盖高频反馈）；
 * enemySpawned 静默。wallDamaged 音量随伤害量缩放（确定性，无随机）。
 */
function sfxListener(ev: GameEvent): void {
  switch (ev.kind) {
    case 'sfx':
      playSfx(ev.name);
      break;
    case 'levelUp':
      playSfx('levelUp');
      break;
    case 'victory':
      playSfx('victory');
      break;
    case 'gameOver':
      playSfx('defeat');
      break;
    case 'wallDamaged':
      playSfx('wallHit', { gain: Math.min(1.5, 0.6 + ev.amount / 30) });
      break;
    case 'bossDefeated':
      playSfx('bossDown');
      break;
    default:
      break; // enemyKilled / enemySpawned：不发声
  }
}

/**
 * 按模式组装一局并启动视图（开局菜单点模式按钮时调用；每局一个 Phaser.Game）。
 * 种子默认 Date.now 派生（仅组装层允许）。返回 destroy 供「返回菜单」销毁当前局。
 */
function launch(mode: GameMode): { session: GameSession; destroy(): void } {
  const session = createSession(undefined, mode);
  // 音效监听随局注册（事件总线 addEventListener，T4.1）；「返回菜单」销毁当前局时
  // 退订，防止旧局监听残留。restart 沿用同一 session，无需重新注册。
  const unsubscribeSfx = session.addEventListener(sfxListener);
  const game = startGame(container, session);
  return {
    session,
    destroy: () => {
      unsubscribeSfx();
      game.destroy(true);
    },
  };
}

initAudio(); // 首次任意 pointerdown 手势时惰性创建/恢复 AudioContext（自动播放策略）
initSoundToggle(); // 右上角音效开关（状态持久化 localStorage `survivor.sfx`）
initUi(launch);
