# 审查 `112917d`：WIP 多项修复的潜在问题

**审查对象**：`112917d`（`git diff 4dc6627 112917d`，11 文件 / +1588 −77，其中 8 个源文件 1026 行净改动）
**审查方式**：只读。全部结论来自 `git show 112917d:<file>`（**不是**工作区——工作区当时已有其他 agent 未提交的改动）
**审查时间**：2026-11-13 19:00–19:50
**本文档是唯一新增文件，未改 `src/` 任何一行**

---

## 0. 结论摘要

`node scripts/check-syntax.js` → **55 文件 0 错误**。
提交自带的两个测试脚本在快照上跑通：`test-unhuman-fixes.js` **27/27**、`test-talk-dedup.js` **30/30**。
**下文 23 条问题全部不在这些测试的覆盖范围内**（它们要么直接调被修的 API，要么用固定输入绕开了新逻辑）。

| # | 文件:行 | 问题 | 严重度 |
|---|---|---|---|
| B1 | `src/mood.js:66-107,181` | #10 只是把「永远 irritated」换成「永远 tired」：`energy` 只降不升 | **会错** |
| B2 | `main.js:1405-1417` | 判据 A 用 goal 关键词判"产出型"，吃饭/聊天/整理/换装备全判失败 | **会错** |
| B3 | `main.js:1439-1447` + `src/coder.js:250-256` | "找/看"就要求位移 → 「找个安全地方待着」必然判失败 | **会错** |
| B4 | `src/coder.js:222-247` | 搬/挪/换/吃 这类净零任务全判 fake；提示语自相矛盾 | **会错** |
| B5 | `src/coder.js:192-258` vs `main.js:1366-1450` | 同一件事两套判据，阈值不同 → 互相打脸 | **会错** |
| B6 | `src/skills.js:512-529,677-691` | 罚分命中 37/39 个真实技能 = 全员 −3.5；目标坏技能仍第一 | **会错** |
| B7 | `src/spontaneous.js:291-306` | 队列头部社交事件冷却中不 shift → 压住后面所有事件 | **会错** |
| B8 | `src/spontaneous.js:400-408` | `_isFamiliar` 读 `ctx.mem`，而 main 只传 `{log,busy}` → 死人分支 | **会错** |
| B9 | `src/spontaneous.js:360` | `/^XJJ/` 把真人小号一起滤掉 → #14 对最主要的那个玩家不生效 | **会错** |
| B10 | `src/spontaneous.js:109,120,141,160` | `instant: true` 全项目只写不读 | 只是不好看 |
| B11 | `main.js:1712-1730` | 深夜事件无 priority → 吃 90 秒冷却 + 被 busy 挡 → 干活时永远说不出来 | **会错** |
| B12 | `src/talk.js:107-118` | 复读拦截跨人无差别 → 第二个人问同一句被静默吞掉 | **会错** |
| B13 | `src/talk.js:450-457` | `followUpDeferred` 忽略 `say()` 返回值，仍 markReplied + `return true` | **会错** |
| B14 | `src/talk.js:216,451,636` | 注释说"记录放到 say() 之后"，实际 history 先 push → 上下文里有没说过的话 | 只是不好看 |
| B15 | `main.js:1332` | `hasGain` 的数量组是可选的，注释承诺的"动词+数字"没实现 | 只是不好看 |
| C1 | `src/actions.js:139-184,188-235` | watchdog 与所有任务无条件并发；会挖开脚下箱子/床/工作台 | **会错** |
| C2 | `src/coder.js:73` | 只核对"复用"，新写的假技能照样入库 | **会错** |
| C3 | 提交信息 | 宣称 #4/#11/#13/#16，其中 #4/#13/#16 不在本提交里 | 只是不好看 |
| D1 | `src/skills.js:680,704` | 同一候选重复计算 `hasUnconditionalReturn` 两次 | 只是不好看 |
| A1 | `src/coder.js:68` | `pos().clone()` 不在 try 内，`bot.entity` 为 null 时抛异常 | 会崩（低概率） |
| F1 | `main.js:1295-1299` | **既有 bug**：`A→B` 且 B<A 一律判"数量没变" → 制作类必失败 | **会错** |
| F2 | `src/talk.js:242,769` | **既有+新**：`botChain` 数的是"收到的消息"，第 4 条起静音 2 分钟 | 会错（低） |

**#15 已确认修好**，见 §5。

---

## 1. `src/mood.js`（#10）

### B1（会错）修完还是"永远同一张脸"，只是从"烦"换成"困"

- **位置**：`src/mood.js:95-98`（tick 的 energy 分支）、`src/mood.js:181`（state 提前返回）、`src/mood.js:209`（`exhausted`）
- **问题**：`state()` 现在把 energy 排在最前（energy<0.12 直接 `tired`），这是对的。但 **energy 在全项目里没有任何一条上升路径会真的被触发**：

  ```
  $ grep -rn "onEvent('rest'\|onEvent('food'\|\.rest(" main.js src/
  （无输出）
  $ grep -rn "\.rest(" main.js src/ scripts/
  scripts/test-unhuman-fixes.js:66:    m.rest(true)
  ```

  `mood.rest()` 只有测试脚本调用；`onEvent('rest')` / `onEvent('food')` 定义了但 0 调用方。`tick()` 的 `resting` 分支（95 行）永远走不到 `else` 之外，于是 energy 单调递减 `-0.004/分钟`。

- **证据**（现场数据）：`data/runtime/mood.json` 现在是
  `{"energy":0,...,"irritation":0.903941,"resting":false}`
  即真实运行里 energy 早已是 0。改动后 `state()` 恒返回 `tired`，`describe()` 恒为
  「你困得不行了，随时能睡过去。心里有点堵。」——**和改动前恒为「谁跟你说话都想呛回去」是同一类错误，只是换了一个常量**。
- **为什么测试没抓到**：`test-unhuman-fixes.js:64-68` 是 `m.rest(true); m.tick(10); ok(m.energy > 0.1)` —— 直接调 API，证明的是"机制能work"，不是"生产路径会调它"。
- **建议**：
  1. 把 `rest()` 接到行为层（主循环空闲 / `reflex.shelter` / 聊天时），或
  2. 更省事：`tick()` 里在没有任务（`!ctx.busy()`）时给一个小的正向回复，并在 `onEvent('food'|'death')` 处真的调用，或
  3. 至少在加载时把 0 钳到一个下界（例如 `Math.max(0.2, energy)`），避免"读档即永久累垮"。

---

## 2. `main.js` 判据（#8 的正面修法）

### B2（会错）"产出型"用 goal 关键词判定，吃饭/打招呼/整理背包永远失败

- **位置**：`main.js:1405-1426`（`isProduce` / `isConsume` / `isObserve` 与 A 规则）
- **问题**：`isProduce` 含 `打`、`换`、`弄`、`备`、`种`，`isObserve` 含 `看/等/睡/歇`。A 规则要求 `gainedAny`（背包里**任意**物品增加）。对于"消耗型但含产出词"的目标，一步就判死。
- **证据**（在 `112917d` 快照上直接调 `Bot.prototype.judgeOutcome`）：

  ```
  FAIL "弄点吃的，别饿着"     -> 背包没有任何增加（3->1 个）——文本说有产出，但物品栏没变，这是假成功
  FAIL "整理一下背包"         -> 要"放/存/摆"东西，但背包一个都没少（30->30）——东西没出手，这是假成功
  FAIL "打个招呼"             -> 背包没有任何增加（5->5 个）——文本说有产出，但物品栏没变，这是假成功
  OK   "把熔炉搬到山顶去"     ->（同上文本，因为不含 isProduce 词）
  ```

  `弄点吃的` 的报错文本自己就写着「3->1 个」，却说"物品栏没变"——判据和它的解释都不是一回事。
- **连锁影响**（这条比判错本身严重）：
  `main.js:1200` 失败分支会 `this.mood.onEvent('task_fail', 1)` → `irritation += 0.05`、`_angeredAt = now`（`mood.js:118-121`）。`_angeredAt` 被刷新后 `irritDecay` 掉回最慢档 0.004/分钟（`mood.js:82-90`）。吃饭/聊天这类任务出现频率高，等于**持续给烦躁续命**，与 B1 叠加后情绪又回到"永远一个样"。同时 `main.js:1190-1195` 会把这类假失败写进长期记忆。
- **建议**：
  1. 判"产出型"不要用 goal 里的动词，改用 `skills` 的 `analysis.produced` 或"任务开始时的目标物品"；
  2. `吃/喝/打招呼/聊天/整理/换装备/睡` 这几类直接白名单跳过背包判据；
  3. 至少把 `打`、`换`、`备` 从 `isProduce` 里拿掉（它们和背包增量没有因果）。

### B3（会错）+ B4（会错）`coder.verifySkillEffect` 把"合法不动/净零"判成假成功

- **位置**：`src/coder.js:192-258`（`verifySkillEffect`），其中 `isTravel` 在 250 行、`isProduce` 在 224 行
- **证据**（快照上直接调 `verifySkillEffect`，模拟"确实干了"的一次）：

  ```
  FAKE 把熔炉搬到山顶（真的搬了，净零）   -> 背包没增加（共 1->1，新增 0 / 减少 0）
  FAKE 找个安全的地方待着（真的在待着）   -> 技能说去了，但只移动了 0.3 格
  FAKE 弄点吃的（吃了两个面包）           -> 背包没增加（共 3->1，新增 0 / **减少 2**）
  FAKE 换石镐拿手上（换了，背包不变）     -> 背包没增加（共 2->2）
  FAKE 站上去看四周（原地看着）           -> 技能说去了，但只移动了 0.3 格
  PASS 清树叶采蘑菇（真的采到蘑菇）
  ```

  - `isTravel` 含 `找`，所以「先找个安全的地方待着，别乱跑」——数据里成功率最高的技能
    `k_mwdr2g2a`（uses 12 / ok 12）——每一趟都会被记一次失败。
  - `isConsume`/`isProduce` 都是**只看词、不看意图**：搬家类（挖起→放下，净零）、装备类（手持变化、背包不变）、进食类（只减不增）必然命中。
  - "减少 2"却判"没增加"，说明分支设计上把"净增物件数"和"总数量"混着用了。
- **后果**：真成功的复用被 `markUse(name,false)` 记失败；`pickFor` 有 `minRate 0.45`（`skills.js:723`）与 `lifeRate` 过滤（`skills.js:748-750`），连续几次假失败后**好技能会被永久剔除**。
- **建议**：
  1. 先判"任务类型"，再判"指标"，且把 `搬到/挪到/移/换/吃/喝/睡/站/守着` 显式列成"不查背包"；
  2. 搬移类改成"目标方块坐标变了"或"手持变化"；
  3. 判据里增加"这一趟有任意动作成功"的证据（`actions.current`、日志时间），而不是纯背包快照。

### B5（会错）两套几乎一样的判据，参数不同 → 同一趟运行结论相反

- **位置**：`src/coder.js:192-258` 与 `main.js:1366-1450`
- **差异**（逐项对比过）：

  | 项 | coder | main |
  |---|---|---|
  | 位移阈值 | `< 2` 格 | `< 1.5` 格 |
  | 产出词 | 做/制作/合成/弄/搞/挖/砍/打/采/收集/攒/备/升级/换/烤/烧/熔炼/捡/种 | + 找点/弄点/弄到/搞到 |
  | 观察豁免 | 无 | isObserve 含 看/观察/望/巡视/确认/记住/记下/睡/歇/等 |
  | 输入文本 | `goal + ' ' + desc` | 只有 `goal` |

  因为 coder 拼了 desc，`isProduce && isConsume` 同时为真的概率大增，两条规则都不触发——**检查被静默跳过**。在 38 个真实技能上统计：

  ```
  只含产出词 → 会查背包增加: 20
  只含放置词 → 会查背包减少: 2
  只含移动词 → 会查位移: 5
  同时含产出+放置词 → 两条规则都不触发，直接放行: 7   ← 18%
  一个词都没有 → 不查: 5                              ← 13%
  ```

  也就是说这套"最后一道闸"对 ~32% 的真实技能完全空转，同时对 B3/B4 那几类真活儿误杀。
- **建议**：抽一个 `judge.js` 共用；输入统一为 `{goal, budget, before: {inv,pos}, after: {inv,pos}}`；规则表化，禁止两处各写一份正则。

---

## 3. `src/skills.js`（#8 源头）

### B6（会错）罚分命中 37/39 = 全员背锅，目标坏技能仍排第一

- **位置**：`src/skills.js:512-529`（`hasUnconditionalReturn`）、`677-691`（`useBonus` / `fakePenalty` / `score`）
- **证据 1**：在 `data/runtime/skills.json` 快照上跑同一个函数：

  ```
  39 个技能里 37 个被判"结尾无条件 return"
  FLAG  k_mwe74ysb  uses=76 ok=1 fail=1   「在附近地上捡够垫脚的石头」  ← 目标
  FLAG  k_mwds22uu  uses=55 ok=0 fail=1   （失败率 100% 的技能也被罚，罚分不区分好坏）
  ok    k_mwdr2g2a  （因为它最后一个 return 在 try 里）
  ```

  原因是**模型写技能几乎都以一句总结 return 结尾**，这是写法常态，不是缺陷特征。`indent > 2 就算有保护` 的判据还进一步把 `if` 里的 `return` 也算成"有保护"。

- **证据 2**：因为这个罚分几乎恒定，**它无法把坏技能排到好技能后面**。真实数据下 `pickFor("在附近地上捡够垫脚的石头")` 仍然选中 `k_mwe74ysb`（`_score 18.24`，第二名 4.51）。

- **证据 3（副作用更严重）**：`search()` 的过滤门槛 `.filter(x => x.score >= 2.2)`（`skills.js:692`）和 `pickFor` 的 `_score >= 5.5`（`skills.js:722`）**都没跟着调**，而所有分数普遍下移 3.5。实测候选池：

  ```
  goal                        改前  改动后
  先弄把铁镐                    26      5
  做一把石镐                    31     15
  带上吃的和火把再出门           13      3
  去挖点圆石                    19     13
  ```

  `coder.writeAndRun` 第二段用 `search(goal, 2, …, {verifiedOnly:true})` 拿"以前做过的类似代码"当参考，池子缩小 30–80% 意味着模型经常拿不到参考、只能从零写——**技能复用率和一次成功率都会降**，而这正是本 repo 最在意的指标。

- **建议**：
  1. 把"无条件 return"判据改成**对照产出**：解析 `return` 表达式里是否出现 `countOf(...)` 且没有前置阈值判断——或者干脆放弃静态判断，用 `runs` 里"连续 N 次 ok 但世界没变"的实际数据来判（`coder.verifySkillEffect` 已经在产出这个信号了）；
  2. 若保留 3.5 罚分，必须同步把 `2.2` / `5.5` 门槛下调 3.5（或把罚分改成相对排序项而不是绝对减分）；
  3. `useBonus` 从 `min(uses/20,1)` 降到 `min(uses/100,0.3)` 是合理的（方向对），但单靠它不足以治假成功。

### D1（只是不好看）同一候选重复计算两次

`skills.js:680` 和 `704` 各调一次 `hasUnconditionalReturn(x.s.code)`，都是整段字符串 split + 回溯扫描。39 个技能 × 2KB 可忽略，但既然已经在算，存到 `X._uncond` 上一次即可。

---

## 4. `src/spontaneous.js`（#3 / #14）

### B7（会错）队头阻塞：一条社交事件压住整个队列

- **位置**：`src/spontaneous.js:278`（`_sortQueue`）、`291-298`（冷却提前 return）、`306`（shift）
- **问题**：`_sortQueue` 把 `social` 排到队头；冷却期内在**队头**直接 `return false`，但**没有 shift**。于是队头那条社交事件在冷却窗口内会把后面所有事件一起压住，包括本该"当场就骂"的吐槽。
- **证据**（快照上构造：社交事件在头 + 冷却中 + 后面一条 `onComplain('died')`）：

  ```
  队列顺序: social < complain?
  tick1: false  剩余 2  [social, 你刚死了（被僵尸）]
  tick2: false  剩余 2  [social, 你刚死了（被僵尸）]
  tick3: false  剩余 2  [social, 你刚死了（被僵尸）]
  ```

  死亡吐槽一句都没轮到；等社交冷却 20 秒过去之前它只能靠 120 秒 TTL 过期被丢。考虑到 #3 的目标就是"提高社交事件密度"，这条会在修好 #3 之后**更频繁**地饿死吐槽类事件。
- **建议**：冷却不满足时**不要只看队头**——扫一遍队列找第一个"当前可发"的事件（社交跳过、吐槽放行）；或冷却期把社交事件暂时出队、冷却结束后再压回。

### B8（会错）"熟人喊名字"是死人代码

- **位置**：`src/spontaneous.js:400-408`（`_isFamiliar` 读 `this.ctx.mem`）vs `main.js:441-444`（`new spontaneous.Spontaneity({ log, busy })`）
- **问题**：`ctx` 里只有 `log` 和 `busy`，`this.ctx.mem` 恒 `undefined` → `_isFamiliar()` 恒 `false` → 所有 `onPlayerJoin/onPlayerNearby/onPlayerLinger` 的 `familiar` 分支永远走不到，永远输出"你不太认识"。这正是 #3 修法第 3 条（熟人喊名字）要的效果。
- **证据**：`scanPeople` 生成的事件文本实测为
  `有个不太认识的玩家 真人甲 在你旁边（4 格）。`
  （`_isFamiliar` 返回 false，即使 `mem.people['真人甲']` 存在且 `talkCount>=3`）。
- **建议**：`tick(talk)` 里把 `talk.mem` 记下来当备选来源（`const mem = this.ctx.mem || (talk && talk.mem)`），或在 main 构造时补 `mem: this.mem`。

### B9（会错）`/^XJJ/` 把真人小号也当 bot 滤掉

- **位置**：`src/spontaneous.js:360`
- **问题**：`const isBotName = (n) => /^XJJ|bot|Bot|BOT/.test(n)`。但 `config.json` 里 bot 自己就叫 `XJJ`，而测试/玩家小号叫 `XJJINTG`、`XJJHOME6`（`memory.json` 里真实存在）。这些人**永远不会**进入 `scanPeople`。
- **证据**：

  ```
  附近有 XJJINTG(3格) 和 真人甲(4格)，scanPeople 攒了:
  [ '有个不太认识的玩家 真人甲 在你旁边（4 格）。' ]
  ```

- **附加不一致**：`talk.js:757` 的 `looksLikeBot` 读 `ctx.botNames`（配置里是 XJJ1..XJJ5），这里却硬编码正则、不读配置。同一个概念两处实现，多 bot 场景下会一个认一个不认。
- **建议**：改成"精确匹配 `cfg.behavior.botNames` + `^(bot|ai|npc)[_-]?\d*$`"，去掉 `^XJJ` 前缀匹配。

### B10（只是不好看）`instant: true` 是死字段

四个事件工厂都返回 `instant: true`，注释（95 行）写"不受 90 秒冷却限制"，但 `tick()` 里从未读过 `ev.instant`：

```
$ grep -rn "instant" src/ main.js
src/spontaneous.js:95    （注释）
src/spontaneous.js:109 / 120 / 141 / 160   （只写）
```

实际生效的是 `priority: 'social'` 带来的 20 秒冷却。要么删字段，要么在 tick 里真的实现"瞬时事件"。

### 其它两条小的（只是不好看）

- `_situationKey` 把**所有数字**都塞进 `ent`（272-276 行）。于是 `onPlayerNearby`（带距离）、`onPlayerLinger`（带秒数）、`onLateNight`（带时间）的"30 分钟内不复读"实际永不生效（每次数值都不同 → `ent` 不同）。
- `onPlayerLeave` 在 commit 里 `chance: 0.35`，但上线是 0.85，而下线本身也用 `instance:true` 走社交冷却。上下线成对出现时，下线那句经常落在 20 秒冷却里（同 B7）。

---

## 5. `src/talk.js`（#2 / #15）

### #15 已确认修好（不重复报）

```
$ grep -rn "withThisThisBotTooMany" src/ main.js   → 无
$ grep -n "botChainTooLong" src/talk.js
242:      if (this.botChainTooLong(withThisBot)) {
769:Talk.prototype.botChainTooLong = function (chain, limit = 3) {
```

定义在 769、调用在 242，全仓无残留引用。`node scripts/test-talk-dedup.js` 30/30 通过。

### B12（会错）复读拦截跨人不分对象

- **位置**：`src/talk.js:107-118`（say 里的闸）、`784-800`（`findRecentDuplicate`）
- **问题**：`recentSaid` 的条目只有 `{text, at, kind}`，**没有"说给谁"**。复读拦截因此无法区分"对同一个人重复"和"对不同的人各回一句同样的话"。
- **证据**（快照上 stub 掉 llm，让它固定回「来了，稍等」）：

  ```
  A 回复返回: true | B 回复返回: false
  实际发出去的: ["来了，稍等"]
  history 里记了几条"我": 2
  ```

  第二个玩家完全被无视，日志里只有一行 `[repeat blocked] …`。真人玩家视角：问了一句没人理。
- **建议**：
  1. `recentSaid` 里加 `who`（`reply` 路径传 username），只在 `who` 相同或为自言自语时才拦；
  2. 或者只在 `speak()`（主动说话）路径拦，回复路径保留 `fatigueHint` 的软提示；
  3. 被拦时让调用方 `unmarkReplied` 并允许换一句重试（现在没有重试路径）。

### B13（会错）`followUpDeferred` 吞掉失败，消息永久作废

- **位置**：`src/talk.js:450-457`
- **问题**：`await this.say(out)` 的返回值被丢掉，随后无条件 `markReplied(item.who, item.msg)` + `return true`。改动前 `say()` 只在 leak/machine-talk 时返回 false（罕见）；改动后**复读拦截让 false 变成常见路径**，于是"回头接话"这一路会变成"悄悄吃掉 + 标记已回"。
- **证据**：

  ```
  followUpDeferred 返回: true | 实际发出: []
  这条消息被标记为"回过了": true
  ```

  `hasReplied` 一旦为 true（`talk.js:396`），之后任何路径都不会再回这条——玩家那句话永久没有下文。`main.js:1002` 拿到 `true` 也会当成"说了"。
- **建议**：照 `reply()` 的写法 `const said = await this.say(out); if (!said) return false`（不要 markReplied），让下一轮还有机会。

### B14（只是不好看）注释与代码不一致，history 里混入"没说过的话"

- **位置**：`src/talk.js:216`、`451`、`636` 三处
- **问题**：注释明确写"记录放到 say() 成功之后"，但 `this.history.push({ who: '我', msg: out })` 仍然在 `say()` 之前执行。被复读拦截/机器味拦截的句子照样进入"刚才聊的"上下文（`talk.js:199-200` 会把 history 塞进提示词）。实测发出 1 条、history 里 2 条"我"。
- **影响**：模型会以为自己说过那句，之后容易说"我刚说了""你问第三遍了"之类基于假上下文的话——和 #2 想修的现象同类。
- **建议**：把 history.push 挪到 `said` 为真之后；或在 `say` 返回 false 时 pop 回去。

### B15（只是不好看）`hasGain` 的"动词+数量"名不副实

- **位置**：`main.js:1332`
- **问题**：

  ```js
  /(?:挖|砍|捡|采|做|合|烤|种|放|摆|存|建|盖)(?:了|下|出|好|成)\s*(?:[1-9]\d*\s*(?:块|个|根|把|颗|件|张|座))?/
  ```

  数量那一段是 `(?: … )?`（可选），所以裸的"挖了""放好"就成立，等价于上方那条 `做好了|做成了|…` 的替代。注释写的"必须是动词+数字"并没有被实现。文本判据因此仍可被"做好了…"这类无条件文案骗过（现在靠 A/B 背包规则兜底，但只要 goal 含 `看/等/睡` 就绕过了）。

---

## 6. `src/actions.js`（#5 watchdog）

### C1（会错）watchdog 与所有任务无条件并发，会挖开脚下的功能方块

- **位置**：`src/actions.js:139-151`（`startWatchdog`）、`157-184`（`_checkStuck`）、`188-235`（`_rescue`）
- **问题 1（无协调）**：`_rescue` 不检查 `this.ctx.busy()`、不调 `this.check()`、不看 `this.cancel`，直接 `bot.dig` / `wander` / `walkToward`。任何"合法静止 30 秒"的行为都会被强制打断：`reflex.shelter()` 里的等待、`sleepInBed`、熔炉前的等待、技能里的 `for(...) await sleep(2000)`（`k_mwdr2g2a` 就是睡 6×2 秒）、以及正在跟人聊天。
- **问题 2（破坏性）**：判据是

  ```js
  if (below && below.boundingBox === 'block' &&
      !/bedrock|lava|water/.test(below.name)) { await bot.dig(below, true) }
  ```

  只排除基岩/岩浆/水。**箱子、床、工作台、熔炉、附魔台都满足条件**，而且 `home.js` 的家正是在脚边放这些。站在自家箱子前发呆 30 秒 → 把箱子挖了，里面东西撒一地。

  同类风险：站在 1 格深坑里挖脚下 = 继续往下掉；`_rescue` 第 2 步一次最多连挖 8 格 + `walkToward(900)`，整套下来可能持续 1 分钟（188-235 行），完全盖住任务本身。
- **证据**：`bot.dig(below, true)` 在 195-198 行；过滤条件只有 `/bedrock|lava|water/`；`_checkStuck` 全文（157-184）没有任何 busy/cancel 判定。
- **建议**：
  1. `_checkStuck` 开头加 `if (this.ctx.busy && this.ctx.busy()) return`（任务层自己会卡死检测，`main.js:1104-1118` 已有 60 秒 stall 检测，重复了）；
  2. 加功能性方块黑名单（chest/barrel/furnace/crafting_table/bed/...）和"脚下方块是容器就不挖"；
  3. `_rescue` 里每一步之前 `this.check()`，`cancel` 时立刻退出；
  4. 自救优先"跳一下/走两步"，把"挖脚下"放到最后（现在的顺序会把地板挖穿）。

---

## 7. `src/coder.js`（#8 技能核对）

### C2（会错）只核对"复用"，新写的假技能照样入库

- **位置**：`src/coder.js:67-81`（复用分支）vs `src/coder.js:138-145`（新代码分支）、`main.js:1146-1156`（`skills.add`）
- **问题**：`verifySkillEffect` 只在 `pickFor` 命中旧技能时调用；`writeAndRun` 第二段模型现写的代码直接 `markTask({reused:false, ok:true})` 并把 `result.code` 交给 main.js：

  ```js
  if (result.ok && verdict.ok) {
    if (result.code) this.skills.add({ name: 'k_' + Date.now().toString(36), desc: want.text, code: result.code, ... })
  ```

  也就是说**假技能的"出生"环节没有把关**，只是"长大之后被抓"。`k_mwe74ysb` 当初正是这样进来的。
- **建议**：把 `invBefore/posBefore` 提到 `writeAndRun` 入口，两段共用同一套 `verifySkillEffect`；`skills.add` 的入口也加一道（不通过就只记 `code`，不记 ok）。

### A1（会崩，低概率）`pos().clone()` 裸奔

- **位置**：`src/coder.js:68`
- **问题**：`const posBefore = this.actions.pos ? this.actions.pos().clone() : null` —— 只判了函数存在。`actions.pos()` 就是 `this.bot.entity.position`（`src/actions.js:262`），`bot.entity` 为 null（断线/维度切换瞬间）时 `TypeError: Cannot read properties of null`。抛出点在 `Promise.race` 里，会被 `main.js:1214` 的 catch 兜住，但这一轮任务会直接以"任务异常"收场、`markTask` 不记、技能不入库。
- **建议**：`try { … } catch (e) { posBefore = null }`（`main.js:1089` 的同款写法已经这么做了，直接照抄）。

### 顺带（只是不好看）

- `coder.js:81` 的 `markUse(..., fake: …)`：`markUse` 只存 `{at, ok, ms, error}`（`skills.js:536-543`），`meta.fake` 被静默丢弃 —— 这个信号是本次改动最有价值的产出之一，却没落盘。
- `coder.js:81` 的表达式 `out.ok === false && real.fake` 在"代码真的抛错"时也可能为真（`verifySkillEffect` 不看 `out.ok`），语义上不是"假成功"。建议 `const fake = real.fake && !outOriginallyFailed`。
- `verifySkillEffect(goal, skill, invBefore, posBefore, out)` 的 `out` 参数未使用。

---

## 8. `src/selfstate.js`（#12）

**没有发现问题。** 逐项核过：

- `describeTod`（49-59 行）七个区间的边界我都对了一遍（0/1000/11000/12500/13500/22500/23500/24000 覆盖无重叠无空洞），`null/undefined/NaN` 走第一行 return null。
- `snapshot()` 里 `bot.time.timeOfDay` 包在 try 里（121-128 行），`bot.time` 缺失不崩。
- `module.exports.describeTod = describeTod`（364 行）加了类属性，`require('../src/selfstate')` 拿到的是 class，挂静态属性合法；`test-unhuman-fixes.js:109` 已验证。
- `s.tod` 新增字段对旧快照对象向后兼容（`describeTod(undefined)` → null → 跳过整段）。
- 每轮只多两行 `lines.push`，无热路径成本。

---

## 9. 性能（第 ④ 项）

**没有发现热路径上的昂贵操作**，逐项核过：

| 热点 | 频率 | 成本 | 结论 |
|---|---|---|---|
| `actions._checkStuck` | 3 s | 距离比较 + 1 次 `clone()` | 可忽略（真正的问题是副作用，见 C1） |
| `spont.scanPeople` | 4 s | 遍历 `bot.players`（几十项）+ `distanceTo` | 可忽略 |
| `spont.tick` | 4 s | 队列 ≤30 排序 + 正则 | 可忽略 |
| `mood.tick` | 每心跳 | 常数 | 可忽略 |
| `skills.search` | 每任务 1–2 次 | 候选 ≤50，每个算 2 次 `hasUnconditionalReturn`（整段 split + 逐行回溯） | 毫秒级，但重复计算（D1） |
| `coder.snapshotInv` | 每任务 2–3 次 | ≤36 格 | 可忽略 |
| `judgeOutcome` | 每任务 1 次 | 十几个正则 + 一次 snapshot | 可忽略 |

唯一值得改的是 D1（重复计算）以及 `skills.search` 里对**每个**候选都跑一遍正则打分的既有写法（本次没动，不扩大范围）。

---

## 10. 不在本次 diff、但紧邻改动、会让上面所有判据失效的既有 bug

### F1（会错，既有，4dc6627 就有）制作类任务永远判"数量没变"

- **位置**：`main.js:1295-1299`
- **问题**：任何 `X→Y` 形式且**没有任何一处 Y>X** 就判失败：

  ```js
  const arrows = [...t.matchAll(/(\S+)\s*(\d+)\s*(?:→|->|>)\s*(\d+)/g)]
  if (arrows.length) { const gained = arrows.some(m => Number(m[3]) > Number(m[2]))
    if (!gained) return { ok: false, why: `背包数量没变（…）` } }
  ```

  制作天然是"原料减少"：
  ```
  FAIL "做一把石镐" / "做好了石镐，圆石 12→8，木棍 4→2"        -> 背包数量没变（12→8、4→2）
  FAIL "造个工作台" / "消耗木板 8→4，多了工作台一个"           -> 背包数量没变（8→4）
  FAIL "烤点木炭"   / "烧成 2 个木炭，原木 5→3"                -> 背包数量没变（5→3）
  ```
- **为什么现在更要命**：#8 之后 main 又加了一层"背包必须涨"（B2），两层叠加后，**制作类任务几乎不可能被判成功**，而制作是本 repo 最主要的任务类型（数据里 38 个技能有 12 个是 craft 意图）。
- **建议**：`arrows` 判定只在"没有任何 gained 迹象"时启用；至少允许"目标产物增加"（`extractWantedItem` 已经在项目里，`main.js` 里写着"判据 3"但没实现）。

### F2（会错，既有 + 本次改了调用名）`botChain` 数的是"收到的消息"，第 4 条起静音 2 分钟

- **位置**：`src/talk.js:237-244`、`769-771`
- **问题**：`botChain.push` 发生在 `mentioned/isQuestion` 判断**之前**，且只记录"收到 botlike 消息"，不记录"我们回了没有"。于是任何名字命中 `looksLikeBot`（`/^(bot|ai|npc|_bot|bot_|XJJ\d+|Test\d*)/i`，注意 `Test\d*` 能匹配 `Test`、`Testament` 等）的**真人玩家**，2 分钟内的第 4 条消息起就被整体静音，日志只有 `[chain] … 已经聊了 3 轮`。注释写的是"聊了 3 轮"，实际是"收到 3 条"。
- **建议**：`botChain` 只在"我们真的回了"之后 push；阈值改成按"我们的发言数"计；`looksLikeBot` 的 `Test\d*` 收紧成 `Test\d+$`。

---

## 11. 我查了但没发现问题的地方（免得别人重复查）

- `main.js` 的 `startWatchdog()` 调用点（335）在 `onSpawn` 内、`new Actions` 之后，`_checkStuck` 有 `bot.entity` 判空 —— 不会在未 spawn 时崩。
- `spont.tick(this.talk)`（`main.js:1002`）没传第二个参数，靠 `talk.bot` 兜底，`Talk` 构造里确实存了 `this.bot` —— 能拿到 bot，`scanPeople` 不会空跑。
- `noteLateNight` 里 `spontaneous.onLateNight()` 是模块级导出（`spontaneous.js:453`），`this.spont.push` 存在 —— 不会 ReferenceError（但按 B11 说不出来）。
- `actions.js` goto 的起步宽限：`goalSetAt=0` 后 `Date.now()-0` 远大于 900，`inGrace` 恒 false，不会死循环；`continue` 前都 `sleep`，没有忙等。
- `skills.hasUnconditionalReturn` 的 `indent > 2 → return false` 对**缩进 4 的 return** 会漏判，但真实技能体都在 0/2 缩进，实际没触发（用真实数据验证过：39 个技能里没有因这条漏判的）。
- `selfstate`（整文件，见 §8）。
- `scripts/probe-unhuman.js`：`AIFRIEND_DATA` / `AIFRIEND_CONFIG` 两个环境变量 `main.js:37-42` 都真的读了，隔离生效；临时 config 会清理；`console.log` 劫持在 `require(main.js)` 之后，能捕到日志。没有发现会污染 `data/runtime` 的路径。
- 提交自带的 `scripts/test-unhuman-fixes.js` / `test-talk-dedup.js`：全部通过，**但它们测不到本文任何一条**（`test-unhuman-fixes` 直接调 `rest()`；`test-talk-dedup` 的"不同的人说同一句"用的是两条不同回复文本 `['在','嗯']`，恰好绕开了 B12）。

---

## 12. 复现方式

所有验证都在 `git archive 112917d` 解出来的干净快照里跑（不碰工作区）：

```bash
mkdir -p /tmp/rev && cd /root/workspace/minecraft-AIfriend
git archive 112917d | tar -x -C /tmp/rev/tree && cd /tmp/rev/tree
node scripts/check-syntax.js
node scripts/test-unhuman-fixes.js      # 27/27
node scripts/test-talk-dedup.js         # 30/30
```

关键复现片段（都在快照目录内执行，不写任何仓库文件）：

```js
// B2：main.js 判据误杀
const { Bot } = require('./main.js'); const Vec3 = require('vec3').Vec3
const j = (g,o,b,a,x,y) => Bot.prototype.judgeOutcome.call(
  {_taskStartInv:b, snapshotInv:()=>a, _taskStartPos:x, bot:{entity:{position:y}}}, g, o, 0)
j('弄点吃的，别饿着','吃了个面包',{bread:3},{bread:1},new Vec3(0,64,0),new Vec3(0.2,64,0.2))
// → {ok:false, why:'背包没有任何增加（3->1 个）…'}

// B3/B4：coder 判据误杀
const { Coder } = require('./src/coder.js')
const c = Object.create(Coder.prototype)
c.actions = { pos: () => new Vec3(6,64,4) }
c.bot = { inventory: { items: () => Object.entries({stone_pickaxe:1,dirt:7,cobblestone:5}).map(([name,count])=>({name,count})) } }
c.verifySkillEffect('找个安全的地方待着', {desc:'先找个安全的地方待着，别乱跑'}, {dirt:10}, new Vec3(0,64,0), {ok:true})
// → {ok:false, fake:true, why:'技能说去了，但只移动了 0.0 格'}

// B12/B13：talk 复读拦截跨人 + followUp 吞失败
// llm 固定返回同一句 → 第二个人的 reply 返回 false、sent 只有 1 条；
// followUpDeferred 返回 true 但 sent 为 0 且 hasReplied === true。

// B7：spont 队头阻塞（见 §4 证据）
// B1：mood.state() 在 energy=0 时恒 'tired'，且 grep 不到 rest()/onEvent('rest'|'food') 的生产调用方
```

---

## 13. 给 Lead 的优先级建议

1. **必须先修**（会让运行数据全部失真）：B2、B3、B4、F1 —— 这四条一起把"成功/失败"这个最底层信号弄脏了，`mood` / `goals` / `skills` 全建在它上面。
2. **然后修**（会持续放大问题）：B1（energy 不恢复）、B6（罚分全员+候选池缩水）、B7（队头阻塞）、C1（watchdog 挖箱子）。
3. **再修**（局部体验）：B8、B9、B12、B13、C2。
4. 文档/注释类（B10、B14、B15、C3、D1、A1）最后一起清。

> 注：写本报告时工作区已有其他 agent 针对 B1（rest 周期）、B8（`_talk.mem`）、B9（去掉 `/^XJJ/`）、B11（直接 speak）、B3/B4 的一部分（`isMove`）打了未提交补丁。**本文按 `112917d` 的实际内容记录**，交付前请以 `git diff 112917d` 复核哪些已经修掉、哪些只是部分修。

---

# 附录（2026-11-13 21:40 复核工作区当前状态）

> 上一部分是 `112917d` 的静态审查。这一部分是 Lead 要求继续跟的两条：
> **① `coder.js` 的搬/换/吃误杀；② 两套判据并存。**
> 复核对象是**工作区当前状态**（`main.js` 已由 Lead 加了 arrows 例外，`coder.js` 已由他人加了 `worldSig/worldDiff/isStay/isMove`），行号以复核时（21:4x）为准。

---

## 14. 复核 Lead 的 arrows 例外（制作类救回来了，吃东西类没有）

### 14.1 例外本身写对了，但**只覆盖"输出带 A→B 箭头"的情况**

`main.js:1384-1427` 的例外块整体在 `if (arrows.length)` 里面。产出这种文本才有箭头；真实运行里模型/技能大多写自然语言。

| 目标 | 输出文本 | judgeOutcome | verifyTaskEffect（真正的批准权） |
|---|---|---|---|
| 弄点吃的，别饿着 | `弄点吃的，面包 3→1` | **PASS** 吃了（食物减少属正常） | **FAIL** 背包没增加（5->2） |
| 弄点吃的，别饿着 | `吃了个面包，饱食度 17` | **FAIL** 背包没有任何增加 | FAIL |
| 弄点吃的，别饿着 | `吃了两个面包、一块牛排，饱了` | **FAIL** 背包没有任何增加 | FAIL |
| 弄点吃的，别饿着 | `填饱了，面包 3→1` | PASS | FAIL |
| 做一把石镐 | `做好了石镐，圆石 12→8，木棍 4→2` | PASS 做成了 | PASS ✅ |

**结论**：制作类真的修好了；**吃东西类只在"输出恰好写成 数量→数量" 时才生效**，而这一次改动里最典型的自然语言写法反而漏掉。

### 14.2（关键）成功门是三个与，`verifyTaskEffect` 里没有 eat/craft 的豁免 —— 例外被下一道闸否掉

`main.js:1240`：

```js
if (result.ok && verdict.ok && proof.ok) { … 完成 … } else { … 失败 + mood.onEvent('task_fail') … }
```

`verifyTaskEffect`（`main.js:1691-1786`）里只有：目标产物（1740）、产出型（1752）、放置型（1766）、走/搬（1776）、兜底（1782）。**没有 isEat / isCraft / isEquip 分支**。所以：

- 「弄点吃的，面包 3→1」→ `verdict.ok = true` 但 `proof.ok = false` → 仍然走失败分支 → `mood.onEvent('task_fail')`（烦躁 +0.05、`_angeredAt` 刷新）+ 写失败记忆 + `reportTaskResult(false)`。
- 也就是说 Lead 验证的"✓ 弄点吃的，面包 3→1 → 吃了"**只验证了一半的闸**。

**建议**（最小改动）：把 `isEatTask` / `isCraftTask` 的判定提到 `judgeOutcome` 外层（不依赖 arrows），并在 `verifyTaskEffect` 里加同样的两个分支，判定条件用**食物总数下降**（eat）和**目标产物 +1**（craft），而不是文本。

### 14.3 `failWord` 里的 `缺` 会误杀

`main.js:1414`：`const failWord = /(做不出|做不了|没做成|没做好|搞不定|弄不到|缺|失败)/.test(t)`。
「吃了点东西，但还缺木头生火」这种句子会被 `缺` 判成失败。建议去掉 `缺`（它太常见，且"缺材料"已有专用判据 `main.js:1377` 的 `材料不够|材料不足`）。

### 14.4 顺带确认：`isMove` 已把"搬到"救回来

`coder.js:292` + `main.js:1722` 的 `isMove` 生效，「把那个熔炉挖了搬到山顶上去」在 coder/verifyTaskEffect 里都 PASS（见 §15 的 ①）。这条可以关掉。

---

## 15. 两套判据并存 —— 现在是**三份实现 + 四份重复资产**，实测不一致率 42%

### 15.1 重复清单（同一件事写了几遍）

| 能力 | coder.js | main.js | 差异 |
|---|---|---|---|
| 世界快照 | `worldSig` 203 / `worldDiff` 220 | `worldSig` 1654 / `worldDiff` 1672 | 两行代码一模一样，各自维护 |
| 判据主函数 | `verifySkillEffect` 253-370 | `judgeOutcome`（文本）+ `verifyTaskEffect` 1691-1786 | 三份，semantic 不同 |
| 分类词表 | `isProduce` 285（19 词） | `isProduce` 1529/1719（22 词，多 找点/弄点/弄到/搞到） | 两套 |
| | `isConsume` 286 | `isConsume` 1530/1720 | 同 |
| | `isTravel` 287 | `isTravel` 1723（少 搬家/搬到） | 不同 |
| | `isStay` 336 | `isStay` 1725 | 后来补的，两处各写一遍 |
| 目标产物表 | `WANT_MAP` 23-47 + `wantedItemOf` 40 | `extractWantedItem` 1795+ | **同一张表两份**，还都踩了同一个坑（见 15.3） |
| 输入文本 | `goal + ' ' + desc` | 只有 `goal` | **这一条是分歧的总开关** |

### 15.2 实测：同一份证据，两个判据给出相反结论

用 38 个真实技能 × 3 种世界状态（快照 `/tmp/rev/skl/skills.json`，桩世界按绝对坐标哈希）：

| 场景 | coder PASS | main PASS | **结论不一致** |
|---|---|---|---|
| S1 什么都没变（假成功） | 4/38 | 4/38 | 0 |
| S2 真的挖了 2 格、背包没涨（挖通道类真成功） | 20/38 | 4/38 | **16 个（42%）** |
| S3 背包 +3（真产出） | 18/38 | 15/38 | **11 个（29%）** |

S2 的不一致样例：

```
k_mwdwscmb  coder=PASS main=FAIL 「先搭个简易庇护所把箱子放进去，腾出背包空间」
k_mwds22uu  coder=PASS main=FAIL 「把背包里的树苗种下去，等它们长成树再砍木头」
k_mwdtztmz  coder=PASS main=FAIL 「把三只箱子摆好，将多余的石镐、圆石和泥土分类存进去」
k_mwdu5zyv  coder=PASS main=FAIL 「把两个熔炉和合成桌摆到庇护所里，用圆石烧点木炭」
```

后果不是"某趟任务判错"，而是**同一次运行两个模块记账相反**：`coder` 把它记成 `markUse(ok)`（成功率上升、下次更容易被 `pickFor` 复用），`main` 把它记成失败（`task_fail`、烦躁 +0.05、目标进度 0、`reportTaskResult(false)`）。任何拿"成功率/完成率"做验收的数据都会被这两套判据搅浑。

### 15.3 两边共有的一个错：把"工具名"当成"要产出的东西"

`wantedItemOf` / `extractWantedItem` 都是**表里第一个被文本包含的中文词**就当目标产物，于是"用石镐挖圆石"要求 `stone_pickaxe +1`：

```
"用石镐挖圆石"        → stone_pickaxe   （真目标是 cobblestone）
"用石斧砍树"          → stone_axe       （真目标是 oak_log）
"把石镐拿在手上"       → stone_pickaxe   （这是装备任务，不该要求 +1）
"用木镐挖点石头顺便砍树"  → wooden_pickaxe
```

`coder` 因为拼了 `desc`，触发面更大。实测 38 个真实技能里有 **14 个**首个命中是工具名：

```
k_mwdx4vb0 「用石镐把庇护所附近暴露的石头和安山岩挖下来」→ 要求 stone_pickaxe
k_mwduesmg 「用石镐把庇护所旁剩下的铜矿全挖下来收进背包」  → 要求 stone_pickaxe
k_mwdx4mzx 「用木斧把庇护所西侧剩下的树叶清掉」           → 要求 wooden_axe
…
```

**建议**：先剥掉 `用X/拿X/手持X` 这类工具短语，再抽取产物；或要求产物出现在"做/造/合成/攒/挖到/收集"的**宾语位置**（前后各 6 字内）。

### 15.4 两边共有的第二个错：世界快照的**坐标帧错位**（让"方块变了"这个维度整体失真）

`worldSig(pos)` 的 key 是**相对 base 的偏移** `dx,dy,dz`，而第二次快照用的是**当前 pos**。只要人动了，两组 key 指向的就是不同坐标的方块：

```
没动、什么都没挖            → worldDiff = 0     ✅
没动、挖了 3 格             → worldDiff = 3     ✅
动了 2 格、什么都没挖        → worldDiff = 482   ❌（应为 0）
动了 2 格、只挖 1 格         → worldDiff = 482   ❌（真实变化被噪声淹没）
动了 20 格、什么都没挖       → worldDiff = 492   ❌
```

（`main.worldDiff` 是同一份逻辑，结果相同。）

于是 `worldChanged` 实际等于"**他动过没有**"：任何会走动的假成功都会被判"世界变了"。`k_mwe74ysb` 这类"到处走、什么都没捡"的技能正好属于此列——它能被抓住只因为另外还有 `wantedItem(圆石)` 兜着；一旦目标里没有表内物品（如"攒点木头""采点蘑菇"），就直接放行。

**修法（两行）**：key 改成绝对坐标，并只比较交集：

```js
// 现在
sig[dx + ',' + dy + ',' + dz] = b.name
// 改成
sig[(base.x + dx) + ',' + (base.y + dy) + ',' + (base.z + dz)] = b.name
```

改完上面的 5 行应当变成 `0 / 3 / 0 / 1 / 0`。

### 15.5 `isStay` 关键词过宽，会把"零变化的干活"放过

S1（什么都没变）里总共只放过 4 个技能，其中 2 个是误放：

```
k_mwduk870 「往上刨几格看看头顶那片花岗岩后面是不是藏着什么」→ 因 "藏" 命中 isStay（"藏着什么" ≠ 躲藏）
k_mwdteq0d 「挑一块安山岩搬到脚边垒成凳子，坐上去歇着」      → 因 "歇" 命中 isStay，把 isMove 盖掉
```

建议：`isStay` 用整词/句尾匹配（`待着|躲起来|睡|歇会儿|守着`），并让 `isMove`/`isProduce` 优先于 `isStay`（现在 `isStay` 是"一票放行"）。

### 15.6 建议的统一方案：`src/judge.js`（单一判定器）

不要继续在三处维护同一套正则。核心改动是**用"证据维度"代替"任务分类"**：

```js
// src/judge.js
// 唯一出口：一次任务只能有一个结论
// ctx = { kind, before:{inv,pos,held,world}, after:{inv,pos,held,world}, outText, goal }
function judgeTask (ctx) → { ok, progress, why, evidence }
```

规则（按顺序，命中即返回）：

| 顺序 | 规则 | 说明 |
|---|---|---|
| 0 | **文本只做否决**：输出里有失败词（做不出/没做成/材料不够/超时…）→ fail | 保留 `judgeOutcome` 前半段，去掉它的"批准权" |
| 1 | **fake 清零**：四维度（inv/方块/位移/手持）全都没变，且不是 `stay/social` 类 → fail | 这一条就足以杀掉 `k_mwe74ysb` 这类，且不会误杀搬/换/吃/待着 |
| 2 | **目标产物**（仅当 goal 里出现"做/造/合成/攒/收集 + 物品"，且该物品**不是**"用X"里的工具）→ 要求该物品 +≥1 | 修 15.3 |
| 3 | 其余 → ok（progress = 变化量） | |

配套要点：

1. `worldSig` 用**绝对坐标**（15.4），快照只在任务开始/结束各拍一次（现在 coder + main 各拍两次 = 4 次 × 605 格 = 2420 次 `blockAt`/任务）。
2. 快照里加 **`held`**（`bot.heldItem?.name`），否则"换/拿装备"类任务永远没有证据（现在 `verifyTaskEffect` 判「把石镐拿在手上」= "这一趟什么都没发生"）。
3. `eat`：用"食物总数下降"或"饱食度上升"当证据，别用关键词。
4. `craft`：产物 +1，别用箭头文本。
5. `stay`/`social` 类允许零变化（白名单），但**不能覆盖 `isMove/isProduce`**（15.5）。
6. 迁移顺序：先让 `coder.verifySkillEffect` 调 `judgeTask`（只换实现不改调用方），跑 §15.2 的三组场景对比；再删 `verifyTaskEffect`，改 `main` 的 1240 行；最后删 `judgeOutcome` 的后半段（背包/文本判据）。

### 15.7 验收向量（谁实现谁跑这张表）

| # | goal | 世界/背包变化 | 期望 |
|---|---|---|---|
| 1 | 把那个熔炉挖了搬到山顶上去 | 净零、位移 10 | **ok** |
| 2 | 找个安全的地方待着 | 零变化 | **ok**（stay） |
| 3 | 弄点吃的，别饿着 | 面包 3→1、位移 0 | **ok**（eat） |
| 4 | 换一把石镐拿在手上 | 背包不变、held wooden→stone | **ok**（equip） |
| 5 | 做一把石镐 | 圆石 12→8、石镐 +1 | **ok**（craft） |
| 6 | 用石镐挖圆石 | 圆石 +5 | **ok**（不能要求石镐 +1） |
| 7 | 在附近地上捡够垫脚的石头 | 什么都不变、走了 3 格 | **fail**（fake） |
| 8 | 往上刨几格看看 | 什么都不变 | **fail**（不能因"藏"放过） |
| 9 | 攒点木头 | 什么都不变、走了 6 格 | **fail** |
| 10 | 去山那边看看 | 位移 20、背包不变 | **ok**（travel） |

> 这 10 条在**当前工作区**的结果：1/2/5/10 通过；3/4/6/8/9 会判错（3、4 见 §14/§15.1，6 见 15.3，8 见 15.5，9 见 15.4 的坐标帧缺陷 + 无 WANT_MAP 项）。

---

**复核基线（可复现靶子）**：`main.js` sha256 `99d360c7947175d1…`、`src/coder.js` sha256 `d7c3931732d43959…`（2026-11-13 21:5x）。
两个文件当时都有其他 agent 的未提交改动，数字只会随它们继续变动——上面的 S1/S2/S3 与坐标帧测试都可以用文中的桩代码在 1 分钟内重跑，改动后请重新取数再下结论。
