#!/usr/bin/env node
'use strict'
/**
 * 主题级复读回归（2026-11-13 用户实机截图）。
 *
 *   node scripts/test-theme-repeat.js
 *
 * 截图现场（10 句里 6 句是同一批意思）：
 *   一转眼就没影了 → 眨眼就没影了
 *   那我睡了啊     → 是该睡了 → 我躺了
 *   你自己弄吧     → 你那边自己搞定
 *
 * 病根不是"没接住"，是**每句都成功接住，然后拿同一个意思反复说**。
 * 字面去重抓不到（睡了/躺了/该睡了 字面全不同），所以加了 topicRepeat()：
 * 同一社交主题在最近三句里出现 ≥2 次 → 这一句不许再说。
 *
 * 全 mock，不连服务器、不调模型。
 */

const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const Talk = require(path.join(ROOT, 'src', 'talk'))

let pass = 0
let fail = 0
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) } else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')) }
}

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcai-theme-'))

function mkMem () {
  return {
    people: {},
    secrets: [],
    person (n) { if (!this.people[n]) this.people[n] = { trust: 0, notes: [] }; return this.people[n] },
    remember () { return [] },
    maybeRemember () { return null },
    getSecrets () { return [] },
    markTold () {},
    add () {},
    peopleDigest () { return '' },
    placesDigest () { return '' },
    recentSession () { return '' },
    lastSummary () { return null },
    addSecret () { return null }
  }
}

function mkLLM (lines) {
  const q = lines.slice()
  return {
    calls: [],
    async chat (msgs) { this.calls.push(msgs); return { text: q.length ? q.shift() : '[不说]' } }
  }
}

function mkCtx (dir) {
  return {
    dataDir: dir,
    log: () => {},
    cfg: { behavior: { chatDelayPerChar: 0, chatMinDelay: 0, chatMaxDelay: 1 } },
    busy: () => false,
    taskDesc: () => '',
    perceive: { brief: () => '' },
    taste: { prompt: () => '' },
    mood: { prompt: () => '', state: () => 'normal', irritation: 0, spirit: 0.5 },
    botNames: []
  }
}

function mkTalk (lines) {
  const sent = []
  const bot = { username: 'XJJ', chat (t) { sent.push(t) } }
  const talk = new Talk(bot, mkLLM(lines), mkMem(), mkCtx(mkDir()))
  talk.sayGapMs = 0
  talk.fastSayGapMs = 0
  talk.sayWindowMax = 1e9
  talk.sayWindow = []
  return { talk, sent }
}

async function main () {
  // ============================================================
  // 1. 截图那段对话：同一主题说到第三句必须被拦
  // ============================================================
  console.log('\n[1] 截图回归：同一个意思说三遍')
  {
    const { talk, sent } = mkTalk([
      '嗯 是该睡了',
      '哦 那我去躺了',
      '行 睡吧',
      '嗯 眨眼就没影了',
      '嗯 眨眼就没了',
      '嗯 一转眼就没影'
    ])
    const incoming = [
      '那我睡了啊 别喊我',
      '都几点了 撑不住就下线睡呗',
      '你睡不睡啊',
      '人呢 一转眼就没影了',
      '刚还在的',
      '怎么又没影了'
    ]
    for (let i = 0; i < incoming.length; i++) await talk.reply('Xylitol6983', incoming[i])
    const sleepSaid = sent.filter(t => /睡|躺/.test(t))
    const vanishSaid = sent.filter(t => /没影|眨眼|一转眼/.test(t))
    ok(sleepSaid.length === 2, '睡眠主题最多连着两句', JSON.stringify(sleepSaid))
    ok(vanishSaid.length === 2, '没影主题最多连着两句', JSON.stringify(vanishSaid))
    ok(sent.length === 4, '六句候选里只发出去四句', `实际 ${sent.length}: ${JSON.stringify(sent)}`)
  }

  // ============================================================
  // 2. 任务主题不能误伤（挖矿反复说是正常的）
  // ============================================================
  console.log('\n[2] 不误伤：任务主题反复出现是正常的')
  {
    const { talk, sent } = mkTalk([
      '挖了半天就几块圆的',
      '这地方石头多矿少',
      '再往下挖挖看'
    ])
    for (const m of ['挖到啥了', '还有矿吗', '继续挖不']) await talk.reply('Xylitol6983', m)
    ok(sent.length === 3, '三句都在说挖矿，全部放行', JSON.stringify(sent))
  }

  // ============================================================
  // 3. fatigueHint：主题耗尽 + 连续接话时给出明令
  // ============================================================
  console.log('\n[3] fatigueHint 的两条新指令')
  {
    const { talk } = mkTalk([])
    talk.recentSaid = [
      { text: '嗯 是该睡了', at: Date.now(), kind: 'short' },
      { text: '你那边自己搞定', at: Date.now(), kind: 'short' },
      { text: '哦 那我去躺了', at: Date.now(), kind: 'short' }
    ]
    const h = talk.fatigueHint()
    ok(/不许再碰这个话题/.test(h), '主题耗尽时明令禁止再碰')
    ok(/睡觉/.test(h), '点名了具体主题（睡觉/下线）')
  }
  {
    const { talk } = mkTalk([])
    talk.recentSaid = [
      { text: '坑大发了', at: Date.now(), kind: 'short' },
      { text: '不去', at: Date.now(), kind: 'short' },
      { text: '北边有啥', at: Date.now(), kind: 'short' }
    ]
    talk.recentModes = ['reach', 'reach', 'reach']
    const h = talk.fatigueHint()
    ok(/必须/.test(h) && /自己的事/.test(h), '连着三句接话后，强制这一句岔开')
  }

  // ============================================================
  // 4. noteMode：接住 vs 说自己的
  // ============================================================
  console.log('\n[4] noteMode 记账')
  {
    const { talk } = mkTalk([])
    talk.noteMode('眨眼就没影了', '人呢 一转眼就没影了')
    ok(talk.recentModes[talk.recentModes.length - 1] === 'reach', '共用词 → reach')
    talk.noteMode('我这手是真不行', '你觉得我菜吗')
    ok(talk.recentModes[talk.recentModes.length - 1] === 'dodge', '没共用内容 → dodge')
  }

  console.log(`\n===== 结果 =====\n${pass} 通过，${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
