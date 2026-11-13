#!/usr/bin/env node
'use strict'
/**
 * UNHUMAN-SCAN #3 / #14 的真机事件发生器。
 *
 * 它不参与被测逻辑，只负责在服务器里**制造事件**：
 *   · 6 波玩家批量上下线（27 上 + 27 下 = 54 次，和原扫描的密度一致）
 *   · TMGprobe1 每次上线后寻路贴到目标 bot 身边（8 格内）并站住 60~90 秒
 *     —— 这就是 #14 的"有人靠近我 / 有人跟我并肩站"两个触发源
 *
 * 用法：
 *   node scripts/social-drive.js --minutes 25 --target XJJ
 *   node scripts/social-drive.js --dry            # 只打印计划
 *
 * 所有动作都写进 --log 指定的文件，验收时按时间轴对齐 bot.log。
 */

const path = require('path')
const fs = require('fs')
const mineflayer = require('mineflayer')

const ROOT = path.resolve(__dirname, '..')
const argv = process.argv.slice(2)
const argOf = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
const MINUTES = parseFloat(argOf('minutes', '25'))
const TARGET = argOf('target', cfg.bot.username)
const DRY = argv.includes('--dry')
// --chat：模拟"另一个 AI 在公屏狂说"，用来压发言限速（实测被踢就是这种场景）
const CHAT = argv.includes('--chat')
// --invite：公屏里混入邀请语，复现探针 bot 无限邀请的场景
const INVITE = argv.includes('--invite')
const LOG_PATH = argOf('log', path.join(ROOT, 'data', 'probe-social', 'driver.log'))

// 每波的账号数：合计 27 上线 + 27 下线 = 54 次，与原扫描一致
const WAVES = argOf('waves', '5,5,4,5,4,4').split(',').map(x => parseInt(x, 10)).filter(n => n > 0)
const HOLD_MS = parseInt(argOf('hold', '55'), 10) * 1000
// 服务器对同 IP 有连接限流（实测：连上 1 个后立刻连第 2 个会被 kick）
const STAGGER_MS = parseInt(argOf('stagger', '9'), 10) * 1000

fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })
function log (s) {
  const line = `[${new Date().toTimeString().slice(0, 8)}] ${s}`
  console.log(line)
  // proot 偶发 ENOSYS，写日志失败不能把整个驱动带走（19:55 就被这么崩过一次）
  try { fs.appendFileSync(LOG_PATH, line + '\n') } catch (e) {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function makeBot (name) {
  return mineflayer.createBot({
    host: cfg.bot.host,
    port: cfg.bot.port,
    username: name,
    auth: cfg.bot.auth || 'offline',
    version: cfg.bot.version,
    hideErrors: true
  })
}

/** 上线：等到 spawn（或超时） */
function join (name) {
  return new Promise((resolve, reject) => {
    const bot = makeBot(name)
    let done = false
    const t = setTimeout(() => {
      if (done) return
      done = true
      try { bot.end() } catch (e) {}
      reject(new Error('spawn 超时'))
    }, 30000)
    bot.once('spawn', () => {
      if (done) return
      done = true
      clearTimeout(t)
      resolve(bot)
    })
    bot.once('error', (e) => {
      if (done) return
      done = true
      clearTimeout(t)
      reject(e)
    })
    bot.once('kicked', (r) => {
      if (done) return
      done = true
      clearTimeout(t)
      reject(new Error('kicked: ' + r))
    })
  })
}

/**
 * 贴着目标站：#14 的两条触发源都靠这个。
 * 用 mineflayer-pathfinder 靠近到 3 格内，再原地站着。
 */
async function clingTo (bot, name) {
  try {
    const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
    bot.loadPlugin(pathfinder)
    const moves = new Movements(bot)
    moves.canDig = true
    moves.digCost = 2
    moves.scafoldingBlocks = []
    const deadline = Date.now() + 120000
    let last = null
    while (Date.now() < deadline && bot.entity) {
      const p = bot.players[TARGET] && bot.players[TARGET].entity
      if (!p) { await sleep(2000); continue }
      const d = bot.entity.position.distanceTo(p.position)
      if (d <= 3.5) {
        log(`${name} 已贴到 ${TARGET} 身边（${d.toFixed(1)} 格）`)
        return true
      }
      try {
        bot.pathfinder.setMovements(moves)
        bot.pathfinder.setGoal(new goals.GoalNear(p.position.x, p.position.y, p.position.z, 2), true)
      } catch (e) {}
      last = d
      await sleep(2500)
    }
    log(`${name} 没能贴上去（最后距离 ${last === null ? '未知' : last.toFixed(1)}）`)
    return false
  } catch (e) {
    log(`${name} 贴靠失败：${e.message}`)
    return false
  }
}

function part (bot) {
  try { bot.quit() } catch (e) {
    try { bot.end() } catch (e2) {}
  }
}

async function main () {
  if (DRY) {
    log(`计划：${MINUTES} 分钟，${WAVES.length} 波，账号 ${WAVES.reduce((a, b) => a + b, 0)} 上 + 同样多下 = ${WAVES.reduce((a, b) => a + b, 0) * 2} 次事件`)
    log(`每波：${WAVES.join(' / ')} 个账号；目标 ${TARGET}`)
    return
  }

  log(`=== 开始：${MINUTES} 分钟，目标 ${TARGET}，${WAVES.length} 波 ===`)
  const waveGap = Math.max(60000, (MINUTES * 60 * 1000) / WAVES.length - 40000)

  for (let w = 0; w < WAVES.length; w++) {
    const n = WAVES[w]
    const names = []
    for (let i = 1; i <= n; i++) names.push(`TMGprobe${i}`)

    // 上线：1~3 秒内陆续进（原日志就是这样批量重连）
    const bots = []
    for (const nm of names) {
      try {
        const b = await join(nm)
        bots.push({ name: nm, bot: b })
        log(`${nm} 上线了`)
      } catch (e) {
        log(`${nm} 上线失败：${e.message}`)
      }
      await sleep(STAGGER_MS - 800 + Math.floor(Math.random() * 1600))
    }

    // 第一个账号去贴目标（#14）
    if (bots[0]) clingTo(bots[0].bot, bots[0].name).catch(() => {})

    // 高压聊天：每 25 秒一轮，每轮 8 条、间隔 200ms（≈40 条/秒的输入压力）
    let chatTimer = null
    if (CHAT) {
      const lines = INVITE
        ? ['跟我来', '跟上我', '过来这边', '跟我走', '一起下去']
        : ['XJJ 你在哪', '挖到啥了', '这边有怪', '走不走', '我卡住了',
            '你那边黑不黑', '要不要一起下去', '这服人多不多']
      chatTimer = setInterval(() => {
        for (const { bot: b } of bots) {
          if (!b || !b.chat) continue
          for (let i = 0; i < lines.length; i++) {
            setTimeout(() => {
              try { b.chat(lines[(i + Math.floor(Math.random() * 8)) % 8]) } catch (e) {}
            }, i * 200)
          }
        }
      }, 25000)
    }

    const hold = HOLD_MS + Math.floor(Math.random() * 20000)
    await sleep(hold)

    if (chatTimer) clearInterval(chatTimer)
    // 下线
    for (const { name, bot } of bots) {
      part(bot)
      log(`${name} 下线了`)
      await sleep(700 + Math.floor(Math.random() * 2000))
    }

    if (w < WAVES.length - 1) {
      const rest = waveGap - hold
      if (rest > 0) await sleep(rest)
    }
  }
  log('=== 结束 ===')
}

main().then(() => process.exit(0)).catch(e => {
  log('驱动崩了：' + (e && e.stack || e))
  process.exit(1)
})
