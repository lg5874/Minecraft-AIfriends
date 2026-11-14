# 验收基线（VERIFY BASELINE）

> 由验收员维护。只记数字，不记结论。任何"改坏了没有"的判断都拿这张表对比。

## 快照 2（07:11–07:22，全量回归）

| 项 | 值 |
|---|---|
| git HEAD | `9f05ae8`，工作区 dirty 7 |
| 测试文件 | 34 个 `scripts/test-*.js`，跑了 **33** 个（`test-e2e.js` 未跑：连真服、账号 XJJ_E2E、十几分钟） |
| 通过断言合计 | **1466**（32 个测试有汇总行） |
| 失败合计 | **1**（`test-skills-live`） |
| 退出码 | 33 个全部 0 |
| check-syntax | **132 文件 / 0 问题** |
| judge-consistency | **100.0%**（47 技能 × 3 状态 = 141 组） |

### 唯一红灯：test-skills-live（不是代码回归）

```
✗ stats.reuseOk 与技能级 ok 总数一致  → stats 说 374，技能级只有 43
通过 27，失败 1
```

- 它读**真实运行数据** `data/runtime/skills.json`（`scripts/test-skills-live.js:127`），不是 mock。
- 同一测试在干净 HEAD 副本（`/tmp/clean-head`）上跑是 **27 通过 / 0 失败**。
- 成因方向：死条目（26 条）被剪掉时带走了自己的 ok 计数，`stats.reuseOk` 仍按调用累加 → 两个口径分开漂移。
- `src/skills.js` 最后一次改动是 `d90edad`（今晚之前）。

### 逐项（快照 2）

| 测试 | 通过 | 失败 | 测试 | 通过 | 失败 |
|---|---:|---:|---|---:|---:|
| actionlock | 112 | 0 | memory | 20 | 0 |
| bot-identity | 31 | 0 | memory-live | 83 | 0 |
| cost | 77 | 0 | memory-quality | 73 | 0 |
| decay | 16 | 0 | multibot | 6 | 0 |
| disconnect | 43 | 0 | pain-death | 47 | 0 |
| fake-success | 58 | 0 | perceive | 24 | 0 |
| goals | 174 | 0 | persona | 30 | 0 |
| goals-live | 66 | 0 | reflex-combat | 71 | 0 |
| home | 67 | 0 | scene-tone | 32 | 0 |
| instance | 24 | 0 | skills | 94 | 0 |
| invite-bounds | 11 | 0 | **skills-live** | **27** | **1** |
| invite-reply | 40 | 0 | talk-ack | 29 | 0 |
| loss-chain | 18 | 0 | talk-dedup | 30 | 0 |
| loss-voice | 6 | 0 | talk-speakgate | 33 | 0 |
| theme-repeat | 9 | 0 | torch-chain | 17 | 0 |
| unhuman-fixes | 27 | 0 | unhuman-misc | 71 | 0 |

### 已知口径坑（不是回归，别看花眼）

| # | 坑 | 怎么认 |
|---|---|---|
| 1 | `uses ≠ ok + fail` | 技能用了 N 次，成功+失败对不上 |
| 2 | 行号分母不一致 | 「第 X 行」的分母是筛过的行还是原始行 |
| 3 | `bot_count` 没标注 | 采样器 v2 把路过的人算成在线（报过 30） |
| 4 | 趟数被重启污染 | 重启后「今天第 N 趟」重新数 |
| 5 | **`test-skills-live` 最后一段读真实运行数据** | 它读 `data/runtime/skills.json`（`test-skills-live.js:127`）。死技能被剪掉时把 ok 数一起带走，`stats.reuseOk` 仍累加 → `stats 说 374，技能级只有 43`。**在干净 HEAD 副本上是 27/0**。这条红随机器人长跑漂移，不当退步处理 |

### 覆盖率缺口（全绿 ≠ 测到了）——已于 07:35 补齐

| 改动 | 原覆盖 | 现在 |
|---|---|---|
| `src/talk.js` `MANY_QUOTES` / `META_WORD_CHECK` | 无 | `test-owner-changes.js` A 段（10 项） |
| `src/talk.js` 复读存储 10 条 → 30 分钟 | 无 | `test-owner-changes.js` B 段（4 项） |
| `src/session.js` `robbed` 只认 `containerLoss` | 无 | `test-owner-changes.js` C 段（4 项） |
| `main.js` outText 清理 | 无 | `test-owner-changes.js` D 段（9 项，从 main.js 抠真实代码执行） |
| SOS 同句连发两条（07:16:05 现场） | 无 | `test-talk-concurrent-dup.js`（8 项，在 `43a0801` 上红 5 条） |

写这两类测试踩到的假绿坑，记下来免得再踩：

0. **这族坑的共同点：测试环境和真实环境的差，会让结论反向。**
   今晚的「用修复前的数据评价修复后的代码」也是同一族。写测试先问一句：
   「我造的这个环境，比真实环境少了哪一样东西？」少了的那一样往往就是 bug 藏身处。

1. **mock 延迟设 0 = 假绿**。`chatDelayPerChar: 0` 时 async 函数没有悬挂点，并发两次会串行跑完，看不到「检查 → 等 → 提交」那个窗口。必须用真实的 45ms/字 + 900~5200ms。
2. **`_speakReturn(diff, [], {})` 会早退**（`if (!lines.length) return`），断言等于没跑。
3. **`onComplain()` 自带概率和节流**，断言它的返回值会抖；要断言「有没有走到这条路」，用 spies 记调用。

## 像人度尺子（`scripts/humanness-score.js`）

用户的原话是「如果没人告诉你他是 AI，你多久能发现？」——拆成六个数。

```bash
node scripts/humanness-score.js --log data/runtime/supervisor.log --since 2h
node scripts/humanness-score.js --log ... --detail   # 每条的判定明细
node scripts/humanness-score.js --log ... --json     # 机器可读
```

**铁律**：每项都给分子/分母/口径；分母为 0 记「—」，**不记 0% 也不记 100%**；覆盖不到就明写原因。

### 基线（2026-11-14 08:56，主日志）

| 指标 | 2 小时窗口 | 全日志（02:31 起，385 分钟） | 方向 |
|---|---|---|---|
| 回声率 | 0 / 2 = 0.0% | 0 / 6 = 0.0% | 越低越好 |
| 复读率 | 4 / 46 = 8.7% | 13 / 134 = 9.7% | 越低越好 |
| 拦截率 | 25 / 71 = 35.2% | 62 / 196 = 31.6% | <5% 判据才可退役 |
| 主动沉默率 | 55 / 101 = 54.5% | 137 / 271 = 50.6% | 30~50% 最像人 |
| 言行一致率 | 0 / 2（180s 口径 0/2） | 0 / 4（180s 口径 **3/4**） | 越高越好 |
| 无据陈述 | 0 / 1 | 0 / 2 | 必须是 0 |

\* 全日志严格口径 0/4：**60 秒内一条都没做到**；把窗口放宽到 180 秒是 **3/4** —— 那 3 条是"先走过去再动手"，被 60 秒窗口漏掉了。所以这个指标的读法是「60 秒 = 说到就到；180 秒 = 真去做」两个数一起看，别只看 0%。样本只有 4 条，别当结论。

### 覆盖缺口（明写，不静默跳过）

| 指标 | 覆盖情况 |
|---|---|
| 回声率 | 只能取「玩家跟他说」那一段当输入情景（日志没 dump 完整 prompt）。全日志仅 3 条输入、6 条配对 → **样本太小，别当结论** |
| 无据陈述 | **只核了数字**（前后 120 秒内日志其它行有没有同一个数）。人名/地点的依据需要 `[fabrication]` 日志才算得准，现在**覆盖不到** |
| 言行一致率 | 只认能落到 `[act]` 标签上的六类动词（挖/砍/回家/做/吃/上去），其它表态不计入分母 |

### 交叉验证

同一把尺子量 `47a0801` 时期的老长跑日志 `/tmp/soak.log`（90 分钟）：拦截率 **85.4%**、主动沉默率 **89.7%**、复读 0/15 —— 和现在的 31.6% / 50.6% 差得很远，说明这把尺子**能把改前改后分开**，不是所有日志都给同一个数。

## 快照 0（开工基线）

| 项 | 值 |
|---|---|
| 时间 | 2026-11-14 00:53:51 – 00:55:38 |
| git HEAD | `43a0801` |
| 工作区 | dirty 9 项（`src/goals.js`、`src/spontaneous.js`、`scripts/test-fake-success.js`、`docs/*` 等并行改动在飞） |
| check-syntax | 112 个文件，0 个问题 |
| 通过断言合计 | **935**（20 个测试有汇总行；judge-consistency 用一致率，unhuman-misc 崩溃无汇总） |

## 逐项数字

| 测试 | 通过 | 失败 | 备注 |
|---|---:|---:|---|
| test-memory | 20 | 0 | |
| test-decay | 16 | 0 | |
| test-persona | 30 | 0 | |
| test-perceive | 24 | 0 | |
| test-multibot | 6 | 0 | |
| test-memory-quality | 73 | 0 | 内含 1 条 `模型调用失败: HTTP 403`（当时瞬时，复测两端点 200） |
| test-goals | 152 | 0 | |
| test-home | 67 | 0 | |
| test-skills | 94 | 0 | |
| test-actionlock | 112 | 0 | |
| test-cost | 77 | 0 | |
| test-judge-consistency | — | — | 一致率 **100.0%**（38 技能 × 3 世界状态 = 114 组；基线 58%，目标 >95%） |
| test-fake-success | 58 | 0 | |
| test-talk-dedup | 30 | 0 | |
| test-unhuman-fixes | 27 | 0 | |
| test-unhuman-misc | **崩溃** | 5 | `TypeError: Cannot read properties of null (reading 'text')` @ `scripts/test-unhuman-misc.js:275`，跑到 `[#4]` 中断，无汇总行；中断前 ✗ 5 条 |
| test-scene-tone | 32 | 0 | |
| test-theme-repeat | 9 | 0 | |
| test-bot-identity | **27** | **3** | ✗ 过了 5 秒可以再说一句 / ✗ 被点名时 2.5 秒就能回 / ✗ 20 秒内已 8 条时第 9 条被硬窗口拦下 |
| test-invite-bounds | 10 | 0 | |
| test-pain-death | 47 | 0 | |
| test-instance | 24 | 0 | |

## 已知红灯（开工就红，不算退步）

两个测试在**干净 HEAD** 上同样红，已用 `git archive HEAD` 导出到 `/tmp/clean-head` 复跑确认：

| 测试 | 工作区 | 干净 HEAD | 判定 |
|---|---|---|---|
| test-bot-identity | 27 通过 / 3 失败 | 27 通过 / 3 失败 | 原有问题，连跑 3 次数字稳定，非时间抖动 |
| test-unhuman-misc | 崩溃 @ 275 | 崩溃 @ 275 | 原有问题 |

`test-unhuman-misc` 的具体失败点（供开发定位，不含判断）：

- `[#2]` `第 1 次说得出去` ✗ → 公屏 `[]`、`recentSaid` 没记
- `[#2]` `公屏上只出现 1 条` ✗ → `[]`
- `[#2]` `recentSaid 只记了真正发出去的那条` ✗
- `[#2]` `不重复的话照发` ✗ → `[]`
- `[#4]` `说了计划就记下来` ✗ → `lastIntention = null`，随后第 275 行对 null 取 `.text` 崩溃

`test-bot-identity` 的 3 个失败点集中在「发言限速」段：5 秒窗口、被点名 2.5 秒、20 秒 8 条硬窗口。同段其余断言（同秒 12 次只发 1 条、其余 11 条被拦）通过。

## 口径（怎么算数）

### 单测

1. **通过数** = 测试自己最后一行汇总里的数字，认这几种写法：
   `N 通过，M 失败` / `通过 N，失败 M` / `N 过 / M 挂`。
   judge-consistency 用 `一致率: X%`。
2. **退步** = 通过数比基线少，或失败数比基线多，或原本有汇总行的测试变成崩溃/超时（timeout 120s）。
3. 只报变了的项，没变的合并成一句「无变化」。
4. 单次跑测就下判断前，先确认不是抖动：可疑项重跑 2 次。
5. 并行改动在飞时，基线数字必须带 git HEAD + dirty 数一起记，否则没法归因。

### 长跑任务：四栏，不是三栏

「N 开 / M 成 / K 败」不能用 —— 「成」里混着背包+0、方块+0、位移+0 的空转。
用 `node scripts/task-stats.js --log <日志>` 出四栏：

| 栏 | 判据 |
|---|---|
| 真产出 | `<<< 完成` 且 `[ledger]` 背包>0 或 方块>0 或 位移>=1 |
| 零产出通过 | `<<< 完成` 但背包/方块都 0 且位移<1 |
| 真失败 | `<<< 失败`，且期间没有 `[stall]` / `任务硬超时` |
| 卡住/超时 | `<<< 失败`（或没收尾）且期间出现 `[stall]` / `任务硬超时` |

优先级：**已经 `<<< 完成` 的，即使中途 stall 过也按产出入栏**（强制结束后重跑成功 = 真做完），
另附「严格口径」数字供选。`未收尾`（日志结束时还在跑）**不计入四栏**。

**位移要单独看**：`背包0 方块0 位移10`（"往南找了块平地，收拾了约 0 格地面"）按上面的字面判据
算真产出，但它没产出任何东西。所以同时记「材料口径真产出」（背包>0 或 方块>0）——
明早回答"他会干活吗"用材料口径，别用位移口径。

**死亡一律报「每 N 分钟一次」**，只报总数没有意义（人数、时长不同没法比）。`task-stats.js` 按
日志窗口（第一行到最后一行）算，并给 30 分钟外推。

### 长跑快照（两份日志都在写，数字会随时间变）

**02:20 快照**

| 日志 | 时长 | 开始 | 真产出 | 材料口径 | 零产出通过 | 真失败 | 卡住 | 未收尾 | 死亡 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| /tmp/soak.log | 81.2 分 | 27 | 17 | **16** | 1 | 6 | 1 | 2 | 4 次 / 每 20.3 分钟 |
| /tmp/soak2.log | 21.8 分 | 5 | 2 | 2 | 0 | 1 | 0 | 2 | 3 次 / 每 7.3 分钟 |
| /tmp/soak-archived.log | 8.2 分 | 3 | 1 | **0** | 0 | 0 | 0 | 2 | 0 |

死亡频率会随日志增长变：soak2 在 02:16 是 2 死 / 每 10.3 分，02:20 变成 3 死 / 每 7.3 分。
**引用时现场跑，别抄这里的文字。**

另有两条必须一起报（否则「成功」仍被高估）：

- **失败但有产出**：soak.log 4 条（背包 +28/+2/+10/+34）
- **账本结论 ≠ 任务行**：soak.log 3 条（`<<< 失败` 但 `[ledger] 结论:成`）

### 工具

```bash
# 四栏 + 死亡频率 + 明细
node scripts/task-stats.js --log /tmp/soak.log --detail

# 明早贴给人看的一段（bot 数必须给，不给会警告数字可能污染）
node scripts/task-stats.js --log /tmp/soak.log --bots 3 --brief

# 长跑采样 CSV（⚠️ 必须在仓库根目录跑；在 /root/workspace 跑会报
#    ERR_MODULE_NOT_FOUND ... esm/resolve:272 —— 那是路径错，不是脚本坏）
cd /root/workspace/minecraft-AIfriend
node scripts/sample-soak.js --log /tmp/soak.log --out /tmp/soak.csv --interval 60
```

`task-stats.js` 另外支持 `--json`（机器可读）。
CSV 尾部列：`real_out,zero_pass,real_fail,stuck_open,unfinished,real_material,death_per_min,task_span_min,minutes_per_death`。

## 复跑命令

```bash
cd /root/workspace/minecraft-AIfriend
node scripts/check-syntax.js
for t in memory decay persona perceive multibot memory-quality goals home skills \
         actionlock cost judge-consistency fake-success talk-dedup unhuman-fixes \
         unhuman-misc scene-tone theme-repeat bot-identity invite-bounds pain-death instance; do
  timeout 120 node scripts/test-$t.js > /tmp/raw-test-$t.log 2>&1
  echo "$t: $(node /tmp/verify-parse.js /tmp >/dev/null 2>&1; grep -oE '通过 ?[0-9]+|[0-9]+ ?通过|[0-9]+ ?过' /tmp/raw-test-$t.log | tail -1)"
done
```

跑测辅助脚本放在 `/tmp`（`verify-run.sh` 批量跑、`verify-parse.js` 统一口径解析），**不写进仓库 `scripts/`**。
基线原始日志存档：`/tmp/baseline-logs/`（22 份）。

---

# 实机基线

## 方法

```bash
cd /root/workspace/minecraft-AIfriend
STAMP=$(date +%Y%m%d-%H%M%S)
export AIFRIEND_DATA=/tmp/verify-$STAMP          # 独立数据目录，不碰 data/runtime
export AIFRIEND_CONFIG=../../../tmp/verify-config.json   # main.js 用 path.join(ROOT,...)，只能用相对路径

# 跑之前 / 跑之后各数一次在场 bot（只读探针，不发言）
PROBE_NAME=XJJ_PRE node /tmp/probe-players.js

timeout 180 node main.js > /tmp/live-$STAMP.log 2>&1
node /tmp/live-metrics.js /tmp/live-$STAMP.log
```

- 探针账号独立：`XJJ_VERIFY` / `XJJ_PRE` / `XJJ_POST` / `XJJ_VERIFY1..9`，配置在 `/tmp/verify-config.json`（`botNames` 里登记了并行测试号的名单，避免被当真人）。
- **数据有效性前提**：实机数字必须带「在场其他 bot 数」。同服务器上还有别的 agent 的 `XJJ_E2Evlu3` / `XJJ_SOAK0057` / `XJJ_GOAL1lgb` / `XJJ_FLKOCP` 在跑，**有第三方 bot 在场时行为数据不作准**，只用来验「不报错 / 不卡死 / 不掉线」这类硬指标。

## 实机快照 0

| # | 时间 | 时长 | 在场其他 bot | 任务 成/败 | say | 最长静止 | 掉线 | 报错 |
|---|---|---:|---|---:|---:|---:|---:|---:|
| 1 | 00:59:48–01:00:50 | 62s | 3（E2Evlu3 / GOAL1lgb / SOAK0057） | 0 / 0 | 0 | 22s（点 `[01:00:21]`） | 0 | 0 |
| 2 | 01:01:48–01:04:38 | 170s | 3→4（+FLKOCP） | **0 / 2** | 1 | 30s（点 `[01:03:02]`） | 0 | 0 |

（「最长静止」按日志时间戳算，含 `[hb]` 每 30 秒心跳；剔除心跳后的值见下。）

### 快照 0 的任务明细

| 任务 | 时长 | 结局 | 直接原因 |
|---|---:|---|---|
| 先弄把木镐，不然什么都挖不动 | 136s | 失败 | `[goto] 超时（45秒）` → `[travel] 第2段` → `[stall] 一分钟没动，强制结束任务` → `<<< 失败（136s）：执行出错` |
| 找块够平的地方，把地面收拾出来 | 0s | 失败 | `模型调用失败: HTTP 403`（环境故障，`[mem]` 未记进长期记忆） |

### 快照 0 的发言

- 发出 1 条：`[01:02:14] [say] 我找个树先`
- 被限速拦 2 条，其中 1 条是别人问话没回：

```
[01:03:48] [say 限速] 距上一条 4111ms < 5000ms，这句不说：别人: 小徐，也玩二游吗
[01:04:50] [say 限速] 距上一条 3432ms < 5000ms，这句不说：我: 都玩
```

## 环境依赖：LLM 端点

| 端点 | 6 连测 200 | 失败 | 失败耗时 |
|---|---:|---:|---|
| 主 `nekoapi.muhan.wiki/v1` | 4 | **2（403 HTML）** | 47–48ms |
| 备1 `mapi1.lzywl.top/v1` | 6 | 0 | — |

### 故障转移（本地假端点验证，`/tmp/failover-test2.js`）

provider0 恒返 403，provider1 恒返 200：

| 配置 | 结果 | 实际请求 | 次数 |
|---|---|---|---|
| 2 provider / tries=3 | **抛 HTTP 403** | 只有 `/p0` | 1（备1 一次都没打） |
| 2 provider / tries=1 | **抛 HTTP 403** | 只有 `/p0` | 1 |
| 3 provider / tries=3 | 成功（跳着救回） | `/p0` → `/p2` | 2（**跳过 p1**） |

干净 HEAD 复跑三行结果一致 → **原有问题**。生产 `config.json` 正好是 2 个 provider。
`main.js:69` 为 `new LLM(cfg.llm)`，未传 `log`，因此 `[llm]` 切换/失败日志不会出现在 main.js 日志里（实机 `[llm]` 计数 = 0 是这个原因）。
