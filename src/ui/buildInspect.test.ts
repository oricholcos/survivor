import { describe, expect, it } from 'vitest';
import { createSimState } from '../core/simState';
import { loadWeaponDefs } from '../data/weapons';
import { addWeapon } from '../core/weapons';
import { applyUpgrade } from '../core/upgrade';
import { SNIPER_KILL_COUNT_META_KEY } from '../core/behaviors/behavior_chargeSniper';
import { getWeaponDisplayStats } from './buildInspect';

describe('buildInspect - 构筑详情面板数据指标解析 (对齐 BUILD_INSPECT_DATA_SPEC.md)', () => {
  const defs = loadWeaponDefs();

  it('蓄能狙击：基础面板（伤害、间隔、弹速），爆头几率、爆头伤害（含杀敌成长）、死刑宣告斩杀线', () => {
    const state = createSimState(1);
    addWeapon(state, 'charge_sniper');
    let items = getWeaponDisplayStats(defs['charge_sniper'], state, 'charge_sniper');

    // 确认攻击频次与穿透未在狙击基础项中展示
    expect(items.some((i) => i.label === '攻击频次')).toBe(false);
    expect(items.some((i) => i.label === '弹体穿透')).toBe(false);

    // 基础三项
    expect(items.find((i) => i.label === '单发伤害')?.val).toBe('60');
    expect(items.find((i) => i.label === '攻击间隔')?.val).toBe('2.00s');
    expect(items.find((i) => i.label === '弹体速度')?.val).toBe('1600');

    // 1. 升级 2 层爆头
    applyUpgrade(
      state,
      { kind: 'card', weaponId: 'charge_sniper', cardId: 'crit_shot', name: '爆头', description: '' },
      defs,
    );
    applyUpgrade(
      state,
      { kind: 'card', weaponId: 'charge_sniper', cardId: 'crit_shot', name: '爆头', description: '' },
      defs,
    );
    items = getWeaponDisplayStats(defs['charge_sniper'], state, 'charge_sniper');
    expect(items.find((i) => i.label === '爆头几率')?.val).toBe('40%');
    expect(items.find((i) => i.label === '爆头伤害')?.val).toBe('550%');

    // 2. 升级让子弹飞（杀敌成长）
    applyUpgrade(
      state,
      { kind: 'card', weaponId: 'charge_sniper', cardId: 'bullet_fly', name: '让子弹飞', description: '' },
      defs,
    );
    state.meta[SNIPER_KILL_COUNT_META_KEY] = 15;
    items = getWeaponDisplayStats(defs['charge_sniper'], state, 'charge_sniper');
    expect(items.find((i) => i.label === '爆头伤害')?.val).toBe('700%');

    // 3. 升级死刑宣告与处决强化
    applyUpgrade(
      state,
      { kind: 'card', weaponId: 'charge_sniper', cardId: 'execution_order', name: '死刑宣告', description: '' },
      defs,
    );
    applyUpgrade(
      state,
      { kind: 'card', weaponId: 'charge_sniper', cardId: 'execute_up', name: '处决强化', description: '' },
      defs,
    );
    items = getWeaponDisplayStats(defs['charge_sniper'], state, 'charge_sniper');
    expect(items.find((i) => i.label === '斩杀阈值')?.val).toBe('生命 <25% (Boss <9%)');

    // 用户在规范表中移除了斩首伤害、击杀经验、穿透增伤
    expect(items.some((i) => i.label === '斩首伤害')).toBe(false);
    expect(items.some((i) => i.label === '击杀经验')).toBe(false);
    expect(items.some((i) => i.label === '穿透增伤')).toBe(false);
  });

  it('灼热光束：伤害、间隔、锁定范围，持有灼痕展示灼烧跳频', () => {
    const state = createSimState(1);
    addWeapon(state, 'heat_beam');
    let items = getWeaponDisplayStats(defs['heat_beam'], state, 'heat_beam');

    expect(items.find((i) => i.label === '单发伤害')?.val).toBe('9');
    expect(items.find((i) => i.label === '攻击间隔')?.val).toBe('0.20s');
    expect(items.find((i) => i.label === '锁定范围')?.val).toBe('365px');
    expect(items.some((i) => i.label === '弹体速度')).toBe(false);
    expect(items.some((i) => i.label === '弹体穿透')).toBe(false);

    // 吃灼痕
    applyUpgrade(
      state,
      { kind: 'card', weaponId: 'heat_beam', cardId: 'scorch', name: '灼痕', description: '' },
      defs,
    );
    items = getWeaponDisplayStats(defs['heat_beam'], state, 'heat_beam');
    expect(items.find((i) => i.label === '灼烧跳频')?.val).toBe('0.50s/跳');

    // 吃 dot 频率
    applyUpgrade(
      state,
      { kind: 'card', weaponId: 'heat_beam', cardId: 'dot_freq', name: 'dot频率', description: '' },
      defs,
    );
    items = getWeaponDisplayStats(defs['heat_beam'], state, 'heat_beam');
    expect(items.find((i) => i.label === '灼烧跳频')?.val).toBe('0.38s/跳');
  });

  it('追猎导弹：伤害、间隔、弹速、爆炸半径，多射、连射、燃烧云', () => {
    const state = createSimState(1);
    addWeapon(state, 'homing_missile');
    let items = getWeaponDisplayStats(defs['homing_missile'], state, 'homing_missile');

    expect(items.find((i) => i.label === '单发伤害')?.val).toBe('12');
    expect(items.find((i) => i.label === '攻击间隔')?.val).toBe('1.40s');
    expect(items.find((i) => i.label === '弹体速度')?.val).toBe('500');
    expect(items.find((i) => i.label === '爆炸半径')?.val).toBe('70px');

    applyUpgrade(
      state,
      { kind: 'card', weaponId: 'homing_missile', cardId: 'multi_shot', name: '多射+1', description: '' },
      defs,
    );
    applyUpgrade(
      state,
      { kind: 'card', weaponId: 'homing_missile', cardId: 'burst_shot', name: '连射+1', description: '' },
      defs,
    );
    applyUpgrade(
      state,
      { kind: 'card', weaponId: 'homing_missile', cardId: 'burn_cloud', name: '燃烧云', description: '' },
      defs,
    );

    items = getWeaponDisplayStats(defs['homing_missile'], state, 'homing_missile');
    expect(items.find((i) => i.label === '齐射发数')?.val).toBe('2发');
    expect(items.find((i) => i.label === '连射波数')?.val).toBe('+1波');
    expect(items.find((i) => i.label === '灼烧跳频')?.val).toBe('0.50s/跳');
  });

  it('迫击榴弹：伤害、间隔、爆炸半径，多射、连射、燃烧地', () => {
    const state = createSimState(1);
    addWeapon(state, 'mortar');
    let items = getWeaponDisplayStats(defs['mortar'], state, 'mortar');

    expect(items.find((i) => i.label === '单发伤害')?.val).toBe('18');
    expect(items.find((i) => i.label === '攻击间隔')?.val).toBe('1.80s');
    expect(items.find((i) => i.label === '爆炸半径')?.val).toBe('90px');

    applyUpgrade(
      state,
      { kind: 'card', weaponId: 'mortar', cardId: 'multi_shot', name: '多射+1', description: '' },
      defs,
    );
    applyUpgrade(
      state,
      { kind: 'card', weaponId: 'mortar', cardId: 'burst_shot', name: '连射+1', description: '' },
      defs,
    );
    applyUpgrade(
      state,
      { kind: 'card', weaponId: 'mortar', cardId: 'burn_ground', name: '燃烧地', description: '' },
      defs,
    );

    items = getWeaponDisplayStats(defs['mortar'], state, 'mortar');
    expect(items.find((i) => i.label === '齐射发数')?.val).toBe('2发');
    expect(items.find((i) => i.label === '连射波数')?.val).toBe('+1波');
    expect(items.find((i) => i.label === '灼烧跳频')?.val).toBe('0.50s/跳');
  });

  it('弹射棱镜：伤害、间隔、弹速、弹跳范围、弹跳次数、每跳衰减，多射、连射、闪电半径、冰毒', () => {
    const state = createSimState(1);
    addWeapon(state, 'prism');
    let items = getWeaponDisplayStats(defs['prism'], state, 'prism');

    expect(items.find((i) => i.label === '单发伤害')?.val).toBe('10');
    expect(items.find((i) => i.label === '攻击间隔')?.val).toBe('1.20s');
    expect(items.find((i) => i.label === '弹体速度')?.val).toBe('800');
    expect(items.find((i) => i.label === '弹跳范围')?.val).toBe('150px');
    expect(items.find((i) => i.label === '弹跳次数')?.val).toBe('3次');
    expect(items.find((i) => i.label === '每跳衰减')?.val).toBe('×0.80');

    applyUpgrade(
      state,
      { kind: 'card', weaponId: 'prism', cardId: 'multi_shot', name: '多射+1', description: '' },
      defs,
    );
    applyUpgrade(
      state,
      { kind: 'card', weaponId: 'prism', cardId: 'burst_shot', name: '连射+1', description: '' },
      defs,
    );
    applyUpgrade(
      state,
      { kind: 'card', weaponId: 'prism', cardId: 'chain_lightning', name: '连锁闪电', description: '' },
      defs,
    );
    applyUpgrade(
      state,
      { kind: 'card', weaponId: 'prism', cardId: 'frost_venom', name: '冰毒附着', description: '' },
      defs,
    );

    items = getWeaponDisplayStats(defs['prism'], state, 'prism');
    expect(items.find((i) => i.label === '齐射发数')?.val).toBe('2发');
    expect(items.find((i) => i.label === '连射波数')?.val).toBe('+1波');
    expect(items.find((i) => i.label === '闪电半径')?.val).toBe('90px');
    expect(items.find((i) => i.label === '中毒跳频')?.val).toBe('1.00s/跳');
  });

  it('轨道贯穿炮：伤害、间隔、弹体穿透（规范唯一保留穿透），折射次数', () => {
    const state = createSimState(1);
    addWeapon(state, 'rail_piercer');
    let items = getWeaponDisplayStats(defs['rail_piercer'], state, 'rail_piercer');

    expect(items.find((i) => i.label === '单发伤害')?.val).toBe('10');
    expect(items.find((i) => i.label === '攻击间隔')?.val).toBe('0.80s');
    expect(items.find((i) => i.label === '弹体穿透')?.val).toBe('4');

    applyUpgrade(
      state,
      { kind: 'card', weaponId: 'rail_piercer', cardId: 'refract_up', name: '折射+1', description: '' },
      defs,
    );
    items = getWeaponDisplayStats(defs['rail_piercer'], state, 'rail_piercer');
    expect(items.find((i) => i.label === '折射次数')?.val).toBe('1次');
  });

  it('扇面霰弹：伤害、间隔、弹速、散射夹角、齐射发数常驻（基础5发），连射波数、燃烧弹', () => {
    const state = createSimState(1);
    addWeapon(state, 'scatter');
    let items = getWeaponDisplayStats(defs['scatter'], state, 'scatter');

    expect(items.find((i) => i.label === '单发伤害')?.val).toBe('4');
    expect(items.find((i) => i.label === '攻击间隔')?.val).toBe('1.10s');
    expect(items.find((i) => i.label === '弹体速度')?.val).toBe('700');
    expect(items.find((i) => i.label === '散射夹角')?.val).toBe('70°');
    expect(items.find((i) => i.label === '齐射发数')?.val).toBe('5发');

    applyUpgrade(
      state,
      { kind: 'card', weaponId: 'scatter', cardId: 'burst_shot', name: '连射+1', description: '' },
      defs,
    );
    applyUpgrade(
      state,
      { kind: 'card', weaponId: 'scatter', cardId: 'burn_bullet', name: '燃烧弹', description: '' },
      defs,
    );

    items = getWeaponDisplayStats(defs['scatter'], state, 'scatter');
    expect(items.find((i) => i.label === '连射波数')?.val).toBe('+1波');
    expect(items.find((i) => i.label === '灼烧跳频')?.val).toBe('0.50s/跳');
  });

  it('震波壁垒：伤害、间隔、推进距离，余震伤害、眩晕时间（用户特别要求显示当前实际时长）、撕裂跳频、城垣共鸣', () => {
    const state = createSimState(1);
    addWeapon(state, 'seismic_wall');
    let items = getWeaponDisplayStats(defs['seismic_wall'], state, 'seismic_wall');

    expect(items.find((i) => i.label === '单发伤害')?.val).toBe('35');
    expect(items.find((i) => i.label === '攻击间隔')?.val).toBe('2.40s');
    expect(items.find((i) => i.label === '推进距离')?.val).toBe('220px');

    applyUpgrade(
      state,
      { kind: 'card', weaponId: 'seismic_wall', cardId: 'aftershock', name: '余震', description: '' },
      defs,
    );
    // 升级 1 层震荡加深（+150ms），基础 800ms -> 实际 950ms = 0.95s
    applyUpgrade(
      state,
      { kind: 'card', weaponId: 'seismic_wall', cardId: 'stun_deepen', name: '震荡加深', description: '' },
      defs,
    );
    applyUpgrade(
      state,
      { kind: 'card', weaponId: 'seismic_wall', cardId: 'earth_split', name: '熔岩裂隙', description: '' },
      defs,
    );
    applyUpgrade(
      state,
      { kind: 'card', weaponId: 'seismic_wall', cardId: 'wall_resonance', name: '城垣共鸣', description: '' },
      defs,
    );

    items = getWeaponDisplayStats(defs['seismic_wall'], state, 'seismic_wall');
    expect(items.find((i) => i.label === '余震伤害')?.val).toBe('30% (眩晕双倍)');
    // 验证用户特别要求的：标签【眩晕时间】，显示实际时长 0.95s
    expect(items.find((i) => i.label === '眩晕时间')?.val).toBe('0.95s');
    expect(items.find((i) => i.label === '撕裂跳频')?.val).toBe('0.50s/跳');
    expect(items.find((i) => i.label === '城垣共鸣')?.val).toBe('命中≥8人回血+4');

    // 再升 1 层震荡加深（+150ms -> 1100ms = 1.10s）
    applyUpgrade(
      state,
      { kind: 'card', weaponId: 'seismic_wall', cardId: 'stun_deepen', name: '震荡加深', description: '' },
      defs,
    );
    items = getWeaponDisplayStats(defs['seismic_wall'], state, 'seismic_wall');
    expect(items.find((i) => i.label === '眩晕时间')?.val).toBe('1.10s');
  });
});
