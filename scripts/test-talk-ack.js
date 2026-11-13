#!/usr/bin/env node
'use strict'
/**
 * 两级回复验收（2026-11-14）。
 *
 *   node scripts/test-talk-ack.js
 *
 * 用户问「你在干啥」→ 旧行为：等模型 2~6 秒，公屏一直空着。
 * 真人在忙时会**先秒回一个短词**（"等下""咋了"），然后才说正事。
 *
 * 验五条：
 *   1. 忙 + 被问 → 500ms 内先出短词，2~6 秒后出真回复
 *   2. 闲 → 不垫，直接回
 *   3. 短词不是固定的（20 次看分布）
 *   4. 垫了话但模型失败 → 8 秒内补一句收尾
 *   5. 垫话不占发言闸（2 秒 / 20 秒×8 都不算它）
 *
 * 全 mock：不连服务器、不调真模型、不写 data/runtime。
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

const sleep = ms => new Promise(r => setTimeout(r, ms))

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

/**
 * @param {object} o
 * @param {boolean} o.busy      手上忙不忙
 * @param {number}  o.latency   模型往返毫秒
 * @param {boolean} o.fail      模型直接报错
 * @param {string}  o.brief     状态栏（决定危险等级）
 */
function mkTalk (o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-ack-'))
  const sent = []
  const at = []
  const logs = []
  const bot = { username: 'XJJ', chat (t) { sent.push(t); at.push(Date.now()) } }
  const llm = {
    async chat () {
      if (o.latency) await sleep(o.latency)
      if (o.fail) throw new Error('mock llm down')
      return { text: o.reply || '我在挖石头' }
    }
  }
  const ctx = {
    dataDir: dir,
    log: (m) => logs.push(m),
    cfg: { behavior: { chatDelayPerChar: 0, chatMinDelay: 0, chatMaxDelay: 0 } },
    busy: () => !!o.busy,
    taskDesc: () => (o.busy ? '先弄把木镐' : ''),
    perceive: { brief: () => o.brief || '地面开阔；威胁：无；血 20/20' },
    taste: { prompt: () => '' },
    mood: { prompt: () => '', state: () => 'normal', irritation: 0, spirit: 0.5 },
    botNames: []
  }
  Talk.GLOBAL_SAY.lastAt = 0
  Talk.GLOBAL_SAY.window = []
  return { talk: new Talk(bot, llm, mkMem(), ctx), sent, at, logs, dir }
}

function cleanup (x) { try { fs.rmSync(x.dir, { recursive: true, force: true }) } catch (e) {} }

async function main () {
  // ================================================================
  console.log('\n[1] 忙 + 被问 → 500ms 先垫一句，随后出真回复')
  {
    const x = mkTalk({ busy: true, latency: 1200 })
    const t0 = Date.now()
    const p = x.talk.reply('XJJ_USER1', 'XJJ 你在干啥？')
    await sleep(700)
    const ackAt = x.at[0]
    ok(x.sent.length === 1, '700ms 时公屏上已经有 1 条（垫话）', JSON.stringify(x.sent))
    ok(!!ackAt && ackAt - t0 <= 700, `垫话在 ${ackAt ? ackAt - t0 : '?'}ms 内发出（要求 ≤700，设定 500）`)
    ok(x.logs.some(l => l.startsWith('[ack]')), '日志里有 [ack]')
    await p
    ok(x.sent.length === 2, '真回复也到了（共 2 条）', JSON.stringify(x.sent))
    ok(x.sent[1] === '我在挖石头', '第 2 条是模型说的真话')
    // 模型 1200ms：真回复必须在 t0+1100 之后（垫话不会把真回复提前，只是填补等待）
    ok(x.at[1] - t0 >= 1100, `真回复在 t0+${x.at[1] - t0}ms 到（模型 1200ms）`)
    ok(x.at[1] > x.at[0], `顺序对：垫话 ${x.at[0] - t0}ms → 真回复 ${x.at[1] - t0}ms`)
    cleanup(x)
  }

  // ================================================================
  console.log('\n[2] 闲 → 不垫，直接回')
  {
    const x = mkTalk({ busy: false, latency: 100 })
    await x.talk.reply('XJJ_USER2', 'XJJ 你在干啥？')
    ok(x.sent.length === 1 && x.sent[0] === '我在挖石头', '只有真回复，没有垫话', JSON.stringify(x.sent))
    ok(x.talk.ackSent === 0, 'ackSent 还是 0')
    ok(x.talk.ackSkipped > 0, '记了一笔"该垫没垫"的跳过数', `(${x.talk.ackSkipped})`)
    cleanup(x)
  }

  // ================================================================
  console.log('\n[3] 短词不是固定的（20 次看分布）')
  {
    const x = mkTalk({ busy: true })
    const got = {}
    for (let i = 0; i < 20; i++) {
      const w = x.talk.pickAck('XJJ 你在干啥？')
      got[w] = (got[w] || 0) + 1
    }
    const kinds = Object.keys(got)
    const top = Math.max(...Object.values(got))
    ok(kinds.length >= 3, `20 次出现 ${kinds.length} 种不同短词`, JSON.stringify(got))
    ok(top <= 12, `出现最多的那个只占 ${top}/20（不是固定台词）`)
    ok(!/^(嗯|哦|啊)$/.test(kinds[0]), '不是"嗯/哦/啊"这种敷衍词', kinds.join('、'))

    // 池子跟着状态变：被叫名字 / 被问 / 忙，拿到的不是同一批
    const x2 = mkTalk({ busy: true })
    const busyWords = new Set(Array.from({ length: 40 }, () => x2.talk.pickAck('在吗？')))
    const x3 = mkTalk({ busy: false })
    const calledWords = new Set(Array.from({ length: 40 }, () => x3.talk.pickAck('XJJ')))
    const overlap = [...calledWords].filter(w => busyWords.has(w))
    ok(busyWords.size >= 4 && calledWords.size >= 4, '两档各有至少 4 种', `忙 ${busyWords.size} 种 / 被叫 ${calledWords.size} 种`)
    ok(overlap.length <= 2, `两档基本不重样（重了 ${overlap.length} 个：${overlap.join('、')}）`)
    cleanup(x); cleanup(x2); cleanup(x3)
  }

  // ================================================================
  console.log('\n[4] 垫了话但模型失败 → 8 秒内补一句收尾')
  {
    const x = mkTalk({ busy: true, fail: true })
    x.talk.ackDelayMs = 60
    x.talk.ackRecoveryMs = 250        // 测试里缩短，生产是 8000
    const p = x.talk.reply('XJJ_USER3', 'XJJ 你在干啥？')
    await sleep(600)
    const acked = x.logs.some(l => l.startsWith('[ack]'))
    const recovered = x.logs.some(l => l.startsWith('[ack 补话]'))
    ok(acked, '先垫出去了一句')
    ok(recovered, '模型失败后补了一句收尾')
    ok(x.sent.length === 2, '公屏是 2 条（垫话 + 补话）', JSON.stringify(x.sent))
    ok(/走神|没听着|在忙|没注意/.test(x.sent[1] || ''), '补的话是"没接住"的意思', x.sent[1])
    ok(x.talk.ackRecovered === 1, 'ackRecovered 记了 1 次')
    await p
    cleanup(x)
  }

  // ================================================================
  console.log('\n[5] 垫话不占发言闸（2 秒间隔 / 20 秒 8 条都不算它）')
  {
    const x = mkTalk({ busy: true })
    ok(x.talk.sendReaction('等下', 'ack') === true, '垫话发得出去')
    ok(x.talk.lastSayAt === 0, '没动 lastSayAt（不算说过话）')
    ok(x.talk.sayWindow.length === 0, '没进 20 秒窗口')
    ok(Talk.GLOBAL_SAY.lastAt === 0, '进程级闸也没动')
    const said = await x.talk.say('来了啊')
    ok(said === true, '紧接着 say 一句正常话照发（没被垫话吃掉额度）', JSON.stringify(x.sent))
    ok(x.sent.length === 2 && x.talk.sayGapBlocked === 0, '实际公屏 2 条，0 次限速拦截')
    cleanup(x)
  }

  // ================================================================
  console.log('\n[6] 不该垫的两种情况')
  {
    // 危险态：血 3，这时候"等下"会显得没在跑
    const danger = mkTalk({ busy: true, brief: '地面开阔；威胁：两只僵尸在3格外；血 3/20' })
    await danger.talk.reply('XJJ_USER4', 'XJJ 你在干啥？')
    ok(danger.talk.ackSent === 0, '危险态不垫', JSON.stringify(danger.sent))
    cleanup(danger)

    // 纯聊天（没问他）：只接自己的事，不插"嗯"
    const chat = mkTalk({ busy: true, brief: '地面开阔；威胁：无；血 20/20' })
    await chat.talk.reply('XJJ_USER5', '这破地方连棵树都没有')
    ok(chat.talk.ackSent === 0, '纯聊天不垫', JSON.stringify(chat.sent))
    cleanup(chat)

    // 10 秒内不重复垫
    const twice = mkTalk({ busy: true })
    twice.talk.sendReaction('等下', 'ack')
    ok(twice.talk.needsAck('XJJ 你在干啥？', 'XJJ_USER6') === false, '10 秒内第二次不垫')
    cleanup(twice)
  }

  console.log('\n===== 结果 =====')
  console.log(`${pass} 通过，${fail} 失败`)
  if (fail) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
