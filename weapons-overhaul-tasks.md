# 武器系统改造 · 任务清单（调度与交接文档）

> 本文档由调度会话维护，记录 `weapons-overhaul-prompt.md` 的执行状态，供任务意外中断后继续或交接。
> 实施规范唯一来源：`weapons-overhaul-prompt.md`（本文件只做状态跟踪与派发要点，不复制规格全文）。
> 最后更新：2026-09-19

## 使用说明（接手必读）

- 调度会话只负责任务拆分、派发子代理、复跑验收、更新本文档；具体开发与测试由子代理执行。
- 任务按「实施顺序」**串行**执行：任务间共享 `cards.json` / `upgrade.ts` / behaviors 等文件，禁止并行派发。
- 每个任务完成后由调度会话复跑 `npm test` + `npx tsc --noEmit` 验收并更新本文档。
- 全程不做 git commit（用户未授权）；所有改动保留在工作区。
- **接手方式**：在「任务总表」找第一个非「已完成」的任务 → 阅读其「派发要点」→ 参照 `weapons-overhaul-prompt.md` 对应章节重新派发子代理 → 完成后按验收流程更新本文档。

## 基线快照（2026-09-19，改造开始前）

- 分支 `feature/dev-continue`（最后提交 df0df55，M17 文档）；工作区有大量未提交改动。
- 基线全绿：**34 文件 / 620 测试通过**、`tsc --noEmit` 零错误、`lint` 通过。
- **P0 前置已完成**（上个会话）：龙息武器 `dragon_breath` 整体移除——删除 `behavior_dragonBreath.ts` / `dragonBreath.test.ts` / `dragon_breath.json`，清理 cards/session/测试/注释/VFX 分支引用；`EXCLUDED_INITIAL_WEAPONS` 现为 **2 项**（scatter / heat_beam）。
- 当前武器 7 把：`charge_sniper` / `scatter` / `homing_missile` / `mortar` / `prism` / `rail_piercer` / `heat_beam`。
- 8 把武器的达成路径：删龙息（已完成）+ 新增震波壁垒（任务二）；收尾时 `weapons-reference.html` 按 8 把全量更新。

## 全局约定（每个子代理的硬性约束，摘自规范原文）

1. core 层纯 TypeScript，禁止 import phaser 与任何 DOM/BOM。
2. 数值全部来自武器 JSON 数据表；几何量（弹丸半径等）可硬编码并注释。
3. 行为零随机是默认契约；唯一战斗期随机是任务三的「爆头」，必须走独立随机流（种子 = 会话种子 XOR 0x9E3779B9），绝不消费 state.rng 主随机流。
4. 所有武器遵守「无目标不开火且 cooldownMs 归 0（重试标记）」约定。
5. 武器 stats 缓存契约：返回对象只读，禁止改写。
6. 每完成一个任务跑 `npm test` 与 `npx tsc --noEmit`，保持全绿再进入下一任务。

## 任务总表

| # | 任务 | 状态 | 验收结果 |
|---|------|------|----------|
| P0 | 前置：移除龙息武器 | ✅ 已完成（上个会话，未提交） | 620/620 全绿 |
| T4 | 任务四：全卡牌文本优化（文本基建先行） | ✅ 已完成 | 34 文件 / 631 测试全绿，tsc 零错误，lint 通过 |
| T2 | 任务二：新增震波壁垒 seismic_wall | ✅ 已完成 | 35 文件 / 655 测试全绿，tsc 零错误，lint 通过 |
| T1 | 任务一：重做灼热光束 heat_beam | ✅ 已完成 | 35 文件 / 653 测试全绿，tsc 零错误，lint 通过；子代理审计无缺口 |
| T3 | 任务三：蓄能狙击牌池重构 | ✅ 已完成 | 35 文件 / 657 测试全绿，tsc 零错误，lint 通过 |
| W1 | 收尾：balance 面板重校 + weapons-reference.html 更新 + 最终验收 | ✅ 已完成 | 35 文件 / 657 测试全绿，tsc 零错误，lint 通过；参考文档 8 把武器全覆盖 |
| W2 | 收尾：HANDOFF.md 追加 M18 里程碑记录 | ✅ 已完成 | M18 已更新为最终完成状态 |

## 跨任务衔接注意（派发时传达给对应子代理）

- **T4 先行**：只处理当前存在的牌（7 把武器的现有专属牌 + 通用牌生成器）。不要为后续任务才新增的牌（load_up / coordinated_fire / second_flash / crit_shot / execution_order / border_ricochet / 震波壁垒五张）写文案；也不要提前删除任务一才会删的 heat_beam 牌（dual_beam / refract_up / cooling_up）——当前存在就按新标准重写，任务一会删。
- **T2**：EXCLUDED_INITIAL_WEAPONS 由当前 2 项改为 3 项（scatter / heat_beam / seismic_wall），session.test.ts 断言同步；新增的 5 张专属牌文案直接按 T4 建立的新标准写；效果系统需支持 `data.durationMs` 逐实例覆盖（先例：tickMs 逐实例覆盖），Boss 眩晕减半在覆盖后的时长上照常生效。
- **T1**：协同开火语义引用 seismic_wall（T2 已完成，直接使用）；霰弹门槛 effRange、震波壁垒门槛「目标在当前冲击带内」；给五把武器行为 fireVolley 增加可选「指定目标」参数；heat_beam 的 scorch 文案已在 T4 重写，保持一致。
- **T3**：新增 border_ricochet 后需回补 pierce_shot（贯穿弹）文案中的联动说明（T4 时该牌尚不存在）。

---

## T4 任务四：全卡牌文本优化

- **状态**：✅ 已完成（2026-09-19，子代理实施，调度复跑验收通过）
- **规范出处**：weapons-overhaul-prompt.md「任务四」
- **关键文件**：`src/core/upgrade.ts`（候选构建）、`src/data/cards.json`、`src/data/weapons/*.json`（7 把）、`src/ui/overlay.ts`（消费方）、断言文案的测试
- **派发要点**：
  - 通用牌文案按武器动态生成，生成器数据驱动（映射表），不为单把武器写特判分支；
  - 作用键中文映射：lockRange→索敌半径、bandDepth→冲击带深度、chainRange→弹跳范围、aoeRadius→爆炸半径、fanAngleDeg→扇角（范围强化牌逐键列出该武器会被强化的范围名）；
  - 通用牌逐武器实体名词（多射对霰弹「弹丸」、榴弹「榴弹壳体」、棱镜「链弹」等），逐一核对行为层语义后填表；
  - 现有 7 把武器全部专属牌文案手工重写，标准：触发条件、精确数值、叠层上限、突破规则（hardMax 两段式）、与其他牌联动（如 dot_freq 的 requiresCard 前置）；
  - `sanitizeUnlimitedCardDescription` 清洗逻辑保持兼容（保留可清洗格式或同步调整规则），M17 两段式「（可叠 n 次，突破后上限 m 次）」契约保留；
  - 文案断言测试同步修正；为生成器补专项测试。
- **验收**：tsc 零错误、npm test 全绿、lint 通过。

## T2 任务二：新增震波壁垒（seismic_wall / behavior_seismicPulse.ts）

- **状态**：✅ 已完成（2026-09-19，子代理实施，调度复跑验收通过）
- **规范出处**：weapons-overhaul-prompt.md「任务二」
- **关键文件**：新建 `src/data/weapons/seismic_wall.json`、`src/core/behaviors/behavior_seismicPulse.ts`（自动发现）、`src/core/effects.ts`（durationMs 覆盖）、`src/game/session.ts` + `session.test.ts`、`src/data/cards.json`、`src/phaser/fx.ts` + `mainScene.ts`、新建 `seismicPulse.test.ts`
- **派发要点**：
  - 数据表：damage 22 / intervalMs 3600 / bandDepth 40 / knockbackForce 90，rangeKeys: ["bandDepth"]，maxLevel 10；
  - 行为：线性扫描全宽度冲击带（|y − wallLineY| ≤ bandDepth），伤害→击退（强制竖直向上，maxHp 抗性既有规则）→眩晕（800ms/Boss 400ms 既有规则）；带内无存活敌人不开火、冷却归 0；零随机；
  - 5 张专属牌：余震×3（400ms 后 30% 伤害无 CC）、震荡加深×2（durationMs +150ms/层，逐实例覆盖）、地裂×2（bandDepth +20/层）、过载共振 once（眩晕目标伤害×2）、城垣共鸣×2（单次命中 ≥8 敌回墙 4×层数 hp，clamp maxHp）；
  - 接线：EXCLUDED_INITIAL_WEAPONS → 3 项；cards.json 的 range_up applyTo += seismic_wall；VFX 共享单键 meta { bandDepth, untilMs } + 轻微震屏（复用 wallDamaged 基建）；fx.ts 前缀导出、mainScene 绘制分支；
  - 测试：带判定边界（恰在 bandDepth 上算在内）、全宽度无上限、击退/眩晕附着、无目标冷却归 0、余震延时与 30% 无 CC、震荡加深覆盖（含 Boss 减半叠加语义）、过载共振×2、城垣共鸣回复与 clamp。
- **验收**：tsc 零错误、npm test 全绿、lint 通过。

## T1 任务一：重做灼热光束（heat_beam / behavior_heatBeam.ts）

- **状态**：✅ 已完成（2026-09-19，实施子代理完成；本次审计子代理复核通过，未产生新增代码改动）
- **规范出处**：weapons-overhaul-prompt.md「任务一」（含「关键决策记录」）
- **关键文件**：`src/data/weapons/heat_beam.json`、`src/core/behaviors/behavior_heatBeam.ts`、五把武器行为 fireVolley（指定目标参数）、`src/phaser/mainScene.ts`（drawHeatBeam）、`heatBeam.test.ts` 重写
- **派发要点**：
  - 单体锁定持续光束：base { damage 5, intervalMs 200, lockRange 365, fastSpeedThreshold 80, projectileSpeed 0, pierce 0, ttlMs 0 }，rangeKeys: ["lockRange"]；删除 beamWidth/beamRange/heatPerShot/coolPerSec/overheatThreshold 与过热槽整套；
  - 牌池：删 dual_beam / refract_up / cooling_up；保留 scorch（once，burn damagePerTick 2）；新增 load_up（每跳 +3% 基础伤害、换目标清零、不封顶）/ coordinated_fire / second_flash（次级束 25% 伤害、同频、享受加载与协同）；
  - 四级优先级锁定（preferBoss + preferFast）；纯单体结算；范围内无目标不开火、冷却归 0；
  - 计数模型：加载每束独立（同目标也各自计算、换目标只清自己）+ 协同按目标 id 共用（同目标共同推进、任一目标达 30 即以它触发齐射后归零、换走清零作废、主束转锁次级目标合流）；
  - 协同齐射：遍历其他已拥有武器；霰弹（effRange 门槛）与震波壁垒（带内门槛）不锁定组按各自 fireVolley；其余五把强制锁定光束目标走真实 fire；不影响被触发武器冷却（快照/空转判定恢复）；齐射用真实 stats、连射跟发波照常入队；只迭代 fire 开始时的 weaponStates 键快照；
  - 清理：过热槽 meta（heat_beam_heat:*）、update 散热逻辑、overheat applyEffect；weapons.ts 的 overheatFactor 消费保持不动；
  - VFX：meta 键 `heat_beam_vfx:<weaponId>` 保留（segments + untilMs，段序 [主束, 次级束?]，次级束区分色），beamWidth 改固定视觉宽度常量；
  - 测试覆盖清单见规范原文。
- **验收**：tsc 零错误、npm test 全绿、lint 通过。

## T3 任务三：蓄能狙击牌池重构（charge_sniper）

- **状态**：✅ 已完成（2026-09-19，子代理实施，调度复跑验收通过）
- **规范出处**：weapons-overhaul-prompt.md「任务三」（含「关键决策记录」）
- **关键文件**：`src/data/cards.json`、`src/core/behaviors/behavior_chargeSniper.ts`、`src/core/simState.ts`（独立随机流）、`chargeSniper.test.ts`
- **派发要点**：
  - cards.json：multi_shot / burst_shot / split_shot 的 applyTo 移除 "charge_sniper"；
  - 清理死代码：多射扇形展开、连射调度、分裂（splitOnHit / onProjectileHit）、命中减速（slowHit / SLOW_TEMPLATE）；保留四级 pickTarget、leadAim、mark 模板、斩首、处决强化、贯穿弹；
  - 新增 crit_shot（once）：15% 概率 550% 伤害；独立 LCG 随机流（种子 = 会话种子 XOR 0x9E3779B9，绝不消费 state.rng）；每弹每敌独立掷点；与斩首叠乘；
  - 新增 execution_order（once）：本武器伤害结算后目标存活且 hp < 20% maxHp（Boss 7%）→ 立即击杀，该次击杀经验 ×1.25（只放大这一次）；生效范围含边境折返多次命中与协同齐射强制触发的狙击；
  - 新增 border_ricochet（once）：命中计数 = 1 + 2×贯穿弹张数（发射时快照入弹 data），归零即销毁；撞地图边缘必反弹不消耗计数（上 y≤0、左 x≤0、右 x≥width、下 = 墙线 wallLineY；位置钳回+翻转分量；注意先核对 step.ts 钩子与弹丸位移执行顺序，反射在行为 update 钩子做）；ttl 1200ms 仍封顶；
  - 回补 pierce_shot 文案联动（border_ricochet 计数）；
  - 测试：牌池断言、爆头概率与独立随机流（主随机流序列不受影响）、死刑宣告阈值与经验×1.25、边境折返（基础计数脱靶反弹、贯穿弹计数、镜面反射方向、墙线下边缘、ttl 封顶）、清理后无残留。
- **验收**：tsc 零错误、npm test 全绿、lint 通过。

## W1 收尾：balance 面板重校 + weapons-reference.html + 最终验收

- **状态**：✅ 已完成（2026-09-19，子代理实施，调度复跑验收通过）
- **交付摘要**：
  - balance 面板最终重校：校准 4 条恒真/语义脱节断言（seed 42 前 210s 零墙损恢复原语义；压力存在改为「至少被啃 5% 墙血」；终局护栏限定 victory 种子 <55% 起始墙血；集体咬合锚改为「至少一个通关种子最低墙血 <85% + ≥1 victory 且 ≥1 defeat」）。最终面板：campaign seed 7 victory @600s（墙血 77.8%，击杀 1571）/ seed 42 defeat @445.6s（击杀 837）/ seed 2024 victory @600s（墙血 86.3%，击杀 1497）；endless defeat @665.7s（击杀 1949，loop=2）。
  - `weapons-reference.html` 全量重写：8 把武器（含震波壁垒）、全局机制（四级优先级/协同开火/独立战斗随机流/无目标冷却归 0）、33 条专属牌描述脚本逐字比对与 JSON 一致、40 个牌名双向全覆盖。
  - 旧体系残留自检：beamRange/beamWidth/过热/龙息/dual_beam/cooling_up/slow_hit 等在 HTML 中命中数全部为 0。
  - **情报性发现（未改数值）**：两通关种子最后 120s 墙损为 0（尾段约 390s 后防线零压力），seed 2024 最低墙血 86.3% 偏松——武器增强后 campaign 后段曲线偏软，若需收紧建议后续在 `waves.json` 末段波次单独立项。
- **规范出处**：weapons-overhaul-prompt.md「收尾与验收」
- **派发要点**：
  - `npx tsc --noEmit` 零错误、`npm test` 全绿、`npm run lint` 通过；
  - `balance.test.ts` 全自动对局面板重跑：灼热光束重做、蓄能狙击失去三张通用牌、新增强力 CC 武器都会移动基线——按面板重校断言阈值，汇报列出改动前后关键数字（通关时间、墙损、击杀）；
  - `weapons-reference.html` 全量更新：8 把武器（含震波壁垒）、新索敌逻辑、新牌池与新文案、总览表。
- **验收**：四项全绿 + 参考文档覆盖 8 把武器。

## W2 收尾：HANDOFF.md 追加 M18 里程碑记录

- **状态**：✅ 已完成（2026-09-19，最终状态更新：M18 覆盖四任务 + W1 收尾全貌）
- **说明**：调度会话按仓库交接惯例追加（规范原文未要求，属补充项），汇总四任务改动、验收指标与后续建议。

---

## 修复轮（2026-09-20，浏览器实玩反馈，F1~F3）

- **背景**：内置浏览器实玩两局战役（一败一胜）后用户反馈三个问题；dev server 已停。
- **F1 边境折返弹「计数未耗尽就消失」**：待定位。嫌疑：① ttl 1200ms 到期销毁（规范「关键决策记录」明示 ttl 封顶，属设计行为——若仅此原因则不改，报告后由用户决定是否延长）；② maxProjectiles=600 帧首回收在高密度局误杀；③ 行为 update 反射钩子的时序/边界特例。子代理先定位再修，禁止静默改 ttl 设计值。
- **F2 狙击弹穿过主目标不掉血**：主嫌疑=离散点碰撞隧穿（弹速 1600px/s，帧 dt 上限 50ms → 单步位移可达 80px，远超命中阈值 弹6+敌半径~12≈18px）。修复方向：updateProjectiles 改扫掠段-圆碰撞（上一位置→新位置的线段对敌圆判交，按段上先后次序结算，尊重 pierceLeft/hitIds 去重/onProjectileHit 钩子），全武器回归。
- **F3 震波壁垒范围强化改「行进距离」**：用户原话基于一个误解——bandDepth 不是屏幕宽度（x 向恒全宽），它本来就是「离墙 reach」；按用户意图仍改为真·行进波：脉冲波前从墙线向上推进，行进距离 = 新 base 键（初值 160）× range_up；bandDepth 保留为波前厚度（地裂 +20/层 变为加厚）；rangeKeys → ["waveDistance"]；余震对扫过全程带追结算；门槛按可达范围判定；VFX 改移动波前；seismicPulse.test.ts 重写；balance 面板重校（reach 40→160 属增强）。

| # | 修复项 | 状态 | 验收 |
|---|--------|------|------|
| F1 | 边境折返弹提前消失定位（+如属真 bug 则修） | ✅ 已完成（无真 bug：ttl 1200ms 封顶的几何必然，规范明示设计行为，未改数值，待用户决策是否延长） | 35 文件 / 671 测试全绿，tsc 零错误，lint 通过 |
| F2 | 弹丸扫掠碰撞修复隧穿（全武器） | ✅ 已完成（离散点查询 → 段-圆扫掠碰撞，零漏判 queryRect，命中按段序结算，契约保持） | 同上，+14 用例（隧穿红→绿证据），balance 校准 1 条（seed 42 转胜 46.7% 咬合） |
| F3 | 震波壁垒改行进波 + 范围强化作用于行进距离 | ✅ 已完成 | 35 文件 / 683 测试全绿，tsc 零错误，lint 通过；balance 校准 1 条（seed 2024 咬合 97.4%） |
| G2a | 黑洞拉拽治理（免疫 2s + 限距 120px 位移） | ✅ 已完成 | 35 文件 / 693 测试全绿，tsc 零错误，lint 通过 |
| G2b | 灼热光束粘性锁定（不死不换，出程也打） | ✅ 已完成 | 同上 |
| G3 | 灼热光束增伤（damage 9 / load 5%） | ✅ 已完成 | 同上 |
| G4 | 震波壁垒增强（2.4s / 35 伤 / 距离 220 / 击退 110） | ✅ 已完成 | 同上；balance：seed 2024 零墙损、endless 收敛 982.5s（loop=10），3 处最小校准 |
| G1 | 武器 HUD 胶囊芯片重做 | ✅ 已完成 | 35 文件 / 702 测试全绿；浏览器实玩截图验证：4 枚芯片竖排无截断、满级金描边 MAX |
| G5 | 爆头/死刑宣告特效与音效（无震屏） | ✅ 已完成 | 同上；meta 写入/有界化 9 用例锁定；实玩局未持狙击未采到画面（见日志） |

- 执行顺序：F1+F2 同一子代理（同在 projectiles/chargeSniper 域）→ F3 第二个子代理 → 文档收口。

## 优化轮（2026-09-20，第二轮实玩反馈，G1~G5）——**已批准（含 2 处用户修改），执行中**

- **用户修改记录**：① G2b 粘性锁定加强为「目标不死就一直锁定，即使被击退等移出攻击范围也继续打击，仅死亡才重选」；② G5 死刑宣告**不做震屏**，其余保留。

- **G1 武器 HUD 重做**：现状 = mainScene 单行 `hudText` 拼「A Lv.x、B Lv.y…」，超 720px 截断，第 4 把起不可见。方案 = 每武器一枚独立胶囊芯片（名称+Lv），竖排锚定 HUD 下方；Lv.10 金描边 MAX；按 weaponStates diff 才重绘（池化惯例）；不动 DOM 升级面板。
- **G2a 黑洞拉拽治理**：根因 = 每颗榴弹爆炸都 applyInstant「拉至爆心」，多射/分裂下高频瞬移扰乱全队。方案 = per-enemy 拉拽免疫 2s（meta 时间戳，确定性）+「拉至爆心」改「向爆心位移至多 120px」。
- **G2b 灼热光束粘性锁定**：根因 = 每次 fire 重新 findTarget，场面一变就换目标 → 加载清零。方案 = 目标存活且在 lockRange 内则保持，仅死亡/出程重选；四级优先级只在重选时生效；T1 锁定类测试语义同步改写。
- **G3 灼热光束增伤（纯数据）**：damage 5→9；load_up 3%→5%/跳；intervalMs/second_flash/协同阈值不动。
- **G4 震波壁垒增强（纯数据）**：intervalMs 3600→2400；damage 22→35；waveDistance 160→220；knockbackForce 90→110；其余不动。
- **G5 爆头/死刑宣告反馈特效**：爆头 = 金色星芒环（glow 层新 meta VFX 键，PRISM_ZAP 模式）+ 专属脆响 sfx；死刑宣告 = 暗红竖贯斩线 + 死亡爆散染红 + 低沉斩落 sfx + 轻震屏（wallDamaged 基建 1/3 幅度）；模拟层只推 meta/事件（零随机不变），视图消费。
- 执行顺序：G2 → G3+G4（面板重校）→ G1+G5 → 全量验收 + 内置浏览器实玩验证。待审批后派发。

## 补充轮（2026-09-20，H1~H2，蓄能狙击二改）——执行中

- **H1 边境折返取消 ttl 封顶（用户决策落地，替代原「ttl 延长」待决项）**：持边境折返后，该武器弹丸不再受 ttl 1200ms 上限——命中计数不耗尽就不消失（反弹至计数耗尽为止）；未持边境折返的弹 ttl 1200ms 不变。注意：计数 1 的弹仍首个命中即毁；空场极端下未命中弹会累积，由 maxProjectiles=600 护栏兜底（报告中说明）。F1 的 ttl 不变式测试按新语义重写。
- **H2 死刑宣告经验增幅扩展到直接击杀**：持死刑宣告后，蓄能狙击伤害**直接击杀**目标（含爆头击杀、边境折返多次命中击杀）同样获得该次击杀经验 ×1.25；处决阈值击杀的既有 ×1.25 不变；非本武器击杀不受影响；两路径不得双重放大。文案按 T4 标准同步，reference 文档同步。

| # | 修复项 | 状态 | 验收 |
|---|--------|------|------|
| H1 | 边境折返取消 ttl 封顶 | ✅ 已完成 | 35 文件 / 707 测试全绿，tsc 零错误，lint 通过 |
| H2 | 死刑宣告经验增幅覆盖直接击杀 | ✅ 已完成 | 同上；balance 仅墙钟护栏 40s→55s（环境度量），游戏语义断言零校准 |
| G6 | 协同开火触发特效与音效 | ✅ 已完成 | 35 文件 / 712 测试全绿，tsc 零错误，lint 通过；balance 面板与 M21 基线逐字一致（零数值漂移） |

## 进度日志（倒序追加）

- **2026-09-20 G6 完成并验收**：协同开火触发反馈三层落地——模拟层触发瞬间写共享单键 `coordinated_fire_vfx`（{x,y,untilMs}，留存 350ms 导出常量）+ 推一次性 `coordinated` sfx；视图在触发目标处画金/青双色扩散双环 + 8 芒 + 玩家处小型响应环（配色取 HUD 芯片既有项目色，与爆头金以色相+形态双重区分）；音频合成 D 大调「蓄势-齐发」双音。5 个新用例（707→712），balance 面板与 M21 基线逐字一致。调度复跑验收通过。5173 残留 vite 进程（PID 13068）已确认身份并清除，端口释放。

- **2026-09-20 H1+H2 完成并验收**：H1——持边境折返的弹 ttlMs 置 Infinity（框架 ttl 路径全核查：到期判定/护栏/池清洗/视图均兼容），计数未耗尽不消失，未持牌弹 ttl 1200 不变；F1 的 ttl 不变式用例按新语义重写（跨 1200ms 存活、反弹可达性、未持牌对照）。H2——死刑宣告经验 ×1.25 扩展到直接击杀/爆头击杀/边境多次命中击杀，按死亡时机三路径实现（基础命中=钩子入口补差额、爆头/处决=泛化临时 killHook），一次死亡只放大一次，他武器击杀不受影响；两牌文案与 reference 文档同步。702→707 用例，balance 面板仅墙钟护栏 40s→55s 校准（环境性能度量），游戏语义断言零校准（含狙击 build 种子 85.4%→84.7%、Lv36→37 的自然移动）。调度复跑验收通过。原「ttl 延长」待决项由此关闭。

- **2026-09-20 G 轮完成并浏览器实玩验收**：G2a（黑洞 per-enemy 免疫 2s + 限距 120px 位移，Enemy 字段 blackholePulledUntilMs 随死亡回收）/ G2b（热束极强粘性锁定：绑定目标存活即持续锁定打击、出程照打，仅死亡重选；「无目标归 0」只在死亡重选无候选路径触发）/ G3（热束 9 伤、加载 5%/跳）/ G4（震波 2400ms/35 伤/距离 220/击退 110）——693 用例全绿，balance：seed 2024 零墙损、seed 42 咬合 85.4%、endless 收敛推迟至 982.5s loop=10，3 处最小校准（性能护栏 30s→40s）。G1（HUD 四行 + 武器芯片竖排，Lv.0 灰/Lv1-9 白/Lv10 金 MAX，逐帧 diff 零稳态写入）/ G5（爆头金星芒环 + crit 脆响、死刑暗红竖贯斩线 + 红色迸散 + execute 斩落音效、无震屏；meta 有界 16 滚动清理）——702 用例全绿。**浏览器实玩验证**：热束构筑局 10:00 通关（Lv.35 / 1470 击杀 / 墙血 1600 满），截图确认 G1 四芯片含第 4 把扇面霰弹 Lv.6 完整可见；G2b 粘性锁定经单元用例锁定 + 补采样局复核（本局未持狙击，G5 画面级验证缺，meta 写入有 9 用例覆盖）；IAB RAF 节流致模拟停摆问题用 M17 调试句柄 loop.step 泵帧解决。

- **2026-09-20 F3 完成并最终验收**：震波壁垒改为真·行进波——sweep 状态存共享单键 meta（视图+结算字段一体），波前从墙线上移、扫掠时长固定 400ms 几何常量、走廊结算（上帧带∪本帧带）+ hitIds 去重防击退重入双结算；base 新增 waveDistance 160、bandDepth 语义改波前厚度、rangeKeys → ["waveDistance"]；城垣共鸣按整波 hitIds.size 在 sweep 结束结算；余震 400ms ≈ 波扫完时点、对几何行进带追结算；heatBeam 协同门槛同步为可达范围（waveDistance+bandDepth=200）；5 张牌文案改行进波语义、reference 文档同步、VFX 改移动波前；seismicPulse.test.ts 24→36 用例，总量 671→683。balance：含震波种子咬合 83.1%→97.4%（增强实证），endless 679.5s 收敛；1 条断言按种子分层最小校准。调度复跑验收通过。修复轮 F1~F3 全部完成。
- **2026-09-20 F1+F2 完成并验收**：F1 定位结论——无真 bug，唯一常态根因是 ttl 1200ms 封顶（几何必然：弹速 1600×ttl 1200ms=航程 1920px < 上缘往返 2380px，打高处目标脱靶反弹后计数满额到期消失），600 护栏/反射时序/计数扣减/销毁顺序四条嫌疑全部排除，零代码改动，ttl 是否延长留用户决策；F2 修复——updateProjectiles 改扫掠段-圆碰撞（spatialHash 新增 queryRect 零漏判粗查询、命中按沿段 t 序结算、穿透/去重/钩子契约逐字保持、dt=0 自然退化点查询），隧穿复现 7 用例修复前全红、修复后全绿；新增 14 用例（657→671），balance 因全武器有效 DPS 上涨移动基线（seed 42 defeat→victory 46.7% 濒死咬合，endless 推迟至 704.1s loop=3），1 条断言最小校准。调度复跑验收通过。F1 结论已同步进 F3 前基线。

- **2026-09-19 W1 完成并最终验收**：子代理交付——balance 面板最终重校（4 条恒真/语义脱节断言校准，其余语义成立不动；新基线 campaign 7 victory / 42 defeat @445.6s / 2024 victory，endless defeat @665.7s）；`weapons-reference.html` 全量重写为 8 把武器新体系（33 条专属牌描述逐字比对 JSON 一致，旧体系残留 grep 清零）；最终验收 35 文件 / 657 用例全绿、tsc 零错误、lint 通过。调度复跑验收通过。** weapons-overhaul-prompt.md 全部任务（P0 + T4/T2/T1/T3 + W1/W2）完成**。情报性发现：campaign 尾段（约 390s 后）防线零压力、seed 2024 墙血 86.3% 偏松，后续可在 waves.json 末段单独立项收紧。
- **2026-09-19 T3 完成并验收**：子代理交付——cards.json 三张通用牌 applyTo 移除 charge_sniper；behavior_chargeSniper 整体重写（删除多射展开/连射调度/分裂/命中减速四段死代码，grep 证实零残留）；simState.ts 建立独立战斗随机流 `getBattleRng`（meta 单键 `battle_rng`，种子 = seed XOR 0x9E3779B9，固定 LCG 不经 rngFactory，主流零消费有测试锁定）；新增 crit_shot（追加伤害按受伤乘区折算，首跳总伤精确 550%、斩首叠乘 495）/ execution_order（20%/Boss 7% 严格小于阈值，临时 killHook 追加 0.25 倍经验只放大单次击杀，forcedTarget 协同路径生效）/ border_ricochet（计数 = 1+stats.pierce 等价 1+2×贯穿弹张数，update 钩子镜面反射带速度朝向守卫防出生误反弹）；pierce_shot 文案回补联动；chargeSniper.test.ts 37→51 用例，总数 653→657。balance 仅 1 处最小校准（seed 42 因选牌序列变化 defeat @445.6s，改断言为「全程存在真实墙损」）。调度复跑验收通过。四任务本体全部完成，进入 W1 收尾。

- **2026-09-19 T1 完成并审计验收**：子代理完成 T1 后，本次专门审计其交付，确认无缺口且未修改代码。`heat_beam.json` 已切换为单体持续光束（5 伤 / 200ms / lockRange 365 / fastSpeedThreshold 80，五键占位），删除热束旧过热/双束/折射/散热牌；`behavior_heatBeam.ts` 已实现四级锁定、无目标 cooldown=0、主/次束独立加载、按目标共享协同计数、second_flash 25%、scorch、协同齐射门槛与强制目标/冷却恢复/连射队列/防递归；五把强制锁定行为支持 forcedTarget；VFX 使用 `heat_beam_vfx:<weaponId>`。审计分类确认 `upgrade.ts` 的 beamWidth/beamRange 仅是兼容映射，通用 overheat/overheatFactor 保留符合规范，rail_piercer 的 refract_up 非热束；仅 `weapons-reference.html` 尚有旧热束文案，留给 W1，未在本次处理。验收：35 文件 / 653 用例全绿，heatBeam 28/28，balance 22/22，tsc/lint/git diff --check 全通过。balance 面板：campaign seed 7/42/2024 均 600s victory（seed 7 最低墙血 1244.5/1600=77.8%，击杀 1571；seed 42 击杀 1582；seed 2024 击杀 1519）；endless seed 2024 于 686.8s defeat，击杀 2044，loop=3（本次为审计，未产生前后差异）。T3/W1 未启动；按用户要求当前暂停。 
- **2026-09-19 T2 完成并验收**：子代理交付——新建 `seismic_wall.json` / `behavior_seismicPulse.ts`（自动发现注册）/ `seismicPulse.test.ts`（24 用例）；effects.ts 新增 durationMs 逐实例覆盖（Boss 减半作用于覆盖后时长）；EXCLUDED_INITIAL_WEAPONS → 3 项；range_up applyTo + seismic_wall（T4 生成器零改动即生效）；VFX 共享单键 + 轻微震屏（水位线防重复触发）。裁量记录：余震为 30%×层数单次结算且享受过载共振；余震延时 400ms 与共鸣阈值 8 进 JSON（`base.aftershockDelayMs` / `wallResonanceHits`）；四张可叠牌 hardMax=maxCount 防失控。测试 631→655（35 文件），balance 面板未移出断言区间（campaign 三种子 victory，endless 686.8s defeat）。调度复跑验收通过。当前 8 把武器。
- **2026-09-19 T4 完成并验收**：子代理交付——通用牌逐武器文案生成器落地 `src/core/upgrade.ts`（导出纯函数 `buildCardDescription`；三张映射表 RANGE_KEY_ZH / VOLLEY_NOUNS / DOT_NAMES，含 beamWidth/beamRange 补映射）；7 把武器专属牌文案全部按新标准重写（纠正霰弹击退方向、棱镜三叉「威胁最高→最近」等过时描述）；`sanitizeUnlimitedCardDescription` 未改、兼容双路径有测试锁定；`upgrade.test.ts` 修正 2 处旧断言 + 新增 11 个生成器用例；测试 620→631，tsc/lint 全绿。调度复跑验收通过。
- **2026-09-19 HANDOFF / 任务清单同步并暂停**：按用户要求暂停推进；T1 已审计完成，T3 与 W1 均未启动。当前下一个可执行任务为 T3；W1 仍需在全部任务完成后更新 `weapons-reference.html`、重校 balance 面板并做最终验收。
