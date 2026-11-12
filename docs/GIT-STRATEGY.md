# Git 策略

最后更新：2026-11-13

---

## 一、现状

| 项 | 值 |
|---|---|
| 仓库位置 | `/root/workspace/minecraft-AIfriend` |
| 远端 | https://github.com/lg5874/minecraft-AIfriend （public） |
| 分支 | 只有 `main` |
| 提交数 | 38 |
| 跟踪文件 | 81 |
| 仓库大小 | 3.4 MB |
| 最新 tag | `v0.1-arch-upgrade` |

---

## 二、现在的问题

### ✅ 已经安全的

- `config.json` 在 `.gitignore` 里（含真实 API key）
- `node_modules/` 忽略
- `data/runtime/`（记忆/技能/日志）忽略
- 历史提交里**没有 key 泄露**（查过 `git log -S "sk-"`，两处命中都是误报：一处是变量名 `from-task-log`，一处是占位符 `sk-你的key`）

### ❌ 刚清理掉的

- `data/runtime-min/` 31 个测试数据文件（`.gitignore` 只写了 `runtime/` 没写 `runtime-*/`）
- `src/actions.js.bak` 备份文件

### ⚠️ 风险点

1. **只有一个分支** —— 多人/多 agent 同时改，冲突只能靠人工合并
2. **没有 CI** —— 每次改完靠人跑测试，容易漏
3. **agent 提交信息质量参差** —— 有些只写"修复"，看不出改了什么
4. **远端是 public** —— 代码公开，不能有任何 key/内部信息

---

## 三、策略

### 3.1 提交粒度

**每个能独立验证的改动 = 一个提交。**

- ✅ 好：「修 pickupNearby 用 GoalBlock 精确走」+ 实测数据
- ❌ 差：「修复若干问题」

**提交信息模板**：
```
<动词>：<一句话说清改了什么>

<为什么改 —— 问题现象、根因>
<怎么改 —— 关键思路>
<验证 —— 实测数据，改前 vs 改后>
```

### 3.2 分支策略

**平时只在 `main` 上做**，因为：
- 单人 + agent 团队，分支合并成本 > 收益
- 每个提交都是可回退的点

**需要分支的三种情况**：
1. 大重构（改 3 个以上文件，可能改坏）
2. 实验性方案（不确定能不能成）
3. 需要用户确认的改动（先做在分支上，确认后合）

**分支命名**：`feat/xxx`、`fix/xxx`、`exp/xxx`

### 3.3 Tag 策略

**每个里程碑打 tag**：

| Tag | 含义 |
|---|---|
| `v0.1-arch-upgrade` | 七层架构完成（已有） |
| `v0.2-quality` | 端到端成功率 > 70% |
| `v0.3-deploy` | 部署到服务器常驻 |
| `v1.0-playable` | 能跟真人一起玩，不被识破 |

**打 tag 时机**：全量测试通过 + 真机跑过 + 用户确认过。

### 3.4 Agent 协作规则

**这是最容易出事的地方。**

1. **改前先 `git diff <文件>`** —— 看有没有别人的未提交改动
2. **改完立刻 commit** —— 别攒着，否则会被覆盖
3. **不 commit 别人负责的文件** —— 除非明确知道对方已经完成
4. **冲突时先问 Lead** —— 不要自己 `git checkout -- .`（会丢掉别人的工作）

**已经踩过的坑**：
- 两个 agent 同时改 `getToSurface`，互相覆盖 3 次
- 我用 `XJJ` 账号跑测试，跟正式 bot 抢登录，数据全污染

### 3.5 备份

**三层**：

| 层 | 位置 | 频率 |
|---|---|---|
| 1 | 本地 git | 每次改动 |
| 2 | GitHub 远端 | 每天推一次 |
| 3 | 手机存储 tar 包 | 重大节点 |

**第 3 层的命令**：
```bash
cd /root/workspace
tar czf /sdcard/Download/DSH-Go/minecraft-AIfriend-$(date +%m%d-%H%M).tar.gz \
  --exclude=node_modules --exclude=data/runtime minecraft-AIfriend
```

### 3.6 推送

**每天推一次**，或每个里程碑推一次。

**token 处理**：用 `ghp_...` 临时写进 remote URL，推完立刻改回干净 URL。
```bash
TOKEN="ghp_xxx"
git remote set-url origin "https://${TOKEN}@github.com/lg5874/minecraft-AIfriend.git"
git push -q origin main
git remote set-url origin "https://github.com/lg5874/minecraft-AIfriend.git"
```

**绝不把 token 写进 `.git/config` 长期保留，也绝不提交进仓库。**

---

## 四、还没做的

- [ ] GitHub Actions CI（每次 push 自动跑 `npm test` + `check-syntax`）
- [ ] 提交信息 lint（拒绝"修复"这种模糊信息）
- [ ] 定期清理 `.git` 里的大文件历史（现在 3.4MB 还好，不用做）

---

## 五、给未来接手的人

1. **先看 `PROJECT_STATE.md`** —— 当前状态和已知的坑
2. **再看 `ROADMAP.md`** —— 分几个阶段，现在在哪
3. **`TEAM.md`** —— 多人/多 agent 协作规则
4. **`docs/TESTING.md`** —— 测试基线和怎么验证

**改之前先跑一遍测试，改完再跑一遍，对比数据。**
