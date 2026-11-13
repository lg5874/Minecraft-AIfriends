'use strict'
// #8 假成功判据 —— 回归测试（单判定器 src/judge.js 版）
//
// 每条 case 要么来自真实日志，要么是审查报告点名的验收项。
// 判据只允许"世界真的变了"才算成功：话术再漂亮、数字再大，
// 背包/方块/位移/手持/饱食度一个都没动，就是失败。
//
// 跑：node scripts/test-fake-success.js

const path = require('path')
const ROOT = path.join(__dirname, '..')
const { Bot } = require(path.join(ROOT, 'main.js'))
const { Coder } = require(path.join(ROOT, 'src', 'coder.js'))
const judge = require(path.join(ROOT, 'src', 'judge.js'))
const { Goals } = require(path.join(ROOT, 'src', 'goals.js'))

// ---------------- 造世界 ----------------
function makePos (x, y, z) {
  return {
    x, y, z,
    distanceTo (p) { return Math.hypot(x - p.x, y - p.y, z - p.z) },
    clone () { return makePos(x, y, z) }
  }
}

// 一个方块表默认全是 stone 的世界；blockAt 按**绝对坐标**查
function worldBot ({ pos = makePos(0, 64, 0), blocks = {} } = {}) {
  const map = new Map(Object.entries(blocks))
  const bot = {
    entity: { position: pos },
    heldItem: null,
    food: 20,
    blockAt ({ x, y, z }) {
      const k = `${x},${y},${z}`
      return { name: map.has(k) ? map.get(k) : 'stone' }
    },
    inventory: { items: () => [] }
  }
  return bot
}

function invItems (inv) {
  return Object.entries(inv || {}).map(([name, count]) => ({ name, count }))
}

// ---------------- main.verifyTaskEffect 的假 this ----------------
function mainCtx (opts) {
  const {
    goal, beforeInv = {}, afterInv = {}, pos = makePos(0, 64, 0),
    posNow = pos, blocks = {}, worldBefore = null, worldAfter = null,
    heldBefore = null, heldAfter = null, foodBefore = 20, foodAfter = 20,
    undergroundAfter = null,
    // evidence 类型（judge 没有默认分支）：不传就是 world
    evidence = 'world', minSec = 30, elapsedSec = 0,
    healthBefore = 20, healthAfter = 20
  } = opts
  const bot = worldBot({ pos: posNow, blocks })
  // 背包必须挂上 afterInv —— 第一版忘了，snapshotInv 读到空背包，
  // 于是"什么都没发生"变成了"丢了 3 个东西"，把假成功判成了成功（测试假绿）。
  bot.inventory = { items: () => invItems(afterInv) }
  const ctx = {
    bot,
    _taskStartInv: beforeInv,
    _taskStartPos: pos,
    _taskStartWorld: worldBefore || judge.worldSig(worldBot({ pos, blocks }), pos),
    _taskStartHeld: heldBefore,
    _taskStartFood: foodBefore,
    _taskStartHealth: healthBefore,
    _taskStartAt: Date.now() - elapsedSec * 1000,
    // 阶段声明：judge 要求有 evidence。测试里显式给。
    goals: { currentStage: () => ({ evidence, minSec }) },
    snapshotInv: Bot.prototype.snapshotInv,
    worldSig: function (p) { return judge.worldSig(this.bot, p) },
    actions: { isUnderground: () => undergroundAfter, status: () => ({}) },
    log: () => {}
  }
  if (heldAfter !== null) ctx.bot.heldItem = { name: heldAfter }
  ctx.bot.food = foodAfter
  ctx.bot.health = healthAfter
  if (worldAfter) {
    // 显式给"任务结束后"的世界：换一个 bot 视图，但锚点仍然是任务开始位置
    ctx.worldSig = () => worldAfter
  }
  return ctx
}

function hardCheck (opts) {
  return Bot.prototype.verifyTaskEffect.call(mainCtx(opts), opts.goal, opts.out || '')
}

// ---------------- coder.verifySkillEffect 的假 this ----------------
function skillCheck (opts) {
  const {
    goal, beforeInv = {}, afterInv = {}, pos = makePos(0, 64, 0), posNow = pos,
    blocks = {}, desc, worldBefore = null, worldAfter = null,
    heldBefore = null, foodBefore = 20, foodAfter = 20
  } = opts
  const bot = worldBot({ pos: posNow, blocks })
  bot.inventory = { items: () => invItems(afterInv) }
  bot.food = foodAfter
  const ctx = {
    bot,
    actions: { pos: () => posNow },
    snapshotInv: Coder.prototype.snapshotInv,
    worldSig: function (p) { return judge.worldSig(this.bot, p) },
    _skillHeld: heldBefore,
    _skillFood: foodBefore
  }
  const wb = worldBefore || judge.worldSig(worldBot({ pos, blocks }), pos)
  const wa = worldAfter || judge.worldSig(bot, pos)
  ctx.worldSig = () => wa
  ctx._skillHeld = heldBefore
  return Coder.prototype.verifySkillEffect.call(
    ctx, goal, { desc: desc || goal }, beforeInv, pos, { ok: true, output: '' }, wb
  )
}

// ---------------- 记账 ----------------
let pass = 0
let fail = 0
function expect (tag, name, want, got) {
  const ok = got.ok === want
  if (ok) pass++
  else fail++
  console.log(`${ok ? '  ok ' : 'FAIL'}  [${tag}] ${name}`)
  if (!ok) console.log(`        期望 ok=${want}，实际 ok=${got.ok}｜${String(got.why || '').slice(0, 120)}`)
}

// ============================================================
// 一、judgeOutcome（否决权）
// ============================================================
function judgeOut (goal, out, beforeInv, afterInv, posOpt = {}) {
  const pos = posOpt.pos || makePos(0, 64, 0)
  const ctx = {
    _taskStartInv: beforeInv,
    _taskStartPos: pos,
    bot: {
      entity: { position: posOpt.posNow || pos },
      inventory: { items: () => invItems(afterInv) }
    },
    snapshotInv: Bot.prototype.snapshotInv,
    countItem: Bot.prototype.countItem,
    extractWantedItem: Bot.prototype.extractWantedItem,
    actions: { status: () => ({}) }
  }
  return Bot.prototype.judgeOutcome.call(ctx, goal, out, Date.now(), posOpt.hardOk)
}

console.log('\n--- 一、judgeOutcome：只保留否决权 ---')
expect('否决', '模型自己说没做成', false, judgeOut('挖钻石', '做不了，没镐子', { cobblestone: 1 }, { cobblestone: 1 }))
expect('否决', '执行异常', false, judgeOut('挖钻石', '出错 Error: boom', { cobblestone: 1 }, { cobblestone: 1 }))
expect('否决', '明确零收获', false, judgeOut('挖钻石', '挖到 0 个钻石', { cobblestone: 1 }, { cobblestone: 1 }))
expect('放行', '文本正常时不予否决（批准权在 judge）', true,
  judgeOut('挖点圆石', '挖到圆石 8 个；圆石 132→140', { cobblestone: 132 }, { cobblestone: 140 }))

// 实测 22:34:13：背包+9、方块动 15 格的真成功，被句子里一句"3→3"否掉。
// 硬判据通过后，文本不该再用推断压过它。
expect('放行', '硬判据已通过时，句子里的"3→3"不再否决', true,
  judgeOut('挖点石头', '圆石 3→3、木板 0→0', { cobblestone: 3 }, { cobblestone: 3 },
    { hardOk: true }))
expect('否决', '硬判据没过时，那句"3→3"仍然是否决理由', false,
  judgeOut('挖点石头', '圆石 3→3、木板 0→0', { cobblestone: 3 }, { cobblestone: 3 },
    { hardOk: false }))

// ============================================================
// 二、验收项：端到端（main.verifyTaskEffect，真正的审批权）
// ============================================================
console.log('\n--- 二、端到端硬判据（main）---')

// 验收 2：吃东西 —— 食物减少是正常的，饱食度涨了就该算成
expect('验收', '弄点吃的，面包 3→1（饱食度 12→18）', true,
  hardCheck({
    goal: '弄点吃的，别饿着',
    out: '吃了个面包，面包 3→1',
    beforeInv: { bread: 3, cobblestone: 2 },
    afterInv: { bread: 1, cobblestone: 2 },
    foodBefore: 12,
    foodAfter: 18
  }))

// 验收 3：制作成功
expect('验收', '做好了石镐，圆石 12→8', true,
  hardCheck({
    goal: '用石镐的料做把镐子',
    out: '做好了石镐，圆石 12→8',
    beforeInv: { cobblestone: 12, stick: 4 },
    afterInv: { cobblestone: 8, stick: 2, stone_pickaxe: 1 }
  }))

// 工具不能当产物：「用石镐挖圆石」要求的是圆石，不是石镐
expect('验收', '用石镐挖圆石（+2 圆石）', true,
  hardCheck({
    goal: '用石镐挖圆石',
    out: '挖到圆石 2 个',
    beforeInv: { stone_pickaxe: 1, cobblestone: 10 },
    afterInv: { stone_pickaxe: 1, cobblestone: 12 }
  }))

// 真实日志：冲铁镐 —— 铁锭 0，只顺路挖了圆石
expect('实测', '冲铁镐: 铁锭0 生铁0 圆石148', false,
  hardCheck({
    goal: '先弄把铁镐，不然到深层白跑',
    out: '冲铁镐: 铁锭0 生铁0 圆石148',
    beforeInv: { cobblestone: 140, iron_ingot: 0, raw_iron: 0 },
    afterInv: { cobblestone: 148, iron_ingot: 0, raw_iron: 0 }
  }))

// 文档点名：无条件 return 成功文案
expect('实测', '捡够垫脚的石头，背包一个没多', false,
  hardCheck({
    goal: '在附近地上捡够垫脚的石头',
    out: '现在手上有圆石132个，够垫脚用了',
    beforeInv: { cobblestone: 132 },
    afterInv: { cobblestone: 132 }
  }))

// 挖通道：背包不涨，但方块真的动了 3 格
expect('验收', '挖通道：背包没涨但方块动了 3 格', true,
  hardCheck({
    goal: '挖一条通道过去',
    out: '挖通了',
    beforeInv: { cobblestone: 5 },
    afterInv: { cobblestone: 5 },
    worldBefore: { '0,64,0': 'stone', '1,64,0': 'stone', '2,64,0': 'stone', '3,64,0': 'stone' },
    worldAfter: { '0,64,0': 'air', '1,64,0': 'air', '2,64,0': 'air', '3,64,0': 'stone' }
  }))

// 走 30 格是真的去了 —— 走动的任务只看位移
expect('验收', '去北边探路，真的走了 30 格', true,
  hardCheck({
    goal: '去北边探探路，看看有什么',
    out: '看了看，还行',
    beforeInv: { cobblestone: 3 },
    afterInv: { cobblestone: 3 },
    pos: makePos(10, 64, 10),
    posNow: makePos(40, 64, 10)
  }))

// 但"挖石头"的任务里只走了路，实物一点没多 —— 这才是走动型假成功
expect('验收', '目标是挖石头，结果只是走了一圈', false,
  hardCheck({
    goal: '在附近挖点圆石',
    out: '走了走，挖到圆石 0 个',
    beforeInv: { cobblestone: 3 },
    afterInv: { cobblestone: 3 },
    pos: makePos(10, 64, 10),
    posNow: makePos(40, 64, 10)
  }))

// 躲起来养血：世界零变化 —— 不再算成功（"背书质量"要求）
expect('实测', '躲起来养血，原地不动 -> 失败（无可验证进展）', false,
  hardCheck({
    goal: '先找个安全的地方待着，别乱跑，把血养回来',
    out: '躲好了',
    beforeInv: { cobblestone: 1 },
    afterInv: { cobblestone: 1 }
  }))

// ===== 哨兵复现：用收尾话术骗过 proof 背书 =====
expect('话术', '目标"回家"，输出"太远了先歇会儿" -> 失败', false,
  hardCheck({ goal: '回家', out: '太远了，先歇会儿', beforeInv: {}, afterInv: {} }))
expect('话术', '目标"走回家"，输出"先在这儿等等" -> 失败', false,
  hardCheck({ goal: '走回家', out: '太远，先在这儿等等', beforeInv: {}, afterInv: {} }))
expect('话术', '目标"去矿洞看看"，输出"原地待着等天亮" -> 失败', false,
  hardCheck({ goal: '去矿洞看看', out: '原地待着等天亮', beforeInv: {}, afterInv: {} }))
expect('话术', '目标"回家"，真的走了 30 格 -> 成功', true,
  hardCheck({
    goal: '回家', out: '到家了',
    beforeInv: {}, afterInv: {},
    pos: makePos(0, 64, 0), posNow: makePos(30, 64, 0)
  }))

// 换装备：背包完全不变，但手持变了
expect('验收', '换上石剑（背包没变，手持变了）', true,
  hardCheck({
    goal: '把剑拿在手上',
    out: '拿上了',
    beforeInv: { stone_sword: 1 },
    afterInv: { stone_sword: 1 },
    heldBefore: null,
    heldAfter: 'stone_sword'
  }))

// 什么都没发生
expect('验收', '收拾一下东西：什么都没发生', false,
  hardCheck({ goal: '收拾一下东西', out: '收拾好了', beforeInv: { cobblestone: 3 }, afterInv: { cobblestone: 3 } }))

// ============================================================
// 二·B 位置类目标：只有 y 能作证（2026-11-13 22:54 真机铁证）
// ============================================================
console.log('\n--- 二·B 位置类目标 ---')

// 真机原句：点火把（方块变了）、捡东西（背包变了），但 y=42 还在地面下
expect('位置', '回地面：点火把捡东西但没上去 -> 失败', false,
  hardCheck({
    goal: '回到地面上',
    out: '没硬往上挖，往北探了探（没挪动），点了火把、捡了捡东西，坐下歇了会儿。现在 y=42，还在地面下，出去的事改天再想。',
    beforeInv: { cobblestone: 3, torch: 4 },
    afterInv: { cobblestone: 5, torch: 2 },
    pos: makePos(0, 42, 0),
    posNow: makePos(0, 42, 0),
    worldBefore: { '0,42,0': 'stone' },
    worldAfter: { '0,42,0': 'torch' }
  }))

expect('位置', '回地面：真的升到 y=58', true,
  hardCheck({
    goal: '回到地面上',
    out: '上来了，y=58',
    beforeInv: { cobblestone: 3 },
    afterInv: { cobblestone: 3 },
    pos: makePos(0, 42, 0),
    posNow: makePos(0, 58, 0)
  }))

expect('位置', '已经在地面（isUnderground=false）直接算到', true,
  hardCheck({
    goal: '回到地面上',
    out: '上来了',
    beforeInv: {},
    afterInv: {},
    pos: makePos(0, 60, 0),
    posNow: makePos(0, 60, 0),
    undergroundAfter: false
  }))

// 别的类型不受影响
expect('位置', '挖矿照旧（y 没变但挖到了）', true,
  hardCheck({
    goal: '挖点圆石', out: '挖到圆石 3 个',
    beforeInv: { cobblestone: 1 }, afterInv: { cobblestone: 4 },
    pos: makePos(0, 30, 0), posNow: makePos(0, 30, 0)
  }))
expect('位置', '搬到山顶上去不算位置目标（搬移类）', true,
  hardCheck({
    goal: '把那个熔炉挖了搬到山顶上去', out: '搬好了',
    beforeInv: { furnace: 1 }, afterInv: {},
    pos: makePos(0, 40, 0), posNow: makePos(0, 44, 0)
  }))

// 文本自认没上去 -> 否决
expect('位置', '文本自己说"还在地面下" -> 否决层拦下', false,
  judgeOut('回到地面上', '没硬往上挖，现在 y=42，还在地面下，出去的事改天再想。',
    { cobblestone: 3 }, { cobblestone: 5 }, { hardOk: true }))

// ============================================================
// 三、世界快照坐标系（审查报告点名的最大 bug）
// ============================================================
console.log('\n--- 三、世界快照坐标帧 ---')
{
  const blocks = { '5,64,5': 'gold_ore' }
  const p0 = makePos(0, 64, 0)
  const p1 = makePos(2, 64, 0)
  const b = worldBot({ pos: p0, blocks })
  const s0 = judge.worldSig(b, p0)
  const s1 = judge.worldSig(worldBot({ pos: p1, blocks }), p0) // 同一片区域，锚点不变
  const d = judge.worldDiffCount(s0, s1)
  expect('坐标', '动了 2 格、没挖：方块变化必须是 0', true, { ok: d === 0, why: `实际 ${d}` })

  const dug = { ...blocks, '0,64,0': 'air' }
  const s2 = judge.worldSig(worldBot({ pos: p1, blocks: dug }), p0)
  const d2 = judge.worldDiffCount(s0, s2)
  expect('坐标', '动了 2 格 + 挖 1 格：只数那 1 格', true, { ok: d2 === 1, why: `实际 ${d2}` })
}

// 生产环境里的 blockAt 要求 Vec3（内部会调 pos.floored()）。
// 传普通对象会抛异常 -> 快照 null -> "方块?"，整维世界证据静默失效。
// 实测三轮真机日志全是 `方块?`，就是这条。
{
  const strictBot = {
    blockAt (p) {
      if (typeof p.floored !== 'function') throw new TypeError('pos.floored is not a function')
      return { name: 'stone' }
    }
  }
  const sig = judge.worldSig(strictBot, makePos(0, 64, 0), { r: 2, up: 1, down: 1 })
  expect('坐标', 'blockAt 只吃 Vec3 时快照仍然读得到', true,
    { ok: !!sig && Object.keys(sig).length > 0, why: sig ? '' : '快照为 null（生产里会显示"方块?"）' })
}

// ============================================================
// 四、技能层走同一判定器
// ============================================================
console.log('\n--- 四、技能层（coder，共用 judge）---')
expect('技能', '复用「捡够垫脚的石头」，背包没变', false,
  skillCheck({ goal: '在附近地上捡够垫脚的石头', beforeInv: { cobblestone: 132 }, afterInv: { cobblestone: 132 } }))
expect('技能', '复用「冲铁镐」，只挖到圆石', false,
  skillCheck({
    goal: '先弄把铁镐，不然到深层白跑',
    beforeInv: { cobblestone: 140, iron_ingot: 0 },
    afterInv: { cobblestone: 148, iron_ingot: 0 }
  }))
expect('技能', '复用「把熔炉搬到山顶」，东西放下了但确实搬了', true,
  skillCheck({
    goal: '把那个熔炉挖了搬到山顶上去',
    beforeInv: { furnace: 1 },
    afterInv: {},
    pos: makePos(0, 64, 0),
    posNow: makePos(0, 80, 0)
  }))
expect('技能', '复用"躲起来"技能：世界零变化 -> 不记 ok', false,
  skillCheck({ goal: '先找个安全的地方待着，别乱跑，把血养回来', beforeInv: { cobblestone: 1 }, afterInv: { cobblestone: 1 } }))
expect('技能', '真挖到圆石', true,
  skillCheck({ goal: '挖点圆石', beforeInv: { cobblestone: 100 }, afterInv: { cobblestone: 108 } }))

// ============================================================
// 五、目标层：do/build 不再白送（回归）
// ============================================================
console.log('\n--- 五、目标层 addWork ---')
function goalCheck (kind, progress) {
  const stage = { kind, title: '先弄把铁镐', need: { count: 1 }, work: 0, attempts: 0, fails: 0, best: 0 }
  const ctx = Object.create(Goals.prototype)
  ctx.goal = { stages: [stage], attempts: 0, createdAt: Date.now(), lastProgressAt: Date.now(), done: false }
  ctx.cfg = { stallMs: 1e9, maxFails: 9, methodSwitchWins: 99, maxIdleWins: 99 }
  ctx.now = () => Date.now()
  ctx.journal = () => {}
  ctx.log = () => {}
  ctx.save = () => {}
  ctx.stage = () => stage
  ctx.currentStage = () => stage
  ctx.observe = () => ({ stageCompleted: false, goalCompleted: false })
  Goals.prototype.onTaskResult.call(ctx, { ok: true, text: '先弄把铁镐', status: null, progress })
  return stage.work || 0
}
expect('目标', 'do 阶段 progress=0 -> 不推进', true, { ok: goalCheck('do', 0) === 0 })
expect('目标', 'do 阶段 progress=3 -> 推进且被 need 封顶', true, { ok: goalCheck('do', 3) === 1 })
expect('目标', 'do 阶段没给 progress -> 不推进', true, { ok: goalCheck('do', undefined) === 0 })

// ============================================================
// 六、扫描器
// ============================================================
const { judgeSkill } = require('./scan-fake-success.js')
const scanVerdict = (code, desc) => judgeSkill({ name: 'k_test', desc: desc || '测试', code, ok: 0, fail: 0, uses: 0 })

console.log('\n--- 六、扫描器 ---')
expect('扫描', '无条件成功文案 -> FAKE', true,
  { ok: scanVerdict(`let c = actions.countOf('cobblestone')\nawait actions.pickupNearby(12)\nreturn '现在手上有圆石' + c + '个，够垫脚用了'`, '捡石头').verdict === 'FAKE' })
expect('扫描', '无条件报存量 -> FAKE', true,
  { ok: scanVerdict(`await actions.mine('iron', 3, 20)\nreturn '冲铁镐: 铁锭' + actions.countOf('iron_ingot') + ' 圆石' + actions.countOf('cobblestone')`, '先弄把铁镐').verdict === 'FAKE' })
expect('扫描', '提前返回失败（跨行拼接）-> HONEST', true,
  { ok: scanVerdict(`
if (!actions.item('iron_pickaxe')) {
  return '冲铁镐: 铁锭' + actions.countOf('iron_ingot') +
    ' 圆石' + actions.countOf('cobblestone') + '，铁镐没做出来，还差材料'
}
return '做了一把铁镐，铁锭' + actions.countOf('iron_ingot')`, '先弄把铁镐').verdict === 'HONEST' })

// ============================================================
// 七、技能选择与入库门槛（越失败越窄 / 无进展出口 / 标脏）
// ============================================================
console.log('\n--- 七、技能选择与入库 ---')
{
  const { SkillLibrary } = require(path.join(ROOT, 'src', 'skills.js'))
  const { hasNoProgressExit } = require(path.join(ROOT, 'src', 'coder.js'))
  const lib = new SkillLibrary(path.join(ROOT, 'data', 'tmp-skills-test'))
  lib.data = { skills: [], stats: {} }
  const honest = `const n = actions.countOf('cobblestone')
if (n < 3) { return '还差，只凑到' + n }
return '挖到圆石' + n`
  lib.add({ name: 'k_a', desc: '在附近挖点圆石', code: honest, tags: [] })
  const sk = lib.get('k_a')
  const ctx = { inventory: { stone_pickaxe: 1 } }

  sk.ok = 0; sk.fail = 1; sk.uses = 1
  expect('选择', '失败 1 次仍可被选中', true, { ok: !!lib.pickFor('在附近挖点圆石', ctx) })

  sk.ok = 0; sk.fail = 2; sk.uses = 2
  expect('选择', '失败 2 次后不再被选中', true, { ok: !lib.pickFor('在附近挖点圆石', ctx) })

  sk.ok = 1; sk.fail = 1; sk.uses = 2
  expect('选择', '1 成 1 败仍可被选中', true, { ok: !!lib.pickFor('在附近挖点圆石', ctx) })

  sk.dirty = true
  expect('选择', '标脏的技能选不上', true, { ok: !lib.pickFor('在附近挖点圆石', ctx) })

  expect('入库', '带无进展退出的循环代码可入库', true, {
    ok: hasNoProgressExit(`let stall = 0
while (stall < 5) {
  const before = actions.countOf('cobblestone')
  await sleep(1000)
  if (actions.countOf('cobblestone') === before) stall++
  else stall = 0
}
if (stall >= 5) return '白干了，还差'
return '挖到了'`)
  })
  expect('入库', '只有 while 没有退出计数的代码不入库', true, {
    ok: !hasNoProgressExit(`while (actions.countOf('cobblestone') < 32) {
  await actions.digStone(8)
}
return '够了'`)
  })
}

// ============================================================
// 八、证据类型（evidence）—— 取消默认分支
// ============================================================
console.log('\n--- 八、证据类型 ---')
{
  // 验收 1：目标声明 world，"歇会儿"不能骗过
  expect('证据', '目标"回家"(world) + 输出"先歇会儿" -> 失败', false,
    hardCheck({ goal: '回家', out: '太远了，先歇会儿', beforeInv: {}, afterInv: {}, evidence: 'world' }))

  // 验收 2：duration 型必须真的待够
  expect('证据', 'duration 30s：只待了 10s -> 失败', false,
    hardCheck({
      goal: '先歇着，把血养回来', out: '歇着呢', beforeInv: {}, afterInv: {},
      evidence: 'duration', minSec: 30, elapsedSec: 10
    }))
  expect('证据', 'duration 30s：待了 35s、没掉血没饿 -> 成功', true,
    hardCheck({
      goal: '先歇着，把血养回来', out: '歇够了', beforeInv: {}, afterInv: {},
      evidence: 'duration', minSec: 30, elapsedSec: 35
    }))
  expect('证据', 'duration：待够了但血掉了 -> 失败', false,
    hardCheck({
      goal: '先歇着，把血养回来', out: '歇够了', beforeInv: {}, afterInv: {},
      evidence: 'duration', minSec: 30, elapsedSec: 35, healthBefore: 20, healthAfter: 12
    }))
  expect('证据', 'duration：待够了但跑出去 20 格 -> 失败', false,
    hardCheck({
      goal: '先歇着，把血养回来', out: '歇够了', beforeInv: {}, afterInv: {},
      evidence: 'duration', minSec: 30, elapsedSec: 35,
      pos: makePos(0, 64, 0), posNow: makePos(20, 64, 0)
    }))

  // 验收 3：没声明 evidence -> throw（不是静默放过）
  let threw = ''
  try {
    judge.judgeTask({ goal: '回家', invBefore: {}, invAfter: {}, posBefore: makePos(0, 64, 0), posAfter: makePos(0, 64, 0) })
  } catch (e) { threw = e.message }
  expect('证据', '没声明 evidence -> 抛错', true, { ok: /evidence/.test(threw), why: threw || '没抛错' })

  let threw2 = ''
  try {
    judge.judgeTask({ goal: '回家', evidence: 'vibes', invBefore: {}, invAfter: {} })
  } catch (e) { threw2 = e.message }
  expect('证据', '未知 evidence 类型 -> 抛错', true, { ok: /未知/.test(threw2), why: threw2 || '没抛错' })

  // goals 每个阶段都自带 evidence（模板 + 自定义 + 老存盘迁移）
  const { evidenceForStage, POOL } = require(path.join(ROOT, 'src', 'goals.js'))
  let missing = 0
  let derived = 0
  for (const def of POOL) {
    for (const st of def.stages || []) {
      // 必须是**阶段自己的字段**（数据级声明），不是靠调用时推导
      if (!st.evidence) { missing++; continue }
      if (!['world', 'duration', 'state'].includes(st.evidence)) missing++
      if (st.evidence !== evidenceForStage(st.kind, st.title).evidence) derived++
    }
  }
  expect('证据', 'POOL 里每个阶段都自带 evidence 字段', true, { ok: missing === 0, why: `${missing} 个缺` })
  expect('证据', '阶段声明与推导一致（没写错类型）', true, { ok: derived === 0, why: `${derived} 个对不上` })
}

// ============================================================
// 九、判据纪律 CI
// ============================================================
console.log('\n--- 九、判据纪律 ---')
{
  const { execFileSync } = require('child_process')
  const script = path.join(ROOT, 'scripts', 'check-judge-discipline.js')
  let selfOk = true
  let zeroViolation = true
  let out = ''
  try {
    out = execFileSync(process.execPath, [script, '--selftest'], { encoding: 'utf8' })
  } catch (e) { selfOk = false; out = String(e.stdout || e.message) }
  expect('纪律', '检测器自测：含违规样本能抓到', true, { ok: selfOk, why: out.trim().slice(0, 80) })
  try {
    out = execFileSync(process.execPath, [script], { encoding: 'utf8' })
    zeroViolation = /违规.*: 0/.test(out)
  } catch (e) { zeroViolation = false; out = String(e.stdout || e.message) }
  expect('纪律', '现有代码 0 处"文本批准"', true, { ok: zeroViolation, why: out.split('\n')[1] || '' })
}

// ---------------- 汇总 ----------------
console.log(`\n===== 合计 ${pass} 过 / ${fail} 挂 =====`)
process.exit(fail ? 1 : 0)
