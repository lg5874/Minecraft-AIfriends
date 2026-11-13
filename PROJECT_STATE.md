# 项目状态

最后更新：2026-11-13 18:56
代码版本：`0040035`
（团队仍在改：`main.js`、`src/*`、`scripts/` 有新文件在动；本文数字按工作区实测，谁改完谁更正）

---

## 10 分钟读法

1. **这一页** —— 现在能干什么、卡在哪
2. `docs/KNOWN-BOTTLENECK.md` —— 每个坑的根因和修法（最有参考价值）
3. `docs/UNHUMAN-SCAN.md` —— 16 个"一眼不像人"的日志证据
4. `docs/TESTING.md` —— 端到端怎么测、历次数字

---

## 一句话

他能自己活一天：砍树、合成、放箱子、存东西、找吃的、走回家、自己定长期目标。
端到端 **67%（4/6，2 项夹具造不出）**。
但玩家看到的还不是"一个玩家"，是"一个卡在循环里的东西"——
UNHUMAN-SCAN 16 条已修 9 条、半成品 3 条、没动 4 条。

---

## 现在能做什么（全是实测，不是设计）

| 能力 | 实测 | 取样时间 |
|---|---|---|
| 砍一棵树 | 106s，原木 4→9；历史最好 63–87s | e2e 17:13 |
| 放箱子 | 4s，世界内 chest 0→1 @(113,79,106) | e2e 17:13 |
| 存东西 | 3s，箱内 0→9 格（depositAll 返回 true） | e2e 17:13 |
| 找点吃的 | 119s，4 个 porkchop；历史最好 27–58s | e2e 17:13 |
| 回家 | 5 次 4 成（80%）；离家 30 格 10.2s 到位，误差 2.6 格 | home.json + test-home |
| 从 y=18 爬回 y=64 | 48.7s，真寻路，不用传送 | bot.log 16:47 |
| 做木镐 | 2s（材料齐时）；从零做要 80–160s | e2e 历史 |
| 长期目标 | 当前"搭个高台"走到第 2 阶段；历史 30 个里**放弃 27 / 完成 3** | goals.json 18:28 |
| 技能复用 | 383 次任务里 359 次复用（**93.7%**），复用后成功 351 | skills.json 18:28 |
| 记忆 | 51 条 / 6 人 / 19 个地点 / 20 条阶段总结 | memory.json 18:28 |

代码规模：**33 个 JS 文件 / 22,883 行**（`main.js` + `src/` 25 个 + `src/memory/` 7 个，不含 `actions.js.bak`）。
提交 **141** 个，tag 只有 `v0.1-arch-upgrade`。

---

## 现在不能做什么

- **端到端挖石头**：最近 20 次跑，最好 252s 成功，多数 118–301s 失败。`mine()` 本体 37.8s 是单独计时，不是任务耗时。
- **做石镐**：181s 超时（依赖挖石头，级联）。
- **从零做木镐 / 从地下爬出来**：e2e 夹具造不出（开局自带木镐丢不掉；y=69 仍判露天），这两项一直是 skip。
- **长时间稳定**：几小时以上的连续运行没测过，最长观察窗口约 25 分钟。
- **部署到服务器**：产物齐了（`dist/` 270,875 B + `XJJBot.jar` 52,475 B），**没有实跑过**。
- **别人挨打时去帮**：`spontaneous.onFriendInDanger()` 写好了，`main.js` 里 0 处调用。
- **天黑有反应**：躲夜条件仍是 `tod>13000 && health<=14`，满血就永不触发（UNHUMAN #12）。
- **记忆干净**：`people` 里仍混着测试号（UNHUMAN #13）。

---

## 已知问题（按严重度）

### P0

**1. 假成功没根治**（UNHUMAN #8，半修）
`judgeOutcome()` 已从"只看开头 40 字正则"改成多组失败词 + 零产出 + `A→A` 判定（`main.js:1259`），`skills.json` 里记了 `fakeSuccessCleared: 17`。
但它**仍然只看文本**，不看背包数字。最热技能 `k_mwdx4vb0`（"用石镐挖庇护所附近的石头"）被复用 **19 次，0 成功**——说明"失败技能还被反复选中"的链路没断。

**2. 挖石头/做石镐长超时**
最新一次：挖石头 260s（`digStone` 90s 超时，圆石 0→0，夹具做镐花了 94s）；做石镐 181s。
`mine()` 段占 75–206s，`dig` 32s + `pickup` 30s 是主要开销。

**3. 67% 这个数字没覆盖最新修复**
e2e 那次跑在 `40b21ec`（17:13–17:25），**之后**才有 `4dc6627`（17:52，UNHUMAN #1/#6/#9）和 `112917d`（18:26，#2/#3/#5/#10/#11/#15）。
所以"现在到底多少"需要重跑一次 e2e 才算数。

### P1

**4. 技能库里 1/3 在用，最热那条全败**
39 条技能，只有 12 条被用过。`k_mwdx4vb0` 0/19、`k_mwe60wh8` 0/5——失败权重没有把它们的排序压下去。

**5. 服务器掉落物不稳定**（客户端不可修）
同一台服务器：16:00 测 4/5 有掉落，16:03 测 0/4，16:05 测 0/1。
方块确实被删了，掉落物没生成。这是所有"挖了 0 块"谜团的终极答案，要从服务端 `doTileDrops` / TPS / 清道夫插件查。

**6. `test-skills` 5 条断言挂**
`[检索] 能搜到两个候选 → 实际 1`；`[复用] 第二次复用了技能 → null`、`模型调用次数 1≠0`、`uses=1 ok=0`、`{tasks:3,reused:1}`。
`src/skills.js`（18:06）比 `scripts/test-skills.js`（17:08）新，**要么测试过期、要么复用链路回归**，未定性。

**7. 回家之后立刻又往下钻**
`home` 只管"回地面"，为什么总想往下是 `goals` 驱动。已加 `getup` 目标和 `surface` 阶段，效果未验证。

### P2

**8. energy=0 仍然精神抖擞**
`mood.state()` 改成"取最严重"后不再永远 `irritated`（18:09 日志已出现 `心情:tired`），但 `energy` 依然没有行为后果（只让走神概率 +0.1）。

**9. 目标寿命**
`minLifeMs` 已设 5 分钟（`goals.js:389`），但历史 30 个目标里 27 个是放弃、3 个完成（**完成率 10%**）。`maxIdleWins` 从 5 调到了 **12**（`goals.js:371`），比原来更宽容——是配合假成功修复的取舍，代价是零进展的表演能连做 12 遍。

**10. 技能库的"完成话术"仍能骗过判定**
技能代码里的 `return '现在手上有圆石XX个'` 会被 `hasGain` 正则吃成成功。修法是让 `markUse(name, ok)` 的前提变成"背包真的变了"，还没做。

---

## 最近改了什么（倒序，只挑有实测数字的）

| 提交 | 改了什么 | 效果 |
|---|---|---|
| `112917d` 18:26 | UNHUMAN #2/#3/#5/#10/#11/#15 | 复读硬拦截、上线 0.85+instant、同格强制换动作、心情取最严重、凌晨接上 |
| `4dc6627` 17:52 | UNHUMAN #1/#6/#9 | 纯标点不发、goto 起步宽限 250ms、目标最低活 5 分钟 |
| `3558e96`–`c277fb0` 17:10 | chopTree 候选/挖路/垫柱 | 挖 0 格不再反退 3.3 格；`trySpots` 连 3 次没靠近才停 |
| `157487a` 17:0x | `digPathTo` 限时 3s | 两个候选里 14s 全花在挖树叶上 → 不再无上限 |
| `ee946ae` 16:xx | `candidates` 9 次 `findBlocks` 合 1 次 | radius96：**4900ms → 906ms（5.4×）** |
| 16:50 | 回家判定改 `walkCostHome = 水平 + 垂直×3` | 水平 82 格 / 垂直 46 格那种情况能判出来；y=18→y=64 用 48.7s |
| 15:54–16:00 | 多 provider 故障转移 + 主模型自动切回 | 指数退避 30s→30min，探测 `max_tokens=1` |
| 14:xx | `getToSurface` 地下死循环、`isUnderground` 浅坑误判、`digAt` 假成功、`craftSmart` 补料顺序、`stick` 配方 `result.id` 全相同 | `mine()` 187ms→8ms（23.4×）；砍树 113s 失败→27s 成功 |
| 13:xx | 技能 278→29→39 条、记忆 212→51 条 | 复用率 0%→93.7%；`fakeSuccessCleared` 开始计数 |

---

## 下一步（按"收益 ÷ 成本"排）

1. **重跑一次 e2e**（约 11 分钟）——现在没有覆盖 17:52 之后修复的基线，`docs/TESTING.md` 该补一行。
2. **收尾 UNHUMAN 剩 4 条**（都是小改）：#12 躲夜别绑血量、#16 用上或删掉 `idleThinkSeconds`、#14 接 `onFriendInDanger`、#13 记忆过滤测试号。
3. **给失败技能加惩罚**：19 连败的 `k_mwdx4vb0` 不该继续被选中（#4 的连带）。
4. **定性 `test-skills` 那 5 条断言**：回归还是测试过期，二选一。
5. **挖石头夹具/超时**：夹具 94s 造镐 + `digStone` 90s 上限，两段都要动。
6. **服务器掉落物**：找服主确认 `doTileDrops` / TPS。
7. **长跑 + 部署实跑**：24 小时不掉线是阶段 6 的验收线。

---

## 数据快照（2026-11-13 18:28）

```
skills : 39 条 / 任务 383 / 复用 359 (93.7%) / 复用失败 8 / 假成功清理 17
memory : entries 51 / people 6 / places 19 / summaries 20 / journal 300
goals  : 当前「搭个高台」第 2 阶段 / 历史 30（放弃 27、完成 3）
home   : (66,64,-92) 锚点 chest / goHome 5 次 4 成
mood   : energy 0 / spirit 0.629 / irritation 0.904 → state() 现在会输出 tired 而不是永远 irritated
```

---

## 怎么跑

```bash
cd /root/workspace/minecraft-AIfriend
cp config.example.json config.json   # 填 llm.apiKey / bot.host / bot.port
npm start
```

## 怎么验

```bash
npm test                      # 90 项断言，4 个文件，必须全过
node scripts/test-home.js     # 67 项，含一次真连服务器回家
node scripts/test-goals.js    # 64 项
node scripts/test-skills.js   # 94 项（当前 5 条挂，见 P1-6）
node scripts/test-unhuman-fixes.js  # 27 项，对应 UNHUMAN 修复
node scripts/test-unhuman-misc.js   # 41 项
node scripts/test-talk-dedup.js     # 30 项
node scripts/test-memory-quality.js # 73 项
node scripts/test-fake-success.js   # 4 项
node scripts/test-e2e.js      # 连真服务器跑 8 个任务（约 11 分钟）
```

全部离线测试合计 **496 条断言：491 过 / 5 挂**（挂的 5 条全在 `test-skills`）。
这个数每轮都在涨（团队边修边加断言），以最后一次跑的结果为准。

### 铁律：测试要用独立账号

所有 e2e 用 `XJJ_E2E<随机后缀>`，不要用 `XJJ`。
同名会 `duplicate_login` 互相踢，数据全污染（实测：`setControlState('forward')` 1 秒只动 0.21 格、`jump` y 不变、`placeBlock` 超时 5000ms）。
跑测试前确认 `pgrep -f "node main.js"` 是空的。

---

## 服务器

- `s205.singsi.cn:19830`（Java TCP + Bedrock UDP 同端口）
- Paper 1.21.11（协议 774），Geyser b1279 + ViaVersion
- 离线模式，死亡不掉落
- 基岩版客户端必须 ≤ 26.52.3
- 玩家：Xylitol6983（叫"果哥"）
- ⚠️ 掉落物生成不稳定，见 P1-5

## 文档地图

| 文件 | 内容 |
|---|---|
| `docs/KNOWN-BOTTLENECK.md` | 坑与修法（最有用） |
| `docs/UNHUMAN-SCAN.md` | 16 个露馅点的日志证据 |
| `docs/TESTING.md` | 端到端基线 |
| `docs/DEPLOY.md` | 部署（插件源码在仓库外 `/root/workspace/mcplugin`） |
| `docs/DESIGN.md` / `architecture.md` / `memory.md` | 设计、调研 |
| `docs/TONE-AUDIT.md` / `docs/PERCEPTION-REPORT.md` | 语气与感知专项 |
| `docs/STRATEGY.md` | 参谋笔记：到底在修什么（18:54 新增） |
| `ROADMAP.md` / `BACKLOG.md` | 路线、待办 |
