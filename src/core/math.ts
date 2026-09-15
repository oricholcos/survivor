// src/core/math.ts —— 向量/几何纯函数（{x, y} 最小结构，零依赖）
// 全部为纯函数：不修改入参、不依赖外部状态；数值计算路径零临时对象分配。
// 纯 TypeScript，禁止 import phaser / DOM。

/** 二维向量/点的最小结构约定（结构性类型，任何含 x/y 的对象都兼容）。 */
export interface Vec2 {
  x: number;
  y: number;
}

/** 向量加法 a + b。 */
export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

/** 向量减法 a - b。 */
export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

/** 标量缩放 v * k。 */
export function scale(v: Vec2, k: number): Vec2 {
  return { x: v.x * k, y: v.y * k };
}

/** 点积 a·b。 */
export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/** 长度平方。 */
export function lenSq(v: Vec2): number {
  return v.x * v.x + v.y * v.y;
}

/** 欧几里得长度。 */
export function len(v: Vec2): number {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

/** 两点距离平方（避免先构造差向量，热路径零分配）。 */
export function distSq(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** 两点欧几里得距离。 */
export function dist(a: Vec2, b: Vec2): number {
  return Math.sqrt(distSq(a, b));
}

/**
 * 单位化：返回同方向、长度 1 的向量。
 * 零向量无方向：约定返回 { x: 0, y: 0 } 而非 NaN，调用方无需判空。
 */
export function normalize(v: Vec2): Vec2 {
  const l = Math.sqrt(v.x * v.x + v.y * v.y);
  if (l === 0) {
    return { x: 0, y: 0 };
  }
  return { x: v.x / l, y: v.y / l };
}

/** 标量钳制到 [min, max]（区间内原样，越界钳到最近边界）。 */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
