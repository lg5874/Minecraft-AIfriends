# 自保（被怪打 / 环境伤害）— 2026-11-14

## 事故

普通模式上线 5 分钟，被怪一路打到死，全程几乎没有反应：

```
[01:37:27] [dmg] 未知类型 sourceTypeId=35
[01:38:49] [hurt] 环境伤害 未知，血 20
[01:38:49] [hurt] 环境伤害 未知，血 16
[01:38:51] [hurt] 环境伤害 未知，血 11
[01:38:53] [hurt] 环境伤害 未知，血 6
[01:39:24] [pain] 血 1（受了点伤）—— 疼，停手
[01:39:24] [death] 受了点伤（来源：damage_event / sourceTypeId=0）
```

掉血速度：**2 秒 5 血**（20 → 15 → 10 → 5 → 0，8 秒）。

## 根因（三条，缺一条都能死）

1. **阈值本身就救不了命**：`health <= 8 才跑`。20 掉到 8 只要 4.8 秒，
   而且 8 血只剩不到 2 秒 —— 抬到 14 也只多 1.2 秒。**调阈值是死路。**
2. **他不知道自己在挨打**：`sourceTypeId` 全解析成"未知"，日志写"环境伤害 未知"，
   反射层选不出应对（跑？跳？退？），于是什么都不做。
   真正的表是服务端下发的 `minecraft:damage_type` 注册表，
   mineflayer 只收 chat/biome/dimension 三类，**damage_type 被丢掉了**；
   main.js 里那张手写的 id 表整体错位（`9` 其实是 explosion，`24` 才是 lava）。
3. **busy 门禁**：任务在跑时 `tick` 直接 return，分档逻辑根本没机会执行。

## 改法

### `src/reflex.js`

| 触发 | 动作 |
|---|---|
| **3 秒内掉 ≥ 4 血** | **后撤 2 格 + 跳一下**（不看来源、不看血绝对值、不抢 pathfinder） |
| 血 ≤ 14 且附近有敌对 / 正在挨打 | 拉开距离（不拼命跑） |
| 血 ≤ 10 | 跑 |
| 血 ≤ 8 | 跑 + 吃东西 |
| 血 ≤ 5 | 跑 + 吃东西 + `blocksNewTasks()`（这段时间不接新任务） |

- 掉血速率是**主触发**：挂在 `bot.on('health')` 上（服务端每个伤害包都会推），
  再加 tick 800ms 采样兜底（毒/凋零/饥饿这些没有 damage_event 的也会掉血）。
- 弹开用控制键脉冲（0.4 秒），**不设 pathfinder goal** —— 那条会打断任务挖掘
  （历史上那堆 `Digging aborted` 就是抢寻路抢出来的）。
- 分档判断挪到 **busy 门禁之前**：血 ≤10 命比任务重要。
- 反击收紧：`血 > 14 且 6 格内敌对 ≤ 2` 才打；否则跑。
- `nearestHostile` 用 minecraft-data 的 `category === 'Hostile mobs'` 兜底，
  bogged / breeze / creaking 这些新怪不用改代码就认得出。

### `src/damage.js`（新）

以**服务端真实注册表**为准：`damage.attach(bot)` 拦 `registry_data`，
拿不到就用实测快照（`FALLBACK_ID`，抓自 s205.singsi.cn）。

实测表（1.21.11，50 条，关键项）：

```
0 arrow   6 drown   10 fall   24 lava   28 mob_attack   34 player_attack   40 starve
```

`infoOf(id)` → `{ name, cat, attack, continuous, cn }`；
`deathTextOf(id, by)` → `被僵尸打死` / `被骷髅射死` / `摔死了`；
`mobCn(name)` → `zombie → 僵尸`（`displayName` 是英文 `Zombie`）。

### `main.js`（6 处，已由 Lead 批）

1. require `src/damage`
2. `damage.attach(bot)`
3. 删掉手写的 `DAMAGE_KIND` / `DAMAGE_TEXT` → `damage.infoOf()`
4. `[dmg]` 每种类型第一次出现打一行可读的（带 `同实体` 判定）
5. `resolveDeathCause()` 用 `deathText`
6. 主循环 `if (this.busy) return` 之后加 `blocksNewTasks()` 闸门
   （只挡"开新任务"，reflex 自己的定时器照跑 → 逃跑/吃东西不受影响）

## 证据

注入服务端同款包（`--inject`，日志里标明是注入；真实被怪打见下）：

```
[02:08:24] [dmg] mob_attack(28) 攻击 同实体 cause=99001 direct=99001
[02:08:24] [hurt] 被攻击 挨了一下（mob_attack/28），血 16
[02:08:24] [reflex] 3 秒内掉 4 血（最近一下 20→16） —— 被 mob_attack，先退开 2 格 + 跳一下
[02:08:27] [reflex] 身边有怪（4 格），先拉开点距离
[02:08:27] [reflex] 血 12（1 档）—— 拉开距离
[02:08:30] [reflex] 血 9（2 档）—— 跑
[02:08:33] [dmg] fall(10) 环境
[02:08:33] [hurt] 环境伤害 摔下来了（fall/10），血 8
[02:08:33] [reflex] 血 8（3 档）—— 跑 + 吃东西
[02:08:39] [death] 被僵尸打死（来源：damage_event / mob_attack）
```

真实被怪打（`data/test-results/combat-live-2026-11-13T17-56-11-159Z.log`，
改 main.js 之前那一趟，反射层已经按速率动起来）：

```
[01:54:06] [dmg] 未知类型 sourceTypeId=28 cause=138539 direct=138539
[01:54:07] [reflex] 掉血 5（20→15，3 秒内）—— 被 unknown，先退开 2 格 + 跳一下
[01:54:10] [reflex] 身边有怪（2 格），先拉开点距离
[01:54:11] [reflex] 血 9（2 档）—— 跑
[01:55:04] [pain] 血 5（被skeleton打了）—— 疼，停手
```

## 怎么复验

```sh
node scripts/test-reflex-combat.js      # 68 条：分档 / 掉血速率 / 伤害表 / 死因
node scripts/test-pain-death.js         # 47 条：痛觉 / 死因优先级（原有用例没退化）
npm test                                # 24 条

# 抓服务端真实注册表（只读，不下世界）
node scripts/probe-damage-registry.js

# 实机：独立账号 + 独立数据目录，不碰 data/runtime
AIFRIEND_DATA=/tmp/combat-test node scripts/probe-combat-live.js --minutes 5
AIFRIEND_DATA=/tmp/combat-test node scripts/probe-combat-live.js --minutes 1 --inject
```

## 已知边界

- 弹开只有 2 格：**保证"已经开始动"**，真正的逃脱靠分档的 `flee`。
- `flee` 仍然是 pathfinder 12 格；地形复杂/被封住时可能跑不动
  （`nearestHostile` 看得见怪、`pathfinder` 算不出路 → 会退回原地）。
- 吃东西要背包里有食物，否则 `eatNow` 什么都不做。
- 隐身/看不见的敌人只能靠掉血速率（这正是这条触发的价值）。
- 反击只打 1~2 只怪，且血 > 14；被围殴一律跑。

## 追加（07:30）：回血线 —「饿 17」怎么会把人拖死

`[hb] 血7 饿17 背包32种 空闲`，就这样蹲了 4 分钟不走。

- MC 自然回血要 **food >= 18**；**17 就永远不回血**。
- 老 `eatNow()` 只在血低档位被调一次，而且食物判定是一条名字正则：
  `bread|cooked_|apple|…` —— 漏了 `honey_bottle` / `sweet_berries` / `beetroot` /
  `dried_kelp`，失败还是**全静默**（没吃的直接 return，equip/consume 出错也吞掉）。
- 所以现场日志里一条"吃"都没有，排查时只能靠猜。

现在：

| 情况 | 行为 |
|---|---|
| `food < 18` 且有正经食物 | 吃（不管血量、不管是不是在干活），并打日志说明为什么 |
| 只剩 `rotten_flesh` / `spider_eye` / `poisonous_potato` / `pufferfish` | 垫一口，但日志写明"腐肉有 80% 概率给 30 秒饥饿" |
| `food >= 18` | 不吃（日志：会自然回血，先不吃） |
| 背包没吃的 | 日志说出来：`[eat] 饿 17、血 20，想吃但背包里没吃的（背包 0 种）` |
| `equip`/`consume` 卡住 15 秒 | 强制复位 `this.eating`，不然以后永远不吃 |

食物判定以 `bot.registry.foodsByName`（1.21 数据表）为准，表不在才退回名字正则。

**一个反直觉的事实**：`brown_mushroom` 不是食物 —— 1.21 的 `foodsByName` 里没有它，
生的蘑菇只能做煲。背包里"还有蘑菇"不等于"还有吃的"。

### 上线后补的闸（07:32 现场）

```
[07:32:12] [eat] 饿 16 < 18 …，吃一个 rotten_flesh
[07:32:20] [eat] 饿 16 < 18 …，吃一个 rotten_flesh     ← 每 8 秒一条
```
腐肉 `+4 饱食 / 1.6 饱和` 但带 30 秒「饥饿」，净收益≈0，于是 keepFed 每次都判"还没到 18"。

三道闸：

| 闸 | 行为 |
|---|---|
| 同名冷却 | 正经食物 10 秒内不重复吃；腐肉 30 秒 |
| "吃了没用"记忆 | 吃过毒食后 120 秒内不再指望它（`_noPoisonUntil`） |
| 毒食救命线 | 只有毒食时，**血 ≤ 6 才吃**；否则只记一句「只有腐肉，但它会让我更饿 —— 忍着，去找正经吃的」（60 秒一次） |

**"忍着"比"吃腐肉"对**：腐肉的饥饿效果是负收益，吃它等于把"去找正经吃的"的时间换掉。

### 退之前看落点（摔死的最后一环）

`recoil()` 原来是"扭头就退 2 格 + 跳"，**没有落点检查**：

```
[07:13:35] [reflex] 3 秒内掉 6 血 —— 先退开 2 格 + 跳一下
[07:13:38] [fall] 35.3 格 -> [death] 摔死了
```

掉 30 格 ≈ 掉 20 血（必死）；硬吃一下怪的攻击只掉 2~5 血。
**所以"不知道背后是什么"就不该退。**

现在 `recoil()`：

1. `pickRetreatDir()`：有来源就只往"背向来源"退（退不了就不退，不往侧面/朝怪方向退）；
   没来源就四个正方向里挑第一个**脚下有地**的。
2. `safeToStepBack(dir)`：退 1~2 格那两格必须"脚/头都空 + 下面 3 格内有实心块"，否则算不安全。
3. 不安全 → 只原地跳（脱离岩浆/营火靠它），日志写明 `退路上是坑/挡着，原地跳一下（不后退）`。

move-owner 在 `actions.js` 的 `[ledge]` 是"退了之后 50ms 兜底"，这里是"退之前就判断"。

### 两级退（07:55）

只判"退 2 格"时实机 `退=4 / 不退=12` —— 75% 站着挨打，不像活人。改成：

```
退 2 格（两格都有地） -> 退 1 格（一格有地） -> 原地跳（都不行）
```

退 1 格最多掉 0.5 心，比硬吃 2~5 血划算，也补上了「血 11~20 挨打时几乎什么都不做」的空档
（`flee()` 只在血 ≤10/14 才启动，中间那段原来只有原地跳）。

实机一趟三种分支都出现：`退2=2 退1=2 不退=2`。
