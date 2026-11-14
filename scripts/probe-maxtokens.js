#!/usr/bin/env node
'use strict'
/**
 * 实测：max_tokens 是天花板还是消耗？
 *
 * 同一个 prompt（impulse.askWhatElse 的真实那条），分别传 80 / 600，
 * 对比 usage.completion_tokens。
 *
 * 结论应当是：**上限提高，实际消耗不变**（差异只有随机波动）。
 * 只读：不写 config、不连 MC、不碰 bot。
 *
 *   node scripts/probe-maxtokens.js [--tries 3]
 */
const path = require('path')
const ROOT = path.resolve(__dirname, '..')
process.chdir(ROOT)

const { LLM } = require('../src/llm')
const cfg = require('../config.json')

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d }
const TRIES = Number(arg('tries', '3'))

const PROMPT = `你正在挖点石头，干了一会儿了。

现在的处境：
位置 128,47,-330，黄昏
周围看到：stone(412) dirt(88) coal_ore(6) oak_log(3) water(2)
心情一般，精力还行

你突然有点想干别的。想干嘛？

要求：
- 一句话，具体，能马上动手
- 不需要有什么正当理由，"想上去看看"、"这块石头颜色挺好看"都行
- 别说什么"继续挖矿"这种废话
- 如果你其实不想走神，就只输出 [继续]`

async function one (llm, maxTokens, prompt) {
  const t0 = Date.now()
  const r = await llm.chat([{ role: 'user', content: prompt }], { maxTokens, temperature: 1.2 })
  const u = (r.raw && r.raw.usage) || {}
  return {
    maxTokens,
    completion: u.completion_tokens,
    reasoning: u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens,
    prompt: u.prompt_tokens,
    finish: r.finish,
    ms: Date.now() - t0,
    text: String(r.text || '').replace(/\n/g, ' ').slice(0, 46)
  }
}

// 第二个场景：需求本身很短（will 的"只回一句话"）。两档都远超需求，
// 用来验证"上限 ≠ 消耗"——这时两档应该消耗几乎一样。
const SHORT = `你现在在自己的世界里，没人管你。

【你在哪】你现在在地表附近（y=68）。附近有树。
坐标 128,68,-330，白天，血 18，饿 15。
背包：oak_logx3 dirtx2

你现在想干点什么？挑一件你现在就能开始动手的事。
只回一句话，不要解释。`

;(async () => {
  const llm = new LLM(cfg.llm)
  const run = async (label, pairs, prompt) => {
    const rows = []
    for (let i = 0; i < TRIES; i++) {
      for (const n of pairs) rows.push(await one(llm, n, prompt))
    }
    console.log('\n=== ' + label + ' ===')
    console.log('max_tokens  completion  reasoning  finish        ms   输出')
    for (const r of rows) {
      console.log(
        String(r.maxTokens).padEnd(11) +
        String(r.completion).padEnd(12) +
        String(r.reasoning == null ? '-' : r.reasoning).padEnd(11) +
        String(r.finish).padEnd(14) +
        String(r.ms).padEnd(6) +
        (r.text || '（空）')
      )
    }
    const avg = n => {
      const xs = rows.filter(r => r.maxTokens === n).map(r => r.completion).filter(x => typeof x === 'number')
      return xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length) : NaN
    }
    const trunc = n => rows.filter(r => r.maxTokens === n && r.finish === 'length').length
    const empty = n => rows.filter(r => r.maxTokens === n && !r.text).length
    console.log(pairs.map(n => `${n} → 均 ${avg(n).toFixed(1)} tok / 截断 ${trunc(n)} / 空 ${empty(n)}`).join(' | '))
    return { rows, avg, trunc }
  }

  // 场景 A：冲动那条真 prompt —— 有思考，需求会顶到 80
  await run('A. 冲动 askWhatElse（thinking 会吃预算）', [80, 600], PROMPT)
  // 场景 B：短回答，两档都远超需求
  await run('B. will 短回答（160 vs 800，都远超需求）', [160, 800], SHORT)

  llm.destroy && llm.destroy()
})()
