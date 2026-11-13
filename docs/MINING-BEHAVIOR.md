# 采矿行为研究：真实玩家怎么挖，我们应该怎么挖

> 起因（用户原话）：
> 「他也可以去挖那些山吧，不一定非要去地下挖吧，如果有问题请反驳我，我们一起讨论」
>
> 结论先说：**用户说得对，而且有硬证据支持**。煤/铜/铁不需要下竖井，游戏 wiki 自己就建议「从洞口进去，浅层洞穴就有大量煤铜铁」，社区里票数最高的「挖矿效率」回答也说「别自己打隧道，去找天然洞穴系统，暴露的方块多得多」。
>
> 但有两处要反驳/补充：
> 1. **露头矿比想象少**：wiki 明确写「矿脉在洞穴壁上生成时，有 50% 概率这次生成被取消」——所以「山坡捡矿」能捡到的是**零散的、好看的**，不是效率来源。真正效率来源是**走进洞穴顺着走**，不是站在山坡上捡。
> 2. **「效率党」的真实答案是下到基岩然后挖矿道**（社区 358 票问题下的 260 票回答）。所以真实玩家是**两派并存**，不是一派对。我们的目标池现在只有「深部」这一派 —— 这才是 bug，不是「深部」本身错。

---

## 0. 一个前置声明：我查到了什么、没查到什么

| 想查的 | 结果 |
|---|---|
| 矿石分布在哪些 y 层 | **查到了**，Minecraft Wiki 明确列出（见 §1.1） |
| 地表/山坡/洞口能不能拿到煤铜铁 | **查到了**，wiki 自己就这么建议（见 §1.2） |
| 洞穴路线 vs 自打竖井，哪个效率高 | **查到了**，wiki 与社区高票回答一致（见 §1.2、§1.4） |
| 「休闲玩家 vs 效率党」的具体差异 | **部分查到**，来自 wiki 的玩法分类和社区回答，不是统计数据 |
| 「地表采集占多少比例」 | **没查到**。没有任何公开的、按玩家人均统计的比例数据 |
| 「多久上一次地面」 | **没查到统计**。只有玩家自述（「挖上一个小时」「几天不回来」），样本是个人陈述不是分布 |
| 「挖矿在休闲玩法里占多少时间」 | **没查到百分比**。最接近的是 HeapCraft 的遥测研究，但它没发布四类行为的时长占比 |

**关于「没查到」的部分，本文以下标注为「推断」，不冒充数据。**
搜索引擎这块也说明一下：本机环境里 Google / DuckDuckGo / Reddit / Wikipedia 都不可达，Bing 返回的是被缓存的通用页（对任何查询都给同样的中文结果，等于不可用）。实际能用的通道是 **Minecraft Wiki 直连、Stack Exchange API、arXiv 的 export 镜像、GitHub API、OpenAlex**。所以下面每条来源都是我真抓下来的原文，不是凭印象写的。

---

## 1. 真实玩家行为：查到的证据

### 1.1 矿石分层（决定「要不要下去」的物理事实）

Minecraft Wiki `Tutorials/Mining` 的 Mining layers 表（1.18+）：

| 矿 | 分布 | 峰值 |
|---|---|---|
| 煤 | Y > -1 | Y=95、Y=136（**都在山体高度**） |
| 铁 | Y > 80 与 Y < 72（**两条带**） | Y=16 与 **Y=232** |
| 铜 | Y=-16 ~ 112 | Y=48 |
| 金 | Y < 32；恶地生物群系里额外 Y=32~256 | Y=-16（恶地那条带在山体表面） |
| 青金石 | Y < 64 | Y=0 |
| 红石 | Y < 16 | Y=-58/-59 |
| 钻石 | Y < 16 | **Y=-58/-59** |
| 绿宝石 | Y=-16 ~ 320，**只在山地生物群系** | **Y=236（山顶）** |

原文补充两句关键的话：
- 「Layers 10 to 15 are usually considered the best levels… **Post Caves and Cliffs, deepslate layers between -59 to -54** have the best chances for players seeking diamonds and redstone.」
- 「The single best layer for mining is highly debated and is not agreed on.」

**这条直接支持用户**：煤和铁的峰值一条在 y=95/136，一条在 y=232 —— 那本来就是**山地地形的高度**。铁矿有整整一条上部带在 y>80，挖山挖到的正是这条带。绿宝石更是**只**在山地、峰值 y=236，是「挖山」独有的奖励，地下反而挖不到。

### 1.2 wiki 自己就建议「别打竖井，走洞口」

`Tutorials/Mining`，Cave mining 一节，原文：

> 「**Find one of the many caves that opens to the surface, and start exploring that**, generally working the way downwards. **Even shallow caves offer plenty of coal, copper and iron**, and later on, gold and other ores. Caves offer the advantage that a great deal of stone has already been excavated for the player, exposing many blobs.」

> 「Cave mining has a **high return on investment, yielding more ore per unit time and requiring fewer tools** (less pickaxe and shovel durability is lost mining stone, dirt, and gravel) than other approaches.」

关于「露头矿少」的那条反面证据（我说的「要反驳一半」就在这里）：

> 「Another disadvantage to cave mining is that **when ores generate exposed in a cave, they have a 50% chance of the generation being cancelled.** Therefore, the ore amount per chunk is lower in chunks where there is a big cave.」

### 1.3 一趟下去要待多久：wiki 的备战清单就是「时长刻度」

`Tutorials/Mining`，Preparing to mine：

> 「Longer mining sessions should facilitate more preparation.」
> 「Players may want to bring straw beds **if they plan to go mining for a long time**, so they do not have to go back to their house to sleep, however it may not be too helpful if they decide to go down to a level far below the surface **where you may not return for a few days**.」
> 「Always remember to bring a good amount of wood (**2 stacks is preferred**)…」
> Cave mining checklist：「**Torches**. At least **a full stack** is recommended, and the more the player can carry, the better.」「If you are further along in the game, and expects to mine for a while, **bring two iron pickaxes and at least 3-8 stone pickaxes**.」

**这里藏着一个特别好用的设计线索**：wiki 把「带多少火把」当成赶路预算 —— 一整组火把 = 一趟的照明额度。真实玩家的「该上去了」不是看表，是**看火把还剩几根 / 镐还剩多少耐久 / 背包满了**。这是可编程的退出条件（见 §3.3）。

### 1.4 社区高票答案：两派都真实存在

Stack Exchange Gaming 问题 *What's the most efficient Minecraft mining strategy?*（358 票，28 个回答），我抓到的高票回答：

- **260 票（效率派的标准答案）**：「Branch mining is the most efficient. **You dig down to the bedrock**… every 4 squares on either side of the trunk, you dig perpendicular tunnels extending out 20 blocks.」
- **81 票（洞穴派，正对我们的问题）**：「**If you're not married to building a completely man-made mine, the answer is to find a deep tunnel.** Getting down to the bottom is correct… but **digging a tunnel doesn't expose you to nearly the same amount of blocks as using a generated cave system.**」
- **68 票（长时段派）**：「Just dig 2 high in one direction **for a very long time, say around an hour**…」
- **58 票（住矿里的那一派，注意这条很关键）**：「In regards to getting to and from your mine: **My solution is to never leave the mine.** Bring down some saplings, some wheat seeds… and build your base underground near your mine.」

**58 票这条要特别留意**：真人确实有「干脆住矿里」的玩法。所以「必须每隔 N 分钟上来一次」不是玩家事实，是**我们的产品选择**（因为用户抱怨的是「每次见他都在地下」这个单调症，不是「地下不合法」）。§3 里我把这两件事分开：**一趟有时长上限**是工程需要，**「上来之后不许立刻再下去」**才是解决用户抱怨的那一条。

### 1.5 有真实遥测的学术研究（能引用的最硬的一条）

Müller et al., *Statistical Analysis of Player Behavior in Minecraft*, FDG 2015（ETH Zürich / Disney Research，HeapCraft 项目）。我抓的是白玫瑰大学仓库的 PDF 全文：

- 采集周期 **62 天**，其中 **14 person-days** 的有效游玩
- 记录事件里 `BlockBreakEvent` **252,438** 次（排在 `PlayerMoveEvent` 之后）
- 作者把玩家行为分成四类：**Building / Mining / Fighting / Exploring**（原文 Figure 1 的标题就是这四个词）
- 用 2 分钟时间窗做分类，**准确率约 65%**
- 空间图上：地下基地「feature more distinct edges」，矿道是「straight, dark lines」，地表游走是「light, random paths」

**它的价值和它的边界都要说清**：
- 价值：证明「Mining 是四大主行为之一」是有数据支撑的，且矿道在地图上**形状可辨**（直、暗、成线）—— 这可以反过来当我们的验收特征。
- 边界：**论文没有发布四类行为的时长占比**，所以「挖矿占休闲玩法多少时间」这个数我不能编。它连分类本身都只有 65% 准确率（原文自己也说「Building a house inside a mountain could (and possibly should) be measured as mining」）。

### 1.6 大数据集给出的规模感

- **MineRL**（Guss et al., arXiv:1907.13440）：**1,002 个**不同玩家的对局、500+ 小时演示数据；原文「coverage of the full item hierarchy by one player **takes several hundred hours**」；「**Diamonds are central to high-level Minecraft play**, and a large portion of gameplay centers around their discovery.」
- **MineDojo**（arXiv:2206.08853）：**730,000+** 带解说的视频、合计 **33 年**时长、22 亿词字幕。

这两条只能说明「矿是 Minecraft 的核心活动、人类要几百小时才走完全部内容」，**不能**推出「一趟多久」，我不拿它当行为数据用。

### 1.7 同类 bot 项目是怎么设计采矿任务的（工程参考，最有用的部分）

**(a) Baritone —— 数量驱动的「够了就停」**
`src/main/java/baritone/process/MineProcess.java`（我抓的 1.21.4 分支，547 行）：

```java
private int desiredQuantity;
...
if (desiredQuantity > 0) {
    int curr = ctx.player().getInventory().items.stream()
            .filter(stack -> filter.has(stack))
            .mapToInt(ItemStack::getCount).sum();
    if (curr >= desiredQuantity) {
        logDirect("Have " + curr + " valid items");
        cancel();          // ← 一到数就 cancel，不会"顺手再多挖点"
        return null;
    }
}
```
另外它有 `blacklistClosestOnFailure`：够不着就**把那个矿点拉黑**换下一个，而不是反复扑同一个。

启示：**采矿任务的终止条件是「背包里的数量」，不是「挖到累了」**。我们 `dailyQuota` 走的是同一条路（对的方向），但退出是靠分数扣，不是靠数量到点。

**(b) Voyager —— 任务必带数量，找不到就换方向走**
`voyager/prompts/curriculum.txt`：

> 「The next task should follow a concise format, such as "**Mine [quantity] [block]**"…」
> 「**Do not ask me to build or dig shelter** even if it's at night. I want to explore the world and discover new things. I don't want to stay in one place.」
> 「Only repeat tasks if necessary.」

`voyager/prompts/action_template.txt`：

> 「Use `mineBlock(bot, name, count)` to collect blocks. **Do not use `bot.dig` directly.**」
> 「Use `exploreUntil(bot, direction, maxDistance, callback)` **when you cannot find something**. You should frequently call this before mining blocks… **select a direction at random** every time instead of constantly using (1, 0, 1).」
> 「`maxDistance` should always be **32** for `bot.findBlocks`… Do not cheat.」

启示两条，都很对我们的胃口：
1. **「找不到就横着走出去找」是主流做法，不是「往下挖」**。Voyager 明确要求随机方向探索，禁止一直用同一个方向 —— 我们 `actions.wander()` 是随机角度，这点已经对了。
2. **任务必带数量**（Mine 5 iron_ore），不带「挖到够用为止」。

**(c) 三个项目共同的形态**：任务都是 `动词 + 数量 + 对象`，都是**单句、可验证、有时限**，没有一个是「下去挖矿」这种**不带数量、不带边界的地理指令**。这正是我们 POOL 里 `iron` / `diamond` 的病根。

---

## 2. 现有设计的错误（逐条对照 `src/goals.js`）

> **行号警告**：`goals-fixer` 正在并行改 `goals.js`（我写这份文档时文件已经从 1278 行涨到 1815 行）。**行号会漂，请以引号里的原文为准**，用 `grep -n "原文片段"` 定位。

### 错误 1（核心）：「下去」被写进了任务标题，模型会照着往下挖

`src/goals.js:216`
```js
{ kind: 'gather', title: '带够火把和吃的，下去挖矿', need: { torch: 8, '#food': 4 } },
```
`stageIntent()`（`goals.js` 约 1642 行）里还给这句话配了执行细则，于是这句会原样进到 will/LLM 的任务里。

**问题**：铁矿在 Y>80 和 Y<72 都有带，洞口、山体、浅层洞穴都能拿到（§1.1、§1.2）。写死「下去」等于**把 90% 的可达矿源排除**，只留下最深那条路。这不是「偏好深部」，是「只有深部」。

**改法**：把「去哪挖」从标题里拿掉，改成**由 pickTier 和已探明环境决定的地点**（见 §3.1 的 A/B 两条目标）。标题只写「弄到 X 块粗铁」。

### 错误 2：钻石的 y 坐标是 1.17 时代的，1.21 里是错的

`src/goals.js:243`
```js
{ kind: 'depth', title: '往下挖到很深的地方', need: { y: 16 } },
```
**wiki 原文**：钻石「most common at **Y=-58 and Y=-59**」；「Layers 10 to 15」是**Caves & Cliffs 之前**的老建议。

y=16 在新版里是「钻石分布的边缘」，往下还有 70 多格才是峰值。也就是说：**他挖到 y=16 就以为到位了，然后在一个产出很差的层里空转** —— 这能解释一部分「下去了但进度不动」。

**改法**：`need: { y: -54 }`（-59~-54 是 wiki 给的安全最优带），文案改成「往下挖到基岩上方那几层」。

### 错误 3：钻石目标的阶段顺序反了 —— 火把在下井之后才备

`src/goals.js:242-245`
```js
{ kind: 'craft',  title: '先弄把铁镐，不然到深层白跑', need: { item: 'iron_pickaxe', n: 1 } },
{ kind: 'depth',  title: '往下挖到很深的地方', need: { y: 16 } },      // ← 先下去
{ kind: 'gather', title: '带够火把，别在下面摸黑', need: { torch: 16 } }, // ← 再找火把
```
**wiki 原文**：「Torches. Light is the key to survival. **At least a full stack is recommended**」——照明是**下井前**的事，不是到了 -54 层再去找。

**改法**：`craft 铁镐 → 备火把/水桶/吃的 → depth → 采集 → surface`。顺序错一级，整条链在深层就会因为没光而卡住（而 `mine()` 在黑暗中还会被判成 `isUnderground` 触发回地面逻辑，来回折腾）。

### 错误 4：`#surfacestone` 里混进了深板岩 —— 地表永远攒不满

`src/goals.js:108`
```js
case '#surfacestone': return sum(/^(cobblestone|stone|cobbled_deepslate)$/)
```
`cobbled_deepslate` 只由深板岩掉，深板岩只生成在 **Y<0 的深层**。把它算进「地表石头」，含义就自相矛盾：`house` 要 48 个、`tower` 要 40 个，只要他开始挖到深板岩，计数就会**在地表突然满足** —— 反过来，如果他在山上（只有 stone/cobblestone），计数就永远差一点。

这跟 §1.1 的「山体有大量暴露石头」正好相反：**山上的石头本来最该算数**，代码却把地下的那部分也算成地表。

**改法**：`#surfacestone` 只留 `cobblestone|stone`；深板岩单独给个 `#deepstone` 键（现在没人用，留着以后做深层任务）。

### 错误 5：三个目标都要火把，但**没有任何一条路能造出火把**

- `goals.js:216` 要 `torch: 8`
- `goals.js:244` 要 `torch: 16`
- `goals.js:305`（explore）要 `torch: 6`
- 但 `src/actions.js:6666`：`if (itemName === 'torch') return false` —— `gather('torch')` **恒假**
- POOL 里也没有「挖煤 → 做火把」这一段；`coal` 只出现在 `ITEM_CN` 的翻译表里（`goals.js:123`），从来没有被当成收集目标

**这是「煤」在我们的设计里完全缺席的证据**。煤是地表最好拿的矿（峰值 y=95/136 都在山上），也是火把唯一的原料，而它既不在 POOL 里、也没有 craft 通道。于是「带够火把」这一步只能靠 `craft('torch')`（`actions.js:3992`）碰运气 —— 手里没煤没木棍就必然卡死，然后被 `maxFails`/`stall` 判定放弃。

**改法**：加一条「地表挖煤 → 做火把」的阶段（§3.1 的 C）。这条链一旦通了，`iron`/`diamond`/`explore` 三个目标的「备火把」才真的能完成。

### 错误 6：`mine()` 自己会往下抠 6 格，「地表采集」在动作层并不存在

`src/actions.js:2075` `mine(blockName, count, maxDist, opts)`：
- `src/actions.js:2205`：`const MAX_DESCENTS = 6  // 最多往下挖 6 格靠近`
- 够不着目标时：`// ---- 够不着：往下挖一格靠近（真人挖石头就是这么干的）----` → `digAt(below)`
- 找不到目标时：`await this.wander(15)`（横着走 15 格，y 不变）

也就是说：**只要上层说「挖 iron_ore」，动作层在够不着时就会自己往地下抠最多 6 格**，一次调用 6 格，反复调用就是一条竖井。`gather('raw_iron')`（`actions.js:6604`）直接落到 `mine('iron_ore', count)`，没有任何「只在地表」的开关。

**所以「地表采集」不是改几句文案就能实现的 —— 动作层需要一个竖向预算。**

**改法**：给 `mine()` 加 `opts.maxDescend`（默认 6，保持现状），地表模式传 `0`；`mine()` 里把 `MAX_DESCENTS` 换成 `Number(optsObj.maxDescend ?? 6)`。地表模式够不着就只 `wander`，永远不下沉。

### 错误 7（要反驳用户的一半）：25 分钟硬扣分和真实玩法对不上，但**不该删**

`src/goals.js:553` / `558`
```js
penalty = Math.min(110, Math.max(0, (underMin - 10) * 5))
if (underMin > 25) penalty = 110
```
真实玩家一趟可以挖一小时（§1.4 68 票回答），也有人住矿里（58 票回答）。所以「25 分钟必须上来」**不是玩家事实**。

但**这条不该删**，因为用户抱怨的原话是「一个正常玩家会一直把自己埋在地里吗」——他抱怨的是**单调**，不是**深度**。区分开：
- 「一趟有时长上限」→ 工程需要（会迷路、会卡住、`stallMs` 45 分钟太长），保留，但**理由要改成「一趟的收工条件」而不是「地下不合法」**。
- 「上来之后不许马上再下去」→ `surfaceHoldMs`/`surfaceHoldPenalty`（`goals.js:421-422`）已经在做，方向正确。

**真正没解决的**是：上来之后**只有「别再挖」这一个约束，没有「那去干什么」的正向出口**。`getup`（`goals.js:331` 附近）只管「爬上来」，爬上来之后它的 `score` 立刻归零（`if (undergroundOf(status) !== true) return 0`），于是下一个目标还是在同一个池子里挑，而池子里能干的活本来就不多 —— 于是又回到挖矿。

**改法**：`surfaceHoldMs` 期间给**非挖矿类**目标**加分**（不是只给挖矿扣分），并且把「上来之后的收尾动作」写进挖矿目标本身（§3.2）。

---

## 3. 具体改法

### 3.1 目标池：把「挖矿」拆成三条，而不是一条

现在 `iron` 和 `diamond` 都在做同一件事的两个版本。改成三条，按 `pickTier` 和**垂直距离**分流：

```js
// A. 地表采集（新）—— 不下沉，tier 0 起就能干
{
  key: 'surfacegather',
  title: '在山坡和洞口捡点矿',
  why: '山上的石头缝里就有煤和铁，犯不着打洞',
  tag: '收集',
  surfaceOnly: true,          // ← 新标记，见 3.3
  stages: [
    { kind: 'craft',  title: '弄把石镐', need: { item: 'stone_pickaxe', n: 1 } },
    { kind: 'gather', title: '顺着山脊和洞口找露头的煤和铁',
      need: { coal: 8, raw_iron: 6 }, where: '地上：山坡、崖壁、洞口（不下沉）' },
    { kind: 'do',     title: '就着这些料做几根火把', need: { count: 1 } },  // 火把链，见错误5
    { kind: 'surface', title: '本来就在地面，走回去把东西放下', need: { y: SURFACE_Y } }
  ],
  score (status) {
    const tier = pickTier(status.inventory || {})
    if (tier < 0) return 12          // 没镐子先别看这个
    let s = 62                        // 比 iron 高：这是日常活
    if (tier >= 1) s += 10
    if (((status.pos && status.pos.y) || 64) > 70) s += 8   // 人在山上就更容易想到
    return s
  }
},

// B. 铁矿（改）—— 分「地表版」和「深部版」，由代码选，不由文案选
{
  key: 'iron',
  title: '挖一趟铁就上来',
  why: '石镐不经用，铁的东西才扛造',
  tag: '收集',
  undergroundGoal: true,
  // 深部版：tier>=2 且火把够，才走这条。y 目标跟着 1.18 走。
  // 地表版直接复用 A 的采集段，只是数量更大。
  ...
}
```

**铁矿的判定用代码，不用文案**（这样模型无法把它改成「下去」）：

```js
// 在 makeGoal() 里按当前状态选阶段模板，而不是永远用同一个 stages
function ironStages (status) {
  const tier = pickTier(status.inventory || {})
  const hasLight = itemCount(status.inventory || {}, 'torch') >= 8
  if (tier <= 1 || !hasLight) {
    // 地表版：不下沉，只走洞口和崖壁
    return [
      { kind: 'craft',  title: '弄把石镐', need: { item: 'stone_pickaxe', n: 1 } },
      { kind: 'gather', title: '在洞口和崖壁上找露头的铁矿', need: { raw_iron: 6 },
        where: '地上：洞口、崖壁、山坡（不下沉）', surfaceOnly: true },
      { kind: 'surface', title: '本来就在外面，走回去烧', need: { y: SURFACE_Y } },
      { kind: 'gather', title: '烧成铁锭', need: { iron_ingot: 6 } }
    ]
  }
  // 深部版：进了洞就按「火把额度」收工
  return [
    { kind: 'craft',  title: '先弄把铁镐', need: { item: 'iron_pickaxe', n: 1 } },
    { kind: 'gather', title: '备好火把和吃的再下去', need: { torch: 16, '#food': 4 } },
    { kind: 'depth',  title: '下到有铁的那一层', need: { y: 16 } },
    { kind: 'gather', title: '这一趟挖够十来块铁矿', need: { raw_iron: 12 } },
    { kind: 'surface', title: '顺着来路回到地面', need: { y: SURFACE_Y } },
    { kind: 'gather', title: '烧成铁锭', need: { iron_ingot: 12 } }
  ]
}
```

### 3.2 什么时候才允许下深矿（硬门槛，全部来自 §1）

```js
/**
 * 下深矿的四个门槛。少一条就不去 —— 这才是「真人不会空手往深处钻」的代码化。
 */
function mayGoDeep (status) {
  const inv = status.inventory || {}
  const tier = pickTier(inv)
  const torches = itemCount(inv, 'torch')
  const food = itemCount(inv, '#food')
  const y = (status.pos && Number(status.pos.y)) || 64
  return {
    ok: tier >= 2 && torches >= 16 && food >= 4 && y <= 120,
    why: tier < 2 ? '镐子不够硬'
       : torches < 16 ? '火把不够（wiki 建议一整组）'
       : food < 4 ? '没吃的'
       : y > 120 ? '从山顶直接往下打太深，先下山'
       : ''
  }
}
```
- `tier >= 2`：铁镐。钻石/红石要铁镐（wiki 表里的「Minimum pickaxe tier required」）。
- `torches >= 16`：wiki 原文「at least a full stack is recommended」，16 是折中（一整组 64 会让准备阶段永远做不完）。
- `food >= 4`：`goal.js` 现在就是 4，保留。
- `y <= 120`：**这是给「挖山」留的口子** —— 人在 y=200 的山顶说「下去挖钻石」，那是 260 格的竖井，必然迷路。先下山再下井。

### 3.3 挖多久该上来：三个退出条件，都用现有代码能读到的东西

1. **数量到点**（Baritone 的做法，`dailyQuota` 已经在做）：`raw_iron >= 8`。
2. **火把耗尽**（真人做法，§1.3）：`torch === 0 && isUnderground()` → 立刻 surface。
   ```js
   // shouldWrapUp() 里加第三条
   if (isUnder && itemCount(inv, 'torch') === 0 && this.stage().kind === 'gather') {
     return { yes: true, why: '火把用完了，黑着没法再挖' }
   }
   ```
3. **下沉预算**（防「越挖越深」）：一趟的累计下降格数超过 `deepBudget = 40` 就收工。
   ```js
   // observe() 里累计
   const y = posOf(status).y
   if (y < (this.goal.tripStartY ?? y)) this.goal.tripDescend = (this.goal.tripDescend || 0) + (this._lastY - y)
   this._lastY = y
   // shouldWrapUp()
   if ((this.goal.tripDescend || 0) > 40) return { yes: true, why: '这趟下得太深了，先回去' }
   ```
   （40 格 ≈ 从 y=64 到 y=-24，还没到钻石层；够一趟正规矿洞，不够一路挖到基岩。）

**25 分钟那条保留，但换成理由**：不要叫「憋太久了」，叫「这趟差不多了」。文案改了，行为不变，但下次调参时不会再有人把它当成「地下有害」的证据。

### 3.4 上来之后干什么（现在这里是空的）

`surfaceHoldMs` 期间，除了给挖矿类扣分，**还要给三类活加正分**，否则他上来了也没事干，就又会挑挖矿：

| 上来后该干 | 现有目标 | 要做的事 |
|---|---|---|
| 烧矿、做工具 | `iron` 的最后一阶段（`回到地上再烧成铁锭`） | 已经对了，保留 |
| 做火把备下一趟 | **没有** | 新增（§3.1 的 C，或用 `craft('torch')` 段） |
| 干点跟矿无关的 | `house` / `farm` / `tower` | 在 `surfaceHoldMs` 内给这几个 **+15 分**（现在只是给挖矿 -45） |

```js
// candidates() 里，justCameUp 那段后面补上
if (justCameUp && !g.undergroundGoal && !g.valleyGoal) {
  score += 15            // 刚上来这段时间，地面上的活更容易被想起来
}
```

这样「上来」才不是结束，而是换挡。

### 3.5 改动的优先级（给 goals-fixer 的顺序建议）

| 优先级 | 改动 | 文件 | 一行能不能改 |
|---|---|---|---|
| P0 | `#surfacestone` 去掉 `cobbled_deepslate` | `goals.js:108` | 能，一行 |
| P0 | 钻石 `need:{y:16}` → `{y:-54}` | `goals.js:243` | 能，一行 |
| P0 | 钻石阶段顺序：火把挪到 `depth` 之前 | `goals.js:242-245` | 能，挪两行 |
| P1 | `iron` 标题去掉「下去」+ 地表/深部两套 stages | `goals.js:216` + 新增 `ironStages()` | 要加函数 |
| P1 | 加「挖煤 → 做火把」链路（错误 5） | `goals.js` 新目标 + `actions.js` 的 torch 分支 | 跨文件，注意归属 |
| P2 | `mine()` 加 `opts.maxDescend` | `actions.js:2205` | 两行 |
| P2 | `shouldWrapUp()` 加「火把耗尽 / 下沉预算」 | `goals.js` | 十几行 |
| P3 | `surfaceHold` 期间给地面活加分 | `goals.js` `candidates()` | 三行 |

---

## 4. 一句话回应用户

> 「他也可以去挖那些山吧，不一定非要去地下挖吧」

可以，而且比下去更划算：
- 煤的峰值在 y=95/136、铁有一条带在 y>80、绿宝石只在山地峰值 y=236 —— **山地本来就是矿带**；
- wiki 自己的建议就是「从洞口进去，浅层洞穴煤铜铁管够」，社区高票答案也是「天然洞穴系统暴露的方块远多于自打隧道」；
- 但**露头矿有 50% 生成取消**，所以「挖山」的正确形态不是站在坡上捡，是**沿洞口/崖壁/山脊走**，横着走而不是往下抠。

唯一要补的一半：**「效率党」确实会下到基岩挖矿道**（260 票回答）。所以不是「别下去」，是**两条都要有，而且由代码按手里的工具和火把去选**，不是把「下去」写死在标题里。

**建议先改 P0 那三条**（一行一条），它们不依赖任何重构，改完就能少掉一部分「下去但不动」的空转。
