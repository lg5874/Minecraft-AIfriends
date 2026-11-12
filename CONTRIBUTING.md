# 怎么参与

## 你想改人设

改 `src/persona.js` 里的 `systemPrompt()`。里面是纯文本提示词，直接改就行。

改完跑 `npm run test:persona` 确认没弄坏别的。

## 你想让他懂更多游戏知识

改 `src/knowledge.js`。里面是分好类的常识条目。

**注意**：只放"正常玩家都懂的"。深层玩法（下界、附魔、红石）故意不写，让他自己摸。

## 你想加新的原子动作

改 `src/actions.js`，加一个 `async` 方法。然后在 `src/coder.js` 的 `apiDoc()` 里写上说明，
模型才知道有这个东西可以用。

## 你想改记忆机制

`src/memory/` 下按职责拆开了：

- `clock.js` 时间钟（下线不走）
- `entry.js` 记忆条目结构
- `decay.js` 衰减/模糊/归档
- `recall.js` 检索打分
- `writer.js` 写入判定（哪些话值得记）

改完跑 `npm run test:memory` 和 `npm run test:decay`。

## 你想改"像不像人"

- `taste.js` 品味怎么长
- `mood.js` 心情怎么变
- `persuasion.js` 说服怎么算
- `talk.js` 打字节奏、什么时候说话

改完跑 `npm run test:persona`。

## 提交前

```bash
npm run check    # 语法
npm test         # 全部测试
```

**别把 `config.json` 提交上去**（里面有 API key）。

## 代码风格

- 用中文注释，写清楚"为什么这么做"，不是"这行在干嘛"
- 不写死台词。所有他说的话都应该由模型按情境生成
- 加功能前先问：这让他更像人，还是更像工具？
