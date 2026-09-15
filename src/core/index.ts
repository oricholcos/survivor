// src/core：纯逻辑层。禁止 import phaser 与任何 DOM/BOM（ESLint 强制）。
// 模拟为 step(state, dt) 纯推进，副作用只通过事件队列对外表达。
// 占位导出：后续任务填充种子 RNG、对象池、空间网格、SimState 等。
export const CORE_LAYER_PLACEHOLDER = true;
