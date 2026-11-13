# main.js 接线登记

> 建立：2026-11-14 00:15，`scheduler-owner`。
> 接管：2026-11-14 00:55，`wiring-owner`（唯一写入人）。
> 起因：`main.js` 4 小时被改了 8 次，四条线同时要往里接一行，撞车概率按人头发散。
> 现在 **`main.js` 只有一个写入者**，别人要接，登记 + 给片段，由接线人统一落。

---

## 一、规则

1. **不要直接改 `main.js`**。要接的东西用下面"接入申请"模板发给我。
2. 一处一接：接完立刻 `node --check main.js` + 跑**你那个模块自己的测试**，再跑全量语法。
3. 接错了立刻退回（`git revert` 单条或反向 patch），不攒着。
4. 涉及忙状态/中断的接线只有两种合法写法：
   - 占线：`this.lock.acquire(REASON.X, 'why')` / 放线：`this.lock.release(REASON.X)`
   - 换线：`await this.interruptCurrent({ from, to, why })`
   - **不许**写 `this.busy = ...`（`busy` 已是只读 getter，严格模式下会抛错），
     也不许在 `interruptCurrent` 之外写 `actions.cancel`。
5. 新动作线要 rank：在 `src/actionlock.js` 的 `RANK` 里注册，或运行时 `registerRank()`。
6. **提交纪律**：`git add main.js`，**不要** `git add -A`。仓库里有别人未跟踪的
   `assets/`、`data/*` 目录，一把梭会把别人的活卷进你的 commit，信息跟内容不符。

## 二、接入申请模板

```
模块：src/xxx.js
要调的函数：<module.fn(...)> 或 <self.method()>
一行/一段代码：<原样给，带缩进不算>
接在哪：main.js 的 <函数名>，在 <锚点行/注释> 之前/之后
需要 this 上的什么：<如 this.actions / this.bot / this.lock>
跑什么测：<node scripts/test-xxx.js>
失败怎么退：<可逆吗 / 需要开关吗>
```

## 三、登记表（本轮 4 条）

| 谁 | 要接什么 | 状态 | 接在哪个函数/行 | 接了之后验了什么 |
|---|---|---|---|---|
| judge-owner | judgeTask evidence 类型 | **已接**（已随 `c1457c2` 入库） | `verifyTaskEffect()`，main.js:**2272** | `test-judge-consistency` 114 组 100%；`test-fake-success` 58/0；`check-judge-discipline` 规则 W 接线 OK |
| goals-owner | 目标选中时记 y + underground | **无需接线（0 行）** | goals.js:991-992 / 1666 / 1757 已有 | `test-goals` 152/0；`test-goals-live` 66/0 |
| voice-owner | 损失记忆 → spontaneous 触发 | **无需接线（0 行）** | 触发点 `src/spontaneous.js` `_tickInner()`；数据源 `src/cost.js` | `check-syntax` 0 问题；`test-cost` 通过 |
| move-owner | maxDropDown / 落点配置 | **无需接线（保持原值）** | main.js:355 `moves.maxDropDown = 3` **不动** | 见下：3 是 MC 1.21 安全上限 |
| （附带）goals-owner 可选项 | `reportTaskResult` 用带 underground 的 status | **已接**（已随 `c1457c2` 入库） | `reportTaskResult()`，main.js:**1321** | `test-goals` 152/0；`test-goals-live` 66/0；`test-actionlock` 112/0 |

状态取值：`待申请` → `已收到片段` → `已接` → `已验证`（或 `已退回` / `无需接线`）。

### ⚠️ 前提事故：我这行的前提一度是假的

接线时我核了三处「阶段必带 evidence」的路径 —— POOL 初始化盖章（goals.js:2175）、
老存盘补齐（550-559）、`normalizeStage` 必带字段 —— 结论是安全。
**漏了第四条、而且是最关键的那条：`makeGoal()`。**

judge-owner 在同一个 commit 里实测出来：
`makeGoal()` 当时只拷 `key/kind/need/title`，**把 `evidence`/`minSec` 丢了**，
真实目标 5/5 阶段 `evidence=undefined`。
也就是说：在我落 `stage ? stage.evidence : 'world'` 的那一刻，
每个正常任务都会 `evidence=undefined` → judge 入口 throw → **第一次判定就炸**。
它没炸，是因为 judge-owner 的修复和我这两行进了同一个 commit（`c1457c2`）。

**教训**：验「前提成立」要验**数据真正流动的那条路**，不是验生产者端有没有值。
POOL 有值 ≠ 目标身上有值 —— 中间隔着一个只拷 4 个字段的 `makeGoal`。
现在有 `check-judge-discipline.js` 规则 W 专门盯这条链
（`POOL 计划 → makeGoal → 每个阶段都带 evidence`），并且验证过「把透传删掉立刻红 7 处」，不是永远绿。

### ⚠️ 提交事故：`c1457c2` 一把梭卷了 11 个文件

| | |
|---|---|
| 提交 | `c1457c2 判据层补投递缺口 + 摔死真因（挖穿脚下）` |
| 卷入 | `main.js` `src/{actions,actions.orig,goals,invite,judge,spontaneous,talk}.js` `scripts/{check-judge-discipline,probe-gather-count,test-loss-voice}.js` |
| 涉及 | judge-owner / move-owner / voice-owner / wiring-owner 四个人的活 |
| 问题 | commit 信息只讲 judge 和 move 两条线，**没提 main.js 的两处接线**，也没提 voice 的 `test-loss-voice.js` |

我的两处接线因此被别人的提交带走，不是我提交的。
**这个仓库的提交粒度现在是坏的** —— 提交信息跟内容不符，正是 Lead 之前踩过的坑。
```bash
git add main.js && git commit -m "..."   # 只加自己那个文件
```

### 三条「不用接」的依据（都是对方自己核实后回我的）

**goals-owner**：`goals.js` 里已经齐了 ——
`makeGoal()` 记 `createdY` / `createdUnderground`（991-992），
`completeGoal()`（1666）、`abandon()`（1757，另有 `yNow`/`undergroundNow`）写进 history，
`undergroundOf()`（53-59）优先读 `status.underground`、没有再按 y 猜。
**之前看着没生效是排序 bug 在 `house.score()` 自己**（分数根本不看 underground），不是接线丢了。
已在 goals.js 内修掉（commit `c630e69`），main 一行没加。

**voice-owner**：数据源不是 `src/memory/*`，是 `src/cost.js` 的账本。
`spont.tick()` 已经被 main.js:1556 每轮主循环驱动，`_maybeQueueLoss()` 挂在
`_tickInner()` 内部，**main 侧的现成口子够用**。
忙的时候也能说：该事件 `priority:'complain'` → `busyExempt` 放行，
不需要 2598 那种绕过 busy 的直推写法。

**move-owner**：`maxDropDown = 3` **是对的，不要改**。
engine 默认 4（`mineflayer-pathfinder/lib/movements.js:107`），
MC 1.21 摔伤 `damage = floor(fallDistance - 3.0)`，3.0 格整好 0 伤。
日志实证死因是 `fall` 不是 `void`/`lava`。
真问题在别处、且都不在 main.js：
① `src/invite.js:292` 跟随结束后 `setMovements(new Movements(bot, mcData))` 造了个默认对象，
   `maxDropDown` 3→4、`digCost` 20→1、`liquidCost` 20→1，跟完一次人全局寻路就降级且不恢复；
② `src/actions.js` 有 7 处 `setControlState('forward')` 手动前进绕过 pathfinder，没有落差检查。

## 四、已验证的既有接线（不用再动）

| 东西 | 位置 | 证据 |
|---|---|---|
| 动作线仲裁 `lock` / `busy` 只读 | 构造函数 + 各动作线 | `test-actionlock.js` → 112 项全过 |
| `interruptCurrent()` / `_signalCancel()` | 死亡段之前的仲裁节 | 单测 C 段静态守则（顺序、唯一写点） |
| task / home / survive 三条线占锁放锁 | tick / walkHomeNow / doSurvive | 单测 D 段（真 Bot 对象，不连服务器） |
| 死亡 / 复活 / 重连整锁释放 | onDeath / onRespawn / connect | 实机日志 `forceReleaseAll` |
| `statusWithUnderground()` | 1253 | `observeGoals` / `ensureGoal` / 现在 `reportTaskResult` 共用 |

**Step 2 状态**：已落地（6 处 `this.busy=` 全部换成 acquire/release，兼容层已删）。
`grep -c "legacy busy"` 结构性归零；`busy` 写点归零；`actions.cancel = true` 全仓 1 处。

## 五、回归命令（每接一处都跑）

```bash
node --check main.js
node scripts/check-syntax.js
node scripts/test-actionlock.js
# 加上被接模块自己的测试
```

本轮的完整回归（全部离线，2026-11-14 01:05 跑）：

```bash
node --check main.js                                  # OK
node scripts/check-syntax.js                           # 112 文件 / 0 问题
node scripts/check-judge-discipline.js                 # 0 违规 + 规则 W 接线透传 OK
node scripts/test-judge-consistency.js                 # 一致率 100%（114 组）
node scripts/test-fake-success.js                      # 58 过 / 0 挂
node scripts/test-goals.js                             # 152 过 / 0 挂
node scripts/test-goals-live.js                        # 66 过 / 0 挂
node scripts/test-actionlock.js                        # 112 过 / 0 挂
node scripts/test-cost.js / test-decay / test-memory   # 全绿
node scripts/test-persona.js / test-talk-dedup.js      # 全绿
node scripts/test-home.js / test-pain-death.js         # 全绿（pain-death 47/0）
```

**没跑的：`test-e2e.js`**。它是**连真服务器的探针**（账号 `XJJ_E2E`，生产服在
`s205.singsi.cn:19830`），不是离线单测。两条理由不跑：
① 会往生产服再挂一个 bot；② move-owner 明确要求别和他们的 15 分钟计时窗重叠，
否则死亡数算歪。离线侧的等价验证是 `test-judge-consistency`（同一套判定 + 114 组世界态，
一致率 100%），已覆盖本次改动的核心路径。

## 六、重复逻辑审计（**只报告，不删**）

main.js 2859 行。以下重复不影响正确性，动它们属于另一件事（要单独派活 + 单独验）。

| # | 重复模式 | 处数 | 位置 | 风险 |
|---|---|---|---|---|
| 1 | **`snapshotInv()` 与 `snapshotInventory()` 逻辑逐字相同** | 2 | 2346-2353 / 2602-2609 | 低。合并前注意 `session.js:1298` 通过 `ctx.snapshotInv` 注入、`main.js:610` 也有同名注入，**名字是接口**，别随手并 |
| 2 | `[goals]` 结果日志三段式 if/else | 2 | `observeGoals` 1278-1284 / `reportTaskResult` 1323-1326 | 低。文案已分叉（"下一步：X" vs "过了一步"），合并会丢信息 |
| 3 | `if (ev) this.spont.push(ev)` 守卫 | 5 | 375 / 906 / 1364 / 1862 / 2619 | 低。可抽 `_pushSpont(ev)`，收益一般 |
| 4 | `if (this.busy) return` 家族 | 9 | 415 / 478 / 1012 / 1095 / 1562 / 1654 / 1666 / 1693 / 2474 | **中**。返回值不统一（`return` / `return false` / `return null`），抽公共函数前必须先定语义，否则改变控制流 |
| 5 | 空吞 `catch (e) {}` | 46 | 遍布全文 | **中**。这是 main.js 最难查的一类 bug 来源（挂了没有任何痕迹）。不建议批量改，但新代码严禁再空吞 |
| 6 | `this.actions.status()` 直调 | 6 | 含 `statusWithUnderground` 内部 | 低。漏掉 underground 的坑刚踩过一次（见 §三 第 5 行） |
| 7 | `now - (this._xAt \|\| 0) < N` 节流惯用法 | 3 | 1014 / 1273 / 2567 | 低。可抽 `_throttle(name, ms)`，纯口味问题 |
| 8 | `if (!this.X) return` 组件空守卫 | 12 | 162 / 373 / 669 / 694 / 1143 / 1254 / 1266 / 1299 / 1316 / 2612 等 | 低。防御性写法，正常 |

**结论**：真正的重复只有 #1 一处（逐字相同）。其余是**惯用法**层面的重复，抽象收益低于出错风险。
建议只对 #4 和 #5 立项，且必须单独一轮、单独回归。

## 七、变更日志

| 时间 | 谁 | 改了什么 | 验证 |
|---|---|---|---|
| 2026-11-14 00:15 | scheduler-owner | 建立登记表；Step 2 收尾（单测正则修复） | 112 项单测 + 112 文件语法 |
| 2026-11-14 00:52 | wiring-owner | 接 judge-owner：`evidence = stage ? stage.evidence : 'world'`。收窄 `\|\| 'world'` 兜底：有阶段就必须自己声明，临时任务仍按 world | `node --check` OK；`check-syntax` 112/0；`test-judge-consistency` 100%；`test-fake-success` 58/0 |
| 2026-11-14 00:56 | wiring-owner | 接 goals-owner 可选：`reportTaskResult` 的 status 换成 `statusWithUnderground()`，修 surface 阶段两条路判据不一致 | `check-syntax` 112/0；`test-goals` 152/0；`test-goals-live` 66/0；`test-actionlock` 112/0 |
| 2026-11-14 00:57 | wiring-owner | 登记 voice-owner / move-owner / goals-owner 三条为「无需接线 0 行」，附对方给的依据 | 见 §三 三条依据 |
| 2026-11-14 01:07 | judge-owner（他人提交） | `c1457c2` 一次带走 11 个文件，**含我这两处接线**；同 commit 修了 `makeGoal()` 丢 evidence —— 那是我这行的前提 | `check-judge-discipline` 规则 W 接线 OK；上面全量离线回归 |
| 2026-11-14 01:15 | wiring-owner | 补记前提事故 + 提交事故；全量离线回归 12 项全绿 | 见 §五 |
