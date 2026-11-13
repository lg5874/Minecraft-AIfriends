#!/usr/bin/env node
'use strict'
/**
 * UNHUMAN-SCAN #3 / #14 的真机验收统计。
 *
 * 只读两份日志，不做任何推测：
 *   data/probe-social/stdout.log  被测 bot 的日志（[spont] / [say] / 事件）
 *   data/probe-social/driver.log  事件发生器日志（谁几点上下线）
 *
 * 输出：
 *   1. 玩家上下线招呼次数（事件数 / 招呼句数 / 覆盖人数）
 *   2. 主动说话的分布（对人 vs 对事）
 *   3. 刷屏指标（单分钟最多、10 分钟最多、重复句）
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const argv = process.argv.slice(2)
const argOf = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}

const BOT_LOG = path.join(ROOT, argOf('bot', 'data/probe-social/stdout.log'))
const DRV_LOG = path.join(ROOT, argOf('driver', 'data/probe-social/driver.log'))
const START = argOf('start', '')

const readLines = (p) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : []
const parseTs = (line) => {
  const m = /^\[(\d\d):(\d\d):(\d\d)\]/.exec(line)
  if (!m) return null
  return (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000
}

const botLines = readLines(BOT_LOG)
const drvLines = readLines(DRV_LOG)

// ---- 时间窗口（以驱动开始为准）----
let windowStart = null
if (START) {
  const m = /^(\d\d):(\d\d):(\d\d)$/.exec(START.trim())
  if (m) windowStart = (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000
}
const drvFirst = drvLines.map(parseTs).find(t => t !== null)
const drvLast = [...drvLines].reverse().map(parseTs).find(t => t !== null)
const t0 = windowStart !== null ? windowStart : drvFirst
const t1 = drvLast || (t0 + 10 * 60 * 1000)

const inWin = (t) => t !== null && t >= t0 && t <= t1 + 2000

// ---- 1. 事件发生器那边：真实上下线 ----
const drvEvents = []
for (const l of drvLines) {
  const t = parseTs(l)
  if (!inWin(t)) continue
  const mj = /\] (\S+) 上线了/.exec(l)
  const ml = /\] (\S+) 下线了/.exec(l)
  if (mj) drvEvents.push({ t, type: 'join', name: mj[1] })
  if (ml) drvEvents.push({ t, type: 'leave', name: ml[1] })
}
const joins = drvEvents.filter(e => e.type === 'join')

// ---- 2. bot 侧：所有主动说话的记录 ----
const spontSaid = []
const allSay = []
const merged = []
const skipped = []
const noSay = []
const repeatBlocked = []
const joinEventsSeen = []

for (const l of botLines) {
  const t = parseTs(l)
  if (!inWin(t)) continue

  let m = /\[say\]\s*(.+)$/.exec(l)
  if (m) allSay.push({ t, text: m[1].trim() })

  m = /\[spont\] 说 trigger=(\S+) kind=(\S+) people=(\S*)/.exec(l)
  if (m) spontSaid.push({ t, trigger: m[1], kind: m[2], people: m[3] === '-' ? [] : m[3].split(',') })

  m = /\[spont\] 合并 social x(\d+) → (.+)$/.exec(l)
  if (m) merged.push({ t, n: +m[1], names: m[2].split('、') })

  m = /\[spont\] 跳过 trigger=(\S+) reason=(\S+)/.exec(l)
  if (m) skipped.push({ t, trigger: m[1], reason: m[2] })

  m = /\[talk\] 模型不想说：(.+)$/.exec(l)
  if (m) noSay.push({ t, situation: m[1] })

  m = /\[spont\] 撤回重复事件：(.+)$/.exec(l)
  if (m) repeatBlocked.push({ t, situation: m[1] })

  m = /· (\S+) 上线了/.exec(l)
  if (m) joinEventsSeen.push({ t, name: m[1] })
}

// ---- 3. 把 [spont] 说 和 [say] 文本对齐（同一秒内最近的一条）----
const said = spontSaid.map(s => {
  const cand = allSay.filter(a => Math.abs(a.t - s.t) <= 2000)
  return { ...s, text: cand.length ? cand[cand.length - 1].text : '' }
})

// ---- 4. 指标 ----
const personKinds = new Set(['social'])
const person = said.filter(s => personKinds.has(s.kind))
const thing = said.filter(s => !personKinds.has(s.kind))

// 招呼：trigger 属于上下线
const greetTriggers = new Set(['playerJoin', 'playerLeave', 'playerJoinBatch'])
const greet = said.filter(s => greetTriggers.has(s.trigger))
const joinGreet = said.filter(s => s.trigger === 'playerJoin' || s.trigger === 'playerJoinBatch')
let coveredNames = new Set()
for (const g of joinGreet) for (const n of g.people) coveredNames.add(n)
// 合并句里的人数（[spont] 合并 已经展开成 people）

const proactive = said.slice()
const ts = proactive.map(s => s.t).sort((a, b) => a - b)
const tsAll = allSay.map(s => s.t).sort((a, b) => a - b)
const maxIn = (win) => {
  let best = 0
  for (let i = 0; i < ts.length; i++) {
    let c = 0
    for (let j = i; j < ts.length; j++) if (ts[j] - ts[i] < win) c++
    best = Math.max(best, c)
  }
  return best
}

const freq = {}
for (const s of allSay) freq[s.text] = (freq[s.text] || 0) + 1
const dups = Object.entries(freq).filter(([, n]) => n > 1)

const byTrigger = {}
for (const s of said) byTrigger[s.trigger] = (byTrigger[s.trigger] || 0) + 1
const skipByReason = {}
for (const s of skipped) skipByReason[s.reason] = (skipByReason[s.reason] || 0) + 1

const clock = (t) => {
  const sec = Math.floor(t / 1000)
  const h = Math.floor(sec / 3600) % 24
  const mm = Math.floor(sec / 60) % 60
  const ss = sec % 60
  return [h, mm, ss].map(x => String(x).padStart(2, '0')).join(':')
}
const dur = ((t1 - t0) / 60000).toFixed(1)

// ---- 5. 打印原始数据 ----
console.log('================ 真机验收原始数据 ================')
console.log(`窗口：${clock(t0)} → ${clock(t1)}（${dur} 分钟）`)
console.log(`日志：${BOT_LOG}`)
console.log(`      ${DRV_LOG}`)
console.log('')

console.log('【1】玩家上下线')
console.log(`  驱动制造的上下线事件：${drvEvents.length} 次（上线 ${joins.length} / 下线 ${drvEvents.length - joins.length}）`)
const seenNames = new Set()
for (const l of botLines) {
  const t = parseTs(l); if (!inWin(t)) continue
  const m = /(TMGprobe\d)/.exec(l)
  if (m && /\[spont\]|不想说|上线了/.test(l)) seenNames.add(m[1])
}
console.log(`  bot 侧经手过的玩家（出现在 [spont]/拒绝记录里）：${seenNames.size} 个 → ${[...seenNames].sort().join(',')}`)
console.log(`  真说出口的招呼句：${greet.length} 句（上线 ${joinGreet.length} / 下线 ${greet.length - joinGreet.length}）`)
console.log(`  其中「合并多人」句：${joinGreet.filter(s => s.trigger === 'playerJoinBatch').length} 句，覆盖 ${coveredNames.size} 个不同玩家`)
console.log(`  合并事件：${merged.length} 次（原始 ${merged.reduce((a, m) => a + m.n, 0)} 条 → ${merged.length} 句）`)
if (greet.length) {
  console.log('  招呼明细：')
  for (const g of greet) console.log(`    ${clock(g.t)} [${g.trigger}] ${g.people.join(',') || '-'} → "${g.text}"`)
} else {
  console.log('  招呼明细：（一句都没有）')
}

console.log('')
console.log('【2】主动说话分布')
console.log(`  总句数：${said.length}（对人 ${person.length} / 对事 ${thing.length}）`)
console.log(`  对事细分：` + (thing.length ? '' : '无'))
for (const s of thing) console.log(`    ${clock(s.t)} [${s.trigger}] "${s.text}"`)
console.log('  按触发源：')
for (const [k, v] of Object.entries(byTrigger).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(16)} ${v}`)
console.log('  没说出来（跳过原因）：')
for (const [k, v] of Object.entries(skipByReason).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(16)} ${v}`)
console.log(`  模型自己拒说（[不说]）：${noSay.length} 次`)
console.log(`  复读拦截：${repeatBlocked.length} 次`)

console.log('')
console.log('【3】刷屏检查')
console.log(`  主动句（[spont] 说）：${said.length} 句 / ${dur} 分钟`)
console.log(`    任意 60 秒内最多：${maxIn(60000)} 句`)
console.log(`    任意 10 分钟内最多：${maxIn(600000)} 句`)
console.log(`  全部 [say] 行（含回别人话）：${allSay.length} 句`)
const maxAll = (win) => { let best=0; for (let i=0;i<tsAll.length;i++){ let c=0; for(let j=i;j<tsAll.length;j++) if(tsAll[j]-tsAll[i]<win) c++; best=Math.max(best,c) } return best }
console.log(`    任意 60 秒内最多：${maxAll(60000)} 句`)
console.log(`    任意 10 分钟内最多：${maxAll(600000)} 句`)
console.log(`  重复句：${dups.length} 种${dups.length ? '：' + dups.map(([t, n]) => `"${t}"×${n}`).join(' ') : ''}`)
console.log('')
console.log('  全部发言时间轴：')
for (const s of allSay) console.log(`    ${clock(s.t)} "${s.text}"`)
