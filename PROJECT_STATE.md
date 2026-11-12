# 项目状态（每次重大改动后更新）

最后更新：2026-11-13 01:20

## 现在是什么状态

能跑。他会自己找活干、会说话、会记忆、会长品味、会记仇。
但**失败率 78%** —— 大部分时间在做不成事。

## 代码规模

- 8060 行，29 个模块
- 4 套测试，89 项，全过
- 提交数 9，tag `v0.1-arch-upgrade`

## 核心模块（按重要性）

| 文件 | 作用 | 状态 |
|---|---|---|
| `main.js` | 主程序、事件循环 | 可用 |
| `src/actions.js` | 70+ 原子动作 | 可用，但很多动作成功率低 |
| `src/perceive.js` | 感知层（把世界翻译成人话） | 刚做，未充分验证 |
| `src/events.js` | 事件队列 | 接了一半，多数事件源没接 |
| `src/memory/` | 记忆（7个子模块） | 机制对，但存的内容是流水账 |
| `src/coder.js` | 模型写代码 + 沙箱 | 可用 |
| `src/skills.js` | 技能库 | **空转：58个技能0复用** |
| `src/talk.js` | 说话 | 可用，含两道过滤 |
| `src/persona.js` | 人格提示词 | 可用 |
| `src/reflex.js` | 反射层 | 可用 |
| `src/taste.js` | 品味（自己长） | 可用，但样本太少 |
| `src/mood.js` | 心情 | 可用，未接进语气 |
| `src/persuasion.js` | 说服 | 可用 |
| `src/plugin.js` | 插件适配 | 可用，服务器目前没插件 |

## 已知的坑（别重复踩）

1. **技能库空转**：`markUse` 没被调用，所以 58 个技能 0 复用
2. **失败率 78%**：挖坑 0 格、箱子放不下、熔炉合不出
3. **他会念日志**：执行结果原文被塞进提示词，加了 `isMachineTalk` 过滤挡住
4. **记忆存流水账**：存的是"我今天做了啥"，不是"关于人的印象"
5. **没有"家"的概念**：走远迷路，死了回出生点
6. **跑在开发机上**：没部署到服务器，开发机断网他就没了

## 服务器信息

- 地址 `s205.singsi.cn:19830`（Java TCP + Bedrock UDP 同端口）
- Paper 1.21.11（协议 774）
- Geyser b1279 + ViaVersion，基岩版客户端必须 ≤ 26.52.3
- 离线模式，死亡不掉落
- 玩家：Xylitol6983（叫"果哥"）

## 怎么跑

```bash
cd /root/workspace/minecraft-AIfriend
cp config.example.json config.json   # 填 API key
npm start
```

## 相关文档

- `docs/DESIGN.md` 完整设计
- `docs/memory.md` 记忆方案调研
- `docs/architecture.md` 架构调研
- 手机里：`/sdcard/Download/DSH-Go/项目盘点与我的判断.md`
