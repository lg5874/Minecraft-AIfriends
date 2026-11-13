#!/usr/bin/env node
'use strict'
/**
 * 实机探针：「能被邀请」——玩家叫一声，他跟着走 3 分钟。
 *
 * 两个人：
 *   XJJLEADER   提要求的"玩家"：说「跟我来」，然后带路（走远、停下、再走）。
 *   XJJFOLLOWEE 被测的 AI：只装了 Invite（+ Watched），没有任何"自己开任务"的逻辑，
 *               所以能干净地看出"跟着的时候会不会乱跑"。
 *
 * 判据（lead 给的）：跟 3 分钟不丢人 / 不插队干活 / 至少 2 句话 / 不站人身上、不跳崖。
 *
 * 用法：node scripts/probe-invite-live.js [--seconds 180]
 */

const mineflayer = require('mineflayer')
const pf = require('mineflayer-pathfinder')
const goals = pf.goals
const { Invite } = require('../src/invite')
const { Watched } = require('../src/audience')

const HOST = process.env.MC_HOST || 's205.singsi.cn'
const HOST_IP = process.env.MC_HOST_IP || '198.18.0.29'
const PORT = +(process.env.MC_PORT || 19830)
const VER = process.env.MC_VER || '1.21.11'
const ARG = process.argv.indexOf('--seconds')
const DUR = (ARG > 0 ? +process.argv[ARG + 1] : 180) * 1000

const LEADER = 'XJJLEADER'
const FOLLOWER = 'XJJFOLLOWEE'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const t0 = Date.now()
const rel = () => Date.now() - t0

function connect (name, host = HOST) {
  return new Promise((resolve, reject) => {
    const b = mineflayer.createBot({ host, port: PORT, username: name, version: VER, auth: 'offline' })
    b.loadPlugin(pf.pathfinder)
    let done = false
    const to = setTimeout(() => { if (!done) { done = true; reject(new Error('连接超时')) } }, 40000)
    b.once('spawn', () => { if (!done) { done = true; clearTimeout(to); resolve(b) } })
    b.once('error', e => { if (!done) { done = true; clearTimeout(to); reject(e) } })
    b.once('kicked', r => log(`[${name}] kicked`, JSON.stringify(r).slice(0, 100)))
    b.once('end', r => log(`[${name}] 断开`, r))
  })
}

/**
 * 连接重试。
 *
 * 【踩过的坑】原来一次失败就连两次（域名 + IP），服务器按 IP 限流，
 * 直接 "Connection throttled! Please wait before reconnecting." —— 越重试越进不去。
 * 现在：单次尝试，失败就老老实实等，而且失败原因如果是 throttled 就等更久。
 */
async function connectRetry (name) {
  let wait = 8000
  for (let i = 0; i < 4; i++) {
    try { return await connect(name, HOST) } catch (e) {
      const throttled = /throttl/i.test(e.message || '')
      const w = throttled ? 45000 : wait
      log(`[${name}] 第 ${i + 1} 次连接失败：${e.message}；${Math.round(w / 1000)}s 后重试`)
      await sleep(w)
      wait *= 2
    }
  }
  throw new Error(name + ' 连不上')
}

const samples = []
let leaderLast = null
let leaderMoved = 0
const said = []
const leaderSaid = []
let leader = null
let follower = null
let invite = null
let watch = null

async function main () {
  log(`连接 ${HOST}:${PORT} 领队=${LEADER} 跟随=${FOLLOWER} 时长=${DUR / 1000}s`)

  follower = await connectRetry(FOLLOWER)
  log('跟随者上线')
  await sleep(1500)

  // AI 这边：Watched（顺带验被注视）+ Invite（说话直接发公屏）
  watch = new Watched({ log: s => log(s), familiarOf: () => false, ignore: () => false, busy: () => false })
  invite = new Invite({
    log: s => log(s),
    speak: async (situation, opts = {}) => {
      // 这里不走 LLM：直接用一句"带名字的短句"，重点验证跟随行为与题意。
      const who = (opts.people && opts.people[0]) || '你'
      const lines = [
        `来了${who}`,
        `${who} 等等我`,
        `跟着呢`,
        `${who} 你这是要去哪`
      ]
      const text = lines[Math.min(lines.length - 1, said.length)]
      try { follower.chat(text) } catch (e) { return false }
      said.push(text)
      log(`[跟随者说] ${text}（触发：${String(situation).slice(0, 26)}）`)
      return true
    },
    isBotName: () => false
  })
  invite.attach(follower)
  // 公屏 -> 邀请识别（主程序里这行在 main.js 的 chat handler 里）
  follower.on('chat', (u, m) => {
    if (u === follower.username) return
    try { invite.handleChat(u, m) } catch (e) {}
  })

  log('等领队上线…')
  leader = await connectRetry(LEADER)
  await sleep(1500)
  log('领队上线')

  leader.on('chat', (u, m) => { if (u !== leader.username) leaderSaid.push(`${u}: ${m}`) })

  // 距离采样 + 跟随者是否"自己乱跑"（记录它的位置变化速度）
  let lastPos = null
  const tick = setInterval(() => {
    try {
      watch.observe(follower)
      const lp = leader.entity && leader.entity.position
      const fp = follower.entity && follower.entity.position
      if (!lp || !fp) return
      const d = fp.distanceTo(lp)
      const moved = lastPos ? fp.distanceTo(lastPos) : 0
      if (leaderLast) leaderMoved += leaderLast.distanceTo(lp)
      leaderLast = lp.clone ? lp.clone() : null
      lastPos = fp.clone ? fp.clone() : null
      samples.push({
        t: rel(),
        d: +d.toFixed(1),
        dy: +(lp.y - fp.y).toFixed(1),
        moved: +moved.toFixed(2),
        active: invite.active,
        goal: follower.pathfinder.goal ? follower.pathfinder.goal.constructor.name : null,
        watched: watch.state.anyoneLooking
      })
    } catch (e) {}
  }, 1000)

  // 领队带路：10 秒后喊人，然后走远/停/再走
  setTimeout(() => {
    try {
      leader.chat(`${FOLLOWER} 跟我来，我去那边看看`)
      log('[领队] 说了：跟我来')
    } catch (e) {}
  }, 8000)

  // 领队带路：30 秒一轮（走 20 秒 + 停 10 秒），走到下一个航点。
  // 【第一版写错了】原来只在"距离 > 6"时才走 —— 结果跟随者贴上 1.4 格后
  // 领队就再也没动过，3 分钟两人并排站着，等于什么都没测。
  const waypoints = [[10, 0], [0, 12], [-10, 0], [0, -12], [8, 8], [-8, -8]]
  let wi = 0
  const walk = setInterval(async () => {
    if (rel() > DUR - 8000) return
    const lp = leader.entity && leader.entity.position
    if (!lp) return
    const cycle = rel() % 30000
    if (cycle > 20000) {                    // 停下来等我 10 秒
      try { leader.pathfinder.setGoal(null) } catch (e) {}
      return
    }
    const [dx, dz] = waypoints[wi % waypoints.length]
    if (cycle < 2000) wi++                     // 每轮走一个新航点
    try {
      leader.pathfinder.setGoal(new goals.GoalNear(
        Math.floor(lp.x + dx), Math.floor(lp.y), Math.floor(lp.z + dz), 1))
    } catch (e) {}
  }, 5000)

  await sleep(DUR)
  clearInterval(tick)
  clearInterval(walk)

  try { invite.detach() } catch (e) {}
  await sleep(800)
  try { leader.quit() } catch (e) {}
  try { follower.quit() } catch (e) {}

  report()
  process.exit(0)
}

function report () {
  const r = invite.report()
  const s = samples.filter(x => x.active)
  const near = s.filter(x => x.d <= 3.5)
  const dists = s.map(x => x.d).sort((a, b) => a - b)
  const q = p => (dists.length ? dists[Math.min(dists.length - 1, Math.floor((dists.length - 1) * p))] : null)

  console.log('\n================ 实机：跟着走 ================')
  console.log(`跟随状态采样 ${s.length} 秒（active=true 的时段）`)
  console.log(`距离：p10=${q(0.1)} p50=${q(0.5)} p90=${q(0.9)} max=${dists[dists.length - 1]}`)
  console.log(`3.5 格内占比 ${(near.length / Math.max(1, s.length) * 100).toFixed(0)}%`)
  console.log(`开会/跟丢：lost=${r.lost} giveUp=${r.giveUp} stops=${r.stops}`)
  console.log(`说话 ${said.length} 句：${JSON.stringify(said)}`)
  console.log(`喊"等等" ${r.shouts} 次；后退 ${r.backoffs} 次；绕路(防跳崖) ${r.ledgeGuards} 次`)
  console.log(`push goal ${r.goals} 次；被注视采样 ${samples.filter(x => x.watched).length} 秒`)
  const dyMax = s.length ? Math.max(...s.map(x => Math.abs(x.dy))) : 0
  console.log(`领队这段路实际走了 ${leaderMoved.toFixed(1)} 格`)
  console.log(`高差最大 ${dyMax} 格（超过 4 就是"跟着跳下去了"）`)
  const movedWhenIdle = s.filter(x => x.moved < 0.05).length
  console.log(`跟随者站住不动的秒数 ${movedWhenIdle} / ${s.length}（玩家停他也停）`)
  const tail = samples.slice(-10).map(x => `${Math.round(x.t / 1000)}s d=${x.d} ${x.goal || '-'}`)
  console.log('最后 10 秒：' + tail.join(' | '))
}

main().catch(e => { console.error('崩了：', e && e.message); process.exit(1) })
