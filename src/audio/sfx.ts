// src/audio/sfx.ts —— WebAudio 合成音效引擎（T4.1）。
// 零外部素材：全部用 OscillatorNode / 噪声 Buffer + Gain 包络即时合成；
// 主人声链 master Gain → DynamicsCompressor（简单限幅）→ destination，防爆音。
// 分层契约：WebAudio / localStorage 只允许出现在 src/audio（本文件）与 src/ui；
// 纯节流决策在 src/core/audioThrottle（可测），本文件只做「决策消费 + 声音合成」。
//
// 自动播放策略：AudioContext 惰性创建——initAudio() 注册任意 pointerdown 手势，
// 首次手势时创建/恢复上下文；此前的一切 playSfx 调用静默忽略。
// 开关持久化：localStorage key `survivor.sfx`（'1' 开 / '0' 关，缺省开）；
// localStorage 异常（隐私模式等）try/catch 降级为内存态。

import { createSfxThrottle } from '../core/audioThrottle';

/** 开关持久化键名：'1' = 开、'0' = 关（缺省开）。 */
const STORAGE_KEY = 'survivor.sfx';

/** 同类音效最小间隔（ms）与滑动窗口上限：见 audioThrottle（榴弹/激光高射速防糊爆）。 */
const THROTTLE_MIN_INTERVAL_MS: Record<string, number> = {
  shoot: 60,
  hit: 40,
  burst: 250,
  levelUp: 300,
  wallHit: 90,
  bossDown: 500,
  victory: 1000,
  defeat: 1000,
  uiClick: 80,
  // 蓄能狙击一次性反馈（G5）：core 推送层不节流（稀有事件），音频侧仍留保守间隔
  // 防多弹同帧爆头/处决叠音糊爆。
  crit: 80,
  execute: 150,
  // 协同开火触发音（G6）：同 crit/execute 约定（core 一次性推送不节流），音频侧 300ms
  // 保守间隔——协同触发间隔 ≥ 数秒，仅防极端叠音。
  coordinated: 300,
  // 首领降临警报音（模块 C）
  bossWarning: 1000,
};
const THROTTLE_DEFAULT_MIN_INTERVAL_MS = 40;
const THROTTLE_WINDOW_MS = 20; // ≈一帧（60fps）
const THROTTLE_MAX_PER_WINDOW = 6;

// —— 模块级状态（惰性初始化） ——

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let gestureUnlocked = false; // 首次 pointerdown 后为 true（此前浏览器禁止出声）
let inited = false; // initAudio 只接线一次

/** 开关状态：localStorage 可用时持久化，异常（隐私模式）降级为纯内存态。 */
let enabled = readEnabledPref();

function readEnabledPref(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0'; // 缺省开；仅显式 '0' 视为关
  } catch {
    return true;
  }
}

function persistEnabledPref(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    // 隐私模式等异常：降级为内存态（本局内开关仍生效，不跨会话记忆）。
  }
}

/** 节流器：core 纯逻辑（可测），时间基准用 performance.now（本层允许 DOM/BOM）。 */
const throttle = createSfxThrottle({
  minIntervalMs: THROTTLE_MIN_INTERVAL_MS,
  defaultMinIntervalMs: THROTTLE_DEFAULT_MIN_INTERVAL_MS,
  windowMs: THROTTLE_WINDOW_MS,
  maxPerWindow: THROTTLE_MAX_PER_WINDOW,
});

// —— 音频图构建（全部惰性） ——

/** 惰性创建 AudioContext 与主人声链（master Gain → 限幅 Compressor → 输出）。 */
function ensureContext(): AudioContext | null {
  if (ctx === null) {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AC === undefined) {
      return null; // 极老浏览器无 WebAudio：整层静默降级
    }
    ctx = new AC();

    master = ctx.createGain();
    master.gain.value = 0.85;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -14; // 提前压顶：多音叠加峰值不破
    limiter.knee.value = 18;
    limiter.ratio.value = 10;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;

    master.connect(limiter);
    limiter.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') {
    void ctx.resume();
  }
  return ctx;
}

/**
 * 确定性白噪声 Buffer（1s，LCG 固定种子）：项目契约禁 Math.random，
 * 噪声样本用线性同余生成器产出（每次创建结果一致，可复现）。
 */
function ensureNoiseBuffer(c: AudioContext): AudioBuffer {
  if (noiseBuffer === null) {
    const buffer = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const data = buffer.getChannelData(0);
    let s = 0x2f6e2b1 >>> 0; // 固定种子
    for (let i = 0; i < data.length; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      data[i] = (s / 0xffffffff) * 2 - 1;
    }
    noiseBuffer = buffer;
  }
  return noiseBuffer;
}

// —— 合成原语（每个声音即时建节点、播完自毁，稳态无驻留） ——

interface ToneOpts {
  type: OscillatorType;
  freq: number;
  /** 结束频率（Hz）：给则是频率滑音（指数渐变，必须 > 0）。 */
  freqEnd?: number;
  /** 相对 startAt 的起始偏移（s）。 */
  delay?: number;
  dur: number;
  peak: number;
  /** 起音时长（s），缺省 0.008。 */
  attack?: number;
}

/** 单振荡器 + Gain 包络（指数衰减）。 */
function tone(c: AudioContext, startAt: number, o: ToneOpts): void {
  if (master === null) {
    return;
  }
  const osc = c.createOscillator();
  const g = c.createGain();
  const t0 = startAt + (o.delay ?? 0);
  const attack = o.attack ?? 0.008;

  osc.type = o.type;
  osc.frequency.setValueAtTime(o.freq, t0);
  if (o.freqEnd !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.freqEnd), t0 + o.dur);
  }
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(o.peak, t0 + Math.min(attack, o.dur * 0.5));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);

  osc.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + o.dur + 0.05);
  osc.onended = () => {
    osc.disconnect();
    g.disconnect();
  };
}

interface NoiseOpts {
  filter: BiquadFilterType;
  freq: number;
  /** 滤波频率结束值（Hz）：给则滑音（闷/亮变化）。 */
  freqEnd?: number;
  q?: number;
  delay?: number;
  dur: number;
  peak: number;
}

/** 噪声 burst（经 Biquad 滤波染色 + Gain 包络）：hit / wallHit 的打击质感。 */
function noiseHit(c: AudioContext, startAt: number, o: NoiseOpts): void {
  if (master === null) {
    return;
  }
  const src = c.createBufferSource();
  src.buffer = ensureNoiseBuffer(c);
  const f = c.createBiquadFilter();
  const g = c.createGain();
  const t0 = startAt + (o.delay ?? 0);

  f.type = o.filter;
  f.frequency.setValueAtTime(o.freq, t0);
  if (o.freqEnd !== undefined) {
    f.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd), t0 + o.dur);
  }
  if (o.q !== undefined) {
    f.Q.value = o.q;
  }
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(o.peak, t0 + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);

  src.connect(f);
  f.connect(g);
  g.connect(master);
  src.start(t0);
  src.stop(t0 + o.dur + 0.05);
  src.onended = () => {
    src.disconnect();
    f.disconnect();
    g.disconnect();
  };
}

// —— 音效配方表：name → 合成函数（c = 上下文，t = 当前时刻，vol = 音量乘区） ——

/**
 * shoot：短促能量弹。基频按固定四步循环微调音高（确定性伪随机，无 Math.random），
 * 避免连射时完全同一音高的「机关枪机械感」。
 */
let shootStep = 0;
const SHOOT_PITCH_CYCLE = [1, 1.059, 0.944, 1.026]; // ≈ ±1 半音的确定循环

const VOICES: Record<string, (c: AudioContext, t: number, vol: number) => void> = {
  shoot(c, t, vol) {
    const f = 760 * SHOOT_PITCH_CYCLE[shootStep % SHOOT_PITCH_CYCLE.length];
    shootStep += 1;
    tone(c, t, { type: 'square', freq: f, freqEnd: 170, dur: 0.11, peak: 0.14 * vol });
    noiseHit(c, t, { filter: 'highpass', freq: 3200, dur: 0.03, peak: 0.05 * vol });
  },

  hit(c, t, vol) {
    // 短噪声 click：带通噪声瞬态 + 微弱低频衬底。
    noiseHit(c, t, { filter: 'bandpass', freq: 1900, freqEnd: 800, q: 1.2, dur: 0.06, peak: 0.2 * vol });
    tone(c, t, { type: 'sine', freq: 300, freqEnd: 120, dur: 0.05, peak: 0.08 * vol });
  },

  burst(c, t, vol) {
    // 低频警报双音：G3 → D3 两声方波，紧迫感。
    tone(c, t, { type: 'square', freq: 196, dur: 0.16, peak: 0.18 * vol, attack: 0.012 });
    tone(c, t, { type: 'square', freq: 147, delay: 0.19, dur: 0.24, peak: 0.22 * vol, attack: 0.012 });
  },

  levelUp(c, t, vol) {
    // 上行琶音：C5-E5-G5-C6（三角波，明亮）。
    tone(c, t, { type: 'triangle', freq: 523.25, dur: 0.12, peak: 0.2 * vol });
    tone(c, t, { type: 'triangle', freq: 659.25, delay: 0.085, dur: 0.12, peak: 0.2 * vol });
    tone(c, t, { type: 'triangle', freq: 783.99, delay: 0.17, dur: 0.12, peak: 0.2 * vol });
    tone(c, t, { type: 'triangle', freq: 1046.5, delay: 0.255, dur: 0.26, peak: 0.22 * vol });
  },

  wallHit(c, t, vol) {
    // 闷响低音：低频正弦下坠 + 低通噪声（墙体受击质感；vol 随伤害量缩放）。
    tone(c, t, { type: 'sine', freq: 88, freqEnd: 42, dur: 0.28, peak: 0.4 * vol, attack: 0.004 });
    noiseHit(c, t, { filter: 'lowpass', freq: 420, freqEnd: 120, dur: 0.16, peak: 0.16 * vol });
  },

  bossDown(c, t, vol) {
    // 庄重低鸣：C2 + G2 双正弦慢起音长衰减。
    tone(c, t, { type: 'sine', freq: 65.41, dur: 1.4, peak: 0.3 * vol, attack: 0.06 });
    tone(c, t, { type: 'sine', freq: 98, delay: 0.05, dur: 1.2, peak: 0.16 * vol, attack: 0.08 });
  },

  victory(c, t, vol) {
    // 胜利小旋律：C5-E5-G5 上行 + C6-G5 收束长音。
    tone(c, t, { type: 'triangle', freq: 523.25, dur: 0.14, peak: 0.2 * vol });
    tone(c, t, { type: 'triangle', freq: 659.25, delay: 0.13, dur: 0.14, peak: 0.2 * vol });
    tone(c, t, { type: 'triangle', freq: 783.99, delay: 0.26, dur: 0.14, peak: 0.2 * vol });
    tone(c, t, { type: 'triangle', freq: 1046.5, delay: 0.39, dur: 0.42, peak: 0.22 * vol });
    tone(c, t, { type: 'triangle', freq: 783.99, delay: 0.39, dur: 0.42, peak: 0.1 * vol });
  },

  defeat(c, t, vol) {
    // 下行低沉：A3-F3-D3-A2 逐级下坠（三角波）+ A1 低音垫底。
    tone(c, t, { type: 'triangle', freq: 220, dur: 0.26, peak: 0.2 * vol });
    tone(c, t, { type: 'triangle', freq: 174.61, delay: 0.28, dur: 0.26, peak: 0.2 * vol });
    tone(c, t, { type: 'triangle', freq: 146.83, delay: 0.56, dur: 0.3, peak: 0.22 * vol });
    tone(c, t, { type: 'triangle', freq: 110, delay: 0.88, dur: 0.8, peak: 0.24 * vol });
    tone(c, t, { type: 'sine', freq: 55, delay: 0.88, dur: 1.0, peak: 0.18 * vol, attack: 0.04 });
  },

  uiClick(c, t, vol) {
    // 按钮轻点：短促高频正弦。
    tone(c, t, { type: 'sine', freq: 1150, dur: 0.045, peak: 0.12 * vol });
  },

  crit(c, t, vol) {
    // 爆头金属脆响（G5）：短促高亢——高频方波瞬间下滑（金属「叮」）+ 高倍频正弦泛音
    // + 窄带通噪声瞬态（敲击质感）。音量克制（峰值 ≤0.11），一发一个脆点不喧宾夺主。
    tone(c, t, { type: 'square', freq: 2350, freqEnd: 1450, dur: 0.07, peak: 0.11 * vol });
    tone(c, t, { type: 'sine', freq: 3520, freqEnd: 2800, dur: 0.05, peak: 0.07 * vol });
    noiseHit(c, t, { filter: 'bandpass', freq: 5200, q: 2.5, dur: 0.035, peak: 0.1 * vol });
  },

  execute(c, t, vol) {
    // 死刑宣告「斩落」声（G5）：低沉——锯齿波低频下坠（220→55Hz，刀锋落下的重量感）
    // + 低通噪声扫落（「唰」）+ 亚低频正弦收尾（落地震底）。
    tone(c, t, { type: 'sawtooth', freq: 220, freqEnd: 55, dur: 0.32, peak: 0.2 * vol, attack: 0.004 });
    noiseHit(c, t, { filter: 'lowpass', freq: 900, freqEnd: 160, dur: 0.22, peak: 0.13 * vol });
    tone(c, t, { type: 'sine', freq: 110, freqEnd: 40, dur: 0.4, peak: 0.16 * vol, attack: 0.01 });
  },

  coordinated(c, t, vol) {
    // 协同开火「蓄势-齐发」双音（G6）：前半 = 方波快速八度上滑（D5→D6，全队蓄势感），
    // 后半 = 三角波 D6 + A6 纯五度双音齐发（明亮收束：「全队同时开火」）。与爆头金属
    // 脆响 / 处决斩落声色相区分；音量克制（峰值 ≤0.12）。
    tone(c, t, { type: 'square', freq: 587.33, freqEnd: 1174.66, dur: 0.08, peak: 0.08 * vol });
    tone(c, t, { type: 'triangle', freq: 1174.66, delay: 0.085, dur: 0.18, peak: 0.12 * vol });
    tone(c, t, { type: 'triangle', freq: 1760, delay: 0.085, dur: 0.14, peak: 0.07 * vol });
  },

  bossWarning(c, t, vol) {
    // 警报鸣响（模块 C）：锯齿波下行扫频 + 紧急双蜂鸣（重度警告感）
    tone(c, t, { type: 'sawtooth', freq: 720, freqEnd: 240, dur: 0.35, peak: 0.28 * vol, attack: 0.005 });
    noiseHit(c, t, { filter: 'bandpass', freq: 1200, q: 3.0, dur: 0.25, peak: 0.12 * vol });
    tone(c, t, { type: 'square', freq: 880, delay: 0.38, dur: 0.12, peak: 0.18 * vol });
    tone(c, t, { type: 'square', freq: 880, delay: 0.54, dur: 0.15, peak: 0.22 * vol });
  },
};

// —— 对外 API ——

/** 接线音频层：注册首次手势解锁（惰性创建/恢复 AudioContext）。在 src/main.ts 调用一次。 */
export function initAudio(): void {
  if (inited) {
    return;
  }
  inited = true;
  const unlock = (): void => {
    gestureUnlocked = true;
    ensureContext(); // 首次手势即创建（后续手势仅负责 resume）
  };
  // 不用 once：挂起状态（切后台回来）时每次手势都尝试恢复，开销可忽略。
  window.addEventListener('pointerdown', unlock, { passive: true });
}

/** 开/关音效（持久化到 localStorage，异常降级内存态）。 */
export function setEnabled(on: boolean): void {
  enabled = on;
  persistEnabledPref(on);
}

/** 当前开关状态（开关按钮初始化文案用）。 */
export function isSfxEnabled(): boolean {
  return enabled;
}

/** 音量乘区上/下限（wallDamaged 按伤害缩放时的夹取范围）。 */
const GAIN_MIN = 0.1;
const GAIN_MAX = 1.5;

/**
 * 播放一个音效（节流决策 → 合成）：
 * - 关闭状态 / 首次手势前 / 未知名 / 节流丢弃 → 静默忽略；
 * - opts.gain：音量乘区（如 wallHit 随伤害量缩放），夹取 [0.1, 1.5]。
 */
export function playSfx(name: string, opts?: { gain?: number }): void {
  if (!enabled || !gestureUnlocked) {
    return;
  }
  const voice = VOICES[name];
  if (voice === undefined) {
    return; // 未知名：不消耗节流配额，直接忽略
  }
  if (!throttle.tryPlay(name, performance.now())) {
    return; // 同类间隔内 / 窗口满：丢弃（榴弹/激光高射速防糊爆）
  }
  const c = ensureContext();
  if (c === null || ctx === null) {
    return;
  }
  const vol = Math.max(GAIN_MIN, Math.min(GAIN_MAX, opts?.gain ?? 1));
  voice(c, ctx.currentTime + 0.001, vol);
}
