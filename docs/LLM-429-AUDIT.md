# LLM 429 审计（2026-11-14 01:30）

> 谁要的：Lead。为什么：97 次 429 可能解释「他有时候不说话 / 回得特别慢」。
> 数据源：`data/test-results/*.log`、`data/runtime/bot.log`、`/tmp/*.log`，共 410 个日志文件。
> **全部只读，没改任何日志或 `data/runtime/` 下的用户数据。**

## 一、总量：**真实 429 是 54 次，不是 97 次**

| 模式 | 次数 | 说明 |
|---|---|---|
| `llm fail HTTP 429`（精确） | **54** | 真实失败行 |
| 其中带 `rate_limit_error` 体 | 53 | 剩下 1 条错误体不同 |
| 裸 `429` 子串 | 97 | ❌ **有噪声，别用这个数** |

**⚠️ 先纠正一个流传中的数字：97 是子串计数，不是 429 次数。**
`grep "429"` 会把下面这些都算进去：

```
代码版本 : 74429b3                      ← 提交哈希里含 "429"
[say 限速] 距上一条 4429ms < 5000ms      ← 毫秒数
[act] [chop] ... 共 7429ms               ← 毫秒数
[say 限速] 距上一条 4290ms / 4291ms      ← 毫秒数
```

真实量级是 **54**，比 97 少四成。结论方向不变（确实是限流），但「被限流过很多次」的程度要按 54 来理解。

## 二、时间分布：**54 条里 53 条集中在 22 点**

```
1  [15:xx]
53 [22:xx]
```

具体时刻（2026-11-13）：`22:11:42`、`22:23:54`、`22:36:55`、`22:45:10`、`22:54:17` ……
全部是**整簇出现**，同一秒内 3 条。

**跟「多个 bot 同时说话」的时段完全重合。** 以 `/tmp/runE.log` 22:23:50–22:23:58 为例：

```
[22:23:50] 3×persuade 3×say
[22:23:51] 1×comply   2×persuade 3×say
[22:23:54] 3×[chat] llm fail HTTP 429   ← 三条同时在秒内失败
[22:23:57] 3×[chat] llm fail HTTP 429
[22:23:58] 3×[chat] llm fail HTTP 429
[22:23:58] 被踢: disconnect.spam
[22:23:58] 断开: socketClosed
```

该窗口内出现的身份：`XJJ_CST9`、`XJJ_GB125`、`XJJ_P8s9a`、`XJJ_PDsg0` —— **4 个 bot 同场**。

## 三、哪个 provider：是**主 nekoapi**

错误体：

```json
{"error":{"code":"gateway_queue_full",
 "message":"Too many pending requests, please retry later",
 "type":"rate_limit_error"}}
```

**这不是「按 key 的 RPM 限流」，是网关自己的待处理队列满了。**
判据：
- `code` 是 `gateway_queue_full`，措辞是 `Too many pending requests` —— 排队人数，不是配额。
- 该错误形态来自 `https://nekoapi.muhan.wiki/v1`（主）。
- **更关键**：22 点那会儿 2-provider 的故障转移是坏的 —— `849e8cf`（11-14 01:09）
  修的正是「2 provider 时备用永远用不上」（`_pickHealthy` 跳过备1）。也就是说
  **当时 97 条 429 一条都没试过 `备1-lzywl`**，全部记在主头上。

⚠️ 这条是**推断**，不是直证：日志里 `[llm]` 前缀的行在这批日志里是 0 条
（`849e8cf` 才给 LLM 传了 log 回调，22 点的日志根本没有这个通道）。
所以 provider 归因靠的是错误体特征 + failover 当时不可用，不是日志明写。

## 四、429 之后发生了什么：**那句话没了，而且等了 10 秒**

代码路径（`src/llm.js` 6d7e373 版已有，22 点就在生效）：

```js
if (kind === 'ratelimit' && t === 0) { await sleep(10000); continue }   // 等 10 秒重试一次
...
break                                                                    // 还不行就放弃这一跳
// 然后切 provider —— 但 2 provider 时这一步当时是坏的
throw lastErr                                                            // 全失败才抛
```

`src/talk.js:714` / `:1200`：

```js
} catch (e) {
  this.ctx.log('[talk] llm fail ' + e.message)
  return false            // ← 什么都不补，这句就不说了
}
```

**talk 层没有自己的重试。** 所以一次 429 的代价是：

1. 第一次 429 →
2. **干等 10 秒** →
3. 重试还 429 → 放弃 →
4. 本该切备1，但切不过去（bug）→
5. 抛错 → talk/chat 吞掉 → **那句话一个字都没说**

这就是「回得特别慢」（10 秒等待占着这条调用）和「不说话」（直接丢句）的双重来源。

量化（`/tmp/runE.log` 单次运行）：

| 指标 | 数 |
|---|---|
| `[say]` 成功说出口 | 86 |
| `llm fail`（含 429） | 33 |
| `[chat] 选择不理` | 6 |

**33 次失败 vs 86 次说出口 —— 失败约占三成调用。**

## 五、比 429 更严重的一件事：**spam 被踢**

同一次运行、同一个窗口，22:23:58：

```
被踢: {"type":"compound","value":{"translate":{"type":"string","value":"disconnect.spam"}}}
```

全仓统计：

| 指标 | 数 |
|---|---|
| `disconnect.spam` 出现总次数 | **319** |
| 含该日志的文件数 | 19 |
| 日志文件总数 | 410 |

有 429 的文件基本都有 spam 踢人：

| 文件 | 429 | spam 踢 |
|---|---|---|
| `runE.log` | 33 | 7 |
| `pd-sos-5min-after.log` | 4 | 12 |
| `probeS5.log` / `probeS6.log` / `lock-probe-final.log` | 2–4 | 12 |
| `day-live.log` | 4 | 3 |

**「他有时候不说话」更可能是被踢下线，不是模型不回。**
被踢之后整个连接没了，比丢一句话严重得多。而这两件事同一个根因：**说话频率**。

## 六、结论与建议（按收益排序）

1. **先看 spam 踢，不是先看 429。** 建议把 `disconnect.spam` 次数当第一指标。
   注意 `sayGapMs` 刚从 5000 降到 2500（talk-owner 的改动）—— 如果这个服务器
   对聊天频率敏感，**降低间隔可能让踢人变多**，明天要专门对比这个数。
2. **429 是并发引起的，不是频率。** 网关队列满 → 加一个**全局出口信号量**
   （同时在飞的 LLM 请求 ≤2，其余排队）比调重试次数有效。现在 N 个 bot 同时说话
   会瞬间打出 N 个并发请求。
3. **重试策略现在仍然偏贵**：一次 429 = 10 秒。建议改成「429 不重试，立刻切 provider」——
   反正 `849e8cf` 之后备1 真的能用了。让 10 秒等待只发生在**所有 provider 都 429** 时。
4. **重新采样一次**：上面 97 条全是 `849e8cf` 之前的。修复后再跑一轮实机，
   看 `[llm]` 日志（现在有 provider 名了）里 429 落在哪个 provider 上，
   这次的推断就能变直证。

## 七、怎么复现这份审计

```bash
# 总量
grep -rho "429\|rate_limit" data/test-results/*.log data/runtime/*.log /tmp/*.log | sort | uniq -c
# 时段
grep -rh "llm fail HTTP 429" data/test-results/*.log /tmp/*.log | grep -oE "^\[[0-9]{2}:" | sort | uniq -c
# 踢人
grep -rh "disconnect.spam" data/test-results/*.log /tmp/*.log | wc -l
# 修复后：按 provider 看
grep -rh "\[llm\]" data/test-results/*.log /tmp/*.log
```
