#!/usr/bin/env node
'use strict'
/**
 * 求救话的复读 / 连发回归（2026-11-14）。
 *
 *   node scripts/test-sos-dedup.js
 *
 * 现场（/tmp/newcode.log）：
 *   06:12:45 [say] 我快挺不住了 有吃的吗
 *   06:27:56 [say] 我快挺不住了 有吃的吗      ← 15 分钟后一字不差
 *   06:15:37 [say] 再不来人我就没了
 *   06:15:38 [say] 再不来人我就没了            ← 连发两句
 *   （中间一句**不同**的反被 [say 限速] 丢了）
 *
 * 两个根因都不在 reflex：
 *   A. talk.js 的 recentSaid 只存 10 条，却宣称"30 分钟窗口" ——
 *      15 分钟里说了 14 句，原句早被挤掉。
 *   B. say() 是"查闸门 → await 打字延迟（900~5200ms）→ 才写时间戳"，
 *      同一瞬间进来的两次调用都能通过检查 —— 检查-等待-才提交的竞态。
 *
 * 全 mock：不连服务器、不调模型、不写 data/runtime。
 */

const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const Talk = require(path.join(ROOT, 'src', 'talk'))
const Reflex = require(path.join(ROOT, 'src', 'reflex'))

let pass = 0
let fail = 0
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}

function mkMem () {
  return {
    people: {}, secrets: [],
    person (n) { if (!this.people[n]) this.people[n] = { trust: 0, notes: [] }; return this.people[n] },
    remember () { return [] }, maybeRemember () {}, getSecrets () { return [] }, markTold () {}, add () {},
    peopleDigest () { return '' }, placesDigest () { return '' }, recentSession () { return '' },
    lastSummary () { return null }, addSecret () {}
  }
}

function mkTalk () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sos-dedup-'))
  const sent = []
  const logs = []
  const bot = { username: 'XJJ', chat: (t) => sent.push(t) }
  const llm = { async chat () { return { text: '[不说]' } } }
  const ctx = {
    dataDir: dir, log: (m) => logs.push(m),
    cfg: { behavior: { chatDelayPerChar: 0, chatMinDelay: 0, chatMaxDelay: 1 } },
    busy: () => false, taskDesc: () => '',
    perceive: { brief: () => '' },
    taste: { prompt: () => '' }, mood: { prompt: () => '', state: () => 'normal', irritation: 0, spirit: 0.5 },
    botNames: []
  }
  Talk.GLOBAL_SAY.lastAt = 0
  Talk.GLOBAL_SAY.window = []
  return { talk: new Talk(bot, llm, mkMem(), ctx), sent, logs, dir }
}

/** 让时间过去 ms（两个时钟 + 窗口一起后退；recentSaid 不在这里动） */
function advance (talk, ms) {
  talk.lastSayAt = (talk.lastSayAt || Date.now()) - ms
  talk.lastSpokeAt = (talk.lastSpokeAt || 0) - ms
  Talk.GLOBAL_SAY.lastAt = (Talk.GLOBAL_SAY.lastAt || Date.now()) - ms
  if (Array.isArray(talk.sayWindow)) talk.sayWindow = talk.sayWindow.map(x => x - ms)
  Talk.GLOBAL_SAY.window = Talk.GLOBAL_SAY.window.map(x => x - ms)
}

function cleanup (x) { try { fs.rmSync(x.dir, { recursive: true, force: true }) } catch (e) {} }

async function main () {
  // ================================================================
  console.log('\n[1] 同一句 15 分钟内不会出现第二次（recentSaid 存得住 30 分钟）')
  {
    const x = mkTalk()
    const A = '我快挺不住了 有吃的吗'
    ok(await x.talk.say(A) === true, '第 1 次说得出去')

    // 模拟 14 分钟过去（两个时钟一起退；recentSaid 里那条的 at 也跟着退）
    advance(x.talk, 14 * 60 * 1000)
    x.talk.recentSaid.forEach(e => { e.at -= 14 * 60 * 1000 })

    const again = await x.talk.say(A)
    ok(again === false, '14 分钟后同一句被拦', JSON.stringify(x.sent))
    ok(x.logs.some(l => l.startsWith('[repeat blocked]')), '日志是 [repeat blocked]（不是限速）')
    ok(x.sent.length === 1, '公屏只有 1 条')
    cleanup(x)
  }

  // ================================================================
  console.log('\n[2] 中间隔 14 句也挤不掉它（旧代码只存 10 条，第 11 条就挤没了）')
  {
    const x = mkTalk()
    const A = '再不来人我就没了'
    await x.talk.say(A)
    for (let i = 0; i < 14; i++) {
      advance(x.talk, 2700)
      await x.talk.say('无关的第' + i + '句话')
    }
    ok(x.sent.length === 15, '中间那 14 句都说出去了', String(x.sent.length))
    ok(x.talk.recentSaid.length >= 15, `recentSaid 存了 ${x.talk.recentSaid.length} 条（旧实现最多 10）`)

    advance(x.talk, 2700)
    x.talk.recentSaid.forEach(e => { e.at -= 14 * 60 * 1000 })   // 都算 14 分钟前
    const again = await x.talk.say(A)
    ok(again === false, '14 分钟 + 中间 14 句之后，同一句仍被拦', JSON.stringify(x.sent.slice(-2)))
    cleanup(x)
  }

  // ================================================================
  console.log('\n[3] 连发两句相同 SOS 只发一句（并发竞态）')
  {
    const x = mkTalk()
    const A = '再不来人我就没了'
    // 同一瞬间两次调用 —— 现场就是这样进来的（血 4→2 两档 sos 前后脚）
    const [a, b] = await Promise.all([x.talk.say(A), x.talk.say(A)])
    ok(x.sent.length === 1, '公屏只有 1 条', JSON.stringify(x.sent))
    ok([a, b].filter(Boolean).length === 1, '一个 true 一个 false', `a=${a} b=${b}`)
    ok(x.logs.some(l => l.startsWith('[repeat blocked]') || l.startsWith('[say 限速]')),
      '第二句被拦（复读或限速，都算拦住）')
    cleanup(x)
  }

  // ================================================================
  console.log('\n[4] 并发时不同的话不会互相踩（旧实现会双发）')
  {
    const x = mkTalk()
    const [a, b, c] = await Promise.all([
      x.talk.say('血不多了'), x.talk.say('快撑不住了'), x.talk.say('来个人')
    ])
    ok(x.sent.length === 1, '同一瞬间三句不同的话 → 只发 1 条', JSON.stringify(x.sent))
    ok([a, b, c].filter(Boolean).length === 1, '其余被限速拦')
    ok(x.talk.sayGapBlocked === 2, `记了 2 次限速拦截（实际 ${x.talk.sayGapBlocked}）`)
    cleanup(x)
  }

  // ================================================================
  console.log('\n[5] reflex 侧：同一句 15 分钟内不挑第二次')
  {
    const said = []
    const logs = []
    const bot = {
      health: 6,
      entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 99 }, onGround: true },
      entities: {},
      inventory: { items: () => [] },
      setControlState () {},
      removeListener () {}
    }
    const r = new Reflex(bot, {
      mem: mkMem(),
      log: (m) => logs.push(m),
      say: (t) => said.push(t),
      busy: () => true
    })

    // 血一档一档往下掉：每一次都算"更糟了"，都会喊
    for (const hp of [6, 5, 4, 3, 2, 1]) {
      bot.health = hp
      r.sos('lowhp')
    }
    ok(said.length === 6, `喊了 ${said.length} 次（血 6→1 六档）`, JSON.stringify(said))
    ok(new Set(said).size === said.length, '六次没有一句重样', `${new Set(said).size}/${said.length}`)

    // 溺水 / 岩浆各喊两次，也不能撞
    for (const k of ['drown', 'drown', 'lava', 'lava']) {
      bot.health = 2
      r._sosBandHp = null
      r.sosKind = ''
      r._sosActAt = 0
      r.sos(k, { urgent: true })
    }
    ok(new Set(said).size === said.length, `溺水/岩浆四次也没撞（共 ${said.length} 句）`, JSON.stringify(said.slice(-4)))
  }

  // ================================================================
  console.log('\n[6] 池子喊完了就这次不喊（不重复、也不静默无声地循环）')
  {
    const said = []
    const logs = []
    const bot = {
      health: 6, entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 99 }, onGround: true },
      entities: {}, inventory: { items: () => [] }, setControlState () {}, removeListener () {}
    }
    const r = new Reflex(bot, { mem: mkMem(), log: (m) => logs.push(m), say: (t) => said.push(t), busy: () => true })
    // 把低血池的 16 句全标成"刚喊过"
    const pool = ['血不多了', '快撑不住了', '有人吗 我快不行了', '我快挺不住了 有吃的吗',
      '我这边情况不太妙', '快没了 谁在附近', '我得缓一下 不然要交代在这',
      '妈的 血见底了', '再不来人我就没了', '撑住 撑住',
      '血就剩一点了', '我快被打死了', '来个人 我要没了', '谁有吃的 给我一口',
      '站不住了', '我快交代了']
    r._sosSaid = pool.map(t => ({ text: t, at: Date.now() }))
    r.sos('lowhp')
    ok(said.length === 0, '全喊过 → 这次不喊', JSON.stringify(said))
    ok(logs.some(l => l.includes('[sos 静默]')), '日志说明为什么没喊', logs.filter(l => l.includes('静默'))[0])
  }

  console.log('\n===== 结果 =====')
  console.log(`${pass} 通过，${fail} 失败`)
  if (fail) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
