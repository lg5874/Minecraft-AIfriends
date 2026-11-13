'use strict'
// 两套判据一致性：main.verifyTaskEffect vs coder.verifySkillEffect。
//
// 审查报告实测（2026-11-13）：38 个真实技能 × 3 种世界状态，
// 同一份证据两边差 42%（"真挖了 2 格、背包没涨"：coder 20/38 vs main 4/38）。
// 后果不是"某趟判错"，是**同一次运行里技能记成功、任务记失败**。
//
// 现在两边都走 src/judge.js 的 judgeTask()，这个脚本就是那条线的一致性哨兵。
//
// 跑：node scripts/test-judge-consistency.js

const path = require('path')
const fs = require('fs')
const ROOT = path.join(__dirname, '..')
const { Bot } = require(path.join(ROOT, 'main.js'))
const { Coder } = require(path.join(ROOT, 'src', 'coder.js'))
const judge = require(path.join(ROOT, 'src', 'judge.js'))

function makePos (x, y, z) {
  return { x, y, z, distanceTo (p) { return Math.hypot(x - p.x, y - p.y, z - p.z) }, clone () { return makePos(x, y, z) } }
}

function mkBot (pos, blocks, inv, food = 20, held = null) {
  const map = new Map(Object.entries(blocks || {}))
  return {
    entity: { position: pos },
    heldItem: held ? { name: held } : null,
    food,
    inventory: { items: () => Object.entries(inv || {}).map(([name, count]) => ({ name, count })) },
    blockAt ({ x, y, z }) { const k = `${x},${y},${z}`; return { name: map.has(k) ? map.get(k) : 'stone' } }
  }
}

// 同一份证据分别喂给两个入口
function runBoth (skill, ev) {
  const pos0 = makePos(0, 64, 0)
  const pos1 = ev.posNow || pos0

  const botMain = mkBot(pos1, ev.blocks, ev.after, ev.foodAfter, ev.heldAfter)
  const mctx = {
    bot: botMain,
    _taskStartInv: ev.before,
    _taskStartPos: pos0,
    _taskStartWorld: judge.worldSig(mkBot(pos0, ev.blocks, ev.before), pos0),
    _taskStartHeld: ev.heldBefore || null,
    _taskStartFood: ev.foodBefore == null ? 20 : ev.foodBefore,
    snapshotInv: Bot.prototype.snapshotInv,
    worldSig: function (p) { return judge.worldSig(this.bot, p) },
    log: () => {}
  }
  if (ev.worldAfter) mctx.worldSig = () => ev.worldAfter

  const mainRes = Bot.prototype.verifyTaskEffect.call(mctx, skill.desc, '')

  const botCoder = mkBot(pos1, ev.blocks, ev.after, ev.foodAfter, ev.heldAfter)
  const cctx = {
    bot: botCoder,
    actions: { pos: () => pos1 },
    snapshotInv: Coder.prototype.snapshotInv,
    worldSig: function (p) { return judge.worldSig(this.bot, p) },
    _skillHeld: ev.heldBefore || null,
    _skillFood: ev.foodBefore == null ? 20 : ev.foodBefore
  }
  const wa = ev.worldAfter || judge.worldSig(botCoder, pos0)
  cctx.worldSig = () => wa
  const coderRes = Coder.prototype.verifySkillEffect.call(
    cctx, skill.desc, { desc: skill.desc }, ev.before, pos0, { ok: true, output: '' },
    judge.worldSig(mkBot(pos0, ev.blocks, ev.before), pos0)
  )

  return { main: mainRes, coder: coderRes }
}

// 三种世界状态（审查报告用的那三种）
const STATES = {
  S1_什么都没变: () => ({
    before: { cobblestone: 20, stick: 4 },
    after: { cobblestone: 20, stick: 4 }
  }),
  S2_真挖了2格背包没涨: () => ({
    before: { cobblestone: 20 },
    after: { cobblestone: 20 },
    worldBefore: { '0,64,0': 'stone', '1,64,0': 'stone', '2,64,0': 'stone' },
    worldAfter: { '0,64,0': 'air', '1,64,0': 'air', '2,64,0': 'stone' }
  }),
  S3_背包加3: () => ({
    before: { cobblestone: 20, stick: 4 },
    after: { cobblestone: 23, stick: 4 }
  })
}

function main () {
  const file = path.join(ROOT, 'data', 'runtime', 'skills.json')
  let skills = []
  try {
    skills = JSON.parse(fs.readFileSync(file, 'utf8')).skills || []
  } catch (e) {
    console.log('读不到技能库：' + e.message)
    process.exit(1)
  }

  let same = 0
  let diff = 0
  const diffs = []
  const per = {}

  for (const [sname, gen] of Object.entries(STATES)) {
    per[sname] = { same: 0, diff: 0, mainOk: 0, coderOk: 0 }
    for (const sk of skills) {
      const ev = gen()
      const r = runBoth(sk, ev)
      const agree = r.main.ok === r.coder.ok
      per[sname].mainOk += r.main.ok ? 1 : 0
      per[sname].coderOk += r.coder.ok ? 1 : 0
      if (agree) { same++; per[sname].same++ } else {
        diff++
        per[sname].diff++
        diffs.push({
          state: sname, skill: sk.name, desc: sk.desc,
          main: { ok: r.main.ok, why: r.main.why.slice(0, 70) },
          coder: { ok: r.coder.ok, why: r.coder.why.slice(0, 70) }
        })
      }
    }
  }

  const total = same + diff
  const rate = total ? (same / total * 100) : 100

  console.log(`技能 ${skills.length} 条 × ${Object.keys(STATES).length} 种世界状态 = ${total} 组`)
  for (const [k, v] of Object.entries(per)) {
    console.log(`  ${k}: 一致 ${v.same}/${v.same + v.diff}｜main 判成 ${v.mainOk}｜coder 判成 ${v.coderOk}`)
  }
  console.log(`\n一致率: ${rate.toFixed(1)}%   （审查基线 58%，目标 >95%）`)
  if (diffs.length) {
    console.log('\n不一致明细（最多 8 条）：')
    for (const d of diffs.slice(0, 8)) {
      console.log(`  ${d.state}｜${d.skill}｜${String(d.desc).slice(0, 24)}`)
      console.log(`     main  : ${d.main.ok ? '成' : '败'} ${d.main.why}`)
      console.log(`     coder : ${d.coder.ok ? '成' : '败'} ${d.coder.why}`)
    }
  }
  process.exit(rate >= 95 ? 0 : 1)
}

main()
