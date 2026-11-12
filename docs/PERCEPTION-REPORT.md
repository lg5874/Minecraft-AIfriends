# 感知与事件系统 交付报告

> perception-owner · 2026-11-13
> 范围：`src/events.js`（重写）、`src/perceive.js`（重写地形段）、`main.js`（只加 11 行监听）、`src/reflex.js`（Lead 追加的 busy 门禁）

---

## 补了哪些事件源

**28 种事件类型**（原 23 种定义 / 实际只接了 8 种 → 现在 28 种定义 / **18 种有真实事件源**）。

每种都在 `src/events.js` 的 `TYPES[type].src` 里写死了触发条件，`test-events` 会断言"每个类型都有 label 和 src"。

### 这次新接上的（原任务点名 6 个 + 额外 6 个）

| 事件 | 触发条件 | main.js 监听 | 节流策略 |
|---|---|---|---|
| `block_change` | `blockUpdate`，8 格内、非空气、新旧不同 | `bot.on('blockUpdate')` | 按 `from>to` 分类，8 秒合并 |
| `item_pickup` | `playerCollect`，`collector.id === bot.entity.id` | `bot.on('playerCollect')` | 2 秒合并 |
| `time_change` | 昼夜阶段切换（白天/黄昏/夜晚/黎明） | `bot.on('time')` | key 带 phase，5 秒 |
| `health_low` | 血 ≤6 且上一次 >6（跨阈值才报） | `bot.on('health')` | 15 秒 |
| `hunger_low` | 饱食度 ≤6 且上一次 >6 | `bot.on('health')` | 30 秒 |
| `weather_change` | 下雨翻转 / 雷暴等级 0↔非0 | `bot.on('rain')` / `'weatherUpdate'` | key 带方向，8 秒 |
| `block_broken` | `blockBreakProgressObserved`，且 `entity` 是自己 | `bot.on('blockBreakProgressObserved')` | 同坐标 60 秒只记一次 |
| `exp_gain` | 经验等级上升 | `bot.on('experience')` | 10 秒 |
| `player_near` / `player_far` | 玩家 >8 格进 ≤8 格 / ≤8 格退 >12 格 | `bot.on('entityMoved')` | 2 秒节流 + 8/12 格滞回 |
| `kick` | `kicked`（急件） | `bot.on('kicked')` | — |
| `respawn` | `respawn`，带复活坐标 | `bot.on('respawn')` | 5 秒 |

`inventory_full` / `goal_fail` 原本由 `selfstate.js` 推，保持不变。

### 三个关键修正

**1. `diggingCompleted` 用不了。** review 说"接 `diggingCompleted` 就行"，实测不行：

```js
// mineflayer/lib/plugins/digging.js:194
if (newBlock?.type !== 0) return      // 只有变成空气才算挖完
bot.emit('diggingCompleted', newBlock) // 传的是空气方块
```

传出来的 `newBlock` 必然叫 `air`，`pushDig` 里"空气不推"的分支会全部吃掉。改用 `blockBreakProgressObserved`（参数是真实被挖的方块），再用"同坐标 60 秒只记一次"把 0–9 十个破坏阶段合成一条。已覆盖测试。

**2. 洪水事件会冲爆队列。** `blockUpdate` 一次 TNT 爆炸就是几百上千条，60 条容量会瞬间挤掉所有别的事。加了 `cooldown + dedupeKey` 合并：同类事件只留一条，次数累加到 `count`，`describe()` 输出"（共 2000 次）"。压测：2000 次 `blockUpdate` → 队列 1 条，`dropped` 为 0。

**3. `time`/`weather` 会被自己的节流吃掉。** 白天→黄昏→夜晚如果共用一个 key，5 秒窗口内第二件事就丢了。key 改成带状态（`time:night`、`weather:rain:true`）。

### main.js 的改动（只有 11 行新增，0 行修改）

```js
bot.on('health', () => { if (this.events) this.events.pushHealth(bot) })
bot.on('time', () => { if (this.events) this.events.pushTime(bot) })
bot.on('rain', () => { if (this.events) this.events.pushWeather(bot) })
bot.on('weatherUpdate', () => { if (this.events) this.events.pushWeather(bot) })
bot.on('blockUpdate', (oldBlock, newBlock) => { if (this.events) this.events.pushBlockChange(oldBlock, newBlock, bot) })
bot.on('blockBreakProgressObserved', (block, stage, entity) => { if (this.events) this.events.pushDig(block, bot, entity) })
bot.on('playerCollect', (collector, collected) => { if (this.events) this.events.pushCollect(collector, collected, bot) })
bot.on('experience', () => { if (this.events) this.events.pushExp(bot) })
bot.on('entityMoved', () => { if (this.events) this.events.pushProximity(bot) })
bot.on('kicked', (reason) => { if (this.events) this.events.pushKick(reason) })
bot.on('respawn', () => { if (this.events) this.events.pushRespawn(bot) })
```

一行监听 = 一行推送。判断、节流、去重、格式化全在 `src/events.js`，主循环不沾业务逻辑。

**容错**：每个 `pushXxx` 内部 `try/catch`，`safe()` 包所有字段读取。用空 bot / `null` / 完全没 `entity` 的对象各打一遍（65 项），零抛出。

---

## 地形图评估

### 测试方法

用**真实的** `Actions.lookAround3D` / `lookProfile` / `lookTop`（不是重写），喂 6 种合成地形：

| 地形 | 构造 |
|---|---|
| 平地 | y=64 草地，上方全空气 |
| 洞穴 | y=41 地下 3×3 走廊，四周石头，头顶 6 格是石头，再上到 y=64 地表 |
| 竖井 | y=30 一格宽竖井直通地表（典型矿洞直井） |
| 水边 | z≥0 是水（水面 y=63），z<0 是沙岸 |
| 树上 | y=70 站在橡树冠里，树干在下方 |
| 矿道 | y=20 一格宽两格高长矿道 + 铁矿脉 |

### 长度：**与地形无关，恒定 792 字符**

这是最重要的发现 —— 图是固定网格，不管内容多少都一样长：

| 地形 | 字符数 | 估 token | 行数 | 最宽行 |
|---|---|---|---|---|
| 平地 | 792 | 477 | 47 | 45 |
| 洞穴 | 792 | 468 | 47 | 45 |
| 竖井 | 792 | 477 | 47 | 45 |
| 水边 | 792 | 455 | 47 | 45 |
| 树上 | 792 | 428 | 47 | 45 |
| 矿道 | 792 | 477 | 47 | 45 |

**现状 792 字符，实测不是 850**（可能之前量的是含四个方向那行的版本）。
`contextForTask` 合计约 1053 字符 —— **地形图占 75%**。

### 冗余度：大部分格子是废的

去掉坐标前缀后，每张图 13 行里只有 1–3 行内容不同：

| 地形 | 东西剖面 | 南北剖面 | 俯视图 |
|---|---|---|---|
| 平地 | **1/13 唯一（92% 重复）** | 1/13（92%） | **1/13（92%）** |
| 洞穴 | 3/13（77%） | 2/13（85%） | 3/13（77%） |
| 竖井 | 2/13（85%） | 2/13（85%） | 2/13（85%） |
| 水边 | **1/13（92%）** | 2/13（85%） | **1/13（92%）** |
| 树上 | 3/13（77%） | 3/13（77%） | 3/13（77%） |
| 矿道 | **1/13（92%）** | 2/13（85%） | 2/13（85%） |

### 可读性判断

判据：能不能从图里读出 ①脚下方块 ②脚下地面 ③头顶遮挡 ④前方通不通。

| 地形 | 字符数 | 能看懂吗 | 建议 |
|---|---|---|---|
| 平地 | 792 | **勉强**。13 行剖面全是 `······███`，一眼能看出"四周开阔、脚下实心"，但代价 792 字符换 1 行信息 | range 降到 5，省 127 字符 |
| 洞穴 | 792 | **能**。走廊轮廓、两侧煤矿 `O` 都清楚，`←你在这` 标在中间行，方向不会搞错 | range 5 足够，洞穴 6 格内没别的东西 |
| 竖井 | 792 | **能但危险**。只有 `x+0` 一行是空的，其余 12 行全实心 —— 图对，但它会误以为"四周都是墙，得挖" | 保持 range 6。竖井是最需要看清"上下通道"的地形 |
| 水边 | 792 | **能**。`~` 和 `█` 分开，能看出哪边是水 | range 5 |
| 树上 | 792 | **不能**。`t`（树叶）和 `T`（树干）占满，看不出"我在树冠哪一层"，也看不出下面是不是地面 | 需要改图例区分树叶/树干层级，或干脆在树上时不出图、出文字 |
| 矿道 | 792 | **能**。`█████··███` 一眼看出是两格高的通道 | **保持 range 6**。矿道里 6 格能提前发现断头路，缩到 4 会撞墙 |

### 关键发现：俯视图 `layer=0` 在露天地形下是纯空白

`lookTop(range, 0)` 的 `layer=0` 取的是**玩家身体所在那一层**，露天时全是空气：

| 地形 | 俯视 layer=0 | 俯视 layer=-1（真正的地面） |
|---|---|---|
| 平地 | **·×169（全空，264 字符 / 约 150 token 全废）** | █×169 |
| 水边 | **·×169（全废）** | █×169 |
| 树上 | ·×144 t×24 T×1（只有树冠） | 同左 |
| 矿道 | █×130 ·×39 | █×169 |

**后果**：平地和露天地形下，俯视图那 264 字符（约 150 token，占全图 33%）什么都不说。
**建议**：`lookTop(range, -1)`。但 `lookAround3D` 在 `actions.js`，不归我改 —— 这条报给 Lead。

### 参数扫描

| 参数 | 平均字符 | 估 token | 说明 |
|---|---|---|---|
| **现状 range6, up6, down3** | 792 | 464 | 地形图占提示词 75% |
| 推荐 A range5, up4, down2 | 599 | 333 | **省 24%**，洞穴/矿道/平地都还看得懂 |
| 推荐 B range4, up4, down2 | 492 | 269 | **省 38%**，矿道会看不见 4 格外的断头路 |
| range4, up3, down1 | 456 | 243 | 头顶只 3 格，洞穴判断会瞎 |
| range8, up8, down4 | 1172 | 721 | 明显过长 |

### range 缩小的代价（实测）

走廊里在 x=WALL 处放墙，看不同 range 能不能在剖面里发现：

| 墙在 | range6 | range5 | range4 | range3 |
|---|---|---|---|---|
| x=2 | 看见 | 看见 | 看见 | 看见 |
| x=4 | 看见 | 看见 | 看见 | **看不见** |
| x=5 | 看见 | 看见 | **看不见** | 看不见 |
| x=6 | 看见 | **看不见** | 看不见 | 看不见 |

**结论：`range=4` 是下限。** 再小就连"前面 4 格有墙"都看不见，会直直撞上去。
`range=5` 在矿道里能提前看到 5 格，比 4 稳，是**通用推荐值**。

### 最终推荐

```
地面 / 露天        -> lookAround3D(5)
洞里 / 矿道        -> lookAround3D(6)   （range 5 也够，但 6 更保险）
树上 / 垂直空间    -> 不出图，改出文字（树叶图和树干图看不出层级）
```

`up/down` 建议 `up=5, down=2`：头顶 5 格够判断"有没有天花板"，脚下 2 格够判断"会不会踩空"，比现在 `up=6, down=3` 窄 2 列。

**保守做法（不改 actions.js 也能做）**：保持 `lookAround3D(6)` 不动，只把 `lookAround3D` 里的 `lookTop(range, 0)` 改成 `lookTop(range, -1)` —— 单点改动，省下的 264 字符是最没用的那部分。这条转 Lead。

---

## isUnderground 断线误判（报告，不修）

> 按 Lead 最新指示，这条**由 Lead 修 `actions.js`**。这里只给复现数据和修法。

### 位置

`src/actions.js:1345`（行号随 Lead 后续改动可能漂移，搜 `isUnderground`）

```js
isUnderground () {
  const near = bot.blockAt(p.offset(0, 2, 0))
  const near2 = bot.blockAt(p.offset(0, 3, 0))
  if (near && near.boundingBox === 'block') return true     // ← 断线时 near 是 null，跳过
  if (near2 && near2.boundingBox === 'block') return true

  let firstBlockAt = -1
  for (let dy = 4; dy <= 60; dy++) {
    const b = bot.blockAt(p.offset(0, dy, 0))
    if (!b) break                                          // ← 断线时第一次就 break
    if (b.boundingBox === 'block' && ...) { firstBlockAt = dy; break }
  }

  if (firstBlockAt < 0) return false                       // ← 返回"露天"
  if (firstBlockAt <= 15) return true
  return false
}
```

### 根因

`blockAt` 的 `null` 有两种完全不同的含义，这版代码混为一谈：

- **区块没加载 / 断线 / 人死了还没复活** → `null`（看不见）
- **那里确实是空气** → `{ name:'air' }`（看见了，是空的）

断线时三次 `blockAt` 全 `null` → `firstBlockAt` 保持 `-1` → **`return false`（露天）**。

### 实测复现（合成 bot，`blockAt: () => null`）

| 场景 | 真值 | `isUnderground()` 返回 | 结论 |
|---|---|---|---|
| A. 断线，全 `null` | 在 y=41 洞穴里 = true | **false** | ✗ 误判 |
| B. 半加载，头顶 10 格后 `null` | 洞穴 = true | true | 侥幸对（近处有石头） |
| C. 正常洞穴（全可见） | true | true | ✓ |
| D. 正常平地 | false | false | ✓ |
| G. 矿道 y=20 | true | true | ✓（头顶 2 格就有石头） |
| I. 断线 + `entity` 还在 | 不知道 | **false** | ✗ 误判 |
| J. 没 `entity`（彻底断线） | — | **抛 TypeError** | ✗ `Cannot read properties of undefined (reading 'position')` |

场景 B 特别有迷惑性：**它侥幸返回了正确值，但推理过程是错的** —— 因为头顶 2-3 格正好有石头。换个地形（比如 y=40 的一格高缝）半加载就会误判成露天。

### 后果链

```
断线 -> isUnderground() 返回 false
     -> getToSurface() 第一行 `if (!this.isUnderground()) return true` 直接返回 true
     -> 调用方（main.js:787 / actions.js:829 / 914）认为"我已经在地面上了"
     -> 但他其实还在洞里，或者根本不知道自己在哪
```

`actions.js:1814` 的 `return !this.isUnderground()` 也一样 —— 断线时会返回 `true`（"出来了！"），日志里会打一行假的成功消息。

### 我在 perceive.js 里做了正确版（可直接搬）

`src/perceive.js` 已实现 `sky()` + `isUnderground()`，**三态**而非布尔：

```js
sky() -> { state: 'open'|'covered'|'unknown', firstBlockAt, checked, blind }
isUnderground() -> true | false | null      // null = 看不清
```

三处关键差别：

1. **连续 3 格 `null` → `unknown`**，不下"露天"结论
2. **`p.y < 60` 兜底**：地表一般 63–72，这个高度头顶还有遮挡就一定是洞里
3. **树叶/原木不算遮挡**：站在树冠上不该判成"在洞里"

实测（同一批合成世界）：

| 地形 | `perceive.isUnderground()` | 期望 |
|---|---|---|
| 平地 y=65 | false | ✓ |
| 洞穴 y=41 | true | ✓ |
| 矿道 y=20 | true | ✓ |
| 竖井 y=30 | true | ✓ |
| 树冠顶 y=75 | false | ✓ |
| 断线（全 null） | **null**（不知道） | ✓ |
| 没有 entity | **null** | ✓ 不抛 |

### 建议 Lead 的最小平移

如果不整体替换，至少在 `actions.js` 里加两行：

```js
// 在 isUnderground 开头
if (!bot.entity) return false          // 彻底断线，由调用方判断
// 在 for 循环里把 `if (!b) break` 改成计数
let blind = 0
for (let dy = 4; dy <= 60; dy++) {
  const b = bot.blockAt(p.offset(0, dy, 0))
  if (!b) { if (++blind >= 3) return false; continue }   // 看不清就当"不在洞里"
  ...
}
```

但更好的做法是**换成三态**：`getToSurface` 的调用方能在 `null` 时选择"先等区块加载"而不是瞎爬。`actions.js:1814` 的 `return !this.isUnderground()` 也要跟着改成显式判断。

---

## Lead 追加的：`reflex.tick()` 不检查 busy（已修）

`main.js:307` 传了 `busy`，`src/reflex.js` 里它出现 **0 次**。确认属实。

### 修法

`tick()` 开头加门禁。**任务执行中只保留两条救命行为**，其余全部让路：

```js
if (this.isBusy()) {
  if (bot.health <= 6) { const near = this.nearestHostile(10); if (near) this.flee(near) }
  if (this.ctx.aggressive !== false && bot.health > 6) {
    const near = this.nearestHostile(2.5)   // 半径从 3.2 收到 2.5：只有真贴脸才打
    if (near) this.retaliate(near)
  }
  this.syncStuckBaseline()                  // 关键：刷新基线，不然任务结束后第一次判断失真
  return
}
```

掉虚空那条在门禁**之前**，永远跑。

### 一个容易漏的点：`syncStuckBaseline()`

busy 期间如果不更新 `lastPos`，任务一结束第一次 `checkStuck` 会拿很久以前的坐标比，算出一个巨大的位移 —— 判定完全失真。所以 busy 分支里仍要刷基线，只是不判卡住。

### 验证

| 检查 | 结果 |
|---|---|
| busy 时 `digOut` 不跑（`dig` 调用数） | 0 ✓ |
| busy 时不吃东西（`equip` 调用数） | 0 ✓ |
| busy 时不改寻路目标（`setGoal` 调用数） | 0 ✓ |
| busy 时不模拟按键（`setControlState` 调用数） | 0 ✓ |
| busy 解除后恢复正常（饿了会吃） | ✓ |
| busy 时血 4 + 有怪 → 仍然逃跑 | ✓ |
| busy 时贴脸怪 → 仍然还手 | ✓ |
| busy 时基线跟着位置更新 | ✓ |
| 不传 `busy` 时行为不变（向后兼容） | ✓ |
| `busy` 回调抛错被吞，`tick` 正常返回 | ✓ |

13 项全过。

---

## 测试与回归

| 测试 | 结果 |
|---|---|
| `scripts/check-syntax.js`（46 文件） | 0 有问题 |
| `scripts/test-perceive.js` | 24 通过 0 失败 |
| `scripts/test-memory.js` | 20 通过 0 失败 |
| `scripts/test-persona.js` | 29 通过 0 失败 |
| 我自己写的 events 单测 | 65 通过 0 失败 |
| 我自己写的 perceive 单测 | 25 通过 0 失败 |
| 我自己写的接线测试（模拟 mineflayer EventEmitter） | 27 通过 0 失败 |
| reflex busy 门禁测试 | 13 通过 0 失败 |

> `scripts/test-decay.js` 有一条既有失败（`intense().protected` 为 undefined），在 `src/memory/` 里，不属于我的范围，我改动前就有。

自测脚本放在 `/tmp/percep-eval/`，没进 repo（`scripts/` 归 test-owner）。

---

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/events.js` | 重写。189 → 690 行。28 种类型全带触发条件注释；11 个语义化 push 入口；合并节流；全字段容错 |
| `src/perceive.js` | 重写地形段。加 `blockAt()`/`canSee()`/`sky()`/`isUnderground()`/`heightAtDetail()`；`describeTerrain`/`describeNearby`/`describePeople`/`describeSelf`/`snapshot` 全部断线容错；`snapshot` 加一行【在不在洞里】 |
| `main.js` | **只加 11 行监听，0 行修改** |
| `src/reflex.js` | Lead 追加：`isBusy()` + `syncStuckBaseline()` + `tick()` 门禁 |

**没碰**：`src/actions.js`、`src/selfstate.js`、`src/persona.js`、`src/talk.js`、`src/memory/**`、`scripts/**`。
