#!/usr/bin/env node
'use strict'
/**
 * 「白干了一趟 → 记账 → 写进记忆 → 说出口」离线端到端。
 *
 * 不连服务器、不调模型：真 Cost + 真 Memory + 真 Spontaneity，
 * 用假 talk 代替 LLM 那一步。验的是这条链本身有没有断：
 *
 *   1. settle() 结出一笔账（verdict = white/bitter，不是 short）
 *   2. 账上有那句「记住这回：…」（memory.json 会存的就是它）
 *   3. memory.entries 里真的多了一条 kind=skill/grievance 的损失记忆
 *   4. spontaneous 的 loss 触发把它排进队列，素材里没有「记住这回」
 *   5. 说出口之后 spokenAt 落盘，同一笔不再排（不会反复念）
 *
 * 跑：node scripts/test-loss-chain.js
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const { Cost } = require('../src/cost')
const Memory = require('../src/memory')
const spontaneous = require('../src/spontaneous')

let pass = 0
let fail = 0
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}

// spontaneous 直接读 Date.now()（没做注入），冻住时钟好测节奏
const T = 1800000000000
let CLOCK = T
Date.now = () => CLOCK

const MIN = 60000

function tmpDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loss-chain-'))
}

async function main () {
  const dir = tmpDir()
  const mem = new Memory(dir)
  const cost = new Cost(dir, { mem, now: () => CLOCK })
  cost.attach(null)

  // 造一个"跑了 5 分钟、搭进去八根木棍、死了两回、跑得老远"的目标
  const goal = {
    key: 'wood',
    title: '去北边砍树，弄到八根木棍就回',
    createdAt: CLOCK - 5 * MIN,
    stages: [{ title: '走过去砍树', base: { pos: { x: 100, y: 64, z: 100 } } }],
    stageIndex: 0
  }
  const bill = cost.settle(goal, {
    ms: 5 * MIN,
    distance: 420,
    gained: [{ item: 'stick', n: 8 }],
    spent: [],
    deaths: 2,
    reason: '砍完树回不来，路上死了两回',
    pos: { x: 210, y: 64, z: 300 }
  })

  console.log('\n[1] 结账')
  ok(!!bill, 'settle 返回了账单')
  ok(bill.verdict === 'white' || bill.verdict === 'bitter',
    `verdict 是亏的（实际 ${bill.verdict}）`)
  ok(/记住这回/.test(bill.memText), '账上有「记住这回」这句记忆')
  console.log('    memText: ' + bill.memText)
  ok(cost.losses.length === 1, '账本里多了一笔')
  ok(cost.losses[0].spokenAt === null, '刚记的账还没说过')

  console.log('\n[2] 写进记忆')
  // rememberLoss 走的是 Memory.add，落盘后重新读一遍才算数
  const mem2 = new Memory(dir)
  const hits = mem2.entries.filter(e => /记住这回/.test(e.text))
  ok(hits.length === 1, `memory.json 里有 1 条损失记忆（实际 ${hits.length}）`)
  ok(hits[0] && (hits[0].kind === 'skill' || hits[0].kind === 'grievance'),
    `记忆类型是 skill/grievance（实际 ${hits[0] && hits[0].kind}）`)
  console.log('    记忆: ' + (hits[0] && hits[0].text))

  console.log('\n[3] 触发：素材进提示词，不是台词')
  const said = []
  const S = new spontaneous.Spontaneity({
    log: () => {},
    busy: () => false,
    mem: mem2
  })
  const talk = {
    async speak (situation, opts) { said.push({ situation, opts }); return true }
  }
  const ev = S._maybeQueueLoss()
  ok(!!ev, '损失触发放了一条事件')
  ok(ev && ev.trigger === 'loss', 'trigger=loss')
  ok(ev && !/记住这回/.test(ev.situation), '素材里没有「记住这回」')
  ok(ev && /八根木棍/.test(ev.situation), '素材带着真实损失（八根木棍）')
  ok(ev && /两回/.test(ev.situation), '素材带着死了两回')
  console.log('    situation: ' + (ev && ev.situation))

  console.log('\n[4] 说出口')
  await S.tick(talk)
  ok(said.length === 1, '说了一次')
  ok(cost.losses[0].spokenAt === T, '说出口之后 spokenAt 才落')
  ok(S._maybeQueueLoss() === null, '同一笔账不会再排第二次')

  console.log('\n[5] 冷却：10 分钟内不翻第二笔旧账')
  const goal2 = {
    key: 'iron',
    title: '挖一趟铁就上来',
    createdAt: CLOCK - 4 * MIN,
    stages: [{ title: '先弄把石镐', base: { pos: { x: 0, y: 64, z: 0 } } }],
    stageIndex: 0
  }
  cost.settle(goal2, { ms: 4 * MIN, distance: 80, gained: [], spent: [], deaths: 1, pos: { x: 0, y: 64, z: 90 } })
  ok(cost.losses.length === 2, '第二笔账记上了')
  ok(S._maybeQueueLoss() === null, '刚说完 10 分钟内不再翻旧账（cost.speakCooldownMs）')

  // 冷却过了，而且第二笔是新鲜的（speakMaxAgeMs = 8 分钟，旧账不许翻）
  CLOCK += 11 * MIN
  const goal3 = {
    key: 'stone',
    title: '下去挖点石头',
    createdAt: CLOCK - 4 * MIN,
    stages: [{ title: '找矿洞', base: { pos: { x: 0, y: 64, z: 0 } } }],
    stageIndex: 0
  }
  cost.settle(goal3, { ms: 4 * MIN, distance: 30, gained: [], spent: [], deaths: 2, pos: { x: 0, y: 64, z: 40 } })
  const ev2 = S._maybeQueueLoss()
  ok(!!ev2, '过了冷却 + 新鲜账，第二笔就能说了')

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过，${fail} 失败\n`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => {
  console.error('崩了：' + (e && e.stack || e))
  process.exit(1)
})
