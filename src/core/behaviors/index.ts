// src/core/behaviors/index.ts —— 行为自动发现：收集本目录全部 behavior_*.ts 并注册。
// import 本文件（副作用 import）即完成全部注册；core/weapons.ts 已引入。
// 新增武器行为零中心文件改动：只需新建 behavior_*.ts 并 `export const behavior: WeaponBehavior`，
// 本文件的 import.meta.glob 会在构建期自动拾取。
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM（import.meta.glob 是 vite 编译期机制，非运行时依赖）。

/// <reference types="vite/client" />
import { registerBehavior } from './registry';
import type { WeaponBehavior } from './registry';

/** eager 收集全部行为文件；约定每个文件导出 `behavior`（WeaponBehavior）。 */
const modules = import.meta.glob('./behavior_*.ts', { eager: true }) as Record<
  string,
  { behavior?: WeaponBehavior }
>;

// 键排序保证注册顺序确定（与文件名序一致，全程可复现）。
const paths = Object.keys(modules).sort();
for (let i = 0; i < paths.length; i++) {
  const mod = modules[paths[i]];
  if (mod?.behavior) {
    registerBehavior(mod.behavior);
  }
}
