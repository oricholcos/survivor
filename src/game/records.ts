// src/game/records.ts —— 最佳纪录（T4.2）：无尽最长存活 / 通关达成标记 / 历史最高击杀。
//
// 分层：localStorage 属 DOM/BOM——按项目契约只允许出现在 src/ui 与 src/game；
// 本文件位于 src/game 合成层（src/core 保持纯逻辑，绝不 import 本模块）。
// 持久化：localStorage key `survivor.records.v1`（与音效开关的 `survivor.sfx` 同为
// `survivor.` 命名空间、不同 key，互不干扰），整包 JSON 序列化存取。
// 降级：脏数据（JSON 解析失败 / 字段类型不对）逐字段回默认值，绝不抛错；
// 存储不可用（隐私模式等）时读写均 try/catch——写失败降级为内存态
// （本会话内纪录仍然可见，但不跨会话记忆；后续写成功则自动交还存储为权威）。

import type { GameMode } from '../core/victory';

/** 纪录结构（读取时逐字段校验，脏数据回默认值）。 */
export interface Records {
  /** 无尽模式最长存活（ms）；null = 尚无纪录。 */
  bestEndlessMs: number | null;
  /** 通关模式通关标记（一次性：一旦达成永久保留）。 */
  campaignCleared: boolean;
  /** 历史最高击杀（两模式共享）。 */
  bestKills: number;
}

/** 单局结算结果（驱动 UI 的「新纪录！」「首次通关！」标记）。 */
export interface RecordResult {
  /** 更新后的纪录（已计入本局贡献；与 UI 展示值同源）。 */
  records: Records;
  /** 本局是否刷新了无尽最长存活。 */
  newBestEndless: boolean;
  /** 本局是否为首次通关（campaignCleared 由 false → true 的那一局）。 */
  firstClear: boolean;
  /** 本局是否刷新了历史最高击杀。 */
  newBestKills: boolean;
}

/** localStorage key（survivor.records.v1）。 */
const STORAGE_KEY = 'survivor.records.v1';

/** 默认纪录（尚无纪录 / 脏数据回退目标）。 */
const DEFAULT_RECORDS: Records = { bestEndlessMs: null, campaignCleared: false, bestKills: 0 };

/**
 * 内存降级态：localStorage 不可用（隐私模式等）时暂存最新纪录。
 * 仅在写失败时置位；此后读取优先于存储（写一旦恢复成功即清空，交还存储为权威）。
 */
let memoryFallback: Records | null = null;

/** 合法时长值：有限非负数（存活 ms 允许小数）。 */
function isNonNegativeFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** 脏数据校验：对未知来源的 JSON 逐字段校验，非法字段回默认值（绝不抛错）。 */
function sanitizeRecords(raw: unknown): Records {
  const records: Records = { ...DEFAULT_RECORDS };
  if (typeof raw !== 'object' || raw === null) {
    return records; // 基本类型 / null / 数组等一律按全默认处理
  }
  const obj = raw as { [key: string]: unknown };
  const bestEndlessMs = obj['bestEndlessMs'];
  if (bestEndlessMs === null || isNonNegativeFinite(bestEndlessMs)) {
    records.bestEndlessMs = bestEndlessMs;
  }
  if (typeof obj['campaignCleared'] === 'boolean') {
    records.campaignCleared = obj['campaignCleared'];
  }
  const bestKills = obj['bestKills'];
  if (typeof bestKills === 'number' && Number.isSafeInteger(bestKills) && bestKills >= 0) {
    records.bestKills = bestKills;
  }
  return records;
}

/** 读存储（键不存在 / JSON 脏 / 存储不可用 → null，由调用方回默认）。 */
function readStored(): Records | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    return sanitizeRecords(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/** 写存储（失败 → 内存降级态接管；成功 → 清空降级态，存储重新为权威）。 */
function writeStored(records: Records): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    memoryFallback = null;
  } catch {
    memoryFallback = { ...records };
  }
}

/** 读取纪录：内存降级态优先（存储不可用期间），其次存储；均无 → 默认。 */
export function loadRecords(): Records {
  if (memoryFallback !== null) {
    return { ...memoryFallback };
  }
  return readStored() ?? { ...DEFAULT_RECORDS };
}

/**
 * 单局结算进纪录（UI 在 victory / gameOver 时调用，每局恰好一次）：
 * - endless：survivedMs > bestEndlessMs 时刷新（null = 尚无纪录，任意存活即立首条）；
 * - campaign：won → campaignCleared = true（一次性标记；重复通关不覆盖，firstClear 仅首次为 true）；
 * - kills > bestKills 时刷新历史最高击杀（两模式共享）；
 * - 立即持久化（try/catch：写失败降级内存态）；无任何刷新则跳过写入。
 */
export function recordResult(
  mode: GameMode,
  survivedMs: number,
  kills: number,
  won: boolean,
): RecordResult {
  const records = loadRecords();
  const result: RecordResult = {
    records,
    newBestEndless: false,
    firstClear: false,
    newBestKills: false,
  };

  if (mode === 'endless' && (records.bestEndlessMs === null || survivedMs > records.bestEndlessMs)) {
    records.bestEndlessMs = survivedMs;
    result.newBestEndless = true;
  }

  if (mode === 'campaign' && won && !records.campaignCleared) {
    records.campaignCleared = true;
    result.firstClear = true;
  }

  if (kills > records.bestKills) {
    records.bestKills = kills;
    result.newBestKills = true;
  }

  if (result.newBestEndless || result.firstClear || result.newBestKills) {
    writeStored(records);
  }
  return result;
}
