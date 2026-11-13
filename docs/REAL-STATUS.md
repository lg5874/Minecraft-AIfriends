# 当前真实状态（一页纸）

> 生成：2026-11-13 21:55 ｜ 代码 `3dae160`（工作区有未提交改动，见 §5）
> 方法：`node scripts/*.js` 实跑、读 `data/runtime/*.json`、`git show <hash>:<file>` 取时点快照、grep 代码。
> **本文不引用其他文档的结论**（那些文档本身可能就是错的）。只写事实，不写建议。

---

## 0. 先看口径（不看这节会误读所有数字）

| 字段 | 真实含义 | 代码位置 |
|---|---|---|
| `skills[].uses` | **终身累计**，跨代码版本不重置 | `src/skills.js:537` |
| `skills[].ok` / `fail` | **只算当前这一版代码**；`add()` 换新版时清零 | `src/skills.js:430-433` |
| `skills[].lifetimeOk/Fail` | 设计上存总账，但现存 38 条里**全部是 undefined**（换代发生在字段存在之前） | — |
| `skills[].runs` | 最近 20 次，**跨版本保留** | `src/skills.js:542-548` |

**后果**：`uses ≠ ok + fail`。38 条技能里 **15 条对不上**（如 `k_mwdx4vb0` uses=53 / ok=0 / fail=19）。
"最热技能 53 次、0 成功"这种说法混了两个口径。

> **行号提示**：下面的行号对应 2026-11-13 22:00 的工作区快照。团队还在改 `main.js` / `src/talk.js` / `src/goals.js`，
> 行号会漂（`main.js` 一小时前到现在已整体下移 5 行）。查证时以**函数名**为准。

---

## 1. UNHUMAN-SCAN 16 条：当前代码的真实状态

**12 修 / 1 半 / 3 未动**（扫描时是 16 条全中）

| # | 条目 | 状态 | 现在的位置 |
|---|---|---|---|
| 1 | 公屏只有句号 | ✅ | `src/talk.js:127` `hasRealContent()`（定义在 `:783`）+ `:802` 在 `cleanLine` 里同判 |
| 2 | 98 秒内复读同一句 | ✅ | `src/talk.js:147` 复读硬拦截（去标点后完全相同就不发） |
| 3 | 54 次上下线不理人 | ✅ | `src/spontaneous.js:164` chance 0.85 + `instant: true`；队列优先淘汰非 social（`:197-199`） |
| 4 | 说完就改主意 | ❌ **实现过又被删** | `0040035` 提交里 `talk.js` 有 `pendingIntention`（7 处），`bc5d2f0` 全部删除；当前 HEAD 0 处。`impulse.js` 从来没读过它 |
| 5 | 同一格站 4.5 分钟 | ✅ | `src/actions.js:215` `[stuck]` 强制换动作 + `wander` |
| 6 | 482 次"走不通了"刷屏 | ✅ | `src/actions.js:142` / `:746` 起步宽限 250ms + 600ms 确认窗 |
| 7 | 同一任务连做 5 遍 | ✅ | `src/goals.js:409` `maxMethods: 3` + `methodSwitchWins: 2`（改成"换方法"，`maxIdleWins: 12` 只作兜底） |
| 8 | 98% 判完成但没变化 | ✅ 三层 | 层1 `main.js:1419` `judgeOutcome`；层2 `src/coder.js:253` `verifySkillEffect`（背包/方块/位移三选一）；层3 `src/goals.js:1504` `stageProgress` 按**增量**算 |
| 9 | 长期目标只活 8 秒 | ✅ | `src/goals.js:393` `minLifeMs = 5 分钟` |
| 10 | 心情永远 irritated | ✅ | `src/mood.js:288` 改成"算紧迫度取最严重"，energy 优先 |
| 11 | 凌晨 4 点不提时间 | ✅ | `main.js:2037` 每 10 分钟调一次 `spontaneous.onLateNight()` |
| 12 | 天黑没反应（绑血量） | ❌ | `main.js:1109` 仍是 `tod>13000 && health<=14`，满血永不触发 |
| 13 | 记忆里混测试号 | ⚠️ 半 | 写入层已过滤：`src/memory/writer.js:176/425/673`；但**存量没清**：`memory.json` 的 people 6 条里 4 条是 `XJJHOME6` / `XJJINTG` / `XJJHOME87` / `XJJVER6`，另外 1 条 `标记起点` 是把地点当人写进去了 |
| 14 | 别人挨打不去帮 | ❌ | `src/spontaneous.js:76` 有实现，`main.js` **0 处调用**（`bc5d2f0` 的"#3社交"只加了实验脚本 `scripts/social-drive.js`） |
| 15 | `withThisThisBotTooMany` 未定义 | ✅ | `src/talk.js:293` 已改成 `withThisBot.length` |
| 16 | `idleThinkSeconds` 没人用 | ✅ | `main.js:1016` `idleThinkMs()`，`:1031` 真被调用（取 10%~50%，封顶 30 秒） |

---

## 2. `test-skills` 那 5 条失败的定性结论

**结论：不是产品回归，是测试夹具跟不上 112917d 的两个改动。** 5 条分两类：

### 类 A（4 条）：`[真 Coder 端到端]` 复用链路整条断

```
✗ 第二次复用了技能，没重新生成  → null
✗ 第二次一次模型都没调          → 1
✗ 复用被记进了成绩              → uses=1 ok=0
✗ 任务统计：2 次里 1 次复用      → {"tasks":3,"reused":1}
```

**机制（用 `pickFor` 打点复现）**：第二次**确实挑中了** `k_1`（`[PICK] -> k_1 score=18.17`），跑也跑完了，但被 `verifySkillEffect` 判成"世界没变"，于是 `out.ok=false` → 回落到模型生成 → `reused=null`、`uses=1 ok=0`。

**根因**：`verifySkillEffect` 用 `this.bot.inventory.items()` 取背包（`src/coder.js:186-192`），而测试里的假 bot 只有 `{username, health, food, time, entity, players}`，**没有 inventory** → `snapshotInv()` 恒为 `{}` → 真实搓出来的 4 木棍 + 1 石镐也算"新增 0"。

真 bot（mineflayer）有 inventory，所以**生产路径没问题**；是夹具缺字段。

### 类 B（1 条）：`[检索] 能搜到两个候选 → 1`

**根因**：同一次改动里 `useBonus` 从 `min(uses/20, 1)` 改成 `min(uses/100, 0.3)`（`src/skills.js:680` 附近）。
两条夹具各被 `markUse` 5 次 → 加分从 0.25 掉到 0.05，`k_mine` 总分 **2.25 → 2.05**，跌破 `search` 的 `score >= 2.2` 过滤线。

**证据**：旧分数 2.25 距阈值只有 0.05，本来就是卡着线过的；用 `search()` 直接跑，`k_mine` 现在被过滤掉，只剩 `k_craft:19.44`。

### 我改了什么（只动测试）

`scripts/test-skills.js` 两处，**没碰 `src/`**：

1. 给假 bot 补 `inventory: { items: () => Object.entries(inv).map(([name,count])=>({name,count})) }`
   （必须用闭包，测试中途会 rebind `inv`）
2. `k_mine` 的描述改成"用木镐挖石头，**攒料做石镐**"，让它在 `做一把石镐` 下得分 3.23（和 k_craft 19.44 的距离稳定，不再是 0.05 的边界）

**结果**：`通过 94，失败 0`。

---

## 3. 哪些数据可信、哪些过时

### 可信（直接用，附原始出处）

| 数据 | 值 | 出处 |
|---|---|---|
| 端到端成功率 | **67%（4/6，2 skip）**，678s | `data/test-results/e2e-2026-11-13T09-13-58-858Z.json`，codeRev `40b21ec` |
| 逐项 | 砍树 106s（原木 4→9）／放箱子 4s／存东西 3s（9 格）／找食物 119s（4 porkchop）／挖石头 260s 失败／做石镐 181s 失败 | 同上 `results[]` |
| 任务级复用 | 359/383 = **93.7%** | `skills.json.stats` |
| 技能条数 | **38** 条 | `skills.json.skills.length` |
| goals | 历史 30：完成 3 / 放弃 27（10%） | `goals.json.history` |
| home | goHome 5 次、成 4 | `home.json.stats` |
| 离线测试 | **536 条断言**（13 个脚本）；除 `test-home` 的联机断言会随机挂 0–3 条外，其余稳定全过 | 逐个实跑 |
| 05:34 那次"366 项全过" | 快照实测 **367 项全过**（`test-home` 53 / `test-skills` 85 / `test-goals` 61 / `test-memory-quality` 73 / persona 29 / perceive 24 / memory 20 / decay 16 / multibot 6） | `git archive 2a615d6` 到 /tmp 后实跑 |

### 过时／错（别再引用）

| 说法 | 实际 |
|---|---|
| "最热技能复用 19 次、0 成功" | 准确写法：`k_mwdx4vb0` **终身 uses=53**，当前代码版本 **0 成功 / 19 失败**，`variants=20`（换过 20 版）；最近几次失败原因是**超时**——`error: "这次干太久了，算了"`，`ms ≈ 420000`，**不是**假成功 |
| "技能复用率 89.8%，最热 53 次" | 89.8% 全库无出处；53 是 uses 口径 |
| "366 项测试" 当作现在的数 | 现在 536 项（团队边修边加断言） |
| "`npm test` = 366 项" | `npm test` 只跑 4 个文件 = **90 项** |
| "`npm run test:e2e`" | `package.json` 无此脚本，要 `node scripts/test-e2e.js` |
| "`mcplugin/` 在仓库里" | `git ls-files` 0 条；实际在 `/root/workspace/mcplugin`（`XJJBot.jar` 52,475 B） |
| "README 里 89.8% / 19 次 0 成功" | 已在 `653684c` 订正 8 处，但"19 次 0 成功"那条按 §0 口径仍不准确 |

### 不确定（复现会变）

| 数据 | 现象 |
|---|---|
| `test-home` 的联机断言 | 同一代码连跑 3 次：**64 通过 3 失败**（`还差 12.1 格` / `最终就在家边上 11.2 格` / `到家后路标清空`）、**67/0**、**67/0**。随机 + 真服务器寻路，非确定性 |
| 端到端"现在多少分" | 67% 那次在 `40b21ec`，之后有 `4dc6627`、`112917d`、`0040035`、`bc5d2f0` 等，**没有覆盖这些修复的 e2e** |

---

## 4. 提交信息 vs 实际代码（逐个用时点快照核对）

| 提交 | 声称 | 实际 | 差在哪 |
|---|---|---|---|
| `112917d` 18:26 | "UNHUMAN #2/#3/#4/#5/#8/#10/#11/#12/#13/#15/#16 多项修复" | 该提交时点只有 **#2 #3 #5 #10 #11 #15** 有实现；#8 有 coder 层（`verifySkillEffect`）；`#1/#6/#9` 属上一提交 `4dc6627` | **#4 没进这个提交**（`talk.js` `pendingIntention` 计数 0，是 `0040035` 才提交的）；**#12 未改**（`main.js` 仍 `tod > 13000 && health<=14`）；**#13 未改**（`writer.js` `TEST_ACCOUNT_RE` 计数 0）；**#16 未改**（`main.js` `idleThinkSeconds` 计数 0）。11 条里 4 条不成立 |
| `bc5d2f0` 19:46 | "#8三层假进度/#7/#3社交/cost代价/被注视/persona语料" | #8 三层 ✅（三个文件都改了）、#7 ✅（`maxMethods`/`methodSwitchWins`）、cost ✅（新增 `src/cost.js`）、被注视 ✅（`watched.js` 587 行）、persona ✅ | **"#3社交"只加了 `scripts/social-drive.js` 实验脚本**，`main.js` 里 `onFriendInDanger` 仍是 0 处调用 |
| `0040035` 18:54 | "修过滤器三个漏网：单字前缀/坐标日志/报数量" | ✅ 三条都在 `src/persona.js:65`、`:67-68`、`:70` | 无。**注**：这条提交还顺带把别人的三份文档（PROJECT_STATE/ROADMAP/BACKLOG）一起提交了，信息里没提 |
| `4dc6627` 17:52 | "UNHUMAN #1/#6/#9" | ✅ `talk.js` 标点闸、`actions.js` 起步宽限、`goals.js` `minLifeMs` | 无 |
| `7d6b6f6` 17:04 | "项目改名 Minecraft AIfriends（MA）" | 只改了 README 标题/URL/文案 + main/goals/e2e | `package.json` `name` 仍是 `minecraft-aifriend`，目录名未变；改名只在展示层 |
| `2a615d6` 05:34 | "366 项测试全过" | 快照实测 **367 项、0 失败**（差 1 项，可能是用例微调） | 基本属实 |
| `3dae160` 19:47 | "被注视维度改名 audience.js（保留 watched.js 兼容壳）" | ✅ `audience.js` 25,216 B；`watched.js` 305 B 纯转发 | 无 |

---

## 5. 复现命令

```bash
cd /root/workspace/minecraft-AIfriend

# 全部离线断言（536 条）
for f in test-memory test-decay test-persona test-perceive test-home test-goals \
         test-skills test-talk-dedup test-memory-quality test-unhuman-fixes \
         test-unhuman-misc test-fake-success test-multibot; do
  node scripts/$f.js 2>&1 | tail -1
done

# 单项
node scripts/test-skills.js      # 94 通过 0 失败（本次修好）
node scripts/test-home.js        # 67 或 64/3，随机 + 真服务器

# 时点快照（不改仓库）
git archive 2a615d6 | tar -x -C /tmp/wt && ln -s $PWD/node_modules /tmp/wt/node_modules
cp config.json /tmp/wt/ && cd /tmp/wt && node scripts/test-home.js
```

工作区状态（21:55）：`src/audience.js`、`src/goals.js`、`src/talk.js`、`scripts/scan-fake-success.js`、`scripts/test-fake-success.js` 有未提交改动；新增若干 `data/probe-*`、`scripts/probe-*.js`。**本文件的代码坐标以工作区为准，不是纯 HEAD。**

---

## 6. 越失败越窄（2026-11-13 22:20 补，strategist）

> **这一节是对前文的修正，不是补充。**
> §1 的 #8「假成功」和 §3 里 `k_mwdx4vb0` 那行说的「最近几次失败原因是超时」，都是**症状**。
> 这一节说的是**机制**：为什么筛完之后他只能反复做同一件事。
> 原文没删，保留认识的演化过程。

### 6.1 机制：三行代码

```js
// src/skills.js:300   拉普拉斯平滑
successRate = (ok + 1) / (ok + fail + 2)

// src/skills.js:765   入选门槛
minRate = 0.45

// src/skills.js:787   只拦"试过的"
.filter(x => !x.tested || x.rate >= minRate)
```

`tested = (ok + fail) > 0`。所以：

| 战绩 | successRate | 是否永久排除 |
|---|---|---|
| 0 成 1 败 | `1/3 = 0.33` | **永久排除** |
| 0 成 2 败 | `1/4 = 0.25` | **永久排除** |
| 1 成 1 败 | `2/4 = 0.50` | 保留（悬崖边） |
| 12 成 0 败 | `13/14 = 0.93` | — |

**只要失败一次，这条技能就再也不会被 `pickFor` 选中。** 一道 420 秒超时 = 一次失败 = 永久封杀。

### 6.2 实测分布（38 条，`data/runtime/skills.json`，逐条算）

| 桶 | 条数 | 说明 |
|---|---|---|
| `rate ≥ 0.85`（真正稳的） | **2** | `k_mwdr2g2a` 93%（12/0）、`k_mwduk870` 88%（6/0） |
| `0.45 ≤ rate < 0.85`（悬崖边） | **1** | `k_mwdu8n8o` 67%（1/0） |
| `rate < 0.45`（**已被永久排除**） | **8** | 见下表 |
| `runs = 0`（从没跑过，永远有资格） | **27** | 占 71% |
| 合计 | 38 | |

被排除的 8 条：

| 技能 | rate | ok/fail | 一句话 |
|---|---|---|---|
| `k_mwdx4vb0` | 5% | 0/19 | 就是它，420s 超时的那个 |
| `k_mwe60wh8` | 14% | 0/5 | 「先弄把铁镐」 |
| `k_mwdwow31` | 17% | 0/4 | 庇护所角落往下挖 |
| `k_mwdwp124` | 25% | 0/2 | 「弄点吃的」 |
| `k_mwds22uu` | 33% | **0/1** | **只失败过一次就死了** |
| `k_mwdzxvul` | 33% | **0/1** | **只失败过一次就死了** |
| `k_mwe4x7yp` | 33% | **0/1** | **只失败过一次就死了** |
| `k_mwe5gioi` | 40% | 1/2 | 烧铁锭 |

**3 条技能只跑过一次、失败一次，就再也没资格被用。**

### 6.3 为什么这是"机制"而不是"症状"

三条问题的因果顺序：

```
技能内部没有失败出口（只有成功出口）
   ↓  → 420s 被外部铡刀砍死（§3 那行）
   ↓  → 记 fail+1
   ↓  → successRate 跌破 0.45
   ↓  → pickFor 永久排除这条
   ↓  → 可选路径单调递减
   ↓  → 最后只剩一两条能用 → 反复做同一件事（UNHUMAN-SCAN #7）
```

- 「420s 超时」是**上游行为的产物**
- 「反复做同一件事」是**下游表现**
- 「越失败越窄」是**中间那个放大器**

这解释了为什么修 420s、修假成功，都不会自动解决「同一件事连做 5 遍」——**因为它们不在这条链的同一个位置。**
假成功清零（`probe-check` 已做）把"成功率虚高"这条正向偏差去掉了，但**负向偏差（一次失败即死）原封不动**。

**结论：层 2 不只是"记账要真"，还得"记账要不杀"。**

### 6.4 和 `goals` 的口径是矛盾的

| 模块 | 容错 | 代码 |
|---|---|---|
| `goals` | 允许试 **2** 次才换法子，**12** 次才放弃 | `goals.js` `methodSwitchWins: 2` / `maxIdleWins: 12` |
| `skills` | **1** 次失败就永久排除 | `skills.js:787` |

同一个系统里，上层说"失败两次再换办法"，下层说"失败一次就永远别用了"。
**上层攒下的容错，被下层一次就抹掉了。**

### 6.5 修法（改动量：1 行 + 1 个对齐）

```js
// src/skills.js:787
// 旧：.filter(x => !x.tested || x.rate >= minRate)
// 新：试够 1 次还不够，得试够 2 次才判死
.filter(x => !x.tested || x.runs < 2 || x.rate >= minRate)
```

**风险**：`k_mwdx4vb0`（0/19）会重新获得资格。但那正是我们要的——它会带着 19 次失败的账去跑，如果这次又失败，第 20 次失败会让 `lifeRate` 那一层挡住它（`skills.js:788` 的三次拦：本版成功率 + 累计成功率 + 换版次数）。**让它"有资格但排在后面"，比"直接从库里消失"更接近真人的行为**（真人不会因为一次失败就忘掉那个方法，只是会更倾向于别的）。

**配套**：和 `goals` 的口径对齐——`fail>=2` 才换法子，`fail>=3` 才换目标。这条已交给 `goals-fixer` 一并处理。

### 6.6 复现

```bash
cd /root/workspace/minecraft-AIfriend
python3 - <<'PY'
import json
sk=json.load(open('data/runtime/skills.json'))['skills']
for s in sk:
    ok=s.get('ok',0) or 0; fail=s.get('fail',0) or 0
    rate=(ok+1)/(ok+fail+2)
    if ok+fail==0: continue
    if rate<0.45: print(f"{s['name']}  rate={rate*100:.0f}%  {ok}/{fail}  {(s.get('desc') or '')[:20]}")
PY
```

### 6.7 我报错过的数字（留档，别删）

- 第一次算这组分布，我说「≤40% 有 6 条、runs=0 有 26 条」。**实际是 8 条和 27 条。**
- 错因：手数表格没跑脚本。**和上一轮"看到 88% 与 ok/fail 矛盾却没追"是同一类错误——用眼睛代替计算。**
- 凡在本文件出现的分布数字，一律以 §6.6 的脚本输出为准。
