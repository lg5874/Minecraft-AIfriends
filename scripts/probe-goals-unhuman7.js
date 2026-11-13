#!/usr/bin/env node
'use strict'
/**
 * 探针：UNHUMAN-SCAN #7 的数据（同一任务连做几遍 / 目标寿命 / 目标选择分布）。
 *
 * 两段：
 *   A. 真实运行留下的 data/runtime/goals.json（改前，maxIdleWins=5 那版跑出来的）
 *   B. 回放：把主循环的节奏（1.6 秒一趟、30 秒 observe 一次、判成功但进度不动）
 *      跑在**两个版本的 goals.js** 上 —— 112917d 的（#9 已修、#7 没修）
 *      和当前工作区的（#7 已修）。同一套输入，只比这两版。
 *
 * 注意：B 段是回放，不是连服务器实测。1.6 秒/趟 这个数来自
 * UNHUMAN-SCAN #7 的原始观测（"一趟任务 1~2 秒"），不是猜的。
 *
 * 用法：node scripts/probe-goals-unhuman7.js
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const GOALS_JSON = path.join(ROOT, 'data', 'runtime', 'goals.json')
const TASK_MS = 1600           // 一趟任务 1.6 秒（#7 原始观测）
const OBSERVE_MS = 30000       // main.js 里 observeGoals 的节流
const argv = process.argv.slice(2)
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const SIM_MS = (parseFloat(argOf('minutes', '20')) || 20) * 60 * 1000
const MODE = argOf('mode', 'stall')   // stall = 判成功但世界不变（#8 现状）；work = 每趟真的+1
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'probe7-'))

const STATS = (arr) => {
  const a = arr.slice().sort((x, y) => x - y)
  if (!a.length) return { n: 0 }
  const at = (p) => a[Math.min(a.length - 1, Math.max(0, Math.floor((a.length - 1) * p)))]
  return {
    n: a.length,
    min: +a[0].toFixed(1),
    p10: +at(0.1).toFixed(1),
    p50: +at(0.5).toFixed(1),
    p90: +at(0.9).toFixed(1),
    max: +a[a.length - 1].toFixed(1)
  }
}

// ---------------------------------------------------------------- A. 真实数据
function partA () {
  if (!fs.existsSync(GOALS_JSON)) {
    console.log('  （没有 data/runtime/goals.json，跳过）')
    return null
  }
  const d = JSON.parse(fs.readFileSync(GOALS_JSON, 'utf8'))
  const h = d.history || []
  console.log(`\n[A. 真实运行数据] data/runtime/goals.json  history=${h.length} 条`)
  console.log('  #   时间(本地)          结果      key                                   停止在哪一步 / 理由')
  const lives = []
  const keyCount = {}
  let prev = null
  h.forEach((x, i) => {
    const ts = new Date(x.at).toLocaleString('zh-CN', { hour12: false })
    const life = prev ? (x.at - prev) / 1000 : null
    if (life !== null) lives.push(life)
    prev = x.at
    keyCount[x.key] = (keyCount[x.key] || 0) + 1
    const tag = x.result === 'done' ? '干完' : '放弃'
    const why = x.result === 'done' ? `${x.stages} 步 ${x.tookMin} 分钟` : (x.reason || '')
    console.log(`  ${String(i + 1).padStart(2)}  ${ts}  ${tag}  ${(x.key || '').slice(0, 30).padEnd(30)}  ${x.stoppedAt || ''}${why ? ' :: ' + why : ''}${life !== null ? '   [上一段 ' + life.toFixed(0) + 's]' : ''}`)
  })

  // 同一条放弃理由里的"干了 N 趟"
  const reps = h.filter(x => /干了 \d+ 趟/.test(x.reason || '')).map(x => +x.reason.match(/干了 (\d+) 趟/)[1])
  console.log('\n  「干了 N 趟都说成了」的记录：' + reps.length + ' 条，N 的取值 ' + JSON.stringify([...new Set(reps)]))
  console.log('  同一阶段最多连续干了几遍：' + (reps.length ? Math.max(...reps) : 0))

  // 连续"同一个 key"的段数
  let run = 0
  let maxRun = 0
  let lastKey = null
  for (const x of h) {
    if (x.key === lastKey) run++
    else { run = 1; lastKey = x.key }
    maxRun = Math.max(maxRun, run)
  }
  console.log('  同一个目标 key 连续出现的最长段：' + maxRun)

  console.log('  相邻两次收尾的间隔（秒）：' + JSON.stringify(STATS(lives)))
  const instant = lives.filter(v => v < 60).length
  console.log(`  间隔 < 60 秒（≈立了立刻放弃）：${instant}/${lives.length}`)
  console.log('  目标选择分布：' + JSON.stringify(keyCount))
  return { reps: reps.length ? Math.max(...reps) : 0, lives: STATS(lives), instant, total: lives.length, keyCount }
}

// ---------------------------------------------------------------- B. 回放
/** 把某版本的 goals.js 落到临时目录（它只 require fs/path，独立可跑） */
function loadVersion (name, source) {
  const f = path.join(TMP, name + '.js')
  fs.writeFileSync(f, source, 'utf8')
  return require(f)
}

function fakeStatus () {
  return {
    pos: { x: 0, y: 70, z: 0 },
    health: 20,
    food: 18,
    time: '白天',
    dimension: 'overworld',
    weather: '晴',
    held: null,
    // 背包固定：一趟接一趟地"说成了"，但东西一个也不会多（#8 的假成功）
    inventory: { stone_pickaxe: 1, cobblestone: 12, oak_log: 6, torch: 3, bread: 2 }
  }
}

async function simulate (label, GoalsMod, mode = MODE) {
  const dir = fs.mkdtempSync(path.join(TMP, 'data-'))
  let t = 1000000
  const logs = []
  const g = new GoalsMod(dir, {
    ctx: { log: (s) => { logs.push({ t, s }) } },
    cfg: {},
    now: () => t
  })
  let status = fakeStatus()
  const goals = []       // 每个目标：{key, born, died, how, stageRuns, maxSameText}
  let cur = null
  let lastText = null
  let sameText = 0
  let sameStage = 0
  let lastStage = null
  let observeAt = 0

  while (t - 1000000 < SIM_MS) {
    if (!g.goal) {
      // 立新目标（等价 main.js 的 ensureGoal）
      try { await g.ensure(status) } catch (e) { /* ignore */ }
      if (!g.goal) { t += 1000; continue }   // 全在冷却，等一会儿
      cur = { key: g.goal.key, title: g.goal.title, born: t, died: null, how: null, maxSameText: 0, maxSameStage: 0 }
      goals.push(cur)
      lastText = null
      sameText = 0
      lastStage = null
      sameStage = 0
      observeAt = t
    }

    const c = g.current()
    const text = c ? c.text : null
    // 同一个任务连续跑了几遍（按发下去的 text 算）
    if (text && text === lastText) sameText++
    else { sameText = 1; lastText = text }
    if (cur) {
      if (sameText > cur.maxSameText) { cur.maxSameText = sameText; cur.maxSameTextWhat = text }
      cur.maxSameText = Math.max(cur.maxSameText, sameText)
    }
    // 同一个阶段标题连续跑了几遍（换法子不改标题，所以这个数会更大）
    const st = c ? c.stage : null
    if (st && st === lastStage) sameStage++
    else { sameStage = 1; lastStage = st }
    if (cur) cur.maxSameStage = Math.max(cur.maxSameStage, sameStage)

    // work 模式：这一趟真的弄到了一点东西 / 真的把活干了
    if (mode === 'work') {
      const st = g.currentStage()
      if (st && st.kind === 'gather') {
        const inv = Object.assign({}, status.inventory)
        for (const k of Object.keys(st.need || {})) {
          if (/^[a-z_]+$/.test(k)) inv[k] = (inv[k] || 0) + 1
          else if (k === '#surfacestone' || k === '#stone') inv.cobblestone = (inv.cobblestone || 0) + 1
          else if (k === '#log') inv.oak_log = (inv.oak_log || 0) + 1
          else if (k === '#food') inv.bread = (inv.bread || 0) + 1
        }
        status = Object.assign({}, status, { inventory: inv })
      }
      if (st && st.kind === 'craft') {
        const inv = Object.assign({}, status.inventory)
        inv[st.need.item] = (inv[st.need.item] || 0) + 1
        status = Object.assign({}, status, { inventory: inv })
      }
      if (st && (st.kind === 'surface' || st.kind === 'depth')) {
        status = Object.assign({}, status, { pos: { x: 0, y: st.kind === 'surface' ? 70 : 16, z: 0 } })
      }
    }
    t += TASK_MS   // 一趟任务
    let res = null
    const prog = (mode === 'work' && g.currentStage() && (g.currentStage().kind === 'do' || g.currentStage().kind === 'build')) ? 1 : undefined
    try { res = g.onTaskResult({ ok: true, text: '成了', status, progress: prog }) } catch (e) { logs.push({ t, s: '[crash] ' + e.message }) }

    if (t - observeAt >= OBSERVE_MS) {
      observeAt = t
      try { g.observe(status) } catch (e) { logs.push({ t, s: '[crash observe] ' + e.message }) }
    }

    if (!g.goal) {
      const h = g.history[g.history.length - 1]
      if (cur) {
        cur.died = t
        cur.how = h && h.result === 'done' ? 'done' : 'abandoned'
        cur.reason = h && h.reason
      }
      lastText = null
    }
  }

  const lives = goals.filter(x => x.died !== null).map(x => (x.died - x.born) / 1000)
  const done = goals.filter(x => x.how === 'done').length
  const abandoned = goals.filter(x => x.how === 'abandoned').length
  const keyCount = {}
  for (const x of goals) keyCount[x.key] = (keyCount[x.key] || 0) + 1
  const maxGoal = goals.reduce((a, x) => (x.maxSameText > (a ? a.maxSameText : 0) ? x : a), null)
  const maxSameText = maxGoal ? maxGoal.maxSameText : 0
  const maxSameStage = goals.reduce((a, x) => Math.max(a, x.maxSameStage), 0)
  const instant = goals.filter(x => x.how === 'abandoned' && (x.died - x.born) < 60000).length

  console.log(`\n[B. 回放 ${label}]  模拟 ${Math.round(SIM_MS / 60000)} 分钟，一趟任务 1.6 秒，mode=${mode}`)
  console.log('  立了几个目标：' + goals.length + `（干完 ${done}，放弃 ${abandoned}）`)
  console.log('  同一任务最多连续几遍（按发下去的那句话）：' + maxSameText)
  if (maxGoal) console.log('    最长那段说的是：' + String(maxGoal.maxSameTextWhat || '').slice(0, 60) + '   （' + maxGoal.key + '）')
  console.log('  同一个阶段标题最多连续几遍（换法子不改标题）：' + maxSameStage)
  console.log('  目标寿命（秒）：' + JSON.stringify(STATS(lives)))
  console.log('  寿命 < 60 秒（立了立刻放弃）：' + instant + '/' + lives.length)
  console.log('  目标选择分布：' + JSON.stringify(keyCount))
  console.log('  前 12 个目标：')
  goals.slice(0, 12).forEach((x, i) => {
    console.log(`    ${String(i + 1).padStart(2)}  ${(x.key || '').slice(0, 26).padEnd(26)} ${x.died ? ((x.died - x.born) / 1000).toFixed(0) + 's' : '进行中'}  ${x.how || ''}  ${x.reason || ''}`)
  })
  const switches = logs.filter(x => /换法子/.test(x.s)).slice(0, 8)
  if (switches.length) {
    console.log('  换法子的日志（前 8 条）：')
    switches.forEach(x => console.log('    ' + x.s))
  }
  return { maxSameText, maxSameStage, lives: STATS(lives), instant, totalAbandoned: abandoned, keyCount, goals: goals.length, switches: logs.filter(x => /换法子/.test(x.s)).length }
}

async function main () {
  const a = partA()

  // 三个版本：
  //   scan5   = 40b21ec（UNHUMAN-SCAN 扫描时的样子，maxIdleWins=5）
  //   112917d = #9 已修（12 + 时间闸只写在 cfg 里、没接线）
  //   After   = 当前工作区（#7 + 层3 + 声明式 stage()）
  const scanSrc = execSync('git show 40b21ec:src/goals.js', { cwd: ROOT, encoding: 'utf8' })
  const Scan5 = loadVersion('goals-40b21ec', scanSrc)
  const beforeSrc = execSync('git show 112917d:src/goals.js', { cwd: ROOT, encoding: 'utf8' })
  const Before = loadVersion('goals-112917d', beforeSrc)
  const After = require('../src/goals')

  const a0 = await simulate(`${MODE} / 40b21ec（扫描时：maxIdleWins=5）`, Scan5)
  const b = await simulate(`${MODE} / 112917d（#9 已修 / #7 没修）`, Before)
  const c = await simulate(`${MODE} / 当前工作区（#7 #7+层3 已修）`, After)

  const out = { at: new Date().toISOString(), real: a, scan5: a0, before: b, after: c }
  const outFile = path.join(ROOT, 'data', 'test-results', `goals-unhuman7-${MODE}-${Math.round(SIM_MS / 60000)}min.json`)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2))
  console.log('\n结果已存: ' + path.relative(ROOT, outFile))
}

main().catch(e => { console.error(e && e.stack ? e.stack : e); process.exit(2) })
