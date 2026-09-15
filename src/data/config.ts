// src/data/config.ts —— 全局数值加载层：config.json → SimConfig。
// 类型从 core/types 反向 import type（数据层依赖 core 的类型契约）；
// 数值契约：全部数值只存在于 config.json，此处零硬编码。禁止 import phaser / DOM。

import type { SimConfig } from '../core/types';
import configJson from './config.json';

/**
 * 加载一局的全局数值表（字段与 core/types 的 SimConfig 一致）。
 * 返回浅拷贝（表内容为共享只读数据，调用方不得修改，改数值请改 config.json）。
 */
export function loadSimConfig(): SimConfig {
  return { ...configJson };
}
