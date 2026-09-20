# 武器系统改造 · 完整实施提示词

本文件是一次武器系统改造的完整实施规范，供新会话直接执行。开始前先通读仓库根目录 `AGENTS.md`（客观务实、Markdown 嵌套安全等约定），以及以下关键文件建立上下文：

- `src/core/weapons.ts`（武器解释器、stats 缓存契约、无目标冷却归零约定）
- `src/core/targeting.ts`（统一四级优先级 findTarget、leadAim 移动预测）
- `src/core/behaviors/`（行为自动发现：新建 `behavior_*.ts` 即注册，零中心改动）
- `src/core/cards.ts` + `src/data/cards.json`（通用牌表、乘区/开关注入、excludes/requiresCard 机制）
- `src/data/weapons/*.json`（武器数据表：base 数值 + rangeKeys + 专属牌）
- `src/core/effects.ts` + `src/data/effects.json`（效果系统：tick 间隔 data 覆盖先例、boss 眩晕减半先例、knockback 方向强制竖直向上 + maxHp 抗性）
- `src/core/upgrade.ts`（三选一候选池构建、卡牌文案清洗）
- `src/game/session.ts`（EXCLUDED_INITIAL_WEAPONS / INITIAL_WEAPON_CANDIDATES 开局池）
- `src/core/balance.test.ts`（全自动对局回归面板）

## 全局约定（不可违反）

1. core 层纯 TypeScript，禁止 import phaser 与任何 DOM/BOM。
2. 数值全部来自武器 JSON 数据表；几何量（弹丸半径等）可硬编码并注释。
3. 行为零随机是默认契约；本项目唯一的战斗期随机是任务三的「爆头」，必须走独立随机流（见下），绝不消费 state.rng 主随机流。
4. 所有武器遵守「无目标不开火且 cooldownMs 归 0（重试标记）」约定；解释器据此区分空转与真实开火。
5. 武器 stats 缓存契约：返回对象只读，禁止改写（见 weapons.ts 文件头）。
6. 每完成一个任务跑 `npm test`（vitest）与 `npx tsc --noEmit`，保持全绿再进入下一任务。

---

## 任务一：重做「灼热光束」（heat_beam / behavior_heatBeam.ts）

### 定位

从「线上全体结算的瞬时激光」改为**单体锁定持续光束**：锁定一个目标按固定频率反复跳伤害，靠专属牌【加载】在同一目标上爬升伤害，靠【协同开火】驱动全队齐射。

### 数据表重写（src/data/weapons/heat_beam.json）

```text
base: {
  damage: 5,          // 每跳伤害
  intervalMs: 200,    // 每秒 5 跳
  lockRange: 365,     // 索敌半径 = 角色到墙最远角点的直线距离（角色(360,1220)、墙角(0/720,1160)，≈365）
  fastSpeedThreshold: 80,
  projectileSpeed: 0, pierce: 0, ttlMs: 0   // 固定五键占位（与 mortar 同款）
}
rangeKeys: ["lockRange"]
```

删除键：beamWidth、beamRange、heatPerShot、coolPerSec、overheatThreshold（过热槽整套删除）。

### 牌池

- 删除专属牌：双束（dual_beam）、折射+1（refract_up）、散热强化（cooling_up）。
- 保留：灼痕（scorch，once——每次命中给存活的锁定目标 applyEffect('burn', { damagePerTick: 2 })，语义不变；dot_freq 的 requiresCard=scorch 保留）。
- 新增专属牌（均 once）：
  - 【加载】load_up：对同一目标的每一跳伤害 +基础伤害的 3%，换目标清零，层数无上限。
  - 【协同开火】coordinated_fire：见下文协同语义。
  - 【第二闪光】second_flash：发射一道次级光束，射程/伤害频率与主束相同，伤害为主束的 25%，享受加载与协同（按「武器级单一计数」的并入规则，见下）。

### 行为语义（behavior_heatBeam.ts 重写）

**索敌与锁定（主束）**：每次 fire 按 `findTarget(state, { preferBoss: true, preferFast: true, fastSpeedThreshold })` 在 lockRange 内选目标（统一四级：Boss>贴墙>快速>最近）。锁定目标死亡或离开索敌半径 → 下次 fire 自然重选。范围内无敌人 → 不开火、冷却归 0。主束不受次级束约束，可选中次级束正在打的目标。

**计数模型（加载每束独立；协同按目标共用）**（存 weaponStates 挂载的武器级状态或 meta，按 weaponId 分键）：
- **加载计数——每束各自独立**：主束维护自己「当前目标的连续命中数」n主，次级束维护自己的 n次；任一束换目标 → 只清零该束自己的计数。**即使两束攻击同一目标，加载层数也各自独立计算。**
  - 主束单跳伤害 = damage × (1 + 0.03 × n主)；
  - 次级束单跳伤害 = damage × (1 + 0.03 × n次) × 0.25。
- **协同计数——按目标 id 共用**：按目标 id 记录命中数，活跃至多两份（主束目标一份、次级束目标一份）；两束攻击同一目标时，两束命中推进同一份 = **共同计数**。任一目标计数达到 30 → 以**该目标**为对象触发一次协同齐射，该目标计数归零。某束换走后，其原目标的协同计数清零作废；主束转锁到次级束正在打的目标时，该目标已有计数保留，改为两束共同推进。

**次级光束（持第二闪光牌）**：目标 = 四级优先级结果中**排除主束当前锁定目标**后的最高优先者；排除后无候选 → 攻击主束目标。次级束与主束同 tick 发射、同频率。

**【协同开火】触发语义**：任一目标的协同计数 ≥ 30 → 立即以**该目标**为对象触发一次协同齐射，该目标计数归零重新累计。齐射内容：遍历 state.weaponStates 中**其他所有已拥有武器**：

- 前置门槛：触发目标在该武器的索敌范围内（rail_piercer / prism / charge_sniper / homing_missile / mortar 为全场，恒真；scatter 为 effRange = projectileSpeed × ttlMs / 1000；seismic_wall 为目标位于其当前冲击带内，即 |y − wallLineY| ≤ bandDepth（含地裂加层）；灼热光束自身跳过）。
- **不锁定组（霰弹、震波壁垒）**：不强制指定目标，按各自正常 fireVolley 发动——霰弹固定朝上扇形；震波壁垒对整条墙线带结算（伤害/击退/眩晕照常；目标过门槛即必在带内）。
- **强制锁定组（其他五把）**：以**触发目标**为强制指定目标走真实 fire 流程——狙击以它为目标射出（斩首/爆头/死刑宣告等判定照常）、棱镜以它为首跳（leadAim 照常、后续弹跳正常）、导弹 targetId 指向它（初速朝向它、其后照常追踪）、榴弹以它为密度锚点（落点预测照常）、贯穿炮主射线指向它（三叉等分支照常）。实现上给各行为的 fireVolley 增加可选「指定目标」参数，findTarget 调用点接受覆盖。
- 强制齐射**不影响**被触发武器的冷却与索敌节奏：调用前快照 `ws.cooldownMs`，若该武器本次为空转（借现有约定判定：调用前 cooldownMs ≠ 0 且调用后 == 0）则恢复快照；真实开火则不恢复。
- 齐射使用各武器当前真实 stats（getWeaponStats）；齐射产生的连射跟发波照常入队（scheduleBurstWaves）。
- 协同触发发生在灼热光束的 fire 内（可重入调用其他行为 fire，注意只迭代 fire 开始时的 weaponStates 键快照）。

**清理**：删除过热槽 meta（heat_beam_heat:*）、update 钩子中的散热逻辑、overheat applyEffect；weapons.ts 的 overheatFactor 消费保持不动（通用机制，其他无牌武器不受影响）。

### VFX

meta 键 `heat_beam_vfx:<weaponId>` 结构保留（segments + untilMs）：段序 = [主束, 次级束?]，主束从角色到锁定目标，次级束用区分色。mainScene 的 drawHeatBeam 相应调整（原 beamWidth 从 stats 读取，改为固定视觉宽度常量）。

### 测试（heatBeam.test.ts 重写）

至少覆盖：四级锁定与换目标清零；加载爬升数值（两束各自独立，同目标也独立）；纯单体结算（线上其他敌人不掉血）；次级束目标规则（多目标时避开主束目标/无候选时同目标）；次级束 25% 伤害；协同按目标共用计数（两束同目标共同推进、不同目标各自推进、次级束目标先达 30 时以它触发、主束转锁次级目标时该目标计数保留合流）；协同触发后各武器被真实触发一次、霰弹与震波壁垒不锁定、空转恢复冷却、真实开火不恢复；灼痕附着。

---

## 任务二：新增「震波壁垒」（seismic_wall / behavior_seismicPulse.ts）

### 定位

全武器唯一的**全宽度防线节拍器**：以最慢节奏对整条墙线带内的所有敌人同时结算伤害 + 击退 + 眩晕。无索敌、无弹道、零随机。

### 数据表（src/data/weapons/seismic_wall.json，新建）

```text
id: seismic_wall, name: 震波壁垒, behavior: seismic_pulse, maxLevel: 10
base: {
  damage: 22, intervalMs: 3600,
  bandDepth: 40,        // 冲击带深度（|y - wallLineY| ≤ bandDepth，全 x 宽度，无数量上限）
  knockbackForce: 90,
  projectileSpeed: 0, pierce: 0, ttlMs: 0
}
rangeKeys: ["bandDepth"]
```

### 行为

fire：线性扫描 state.enemies（无需网格），对 |e.y − layout.wallLineY| ≤ bandDepth 的存活敌人依次：dealDamage(damage) → 幸存者 applyEffect('knockback', { force: knockbackForce })（效果引擎强制竖直向上 = 推离墙线，maxHp 抗性自动让 tank/boss 少退）→ 幸存者 applyEffect('stun')（效果表 800ms，Boss 400ms 为现有规则，不新写）。带内无存活敌人 → 不开火、冷却归 0。

### 专属牌（5 张）

- 余震 ×3：脉冲后 400ms 对同一冲击带追加一次 30% 伤害、无击退无眩晕的余震（update 钩子或 meta 延时队列实现）。
- 震荡加深 ×2：眩晕时长 +150ms/层（applyEffect('stun', { durationMs: 覆盖值 })——需给效果系统加 data.durationMs 逐实例覆盖，参照 tickMs 逐实例覆盖的既有先例；Boss 减半规则在覆盖后的时长上照常生效）。
- 地裂 ×2：bandDepth +20/层。
- 过载共振 once：对处于眩晕中的目标伤害 ×2（结算时 hasEffect(e,'stun') 判定）。
- 城垣共鸣 ×2：单次脉冲命中 ≥8 个敌人时，墙回复 4×层数 hp（clamp 到 wall.maxHp；state.wall）。

### 接线

- `src/game/session.ts`：EXCLUDED_INITIAL_WEAPONS 加入 'seismic_wall'（变 3 项：scatter / heat_beam / seismic_wall），INITIAL_WEAPON_CANDIDATES 不变；session.test.ts 的 EXPECTED_EXCLUDED 与长度断言同步改 3。
- `src/data/cards.json`：range_up 的 applyTo 加入 "seismic_wall"。
- VFX：meta 键（共享单键）值 { bandDepth, untilMs }——沿墙线的横向冲击波带 + 轻微震屏（复用 wallDamaged 震屏基建）；fx.ts 加前缀导出，mainScene 加绘制分支。

### 测试（seismicPulse.test.ts 新建）

带判定边界（恰在 bandDepth 上算在内）、全宽度无上限、击退/眩晕附着、无目标冷却归 0、余震延时与 30% 无 CC、震荡加深覆盖（含 Boss 减半叠加语义）、过载共振 ×2、城垣共鸣回复与 clamp。

---

## 任务三：蓄能狙击牌池重构（charge_sniper）

### 牌池调整

- `src/data/cards.json`：multi_shot / burst_shot / split_shot 的 applyTo 移除 "charge_sniper"。
- behavior_chargeSniper.ts 清理死代码：多射扇形展开（count = 1 + projectileCount → 恒 1）、连射调度（scheduleBurstWaves / update 消费）、分裂（splitOnHit / onProjectileHit 整段）、命中减速（slowHit / SLOW_TEMPLATE）。
- 保留：四级优先级 pickTarget、leadAim、mark 模板、斩首（headshot ×1.5 条件乘区）、处决强化（斩首倍率 +0.25/层）、贯穿弹（pierceShot）。

### 新增专属牌

**【爆头】crit_shot（once）**：命中时 15% 概率造成 550% 伤害。
- 独立随机流：在 simState 建立第二随机流（独立 LCG，种子 = 会话种子 XOR 0x9E3779B9，若 createSimState 未暴露种子则透传），仅供战斗期掷点；**绝不消费 state.rng**（升级三选一等主随机流序列零扰动）。同种子全程可复现。
- 判定点：每次命中实例（每弹每敌）独立掷点；与斩首乘区叠乘。

**【死刑宣告】execution_order（once）**：本武器造成的伤害结算后，若目标存活且 hp < 20% maxHp（isBoss 时 7%）→ 立即击杀，该次击杀的宝石经验 ×1.25。
- 生效范围：本武器一切伤害实例（主弹、边境折返多次命中、以及被灼热光束【协同开火】强制触发的狙击齐射）。
- 实现建议：命中点钩子（onProjectileHit 或框架结算回调）在 dealDamage 之后判定；处决用致命 dealDamage 走正常死亡/掉宝路径，宝石经验 ×1.25 的实现方式自选（如 dealDamage 可选 xpFactor 或击杀后覆盖当次 gem 数值），要求只放大这一次击杀。

**【边境折返】border_ricochet（once）**：
- 命中计数 = 1 + 2×(贯穿弹张数)，发射时快照进弹 data；每次命中敌人结算伤害并 -1；计数归零的那次命中结算完后弹就地销毁（等价于把 pierceLeft 设为该计数——框架穿透路径天然满足）。
- **撞地图边缘必反弹、不消耗计数**（镜面反射：垂直于边缘的速度分量取反）：上边缘 y ≤ 0、左右边缘 x ≤ 0 / x ≥ layout.width、下边缘 = 墙线 y ≥ layout.wallLineY。反弹时把位置钳回界内并翻转对应分量。
- 由于计数归零即销毁，飞行中的弹计数必然 ≥1，不存在「计数为 0 撞边」的情况；ttl 1200ms 仍是飞行总时长上限（计数未耗尽也照常到期销毁）。
- 实现注意：反射在行为的 update 钩子做（扫描本行为弹丸，判断「下一帧位移将越界」则先反射，避免框架先回收；先核对 step.ts 中武器钩子与弹丸位移的执行顺序）。

### 测试

牌池断言（三选一不再出现三张通用牌）、爆头概率与独立随机流（主随机流序列不受影响）、死刑宣告阈值（普通 20%/Boss 7%）与经验 ×1.25、边境折返（基础计数 1 的脱靶反弹、贯穿弹计数、镜面反射方向、墙线为下边缘、ttl 封顶）、清理后无多射/连射/分裂残留行为。

---

## 任务四：全卡牌文本优化

1. **通用牌描述按武器动态生成**：在升级候选构建（upgrade.ts）处，通用牌文案按当前武器拼装——
   - 作用键中文映射：lockRange→索敌半径、bandDepth→冲击带深度、chainRange→弹跳范围、aoeRadius→爆炸半径、fanAngleDeg→扇角（范围强化牌必须逐键列出该武器会被强化的范围名）。
   - 通用牌逐武器实体名词：如多射对霰弹是「弹丸」、对榴弹是「榴弹壳体」、对棱镜是「链弹」；连射/分裂同理。生成器数据驱动（映射表），不为单把武器写特判分支。
2. **全部专属牌文案手工重写**（现有 7 把 + 新增震波壁垒），标准：说明触发条件、精确数值、叠层上限、突破规则、与其他牌的联动（如贯穿弹 ↔ 边境折返计数、dot 频率 ↔ 对应附着牌、过载共振 ↔ 自身眩晕）。
3. 现有测试中断言描述原文的用例同步修正；`sanitizeUnlimitedCardDescription` 的清洗逻辑保持兼容（动态生成文案注意保留可清洗的「（可叠 n 次）」格式或调整清洗规则）。

---

## 收尾与验收

1. `npx tsc --noEmit` 零错误、`npm test` 全绿、`npm run lint` 通过。
2. `balance.test.ts` 全自动对局面板重跑：灼热光束重做、蓄能狙击失去三张通用牌、新增强力 CC 武器都会移动基线——按面板重校断言阈值，并在汇报中列出改动前后的关键数字（通关时间、墙损、击杀）。
3. `weapons-reference.html` 全量更新：8 把武器（含震波壁垒）、新索敌逻辑、新牌池与新文案、总览表。
4. 实施顺序建议：任务四的文本基建（生成器先行，新牌直接按新标准写文案）→ 任务二（震波壁垒）→ 任务一（灼热光束）→ 任务三（蓄能狙击）→ 收尾。预计总量 4~4.5 天。

## 关键决策记录（实现时不要再改动）

- 灼热光束：纯单体结算（不穿透线上敌人）；索敌半径 365px 静态值；5 跳/s × 5 伤；过热槽删除；双束/折射/散热强化删除、灼痕保留；四级优先级锁定；加载不封顶；计数模型 = 加载每束独立（同目标也各自计算、换目标只清自己）+ 协同按目标 id 共用计数（同目标共同推进、任一目标达 30 即以它触发齐射）。
- 协同开火：除霰弹与震波壁垒外全部强制锁定光束目标走真实 fire；霰弹/震波壁垒按正常逻辑发动（门槛：霰弹 effRange、震波壁垒目标在当前冲击带内）；不影响被触发武器的冷却。
- 蓄能狙击：独立第二随机流（不扰主流）；死刑宣告经验 = 击杀总经验 ×1.25（非额外 +125%）；边境折返撞边必反弹不消耗计数、计数归零即销毁、ttl 封顶；命中减速删除。
- 震波壁垒：22 伤 / 3.6s / 带 40px / 击退 90 / 眩晕 800（Boss 400）；开局排除池武器；范围牌作用于 bandDepth。
