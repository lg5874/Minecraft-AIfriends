#!/usr/bin/env node
'use strict'
/**
 * 探针：痛觉（血 ≤6 是否真的停手）+ 死因（死了：后面写的是什么）
 *
 *   node scripts/probe-pain-death.js --minutes 5
 *   node scripts/probe-pain-death.js --minutes 5 --hurt-now 5   # 连上就注入血=5
 *
 * 为什么用"注入伤害包"而不是等它自己掉血：
 *   这条要测的是**因果**（血到线 -> 停手），不是运气（这一局会不会挨打）。
 *   注入的是服务端同款 damage_event 包，走的是完全真实的代码路径；
 *   唯一的假是血量是我们设的，日志里会写清楚。
 *
 * 环境隔离同其它探针：独立账号 + 独立 AIFRIEND_DATA。
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
const MINUTES = parseFloat(argOf('minutes', '5')) || 5
const HURT_HP = parseInt(argOf('hurt-now', '5'), 10)
const KILL_AT = parseInt(argOf('kill-at', '90'), 10)   // 连上后第几秒注入死亡
const HOLD_LOW = argv.includes('--hold-low')            // 持续把血压在低位（不压会被服务端 health 包覆盖）
const ACCOUNT = argOf('account', 'XJJ_PD') + Math.random().toString(36).slice(2, 5)
const DATA_DIR = path.join('data', 'probe-pain', ACCOUNT)
const OUT_DIR = path.join(ROOT, 'data', 'test-results')

const sleep = ms => new Promise(r => setTimeout(r, ms))

const M = { lines: [], pain: [], death: [], tasks: [], says: [], health: [] }

function feed (line) {
  if (/^\[probe\]/.test(line)) return
  M.lines.push(line)
  if (/\[pain\]/.test(line)) M.pain.push(line)
  if (/\[death\]/.test(line)) M.death.push(line)
  if (/\[lock\] 中断信号/.test(line)) M.pain.push(line)
  if (/>>> 开始/.test(line)) M.tasks.push(line)
  if (/\[say\]/.test(line)) M.says.push(line)
  if (/\[survive\]|\[sos\]|\[hurt\]/.test(line)) M.health.push(line)
}

async function main () {
  const rev = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()
  process.env.AIFRIEND_DATA = DATA_DIR
  fs.mkdirSync(path.join(ROOT, DATA_DIR), { recursive: true })

  console.log('='.repeat(66))
  console.log('  痛觉 + 死因 探针')
  console.log('='.repeat(66))
  console.log(`代码版本 : ${rev}`)
  console.log(`账号     : ${ACCOUNT}（独立）`)
  console.log(`数据目录 : ${DATA_DIR}`)
  console.log(`时长     : ${MINUTES} 分钟`)
  console.log(`注入     : 血=${HURT_HP}（damage_event drown），第 ${KILL_AT}s 注入死亡`)
  console.log('='.repeat(66) + '\n')

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
  cfg.bot.username = ACCOUNT
  cfg.behavior = cfg.behavior || {}
  cfg.behavior.reconnectDelaySeconds = 15
  const tmpCfg = path.join(ROOT, 'data', `probe-pd-${ACCOUNT}.json`)
  fs.writeFileSync(tmpCfg, JSON.stringify(cfg, null, 2))
  process.env.AIFRIEND_CONFIG = path.relative(ROOT, tmpCfg)

  const origLog = console.log.bind(console)
  console.log = (...args) => {
    const line = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ')
    feed(line)
    origLog(line)
  }

  const { Bot } = require(path.join(ROOT, 'main.js'))
  const b = new Bot(cfg)
  b.connect()

  const t0 = Date.now()
  let injected = false
  let killed = false

  const timer = setInterval(async () => {
    const el = (Date.now() - t0) / 1000
    const bot = b.bot
    if (!bot || !bot.entity) return

    // 等真的开始干活再注入 —— 要测的是"任务进行中能不能被疼打断"
    if (!injected && el > 25 && b.busy) {
      injected = true
      origLog(`[probe] ${Math.round(el)}s 注入：血=${HURT_HP} + damage_event(drown)，当前任务「${b.taskDesc}」`)
      try { bot.health = HURT_HP } catch (e) {}
      try {
        bot._client.emit('damage_event', {
          entityId: bot.entity.id,
          sourceTypeId: 11,     // drown
          sourceCauseId: 0,
          sourceDirectId: 0
        })
      } catch (e) { origLog('[probe] 注入失败 ' + e.message) }
    }

    // --hold-low：持续把血压在低线（模拟一直在水里/一直在挨打）。
    // 不压的话，服务端下一个 health 包就把注入的 5 覆盖回 20，
    // 于是"停手"只维持一瞬，测不出"5 分钟里会不会接着干活"。
    if (injected && HOLD_LOW && el < KILL_AT) {
      try { bot.health = HURT_HP } catch (e) {}
      try {
        bot._client.emit('damage_event', { entityId: bot.entity.id, sourceTypeId: 11, sourceCauseId: 0 })
      } catch (e) {}
    }

    if (!killed && injected && el > KILL_AT) {
      killed = true
      origLog(`[probe] ${Math.round(el)}s 注入死亡（血 0）`)
      try { bot.health = 0 } catch (e) {}
      try { bot._client.emit('damage_event', { entityId: bot.entity.id, sourceTypeId: 11, sourceCauseId: 0 }) } catch (e) {}
      try { bot.emit('death') } catch (e) { origLog('[probe] death 注入失败 ' + e.message) }
    }

    if (Math.round(el) % 30 === 0) {
      origLog(`[probe] ${Math.round(el)}s 血=${Math.round(bot.health)} 任务=${b.busy ? b.taskDesc : '空闲'} ｜ pain ${M.pain.length} ｜ 任务开始 ${M.tasks.length}`)
    }
  }, 3000)

  await sleep(MINUTES * 60 * 1000)
  clearInterval(timer)

  try { b.shutdown() } catch (e) {}
  await sleep(1500)
  console.log = origLog

  origLog('\n' + '='.repeat(66))
  origLog('  原始数据')
  origLog('='.repeat(66))
  const show = (title, arr) => {
    origLog('\n' + title + `（${arr.length} 条）`)
    if (!arr.length) origLog('  （空）')
    arr.forEach(x => origLog('  ' + x))
  }
  show('【#A 痛觉】[pain] / [lock] 中断信号', M.pain)
  show('【#A】自救相关 [hurt]/[sos]/[survive]', M.health)
  show('【#A】任务开始 >>>', M.tasks)
  show('【#B 死因】[death]', M.death)

  let memFile = null
  try {
    const mem = JSON.parse(fs.readFileSync(path.join(ROOT, DATA_DIR, 'memory.json'), 'utf8'))
    const list = Array.isArray(mem) ? mem : (mem.entries || mem.items || [])
    const deathEntries = list.filter(e => /死了/.test(String(e.text || '')))
    origLog('\n【#B 记忆里的死亡条目】' + deathEntries.length + ' 条')
    deathEntries.slice(-5).forEach(e => origLog('  ' + JSON.stringify(e)))
    memFile = path.join(OUT_DIR, `pain-death-${Date.now()}.memory.json`)
    fs.writeFileSync(memFile, JSON.stringify(deathEntries, null, 2))
  } catch (e) {
    origLog('\n（读 memory.json 失败：' + e.message + '）')
  }

  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, `pain-death-${runId}.log`), M.lines.join('\n'))
  origLog('\n原始日志: data/test-results/pain-death-' + runId + '.log')
  try { fs.unlinkSync(tmpCfg) } catch (e) {}
  process.exit(0)
}

main().catch(e => {
  console.error('探针崩溃: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e))
  process.exit(2)
})
