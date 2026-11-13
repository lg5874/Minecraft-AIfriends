# 动作线仲裁：`ActionLock` 草案

> 起草：strategist，2026-11-13 22:05，只写文档，没碰 `src/`。
> 给 `scheduler-owner` 的实现依据。**本文件是规格，不是实现。**

---

## 0. 为什么要有这个

`main.js` 现在有 **4 条会动的线**在抢同一套 `busy` / `actions.cancel` / pathfinder：

| 线 | 谁在动 | 现状 |
|---|---|---|
| task | 主循环起任务 | 收尾时**无条件** `busy = false`（`main.js:1305`） |
| home | `walkHomeNow` | `_homing` 是唯一的例外，专门为它加的 `if (!this._homing)` |
| survive | `doSurvive` | 自己设 `actions.cancel = true`（`2092`） |
| session | 正在做 | 会成为第 4 条 |

代码里已经写下了这个 bug 的疤（`main.js:1300` 注释）：

> 期间一个早就起跑的任务走到这里，就把回家的忙状态误清掉，主循环立刻起新任务，两边抢 pathfinder —— **实测「107 → 105 → 107」原地打转**

当时的修法是**加一个例外**。再加两条线就要加两个例外。**例外会指数增长，而那个 bug 会精确复现。**

根因不是写法不小心，是**类型表达能力不足**：`busy: boolean` 表不了"两条线同时占着"。

---

## 1. 数据结构

`Map<reason, { count, since, why }>`。**不是 Set，也不是裸计数。**

- 用 **Set** 不够：同一 reason 重入（主循环 tick 重复进入）会变成"第二次 release 把第一次的锁清掉"——换个写法的同一个 bug。
- 用 **裸计数** 不够：出错时看不出**是谁占着、占了多久**，没法查。
- Map + count：重入安全，且 `holders()` 能打出"follow 已持 8 分钟"。

`reason` 是字符串常量，不是自由文本：

```js
const REASON = {
  TASK:    'task',     // 主循环正在跑一个任务
  HOME:    'home',     // 走回家
  SURVIVE: 'survive',  // 找吃的 / 逃命
  FOLLOW:  'follow',   // 跟玩家走（第 2 层）
  SESSION: 'session',  // 收工 / 上线结算
  LEGACY:  '__legacy__' // 兼容层专用，迁移完成后删除
}
```

## 2. 语义（逐条回答）

| 情况 | 行为 | 为什么 |
|---|---|---|
| 同一 reason 重复 `acquire` | **允许**，count+1 | tick 会重复进入，报错会把正常运行变成崩溃 |
| `release` 一个没持有的 reason | **返回 false + 打一行日志，不抛错** | release 几乎都写在 `finally` 里，抛错会**吃掉真正的异常** |
| `release` 到 count 归零 | 删除 key | — |
| 查询"现在能不能起新任务" | `lock.canStart('task')` | 见下 |
| 查询"谁占着" | `lock.holders()` → `[{reason, count, since, why, secs}]` | 卡死时靠这个定位 |
| 查询某条线 | `lock.isHolding('home')` | 替代 `this._homing` |

### 抢占用 rank，不用例外

```js
const RANK = { survive: 100, session: 80, follow: 60, home: 50, task: 10 }
```

- `canPreempt(by)`：`RANK[by] > 当前所有持有者的最高 rank`
- **新加一条动作线只需要注册一个 rank，不需要改任何别人的代码。** 这就是"例外会指数增长"的解药。

具体到第 2 层：`follow(60) > task(10)` → 能打断挖矿；`follow(60) < survive(100)` → **不能**打断逃命。这条规则写对了，用户喊你时你正在被骷髅追，他会先跑，回头再理你——这才像人。

## 3. 接口

```js
lock.acquire(reason, why = '')      // -> true
lock.release(reason)                // -> bool，永不抛错
lock.forceRelease(reason, why)      // 超时夺锁，必须打日志
lock.isHolding(reason)              // -> bool
lock.busy                           // getter: 有没有人持有
lock.canStart(reason = 'task')      // -> bool
lock.canPreempt(reason)             // -> bool
lock.holders()                      // -> 数组，给日志/日报用
```

## 4. 和现有字段的关系

| 旧字段 | 处理 | 时间 |
|---|---|---|
| `this.busy` | 改成 **getter/setter**，setter 走兼容层（见 §6） | 第一步 |
| `this._homing` | 改成 `isHolding('home')` 的 getter/setter | 第一步 |
| `this._busySince` | 删掉，用 `lock.since('task')` | 第二步 |
| `this.actions.cancel` | **暂时保留布尔**，但只许在 `interruptCurrent()` 里写 | 第二步再改 Set |

**`actions.cancel` 为什么这次不改**：它在 `src/actions.js`（7930 行）里被读了 20+ 处，改成 Set 是另一个 owner 的活。这一轮只做到"**main.js 里再没有第二个人写 `actions.cancel`**"，就够挡住那个 bug 了。

---

## 5. 最容易写错的地方：`cancel` 和 `release` 的顺序

**它们不是一件事，但必须绑在一起。**

- `actions.cancel = true` 是**中断信号**（让正在 await 的动作提前退出）
- `lock.release(reason)` 是**所有权归还**
- `acquire(to)` 是**新主子上位**

三种写错法，对应三种后果：

| 错误顺序 | 后果 |
|---|---|
| `release(from)` → 再 `acquire(to)` | **中间有窗口**，主循环 tick 看到 `busy=false` 就起了新任务 → 第 4 条线 → 107 那个 bug |
| `release(from)` 但没有 `cancel` | 旧动作还在跑，新动作已经开始 → 两条线抢 pathfinder |
| `cancel` 但没人 `release` | **永久卡死**（最严重，只能等 watchdog） |

**唯一正确顺序（写进 `interruptCurrent`，外面不许手写）：**

```
1. acquire(to)            ← 先拿新的，保证任何时刻至少一方持有
2. actions.cancel = true  ← 打断在跑的动作
3. 等 from 自己 release   ← 它的 finally 会做，最多等 timeoutMs
4. 超时 → forceRelease(from) + 打日志
5. 只有 lock.busy === false 才允许 actions.cancel = false  ← 否则会清掉别人的中断信号
```

```js
// main.js
async interruptCurrent ({ from, to, why, timeoutMs = 8000, step = 50 }) {
  this.lock.acquire(to, why)                       // 1
  if (this.actions) this.actions.cancel = true      // 2
  if (from) {                                       // 3
    const t0 = Date.now()
    while (this.lock.isHolding(from) && Date.now() - t0 < timeoutMs) await sleep(step)
    if (this.lock.isHolding(from)) {                // 4
      this.log(`[lock] ${from} 超时未释放 ${((Date.now() - t0) / 1000).toFixed(1)}s，强制夺走`)
      this.lock.forceRelease(from, 'timeout')
    }
  }
  if (this.actions && !this.lock.busy) this.actions.cancel = false   // 5
  return true
}
```

**调用方只负责 `finally { lock.release(to) }`，永远不碰 `actions.cancel`。**

---

## 6. 迁移：两步，第一步就会顺手治掉 107

### Step 1 — 兼容层（不改任何旧调用点）

```js
Object.defineProperty(this, 'busy', {
  configurable: true,
  get: () => this.lock.busy,
  set: (v) => {
    const who = ((new Error().stack || '').split('\n')[2] || '').trim()
    this.log(`[lock] legacy busy=${v} @ ${who}`)          // ← 这行就是待办清单
    if (v) this.lock.acquire('__legacy__', 'legacy busy=true')
    else this.lock.forceRelease('__legacy__', 'legacy busy=false')  // ← 只清自己
  }
})
```

关键：**`legacy busy = false` 只清 `__legacy__`，不清别人。**

所以 Step 1 完成的那一刻，`main.js:1305` 那句无条件 `busy = false` **就已经清不掉回家的锁了** ——
**107→105→107 在第一步就没了，不用等到重构完。**

配套改 `_homing`：

```js
get _homing () { return this.lock.isHolding('home') }
set _homing (v) { v ? this.lock.acquire('home', 'walkHomeNow') : this.lock.forceRelease('home', 'walkHomeNow 结束') }
```

`if (!this._homing)` 那几处一行不用改，行为天然正确。

### Step 2 — 按日志清单逐个换，换完删兼容层

1. 跑一轮（30 分钟）
2. `grep -c "legacy busy" bot.log` → 这就是**还剩几处没迁移**，而且日志里有行号
3. 逐个把 `this.busy = true/false` 换成 `lock.acquire(REASON.X)` / `lock.release(REASON.X)`
4. 每换完一处，重跑，数字必须变小
5. 数字归零 → 删兼容层 setter（保留 getter）

**验收判据（客观，不靠人看）：**
- `grep -c "legacy busy" bot.log` == **0**
- `grep -c "release 没有持有的锁" bot.log` == **0**（说明没有漏 release / 重复 release）
- `grep "\[lock\] .* 超时未释放" bot.log` == **0**
- 连跑 2 小时，`lock.holders()` 在空闲时为空

**这套验收的好处：迁移进度是可数的，不是"我觉得改完了"。**

---

## 7. 给 `scheduler-owner` 的边界

| 可以做 | 不许做 |
|---|---|
| 新建 `src/actionlock.js` | 改 `src/session.js` |
| 改 `main.js` 里 `busy`/`_busySince`/`taskDesc`/`_homing`/`actions.cancel` 相关的行 | 改 `goOnline`/`goOffline`/会话段落 |
| 加 `interruptCurrent()` | 写 follow 的行为逻辑（那是 watcher-fixer 的） |
| 加兼容层和迁移日志 | 改 `src/actions.js` |

**交付顺序**：`actionlock.js` 先单独提交（+ 单测），再改 `main.js`。
**session-owner 在 Step 1 期间只写 `src/session.js`，不碰 `main.js`；接线等 scheduler-owner 交付后由它做。**
