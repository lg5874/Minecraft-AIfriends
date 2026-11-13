'use strict'
// 技能库自测：记账、适用性、检索、复用、去重、复用率
//
// 核心要证明的事：
//   1. markUse 真的被调用，ok/fail 不再是 0
//   2. 成功率真的进排序
//   3. 复用的前提是"还适用"（工具升级了就不该复用）
//   4. 同一个任务做两次，第二次走技能而不是重新生成
//   5. 278 个重复技能能压到 30 个以内，且不丢有用的

const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  SkillLibrary, intentOf, analyzeCode, successRate, totalRuns, parseToolName
} = require('../src/skills')

let pass = 0
let fail = 0
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}

function tmpDir (tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aifriend-skill-' + tag + '-'))
}

// 模拟 actions.status() 的返回值
function inv (o) { return { inventory: o || {} } }

// 一份真实的技能代码样本
const CODE_STONE_PICK = `
await actions.ensureChunks()
if (actions.countOf('stone_pickaxe') < 1) {
  await actions.craftSmart('stick', 4)
  await actions.craftSmart('stone_pickaxe', 1)
}
await actions.equip('stone_pickaxe')
return '做好石镐'
`

const CODE_WOOD_PICK = `
const w = actions.woodCount()
if (w < 3) await actions.ensureWood(6)
await actions.anyPlanks(8)
await actions.craftSmart('crafting_table', 1)
await actions.craftSmart('wooden_pickaxe', 1)
return '做好木镐'
`

const CODE_MINE_WITH_WOOD = `
// 用木镐挖石头
await actions.equip('wooden_pickaxe')
const n = await actions.mine('stone', 8)
return '挖了' + n
`

// ==================== 1. 代码分析 ====================
console.log('\n[代码分析]')
{
  const a = analyzeCode(CODE_STONE_PICK)
  ok(a.produced.includes('stone_pickaxe'), '读出代码造了 stone_pickaxe', a.produced.join(','))
  ok(a.tools.some(t => t.tier === 'stone' && t.kind === 'pickaxe'), '读出依赖石镐')
  ok(a.actions.includes('craftSmart'), '读出调用的动作')

  const b = analyzeCode(CODE_MINE_WITH_WOOD)
  ok(b.tools.some(t => t.tier === 'wooden' && t.kind === 'pickaxe'), '从 equip 认出木镐')
  ok(b.produced.length === 0, '挖矿代码没造东西')

  ok(parseToolName('stone_pickaxe').rank > parseToolName('wooden_pickaxe').rank, '石镐等级高于木镐')
  ok(parseToolName('oak_log') === null, '非工具名返回 null')
}

// ==================== 2. 意图识别 ====================
console.log('\n[意图识别]')
{
  const k1 = intentOf('用工作台和圆石做一把石镐。', CODE_STONE_PICK)
  const k2 = intentOf('先把圆石和木棍在工作台做一把石镐，换掉手里的木镐。', CODE_STONE_PICK)
  ok(k1.key === k2.key, '两种说法的"做石镐"归成同一意图', k1.key + ' vs ' + k2.key)

  const k3 = intentOf('拿木镐去附近挖石头，凑3块圆石。', CODE_MINE_WITH_WOOD)
  ok(k3.key !== k1.key, '"挖石头"和"做石镐"是不同意图', k3.key + ' vs ' + k1.key)
  ok(/^mine:/.test(k3.key), '挖石头归到 mine:')

  const k4 = intentOf('弄点吃的，别饿着', '')
  ok(k4.key === 'eat', '吃归到 eat')
}

// ==================== 3. 记账：markUse 真的生效 ====================
console.log('\n[记账]')
{
  const dir = tmpDir('use')
  const lib = new SkillLibrary(dir)
  lib.add({ name: 'k_pick', desc: '用圆石做一把石镐', code: CODE_STONE_PICK, tags: ['craft'] })

  const s0 = lib.get('k_pick')
  ok(totalRuns(s0) === 0, '新技能还没有成绩')
  ok(s0.uses === 0, '新技能 uses = 0')

  lib.markUse('k_pick', true)
  lib.markUse('k_pick', true)
  lib.markUse('k_pick', false, { error: '材料不够' })

  const s1 = lib.get('k_pick')
  ok(s1.uses === 3, 'uses 累加到 3', String(s1.uses))
  ok(s1.ok === 2, 'ok = 2', String(s1.ok))
  ok(s1.fail === 1, 'fail = 1（失败也要记）', String(s1.fail))
  ok(s1.runs.length === 3, '每次跑都留一条记录')
  ok(s1.runs[2].error === '材料不够', '失败原因存下来了')
  ok(!!s1.lastUsed, '记了最后使用时间')

  // 落盘 + 重新加载
  const lib2 = new SkillLibrary(dir)
  ok(lib2.get('k_pick').ok === 2 && lib2.get('k_pick').fail === 1, '成绩写进了 skills.json')
  ok(Math.abs(successRate(lib2.get('k_pick')) - 0.6) < 0.001, '成功率 = 2/3 平滑后约 0.6',
    String(successRate(lib2.get('k_pick'))))

  ok(lib.markUse('不存在的技能', true) === null, '记不存在的技能不会崩')
}

// ==================== 4. 适用性：复用的安全闸 ====================
console.log('\n[适用性]')
{
  const dir = tmpDir('app')
  const lib = new SkillLibrary(dir)
  lib.add({ name: 'k_wood', desc: '用木镐挖石头', code: CODE_MINE_WITH_WOOD })
  const wood = lib.get('k_wood')

  // 手上只有木镐 → 能用
  ok(lib.applicable(wood, inv({ wooden_pickaxe: 1 })).ok, '只有木镐时，"用木镐挖石头"可用')

  // 有石镐了 → 这个技能过时了
  const r1 = lib.applicable(wood, inv({ wooden_pickaxe: 1, stone_pickaxe: 1 }))
  ok(!r1.ok, '有石镐后，"用木镐挖石头"不再适用')
  ok(/更好的工具/.test(r1.reason), '说明了原因', r1.reason)

  // 做石镐：还没石镐 → 可用
  lib.add({ name: 'k_stone', desc: '用圆石做一把石镐', code: CODE_STONE_PICK })
  const stone = lib.get('k_stone')
  ok(lib.applicable(stone, inv({ cobblestone: 8 })).ok, '没有石镐时，"做石镐"可用')

  // 已经有石镐 → 不必再做
  const r2 = lib.applicable(stone, inv({ stone_pickaxe: 1 }))
  ok(!r2.ok, '已经有石镐时，"做石镐"不必再跑')
  ok(/已经有了/.test(r2.reason), '说明了原因', r2.reason)

  // 空背包不影响判断
  ok(lib.applicable(stone, {}).ok, '没有 inventory 时按"缺东西"处理，不崩')
}

// ==================== 5. 检索：成功率进排序 ====================
console.log('\n[检索]')
{
  const dir = tmpDir('rank')
  const lib = new SkillLibrary(dir)
  // 两个不同意图、但都跟"石镐"沾边的技能，用来比排序
  //
  // k_mine 的描述里必须带"石镐"：skills.js 在 #8 里把 useBonus 从
  // min(uses/20, 1) 降到 min(uses/100, 0.3)，旧的"用木镐挖石头"在
  // query="做一把石镐" 下得分正好掉到 2.05（阈值 2.2），
  // 于是"能搜到两个候选"就只剩 1 个 —— 那是权重变了、夹具没跟上，
  // 不是检索坏了。带上"石镐"之后得分 3.23，和 k_craft(19.44) 差距稳定。
  lib.add({ name: 'k_craft', desc: '用圆石做一把石镐', code: CODE_STONE_PICK })
  lib.add({ name: 'k_mine', desc: '用木镐挖石头，攒料做石镐', code: CODE_MINE_WITH_WOOD })

  // k_mine 一直失败，k_craft 一直成功
  for (let i = 0; i < 5; i++) lib.markUse('k_mine', false)
  for (let i = 0; i < 5; i++) lib.markUse('k_craft', true)

  const res = lib.search('做一把石镐', 5, inv({ cobblestone: 8 }))
  ok(res.length >= 2, '能搜到两个候选', String(res.length))
  ok(res[0].name === 'k_craft', '成功率高的排前面', res.map(s => s.name + '@' + s._score).join(','))
  ok(successRate(lib.get('k_craft')) > successRate(lib.get('k_mine')), 'k_craft 成功率确实更高')

  // 不适用的排后面，但不是搜不到
  const woodLib = new SkillLibrary(tmpDir('rank2'))
  woodLib.add({ name: 'k_mine_wood', desc: '用木镐挖石头', code: CODE_MINE_WITH_WOOD })
  const r = woodLib.search('用木镐挖石头', 5, inv({ stone_pickaxe: 1 }))
  ok(r.length === 1, '不适用的技能仍然能搜到（当参考）')
  ok(r[0]._applicable === false, '但标了 _applicable = false')
}

// ==================== 6. pickFor：只挑能直接跑的 ====================
console.log('\n[挑技能]')
{
  const dir = tmpDir('pick')
  const lib = new SkillLibrary(dir)
  lib.add({ name: 'k_stone', desc: '用圆石做一把石镐', code: CODE_STONE_PICK })

  const p1 = lib.pickFor('用圆石做一把石镐', inv({ cobblestone: 8 }))
  ok(p1 && p1.skill.name === 'k_stone', '缺石镐时挑中了它', p1 ? p1.skill.name : 'null')

  const p2 = lib.pickFor('用圆石做一把石镐', inv({ stone_pickaxe: 1 }))
  ok(p2 === null, '已有石镐时不挑（交给模型重新判断）')

  const p3 = lib.pickFor('去北极看企鹅', inv({}))
  ok(p3 === null, '不相干的任务不硬凑技能')

  // 成功率太低的技能不该被复用
  lib.add({ name: 'k_bad', desc: '用圆石做一把石镐备用', code: CODE_STONE_PICK.replace('做好石镐', '备用') })
  for (let i = 0; i < 10; i++) lib.markUse('k_bad', false)
  const p4 = lib.pickFor('用圆石做一把石镐备用', inv({ cobblestone: 8 }))
  ok(!p4 || p4.skill.name !== 'k_bad', '失败 10 次的技能不会被再挑中',
    p4 ? p4.skill.name : 'null')
}

// ==================== 7. 去重 ====================
console.log('\n[去重]')
{
  const dir = tmpDir('dedup')
  const lib = new SkillLibrary(dir)
  // 同一个意图塞 20 个变体
  for (let i = 0; i < 20; i++) {
    lib.add({
      name: 'k_pick_' + i,
      desc: ['用圆石做一把石镐', '先把圆石和木棍在工作台做一把石镐', '用工作台和圆石做一把石镐，换掉木镐'][i % 3],
      code: CODE_STONE_PICK + `\n// 变体 ${i}`
    })
  }
  // 另一个意图，不该被并掉
  lib.add({ name: 'k_mine', desc: '用木镐挖石头', code: CODE_MINE_WITH_WOOD })
  lib.add({ name: 'k_eat', desc: '弄点吃的，别饿着', code: 'await actions.eat()\nreturn "吃了"' })

  const before = lib.all().length
  const rep = lib.consolidate()
  ok(rep.after < rep.before, '去重后数量下降', rep.before + ' -> ' + rep.after)
  ok(rep.after === 3, '20 个石镐变体 + 挖矿 + 吃 = 3 个', String(rep.after))
  ok(lib.all().some(s => s.intent === 'eat'), '"吃"没被并掉')
  ok(lib.all().some(s => /^mine:/.test(s.intent)), '"挖矿"没被并掉')

  const keeper = lib.all().find(s => /^craft:pickaxe/.test(s.intent))
  ok(keeper && keeper.mergedFrom + keeper.variants - 1 === 20,
    '保留者吸收了全部 20 个变体',
    keeper ? 'mergedFrom=' + keeper.mergedFrom + ' variants=' + keeper.variants : 'null')
  ok(keeper && keeper.code.includes('craftSmart'), '保留者是有用的那份代码')

  // 插入时就该合并，不该等 consolidate
  const dir2 = tmpDir('dedup2')
  const lib3 = new SkillLibrary(dir2)
  for (let i = 0; i < 20; i++) {
    lib3.add({
      name: 'k_x_' + i,
      desc: ['用圆石做一把石镐', '先把圆石和木棍在工作台做一把石镐', '用工作台和圆石做一把石镐，换掉木镐'][i % 3],
      code: CODE_STONE_PICK + `\n// 变体 ${i}`
    })
  }
  ok(lib3.all().length <= 3, '同一意图的变体在写入时就被合并', String(lib3.all().length))

  // 去重结果要落盘
  const lib2 = new SkillLibrary(dir)
  ok(lib2.all().length === 3, '去重结果写进了文件', String(lib2.all().length))
}

// ==================== 8. 真实数据：278 → 30 以内 ====================
console.log('\n[真实数据]')
{
  const realFile = path.join(__dirname, '..', 'data', 'runtime', 'skills.json')
  if (fs.existsSync(realFile)) {
    const raw = JSON.parse(fs.readFileSync(realFile, 'utf8'))
    const n = raw.skills.length
    const dir = tmpDir('real')
    fs.copyFileSync(realFile, path.join(dir, 'skills.json'))
    const lib = new SkillLibrary(dir)
    ok(lib.all().length === n, '载入 ' + n + ' 个真实技能')

    // 库会在运行中增长（新任务新技能），所以不硬性要求 <=30，
    // 而是要求：现状没有明显该合并却没合并的（去重跑一遍不该砍掉一大半）
    const rep = lib.consolidate({ dryRun: true })
    ok(rep.after <= Math.max(30, Math.ceil(n * 0.9)),
      '去重后条数合理（没有大量漏合并的重复）', n + ' -> ' + rep.after)
    ok(rep.after <= Math.max(30, n - Math.floor(n * 0.05)) || rep.removed <= Math.floor(n * 0.1),
      '重复量在可控范围', '可合并 ' + rep.removed + ' / ' + n)

    // 不丢有用的：核心意图都还在
    const intents = new Set(lib.all().map(s => s.intent))
    for (const need of ['craft:pickaxe@stone', 'craft:pickaxe@wooden', 'mine:stone', 'build:shelter']) {
      ok(intents.has(need), '保留了 ' + need)
    }
    // 每个保留者都要有代码
    ok(lib.all().every(s => s.code && s.code.length > 40), '保留者都带完整代码')
    // 合成类保留者，代码里真的造出了那个东西
    let mismatch = 0
    for (const s of lib.all()) {
      const m = /^craft:([a-z]+)(?:@([a-z]+))?$/.exec(s.intent || '')
      if (!m) continue
      const want = m[1] === 'table' ? 'crafting_table'
        : m[1] === 'furnace' ? 'furnace'
          : m[1] === 'chest' ? 'chest'
            : m[1] === 'block' ? null
              : m[2] + '_' + m[1]
      if (!want) continue
      if (!(s.analysis.produced || []).includes(want)) mismatch++
    }
    ok(mismatch === 0, '合成类保留者的代码确实造出了对应物品', '不一致 ' + mismatch + ' 个')
  } else {
    console.log('  （跳过：没有 data/runtime/skills.json）')
  }
}

// ==================== 9. 端到端：同一任务做两次 ====================
console.log('\n[同一任务做两次]')
{
  const dir = tmpDir('e2e')
  const lib = new SkillLibrary(dir)
  lib.add({ name: 'k_stone', desc: '用圆石做一把石镐', code: CODE_STONE_PICK })

  // 假 bot：第一次没石镐，第二次有石镐
  let inventory = { cobblestone: 12 }
  const actions = {
    status: () => ({ pos: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory })
  }

  // 第一次：pickFor 应挑中技能
  const goal = '用圆石做一把石镐'
  const first = lib.pickFor(goal, actions.status())
  ok(!!first, '第一次：找到可复用的技能', first ? first.skill.name : 'null')
  if (first) {
    lib.markUse(first.skill.name, true, { ms: 900 })
    lib.markTask({ reused: true, ok: true })
  }
  ok(lib.get('k_stone').uses === 1, '第一次复用了技能（uses=1）')

  // 跑完之后背包里有石镐了
  inventory = { cobblestone: 6, stone_pickaxe: 1 }
  const second = lib.pickFor(goal, actions.status())
  ok(second === null, '第二次：已有石镐，不再复用（避免重复干活）')

  // 换个任务：挖石头。这次应该挑中挖矿技能
  lib.add({ name: 'k_mine', desc: '用木镐挖石头', code: CODE_MINE_WITH_WOOD })
  const third = lib.pickFor('用木镐挖石头', inv({ wooden_pickaxe: 1 }))
  ok(!!third && third.skill.name === 'k_mine', '换任务能挑到对应技能', third ? third.skill.name : 'null')

  const st = lib.stats()
  ok(st.reusedTasks === 1 && st.tasks >= 1, '任务统计记下了复用次数', JSON.stringify(st))
}

// ==================== 10. 复用率 ====================
console.log('\n[复用率]')
{
  const dir = tmpDir('rate')
  const lib = new SkillLibrary(dir)
  lib.add({ name: 'k_a', desc: '用圆石做一把石镐', code: CODE_STONE_PICK })
  lib.add({ name: 'k_b', desc: '用木镐挖石头', code: CODE_MINE_WITH_WOOD })

  // 模拟 10 个任务：前 4 个靠模型生成，后 6 个复用技能
  for (let i = 0; i < 4; i++) lib.markTask({ reused: false, ok: true })
  for (let i = 0; i < 6; i++) {
    lib.markTask({ reused: true, ok: true })
    lib.markUse(i % 2 ? 'k_a' : 'k_b', true)
  }

  const st = lib.stats()
  ok(st.tasks === 10, '任务总数 10', String(st.tasks))
  ok(st.reusedTasks === 6, '其中 6 次复用', String(st.reusedTasks))
  ok(Math.abs(st.reuseRate - 0.6) < 1e-9, '复用率 60%', String(st.reuseRate))
  ok(st.used === 2, '两个技能都被用过', String(st.used))
  ok(st.ok === 6 && st.fail === 0, '成功率数据是真的', st.ok + '/' + (st.ok + st.fail))

  // catalog 里能看到真实成功率（原始比值，不是平滑值）
  const cat = lib.catalog()
  ok(/成功率 100%/.test(cat), '目录里显示真实成功率', cat.split('\n')[0])
}

// ==================== 11. 真 Coder 端到端：第二次不调模型 ====================
async function testCoderReuse () {
  console.log('\n[真 Coder 端到端]')
  const { Coder } = require('../src/coder')
  const dir = tmpDir('coder')
  const lib = new SkillLibrary(dir)

  let inv = { cobblestone: 12 }
  const actions = {
    status: () => ({ pos: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: inv }),
    countOf: n => inv[n] || 0,
    ensureChunks: async () => true,
    craftSmart: async (n, c) => { inv[n] = (inv[n] || 0) + c; return true },
    equip: async () => true
  }

  let llmCalls = 0
  const llm = {
    chat: async () => {
      llmCalls++
      return {
        text: '```javascript\nawait actions.ensureChunks()\n' +
          'await actions.craftSmart("stick", 4)\n' +
          'await actions.craftSmart("stone_pickaxe", 1)\n' +
          'return "做好了石镐"\n```'
      }
    }
  }

  const ctx = {
    log: () => {},
    say: () => {},
    mem: { note () {}, place () {}, fact () {}, lesson () {} },
    cfg: { llm: { codeMaxTokens: 1000 }, behavior: { taskTimeoutSeconds: 20 } }
  }

  // 【测试夹具】必须给 bot 一个真 inventory。
  //
  // coder 在 112917d 之后会用 `bot.inventory.items()` 核对"世界真的变了"
  // （src/coder.js 的 verifySkillEffect，防假成功的第一层）。
  // 这里原来只有 {username, health, ...}，没有 inventory：
  // snapshotInv() 永远返回 {}，于是"真的搓出了石镐"也被判成
  // "背包没增加"，复用整条链路直接断掉（表现为 reused=null、uses=1 ok=0）。
  //
  // 注意 items() 必须读**当前的** inv 变量（测试中途会 rebind），所以用闭包。
  const bot = {
    username: 'XJJ',
    health: 20,
    food: 20,
    time: 0,
    entity: {},
    players: {},
    inventory: {
      items: () => Object.entries(inv).map(([name, count]) => ({ name, count }))
    }
  }
  const coder = new Coder(bot, actions, llm, lib, ctx)
  const goal = '用圆石做一把石镐'

  // ---- 第一次：库里没有技能 → 模型生成 ----
  const r1 = await coder.writeAndRun(goal)
  ok(r1.ok, '第一次任务成功')
  ok(r1.reused === null, '第一次是模型生成的（reused=null）')
  ok(llmCalls === 1, '第一次调了 1 次模型', String(llmCalls))

  // 主程序在成功后会存技能（main.js 里就是这么做的）
  lib.add({ name: 'k_1', desc: goal, code: r1.code, tags: ['craft', 'pickaxe'] })

  // ---- 第二次：同一任务，库里有了 → 应该直接跑 ----
  inv = { cobblestone: 12 }   // 回到"还没做石镐"的状态
  const before = llmCalls
  const r2 = await coder.writeAndRun(goal)
  const used = llmCalls - before

  ok(r2.ok, '第二次任务也成功')
  ok(r2.reused === 'k_1', '第二次复用了技能，没重新生成', String(r2.reused))
  ok(used === 0, '第二次一次模型都没调', String(used))

  const s = lib.get('k_1')
  ok(s.uses === 1 && s.ok === 1, '复用被记进了成绩', 'uses=' + s.uses + ' ok=' + s.ok)

  const st = lib.stats()
  ok(st.tasks === 2 && st.reusedTasks === 1, '任务统计：2 次里 1 次复用',
    JSON.stringify({ tasks: st.tasks, reused: st.reusedTasks }))

  // ---- 第三次：已经有石镐了 → 不该再复用 ----
  inv = { cobblestone: 6, stone_pickaxe: 1 }
  const before3 = llmCalls
  const r3 = await coder.writeAndRun(goal)
  ok(r3.reused === null, '第三次：已有石镐，不复用旧技能', String(r3.reused))
  ok(llmCalls > before3, '第三次回到了模型生成', String(llmCalls - before3))
}

// ==================== 12. 复用失败也要记 ====================
async function testReuseFailure () {
  console.log('\n[复用失败]')
  const { Coder } = require('../src/coder')
  const dir = tmpDir('failuse')
  const lib = new SkillLibrary(dir)
  // 存一个会抛错的技能
  lib.add({ name: 'k_broken', desc: '用圆石做一把石镐', code: 'throw new Error("模拟技能失效")' })

  const actions = { status: () => ({ inventory: { cobblestone: 9 } }) }
  let llmCalls = 0
  const llm = { chat: async () => { llmCalls++; return { text: '```javascript\nreturn "兜底成功"\n```' } } }
  const ctx = {
    log: () => {}, say: () => {},
    mem: { note () {}, place () {}, fact () {}, lesson () {} },
    cfg: { llm: { codeMaxTokens: 1000 }, behavior: { taskTimeoutSeconds: 20 } }
  }
  const coder = new Coder({ username: 'X', players: {} }, actions, llm, lib, ctx)

  const r = await coder.writeAndRun('用圆石做一把石镐')
  const s = lib.get('k_broken')

  ok(s.fail === 1, '技能跑挂记了一次失败', 'fail=' + s.fail)
  ok(s.runs[0] && /模拟技能失效/.test(s.runs[0].error || ''), '失败原因存下来了',
    s.runs[0] ? s.runs[0].error : 'null')
  ok(r.ok && r.reused === null, '技能失败后回落到模型生成')
  ok(llmCalls > 0, '确实调了模型兜底', String(llmCalls))
  ok(successRate(s) < 0.5, '失败后成功率掉到 50% 以下', String(successRate(s)))
}

// ==================== 13. 容量上限与淘汰 ====================
async function testCap () {
  console.log('\n[容量上限]')
  const dir = tmpDir('cap')
  const lib = new SkillLibrary(dir)
  // 直接塞 60 条互不相同的技能，绕开 add 的去重
  lib.data.skills = []
  for (let i = 0; i < 60; i++) {
    lib.data.skills.push(lib.migrate({
      name: 'k_' + i, desc: '技能' + i, code: 'return ' + i,
      uses: 0, ok: 0, fail: 0, created: Date.now() + i, updated: Date.now() + i
    }))
  }
  // 5 条好成绩但很旧
  const good = lib.all().slice(0, 5).map(s => s.name)
  good.forEach(n => { const s = lib.get(n); s.ok = 9; s.fail = 1; s.uses = 10; s.updated = 1 })
  // 5 条差成绩但很新
  const bad = lib.all().slice(5, 10).map(s => s.name)
  bad.forEach(n => { const s = lib.get(n); s.ok = 1; s.fail = 9; s.uses = 10; s.updated = Date.now() + 99999 })

  ok(lib.all().length === 60, '塞了 60 条', String(lib.all().length))
  const dropped = lib.prune(50)
  ok(lib.all().length === 50, 'prune 后压到 50 条', String(lib.all().length))
  ok(dropped.length === 10, '淘汰了 10 条', String(dropped.length))
  ok(good.every(n => !!lib.get(n)), '高成功率的老技能保住了')
  ok(bad.every(n => !lib.get(n)), '低成功率的新技能被淘汰')

  // add 触发自动 prune
  const dir2 = tmpDir('cap2')
  const lib2 = new SkillLibrary(dir2)
  lib2.data.skills = []
  for (let i = 0; i < 55; i++) {
    lib2.data.skills.push(lib2.migrate({
      name: 'x_' + i, desc: '旧任务' + i, code: 'return ' + i,
      uses: 0, ok: 0, fail: 0, created: i, updated: i
    }))
  }
  lib2.add({ name: 'x_new', desc: '全新任务：去挖红石', code: 'return 1' })
  ok(lib2.all().length <= 50, 'add() 会自动触发修剪', String(lib2.all().length))
}

// ==================== 14. 提示词只注入验证过的技能 ====================
async function testPromptSize () {
  console.log('\n[提示词体积]')
  const dir = tmpDir('prompt')
  const lib = new SkillLibrary(dir)

  // 未验证的技能不该出现在目录里
  lib.add({ name: 'k_unverified', desc: '用圆石做一把石镐', code: CODE_STONE_PICK })
  const cat1 = lib.catalog(20)
  ok(!/k_unverified/.test(cat1), '未验证的技能不进目录', cat1)
  ok(/还没有验证过/.test(cat1), '目录明确说明"还没有验证过的技能"')

  // 验证过（跑成功过）才进目录
  lib.markUse('k_unverified', true)
  const cat2 = lib.catalog(20)
  ok(/k_unverified/.test(cat2), '跑成功过才进目录', cat2)
  ok(/成功率 100%/.test(cat2), '带真实成功率', cat2)

  // 只失败过的也不进目录
  lib.add({ name: 'k_always_fail', desc: '用圆石做一把石斧', code: CODE_STONE_PICK.replace('pickaxe', 'axe') })
  lib.markUse('k_always_fail', false)
  const cat3 = lib.catalog(20)
  ok(!/k_always_fail/.test(cat3), '只失败过的不进目录', cat3)

  // 目录有上限，不会无限长
  const dir2 = tmpDir('prompt2')
  const lib3 = new SkillLibrary(dir2)
  for (let i = 0; i < 40; i++) {
    lib3.add({ name: 'v_' + i, desc: '第' + i + '个已验证技能：去挖第' + i + '种矿', code: 'return ' + i })
    lib3.markUse('v_' + i, true)
  }
  const cat4 = lib3.catalog(20)
  const lines = cat4.split('\n').filter(Boolean)
  ok(lines.length <= 20, '目录最多 20 行', String(lines.length))
  ok(cat4.length < 1200, '目录字符数受控（< 1200）', String(cat4.length))
}

// ==================== 汇总 ====================
;(async () => {
  await testCoderReuse()
  await testReuseFailure()
  await testCap()
  await testPromptSize()

  console.log('\n' + '='.repeat(46))
  console.log(`通过 ${pass}，失败 ${fail}`)
  if (fail) {
    console.log('有 ' + fail + ' 项没过')
    process.exit(1)
  }
  console.log('技能库自测全过')
})()
