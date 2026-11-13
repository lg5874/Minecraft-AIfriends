#!/usr/bin/env node
'use strict'
/**
 * 实机探针：「有人在看」——连真服务器，两个人。
 *
 * 主体 bot（XJJWATCHED）在地表挖土/草/石头；观察者 bot（XJJSTARER）
 * 按时间表靠近、盯着、走开、再来。全程记录每一格的间隔 + 停顿。
 *
 * 时间表（默认 600 秒）：
 *   0-150   没人（基线）
 *   150-330 有人在 3 格内盯着（第一次靠近）
 *   330-420 人走了
 *   420-540 又有人来盯着（第二次靠近）
 *   540-600 人又走了
 *
 * 用法：
 *   node scripts/probe-watched-live.js --smoke     60 秒连通性/能不能挖
 *   node scripts/probe-watched-live.js             完整 10 分钟
 */

const mineflayer = require('mineflayer')
const { Watched } = require('../src/audience')

const HOST = process.env.MC_HOST || 's205.singsi.cn'
const PORT = +(process.env.MC_PORT || 19830)
const VER = process.env.MC_VER || '1.21.11'
const SMOKE = process.argv.includes('--smoke')
const DUR = SMOKE ? 60000 : 5 * 60 * 1000

const MAIN = process.env.MAIN_NAME || 'WATCHS1'
const STARER = process.env.STARER_NAME || 'WATCHW1'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

const digs = []          // {t, delay, mood, watched, looking}
const marks = []         // 关键事件
const t0 = Date.now()
const rel = () => Date.now() - t0

let bot = null
let starer = null
let watchRef = null
let stopping = false

async function connectRetry (name) {
  let wait = 6000
  for (let i = 0; i < 5; i++) {
    try { return await connect(name) } catch (e) {
      const th = /throttl/i.test(e.message || '')
      const w = th ? 45000 : wait
      log(`[${name}] 连接失败：${e.message}；${Math.round(w / 1000)}s 后重试`)
      await sleep(w); wait *= 2
    }
  }
  throw new Error(name + ' 连不上')
}

function connect (name) {
  return new Promise((resolve, reject) => {
    const b = mineflayer.createBot({ host: HOST, port: PORT, username: name, version: VER, auth: 'offline' })
    let done = false
    const to = setTimeout(() => { if (!done) { done = true; reject(new Error('连接超时')) } }, 30000)
    b.once('spawn', () => { if (!done) { done = true; clearTimeout(to); resolve(b) } })
    b.once('error', e => { log(`[${name}] error`, e.message); if (!done) { done = true; clearTimeout(to); reject(e) } })
    b.once('kicked', r => { log(`[${name}] kicked`, JSON.stringify(r).slice(0, 120)) })
    b.once('end', r => log(`[${name}] 断开`, r))
  })
}

const DIGGABLE = ['dirt', 'grass_block', 'stone', 'sand', 'gravel', 'cobblestone', 'andesite', 'diorite']

/** 找最近能挖的方块（4 格内，视线高度附近） */
function findTarget (b) {
  let best = null
  for (const name of DIGGABLE) {
    const ids = b.registry.blocksByName[name] ? [b.registry.blocksByName[name].id] : []
    if (!ids.length) continue
    const blk = b.findBlock({ matching: ids, maxDistance: 6 })
    if (!blk) continue
    if (!best || blk.position.distanceTo(b.entity.position) < best.position.distanceTo(b.entity.position)) best = blk
  }
  return best
}

// stareLoop 里不能 await（setInterval），这里给个空转占位，避免 await 写错
function await0 () {}

async function main () {
  log(`连接 ${HOST}:${PORT} 主体=${MAIN} 观察者=${STARER} 时长=${DUR / 1000}s`)

  bot = await connectRetry(MAIN)
  log('主体已上线')

  const watch = new Watched({
    log: s => log(s),
    familiarOf: () => false,
    ignore: () => false,
    busy: () => false
  })

  watchRef = watch
  // 记录 dig 的"停顿"：在 Watched 包装之前先量一遍真实间隔
  const rawDig = bot.dig.bind(bot)
  let lastDigAt = 0
  bot.dig = async function (block, force) {
    const before = Date.now()
    try {
      return await rawDig(block, force)
    } finally {
      const st = watch.state
      digs.push({
        t: rel(),
        gapFromPrev: lastDigAt ? before - lastDigAt : null,
        watched: !!st.anyoneLooking,
        mood: st.mood || null,
        looking: (st.lookingNames || []).slice(),
        d: st.nearest ? st.nearest.d : null
      })
      lastDigAt = Date.now()
    }
  }

  // Watched 自己也会包一层（节奏来源）；这层在上面之后装，所以顺序是
  //   probe 记录层 -> Watched 停顿层 -> mineflayer bot.dig
  watch.observe(bot)

  // 观察循环
  const tick = setInterval(() => {
    try {
      watch.observe(bot)
      const st = watch.state
      if (st.anyoneLooking && !bot.targetDigBlock) {
        // 被看着的闲时：小动作由 Watched 自己做，这里只记录
      }
    } catch (e) {}
  }, 1000)

  /** 挖矿循环：一直挖最近的可挖方块 */
  const loop = (async () => {
    while (!stopping && rel() < DUR) {
      const st = watch.state
      if (SMOKE) {
        // smoke 只看能不能挖
      }
      const target = findTarget(bot)
      if (!target) {
        main._noTarget = (main._noTarget || 0) + 1
        // 没得挖就走两步找
        try {
          const p = bot.entity.position
          bot.setControlState('forward', true)
          await sleep(400)
          bot.setControlState('forward', false)
        } catch (e) {}
        await sleep(300)
        continue
      }
      try {
        await bot.dig(target, true)
        main._ok = (main._ok || 0) + 1
      } catch (e) {
        // 挖不动（保护/工具/够不到）-> 记下来，别把日志刷满
        if (!main._digErr || Date.now() - main._digErr > 10000) {
          main._digErr = Date.now()
          log('[dig] 失败：' + e.message)
        }
        await sleep(500)
      } finally {}
      await sleep(150)
    }
  })()

  /** 观察者时间表 */
  const schedule = (async () => {
    if (SMOKE) return
    const phases = [
      [100000, 'connect'],
      [260000, 'leave'],
      [300000, 'connect'],
      [320000, 'leave']
    ]
    for (const [at, what] of phases) {
      while (rel() < at && !stopping) await sleep(500)
      if (stopping) return
      if (what === 'connect') {
        try {
          marks.push({ t: rel(), what: 'starer_connect' })
          log('[观察者] 上线')
          starer = await connectRetry(STARER)
          const p = bot.entity.position
          // 站到主体旁边 3 格（直接找落脚点不行就原地上线位置）
          starer.once('spawn', () => {})
          const stareLoop = setInterval(() => {
            try {
              if (!starer || !starer.entity) return
              const me = bot.entity.position
              const sp = starer.entity.position
              const d = sp.distanceTo(me)
              if (d < 2.0) {
                // 离太近了看不清（也容易撞在一起），退半步
                starer.setControlState('forward', false)
                starer.setControlState('back', true)
                await0(300)
                starer.setControlState('back', false)
              } else if (d > 3.5) {
                // 走近：朝主体方向慢慢挪
                const yaw = Math.atan2(-(me.x - sp.x), me.z - sp.z)
                starer.look(yaw, 0, true)
                starer.setControlState('forward', true)
              } else {
                starer.setControlState('forward', false)
                // 站定了就盯着主体看
                const ey = (me.y + 1.6) - (sp.y + 1.6)
                const yaw = Math.atan2(-(me.x - sp.x), me.z - sp.z)
                const pitch = Math.atan2(ey, Math.max(0.3, Math.hypot(me.x - sp.x, me.z - sp.z)))
                starer.look(yaw, pitch, true)
              }
            } catch (e) {}
          }, 300)
          starer.__stareLoop = stareLoop
          log('[观察者] 开始盯着主体')
        } catch (e) {
          log('[观察者] 上线失败：' + e.message)
        }
      } else {
        marks.push({ t: rel(), what: 'starer_leave' })
        try {
          if (starer) {
            if (starer.__stareLoop) clearInterval(starer.__stareLoop)
            starer.quit()
          }
        } catch (e) {}
        starer = null
        log('[观察者] 走了')
      }
    }
  })()

  await Promise.all([loop, schedule])
  stopping = true
  clearInterval(tick)
  try { if (starer) starer.quit() } catch (e) {}
  try { bot.quit() } catch (e) {}

  await sleep(1500)
  report()
  process.exit(0)
}

function stat (arr) {
  if (!arr.length) return 'n=0'
  const a = arr.slice().sort((x, y) => x - y)
  const q = p => a[Math.min(a.length - 1, Math.floor((a.length - 1) * p))]
  return `n=${a.length} p10=${q(0.1)} p50=${q(0.5)} p90=${q(0.9)} avg=${Math.round(a.reduce((x, y) => x + y, 0) / a.length)}`
}

function report () {
  const w = digs.filter(x => x.watched)
  const n = digs.filter(x => !x.watched)
  const gapsW = w.map(x => x.gapFromPrev).filter(x => x != null && x > 0 && x < 60000)
  const gapsN = n.map(x => x.gapFromPrev).filter(x => x != null && x > 0 && x < 60000)

  console.log('\n================ 实机结果 ================')
  console.log(`总挖掘 ${digs.length} 格：被看着 ${w.length} 格 / 没人 ${n.length} 格`)
  console.log(`两次挖掘之间的间隔  被看着: ${stat(gapsW)}`)
  console.log(`两次挖掘之间的间隔  没人:   ${stat(gapsN)}`)
  console.log(`\n被看着时的 mood 分布：`)
  const mood = {}
  for (const x of w) mood[x.mood || '-'] = (mood[x.mood || '-'] || 0) + 1
  console.log('  ' + JSON.stringify(mood))
  console.log('\n观察者时间表：' + JSON.stringify(marks))
  const wr = watchRef ? watchRef.report() : null
  if (wr) {
    console.log(`\n节奏（Watched 自己量的 dig 前停顿）：被看 ${wr.preDelayAvgMs.watched}ms / 没人 ${wr.preDelayAvgMs.unwatched}ms`)
    console.log(`主动反应：${JSON.stringify(wr.reactions)}；10 分钟窗口内 ${wr.reactsPer10Min} 次；显摆空挥 ${wr.flourish} 次`)
    console.log(`注视幕 ${wr.episodes} 次；mood ${JSON.stringify(wr.byMood)}；到访 ${wr.visits} 次`)
    console.log(`挖掘样本 dug=${JSON.stringify(wr.dug)}`)
  }
  const tail = digs.slice(-15).map(x => `${Math.round(x.t / 1000)}s/${x.watched ? 'W' : '-'}/${x.gapFromPrev || 0}ms`)
  console.log(`挖矿循环：成功 ${main._ok || 0} 次 / 找不到目标 ${main._noTarget || 0} 次`)
  console.log('\n最后 15 格：' + tail.join('  '))
}

main().catch(e => { console.error('崩了：', e); process.exit(1) })
