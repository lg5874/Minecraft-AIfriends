# 部署：让 bot 常驻服务器

> 目标：他不跑在你的手机上。锁屏、断网、手机没电，他都在服务器里待着。
>
> 做法：服务器上装一个 Java 插件，插件负责下 Node、装依赖、拉起 bot、崩了重启、日志落盘。
> **不需要改服务器启动命令，不需要 root，不碰面板。**

---

## 0. 一次看懂全貌

```
服务器（Paper 1.21.11 / Linux x86_64 / Java 21）
│
├── plugins/
│   ├── XJJBot.jar                  ← 插件本体（48KB）
│   └── XJJBot/                     ← 插件的"家"
│       ├── config.yml              ← 插件设置（端口、重启策略、日志）
│       ├── upload/                 ← ★ 你把包传这里
│       │   └── minecraft-aifriend-0.1.0-xxx.tar.gz
│       ├── bot/                    ← 插件自动解出来的 bot 代码
│       │   ├── main.js
│       │   ├── src/
│       │   ├── package.json
│       │   ├── config.json         ← ★ 你填 API key 的地方（永不进包）
│       │   ├── data/               ← 他的记忆、技能、家（自己长）
│       │   └── node_modules/       ← 插件 npm install 装的
│       ├── runtime/                ← 插件下的 Node（系统有就复用）
│       ├── npm-cache/
│       └── logs/
│           ├── plugin.log          ← 插件自己的日志（轮转）
│           └── bot/bot.log         ← ★ bot 的输出（轮转）
│
└── [服务器启动命令：不用改]
```

**插件启动后自动做的事**：找 Node → 解包 `upload/` → `npm install` → 生成 `config.json` → 起 node → 盯着它，崩了重启 → 日志写盘。

---

## 1. 打两个包

在开发机（或任何有 Node 的地方）执行。

### 1.1 bot 包

```bash
cd /root/workspace/minecraft-AIfriend
node scripts/package.js
```

输出：

```
打包完成
  产物   /root/workspace/minecraft-AIfriend/dist/minecraft-aifriend-0.1.0-20261113-054257.tar.gz
  大小   186.9 KB（tar 566.5 KB 压缩后）
  文件   37 个
  build  9e5ad9d50aba048c
```

> **187 KB**。不含 `node_modules`（500MB 那坨由服务器装），不含 `config.json`（key 绝不进包）。
> 打包脚本会自己扫一遍：发现疑似 key 就直接拒绝打包并报出是哪一行。

想先看会打进去什么：

```bash
node scripts/package.js --list
```

### 1.2 插件 jar

```bash
cd /root/workspace/mcplugin
./build.sh
```

输出 `XJJBot.jar`（48 KB）。需要 JDK 21（`javac` 在 PATH 里）。

> 如果要在别的机器上重编：`paper-api.jar` 已经在目录里，不用联网拉 maven。

---

## 2. 传到服务器

用面板的文件管理器（或 sftp）。目标位置：

| 文件 | 传到 |
|---|---|
| `XJJBot.jar` | `plugins/XJJBot.jar` |
| `minecraft-aifriend-*.tar.gz` | `plugins/XJJBot/upload/` |

`plugins/XJJBot/` 这一层如果不存在就手建一个，把包扔进 `upload/` 子目录。

> 也可以不建 `upload/`：直接把包传到 `plugins/XJJBot/` 下面也行，插件两处都找。
> 但 `upload/` 更干净——解完包就删了，不会留垃圾。

---

## 3. 启动服务器

面板点"启动"。**启动命令一个字都不要改**（这是踩过的坑：改了面板会崩）。

看控制台，正常应该依次出现：

```
[XJJ] === XJJBot 1.0.0 启动 ===
[XJJ] 数据目录: /xxx/plugins/XJJBot
[XJJ] 上传包放这里: /xxx/plugins/XJJBot/upload
[XJJ] 已请求启动
[XJJ] --- 准备中 ---
[XJJ] 使用系统 node v20.x.x => /usr/bin/node        ← 或"下载 node: https://..."
[XJJ] 解包 minecraft-aifriend-0.1.0-xxx.tar.gz -> .../bot
[XJJ] 部署完成，文件数=37
[XJJ] npm install 开始（首次几分钟）...
[XJJ] npm install 结束 exit=0 用时 68s
[XJJ] 生成了一份模板 config.json: .../bot/config.json
[XJJ] >>> 去改里面的 llm.apiKey / baseUrl / model，然后 /xj restart <<<
[XJJ] bot 已启动 pid=12345 node=v20.x.x
```

第一次启动会在 `npm install` 停一会儿（装 mineflayer，通常 1–3 分钟，看网络；本机实测 25 秒）。
控制台这时候没动静是**正常的**，别以为卡死了。

---

## 4. 填 API key

**这是唯一必须手动的一步。** key 不在包里，在服务器上单独配。

编辑 `plugins/XJJBot/bot/config.json`：

```json
{
  "bot": {
    "username": "XJJ",
    "host": "127.0.0.1",
    "port": 19830,
    "version": "1.21.11",
    "auth": "offline"
  },
  "llm": {
    "baseUrl": "https://你的中转站/v1",
    "apiKey": "sk-这里填真key",
    "model": "你的模型名",
    "chatMaxTokens": 900,
    "codeMaxTokens": 4000,
    "thinkMaxTokens": 1200,
    "temperature": 0.9
  }
}
```

只有 `llm` 那三行（`baseUrl` / `apiKey` / `model`）必须改。`bot` 段插件已经按你的服务器端口填好了。

改完在游戏里（op 账号）或控制台执行：

```
/xj restart
```

看到 `[XJJ] bot 已启动 pid=...` 就成了。进服务器应该能看到他。

> ⚠️ **不要用 `/reload`**。Paper 的 `/reload` 会留下半死不活的线程，用 `/xj restart` 或者干脆重启服务器。

---

## 5. 命令

全部需要 `xjj.admin` 权限（默认 op 就有）。

| 命令 | 干什么 |
|---|---|
| `/xj status` | 状态：跑着没、pid、跑多久、重启几次、node 版本、上次退出原因、日志路径 |
| `/xj start` | 启动 |
| `/xj stop` | 优雅停止（SIGTERM，等 20 秒，超时才强杀） |
| `/xj restart` | 重启（改完 `config.json` 用这个） |
| `/xj logs 100` | 看最后 100 行 bot 日志（最多显示 60 行，完整版去文件里看） |
| `/xj deploy` | 重新部署：先放新包进 `upload/`，再执行这个 |
| `/xj where` | 打印所有路径（数据、bot、上传、日志、config） |
| `/xj reload` | 重读 `config.yml`（要 `/xj restart` 才生效） |
| `/xj prune` | 清掉越界的归档日志 |

`/xj` 不带参数 = `/xj status`。

---

## 6. 崩溃自动重启怎么实现的

**代码在 `mcplugin/src/com/xjj/bot/Supervisor.java`。** 一个独立守护线程跑状态机，不占 Bukkit 主线程：

```
            stop()
     ┌──────────────────┐
     ↓                  │
  STOPPED ──start()──> PREPARING ──成功──> RUNNING
                          │                 │
                       失败(等120s)      进程退出
                          │                 │
                          └──> BACKOFF <────┘
                                 │
                            退避后重来
```

具体行为：

1. **进程跑了多久决定退避**。跑满 `stableUptimeSeconds`（默认 300s）算"这次是稳的"，退避归零；否则累计失败次数。
2. **退避指数增长**：5s → 10s → 20s → 40s → 60s（上限由 `restartBackoffMaxSeconds` 控制，默认 60s）。
3. **准备阶段失败不算崩溃**。下载 Node 失败、npm 装不上，隔 `prepareRetrySeconds`（默认 120s）重试，不进入快速退避循环——网络问题不该把重试次数烧光。
4. **连不上服务器 ≠ 崩溃**。mineflayer 自己会在内部无限重连（`reconnectDelaySeconds`，默认 15s），进程不退出，所以守护不会插手，不会出现"重启风暴"。
5. **`maxRestarts`** 默认 `0` = 不限次数。想限制就设成正数，超了会停在 `FAILED` 并打日志。
6. **服务器关服时会把他收干净**：`onDisable` → SIGTERM → 等 `shutdownTimeoutSeconds`（默认 20s）→ 还不走才 `destroyForcibly()`。

实测（`DeployCheck`，见第 9 节）：`kill -9` 掉 bot 进程，守护在 5 秒内换了新 pid 拉起来，日志里留下 `bot 退出 exit=137 存活 Ns` 和 `bot 启动 #2`。

---

## 7. 日志写在哪、怎么轮转

### 位置

```
plugins/XJJBot/logs/
├── plugin.log          ← 插件自己的：下载进度、解包、npm、启动/停止、重启
├── bot/
│   └── bot.log         ← bot 的 stdout/stderr 全文（他的每一句话、每一次报错）
└── runtime/            ← Node 下载缓存之类
```

### 两条日志分开

- `plugin.log` 是**宿主**的话："我下了个 Node"、"npm 花了 68 秒"、"第 3 次重启"。
- `bot/bot.log` 是**他**的话：连上了、被踢了、说了什么、崩在哪一行。

排查时先看 `bot.log` 的尾巴，看不出来再看 `plugin.log`。

### 轮转

两个文件都按大小轮转，各自独立配置：

```
logs/plugin.log       ← 当前
logs/plugin.log.1     ← 上一个
logs/plugin.log.2
...
```

- 单个文件超过 `log.maxMB`（默认 10MB）就滚一次。
- 只保留 `log.keepFiles` 个（默认 10 个，含当前文件），更老的删掉。
- 轮转判断是**按文件名里的序号**，不是按修改时间——手动塞进去的 `bot.log.77` 也会被 `/xj prune` 清掉。

bot 日志默认 10MB × 10 个 = 最多占 100MB，够翻很久了。

### 看日志

```bash
# 实时跟
tail -f plugins/XJJBot/logs/bot/bot.log

# 只看报了错的
grep -E "错误|Error|fatal|被踢" plugins/XJJBot/logs/bot/bot.log | tail -30

# 上次启动怎么死的
grep -A 5 "bot 退出" plugins/XJJBot/logs/bot/bot.log | tail -20
```

游戏里：`/xj logs 100`。

### 控制台镜像

`log.consoleMirror` 控制往服务器控制台镜像多少：

| 值 | 效果 |
|---|---|
| `important` | **默认**。只镜像"连接/断开/被踢/错误/fatal/登录/重生"这几类，不刷屏 |
| `all` | 全镜像（他说的每句话都进控制台，调试时用） |
| `off` | 只进文件，控制台干干净净 |

---

## 8. 改插件设置

`plugins/XJJBot/config.yml`。改完 `/xj reload` 再 `/xj restart`。

常改的几个：

```yaml
# 关掉开服自动拉起（手动控制）
autoStart: false

# 系统 node 太老时的下限
node:
  minSystemMajor: 18

# 想在面板里看到他说什么
log:
  consoleMirror: all

# 内存紧的机器
node:
  args: "--max-old-space-size=384"

# 限制重启次数（默认不限）
supervise:
  maxRestarts: 50
```

完整项见 `mcplugin/src/config.yml`，每一项都有中文注释。

---

## 9. 自己验证（不碰服务器）

两个自检程序，都是纯 Java、不需要 Paper、不会连你的服务器。

### 9.1 单元自检

```bash
cd /root/workspace/mcplugin
./build.sh
java -cp build/classes com.xjj.runner.SelfTest \
  /tmp/xjj-selftest \
  /root/workspace/minecraft-AIfriend/dist/minecraft-aifriend-0.1.0-*.tar.gz
```

验四件事：真包能解开（含 UTF-8 中文）、日志轮转正确、进程能起、崩了会重启。

### 9.2 全流程部署验证

```bash
java -cp build/classes com.xjj.runner.DeployCheck \
  /tmp/clean-server \
  /root/workspace/minecraft-AIfriend/dist/minecraft-aifriend-0.1.0-*.tar.gz \
  --npm
```

模拟一台干净服务器：建 `plugins/XJJBot/upload/` → 放包 → 解包 → **真跑 npm install** → 生成 config.json → 起进程 → `kill -9` 验证重启 → 优雅停止。

加 `--npm` 才会真装依赖（约 25 秒）；不加就跳过，秒出结果。

### 9.3 边界验证

```bash
java -cp build/classes com.xjj.runner.EdgeCheck /tmp/xjj-edge
```

验的是主流程没覆盖、但线上会踩到的：`maxRestarts` 到上限会停在 `FAILED`、`node.args` 真的传给子进程、日志洪水被轮转兜住、`bot/` 被删空后补包能恢复、重新解包不冲掉 `config.json`。

### 9.4 打包与兼容性

```bash
cd /root/workspace/mcplugin && ./build.sh
```

`build.sh` 除了编译打包，还会跑 `tools/PaperCompat.java`：用真实的 Bukkit API 加载插件类，确认主类继承关系、命令签名、依赖类完整、jar 里没混进自检类或 paper-api。

**当前实测：插件兼容 23 项 + 单元自检 31 项 + 部署验证 28 项 + 边界 21 项 = 103 项全过。**

### 9.5 只在本地验证包本身

```bash
cd /tmp && rm -rf pkgtest && mkdir pkgtest && cd pkgtest
tar -xzf /root/workspace/minecraft-AIfriend/dist/*.tar.gz
ls                    # main.js src package.json PACKAGE.json data/
node --check main.js  # 语法
```

---

## 10. 更新代码

```bash
# 开发机上
cd /root/workspace/minecraft-AIfriend
node scripts/package.js
```

新的 `dist/xxx.tar.gz` 传到 `plugins/XJJBot/upload/`，然后 `/xj deploy`（或者直接 `/xj restart`，插件发现包比已部署的新会自动重解）。

**你的 `config.json` 和 `data/` 会保留。** 解包时插件会先备份 `config.json`，解完再写回去；`data/`（记忆、技能、家）不动。

---

## 11. 排障

| 现象 | 原因 / 怎么办 |
|---|---|
| 控制台没有 `[XJJ]` 字样 | 插件没加载。看 `logs/latest.log` 有没有 `XJJBot` 的报错；确认 jar 在 `plugins/` 根目录、Java 是 21 |
| `准备失败: 所有 node 镜像都失败` | 服务器连不上外网。手动下载 `node-v22.11.0-linux-x64.tar.gz` 放到 `plugins/XJJBot/` 再重启 |
| `npm install 没装上依赖` | 看 `plugin.log` 里 `[npm]` 开头的行。国内网络慢就确认 `npm.registry` 是 npmmirror |
| `bot 目录里没有 main.js` | 包没传对位置，或传的不是 tar.gz。用 `/xj where` 看它到底在找哪 |
| `/xj status` 显示 `config.json 还没填 key` | 就是第 4 节那一步没做 |
| 起来了但进不去游戏 | `/xj logs 50` 看是不是 `ECONNREFUSED`（端口错）或 `duplicate_login`（同名账号在别处登录） |
| `duplicate_login` | **手机上那个 bot 还在跑**。先 `ps aux \| grep main.js` 关掉，否则互相踢 |
| 日志刷 `ECONNREFUSED 127.0.0.1:端口` | `config.json` 里 `bot.port` 跟服务器实际端口不一致。插件首次生成时会自动填对，手改过的话检查一下 |
| 他一直重启停不下来 | `/xj logs 100` 看退出码。若是 `exit=1` 且日志有"找不到配置文件"，说明 `config.json` 被删了 |
| 磁盘满了 | `/xj prune`；或把 `log.maxMB` / `keepFiles` 调小 |

**卡死时的三板斧**：

```bash
/xj status                                    # 它自己怎么看
tail -100 plugins/XJJBot/logs/plugin.log      # 宿主视角
tail -200 plugins/XJJBot/logs/bot/bot.log     # 他的视角
```

---

## 12. 一句话检查单

上服务器前对照这个：

- [ ] `node scripts/package.js` 跑过，产物 ≤ 5MB（实际 187KB）
- [ ] `./build.sh` 跑过，`XJJBot.jar` 有 48KB
- [ ] jar 在 `plugins/XJJBot.jar`
- [ ] 包在 `plugins/XJJBot/upload/`
- [ ] **启动命令没动过**
- [ ] 启动后看到 `bot 已启动 pid=...`
- [ ] 改过 `bot/config.json` 的 `llm` 三行，`/xj restart` 过
- [ ] 进游戏能看到他
- [ ] 手机上的旧 bot 已经关掉（不然 `duplicate_login`）

---

## 附：为什么不能用启动脚本 / systemd

面板锁定了启动命令，改了就崩（踩过的坑）。而且面板机通常不给 `systemctl`。

所以守护做在**插件内部**：插件跟服务器同生共死，服务器一起来就拉起 bot，服务器一关就带他走。这样：

- 不用改启动命令 ✅
- 不用 root ✅
- 面板重启服务器时自动恢复 ✅
- 服务器崩了 bot 也跟着停（不会变成孤儿进程占内存）✅

代价是：插件只能在服务器进程活着的时候守护他。但这就够了——服务器不在的时候，他本来也没地方待。
