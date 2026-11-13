#!/usr/bin/env node
'use strict'
/**
 * 探针：地表攒石头的「挖了什么」vs「计数涨了什么」
 *
 *   node scripts/probe-gather-count.js --minutes 10
 *
 * 目的（Lead 2026-11-14）：
 *   `#surfacestone` 只认 cobblestone|stone，但实测日志里他一直在挖 diorite。
 *   这个探针起一个独立实例正常玩 10 分钟，每 30 秒打印：
 *     · 目标/阶段/ratio
 *     · cobblestone / stone / diorite / andesite / granite 的当前数量与本窗口增量
 *     · #surfacestone / #stone 按 goals.itemCount 的算法各是多少
 *   `[dig]` 行会即时打出来，带方块名，便于和增量对照。
 *
 * 环境隔离：
 *   独立账号 XJJ_GOAL<时间戳>，AIFRIEND_DATA=/tmp/goal-probe，
 *   不碰 data/runtime，也不改 config.json。
 */

const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const argv = process.argv.slice(2)
const argOf = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const MINUTES = Math.max(1, parseFloat(argOf('minutes', '10')) || 10)
const INTERVAL_S = Math.max(5, parseInt(argOf('interval', '30'), 10) || 30)
// --mine diorite：受控模式，关掉主循环后反复挖指定方块（用来做"挖了什么/计数涨了什么"对照）
const MINE_BLOCK = argOf('mine', null)
const HOST = argOf('host', null)
const PORT = parseInt(argOf('port', '0'), 10) || 0
const ACCOUNT = argOf('account', 'XJJ_GOAL') + Date.now().toString(36).slice(-4)
const DATA_DIR = '/tmp/goal-probe'
const CONFIG_PATH = `/tmp/goal-probe-config-${ACCOUNT}.json`
const OUT_PATH = `/tmp/goal-gather-${ACCOUNT}-${Date.now()}.log`

const sleep = ms => new Promise(r => setTimeout(r, ms))
const stamp = () => new Date().toTimeString().slice(0, 8)
const TRACK = ['cobblestone', 'stone', 'diorite', 'andesite', 'granite', 'cobbled_deepslate', 'deepslate']

const raw = []
const digs = []
const windows = []
function record (line) {
  raw.push(line)
  const m = line.match(/\[dig\] (?:用 \S+ 挖|空手挖) (\w+)/)
  if (m) {
    digs.push({ at: stamp(), block: m[1], line })
    // 即时打印，方便和 30 秒窗口对齐
    process.stdout.write(`      ↳ DIG ${m[1]}  ${line.replace(/^\[[^\]]+\]\s*/, '')}\n`)
  }
}

async function main () {
  if (!fs.existsSync(path.join(ROOT, 'config.json'))) {
    console.error('缺 config.json'); process.exit(2)
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
  cfg.bot = cfg.bot || {}
  cfg.bot.username = ACCOUNT
  if (HOST) cfg.bot.host = HOST
  if (PORT) cfg.bot.port = PORT
  cfg.behavior = cfg.behavior || {}
  cfg.behavior.reconnectDelaySeconds = 10
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
  process.env.AIFRIEND_DATA = DATA_DIR
  fs.mkdirSync(DATA_DIR, { recursive: true })

  console.log('='.repeat(72))
  console.log('  攒石头计数探针')
  console.log('='.repeat(72))
  console.log(`账号     : ${ACCOUNT}（独立）`)
  console.log(`数据目录 : ${DATA_DIR}`)
  console.log(`服务器   : ${cfg.bot.host}:${cfg.bot.port}`)
  console.log(`时长     : ${MINUTES} 分钟（每 ${INTERVAL_S} 秒采样）`)
  console.log(`模式     : ${MINE_BLOCK ? '受控挖掘 mine(' + MINE_BLOCK + ')' : '正常玩（主循环）'}`)
  console.log('='.repeat(72) + '\n')

  const origLog = console.log.bind(console)
  console.log = (...args) => {
    const line = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ')
    record(line)
    origLog(line)
  }

  const { Bot } = require(path.join(ROOT, 'main.js'))
  const goalsMod = require(path.join(ROOT, 'src', 'goals.js'))
  const b = new Bot(cfg)
  b.connect()

  // 等 spawn + goals 初始化
  const t0 = Date.now()
  while (Date.now() - t0 < 90000) {
    if (b.bot && b.bot.entity && b.goals) break
    await sleep(1000)
  }
  if (!b.bot || !b.bot.entity || !b.goals) {
    origLog('[probe] 90 秒没进服或 goals 没起来，退出')
    try { b.shutdown() } catch (e) {}
    process.exit(2)
  }
  origLog(`[probe] 已上线，位置 ${Math.round(b.bot.entity.position.x)},${Math.round(b.bot.entity.position.y)},${Math.round(b.bot.entity.position.z)}`)

  if (MINE_BLOCK) {
    // 受控模式：停主循环，只跑 mine()。主循环的 tick 会抢 pathfinder，
    // 这个探针要的是干净的"挖一格 → 背包怎么变"。
    b.running = false
    const tw = Date.now()
    while (b.lock && b.lock.busy && Date.now() - tw < 12000) await sleep(500)
    if (b.lock && b.lock.busy) {
      try { b._signalCancel('probe-mine') } catch (e) {}
      try { b.lock.forceReleaseAll('probe-mine') } catch (e) {}
    }
    await sleep(1000)

    // 工具由服务端控制台 /give 提供；等它进背包
    const tp = Date.now()
    while (b.actions && b.actions.countOf('stone_pickaxe') === 0 && Date.now() - tp < 60000) await sleep(1000)
    origLog('[probe] 工具：' + (b.actions ? 'stone_pickaxe=' + b.actions.countOf('stone_pickaxe') : 'actions 未就绪'))
  }

  const inv = () => {
    const out = {}
    try {
      for (const it of b.bot.inventory.items()) out[it.name] = (out[it.name] || 0) + it.count
    } catch (e) {}
    return out
  }
  const cursor = () => {
    const s = b.goals && b.goals.currentStage && b.goals.currentStage()
    const g = b.goals && b.goals.goal
    return {
      key: g ? g.key : '-',
      stage: g ? g.stageIndex : -1,
      title: s ? s.title : '-',
      ratio: s ? Number(s.ratio || 0) : 0,
      need: s ? s.need : null,
      baseInv: s && s.base ? s.base.inv || {} : {}
    }
  }
  const fmtNeed = (need) => {
    if (!need) return '-'
    return Object.entries(need).map(([k, v]) => `${k}:${v}`).join(',')
  }

  let prev = inv()
  const snap = (tag) => {
    const now = inv()
    const delta = {}
    for (const k of TRACK) delta[k] = (now[k] || 0) - (prev[k] || 0)
    const c = cursor()
    const surf = goalsMod.itemCount(now, '#surfacestone')
    const stone = goalsMod.itemCount(now, '#stone')
    const surfDelta = surf - goalsMod.itemCount(prev, '#surfacestone')
    const digsInWindow = digs.slice(windows.length ? windows[windows.length - 1].digCount : 0).map(d => d.block)
    const row = {
      at: stamp(),
      tag,
      goal: c.key,
      stage: c.stage,
      title: c.title,
      ratio: c.ratio,
      need: fmtNeed(c.need),
      counts: Object.fromEntries(TRACK.map(k => [k, now[k] || 0])),
      delta,
      surf,
      surfDelta,
      stone,
      digsInWindow,
      digCount: digs.length
    }
    windows.push(row)
    prev = now
    origLog(
      `[probe ${row.at}] goal=${row.goal}/${row.stage} ratio=${row.ratio.toFixed(2)} need={${row.need}} ` +
      `| ${TRACK.map(k => `${k}=${row.counts[k]}(${delta[k] >= 0 ? '+' : ''}${delta[k]})`).join(' ')} ` +
      `| #surfacestone=${row.surf}(${row.surfDelta >= 0 ? '+' : ''}${row.surfDelta}) #stone=${row.stone}` +
      (digsInWindow.length ? ` | dig:${digsInWindow.join(',')}` : '')
    )
  }

  snap('start')
  const timer = setInterval(() => { try { snap('tick') } catch (e) { origLog('[probe] snap err ' + e.message) } }, INTERVAL_S * 1000)

  if (MINE_BLOCK) {
    const deadline = Date.now() + MINUTES * 60 * 1000
    let rounds = 0
    while (Date.now() < deadline) {
      let got = 0
      try {
        got = await b.actions.mine(MINE_BLOCK, 2, 32, { budgetMs: 45000 })
      } catch (e) {
        origLog('[probe] mine 出错: ' + (e && e.message))
        await sleep(2000)
      }
      rounds++
      if (got) origLog(`[probe] mine(${MINE_BLOCK}) 本轮 +${got}`)
      await sleep(1000)
    }
    origLog(`[probe] 受控挖掘结束：${rounds} 轮`)
  } else {
    await sleep(MINUTES * 60 * 1000)
  }
  clearInterval(timer)
  snap('end')

  const finalInv = inv()
  try { b.shutdown() } catch (e) {}
  await sleep(1500)
  console.log = origLog

  // ---------------- 汇总 ----------------
  const byBlock = {}
  for (const d of digs) byBlock[d.block] = (byBlock[d.block] || 0) + 1
  origLog('\n' + '='.repeat(72))
  origLog('  对照表：每个窗口挖了什么 / 计数涨了什么')
  origLog('='.repeat(72))
  origLog('  时间      goal/stage  ratio  本窗口 dig             Δcobble Δstone Δdiorite Δandes Δgranite  Δ#surfacestone')
  for (const w of windows) {
    const digsText = (w.digsInWindow.length ? w.digsInWindow.join(',') : '-').slice(0, 22).padEnd(22)
    origLog(
      `  ${w.at}  ${(w.goal + '/' + w.stage).padEnd(10)} ${w.ratio.toFixed(2)}   ${digsText} ` +
      `${String(w.delta.cobblestone).padStart(7)} ${String(w.delta.stone).padStart(6)} ${String(w.delta.diorite).padStart(8)} ` +
      `${String(w.delta.andesite).padStart(6)} ${String(w.delta.granite).padStart(8)} ${String(w.surfDelta).padStart(13)}`
    )
  }
  origLog(`\n  挖掘统计（${digs.length} 次）：` + (JSON.stringify(byBlock) || '{}'))
  origLog('  最终 #surfacestone = ' + goalsMod.itemCount(finalInv, '#surfacestone') +
    '｜#stone = ' + goalsMod.itemCount(finalInv, '#stone'))
  origLog('  最终相关库存 = ' + JSON.stringify(Object.fromEntries(TRACK.map(k => [k, finalInv[k] || 0]))))
  origLog('\n  原始日志: ' + OUT_PATH)
  fs.writeFileSync(OUT_PATH, raw.join('\n'))
  try { fs.unlinkSync(CONFIG_PATH) } catch (e) {}
  process.exit(0)
}

main().catch(e => {
  console.error('探针崩溃: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e))
  process.exit(2)
})
