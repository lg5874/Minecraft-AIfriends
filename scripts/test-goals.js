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
  ok(g.currentStage().kind === 'craft', '第一步是弄工具')
  let r = g.observe(status)
  ok(r.ratio < 1, '还没石镐，进度不满', String(r.ratio))

  // 做出石镐
  status = fakeStatus({ inv: { wooden_pickaxe: 1, stone_pickaxe: 1, cobblestone: 30 } })
  r = g.observe(status)
  ok(r.stageCompleted === true, '做出石镐 → 过了一步')
  ok(g.goal.stageIndex === 1, '进到第二步')

  // 阶段2：带火把和吃的（gather）
  ok(g.currentStage().kind === 'gather', '第二步是备料')
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
  ok(g.currentStage().kind === 'gather', '第三步是挖矿')
  status = fakeStatus({ inv: { stone_pickaxe: 1, raw_iron: 3 } })
  r = g.observe(status)
  ok(r.ratio > 0.1 && r.ratio < 0.5, '挖到 3 块粗铁，刚起步', g.progressText())

  status = fakeStatus({ inv: { stone_pickaxe: 1, raw_iron: 12 } })
  r = g.observe(status)
  ok(r.stageCompleted === true, '12 块粗铁就够一趟 → 过了一步')

  // 阶段4：必须回地面（surface）
  ok(g.currentStage().kind === 'surface', '挖完必须先回地面')
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
console.log('\n[七、反复失败：先换法子，几条路都不行才放弃（也不能几秒就放弃）]')
{
  const dir = tmp()
  let t = 1000000
  const logs = []
  const llm = fakeLLM(JSON.stringify({ key: 'tower', title: '搭个高台看看四周', why: '想看清楚' }))
  const g = new Goals(dir, { llm, ctx: { log: (x) => logs.push(x) }, now: () => t })
  const status = fakeStatus({ inv: { stone_pickaxe: 1 } })
  await g.ensure(status)

  // 前两遍失败：还按原计划（第一次失败就换 = 假）
  let r = g.onTaskResult({ ok: false, text: '卡住了', status })
  ok(g.currentStage().methodIndex === 0, '第 1 遍失败：不换（一失败就换也假）')
  r = g.onTaskResult({ ok: false, text: '卡住了', status })
  ok(g.currentStage().methodIndex === 1, '第 2 遍还不行 → 换法子', String(r.switched))
  ok(!!g.goal, '目标还在')
  ok(/换个法子/.test(g.current().text), '发下去的活变了', g.current().text)

  // 一路失败到三条路都试完
  for (let i = 0; i < 8; i++) { t += 1600; r = g.onTaskResult({ ok: false, text: '又卡住了', status }) }
  ok(g.currentStage().parked === true || r.abandoned === true, '几条路都走不通 → 先搁着（还没到 5 分钟）')

  // 不到最低寿命，不许扔
  ok(!!g.goal, '才几分钟，目标还在手上')

  // 过了最低寿命，同样的失败就该认账
  t += 5 * 60 * 1000
  r = g.onTaskResult({ ok: false, text: '还是不成', status })
  ok(r.abandoned === true, '过了 5 分钟 → 放弃')
  ok(/几条路|次都不行/.test(g.history[g.history.length - 1].reason), '理由写得清楚', g.history[g.history.length - 1].reason)
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
  // 【改成边盖边攒之后是 7 步：do / 8石6木 / do / 16石6木 / do / 24石4木 / do】
  const steps = [
    { note: '把地面收拾出来', inv: { wooden_pickaxe: 1, oak_log: 8 }, work: 1 },
    { note: '先攒一小堆（8 石 6 木）', inv: { wooden_pickaxe: 1, oak_log: 14, cobblestone: 8 } },
    { note: '先搭个小矮墙', inv: { wooden_pickaxe: 1, oak_log: 14, cobblestone: 8 }, work: 1 },
    { note: '再补一轮（+16 石 6 木）', inv: { wooden_pickaxe: 1, oak_log: 20, cobblestone: 24 } },
    { note: '扩一圈接墙', inv: { wooden_pickaxe: 1, oak_log: 20, cobblestone: 24 }, work: 1 },
    { note: '最后补一轮（+24 石 4 木）', inv: { wooden_pickaxe: 1, oak_log: 24, cobblestone: 48 } },
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
console.log('\n[十二、#7：同一个阶段不连做 5 遍，第 2 遍没动就换法子]')
{
  const dir = tmp()
  let t = 2000000
  const llm = fakeLLM(JSON.stringify({ key: 'tower', title: '搭个高台看看四周', why: '想看清楚' }))
  const g = new Goals(dir, { llm, ctx: { log: (s) => logs.push(s) }, now: () => t })
  const logs = []
  // 背包里没有垫脚石：这一阶段怎么弄都不会有进展（#8 的假成功）
  const status = fakeStatus({ inv: { stone_pickaxe: 1 } })
  await g.ensure(status)
  const title = g.currentStage().title

  const attempt = () => { t += 1600; return g.onTaskResult({ ok: true, text: '成了', status }) }

  attempt()
  ok(g.currentStage().methodIndex === 0, '第 1 遍：还按原计划')
  const r2 = attempt()
  ok(g.currentStage().methodIndex === 1, '第 2 遍没进展 → 换法子（不是放弃目标）', String(r2.switched))
  ok(!!g.goal, '目标还在')
  ok(/换个法子/.test(g.current().text), '交给上层的话变了', g.current().text)

  // 第 3 遍：总账到 3 -> 该换目标了；还没到 5 分钟，所以先搁着
  const r3 = attempt()
  ok(g.currentStage().parked === true, '第 3 遍还不行 → 搁着（5 分钟闸门没过，先不扔）', JSON.stringify(r3))
  ok(!!g.goal, '搁着的时候目标还在')
  ok(/放一放|转转|坐一会儿|归置/.test(g.current().text), '搁着时给的是"干点别的"', g.current().text)

  // 同一个任务文本连续出现最多几遍
  // 按真实节奏：每趟任务取一次文本（current 在同一趟里是稳定的）
  const texts = []
  for (let i = 0; i < 20; i++) { texts.push(g.current().text); attempt() }
  let run = 1
  let maxRun = 1
  for (let i = 1; i < texts.length; i++) {
    if (texts[i] === texts[i - 1]) { run++; maxRun = Math.max(maxRun, run) } else run = 1
  }
  ok(maxRun <= 2, '同一句话不会连着重复 5 遍', '最多 ' + maxRun + ' 遍')

  // 过了最低寿命，这条走不通的路才被放下
  t += 5 * 60 * 1000
  const rEnd = attempt()
  ok(rEnd.abandoned === true, '过了 5 分钟 → 放弃这个目标')
  ok(/几条路|趟|次都不行/.test(g.history[g.history.length - 1].reason), '放弃的理由说得清', g.history[g.history.length - 1].reason)

  const switchLogs = logs.filter(s => /换法子/.test(s))
  ok(switchLogs.length >= 1, '换法子有日志（写清换什么/为什么）', String(switchLogs.length))
  console.log('    ' + switchLogs[0])
  ok(/「.+」→「.+」/.test(switchLogs[0] || ''), '日志里写明了从哪条路换到哪条路')
}

// ================================================================
console.log('\n[十三、层3：真实增量 —— 存量不算、没证据不算]')
{
  // 1) craft：手上本来就有，不代表这一阶段做完了
  const mk = async (key, inv) => {
    const llm = fakeLLM(JSON.stringify({ key, title: 'x' + key, why: 'y' }))
    const g = new Goals(tmp(), { llm, ctx: { log: () => {} } })
    await g.ensure(fakeStatus({ inv }))
    return g
  }
  const gIron = await mk('iron', { stone_pickaxe: 1, iron_pickaxe: 1 })
  ok(gIron.currentStage().kind === 'craft', 'iron 第 1 步是 craft')
  const pIron = Goals.stageProgress(gIron.currentStage(), fakeStatus({ inv: { stone_pickaxe: 1, iron_pickaxe: 1 } }))
  ok(pIron.trivial === true, '开局就有石镐 → 这一步"不用做"（跳过，不算他做到）', JSON.stringify(pIron))
  const gIron2 = await mk('iron', { cobblestone: 20 })
  const pIron2 = Goals.stageProgress(gIron2.currentStage(), fakeStatus({ inv: { cobblestone: 20 } }))
  ok(pIron2.ratio === 0 && !pIron2.trivial, '手上没有石镐 → 必须真的做出来才算', JSON.stringify(pIron2))

  // 2) gather：开局有 130 块圆石，也不算攒够
  const gTower = await mk('tower', { cobblestone: 130 })
  const sT = gTower.currentStage()
  ok(sT.kind === 'gather', 'tower 第 1 步是 gather')
  ok(Goals.stageProgress(sT, fakeStatus({ inv: { cobblestone: 130 } })).ratio === 0,
    '开局 130 块圆石 → 这一步也不算做完')

  // 3) 真的多出来 48 块 → 才过
  ok(Goals.stageProgress(sT, fakeStatus({ inv: { cobblestone: 178 } })).ratio === 1,
    '真的多挖了 48 块 → 过')

  // 4) do：报"完成"但不给增量 → 不推进
  const gHouse = await mk('house', { wooden_pickaxe: 1 })
  const beforeIdx = gHouse.goal.stageIndex
  gHouse.onTaskResult({ ok: true, text: '把地面收拾好了', status: fakeStatus({ inv: { wooden_pickaxe: 1 } }) })
  ok(gHouse.goal.stageIndex === beforeIdx, 'do 阶段：没给 progress → 不白送')
  ok(gHouse.currentStage().noProof >= 1, '记了一次"拿不出硬证据"', String(gHouse.currentStage().noProof))
  gHouse.onTaskResult({ ok: true, text: '收拾好了', status: fakeStatus({ inv: { wooden_pickaxe: 1 } }), progress: 1 })
  ok(gHouse.goal.stageIndex === beforeIdx + 1, '给了真实增量 → 才过这一步')

  // 5) surface：一开始就在地面上，是"没走过"，不是"做到了"
  const pTrivial = Goals.stageProgress(
    { kind: 'surface', need: { y: 58 }, base: { ug: false, y: 70 } },
    { pos: { x: 0, y: 70, z: 0 }, underground: false, inventory: {} }
  )
  ok(pTrivial.trivial === true, 'surface：一开始就在外面 → 标成"本来就不用做"')
  const pReal = Goals.stageProgress(
    { kind: 'surface', need: { y: 58 }, base: { ug: true, y: 20 } },
    { pos: { x: 0, y: 70, z: 0 }, underground: false, inventory: {} }
  )
  ok(pReal.ratio === 1 && !pReal.trivial, 'surface：真从下面上来了 → 才算到')
}


// ================================================================
console.log('\n[十四、stage() 是声明式候选池，不是命令]')
{
  const llm = fakeLLM(JSON.stringify({ key: 'tower', title: '搭个高台看看四周', why: '想看清楚' }))
  const g = new Goals(tmp(), { llm, ctx: { log: () => {} } })
  await g.ensure(fakeStatus({ inv: { stone_pickaxe: 1, cobblestone: 5 } }))

  const pool = g.stage()
  ok(Array.isArray(pool), 'stage() 返回的是池子（数组），不是"下一步做 X"', typeof pool)
  ok(pool.length === g.goal.stages.length, '池子里是这次的全部步骤', String(pool.length))
  ok(pool.every(x => x.state), '每条都带状态（done/current/later）')
  ok(pool[0].state === 'current' && pool[1].state === 'later', '第一条是当前的，后面的还是 later')
  ok(pool.every(x => Array.isArray(x.prereqs)), '每条都说清前置条件')
  ok(pool.every(x => Array.isArray(x.ways) && x.ways.length >= 1), '每条都给出可选的干法')
  ok(!('score' in pool[0]) && !('priority' in pool[0]), '不带排序/优先级 —— 排序是 session 的事')
  ok(!('text' in pool[0]) || !/(先|去|赶紧)/.test(String(pool[0].text || '')), '没有"下命令"的字段')

  // 条件按增量算：手上 5 块圆石 ≠ 攒够 40
  const first = pool[0]
  const stone = first.prereqs.find(r => /surfacestone|石头/.test(r.what + r.text))
  ok(!!stone && stone.ok === false, '前置条件说"还不够"', JSON.stringify(stone || {}))

  // 开局就有 130 块老石头：这一阶段仍然是 0/40（存量不算）
  const g2 = new Goals(tmp(), { llm: fakeLLM(JSON.stringify({ key: 'tower', title: '搭个高台', why: '想看远' })), ctx: { log: () => {} } })
  await g2.ensure(fakeStatus({ inv: { stone_pickaxe: 1, cobblestone: 130 } }))
  const stone2 = g2.stage()[0].prereqs.find(r => /surfacestone|石头/.test(r.what + r.text))
  ok(!!stone2 && stone2.ok === false, '开局 130 块老石头 → 池子里还是不够（存量不算）', JSON.stringify(stone2 || {}))

  // 这一步里真的多弄到 40 块，条件才成立
  const st2 = fakeStatus({ inv: { stone_pickaxe: 1, cobblestone: 45 } })
  g.observe(st2)
  const pool3 = g.stage()
  ok(pool3[0].progress !== null, '当前这一步带"上次进展"')
  ok(pool3[1].state === 'current' || pool3[0].state === 'done', '攒够之后这一步就过去了', pool3[0].state)

  console.log('    池子：')
  pool3.forEach(x => console.log(`      ${x.index + 1}. [${x.state}] ${x.title}  ready=${x.ready}` +
    (x.blockedBy.length ? '  差：' + x.blockedBy.join('；') : '') +
    (x.progress ? `  进度=${(x.progress.ratio * 100).toFixed(0)}%` : '')))
}


// ================================================================
console.log('\n[十五、P0：地表石头、钻石深度、火把顺序]')
{
  // P0-1 深板岩不算地表石头
  const G = require('../src/goals')
  const n1 = G.itemCount({ cobbled_deepslate: 40 }, '#surfacestone')
  const n2 = G.itemCount({ cobblestone: 20, stone: 5, cobbled_deepslate: 40 }, '#surfacestone')
  ok(n1 === 0, '深板岩不算地表石头（y<0 才有，地表挖不到）', String(n1))
  ok(n2 === 25, '圆石 + 石头还算', String(n2))

  // P0-2 / P0-3 钻石目标：火把在下去之前，深度是 1.18+ 的真实分布
  const POOL = G.POOL
  const dia = POOL.find(g => g.key === 'diamond')
  const depth = dia.stages.find(s => s.kind === 'depth')
  const torchIdx = dia.stages.findIndex(s => s.need && s.need.torch)
  const depthIdx = dia.stages.findIndex(s => s.kind === 'depth')
  ok(depth.need.y === -54, '钻石的深度是 y=-54（1.18+ 峰值 -58/-59）', String(depth.need.y))
  ok(torchIdx >= 0 && torchIdx < depthIdx, '火把在下去之前备好', `torch@${torchIdx} depth@${depthIdx}`)

  const iron = POOL.find(g => g.key === 'iron')
  const ironTorch = iron.stages.findIndex(s => s.need && s.need.torch)
  const ironMine = iron.stages.findIndex(s => s.need && s.need.raw_iron)
  ok(ironTorch >= 0 && ironTorch < ironMine, '铁的流程里火把也在下矿之前', `torch@${ironTorch} mine@${ironMine}`)
  console.log('    diamond：' + dia.stages.map(s => s.title).join(' → '))
  console.log('    iron   ：' + iron.stages.map(s => s.title).join(' → '))
}


// ================================================================
console.log('\n[十六、歇着的时候不发活（任务调度要问心情）]')
{
  const mood = { resting: false }
  const llm = fakeLLM(JSON.stringify({ key: 'tower', title: '搭个高台', why: '想看远' }))
  const g = new Goals(tmp(), { llm, ctx: { log: () => {}, mood } })

  // 正常状态：能立目标
  const goal = await g.ensure(fakeStatus({ inv: { stone_pickaxe: 1 } }))
  ok(!!goal, '没在歇着 → 正常立目标')

  // 进入休息
  mood.resting = true
  ok(g.isResting() === true, '能读到 mood.resting')
  ok(g.candidates(fakeStatus({ inv: { stone_pickaxe: 1 } })).length === 0, '歇着 → 方向池是空的（不产出新目标）')
  const cur = g.current()
  ok(cur && cur.resting === true, '歇着 → current() 给的是"歇着"', JSON.stringify(cur && cur.text))
  ok(!/石头|矿|镐/.test(cur.text), '不会再把攒料/挖矿的活发出去', cur.text)
  ok(/歇/.test(g.promptBlock()), '提示词里也说在歇着')

  // 手上原本的目标没被扔掉
  const keep = await g.ensure(fakeStatus({ inv: { stone_pickaxe: 1 } }))
  ok(keep === goal, '歇着不扔已有的目标（只是先不干）')

  // 休息窗口里：在途任务回报只记账，不换法子、不改主意
  {
    const m2 = { resting: false }
    const llm = fakeLLM(JSON.stringify({ key: 'tower', title: '搭个高台', why: '想看远' }))
    const g3 = new Goals(tmp(), { llm, ctx: { log: () => {}, mood: m2 } })
    const st = fakeStatus({ inv: { stone_pickaxe: 1 } })
    await g3.ensure(st)
    m2.resting = true
    const r1 = g3.onTaskResult({ ok: true, text: '成了', status: st })
    ok(r1.resting === true, '歇着时任务回报 → 只记账', JSON.stringify(r1))
    ok(g3.currentStage().idleWins === 1, '账还是记着的（只是不做决定）', String(g3.currentStage().idleWins))
    ok(g3.currentStage().methodIndex === 0, '歇着时不换法子（休息窗口不偷步）', String(g3.currentStage().methodIndex))
    m2.resting = false
    g3.onTaskResult({ ok: true, text: '成了', status: st })
    ok(g3.currentStage().methodIndex === 1, '醒过来之后才按趟数换法子', String(g3.currentStage().methodIndex))
  }

  // 收工（session.phase === 'resting'）也算"歇着"
  {
    const gRest = new Goals(tmp(), { ctx: { log: () => {}, session: { phase: 'resting' } } })
    ok(gRest.isResting() === true, 'session 收工了 → goals 也不再派人（只读 session 状态）')
    ok(gRest.current() && gRest.current().resting === true, '收工时 current() 给的是"歇着"')
    const gWork = new Goals(tmp(), { ctx: { log: () => {}, session: { phase: 'working', isTodayDone: () => false } } })
    ok(gWork.isResting() === false, 'session 在上班 → 照常干活')
    const gDone = new Goals(tmp(), { ctx: { log: () => {}, session: { phase: 'working', isTodayDone: () => true } } })
    ok(gDone.isResting() === true, 'todayDone 也算收工')
  }

  // main.js 没往 ctx 里传 mood 的情况：从 mood.active() 读（只读）
  {
    const Mood = require('../src/mood')
    const live = new Mood(tmp())
    live.resting = true
    const g2 = new Goals(tmp(), { ctx: { log: () => {} } })  // 注意：没有 mood
    ok(g2.isResting() === true, 'ctx 里没有 mood 时，能读到进程里那个 mood 的休息状态')
    live.resting = false
    ok(g2.isResting() === false, '歇够了也能读到')
  }

  // 歇够了：接着干
  mood.resting = false
  const cur2 = g.current()
  ok(cur2 && cur2.resting !== true, '歇够了 → 又发活了', cur2 && cur2.text)
  console.log('    歇够之后发的是：' + (cur2 && cur2.text))
}


// ================================================================
console.log('\n[十七、house 边盖边攒 / getup 拆成爬高度+找露天]')
{
  const POOL = Goals.POOL
  const house = POOL.find(g => g.key === 'house')
  const gs = house.stages
  const gathers = gs.filter(x => x.kind === 'gather')
  const stone = gathers.reduce((a, x) => a + (x.need['#surfacestone'] || 0), 0)
  const logs = gathers.reduce((a, x) => a + (x.need['#log'] || 0), 0)
  ok(gs.length >= 6, 'house 拆成了多步（边盖边攒）', gs.length + ' 步')
  ok(gathers.length >= 3, '备料拆成 3 轮', String(gathers.length))
  ok(stone === 48 && logs === 16, '总料还是 48 石 + 16 木（只是分三轮）', `${stone}/${logs}`)
  ok(gathers.every(x => x.need['#surfacestone'] <= 24), '每一轮都不超过 24 块（一口气攒得动）')
  // 每轮备料后面都跟着一段建造
  ok(gs[gs.length - 1].kind === 'do', '最后一段是建造，不是攒料')

  // 天黑 / 血少 → house 更想盖
  const dayInv = { stone_pickaxe: 1, oak_log: 10 }
  const day = house.score({ inventory: dayInv, time: '白天', health: 20 })
  const night = house.score({ inventory: dayInv, time: '夜', health: 20 })
  const hurt = house.score({ inventory: dayInv, time: '白天', health: 6 })
  ok(night > day, '夜里更想有个能关门的地方', `${day} → ${night}`)
  ok(hurt >= day, '血少也会想盖', `${day} → ${hurt}`)

  const getup = POOL.find(g => g.key === 'getup')
  ok(getup.stages[0].kind === 'climb', 'getup 第一步是"往上爬高度"（做得到的事）', getup.stages[0].kind)
  ok(getup.stages[1].kind === 'surface', '第二步才是"找到露天"', getup.stages[1].kind)

  const climb = { kind: 'climb', need: { y: 58 }, base: { y: 42 } }
  const at = (y) => ({ pos: { x: 0, y, z: 0 }, inventory: {}, underground: true })
  ok(Goals.stageProgress(climb, at(42)).ratio === 0, 'climb：还没动')
  ok(Math.abs(Goals.stageProgress(climb, at(50)).ratio - 0.5) < 0.01, 'climb：爬到一半就算一半')
  ok(Goals.stageProgress(climb, at(58)).ratio === 1, 'climb：到高度就算这一步做到')
  console.log('    house：' + gs.map(x => x.title).join(' → '))
  console.log('    getup：' + getup.stages.map(x => x.title).join(' → '))
}


// ================================================================
console.log('\n[十八、地表头上被遮挡 ≠ 在地下（house 不该被无辜扣 25）]')
{
  const g = new Goals(tmp(), { ctx: { log: () => {} } })
  const tree = { pos: { x: 69, y: 68, z: 1 }, health: 20, food: 20, inventory: {}, time: '白天', underground: true }
  const deep = { pos: { x: 0, y: 40, z: 0 }, health: 20, food: 20, inventory: {}, time: '白天', underground: true }
  const flat = { pos: { x: 69, y: 68, z: 1 }, health: 20, food: 20, inventory: {}, time: '白天', underground: false }

  const hTree = g.candidates(tree).find(c => c.key === 'house')
  const hDeep = g.candidates(deep).find(c => c.key === 'house')
  const hFlat = g.candidates(flat).find(c => c.key === 'house')
  ok(hTree.score === hFlat.score - 8, '站在树底下只扣 8（挪两步的事）', `${hFlat.score} → ${hTree.score}`)
  ok(hDeep.score <= 15, '真的在地面以下 → 盖房压到 15（物理上干不了）', `${hFlat.score} → ${hDeep.score}`)
  // 关键判据：洞里「盖房」必须低于「上去」
  const caveInv = { stone_pickaxe: 1, iron_pickaxe: 1, cobblestone: 130, oak_log: 26 }
  for (const time of ['白天', '夜']) {
    const cave = { pos: { x: 0, y: 42, z: 0 }, health: 20, food: 20, inventory: caveInv, time, underground: true }
    const cs = g.candidates(cave)
    const h = cs.find(c => c.key === 'house')
    const u = cs.find(c => c.key === 'getup')
    ok(h.score < u.score, `洞里（${time}）house < getup（不再"在洞里挑盖房"）`, `house=${h.score} getup=${u.score}`)
  }
  // 地面上要恢复正常
  const surf = { pos: { x: 0, y: 70, z: 0 }, health: 20, food: 20, inventory: caveInv, time: '白天', underground: false }
  const hs = g.candidates(surf).find(c => c.key === 'house')
  ok(hs.score >= 80, '地面 y=70 材料齐 → house 不被误压', String(hs.score))
  ok(g.candidates(tree)[0].key === 'house', '地表被树挡着时 house 仍是首选', g.candidates(tree)[0].key)
  console.log('    树底：' + g.candidates(tree).slice(0, 3).map(c => c.key + '(' + c.score + ')').join(' '))
  console.log('    地下：' + g.candidates(deep).slice(0, 3).map(c => c.key + '(' + c.score + ')').join(' '))
}


// ================================================================
console.log('\n[十九、今天份：攒到一半不许喊够了（实机 4/6 木头就收工）]')
{
  const llm = fakeLLM(JSON.stringify({ key: 'house', title: '盖屋', why: 'x' }))
  const g = new Goals(tmp(), { llm, ctx: { log: () => {} } })
  const st = (inv) => fakeStatus({ inv, y: 70 })
  await g.ensure(st({ stone_pickaxe: 1 }))
  g.goal.stageIndex = 1
  g.goal.stages[1].base = { inv: {}, pos: { x: 0, y: 70, z: 0 }, y: 70 }

  const half = g.dailyQuota(st({ cobblestone: 8, oak_log: 4 }))
  ok(half.reached === false, '8 石 + 4 木（差 2 根）→ 还不该收工', half.text)
  const full = g.dailyQuota(st({ cobblestone: 8, oak_log: 6 }))
  ok(full.reached === true, '8 石 + 6 木 → 这一份够了', full.text)
  console.log('    ' + half.text)
  console.log('    ' + full.text)
}


// ================================================================
console.log('\n[二十、history 记下"立目标时在哪"（排序 bug 的判据）]')
{
  let t = 3000000
  const logs = []
  const llm = fakeLLM(JSON.stringify({ key: 'iron', title: '挖铁', why: 'x' }))
  const g = new Goals(tmp(), { llm, ctx: { log: (x) => logs.push(x) }, now: () => t })
  await g.ensure(fakeStatus({ inv: { stone_pickaxe: 1 }, y: 42 }))
  ok(g.goal.createdY === 42, '目标上记着立的时候 y=42', String(g.goal.createdY))
  ok(g.goal.createdUnderground === true, '也记着当时在地下')
  t += 6 * 60 * 1000
  g.abandon('测试')
  const h = g.history[g.history.length - 1]
  ok(h.y === 42 && h.underground === true, 'history 里有 y / underground', JSON.stringify({ y: h.y, ug: h.underground }))
  ok('yNow' in h && 'undergroundNow' in h, '也记了扔的时候在哪', JSON.stringify({ yNow: h.yNow, ugNow: h.undergroundNow }))
  console.log('    ' + JSON.stringify(h))
}

// ================================================================
console.log('\n[二十一、gather 进度用峰值：挖到就算、消耗不倒退、开局不白送]')
{
  const P = Goals.stageProgress
  const st = (need, baseInv) => ({
    kind: 'gather',
    need,
    base: { inv: Object.assign({}, baseInv), peak: {} }
  })
  const inv = (o) => ({ inventory: o })

  // 1. 挖到比开局多 8 块 -> 1
  {
    const s = st({ '#surfacestone': 8 }, {})
    const p = P(s, inv({ cobblestone: 8 }))
    ok(p.ratio === 1, '挖到 8 块（需求 8）→ ratio=1', String(p.ratio))
  }

  // 2. 挖到 10 后消耗到 5 -> 仍是 1
  {
    const s = st({ '#surfacestone': 8 }, {})
    P(s, inv({ cobblestone: 10 }))
    const p = P(s, inv({ cobblestone: 5 }))
    ok(p.ratio === 1, '挖到 10 再消耗到 5 → ratio 仍是 1（不倒退）', String(p.ratio))
  }

  // 3. 开局 170 块，一块没挖 -> 0
  {
    const s = st({ '#surfacestone': 8 }, { cobblestone: 170 })
    const p = P(s, inv({ cobblestone: 170 }))
    ok(p.ratio === 0, '开局 170 块、一块没挖 → ratio=0（不白送）', String(p.ratio))
  }

  // 4. 挖到 4 块（需求 8）-> 0.5
  {
    const s = st({ '#surfacestone': 8 }, {})
    const p = P(s, inv({ cobblestone: 4 }))
    ok(Math.abs(p.ratio - 0.5) < 1e-9, '挖到 4 块（需求 8）→ ratio=0.5', p.ratio.toFixed(3))
  }

  // 5. 关键：挖到 8 → 消耗到 2 → 再挖 3（到 5），peak 仍是 8
  {
    const s = st({ '#surfacestone': 8 }, {})
    P(s, inv({ cobblestone: 8 }))
    P(s, inv({ cobblestone: 2 }))
    const p = P(s, inv({ cobblestone: 5 }))
    ok(s.base.peak['#surfacestone'] === 8, '消耗后再挖，peak 取历史最大值 8', JSON.stringify(s.base.peak))
    ok(p.ratio === 1, '消耗后再挖 3 块（到 5）→ ratio 仍是 1', String(p.ratio))
  }

  // 6. 多个 key 分别记峰值，用光也不倒退
  {
    const s = st({ '#surfacestone': 8, '#log': 6 }, {})
    P(s, inv({ cobblestone: 8, oak_log: 6 }))
    const p = P(s, inv({ cobblestone: 0, oak_log: 0 }))
    ok(p.ratio === 1, '石头和木头都攒够后全用光 → ratio 仍是 1', p.text)
  }

  // 7. #surfacestone 认 diorite / andesite / granite
  {
    const n1 = Goals.itemCount({ cobblestone: 3, diorite: 5 }, '#surfacestone')
    ok(n1 === 8, '背包 {cobblestone:3, diorite:5} → #surfacestone=8（不是 3）', String(n1))
    const n2 = Goals.itemCount({ cobblestone: 3, andesite: 2, granite: 1 }, '#surfacestone')
    ok(n2 === 6, 'andesite / granite 也算地表石头', String(n2))
  }

  // 8. 深板岩仍然排除
  {
    const n3 = Goals.itemCount({ cobblestone: 3, cobbled_deepslate: 10, deepslate: 4 }, '#surfacestone')
    ok(n3 === 3, 'cobbled_deepslate / deepslate 不算地表石头', String(n3))
  }

  // 9. dailyQuota 用同一口径：消耗后不倒退
  {
    const g = new Goals(tmp(), { ctx: { log: () => {} } })
    const s = st({ '#surfacestone': 8 }, {})
    g.goal = { stages: [s], stageIndex: 0 }
    const q1 = g.dailyQuota({ inventory: { cobblestone: 8 } })
    const q2 = g.dailyQuota({ inventory: { cobblestone: 0 } })
    ok(q1.reached === true && q2.reached === true && s.base.peak['#surfacestone'] === 8,
      '今天份也按峰值算：挖够 8 块后用光，今天份仍算完成', q2.text)
  }
}

// ================================================================
console.log('\n[二十二、出生点没树：explore 要能当出口（不需要木镐）]')
{
  const g = new Goals(tmp(), { ctx: { log: () => {} } })
  const st = (inv) => ({ pos: { x: 0, y: 70, z: 0 }, health: 20, food: 18, inventory: inv, time: '白天', underground: false })

  // 没镐、没木头 -> explore 排第一（原来是 house 赢，然后卡在备料）
  const cs = g.candidates(st({}))
  ok(cs[0].key === 'explore', '没镐没木头 → explore 是第一', cs.slice(0, 3).map(c => c.key + '(' + c.score + ')').join(' '))

  // 第一步是纯走路，不需要任何材料
  const ex = Goals.POOL.find(x => x.key === 'explore')
  ok(ex.stages[0].kind === 'travel' && Number(ex.stages[0].need.distance) >= 64,
    'explore 第一步是走路（不烧火把、不砍树）', JSON.stringify(ex.stages[0]))

  // 走路阶段的进度只看位移
  const walk = { kind: 'travel', need: { distance: 80 }, base: { pos: { x: 0, y: 70, z: 0 } } }
  const p = Goals.stageProgress(walk, { pos: { x: 40, y: 70, z: 0 } })
  ok(Math.abs(p.ratio - 0.5) < 1e-9, '走出去 40/80 格 → ratio=0.5（不用工具）', p.ratio.toFixed(3))

  // 有木镐、有木头之后，explore 不该再被硬抬
  const cs2 = g.candidates(st({ wooden_pickaxe: 1, oak_log: 8 }))
  ok(cs2[0].key !== 'explore', '有镐有木头后，explore 不再排第一', cs2[0].key + '(' + cs2[0].score + ')')
}

// ================================================================
console.log('\n[二十三、卡死看门狗 + 连续挖不动 → 强制 explore]')
{
  const mkGoal = (t, actions, over = {}) => {
    const stage = Object.assign({
      kind: 'gather', title: '攒石头', need: { '#surfacestone': 8 },
      base: { inv: {}, peak: {} }, startedAt: t - 120000, evidence: 'world',
      ratio: 0.2, best: 0.2, attempts: 0, fails: 0
    }, over.stage || {})
    const g = new Goals(tmp(), { now: () => t, ctx: { log: () => {}, actions } })
    g.goal = Object.assign({
      key: 'house', title: '盖房', why: 'x', createdAt: t - 180000,
      createdY: 70, createdUnderground: false, stageIndex: 0, stages: [stage],
      attempts: 0, fails: 0, lastProgressAt: t - 60000, journal: [], done: false
    }, over.goal || {})
    g._watchPos = { x: 0, y: 70, z: 0 }
    g._watchMoveAt = t - 60000
    return g
  }
  const st = (x = 0) => ({ pos: { x, y: 70, z: 0 }, health: 20, food: 20, inventory: {}, time: '白天', underground: false })

  // 30 秒没动作、没位移 -> 放弃 + 打断任务
  {
    const t = 5000000
    const actions = { _lastLogAt: t - 60000, cancel: false }
    const g = mkGoal(t, actions)
    const r = g.observe(st(0))
    ok(r.stuck === true && g.goal === null, '30 秒没动作没位移 → 目标放弃（记卡死）', JSON.stringify(r))
    ok(actions.cancel === true, '同时打断正在跑的任务（不会一直占着 busy）')
    const h = g.history[g.history.length - 1]
    ok(h && /卡死/.test(h.reason || ''), 'history 里记了一次卡死', h && h.reason)
  }

  // 有动作日志 -> 不误杀
  {
    const t = 6000000
    const actions = { _lastLogAt: t - 3000, cancel: false }
    const g = mkGoal(t, actions)
    const r = g.observe(st(0))
    ok(r.stuck !== true && g.goal, '3 秒前刚有动作 → 不判卡死', String(r.stuck))
  }

  // 有位移 -> 不误杀（走路可能不刷日志）
  {
    const t = 7000000
    const actions = { _lastLogAt: t - 60000, cancel: false }
    const g = mkGoal(t, actions)
    const r = g.observe(st(3))
    ok(r.stuck !== true && g.goal, '30 秒没日志但有 3 格位移 → 不判卡死', String(r.stuck))
  }

  // actions 连续 3 次挖不动 -> explore 顶上来（冷却中也放行）
  {
    const t = 8000000
    const actions = { _lastLogAt: t, cancel: false, _forceExploreUntil: t + 60000 }
    const g = new Goals(tmp(), { now: () => t, ctx: { log: () => {}, actions } })
    g.cooldown.explore = t + 300000
    const cs = g.candidates({ pos: { x: 0, y: 70, z: 0 }, health: 20, food: 18, inventory: {}, time: '白天', underground: false })
    ok(cs[0] && cs[0].key === 'explore', 'forceExplore 标记 → explore 排第一（冷却中也放行）',
      cs.slice(0, 3).map(c => c.key + '(' + c.score + ')').join(' '))
  }

  // 手上有目标也放下：ensure() 会先扔掉当前目标，再选 explore
  {
    const t = 9000000
    const actions = { _lastLogAt: t, cancel: false, _forceExploreUntil: t + 60000 }
    const g = mkGoal(t, actions)
    g.llm = null
    const ng = await g.ensure(st(0))
    const h = g.history[g.history.length - 1]
    ok(h && /地形挡住/.test(h.reason || '') && ng && ng.key === 'explore',
      '连续被地形挡住 → 放下手上目标，改去 explore',
      JSON.stringify({ history: h && h.reason, goal: ng && ng.key }))
  }
}

// ================================================================
console.log('\n[二十四、rest 死锁出口：血低 + 饿着时不许歇着]')
{
  const st = (hp, food, y = 70) => ({
    pos: { x: 0, y, z: 0 }, health: hp, food,
    inventory: {}, time: '白天', underground: y < 58
  })

  // 判据本身：只放行「血 <8 且饿 <18」这一种组合
  {
    const g = new Goals(tmp(), { ctx: { log: () => {}, mood: { resting: true } } })
    g.lastStatus = { health: 7, food: 17 }
    ok(g.isResting() === false, '血 7 + 饿 17 → 不再 rest（命比歇着重要）')
    g.lastStatus = { health: 7, food: 19 }
    ok(g.isResting() === true, '血 7 但吃饱了（饿 19）→ 仍然 rest')
    g.lastStatus = { health: 12, food: 10 }
    ok(g.isResting() === true, '饿 10 但血 12 → 仍然 rest（不把 rest 整个关掉）')
  }

  // 解除 rest 的同时，得有一条"先弄吃的"把优先级抢过来
  {
    const g = new Goals(tmp(), { ctx: { log: () => {}, mood: { resting: true } } })
    const s = st(7, 17)
    g.lastStatus = s
    const cs = g.candidates(s)
    ok(cs[0] && cs[0].key === 'food', '血 7 + 饿 17 → candidates 第一是 food',
      cs.slice(0, 3).map(c => c.key + '(' + c.score + ')').join(' '))
    ok(g.candidates(st(7, 17, 42))[0].key === 'food', '在地下也照样先找吃的（不被位置扣分压掉）')

    g.llm = null
    const goal = await g.ensure(s)
    ok(goal && goal.key === 'food' && goal.stages.length >= 1, 'ensure 真的立了「先弄点吃的」', goal && goal.key)
  }

  // 正常状态 food 不该冒出来
  {
    const F = Goals.POOL.find(x => x.key === 'food')
    ok(F.score(st(12, 10)) === 0 && F.score(st(7, 19)) === 0 && F.score(st(20, 20)) === 0,
      '血/饿不在临界区 → food 分数为 0')
  }
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
