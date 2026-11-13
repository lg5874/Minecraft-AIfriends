#!/usr/bin/env node
'use strict'
/**
 * 探针：#12 天黑反应（血满警觉 / 血低躲）
 *
 *   node scripts/probe-night.js --minutes 3
 *
 * 做法：把 bot.time 换成假的（服务端每秒推一次 update_time，注入包会被覆盖，
 * 只有替换属性才测得稳），两段各跑一遍：
 *   1) 血 20 + 深夜 tod=14000  -> 期望 [night] 天黑了（血 20，血够，不躲）
 *   2) 血 10 + 深夜 tod=14000  -> 期望 [night] 天黑了，先躲起来
 * 中间插一段白天 tod=1000，让 _nightAlerted / sheltered 复位。
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
const MINUTES = parseFloat(argOf('minutes', '3')) || 3
const ACCOUNT = argOf('account', 'XJJ_NT') + Math.random().toString(36).slice(2, 5)
const DATA_DIR = path.join('data', 'probe-night', ACCOUNT)
const OUT_DIR = path.join(ROOT, 'data', 'test-results')

const sleep = ms => new Promise(r => setTimeout(r, ms))

const M = { lines: [], night: [], says: [], ctx: [] }
function feed (line) {
  if (/^\[probe\]/.test(line)) return
  M.lines.push(line)
  if (/\[night\]/.test(line)) M.night.push(line)
  if (/\[say\]/.test(line)) M.says.push(line)
  if (/\[tod\]/.test(line)) M.ctx.push(line)
}

async function main () {
  const rev = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()
  process.env.AIFRIEND_DATA = DATA_DIR
  fs.mkdirSync(path.join(ROOT, DATA_DIR), { recursive: true })

  console.log('='.repeat(66))
  console.log('  #12 天黑反应探针（血满警觉 / 血低躲）')
  console.log('='.repeat(66))
  console.log(`代码版本 : ${rev}`)
  console.log(`账号     : ${ACCOUNT}（独立）`)
  console.log(`数据目录 : ${DATA_DIR}`)
  console.log(`时长     : ${MINUTES} 分钟`)
  console.log('时钟     : 伪造 bot.time（服务端 update_time 每秒覆盖注入包，只能换属性）')
  console.log('='.repeat(66) + '\n')

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
  cfg.bot.username = ACCOUNT
  cfg.behavior = cfg.behavior || {}
  cfg.behavior.reconnectDelaySeconds = 15
  const tmpCfg = path.join(ROOT, 'data', `probe-nt-${ACCOUNT}.json`)
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

  const state = { tod: 1000 }
  const t0 = Date.now()
  let phase = 0
  let stubbed = false

  const timer = setInterval(() => {
    const el = (Date.now() - t0) / 1000
    const bot = b.bot
    if (!bot || !bot.entity) return

    // 把 bot.time.timeOfDay 钉成探针值。
    // 注意不能整个替换 bot.time —— mineflayer 的物理层会读 bot.time.clocks，
    // 换成假对象会直接 TypeError（实测）。只覆盖这一个字段，其余原样。
    const applyFakeTod = () => {
      try {
        if (!bot.time) return
        Object.defineProperty(bot.time, 'timeOfDay', {
          configurable: true,
          get: () => state.tod,
          set: () => {}
        })
      } catch (e) {}
    }
    if (!stubbed && el > 12) {
      stubbed = true
      applyFakeTod()
      origLog('[probe] bot.time.timeOfDay 已钉成探针值')
    }
    if (!stubbed) return
    applyFakeTod()   // 服务端每次 update_time 都会重建对象，重新钉

    // 主循环被任务占着时（busy / 回家）压根不会走到"天黑判断"那一行，
    // 这时候推进阶段等于白测 —— 等它空下来再进下一段。
    if (b.busy || b._homing) return

    // 阶段推进
    if (phase === 0 && el > 20) {
      phase = 1
      state.tod = 14000
      bot.health = 20
      origLog('[probe] 阶段1：血 20 + 深夜 tod=14000')
    } else if (phase === 1 && el > 45) {
      phase = 2
      state.tod = 1000
      origLog('[probe] 阶段2：白天 tod=1000（复位）')
    } else if (phase === 2 && el > 60) {
      phase = 3
      state.tod = 14000
      bot.health = 10
      origLog('[probe] 阶段3：血 10 + 深夜 tod=14000')
    }
  }, 2000)

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
  show('【#12】[night]', M.night)
  show('【#12】[tod] 提示词侧', M.ctx)
  show('【#12】[say]', M.says)

  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, `night-${runId}.log`), M.lines.join('\n'))
  origLog('\n原始日志: data/test-results/night-' + runId + '.log')
  try { fs.unlinkSync(tmpCfg) } catch (e) {}
  process.exit(0)
}

main().catch(e => {
  console.error('探针崩溃: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e))
  process.exit(2)
})
