# 项目交接文档 (HANDOFF.md)

## 1. 项目概况与运行环境

- **游戏类型与简介：** Phaser 3 竖屏自动战斗 survivor / 城墙防守游戏。角色固定在屏幕底部中央，怪物从上方下压并在城墙前攻击；武器自动瞄准开火，玩家通过中文三选一升级牌做构筑，不直接移动或瞄准。
- **引擎/框架与核心版本：** Phaser `3.90.0`、Vite `8.3.0`、TypeScript `5.9.3`、Vitest `5.0.0`。
- **开发语言与运行时环境：** TypeScript strict、Node.js `v24.16.0`、npm `11.17.0`。当前工作目录为 `F:\myzcode\survivor`。
- **关键第三方库/插件/依赖：** `phaser`；开发依赖为 `vite`、`vitest`、`eslint`、`typescript-eslint`、`@eslint/js`。无后端、无外部美术素材。
- **如何启动与调试：**
  - 安装依赖：`npm install`
  - 开发服务：`npm run dev`
  - 构建：`npm run build`
  - 测试：`npm run test`
  - lint：`npm run lint`
  - 入口：`index.html` -> `src/main.ts` -> `src/game/session.ts` + `src/phaser/index.ts`
  - 本地调试参数：`?speed=1..20` 控制模拟步进倍速；`?fx=0` 关闭 Phaser 霓虹泛光降级路径。
  - 开发服务默认地址：`http://localhost:5173/`。交接时没有保留运行中的 Node/Vite 进程。

## 2. 核心架构与目录导航

- **核心入口/管理器：**
  - `src/main.ts`：浏览器入口，创建会话、启动 Phaser、挂载 DOM UI、音效监听。
  - `src/game/session.ts`：`GameSession` 组装根；加载数据表、注册模拟 hooks、接线击杀掉落/Boss 奖励、管理 campaign/endless 模式和 restart。
  - `src/core/step.ts`：纯逻辑帧推进，dt 上限 50ms，`state.over` 后停摆。
  - `src/core/types.ts`：`SimState`、敌人、弹丸、武器状态和事件相关类型。
  - `src/core/upgrade.ts`：三选一牌池生成与应用。
  - `src/core/cards.ts`：通用牌/专属牌定义、牌上限、全武器满级解锁、stats 牌效果注入，以及连射待发波基础队列。
- **关键目录结构：**
  - `src/core/`：纯 TypeScript 模拟层，禁止 Phaser/DOM/BOM import；包含 RNG、dt、数学、对象池、空间网格、敌人、城墙、武器、弹丸、效果槽、区域、波次、胜利、Boss、目标预测、卡牌和测试。
  - `src/core/behaviors/`：8 把武器的行为分支和行为测试，行为通过注册表 + `import.meta.glob` 自动发现。
  - `src/data/`：JSON 数值表及加载器。包括 `config.json`、`enemies.json`、`waves.json`、`effects.json`、`cards.json`、`weapons/*.json`。
  - `src/game/`：合成层，会话和 localStorage 纪录。
  - `src/phaser/`：Phaser 场景、主循环和霓虹几何视觉；`fx.ts` 含发光/爆裂/冲击环/背景等视图特效。
  - `src/ui/`：DOM 覆盖层、三选一、模式选择、结算、纪录展示、音效开关和 CSS。
  - `src/audio/`：WebAudio 合成音效引擎。
  - `dist/`：构建产物，不应提交。
  - `node_modules/`：本地依赖，不应提交。

## 3. 当前开发进度

### [已完成]

- Vite + Phaser + TypeScript strict 工程骨架和 ESLint 分层约束。
- 确定性 mulberry32 RNG、dt 钳制、对象池、SpatialHash、SimState/事件队列。
- 敌人行军、墙前分离、墙战攻击、失败判定、经验宝石/修复包自动飞行、升级事件。
- 双模式：campaign 存活 600 秒胜利；endless 表尾循环与逐轮膨胀。
- Boss、Boss 击杀回血和额外升级事件。
- 效果槽：燃烧、毒、减速、冰、眩晕、标记、腐蚀、击退、黑洞、过热等。
- 8 把武器的基础行为、数据驱动加载和行为注册：轨道贯穿炮、扇面霰弹、追猎导弹、弹射棱镜、灼热光束、迫击榴弹、龙息锥、蓄能狙击。
- T5.2 目标选择修复：`src/core/targeting.ts` 提供移动预测和 `boss > attack > fast > nearest` 目标优先级；轨道炮已经改成 hitscan 射线。
- 牌池制基础：武器从 0 级起步，牌使武器等级增长；默认上限 10；通用牌和武器专属牌均来自 JSON；集齐 4 把且全部满级后解锁无限牌池；原 4 个被动系统已移除。
- 经验、波次和墙血的当前回归基线。
- WebAudio 合成音效、音效开关、localStorage 纪录、霓虹几何视觉、榴弹爆炸 VFX、轨道射线 VFX、龙息锥增强、触屏/窄屏/横屏样式。
- 当前全量 Vitest：**32 个测试文件、549 个测试全部通过**。

### [进行中/未调通]

- **T5.3b 弹道机制与专属牌接线处于半完成状态。** 最近一次子代理在实现后超时，但留下了大量已写入代码和测试。已完成/部分完成的内容包括：
  - 连射待发波基础队列：`scheduleBurstWaves` / `consumeDueBurstWaves` 位于 `src/core/cards.ts`。
  - 分裂目标选择 helper：`pickNearestDistinctEnemies` 位于 `src/core/projectiles.ts`。
  - 轨道炮三叉、折射、跳弹、蓄力增伤实现已写入 `behavior_piercingBolt.ts`，但需要接手 Agent 逐项审计实际牌数据、重复命中语义和视觉/平衡结果。
  - 狙击、导弹、迫击榴弹、光束、龙息等文件包含多射/连射/分裂/DoT 频率接线的部分实现；不能仅凭测试全绿判断所有组合都已完成，因为部分旧测试仍覆盖兼容路径，且最终实际牌组合未做完整 GUI 回归。
  - `cards.ts` 和 `projectiles.ts` 已写入 `TODO(handoff):`，明确说明机制接线和逐武器组合仍需核验。
- **平衡当前不代表最终目标。** `balance.test.ts` 本次全绿，但面板显示牌池制/怪物强度下的自动回归并不满足“通关模式三种子全部胜利”的旧目标：seed 7 victory，seed 42 defeat，seed 2024 defeat；endless seed 7 在约 617 秒 defeat。测试当前是牌池重构后的中间态标准，不应作为最终手感结论。
- 当前牌池升级数量还没有在“怪物数量至少提升一倍”的新难度目标下重新调平；`waves.json` 尚未完成该轮难度重做。

### [待开发/未开始]

- 完成 T5.3b 所有牌机制的逐武器接线和组合回归：多射×连射、分裂、轨道炮折射/跳弹/蓄力、多层折射、DoT 频率、龙息模式互斥等。
- 按用户“怪物数量至少提升 1 倍、合理策略险胜”要求重新调整波次/敌人 JSON，并恢复稳定的三种子 campaign 回归目标。
- UI 需要把新牌池的上限/前置/互斥/无限解锁状态表达清楚，并确认升级卡不再显示旧的“升级至 Lv.n”语义。
- T5.3b 完成后的完整 GUI 回归：牌池构筑、机制清屏瞬间、轨道射线、榴弹分裂爆炸、龙息模式、无尽循环。
- 后续只动数据表的 T5.2 调优轮：以用户试玩反馈校准难度与打击感。

## 4. 刚才的暂停点与文件改动清单

- **刚才正在处理的具体任务：** T5.3b：把 T5.3a 牌池定义真正接入 8 把武器的行为层，重点是多射、连射、分裂、DoT 频率，以及轨道炮专属牌。
- **最近修改/涉及的核心文件列表：**
  - `src/core/cards.ts`：牌参数注入、DoT 频率助手、连射队列。
  - `src/core/projectiles.ts`：分裂目标选择 helper。
  - `src/core/behaviors/behavior_piercingBolt.ts`：轨道炮三叉/折射/跳弹/蓄力增伤。
  - `src/core/behaviors/behavior_chargeSniper.ts`：多射、连射、分裂等部分接线。
  - `src/core/behaviors/behavior_homingMissile.ts`：多射、连射、燃烧云、分裂等部分接线。
  - `src/core/behaviors/behavior_mortar.ts`：多射、连射、分裂、DoT 频率和区域效果快照。
  - `src/core/behaviors/behavior_heatBeam.ts`、`behavior_dragonBreath.ts`、`behavior_scatterShot.ts`、`behavior_prismChain.ts`：牌驱动字段的部分消费和/或兼容逻辑。
  - 对应 `src/core/behaviors/*.test.ts` 与 `src/core/cards.test.ts`：已更新或新增测试。
- **逻辑暂停在哪个函数/类：** 暂停在 T5.3b 的跨武器机制闭环阶段，不是语法错误点。下一步应先审计 `src/core/cards.ts` 中 `scheduleBurstWaves/consumeDueBurstWaves` 的调用者，再逐把检查 `behavior_*.ts` 的 `projectileCount`、`burstWaves`、`splitReady`、`dotTickMult` 消费；随后跑真实牌组合的行为测试和 balance。
- 已在 `cards.ts` 与 `projectiles.ts` 添加 `TODO(handoff):` 注释，提示接手者继续完成上述逻辑。

## 5. 当前工程状态与已知问题 (Known Issues)

- **当前工程是否能直接运行/编译：** **是**。`npm run build` 通过；`npm run test` 通过；`npm run lint` 通过。开发服务当前未启动。
- **验证结果：**
  - `npm run test`：32 test files / 549 tests passed。
  - `npm run build`：通过；Vite 输出 Phaser bundle 大于 500 kB 的非阻断 warning（当前约 1.3 MB 未压缩构建 chunk）。
  - `npm run lint`：通过，无输出错误。
- **已知问题与注意事项：**
  1. T5.3b 仍是半完成的玩法接线；测试绿主要证明现有兼容路径，不能证明所有新牌组合都符合最终设计。
  2. `balance.test.ts` 的自动策略当前报告 seed 42/2024 在 campaign 失败，endless 在约 617 秒结束；这是调平问题，不是构建错误。
  3. 用户要求怪物数量至少翻倍尚未落实；不要把当前 `waves.json` 视为最终难度表。
  4. `src/core/types.ts` 和 `src/data/config.json` 当前 `wallMaxHp` 已被牌池中间态调整为 3200；这是补偿牌池早期输出的临时校准，后续应在怪物数量翻倍后重新评估，不要直接沿用为最终设计结论。
  5. `dist/` 和 `node_modules/` 属于生成/依赖目录，已在 `.gitignore` 中排除，不要提交。
  6. 两份根目录设计/任务文档 `survivor-design.md`、`survivor-tasks.md` 是只读来源，本次未改动；新的牌池方案来自指定旧会话日志，不应回写原 md，除非用户明确要求。
  7. 项目依赖 Phaser bundle 较大，属于现有构建警告，暂不影响开发。

## 6. 给接手 Agent 的下一步建议

1. 先运行 `npm run test && npm run build && npm run lint`，确认工作区基线。
2. 读取 `src/data/cards.json` 和全部 `src/data/weapons/*.json`，核对每张牌的 `params`、`requiresCard`、`once`、`maxCount`、`excludes` 与行为文件读取的 stats 键完全一致。
3. 逐把审计 `src/core/behaviors/`：先完成连射队列的所有调用方，再完成分裂的五种弹道语义，最后检查 DoT 频率是否覆盖效果实例和地面 zone。
4. 为每个机制组合补行为测试，尤其是“多射 × 连射”“分裂不再分裂且不吃多射/连射”“龙息模式互斥”“集齐 4 把且全 10 级后无限牌池”。
5. 执行 GUI 回归，确认升级面板显示新牌文案、武器从 0 级开始、每张牌使绑定武器 level+1、被动牌不再出现。
6. 在行为机制完全稳定后，把 `waves.json` 的刷怪量提高至少一倍，并重新校准到“合理策略险胜”；不要先通过放大 wallMaxHp 掩盖牌/机制未接线问题。
7. 最后跑完整 balance 回归和两模式试玩，再决定是否继续 T5.2 数据调优。

## 交接提交信息

- 交接前发现项目没有 `.git` 目录，因此本次交接会初始化 Git 仓库并创建首个 checkpoint commit。
- 提交内容包含当前源码、配置、设计/任务文档、`HANDOFF.md` 和 `.gitignore`；`node_modules/`、`dist/` 和临时日志不提交。
