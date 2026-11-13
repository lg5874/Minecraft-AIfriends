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
| move-owner（第二轮） | 未知 damage type 原样打出 | **已接**（已随 `ce8e6dd` 入库） | `damage_event` 处理，main.js:**242**；死亡行 main.js:**887** | `test-pain-death` 47/0；`check-syntax` 118 文件 0 问题 |
| voice-owner（第二轮） | invite 注入 `busy` + `progress` | **已验证**（main.js 侧 `bd7582c`；豁免 `f1710ae`） | `new Invite({...})`，main.js:**554-570** | `test-invite-reply` **38/0**；`test-invite-bounds` **11/0**；`test-loss-chain` **18/0**；四档真集成探针全对 |

| voice-owner（第二轮） | invite 注入 `busy` + `progress` | **已验证**（main.js 侧 `bd7582c`；豁免 `f1710ae`） | `new Invite({...})`，main.js:**554-570** | `test-invite-reply` **40/0**；`test-invite-bounds` **11/0**；`test-loss-chain` **18/0**；四档真集成探针全对 |
| Lead（断线收尾） | `_teardown` 清四类状态 + 三路径接入 | **已接（待提交）** | `_teardown()` 新方法；`onEnd` / `kicked` / `error` 三处接入；`connect()` 复位 | `test-disconnect` **43/0**（含变异验证）；全量 17 个测试全绿；`check-syntax` 123/0 |
| move-owner（第三轮） | `infiniteLiquidDropdownDistance = false` | **已接（待提交）** | movements 配置段，紧跟 `maxDropDown = 3` | 引擎默认实测 `true`/`maxDropDown=4`；配置后 `false`/`3`；`test-home` 67/0、`test-pain-death` 47/0、`test-actionlock` 112/0、`test-disconnect` 43/0 |

状态取值：`待申请` → `已收到片段` → `已接` → `已验证`（或 `已退回` / `无需接线`）。

### 断线收尾 `_teardown`（本轮最大的一块）

**问题**：断线时状态全都没清。`onEnd` 里 0 处清理；而 `kicked` / `error`
**根本不走 `onEnd`**（只打一行日志）—— **spam 踢走的是 `kicked`**，那条路径上一片空白。

**改法**：抽 `_teardown(reason)`，三条路径都调，自己幂等（`_tornDown` 守卫，
`kicked -> end` 连着来只做一次）。

| 类 | 清什么 | 怎么清 |
|---|---|---|
| **① 限速/时间** | `talk.lastSayAt` / `lastSpokeAt` / `sayWindow` / `repliedMsgIds`、`Talk.GLOBAL_SAY`、15 个冷却时间戳 | 清零/清空 |
| **② 待办/承诺** | `will.current`、`pendingTask`、`spont.pendingEvents`、`invite._pendingFollow/_pendingRecover`、待发 ack | 清空 |
| **③ 占用/锁** | `lock.forceReleaseAll()`、`actions.cancel=false` + `actions.stop()`、`_taskTimer`、7 个 `_taskStart*` | 释放 + 记日志 |
| **④ 目标/进度** | **什么都不动** | 只立 `_interrupted` 标记 |

**③ 为什么最重**：断线时持着 `home`/`task` 锁，重连后锁还在 → 主循环看到 `busy`
就 `return` → **永远开不了新任务**。`connect()` 虽然也 `forceReleaseAll('重新连接')`，
但断线到重连那 15 秒里 `busy` 一直是 true。

**① 为什么非要清**：`sayWindowMs = 20000`，**比重连延迟 15 秒还长** ——
不清的话重连后第一句正常的话会被上一局的说话记录拦掉。
`Talk.GLOBAL_SAY` 在 `talk.js` 模块作用域里，但它是**导出的**
（`module.exports.GLOBAL_SAY`），所以 main.js 能清，**不用改 talk.js**。

**④ 是硬约束，而且有个坑**：`_teardown` 里调 `actions.stop()` 会让在飞的任务
走进 `catch` → `reportTaskResult(false, ...)` → **goals 记 fail**，
正好破坏「断线不记失败」。所以：
- `_teardown` 先立 `this._interrupted = true`
- `reportTaskResult()` 看到它**直接返回 null**，不碰 `attempts/fails`
- 任务 `catch` 里的 `spontaneous.onComplain` 也加 `!this._interrupted` 守卫
  （否则重连后会突然说一句断线前的「跑不动」—— 真人不会这么讲）

**验证：`scripts/test-disconnect.js`，43 项，1 秒跑完**

```
A ③ 锁      占两把锁 → teardown → holders 0、busy false、cancel 归零、stop 被调
B ② 待办     will.current / pendingTask / spont.pendingEvents / invite 承诺 全空
C ① 闸门     lastSayAt / lastSpokeAt / sayWindow / repliedMsgIds / GLOBAL_SAY 全零
D ④ 不记失败 断线前汇报正常进 goals（calls=1）；断线后返回 null 且 calls 仍为 1
E 幂等       kicked→end 连着来，收尾日志只 1 条
F 三路径     静态检查 onEnd / kicked / error 都调了 _teardown
G 5 次注入   skills 的 fail 一字未变、goals 一次都没收到失败、锁都是空的
H 隔离       全程没写过 data/runtime/skills.json（数据目录打到 tmp）
```

**这套测试做过变异验证**（不是"永远绿"）：
把 `T.lastSayAt = 0` 改成 `= 777` → 抓 1 红；把 `forceReleaseAll` 摘掉 → 抓 2 红。
还原后 main.js 哈希与改动前一致。

**没跑的验证**：`test-e2e`（要真服务器）和 60 分钟长跑 ——
参谋的原话是「长跑抓不到这个 bug，它伪装成正常行为」，所以用离线注入替代。

### invite 接线：注入了一个会改变「过来」应答的开关

voice-owner 要的两个口子照原样落，`main.js:554` 的 `new Invite({...})` 加：

```js
busy: () => this.busy,
progress: () => { /* this.goals.status().progress，0~1 */ }
```

**接口核实过**：`goals.status()` 真实存在（`src/goals.js:1795`），
有目标时返回 `progress: s.ratio || 0`，没目标时返回 `{ has:false }`（无 progress 字段）
→ `Number(undefined)` = NaN → invite 自己的 `_progress()` 判 `isFinite` 后返回 0。
**没目标 = 一律答应**，这条兜底是有意的。

**但 `progress` 会改变「过来」的结果。** 拿真 `Invite` + 真 `handleChat` 跑了个矩阵
（`/tmp/probe2.js`，血满、白天）：

| 当前阶段进度 | `handleChat('过来')` | pendingFollow |
|---|---|---|
| 没目标 / 0.3 / 0.5 | `'invite'` **立刻答应** | false |
| **0.51** | `null` **延后** | true |
| **0.8** | `null` **延后** | true |
| 对照：不注入 progress | `'invite'` 立刻答应 | false |

也就是说：**阶段进度一旦超过 0.5，那声「过来」不会被立刻接。**
走的是 voice-owner 设计的延后分支 —— 说一句「等我把这块弄完就来」，
置 `_pendingFollow`，`followThruMs = 60s` 内由 `_tickPendingFollow()` 自己走过去
（`_isBusy()` 只在这一处生效，且 60 秒后无条件放行，不会无限等）。

另外三条状态门槛（都不是我注入的，是 `invite.js` 的 DEFAULTS）：

| 状态 | 结果 |
|---|---|
| 血 ≤ 8 | `null`，说「得先回家」，**不会**自动过去 |
| 饿 ≤ 6 | 立刻答应（`_badState` 跳过延后） |
| 夜里（tod 13000–23000） | 立刻答应 |

**Lead 拍板（2026-11-14 01:20）：保留 `progress` 注入，并在 `invite.js` 加两条豁免。**

**2026-11-14 01:35 状态：已验证。** 最终落库 `f1710ae`（只动 `src/invite.js` + 三个测试，**没碰 main.js**）。
`_everAccepted` 构造 `:88` 初始化 / `attach()` `:136` 重置；
`_tickPendingRecover()` `:355`，`_tick` 里 `:532` 调用。
main.js 这 8 行**一个字不用改**，符合「豁免归 voice-owner」的判断。

**同批还有个口径变化，接 invite 的人要知道**：`INVITE_RE` 收窄了 ——
裸词 `上来` / `下来` 不再算邀请（实机原句 `XJJ_VOICE30126 刚上来啊` 现在返回 `null`）。
我的集成探针用「过来」，不受影响，四档在 `f1710ae` 上重跑仍全对。

### 四档行为：真 Invite + 真 handleChat 实测（`/tmp/probe3.js`）

| 场景 | `handleChat('过来')` | 内部状态 | 期望 |
|---|---|---|---|
| 第 1 声，进度 0.8 **且** 血 5（最恶劣） | `'invite'` | `active=true` | ✅ |
| 第 2 声，进度 0.8 | `null` | `_pendingFollow=true` | ✅ |
| 第 2 声，血 5 | `null` | `_pendingRecover=true` | ✅ |
| 第 2 声，进度 0.3、血满 | `'invite'` | — | ✅ |

**「说出来的话要有下文」三条分支也全测了：**

| 后续 | 结果 |
|---|---|
| 血回到 15（> `recoverHp: 12`） | `active=true`、`target=老王`、`_pendingRecover` 清空 → **真的过去了** |
| 90 秒还回不来（`recoverMaxMs`） | `_pendingRecover` 清空 → 不挂一整局，补一句实话 |
| 那个玩家下线了 | `_pendingRecover` 清空 → 不会对着空气承诺 |

**第 1 声不延后、第 2 声才讲分寸**，分档如下：

```
第 1 声                    -> 无条件答应（不看 progress、不看血、不看任何条件）
第 2+ 声，进度 > 0.5       -> 说「等我把这块弄完」+ 60 秒内自己过去
第 2+ 声，血 <= 8          -> 说「我快不行了，先缓一下」+ 必须有下文（血回来就去找他）
其余                       -> 答应
```

**为什么第一声必须无条件**：用户进游戏第一件事大概率就是「XJJ 过来」，
这一声决定他是不是「能一起玩」。分寸从第二声开始讲。
**为什么不用调阈值**：`0.5→0.85` 只是把撞上的概率推后，用户试到第三次照样撞上。

**两条豁免都归 `voice-owner`（`src/invite.js`），不在 main.js。**
接线人这边不预留开关 —— 加了之后 `main.js` 这 8 行一个字不用改。

### 血 ≤8 的观感坑（已修，留档）

**修之前**：血 ≤8 时 `handleChat` 返回 `null`，说「得先回家」，**且 `_pendingFollow` 为 false** ——
说完人就没了，不会回来找。用户听到的是「他跑了」。
**现在**（`f1710ae`）：说「我快不行了，先缓一下」，落 `_pendingRecover`；
血回到 `recoverHp: 12` 以上 → 主动 `start()` 过去；`recoverMaxMs: 90s` 还不回来 →
清承诺 + 补一句实话「这会儿过去就是送死，让他别等我」；对方下线 → 一并清空。
实测三条分支全对（见上表）。

### 回归的假红：两次，都记在这儿

| 时间 | 现象 | 真因 | 重跑结果 |
|---|---|---|---|
| 01:2x | `test-invite-reply` 报 `at Invite._tick (src/invite.js:575)` | 撞上 voice-owner 保存文件的**中间态**（文件半写） | 38/0 |
| 01:4x | 批量跑时 `test-unhuman-misc` 无输出直接 FAIL | 同上：并发写 + 系统负载；该测试**没有真实 sleep**（只有 1 处 5ms），连跑 4 次全 71/0 | 71/0 ×4 |

**教训（写给所有接线人）**：
1. **别人正在写的文件，跑回归必须等他喊停** —— 否则拿到的是假红，还可能被误报成真 bug。
2. 批量循环里 FAIL 但单跑通过 → **先单跑 3 次再下结论**，别直接说"回归坏了"。
3. 批量的 `timeout` 在高负载下可能把慢测试掐死（rc=124），和断言失败不是一回事。

### 伤害归因接线细节（第二轮，`DAMAGE_KIND` 补全）

move-owner 给的原样一行是 `if (!kind) this.log(...)`，我在它外面加了一层去重，**其余照抄**：

```js
if (!kind && !seenUnknownDmg.has(pkt.sourceTypeId)) {
  seenUnknownDmg.add(pkt.sourceTypeId)
  this.log(`[dmg] 未知类型 sourceTypeId=${pkt.sourceTypeId} cause=${pkt.sourceCauseId || 0} direct=${pkt.sourceDirectId || 0}`)
}
```

**为什么加去重**：那行在 `damage_event` 里、位于 1.5 秒节流**之前**，
骷髅连射一秒两包 → 一秒两条日志。补表只需要每个 id 见一次，去重后永不刷屏。

**额外补了两处**（否则「明天摔死能不能归因」只解决一半）：
`[dmg]` 每个 id 一辈子只打一行，真正每次死亡都要能查，所以让死因带上 id ——
- `_lastDamage` 两个分支都存 `sourceTypeId`（实体来源 263 行、环境伤害 296 行）
- `resolveDeathCause()` 透传（853 行）
- `[death]` 行在 `kind === 'unknown'` 时追加 ` / sourceTypeId=N`（887 行）

结果：`[death] 受了点伤（来源：damage_event / sourceTypeId=4）`。
**人类文案 `受了点伤` 一个字没改** —— 它会流进 `cost.onDeath` 和 `mem.add`，
改成「受了点伤(类型4)」会污染记忆和他说的话。诊断信息只进日志。

### 核实 Lead 第 3 条：`evidence` 透传没被兜底覆盖

**结论：没被覆盖。** `main.js` 全文只有一处硬编码 `'world'`，
就是 `const evidence = stage ? stage.evidence : 'world'` —— `stage` 为 null 时才生效，
`stage` 存在时**原样用 `stage.evidence`**，不判值、不改写。

另外查了 `minSec`：`main.js:2277` 原样传 `stage && stage.minSec`，
`judge.js:306` 只在 `duration` 分支使用（`Number(ctx.minSec || 30)`）。
自定义计划带 `duration` 能一路走通：`normalizeStage` 保留 `raw.evidence`/`raw.minSec`
→ `makeGoal` 只透传 → `main.js` 原样交 → judge 按 duration 验。

**但 Lead 说的「POOL 的 30 个阶段全部声明了 evidence: 'world'」需要修正一处：**
拿真实 POOL 跑了一遍（`/tmp/pool2.js`，括号匹配抽字面量 + stub `SURFACE_Y`）：

```
POOL 计划数: 7
阶段总数: 30
源码显式写了 evidence: 0      ← 一个都没有
推导 world: 30
推导 duration: 0
```

**30 个阶段没有一个在源码里写了 `evidence`**，全部是模块初始化时
`evidenceForStage()` 盖上去的章，而盖章结果恰好全是 `'world'`。
所以「不会失败」的结论成立，但理由是**盖章默认 world**，不是「都声明了」。

顺带发现：`STAGE_EVIDENCE` 里三条 `duration` 条目（`先歇着` / `歇一会儿` / `守着火堆`）
**在 POOL 里一条都不存在**，正则那条 duration 路径也是 0 命中 ——
也就是说 **`duration` 判据目前对 POOL 任务完全用不上**，
只有模型自定义计划显式写 `evidence:'duration'` 才会进那个分支。
这不是 bug，但「duration 判据已覆盖待着类目标」这个印象是错的。

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
| 2026-11-14 01:10 | wiring-owner | 伤害归因（已在 `ce8e6dd` 单独入库，只动 main.js + 本表）：`[dmg]` 未知类型带 id 去重 + 死因带 `sourceTypeId` | `test-pain-death` 47/0；`check-syntax` 118/0；全量离线 11 项绿 |
| 2026-11-14 01:17 | wiring-owner | 接 voice-owner：`new Invite` 注入 `busy` + `progress`。实测进度 >0.5 会延后「过来」（见 §三 invite 一节） | `check-syntax` 118/0；`test-invite-reply` 20/0；`test-invite-bounds` 11/0；`test-actionlock` 112/0；`test-pain-death` 47/0；`test-judge-consistency` 100%；`test-fake-success` 58/0；`test-goals` 163/0；`test-goals-live` 66/0；`test-cost`/`test-memory`/`test-persona` 通过 |
| 2026-11-14 01:11 | wiring-owner | 接 move-owner：`[dmg] 未知类型`（242 行，加 id 去重防刷屏）+ `_lastDamage`/`resolveDeathCause`/`[death]` 三处带 `sourceTypeId`，让每次死亡都能归因 | `node --check` OK；`check-syntax` 117/0；`test-pain-death` 47/0；`test-unhuman-misc` 通过；`test-actionlock` 112/0；`test-judge-consistency` 100%；`test-fake-success` 58/0；`test-goals` 163/0；`test-goals-live` 66/0；`test-cost`/`test-memory` 通过；`check-judge-discipline` 规则 W OK |
| 2026-11-14 01:45 | wiring-owner | 断线收尾：新增 `_teardown()`，接入 `onEnd` / `kicked` / `error` 三条路径（后两条原来只打日志、0 处清理）；四类状态按①②③④分；`connect()` 复位 `_tornDown`/`_interrupted`；`reportTaskResult` 加 `_interrupted` 守卫保住「断线不记失败」 | `test-disconnect` 43/0（变异验证：摘清理抓 1~2 红，还原后哈希一致）；`check-syntax` 123/0；全量 17 个测试全绿 |
