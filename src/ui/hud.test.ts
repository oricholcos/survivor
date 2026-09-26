// src/ui/hud.test.ts —— 电脑端外置 HUD 逻辑单元测试（M45）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSimState } from '../core/simState';
import { addWeapon } from '../core/weapons';
import { WAVE_CLOCK_META_KEY } from '../core/waves';
import { createExternalHud, PC_HUD_MIN_LEFT_SPACE } from './hud';

// 轻量级 DOM 环境 Mock 工具
class MockClassList {
  private classes = new Set<string>();
  add(c: string) {
    this.classes.add(c);
  }
  remove(c: string) {
    this.classes.delete(c);
  }
  contains(c: string): boolean {
    return this.classes.has(c);
  }
}

class MockElement {
  id = '';
  className = '';
  textContent = '';
  title = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  classList = new MockClassList();
  children: MockElement[] = [];
  eventListeners: Record<string, ((ev: unknown) => void)[]> = {};
  parentElement: MockElement | null = null;

  appendChild(child: MockElement) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string) {
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, g) => g.toUpperCase());
      this.dataset[key] = value;
    }
  }

  getAttribute(name: string): string | null {
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, g) => g.toUpperCase());
      return this.dataset[key] ?? null;
    }
    return null;
  }

  closest<T>(selector: string): T | null {
    let cur: MockElement | null = this.parentElement ? this : null;
    if (selector.startsWith('.') && this.className.includes(selector.slice(1))) {
      return this as unknown as T;
    }
    while (cur) {
      if (selector.startsWith('.') && cur.className.includes(selector.slice(1))) {
        return cur as unknown as T;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  addEventListener(event: string, handler: (ev: unknown) => void) {
    if (!this.eventListeners[event]) {
      this.eventListeners[event] = [];
    }
    this.eventListeners[event].push(handler);
  }

  dispatchEvent(event: string, evObj: unknown = {}) {
    const selfHandlers = this.eventListeners[event] || [];
    for (const h of selfHandlers) {
      h(evObj);
    }
    let cur = this.parentElement;
    while (cur) {
      const handlers = cur.eventListeners[event] || [];
      for (const h of handlers) {
        h(evObj);
      }
      cur = cur.parentElement;
    }
  }

  pointerdown() {
    this.dispatchEvent('pointerdown', {
      target: this,
      stopPropagation: () => {},
      preventDefault: () => {},
    });
  }

  click() {
    this.dispatchEvent('click', {
      target: this,
      stopPropagation: () => {},
    });
  }

  remove() {
    this.children = [];
  }
}

describe('createExternalHud - 电脑端外置 HUD 组件 (M45)', () => {
  let originalDocument: unknown;

  beforeEach(() => {
    originalDocument = globalThis.document;
    const body = new MockElement();
    (globalThis as unknown as { document: unknown }).document = {
      createElement: () => new MockElement(),
      body,
    };
  });

  afterEach(() => {
    (globalThis as unknown as { document: unknown }).document = originalDocument;
  });

  it('常量阈值校验：PC_HUD_MIN_LEFT_SPACE 设定为 180px', () => {
    expect(PC_HUD_MIN_LEFT_SPACE).toBe(180);
  });

  it('移动端/窄屏模式（leftSpace < 180）：update 返回 false，外部 HUD 隐藏', () => {
    const state = createSimState(1);
    addWeapon(state, 'rail_piercer');
    const hud = createExternalHud();

    const mockCanvas = {
      getBoundingClientRect: () => ({ left: 100, top: 20, width: 360, height: 640 }),
    } as unknown as HTMLCanvasElement;

    const isActive = hud.update(state, 'campaign', null, 5, mockCanvas);
    expect(isActive).toBe(false);
    expect(hud.element.classList.contains('ov-hidden')).toBe(true);

    hud.destroy();
  });

  it('电脑宽屏模式（leftSpace >= 180）：update 返回 true，外部 HUD 显示并正确渲染文本、经验条与芯片', () => {
    const state = createSimState(1);
    addWeapon(state, 'rail_piercer');
    state.timeMs = 65000; // 01:05
    state.progress.level = 3;
    state.progress.xp = 10;
    state.weaponStates.rail_piercer.damageDealt = 1200;

    const onToggle = vi.fn();
    const hud = createExternalHud(onToggle);

    const mockCanvas = {
      getBoundingClientRect: () => ({ left: 350, top: 40, width: 360, height: 640 }),
    } as unknown as HTMLCanvasElement;

    const isActive = hud.update(state, 'campaign', null, 12, mockCanvas);
    expect(isActive).toBe(true);
    expect(hud.element.classList.contains('ov-hidden')).toBe(false);

    // 检查状态文本渲染
    const statsBox = (hud.element as unknown as MockElement).children[0];
    expect(statsBox.children[0].textContent).toBe('模式 通关 (0/6)');
    expect(statsBox.children[1].textContent).toBe('存活 01:05');
    expect(statsBox.children[2].textContent).toBe('等级 3');
    expect(statsBox.children[3].textContent).toBe('击杀 12');

    // 检查武器芯片渲染
    const chipsBox = (hud.element as unknown as MockElement).children[2];
    expect(chipsBox.children.length).toBe(1);
    const chip = chipsBox.children[0];
    expect(chip.className).toContain('ov-hud-chip');
    expect(chip.children[0].textContent).toBe('轨道贯穿炮');

    // 点击芯片触发切换回调
    chip.pointerdown();
    expect(onToggle).toHaveBeenCalledWith('rail_piercer');

    hud.destroy();
  });

  it('高频伤害变化时，武器芯片 DOM 节点保持稳定复用，绝不销毁重建（防点击失效）', () => {
    const state = createSimState(1);
    addWeapon(state, 'rail_piercer');
    const onToggle = vi.fn();
    const hud = createExternalHud(onToggle);
    const mockCanvas = {
      getBoundingClientRect: () => ({ left: 300, top: 10, width: 360, height: 640 }),
    } as unknown as HTMLCanvasElement;

    // 第一次 update
    state.weaponStates.rail_piercer.damageDealt = 100;
    hud.update(state, 'campaign', null, 1, mockCanvas);

    const chipsBox = (hud.element as unknown as MockElement).children[2];
    const initialChip = chipsBox.children[0];
    expect(initialChip.children[3].textContent).toContain('100');

    // 模拟 16ms 后伤害高频变化
    state.weaponStates.rail_piercer.damageDealt = 350;
    hud.update(state, 'campaign', null, 1, mockCanvas);

    const updatedChip = chipsBox.children[0];
    // 关键断言：DOM 对象必须是完全相同的引用（池化稳定复用，没有被 textContent = '' 销毁）
    expect(updatedChip).toBe(initialChip);
    expect(updatedChip.children[3].textContent).toContain('350');

    // 点击依然 100% 触发回调
    updatedChip.pointerdown();
    expect(onToggle).toHaveBeenCalledWith('rail_piercer');

    hud.destroy();
  });

  it('武器被禁用时，外部芯片打上 ov-hud-chip--disabled 样式并标注 [已禁用]', () => {
    const state = createSimState(1);
    addWeapon(state, 'rail_piercer');
    state.weaponStates.rail_piercer.disabled = true;

    const hud = createExternalHud();
    const mockCanvas = {
      getBoundingClientRect: () => ({ left: 240, top: 20, width: 360, height: 640 }),
    } as unknown as HTMLCanvasElement;

    hud.update(state, 'campaign', null, 0, mockCanvas);

    const chipsBox = (hud.element as unknown as MockElement).children[2];
    const chip = chipsBox.children[0];
    expect(chip.className).toContain('ov-hud-chip--disabled');
    const disSpan = chip.children[1];
    expect(disSpan.textContent).toBe('[已禁用]');
    expect(disSpan.style.display).toBe('');

    hud.destroy();
  });

  it('极限生存模式：不分轮数，始终恒定显示【模式 极限生存】（不带轮数或倍率后缀）', () => {
    const state = createSimState(1);
    addWeapon(state, 'rail_piercer');
    state.timeMs = 4000;

    const hud = createExternalHud();
    const mockCanvas = {
      getBoundingClientRect: () => ({ left: 250, top: 0, width: 360, height: 640 }),
    } as unknown as HTMLCanvasElement;

    // 第 1 轮：显示 "模式 极限生存"
    hud.update(state, 'endless', 600000, 0, mockCanvas);
    const statsBox = (hud.element as unknown as MockElement).children[0];
    expect(statsBox.children[0].textContent).toBe('模式 极限生存');
    expect(statsBox.children[1].textContent).toBe('存活 00:04 (最佳 10:00)');

    // 即使进入后续多轮循环，也依然恒定显示 "模式 极限生存"
    state.meta[WAVE_CLOCK_META_KEY] = { loopCount: 2, loopScale: 2.0 };
    hud.update(state, 'endless', 600000, 0, mockCanvas);
    expect(statsBox.children[0].textContent).toBe('模式 极限生存');

    hud.destroy();
  });

  it('setVisible(false) 强制隐藏外部面板', () => {
    const state = createSimState(1);
    const hud = createExternalHud();
    const mockCanvas = {
      getBoundingClientRect: () => ({ left: 300, top: 0, width: 360, height: 640 }),
    } as unknown as HTMLCanvasElement;

    hud.update(state, 'campaign', null, 0, mockCanvas);
    expect(hud.element.classList.contains('ov-hidden')).toBe(false);

    hud.setVisible(false);
    expect(hud.element.classList.contains('ov-hidden')).toBe(true);

    hud.destroy();
  });
});
