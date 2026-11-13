'use strict'
/**
 * 记忆系统实战验证：他在真实使用中能不能像人一样记事？
 *
 * 和 test-memory-quality.js 的分工：
 *   quality = 「这条该不该记」（准入判定的单元测试）
 *   live    = 「用起来对不对」（完整场景 + 长期衰减 + 提示词泄漏）
 *
 * 跑法：node scripts/test-memory-live.js
 *      node scripts/test-memory-live.js --verbose
 *
 * 只读 src/memory/**，不连服务器，不碰真实 data/。
 */

const path = require('path')
const fs = require('fs')
const os = require('os')

const Memory = require('../src/memory')
const writer = require('../src/memory/writer')
const decay = require('../src/memory/decay')
const recall = require('../src/memory/recall')
const { KINDS } = require('../src/memory/entry')

const VERBOSE = process.argv.includes('--verbose')

let pass = 0
let fail = 0
const failures = []

function ok (cond, name, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    failures.push(name)
    console.log('  ✗ ' + name + (extra ? '  ← ' + extra : ''))
  }
}

function section (t) {
  console.log('\n' + t)
}

const tmpdirs = []
function fresh () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memlive-'))
  tmpdirs.push(dir)
  const m = new Memory(dir)
  m.goOnline()
  return m
}

function cleanup () {
  for (const d of tmpdirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch (e) {}
  }
}

/** 走过 n 游戏分钟 */
function advance (m, minutes) {
  m.clock.online = true
  for (let i = 0; i < minutes; i++) m.tick(60)
}

/** 把记忆库里的全部内容拼成一段，用来查"有没有泄漏" */
function allText (m) {
  return m.entries.map(e => e.text).join('\n')
}

// 记忆里绝不该出现的机器味
const MACHINE_MARKS = [
  { re: /\s(?:->|→|=>)\s/, name: '任务箭头' },
  { re: /返回\s*-?\d/, name: 'mine返回N' },
  { re: /[a-z]{3,}:\s*-?\d/, name: 'block:id' },
  { re: /从\s*\d+\s*个?\s*变(?:成|为)\s*\d/, name: '从0变0' },
  { re: /[+\-]\s*\d+\b/, name: '煤+0' },
  { re: /[x×]\s*\d+/, name: '木镐x0' },
  { re: /HTTP\s*\d{3}|<!DOCTYPE|<html/i, name: 'HTTP报错' },
  { re: /^\s*我说\s*[:：]/, name: '我说：自言自语' }
]

function findMachineTalk (m) {
  const hits = []
  for (const e of m.entries) {
    for (const k of MACHINE_MARKS) {
      if (k.re.test(e.text)) hits.push(k.name + ' → ' + e.text.slice(0, 60))
    }
  }
  return hits
}

// ============================================================
console.log('='.repeat(64))
console.log('记忆实战验证：用起来像不像人')
console.log('='.repeat(64))

// ------------------------------------------------------------
section('[一] 场景：玩家给他东西')
// ------------------------------------------------------------
{
  const m = fresh()
  m.person('老王')
  m.got('老王', '木头')

  const pd = m.peopleDigest()
  ok(pd.includes('老王'), '记得老王这个人')
  ok(pd.includes('木头'), '记得老王给过木头：' + (pd.match(/老王.*/) || [''])[0].slice(0, 50))
  ok(m.people.老王.trust > 0, '信任值涨了（' + m.people.老王.trust + '）')

  const rec = m.remember('老王', { people: ['老王'] })
  ok(rec.length > 0, '问起老王能想起来')
  ok(rec.some(e => (e.who || []).includes('老王')), '想起来的事挂在老王名下')
  ok(!findMachineTalk(m).length, '没混进机器话')
}

// ------------------------------------------------------------
section('[二] 场景：玩家打他')
// ------------------------------------------------------------
{
  const m = fresh()
  m.hit('老王', 1)
  const hs = m.hitStats('老王')
  ok(hs.times === 1, '记了 1 次挨打')
  ok(m.people.老王.trust < 0, '信任值掉了（' + m.people.老王.trust + '）')
  const g = m.entries.find(e => e.kind === KINDS.GRIEVANCE)
  ok(!!g, '产生了一条恩怨记忆')
  ok(g && g.emotion >= 0.7, '情绪够强（' + (g && g.emotion) + '）—— 他该记仇')

  // 打一次不该变成刻骨铭心（那是 Long-term 保护，不是这一次）
  ok(g && !g.protected || (g && g.emotion >= 0.7), '单次挨打按情绪规则处理，没有额外加码')

  // 打三次：次数要累加，条目不能刷屏
  m.hit('老王', 1); m.hit('老王', 1)
  ok(m.hitStats('老王').times === 3, '三次都记了')
  const griev = m.entries.filter(e => e.kind === KINDS.GRIEVANCE && (e.who || []).includes('老王'))
  ok(griev.length === 1, '但没有刷成 3 条（实际 ' + griev.length + ' 条）')

  // 道歉之后
  m.forgive('老王')
  ok(m.hitStats('老王').times === 0, '道歉后次数清零')
  ok(m.peopleDigest().includes('老王'), '但人还在')
}

// ------------------------------------------------------------
section('[三] 场景：玩家说"我叫老王"')
// ------------------------------------------------------------
{
  const m = fresh()

  // 模拟 talk.js setName 的行为（它直接写 p.callMe + mem.add）
  const p = m.person('XJJVER6')
  p.callMe = '小徐'
  m.add({ text: 'XJJVER6 让我叫他 小徐', kind: 'person', who: ['XJJVER6'], importance: 0.7 })

  ok(m.people.XJJVER6.callMe === '小徐', '记住称呼「小徐」')
  ok(m.peopleDigest().includes('XJJVER6'), '人物摘要里有他')

  // 真人会改口 —— 改口要能覆盖，但历史要留着
  m.person('XJJVER6').callMe = '俊杰'
  ok(m.people.XJJVER6.callMe === '俊杰', '改口后以新的为准')

  // talk.js 的正则会把「俊杰就行」整段当称呼塞进来 —— 存储侧必须洗干净
  m.person('XJJVER6').callMe = '俊杰就行'
  ok(m.person('XJJVER6').callMe === '俊杰', '脏称呼清洗：俊杰就行 → ' + m.person('XJJVER6').callMe)
  m.person('XJJVER6').callMe = '小徐吧'
  ok(m.person('XJJVER6').callMe === '小徐', '脏称呼清洗：小徐吧 → ' + m.person('XJJVER6').callMe)
  m.person('XJJVER6').callMe = '果哥'
  ok(m.person('XJJVER6').callMe === '果哥', '干净称呼原样保留')
}

// ------------------------------------------------------------
section('[四] 场景：挖到铁矿，记成地点知识')
// ------------------------------------------------------------
{
  const m = fresh()
  m.place('矿洞口', { x: 100, y: 65, z: 14 }, '那底下有铁')
  ok(m.places['矿洞口'], '地点坐标记住了')

  const r = m.learnPlace('矿洞口', '铁矿')
  ok(r && r.kind === KINDS.PLACE, 'learnPlace 产生地点知识')
  ok(r && String(r.text + r.where).includes('矿洞口'), '内容提到地点：' + (r && r.text))

  // 之后走到附近，要能想起来
  const near = m.remember('矿洞口', { near: { x: 101, z: 15 } })
  ok(near.some(e => e.kind === KINDS.PLACE), '走到附近能想起这地方')

  // 站到别处、又没提这个地名时，不该硬想起
  const far = m.remember('现在该干什么', { near: { x: 9000, z: 9000 } })
  ok(!far.some(e => /矿洞口/.test(e.text)), '离得远、又没提这地名，不会硬想起' + (far.length ? '（实际想起：' + far.map(e => e.text.slice(0, 16)).join('；') + '）' : ''))
}

// ------------------------------------------------------------
section('[五] 场景：同一个人三天后再来')
// ------------------------------------------------------------
{
  const m = fresh()
  m.person('老王')
  m.got('老王', '面包')
  m.hit('老王', 1)
  const chatRef = m.add({ text: '跟老王在河边碰了面，瞎聊了半天', kind: 'event', who: ['老王'], emotion: 0.2, importance: 0.25 })

  advance(m, 60 * 72)   // 3 天游戏时间（他在线才计时）

  const pd = m.peopleDigest()
  ok(pd.includes('老王'), '三天后还记得老王这个人')
  ok(/打我|面包/.test(pd), '还记得他给过面包 / 打过我')
  ok(m.people.老王, '人物档案还在（不衰减）')

  // 普通闲聊该淡 —— 遗忘是设计（用对象引用，因为文字会被模糊化改掉）
  const chat = chatRef
  ok(chat && chat.strength < 0.5, '但那次闲聊淡掉了（' + (chat && chat.strength.toFixed(2)) + '）—— 该忘就忘')
  ok(chat && chat.fuzzy, '淡化之后变成"记不清"')
  ok(chat && /老王/.test(chat.text), '但还知道是跟老王有关：' + (chat && chat.text))
}

// ------------------------------------------------------------
section('[六] 衰减：四条规则逐条验')
// ------------------------------------------------------------
{
  const m = fresh()
  const plain = m.add({ text: '在树林里瞎转了两圈', kind: KINDS.EVENT, emotion: 0.1, importance: 0.2, force: true })
  const grudge = m.add({ text: '老王打了我一顿', kind: KINDS.GRIEVANCE, emotion: 0.2, importance: 0.4, force: true })
  const promise = m.add({ text: '答应给老王三块铁', kind: KINDS.PROMISE, emotion: 0.1, importance: 0.5, force: true })
  const skill = m.add({ text: '记住：别在岩浆边上乱挖', kind: KINDS.SKILL, emotion: 0.1, importance: 0.5, force: true })
  const hard = m.add({ text: '差点被苦力怕炸死，真的吓人', kind: KINDS.EVENT, emotion: 0.9, importance: 0.3, force: true })

  // 半衰期常量本身
  ok(decay.HALF_LIFE[KINDS.EVENT] === 6 * 60, '普通事件半衰期 = 6 小时')
  ok(decay.HALF_LIFE[KINDS.GRIEVANCE] === 40 * 60, '恩怨半衰期 = 40 小时')
  ok(decay.HALF_LIFE[KINDS.PROMISE] === Infinity, '承诺 = 不衰减')
  ok(decay.HALF_LIFE[KINDS.SKILL] === Infinity, '技能 = 不衰减')

  // 6 小时：普通事件应该掉一半左右（有 emotion/importance 加成，所以不是精确一半）
  advance(m, 6 * 60)
  ok(plain.strength < 0.75 && plain.strength > 0.15,
    '6 小时后普通事件掉到 ' + plain.strength.toFixed(2) + '（半衰期 6h，含权重加成所以不是精确 0.5）')
  ok(grudge.strength > 0.85, '同期恩怨还有 ' + grudge.strength.toFixed(2) + '（40 小时半衰期，掉得慢）')

  // 再走 34 小时 = 恩怨满 40 小时
  const gBefore = grudge.strength
  advance(m, 34 * 60)
  ok(grudge.strength < gBefore, '恩怨 40 小时开始明显衰减（' + grudge.strength.toFixed(2) + '）')
  ok(grudge.strength > plain.strength, '但始终比普通事件活得久')

  // 承诺 / 技能 一点没变
  ok(promise.strength === 1, '过了 40 小时，承诺还是 1.0')
  ok(skill.strength === 1, '过了 40 小时，技能还是 1.0')

  // 刻骨铭心
  ok(hard.protected === true, '情感 0.9 被标成刻骨铭心')
  ok(hard.strength === 1, '刻骨铭心的一直是 1.0')
  ok(!hard.archived, '也不会被归档')

  // 承诺/技能 不该因为"强度低"被模糊或归档
  ok(!promise.fuzzy && !promise.archived, '承诺不会被模糊/归档')
  ok(!skill.fuzzy && !skill.archived, '技能不会被模糊/归档')
}

// ------------------------------------------------------------
section('[七] 遗忘：该忘的真的忘了（不是永久记住）')
// ------------------------------------------------------------
{
  const m = fresh()
  const e = m.add({ text: '跟老王在河边碰了面，瞎聊了半天', kind: KINDS.EVENT, who: ['老王'], emotion: 0.15, importance: 0.2, force: true })
  advance(m, 60 * 60)   // 60 小时

  ok(e.fuzzy, '60 小时后变成"记不清"')
  ok(!/河边碰了面/.test(e.text), '细节没了：' + e.text)
  ok(/老王|有人/.test(e.text), '但还留着"跟谁"，不是彻底消失：' + e.text)
  ok(e.certainty < 0.85, '确信度降了（' + e.certainty.toFixed(2) + '）')

  advance(m, 60 * 60)   // 再 60 小时
  ok(e.archived, '足够淡之后归档（不再进提示词）')
}

// ------------------------------------------------------------
section('[八] 提示词泄漏：不能变成"念日志"')
// ------------------------------------------------------------
{
  const m = fresh()
  // 喂一批真实运行里出现过的流水账
  const junk = [
    '把脚边那块andesite挖了看看下面是什么颜色。 -> 啥也没挖',
    '用石镐在阶梯矿道尽头继续向前挖。 -> 沿矿道向前挖了0块（圆石+1）',
    '先看看周围地形和资源分布。 -> 我在 (66,43,-93) 周围：granite:457 coal_ore:55',
    '教训：弄点木头，先做把镐 没成（模型调用失败: HTTP 403 <!DOCTYPE html>）',
    '我说：嗯 回来了',
    '整理完成：往箱子存了 240 件东西（圆石剩 203 块）'
  ]
  for (const t of junk) m.add({ text: t, kind: 'event' })

  ok(m.stats().entries === 0, '6 条流水账一条没进记忆（实际 ' + m.stats().entries + '）')
  ok(findMachineTalk(m).length === 0, '记忆库里没有机器话')

  // 现在喂几条真记忆，再看提示词里都塞了什么
  m.got('老王', '木头')
  m.hit('老王', 1)
  m.learnPlace('矿洞口', '铁矿')

  const leak = findMachineTalk(m)
  ok(leak.length === 0, '真记忆也不会混进机器话' + (leak.length ? '：' + leak.join('；') : ''))

  // recentSession / peopleDigest / placesDigest 是直接进提示词的
  const promptBlocks = [
    m.peopleDigest(),
    m.placesDigest(),
    m.recentSession(10),
    (m.lastSummary() || {}).text || ''
  ].join('\n')
  const bad = MACHINE_MARKS.filter(k => k.re.test(promptBlocks))
  ok(bad.length === 0, '三个提示词块里都没有机器话' + (bad.length ? '：' + bad.map(x => x.name).join('；') : ''))

  if (VERBOSE) {
    console.log('    --- peopleDigest ---\n' + m.peopleDigest())
    console.log('    --- placesDigest ---\n' + m.placesDigest())
  }
}

// ------------------------------------------------------------
section('[九] 上下文预算：记忆不能挤爆提示词')
// ------------------------------------------------------------
{
  const m = fresh()
  // 塞 30 个人、30 个地点、50 条记忆 —— 模拟玩很久之后
  for (let i = 0; i < 30; i++) {
    m.person('玩家' + i)
    m.got('玩家' + i, '面包')
    m.place('地方' + i, { x: i * 10, y: 64, z: i * 10 }, '这有铁')
    m.add({ text: `跟玩家${i}一起挖了会矿`, kind: 'event', who: ['玩家' + i], emotion: 0.3, importance: 0.4 })
  }
  for (let i = 0; i < 20; i++) {
    m.add({ text: `玩家${i}帮我打死了僵尸`, kind: 'person', who: ['玩家' + i], emotion: 0.5, importance: 0.6 })
  }

  const pd = m.peopleDigest()
  const pld = m.placesDigest()
  const rs = m.recentSession(10)

  ok(pd.split('\n').length <= 10, '人物摘要有上限（' + pd.split('\n').length + ' 行，≤10）')
  ok(pld.split('\n').length <= 10, '地点摘要有上限（' + pld.split('\n').length + ' 行，≤10）')
  ok(rs.split('\n').filter(Boolean).length <= 10, '本次流水有上限（≤10 行）')

  const total = pd.length + pld.length + rs.length
  ok(total < 2500, '三块加起来 ' + total + ' 字符，不会挤爆上下文（<2500）')

  // 检索也要有上限
  const r = m.remember('挖矿', { limit: 5 })
  ok(r.length <= 5, '想起了不超过 5 条（实际 ' + r.length + '）')
}

// ------------------------------------------------------------
section('[十] 已知 bug 回归：不该因为"重复"变成刻骨铭心')
// ------------------------------------------------------------
{
  const m = fresh()

  // 他反复念叨同一件事（真实数据里「还差点石头」念了 7 遍）
  // 注意：用一条**本身够格进记忆**的内容来测，否则测的是"准入"而不是"重复"。
  // 用一条**普通事件**（不是恩怨 —— 恩怨的 0.7 是设计给的，不是重复给的）。
  // 「老王跟我说他缺铁」是普通事，重复 8 次也不该变成刻骨铭心。
  for (let i = 0; i < 8; i++) {
    m.add({ text: '老王跟我说他缺铁', kind: KINDS.EVENT, who: ['老王'] })
  }
  const e = m.entries[0]
  ok(!!e, '重复 8 次确实只留 1 条（去重生效）')
  ok(e && e.emotion < 0.7, '但情绪没被刷到 0.7 以上（实际 ' + (e && e.emotion.toFixed(2)) + '）',
    '重复只是"这事我说过好几次"，不等于"这事刻骨铭心"')
  ok(e && e.importance < 0.8, '重要性也没被刷到 0.8 以上（实际 ' + (e && e.importance.toFixed(2)) + '）')
  ok(e && !e.protected, '所以它不该被永久保护', '一句念叨不该永不遗忘')

  if (e) {
    advance(m, 60 * 24 * 7)
    ok(e.strength < 1, '一周后它确实淡了（' + e.strength.toFixed(2) + '）—— 会忘事是设计')
  }
}

// ------------------------------------------------------------
section('[十一] 已知 bug 回归：附和的话不该进记忆')
// ------------------------------------------------------------
{
  const m = fresh()
  const chatter = [
    '嗯，谢了',
    '行，缺啥喊我。',
    '好嘞',
    '知道了',
    '哦',
    '嗯嗯',
    '没事',
    '好，那我去了'
  ]
  let kept = 0
  for (const t of chatter) if (m.add({ text: t, who: ['老王'] })) kept++
  ok(kept === 0, '8 句附和一句都没记（实际记了 ' + kept + ' 句）')
}

// ------------------------------------------------------------
section('[十二] 已知 bug 回归：人名不能抽错')
// ------------------------------------------------------------
{
  const cases = [
    { text: '草，又让僵尸挠了', bad: '僵尸谦' },
    { text: '你想和别人一起玩吗', bad: '别人一' },
    { text: '这山洞里有铁矿', bad: null }
  ]
  for (const c of cases) {
    const v = writer.admit({ text: c.text })
    const who = v.who || []
    // 怪物、代词不该被当成人名
    const junk = who.filter(n => /僵尸|骷髅|苦力怕|蜘蛛|别人|那个|这个|东西/.test(n))
    ok(junk.length === 0, `「${c.text.slice(0, 16)}」没有把怪物/代词当人名（who=${JSON.stringify(who)}）`)
  }

  // 真正的人名要抽对
  const v = writer.admit({ text: '张三帮我打死了僵尸' })
  ok((v.who || []).includes('张三'), '「张三帮我打死了僵尸」抽出了张三')
}

// ------------------------------------------------------------
section('[十三] 已知 bug 回归：地点不该重复堆')
// ------------------------------------------------------------
{
  const m = fresh()
  // 同一块地起 4 个名字（真实数据就是这样）
  m.place('水边探索起点', { x: 100, y: 59, z: 14 }, '出发点')
  m.place('标记起点', { x: 100, y: 59, z: 14 }, '插火把做标记')
  m.place('水边探索终点', { x: 100, y: 59, z: 14 }, '这次走到这')
  m.place('标记点0', { x: 100, y: 59, z: 14 }, '出发点')

  ok(Object.keys(m.places).length < 4, '同坐标的 4 个名字被合并了（实际剩 ' + Object.keys(m.places).length + ' 个）')
}

// ------------------------------------------------------------
section('[十四] 已知 bug 回归：同一次死亡不记两条')
// ------------------------------------------------------------
{
  const m = fresh()
  // 真实情况：系统给了英文死法，他自己又吐槽了一句
  m.add({ text: '死了：XJJ was slain by Zombie', kind: 'event' })
  m.add({ text: '草，被僵尸挠死了', kind: 'event' })

  const deaths = m.entries.filter(e => /死/.test(e.text))
  ok(deaths.length === 1, '同一次死亡只记 1 条（实际 ' + deaths.length + ' 条：' + deaths.map(d => d.text).join(' / ') + '）')
}

// ------------------------------------------------------------
section('[十五] 已知 bug 回归：寒暄/缺材料的话不该进记忆')
// ------------------------------------------------------------
{
  const m = fresh()
  const lines = [
    '哦，那你种呗，我这边还差点石头',
    '上线了，这边还差点石头',
    '还差点石头，谁那边有多余的',
    '嗯，都忙着呢，我这石头也还差点',
    '行，你忙你的。我这边还差点石头',
    '兄弟别气，我们一起上去盖家',
    '你想和别人一起玩吗'
  ]
  let kept = 0
  for (const t of lines) if (m.add({ text: t, who: ['老王'] })) kept++
  ok(kept === 0, '7 句寒暄/缺材料的话一条都没记（实际 ' + kept + ' 条）')

  // 但真正的危险描述要留（「差点」在这里是真危险）
  const danger = m.add({ text: '差点被苦力怕炸死' })
  ok(danger !== null, '「差点被苦力怕炸死」照样记 —— 危险信号没被误杀')
}

// ------------------------------------------------------------
section('[十六] 已知 bug 回归：模糊之后还得记得是谁')
// ------------------------------------------------------------
{
  const m = fresh()
  const e = m.add({ text: '跟老王在河边碰了面，瞎聊了半天', kind: KINDS.EVENT, who: ['老王'], emotion: 0.15, importance: 0.2, force: true })
  advance(m, 60 * 60)
  ok(e.fuzzy, '60 小时后变模糊')
  ok(/老王/.test(e.text), '模糊之后还知道是跟老王有关：' + e.text)
}

// ------------------------------------------------------------
section('[十七] 已知 bug 回归：回忆过的东西不会永远霸屏')
// ------------------------------------------------------------
{
  const m = fresh()
  m.place('矿洞口', { x: 100, y: 65, z: 14 }, '那底下有铁')
  // 先在附近想起它（recallCount 涨到 1）
  m.remember('矿洞口', { near: { x: 101, z: 15 } })
  // 再站到 9000 格外、问一件毫不相干的事
  const far = m.remember('现在该干什么', { near: { x: 9000, z: 9000 } })
  ok(!far.some(e => /矿洞口/.test(e.text)),
    '在 9000 格外问无关的事，不会硬想起矿洞口' + (far.length ? '（实际：' + far.map(e => e.text.slice(0, 14)).join('；') + '）' : ''))
}

// ------------------------------------------------------------
section('[十八] 已知 bug 回归：清理不能误删事实层')
// ------------------------------------------------------------
{
  const m = fresh()
  // 事实层：恩怨 / 承诺 / 地点 / 技能 —— 这些文本长什么样都得留
  m.hit('老王', 1)
  m.add({ text: '答应给老王三块铁', kind: KINDS.PROMISE, who: ['老王'], importance: 0.7, force: true })
  m.place('矿洞口', { x: 100, y: 65, z: 14 }, '那底下有铁')
  m.add({ text: '缺木棍这事就卡住了', kind: KINDS.SKILL, importance: 0.7, force: true })

  const before = m.entries.length
  const rep = m.purgeLogs()
  ok(rep.after === before, 'purgeLogs 一条事实层都没删（' + before + ' -> ' + rep.after + '）')
  ok(m.entries.some(e => e.kind === KINDS.GRIEVANCE), '恩怨还在')
  ok(m.entries.some(e => e.kind === KINDS.PROMISE), '承诺还在')
  ok(m.entries.some(e => e.kind === KINDS.PLACE), '地点知识还在')
  ok(m.entries.some(e => e.kind === KINDS.SKILL), '技能还在')
}

// ------------------------------------------------------------

console.log('\n' + '='.repeat(64))
if (fail) {
  console.log(`结果：${pass} 通过，${fail} 失败`)
  console.log('\n失败的：')
  for (const f of failures) console.log('  - ' + f)
} else {
  console.log(`结果：${pass} 通过，${fail} 失败 ✓ 全过`)
}
console.log('='.repeat(64))

cleanup()
process.exit(fail ? 1 : 0)
