'use strict'
// 真机日志时间账：10 分钟到底花在哪。
//
// 为什么要有它：吞吐只有 0.2–0.5 任务/分钟，凭印象猜"卡在找路"不算数。
// 这里用**相邻两行的时间差**给每一秒归因（归给前一行所属的类别），
// 再按类别汇总。粗糙但可复现，足够回答"瓶颈在哪"。
//
// 用法：node scripts/analyze-throughput.js data/test-results/p8-surface2.log

const fs = require('fs')

const file = process.argv[2]
if (!file) {
  console.log('用法: node scripts/analyze-throughput.js <bot.log>')
  process.exit(1)
}

const CATS = [
  ['任务中(代码执行)', /\[code\]|\[act\]|\[skill\]/],
  ['幸存/找吃的', /\[survive\]|\[food\]|\[reflex\]|\[danger\]/],
  ['说话/社交', /\[talk\]|\[chat\]|\[spontaneous\]|\[spont\]|\[invite\]|\[watched\]|\[audience\]/],
  ['模型调用', /\[llm\]|\[will\]|\[goals\]|\[impulse\]/],
  ['空闲/心跳', /\[hb\]|\[idle\]|\[stall\]|\[stuck\]/],
  ['路径/移动', /\[path\]|\[home\]|\[surface\]/]
]

function catOf (line) {
  for (const [name, re] of CATS) if (re.test(line)) return name
  return '其它'
}

const raw = fs.readFileSync(file, 'utf8').split('\n')
const rows = []
for (const line of raw) {
  const m = /^\[(\d\d):(\d\d):(\d\d)\]\s?(.*)$/.exec(line)
  if (!m) continue
  rows.push({
    t: (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]),
    text: line
  })
}
if (rows.length < 2) {
  console.log('日志里没有可解析的时间戳')
  process.exit(1)
}

const total = rows[rows.length - 1].t - rows[0].t
const byCat = {}
const tasks = []
let curTask = null

for (let i = 0; i < rows.length - 1; i++) {
  const dt = Math.min(600, Math.max(0, rows[i + 1].t - rows[i].t)) // 单行最多归因 10 分钟（断线/挂起）
  const c = catOf(rows[i].text)
  byCat[c] = (byCat[c] || 0) + dt
}

// 任务边界
for (const r of rows) {
  const mStart = />>>\s*开始[:：]\s*(.*)$/.exec(r.text)
  if (mStart) curTask = { at: r.t, goal: mStart[1].slice(0, 40), end: null, how: null }
  const mEnd = /<<<\s*(完成|失败)（(\d+)s）/.exec(r.text)
  if (mEnd && curTask) {
    curTask.end = r.t
    curTask.how = mEnd[1]
    curTask.secs = +mEnd[2]
    tasks.push(curTask)
    curTask = null
  }
}

const mins = total / 60
console.log(`日志跨度 ${Math.round(total)}s（${mins.toFixed(1)} 分钟）｜行数 ${rows.length}`)
console.log('\n时间归因（按相邻行时间差，归给前一行所属类别）：')
for (const [c, s] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
  const pct = total ? (s / total * 100) : 0
  const bar = '█'.repeat(Math.round(pct / 4))
  console.log(`  ${c.padEnd(16, ' ')} ${String(Math.round(s)).padStart(5)}s ${pct.toFixed(0).padStart(3)}%  ${bar}`)
}

const judged = tasks.filter(t => t.how)
console.log(`\n跑完的任务 ${judged.length} 个（${mins.toFixed(1)} 分钟）` +
  ` → 吞吐 ${(judged.length / mins).toFixed(2)} 个/分钟`)
for (const t of judged) console.log(`  ${t.how} ${String(t.secs).padStart(4)}s｜${t.goal}`)
const unfinished = rows.filter(r => />>>\s*开始/.test(r.text)).length - judged.length
if (unfinished > 0) console.log(`  （还有 ${unfinished} 个任务在跑/被打断）`)
