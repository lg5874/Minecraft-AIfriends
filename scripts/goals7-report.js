#!/usr/bin/env node
'use strict'
/**
 * 读一次真实运行的日志 + goals.json，出 #7 / 层3 的原始计数。
 *
 * 用法：
 *   node scripts/goals7-report.js --log data/probe-g7/run.log --data data/probe-g7/data
 *
 * 只读，不改任何东西。四项：
 *   1. 同一任务最多连续几遍（按 [will] 发下去的那句话）
 *   2. goals.json 里还有没有"零动作完成"的阶段
 *   3. 目标寿命中位数
 *   4. 目标完成率
 */

const fs = require('fs')
const path = require('path')

const argv = process.argv.slice(2)
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const LOG = argOf('log', 'data/probe-g7/run.log')
const DATA = argOf('data', 'data/probe-g7/data')

const raw = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n') : []
const ts = (line) => {
  const m = /^\[(\d{2}):(\d{2}):(\d{2})\]/.exec(line)
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null
}
// 只砍掉"（大目标：…）"这个尾巴；"（换个法子：…）"要留着 ——
// 换了法子就是换了一件事，不能再算"同一任务又念一遍"。
const normTask = (s) => String(s).replace(/（大目标：.*$/, '').trim()

// ---------------------------------------------------------------- 1b. 扫描同口径
// UNHUMAN-SCAN #7 用的是 `grep ">>> 开始：" | uniq -c`，这里照抄一遍，
// 方便和"改前 5 遍"直接对比。
const starts = raw.map(l => { const m = />>> 开始：(.+)$/.exec(l); return m ? m[1].trim() : null }).filter(Boolean)
{
  let r = 1; let mx = 1; let mxText = ''
  for (let i = 1; i < starts.length; i++) {
    if (starts[i] === starts[i - 1]) { r++; if (r > mx) { mx = r; mxText = starts[i] } } else r = 1
  }
  console.log(`\n[1b. 和扫描同口径]  >>> 开始 共 ${starts.length} 条，同一任务最多连续 ${mx} 遍${mxText ? '  —— ' + mxText : ''}`)
  starts.slice(0, 12).forEach((t, i) => console.log(`    ${String(i + 1).padStart(2)} ${t}`))
}

// ---------------------------------------------------------------- 1. 连续遍数
const tasks = []
for (const line of raw) {
  const m = /\[will\]\s*(.+)$/.exec(line)
  if (!m) continue
  const text = normTask(m[1])
  if (!text) continue
  tasks.push({ t: ts(line), text })
}
let run = 1
let maxRun = 1
let maxRunText = ''
const runs = []
for (let i = 1; i < tasks.length; i++) {
  if (tasks[i].text === tasks[i - 1].text) {
    run++
    if (run > maxRun) { maxRun = run; maxRunText = tasks[i].text }
  } else {
    runs.push({ text: tasks[i - 1].text, run })
    run = 1
  }
}
if (tasks.length) runs.push({ text: tasks[tasks.length - 1].text, run })
runs.sort((a, b) => b.run - a.run)
console.log(`\n[1. 同一任务连续几遍]  [will] 发出的任务共 ${tasks.length} 条`)
console.log('  最多连续：' + maxRun + ' 遍' + (maxRunText ? '  —— ' + maxRunText : ''))
console.log('  重复最多的前 8 段：')
runs.slice(0, 8).forEach(r => console.log(`    ${String(r.run).padStart(3)} × ${r.text}`))

// ---------------------------------------------------------------- 3/4. 目标寿命与完成率
const goals = []
let open = null
for (const line of raw) {
  const t = ts(line)
  let m = /\[goals\]\s*立了个长期目标[:：]\s*(.+)$/.exec(line)
  if (m) { open = { title: m[1].trim(), set: t, end: null, how: null, reason: '' }; goals.push(open); continue }
  m = /\[goals\]\s*放弃[:：]\s*(.+)$/.exec(line)
  if (m && open) { open.end = t; open.how = 'abandoned'; open.reason = m[1].trim(); open = null; continue }
  m = /\[goals\]\s*干完了[:：]\s*(.+)$/.exec(line)
  if (m && open) { open.end = t; open.how = 'done'; open = null }
}
const closed = goals.filter(g => g.end !== null)
const lives = closed.map(g => g.end - g.set).sort((a, b) => a - b)
const med = lives.length ? lives[Math.floor((lives.length - 1) / 2)] : null
const done = closed.filter(g => g.how === 'done').length
console.log(`\n[3. 目标寿命]  立了 ${goals.length} 个，结束 ${closed.length} 个`)
console.log('  寿命（秒）：' + JSON.stringify(lives))
console.log('  中位数：' + (med === null ? 'n/a' : med + 's'))
console.log(`\n[4. 目标完成率]  干完 ${done} / 结束 ${closed.length} = ${closed.length ? (done / closed.length * 100).toFixed(1) : 'n/a'}%`)
console.log('  明细：')
goals.forEach((g, i) => console.log(`    ${String(i + 1).padStart(2)}  ${g.title.slice(0, 34).padEnd(34)} ${g.end === null ? '还在进行' : (g.end - g.set) + 's'}  ${g.how || ''} ${g.reason ? ':: ' + g.reason.slice(0, 70) : ''}`))

// 换法子的日志
const switches = raw.filter(l => /换法子/.test(l))
console.log(`\n[#7 换法子日志]  ${switches.length} 条`)
switches.slice(0, 10).forEach(l => console.log('  ' + l.trim()))

// ---------------------------------------------------------------- 2. 零动作完成
console.log('\n[2. 零动作完成]')
const blocked = raw.filter(l => /拒绝白送/.test(l))
const skipped = raw.filter(l => /跳过「/.test(l))
console.log(`  日志里"拒绝白送"：${blocked.length} 条`)
blocked.slice(0, 6).forEach(l => console.log('    ' + l.trim()))
console.log(`  日志里"本来就不用做，跳过"：${skipped.length} 条`)
skipped.slice(0, 6).forEach(l => console.log('    ' + l.trim()))

const gf = path.join(DATA, 'goals.json')
if (fs.existsSync(gf)) {
  const d = JSON.parse(fs.readFileSync(gf, 'utf8'))
  const g = d.goal
  if (g) {
    console.log(`  当前目标：${g.title}（第 ${g.stageIndex + 1}/${g.stages.length} 步）`)
    g.stages.forEach((s, i) => {
      const finished = s.doneAt || i < g.stageIndex
      const zero = finished && !(s.work > 0) && !(s.attempts > 0) && !(s.best > 0)
      console.log(`    ${i + 1}. [${s.kind}] ${s.title}`)
      console.log(`       状态=${finished ? '已过' : '当前'} attempts=${s.attempts || 0} work=${(s.work || 0).toFixed ? (s.work || 0).toFixed(2) : s.work || 0} best=${(s.best || 0).toFixed(2)} idleWins=${s.idleWins || 0} methodIndex=${s.methodIndex || 0}${s.parked ? ' parked' : ''}${zero ? '   ← 零动作完成（可疑）' : ''}`)
    })
    const journal = (g.journal || []).map(j => j.text)
    console.log('  journal：')
    journal.slice(-10).forEach(t => console.log('    · ' + t))
  }
  const h = d.history || []
  if (h.length) {
    const hd = h.filter(x => x.result === 'done').length
    console.log(`  历史：${h.length} 条（干完 ${hd}，放弃 ${h.length - hd}）`)
    h.slice(-10).forEach(x => console.log(`    ${x.result === 'done' ? '干完' : '放弃'}  ${(x.key || '').slice(0, 26).padEnd(26)} ${x.stoppedAt || ''} ${x.reason ? ':: ' + x.reason.slice(0, 60) : ''}`))
  }
} else {
  console.log('  （没有 goals.json）')
}
