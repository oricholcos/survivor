// src/data/effects.ts —— 效果定义加载层：effects.json → core/effects 注册表。
// 类型从 core/effects 反向 import type（数据层依赖 core 的类型契约）；
// 数值契约：全部数值只存在于 effects.json，此处零硬编码。禁止 import phaser / DOM。
//
// 互斥分组说明（JSON 无注释，规则文档落在 core/effects.ts 头注释）：
// - slow 与 chill 同组 'slow_family'（减速家族互斥，potency 取更强：slow 2 > chill 1）；
// - burn / poison（双 DoT）、mark / corrode（受伤加成）刻意不互斥、可共存叠乘。

import { registerEffectDefs, type EffectDef } from '../core/effects';
import effectsJson from './effects.json';

/**
 * 加载效果定义表：逐条注册进 core/effects 的模块级注册表（applyEffect / updateEffects
 * 按 kind 查询；session.ts 在模块级调用一次完成接线）。
 * 返回外层浅拷贝（表内容为共享只读数据，调用方不得修改，改数值请改 effects.json）。
 */
export function loadEffectDefs(): Record<string, EffectDef> {
  const defs = effectsJson as unknown as Record<string, EffectDef>;
  registerEffectDefs(defs);
  return { ...defs };
}
