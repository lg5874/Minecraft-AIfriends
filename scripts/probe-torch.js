#!/usr/bin/env node
'use strict'
/**
 * 探针：火把链（gather('torch') 到底能不能做出来）
 *
 *   node scripts/probe-torch.js --count 8 --minutes 12
 *
 * 只做一件事：连上服，直接调 actions.gather('torch', N)，
 * 把中间每一步（[gather]/[craft]/[mine]/[chop]）原样打出来，最后看背包里有几个 torch。
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
const COUNT = parseInt(argOf('count', '8'), 10) || 8
const MINUTES = parseFloat(argOf('minutes', '12')) || 12
const ACCOUNT = argOf('account', 'XJJ_T') + Math.random().toString(36).slice(2, 5)
const DATA_DIR = path.join('data', 'probe-torch', ACCOUNT)
const OUT_DIR = path.join(ROOT, 'data', 'test-results')

const sleep = ms => new Promise(r => setTimeout(r, ms))

const M = { lines: [], gather: [], craft: [], mine: [], chop: [], key: [] }
function feed (line) {
  if (/^\[probe\]/.test(line)) return
  M.lines.push(line)
  if (/\[gather\]/.test(line)) M.gather.push(line)
  if (/\[craft\]/.test(line)) M.craft.push(line)
  if (/\[mine\]/.test(line)) M.mine.push(line)
  if (/\[chop\]/.test(line)) M.chop.push(line)
  if (/火把|torch|coal|charcoal|stick/.test(line) && /\[gather\]|\[craft\]/.test(line)) M.key.push(line)
}

async function main () {
  const rev = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()
  process.env.AIFRIEND_DATA = DATA_DIR
  fs.mkdirSync(path.join(ROOT, DATA_DIR), { recursive: true })

  console.log('='.repeat(66))
  console.log('  火把链探针')
  console.log('='.repeat(66))
  console.log(`代码版本 : ${rev}`)
  console.log(`账号     : ${ACCOUNT}（独立）`)
  console.log(`数据目录 : ${DATA_DIR}`)
  console.log(`目标     : gather('torch', ${COUNT})`)
  console.log(`上限     : ${MINUTES} 分钟`)
  console.log('='.repeat(66) + '\n')

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
  cfg.bot.username = ACCOUNT
  // 本地测试服（127.0.0.1）+ 从服务端控制台 /give 发料
  const host = argOf('host', null)
  const port = parseInt(argOf('port', '25565'), 10)
  if (host) { cfg.bot.host = host; cfg.bot.port = port }
  cfg.behavior = cfg.behavior || {}
  cfg.behavior.reconnectDelaySeconds = 15
  const tmpCfg = path.join(ROOT, 'data', `probe-torch-${ACCOUNT}.json`)
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

  // 等上线（有 entity + inventory）
  const t0 = Date.now()
  while (Date.now() - t0 < 60000) {
    if (b.bot && b.bot.entity && b.bot.inventory) break
    await sleep(1000)
  }
  if (!b.bot || !b.bot.entity) {
    origLog('[probe] 60 秒没进服，退出')
    process.exit(2)
  }

  // 让主循环别插手（它自己会起任务抢 bot）。只动 actions，不起任务。
  b.busy = true
  // 主循环的自救（checkSurvival -> doSurvive）会 _signalCancel，
  // 把探针正在跑的 gather 打断（实测日志里一堆"任务被中断"）。
  // 探针自己承担风险：关掉这一路，只测火把链。
  b.checkSurvival = () => null
  while (!b.actions && Date.now() - t0 < 60000) await sleep(500)
  if (b.actions) b.actions.cancel = false
  await sleep(1500)
  const inv = () => {
    const out = {}
    try { for (const i of b.bot.inventory.items()) out[i.name] = (out[i.name] || 0) + i.count } catch (e) {}
    return out
  }
  origLog('[probe] 开始前背包: ' + JSON.stringify(inv()))

  const prepWait = parseInt(argOf('prep-wait', '0'), 10)
  if (prepWait > 0) {
    origLog(`[probe] 等外部发料 ${prepWait}s（服务端控制台 /give）`)
    await sleep(prepWait * 1000)
    origLog('[probe] 发料后背包: ' + JSON.stringify(inv()))
  }

  // 【环境】出生点被前面几十次测试砍秃了（96 格内可走的树 0 棵），
  // 先走到有树的地方再开始 —— 不然测的是"找不到树"，不是火把链。
  if (!argv.includes('--no-travel')) {
    origLog('[probe] 先找有树的地方…')
    try {
      const hit = await b.actions.travelToFind(() => {
        for (const l of ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log',
          'dark_oak_log', 'cherry_log', 'mangrove_log', 'pale_oak_log']) {
          const blk = b.actions.findBlock(l, 40)
          if (blk) return blk
        }
        return null
      }, 6, 50)
      const pos = b.bot.entity.position
      origLog(`[probe] 落脚点 ${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}｜树：${hit ? '有' : '还是没有'}`)
    } catch (e) {
      origLog('[probe] 找树阶段出错: ' + (e && e.message))
    }
  }

  const started = Date.now()
  let ok = false
  let err = null
  try {
    ok = await Promise.race([
      b.actions.gather('torch', COUNT),
      sleep(MINUTES * 60 * 1000).then(() => { origLog('[probe] 到达时间上限，放弃'); return false })
    ])
  } catch (e) {
    err = e
    origLog('[probe] gather 抛错: ' + (e && e.message))
  }
  const secs = Math.round((Date.now() - started) / 1000)
  const after = inv()
  origLog(`[probe] gather('torch', ${COUNT}) => ${ok}｜耗时 ${secs}s`)
  origLog('[probe] 结束后背包: ' + JSON.stringify(after))

  try { b.shutdown() } catch (e) {}
  await sleep(1500)
  console.log = origLog

  origLog('\n' + '='.repeat(66))
  origLog('  原始数据')
  origLog('='.repeat(66))
  const show = (title, arr, n = 60) => {
    origLog('\n' + title + `（${arr.length} 条）`)
    if (!arr.length) origLog('  （空）')
    arr.slice(-n).forEach(x => origLog('  ' + x))
  }
  origLog(`\n结果: ${ok ? '成功' : '失败'}｜torch = ${after.torch || 0}｜耗时 ${secs}s${err ? '｜错误 ' + err.message : ''}`)
  origLog('背包里的相关物资: ' + JSON.stringify({
    torch: after.torch || 0, coal: after.coal || 0, charcoal: after.charcoal || 0,
    stick: after.stick || 0, oak_log: after.oak_log || 0,
    wooden_pickaxe: after.wooden_pickaxe || 0, stone_pickaxe: after.stone_pickaxe || 0,
    crafting_table: after.crafting_table || 0, furnace: after.furnace || 0
  }))
  show('【[gather]】', M.gather)
  show('【[craft]】', M.craft)
  show('【[mine]】', M.mine)
  show('【[chop]】', M.chop)

  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, `torch-${runId}.log`), M.lines.join('\n'))
  origLog('\n原始日志: data/test-results/torch-' + runId + '.log')
  try { fs.unlinkSync(tmpCfg) } catch (e) {}
  process.exit(0)
}

main().catch(e => {
  console.error('探针崩溃: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e))
  process.exit(2)
})
