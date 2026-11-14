#!/usr/bin/env node
'use strict'
/**
 * 时间感（2026-11-14）。
 *
 *   node scripts/test-time-sense.js
 *
 * memory 里的 firstSeen/lastSeen 是游戏分钟，跨重启算不出"3 天前"。
 * talk.js 另存一份现实时间戳（dataDir/talk-presence.json），
 * 再把「现在几点/上次上线/某人多久没说话」作为**事实**塞进 prompt。
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

const mem = () => ({
  people: {}, secrets: [],
  person (n) { if (!this.people[n]) this.people[n] = {}; return this.people[n] },
  remember () { return [] }, maybeRemember () {}, getSecrets () { return [] }, markTold () {}, add () {},
  peopleDigest () { return '' }, placesDigest () { return '' }, recentSession () { return '' },
  lastSummary () { return null }, addSecret () {}
})
const mk = (dir) => new Talk(
  { username: 'XJJ', chat () {} },
  { chat: async () => ({ text: '[不说]' }) },
  mem(),
  { dataDir: dir, log: () => {}, cfg: { behavior: { chatDelayPerChar: 0, chatMinDelay: 0, chatMaxDelay: 0 } }, busy: () => false, taskDesc: () => '', perceive: { brief: () => '' }, taste: { prompt: () => '' }, mood: { prompt: () => '', state: () => 'normal', irritation: 0, spirit: 0.5 }, botNames: [] }
)

async function main () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'time-sense-'))

  console.log('\n[1] 第一次来：只剩"现在几点"和"第一次"')
  {
    const t = mk(dir)
    const facts = t.timeFacts({ people: ['老王'] })
    ok(/现在是 \d+ 月 \d+ 号 周[一二三四五六日]/.test(facts[0]), '有具体日期 + 星期 + 时段', facts[0])
    ok(facts.some(x => x.includes('第一次来这个服')), '第一次上线说"第一次"')
    ok(fs.existsSync(path.join(dir, 'talk-presence.json')), '侧车文件落在 dataDir 里')
  }

  console.log('\n[2] 跨重启：3 天前上线 + 老王 3 天前说过话')
  {
    const file = path.join(dir, 'talk-presence.json')
    const threeDays = Date.now() - 3 * 86400000
    fs.writeFileSync(file, JSON.stringify({ lastOnlineAt: threeDays, people: { 老王: threeDays, 小李: Date.now() - 30 * 60000 } }))
    const t = mk(dir)
    const facts = t.timeFacts({ people: ['老王', '小李'] })
    ok(facts.some(x => /上一次在这个服里是3 天前/.test(x)), '上一次上线 = 3 天前', facts.find(x => x.includes('上一次')))
    ok(facts.some(x => /老王 上次跟你说话是3 天前/.test(x)), '老王 3 天没说话了', facts.find(x => x.includes('老王')))
    ok(facts.some(x => /小李 上次跟你说话是30 分钟前/.test(x)), '小李 30 分钟前', facts.find(x => x.includes('小李')))
  }

  console.log('\n[3] 昨天下午要说成"昨天下午"')
  {
    const file = path.join(dir, 'talk-presence.json')
    const y = new Date(); y.setDate(y.getDate() - 1); y.setHours(15, 20, 0, 0)
    fs.writeFileSync(file, JSON.stringify({ lastOnlineAt: y.getTime(), people: {} }))
    const t = mk(dir)
    const facts = t.timeFacts({})
    ok(facts.some(x => x.includes('昨天下午')), '昨天 15:20 → 昨天下午', facts.find(x => x.includes('昨天')))
  }

  console.log('\n[4] prompt 里真的带上了【时间】段')
  {
    const t = mk(dir)
    t.history.push({ who: '老王', msg: '你在干啥' })
    const txt = t.speakMessages('老王 刚上线', { people: ['老王'] }).map(m => m.content).join('\n')
    ok(txt.includes('【时间】（事实，别念出来）'), '有【时间】标题')
    ok(/现在是 \d+ 月 \d+ 号/.test(txt), '有时间事实')
    ok(txt.includes('别主动报时'), '带了"别主动报时"的约束（不然会变成报时器）')
    ok(txt.indexOf('【时间】') < txt.indexOf('【刚才发生了什么】'), '时间在前、事件在后')
  }

  console.log('\n[5] 侧车只留最近 200 人')
  {
    const t = mk(dir)
    for (let i = 0; i < 260; i++) t._presence.people['p' + i] = Date.now() - i * 1000
    t._notePresence('新来的')
    ok(Object.keys(t._presence.people).length <= 201, `人数被截到 ${Object.keys(t._presence.people).length}`)
  }

  fs.rmSync(dir, { recursive: true, force: true })
  console.log('\n===== 结果 =====')
  console.log(`${pass} 通过，${fail} 失败`)
  if (fail) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
