#!/usr/bin/env node
'use strict'
/**
 * 探针：实战自保（被怪打 / 掉血速率触发 / 分档逃跑）
 *
 *   AIFRIEND_DATA=/tmp/combat-test node scripts/probe-combat-live.js --minutes 4
 *
 * 只读服务端状态，不改世界、不注入任何东西（除非显式 --inject）。
 * 独立账号 + 独立数据目录，**不碰 data/runtime**。
 *
 * 输出重点：
 *   [probe] 每 2 秒一行：血 / 饱食 / 游戏时刻 / 最近的怪 / 正被谁打
 *   [reflex] 反射层的分档与掉血速率
 *   [hurt] / [dmg] / [sos] / [pain] / [death] 原样收
 */

const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const argv = process.argv.slice(2)
const argOf = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const MINUTES = parseFloat(argOf('minutes', '4')) || 4
// --inject：注入服务端同款 damage_event 包（不是真怪）。用来确定性验证
// "解析 + 分档 + 死因"这三段；真实被怪打另有实机跑（见 data/test-results/combat-live-*）。
const INJECT = argv.includes('--inject')
// --set-food N：把饱食度按在 N（服务端不发 health 包时生效），用来复现
// "饿 17 < 18 卡在回血线下面" —— 日志里会标 [probe] 注入。
const SET_FOOD = argv.indexOf('--set-food') >= 0 ? parseFloat(argv[argv.indexOf('--set-food') + 1]) : null
const ACCOUNT = argOf('account', 'XJJ_CBT') + Date.now().toString(36).slice(-4)
const DATA_DIR = process.env.AIFRIEND_DATA || '/tmp/combat-test'
const OUT_DIR = path.join(ROOT, 'data', 'test-results')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const M = { lines: [], reflex: [], hurt: [], dmg: [], sos: [], pain: [], death: [], survive: [], night: [] }
function feed (line) {
  const s = String(line)
  if (/^\[probe\]/.test(s)) return
  M.lines.push(s)
  for (const k of ['reflex', 'hurt', 'dmg', 'sos', 'pain', 'death', 'survive', 'night']) {
    if (new RegExp('\\[' + k + '\\]').test(s)) M[k].push(s)
  }
}

async function main () {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.mkdirSync(OUT_DIR, { recursive: true })

  console.log('='.repeat(64))
  console.log('  实战自保探针（掉血速率 / 分档逃跑）')
  console.log('='.repeat(64))
  console.log(`账号     : ${ACCOUNT}（独立，不碰线上的号）`)
  console.log(`数据目录 : ${DATA_DIR}`)
  console.log(`时长     : ${MINUTES} 分钟`)
  console.log('='.repeat(64) + '\n')

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
  cfg.bot.username = ACCOUNT
  cfg.behavior = cfg.behavior || {}
  cfg.behavior.reconnectDelaySeconds = 15
  const tmpCfg = path.join(DATA_DIR, `probe-combat-${ACCOUNT}.json`)
  fs.writeFileSync(tmpCfg, JSON.stringify(cfg, null, 2))
  process.env.AIFRIEND_CONFIG = tmpCfg

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
  const hpTrace = []
  let lastHp = null
  let recoilSeen = 0
  let hooked = false

  // reflex 是在 onSpawn 里建的，所以要等它出现再挂计数
  const hookReflex = () => {
    if (hooked || !b.reflex || !b.reflex.ctx) return
    hooked = true
    const origReflexLog = b.reflex.ctx.log
    b.reflex.ctx.log = (m) => {
      if (/^\[reflex\]/.test(String(m))) recoilSeen++
      if (origReflexLog) origReflexLog(m)
    }
  }

  const timer = setInterval(() => {
    const bot = b.bot
    if (!bot || !bot.entity) return
    hookReflex()
    if (SET_FOOD != null && Math.abs((bot.food || 0) - SET_FOOD) > 0.01) {
      try { bot.food = SET_FOOD } catch (e) {}
    }
    const el = Math.round((Date.now() - t0) / 1000)
    const hp = bot.health
    const tod = bot.time && bot.time.timeOfDay
    const near = b.reflex ? b.reflex.nearestHostile(12) : null
    let nd = null
    if (near) {
      try { nd = Math.round(b.reflex.dist(near.position, bot.entity.position) * 10) / 10 } catch (e) {}
    }
    if (lastHp != null && hp < lastHp) {
      hpTrace.push({ el, from: lastHp, to: hp })
      origLog(`[probe] ${el}s 掉血 ${Math.round((lastHp - hp) * 10) / 10}：${Math.round(lastHp)} -> ${Math.round(hp)}${near ? `（旁边 ${near.name} @${nd}）` : '（看不见怪）'}`)
    }
    lastHp = hp
    origLog(`[probe] ${el}s 血=${Math.round(hp)} 饱食=${bot.food} 时刻=${tod} 附近=${near ? near.name + '@' + nd : '无'} 任务=${b.busy ? b.taskDesc : '空闲'}`)
  }, 2000)

  // ===== 注入模式（lab fixture）=====
  let injected = false
  const injectTimer = setInterval(() => {
    if (!INJECT || injected) return
    const bot = b.bot
    if (!bot || !bot.entity || !b.reflex) return
    const el = (Date.now() - t0) / 1000
    if (el < 20) return
    injected = true

    const { Vec3 } = require(path.join(ROOT, 'node_modules', 'vec3'))
    const p = bot.entity.position.clone()
    const mobId = 99001
    // 造一个"僵尸"实体：让 main.js 走"有来源实体"那条分支（中文名/死因都靠它）
    bot.entities[mobId] = {
      id: mobId,
      name: 'zombie',
      type: 'hostile',
      username: undefined,
      position: new Vec3(p.x + 2, p.y, p.z)
    }
    // --ledge-debug：把退路判定看的那几格打出来（判定是不是太严）
    if (argv.includes('--ledge-debug') && b.reflex) {
      const { Vec3 } = require(path.join(ROOT, 'node_modules', 'vec3'))
      const bp = bot.entity.position
      const at = (x, y, z) => { const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))); return b ? b.name : '?' }
      origLog(`[probe] 地形：pos=${bp.x.toFixed(2)},${bp.y.toFixed(2)},${bp.z.toFixed(2)} 脚=${at(bp.x, bp.y, bp.z)} 头=${at(bp.x, bp.y + 1, bp.z)} 下1=${at(bp.x, bp.y - 1, bp.z)} 下2=${at(bp.x, bp.y - 2, bp.z)}`)
      for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const bx = bp.x + d[0], bz = bp.z + d[1]
        origLog(`[probe]   方向 ${d}: 脚=${at(bx, bp.y, bz)} 头=${at(bx, bp.y + 1, bz)} 下1=${at(bx, bp.y - 1, bz)} 下2=${at(bx, bp.y - 2, bz)} 下3=${at(bx, bp.y - 3, bz)} -> safe=${b.reflex.safeToStepBack({ x: d[0], z: d[1] })}`)
      }
    }
    const send = (hp, type) => {
      origLog(`[probe] 注入（服务端同款包，不是真怪）：sourceTypeId=${type} 血=${hp}`)
      try { bot.health = hp } catch (e) {}
      try {
        bot._client.emit('damage_event', {
          entityId: bot.entity.id,
          sourceTypeId: type,          // 28 = mob_attack
          sourceCauseId: mobId,
          sourceDirectId: mobId
        })
      } catch (e) { origLog('[probe] 注入失败 ' + e.message) }
    }
    // 20 -> 16 -> 12 -> 9（每 3 秒一下，和实测"2 秒 5 血"同量级）
    setTimeout(() => send(16, 28), 0)
    setTimeout(() => send(12, 28), 3000)
    setTimeout(() => send(9, 28), 6000)
    // 再来一个"环境伤害"（摔），看两条路分得开
    setTimeout(() => {
      origLog('[probe] 注入（服务端同款包）：sourceTypeId=10 fall')
      try { bot.health = 7.5 } catch (e) {}
      try {
        bot._client.emit('damage_event', {
          entityId: bot.entity.id, sourceTypeId: 10, sourceCauseId: 0, sourceDirectId: 0
        })
      } catch (e) {}
    }, 9000)
    // 最后：致死一击，验死因文案
    setTimeout(() => {
      origLog('[probe] 注入（服务端同款包）：致死的 mob_attack + death')
      try { bot.health = 0 } catch (e) {}
      try {
        bot._client.emit('damage_event', {
          entityId: bot.entity.id, sourceTypeId: 28, sourceCauseId: mobId, sourceDirectId: mobId
        })
      } catch (e) {}
      try { bot.emit('death') } catch (e) {}
    }, 14000)
  }, 1000)

  await sleep(MINUTES * 60 * 1000)
  clearInterval(injectTimer)
  clearInterval(timer)
  try { b.shutdown() } catch (e) {}
  await sleep(1200)
  console.log = origLog

  const show = (title, arr, n = 20) => {
    origLog('\n' + title + `（${arr.length} 条）`)
    if (!arr.length) return origLog('  （空）')
    arr.slice(-n).forEach(x => origLog('  ' + x))
  }

  origLog('\n' + '='.repeat(64))
  origLog('  结果')
  origLog('='.repeat(64))
  origLog(`反射层动作（[reflex] 行数）：${recoilSeen}`)
  origLog('\n掉血时间线：' + (hpTrace.length
    ? hpTrace.map(h => `${h.el}s ${Math.round(h.from)}→${Math.round(h.to)}`).join('，')
    : '（这段没掉血 —— 可能没遇到怪，不算失败）'))
  show('【掉血速率 / 分档】[reflex]', M.reflex)
  show('【来源解析】[hurt]', M.hurt)
  show('【类型名】[dmg]', M.dmg)
  show('【保命】[sos]', M.sos)
  show('【痛觉】[pain]', M.pain)
  show('【死因】[death]', M.death)

  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const logFile = path.join(OUT_DIR, `combat-live-${runId}.log`)
  fs.writeFileSync(logFile, M.lines.join('\n'))
  origLog('\n原始日志: ' + path.relative(ROOT, logFile))
  try { fs.unlinkSync(tmpCfg) } catch (e) {}
  process.exit(0)
}

main().catch(e => {
  console.error('探针崩溃: ' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n') : e))
  process.exit(2)
})
