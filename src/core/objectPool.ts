// src/core/objectPool.ts —— 泛型对象池（模拟循环内零对象分配的基建）
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM（ESLint 强制）；本文件无随机。
//
// 性能契约：
// - acquire 优先复用池内已释放实例（LIFO 出池，缓存友好）；仅当池空时才调用 factory 新建，
//   factory 是全池唯一的对象创建入口。
// - release 归还时执行 reset 清洗脏状态后入池；复用保证由此成立——对象唯一的入池通道是
//   release（必过 reset），预热实例由 factory 直接产出（视为干净），因此任何被复用出的
//   实例必然已通过 reset，无脏状态残留。
// - 池容量自然收敛：freeList 上限 = 历史峰值「同时在场」数量，完整 acquire→release 循环
//   不会让池继续增长，稳态下零分配、零工厂调用。
//
// 所有权契约（用引用比较判定，active 集合 O(1) 查删）：
// - release 一个不在「在外集合」中的对象（重复归还 / 从未 acquire / 其他池的对象）
//   → 明确抛错，杜绝 double-return 静默污染 activeCount 与重复入池。

/** Pool 构造选项。 */
export interface PoolOptions<T> {
  /** 池空时新建实例的工厂（全池唯一创建入口）。 */
  factory: () => T;
  /** release 时清洗脏状态的回调：把对象恢复到可安全复用的默认态。 */
  reset: (obj: T) => void;
  /** 可选预热数量：构造时先调用 factory 产出该数量的空闲实例。默认 0。 */
  initial?: number;
}

/**
 * 泛型对象池：acquire 借出 / release 归还，LIFO 复用。
 *
 * 语义约定（测试锁定）：
 * - `acquire()`：池非空 → 弹出空闲实例复用（不调 factory）；池空 → factory 新建。
 *   新建实例不经过 reset（工厂产出即干净态）；复用实例必然已在 release 时过 reset。
 * - `release(obj)`：仅接受当前在外（已 acquire 未归还）的本池实例，引用比较；
 *   成功路径 = 先移出在外集合 → 执行 reset → 入池。重复归还 / 非本池对象 → 抛 Error，
 *   池状态不受影响。
 * - `activeCount` / `pooledCount`：在外未归还数 / 池内空闲数；恒有
 *   activeCount + pooledCount === 工厂累计创建数。
 */
export class Pool<T> {
  private readonly factory: () => T;
  private readonly reset: (obj: T) => void;

  /** 空闲实例栈（LIFO 出池）：栈深峰值 = 历史峰值同时在场数，天然收敛。 */
  private readonly freeList: T[] = [];

  /** 当前在外实例集合：O(1) 所有权判定 + activeCount（Set 对对象用引用比较）。 */
  private readonly active = new Set<T>();

  constructor(opts: PoolOptions<T>) {
    if (typeof opts.factory !== 'function') {
      throw new TypeError('Pool: factory 必须是函数');
    }
    if (typeof opts.reset !== 'function') {
      throw new TypeError('Pool: reset 必须是函数');
    }
    this.factory = opts.factory;
    this.reset = opts.reset;

    const initial = opts.initial ?? 0;
    if (!Number.isInteger(initial) || initial < 0) {
      throw new RangeError(`Pool: initial 必须为非负整数，收到 ${initial}`);
    }
    for (let i = 0; i < initial; i++) {
      this.freeList.push(this.factory());
    }
  }

  /** 在外未归还数量。 */
  get activeCount(): number {
    return this.active.size;
  }

  /** 池内空闲数量。 */
  get pooledCount(): number {
    return this.freeList.length;
  }

  /**
   * 借出一个实例：优先复用池内空闲实例（LIFO），池空才调 factory 新建。
   * 复用出的实例必然已通过 reset（见类注释的复用保证）。
   */
  acquire(): T {
    const reused = this.freeList.pop();
    if (reused !== undefined) {
      this.active.add(reused);
      return reused;
    }
    // 池空：全池唯一允许调用 factory 的路径。
    const fresh = this.factory();
    this.active.add(fresh);
    return fresh;
  }

  /**
   * 归还实例：校验所有权 → reset 清洗脏状态 → 入池待复用。
   * - 重复归还同一对象 / 归还从未 acquire 的对象 / 归还其他池的对象 → 抛 Error（池状态不变）。
   * - reset 抛错视为使用者 reset 实现缺陷，不做兜底（此时对象已移出在外集合、未入池）。
   */
  release(obj: T): void {
    // Set.delete 返回是否真的删除：false 即该对象不在在外集合中（引用比较）。
    if (!this.active.delete(obj)) {
      throw new Error('Pool: release 拒绝该对象——它不属于本池当前在外的实例（重复归还或外来源对象）');
    }
    this.reset(obj);
    this.freeList.push(obj);
  }
}
