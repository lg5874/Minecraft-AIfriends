'use strict'
/**
 * 长期目标自测。
 *
 * 验的是五件事：
 *   1. 目标能立起来，拆成至少 3 个阶段
 *   2. 目标是他自己选的（模型给什么就用什么），不是写死的
 *   3. 进度能算出来，能往前走
 *   4. 重启（重新 new 一次）能读回来，接着干
 *   5. 太久没进展会放弃，放弃之后不会马上又挑同一个
 *
 * 用假 LLM + 假背包，不连服务器。
 */

const path = require('path')
const fs = require('fs')
const os = require('os')

const Goals = require('../src/goals')

let pass = 0
let fail = 0
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aifriend-goals-'))

/** 假 LLM：按预设回一段 JSON */
function fakeLLM (reply) {
  return {
    calls: 0,
    async chat () {
      this.calls++
      return { text: typeof reply === 'function' ? reply(this.calls) : reply }
    }
  }
}

/** 假的状态（跟 actions.status() 同结构） */
function fakeStatus ({ inv = {}, y = 70, x = 0, z = 0, health = 20, food = 18 } = {}) {
  return {
    pos: { x, y, z },
    health,
    food,
    time: '白天',
    dimension: 'overworld',
    weather: '晴',
    held: null,
    inventory: inv
  }
}

const log = (s) => console.log('    ' + s)

// ================================================================
async function main () {
console.log('\n[一、立目标：让他自己挑]')
{
  const dir = tmp()
  const llm = fakeLLM(JSON.stringify({
    key: 'house',
    title: '攒够材料盖个小屋',
    why: '一直住山洞不像话'
  }))
  const g = new Goals(dir, { llm, ctx: { log }, now: () => Date.now() })
  const status = fakeStatus({ inv: { wooden_pickaxe: 1, oak_log: 12, cobblestone: 20 } })

  const cands = g.candidates(status)
  ok(cands.length >= 3, '候选池里能想到好几件事', cands.length + ' 个')
  ok(cands[0].score >= cands[cands.length - 1].score, '候选按可行性排了序')

  const goal = await g.ensure(status)
  ok(!!goal, '立起了一个长期目标')
  ok(goal.title === '攒够材料盖个小屋', '用的是他想出来的说法', goal.title)
  ok(goal.stages.length >= 3, '拆成了至少 3 个阶段', goal.stages.length + ' 个')
  ok(llm.calls === 1, '问了一次模型')

  console.log('\n    目标：' + goal.title + '（' + goal.why + '）')
  goal.stages.forEach((s, i) => console.log(`      ${i + 1}. [${s.kind}] ${s.title}`))

  ok(goal.stages.every(s => typeof s.title === 'string' && s.title.length > 4), '每个阶段都说人话')
  ok(goal.stages.every(s => s.need && typeof s.need === 'object'), '每个阶段都能验收')
}

// ================================================================
console.log('\n[二、现在该干哪一步]')
{
  const dir = tmp()
  const llm = fakeLLM(JSON.stringify({ key: 'house', title: '攒够材料盖个小屋', why: '住山洞不像话' }))
  const g = new Goals(dir, { llm, ctx: { log } })
  const status = fakeStatus({ inv: { wooden_pickaxe: 1, oak_log: 12 } })
  await g.ensure(status)

  const cur = g.current()
  ok(!!cur, 'current() 给出当下该做的一步')
  ok(cur.fromGoal === true, '标了 fromGoal，will 能认出这是长期目标来的')
  ok(cur.text === g.goal.stages[0].title, '第一步就是第一个阶段')
  ok(cur.total >= 3, '带着总步数')
  ok(typeof g.currentText() === 'string', 'currentText() 只给一句话')
  ok(g.promptBlock().includes('你心里挂着的一件事'), '能给提示词用的一段话')

  console.log('\n    现在该干：' + cur.text)
  console.log('    ' + g.progressText())
}

// ================================================================
console.log('\n[三、记进度：一步一步往前推]')
{
  const dir = tmp()
  const llm = fakeLLM(JSON.stringify({ key: 'iron', title: '攒够铁做身铁家伙', why: '石镐不经用' }))
  const g = new Goals(dir, { llm, ctx: { log } })

  // 阶段1：先弄把石镐（craft）
  let status = fakeStatus({ inv: { wooden_pickaxe: 1, cobblestone: 30 } })
  await g.ensure(status)
  ok(g.stage().kind === 'craft', '第一步是弄工具')
  let r = g.observe(status)
  ok(r.ratio < 1, '还没石镐，进度不满', String(r.ratio))

  // 做出石镐
  status = fakeStatus({ inv: { wooden_pickaxe: 1, stone_pickaxe: 1, cobblestone: 30 } })
  r = g.observe(status)
  ok(r.stageCompleted === true, '做出石镐 → 过了一步')
  ok(g.goal.stageIndex === 1, '进到第二步')

  // 阶段2：带火把和吃的（gather）
  ok(g.stage().kind === 'gather', '第二步是备料')
  status = fakeStatus({ inv: { stone_pickaxe: 1, cobblestone: 30, torch: 4, bread: 2 } })
  r = g.observe(status)
  ok(r.ratio > 0.3 && r.ratio < 1, '备了一半', g.progressText())

  status = fakeStatus({ inv: { stone_pickaxe: 1, cobblestone: 30, torch: 8, bread: 4 } })
  r = g.observe(status)
  ok(r.stageCompleted === true, '火把和吃的够了 → 又过一步')

  // 阶段3：挖铁矿（gather，按增量算）
  //
  // 【量已改】原来是"挖够 40 块"，那是"一直待在地下"的直接原因。
  // 现在一趟 12 块就算够 —— 真人挖矿是"这一趟挖到这些就上去"，不是挖满一箱。
  ok(g.stage().kind === 'gather', '第三步是挖矿')
  status = fakeStatus({ inv: { stone_pickaxe: 1, raw_iron: 3 } })
  r = g.observe(status)
  ok(r.ratio > 0.1 && r.ratio < 0.5, '挖到 3 块粗铁，刚起步', g.progressText())

  status = fakeStatus({ inv: { stone_pickaxe: 1, raw_iron: 12 } })
  r = g.observe(status)
  ok(r.stageCompleted === true, '12 块粗铁就够一趟 → 过了一步')

  // 阶段4：必须回地面（surface）
  ok(g.stage().kind === 'surface', '挖完必须先回地面')
  status = fakeStatus({ inv: { stone_pickaxe: 1, raw_iron: 12 }, y: 14 })
  r = g.observe(status)
  ok(r.stageCompleted === false, '还在洞里 y=14，这步不算过', g.progressText())

  status = fakeStatus({ inv: { stone_pickaxe: 1, raw_iron: 12 }, y: 66 })
  r = g.observe(status)
  ok(r.stageCompleted === true, '回到地面 y=66 → 过了一步')

  // 阶段5：在地上烧成铁锭 → 目标完成
  status = fakeStatus({ inv: { stone_pickaxe: 1, raw_iron: 12, iron_ingot: 12 }, y: 66 })
  r = g.observe(status)
  ok(r.goalCompleted === true, '最后一步做完 → 整个目标完成')
  ok(g.goal === null, '完成后手上就空了，准备想下一个')
  ok(g.history.length === 1 && g.history[0].result === 'done', '记进了历史')
  ok(g.cooldown.iron > Date.now(), '刚做完的方向先冷却一阵')
}

// ================================================================
console.log('\n[四、进度存盘：重启后接着干]')
{
  const dir = tmp()
  const llm = fakeLLM(JSON.stringify({ key: 'house', title: '攒够材料盖个小屋', why: '住山洞不像话' }))
  const g1 = new Goals(dir, { llm, ctx: { log } })
  let status = fakeStatus({ inv: { wooden_pickaxe: 1, cobblestone: 60, oak_log: 20 } })
  await g1.ensure(status)

  // 推到第二步（备料）一半
  status = fakeStatus({ inv: { wooden_pickaxe: 1, cobblestone: 60, oak_log: 20 } })
  g1.observe(status)                              // 第一步是 do，需要 work
  g1.addWork(1)
  g1.observe(status)                              // 过第一步
  const idxBefore = g1.goal.stageIndex
  const stageBefore = g1.currentText()
  const titleBefore = g1.goal.title

  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'goals.json'), 'utf8'))
  ok(saved.goal && saved.goal.title === titleBefore, '进度写进了 goals.json')
  ok(saved.version === 1, '带版本号')

  // —— 模拟下线再上线：新的实例，同一个目录 ——
  const llm2 = fakeLLM('{"key":"custom"}')        // 如果它去问模型，说明没读回来
  const g2 = new Goals(dir, { llm: llm2, ctx: { log } })
  ok(g2.goal !== null, '重启后目标还在')
  ok(g2.goal.title === titleBefore, '目标名字一样', g2.goal.title)
  ok(g2.goal.stageIndex === idxBefore, '进度还是那一步', String(g2.goal.stageIndex))
  ok(g2.currentText() === stageBefore, '当下该干的事没变', g2.currentText())

  await g2.ensure(fakeStatus({}))
  ok(llm2.calls === 0, '有目标在，不会重新问模型')

  console.log('\n    重启前：' + titleBefore + ' / ' + stageBefore)
  console.log('    重启后：' + g2.goal.title + ' / ' + g2.currentText())
}

// ================================================================
console.log('\n[五、自己发明的目标（不在候选池里）]')
{
  const dir = tmp()
  const llm = fakeLLM(JSON.stringify({
    key: 'custom',
    title: '把河边那块地用栅栏围起来当院子',
    why: '那地方看着舒服，想圈起来',
    stages: ['先量一下多大，砍够木头', '做栅栏，一根根插上', '装个门，能进能出']
  }))
  const g = new Goals(dir, { llm, ctx: { log } })
  const goal = await g.ensure(fakeStatus({ inv: { stone_axe: 1, oak_log: 24 } }))
  ok(!!goal, '模型能自己发明一个目标')
  ok(goal.title === '把河边那块地用栅栏围起来当院子', '用的是他原话', goal.title)
  ok(goal.stages.length === 3, '自己说的三步都留下了', goal.stages.length + ' 个')
  ok(goal.stages[0].title.includes('木头'), '阶段文字没被机械化')
  ok(goal.stages.every(s => ['gather', 'craft', 'depth', 'travel', 'do', 'build'].includes(s.kind)), '补上了可验收的 kind')
  console.log('\n    自己想的：' + goal.title)
  goal.stages.forEach((s, i) => console.log(`      ${i + 1}. ${s.title}`))
}

// ================================================================
console.log('\n[六、干不下去就放弃]')
{
  const dir = tmp()
  let t = 1000000
  const clock = () => t
  const llm = fakeLLM(JSON.stringify({ key: 'diamond', title: '一直往下挖，挖到钻石', why: '想自己看一眼' }))
  const g = new Goals(dir, { llm, ctx: { log }, now: clock, cfg: { stallMs: 60 * 60 * 1000 } })
  await g.ensure(fakeStatus({ inv: { stone_pickaxe: 1 }, y: 70 }))

  // 一直没进展，时间往前走
  t += 61 * 60 * 1000
  const r = g.observe(fakeStatus({ inv: { stone_pickaxe: 1 }, y: 70 }))
  ok(r.abandoned === true, '一小时没动静 → 放弃了')
  ok(g.goal === null, '手上清空了')
  ok(g.history.some(h => h.result === 'abandoned'), '记下了为什么放弃')
  ok(g.cooldown.diamond > t, '刚放弃的方向先进冷却')

  const cands = g.candidates(fakeStatus({ inv: { stone_pickaxe: 1 }, y: 70 }))
  ok(!cands.some(c => c.key === 'diamond'), '冷却期内不会再挑同一个')

  const goal2 = await g.ensure(fakeStatus({ inv: { stone_pickaxe: 1 }, y: 70 }))
  ok(!!goal2 && goal2.key !== 'diamond', '换了个别的事干', goal2.title)
}

// ================================================================
console.log('\n[七、反复失败也会放弃]')
{
  const dir = tmp()
  const llm = fakeLLM(JSON.stringify({ key: 'tower', title: '搭个高台看看四周', why: '想看清楚' }))
  const g = new Goals(dir, { llm, ctx: { log }, cfg: { maxFails: 3 } })
  const status = fakeStatus({ inv: { stone_pickaxe: 1 } })
  await g.ensure(status)

  let res
  for (let i = 0; i < 3; i++) res = g.onTaskResult({ ok: false, text: '卡住了', status })
  ok(res.abandoned === true, '同一阶段失败 3 次 → 放弃')
  ok(g.history[g.history.length - 1].reason.includes('3 次'), '理由写得清楚')
}

// ================================================================
console.log('\n[八、模型挂了也能干活]')
{
  const dir = tmp()
  const bad = { async chat () { throw new Error('模型超时') } }
  const g = new Goals(dir, { llm: bad, ctx: { log } })
  const goal = await g.ensure(fakeStatus({ inv: { wooden_pickaxe: 1, oak_log: 20, cobblestone: 40 } }))
  ok(!!goal, '模型出错也有目标')
  ok(goal.stages.length >= 3, '还是拆成了多步')
  ok(g.current() !== null, 'current() 照常给东西')

  // 连 llm 都没有
  const g2 = new Goals(tmp(), { ctx: { log } })
  const goal2 = await g2.ensure(fakeStatus({ inv: { stone_pickaxe: 1 } }))
  ok(!!goal2, '完全没模型也能立目标')
  console.log('\n    兜底挑的：' + goal2.title)
}

// ================================================================
console.log('\n[九、可行性：本事不够就别想太远]')
{
  const g = new Goals(tmp(), { ctx: { log } })
  const noTool = g.candidates(fakeStatus({ inv: {} }))
  const ironTool = g.candidates(fakeStatus({ inv: { iron_pickaxe: 1, torch: 10 } }))

  const d1 = noTool.find(c => c.key === 'diamond')
  const d2 = ironTool.find(c => c.key === 'diamond')
  ok(d2.score > d1.score, '有铁镐的时候，挖钻石更现实', `${d1.score} → ${d2.score}`)

  const i1 = noTool.find(c => c.key === 'iron')
  const i2 = ironTool.find(c => c.key === 'iron')
  ok(i2.score > i1.score, '有铁镐的时候，攒铁更现实', `${i1.score} → ${i2.score}`)
}

// ================================================================
console.log('\n[十、给 will 的接口形状]')
{
  const dir = tmp()
  const llm = fakeLLM(JSON.stringify({ key: 'farm', title: '开块地种点吃的', why: '老靠打猎不行' }))
  const g = new Goals(dir, { llm, ctx: { log } })
  await g.ensure(fakeStatus({ inv: { wooden_hoe: 1 } }))
  const cur = g.current()
  ok(typeof cur.text === 'string' && cur.text.length > 0, '有 text')
  ok(typeof cur.since === 'number', '有 since')
  ok(cur.done === false, 'done 是 false')
  ok(typeof g.status().title === 'string', 'status() 能直接给上层显示')
  ok(typeof g.summary() === 'string', 'summary() 能进长期记忆')
}

// ================================================================
console.log('\n[十一、完整演示：一个目标从生到完]')
{
  const dir = tmp()
  const llm = fakeLLM(JSON.stringify({
    key: 'house',
    title: '攒够材料盖个小屋',
    why: '一直住山洞不像话，想有个自己的地方'
  }))
  const g = new Goals(dir, { llm, ctx: { log } })

  let inv = { wooden_pickaxe: 1, oak_log: 8 }
  let status = fakeStatus({ inv, y: 68 })
  await g.ensure(status)

  console.log('\n    长期目标：' + g.goal.title)
  console.log('    为什么：' + g.goal.why)
  console.log('    拆解：')
  g.plan().forEach(p => console.log(`      阶段${p.index + 1} ${p.title}（${p.kind}）`))

  // 一步步推进（起始背包：木镐 1、木头 8）
  const steps = [
    { note: '把地面收拾出来', inv: { wooden_pickaxe: 1, oak_log: 8 }, work: 1 },
    { note: '备料：又砍了 16 根木头、挖了 48 块石头', inv: { wooden_pickaxe: 1, oak_log: 24, cobblestone: 48 } },
    { note: '立墙', inv: { wooden_pickaxe: 1, oak_log: 24, cobblestone: 48 }, work: 1 },
    { note: '封顶装门', inv: { wooden_pickaxe: 1, oak_log: 24, cobblestone: 48 }, work: 1 }
  ]
  for (const st of steps) {
    status = fakeStatus({ inv: st.inv, y: 68 })
    if (st.work) g.addWork(st.work)
    const r = g.observe(status)
    const at = g.goal ? `第 ${g.goal.stageIndex + 1} 步` : '收工'
    console.log(`    · ${st.note} → ${at}` +
      (r.goalCompleted ? '，整个目标做完了' : r.stageCompleted ? '，过了一步' : ''))
  }

  ok(g.goal === null, '演示跑完，目标收工')
  ok(g.history.length === 1, '历史里有这一条')
  console.log('    结果：' + g.history[0].title + ' —— 用了 ' + g.history[0].stages + ' 步')
}

// ================================================================
}

main().then(() => {
  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过，${fail} 失败\n`)
  process.exit(fail ? 1 : 0)
}).catch(e => {
  console.error('\n测试崩了：' + (e && e.stack || e))
  process.exit(1)
})
