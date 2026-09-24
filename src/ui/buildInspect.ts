// src/ui/buildInspect.ts —— 局中构筑详情面板数据解析器。
// 100% 严格对齐 BUILD_INSPECT_DATA_SPEC.md 规范：
// 1. 各武器按规范仅展示该武器指定列入的属性项；
// 2. 标签 (label) 与显示值格式 (val) 逐字对齐规范；
// 3. 震波壁垒【眩晕加时】按要求改为【眩晕时间】，显示当前实际时长。

import type { WeaponDef, WeaponStats } from '../core/weapons';
import { getWeaponStats } from '../core/weapons';
import { getSniperKillCount } from '../core/behaviors/behavior_chargeSniper';
import type { SimState } from '../core/types';

export interface StatDisplayItem {
  label: string;
  val: string;
}

/**
 * 读 stats 可选数值键，缺省或非有限返回 0。
 */
function num(stats: WeaponStats, key: string): number {
  const v = stats[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * 为构筑详情面板生成某武器的完整数据指标列表（100% 遵循 BUILD_INSPECT_DATA_SPEC.md）。
 */
export function getWeaponDisplayStats(
  def: WeaponDef,
  state: SimState,
  weaponId: string,
): StatDisplayItem[] {
  const stats = getWeaponStats(def, state, weaponId);
  const items: StatDisplayItem[] = [];
  const dotMult = num(stats, 'dotTickMult') || 1;

  // —— 1. 蓄能狙击 (`charge_sniper`) ——
  if (def.id === 'charge_sniper') {
    items.push({ label: '单发伤害', val: `${Math.round(stats.damage)}` });
    items.push({ label: '攻击间隔', val: `${(stats.intervalMs / 1000).toFixed(2)}s` });
    items.push({ label: '弹体速度', val: `${Math.round(stats.projectileSpeed)}` });

    // 爆头几率
    if (num(stats, 'critShot') === 1 || num(stats, 'critChance') > 0) {
      items.push({ label: '爆头几率', val: `${Math.round(num(stats, 'critChance') * 100)}%` });

      // 爆头伤害（基础 550% + 让子弹飞击杀成长，仅显示当前总伤害，去掉括号说明）
      const baseMult = num(stats, 'critMultiplier') || 5.5;
      const killCritAmp = num(stats, 'killCritAmp');
      const killCount = killCritAmp > 0 ? getSniperKillCount(state) : 0;
      const totalMult = baseMult + killCount * killCritAmp;
      items.push({ label: '爆头伤害', val: `${Math.round(totalMult * 100)}%` });
    }

    // 斩杀阈值
    if (num(stats, 'executionOrder') === 1) {
      const execHp = Math.round(num(stats, 'executionHpFactor') * 100);
      const execBossHp = Math.round(num(stats, 'executionBossHpFactor') * 100);
      items.push({ label: '斩杀阈值', val: `生命 <${execHp}% (Boss <${execBossHp}%)` });
    }

    return items;
  }

  // —— 2. 灼热光束 (`heat_beam`) ——
  if (def.id === 'heat_beam') {
    items.push({ label: '单发伤害', val: `${Math.round(stats.damage)}` });
    items.push({ label: '攻击间隔', val: `${(stats.intervalMs / 1000).toFixed(2)}s` });
    items.push({ label: '锁定范围', val: `${Math.round(stats.lockRange)}px` });

    if (num(stats, 'scorch') === 1) {
      const tickSec = 0.5 / dotMult;
      items.push({ label: '灼烧跳频', val: `${tickSec.toFixed(2)}s/跳` });
    }

    return items;
  }

  // —— 3. 追猎导弹 (`homing_missile`) ——
  if (def.id === 'homing_missile') {
    items.push({ label: '单发伤害', val: `${Math.round(stats.damage)}` });
    items.push({ label: '攻击间隔', val: `${(stats.intervalMs / 1000).toFixed(2)}s` });
    items.push({ label: '弹体速度', val: `${Math.round(stats.projectileSpeed)}` });
    items.push({ label: '爆炸半径', val: `${Math.round(stats.aoeRadius)}px` });

    if (num(stats, 'projectileCount') > 1) {
      items.push({ label: '齐射发数', val: `${stats.projectileCount}发` });
    }
    if (num(stats, 'burstWaves') > 0) {
      items.push({ label: '连射波数', val: `+${stats.burstWaves}波` });
    }
    if (num(stats, 'burnCloud') === 1) {
      const tickSec = 0.5 / dotMult;
      items.push({ label: '灼烧跳频', val: `${tickSec.toFixed(2)}s/跳` });
    }

    return items;
  }

  // —— 4. 迫击榴弹 (`mortar`) ——
  if (def.id === 'mortar') {
    items.push({ label: '单发伤害', val: `${Math.round(stats.damage)}` });
    items.push({ label: '攻击间隔', val: `${(stats.intervalMs / 1000).toFixed(2)}s` });
    items.push({ label: '爆炸半径', val: `${Math.round(stats.aoeRadius)}px` });

    const extraProj = num(stats, 'projectileCount');
    if (extraProj > 0) {
      items.push({ label: '齐射发数', val: `${1 + extraProj}发` });
    }
    if (num(stats, 'burstWaves') > 0) {
      items.push({ label: '连射波数', val: `+${stats.burstWaves}波` });
    }
    if (num(stats, 'burnGround') === 1) {
      const tickSec = 0.5 / dotMult;
      items.push({ label: '灼烧跳频', val: `${tickSec.toFixed(2)}s/跳` });
    }

    return items;
  }

  // —— 5. 弹射棱镜 (`prism`) ——
  if (def.id === 'prism') {
    items.push({ label: '单发伤害', val: `${Math.round(stats.damage)}` });
    items.push({ label: '攻击间隔', val: `${(stats.intervalMs / 1000).toFixed(2)}s` });
    items.push({ label: '弹体速度', val: `${Math.round(stats.projectileSpeed)}` });
    items.push({ label: '弹跳范围', val: `${Math.round(stats.chainRange)}px` });
    items.push({ label: '弹跳次数', val: `${stats.chainCount}次` });
    items.push({ label: '每跳衰减', val: `×${stats.falloff.toFixed(2)}` });

    const extraProj = num(stats, 'projectileCount');
    if (extraProj > 0) {
      items.push({ label: '齐射发数', val: `${1 + extraProj}发` });
    }
    if (num(stats, 'burstWaves') > 0) {
      items.push({ label: '连射波数', val: `+${stats.burstWaves}波` });
    }
    if (num(stats, 'chainLightning') === 1 && num(stats, 'zapRadius') > 0) {
      items.push({ label: '闪电半径', val: `${Math.round(stats.zapRadius)}px` });
    }
    if (num(stats, 'frostVenom') === 1) {
      const tickSec = 1.0 / dotMult;
      items.push({ label: '中毒跳频', val: `${tickSec.toFixed(2)}s/跳` });
    }

    return items;
  }

  // —— 6. 轨道贯穿炮 (`rail_piercer`) ——
  if (def.id === 'rail_piercer') {
    items.push({ label: '单发伤害', val: `${Math.round(stats.damage)}` });
    items.push({ label: '攻击间隔', val: `${(stats.intervalMs / 1000).toFixed(2)}s` });
    items.push({ label: '弹体穿透', val: `${Math.round(stats.pierce)}` });

    if (num(stats, 'refract') > 0) {
      items.push({ label: '折射次数', val: `${stats.refract}次` });
    }

    return items;
  }

  // —— 7. 扇面霰弹 (`scatter`) ——
  if (def.id === 'scatter') {
    items.push({ label: '单发伤害', val: `${Math.round(stats.damage)}` });
    items.push({ label: '攻击间隔', val: `${(stats.intervalMs / 1000).toFixed(2)}s` });
    items.push({ label: '弹体速度', val: `${Math.round(stats.projectileSpeed)}` });
    items.push({ label: '散射夹角', val: `${Math.round(stats.fanAngleDeg)}°` });
    items.push({ label: '齐射发数', val: `${stats.projectileCount}发` });

    if (num(stats, 'burstWaves') > 0) {
      items.push({ label: '连射波数', val: `+${stats.burstWaves}波` });
    }
    if (num(stats, 'burnBullet') === 1) {
      const tickSec = 0.5 / dotMult;
      items.push({ label: '灼烧跳频', val: `${tickSec.toFixed(2)}s/跳` });
    }

    return items;
  }

  // —— 8. 震波壁垒 (`seismic_wall`) ——
  if (def.id === 'seismic_wall') {
    items.push({ label: '单发伤害', val: `${Math.round(stats.damage)}` });
    items.push({ label: '攻击间隔', val: `${(stats.intervalMs / 1000).toFixed(2)}s` });
    items.push({ label: '推进距离', val: `${Math.round(stats.waveDistance)}px` });

    if (num(stats, 'aftershockFactor') > 0) {
      items.push({
        label: '余震伤害',
        val: `${Math.round(stats.aftershockFactor * 100)}% (眩晕双倍)`,
      });
    }
    // 用户特别要求：【眩晕加时】改成【眩晕时间】，显示当前实际眩晕时长
    if (num(stats, 'stunBonusMs') > 0) {
      const totalStunSec = (800 + stats.stunBonusMs) / 1000;
      items.push({ label: '眩晕时间', val: `${totalStunSec.toFixed(2)}s` });
    }
    if (num(stats, 'earthSplit') === 1) {
      const tickSec = 0.5 / dotMult;
      items.push({ label: '撕裂跳频', val: `${tickSec.toFixed(2)}s/跳` });
    }
    if (num(stats, 'wallResonanceHeal') > 0) {
      items.push({ label: '城垣共鸣', val: `命中≥8人回血+${stats.wallResonanceHeal}` });
    }

    return items;
  }

  // 兜底（如果未来有未知新武器，退化展示基础通用项）
  items.push({ label: '单发伤害', val: `${Math.round(stats.damage)}` });
  items.push({ label: '攻击间隔', val: `${(stats.intervalMs / 1000).toFixed(2)}s` });
  return items;
}
