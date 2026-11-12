# AI 团队与协作规则

> 立项：2026-11-13
> 方法论来源：Anthropic《How we built our multi-agent research system》+ 本项目踩过的坑
> 通用版方法论已做成 skill：`agent-team-lead`

---

## 一、先判断：这事该不该派 agent

**多 agent 的 token 消耗约是单 agent 的 15 倍。**

| 值得 | 不值得 |
|---|---|
| 能真正并行（改不同文件 / 查不同方向） | 一条命令就能搞定 |
| 单个上下文装不下 | 步骤强依赖，必须按顺序 |
| 需要多个独立视角 | 简单事实查找 |

### 投入分级

| 复杂度 | agent 数 | 每次工具调用 |
|---|---|---|
| 简单查找 | 1 | 3–10 |
| 小改动 / 对比 | 2–4 | 10–15 |
| 大重构 / 复杂调研 | 5–10，明确分工 | 按需 |

**最常见的错误：简单任务也派 agent。**

---

## 二、派活五要素（缺一样就别派）

```markdown
## 目标
一句话说清要达成什么（带数字）

## 输出格式
交回什么（代码 / 报告 / 数据）

## 依据与工具
看哪些文件、参考哪些已有实现

## 边界（硬约束）
只能改什么、不许改什么

## 验收标准
什么算完成（带可验证的判据）
```

**边界最容易出事。** 真实教训：没写边界 → 两个 agent 同时改 `getToSurface` → 互相覆盖两次。

---

## 三、文件归属表（硬约束）

| 文件 / 函数 | 归属 | 别人能改吗 |
|---|---|---|
| `src/actions.js` → `getToSurface` / `tryPillar` / `digOne` | code-fixer | ❌ |
| `src/actions.js` → `mine` / `digAt` / `chopTree` / `digStone` | dig-owner | ❌ |
| `src/actions.js` → `craft*` / `ensureTable` / `safeCraft` | craft-owner | ❌ |
| `src/actions.js` → `place*` / `findPlaceSpot` / `pillarUp` | build-owner | ❌ |
| `src/actions.js` → 其余（goto / bestToolFor / 背包 / 战斗） | **Lead** | ⚠️ 改前通知 |
| `src/skills.js` | skills-owner | ❌ |
| `src/memory/**` | memory-owner | ❌ |
| `src/persona.js` / `talk.js` | **Lead** | ⚠️ 这是人格核心 |
| `src/selfstate.js` / `perceive.js` / `events.js` | perception-owner | ❌ |
| `main.js` | **Lead** | ⚠️ 改前通知 |
| `scripts/**` | test-owner | ❌ |
| `src/home.js` / `src/goals.js`（新文件） | 各自 owner | ❌ |

**同一个文件里的不同函数可以分给不同人，但派活必须写清函数名。**

**新增文件最安全。**

---

## 四、现有成员

| 名字 | 职责 | 状态 |
|---|---|---|
| `code-reviewer` | 代码审查（只读） | 常驻 |
| `code-fixer` | 修 `getToSurface` 及爬坡相关 | 常驻 |
| `test-model-probe` | 测试验证（探针） | 常驻 |
| 其余 7 个 | 按阶段开启 | 待定 |

---

## 五、铁律

1. **派完立刻干别的**，不要同步等结果
2. **要数据不要结论** —— "已修复"不算，要给"从 y=50 到 y=53"
3. **自己验证** —— agent 说完成不等于完成
4. **测试环境必须隔离** —— 独立账号 / 端口 / 数据目录
5. **改前记基线** —— 不然不知道是变好还是变坏
6. **不许同时改两个模块**

---

## 六、Agent 失败模式对照表

| 症状 | 原因 | 防法 |
|---|---|---|
| 两个 agent 做同一件事 | 描述没边界 | 五要素 |
| 改坏别人的代码 | 没归属表 | 归属表 |
| 说"完成了"但没好 | 验收模糊 | 要数据 |
| 测出的数据不可信 | 环境被污染 | 隔离环境 |
| 不知道变好还是变坏 | 没基线 | 先记基线 |

---

## 七、当前项目阶段

见 `ROADMAP.md`。

**当前**：阶段 0（视觉）已完成，阶段 1（验证视觉+原子动作够不够）进行中。

**卡点**：他困在地下爬不出来（y=68，地表约 y=72，差 4 格）。
