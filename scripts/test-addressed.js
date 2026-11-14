#!/usr/bin/env node
'use strict'
/**
 * 「是不是在跟我说话」的模型判定（2026-11-14）。
 *
 *   node scripts/test-addressed.js
 *
 * 背景：main.js 原来用一条正则（带名字 / 结尾问号）判 chat_me。
 * 它分不清「你在哪呢」（在问他）和「这破地方真难找」（自言自语）。
 *
 * 这里只测 talk.isAddressedTo()：三种输入、缓存、超时兜底、乱码兜底。
 * 接线（main.js）不在本文件里，由 wiring-owner 改。
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
    people: {}, secrets: [],
    person (n) { if (!this.people[n]) this.people[n] = {}; return this.people[n] },
    remember () { return [] }, maybeRemember () {}, getSecrets () { return [] }, markTold () {}, add () {},
    peopleDigest () { return '' }, placesDigest () { return '' }, recentSession () { return '' },
    lastSummary () { return null }, addSecret () {}
  }
}

/** @param {function} responder 收到 messages 返回字符串（或 Promise） */
function mk (responder) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addr-'))
  const logs = []
  let calls = 0
  const llm = {
    async chat (msgs, opts) {
      calls++
      const out = await responder(msgs, opts)
      if (out === '__hang__') return new Promise(() => {})   // 永不返回，模拟超时
      return { text: out }
    }
  }
  const ctx = {
    dataDir: dir, log: (m) => logs.push(m),
    cfg: { behavior: { chatDelayPerChar: 0, chatMinDelay: 0, chatMaxDelay: 0 } },
    busy: () => false, taskDesc: () => '', perceive: { brief: () => '' },
    taste: { prompt: () => '' }, mood: { prompt: () => '', state: () => 'normal', irritation: 0, spirit: 0.5 },
    botNames: []
  }
  const talk = new Talk({ username: 'XJJ', chat () {} }, llm, mkMem(), ctx)
  talk.history.push({ who: '老王', msg: '这破地方真难找' })
  talk.history.push({ who: '我', msg: '转了半圈 这附近真没树' })
  return { talk, logs, dir, calls: () => calls }
}

function cleanup (dir) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) {} }

async function main () {
  // ================================================================
  console.log('\n[1] 三种真实句子')
  {
    // 「你在哪呢」—— 在问他。正则判不出来（结尾是"呢"，不是问号，也没名字）
    const a = mk(() => '{"toMe": true, "want": "报位置", "urgent": 0.6}')
    const r1 = await a.talk.isAddressedTo('老王', '你在哪呢')
    ok(r1.toMe === true && r1.via === 'model', '「你在哪呢」→ toMe=true（模型判的）', JSON.stringify(r1))
    ok(r1.want === '报位置' && r1.urgent === 0.6, 'want / urgent 也解析出来了', `want=${r1.want} urgent=${r1.urgent}`)
    // 注意：「你在哪呢」因为以"你"开头，老正则其实也判对 —— 真正漏的是下面这种
    ok(a.talk._regexAddressed('在哪呢') === false, '老正则漏掉「在哪呢」（没名字、结尾不是问号）')
    const a2 = mk(() => '{"toMe": true, "want": "报位置", "urgent": 0.5}')
    const r1b = await a2.talk.isAddressedTo('老王', '在哪呢')
    ok(r1b.toMe === true && r1b.via === 'model', '「在哪呢」→ 模型判 true（老正则判不了）')
    cleanup(a2.dir)
    cleanup(a.dir)

    // 「这破地方真难找」—— 自言自语
    const b = mk(() => '{"toMe": false, "want": "别理", "urgent": 0}')
    const r2 = await b.talk.isAddressedTo('老王', '这破地方真难找')
    ok(r2.toMe === false && r2.via === 'model', '「这破地方真难找」→ toMe=false', JSON.stringify(r2))
    cleanup(b.dir)

    // 带名字
    const c = mk(() => '{"toMe": true, "want": "接话", "urgent": 0.2}')
    const r3 = await c.talk.isAddressedTo('老王', 'XJJ 来挖矿不')
    ok(r3.toMe === true, '「XJJ 来挖矿不」→ toMe=true', JSON.stringify(r3))
    ok(c.talk._regexAddressed('XJJ 来挖矿不') === true, '这句老正则也判得对（带名字）')
    cleanup(c.dir)
  }

  // ================================================================
  console.log('\n[2] 缓存：同一条消息只问一次模型')
  {
    const x = mk(() => '{"toMe": true, "want": "接话", "urgent": 0}')
    for (let i = 0; i < 5; i++) await x.talk.isAddressedTo('老王', '你在哪呢')
    ok(x.calls() === 1, `连问 5 次，模型只调用 1 次（实际 ${x.calls()}）`)
    ok(x.talk.addrCacheHits === 4, `缓存命中 4 次（实际 ${x.talk.addrCacheHits}）`)
    await x.talk.isAddressedTo('老王', '你在哪呢 ')   // 不同文本（多空格）= 不同 key
    ok(x.calls() === 2, '换一条文本会重新判', `实际 ${x.calls()}`)
    cleanup(x.dir)
  }

  // ================================================================
  console.log('\n[3] 超时兜底：模型 3 秒不回就退回正则，主循环不等')
  {
    const x = mk(() => '__hang__')
    x.talk.addrTimeoutMs = 120                  // 测试里缩短，生产 3000
    const t0 = Date.now()
    const r = await x.talk.isAddressedTo('老王', '这破地方真难找？')
    const ms = Date.now() - t0
    ok(ms < 600, `超时后 ${ms}ms 就返回了（生产上限 3000ms）`)
    ok(r.via === 'regex', '走的是正则兜底', JSON.stringify(r))
    ok(r.toMe === true, '正则兜底判「…难找？」= true（问号结尾，跟老逻辑一致）')
    ok(x.talk.addrTimeouts === 1, '记了一次超时')
    ok(x.logs.some(l => l.includes('[addr]') && l.includes('没回')), '日志写明了为什么兜底', x.logs.find(l => l.includes('没回')))
    cleanup(x.dir)
  }

  // ================================================================
  console.log('\n[4] 乱码 / 非 JSON：照样兜底，不抛异常')
  {
    const x = mk(() => '我觉得他是在跟你说话吧')
    const r = await x.talk.isAddressedTo('老王', 'XJJ 在不在')
    ok(r.via === 'regex' && r.toMe === true, '返回不是 JSON → 正则兜底（带名字 → true）', JSON.stringify(r))
    ok(x.logs.some(l => l.includes('不是 JSON')), '日志写明"返回不是 JSON"')

    const y = mk(() => { throw new Error('HTTP 500 boom') })
    const r2 = await y.talk.isAddressedTo('老王', '在哪呢')
    ok(r2.via === 'regex' && r2.toMe === false, '模型直接报错 → 正则兜底，不抛到上层', JSON.stringify(r2))
    cleanup(x.dir); cleanup(y.dir)
  }

  // ================================================================
  console.log('\n[5] 兜底口径跟 main.js 的老正则一致')
  {
    const x = mk(() => '{"toMe": false, "want": "", "urgent": 0}')
    const cases = [
      ['XJJ 在吗', true],
      ['你在干啥', true],
      ['这地方咋这么难找？', true],
      ['你在哪呢', true],      // 以"你"开头，老正则也判对
      ['在哪呢', false],       // 这句才是老正则漏的
      ['这破地方真难找', false]
    ]
    for (const [m, want] of cases) {
      ok(x.talk._regexAddressed(m) === want, `老口径 ${want ? '命中' : '放过'}：${m}`)
    }
    cleanup(x.dir)
  }

  // 计数
  const x = mk(() => '{"toMe": true, "want": "接话", "urgent": 0}')
  x.talk.history.length = 0
  await x.talk.isAddressedTo('老王', '你在哪呢')
  ok(x.talk.addrCalls === 1 && x.talk.addrModelTrue === 1, '计数：addrCalls=1 / addrModelTrue=1')
  cleanup(x.dir)

  console.log('\n===== 结果 =====')
  console.log(`${pass} 通过，${fail} 失败`)
  if (fail) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
