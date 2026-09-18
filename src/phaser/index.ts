// src/phaser：Phaser 视图层入口。游戏配置（720×1280 竖屏、Scale.FIT、自动居中）与场景注册都在这里。
import Phaser from 'phaser';
import { MainScene } from './mainScene';
import { fxEnabledFromUrl } from './fx';
import type { GameSession } from '../game/session';

/** 游戏设计分辨率：竖屏 720×1280 */
export const GAME_WIDTH = 720;
export const GAME_HEIGHT = 1280;

/** 页面深色底色（画布之外的页面区域同色） */
export const PAGE_BACKGROUND = '#05050d';

/**
 * 启动 Phaser 游戏并挂载到 parent 上。
 * session 经 MainScene 构造函数注入（scene 配置数组接受场景实例，Phaser 3 原生支持）；
 * 首个场景自动启动，页面加载即开跑（无需任何点击）。
 *
 * 相机 postFX 降级开关（T4.3）：URL `?fx=0` 完全关闭 bloom（低端机降级路径，fx.ts 解析，
 * 默认开启）；开启且 WebGL 渲染器时相机挂轻度 bloom 让霓虹发光元素泛光。
 */
export function startGame(parent: HTMLElement, session: GameSession): Phaser.Game {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    backgroundColor: PAGE_BACKGROUND,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: [new MainScene(session, fxEnabledFromUrl())],
  });
  // 调试句柄（与 ?speed / ?fx 同类的调试约定）：暴露游戏实例供控制台/GUI 验收手动
  // 驱动主循环（game.loop.step(t)），RAF 被环境节流的场景（如内嵌浏览器）下可逐帧推进。
  (window as unknown as Record<string, unknown>).__survivorGame = game;
  return game;
}
