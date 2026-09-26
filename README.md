# 城墙 survivor

Phaser 3 竖屏自动战斗 survivor / 城墙防守游戏。角色固定在屏幕底部中央，怪物从上方不断下压并在城墙前攻击；武器自动瞄准开火，玩家通过中文三选一升级牌做构筑，不直接移动或瞄准——所有策略都发生在牌桌与武器构筑上。

## 游戏特性

- **8 把武器**：轨道贯穿炮、弹射棱镜、灼热光束、蓄能狙击、追猎导弹、迫击榴弹、扇面霰弹、震波壁垒，每把武器拥有独立的弹道行为与专属卡牌树。
- **40 张卡牌构筑**：7 张通用卡 + 33 张武器专属卡，含前置依赖与互斥约束；每把武器满级后解锁无限牌池。详见 [CARDS.md](CARDS.md)。
- **两种模式**：
  - `campaign` 战役模式——达成 Boss 击杀目标即胜利；
  - `endless` 极限生存模式——波次无尽循环（轮数与倍率持续膨胀），记录生存时长历史最佳。
- **电脑端外置 HUD**：宽屏时将模式、存活时间、等级、击杀、经验条与武器胶囊芯片外置到画布左侧黑边区，点击武器芯片可直接禁用/启用（构筑详情面板内亦可切换）；窄屏 / 移动端自动回退画布内 HUD。
- **霓虹几何视觉与 WebAudio 合成音效**：纯程序化绘制，无外部图片依赖。
- **完全确定性模拟**：核心层为纯 TypeScript（种子 RNG、固定 dt、对象池 + 空间网格），支持全自动对局回归测试。

## 快速开始

```bash
npm install
npm run dev      # 开发服务，默认 http://localhost:5173/
npm run build    # 类型检查 + Vite 生产构建（产物在 dist/）
npm run test     # Vitest 全量测试
npm run lint     # ESLint 静态检查
```

环境要求：Node.js ≥ 20（开发环境为 Node 24 / npm 11）。

**本地调试参数**（附加在 URL 上）：

- `?speed=1..20`：模拟步进倍速；
- `?fx=0`：关闭 Phaser 霓虹泛光降级路径。

## 项目结构

```
src/
├── main.ts              # 浏览器入口：创建会话、启动 Phaser、挂载 DOM UI、音效监听
├── core/                # 纯 TypeScript 模拟层（禁止 Phaser/DOM/BOM import）
│   ├── step.ts          #   帧推进（dt 上限 50ms，战局结束后停摆）
│   ├── behaviors/       #   8 把武器的行为分支（注册表 + import.meta.glob 自动发现）
│   ├── targeting.ts     #   移动预测（leadAim/interceptPoint）与带射程过滤的目标选择
│   ├── upgrade.ts       #   三选一牌池生成与应用（前置依赖/互斥约束）
│   ├── waves.ts         #   波次时间轴解释器与无尽循环时钟
│   └── ...              #   RNG、对象池、空间网格、敌人、弹丸、效果槽、Boss、宝石等
├── data/                # JSON 数值表：config / enemies / waves / effects / cards / weapons/*
├── game/                # 合成层：GameSession 组装根，localStorage 纪录
├── phaser/              # Phaser 场景、主循环、霓虹几何视觉与专用渲染器
├── ui/                  # DOM 覆盖层：三选一、模式选择、结算、外置 HUD、构筑详情、音效开关
└── audio/               # WebAudio 合成音效引擎
```

## 测试

全量 `npm run test` 共 **39 个测试套件 / 753 个用例**，除单元测试外还包含全自动对局回归（`balance.test.ts` 以多组种子完整模拟战役与极限生存对局，验证平衡性收敛）。

## 文档

- [HANDOFF.md](HANDOFF.md) —— 项目交接文档：架构导航、全部迭代里程碑与当前工程状态
- [CARDS.md](CARDS.md) —— 全卡牌文本说明汇总（叠层上限、前置依赖、逐武器实装效果）
- [BUILD_INSPECT_DATA_SPEC.md](BUILD_INSPECT_DATA_SPEC.md) —— 构筑详情面板数据规格
- [difficulty-tuning-plan.md](difficulty-tuning-plan.md) —— 难度调优计划
- [weapons-reference.html](weapons-reference.html) —— 武器数值速查表（浏览器直接打开）
