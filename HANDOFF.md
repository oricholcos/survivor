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

---

## 4. 当前工程状态与质量指标

- **当前工程是否能直接运行/编译：** **是**。
- **全量测试结果 (`npm run test` / `vitest run`)：**
  - **35 / 35 test files passed (100%)**
  - **660 / 660 tests passed (100%)**
  - 运行总耗时约 11s。
- **静态检查 (`npm run lint` / `eslint .`)：**
  - **ESLint 通过，0 errors, 0 warnings**。
- **生产构建 (`npm run build`)：**
  - **`tsc --noEmit && vite build` 成功**，产物正常生成在 `dist/`。
- **开发分支：** `feature/dev-continue`。

---

## 5. 给接手 Agent 的后续建议

1. **分支合并**：当前分支 `feature/dev-continue` 包含 M1 至 M17 的完整改动，35 个测试文件 100% 通过且构建、lint 全绿。在用户确认后可提交并合并至 `main` 分支。
2. **人工试玩体验**：可启动 `npm run dev` 在浏览器中进行完整试玩体验：
   - 无尽模式后期升级节奏应明显放缓（需求随循环膨胀同步增长，40 级后不再平顶），不再出现几秒一级的连续升级打断；
   - 突破上限后无限牌池叠牌受 hardMax 约束（多射至多 8、连射至多 4 等），极端弹幕规模有界（弹 ≤600 / 敌 ≤350），卡顿应显著改善；
   - 敌人与弹丸渲染已池化（贴图烘焙 + 固定池 Image），高密度局的渲染开销与实体数量线性相关且有硬上限；`window.__survivorGame` 调试句柄可在控制台 `game.loop.step(t)` 手动逐帧推进（RAF 受限环境验收用）。
3. **后续微调规范**：若后续需要进一步调整游戏手感或武器伤害，请严格遵循「纯数据驱动」原则，在 `src/data/` 的 JSON 文件中修改，切勿硬编码进行为层代码。
