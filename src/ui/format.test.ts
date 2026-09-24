import { describe, expect, it } from 'vitest';
import { formatDamageNum, formatTime, getPauseButtonText } from './format';

describe('format 工具函数测试', () => {
  describe('formatTime', () => {
    it('正常格式化秒与毫秒', () => {
      expect(formatTime(0)).toBe('00:00');
      expect(formatTime(999)).toBe('00:00');
      expect(formatTime(1000)).toBe('00:01');
      expect(formatTime(65000)).toBe('01:05');
      expect(formatTime(600000)).toBe('10:00');
    });

    it('防御负数时间', () => {
      expect(formatTime(-500)).toBe('00:00');
    });
  });

  describe('formatDamageNum', () => {
    it('非正数或非法数值返回 0', () => {
      expect(formatDamageNum(0)).toBe('0');
      expect(formatDamageNum(-100)).toBe('0');
      expect(formatDamageNum(NaN)).toBe('0');
      expect(formatDamageNum(Infinity)).toBe('0');
    });

    it('1,000 以下正常四舍五入整型', () => {
      expect(formatDamageNum(52)).toBe('52');
      expect(formatDamageNum(999.4)).toBe('999');
    });

    it('1,000 以上显示 k 后缀', () => {
      expect(formatDamageNum(1000)).toBe('1.0k');
      expect(formatDamageNum(5320)).toBe('5.3k');
      expect(formatDamageNum(999999)).toBe('1000.0k');
    });

    it('1,000,000 以上显示 M 后缀', () => {
      expect(formatDamageNum(1000000)).toBe('1.0M');
      expect(formatDamageNum(2450000)).toBe('2.5M');
    });
  });

  describe('getPauseButtonText - 暂停/构筑悬浮按钮文案与图标切换', () => {
    it('暂停/展开构筑时显示 ▶ 构筑', () => {
      expect(getPauseButtonText(true)).toBe('▶ 构筑');
    });

    it('游戏运行/关闭构筑面板时显示 ⏸ 构筑', () => {
      expect(getPauseButtonText(false)).toBe('⏸ 构筑');
    });
  });
});
