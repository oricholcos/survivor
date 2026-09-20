# 难度调整执行计划 — 战役收紧 + 无尽曲线重设计

> 执行会话须知：本文档是完整交接，无需其他会话上下文。所有「当前值」以 2026-09-20 的
> `feature/dev-continue` 分支基线（提交 `0124986`）为准。

---

## 0. 背景与基线

### 问题诊断（自动化面板 + 真人试玩反馈）

1. **战役（600s）偏易、终局失压**：3 个回归种子全胜，墙损只集中在 240~390s，
   390~600s 零压力，seed 2024 全程零墙损。根因：
   - 敌方血量线性膨胀（`hpPerSec 0.0096`，终局仅 ×6.76）vs 玩家乘区成长
     （`dmg_up` ×1.3 可叠 12 层 + 攻速/多射/连射/分裂计数牌），终局 DPS 超需求 5 倍以上；
   - 续航供给过厚：修复包（2% × 30 HP × ~1500 击杀 ≈ 900）+ Boss 回墙
     （5.5% × 1600 × 5 只 ≈ 440），合计 ≈ 1340 = 墙池的 84%。
2. **无尽是「假无尽」**：600s 后每 40s 一个循环，单标量 `loopScale = scalingPerLoop^k = 2^k`
   **同时驱动血量、刷怪密度、经验**，全部每 40s 翻倍：
   - 真人约 12 分钟（720s，loopScale ×8，尾段 runner 7/s × 8 = 56/s 刷怪）即屏幕堆满、快速战败；
   - 「血量提升太快」：40s 翻一倍 = 200s 内 ×32；
   - 击退/眩晕类武器（震波壁垒、霰弹击退）成为唯一显著延长生存的构筑——终局死因是
     「杀不掉的怪堆在墙下啃墙」，只有 CC 能把它们从墙上推开。

### 基线面板（`npx vitest run src/core/balance.test.ts`，2026-09-20 实测）

| 对局 | 结果 | 关键指标 |
|---|---|---|
| campaign seed 7 | victory @600.0s | 最低墙血 86.3% @371.4s，击杀 1575，Lv.37 |
| campaign seed 42 | victory @600.0s | 最低墙血 84.7% @369.2s，击杀 1484，Lv.37 |
| campaign seed 2024 | victory @600.0s | 最低墙血 100%（全程零墙损），击杀 1574，Lv.37 |
| endless seed 2024 | defeat @982.5s | Lv.54，击杀 4585，loop=10（×1024） |

墙损直方图：seed 7 仅 240~390s 有伤（合计 ~460）；seed 42 仅 330~390s（~275）；seed 2024 无。

---

## 1. 目标

- **战役**：390~600s 出现真实咬合，通关种子最低墙血落到 **50~70%** 区间；保持 ≥1 种子
  victory（允许出现 defeat 种子——混合面板比全员通关更健康）。
- **无尽**：把「每 40s 全体翻倍的悬崖」改成「长坡」——血量翻倍时间 40s → **约 70~95s**；
  屏幕饱和点推迟到收敛点附近；真人可玩 **15~20 分钟**；自动代理收敛 **1250~1550s**
  （测试 cap 1800s 内留余量）。
- **架构不变量**：死亡必然收敛。玩家 DPS 被 hardMax 封顶是 M17 性能护栏，**不得放开**
  （有界 DPS 对无界血量必然收敛，「真·无尽」在本架构下不存在且不应存在）。

## 2. 原则约束（项目既有契约）

- 数值只存在于 `src/data/` 的 JSON；行为代码不得硬编码数值。第二轮的代码改动是
  「新增数据通路」（新 JSON 键的解析与消费），语义仍由 JSON 驱动。
- 确定性：不引入任何新随机源。
- 测试校准惯例：`balance.test.ts` 断言校准遵循「**最小校准、语义保留**」，并在文件头
  注释追加校准记录与新基线面板（M/W/F/G/H 历轮均如此，照做）。
- core 层禁止 import phaser / DOM（ESLint 强制）。
- 提交节奏由用户决定；建议每轮一个提交，便于按轮回退。

---

## 3. 第一轮：战役收紧（纯数据，4 处必改 + 1 可选）

| # | 文件 / 键 | 现值 → 目标 | 说明 |
|---|---|---|---|
| 1 | `src/data/waves.json` → `scaling.hpPerSec` | 0.0096 → **0.013** | 主杠杆。终局倍率 ×6.76 → ×8.8；210s 处 ×3.02 → ×3.73，成长窗口基本不动（当前通关种子前 210s 墙损为 0，余量充足） |
| 2 | `src/data/config.json` → `repairDropChance` | 0.02 → **0.015** | 续航削减之一 |
| 3 | `src/data/enemies.json` → `boss_1.bossHealPct` | 0.055 → **0.045** | 续航合计 ≈1340（84% 墙池）→ ≈1000（61%），不改变怪潮手感、只剥隐性垫血 |
| 4a | `waves.json` timeline `fromSec: 300 / 370 / 500` 的 tank `perSec` | 0.7 → **1.0** | 定向打 390~600s 真空段：终局缺的是「啃得动墙的怪」（tank 28 伤/2s = 14 DPS/只），不是 runner 经验礼包 |
| 4b | `waves.json` timeline `fromSec: 560` 的 tank `perSec` | 1.68 → **2.2** | 同上（注意：此条目在无尽循环段内，见第二轮交互说明） |
| 4c | `waves.json` `fromSec: 580` burst tank `count` | 25 → **32** | 同上（也在循环段内） |
| 5（可选，默认不做） | `fromSec: 580` Boss 前移至 ~570s | — | 终局 Boss 现为装饰（剩 20s 打不死也走不到墙），价值低 |

**联动断言同步（改前先 grep）**：
- `src/core/waves.test.ts`：断言 `expect(REAL.scaling).toEqual({ hpPerSec: 0.0096 })` → 改 0.013；
  grep 对 580s burst `count: 25` 的断言并同步。
- `src/core/bossRewards.test.ts` / `src/core/gems.test.ts`：grep 是否断言 `0.055` / `0.02`
  （bossHealPct / repairDropChance），有则同步。

**执行后跑 balance 面板**，预期：通关种子最低墙血 50~70%。
**过调回退**（3 种子全部 defeat 或真人 300s 前崩盘）：按「晚期密度（4a-4c）→ hpPerSec →
续航」顺序逐项回半步（如 tank 1.0→0.85、0.013→0.012、0.015→0.018）。

---

## 4. 第二轮：无尽曲线重设计（2 处小代码 + 1 处 JSON）

核心思路：**把「一个指数」拆成「一条缓坡」**——血量/经验继续按循环膨胀但斜率大幅放缓，
刷怪密度与血量解耦、几乎不膨胀。屏幕堆满主要由密度翻倍造成，血量悬崖由 perLoop 翻倍
造成，两个痛点各自对症。

### 4.1 代码改动（ sketches，以现有代码风格与注释规范为准）

**`src/core/waveClock.ts`**：
- `EndlessConfig` 增可选字段 `densityPerLoop?: number`（密度逐轮膨胀系数）。
- `WaveClockResult` 增字段 `densityScale: number`。
- 线性分支（campaign / 脏配置 / 未过表尾）：`densityScale: 1`。
- 循环分支：`densityScale = (合法 densityPerLoop ?? scalingPerLoop) ** loopCount`；
  脏值（<=1 / NaN）回退 `scalingPerLoop`（与既有防呆风格一致）。

**`src/core/waves.ts`**：
- `WaveClockInput` 增可选字段 `densityScale?: number`（缺省/脏值回退 `loopScale`——
  兼容旧测试直构的 clock 字面量，零破坏）。
- `updateWaves` 提取局部变量 `densityScale`，**只改一行**：
  匀速段累加器 `meta.spawnAcc += spawnRule.perSec * (dtMs / 1000) * densityScale`
  （原乘 `loopScale`）。
- **其余全部不变**：`hpScale`（血量膨胀）、`applyHpScale` 的经验缩放、爆发波触发与
  strengthFactor、数量护栏。
- `gems.ts` 读 `WAVE_CLOCK_META_KEY.loopScale` 做升级需求膨胀——不变（经验需求仍随
  血量曲线同步膨胀，M17 设计自洽保留）。

兼容性：`session.ts` / `balance.test.ts` 把 `resolveWaveClock(...)` 结果直接传
`updateWaves`，结构化类型自动携带新字段，无需改调用方。

**`src/data/waves.json`**：

```json
"endlessLoop": { "loopFromSec": 560, "scalingPerLoop": 1.45, "densityPerLoop": 1.08 }
```

### 4.2 数值依据

- `scalingPerLoop 1.45`（区间 1.4~1.5）：血量/经验**翻倍时间 40s → ~75s**
  （1.4→82s，1.5→68s）。720s 处总血量倍率约 ×54（现状）→ ×27（含第一轮 hpPerSec
  0.013 后 8.8 × 1.45³）。
- `densityPerLoop 1.08`（区间 1.05~1.15）：循环 20（~1400s）时密度仅 ×4.7，而现状设计
  为 ×835（实际被 `maxEnemies: 350` 钳死 = 屏幕堆满）。密度保守起步：用户主诉就是堆屏。
- 交互说明：第一轮 hpPerSec 0.013 把循环段时间因子 6.38~6.76 抬到 8.28~8.80（+~30%），
  且 4b/4c 抬高了循环段基础密度——都会小幅提前无尽收敛，属预期，终值以面板为准。
- 击退垄断问题自解：坡拉长后非 CC 构筑也有 15+ 分钟表达空间，CC 从「唯一生存轴」
  退回「更稳的选择」。不给怪物对墙伤害加膨胀（需改模拟核心，且恶化非 CC 构筑体验）。

### 4.3 新增测试

- `src/core/waveClock.test.ts`：densityPerLoop 缺省回退（= loopScale）；指定 1.08 时逐轮
  densityScale ≠ loopScale；campaign/线性恒 1；脏值回退。
- `src/core/waves.test.ts`：匀速段刷怪计数乘 densityScale（构造小数累加器断言）；
  burst 血量与 count 不受 densityScale 影响。
- `src/core/balance.test.ts`：endless 断言集**语义不变**（≥560s、loopCount ≥1、
  loopScale >1、最终 defeat、cap 1800s 内收敛）；墙钟护栏**先实测再放宽**——无尽模拟
  时长 982s → ~1400s，但晚期实体密度大幅降低使每帧更便宜，预计总墙钟 35~50s，
  55s 护栏可能仍够；不够则放宽至 ~70s（环境度量，30→40→55 有先例）。

### 4.4 调参决策表（面板为准；目标：代理收敛 1250~1550s）

| 面板/试玩结果 | 动作 |
|---|---|
| 收敛 > 1700s | `scalingPerLoop` 1.45 → 1.5~1.55 |
| 收敛 < 1200s | `scalingPerLoop` 1.45 → 1.4；仍快 → 1.35 |
| 收敛前 >2 分钟屏幕饱和（存活敌顶 350）/ 真人反馈堆屏 | `densityPerLoop` 下调 0.02~0.04 |
| 10~15 分钟压力平淡、无爬升感 | `densityPerLoop` 上调 0.02 |

---

## 5.（可选三期，默认不做）循环段内容扩充

`loopFromSec` 560 → 500：循环段从 4 条目 40s 扩为 500~600s 共 10 条目 100s
（每轮 2 Boss + 3 爆发波，内容更丰富，缓解「10 分钟后无限重复同 40 秒」的乏味）。
保持等效每秒膨胀率需换算：`scalingPerLoop ≈ 2.5`、`densityPerLoop ≈ 1.2`（×^(100/40)）。
涉及 burst 跨循环重触发面变大，需回归 `waves.test.ts` 循环段用例。
**触发条件**：二期试玩反馈单调感明显时单独立项。

---

## 6. 验证协议（顺序执行）

1. 每轮改完即跑 `npx vitest run src/core/balance.test.ts`，记录 console 面板；
2. 按第 4.4 决策表调参至目标区间（单变量调整，一次只动一个系数）；
3. 全量 `npm run test` + `npx tsc --noEmit` + `npm run lint` + `git diff --check`；
4. **真人浏览器试玩**（`npm run dev`，代理只是「完美执行计划的真人下限」，验证不了手感）：
   - 战役一整局：390s 后有真实压力、终局不窗口性崩盘、通关可达；
   - 无尽打到 12 分钟以上：无堆屏悬崖、坡度是「温水上升」、击退不再是唯一生存轴。
5. **文档同步（容易漏）**：
   - `weapons-reference.html`「怪物血量成长表」：600s 后各行按新公式
     `基础 × (1 + 0.013 × t) × 1.45^k` 重算，注释改新语义（删除 ×2^k / 「每 40s 全怪
     血量 ×2 跳变」表述，改为 ×1.45 与密度说明）；**用脚本从 JSON 生成再粘贴**
     （该表当初即脚本生成逐行校验，HTML 模块内有公式说明与列结构）。
   - `HANDOFF.md` 追加里程碑（M23：战役收紧 + 无尽曲线重设计），记录新基线面板、
     校准项与测试数量变化。
   - `balance.test.ts` 文件头注释追加本轮校准记录与新基线面板（惯例）。

## 7. 断言校准指引（balance.test.ts，最小校准原则）

- 「前 210s 墙损 ≤55%」：现值 0，收紧后预计仍远低于限，不动。
- seed 2024 的 `biteLimit: null` 豁免（G3/G4 轮因零墙损而设）：若该种子重新出现真实
  墙损（预期会），恢复 0.95 阈值。
- 集体咬合 <90%：余量应拉开（86.3/84.7 → 更深咬合），阈值不动。
- 可赢锚点 ≥1 victory：**红线**。若全 defeat，先按第 3 节回退顺序处理，再谈校准。
- endless 断言集与语义全部保持不变。

## 8. 风险与不做清单

- 最大风险：战役过调（代理全败 / 真人 300s 前崩盘）。代理弱于真人前期，故第一轮目标
  定在 50~70% 而非更低；回退顺序见第 3 节。
- 无尽调参失准：两系数有独立决策表行，单变量调整互不牵连。
- **不做**：不削武器/卡牌（M18~M22 新体系是当前卖点）；不给怪物对墙伤害加时间膨胀；
  不放开 hardMax / maxProjectiles / maxEnemies（M17 性能护栏）；不动
  `ENDLESS_CAP_SEC = 1800`；不缩短循环段（体验单调）。

## 9. 验收清单

- [ ] 第一轮 4 处必改 JSON 落地，waves/bossRewards/gems 相关断言同步
- [ ] 第二轮 waveClock / waves 代码改动 + endlessLoop 新键 + 新增单测（缺省回退/逐轮/脏值/密度消费）
- [ ] balance 面板：campaign 通关种子最低墙血 50~70%、≥1 victory；endless 代理收敛 1250~1550s
- [ ] 全量测试全绿、tsc 零错误、lint 通过、git diff --check 通过
- [ ] weapons-reference.html 血量表 600s+ 行与注释按新公式同步（脚本生成）
- [ ] HANDOFF.md 里程碑（M23）+ balance.test.ts 校准注释追加
- [ ] 真人试玩两模式各一局，手感符合第 1 节目标
