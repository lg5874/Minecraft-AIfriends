#!/usr/bin/env node
'use strict'
/**
 * 探针：验证 UNHUMAN-SCAN #1 / #6 / #9 三条修复的真机效果。
 *
 * 用法：
 *   node scripts/probe-unhuman.js --minutes 10
 *   node scripts/probe-unhuman.js --minutes 10 --account XJJ_PROBE
 *
 * ------------------------------------------------------------------
 * 为什么单独一个脚本，而不是塞进 test-e2e.js
 * ------------------------------------------------------------------
 * test-e2e 测的是"能不能做成事"（离散任务，成功/失败）。
 * 这次要测的是**行为特征**（连续观测）：
 *   · 纯标点 say 出现几次
 *   · 「走不通了」刷几次
 *   · 长期目标活了多久
 *   · 最长静止多少秒
 * 这些必须跑一段真实时间、让 bot 自己跑主循环才测得出来。
 *
 * ------------------------------------------------------------------
 * 环境隔离（Lead 硬要求）
 * ------------------------------------------------------------------
 * 1. 独立账号，默认 XJJ_PROBE + 随机后缀；绝不用 XJJ
 * 2. 独立数据目录（AIFRIEND_DATA），不污染 data/runtime 的记忆/心情/目标
 * 3. 记录 commit hash，结果能对应到代码版本
 * 4. 不碰 src/ —— 只读日志，不改行为
 */

const path = require('path')
const fs = require('fs')
const { execSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')

const argv = process.argv.slice(2)
const argOf = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}

const MINUTES = parseFloat(argOf('minutes', '10')) || 10
const DURATION_MS = MINUTES * 60 * 1000
const ACCOUNT = argOf('account', 'XJJ_PROBE') + Math.random().toString(36).slice(2, 5)
const TAG = argOf('tag', '')

// 独立数据目录：绝不动 data/runtime（正式 bot 的记忆在那里）
const DATA_DIR = path.join('data', 'probe-unhuman', ACCOUNT)
process.env.AIFRIEND_DATA = DATA_DIR

const sleep = ms => new Promise(r => setTimeout(r, ms))
const now = () => new Date().toISOString()
const clock = () => new Date().toTimeString().slice(0, 8)

// ==================================================================
// 0. 代码版本（结果必须能对应到某个 commit）
// ==================================================================
function codeRev () {
  try {
    const rev = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()
    const dirty = execSync('git status --porcelain -- src main.js', { cwd: ROOT, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean)
    return { rev, dirty }
  } catch (e) {
    return { rev: 'unknown', dirty: [] }
  }
}

// ==================================================================
// 1. 指标采集器
// ==================================================================
//
// 全部从**日志行**里数，不去问 bot 内部状态 ——
// 内部状态可能是它自己编的，日志是它真的做了什么。

const M = {
  // #1 纯标点说话
  sayTotal: 0,
  sayPunctOnly: 0,
  sayPunctSamples: [],

  // #6 走不通
  unreachable: 0,
  unreachableSamples: [],

  // #9 目标寿命
  goalSet: [],      // {at, text}
  goalAbandon: [],  // {at, text, reason}
  goalDone: [],     // {at, text}
  goalLives: [],    // 秒

  // 静止
  heartbeats: [],   // {at, pos}
  maxStillSec: 0,

  // 任务成败（配合 #8 判据修复）
  taskStart: 0,
  taskDone: 0,
  taskFail: 0,
  failReasons: [],

  // 通用
  lines: 0
}

const PUNCT_ONLY = /^[\s\p{P}\p{S}]*$/u

function feed (line) {
  M.lines++
  const t = String(line)

  // ---- #1 纯标点 say ----
  // 日志形如：  [say] 。
  const mSay = /\[say\]\s*(.*)$/.exec(t)
  if (mSay) {
    const said = mSay[1].trim()
    M.sayTotal++
    if (said && PUNCT_ONLY.test(said)) {
      M.sayPunctOnly++
      if (M.sayPunctSamples.length < 10) M.sayPunctSamples.push(JSON.stringify(said))
    }
  }

  // ---- #6 走不通 ----
  if (/走不通了/.test(t)) {
    M.unreachable++
    if (M.unreachableSamples.length < 8) M.unreachableSamples.push(t.slice(0, 80))
  }

  // ---- #9 长期目标 ----
  const mSet = /\[goals\]\s*(?:立了个长期目标|自己定了个方向)[:：]\s*(.+)$/.exec(t)
  if (mSet) {
    M.goalSet.push({ at: Date.now(), text: mSet[1].slice(0, 60) })
  }
  const mAbandon = /\[goals\]\s*放弃[:：]\s*(.+)$/.exec(t)
  if (mAbandon) {
    const text = mAbandon[1].slice(0, 60)
    M.goalAbandon.push({ at: Date.now(), text })
    // 找最近一个还没结束的目标
    const open = M.goalSet.filter(g => !g.closed)
    if (open.length) {
      const g = open[open.length - 1]
      g.closed = true
      g.endAt = Date.now()
      g.how = 'abandon'
      M.goalLives.push({ secs: (g.endAt - g.at) / 1000, text: g.text, how: 'abandon' })
    }
  }

  // ---- 任务成败 ----
  if (/^\[\d\d:\d\d:\d\d\]\s*>>>\s*开始[:：]/.test(t)) M.taskStart++
  const mDone = /<<<\s*完成（(\d+)s）[:：]\s*(.*)$/.exec(t)
  if (mDone) {
    M.taskDone++
  }
  const mFail = /<<<\s*失败（(\d+)s）[:：]\s*(.*)$/.exec(t)
  if (mFail) {
    M.taskFail++
    if (M.failReasons.length < 20) M.failReasons.push(mFail[2].slice(0, 70))
  }

  // ---- 心跳坐标（静止检测）----
  // [hb] 62,71,-1 血20 饿20 背包19种 忙:xxx 心情:xxx
  const mHb = /\[hb\]\s*(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(t)
  if (mHb) {
    M.heartbeats.push({ at: Date.now(), x: +mHb[1], y: +mHb[2], z: +mHb[3] })
  }
}

// ==================================================================
// 2. 统计
// ==================================================================
function summarize () {
  // 静止：相邻心跳坐标完全一致视为静止
  let maxStill = 0
  let stillFrom = null
  for (let i = 1; i < M.heartbeats.length; i++) {
    const a = M.heartbeats[i - 1]
    const b = M.heartbeats[i]
    const same = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) < 0.5
    if (same) {
      if (stillFrom === null) stillFrom = a.at
      const secs = (b.at - stillFrom) / 1000
      if (secs > maxStill) maxStill = secs
    } else {
      stillFrom = null
    }
  }

  // 移动范围
  let range = null
  if (M.heartbeats.length) {
    const xs = M.heartbeats.map(h => h.x)
    const ys = M.heartbeats.map(h => h.y)
    const zs = M.heartbeats.map(h => h.z)
    range = {
      dx: +(Math.max(...xs) - Math.min(...xs)).toFixed(1),
      dy: +(Math.max(...ys) - Math.min(...ys)).toFixed(1),
      dz: +(Math.max(...zs) - Math.min(...zs)).toFixed(1)
    }
  }

  const lives = M.goalLives.map(g => g.secs).sort((a, b) => a - b)
  const median = lives.length
    ? lives[Math.floor(lives.length / 2)]
    : null

  return {
    maxStill,
    range,
    goalLifeCount: lives.length,
    goalLifeMedian: median,
    goalLifeMin: lives.length ? lives[0] : null,
    goalLifeMax: lives.length ? lives[lives.length - 1] : null,
    goalLifeAll: lives.map(v => Math.round(v))
  }
}

// ==================================================================
// 3. 主流程
// ==================================================================

async function main () {
  const { rev, dirty } = codeRev()

  const outDir = path.join(ROOT, 'data', 'test-results')
  fs.mkdirSync(outDir, { recursive: true })
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}${TAG ? '-' + TAG : ''}`

  console.log('='.repeat(66))
  console.log('  UNHUMAN #1/#6/#9 真机探针')
  console.log('='.repeat(66))
  console.log(`代码版本  : ${rev}${dirty.length ? ` ⚠️ 有未提交改动 ${dirty.length} 个文件` : '（干净）'}`)
  if (dirty.length) dirty.forEach(d => console.log(`             ${d}`))
  console.log(`账号      : ${ACCOUNT}（独立）`)
  console.log(`数据目录  : ${DATA_DIR}（独立，不碰 data/runtime）`)
  console.log(`时长      : ${MINUTES} 分钟`)
  console.log(`基线对照  : 走不通 482次/1002s ｜ 纯标点say 5次/25min ｜ 目标寿命中位 8s ｜ 最长静止 270s`)
  console.log('='.repeat(66) + '\n')

  // ---- 直接跑正式 bot 主循环，但用独立账号/数据目录 ----
  // 不改 main.js，用环境变量隔离
  process.env.AIFRIEND_CONFIG = 'config.json'

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
  cfg.bot.username = ACCOUNT
  cfg.behavior = cfg.behavior || {}
  // 让它别一上来就 reconnect 到别处
  cfg.behavior.reconnectDelaySeconds = 15

  // 写一份临时 config（main.js 从文件读配置，不吃我们内存里的改动）
  const tmpCfg = path.join(ROOT, 'data', `probe-config-${ACCOUNT}.json`)
  fs.writeFileSync(tmpCfg, JSON.stringify(cfg, null, 2))
  process.env.AIFRIEND_CONFIG = path.relative(ROOT, tmpCfg)

  const { Bot } = require(path.join(ROOT, 'main.js'))

  // 拦截 console.log 做指标采集，同时保留原始输出
  const rawLog = []
  const origLog = console.log.bind(console)
  console.log = (...args) => {
    const line = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ')
    rawLog.push(line)
    feed(line)
    origLog(...args)
  }

  const b = new Bot(cfg)
  b.connect()

  const t0 = Date.now()
  // 每 30 秒打一次进度
  const ticker = setInterval(() => {
    const el = Math.round((Date.now() - t0) / 1000)
    const left = Math.round((DURATION_MS - (Date.now() - t0)) / 1000)
    console.log(`[probe] 已跑 ${el}s / 剩 ${left}s ｜ 走不通 ${M.unreachable} ｜ say ${M.sayTotal}(纯标点 ${M.sayPunctOnly}) ｜ 任务 ${M.taskDone}成/${M.taskFail}败 ｜ 目标 ${M.goalSet.length}立/${M.goalLives.length}终`)
  }, 30000)

  await sleep(DURATION_MS)
  clearInterval(ticker)

  // ---- 收尾 ----
  try { b.shutdown() } catch (e) {}
  await sleep(1500)

  const sum = summarize()

  console.log('\n' + '='.repeat(66))
  console.log('  原始统计（不经加工）')
  console.log('='.repeat(66))
  console.log(`日志行数          : ${M.lines}`)
  console.log(`心跳样本          : ${M.heartbeats.length}`)
  console.log('')
  console.log(`【#1 纯标点 say】`)
  console.log(`  say 总次数      : ${M.sayTotal}`)
  console.log(`  其中纯标点      : ${M.sayPunctOnly}   ← 基线 5 次/25min，目标 0`)
  if (M.sayPunctSamples.length) {
    console.log(`  样本            : ${M.sayPunctSamples.join('  ')}`)
  }
  console.log('')
  console.log(`【#6 走不通了】`)
  console.log(`  次数            : ${M.unreachable}   ← 基线 482 次/1002s`)
  const per1000 = DURATION_MS > 0 ? (M.unreachable / (DURATION_MS / 1000) * 1000) : 0
  console.log(`  折算每 1000 秒  : ${per1000.toFixed(1)} 次   ← 目标 <20`)
  if (M.unreachableSamples.length) {
    M.unreachableSamples.forEach(s => console.log(`    ${s}`))
  }
  console.log('')
  console.log(`【#9 长期目标寿命】`)
  console.log(`  立目标次数      : ${M.goalSet.length}`)
  console.log(`  已结束          : ${M.goalLives.length}`)
  console.log(`  寿命中位数      : ${sum.goalLifeMedian === null ? 'n/a' : Math.round(sum.goalLifeMedian) + 's'}   ← 基线 8s，目标 >300s`)
  console.log(`  最短 / 最长     : ${sum.goalLifeMin === null ? 'n/a' : Math.round(sum.goalLifeMin) + 's'} / ${sum.goalLifeMax === null ? 'n/a' : Math.round(sum.goalLifeMax) + 's'}`)
  if (sum.goalLifeAll.length) console.log(`  全部寿命        : ${sum.goalLifeAll.join(', ')}`)
  console.log('')
  console.log(`【静止与移动】`)
  console.log(`  最长静止        : ${Math.round(sum.maxStill)}s   ← 基线 270s，目标 <30s`)
  if (sum.range) {
    console.log(`  坐标范围        : dx=${sum.range.dx} dy=${sum.range.dy} dz=${sum.range.dz}   ← 基线 dx=3 dy=25 dz=2`)
  }
  console.log('')
  console.log(`【任务成败（配合 #8 判据修复）】`)
  console.log(`  开始 / 完成 / 失败 : ${M.taskStart} / ${M.taskDone} / ${M.taskFail}`)
  const total = M.taskDone + M.taskFail
  console.log(`  成功率          : ${total ? Math.round(M.taskDone / total * 100) : 0}%   ← 基线 98%（假成功）`)
  if (M.failReasons.length) {
    console.log('  失败原因：')
    M.failReasons.forEach((r, i) => console.log(`    ${i + 1}. ${r}`))
  }

  // ---- 落盘 ----
  const report = {
    runId, at: now(), account: ACCOUNT, codeRev: rev, codeDirty: dirty,
    minutes: MINUTES,
    raw: {
      sayTotal: M.sayTotal,
      sayPunctOnly: M.sayPunctOnly,
      sayPunctSamples: M.sayPunctSamples,
      unreachable: M.unreachable,
      unreachablePer1000s: +per1000.toFixed(1),
      taskStart: M.taskStart,
      taskDone: M.taskDone,
      taskFail: M.taskFail,
      failReasons: M.failReasons,
      heartbeats: M.heartbeats.length,
      goalSet: M.goalSet.length,
      goalLives: M.goalLives.map(g => ({ secs: Math.round(g.secs), text: g.text, how: g.how }))
    },
    derived: sum
  }
  const outFile = path.join(outDir, `unhuman-${runId}.json`)
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2))
  const logFile = path.join(outDir, `unhuman-${runId}.log`)
  fs.writeFileSync(logFile, rawLog.join('\n'))

  console.log(`\n结果已存: ${path.relative(ROOT, outFile)}`)
  console.log(`原始日志: ${path.relative(ROOT, logFile)}`)

  try { fs.unlinkSync(tmpCfg) } catch (e) {}
  process.exit(0)
}

main().catch(e => {
  console.error('探针崩溃:', e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n') : e)
  process.exit(2)
})
