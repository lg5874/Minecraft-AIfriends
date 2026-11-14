#!/usr/bin/env node
'use strict'
/**
 * 记忆：旧检索（5 条碎片） vs 新日记（一段话）—— 真跑，不是编。
 *
 * 1. 把 data/runtime 拷一份到 /tmp（不动生产数据）
 * 2. 用真 Memory 读进来，先跑旧的 remember(..., {limit:5})，贴它给的 5 条
 * 3. 再跑 writeDiary()：把这一小时的事整段交给真 LLM，写一段日记
 * 4. 报 token（输入/输出）
 *
 * 跑：node scripts/mem-diary-demo.js
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'data', 'runtime')
const DST = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-diary-'))

function copyDir (from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const f of fs.readdirSync(from)) {
    const a = path.join(from, f)
    const b = path.join(to, f)
    const st = fs.statSync(a)
    if (st.isFile()) fs.copyFileSync(a, b)
  }
}

async function main () {
  copyDir(SRC, DST)
  const Memory = require('../src/memory')
  const { LLM } = require('../src/llm')
  const recall = require('../src/memory/recall')
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, process.env.AIFRIEND_CONFIG || 'config.json'), 'utf8'))

  const mem = new Memory(DST)
  // --tempt：造一个"有人在旁边但没有任何互动事件"的小时，专门看模型会不会编"他救了我"
  const TEMPT = process.argv.includes('--tempt')
  if (TEMPT) {
    const t0 = mem.clock.now()
    for (let i = 0; i < 6; i++) mem.journal.push({ t: t0 - 9 + i, text: `第 ${i + 1} 件事：挖矿没成，血少了点`, why: 'task' })
    mem.person('Xylitol6983')
    mem.people['Xylitol6983'].lastSeen = t0 - 2
  }
  const now = mem.clock.now()
  console.log(`记忆条数 ${mem.entries.length} ｜ 游戏时钟 ${Math.round(now)} 分钟 ｜ 窗口 ${Math.round(now - 60)}~${Math.round(now)}`)

  // ---------- 旧：关键词检索取 5 条（绕过新下限，看改之前他"想起"的是什么） ----------
  const situation = '天快黑了，得先回家把东西放进箱子'
  const old = recall.search(mem.entries, { text: situation, people: [], near: null, places: mem.places }, 5, now)
  console.log(`\n【旧检索】关键词取 5 条（改之前的 remember）→ ${old.length} 条`)
  old.forEach((e, i) => console.log(`  ${i + 1}. [${e.kind}] ${e.text}`))

  // ---------- 现在：下限 20 ----------
  const now20 = mem.remember(situation, { limit: 5 })
  console.log(`\n【现在的 remember】同一个 query，传 limit:5 → 实际 ${now20.length} 条（新下限）`)

  // ---------- 新：把这一小时揉成一段 ----------
  const lines = mem.hourLines(now - 60, now)
  console.log(`\n【这一小时的事】${lines.length} 行`)
  lines.slice(0, 12).forEach(l => console.log('  ' + l))
  if (lines.length > 12) console.log(`  …（还有 ${lines.length - 12} 行）`)

  const llm = new LLM(cfg.llm, (s) => console.log('  [llm] ' + s))
  const d = await mem.writeDiary({ llm, force: true })
  if (d) {
    console.log(`\n【闸门】首检 ${JSON.stringify(d.firstCheck || '无')} ｜ 重写 ${d.rewrote ? '是' : '否'} ｜ 终检 ${JSON.stringify(d.selfCheck)} ｜ 进记忆 ${d.clean ? '是' : '否（有编造嫌疑）'}`)
  }
  console.log('\n【新日记】')
  console.log(d ? '  ' + d.text : '  （没写成）')
  if (d) {
    console.log(`\n【token】输入 ${d.promptTokens} ｜ 输出 ${d.completionTokens} ｜ 料 ${d.lines} 行`)
  }

  // 日记进没进长期记忆
  const diar = mem.entries.filter(e => e.text === (d && d.text))
  console.log(`【落账】日记条目已进 entries：${diar.length ? '是（importance ' + diar[0].importance + '）' : '否'}`)
  console.log(`【持久化】diaries 共 ${mem.diaries.length} 篇，文件 ${path.join(DST, 'memory.json')}`)
}

main().catch(e => { console.error('崩了：' + (e && e.stack || e)); process.exit(1) })
