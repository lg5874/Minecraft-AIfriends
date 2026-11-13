#!/usr/bin/env node
/**
 * 长跑采样器：按固定间隔从 bot.log 里抽关键指标，输出一行 CSV。
 *
 * 【为什么需要它】
 * 60 分钟长跑只靠人肉 grep 会漏，而且事后补不出来——
 * 「第 20 分钟发生了什么」在滚动日志里找不回来。
 *
 * 【参谋定的四个指标】
 *   被踢次数 / 429 次数 / [say] 成功次数 / 真实完成任务数（背包对得上）
 *
 * 用法：
 *   node scripts/sample-soak.js --log /tmp/soak.log --out /tmp/soak.csv
 *   node scripts/sample-soak.js --log /tmp/soak.log --out /tmp/soak.csv --interval 60
 *
 * 只读日志，不碰 bot、不连服务器。
 */

const fs = require('fs')
const path = require('path')

const argv = process.argv.slice(2)
function arg (name, def) {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}

const LOG = arg('log', '/tmp/soak.log')
const OUT = arg('out', '/tmp/soak.csv')
const INTERVAL = Number(arg('interval', '60')) * 1000

if (!fs.existsSync(LOG)) {
  console.error('日志不存在: ' + LOG)
  process.exit(1)
}

// ---- 计数器：每次都从头扫（日志不大，避免增量丢行的坑）----
function count (re) {
  const s = fs.readFileSync(LOG, 'utf8')
  const m = s.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))
  return m ? m.length : 0
}

function metrics () {
  const kicks = count(/disconnect\.spam/g) + count(/Connection throttled/g)
  const r429 = count(/HTTP 429/g) + count(/rate_limit/g)
  const says = count(/\[say\] /g)
  const started = count(/>>> 开始：/g)
  const done = count(/<<< 完成（/g)
  const failed = count(/<<< 失败（/g)
  // 「真实完成」= 有 [proof] 背书的完成
  const proofOk = count(/\[proof\] 硬判据通过/g)
  const deaths = count(/\[death\]/g)
  const falls = count(/\[fall\] 落差/g)
  const stillStuck = count(/\[stuck\] 同一格站了/g)
  const lines = fs.readFileSync(LOG, 'utf8').split('\n').length
  return {
    at: new Date().toISOString().slice(11, 19),
    lines, kicks, r429, says, started, done, failed, proofOk, deaths, falls, stillStuck
  }
}

const HEADER = 'time,lines,kicks,429,says,started,done,failed,proof_ok,deaths,falls,stuck'
if (!fs.existsSync(OUT)) fs.writeFileSync(OUT, HEADER + '\n')

function tick () {
  const m = metrics()
  const row = [m.at, m.lines, m.kicks, m.r429, m.says, m.started, m.done, m.failed, m.proofOk, m.deaths, m.falls, m.stillStuck].join(',')
  fs.appendFileSync(OUT, row + '\n')
  // 同时打一行人看的摘要
  console.log(`[${m.at}] 行${m.lines} | 被踢${m.kicks} 429:${m.r429} | 说${m.says} | ` +
    `任务 开${m.started}/成${m.done}/败${m.failed}（背书${m.proofOk}） | 死${m.deaths} 摔${m.falls} 卡${m.stillStuck}`)
}

tick()
const t = setInterval(tick, INTERVAL)

process.on('SIGINT', () => { clearInterval(t); console.log('\nCSV: ' + OUT); process.exit(0) })
process.on('SIGTERM', () => { clearInterval(t); process.exit(0) })
