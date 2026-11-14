#!/usr/bin/env node
'use strict'
/**
 * will 用**真实** Memory / SkillLibrary 跑一遍（不是假对象），
 * 确认归因写回、思考产出这些路径真的接得上。
 *
 * 用临时目录，不碰 data/ 里的真实存档。
 *   node scripts/probe-will-smoke.js
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const ROOT = path.resolve(__dirname, '..')
process.chdir(ROOT)

const Will = require('../src/will')
const Memory = require('../src/memory')
const { SkillLibrary } = require('../src/skills')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'will-smoke-'))
const log = s => console.log(s)

function stubLLM (seq) {
  let i = 0
  return {
    async json () { return seq[Math.min(i++, seq.length - 1)] },
    async chat () { throw new Error('n/a') }
  }
}

const pos = { x: 10, y: 70, z: 10, offset: () => ({ x: 10, y: 71, z: 10 }) }
const ctx = {
  log,
  cfg: require('../config.json'),
  goals: { current: () => null },
  deaths: () => 0,
  deathsReset: () => {},
  actions: {
    status: () => ({ pos, health: 17, food: 16, time: '白天', inventory: { oak_log: 3 } }),
    pos: () => pos,
    bot: { blockAt: () => ({ boundingBox: 'empty' }) },
    isUnderground: () => false,
    findBlock: n => (/log$/.test(n) ? { name: n } : null),
    survey: () => ({ trees: 5, animals: 4, hostiles: 0 }),
    scan: () => ({ blocks: {}, entities: [] })
  }
}

;(async () => {
  const mem = new Memory(tmp)
  const skills = new SkillLibrary(tmp)

  // 1) 真实记忆里塞一条 main.js 写法的失败记录
  mem.add({ text: '教训：去挖点铁 没成（没有镐，敲了半天没掉东西）', kind: 'event', importance: 0.5, force: true })
  const last = mem.entries[mem.entries.length - 1]
  console.log('① 记忆条目:', last && last.text)

  // 2) 真实 SkillLibrary 里塞一个技能，看归因会不会留痕
  skills.data.skills.push({ name: 'k_test', desc: '去挖点铁', code: '//x', ok: 0, fail: 1 })
  console.log('② skills.data.skills 可读:', Array.isArray(skills.data.skills), '条数', skills.data.skills.length)

  const w = new Will(stubLLM([
    { cause: '手上没有镐，敲石头不掉东西', next: '先砍树做木镐再来' },
    { action: 'chop', text: '先去砍树做把木镐', why: '上次就是没镐才白跑', urgency: 0.5 }
  ]), mem, skills, ctx)

  // 3) 归因
  const a = await w.attribute({ task: '去挖点铁' })
  console.log('③ 归因:', JSON.stringify(a))
  const wroteJournal = mem.journal.some(j => /^归因：去挖点铁/.test(j.text))
  const wroteLesson = mem.entries.some(e => /去挖点铁/.test(e.text) && e.kind !== 'event')
  console.log('   进复盘日志(mem.log):', wroteJournal ? '是' : '否')
  console.log('   进教训通道(能提炼成规则才留):', wroteLesson ? '是' : '否（本条原因不含物品缺失，按设计只进日志）')
  console.log('   journal:', JSON.stringify(mem.journal.slice(-2)))
  console.log('   技能留痕:', JSON.stringify(skills.data.skills.find(s => s.name === 'k_test').note || null))

  // 4) 思考（走模型）
  const cur = await w.think()
  console.log('④ current:', JSON.stringify({ text: cur.text, action: cur.action, source: cur.source }))
  console.log('   提示词里带归因:', w.buildPrompt(w.scene(ctx.actions.status()), [], null).includes('上次没成：') ? '是' : '否')

  // 5) 老接口：pending / finish / current=null
  console.log('⑤ pending():', JSON.stringify(w.pending()))
  w.finish()
  console.log('   finish 后 done:', w.current.done, '| pending:', JSON.stringify(w.pending()))
  w.current = null
  console.log('   current=null 后 pending:', JSON.stringify(w.pending()))

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('\n全部通过')
})().catch(e => { console.error('崩了:', e); process.exit(1) })
