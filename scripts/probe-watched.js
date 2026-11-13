#!/usr/bin/env node
'use strict'
/**
 * 探针：「有人在看」这一维的数据（offscreen，不连服务器）
 *
 * 要回答三个问题：
 *   1. 有没有人看，动作节奏到底差多少？（dig 前停顿分布）
 *   2. 触发频率多少？10 分钟里会不会太频繁？
 *   3. 有人站着不走，会不会一直反应（卡住）？
 *
 * 全部用可注入假时钟（now: () => t）和假 sleep，一秒真实时间都不等。
 * 只有最后一段跑真的 spontaneous.scanPeople，验证接线。
 *
 * 用法：node scripts/probe-watched.js
 */

const { Watched } = require('../src/audience')

let pass = 0; let fail = 0
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) } else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}

// ---------------------------------------------------------------- 假世界

function makeBot (name = 'AI', at = { x: 0, y: 64, z: 0 }) {
  const bot = {
    username: name,
    entity: { position: Object.assign({}, at), yaw: 0, onGround: true },
    players: {},
    targetDigBlock: null,
    digCount: 0,
    dugAt: [],
    dig: async function () { bot.digCount++; bot.dugAt.push(clockT) },
    look () {},
    swingArm () {},
    setControlState () {},
    pathfinder: { isMoving: () => false },
    blockAt: () => ({ boundingBox: 'block' })
  }
  return bot
}

/** 加一个玩家：pos（相对 bot）、yaw（0=+Z，PI=朝向 -Z） */
function addPlayer (bot, name, pos, yaw = 0) {
  bot.players[name] = {
    username: name,
    entity: { position: Object.assign({}, pos), yaw, pitch: 0 }
  }
  return bot.players[name]
}

/** 让玩家"看着" bot：算出朝向 bot 的 yaw */
function lookAt (bot, name) {
  const p = bot.players[name]
  const me = bot.entity.position
  const dx = me.x - p.entity.position.x
  const dz = me.z - p.entity.position.z
  p.entity.yaw = Math.atan2(-dx, dz)
  return p
}

let clockT = 0
const logs = []

/** 可复现的伪随机（LCG）：mood / 抖动 / 概率全部由它决定，跑几遍数据一致 */
function makeRand (seed = 20261113) {
  let x = seed >>> 0
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0
    return x / 4294967296
  }
}

function makeWatch (bot, opts = {}) {
  return new Watched({
    log: s => logs.push(`[t=${(clockT / 1000).toFixed(0)}s] ${s}`),
    now: () => clockT,
    sleep: async () => {},
    familiarOf: opts.familiarOf || (() => false),
    busy: () => false,
    ignore: () => false,
    rand: opts.rand || makeRand(1),
    forcedMood: opts.forcedMood || null
  })
}

const avg = a => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null)
const pct = (a, p) => {
  if (!a.length) return null
  const s = a.slice().sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]
}

/**
 * 跑一段模拟：durationMs 内每 digEveryMs 挖一格，每 second 观察一次。
 * @param {object} cfg { bot, watcher?(t) -> 更新玩家, durationMs }
 */
async function run (watch, bot, durationMs, opts = {}) {
  const digEvery = opts.digEveryMs || 2000
  const start = clockT
  let nextDig = start + 500
  while (clockT < start + durationMs) {
    if (opts.schedule) opts.schedule(clockT - start)
    watch.observe(bot)
    if (clockT >= nextDig) {
      nextDig += digEvery
      // 走真正的 dig 包装（含 preDigDelay）
      bot.targetDigBlock = { name: 'stone' }
      await bot.dig(bot.targetDigBlock, true)
      bot.targetDigBlock = null
    }
    clockT += 1000
  }
}

async function main () {
// ================================================================
console.log('\n[1] 没人看着时：基准节奏')
// ================================================================
{
  clockT = 0
  const bot = makeBot()
  const w = makeWatch(bot)
  await run(w, bot, 10 * 60 * 1000)
  const r = w.report()
  ok(bot.digCount >= 290, `10 分钟挖了 ${bot.digCount} 格（2 秒一格）`)
  ok(r.preDelayAvgMs.watched === null, '没有"被看"的样本')
  ok(r.preDelayAvgMs.unwatched === 0, '没人看时 dig 前停顿 = 0ms（动作稳定如旧）')
  ok(r.episodes === 0 && w.stats.reactions && Object.keys(w.stats.reactions).length === 0, '没有产生任何"被注视"反应')
}

// ================================================================
console.log('\n[2] 生人站在 3 格盯着看，连续 10 分钟（最坏情况）')
// ================================================================
let watchedAvg = null; let watchdog = null
{
  clockT = 0
  const bot = makeBot()
  addPlayer(bot, 'XJJWATCH', { x: 0, y: 64, z: -3 })   // 正南 3 格
  lookAt(bot, 'XJJWATCH')
  const w = makeWatch(bot, { forcedMood: 'tense', rand: makeRand(7) })
  await run(w, bot, 10 * 60 * 1000, {
    schedule: () => { lookAt(bot, 'XJJWATCH') }        // 一直盯着
  })
  const r = w.report()
  watchedAvg = r.preDelayAvgMs.watched
  watchdog = r

  // 抖动只看"还被看着、还没收摊"那段（收摊后是压低版余温，单独看）
  const pre = w.stats.preDelayMs.watched.slice(0, 40)
  ok(r.preDelayAvgMs.watched > 40, `被看时 dig 前平均停顿 ${r.preDelayAvgMs.watched}ms（没人看是 0ms）`)
  ok(pct(pre, 0.9) > 100, `刚被看时 p90 停顿 ${pct(pre, 0.9)}ms / p10 ${pct(pre, 0.1)}ms —— 每次不一样，节奏有抖动`)
  ok(pct(pre, 0.9) - pct(pre, 0.1) > 60, `抖动幅度 ${pct(pre, 0.9) - pct(pre, 0.1)}ms（不是固定延时）`)
  ok(r.episodes >= 1, `注视幕 episodes=${r.episodes}`)
  ok(Object.keys(r.byMood).length >= 1, `mood 抽到：${JSON.stringify(r.byMood)}`)

  // 触发频率：10 分钟最多 6 次（maxReactPer10Min）
  ok(r.reactsPer10Min <= 6, `10 分钟内反应 ${r.reactsPer10Min} 次（上限 6，不会每次靠近都演）`)
  // 收摊：人一直不走，反应次数不能无限涨
  ok(r.reactsPer10Min <= 3, `10 分钟只有 ${r.reactsPer10Min} 次主动反应（抬头看每幕上限 3）`)
  console.log(`     细节：reactions=${JSON.stringify(r.reactions)} mood=${w.state.mood}`)

  // 前 60 秒之后：不再有新的主动反应（人还站着，但不继续演 -> 不卡住）
  const late = (w._reactLog || []).filter(x => x.t - 0 > 60000)
  ok(late.length === 0, `60 秒后 0 次新反应（总共 ${(w._reactLog || []).length} 次都发生在头一分钟）`)
  // 但节奏一直在：人还看着，手就一直有点抖（不是前 30 秒有反应、之后就是机器人）
  const all = w.stats.preDelayMs.watched
  ok(avg(all.slice(0, 40)) > 40, `头 40 格平均停顿 ${avg(all.slice(0, 40))}ms`)
  ok(avg(all.slice(-60)) > 40, `最后 60 格平均停顿 ${avg(all.slice(-60))}ms —— 一直被看着，节奏一直不一样`)
  ok(r.dug.unwatched < 5, `整段几乎没有"回到无人状态"的格数（${r.dug.unwatched}）`)
}

// ================================================================
console.log('\n[2b] 同一场景，mood=showoff（显摆：干得更起劲）')
// ================================================================
{
  clockT = 0
  const bot = makeBot()
  addPlayer(bot, 'XJJWATCH2', { x: 0, y: 64, z: -3 })
  lookAt(bot, 'XJJWATCH2')
  const w = makeWatch(bot, { forcedMood: 'showoff', rand: makeRand(11) })
  await run(w, bot, 4 * 60 * 1000, { schedule: () => { lookAt(bot, 'XJJWATCH2') } })
  const r = w.report()
  ok(r.preDelayAvgMs.watched !== null && r.preDelayAvgMs.watched < 40,
    `显摆时停顿只有 ${r.preDelayAvgMs.watched}ms（手不停，比紧张时快）`)
  ok(r.flourish > 0, `挖完空挥 ${r.flourish} 次（"看我的"）`)
  ok(r.reactsPer10Min <= 6, `频率仍在闸内：${r.reactsPer10Min} 次`)
  console.log(`     细节：主动反应 ${JSON.stringify(r.reactions)}，显摆空挥 ${r.flourish} 次，收摊=${w.state.settled}`)
}

// ================================================================
console.log('\n[2c] 同一场景，mood=awkward（尴尬：跳一下 / 挪半步 / 移开视线）')
// ================================================================
{
  clockT = 0
  const bot = makeBot()
  addPlayer(bot, 'XJJSTARER', { x: 0, y: 64, z: -2 })
  lookAt(bot, 'XJJSTARER')
  const w = makeWatch(bot, { forcedMood: 'awkward', rand: makeRand(17) })
  await run(w, bot, 10 * 60 * 1000, { schedule: () => { lookAt(bot, 'XJJSTARER') } })
  const r = w.report()
  const strong = (r.reactions.hop || 0) + (r.reactions.stepAside || 0) + (r.reactions.glanceAway || 0)
  ok(strong > 0, `尴尬时出现强反应：${JSON.stringify(r.reactions)}`)
  ok(w.state.settled === true, '强反应 2 次后收摊 settled=true')
  const late = (w._reactLog || []).filter(x => x.t > 120000)
  ok(late.length === 0, `2 分钟后不再有任何反应（人一直站着，也不会一直演）`)
  ok(r.reactsPer10Min <= 6, `整段 10 分钟反应 ${r.reactsPer10Min} 次（上限 6）`)
  console.log(`     细节：${JSON.stringify(r.reactions)}，收摊后余温停顿 ${avg(w.stats.preDelayMs.watched.slice(-40))}ms`)
}

// ================================================================
console.log('\n[3] 有人在 8 格内但**背对**我：不该有任何影响')
// ================================================================
{
  clockT = 0
  const bot = makeBot()
  addPlayer(bot, 'XJJBACK', { x: 0, y: 64, z: -3 }, Math.PI)   // 背对
  const w = makeWatch(bot, { rand: makeRand(3) })
  await run(w, bot, 3 * 60 * 1000, {
    schedule: () => { bot.players.XJJBACK.entity.yaw = Math.PI }
  })
  const st = w.state
  ok(st.count === 1, '感知到附近有人（count=1）')
  ok(st.anyoneLooking === false, '但判定为"没在看我"')
  ok(w.report().preDelayAvgMs.watched === null, '没有"被看"样本 —— 只认朝向，不认人头')
  ok(st.intensity < 0.5, `intensity=${st.intensity} 只有距离贡献，没有视线权重`)
}

// ================================================================
console.log('\n[4] 人反复来走 10 次（每次 40 秒）：触发频率')
// ================================================================
{
  clockT = 0
  const bot = makeBot()
  const w = makeWatch(bot, { rand: makeRand(5) })
  let name = 'XJJWANDER'
  // 每 60 秒出现 40 秒
  await run(w, bot, 10 * 60 * 1000, {
    digEveryMs: 2000,
    schedule: rel => {
      const phase = rel % 60000
      const present = phase < 40000
      if (present && !bot.players[name]) {
        addPlayer(bot, name, { x: 0, y: 64, z: -2 })
      }
      if (!present && bot.players[name]) delete bot.players[name]
      if (present) lookAt(bot, name)
    }
  })
  const r = w.report()
  ok(r.visits >= 8, `到访 ${r.visits} 次`)
  ok(r.episodes >= 8, `注视幕 ${r.episodes} 次`)
  ok(r.reactsPer10Min <= 6, `10 分钟只反应 ${r.reactsPer10Min} 次（全局上限 6）`)
  ok(r.reactsPer10Min >= 1, '但确实反应了（不是永远不动）')
  console.log(`     细节：mood 分布 ${JSON.stringify(r.byMood)}，反应 ${JSON.stringify(r.reactions)}`)
}

// ================================================================
console.log('\n[5] 熟人盯着看：mood 应该偏 relaxed/showoff')
// ================================================================
{
  clockT = 0
  const bot = makeBot()
  addPlayer(bot, 'OLDFRIEND', { x: 0, y: 64, z: -3 })
  lookAt(bot, 'OLDFRIEND')
  const w = makeWatch(bot, { familiarOf: n => n === 'OLDFRIEND', rand: makeRand(9) })
  // 抽 60 次"一幕"，比分布
  const tally = {}
  for (let i = 0; i < 60; i++) {
    clockT += 60000
    bot.players.OLDFRIEND.entity.position.z = -3
    lookAt(bot, 'OLDFRIEND')
    w._people.clear()
    w.observe(bot)
    const r = w._people.get('OLDFRIEND')
    if (r && r.mood) tally[r.mood] = (tally[r.mood] || 0) + 1
  }
  const relaxed = (tally.relaxed || 0) + (tally.showoff || 0)
  ok(relaxed >= 30, `熟人 60 幕里 relaxed+showoff = ${relaxed}（生人是偏 tense/awkward）`)
  console.log(`     分布：${JSON.stringify(tally)}`)
}

// ================================================================
console.log('\n[6] 接线：真的 spontaneous.scanPeople 会带动被注视状态')
// ================================================================
{
  const { Spontaneity } = require('../src/spontaneous')
  clockT = 100000
  const bot = makeBot('XJJ')
  addPlayer(bot, 'XJJVIEWER', { x: 2, y: 64, z: -2 })
  lookAt(bot, 'XJJVIEWER')

  const said = []
  const spont = new Spontaneity({ log: s => logs.push(s), busy: () => false })
  spont.watch = new Watched({
    log: s => logs.push(s),
    now: () => clockT,
    sleep: async () => {},
    familiarOf: () => false,
    busy: () => false,
    rand: makeRand(13)
  })
  spont.scanPeople(bot)
  ok(spont.watch.state.count === 1, 'scanPeople 之后 watch.state.count=1（接上了）')
  ok(spont.watch.state.anyoneLooking === true, '并且认出了"在看"')
  ok(bot.__watchedAttached === true, 'bot.dig 被包装（节奏影响生效的前提）')
  ok(spont.watchSpeak === false, '说话线默认关着（social 触发归 social-fixer）')

  // 说话能力在，只是没接：手动打开能拿到事件
  spont.watchSpeak = true
  let ev = null
  for (let i = 0; i < 80 && !ev; i++) {
    clockT += 3000
    lookAt(bot, 'XJJVIEWER')
    spont.watch.observe(bot)
    ev = spont.watch.takeSpeakEvent()
  }
  ok(ev && ev.trigger === 'watchedGaze', `打开开关能产出说话事件：${ev ? ev.situation : 'null'}`)

  // 日志里有 [watched] 且带距离/朝向/时长
  const wl = logs.filter(x => x.includes('[watched]'))
  ok(wl.length > 0, `[watched] 日志 ${wl.length} 条`)
  const sample = wl.find(x => x.includes('looking='))
  ok(!!sample, '日志含 looking=')
  ok(/d=\d/.test(sample || ''), '日志含距离 d=')
  ok(/dot=-?\d/.test(sample || ''), '日志含朝向点积 dot=')
  ok(/gaze=\d/.test(sample || ''), '日志含持续时长 gaze=')
  console.log('     样例：' + sample)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (watchdog) {
  console.log(`关键数：无人时 dig 停顿 0ms；有人盯着时 ${watchedAvg}ms；10 分钟反应 ${watchdog.reactsPer10Min} 次`)
}
}
main().then(() => process.exit(fail ? 1 : 0)).catch(e => { console.error(e); process.exit(1) })
