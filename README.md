# minecraft AIfriend

给 Minecraft 服务器装一个**真的在玩**的 AI 玩家。

不是一个会聊天的 NPC，不是一套脚本机器人。
他会自己找活干、会学新本事、会记人记事、记得住谁对他好谁总打他。
而且——**他坚信自己是人**。

```
[23:53:16] 死了：XJJ was slain by Zombie
[23:53:20] [say] 草，被僵尸挠死了        ← 他自己编的，不是预设台词
```

---

## 他是什么

- **自己找活干**：没人管的时候，他有自己想做的事——想弄把好镐子、想盖个屋、想去前面那座山看看
- **会学新东西**：遇到不会的事，他自己写一段动作代码去试；做成了就存下来，下次直接复用
- **品味自己长出来**：不预设他喜欢什么。玩着玩着才知道自己喜欢高处还是讨厌地下
- **有心情**：会累、会烦、会兴头上。你喊他做事，他愿不愿意看当时心情
- **拒绝不是终点**：求他、给他好处、硬来，效果都不一样。磨久了会松口，威胁会记恨
- **有记性，也会忘**：印象深刻的事记很久，无关紧要的过一阵就"记不清了"
- **不看指令作弊**：不会 `/give` `/tp`，跟普通玩家一样靠走路和挖矿

## 他不是什么

- 不是聊天机器人（虽然很能聊）
- 不是靠预设脚本行动的 NPC
- 不会在你面前暴露自己是程序

---

## 架构

```
L5  意愿层    他自己想干嘛（没有教学大纲）
L4  人格层    人格 + 记忆 + 品味 + 心情 + 价值观
L3  技能库    做成的程序存下来，按处境检索复用   ← 慢慢学会所有玩法
L2  程序层    模型写 JS → 沙箱执行 → 失败回喂重写
L1  原子动作  走/挖/放/合成/冶炼/吃/装备/战斗/容器…
L0  反射层    每秒检查：自救/脱困/逃跑/还手/捡东西/天黑躲藏
L-1 身体      mineflayer，掉线重连，死了自动复活
```

### 为什么是这个结构

| 只有 L2+L3（Voyager 路线） | 只有 L4（聊天 NPC 路线） | 两个都要 |
|---|---|---|
| 很能干，但像打金工作室 | 会说话，但不会真玩 | 才像个玩家 |

能力上限由模型决定，不由写死的代码决定。这是它和"永远只会做简单的事"的本质区别。

---

## 快速开始

### 1. 准备

- Node.js 18+（推荐 22）
- 一个 Paper / Spigot 服务器（支持离线模式）
- 一个 OpenAI 兼容的 LLM 接口（任何中转站都行）

### 2. 装

```bash
git clone https://github.com/YOUR_NAME/minecraft-AIfriend.git
cd minecraft-AIfriend
npm install
```

### 3. 配

```bash
cp config.example.json config.json
```

编辑 `config.json`：

```jsonc
{
  "bot": {
    "username": "XJJ",           // 游戏内 ID（Java 版只支持英文数字，中文会被踢）
    "host": "127.0.0.1",         // 服务器地址
    "port": 25565,
    "version": "1.21.11",        // 跟服务器版本一致
    "auth": "offline"            // 离线服务器用 offline
  },
  "llm": {
    "baseUrl": "https://你的中转站/v1",
    "apiKey": "sk-你的key",
    "model": "你的模型名"
  }
}
```

### 4. 改人设（可选）

编辑 `src/persona.js` 里的 `systemPrompt` 函数，改成你想要的角色。

或者改 `src/knowledge.js`（他懂的游戏常识）和 `data/games.json`（他玩的游戏）。

### 5. 跑

```bash
npm start
```

---

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `bot.username` | — | 游戏 ID，只能是 ASCII |
| `bot.version` | 1.21.11 | 必须跟服务器一致 |
| `llm.baseUrl` | — | OpenAI 兼容接口 |
| `behavior.idleThinkSeconds` | 60 | 多久想一次"接下来干嘛" |
| `behavior.chatDelayPerChar` | 45 | 打字速度（毫秒/字） |
| `behavior.ignoreChanceWhenBusy` | 0.55 | 忙的时候不理人的概率 |
| `behavior.taskTimeoutSeconds` | 420 | 单个任务最长多久 |
| `behavior.reconnectDelaySeconds` | 15 | 掉线后多久重连 |

---

## 他脑子里有什么

### 记忆（`src/memory/`）

三层：眼前（当前任务）→ 本次上线 → 长期（带权重的印象）

- **时间只在玩游戏时走**：服务器关一周再开，他不会觉得过了很久
- **会淡忘**：普通事件 6 小时半衰期，恩怨 40 小时，承诺和技能不忘
- **会模糊**：强度掉下去就变成"好像跟谁干过什么事，记不清了"
- **刻骨铭心的不衰减**：情感 ≥0.7 或重要性 ≥0.8 的永久保留

### 品味（`src/taste.js`）

**开局没有预设偏好。** 干完一件事，他自己评价爽不爽，累积成倾向。
3 次不定型，8 次才成形，50 小时不碰就淡了。

### 心情（`src/mood.js`）

精力 / 兴致 / 烦躁 / 满足。影响他愿不愿意迁就别人。

### 说服（`src/persuasion.js`）

拒绝不是终点。求、给好处、讲道理、命令、威胁、装可怜——效果各不相同。
同一个招用多了会免疫。威胁能让他答应，但会伤感情。

### 价值观（`src/values.js`）

他心里有杆秤。被问"谁对谁错"会站边，不打圆场。

### 秘密（`src/secrets.js`）

别人私下托付的事不会主动说。但被关系够近的人套话，可能漏。

---

## 自测

```bash
npm test              # 全部测试（记忆 20 项 + 衰减 16 项 + 拟人化 29 项）
npm run check         # 只查语法
npm run test:memory   # 记忆系统
npm run test:decay    # 衰减/遗忘
npm run test:persona  # 品味/心情/说服
```

---

## 目录

```
main.js              主程序
src/
  memory/            记忆系统（时间钟、条目、衰减、检索、写入判定）
  actions.js         原子动作
  coder.js           让模型写代码 + 沙箱执行
  skills.js          技能库
  reflex.js          反射层
  persona.js         人格提示词
  talk.js            说话（打字节奏、漏嘴过滤）
  will.js            意愿
  taste.js           品味（自己长出来）
  mood.js            心情
  impulse.js         冲动（干活途中走神）
  persuasion.js      说服
  values.js          价值观
  secrets.js         秘密
  realtime.js        现实时间感
  spontaneous.js     主动开口
  llm.js             LLM 客户端
data/
  games.json         他玩的游戏（二游知识库）
docs/
  DESIGN.md          完整设计
  memory.md          记忆方案调研
  architecture.md    架构调研
scripts/             测试
```

---

## 常见问题

**他被服务器踢了？**
- 中文 ID 会被踢，只能用英文数字
- 检查 `bot.version` 跟服务器是否一致

**他不动 / 一直卡住？**
- 检查服务器是否装了反作弊
- 他允许挖方块寻路，但被保护区域会卡住

**他说话不像人？**
- 换个更强的模型
- 调 `src/persona.js` 里的话风要求

**他记不住东西？**
- 记忆存在 `data/runtime/memory.json`，检查文件是否在写
- 下线时间不算进衰减，所以挂机不会让记忆消失

---

## 已知问题

- 天黑躲藏还不够聪明（会挖个坑但封不上顶）
- 盖房子是逐块摆的，歪歪扭扭
- 不会自己回家
- 长时间跑（几天）没测过稳定性

---

## License

MIT
