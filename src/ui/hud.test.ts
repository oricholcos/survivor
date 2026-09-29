// src/ui/hud.test.ts —— 电脑端外置 HUD 逻辑单元测试（M45）。
// P0-2 扩展：stub 增加写入计数（textContent / style / dataset 赋值次数）与 window / visualViewport
// 事件目标模拟，用于验证热路径 diff 化与画布矩形位置事件驱动化。
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
  // 写入计数：验证热路径 diff 生效（状态不变时赋值次数不得增长）
  writeCounts = { textContent: 0, style: 0, dataset: 0 };
  id = '';
  className = '';
  title = '';
  classList = new MockClassList();
  children: MockElement[] = [];
  eventListeners: Record<string, ((ev: unknown) => void)[]> = {};
  parentElement: MockElement | null = null;
  private textValue = '';
  style: Record<string, string>;
  dataset: Record<string, string>;

  constructor() {
    const counts = this.writeCounts;
    // style / dataset 用 Proxy 计数属性赋值（热路径 diff 验证）
    this.style = new Proxy<Record<string, string>>({}, {
      set(target, prop, value) {
        counts.style++;
        target[prop as string] = String(value);
        return true;
      },
    });
    this.dataset = new Proxy<Record<string, string>>({}, {
      set(target, prop, value) {
        counts.dataset++;
        target[prop as string] = String(value);
        return true;
      },
    });
  }

  get textContent(): string {
    return this.textValue;
  }

  set textContent(value: string) {
    this.writeCounts.textContent++;
    this.textValue = value;
  }

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
    // 从父节点摘除（对齐真实 DOM remove 的脱离语义），供 destroy 后防误访问断言使用
    if (this.parentElement) {
      const siblings = this.parentElement.children;
      const index = siblings.indexOf(this);
      if (index >= 0) {
        siblings.splice(index, 1);
      }
      this.parentElement = null;
    }
    this.children = [];
  }
}

// 模拟 window / visualViewport 的事件目标（vitest node 环境没有 window 全局）
class MockEventTarget {
  listeners: Record<string, ((ev: unknown) => void)[]> = {};
  // 模拟 window.visualViewport（默认 null = 不存在，走判空降级路径）
  visualViewport: MockEventTarget | null = null;

  addEventListener(event: string, handler: (ev: unknown) => void) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(handler);
  }

  removeEventListener(event: string, handler: (ev: unknown) => void) {
    const list = this.listeners[event];
    if (!list) return;
    const index = list.indexOf(handler);
    if (index >= 0) {
      list.splice(index, 1);
    }
  }

  dispatchEvent(event: string, evObj: unknown = {}) {
    const handlers = [...(this.listeners[event] ?? [])];
    for (const h of handlers) {
      h(evObj);
    }
  }
}

// 统计整棵子树的写入次数（验证 setVisible(false) / 隐藏态下 update 零写入）
function collectTree(el: MockElement): MockElement[] {
  const out = [el];
  for (const child of el.children) {
    out.push(...collectTree(child));
  }
  return out;
}

function totalWrites(els: MockElement[]): { textContent: number; style: number; dataset: number } {
  const total = { textContent: 0, style: 0, dataset: 0 };
  for (const el of els) {
    total.textContent += el.writeCounts.textContent;
    total.style += el.writeCounts.style;
    total.dataset += el.writeCounts.dataset;
  }
  return total;
}

describe('createExternalHud - 电脑端外置 HUD 组件 (M45)', () => {
  let originalDocument: unknown;
  let originalWindow: unknown;
  let mockWindow: MockEventTarget;

  beforeEach(() => {
    originalDocument = globalThis.document;
    originalWindow = (globalThis as unknown as { window: unknown }).window;
    const body = new MockElement();
    (globalThis as unknown as { document: unknown }).document = {
      createElement: () => new MockElement(),
      body,
    };
    mockWindow = new MockEventTarget();
    (globalThis as unknown as { window: unknown }).window = mockWindow;
  });

  afterEach(() => {
    (globalThis as unknown as { document: unknown }).document = originalDocument;
    (globalThis as unknown as { window: unknown }).window = originalWindow;
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

  // —— P0-2：热路径 diff 化 ——

  it('热路径 diff：状态不变时重复 update，textContent / style / dataset 赋值次数零增长且布局零读取', () => {
    const state = createSimState(1);
    addWeapon(state, 'rail_piercer');
    state.timeMs = 65000;
    state.progress.level = 3;
    state.progress.xp = 10;
    state.weaponStates.rail_piercer.damageDealt = 1200;

    const hud = createExternalHud();

    let rectReads = 0;
    const mockCanvas = {
      getBoundingClientRect: () => {
        rectReads++;
        return { left: 300, top: 40, width: 360, height: 640 };
      },
    } as unknown as HTMLCanvasElement;

    // 首帧：完成懒初始化与全部初始写入
    expect(hud.update(state, 'campaign', null, 12, mockCanvas)).toBe(true);
    expect(rectReads).toBe(1);
    // 面板位置/宽度只在首帧位置重算路径写一次（width + top + left = 3 次）
    const root = hud.element as unknown as MockElement;
    expect(root.writeCounts.style).toBe(3);

    const modeEl = root.children[0].children[0];
    const timeEl = root.children[0].children[1];
    const levelEl = root.children[0].children[2];
    const killsEl = root.children[0].children[3];
    const xpFill = root.children[1].children[0].children[0];
    const chip = root.children[2].children[0];
    const nameSpan = chip.children[0];
    const disabledSpan = chip.children[1];
    const tagSpan = chip.children[2];
    const dmgSpan = chip.children[3];

    const counters: Array<[string, () => number]> = [
      ['container.style', () => root.writeCounts.style],
      ['modeEl.textContent', () => modeEl.writeCounts.textContent],
      ['timeEl.textContent', () => timeEl.writeCounts.textContent],
      ['levelEl.textContent', () => levelEl.writeCounts.textContent],
      ['killsEl.textContent', () => killsEl.writeCounts.textContent],
      ['xpFill.style.width', () => xpFill.writeCounts.style],
      ['chip.style.display', () => chip.writeCounts.style],
      ['chip.dataset.weaponId', () => chip.writeCounts.dataset],
      ['disabledSpan.style.display', () => disabledSpan.writeCounts.style],
      ['nameSpan.textContent', () => nameSpan.writeCounts.textContent],
      ['tagSpan.textContent', () => tagSpan.writeCounts.textContent],
      ['dmgSpan.textContent', () => dmgSpan.writeCounts.textContent],
    ];
    const before = counters.map(([, get]) => get());

    // 状态完全不变的 10 帧：任何 DOM 写入计数都不允许增长
    for (let frame = 0; frame < 10; frame++) {
      expect(hud.update(state, 'campaign', null, 12, mockCanvas)).toBe(true);
    }
    expect(rectReads).toBe(1); // 常规帧零布局读取（无 resize 事件不得再调 getBoundingClientRect）
    counters.forEach(([label, get], i) => {
      expect(get(), label).toBe(before[i]);
    });

    hud.destroy();
  });

  it('时间文本按格式化结果 diff：同一秒内的帧不替换文本节点，跨秒只写一次', () => {
    const state = createSimState(1);
    addWeapon(state, 'rail_piercer');
    const hud = createExternalHud();
    const mockCanvas = {
      getBoundingClientRect: () => ({ left: 300, top: 40, width: 360, height: 640 }),
    } as unknown as HTMLCanvasElement;

    state.timeMs = 65000;
    hud.update(state, 'campaign', null, 0, mockCanvas);
    const root = hud.element as unknown as MockElement;
    const timeEl = root.children[0].children[1];
    expect(timeEl.textContent).toBe('存活 01:05');
    const baseline = timeEl.writeCounts.textContent;

    state.timeMs = 65400; // 同一秒内（仍格式化为 01:05）
    hud.update(state, 'campaign', null, 0, mockCanvas);
    expect(timeEl.writeCounts.textContent).toBe(baseline); // 不替换文本节点

    state.timeMs = 66000; // 跨入下一秒（01:06）
    hud.update(state, 'campaign', null, 0, mockCanvas);
    expect(timeEl.writeCounts.textContent).toBe(baseline + 1);
    expect(timeEl.textContent).toBe('存活 01:06');

    hud.destroy();
  });

  // —— P0-2：画布矩形位置事件驱动化 ——

  it('位置事件驱动：window resize 触发矩形重算与面板位置重写；无事件帧使用缓存矩形、零布局读取', () => {
    const state = createSimState(1);
    addWeapon(state, 'rail_piercer');
    const hud = createExternalHud();

    const rect = { left: 300, top: 40, width: 360, height: 640 };
    let rectReads = 0;
    const mockCanvas = {
      getBoundingClientRect: () => {
        rectReads++;
        return rect;
      },
    } as unknown as HTMLCanvasElement;

    hud.update(state, 'campaign', null, 0, mockCanvas);
    expect(rectReads).toBe(1);
    expect(hud.element.style.width).toBe('260px'); // min(260, max(160, 300 - 32))
    expect(hud.element.style.top).toBe('56px'); // max(16, 40 + 16)
    expect(hud.element.style.left).toBe('20px'); // 300 - 260 - 20

    // 画布矩形变化但未派发 resize 事件：走缓存矩形，位置保持不变、布局零读取
    rect.left = 420;
    rect.top = 100;
    hud.update(state, 'campaign', null, 0, mockCanvas);
    expect(rectReads).toBe(1);
    expect(hud.element.style.top).toBe('56px');
    expect(hud.element.style.left).toBe('20px');

    // window resize 事件：重算矩形，下一次 update 在激活帧重写位置与宽度
    mockWindow.dispatchEvent('resize');
    hud.update(state, 'campaign', null, 0, mockCanvas);
    expect(rectReads).toBe(2);
    expect(hud.element.style.top).toBe('116px'); // max(16, 100 + 16)
    expect(hud.element.style.left).toBe('140px'); // 420 - 260 - 20
    expect(hud.element.style.width).toBe('260px');

    hud.destroy();
  });

  it('visualViewport 的 resize 同样触发矩形重算；visualViewport 缺失时其余用例判空降级不抛错', () => {
    // 挂上 visualViewport 再创建实例，确保监听注册到 vv 上（移动端地址栏收展场景）
    const mockVV = new MockEventTarget();
    mockWindow.visualViewport = mockVV;

    const state = createSimState(1);
    addWeapon(state, 'rail_piercer');
    const hud = createExternalHud();

    const rect = { left: 300, top: 40, width: 360, height: 640 };
    let rectReads = 0;
    const mockCanvas = {
      getBoundingClientRect: () => {
        rectReads++;
        return rect;
      },
    } as unknown as HTMLCanvasElement;

    hud.update(state, 'campaign', null, 0, mockCanvas);
    rect.left = 500;
    rect.top = 120;

    // 不派发 window resize，仅派发 visualViewport resize：同样触发重算
    mockVV.dispatchEvent('resize');
    hud.update(state, 'campaign', null, 0, mockCanvas);
    expect(rectReads).toBe(2);
    expect(hud.element.style.top).toBe('136px'); // max(16, 120 + 16)
    expect(hud.element.style.left).toBe('220px'); // 500 - 260 - 20

    hud.destroy();
  });

  it('隐藏态恢复：resize 后空间变充足时，面板位置与宽度重新正确写入；隐藏期间不写位置与内容', () => {
    const state = createSimState(1);
    addWeapon(state, 'rail_piercer');
    state.timeMs = 65000;
    const hud = createExternalHud();

    const rect = { left: 100, top: 20, width: 360, height: 640 };
    const mockCanvas = {
      getBoundingClientRect: () => rect,
    } as unknown as HTMLCanvasElement;

    expect(hud.update(state, 'campaign', null, 0, mockCanvas)).toBe(false);
    expect(hud.element.classList.contains('ov-hidden')).toBe(true);
    // 隐藏态：不得写面板位置样式，也不得写内容
    const root = hud.element as unknown as MockElement;
    expect(root.writeCounts.style).toBe(0);
    expect(root.children[0].children[0].writeCounts.textContent).toBe(0);

    // resize 后空间变充足（left: 100 -> 350）
    rect.left = 350;
    rect.top = 40;
    mockWindow.dispatchEvent('resize');
    expect(hud.update(state, 'campaign', null, 0, mockCanvas)).toBe(true);
    expect(hud.element.classList.contains('ov-hidden')).toBe(false);
    expect(hud.element.style.width).toBe('260px'); // min(260, max(160, 350 - 32))
    expect(hud.element.style.top).toBe('56px'); // 40 + 16
    expect(hud.element.style.left).toBe('70px'); // 350 - 260 - 20
    expect(root.children[0].children[0].textContent).toBe('模式 通关 (0/6)'); // 内容随之正确写入

    hud.destroy();
  });

  it('setVisible(false) 后 update 不做任何面板写入（完全交由画布内 HUD 兜底）', () => {
    const state = createSimState(1);
    addWeapon(state, 'rail_piercer');
    state.timeMs = 65000;
    const hud = createExternalHud();
    const mockCanvas = {
      getBoundingClientRect: () => ({ left: 300, top: 40, width: 360, height: 640 }),
    } as unknown as HTMLCanvasElement;

    expect(hud.update(state, 'campaign', null, 0, mockCanvas)).toBe(true);
    hud.setVisible(false);

    const root = hud.element as unknown as MockElement;
    const before = totalWrites(collectTree(root));

    expect(hud.update(state, 'campaign', null, 0, mockCanvas)).toBe(false);
    expect(hud.element.classList.contains('ov-hidden')).toBe(true);
    expect(totalWrites(collectTree(root))).toEqual(before); // 零写入

    hud.destroy();
  });

  it('destroy() 移除 resize 监听：再派发 resize 不抛错、不访问已移除节点，且可重复调用', () => {
    const state = createSimState(1);
    addWeapon(state, 'rail_piercer');
    let rectReads = 0;
    const mockCanvas = {
      getBoundingClientRect: () => {
        rectReads++;
        return { left: 300, top: 40, width: 360, height: 640 };
      },
    } as unknown as HTMLCanvasElement;
    const hud = createExternalHud();
    hud.update(state, 'campaign', null, 0, mockCanvas);
    expect(rectReads).toBe(1);
    expect(mockWindow.listeners.resize?.length ?? 0).toBeGreaterThan(0);

    hud.destroy();
    // 具名处理函数成对移除
    expect(mockWindow.listeners.resize?.length ?? 0).toBe(0);

    // 之后再派发 resize：不得抛错，也不得再读取画布矩形（不访问已移除节点）
    expect(() => mockWindow.dispatchEvent('resize')).not.toThrow();
    expect(rectReads).toBe(1);

    // 重复 destroy 幂等不抛错
    expect(() => hud.destroy()).not.toThrow();

    // 容器已从 body 摘除
    const body = (globalThis as unknown as { document: { body: MockElement } }).document.body;
    expect(body.children.includes(hud.element as unknown as MockElement)).toBe(false);
  });
});
