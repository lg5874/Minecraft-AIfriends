'use strict'
// 把"跑满过超时"的老技能标脏下线。
//
// 参谋的证据（2026-11-13）：那个技能 8 次成功的耗时是双峰分布
//   5s / 16s / 131s / 233s / 311s / 312s / 394s / 407s
// 双峰 = 它只有成功出口，没有失败出口。找到就退出，没找到就空转，
// 直到外部把 420 秒超时掐死。这种代码留着就会被反复复用。
//
// 处理方式：**不改它的代码**，只打标记 dirty=true + 原因，
// 让 pickFor 选不到它（src/skills.js 里已过滤掉 dirty）。
//
// 用法：
//   node scripts/mark-dirty-skills.js            # 只报告
//   node scripts/mark-dirty-skills.js --fix      # 写回

const path = require('path')
const { SkillLibrary } = require(path.join(__dirname, '..', 'src', 'skills.js'))
const { hasNoProgressExit } = require(path.join(__dirname, '..', 'src', 'coder.js'))

const FIX = process.argv.includes('--fix')
// 超时门槛：配置里 taskTimeoutSeconds 默认 420
const TIMEOUT_MS = (() => {
  try {
    const cfg = require(path.join(__dirname, '..', 'config.json'))
    return (cfg.behavior && cfg.behavior.taskTimeoutSeconds ? cfg.behavior.taskTimeoutSeconds : 420) * 1000
  } catch (e) { return 420000 }
})()

function main () {
  const lib = new SkillLibrary(path.join(__dirname, '..', 'data', 'runtime'))
  try { lib.load() } catch (e) {}
  const all = lib.all()

  const slow = []
  const noExit = []
  for (const s of all) {
    const runs = Array.isArray(s.runs) ? s.runs : []
    const maxMs = runs.reduce((a, r) => Math.max(a, r.ms || 0), 0)
    if (maxMs >= TIMEOUT_MS * 0.95) slow.push({ s, maxMs, runs: runs.length })
    if (!hasNoProgressExit(s.code)) noExit.push(s)
  }

  console.log(`技能总数              : ${all.length}`)
  console.log(`跑满过超时(>=${Math.round(TIMEOUT_MS / 1000 * 0.95)}s)  : ${slow.length}`)
  console.log(`代码里没有无进展出口  : ${noExit.length}`)
  for (const x of slow.slice(0, 10)) {
    console.log(`  慢: ${x.s.name} 最长 ${Math.round(x.maxMs / 1000)}s（${x.runs} 次记录）｜${String(x.s.desc).slice(0, 26)}`)
  }
  for (const s of noExit.slice(0, 10)) {
    console.log(`  无出口: ${s.name}｜${String(s.desc).slice(0, 26)}`)
  }

  if (FIX) {
    let n = 0
    for (const x of slow) {
      if (!x.s.dirty) { x.s.dirty = true; x.s.dirtyReason = `跑满过 ${Math.round(x.maxMs / 1000)}s 超时`; n++ }
    }
    // 没有无进展出口、而且已经测过（有失败记录）的也没必要再选
    for (const s of noExit) {
      if (!s.dirty && (s.fail || 0) > 0) {
        s.dirty = true
        s.dirtyReason = '代码里没有"没进展就退出"的计数'
        n++
      }
    }
    lib.save()
    console.log(`\n标脏 ${n} 条（不改代码，只是不再被选中）`)
  }

  process.exit(0)
}

main()
