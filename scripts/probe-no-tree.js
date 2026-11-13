#!/usr/bin/env node
'use strict'
/**
 * 探针：出生点 64 格内没树时，他会怎么办
 *
 *   node scripts/probe-no-tree.js --minutes 2
 *
 * 验两件事（都不需要树、不需要镐）：
 *   1. `ensurePickaxe()` 在 96 格没树时会不会往外走（走多少格、走几段）
 *   2. 这种情况下 goals 会不会选 `explore`，第一步是不是纯走路
 *
 * 本地 superflat 服天然没有树，正好当"林子被砍秃"的场景。
 * 独立账号 + AIFRIEND_DATA=/tmp/goal-probe-notree，不碰 data/runtime。
 */

const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const argv = process.argv.slice(2)
const argOf = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const ACCOUNT = argOf('account', 'XJJ_NOTREE') + Date.now().toString(36).slice(-3)
const HOST = argOf('host', '127.0.0.1')
const PORT = parseInt(argOf('port', '25565'), 10) || 25565
const BUDGET_S = Math.max(30, parseInt(argOf('budget', '90'), 10) || 90)
const DATA_DIR = '/tmp/goal-probe-notree'
const CONFIG_PATH = `/tmp/goal-probe-notree-${ACCOUNT}.json`

const sleep = ms => new Promise(r => setTimeout(r, ms))
const stamp = () => new Date().toTimeString().slice(0, 8)
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

async function main () {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
  cfg.bot = cfg.bot || {}
  cfg.bot.username = ACCOUNT
  cfg.bot.host = HOST
  cfg.bot.port = PORT
  cfg.behavior = cfg.behavior || {}
  cfg.behavior.reconnectDelaySeconds = 10
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
  process.env.AIFRIEND_DATA = DATA_DIR
  process.env.AIFRIEND_CONFIG = path.relative(ROOT, CONFIG_PATH)

  console.log('='.repeat(64))
  console.log('  出生点没树探针')
  console.log('='.repeat(64))
  console.log(`账号 ${ACCOUNT}｜${HOST}:${PORT}｜数据 ${DATA_DIR}`)
  console.log('='.repeat(64) + '\n')

  const origLog = console.log.bind(console)
  const log = (...a) => origLog(`[probe ${stamp()}]`, ...a)
  const { Bot } = require(path.join(ROOT, 'main.js'))
  const b = new Bot(cfg)
  b.connect()

  const t0 = Date.now()
  while (Date.now() - t0 < 90000) {
    if (b.bot && b.bot.entity && b.actions && b.goals) break
    await sleep(1000)
  }
  if (!b.bot || !b.bot.entity || !b.actions) {
    log('90 秒没进服，退出')
    try { b.shutdown() } catch (e) {}
    process.exit(2)
  }
  await sleep(2000)

  // 停主循环：这个探针要手动控制，不能让它自己去砍树
  b.running = false
  const tw = Date.now()
  while (b.lock && b.lock.busy && Date.now() - tw < 12000) await sleep(500)
  if (b.lock && b.lock.busy) {
    try { b._signalCancel('probe-no-tree') } catch (e) {}
    try { b.lock.forceReleaseAll('probe-no-tree') } catch (e) {}
  }
  await sleep(800)

  const pos = () => {
    const p = b.bot.entity.position
    return { x: p.x, y: p.y, z: p.z }
  }
  const status = () => {
    const st = b.actions.status()
    try {
      const ug = b.actions.isUnderground()
      if (ug === true || ug === false) st.underground = ug
    } catch (e) {}
    return st
  }
  const start = pos()
  log(`出生点 ${start.x.toFixed(1)},${start.y.toFixed(1)},${start.z.toFixed(1)}`)

  // ---- 1. ensurePickaxe 没树时会不会往外走 ----
  log('--- 1) ensurePickaxe：96 格没树 ---')
  const before = pos()
  let err = null
  try {
    await b.actions.ensurePickaxe({ budgetMs: BUDGET_S * 1000 })
  } catch (e) {
    err = e
  }
  const after = pos()
  const moved = dist(before, after)
  log(`ensurePickaxe 结果：${err ? '失败（' + err.message + '）' : '成功'}`)
  log(`位移 ${moved.toFixed(1)} 格：${before.x.toFixed(1)},${before.z.toFixed(1)} -> ${after.x.toFixed(1)},${after.z.toFixed(1)}`)

  // ---- 2. goals 会不会选 explore、第一步是不是走路 ----
  log('--- 2) goals 在没镐没木头时选什么 ---')
  const st = status()
  // 探索目标选谁用打分兜底（不让模型改主意），这样量的是排序本身
  try { b.goals.llm = null } catch (e) {}
  const cs = b.goals.candidates(st)
  log('candidates: ' + cs.slice(0, 4).map(c => `${c.key}(${c.score})`).join(' '))
  const goal = await b.goals.ensure(st)
  log(`ensure -> ${goal ? goal.key + ' / ' + (goal.stages[0] && goal.stages[0].title) : 'null'}`)
  log(`第一步 kind=${goal && goal.stages[0] && goal.stages[0].kind} need=${JSON.stringify(goal && goal.stages[0] && goal.stages[0].need)}`)

  let walkMoved = 0
  let ratio = 0
  if (goal && goal.key === 'explore' && goal.stages[0] && goal.stages[0].kind === 'travel') {
    log('--- 3) 走 40 格，看 travel 阶段进度 ---')
    const p0 = pos()
    try { await b.actions.goto(p0.x + 40, p0.y, p0.z, 3, 30000) } catch (e) { log('goto: ' + e.message) }
    await sleep(500)
    const p1 = pos()
    walkMoved = dist(p0, p1)
    const r = b.goals.observe(status())
    ratio = r.ratio
    log(`实际走了 ${walkMoved.toFixed(1)} 格，travel ratio=${ratio.toFixed(2)}`)
  }

  const pass = moved >= 10 && goal && goal.key === 'explore' && goal.stages[0].kind === 'travel'
  log(`结论：没树时 ensurePickaxe 位移 ${moved.toFixed(1)} 格 ≥10 → ${moved >= 10 ? '✓' : '✗'}；` +
    `goals 选 ${goal && goal.key} / 第一步 ${goal && goal.stages[0] && goal.stages[0].kind} → ` +
    `${goal && goal.key === 'explore' && goal.stages[0].kind === 'travel' ? '✓' : '✗'}`)
  log(`总判定：${pass ? '通过' : '失败'}`)

  try { b.shutdown() } catch (e) {}
  await sleep(1000)
  try { fs.unlinkSync(CONFIG_PATH) } catch (e) {}
  process.exit(pass ? 0 : 1)
}

main().catch(e => {
  console.error('探针崩溃: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e))
  process.exit(2)
})
