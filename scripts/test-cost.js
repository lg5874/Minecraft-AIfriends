'use strict'
/**
 * 代价层自测（src/cost.js）。
 *
 * 验的是四件事：
 *   1. 账算得对：多久、多远、弄到啥、白搭多少
 *   2. 话说得像人：「四十来分钟」「两块圆石」，不是「耗时 2400 秒 / 产出 6」
 *   3. 记忆有牙：白干写进记忆 + 那片地/那种活下次真的被压分
 *   4. 接线不侵入：attach(goals) 之后，真 goals.abandon() 会结账，
 *      goals.candidates() 会避开栽过的地方（不改 goals.js 一行）
 *
 * 不连服务器。用假状态 + 真的 Goals / 真的 Memory。
 */

const path = require('path')
const fs = require('fs')
const os = require('os')

const Goals = require('../src/goals')
const Memory = require('../src/memory')
const cost = require('../src/cost')
const { Cost } = cost

let pass = 0
let fail = 0
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}
const show = s => console.log('    ' + s)
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aifriend-cost-'))

const MIN = 60 * 1000

function fakeStatus ({ inv = {}, y = 64, x = 0, z = 0, health = 20, food = 18 } = {}) {
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

/** 假目标：跟 goals.makeGoal() 出来的结构一致（base 里有建立时的库存和坐标） */
function fakeGoal ({ key = 'dig', title = '下去挖点铁', mins = 40, startPos = { x: 0, y: 64, z: 0 }, startInv = {}, stages = null, stageIndex = 0 } = {}) {
  const at = Date.now() - mins * MIN
  const st = stages || [{
    key: null, kind: 'gather', title: '挖铁矿', need: { count: 8 }, where: '地下的石头里',
    base: { at, inv: startInv, pos: startPos, y: startPos.y, ug: startPos.y < 58 },
    work: 0, ratio: 0, best: 0, attempts: 3, fails: 2, doneAt: null, methodIndex: 0, idleWins: 0
  }]
  return {
    key, title, why: '想做把铁镐', createdAt: at, stageIndex, stages: st,
    attempts: 3, fails: 2, done: false,
    journal: [{ at, text: '定了这件事：' + title }]
  }
}

// ================================================================
console.log('\n[一、先说人话]')
{
  ok(cost.humanMins(2) === '两分钟', '2 分钟 -> 两分钟', cost.humanMins(2))
  ok(cost.humanMins(13) === '一刻钟', '13 分钟 -> 一刻钟', cost.humanMins(13))
  ok(cost.humanMins(40) === '四十分钟', '40 分钟 -> 四十分钟', cost.humanMins(40))
  ok(cost.humanMins(43) === '四十来分钟', '43 分钟 -> 四十来分钟（不会说四十三）', cost.humanMins(43))
  ok(cost.humanMins(75) === '一个多钟头', '75 分钟 -> 一个多钟头', cost.humanMins(75))
  ok(/两块圆石/.test(cost.humanGoods('cobblestone', 2)), '数量也是中文：两块圆石', cost.humanGoods('cobblestone', 2))
  ok(/六颗钻石/.test(cost.humanGoods('diamond', 6)), '六颗钻石', cost.humanGoods('diamond', 6))
}

// ================================================================
console.log('\n[二、算账：三种结局]')
{
  // 白干：40 分钟，一块铁都没挖到
  const c = new Cost(tmp(), { now: () => Date.now() })
  const g = fakeGoal({ mins: 40, startInv: { cobblestone: 6, wooden_pickaxe: 1 } })
  const bill = c.settle(g, { status: fakeStatus({ inv: { cobblestone: 6, wooden_pickaxe: 1 }, y: 12 }), pos: { x: 40, y: 12, z: -90 } })
  ok(bill.verdict === 'white', '四十分钟啥也没弄到 = 白干', bill.verdict)
  ok(bill.worth === 0, '产出按 0 算', bill.worth)
  show('账单：' + bill.text)
  show('记忆：' + bill.memText)

  // 够本：40 分钟，40 圆石 + 5 铁矿石
  const c2 = new Cost(tmp(), { now: () => Date.now() })
  const g2 = fakeGoal({ mins: 40, startInv: { cobblestone: 0 } })
  const b2 = c2.settle(g2, { status: fakeStatus({ inv: { cobblestone: 40, raw_iron: 5 }, y: 14 }) })
  ok(b2.verdict === 'ok', '挖到 40 圆石 + 5 铁 = 够本', b2.verdict + ' rate=' + b2.rate)
  show('账单：' + b2.text)

  // 又白干又死了两回
  const c3 = new Cost(tmp(), { now: () => Date.now() })
  c3.onDeath({ how: 'XJJ was burned to death', pos: { x: 5, y: 11, z: 5 } })
  c3.onDeath({ how: 'XJJ was burned to death', pos: { x: 5, y: 11, z: 5 } })
  const g3 = fakeGoal({ key: 'diamond', title: '下去探一趟深层，看看有没有钻石', mins: 35 })
  const b3 = c3.settle(g3, { status: fakeStatus({ inv: {}, y: 9 }) })
  ok(b3.verdict === 'bitter', '白干还赔了两条命 = 不划算', b3.verdict)
  show('账单：' + b3.text)
  show('记忆：' + b3.memText)

  // 太短不算账
  const c4 = new Cost(tmp(), { now: () => Date.now() })
  const g4 = fakeGoal({ mins: 2 })
  const b4 = c4.settle(g4, { status: fakeStatus({}) })
  ok(b4.verdict === 'short', '两分钟的活不记账（不然每件小事都白干）', b4.verdict)
  ok(b4.memText === '' && b4.memKept === false, '太短就不写记忆')
}

// ================================================================
console.log('\n[三、账里的数：路走了多远、东西搭进去多少]')
{
  const c = new Cost(tmp(), { now: () => Date.now() })
  const g = fakeGoal({ mins: 30, startPos: { x: 0, y: 64, z: 0 }, startInv: { torch: 12, bread: 3 } })
  const bill = c.settle(g, {
    status: fakeStatus({ inv: { cobblestone: 9, torch: 4, bread: 3 }, x: 30, y: 20, z: 40 })
  })
  ok(bill.gained.some(x => x.item === 'cobblestone' && x.n === 9), '产出算对了：9 块圆石')
  ok(bill.spent.some(x => x.item === 'torch' && x.n === 8), '投入也算：烧掉 8 根火把', JSON.stringify(bill.spent))
  ok(bill.dist >= 40, '从起点到现在的直线距离算进去了', bill.dist + ' 格')
  ok(/火把/.test(bill.memText), '记忆里会说"还搭进去八根火把"', bill.memText)
  show('记忆：' + bill.memText)
}

// ================================================================
console.log('\n[四、写进真记忆（准入也得过）]')
{
  const dir = tmp()
  const mem = new Memory(dir)
  mem.goOnline()
  const c = new Cost(dir, { mem, now: () => Date.now() })

  const g = fakeGoal({ mins: 45, startInv: { cobblestone: 0 } })
  const bill = c.settle(g, { status: fakeStatus({ inv: { cobblestone: 2 }, y: 14 }), pos: { x: 20, y: 14, z: 30 } })
  ok(bill.verdict === 'white', '四十五分钟两块石头 = 白干', bill.verdict)
  ok(bill.memKept === true, '这句进了长期记忆（不是被当流水账踢进 journal）')

  const e = mem.entries.find(x => x.text.includes('记住这回'))
  ok(!!e, '记忆里查得到这条')
  if (e) {
    ok(e.kind === 'skill', '归类成"教训"（以后还会被想起来）', e.kind)
    ok(e.importance >= 0.6 && e.importance < 0.8, '有分量但没到"刻骨铭心永不衰减"', e.importance)
    ok(e.emotion >= 0.5 && e.emotion < 0.7, '带情绪，但没到永不淡忘的线', e.emotion)
    show('记忆原文：' + e.text)
    show(`权重：kind=${e.kind} importance=${e.importance} emotion=${e.emotion} where=${e.where}`)
  }
  ok(!mem.journal.some(j => /记住这回/.test(j.text)), '没被当成任务日志丢掉')

  // 记忆真的能召回
  const recalled = mem.remember('下去挖矿 那片地方', { limit: 5 })
  ok(recalled.some(x => /白忙|白干|折腾/.test(x.text)), '想"挖矿"的时候这条能被想起来',
    recalled.map(x => x.text).join(' / '))
}

// ================================================================
console.log('\n[五、记忆有牙：那片地方下次会被压分]')
{
  const c = new Cost(tmp(), { now: () => Date.now() })
  const g = fakeGoal({ mins: 40 })
  c.settle(g, { status: fakeStatus({ inv: {}, y: 12 }), pos: { x: 100, y: 12, z: -200 } })
  ok(c.zones.length === 1, '记下了"这片没搞头"', JSON.stringify(c.zones[0] && c.zones[0].reason))

  const here = c.zoneBias({ x: 110, y: 12, z: -200 })
  const far = c.zoneBias({ x: 400, y: 64, z: 400 })
  ok(here.penalty > 0, '站在那片地上：扣分', here.penalty)
  ok(far.penalty === 0, '离得远：不扣分')
  show('为什么：' + here.why)

  const cands = [
    { key: 'dig', title: '就在这附近挖点石头', score: 80, undergroundGoal: true },
    { key: 'farm', title: '开一小块地，种点吃的', score: 60 },
    { key: 'explore', title: '往一个方向走远点', score: 55 }
  ]
  const before = cands.map(x => x.key + '=' + x.score).join(' > ')
  const after = c.applyBias(cands, fakeStatus({ y: 12, x: 105, z: -200 }))
  show('排之前：' + before)
  show('排之后：' + after.map(x => x.key + '=' + x.score + (x.costWhy.length ? '（' + x.costWhy[0] + '）' : '')).join(' > '))
  ok(after[0].key !== 'dig', '上次栽的那类活不再是首选', after[0].key)
}

// ================================================================
console.log('\n[六、记忆有牙：刚被岩浆烫过，别选深层]')
{
  const c = new Cost(tmp(), { now: () => Date.now() })
  const r = c.onDeath({ how: 'XJJ 被岩浆烫死了', pos: { x: 0, y: 11, z: 0 } })
  ok(r.kind === 'lava', '死因认出来了：岩浆', r.kind)
  ok(c.hazardActive('lava'), '进入危险期')

  const deep = c.hazardBias({ key: 'diamond', title: '下去探一趟深层，看看有没有钻石', undergroundGoal: true })
  const farm = c.hazardBias({ key: 'farm', title: '开一小块地，种点能吃的东西' })
  ok(deep.penalty < 0, '深层目标被压分', deep.penalty)
  ok(farm.penalty === 0, '地面上的活不受影响')
  show('深层被扣：' + deep.penalty + ' —— ' + deep.why.join('；'))

  ok(c.hazardBias({ key: 'stone', title: '砸点石头' }).penalty === 0, '表层挖石头不算深层')
}

// ================================================================
console.log('\n[七、记忆有牙：同一件事栽三回，提起来就不想干]')
{
  const c = new Cost(tmp(), { now: () => Date.now() })
  for (let i = 0; i < 3; i++) {
    const g = fakeGoal({ key: 'farm', title: '开一小块地，种点能吃的东西', mins: 20 + i })
    c.settle(g, { status: fakeStatus({ inv: {} }) })
  }
  ok(c.failCount('farm') === 3, '记下了栽 3 回', c.failCount('farm'))
  ok(c.isDreaded('farm'), '这一档算"想想就烦了"')
  const d = c.dreadBias({ key: 'farm', title: '开一小块地' })
  ok(d.penalty < 0, '再提它就扣分', d.penalty)
  show('为什么：' + d.why)
  ok(c.dreadBias({ key: 'house' }).penalty === 0, '没栽过的不受影响')
  const db = c.dreadBlock()
  ok(/栽过好几回/.test(db), '提示词里会提"这个我栽过好几回"')
  show('提示词：' + db.split('\n')[0] + ' / ' + (db.split('\n')[1] || ''))
}

// ================================================================
console.log('\n[八、时间值钱：白干之后该有情绪]')
{
  const c = new Cost(tmp(), { now: () => Date.now() })
  ok(c.wear() === 0, '一开始不烦')
  const g = fakeGoal({ mins: 40 })
  c.settle(g, { status: fakeStatus({ inv: {} }) })
  ok(c.wear() > 0.2, '白干完心里堵了一下', c.wear())
  show('状态：' + c.wearText())
  const block = c.lossBlock()
  ok(/吃的亏/.test(block), '这一段能进提示词')
  ok(/记住这回/.test(block), '里面是原话，不是"目标失败"三个字')
  ok(!/前：/.test(block), '每行不带"X分钟前"时间戳（会被模型放大成"昨天"）')
  ok(/这一两个小时里|这半天里|这两天里/.test(block), '整段只给一个粗时间窗', block.split('\n')[0])
  show('---- 提示词里的那一段 ----')
  block.split('\n').forEach(l => show(l))
  show('--------------------------')

  ok(c.sourness({ mins: 5, progress: 0 }) === 0, '五分钟不算久')
  ok(c.sourness({ mins: 30, progress: 0.05 }) > 0.5, '三十分钟没进展：该烦了', c.sourness({ mins: 30, progress: 0.05 }))
  ok(c.sourness({ mins: 30, progress: 0.9 }) < 0.2, '同样三十分钟但一直在推进：不烦')
}

// ================================================================
console.log('\n[九、账本：同一份目标只结一次]')
{
  const c = new Cost(tmp(), { now: () => Date.now() })
  const g = fakeGoal({ mins: 40 })
  const a = c.settle(g, { status: fakeStatus({ inv: {} }) })
  const b = c.settle(g, { status: fakeStatus({ inv: {} }) })
  ok(a === b, '第二次 settle 拿到同一份账单')
  ok(c.losses.length === 1, '只记了一笔', c.losses.length)
}

// ================================================================
console.log('\n[十、接线：真的 goals.abandon() 会结账（不改 goals.js 一行）]')
{
  const dir = tmp()
  const mem = new Memory(dir)
  mem.goOnline()
  const gdir = tmp()
  const c = new Cost(gdir, { mem, now: () => Date.now() })
  const goals = new Goals(gdir, { ctx: { log: () => {} }, now: () => Date.now() })
  c.attach(goals)

  // 造一个"已经干了一会儿、什么都没挖到"的目标
  goals.goal = fakeGoal({ key: 'dig', title: '下去挖点铁', mins: 38, startInv: { cobblestone: 4 } })
  goals.lastStatus = fakeStatus({ inv: { cobblestone: 4 }, y: 13 })

  const rec = goals.abandon('「挖铁矿」换了 3 个法子都不行', { urgent: true })
  ok(!!rec && rec.result === 'abandoned', 'goals 那边正常放弃')
  ok(c.losses.length === 1, '放弃之后自动结了一笔账', c.losses.length)
  ok(c.losses[0].verdict === 'white', '账上写的是白干', c.losses[0].verdict)
  ok(mem.entries.some(e => /记住这回/.test(e.text)), '记忆里多了一条"白干"')
  ok(goals.history.length === 1, 'goals 自己的历史没被搞乱', goals.history.length)
  show('日志里的结算行：[cost] ' + c.losses[0].text)

  // 被"最低寿命"挡住时不该记账
  const c2 = new Cost(tmp(), { now: () => Date.now() })
  const goals2 = new Goals(tmp(), { ctx: { log: () => {} }, now: () => Date.now() })
  c2.attach(goals2)
  goals2.goal = fakeGoal({ key: 'dig', title: '下去挖点铁', mins: 1 })   // 才 1 分钟
  goals2.lastStatus = fakeStatus({})
  const held = goals2.abandon('不想干了')      // 非 urgent，会被 minLifeMs 挡
  ok(held === null, '太早放弃被闸门挡住')
  ok(c2.losses.length === 0, '被挡住就不结账（没有白干这回事）')

  // 候选池被重排
  const cands = goals.candidates(fakeStatus({ inv: { wooden_pickaxe: 1 }, y: 13, x: 0, z: 0 }))
  ok(Array.isArray(cands) && cands.every(x => Array.isArray(x.costWhy)), 'goals.candidates() 出来的每一项都带了代价理由', cands.length + ' 项')
  const blocked = cands.filter(x => x.costPenalty < 0)
  ok(blocked.length >= 1, '至少有一项被上次的账压了分',
    blocked.map(x => x.key + x.costPenalty).join(',') || '无')
  if (blocked.length) show('被压分的：' + blocked.map(x => `${x.key}${x.costPenalty}（${x.costWhy[0]}）`).join('；'))

  // 提示词里能看到亏
  goals.goal = fakeGoal({ key: 'dig', title: '下去挖点铁', mins: 10 })
  const blk = goals.promptBlock()
  ok(/吃的亏/.test(blk), '目标提示词里带上了最近的亏')
}

// ================================================================
console.log('\n[十一、真实数据：历史里的放弃记录长什么样]')
{
  const f = path.join(__dirname, '..', 'data', 'runtime', 'goals.json')
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'))
    const ab = (d.history || []).filter(h => h.result === 'abandoned')
    const withTook = ab.filter(h => h.tookMin != null).length
    const withGain = ab.filter(h => h.gained != null).length
    show(`data/runtime/goals.json 里 ${ab.length} 条放弃记录：带耗时的 ${withTook} 条，带产出的 ${withGain} 条`)
    show('这就是"放弃不结算"的证据 —— 那些时间里他到底折了多少，一条都没留下。')
    // 拿真记录里的标题和原因，按 cost 的口径生成"本该记下来的那句话"
    const samples = ab.slice(-3)
    const c = new Cost(tmp(), { now: () => Date.now() })
    for (const h of samples) {
      const g = fakeGoal({ key: h.key, title: h.title, mins: 35, startInv: { cobblestone: 0 } })
      const bill = c.settle(g, { status: fakeStatus({ inv: {} }) })
      show(`「${h.title}」-> ${bill.memText}`)
    }
  } catch (e) {
    show('（没有真实数据文件，跳过）')
  }
}

// ================================================================
console.log('\n[十二、文案矩阵：事实不能写错，落点别全推给地方]')
{
  const c = new Cost(tmp(), { now: () => Date.now() })
  const bill = (o) => Object.assign({
    time: '四十分钟', mins: 40, dist: 0, deaths: 0,
    gained: [], spent: [], worth: 0, burn: 0, zone: null, verdict: 'white'
  }, o)

  // bitter 有货：不许说"白扔"（tone-researcher 审计的事实冲突）
  const g = fakeGoal({ key: 'dig', mins: 40, startInv: {} })
  const b1 = c.settle(g, {
    status: fakeStatus({ inv: { cobblestone: 12 }, y: 12 }),
    deaths: 1
  })
  ok(b1.verdict === 'bitter', '够本但赔命 = bitter（有货的 bitter 是合法输出）', b1.verdict)
  ok(/圆石/.test(b1.memText) && !/白扔|白搭/.test(b1.memText), 'bitter 有货时只说弄到多少，不说"白扔"', b1.memText)
  ok(/死/.test(b1.memText), 'bitter 记得住这趟赔了命', b1.memText)
  show('记忆：' + b1.memText)

  // bitter 空手：要有判断，不能只是叙述
  const b2 = cost.memText(bill({ verdict: 'bitter', deaths: 2, worth: 0 }))
  ok(/不能再进|白扔|白搭/.test(b2), 'bitter 空手有落点，不是纯叙述', b2)

  // meh / ok 里的死亡不能吞
  const cm = new Cost(tmp(), { now: () => Date.now() })
  const b3 = cost.memText(bill({ verdict: 'meh', deaths: 1, gained: [{ item: 'cobblestone', n: 6 }], worth: 6 }))
  ok(/命|死/.test(b3), 'meh 有死亡要提（以前被吞）', b3)
  const b4 = cost.memText(bill({ verdict: 'ok', deaths: 2, gained: [{ item: 'raw_iron', n: 8 }], worth: 48 }))
  ok(/命|死/.test(b4), 'ok 有死亡要提（以前被吞）', b4)
  show('meh：' + b3 + ' ／ ok：' + b4)

  // 距离：跑老远要说出来
  const near = cost.memText(bill({ verdict: 'white', dist: 40 }))
  const far = cost.memText(bill({ verdict: 'white', dist: 420 }))
  ok(!/跑老远/.test(near) && /跑老远/.test(far), '走 420 格和走 40 格不会说同一句话', far)
  ok(/跑老远/.test(cost.billText(bill({ verdict: 'bitter', dist: 420, deaths: 1 }))), '账单里也会提"跑老远"')

  // 落点：meh 落在"我以后怎么做"，不是"换个地方"
  ok(/探一探/.test(b3), 'meh 的落点是自己的做法（下回先探一探），不是"换个地方"', b3)
  ok(!/挑个好点的地方/.test(b3), '不再把教训全推给地方')

  // 搭进去的东西要带动作，不能读成清单（"六块圆石，八根火把"）
  const burnTxt = cost.memText(bill({ verdict: 'meh', gained: [{ item: 'cobblestone', n: 6 }], spent: [{ item: 'torch', n: 8 }], burn: 8 }))
  ok(/搭进去八根火把/.test(burnTxt), '搭进去的东西带"还搭进去"，不是罗列', burnTxt)

  // bitter 有货但赔本明显：把"搭进去什么"说出来；赔得不多就别堆数字
  const leak = cost.memText(bill({ verdict: 'bitter', deaths: 1, worth: 9, gained: [{ item: 'cobblestone', n: 9 }], spent: [{ item: 'torch', n: 8 }], burn: 8 }))
  ok(/火把/.test(leak) && /圆石/.test(leak), '净赚但赔本时，搭进去的东西也要说', leak)
  const noLeak = cost.memText(bill({ verdict: 'bitter', deaths: 1, worth: 40, gained: [{ item: 'raw_iron', n: 7 }], spent: [{ item: 'torch', n: 2 }], burn: 2 }))
  ok(!/火把/.test(noLeak), '赔得不多时不再堆数字', noLeak)

  // 全部文案不许出现阿拉伯数字（日志腔）
  for (const v of ['white', 'bitter', 'meh', 'ok']) {
    const txt = cost.memText(bill({ verdict: v, deaths: 1, dist: 420, gained: [{ item: 'cobblestone', n: 9 }], worth: 9 }))
    ok(!/\d/.test(txt), `${v} 的记忆句里没有阿拉伯数字`, txt)
  }
}

// ================================================================
console.log('')
console.log(`${pass} 过 / ${fail} 挂`)
if (fail) process.exitCode = 1
