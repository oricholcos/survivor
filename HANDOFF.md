# 项目交接文档 (HANDOFF.md)

## 1. 项目概况与运行环境

- **游戏类型与简介：** Phaser 3 竖屏自动战斗 survivor / 城墙防守游戏。角色固定在屏幕底部中央，怪物从上方下压并在城墙前攻击；武器自动瞄准开火，玩家通过中文三选一升级牌做构筑，不直接移动或瞄准。
- **引擎/框架与核心版本：** Phaser `3.90.0`、Vite `8.3.0`、TypeScript `5.9.3`、Vitest `5.0.0`。
- **开发语言与运行时环境：** TypeScript strict、Node.js `v24.16.0`、npm `11.17.0`。当前工作目录为 `F:\myzcode\survivor`。
- **当前开发分支：** `feature/dev-continue`（基于 `main` 分支建立的安全迭代分支）。
- **关键第三方库/插件/依赖：** `phaser`；开发依赖为 `vite`、`vitest`、`eslint`、`typescript-eslint`、`@eslint/js`。无后端、无外部美术素材。
- **如何启动与调试：**
  - 安装依赖：`npm install`
  - 开发服务：`npm run dev`
  - 生产构建：`npm run build`
  - 运行单测：`npm run test`
  - 静态检查：`npm run lint`
  - 入口：`index.html` -> `src/main.ts` -> `src/game/session.ts` + `src/phaser/index.ts`
  - 本地调试参数：`?speed=1..20` 控制模拟步进倍速；`?fx=0` 关闭 Phaser 霓虹泛光降级路径。
  - 开发服务默认地址：`http://localhost:5173/`。

---

## 2. 核心架构与目录导航

- **核心入口/管理器：**
  - `src/main.ts`：浏览器入口，创建会话、启动 Phaser、挂载 DOM UI、音效监听。
  - `src/game/session.ts`：`GameSession` 组装根；加载数据表、注册模拟 hooks、接线击杀掉落/Boss 奖励、管理 campaign/endless 模式和 restart。
  - `src/core/step.ts`：纯逻辑帧推进，dt 上限 50ms，`state.over` 后停摆。
  - `src/core/types.ts`：`SimState`、敌人、弹丸、武器状态、`SimConfig` 和事件相关类型契约。
  - `src/core/targeting.ts`：移动预测（`leadAim`、`interceptPoint`）与统一目标选择（`findTarget` 支持四级优先级及 `maxRange` 射程过滤，杜绝远距离空放）。
  - `src/core/upgrade.ts`：三选一牌池生成与应用（0 级起步、每牌 level+1、前置依赖/互斥约束、4 把满级解锁无限牌池）。
  - `src/core/cards.ts`：通用牌/专属牌定义、牌上限、全武器满级解锁、stats 牌效果注入，以及连射待发波队列（`scheduleBurstWaves` / `consumeDueBurstWaves`）。
  - `src/core/projectiles.ts`：弹丸推进、生命周期与次级分裂目标选取 helper（`pickNearestDistinctEnemies`）。
  - `src/core/gems.ts`：经验宝石掉落、拾取移动、两段线性升级经验曲线与 40 级软上限计算（`xpToNext`）。
  - `src/core/waves.ts` & `src/core/waveClock.ts`：波次时间轴解释器与无尽循环时钟（处理回绕、密度/血量膨胀及无尽模式怪物经验缩放）。
- **关键目录结构：**
  - `src/core/`：纯 TypeScript 模拟层，禁止 Phaser/DOM/BOM import；包含 RNG、dt、数学、对象池、空间网格、敌人、城墙、武器、弹丸、效果槽、区域、波次、胜利、Boss、目标预测、卡牌和测试。
  - `src/core/behaviors/`：8 把武器的行为分支和行为测试，行为通过注册表 + `import.meta.glob` 自动发现。
  - `src/data/`：JSON 数值表及加载器。包括 `config.json`、`enemies.json`、`waves.json`、`effects.json`、`cards.json`、`weapons/*.json`。
  - `src/game/`：合成层，会话和 localStorage 纪录。
  - `src/phaser/`：Phaser 场景、主循环和霓虹几何视觉；`fx.ts` 含发光/爆裂/冲击环/背景等视图特效。
  - `src/ui/`：DOM 覆盖层、三选一、模式选择、结算、纪录展示、音效开关和 CSS。
  - `src/audio/`：WebAudio 合成音效引擎。

---

## 3. 当前开发进度与迭代里程碑

### [已完成里程碑]

1. **M1: T5.3b 弹道与卡牌机制全武器闭环落地**：
   - 连射队列（`burst_shot`）：5 把弹道武器（狙击、霰弹、导弹、迫击炮、棱镜）完成开火排波与帧推进消费，快照 stats 独立结算，怪物全灭安全跳过，龙息模式严格互斥。
   - 分裂机制（`split_shot`）：5 把弹道武器在直击/爆炸/终点处通过 `pickNearestDistinctEnemies` 生成至多 4 发次级弹，打上 `isSecondary: 1` 与 `splitDone: 1` 标识，继承 20% 伤害，**严禁次级弹递归分裂与触发连射跟发队列**。
   - DoT 频率（`dot_freq`）：6 把武器的效果槽实例及地面 Zone 燃烧/腐蚀/毒液的 tick 间隔随牌层数精准缩短。
   - 专属牌与数据对齐：8 把武器专属牌 params 与行为层消费字段完全一致，移除了代码中的 `TODO(handoff):` 注释。
   - 新增 `src/core/ballistics_cards_closed_loop.test.ts`（43 个闭环测试）。

2. **M2: 机制组合边界与牌池规则测试全覆盖**：
   - 牌池升级流验证：初始 0 级起步、每次选牌 level+1、前置依赖/互斥约束、满 4 把武器且全部 10 级后解锁无限牌池；旧被动牌彻底绝迹。
   - 极端边界验证：开火后怪物瞬间全灭静默跳过、无分裂目标安全兜底、多射4层+连射2层高并发弹幕生命周期与池化内存稳定性、龙息模式切换与互斥。
   - 新增 `src/core/m2_boundary_extreme.test.ts`（16 个专项测试）。

3. **M3: 怪物数量翻倍与平衡性深度校准**：
   - 波次怪量翻倍：`src/data/waves.json` 全面重构，总怪量由 ~578 只提升至 1036+ 只（提升约 100%）。
   - 数值与城墙调平：`src/data/config.json` 中 `wallMaxHp` 设为 1600；`src/data/enemies.json` 属性协同调整。
   - 波次契约与平衡回归：更新 `src/core/waves.test.ts` 适配新波次契约；`src/core/balance.test.ts` 自动化回归全绿。

4. **M4: UI 呈现与全量回归验收**：
   - 升级面板 UI 优化：`src/ui/overlay.ts` 和 `src/ui/styles.ts` 接入新牌池规范：新武器提示“解锁新武器 · [名称]（初始等级 Lv.0）”；卡牌展示归属武器与“强化升级 Lv.n → Lv.n+1”；无限池激活时显示“无限牌池已激活（突破上限）”与“等级突破 Lv.n → Lv.n+1”徽章；彻底清除旧被动样式与残留。
   - 渲染契约核验：Phaser 视图层多射、连射、分裂弹幕、射线与爆炸视效稳定。

5. **M5: 轨道贯穿炮射线统一截断/自然衔接 + 武器索敌射程匹配**：
   - **轨道炮统一截断**：`behavior_piercingBolt.ts` 重构 `settleRay`，所有射线（主射线、三叉侧射线、折射射线）统一在消耗完 `pierce` 上限后在最后一个受击怪体内截断停止；未遇阻挡或未耗尽上限才穿出全屏。
   - **折射自然衔接**：折射起点从主射线实际终点（若被截断则从受击怪体内折出；全屏贯穿则从全屏尽头折出）自然发射，多层折射链式继承上层实际终点。
   - **跳弹自然衔接**：主射线刚好停在最后一个受击怪身上，跳弹光束紧接着从该怪身上折向下一个怪。
   - **武器索敌射程匹配**：`targeting.ts` 的 `FindTargetOpts` 支持 `maxRange` 射程过滤；`behavior_heatBeam.ts` 接入 `beamRange` 过滤，射程内无敌人时光束不开火、不积热、冷却置 0 就绪，彻底解决对顶部远距离敌人空放问题。

6. **M6: 战斗机制精细化与平衡优化（防空放/弹跳重构/击退抗性/Boss削弱/龙息移除）**：
   - **扇面霰弹防空放**：`behavior_scatterShot.ts` 计算有效射程 `effRange = projectileSpeed * (ttlMs / 1000)`，无敌人在射程内不开火、冷却置 0 就绪；全武器开火前均对齐射程与存活目标检测。
   - **轨道炮弹跳计数与穿透保留**：`behavior_piercingBolt.ts` 引入开火时弹跳计数（初始 0，选弹跳强化后初始 1）。遍历射线击中怪物时若计数为 1，向 200px 内未受击存活怪弹跳，触发后计数置 0 且**该次命中不消耗 pierce**，后续怪物可继续被贯穿。
   - **击退垂直向上与怪物生命抗性**：`src/core/effects.ts` 中 knockback 方向统一强制为竖直向上（dirX: 0, dirY: -1）；增加基于生命上限的击退抗性 `res = Math.min(1, 40 / Math.max(1, maxHp))`，高血量肉盾和 Boss 被击退位移显著减少。
   - **首波 Boss 血量调至 70%**：`src/data/enemies.json` 将 `boss_1.hp` 从 900 降为 630，平滑第一次 Boss 战难度跃迁。
   - **扇面霰弹移除【龙息模式】强化**：`src/data/weapons/scatter.json` 移除 `dragon_breath_mode` 牌，同步清理单测与牌池断言。

7. **M7: 轨道贯穿炮机制重构与第一波 Boss 难度下调（防空放、智能折射、多目标分束、穿透增幅、Boss二次削弱）**：
   - **轨道贯穿炮数据重构 (`rail_piercer.json`)**：基础穿透 `base.pierce` 提升至 4；彻底移除 `ricochet`（跳弹）牌；折射牌 (`refract_up`) 上限提升至 4，单次加 1 折射；三叉分裂 (`trident_split`) 重构为锁定至多 3 目标或聚合打击；蓄力增伤 (`charge_damage`) 重构为【穿透增幅】（`penetrateAmp: 0.25`）。
   - **轨道贯穿炮行为重构 (`behavior_piercingBolt.ts`)**：
     - 穿透增幅：每条射线维护 `penetratedCount`，伤害按 `baseDamage * (1 + penetratedCount * penetrateAmp)` 递增。
     - 智能折射：开火维护 `refractLeft`，命中后在 300px 内搜索最近未受击存活敌折射出新贯穿线（折射-1、穿透-1，上限4次）。
     - 多目标锁定分束：三叉开启时，锁定全场威胁最高的至多 3 个存活敌人各射一道贯穿线；若仅单个目标则 3 线聚合打击，造成 1.6 倍伤害并画出 3 段聚合线。
   - **灼热光束折射寻敌 (`behavior_heatBeam.ts`)**：折射层以端点为中心在 300px 内优先锁定存活敌人折射，无敌人时平滑回退到默认 +30° 旋转，消除盲折空放。
   - **首波 Boss 难度下调 (`enemies.json`)**：`boss_1` 生命值再减少 20%（630 -> 504），移速降为基准怪 45%（40 -> 22），平滑早期首领战攻防压力。

8. **M8: 经验与升级系统重构（方案 C · 无尽友好型）**：
   - **需求侧：两段阶梯曲线 + 40 级软上限 (`src/data/config.json`, `src/core/types.ts`, `src/core/simState.ts`, `src/core/gems.ts`)**：
     - $1 \le \text{level} \le 10$：$xpToNext = 5 + (\text{level} - 1) \times 4$（每级递增 4 XP）；
     - $11 \le \text{level} \le 40$：$xpToNext = 41 + (\text{level} - 10) \times 8$（每级递增 8 XP）；
     - $\text{level} > 40$：恒定锁定为软上限 $280$ XP，玩家进入无尽循环后能顺畅突破 40 级门槛并解锁核心的「无限牌池（allMaxedUnlocked）」。
     - 配置契约化：`SimConfig` 字段 `xpTier1Step: 4, xpTier2Step: 8, xpCapLevel: 40, xpCap: 280`，并保留向后兼容旧指数配置的 fallback。
   - **供给侧：怪物基础经验重平衡 (`src/data/enemies.json`)**：
     - `runner: 1`, `standard: 3`, `tank: 15`（与 220 HP 对齐，彻底扭转肉盾怪投入产出比倒挂问题）, `boss_1: 80`。
   - **无尽经验动态缩放 (`src/core/waves.ts`)**：
     - `applyHpScale` 中接入无尽判定：当 `loopScale > 1` 时，`enemy.xp = Math.max(1, Math.round(enemy.xp * loopScale))`，经验掉落随波次循环同步膨胀。
   - **波次海啸与无尽收敛平衡 (`src/data/waves.json`, `src/core/waves.test.ts`, `src/core/balance.test.ts`)**：
     - 密集化 560s~600s 循环段波次，消除原先在回绕点前 10s 的刷新真空期；
     - 无尽循环膨胀系数调谐为 `scalingPerLoop: 2.0`（战役模式不受影响）；
     - `balance.test.ts` 自动玩家代理尊重卡牌自然设计上限（`cardDef.maxCount ?? 5`），避免测试代理无限叠加机制牌引发的弹幕实体指数级失真与 CPU 停滞；在可升级卡牌耗尽后引入快速熔断；
     - **Campaign 战役模式回归**：三种子（7, 42, 2024）全胜通关，通关等级均达到 31~33 级（满足 $\ge 30$ 级指标）；
     - **Endless 无尽模式回归**：顺利突破 40 级并在 **797.6s**（精确对齐 800s 目标锚点）被怪潮攻破城墙收敛（`over === 'defeat'`）；全量自动化平衡回归在 34 进程并发满载下仅耗时约 16.8s（稳稳低于 20s 契约红线）。

9. **M9: 开局初始武器 5 选 1 确定性随机重构**：
   - **近程武器精准剔除**：将原灰盒固定首武器 `rail_piercer` 改为候选池抽取，明确排除 `dragon_breath`（龙息锥）、`scatter`（扇面霰弹）、`heat_beam`（灼热光束）三把短手武器，解决开局阶段怪潮从屏幕顶端下压时玩家无法射击而长时间发呆的问题。
   - **长程武器池标准化**：确立 5 把开局候选武器池（`charge_sniper`、`homing_missile`、`mortar`、`prism`、`rail_piercer`），按严格字典序组织。
   - **合成层与随机契约**：在 `src/game/session.ts` 中通过 `state.rng.pick(INITIAL_WEAPON_CANDIDATES)` 进行等概率抽取，`addWeapon` 0 级起步；同种子及 `restart(seed)` 严格保持确定性可复现。
   - **专项测试闭环**：新增 `src/game/session.test.ts`（8 个测试用例），覆盖候选池定义、排除隔离、种子确定性复现、5 种武器抽中覆盖度及初始 WeaponState 契约；更新 `vite.config.ts` 纳入 `src/game/**/*.test.ts` 测试收集。

10. **M10: 多射主轴保底优化与弹射棱镜连锁闪电特效补全**：
    - **多射「V字中空」严重缺陷修复**：
      - 移除蓄能狙击（`behavior_chargeSniper.ts`）、弹射棱镜（`behavior_prismChain.ts`）、追猎导弹（`behavior_homingMissile.ts`）原先 `(2*i)/(count-1)-1` 的对称偶数插值；
      - 改用「主轴保底 + 侧翼交替展开」算法：第 0 发子弹严格锁定 `baseAng` 0 偏差瞄准线，确保主目标 100% 必中；新增弹丸按 `+1*step, -1*step, +2*step, -2*step...` 向侧翼展开（狙击 4°、棱镜 6°、导弹 12°），彻底杜绝玩家点了多射反而导致正前方空放脱靶的恶性体验。
    - **弹射棱镜【连锁闪电】特效与反馈闭环**：
      - 模拟层 (`behavior_prismChain.ts`)：导出 `PRISM_ZAP_VFX_KEY = 'prism_zap_vfx'` 与 `PrismZapSegment`，在 `zapNearby` 命中额外怪时写入坐标段与 `untilMs`（留存 100ms 并滚动清理过期条目防泄漏），同时推送 `sfx: hit` 音效事件；
      - 视图层 (`fx.ts`, `mainScene.ts`)：导出 `PRISM_ZAP_COLORS`，在 `glowGfx` 的 ADD 叠加发光层通过 `drawPrismZapArcs` 绘制 3 段式霓虹高亮折线电弧（双层粗细线 + 端点高亮能量光斑）。
11. **M11: 敌人生成边界约束、异常状态专属视觉特效、处决强化前置依赖配置**：
    - **敌人刷新与移动边界安全约束**：
      - 动态留白边距生成 (`waves.ts`)：根据普通怪（`radius+10`，保底 32px）与 Boss（`radius*1.5+24`，保底 72px）计算动态 margin，确保大体型怪物、血条与旋转光环完整处于屏幕宽度（720px）内部；
      - 坐标安全防呆与推挤边界钳制 (`enemies.ts`)：在 `spawnEnemy` 中执行 `clamp(x, radius, width - radius)`；在 `updateEnemies` 怪群分离阶段推开后，对所有相互作用的存活怪物施加边界 clamp，彻底杜绝高密度怪群推挤出屏；
      - 新增单测用例覆盖超界坐标安全钳制与边界高密度推挤防出界。
    - **异常状态专属霓虹几何视觉呈现 (`fx.ts`, `mainScene.ts`)**：
      - 纯在 Phaser 的 `glowGfx`（ADD 叠加发光层）执行立即模式几何重绘，零外部贴图素材，零 GC 分配（正弦波 + 模数取余周期计算，无逐帧临时对象生成）；
      - **减速（slow / chill）**：冰蓝冷光外轮廓描边 + 脉动霜冻圈 + 6 芒冰晶尖刺；
      - **冰毒 / 中毒（poison / chill+poison）**：霓虹毒绿升腾消散微粒；若同时有 chill 和 poison，外圈冰霜冷光，内侧升腾消散绿雾气泡微粒；
      - **灼烧（burn）**：亮橙红高频呼吸脉动烈焰描边 + 向上抖动的微型火星细菱形；
      - **眩晕（stun）**：头顶悬浮双段倾斜旋转金色虚线光环与微型星辉，明确行动停摆反馈。
    - **蓄能狙击「处决强化」配置前置依赖斩首**：
      - `charge_sniper.json` 为 `execute_up` 专属卡显式配置 `"requiresCard": "headshot"`；
      - `chargeSniper.test.ts` 补充专项测试，验证未持斩首时不进可选池、持有斩首后正常出现。
12. **M12: 删除经验球即时结算与10分钟战役难度大幅提升**：
    - **删除经验球（Gem）即时到账与升级**：
      - `gems.ts` 中彻底移除击杀生成 Gem、小球在空中追踪飞行的物理实体流程，改为在 `onEnemyKilled` 击杀瞬间直接累加经验 `progress.xp += enemy.xp`，并立即调用通用连升检查 `checkLevelUp(state)`；
      - **城墙修复包（Drop）保持现状**：概率掉落、向城墙中点飞行、到达修墙回血逻辑完整保留；
      - `mainScene.ts` 渲染层清理经验宝石绘制，避免冗余遍历。
    - **10分钟战役模式难度大幅提升**：
      - **小怪血量统一 +50% (`enemies.json`)**：`runner` (18 -> 27)、`standard` (40 -> 60)、`tank` (220 -> 330)；
      - **Boss 血量统一 +100% (`enemies.json`)**：`boss_1` (504 -> 1008)；
      - **小怪数量统一 +50% (`waves.json`)**：匀速刷怪段 `perSec` 全部提升为 1.5 倍（0.6->0.9, 1.0->1.5, 3.0->4.5, 5.0->7.5 等）；爆发波小怪 `count` 全部提升为 1.5 倍（6->9, 8->12, 24->36, 36->54 等）；Boss 每次爆发保持 1 只（血量已翻倍）；
      - 单测适配：`waves.test.ts`、`bossRewards.test.ts`、`gems.test.ts` 更新真实数据断言；
      - 平衡回归：`balance.test.ts` 自动化对局顺利收敛（优秀 build seed=2024 通关击杀达 1689 只，终局 38 级；endless 击杀达 8014 只压死收敛）。
    - **单测与全量回归**：
      - 全量 35 个测试文件、627 个测试用例 100% 全部通过。
13. **M13: 难度精细回调（小怪血量120%、Boss血量150%、小怪数量130%）**：
    - **敌人血量精细调整 (`src/data/enemies.json`)**：
      - 小怪血量设为基线 120%：`runner: 21.6`（基线 18）、`standard: 48`（基线 40）、`tank: 264`（基线 220）；
      - Boss 血量设为基线 150%：`boss_1: 756`（基线 504）；
      - `bossRewards.test.ts` 同步更新对 `boss_1.hp === 756` 的断言。
    - **小怪数量精细调整 (`src/data/waves.json`)**：
      - 匀速段 `perSec` 全部设为基线 130%：如 0.6->0.78, 1.0->1.3, 1.2->1.56, 0.5->0.65, 2.2->2.86, 2.4->3.12, 2.5->3.25, 1.8->2.34, 2.6->3.38, 2.8->3.64, 3.0->3.9, 1.5->1.95, 5.0->6.5 等；
      - 爆发波 `burst.count` 全部设为基线 130%（四舍五入取整）：85s(8), 160s(8), 195s(10), 285s(31), 415s(31), 470s(31), 525s(34), 550s(47), 580s(23)，Boss 每次依然 1 只保持稳定；
      - `waves.test.ts` 同步更新 t=85 首个爆发波数量为 8 的断言；
      - `balance.test.ts` 节奏断言校准为允许通关种子承受前期抗压咬合（半血以内逆风翻盘）。
    - **全自动对局与质量检验**：
      - Campaign 模式种子 7、42、2024 全部通关（击杀 1410~1467 只，终局 Lv.35~36）；
      - Endless 模式在 792.1s（约 800s 锚点）被怪潮（5轮膨胀 ×32倍）收敛压死，击杀 9471 只；
      - 全量 35 个测试文件、627 个测试用例 100% 全部通过。

14. **M14: 弹射棱镜专属卡牌重构（删除回旋返回，新增聚能折返与棱镜往复）**：
    - **卡牌配置更新 (`src/data/weapons/prism.json`)**：彻底移除旧卡牌 `boomerang`（回旋返回），加入 `focus_return`（聚能折返，100%基础+每跳25%增伤贯穿光梭）与 `prism_recurse`（棱镜往复，解除单次命中限制支持折返弹跳）。
    - **物理碰撞去重放宽 (`src/core/projectiles.ts`)**：针对 `prismRecurse === 1 && returning !== 1` 放宽判定，仅跳过刚命中的上一个目标，允许弹丸在双怪之间持续高速往复弹射，保留完整 $N$ 次跳跃历史与递减伤害指数。
    - **行为契约与寻的算法 (`src/core/behaviors/behavior_prismChain.ts`)**：
      - 升级为两级优先级寻的：第一优先级锁定未受击存活敌，第二优先级（无新目标且允许往复）锁定非刚命中自身的最近存活怪；
      - 弹跳终止统一触发【聚能折返】：伤害按 $N = \text{proj.hitIds.length}$ 蓄能 $1 + 0.25 \times N$，射出半径 16、穿透 999 的宽体光梭贯穿飞向角色，彻底修复打单体 Boss/孤立怪时的截断漏洞。
    - **平衡评分与测试验收**：
      - `balance.test.ts` 权重配置更新；
      - `prismChain.test.ts` 新增聚能折返专项测试（基础契约、伤害倍率、单怪保底修复、贯穿扫射）、棱镜往复专项测试（两怪互弹打满跳数、优先新怪、往复+折返联动测试）；
      - 全量 35 个测试文件、632 个测试用例 100% 全部通过。

15. **M15: 10分钟战役节奏优化（小怪血量100%、Boss血量180%、怪量140%、每秒血量增长提升20%）**：
    - **怪物基础血量重置 (`src/data/enemies.json`)**：
      - 小怪回归 100% 基线：`runner: 18`、`standard: 40`、`tank: 220`（降低前期卡手感，割草更顺畅）；
      - Boss 强化至 180% 基线：`boss_1: 907`（原 756，显著强化首领战压迫感）；
      - `bossRewards.test.ts` 同步更新断言 `expect(boss.hp).toBe(907)`。
    - **波次密度与时间膨胀校准 (`src/data/waves.json`)**：
      - 刷怪量统一升至 140% 基线：匀速段 `perSec`（0.84, 1.4, 1.68, 0.7, 3.08, 3.36, 3.5, 2.52 等）与爆发波小怪数量（85s[8], 160s[8], 195s[11], 285s[34], 415s[34], 470s[34], 525s[36], 550s[50], 580s[25]）全面扩展；
      - 动态膨胀提升 20%：`scaling.hpPerSec` 由 0.008 提升至 0.0096（终局 600s 膨胀倍率由 5.80 倍增至 6.76 倍，解决后期过易问题）；
      - `waves.test.ts` 同步更新断言 `expect(REAL.scaling).toEqual({ hpPerSec: 0.0096 })`。
    - **自动化平衡与全量回归验收**：
16. **M16: 黑洞即时拉拽、Boss 异常状态抗性、突破上限文案清洗与无效分裂牌排除**：
    - **黑洞即时拉拽与删除持续吸引**：
      - `src/data/effects.json` 将 `blackhole` 的 `durationMs` 改为 `0` 并移除持续拉拽参数；`src/data/weapons/mortar.json` 同步更新卡牌描述文案为“爆炸后幸存敌人被瞬间拉至爆心”；
      - `src/core/effects.ts` 在 `applyInstant` 中接入黑洞即时处理：命中当帧将幸存敌人坐标拉至爆心并执行场地 clamp，不占用效果槽，彻底消除长达 1.5s 的持续死吸，由下一帧的空间碰撞算法自然分离；
      - `src/core/behaviors/mortar.test.ts` 与 `src/core/effects.test.ts` 全面更新为即时拉拽断言。
    - **Boss 异常状态抗性**：
      - 眩晕缩短：在 `applyEffect` 中检测 `bearer.isBoss === true` 时将 `stun` 持续时间设定为 400ms（普通怪 800ms）；
      - 减速削弱：在 `collectFactor` 中检测 Boss 减速，`slow` 乘区设为 0.75（仅降低 25% 移速，普通怪降低 50%）；`chill` 单层乘区设为 0.875（仅降低 12.5% 移速，普通怪降低 25%）。
    - **突破上限描述清洗与分裂牌排除**：
      - 文案清洗：`src/core/upgrade.ts` 新增 `sanitizeUnlimitedCardDescription` 并在 `allMaxedUnlocked` 激活时自动剔除“（可叠 n 次）”、“，上限n次”等误导性文案，实际保持可无限刷新；
      - 分裂牌排除：`src/data/cards.json` 将 `split_shot` 改为 `"once": true`；`src/core/cards.ts` 的 `availableCards` 保证无论解锁前后，已持有分裂牌均不再刷新进池，避免无收益重复升级。
    - **单测与全量回归**：
      - 全量 35 个测试文件、637 个测试用例 100% 全部通过；
      - `balance.test.ts` 全自动对局：战役模式种子 7、42、2024 全部通关，无尽模式在 800.6s（精确贴合 800s 目标锚点）收敛。

17. **M17: 无尽节奏修复与性能护栏（经验同步膨胀 / 叠牌 hardMax / 实体上限 / 事件节流 / stats 缓存 / 渲染池化）**：
    - **经验需求同步膨胀 + 取消 40 级平顶（`src/core/gems.ts`, `src/core/waves.ts`, `src/data/config.json`）**：
      - `xpToNext` 删除 level>capLevel 恒返 `xpCap` 的平顶分支，第二段线性曲线（每级 +8）无限延续；
      - 无尽模式升级需求 ×`loopScale`：`updateWaves` 每帧把波次时钟存入 `state.meta['waveClock']`（导出键 `WAVE_CLOCK_META_KEY`），gems 侧读取并乘入（缺失/脏值回退 1，campaign 恒为 1 数值不变）；
      - 移除失效配置 `xpCapLevel` / `xpCap`；无尽收敛锚点由 800.6s 前移至 ~670s（升级放缓、成卡更少，方向符合设计意图）。
    - **突破后叠牌硬上限 hardMax（`src/core/cards.ts`, `src/data/cards.json`, `weapons/*.json`）**：
      - `WeaponCardDef.hardMax`：解锁前后都生效的持牌硬上限（区别于解锁后失效的 `maxCount`）；`availableCards` 过滤链新增判定；
      - 通用牌：dmg 12 / spd 6 / multi_shot 8 / burst_shot 4 / range_up 8 / dot_freq 6；专属牌审计补齐（贯穿/处决/折射/弹跳/链路稳定/贯通/反弹等）；
      - 文案两段式「（可叠 n 次，突破后上限 m 次）」；`sanitizeUnlimitedCardDescription` 仅对无 hardMax 牌执行。
    - **全局实体护栏（`src/core/projectiles.ts`, `src/core/waves.ts`, `config.json` 新增 `maxProjectiles:600` / `maxEnemies:350`）**：
      - 弹丸超限在 `updateProjectiles` 帧首按最小 id 回收（只置 `ttlMs=0`，走标准 ttl 死亡路径，行为钩子语义不破坏）；
      - 敌人匀速段与爆发波按剩余额度钳制（boss 豁免但计入存活账）；实测战役峰值敌 53~71 / 弹 36~102，自动对局中上限从未触发，仅在真正死亡螺旋封顶。
    - **高频 sfx 事件 push 点节流（`src/core/events.ts`）**：
      - 新增 `pushSfxThrottled`（模拟时间 30ms 窗口/名，确定性；首事件恒过）；shoot / hit / prism zap hit 换用，一次性 sfx 不动；gameplay 事件（击杀/刷怪）不动。
    - **模拟热路径微优化（`src/core/weapons.ts`, `src/core/spatialHash.ts`）**：
      - `getWeaponStats` 按 `cardsVersion` + cards 引用双保险缓存（meta 单键，`applyUpgrade` 自增版本；全行为调用方审计只读）；`queryCircle` 支持可选 out 缓冲，弹丸命中热路径接入复用。
    - **渲染池化（新建 `src/phaser/enemyRenderer.ts` / `src/phaser/projectileRenderer.ts`，mainScene 净减矢量绘制约 340 行）**：
      - 敌人：create 期逐 typeId 烘焙本体/白色剪影/状态光环贴图 + 固定池 Image（本体/白闪/血条槽/血条填充），每帧零分配；矢量状态特效保留 ≤80 只阈值，超限降级为烘焙光环（ADD + 正弦脉动）；
      - 弹丸：7 张弹体贴图（长针/圆点/导弹/榴弹/棱镜菱形/弹尾/兜底）+ 640 槽 ADD Image 池，直线弹 rotation 对准速度方向；meta VFX（光束/龙息锥/电弧/落点引导）与 zones/墙/HUD 保留 Graphics；
      - VFX 实例上限核查：DeathBurst 200 / MuzzleFlashes 24 / RingWaves 32 既有环形缓冲确认，迫击炮爆炸补视图侧绘制上限 32；
      - 调试句柄 `window.__survivorGame`（与 ?speed/?fx 同类约定）：暴露游戏实例，RAF 被节流的环境（内嵌浏览器验收）可 `game.loop.step(t)` 手动逐帧推进；
      - 内嵌浏览器冒烟验证通过：开局/敌人/弹丸/毒圈/升级面板文案/击杀结算全部正常，0 页面错误。
    - **单测与全量回归**：全量 35 个测试文件、660 个测试用例 100% 全部通过（测试运行时长 ~11s）；`balance.test.ts`：campaign 三种子全胜（Lv.37，最低墙血咬合保留），endless 于 670.1s 收敛（Lv.43，击杀 2191，loop=2）。

18. **M18: 武器系统改造完成（龙息移除 / T4 卡牌文本 / T2 震波壁垒 / T1 灼热光束 / T3 蓄能狙击 / W1 收尾）**：
    - **总体范围**：按 `weapons-overhaul-prompt.md` 完成全部任务——龙息武器整体移除（P0）、全卡牌文本动态生成与专属牌文案重写（T4）、新增震波壁垒 `seismic_wall`（T2）、灼热光束重做为单体锁定持续光束并接入协同齐射（T1）、蓄能狙击牌池重构与三张新专属牌（T3）、balance 面板最终重校与 `weapons-reference.html` 全量更新（W1）。当前武器共 8 把。
    - **T4 卡牌文本基建**：`src/core/upgrade.ts` 新增 `buildCardDescription` 及数据驱动映射表，通用牌按武器实体名词/范围键动态生成；全部专属牌文案按触发条件、数值、上限、联动标准重写；`sanitizeUnlimitedCardDescription` 兼容性保持。
    - **T2 震波壁垒**：新增 `seismic_wall.json`、自动发现行为 `behavior_seismicPulse.ts`；全宽冲击带伤害+击退+眩晕、余震延时队列、效果系统 `durationMs` 逐实例覆盖（Boss 减半作用于覆盖后时长）、过载共振、城垣共鸣回墙；开局排除池 3 项；VFX 共享单键 + 轻微震屏。
    - **T1 灼热光束**：单体锁定持续光束（5 伤/200ms/lockRange 365/四级优先级）；加载（每束独立计数爬升 3%/跳、换目标清零、不封顶）、协同开火（按目标 id 共用计数、达 30 触发全队齐射：五把强制锁定走 forcedTarget、霰弹/震波壁垒门槛不锁定、空转恢复冷却快照）、第二闪光（次级束 25%）；过热槽整套删除；registry fire 增加 `forcedTarget` 第 4 参。
    - **T3 蓄能狙击**：移出 multi_shot/burst_shot/split_shot 并清理四段死代码（多射展开/连射调度/分裂/命中减速，grep 零残留）；新增爆头 `crit_shot`（15%×550%，独立战斗随机流 `getBattleRng`：meta 单键 `battle_rng`、种子 = 会话种子 XOR 0x9E3779B9、主流零消费有测试锁定）、死刑宣告 `execution_order`（存活且 hp<20% maxHp/Boss 7% 立即击杀、该次击杀经验 ×1.25、协同 forcedTarget 路径生效）、边境折返 `border_ricochet`（计数 = 1+2×贯穿弹张数、撞四边缘镜面反弹不消耗计数、归零即销毁、ttl 1200ms 封顶）。
    - **W1 收尾**：balance 面板最终重校（校准 4 条恒真/语义脱节断言：seed 42 前 210s 零墙损恢复原语义、压力存在改「至少啃 5% 墙血」、终局护栏限定 victory 种子、集体咬合锚「至少一个通关种子最低墙血 <85% + ≥1 victory 且 ≥1 defeat」）；`weapons-reference.html` 全量重写为 8 把武器新体系（33 条专属牌描述脚本逐字比对 JSON 一致，旧体系残留 grep 清零）。
    - **最终验收**：**35/35 测试文件、657/657 用例通过**；`npx tsc --noEmit`、`npm run lint`、`git diff --check` 全部通过。balance 面板：campaign seed 7 victory @600s（最低墙血 1244.5/1600=77.8%，击杀 1571）、seed 42 defeat @445.6s（击杀 837）、seed 2024 victory @600s（最低墙血 86.3%，击杀 1497）；endless seed 2024 defeat @665.7s（击杀 1949，loop=2）。
19. **M19: 实玩反馈修复轮（弹丸扫掠碰撞 / 震波壁垒行进波 / 边境折返 ttl 定位）**：
    - **F2 弹丸扫掠碰撞（`src/core/projectiles.ts`, `src/core/spatialHash.ts`）**：修复「狙击弹穿过主目标不掉血」——原命中判定为离散点查询（位移后仅查新位置），弹速 1600px/s × 帧上限 50ms = 单步 80px，远超命中阈值（弹 6 + 敌半径 ≈18px），粗 dt/掉帧必隧穿。改为**扫掠段-圆碰撞**：本步位移线段对敌圆点-线段判交，`SpatialHash.queryRect` 做 AABB 零漏判粗过滤（利用 item 按自身圆 AABB 链接格子的性质，无需按最大敌半径外扩，热路径性能与点查询持平）；命中按沿段 t 序结算（并列 t 按敌 id 升序），穿透弹段内多敌依次扣计数、非穿透弹只结算最近敌；hitIds 去重 / onProjectileHit / splitOnHit / 死亡钩子等契约逐字保持；dt=0 自然退化为点查询。隧穿复现 7 用例修复前全红、修复后全绿，另加全 dt 档不变式测试。
    - **F1 边境折返弹「计数未耗尽消失」定位（零代码改动）**：唯一常态根因是 **ttl 1200ms 封顶**（规范「关键决策记录」明示的设计）：弹速 1600 × ttl 1200ms = 航程 1920px，而上缘反弹往返需 1220+1160=2380px——打高处目标脱靶后反弹必在计数满额时到期销毁，几何必然。其余嫌疑（600 弹上限回收、反射时序、计数扣减、销毁顺序）逐一排查无 bug 并有测试锁定。**ttl 是否延长待用户决策**（延长会放大边境弹输出，属平衡决策）。
    - **F3 震波壁垒改行进波（`behavior_seismicPulse.ts` 重写, `seismic_wall.json`）**：原「瞬时全带结算」改为波前从墙线向上推进的行进波——扫掠时长固定 400ms（几何常量），base 新增 `waveDistance: 160`（行进距离），`bandDepth` 语义改为波前厚度（地裂 +20/层 = 加厚），rangeKeys → ["waveDistance"]（范围强化 ×1.2 作用于行进距离）；走廊结算（上帧带∪本帧带）+ hitIds 去重防击退重入；城垣共鸣按整波累计命中在 sweep 结束结算；余震 400ms ≈ 波扫完时点对行进带追结算；灼热光束协同门槛同步为可达范围（waveDistance+bandDepth）；5 张牌文案改行进波语义，weapons-reference.html 同步；VFX 改移动波前（模拟/视图共享 400ms 常量）。
    - **单测与全量回归**：35 文件、**683 用例**全绿（657→671→683，新增扫掠碰撞 11 + queryRect 3 + F1 不变式 3 + 行进波 12 等）；tsc/lint 通过。balance 面板：扫掠碰撞修复使全武器有效 DPS 上涨（seed 42 由 defeat @445.6s 转为 victory、最低墙血 46.7% 濒死咬合；endless 推迟至 704.1s loop=3），行进波增强使含震波 build 的 seed 2024 咬合 83.1%→97.4%、endless 收敛 679.5s；两轮各做 1 条断言最小校准（语义均保留「真实咬合」意图）。
20. **M20: 第二轮实玩优化（黑洞治理 / 热束粘性锁定与增伤 / 震波增强 / 武器 HUD 芯片 / 爆头处决特效）**：
    - **G2a 黑洞拉拽治理（`effects.ts`, `types.ts`）**：Enemy 新增 `blackholePulledUntilMs`（随死亡回收）；「拉至爆心」改为「向爆心位移至多 120px」+ 被拉后 2s 免疫再次拉拽（免疫窗锚定首次被拉时刻、期内不刷新戳）——消除多射迫击炮高频瞬移对全队弹道与锁定的扰乱。
    - **G2b 灼热光束极强粘性锁定（`behavior_heatBeam.ts`）**：绑定目标存活即永久锁定并持续结算，**被击退/移出 lockRange 也照打**（用户明确要求）；仅死亡才按四级优先级重选；「无目标不开火冷却归 0」只在死亡重选且范围内无候选时触发（粘性锁定为该约定的显式例外）；次级束同规则（死亡重选时避开主束）。
    - **G3 热束增伤**：damage 5→9、加载 3%→5%/跳（JSON）；G4 震波增强：intervalMs 2400、damage 35、waveDistance 220、knockbackForce 110（JSON）。
    - **G1 武器 HUD 胶囊芯片（`mainScene.ts`）**：五行 HUD 的武器拼接行改为每武器一枚独立胶囊（名称+Lv），经验条下方竖排，永不截断；Lv.0 灰 / Lv.1~9 白 / 满级金描边「MAX」；逐帧 diff、无变化零写入（独立 chipGfx 不参与每帧 clear）。
    - **G5 爆头/处决爽感反馈（`behavior_chargeSniper.ts` meta 写入 + `fx.ts`/`mainScene.ts` + `audio/sfx.ts`）**：爆头 = 金色星芒环（meta 键 `sniper_crit_vfx`，有界 16 滚动清理）+ 新合成音效 `crit`；死刑宣告 = 暗红竖贯斩线 + 红色迸散 + `execute` 音效，**无震屏**（用户要求）；一次性 sfx 推送不节流、音频侧保守防叠音；静音开关链路自动生效。
    - **单测与回归**：35 文件、**702 用例**全绿（683→693→702）；tsc/lint 通过。balance：G 轮后 campaign seed 42 咬合 85.4%、seed 2024 零墙损、endless 收敛推迟至 **982.5s（loop=10）**；3 处最小校准（含测试墙钟护栏 30s→40s，全量测试现约 30~40s）。浏览器实玩：热束构筑局 10:00 通关（Lv.35/1470 击杀/满墙血），HUD 四芯片截图验证；IAB 内 RAF 节流致停摆时用 `window.__survivorGame` 手动泵帧。
21. **M21: 蓄能狙击二改（边境折返取消 ttl 封顶 / 死刑宣告经验覆盖直接击杀）**：    - **H1（`behavior_chargeSniper.ts`）**：持边境折返牌时弹丸 `ttlMs = Infinity`——命中计数（1+2×贯穿弹张数）不耗尽就不消失，持续反弹直至计数耗尽那一次命中结算后销毁；未持牌弹 ttl 1200ms 不变。ttl 消费路径全核查（到期判定/600 护栏/池清洗/视图均兼容 Infinity）；空场未命中弹累积由 maxProjectiles 护栏兜底。原 M19 的「ttl 是否延长」待决项由此关闭。
    - **H2**：死刑宣告的击杀经验 ×1.25 从「处决阈值击杀」扩展到**本武器任何一次击杀**（直接击杀、爆头追伤击杀、边境折返多次命中击杀）；实现按死亡时机三路径（基础命中=命中钩子入口补加差额；爆头/处决=泛化 `dealDamageWithKillXpBonus` 临时 killHook），一次死亡只放大一次、他武器击杀不受影响；两牌文案与 weapons-reference.html 同步。
    - **验收**：35 文件、**707 用例**全绿（702→707）；tsc/lint 通过；balance 面板游戏语义断言零校准（含狙击 build 种子 85.4%→84.7%、Lv36→37 自然移动），仅测试墙钟护栏 40s→55s 校准（环境性能度量）。
    - **后续观察项**：campaign 偏易（seed 2024 零墙损）与 endless 收敛推迟（982.5s）的收紧建议同 M20，待用户决策是否在 `waves.json` 立项。

22. **M22: 协同开火触发特效与音效（G6）**：
    - **模拟层（`behavior_heatBeam.ts`）**：协同计数达阈值触发齐射的瞬间写共享单键 `coordinated_fire_vfx`（`{x, y, untilMs}`，触发目标坐标 + 留存 350ms 导出常量，单对象覆写式）+ 推一次性 `coordinated` sfx（不节流约定）；门槛未达/空转/目标已死三条不触发路径不写不推。
    - **视图（`fx.ts` + `mainScene.ts` glow 层）**：触发目标处金/青双色扩散双环 + 8 道短芒（前 60% 扩散后 40% 淡出），玩家位小型响应双环表示「全队收到」；配色取 HUD 芯片既有项目色（MAX 金/常规青），与爆头金以色相+形态双重区分；零分配立即模式重绘。
    - **音效（`audio/sfx.ts`）**：新合成 `coordinated`（D 大调八度上滑 80ms 蓄势 → 纯五度双音齐发，三角波为主），音频侧节流 300ms；静音开关链路自动覆盖。
    - **验收**：35 文件、**712 用例**全绿（707→712）；tsc/lint 通过；balance 面板与 M21 基线逐字一致（纯表现层零数值漂移）。另：5173 端口的残留 vite 进程（首启 dev server 的 node 子进程）已确认身份并清除。

23. **M23: 难度评估、武器手册同步核验与难度调整立项（文档轮，零玩法代码改动）**：
    - **难度数据评估（两模式分开）**：复现 balance 面板并逐项分析 waves/enemies/config 数据——结论：campaign 偏易且 390~600s 终局零压力（三种子全胜、最低墙血 84.7%~100%，根因为玩家乘区 DPS 成长远超敌方线性血量膨胀 ×6.76，且续航 ≈1340 占墙池 84%）；endless 为「假无尽」（600s 后每 40s 血量/密度/经验同乘 2^k，真人约 12 分钟堆屏速败、击退类成唯一生存轴；代理收敛 982.5s 偏离设计锚点）。完整结论与方案见 `difficulty-tuning-plan.md`。
    - **weapons-reference.html 同步核验（M19~M21 增量）**：33 条专属牌文案脚本逐字比对发现 1 处 JSON 过期——`heat_beam.json`「协同开火」仍写旧词「位于震波冲击带内」，改为「位于震波行进波可达范围内」（对齐 F3 行进波语义与 `behavior_heatBeam.ts` 实际门槛 waveDistance+bandDepth=260px，属游戏内三选一牌面文案修复）；HTML 头部变更记录刷新至 2026-09-20、清理内部代号（G2b）。
    - **weapons-reference.html 新增「怪物血量成长表」模块（#enemies）**：0→840s（14 分钟）每 30s 采样，基础血量 × 时间膨胀 ×（600s 后）无尽循环 2^k，按 `waveClock.ts` 公式脚本生成并逐行回验（29/29 一致）；标注战役终局行、循环锯齿警告（每 40s ×2 跳变）与表外修正（burst strengthFactor 0.5~0.8、Boss 豁免、对墙伤害/移速不膨胀）。
    - **难度调整立项**：新建 `difficulty-tuning-plan.md`（自包含执行交接：第一轮战役收紧 4 处 JSON【hpPerSec 0.013 / 续航削减 / 晚期 tank 密度】；第二轮无尽曲线重设计【新增 `densityPerLoop` 键解耦密度与血量，scalingPerLoop 2.0→1.45】；调参决策表 / 断言校准指引 / 回退顺序 / 验证协议），待新会话执行。
    - **存量提交（M18~M22 入库）**：4 commits——`22b112e` feat(weapons) 主体（54 文件，+5667/−2626）、`54d8e78` docs 计划、`0124986` chore .zcodeignore、`db9ddbe` docs 计划头修订；提交前验证 35 文件 / 712 用例全绿 + tsc / lint / `git diff --check` 通过。

24. **M24: 战役收紧与无尽曲线重设计（战役终局咬合 + 密度解耦缓坡无尽）**：
    - **第一轮：战役收紧**：
      - `src/data/waves.json`：血量膨胀系数 `scaling.hpPerSec` 由 0.0096 提升至 0.013（终局倍率 ×6.76 → ×8.80）；
      - 续航削减：`src/data/config.json` 的 `repairDropChance` 由 0.02 降为 0.015；`src/data/enemies.json` 的 `boss_1.bossHealPct` 由 0.055 降为 0.045；
      - 晚期怪潮咬合调平：`timeline` 中 `fromSec: 300 / 370 / 500` 的 tank `perSec` 提升至 0.85，`fromSec: 560` tank `perSec` 提升至 1.9，`fromSec: 580` burst tank `count` 提升至 28。彻底消除 390~600s 终局零压力现象，seed 42 在后 120s 承受 637 点真实墙损，最低墙血 22.7%（咬合充分且无窗口性崩盘）；seed 7 最低墙血 17.9%；seed 2024 满血通关；
      - 同步更新 `waves.test.ts`、`bossRewards.test.ts`、`gems.test.ts` 相关断言。
    - **第二轮：无尽曲线重设计（血量放缓 + 密度解耦）**：
      - 模拟层扩展（`src/core/waveClock.ts`）：`EndlessConfig` 新增 `densityPerLoop?: number`，`WaveClockResult` 新增 `densityScale: number`；循环分支按 `densityPerLoop ** loopCount` 独立计算（合法 > 1 独立计算，缺省或脏值回退 `scalingPerLoop`），非循环/通关分支恒 1；
      - 刷怪消费（`src/core/waves.ts`）：`WaveClockInput` 接入 `densityScale`，`updateWaves` 匀速段刷怪累加器改乘 `densityScale`，与血量/经验膨胀 `loopScale` 彻底解耦；
      - 配置落地（`src/data/waves.json`）：`endlessLoop` 配置为 `{"loopFromSec": 560, "scalingPerLoop": 1.60, "densityPerLoop": 1.20}`；
      - 专项单测：`waveClock.test.ts` 新增 4 个单测（缺省回退、解耦计算、通关/线性恒 1、脏配置防呆）；`waves.test.ts` 新增 2 个单测（匀速段累加乘 densityScale、爆发波数量与血量不受影响）；
      - 自动对局面板：endless seed 2024 于 **1070.4s**（17.8 分钟）自然收敛（loop=12，×281.47，击杀 8364），完美落在真人 15~20 分钟黄金生存区间，彻底终结原 12 分钟堆屏秒败问题；单测总墙钟耗时约 33~36s（远低于 55s 护栏）。
    - **手册与参考文档同步**：
      - `weapons-reference.html`：`#enemies` 模块中的怪物血量成长表（0~840s 每 30s 采样）按新公式重算并脚本逐行回验（29/29 一致）；说明文案同步为 1.60^k 缓坡血量与 1.20^k 独立密度。
      - `balance.test.ts`：文件头注释追加 M24 新基线面板与调校记录。
    - **全量测试与质量指标**：35 个测试文件、718 个测试用例 100% 全部通过；`npx tsc --noEmit`、`npm run lint`、`git diff --check` 全部通过。

25. **M25: 战役胜负重构、击退抗性类型化与卡牌展示精简**：
    - **战役获胜条件改为击杀固定数量 Boss（6只）**：
      - 解决原机制下 600s 强制按时间通关导致 580s 刷出的第 6 只 Boss 无法走到城墙前也难以被击杀的无用问题；
      - `src/data/waves.json` 顶层增加 `"campaignBossTarget": 6` 配置；
      - `src/core/bossRewards.ts` 在 Boss 死亡结算时累加 `state.meta.bossKills`，并导出 `getBossKills(state)` 接口；
      - `src/core/victory.ts` 重构：当 `mode === 'campaign'` 且 `bossKills >= targetBossKills` 时判定胜利（`state.over = 'victory'`），endless 模式保持永不胜利；
      - `src/game/session.ts` 传入 `WAVES.campaignBossTarget ?? 6`；`src/phaser/mainScene.ts` HUD 首行在 campaign 模式展示 `模式 通关 (${bossKills}/6)`；
      - `src/core/victory.test.ts` 适配 Boss 击杀数量契约。
    - **击退抗性类型化（固定抗性系数）**：
      - 解决原按实时最大血量 `40 / maxHp` 动态衰减导致游戏后期小怪血量膨胀后击退距离趋于 0 的 CC 失效问题；
      - 基于怪物类型将击退距离固定为游戏 4 分钟（$t = 240$s，$\text{hpScale} = 4.12$）时的数值：
        - `runner: 0.539374`（位移乘数，基准 40/74.16）
        - `standard: 0.242718`（基准 40/164.8）
        - `tank: 0.044131`（基准 40/906.4）
        - `boss_1: 0.010704`（基准 40/3736.84）
      - `src/data/enemies.json` 为 4 类敌人显式配置 `knockbackFactor`；
      - `src/core/types.ts` 与 `src/core/enemies.ts` 声明并传递该属性；
      - `src/core/effects.ts` 的 `applyInstant('knockback')` 优先使用 `b.knockbackFactor`，未配置时安全回退 `40 / maxHp`；`src/core/effects.test.ts` 补充类型抗性单测。
    - **聚能折返弹道竖直向下**：
      - `src/core/behaviors/behavior_prismChain.ts` 中终结宽体贯穿光梭发射方向由指向玩家角色坐标改为严格竖直向下（`vx = 0, vy = speed`）；
      - `src/core/behaviors/prismChain.test.ts` 更新单测断言 `beam.vx === 0` 与 `beam.vy === 800`。
    - **有上限卡牌选牌计数与文案精简**：
      - `src/core/upgrade.ts` 扩充 `UpgradeOption` 增加 `currentCount` 与 `maxCount`；
      - 导出 `formatCardDescriptionWithLimit`，将卡牌原有的“（可叠 n 次...）”等说明统一转换为“（已选/最大）”（如 `（1/3）`），无上限牌与突破后无 hardMax 的牌不展示；
      - 精简震波壁垒卡牌描述（地裂改为“震波判定厚度 +20px，更容易命中敌人”，过载共振、余震、城垣共鸣等全面去冗余）；精简 burst_shot、split_shot、scatter knockback 等卡牌的底层实现细节；
      - `src/ui/overlay.ts` 选牌卡片标题防御性提供徽章兜底。
    - **平衡测试与环境适配**：
      - `src/core/balance.test.ts` 胜负断言接入 Boss 目标数，战役单局运行上限由 605s 扩展至 700s，实测 seed 7 于 636.6s 击杀第 6 只 Boss 通关，seed 2024 于 594.7s 通关；
      - endless seed 2024 于 1270.8s 自然收敛（击杀 10121，loop=17）；测试墙钟护栏放宽至 100s。
    - **手册与参考文档同步**：
      - `weapons-reference.html`：更新震波壁垒卡牌表、弹射棱镜聚能折返、扇面霰弹击退文案与类型击退说明。

26. **M26: DoT 持续伤害系统重构（灼烧百分比+余烬尸爆传染、中毒武器面板挂钩+15层上限+毒发斩杀）**：
    - **重构背景**：原 DoT 系统（固定 2~3 点基础跳伤）在中后期高血量怪潮与 Boss 战中收益极度低下，缺乏实战价值与独特性。
    - **灼烧机制重做（百分比伤害 + 余烬尸爆 + 火种传染）**：
      - `src/data/effects.json`：`burn` 新增 `"hpPctPerTick": 0.02`（每 0.5s 一跳目标 2% 最大生命值，3s 共 6 跳 = 12% maxHp），保留 3 点保底伤害；新增 `"corpseExplosionRadius": 60`；
      - 模拟层实现（`src/core/effects.ts`）：
        - `calcDoTSingleDamage`：精确计算单跳伤害 `max(damagePerTick, maxHp * hpPctPerTick)`；
        - `triggerBurnExplosion`：带灼烧敌人死亡时触发【余烬尸爆】，提取剩余未结算跳数伤害总和（至多 6 跳 = 12% 目标最大生命值），在 60px 半径内对幸存敌人造成 AoE 范围伤害；
        - 单代火种安全传染（`canSpread` 机制）：尸爆击中的幸存敌人被传染灼烧（打上 `{ spread: 0 }` 标记），次级火种死亡引爆伤害但不再向外扩散传染，结合双指针队列平铺消费与 AABB 粗筛，彻底杜绝怪潮中指数级裂变与栈溢出风险；
        - 在 `dealDamage` 致死处挂接 `triggerBurnExplosion`。
    - **中毒机制重做（武器面板挂钩 + 15层叠加上限 + 毒发身亡斩杀）**：
      - `src/data/effects.json`：`poison` 的 `maxStacks` 由 3 层放宽至 15 层，新增 `"weaponDamageFactor": 0.25`（每层每跳造成来源武器单发面板 25% 伤害），保留 2 点保底；
      - 模拟层实现（`src/core/effects.ts` & `src/core/behaviors/behavior_prismChain.ts`）：
        - 挂毒时透传武器单发面板伤害快照 `weaponDamage`；
        - `calcDoTSingleDamage`：单层伤害 `max(damagePerTick, weaponDamage * 0.25)`，总跳伤随 `stacks` 线性叠加；
        - 毒发身亡（斩杀机制）：在 `tickEffectList` 中，当敌人身上中毒预期总伤害（单跳伤害 × 叠层数 × 剩余跳数）大于等于敌人当前生命值时，当帧立刻触发毒发斩杀，清空剩余跳数并直接击杀目标，消除等待跳完的漫长垃圾时间。
    - **武器配置与卡牌描述同步**：
      - `src/data/weapons/scatter.json`：`burn_bullet` 更新为“造成 2% 最大生命值灼烧（3s 共 12%），死亡触发余烬尸爆并传染周围敌人”；
      - `src/data/weapons/heat_beam.json`：`scorch` 同步更新为 2% maxHp 与余烬尸爆传染；
      - `src/data/weapons/homing_missile.json`：`burn_cloud` 同步更新为 2% maxHp 与余烬尸爆传染；
      - `chargeSniper.test.ts` 补充专项测试，验证未持斩首时不进可选池、持有斩首后正常出现。
12. **M12: 删除经验球即时结算与10分钟战役难度大幅提升**：
    - **删除经验球（Gem）即时到账与升级**：
      - `gems.ts` 中彻底移除击杀生成 Gem、小球在空中追踪飞行的物理实体流程，改为在 `onEnemyKilled` 击杀瞬间直接累加经验 `progress.xp += enemy.xp`，并立即调用通用连升检查 `checkLevelUp(state)`；
      - **城墙修复包（Drop）保持现状**：概率掉落、向城墙中点飞行、到达修墙回血逻辑完整保留；
      - `mainScene.ts` 渲染层清理经验宝石绘制，避免冗余遍历。
    - **10分钟战役模式难度大幅提升**：
      - **小怪血量统一 +50% (`enemies.json`)**：`runner` (18 -> 27)、`standard` (40 -> 60)、`tank` (220 -> 330)；
      - **Boss 血量统一 +100% (`enemies.json`)**：`boss_1` (504 -> 1008)；
      - **小怪数量统一 +50% (`waves.json`)**：匀速刷怪段 `perSec` 全部提升为 1.5 倍（0.6->0.9, 1.0->1.5, 3.0->4.5, 5.0->7.5 等）；爆发波小怪 `count` 全部提升为 1.5 倍（6->9, 8->12, 24->36, 36->54 等）；Boss 每次爆发保持 1 只（血量已翻倍）；
      - 单测适配：`waves.test.ts`、`bossRewards.test.ts`、`gems.test.ts` 更新真实数据断言；
      - 平衡回归：`balance.test.ts` 自动化对局顺利收敛（优秀 build seed=2024 通关击杀达 1689 只，终局 38 级；endless 击杀达 8014 只压死收敛）。
    - **单测与全量回归**：
      - 全量 35 个测试文件、627 个测试用例 100% 全部通过。
13. **M13: 难度精细回调（小怪血量120%、Boss血量150%、小怪数量130%）**：
    - **敌人血量精细调整 (`src/data/enemies.json`)**：
      - 小怪血量设为基线 120%：`runner: 21.6`（基线 18）、`standard: 48`（基线 40）、`tank: 264`（基线 220）；
      - Boss 血量设为基线 150%：`boss_1: 756`（基线 504）；
      - `bossRewards.test.ts` 同步更新对 `boss_1.hp === 756` 的断言。
    - **小怪数量精细调整 (`src/data/waves.json`)**：
      - 匀速段 `perSec` 全部设为基线 130%：如 0.6->0.78, 1.0->1.3, 1.2->1.56, 0.5->0.65, 2.2->2.86, 2.4->3.12, 2.5->3.25, 1.8->2.34, 2.6->3.38, 2.8->3.64, 3.0->3.9, 1.5->1.95, 5.0->6.5 等；
      - 爆发波 `burst.count` 全部设为基线 130%（四舍五入取整）：85s(8), 160s(8), 195s(10), 285s(31), 415s(31), 470s(31), 525s(34), 550s(47), 580s(23)，Boss 每次依然 1 只保持稳定；
      - `waves.test.ts` 同步更新 t=85 首个爆发波数量为 8 的断言；
      - `balance.test.ts` 节奏断言校准为允许通关种子承受前期抗压咬合（半血以内逆风翻盘）。
    - **全自动对局与质量检验**：
      - Campaign 模式种子 7、42、2024 全部通关（击杀 1410~1467 只，终局 Lv.35~36）；
      - Endless 模式在 792.1s（约 800s 锚点）被怪潮（5轮膨胀 ×32倍）收敛压死，击杀 9471 只；
      - 全量 35 个测试文件、627 个测试用例 100% 全部通过。

14. **M14: 弹射棱镜专属卡牌重构（删除回旋返回，新增聚能折返与棱镜往复）**：
    - **卡牌配置更新 (`src/data/weapons/prism.json`)**：彻底移除旧卡牌 `boomerang`（回旋返回），加入 `focus_return`（聚能折返，100%基础+每跳25%增伤贯穿光梭）与 `prism_recurse`（棱镜往复，解除单次命中限制支持折返弹跳）。
    - **物理碰撞去重放宽 (`src/core/projectiles.ts`)**：针对 `prismRecurse === 1 && returning !== 1` 放宽判定，仅跳过刚命中的上一个目标，允许弹丸在双怪之间持续高速往复弹射，保留完整 $N$ 次跳跃历史与递减伤害指数。
    - **行为契约与寻的算法 (`src/core/behaviors/behavior_prismChain.ts`)**：
      - 升级为两级优先级寻的：第一优先级锁定未受击存活敌，第二优先级（无新目标且允许往复）锁定非刚命中自身的最近存活怪；
      - 弹跳终止统一触发【聚能折返】：伤害按 $N = \text{proj.hitIds.length}$ 蓄能 $1 + 0.25 \times N$，射出半径 16、穿透 999 的宽体光梭贯穿飞向角色，彻底修复打单体 Boss/孤立怪时的截断漏洞。
    - **平衡评分与测试验收**：
      - `balance.test.ts` 权重配置更新；
      - `prismChain.test.ts` 新增聚能折返专项测试（基础契约、伤害倍率、单怪保底修复、贯穿扫射）、棱镜往复专项测试（两怪互弹打满跳数、优先新怪、往复+折返联动测试）；
      - 全量 35 个测试文件、632 个测试用例 100% 全部通过。

15. **M15: 10分钟战役节奏优化（小怪血量100%、Boss血量180%、怪量140%、每秒血量增长提升20%）**：
    - **怪物基础血量重置 (`src/data/enemies.json`)**：
      - 小怪回归 100% 基线：`runner: 18`、`standard: 40`、`tank: 220`（降低前期卡手感，割草更顺畅）；
      - Boss 强化至 180% 基线：`boss_1: 907`（原 756，显著强化首领战压迫感）；
      - `bossRewards.test.ts` 同步更新断言 `expect(boss.hp).toBe(907)`。
    - **波次密度与时间膨胀校准 (`src/data/waves.json`)**：
      - 刷怪量统一升至 140% 基线：匀速段 `perSec`（0.84, 1.4, 1.68, 0.7, 3.08, 3.36, 3.5, 2.52 等）与爆发波小怪数量（85s[8], 160s[8], 195s[11], 285s[34], 415s[34], 470s[34], 525s[36], 550s[50], 580s[25]）全面扩展；
      - 动态膨胀提升 20%：`scaling.hpPerSec` 由 0.008 提升至 0.0096（终局 600s 膨胀倍率由 5.80 倍增至 6.76 倍，解决后期过易问题）；
      - `waves.test.ts` 同步更新断言 `expect(REAL.scaling).toEqual({ hpPerSec: 0.0096 })`。
    - **自动化平衡与全量回归验收**：
16. **M16: 黑洞即时拉拽、Boss 异常状态抗性、突破上限文案清洗与无效分裂牌排除**：
    - **黑洞即时拉拽与删除持续吸引**：
      - `src/data/effects.json` 将 `blackhole` 的 `durationMs` 改为 `0` 并移除持续拉拽参数；`src/data/weapons/mortar.json` 同步更新卡牌描述文案为“爆炸后幸存敌人被瞬间拉至爆心”；
      - `src/core/effects.ts` 在 `applyInstant` 中接入黑洞即时处理：命中当帧将幸存敌人坐标拉至爆心并执行场地 clamp，不占用效果槽，彻底消除长达 1.5s 的持续死吸，由下一帧的空间碰撞算法自然分离；
      - `src/core/behaviors/mortar.test.ts` 与 `src/core/effects.test.ts` 全面更新为即时拉拽断言。
    - **Boss 异常状态抗性**：
      - 眩晕缩短：在 `applyEffect` 中检测 `bearer.isBoss === true` 时将 `stun` 持续时间设定为 400ms（普通怪 800ms）；
      - 减速削弱：在 `collectFactor` 中检测 Boss 减速，`slow` 乘区设为 0.75（仅降低 25% 移速，普通怪降低 50%）；`chill` 单层乘区设为 0.875（仅降低 12.5% 移速，普通怪降低 25%）。
    - **突破上限描述清洗与分裂牌排除**：
      - 文案清洗：`src/core/upgrade.ts` 新增 `sanitizeUnlimitedCardDescription` 并在 `allMaxedUnlocked` 激活时自动剔除“（可叠 n 次）”、“，上限n次”等误导性文案，实际保持可无限刷新；
      - 分裂牌排除：`src/data/cards.json` 将 `split_shot` 改为 `"once": true`；`src/core/cards.ts` 的 `availableCards` 保证无论解锁前后，已持有分裂牌均不再刷新进池，避免无收益重复升级。
    - **单测与全量回归**：
      - 全量 35 个测试文件、637 个测试用例 100% 全部通过；
      - `balance.test.ts` 全自动对局：战役模式种子 7、42、2024 全部通关，无尽模式在 800.6s（精确贴合 800s 目标锚点）收敛。

17. **M17: 无尽节奏修复与性能护栏（经验同步膨胀 / 叠牌 hardMax / 实体上限 / 事件节流 / stats 缓存 / 渲染池化）**：
    - **经验需求同步膨胀 + 取消 40 级平顶（`src/core/gems.ts`, `src/core/waves.ts`, `src/data/config.json`）**：
      - `xpToNext` 删除 level>capLevel 恒返 `xpCap` 的平顶分支，第二段线性曲线（每级 +8）无限延续；
      - 无尽模式升级需求 ×`loopScale`：`updateWaves` 每帧把波次时钟存入 `state.meta['waveClock']`（导出键 `WAVE_CLOCK_META_KEY`），gems 侧读取并乘入（缺失/脏值回退 1，campaign 恒为 1 数值不变）；
      - 移除失效配置 `xpCapLevel` / `xpCap`；无尽收敛锚点由 800.6s 前移至 ~670s（升级放缓、成卡更少，方向符合设计意图）。
    - **突破后叠牌硬上限 hardMax（`src/core/cards.ts`, `src/data/cards.json`, `weapons/*.json`）**：
      - `WeaponCardDef.hardMax`：解锁前后都生效的持牌硬上限（区别于解锁后失效的 `maxCount`）；`availableCards` 过滤链新增判定；
      - 通用牌：dmg 12 / spd 6 / multi_shot 8 / burst_shot 4 / range_up 8 / dot_freq 6；专属牌审计补齐（贯穿/处决/折射/弹跳/链路稳定/贯通/反弹等）；
      - 文案两段式「（可叠 n 次，突破后上限 m 次）」；`sanitizeUnlimitedCardDescription` 仅对无 hardMax 牌执行。
    - **全局实体护栏（`src/core/projectiles.ts`, `src/core/waves.ts`, `config.json` 新增 `maxProjectiles:600` / `maxEnemies:350`）**：
      - 弹丸超限在 `updateProjectiles` 帧首按最小 id 回收（只置 `ttlMs=0`，走 standard ttl 死亡路径，行为钩子语义不破坏）；
      - 敌人匀速段与爆发波按剩余额度钳制（boss 豁免但计入存活账）；实测战役峰值敌 53~71 / 弹 36~102，自动对局中上限从未触发，仅在真正死亡螺旋封顶。
    - **高频 sfx 事件 push 点节流（`src/core/events.ts`）**：
      - 新增 `pushSfxThrottled`（模拟时间 30ms 窗口/名，确定性；首事件恒过）；shoot / hit / prism zap hit 换用，一次性 sfx 不动；gameplay 事件（击杀/刷怪）不动。
    - **模拟热路径微优化（`src/core/weapons.ts`, `src/core/spatialHash.ts`）**：
      - `getWeaponStats` 按 `cardsVersion` + cards 引用双保险缓存（meta 单键，`applyUpgrade` 自增版本；全行为调用方审计只读）；`queryCircle` 支持可选 out 缓冲，弹丸命中热路径接入复用。
    - **渲染池化（新建 `src/phaser/enemyRenderer.ts` / `src/phaser/projectileRenderer.ts`，mainScene 净减矢量绘制约 340 行）**：
      - 敌人：create 期逐 typeId 烘焙本体/白色剪影/状态光环贴图 + 固定池 Image（本体/白闪/血条槽/血条填充），每帧零分配；矢量状态特效保留 ≤80 只阈值，超限降级为烘焙光环（ADD + 正弦脉动）；
      - 弹丸：7 张弹体贴图（长针/圆点/导弹/榴弹/棱镜菱形/弹尾/兜底）+ 640 槽 ADD Image 池，直线弹 rotation 对准速度方向；meta VFX（光束/龙息锥/电弧/落点引导）与 zones/墙/HUD 保留 Graphics；
      - VFX 实例上限核查：DeathBurst 200 / MuzzleFlashes 24 / RingWaves 32 既有环形缓冲确认，迫击炮爆炸补视图侧绘制上限 32；
      - 调试句柄 `window.__survivorGame`（与 ?speed/?fx 同类约定）：暴露游戏实例，RAF 被节流的环境（内嵌浏览器验收）可 `game.loop.step(t)` 手动逐帧推进；
      - 内嵌浏览器冒烟验证通过：开局/敌人/弹丸/毒圈/升级面板文案/击杀结算全部正常，0 页面错误。
    - **单测与全量回归**：全量 35 个测试文件、660 个测试用例 100% 全部通过（测试运行时长 ~11s）；`balance.test.ts`：campaign 三种子全胜（Lv.37，最低墙血咬合保留），endless 于 670.1s 收敛（Lv.43，击杀 2191，loop=2）。

18. **M18: 武器系统改造完成（龙息移除 / T4 卡牌文本 / T2 震波壁垒 / T1 灼热光束 / T3 蓄能狙击 / W1 收尾）**：
    - **总体范围**：按 `weapons-overhaul-prompt.md` 完成全部任务——龙息武器整体移除（P0）、全卡牌文本动态生成与专属牌文案重写（T4）、新增震波壁垒 `seismic_wall`（T2）、灼热光束重做为单体锁定持续光束并接入协同齐射（T1）、蓄能狙击牌池重构与三张新专属牌（T3）、balance 面板最终重校与 `weapons-reference.html` 全量更新（W1）。当前武器共 8 把。
    - **T4 卡牌文本基建**：`src/core/upgrade.ts` 新增 `buildCardDescription` 及数据驱动映射表，通用牌按武器实体名词/范围键动态生成；全部专属牌文案按触发条件、数值、上限、联动标准重写；`sanitizeUnlimitedCardDescription` 兼容性保持。
    - **T2 震波壁垒**：新增 `seismic_wall.json`、自动发现行为 `behavior_seismicPulse.ts`；全宽冲击带伤害+击退+眩晕、余震延时队列、效果系统 `durationMs` 逐实例覆盖（Boss 减半作用于覆盖后时长）、过载共振、城垣共鸣回墙；开局排除池 3 项；VFX 共享单键 + 轻微震屏。
    - **T1 灼热光束**：单体锁定持续光束（5 伤/200ms/lockRange 365/四级优先级）；加载（每束独立计数爬升 3%/跳、换目标清零、不封顶）、协同开火（按目标 id 共用计数、达 30 触发全队齐射：五把强制锁定走 forcedTarget、霰弹/震波壁垒门槛不锁定、空转恢复冷却快照）、第二闪光（次级束 25%）；过热槽整套删除；registry fire 增加 `forcedTarget` 第 4 参。
    - **T3 蓄能狙击**：移出 multi_shot/burst_shot/split_shot 并清理四段死代码（多射展开/连射调度/分裂/命中减速，grep 零残留）；新增爆头 `crit_shot`（15%×550%，独立战斗随机流 `getBattleRng`：meta 单键 `battle_rng`、种子 = 会话种子 XOR 0x9E3779B9、主流零消费有测试锁定）、死刑宣告 `execution_order`（存活且 hp<20% maxHp/Boss 7% 立即击杀、该次击杀经验 ×1.25、协同 forcedTarget 路径生效）、边境折返 `border_ricochet`（计数 = 1+2×贯穿弹张数、撞四边缘镜面反弹不消耗计数、归零即销毁、ttl 1200ms 封顶）。
    - **W1 收尾**：balance 面板最终重校（校准 4 条恒真/语义脱节断言：seed 42 前 210s 零墙损恢复原语义、压力存在改 "至少啃 5% 墙血"、终局护栏限定 victory 种子、集体咬合锚 "至少一个通关种子最低墙血 <85% + ≥1 victory 且 ≥1 defeat"）；`weapons-reference.html` 全量重写为 8 把武器新体系（33 条专属牌描述脚本逐字比对 JSON 一致，旧体系残留 grep 清零）。
    - **最终验收**：**35/35 测试文件、657/657 用例通过**；`npx tsc --noEmit`、`npm run lint`、`git diff --check` 全部通过。balance 面板：campaign seed 7 victory @600s（最低墙血 1244.5/1600=77.8%，击杀 1571）、seed 42 defeat @445.6s（击杀 837）、seed 2024 victory @600s（最低墙血 86.3%，击杀 1497）；endless seed 2024 defeat @665.7s（击杀 1949，loop=2）。
19. **M19: 实玩反馈修复轮（弹丸扫掠碰撞 / 震波壁垒行进波 / 边境折返 ttl 定位）**：
    - **F2 弹丸扫掠碰撞（`src/core/projectiles.ts`, `src/core/spatialHash.ts`）**：修复「狙击弹穿过主目标不掉血」——原命中判定为离散点查询（位移后仅查新位置），弹速 1600px/s × 帧上限 50ms = 单步 80px，远超命中阈值（弹 6 + 敌半径 ≈18px），粗 dt/掉帧必隧穿。改为**扫掠段-圆碰撞**：本步位移线段对敌圆点-线段判交，`SpatialHash.queryRect` 做 AABB 零漏判粗过滤（利用 item 按自身圆 AABB 链接格子的性质，无需按最大敌半径外扩，热路径性能与点查询持平）；命中按沿段 t 序结算（并列 t 按敌 id 升序），穿透弹段内多敌依次扣计数、非穿透弹只结算最近敌；hitIds 去重 / onProjectileHit / splitOnHit / 死亡钩子等契约逐字保持；dt=0 自然退化为点查询。隧穿复现 7 用例修复前全红、修复后全绿，另加全 dt 档不变式测试。
    - **F1 边境折返弹「计数未耗尽消失」定位（零代码改动）**：唯一常态根因是 **ttl 1200ms 封顶**（规范「关键决策记录」明示的设计）：弹速 1600 × ttl 1200ms = 航程 1920px，而上缘反弹往返需 1220+1160=2380px——打高处目标脱靶后反弹必在计数满额时到期销毁，几何必然。其余嫌疑（600 弹上限回收、反射时序、计数扣减、销毁顺序）逐一排查无 bug 并有测试锁定。**ttl 是否延长待用户决策**（延长会放大边境弹输出，属平衡决策）。
    - **F3 震波壁垒改行进波（`behavior_seismicPulse.ts` 重写, `seismic_wall.json`）**：原「瞬时全带结算」改为波前从墙线向上推进的行进波——扫掠时长固定 400ms（几何常量），base 新增 `waveDistance: 160`（行进距离），`bandDepth` 语义改为波前厚度（地裂 +20/层 = 加厚），rangeKeys → ["waveDistance"]（范围强化 ×1.2 作用于行进距离）；走廊结算（上帧带∪本帧带）+ hitIds 去重防击退重入；城垣共鸣按整波累计命中在 sweep 结束结算；余震 400ms ≈ 波扫完时点对行进带追结算；灼热光束协同门槛同步为可达范围（waveDistance+bandDepth）；5 张牌文案改行进波语义，weapons-reference.html 同步；VFX 改移动波前（模拟/视图共享 400ms 常量）。
    - **单测与全量回归**：35 文件、**683 用例**全绿（657→671→683，新增扫掠碰撞 11 + queryRect 3 + F1 不变式 3 + 行进波 12 等）；tsc/lint 通过。balance 面板：扫掠碰撞修复使全武器有效 DPS 上涨（seed 42 由 defeat @445.6s 转为 victory、最低墙血 46.7% 濒死咬合；endless 推迟至 704.1s loop=3），行进波增强使含震波 build 的 seed 2024 咬合 83.1%→97.4%、endless 收敛 679.5s；两轮各做 1 条断言最小校准（语义均保留「真实咬合」意图）。
20. **M20: 第二轮实玩优化（黑洞治理 / 热束粘性锁定与增伤 / 震波增强 / 武器 HUD 芯片 / 爆头处决特效）**：
    - **G2a 黑洞拉拽治理（`effects.ts`, `types.ts`）**：Enemy 新增 `blackholePulledUntilMs`（随死亡回收）；「拉至爆心」改为「向爆心位移至多 120px」+ 被拉后 2s 免疫再次拉拽（免疫窗锚定首次被拉时刻、期内不刷新戳）——消除多射迫击炮高频瞬移对全队弹道与锁定的扰乱。
    - **G2b 灼热光束极强粘性锁定（`behavior_heatBeam.ts`）**：绑定目标存活即永久锁定并持续结算，**被击退/移出 lockRange 也照打**（用户明确要求）；仅死亡才按四级优先级重选；「无目标不开火冷却归 0」只在死亡重选且范围内无候选时触发（粘性锁定为该约定的显式例外）；次级束同规则（死亡重选时避开主束）。
    - **G3 热束增伤**：damage 5→9、加载 3%→5%/跳（JSON）；G4 震波增强：intervalMs 2400、damage 35、waveDistance 220、knockbackForce 110（JSON）。
    - **G1 武器 HUD 胶囊芯片（`mainScene.ts`）**：五行 HUD 的武器拼接行改为每武器一枚独立胶囊（名称+Lv），经验条下方竖排，永不截断；Lv.0 灰 / Lv.1~9 白 / 满级金描边「MAX」；逐帧 diff、无变化零写入（独立 chipGfx 不参与每帧 clear）。
    - **G5 爆头/处决爽感反馈（`behavior_chargeSniper.ts` meta 写入 + `fx.ts`/`mainScene.ts` + `audio/sfx.ts`）**：爆头 = 金色星芒环（meta 键 `sniper_crit_vfx`，有界 16 滚动清理）+ 新合成音效 `crit`；死刑宣告 = 暗红竖贯斩线 + 红色迸散 + `execute` 音效，**无震屏**（用户要求）；一次性 sfx 推送不节流、音频侧保守防叠音；静音开关链路自动生效。
    - **单测与回归**：35 文件、**702 用例**全绿（683→693→702）；tsc/lint 通过。balance：G 轮后 campaign seed 42 咬合 85.4%、seed 2024 零墙损、endless 收敛推迟至 **982.5s（loop=10）**；3 处最小校准（含测试墙钟护栏 30s→40s，全量测试现约 30~40s）。浏览器实玩：热束构筑局 10:00 通关（Lv.35/1470 击杀/满墙血），HUD 四芯片截图验证；IAB 内 RAF 节流致停摆时用 `window.__survivorGame` 手动泵帧。
21. **M21: 蓄能狙击二改（边境折返取消 ttl 封顶 / 死刑宣告经验覆盖直接击杀）**：    - **H1（`behavior_chargeSniper.ts`）**：持边境折返牌时弹丸 `ttlMs = Infinity`——命中计数（1+2×贯穿弹张数）不耗尽就不消失，持续反弹直至计数耗尽那一次命中结算后销毁；未持牌弹 ttl 1200ms 不变。ttl 消费路径全核查（到期判定/600 护栏/池清洗/视图均兼容 Infinity）；空场未命中弹累积由 maxProjectiles 护栏兜底。原 M19 的「ttl 是否延长」待决项由此关闭。
    - **H2**：死刑宣告的击杀经验 ×1.25 从「处决阈值击杀」扩展到**本武器任何一次击杀**（直接击杀、爆头追伤击杀、边境折返多次命中击杀）；实现按死亡时机三路径（基础命中=命中钩子入口补加差额；爆头/处决=泛化 `dealDamageWithKillXpBonus` 临时 killHook），一次死亡只放大一次、他武器击杀不受影响；两牌文案与 weapons-reference.html 同步。
    - **验收**：35 文件、**707 用例**全绿（702→707）；tsc/lint 通过；balance 面板游戏语义断言零校准（含狙击 build 种子 85.4%→84.7%、Lv36→37 自然移动），仅测试墙钟护栏 40s→55s 校准（环境性能度量）。
    - **后续观察项**：campaign 偏易（seed 2024 零墙损）与 endless 收敛推迟（982.5s）的收紧建议同 M20，待用户决策是否在 `waves.json` 立项。

22. **M22: 协同开火触发特效与音效（G6）**：
    - **模拟层（`behavior_heatBeam.ts`）**：协同计数达阈值触发齐射的瞬间写共享单键 `coordinated_fire_vfx`（`{x, y, untilMs}`，触发目标坐标 + 留存 350ms 导出常量，单对象覆写式）+ 推一次性 `coordinated` sfx（不节流约定）；门槛未达/空转/目标已死三条不触发路径不写不推。
    - **视图（`fx.ts` + `mainScene.ts` glow 层）**：触发目标处金/青双色扩散双环 + 8 道短芒（前 60% 扩散后 40% 淡出），玩家位小型响应双环表示「全队收到」；配色取 HUD 芯片既有项目色（MAX 金/常规青），与爆头金以色相+形态双重区分；零分配立即模式重绘。
    - **音效（`audio/sfx.ts`）**：新合成 `coordinated`（D 大调八度上滑 80ms 蓄势 → 纯五度双音齐发，三角波为主），音频侧节流 300ms；静音开关链路自动覆盖。
    - **验收**：35 文件、**712 用例**全绿（707→712）；tsc/lint 通过；balance 面板与 M21 基线逐字一致（纯表现层零数值漂移）。另：5173 端口的残留 vite 进程（首启 dev server 的 node 子进程）已确认身份并清除。

23. **M23: 难度评估、武器手册同步核验与难度调整立项（文档轮，零玩法代码改动）**：
    - **难度数据评估（两模式分开）**：复现 balance 面板并逐项分析 waves/enemies/config 数据——结论：campaign 偏易且 390~600s 终局零压力（三种子全胜、最低墙血 84.7%~100%，根因为玩家乘区 DPS 成长远超敌方线性血量膨胀 ×6.76，且续航 ≈1340 占墙池 84%）；endless 为「假无尽」（600s 后每 40s 血量/密度/经验同乘 2^k，真人约 12 分钟堆屏速败、击退类成唯一生存轴；代理收敛 982.5s 偏离设计锚点）。完整结论与方案见 `difficulty-tuning-plan.md`。
    - **weapons-reference.html 同步核验（M19~M21 增量）**：33 条专属牌文案脚本逐字比对发现 1 处 JSON 过期——`heat_beam.json`「协同开火」仍写旧词「位于震波冲击带内」，改为「位于震波行进波可达范围内」（对齐 F3 行进波语义与 `behavior_heatBeam.ts` 实际门槛 waveDistance+bandDepth=260px，属游戏内三选一牌面文案修复）；HTML 头部变更记录刷新至 2026-09-20、清理内部代号（G2b）。
    - **weapons-reference.html 新增「怪物血量成长表」模块（#enemies）**：0→840s（14 分钟）每 30s 采样，基础血量 × 时间膨胀 ×（600s 后）无尽循环 2^k，按 `waveClock.ts` 公式脚本生成并逐行回验（29/29 一致）；标注战役终局行、循环锯齿警告（每 40s ×2 跳变）与表外修正（burst strengthFactor 0.5~0.8、Boss 豁免、对墙伤害/移速不膨胀）。
    - **难度调整立项**：新建 `difficulty-tuning-plan.md`（自包含执行交接：第一轮战役收紧 4 处 JSON【hpPerSec 0.013 / 续航削减 / 晚期 tank 密度】；第二轮无尽曲线重设计【新增 `densityPerLoop` 键解耦密度与血量，scalingPerLoop 2.0→1.45】；调参决策表 / 断言校准指引 / 回退顺序 / 验证协议），待新会话执行。
    - **存量提交（M18~M22 入库）**：4 commits——`22b112e` feat(weapons) 主体（54 文件，+5667/−2626）、`54d8e78` docs 计划、`0124986` chore .zcodeignore、`db9ddbe` docs 计划头修订；提交前验证 35 文件 / 712 用例全绿 + tsc / lint / `git diff --check` 通过。

24. **M24: 战役收紧与无尽曲线重设计（战役终局咬合 + 密度解耦缓坡无尽）**：
    - **第一轮：战役收紧**：
      - `src/data/waves.json`：血量膨胀系数 `scaling.hpPerSec` 由 0.0096 提升至 0.013（终局倍率 ×6.76 → ×8.80）；
      - 续航削减：`src/data/config.json` 的 `repairDropChance` 由 0.02 降为 0.015；`src/data/enemies.json` 的 `boss_1.bossHealPct` 由 0.055 降为 0.045；
      - 晚期怪潮咬合调平：`timeline` 中 `fromSec: 300 / 370 / 500` 的 tank `perSec` 提升至 0.85，`fromSec: 560` tank `perSec` 提升至 1.9，`fromSec: 580` burst tank `count` 提升至 28。彻底消除 390~600s 终局零压力现象，seed 42 在后 120s 承受 637 点真实墙损，最低墙血 22.7%（咬合充分且无窗口性崩盘）；seed 7 最低墙血 17.9%；seed 2024 满血通关；
      - 同步更新 `waves.test.ts`、`bossRewards.test.ts`、`gems.test.ts` 相关断言。
    - **第二轮：无尽曲线重设计（血量放缓 + 密度解耦）**：
      - 模拟层扩展（`src/core/waveClock.ts`）：`EndlessConfig` 新增 `densityPerLoop?: number`，`WaveClockResult` 新增 `densityScale: number`；循环分支按 `densityPerLoop ** loopCount` 独立计算（合法 > 1 独立计算，缺省或脏值回退 `scalingPerLoop`），非循环/通关分支恒 1；
      - 刷怪消费（`src/core/waves.ts`）：`WaveClockInput` 接入 `densityScale`，`updateWaves` 匀速段刷怪累加器改乘 `densityScale`，与血量/经验膨胀 `loopScale` 彻底解耦；
      - 配置落地（`src/data/waves.json`）：`endlessLoop` 配置为 `{"loopFromSec": 560, "scalingPerLoop": 1.60, "densityPerLoop": 1.20}`；
      - 专项单测：`waveClock.test.ts` 新增 4 个单测（缺省回退、解耦计算、通关/线性恒 1、脏配置防呆）；`waves.test.ts` 新增 2 个单测（匀速段累加乘 densityScale、爆发波数量与血量不受影响）；
      - 自动对局面板：endless seed 2024 于 **1070.4s**（17.8 分钟）自然收敛（loop=12，×281.47，击杀 8364），完美落在真人 15~20 分钟黄金生存区间，彻底终结原 12 分钟堆屏秒败问题；单测总墙钟耗时约 33~36s（远低于 55s 护栏）。
    - **手册与参考文档同步**：
      - `weapons-reference.html`：`#enemies` 模块中的怪物血量成长表（0~840s 每 30s 采样）按新公式重算并脚本逐行回验（29/29 一致）；说明文案同步为 1.60^k 缓坡血量与 1.20^k 独立密度。
      - `balance.test.ts`：文件头注释追加 M24 新基线面板与调校记录。
    - **全量测试与质量指标**：35 个测试文件、718 个测试用例 100% 全部通过；`npx tsc --noEmit`、`npm run lint`、`git diff --check` 全部通过。

25. **M25: 战役胜负重构、击退抗性类型化与卡牌展示精简**：
    - **战役获胜条件改为击杀固定数量 Boss（6只）**：
      - 解决原机制下 600s 强制按时间通关导致 580s 刷出的第 6 只 Boss 无法走到城墙前也难以被击杀的无用问题；
      - `src/data/waves.json` 顶层增加 `"campaignBossTarget": 6` 配置；
      - `src/core/bossRewards.ts` 在 Boss 死亡结算时累加 `state.meta.bossKills`，并导出 `getBossKills(state)` 接口；
      - `src/core/victory.ts` 重构：当 `mode === 'campaign'` 且 `bossKills >= targetBossKills` 时判定胜利（`state.over = 'victory'`），endless 模式保持永不胜利；
      - `src/game/session.ts` 传入 `WAVES.campaignBossTarget ?? 6`；`src/phaser/mainScene.ts` HUD 首行在 campaign 模式展示 `模式 通关 (${bossKills}/6)`；
      - `src/core/victory.test.ts` 适配 Boss 击杀数量契约。
    - **击退抗性类型化（固定抗性系数）**：
      - 解决原按实时最大血量 `40 / maxHp` 动态衰减导致游戏后期小怪血量膨胀后击退距离趋于 0 的 CC 失效问题；
      - 基于怪物类型将击退距离固定为游戏 4 分钟（$t = 240$s，$\text{hpScale} = 4.12$）时的数值：
        - `runner: 0.539374`（位移乘数，基准 40/74.16）
        - `standard: 0.242718`（基准 40/164.8）
        - `tank: 0.044131`（基准 40/906.4）
        - `boss_1: 0.010704`（基准 40/3736.84）
      - `src/data/enemies.json` 为 4 类敌人显式配置 `knockbackFactor`；
      - `src/core/types.ts` 与 `src/core/enemies.ts` 声明并传递该属性；
      - `src/core/effects.ts` 的 `applyInstant('knockback')` 优先使用 `b.knockbackFactor`，未配置时安全回退 `40 / maxHp`；`src/core/effects.test.ts` 补充类型抗性单测。
    - **聚能折返弹道竖直向下**：
      - `src/core/behaviors/behavior_prismChain.ts` 中终结宽体贯穿光梭发射方向由指向玩家角色坐标改为严格竖直向下（`vx = 0, vy = speed`）；
      - `src/core/behaviors/prismChain.test.ts` 更新单测断言 `beam.vx === 0` 与 `beam.vy === 800`。
    - **有上限卡牌选牌计数与文案精简**：
      - `src/core/upgrade.ts` 扩充 `UpgradeOption` 增加 `currentCount` 与 `maxCount`；
      - 导出 `formatCardDescriptionWithLimit`，将卡牌原有的“（可叠 n 次...）”等说明统一转换为“（已选/最大）”（如 `（1/3）`），无上限牌与突破后无 hardMax 的牌不展示；
      - 精简震波壁垒卡牌描述（地裂改为“震波判定厚度 +20px，更容易命中敌人”，过载共振、余震、城垣共鸣等全面去冗余）；精简 burst_shot、split_shot、scatter knockback 等卡牌的底层实现细节；
      - `src/ui/overlay.ts` 选牌卡片标题防御性提供徽章兜底。
    - **平衡测试与环境适配**：
      - `src/core/balance.test.ts` 胜负断言接入 Boss 目标数，战役单局运行上限由 605s 扩展至 700s，实测 seed 7 于 636.6s 击杀第 6 只 Boss 通关，seed 2024 于 594.7s 通关；
      - endless seed 2024 于 1270.8s 自然收敛（击杀 10121，loop=17）；测试墙钟护栏放宽至 100s。
    - **手册与参考文档同步**：
      - `weapons-reference.html`：更新震波壁垒卡牌表、弹射棱镜聚能折返、扇面霰弹击退文案与类型击退说明。

26. **M26: DoT 持续伤害系统重构（灼烧百分比+余烬尸爆传染、中毒武器面板挂钩+15层上限+毒发斩杀）**：
    - **重构背景**：原 DoT 系统（固定 2~3 点基础跳伤）在中后期高血量怪潮与 Boss 战中收益极度低下，缺乏实战价值与独特性。
    - **灼烧机制重做（百分比伤害 + 余烬尸爆 + 火种传染）**：
      - `src/data/effects.json`：`burn` 新增 `"hpPctPerTick": 0.02`（每 0.5s 一跳目标 2% 最大生命值，3s 共 6 跳 = 12% maxHp），保留 3 点保底伤害；新增 `"corpseExplosionRadius": 60`；
      - 模拟层实现（`src/core/effects.ts`）：
        - `calcDoTSingleDamage`：精确计算单跳伤害 `max(damagePerTick, maxHp * hpPctPerTick)`；
        - `triggerBurnExplosion`：带灼烧敌人死亡时触发【余烬尸爆】，提取剩余未结算跳数伤害总和（至多 6 跳 = 12% 目标最大生命值），在 60px 半径内对幸存敌人造成 AoE 范围伤害；
        - 单代火种安全传染（`canSpread` 机制）：尸爆击中的幸存敌人被传染灼烧（打上 `{ spread: 0 }` 标记），次级火种死亡引爆伤害但不再向外扩散传染，结合双指针队列平铺消费与 AABB 粗筛，彻底杜绝怪潮中指数级裂变与栈溢出风险；
        - 在 `dealDamage` 致死处挂接 `triggerBurnExplosion`。
    - **中毒机制重做（武器面板挂钩 + 15层叠加上限 + 毒发身亡斩杀）**：
      - `src/data/effects.json`：`poison` 的 `maxStacks` 由 3 层放宽至 15 层，新增 `"weaponDamageFactor": 0.25`（每层每跳造成来源武器单发面板 25% 伤害），保留 2 点保底；
      - 模拟层实现（`src/core/effects.ts` & `src/core/behaviors/behavior_prismChain.ts`）：
        - 挂毒时透传武器单发面板伤害快照 `weaponDamage`；
        - `calcDoTSingleDamage`：单层伤害 `max(damagePerTick, weaponDamage * 0.25)`，总跳伤随 `stacks` 线性叠加；
        - 毒发身亡（斩杀机制）：在 `tickEffectList` 中，当敌人身上中毒预期总伤害（单跳伤害 × 叠层数 × 剩余跳数）大于等于敌人当前生命值时，当帧立刻触发毒发斩杀，清空剩余跳数并直接击杀目标，消除等待跳完的漫长垃圾时间。
    - **武器配置与卡牌描述同步**：
      - `src/data/weapons/scatter.json`：`burn_bullet` 更新为“造成 2% 最大生命值灼烧（3s 共 12%），死亡触发余烬尸爆并传染周围敌人”；
      - `src/data/weapons/heat_beam.json`：`scorch` 同步更新为 2% maxHp 与余烬尸爆传染；
      - `src/data/weapons/homing_missile.json`：`burn_cloud` 同步更新为 2% maxHp 与余烬尸爆传染；
      - `src/data/weapons/prism.json`：`frost_venom` 更新为“每层造成 25% 武器面板伤害（至多 15 层），毒伤超血量时毒发暴毙”；
      - `weapons-reference.html`：同步刷新对应 4 张专属卡牌说明。
    - **测试适配与平衡分析**：
      - `effects.test.ts`：新增 4 个专项测试（百分比跳伤与保底、余烬尸爆与单代传染、15层叠毒与武器伤害挂钩、预期毒伤超血量瞬杀）；
      - `homingMissile.test.ts`、`scatterShot.test.ts`、`heatBeam.test.ts`：将默认 1e6 HP 假人敌人适配为 hp=150（使得 2% maxHp 恰为 3 点保底），消除测试漂移；
      - **战役平衡性实测**：全 3 种子均在预期区间稳定收敛：
        - seed 7: victory @628.0s，最低墙血 77.5%，6 Boss 击杀通关；
        - seed 42: defeat @610.0s（终局有效承压被破防）；
        - seed 2024: victory @592.4s，满血通关；
      - **无尽模式数值边界实测（客观指引）**：
        - 当前按用户要求处于“试玩不封顶”阶段。因 2% maxHp 与尸爆伤害直接随怪物血量线性膨胀，完全中和了无尽模式靠指数血量膨胀（1.6^k）压死玩家的核心收敛手段，实测 endless seed 2024 在 1350s 时墙血仍满 1600、击杀达 20400+，达成物理无敌；
        - 后续建议在 `effects.json` 中配置 `maxDamageCap: 50`（对战役中最高 900 血怪物单跳 18 毫无削弱，但在无尽中能拦下指数膨胀，使无尽模式于 1000~1200s 自然收敛）。

27. **M27: 蓄能狙击武器与强化池重构（穿透递增高伤大炮 + 爆头贯穿闭环）**：
    - **重构背景**：原蓄能狙击作为慢速单发武器，在无尽模式后期因吞吐量极低（恒单发）、爆头概率过低（15%）、边境折返与贯穿弹为伪 AoE 且无法清怪，导致中后期几乎沦为无用武器。
    - **基础属性与通用池调整**：
      - `src/data/weapons/charge_sniper.json`：基础开火间隔 `intervalMs` 提升至 2000ms（0.50 发/s），基伤 60，穿透 0；
      - `src/data/cards.json`：攻速强化 `spd_up` 的 `applyTo` 显式列出除 `charge_sniper` 之外的 7 把武器，正式禁用攻速强化，打造超慢速高乘区大炮特色；
    - **专属牌池重构**：
      - **移除旧牌**：彻底移除【边境折返】（`border_ricochet`）与【贯穿弹】（`pierce_shot`）；清理行为层边境反弹相关代码；
      - **保留既有牌**：【斩首】（`headshot`，高血 ≥60% 增伤 ×1.5）、【处决强化】（`execute_up`，斩首倍率 +0.25）、【死刑宣告】（`execution_order`，击杀经验 ×1.25，残血 <20%/Boss 7% 处决）；
      - **【爆头】重做（`crit_shot`）**：改为可叠 5 层（上限 5 层），每层 +20% 爆头率（1 层 20% → 5 层 100% 必爆），伤害倍率恒为 550%，继续使用独立第二战斗随机流；
      - **新增【让子弹飞】（`bullet_fly`）**：前置需求【爆头】。命中敌人时若触发爆头或成功击杀，子弹不销毁并继续直线穿透；既未暴击又未击杀时击中即销毁；
      - **新增【狙神】（`sniper_god`）**：前置需求【让子弹飞】。子弹每穿透 1 个敌人，对后续敌人的伤害递增 20%（`baseDamage * (1 + penetratedCount * 0.2)`，一次性牌）；与斩首、爆头倍率完美叠乘；
    - **手册与参考文档同步**：
      - `weapons-reference.html`：更新 ③ 蓄能狙击章节概览行、攻速强化适用范围、基础数值（2000ms / 穿透 0）与专属牌表；
    - **全量测试与质量指标**：
      - `chargeSniper.test.ts`：42 个测试全绿，全覆盖四级索敌、移动预测、2000ms 节奏、爆头 1~5 层、让子弹飞暴击/击杀穿透、狙神递增伤害以及通用牌禁用断言；
      - `balance.test.ts`：更新选牌优先级权重（`bullet_fly: 585, sniper_god: 575`）；自动玩家对局中 seed 42 / seed 2024 均自然选出新狙击构筑，通关表现优异；
      - **全量 35 个测试文件、695 passed / 1 skipped 全部通过，耗时仅 8.5s；`npx tsc --noEmit`、`npm run lint`、`npm run build` 全部 0 errors**。

---

## 4. 当前工程状态与质量指标

- **当前工程是否能直接运行/编译：** **是**。
- **全量测试结果 (`npm run test` / `vitest run`)：**
  - **35 / 35 test files passed (100%)**
  - **695 passed, 1 skipped (696 tests)**（仅实验性无尽收敛断言因暂不封顶暂时挂起）。
  - 运行总耗时仅约 **8.5s**。
- **静态检查 (`npm run lint` / `eslint .`)：**
  - **ESLint 通过，0 errors, 0 warnings**。
- **TypeScript 检查 (`npx tsc --noEmit` & `npm run build`)：**
  - **通过，0 errors**，构建输出正常。
- **平衡回归 (`balance.test.ts` 全自动对局面板，M27 最新基线)：**
  - campaign seed 7：`victory` @628.0s，最低墙血 1240/1600（77.5%），击杀 1789（Boss 6）。
  - campaign seed 42：`victory` @597.5s，最低墙血 1600/1600（100.0%），击杀 1579（Boss 6，自然成型狙神构筑）。
  - campaign seed 2024：`victory` @597.3s，最低墙血 1600/1600（100.0%），击杀 1561（Boss 6，自然成型狙神构筑）。
- **开发分支：** `feature/dev-continue`。

---

## 5. 给接手 Agent 的后续建议

1. **当前状态**：M27 蓄能狙击武器与强化池重构（禁用攻速、爆头叠层、让子弹飞贯穿、狙神穿透递增）已完整闭环落地，全量 35 个测试文件 100% 通过，构建与检查全绿。
2. **实机试玩重点（`npm run dev`）**：
   - 体验蓄能狙击在拿到【爆头】、【让子弹飞】与【狙神】后，单发子弹在触发爆头或击杀后一路穿透整条兵线、数字不断飙升的直线清屏爽感；
   - 检验蓄能狙击在完全不吃攻速强化下的节奏手感，评估 2.0s 固定开火周期在大后期的实战体验。
3. **后续待决项**：
   - 用户试玩后对蓄能狙击手感若有微调意向（例如是否恢复少量攻速堆叠），按实战反馈在 `cards.json` 中配置；
   - DoT 持续伤害系统的封顶收尾（`effects.json` 的 `maxDamageCap: 50`）在用户完成实机试玩后决定是否接入。
