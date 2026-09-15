// src/data/waves.ts —— 波次配置加载层：waves.json → WavesConfig。
// 类型从 core/waves 反向 import type（数据层依赖 core 的类型契约）；
// 数值契约：全部数值只存在于 waves.json，此处零硬编码。禁止 import phaser / DOM。

import type { WavesConfig } from '../core/waves';
import wavesJson from './waves.json';

/**
 * 加载波次配置（字段与 core/waves 的 WavesConfig 一致：通关时长 / 时间轴 /
 * 无尽循环 / 血量膨胀）。
 * 返回浅拷贝（表内容为共享只读数据，调用方不得修改，改数值请改 waves.json）。
 */
export function loadWavesConfig(): WavesConfig {
  return { ...wavesJson };
}
