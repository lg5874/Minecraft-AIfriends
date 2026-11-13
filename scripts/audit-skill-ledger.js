'use strict'
// 技能账本体检：有没有"复用了但没留下判定"的技能。
//
// 哨兵审计（HEAD 80f9302）：
//   任务级成功率 98%（351/359），技能级只有 36%（20/55）；
//   有的技能 uses=54、runs 20/20，但 ok=0 fail=0
//   —— 四个大技能各有 34–54 次复用根本没有判定记录。
//
// 根因：早期版本只数 uses，后来才记 ok/fail，两个账本从某时间点起对不上。
// 修法见 src/skills.js 的 reconcileUses()：差额记进 legacyUses，
// uses 只表示"有判定记录的复用"，于是恒等式
//   uses === ok + fail + Σretired
// 成立。
//
// 用法：
//   node scripts/audit-skill-ledger.js          # 只报告
//   node scripts/audit-skill-ledger.js --fix    # 顺手对账（会写回）

const path = require('path')
const { SkillLibrary } = require(path.join(__dirname, '..', 'src', 'skills.js'))

const FIX = process.argv.includes('--fix')

function main () {
  const lib = new SkillLibrary(path.join(__dirname, '..', 'data', 'runtime'))
  if (typeof lib.load === 'function') {
    try { lib.load() } catch (e) {}
  }
  const all = lib.all()

  const unaccounted = []
  const mismatch = []
  let legacy = 0
  for (const s of all) {
    lib.migrate(s)
    legacy += s.legacyUses || 0
    const recorded = (s.ok || 0) + (s.fail || 0)
    const retired = (s.retired || []).reduce((a, r) => a + (r.ok || 0) + (r.fail || 0), 0)
    if ((s.uses || 0) > 0 && recorded + retired === 0) {
      unaccounted.push({ name: s.name, desc: s.desc, uses: s.uses, legacy: s.legacyUses || 0 })
    }
    if ((s.uses || 0) !== recorded + retired) {
      mismatch.push({ name: s.name, uses: s.uses, ok: s.ok, fail: s.fail, retired })
    }
    // 第三方账本：runs 明细不能多于 ok+fail（换版时明细要跟着归档）
    const runsLen = (s.runs || []).length
    if (runsLen > recorded) {
      mismatch.push({ name: s.name, runs: runsLen, ok: s.ok, fail: s.fail, why: 'runs 比 ok+fail 多' })
    }
  }

  console.log(`技能总数              : ${all.length}`)
  console.log(`uses>0 且 ok+fail=0   : ${unaccounted.length}   ← 目标 0`)
  console.log(`uses/runs/ok+fail 对不上: ${mismatch.length}   ← 目标 0`)
  console.log(`历史遗留 legacyUses   : ${legacy}（早就发生过、无从追溯的复用次数）`)

  if (unaccounted.length) {
    console.log('\n有复用没判定的技能：')
    for (const u of unaccounted.slice(0, 12)) {
      console.log(`  ${u.name} uses=${u.uses} legacy=${u.legacy}｜${String(u.desc).slice(0, 28)}`)
    }
  }
  if (mismatch.length) {
    console.log('\n账本对不上的技能：')
    for (const u of mismatch.slice(0, 12)) {
      console.log(`  ${u.name} uses=${u.uses} ok=${u.ok} fail=${u.fail} retired=${u.retired}`)
    }
  }

  if (FIX) {
    for (const s of all) lib.reconcileUses(s)
    lib.save()
    console.log('\n已对账并写回（差额进 legacyUses，不编造结果）')
  }

  process.exit(unaccounted.length === 0 && mismatch.length === 0 ? 0 : 1)
}

main()
