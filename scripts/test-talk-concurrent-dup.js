#!/usr/bin/env node
'use strict'
/**
 * 并发复读闸（2026-11-14 07:16 现场）
 *
 *   node scripts/test-talk-concurrent-dup.js
 *
 * 【现场】
 *   [07:16:05] [say] 快没了 谁在附近
 *   [07:16:05] [say] 快没了 谁在附近      <- 同一秒，一字不差，两条都真发出去了
 *
 * `[say]` 全仓只有一处会打印（src/talk.js:654），所以两行 = 两次真的 chat()。
 * 这不是"日志重复打了一次"，是同一句话被送出去两遍。
 *
 * 【为什么要单独测】
 * 复读拦截（recentSaid）和限速（sayGap/窗口）都是「先检查 → 再等几秒 → 才提交」。
 * 两个调用如果**同时**进闸门，两边都看到"还没说过"，就都会放行。
 * 单线程 Node 里这不是理论问题：模型往返是 await，两次触发可以同时挂在闸门里。
 *
 * 【判据】
 *   A/B 同一个 Talk 实例，同一句话**并发**喊 → 只能出去 1 条
 *   C   并发喊不同的话 → 连续两条不能被同一个时间片挤出去（限速要生效）
 *   D   顺序喊同一句（控制组）→ 1 条
 *
 * 全 mock：不连服务器、不调模型、不写 data/runtime。
 */

const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const Talk = require(path.join(ROOT, 'src', 'talk'))

let pass = 0
let fail = 0
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}

function mkMem () {
  return {
    people: {},
    secrets: [],
    person (n) { if (!this.people[n]) this.people[n] = { trust: 0, notes: [] }; return this.people[n] },
    remember () { return [] },
    maybeRemember () { return null },
    getSecrets () { return [] },
    markTold () {}, add () {},
    peopleDigest () { return '（还不认识谁）' },
    placesDigest () { return '（还没记地方）' },
    recentSession () { return '' },
    lastSummary () { return null },
    addSecret () { return null }
  }
}

/** 和 test-talk-speakgate.js 同一套 mock，保证测得是同一条真实路径 */
function mkTalk (lines = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-dup-'))
  const sent = []
  const logs = []
  const q = lines.slice()
  const bot = { username: 'XJJ', chat (t) { sent.push(t) } }
  // 模型每次都被调用 → 返回队列里的下一句；队列空了就重复最后一句
  const llm = {
    async chat () {
      await new Promise(r => setTimeout(r, 15))   // 模拟模型往返
      return { text: q.length ? q.shift() : (q._last || '[不说]') }
    }
  }
  const last = lines.length ? lines[lines.length - 1] : '[不说]'
  llm.chat = (() => { const f = llm.chat; return async (...a) => { const r = await f(...a); q._last = r.text; return r } })()
  const ctx = {
    dataDir: dir,
    log: (m) => logs.push(m),
    // 【关键】必须用真实延迟（45ms/字，900~5200ms）。
    // 设成 0 时 async 函数一路同步跑完，第二次调用会看到 recentSaid 里已经有了 → 假绿。
    // 07:16:05 那个窗口就是 await humanDelay() 这 0.5~2 秒撑开的。
    cfg: { behavior: { chatDelayPerChar: 45, chatMinDelay: 900, chatMaxDelay: 5200 } },
    busy: () => false,
    taskDesc: () => '',
    perceive: { brief: () => '' },
    taste: { prompt: () => '' },
    mood: { prompt: () => '', state: () => 'normal', irritation: 0, spirit: 0.5 },
    botNames: []
  }
  Talk.GLOBAL_SAY.lastAt = 0
  Talk.GLOBAL_SAY.window = []
  const talk = new Talk(bot, llm, mkMem(), ctx)
  return { talk, sent, logs, dir, last }
}

async function main () {
  // ================================================================
  console.log('\n[A] 同一句并发喊两次（07:16:05 现场的最小复现）')
  {
    const { talk, sent, dir } = mkTalk(['快没了 谁在附近', '快没了 谁在附近'])
    // 两条同时在飞：都还没提交，都看得到"还没说过"
    const r = await Promise.all([
      talk.say('快没了 谁在附近'),
      talk.say('快没了 谁在附近')
    ])
    ok(sent.length === 1, '公屏上只出现 1 条', JSON.stringify(sent))
    ok(r.filter(Boolean).length === 1, '只有一次返回 true', JSON.stringify(r))
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ================================================================
  console.log('\n[B] 同一句并发喊三次')
  {
    const { talk, sent, dir } = mkTalk(['血不多了', '血不多了', '血不多了'])
    await Promise.all([
      talk.say('血不多了'), talk.say('血不多了'), talk.say('血不多了')
    ])
    ok(sent.length === 1, '公屏上只出现 1 条', JSON.stringify(sent))
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ================================================================
  console.log('\n[C] 并发喊不同的话：限速要生效')
  {
    const { talk, sent, dir } = mkTalk(['来了啊', '天黑这么快'])
    await Promise.all([talk.say('来了啊'), talk.say('天黑这么快')])
    ok(sent.length <= 1, '同一时间片里最多出去 1 条', JSON.stringify(sent))
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ================================================================
  console.log('\n[D] 控制组：顺序喊同一句，第二次必须被拦')
  {
    const { talk, sent, dir } = mkTalk(['快没了 谁在附近'])
    const r1 = await talk.say('快没了 谁在附近')
    const r2 = await talk.say('快没了 谁在附近')
    ok(r1 === true, '第 1 次说得出去')
    ok(r2 === false, '第 2 次被复读拦截', 'sent=' + JSON.stringify(sent))
    ok(sent.length === 1, '公屏只有 1 条', JSON.stringify(sent))
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ================================================================
  console.log('\n[E] 并发 + 中间隔一拍：只错开 1ms 也要拦住')
  {
    const { talk, sent, dir } = mkTalk(['有人吗 我快不行了', '有人吗 我快不行了'])
    const p1 = talk.say('有人吗 我快不行了')
    await new Promise(r => setTimeout(r, 1))
    const p2 = talk.say('有人吗 我快不行了')
    await Promise.all([p1, p2])
    ok(sent.length === 1, '公屏上只出现 1 条', JSON.stringify(sent))
    fs.rmSync(dir, { recursive: true, force: true })
  }

  console.log('\n==============================================')
  console.log(`${pass} 通过，${fail} 失败`)
  if (fail) { console.log('有失败项'); process.exit(1) }
  console.log('并发复读闸全过')
}

main().catch(e => { console.error(e); process.exit(1) })
