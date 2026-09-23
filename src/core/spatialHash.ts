// src/core/spatialHash.ts —— 均匀空间网格（碰撞/邻域查询基建）
// 纯 TypeScript，禁止 import phaser 与任何 DOM/BOM（ESLint 强制）；本文件无随机。
//
// 设计要点（性能契约：按帧 clear + 重新 insert 的高频用法）：
// - clear() 复用内部结构：空桶数组回收入池（length=0 截断复用），槽位平行数组截断复用，
//   稳态下按帧 clear+insert 不产生桶/槽位级别的大对象分配。
// - queryCircle 只遍历查询圆覆盖到的格子，复杂度 = 覆盖格数 × 格内候选数，禁止 O(n²) 全量对比。
// - insert 记录每个 item 的 (x, y, radius)，queryCircle 做「圆与圆相交」精确过滤
//   （dist <= r + item.radius，恰好相切算相交）；跨格 item 用访问戳去重，只返回一次。
//
// 格子索引：用「外层 Map<cx, 内层 Map<cy, 桶>>」的两级嵌套，负坐标/大坐标由 Math.floor
// 与 Map 天然支持，不存在位运算打包键的溢出/碰撞隐患。桶内存放槽位号（number），
// 槽位对应 items/px/py/pr/stamp 等平行数组，查询热路径零 Map 反查、零临时对象。

/** 空桶回收池上限：防止极端场景下空桶数组无限滞留，超出上限的交还 GC。 */
const MAX_BUCKET_POOL = 4096;

export class SpatialHash<T> {
  private readonly cellSize: number;

  /** 外层按格子列 cx、内层按格子行 cy 存桶；桶 = 该格覆盖的槽位号列表。 */
  private readonly columns = new Map<number, Map<number, number[]>>();

  /** 空桶回收池：桶变空/clear 时入池，建桶时出池复用，避免每帧分配。 */
  private readonly bucketPool: number[][] = [];

  /** 槽位平行数组：items[slot] 与 px/py/pr[slot] 一一对应。 */
  private readonly items: T[] = [];
  private readonly px: number[] = [];
  private readonly py: number[] = [];
  private readonly pr: number[] = [];

  /** 每槽位当前链接的格子范围（闭区间），供 remove / 重复 insert 对称解除链接。 */
  private readonly minCx: number[] = [];
  private readonly maxCx: number[] = [];
  private readonly minCy: number[] = [];
  private readonly maxCy: number[] = [];

  /** 访问戳：stamp[slot] === 当前查询 id 表示本次查询已处理过该槽位（跨格去重）。 */
  private readonly stamp: number[] = [];
  private queryId = 0;

  /** item → 槽位，O(1) 定位，供 remove / 重复 insert 使用。 */
  private readonly slotOf = new Map<T, number>();

  /** 已移除槽位的空闲链：re-insert 优先复用；峰值受同时在场 item 数约束。 */
  private readonly freeSlots: number[] = [];

  constructor(cellSize: number) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) {
      throw new RangeError(`cellSize 必须为正有限数，收到 ${cellSize}`);
    }
    this.cellSize = cellSize;
  }

  /**
   * 清空全部内容。内部桶与平行数组结构整体复用（截断而非重建），
   * 稳态下「每帧 clear + 重新 insert」不产生大对象分配。
   */
  clear(): void {
    for (const inner of this.columns.values()) {
      for (const bucket of inner.values()) {
        bucket.length = 0;
        if (this.bucketPool.length < MAX_BUCKET_POOL) this.bucketPool.push(bucket);
      }
      inner.clear();
    }
    // 保留 this.columns 中的 inner Map 实例供后续 insert 复用，消除每帧重新分配 Map 的 GC 压力
    this.items.length = 0;
    this.px.length = 0;
    this.py.length = 0;
    this.pr.length = 0;
    this.minCx.length = 0;
    this.maxCx.length = 0;
    this.minCy.length = 0;
    this.maxCy.length = 0;
    this.stamp.length = 0;
    this.slotOf.clear();
    this.freeSlots.length = 0;
  }

  /**
   * 插入 item 并记录 (x, y, radius)，按圆的 AABB 覆盖范围链接到所有相关格子
   * （radius 缺省/非正按 0 处理 = 单格）。
   * 同一 item 重复 insert 视为「移动」：先解除旧格子链接，再按新位置链接，
   * 因此查询永远不会因移动而返回幽灵引用或重复结果。
   * 坐标必须为有限数（NaN/Infinity 直接抛错，防止格子索引死循环）。
   */
  insert(item: T, x: number, y: number, radius?: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new RangeError(`insert 坐标必须为有限数，收到 (${x}, ${y})`);
    }
    const r = radius !== undefined && radius > 0 ? radius : 0;

    let slot = this.slotOf.get(item);
    if (slot === undefined) {
      const recycled = this.freeSlots.pop();
      if (recycled === undefined) {
        slot = this.items.length;
        this.items.push(item);
        this.px.push(0);
        this.py.push(0);
        this.pr.push(0);
        this.minCx.push(0);
        this.maxCx.push(0);
        this.minCy.push(0);
        this.maxCy.push(0);
        this.stamp.push(0);
      } else {
        slot = recycled;
        this.items[slot] = item;
      }
      this.slotOf.set(item, slot);
    } else {
      // 移动语义：按记录的格子范围解除旧链接，再链接新范围。
      this.unlinkRange(slot, this.minCx[slot], this.maxCx[slot], this.minCy[slot], this.maxCy[slot]);
    }

    this.px[slot] = x;
    this.py[slot] = y;
    this.pr[slot] = r;

    const cs = this.cellSize;
    const minCx = Math.floor((x - r) / cs);
    const maxCx = Math.floor((x + r) / cs);
    const minCy = Math.floor((y - r) / cs);
    const maxCy = Math.floor((y + r) / cs);
    this.minCx[slot] = minCx;
    this.maxCx[slot] = maxCx;
    this.minCy[slot] = minCy;
    this.maxCy[slot] = maxCy;

    for (let cx = minCx; cx <= maxCx; cx++) {
      let inner = this.columns.get(cx);
      if (inner === undefined) {
        inner = new Map<number, number[]>();
        this.columns.set(cx, inner);
      }
      for (let cy = minCy; cy <= maxCy; cy++) {
        let bucket = inner.get(cy);
        if (bucket === undefined) {
          bucket = this.bucketPool.pop() ?? [];
          inner.set(cy, bucket);
        }
        bucket.push(slot);
      }
    }
  }

  /**
   * 增量移除（明确定义）：解除该 item 的全部格子链接并清除其记录，之后 queryCircle 不再返回它。
   * - 参数 (x, y, radius) 与 insert 对称：先按参数推导的格子范围解除链接（快路径）；
   * - 若参数与最近一次 insert 的记录不一致，再按记录范围兜底解除——任何参数组合下都
   *   不会泄漏格子引用（错误范围只是空解除，真实链接始终按记录清理）；
   * - 移除从未插入 / 已移除的 item 是安全 no-op（幂等）；
   * - 移除后可重新 insert（复用空闲槽位）。
   */
  remove(item: T, x: number, y: number, radius?: number): void {
    const slot = this.slotOf.get(item);
    if (slot === undefined) return;

    // 先按调用方给的 (x, y, radius) 推导格子范围解除链接（与 insert 对称的快路径）。
    let hMinCx = Number.NaN;
    let hMaxCx = Number.NaN;
    let hMinCy = Number.NaN;
    let hMaxCy = Number.NaN;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const r = radius !== undefined && radius > 0 ? radius : 0;
      const cs = this.cellSize;
      hMinCx = Math.floor((x - r) / cs);
      hMaxCx = Math.floor((x + r) / cs);
      hMinCy = Math.floor((y - r) / cs);
      hMaxCy = Math.floor((y + r) / cs);
      this.unlinkRange(slot, hMinCx, hMaxCx, hMinCy, hMaxCy);
    }
    // 参数与 insert 记录不一致（或参数非法）时，再按记录范围兜底解除，保证不泄漏格子引用。
    if (
      hMinCx !== this.minCx[slot] || hMaxCx !== this.maxCx[slot] ||
      hMinCy !== this.minCy[slot] || hMaxCy !== this.maxCy[slot]
    ) {
      this.unlinkRange(slot, this.minCx[slot], this.maxCx[slot], this.minCy[slot], this.maxCy[slot]);
    }

    this.slotOf.delete(item);
    this.freeSlots.push(slot);
  }

  /**
   * 圆范围查询：返回所有与查询圆相交（dist <= r + item.radius，恰好相切算相交）的 item，
   * 不含重复（跨多格 / 重复命中的 item 只返回一次）。结果数组默认每次新建，调用方可自由持有；
   * 传入 out 时复用调用方数组（清空后填充并原样返回，零分配）——热路径专用约定：结果只在
   * 下一次对本实例的查询之前有效，期间不得在结果遍历中再发起对本实例的嵌套查询、不得跨帧持有。
   * 输入约定：x/y/r 为有限数、r >= 0；非法输入（NaN/Infinity/负 r）返回空数组。
   */
  queryCircle(x: number, y: number, r: number, out?: T[]): T[] {
    const result = out ?? [];
    result.length = 0;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(r >= 0) || !Number.isFinite(r)) {
      return result;
    }

    const cs = this.cellSize;
    const minCx = Math.floor((x - r) / cs);
    const maxCx = Math.floor((x + r) / cs);
    const minCy = Math.floor((y - r) / cs);
    const maxCy = Math.floor((y + r) / cs);
    const qid = ++this.queryId;
    const { columns, px, py, pr, items, stamp } = this;

    for (let cx = minCx; cx <= maxCx; cx++) {
      const inner = columns.get(cx);
      if (inner === undefined) continue;
      for (let cy = minCy; cy <= maxCy; cy++) {
        const bucket = inner.get(cy);
        if (bucket === undefined) continue;
        for (let i = 0; i < bucket.length; i++) {
          const slot = bucket[i];
          if (stamp[slot] === qid) continue; // 跨格去重
          stamp[slot] = qid;
          const dx = px[slot] - x;
          const dy = py[slot] - y;
          const rr = r + pr[slot];
          if (dx * dx + dy * dy <= rr * rr) result.push(items[slot]);
        }
      }
    }
    return result;
  }

  /**
   * 矩形范围查询（F2 弹丸扫掠碰撞的候选集粗查询）：返回「item 圆与查询矩形外扩 pad 后
   * 的圆角盒相交」的全部 item，即 clampDist(中心, 矩形) <= item.radius + pad（恰好相切算
   * 相交）。语义是「线段胶囊判交」的必要条件粗过滤（零漏判）：与线段胶囊（段 AABB ⊕
   * (item.radius + pad)）相交的 item 圆，其圆心到段 AABB 的距离必 <= item.radius + pad
   * （clamp 距离的逐轴分量均不超过该值），而 item 按自身圆 AABB（圆心 ± item.radius）
   * 链接格子——该 AABB 必与「矩形 ⊕ pad」的坐标盒相交（逐轴：圆心在盒内平凡成立，
   * 圆心在盒外则近端边缘已伸入 pad 余量内），故两者必共享至少一个格子，cell 遍历范围
   * 只需按 pad 外扩即可覆盖全部过滤通过的 item，与 item 半径分布无关（无需按最大半径
   * 额外外扩，热路径扫描格数与 queryCircle 同量级）。调用方须再做精确几何判定
   * （如点-线段距离）。out 复用约定与 queryCircle 相同（结果仅在下一次对本实例的查询前
   * 有效）。输入约定：坐标有限、pad >= 0；min/max 颠倒自动交换；非法输入
   * （NaN/Infinity/负 pad）返回空数组。
   */
  queryRect(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    pad: number,
    out?: T[],
  ): T[] {
    const result = out ?? [];
    result.length = 0;
    if (
      !Number.isFinite(minX) || !Number.isFinite(minY) ||
      !Number.isFinite(maxX) || !Number.isFinite(maxY) ||
      !(pad >= 0) || !Number.isFinite(pad)
    ) {
      return result;
    }
    if (minX > maxX) {
      const t = minX;
      minX = maxX;
      maxX = t;
    }
    if (minY > maxY) {
      const t = minY;
      minY = maxY;
      maxY = t;
    }

    const cs = this.cellSize;
    const minCx = Math.floor((minX - pad) / cs);
    const maxCx = Math.floor((maxX + pad) / cs);
    const minCy = Math.floor((minY - pad) / cs);
    const maxCy = Math.floor((maxY + pad) / cs);
    const qid = ++this.queryId;
    const { columns, px, py, pr, items, stamp } = this;

    for (let cx = minCx; cx <= maxCx; cx++) {
      const inner = columns.get(cx);
      if (inner === undefined) continue;
      for (let cy = minCy; cy <= maxCy; cy++) {
        const bucket = inner.get(cy);
        if (bucket === undefined) continue;
        for (let i = 0; i < bucket.length; i++) {
          const slot = bucket[i];
          if (stamp[slot] === qid) continue; // 跨格去重
          stamp[slot] = qid;
          // 圆心对矩形的最近点距离（clamp 距离）<= item 自身半径 + pad 判交。
          const ix = px[slot];
          const iy = py[slot];
          const qx = ix < minX ? minX : ix > maxX ? maxX : ix;
          const qy = iy < minY ? minY : iy > maxY ? maxY : iy;
          const dx = ix - qx;
          const dy = iy - qy;
          const rr = pr[slot] + pad;
          if (dx * dx + dy * dy <= rr * rr) result.push(items[slot]);
        }
      }
    }
    return result;
  }

  /** 解除某槽位在给定闭区间格子范围内的全部链接；桶变空则删除条目并回收桶数组。 */
  private unlinkRange(slot: number, minCx: number, maxCx: number, minCy: number, maxCy: number): void {
    for (let cx = minCx; cx <= maxCx; cx++) {
      const inner = this.columns.get(cx);
      if (inner === undefined) continue;
      for (let cy = minCy; cy <= maxCy; cy++) {
        const bucket = inner.get(cy);
        if (bucket === undefined) continue;
        const idx = bucket.indexOf(slot);
        if (idx < 0) continue;
        const last = bucket.length - 1;
        bucket[idx] = bucket[last];
        bucket.pop();
        if (bucket.length === 0) {
          inner.delete(cy);
          if (this.bucketPool.length < MAX_BUCKET_POOL) this.bucketPool.push(bucket);
        }
      }
    }
  }
}
