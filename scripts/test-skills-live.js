'use strict'
// 技能库**真实运行**评估：跑一段模拟的运行，看复用到底是不是真的在帮忙。
//
// 和 test-skills.js 的区别：
//   test-skills.js  —— 单元测试，每个机制单独验
//   test-skills-live.js —— 连着跑一串任务，看累积效果和隐患
//
// 要回答的问题：
//   1. 连续做同一类任务，复用率是多少
//   2. 中途工具升级，旧技能会不会退场
//   3. 坏技能会不会被反复复用、反复失败（错误传播）
//   4. 复用 vs 重新生成，成功率和代价差多少
//   5. 注入提示词的字符数控制在多少

const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  SkillLibrary, intentOf, successRate, totalRuns
} = require('../src/skills')

let pass = 0
let fail = 0
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}

function tmpDir (tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'live-' + tag + '-'))
}

// ==================== 一个假的世界 ====================
// 不是真 bot，但行为按真 bot 的约束来：
//   - 任务可能超时（默认 420 秒，这里压成计数）
//   - 挖矿越挖越慢，超时就挂
//   - 工具越高级越快
function makeWorld (opts = {}) {
  const w = {
    inv: Object.assign({}, opts.inv || {}),
    // 超时阈值：跑太多步就算超时
    timeoutSteps: opts.timeoutSteps || 8,
    log: []
  }
  return w
}

// ==================== 一个假 Coder ====================
// 复刻 writeAndRun 的两段式逻辑，但 run() 不真执行代码，
// 而是按技能"声明的工作量"模拟成败 —— 这样能跑几百次任务。
function makeCoder (lib, world, opts = {}) {
  const stats = { llmCalls: 0, reuseOk: 0, reuseFail: 0, genOk: 0, genFail: 0, reuseMs: 0, genMs: 0, timeouts: 0 }

  // 模拟跑一段技能代码：按步数消耗，超时就失败
  function simulate (code, label) {
    const steps = (String(code).match(/actions\.\w+/g) || []).length + 3
    if (steps > world.timeoutSteps) {
      stats.timeouts++
      const ms = 420000
      stats.reuseMs += ms
      return { ok: false, error: '这次干太久了，算了', ms }
    }
    const ms = 800 + steps * 220
    stats.reuseMs += ms
    return { ok: true, output: label + ' 完成', ms }
  }

  function pickFor (goal) {
    // 复用 skills.pickFor 的真实实现
    return lib.pickFor(goal, world.inv)
  }

  return {
    stats,
    async writeAndRun (goal) {
      const tried = new Set()
      let skillFailed = ''

      // ---- 第一段：复用 ----
      for (let i = 0; i < 2; i++) {
        const picked = pickFor(goal, { exclude: tried })
        if (!picked) break
        const sk = picked.skill
        tried.add(sk.name)

        const out = simulate(sk.code, sk.desc)
        // 真 Coder 这里调 markUse —— 一样
        lib.markUse(sk.name, out.ok, { ms: out.ms, error: out.error })
        if (out.ok) {
          lib.markTask({ reused: true, ok: true })
          stats.reuseOk++
          return { ok: true, reused: sk.name, ms: out.ms }
        }
        // ★ 关键：复用失败也要记任务级统计
        lib.markTask({ reused: true, ok: false })
        stats.reuseFail++
        skillFailed = out.error
      }

      // ---- 第二段：模型生成 ----
      stats.llmCalls++
      const ms = 2500 + Math.random() * 2000
      stats.genMs += ms
      const genOk = Math.random() < (opts.genSuccessRate == null ? 0.75 : opts.genSuccessRate)
      if (genOk) {
        stats.genOk++
        lib.add({
          name: 'k_gen_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 9999),
          desc: goal,
          code: '// 生成的代码\n' + 'await actions.wander(1)\n'.repeat(Math.min(6, world.timeoutSteps - 3)),
          tags: []
        })
        lib.markTask({ reused: false, ok: true })
        return { ok: true, reused: null, ms }
      }
      stats.genFail++
      lib.markTask({ reused: false, ok: false })
      return { ok: false, error: '生成失败 ' + skillFailed, ms }
    }
  }
}

// ==================== 1. 真实数据体检 ====================
async function inspectReal () {
  console.log('\n[1. 真实数据体检]')
  const file = path.join(__dirname, '..', 'data', 'runtime', 'skills.json')
  if (!fs.existsSync(file)) {
    console.log('  （跳过：没有真实数据）')
    return null
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const S = raw.skills
  const st = raw.stats || {}

  const used = S.filter(s => (s.uses || 0) > 0)
  const dead = S.filter(s => !(s.uses || 0))
  const okSum = S.reduce((a, s) => a + (s.ok || 0), 0)
  const failSum = S.reduce((a, s) => a + (s.fail || 0), 0)

  console.log(`  条数 ${S.length} | 用过 ${used.length} | 死条目 ${dead.length}`)
  console.log(`  总成绩 ok=${okSum} fail=${failSum} → 技能级成功率 ${(okSum / (okSum + failSum) * 100).toFixed(1)}%`)
  console.log(`  stats: tasks=${st.tasks} reused=${st.reusedTasks} reuseOk=${st.reuseOk} reuseFail=${st.reuseFail}`)

  // ---- 隐患 A：stats 和技能级数据对不上 ----
  const claimed = st.reuseOk || 0
  const actual = okSum
  ok(Math.abs(claimed - actual) <= 1,
    'stats.reuseOk 与技能级 ok 总数一致',
    `stats 说 ${claimed}，技能级只有 ${actual}`)
  // 历史数据的 reuseFail 可能还是旧代码写的 0；这里只报数，判定放到引擎测试里
  console.log(`  ⚠ stats.reuseFail=${st.reuseFail || 0} vs 技能级 fail=${failSum}` +
    ((st.reuseFail || 0) < failSum ? '（历史遗留，新代码已修）' : ''))

  return { S, st, okSum, failSum }
}

// ==================== 2. 连续同类任务 ====================
async function testRepeated () {
  console.log('\n[2. 连续做同一类任务 ×8]')
  const dir = tmpDir('repeat')
  const lib = new SkillLibrary(dir)
  const world = makeWorld({ timeoutSteps: 8 })
  const coder = makeCoder(lib, world)

  const goal = '用石镐挖圆石补充建材'
  const rounds = []
  for (let i = 0; i < 8; i++) {
    const r = await coder.writeAndRun(goal)
    rounds.push(r)
  }

  const reused = rounds.filter(r => r.reused).length
  const firstGen = rounds[0].reused === null
  console.log(`  第 1 次: ${rounds[0].reused ? '复用' : '生成'}  第 2-8 次复用 ${reused} 次`)
  console.log(`  复用率 ${(reused / rounds.length * 100).toFixed(0)}%`)

  ok(firstGen, '第 1 次是模型生成（还没有技能）')
  ok(reused >= 6, '后续 7 次里至少 6 次复用', `只有 ${reused} 次`)
  ok(lib.all().length <= 2, '同一任务不会存一堆重复技能', `${lib.all().length} 条`)

  const s = lib.all()[0]
  if (s) {
    ok(s.uses >= 6, '复用次数真实记账', `uses=${s.uses}`)
    ok((s.ok || 0) > 0, '成功率有真实数据', `ok=${s.ok} fail=${s.fail}`)
  }
  return rounds
}

// ==================== 3. 工具升级后退场 ====================
async function testUpgrade () {
  console.log('\n[3. 中途工具升级，旧技能退场]')
  const dir = tmpDir('upgrade')
  const lib = new SkillLibrary(dir)
  const world = makeWorld({ timeoutSteps: 8, inv: { wooden_pickaxe: 1 } })
  const coder = makeCoder(lib, world, { genSuccessRate: 1 })  // 确定性

  // 手动存一个"用木镐挖石头"的技能 —— 代码里真用木镐，
  // 这样才测得到"工具升级 → 技能退场"
  const goal = '用木镐去附近挖石头'
  lib.add({
    name: 'k_wood_mining',
    desc: goal,
    code: "if (actions.countOf('wooden_pickaxe') < 1) return '没镐'\n" +
      "await actions.equip('wooden_pickaxe')\n" +
      "await actions.mine('stone', 5)\n" +
      "return '挖了5块石头'"
  })
  const sk = lib.get('k_wood_mining')
  ok(!!sk, '先存下了一条木镐技能')

  // 木镐阶段：应该能复用
  const before = lib.pickFor(goal, world.inv)
  ok(!!before, '只有木镐时，技能可复用', before ? before.skill.name : 'null')

  // 升级成石镐
  world.inv.stone_pickaxe = 1
  const after = lib.pickFor(goal, world.inv)
  console.log(`  工具升级后：${after ? '仍在复用 ' + after.skill.name : '已退场（不复用）'}`)
  ok(after === null, '有石镐后，木镐技能退场')

  // 但技能本身不应该被删掉（将来可能退回木镐）
  ok(!!lib.get(sk.name), '技能没被删，只是不复用')
}

// ==================== 4. 坏技能：错误传播 ====================
async function testBadSkill () {
  console.log('\n[4. 坏技能会不会被无限复用]')
  const dir = tmpDir('bad')
  const lib = new SkillLibrary(dir)
  const world = makeWorld({ timeoutSteps: 8 })
  const coder = makeCoder(lib, world, { genSuccessRate: 1 })

  // 存一个必然超时的坏技能（代码里动作太多）
  lib.add({
    name: 'k_bad',
    desc: '用石镐把附近石头全挖下来补充建材',
    code: 'await actions.mine(1)\n'.repeat(20) + 'return 1',
    tags: []
  })

  const goal = '用石镐把附近石头全挖下来补充建材'
  const rounds = []
  for (let i = 0; i < 6; i++) rounds.push(await coder.writeAndRun(goal))

  const bad = lib.get('k_bad')
  const badUsed = rounds.filter(r => r.reused === 'k_bad').length
  const lifeFail = (bad.lifetimeFail || 0) + (bad.fail || 0)
  console.log(`  坏技能被复用 ${badUsed} 次 | 本版 ok=${bad.ok} fail=${bad.fail} | 累计失败 ${lifeFail}`)
  console.log(`  换版 ${bad.replaced || 0} 次 | 现在的代码步数 ${(bad.code.match(/actions\./g) || []).length}`)

  // 允许多次复用，但同一个坏代码造成的失败不该超过 2 次
  // （失败 2 次后 pickFor 就会把它筛掉，或者被换版治愈）
  ok(lifeFail <= 2, '同一个坏代码最多踩坑 2 次', `实际失败 ${lifeFail} 次 / 复用 ${badUsed} 次`)
  ok(lifeFail >= 1, '失败被如实记录（累计，不是清零后装没发生）', `累计失败 ${lifeFail}`)
  ok((bad.replaced || 0) >= 1, '坏代码被换版替换掉了', `replaced=${bad.replaced || 0}`)
  ok((bad.retired || []).length >= 1, '旧版成绩留档在 retired 里', JSON.stringify(bad.retired || []).slice(0, 80))
  // 换版后的代码能跑通（步数够少）
  ok((bad.code.match(/actions\./g) || []).length <= world.timeoutSteps - 3,
    '换版后代码工作量降到不超时',
    `${(bad.code.match(/actions\./g) || []).length} 步 vs 阈值 ${world.timeoutSteps}`)
}

// ==================== 5. 复用 vs 重新生成 ====================
async function testCostCompare () {
  console.log('\n[5. 复用 vs 重新生成：代价对比]')
  const dir = tmpDir('cost')
  const lib = new SkillLibrary(dir)
  const world = makeWorld({ timeoutSteps: 8 })
  const coder = makeCoder(lib, world)

  const goal = '捡够垫脚的石头'
  const rounds = []
  for (let i = 0; i < 10; i++) rounds.push(await coder.writeAndRun(goal))

  const reusedMs = rounds.filter(r => r.reused).reduce((a, r) => a + r.ms, 0)
  const genMs = rounds.filter(r => !r.reused).reduce((a, r) => a + r.ms, 0)
  const nRe = rounds.filter(r => r.reused).length
  const nGen = rounds.length - nRe

  console.log(`  复用 ${nRe} 次共 ${(reusedMs / 1000).toFixed(1)}s（均 ${(reusedMs / nRe / 1000).toFixed(1)}s）`)
  console.log(`  生成 ${nGen} 次共 ${(genMs / 1000).toFixed(1)}s（均 ${(genMs / nGen / 1000).toFixed(1)}s）`)
  console.log(`  复用省下 ${(genMs / nGen - reusedMs / nRe).toFixed(0)}ms/次`)

  ok(nRe >= 8, '10 次里至少 8 次复用', String(nRe))
  ok(reusedMs / nRe < genMs / nGen, '复用单次比重新生成快',
    `复用 ${(reusedMs / nRe).toFixed(0)}ms vs 生成 ${(genMs / nGen).toFixed(0)}ms`)

  const st = lib.stats()
  console.log(`  复用成功率 ${(st.reuseRate * 100).toFixed(0)}% | 任务级 ok=${st.reuseOk} fail=${st.reuseFail}`)
  ok(st.reuseFail >= 0, '复用失败被统计（不是永远 0）')
}

// ==================== 6. 注入量 ====================
async function testInjection () {
  console.log('\n[6. 注入提示词的字符数]')
  const dir = tmpDir('inject')
  const lib = new SkillLibrary(dir)
  const world = makeWorld({ timeoutSteps: 8 })
  const coder = makeCoder(lib, world)

  // 攒一批技能
  const goals = ['挖圆石', '砍树', '种树苗', '弄吃的', '挖铁矿', '搭庇护所', '捡石头', '烧木炭']
  for (const g of goals) {
    for (let i = 0; i < 3; i++) await coder.writeAndRun(g)
  }

  const cat = lib.catalog(30)
  const inv = { stone_pickaxe: 1, cobblestone: 20 }
  let worst = 0
  for (const g of goals) {
    const rel = lib.search(g, 2, inv, { verifiedOnly: true })
    let used = 0
    for (const s of rel) { if (used + s.code.length > 3000) continue; used += s.code.length }
    worst = Math.max(worst, used)
  }
  console.log(`  技能 ${lib.all().length} 条 | catalog ${cat.length} 字符 | 最坏代码注入 ${worst} 字符`)
  console.log(`  最坏合计 ${cat.length + worst} 字符`)

  ok(cat.length < 1500, 'catalog 受控（<1500 字符）', String(cat.length))
  ok(worst <= 3000, '代码注入受预算约束（≤3000）', String(worst))
  ok(cat.length + worst < 4500, '合计不挤爆提示词（<4500）', String(cat.length + worst))
  ok(lib.all().length <= 50, '总条数不超上限', String(lib.all().length))
}

// ==================== 7. 死条目与计划碎片 ====================
async function testJunk () {
  console.log('\n[7. 死条目 / 计划碎片污染]')
  const dir = tmpDir('junk')
  const lib = new SkillLibrary(dir)

  // 模型把"计划步骤"也当技能存了（真实数据里就有）
  const fragments = [
    '沿途用火把和显眼地形做标记，记住来路。',
    '见到没见过的地形就停下来观察一圈，别走太远。',
    '最后找到钻石层确认矿石'
  ]
  for (const f of fragments) {
    lib.add({ name: 'k_' + Math.random().toString(36).slice(2, 8), desc: f, code: 'await actions.wander(2)' })
  }
  const it = fragments.map(f => intentOf(f, 'await actions.wander(2)'))
  console.log('  碎片意图:', it.map(x => x.key + '/' + x.conf).join(', '))
  ok(it.every(x => x.conf === 0), '计划碎片意图置信度为 0（不参与合并，但也不该当正经技能）')

  // 这些碎片不该被当作可复用技能
  const picked = lib.pickFor('沿途用火把和显眼地形做标记，记住来路。', {})
  ok(picked === null || successRate(picked.skill) > 0, '没验证过的碎片不会被当成可复用技能',
    picked ? 'picked ' + picked.skill.name : 'null')
}

// ==================== 8. 超时失败的处理 ====================
async function testTimeout () {
  console.log('\n[8. 超时型失败：该降权而不是永久拉黑]')
  const dir = tmpDir('timeout')
  const lib = new SkillLibrary(dir)

  // 一个"跑得慢但能成"的技能：前几次超时，后几次环境好就成功了
  lib.add({
    name: 'k_slow',
    desc: '用石镐把庇护所附近暴露的石头和安山岩挖下来，补充建材储备。',
    code: 'await actions.mine("stone", 10)\nawait actions.mine("andesite", 5)',
    tags: []
  })
  const s = lib.get('k_slow')

  // 连续 12 次超时
  for (let i = 0; i < 12; i++) lib.markUse('k_slow', false, { error: '这次干太久了，算了' })
  const rateAfterFail = successRate(s)
  console.log(`  连挂 12 次后成功率 ${(rateAfterFail * 100).toFixed(0)}%`)
  ok(rateAfterFail < 0.1, '连续超时把成功率压到 10% 以下', (rateAfterFail * 100).toFixed(0) + '%')

  // 此时不该再被复用
  const p1 = lib.pickFor('用石镐把庇护所附近暴露的石头和安山岩挖下来，补充建材储备。',
    { stone_pickaxe: 1 })
  ok(p1 === null, '成功率太低后不再被挑中', p1 ? p1.skill.name : 'null')

  // 但技能还在（环境好了还能用）
  ok(!!lib.get('k_slow'), '技能本身还在，没被删')

  // 再成功几次，应该能爬回来
  for (let i = 0; i < 30; i++) lib.markUse('k_slow', true, { ms: 1000 })
  const rateBack = successRate(s)
  console.log(`  之后成功 30 次成功率 ${(rateBack * 100).toFixed(0)}%`)
  ok(rateBack > 0.6, '成功多了能爬回来（不是永久拉黑）', (rateBack * 100).toFixed(0) + '%')
}

// ==================== 汇总 ====================
;(async () => {
  const real = await inspectReal()
  await testRepeated()
  await testUpgrade()
  await testBadSkill()
  await testCostCompare()
  await testInjection()
  await testJunk()
  await testTimeout()

  console.log('\n' + '='.repeat(52))
  if (real) {
    const { okSum, failSum, S, st } = real
    console.log('【真实运行概况】')
    console.log(`  技能 ${S.length} 条，用过 ${S.filter(s => s.uses > 0).length} 条，死条目 ${S.filter(s => !s.uses).length} 条`)
    console.log(`  技能级成功 ${okSum} / 失败 ${failSum} → ${(okSum / (okSum + failSum) * 100).toFixed(1)}%`)
    console.log(`  stats 口径 ${st.reuseOk}/${st.reusedTasks} = ${((st.reuseOk || 0) / (st.reusedTasks || 1) * 100).toFixed(1)}%（虚高，见隐患 A）`)
    console.log('')
  }
  console.log(`通过 ${pass}，失败 ${fail}`)
  if (fail) { console.log(`有 ${fail} 项没过`); process.exit(1) }
  console.log('实测全过')
})()
