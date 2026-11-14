#!/usr/bin/env node
'use strict'
/**
 * Prompt A/B：旧版「改写叙述」 vs 新版「自主决定」。
 *
 *   node scripts/bench-prompt-ab.js [--tries 1] [--only auto|rewrite]
 *
 * 量三个数：通过率 / 回声率 / [不说] 比例。
 *
 * 「回声」= 输出里带出了 situation 的原文（≥4 字连续片段，或汉字重合 ≥60%）。
 * 旧 prompt 把 situation 当"要改写的源文本"贴给模型，回声是它的必然产物；
 * 新 prompt 把它降级成【事实】并明说"别念出来"，同时把 [不说] 设成默认。
 *
 * 走真实 provider（读 config.json），每次都是真调用。默认每个场景各跑 1 次。
 */

const path = require('path')
const ROOT = path.resolve(__dirname, '..')
process.chdir(ROOT)

const Talk = require('../src/talk')
const { LLM } = require('../src/llm')
const persona = require('../src/persona')
const cfg = require('../config.json')

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d }
const TRIES = Number(arg('tries', '1'))
const ONLY = arg('only', '')

const CASES = [
  { name: '有人上线', sit: 'XJJ_VERIFY3 刚上线了，服务器里现在有这个人。' },
  { name: '被问在干啥', sit: '有人在公屏问「你在干啥」。' },
  { name: '损失吐槽', sit: '挖了三十次石头才弄到八块圆石，镐子快坏了。' },
  { name: '苦力怕贴脸', sit: '被苦力怕炸了一下，血从 20 掉到 12。' },
  { name: '天黑了', sit: '天黑了，外面有僵尸在叫，得找个地方待着。' },
  { name: '刚死掉', sit: '刚被骷髅射死，掉在洞里，东西还在那儿。' }
]

const STYLES = [
  { id: 'rewrite', label: '旧·改写' },
  { id: 'auto', label: '新·自主' }
]

// ---------------- mock（只为拼 prompt，不发消息） ----------------
const mem = {
  people: {}, secrets: [],
  person (n) { if (!this.people[n]) this.people[n] = { trust: 0, notes: [] }; return this.people[n] },
  remember () { return [] }, maybeRemember () {}, getSecrets () { return [] }, markTold () {}, add () {},
  peopleDigest () { return '（还不认识谁）' }, placesDigest () { return '（还没记地方）' },
  recentSession () { return '' }, lastSummary () { return null }, addSecret () {}
}
const ctx = {
  dataDir: '/tmp',
  log: () => {},
  cfg: { behavior: { chatDelayPerChar: 0, chatMinDelay: 0, chatMaxDelay: 0 } },
  busy: () => true, taskDesc: () => '先弄把木镐',
  perceive: { brief: () => '地面开阔；威胁：无；血 18/20' },
  taste: { prompt: () => '' },
  mood: { prompt: () => '', state: () => 'normal', irritation: 0, spirit: 0.5 },
  botNames: []
}
const talk = new Talk({ username: 'XJJ', chat () {} }, { chat: async () => ({ text: '[不说]' }) }, mem, ctx)

// ---------------- 判据 ----------------
const HAN = /[\u4e00-\u9fa5]/
function echoOf (out, situation) {
  const o = String(out || '')
  // 玩家 ID 不算回声（"XJJ_VERIFY3 在啊" 是打招呼，不是复述叙述）
  const src = String(situation || '').replace(/[A-Za-z0-9_]{3,}/g, '　')
  if (!o || !src) return { hit: false, ratio: 0 }
  for (let n = Math.min(8, src.length); n >= 4; n--) {
    for (let i = 0; i + n <= src.length; i++) {
      if (o.includes(src.slice(i, i + n))) return { hit: true, ratio: 1, frag: src.slice(i, i + n) }
    }
  }
  const set = new Set([...src].filter(c => HAN.test(c)))
  const chars = [...o]
  const hit = chars.filter(c => set.has(c)).length
  const ratio = chars.length ? hit / chars.length : 0
  return { hit: ratio >= 0.6, ratio: Math.round(ratio * 100) / 100 }
}

function judge (out) {
  const t = String(out || '').trim()
  if (!t) return 'empty'
  if (t.includes('[不说]')) return 'silent'
  if (Talk.isInstructionLeak(t)) return 'leak'
  if (persona.isLeak(t)) return 'leak'
  if (persona.isMachineTalk(t)) return 'program-talk'
  if (persona.isMetaLeak(t)) return 'meta'
  return 'ok'
}

// ---------------- 跑 ----------------
const llm = new LLM(cfg.llm)

async function call (style, c) {
  const msgs = talk.speakMessages(c.sit, { promptStyle: style }, '地面开阔；威胁：无；血 18/20\n你正忙着先弄把木镐，是中途停下来说话的。')
  const t0 = Date.now()
  try {
    const r = await llm.chat(msgs, { maxTokens: 160, temperature: 1.0 })
    return { out: String(r.text || '').trim(), ms: Date.now() - t0, rLen: String(r.reasoning || '').length }
  } catch (e) {
    return { out: '', ms: Date.now() - t0, rLen: 0, err: e.message }
  }
}

;(async () => {
  const prov = llm.providers[llm.activeIndex] || llm.providers[0]
  console.log(`provider: ${prov.name} ${prov.baseUrl}  模型: ${prov.model}  每格 ${TRIES} 次`)
  console.log(`reasoning_effort: ${(llm._once && 'low（llm.js 已钉死）') || ''}\n`)

  const sum = {}
  for (const st of STYLES) {
    if (ONLY && ONLY !== st.id) continue
    sum[st.id] = { ok: 0, silent: 0, leak: 0, echo: 0, n: 0, ms: [], len: [], r: [] }
    console.log(`—— ${st.label}（${st.id}）——`)
    for (const c of CASES) {
      for (let i = 0; i < TRIES; i++) {
        const r = await call(st.id, c)
        const kind = judge(r.out)
        const echo = echoOf(r.out, c.sit)
        const s = sum[st.id]
        s.n++
        if (kind === 'ok') s.ok++
        if (kind === 'silent') s.silent++
        if (kind === 'leak' || kind === 'meta' || kind === 'program-talk') s.leak++
        if (kind === 'ok' && echo.hit) s.echo++
        s.ms.push(r.ms); s.len.push(r.out.length); s.r.push(r.rLen)
        console.log(`  ${c.name.padEnd(10)} ${kind.padEnd(12)} 回声=${echo.hit ? 'Y(' + echo.ratio + ')' : 'n(' + echo.ratio + ')'} ` +
          `${String(r.ms).padStart(5)}ms ${String(r.out.length).padStart(2)}字 思考${String(r.rLen).padStart(3)}字 ${JSON.stringify(r.out.slice(0, 28))}${r.err ? ' ERR ' + r.err.slice(0, 40) : ''}`)
      }
    }
    console.log('')
  }

  console.log('='.repeat(76))
  console.log('版本'.padEnd(12) + '说了'.padEnd(8) + '其中干净'.padEnd(10) + '回声率'.padEnd(9) + '[不说]'.padEnd(9) + '被拦'.padEnd(8) + '平均长度  平均思考')
  for (const st of STYLES) {
    const s = sum[st.id]
    if (!s || !s.n) continue
    const pct = (x) => Math.round(x / s.n * 100) + '%'
    const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0)
    console.log(st.label.padEnd(12) + pct(s.n - s.silent).padEnd(8) + pct(s.ok).padEnd(10) +
      pct(s.echo).padEnd(9) + pct(s.silent).padEnd(9) + pct(s.leak).padEnd(8) +
      (avg(s.len) + '字').padEnd(10) + avg(s.r) + '字')
  }
  console.log('\n「说了」= 开口的比例（现场目标 30~50%）；「干净」= 说了且没被今晚那套判据拦')
  console.log('\n通过 = 有内容且没被判据拦；回声 = 复述了 situation 原文；[不说] 单独一列（新版应该明显更高）')
})().catch(e => { console.error(e); process.exit(1) })
