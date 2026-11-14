#!/usr/bin/env node
'use strict'
/**
 * will 新形态验收：模型在环路里 + 规则有否决权。
 *
 * 三个场景：
 *   A 真实模型 · 地表有树没工具   -> 看它选什么、为什么（证明"模型在选"）
 *   B 真实模型 · 地下 y=47 血8 没镐 -> 看它会不会挑不可行的，被怎么处理
 *   C 桩模型（可复现） · 故意选不可行 -> 证明"否决 → 附原因退回 → 重选通过"
 *   D 归因：喂一条 main.js 格式的失败记忆，看 attribute() 产出什么
 *
 * 只读：不连 MC、不写 config、不动 data/ 里的真实存档（假 ctx 假 memory）。
 *   node scripts/probe-will-decide.js
 */
const path = require('path')
const ROOT = path.resolve(__dirname, '..')
process.chdir(ROOT)

const Will = require('../src/will')
const { LLM } = require('../src/llm')
const cfg = require('../config.json')

const LOG = []
const log = s => { LOG.push(s); console.log(s) }

// ---------- 假环境 ----------
function fakeActions (o) {
  const pos = { x: 128, y: o.y, z: -330, offset: (dx, dy, dz) => ({ x: 128 + dx, y: o.y + dy, z: -330 + dz }) }
  return {
    status: () => ({
      pos,
      health: o.health,
      food: o.food,
      time: o.time || '白天',
      inventory: o.inv || {}
    }),
    pos: () => pos,
    bot: { blockAt: p => ({ boundingBox: (p.y - o.y) >= (o.headroom || 99) ? 'block' : 'empty' }) },
    isUnderground: () => o.underground,
    findBlock: (name) => {
      if (/log$/.test(name)) return o.trees ? { name } : null
      if (name === 'stone') return o.stone ? { name } : null
      return null
    },
    survey: () => ({ trees: o.trees ? 4 : 0, animals: o.animals == null ? 3 : o.animals, hostiles: o.hostiles || 0 }),
    scan: () => ({ blocks: {}, entities: [] })
  }
}

function fakeCtx (o) {
  return {
    log,
    cfg,
    actions: fakeActions(o),
    goals: { current: () => null },
    deaths: () => o.deaths || 0,
    deathsReset: () => { o.deaths = 0 }
  }
}

function fakeMem (entries = []) {
  return {
    entries,
    add (e) { this.entries.push({ text: e.text }); log('[mem] + ' + e.text); return e },
    lastSummary: () => null
  }
}

const fakeSkills = { catalog: () => '（略）', search: () => [], data: { skills: [] } }

// 桩 LLM：按顺序返回预先写好的对象，用来做可复现的否决测试
function stubLLM (seq) {
  let i = 0
  return {
    calls: [],
    async json (msgs, opts) {
      this.calls.push(opts && opts.maxTokens)
      const d = seq[Math.min(i++, seq.length - 1)]
      return typeof d === 'function' ? d(msgs[0].content) : d
    },
    async chat () { throw new Error('n/a') }
  }
}

const line = (t) => console.log('\n' + '='.repeat(6) + ' ' + t + ' ' + '='.repeat(6))

;(async () => {
  // ---------- A/B：真实模型 ----------
  const llm = new LLM(cfg.llm)

  line('A. 地表有树、没工具、没木头（真实模型）')
  {
    const ctx = fakeCtx({ y: 68, health: 18, food: 15, underground: false, trees: true, stone: true, inv: { dirt: 2 } })
    const w = new Will(llm, fakeMem(), fakeSkills, ctx)
    const cur = await w.think()
    console.log('→ 决定:', JSON.stringify({ action: cur.action, text: cur.text, why: cur.why, urgency: cur.urgency, source: cur.source }, null, 0))
  }

  line('B. 地下 y=47、血 8、没镐（真实模型，最容易选错）')
  {
    const ctx = fakeCtx({ y: 47, health: 8, food: 12, underground: true, headroom: 14, trees: false, stone: true, inv: { cobblestone: 6, coal: 2 }, hostiles: 2 })
    const w = new Will(llm, fakeMem(), fakeSkills, ctx)
    const cur = await w.think()
    console.log('→ 决定:', JSON.stringify({ action: cur.action, text: cur.text, why: cur.why, urgency: cur.urgency, source: cur.source }))
  }

  // ---------- C：桩模型，强制走"否决 → 重选" ----------
  line('C. 桩模型：先选不可行的（地下没镐要挖铁）')
  {
    const ctx = fakeCtx({ y: 44, health: 16, food: 14, underground: true, headroom: 9, trees: false, stone: true, inv: { dirt: 3 } })
    const stub = stubLLM([
      { action: 'iron', text: '挖点铁做把铁镐', why: '铁镐干活快', urgency: 0.7 },
      { action: 'getup', text: '先挖上去回到地面', why: '规则说地下挖不动铁，先上去', urgency: 0.6 }
    ])
    const w = new Will(stub, fakeMem(), fakeSkills, ctx)
    const cur = await w.think()
    console.log('→ 最终:', JSON.stringify({ action: cur.action, text: cur.text, source: cur.source }))
    console.log('→ 否决统计:', JSON.stringify(w.vetoStats), '| 模型调用次数:', stub.calls.length, '| maxTokens:', stub.calls.join(','))
  }

  line('C2. 桩模型：两次都不可行 -> 规则兜底')
  {
    const ctx = fakeCtx({ y: 44, health: 7, food: 14, underground: true, headroom: 9, trees: false, stone: true, inv: {} , deaths: 4 })
    const stub = stubLLM([
      { action: 'fight', text: '下去硬刚那只僵尸', why: '得清掉', urgency: 0.9 },
      { action: 'iron', text: '挖点铁', why: '想要铁', urgency: 0.8 }
    ])
    const w = new Will(stub, fakeMem(), fakeSkills, ctx)
    const cur = await w.think()
    console.log('→ 最终:', JSON.stringify({ action: cur.action, text: cur.text, source: cur.source }))
    console.log('→ 否决统计:', JSON.stringify(w.vetoStats), '| 模型调用次数:', stub.calls.length)
  }

  // ---------- D：归因 ----------
  line('D. 归因：喂一条 main.js 写法的失败记忆')
  {
    const mem = fakeMem([
      { text: '砍点树弄木头' },
      { text: '教训：砍点树弄木头 没成（找不到树，这片是沙地）' }
    ])
    const ctx = fakeCtx({ y: 68, health: 16, food: 10, underground: false, trees: false, stone: true, animals: 0, inv: {} })
    const w = new Will(llm, mem, fakeSkills, ctx)
    console.log('detectOutcome ->', JSON.stringify(w.detectOutcome('砍点树弄木头')))
    const a = await w.attribute({ task: '砍点树弄木头' })
    console.log('→ 归因:', JSON.stringify(a))
    console.log('→ lessons（只喂下次提示词）:', JSON.stringify(w.lessons))

    // 下一轮提示词里必须带上这条归因
    const p = w.buildPrompt(w.scene(ctx.actions.status()), [], null)
    const hit = /上次没成：/.test(p) && p.includes(String(a && a.cause).slice(0, 6))
    console.log('→ 下次提示词是否包含归因:', hit ? '是' : '否')
    if (!hit) console.log(p.split('\n').slice(0, 8).join('\n'))
  }

  // ---------- E：归因的时间闸（同一句话做两遍，不能拿上一次的失败当这一次） ----------
  line('E. 旧失败不能被当成这一次的结果')
  {
    const mem = fakeMem([
      { text: '教训：砍点树 没成（上一轮的旧原因）' }
    ])
    const ctx = fakeCtx({ y: 68, health: 17, food: 15, underground: false, trees: true, inv: {} })
    const w = new Will(stubLLM([{ cause: '不该被问到', next: 'x' }]), mem, fakeSkills, ctx)
    // 交出任务时记下的 mark = 1（旧失败在 mark 之前）
    console.log('mark=1 时 detectOutcome ->', JSON.stringify(w.detectOutcome('砍点树', 1)), '（应为 null）')
    console.log('mark=0 时 detectOutcome ->', JSON.stringify(w.detectOutcome('砍点树', 0)), '（应看到旧失败）')
  }

  llm.destroy && llm.destroy()
  console.log('\n日志行数:', LOG.length)
})().catch(e => { console.error('崩了:', e); process.exit(1) })
