// src/data/enemies.ts —— 敌人数据加载层：enemies.json → EnemyTypeData 表。
// 类型从 core/enemies.ts 反向 import type（数据层依赖 core 的类型契约）；
// 数值契约：全部数值只存在于 enemies.json，此处零硬编码。禁止 import phaser / DOM。

import type { EnemyTypeData } from '../core/enemies';
import enemyTypes from './enemies.json';

/**
 * 加载敌人类型表：键为敌人图鉴 id（即 Enemy.typeId），值结构与 core 的 EnemyTypeData 一致。
 * 返回外层浅拷贝（表内容为共享只读数据，调用方不得修改，改数值请改 enemies.json）。
 */
export function loadEnemyTypes(): Record<string, EnemyTypeData> {
  return { ...enemyTypes };
}
