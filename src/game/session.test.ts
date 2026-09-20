// src/game/session.test.ts —— 开局初始武器随机选择契约与 session 生命周期测试。
//
// 契约：
// 1. 候选池契约：包含且仅包含 5 把远程武器，严格排除 3 把近程武器，所有候选 ID 均在 loadWeaponDefs() 中存在；
// 2. 确定性契约：相同的种子调用 createSession 必定得到相同的初始武器，session.restart(seed) 保持一致；
// 3. 覆盖度契约：对多个不同种子采样，验证 5 把候选武器都能被抽中，无近程武器泄漏；
// 4. 状态契约：验证开局 state.weaponStates 中恰好只有 1 把初始武器，初始等级为 0，cards 为空对象 {}，cooldownMs 为 0。

import { describe, expect, it } from 'vitest';
import {
  createSession,
  EXCLUDED_INITIAL_WEAPONS,
  INITIAL_WEAPON_CANDIDATES,
} from './session';
import { loadWeaponDefs } from '../data/weapons';

describe('开局初始武器随机选择契约', () => {
  const EXPECTED_CANDIDATES = [
    'charge_sniper',
    'homing_missile',
    'mortar',
    'prism',
    'rail_piercer',
  ] as const;

  const EXPECTED_EXCLUDED = [
    'scatter',
    'heat_beam',
    'seismic_wall',
  ] as const;

  describe('候选池与排除池契约', () => {
    it('候选池包含且仅包含 5 把远程武器，按字典序固定', () => {
      expect(INITIAL_WEAPON_CANDIDATES).toHaveLength(5);
      expect(INITIAL_WEAPON_CANDIDATES).toEqual(EXPECTED_CANDIDATES);
      // 验证严格字典序
      const sorted = [...INITIAL_WEAPON_CANDIDATES].sort();
      expect([...INITIAL_WEAPON_CANDIDATES]).toEqual(sorted);
    });

    it('排除池包含且仅包含 3 把近程武器', () => {
      expect(EXCLUDED_INITIAL_WEAPONS).toHaveLength(3);
      for (const excluded of EXPECTED_EXCLUDED) {
        expect(EXCLUDED_INITIAL_WEAPONS).toContain(excluded);
      }
    });

    it('候选池与排除池严格无交集', () => {
      for (const candidate of INITIAL_WEAPON_CANDIDATES) {
        expect(EXCLUDED_INITIAL_WEAPONS).not.toContain(candidate);
      }
    });

    it('所有候选武器 ID 与排除武器 ID 均在 loadWeaponDefs() 中合法定义', () => {
      const defs = loadWeaponDefs();
      const allDefIds = Object.keys(defs);

      for (const id of INITIAL_WEAPON_CANDIDATES) {
        expect(defs[id], `候选武器 ${id} 必须存在于定义表中`).toBeDefined();
      }

      for (const id of EXCLUDED_INITIAL_WEAPONS) {
        expect(defs[id], `排除武器 ${id} 必须存在于定义表中`).toBeDefined();
      }

      // 验证候选池与排除池正好构成定义表的完整划分（8 把武器）
      const union = new Set([...INITIAL_WEAPON_CANDIDATES, ...EXCLUDED_INITIAL_WEAPONS]);
      expect(union.size).toBe(allDefIds.length);
      for (const id of allDefIds) {
        expect(union.has(id as (typeof EXPECTED_CANDIDATES)[number] | (typeof EXPECTED_EXCLUDED)[number])).toBe(true);
      }
    });
  });

  describe('确定性契约', () => {
    const testSeeds = [1, 7, 42, 123, 2024, 99999];

    it('相同的种子调用 createSession 必定得到相同的初始武器', () => {
      for (const seed of testSeeds) {
        const sessionA = createSession(seed);
        const sessionB = createSession(seed);

        const keysA = Object.keys(sessionA.state.weaponStates);
        const keysB = Object.keys(sessionB.state.weaponStates);

        expect(keysA).toHaveLength(1);
        expect(keysB).toHaveLength(1);
        expect(keysA[0]).toBe(keysB[0]);
      }
    });

    it('session.restart(seed) 保持确定性可复现', () => {
      for (const seed of testSeeds) {
        const session = createSession(seed);
        const initialWeapon = Object.keys(session.state.weaponStates)[0];

        // 推进若干帧后重启
        session.step(100);
        session.restart(seed);

        const restartedWeapon = Object.keys(session.state.weaponStates)[0];
        expect(restartedWeapon).toBe(initialWeapon);

        // 再次重启仍保持完全一致
        session.restart(seed);
        const restartedAgainWeapon = Object.keys(session.state.weaponStates)[0];
        expect(restartedAgainWeapon).toBe(initialWeapon);
      }
    });
  });

  describe('覆盖度契约', () => {
    it('对不同种子采样，5 把候选武器均能被抽中，且绝无排除武器泄漏', () => {
      const sampled = new Set<string>();
      const candidateList = [...INITIAL_WEAPON_CANDIDATES];

      // 采样前 200 个整数种子，收集所有命中的初始武器
      for (let seed = 1; seed <= 200; seed++) {
        const session = createSession(seed);
        const weapons = Object.keys(session.state.weaponStates);
        expect(weapons).toHaveLength(1);

        const weaponId = weapons[0];
        expect(candidateList).toContain(weaponId);
        expect(EXCLUDED_INITIAL_WEAPONS).not.toContain(weaponId);

        sampled.add(weaponId);
        if (sampled.size === candidateList.length) {
          break;
        }
      }

      // 验证 5 把候选武器无一遗漏地全部被命中
      for (const candidate of candidateList) {
        expect(sampled.has(candidate), `候选武器 ${candidate} 应当被采样抽中`).toBe(true);
      }
      expect(sampled.size).toBe(5);
    });
  });

  describe('状态契约', () => {
    it('开局 state.weaponStates 中恰好只有 1 把初始武器，初始等级为 0，cards 为空对象 {}，cooldownMs 为 0', () => {
      // 采样多个不同种子，覆盖可能抽出的不同武器
      for (let seed = 1; seed <= 20; seed++) {
        const session = createSession(seed);
        const weaponEntries = Object.entries(session.state.weaponStates);

        // 恰好只有 1 把初始武器
        expect(weaponEntries).toHaveLength(1);

        const [weaponId, ws] = weaponEntries[0];
        expect(INITIAL_WEAPON_CANDIDATES).toContain(weaponId);

        // 初始等级为 0
        expect(ws.level).toBe(0);
        // cards 为空对象 {}
        expect(ws.cards).toEqual({});
        expect(Object.keys(ws.cards)).toHaveLength(0);
        // cooldownMs 为 0
        expect(ws.cooldownMs).toBe(0);
      }
    });
  });
});
