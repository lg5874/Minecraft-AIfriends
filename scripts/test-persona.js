'use strict'
// 拟人化自测：说服 / 品味 / 心情
const path = require('path'), fs = require('fs'), os = require('os')

const { Persuasion, classify, APPROACH } = require('../src/persuasion')
const { Taste, KINDS } = require('../src/taste')
const Mood = require('../src/mood')
const { classify: classifyExp } = require('../src/impulse')

let pass = 0, fail = 0
function ok (cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name) }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aifriend-'))

console.log('\n[说服手段识别]')
ok(classify('求你了就这一次') === APPROACH.BEG, '求助')
ok(classify('你帮我的话分你一半铁') === APPROACH.BARGAIN, '给好处')
ok(classify('快点过来！') === APPROACH.COMMAND, '命令')
ok(classify('你不来我就拆了你房子') === APPROACH.THREAT, '威胁')
ok(classify('就我一个了没人帮我') === APPROACH.GUILT, '装可怜')

console.log('\n[说服：慢慢磨]')
{
  const p = new Persuasion(tmp())
  const ctx = { moodState: 'normal', trust: 2 }
  const TASK = '挖一箱石头'
  const seq = ['帮我挖一箱石头', '求你了就这一次', '我真的急用', '行行好嘛']
  let first
  const results = seq.map(m => p.ask({ who: '张三', task: TASK, what: m, effort: 0.6, ctx }))
  ok(!results[0].comply, '第一次会拒绝')
  ok(results[0].style === 'first_no', '第一次是正常拒绝，不是生气')
  ok(results[results.length - 1].pressure > results[0].pressure, '磨下去压力累积了')
}

console.log('\n[说服：给好处一次就成]')
{
  const p = new Persuasion(tmp())
  const r = p.ask({ who: '李四', task: '挖石头', what: '你帮我的话分你一半铁', effort: 0.6, ctx: { moodState: 'normal', trust: 2 } })
  ok(r.comply, '给好处能谈成')
  ok(r.style === 'deal', '表现为"成交"')
}

console.log('\n[说服：威胁会被记恨]')
{
  const p = new Persuasion(tmp())
  p.ask({ who: '王五', task: '挖石头', what: '帮我挖', effort: 0.6, ctx: { moodState: 'normal', trust: 0 } })
  const r = p.ask({ who: '王五', task: '挖石头', what: '你不来我就拆了你房子', effort: 0.6, ctx: { moodState: 'normal', trust: 0 } })
  ok(r.irritation > 0.3, '威胁会让他烦躁')
  ok(r.warmth < 0, '威胁会伤感情')
}

console.log('\n[品味：一开始什么都没有]')
{
  const t = new Taste(tmp())
  ok(t.likes().length === 0 && t.dislikes().length === 0, '开局没有预设偏好')
  ok(t.prompt().includes('还不太清楚自己喜欢什么'), '提示词里明说"还不知道"')
}

console.log('\n[品味：自己长出来]')
{
  const t = new Taste(tmp())
  for (let i = 0; i < 3; i++) t.record({ what: '山顶看风景', kinds: [KINDS.HEIGHT], feeling: 0.85, now: i })
  ok(t.likes().length === 0, '3 次还定型不了（不该这么快）')
  for (let i = 3; i < 8; i++) t.record({ what: '山顶看风景', kinds: [KINDS.HEIGHT], feeling: 0.85, now: i })
  ok(t.likes().some(x => x.kind === KINDS.HEIGHT), '8 次后长出了"喜欢高处"')
  for (let i = 0; i < 6; i++) t.record({ what: '地下挖矿', kinds: [KINDS.UNDERGROUND], feeling: -0.7, now: i })
  ok(t.dislikes().some(x => x.kind === KINDS.UNDERGROUND), '挖矿挖烦了，长出"不喜欢地下"')
  ok(t.feel(KINDS.HEIGHT) > 0.2, '好感度是正数')
  ok(t.feel(KINDS.UNDERGROUND) < -0.1, '反感度是负数')
}

console.log('\n[品味：会淡]')
{
  const t = new Taste(tmp())
  for (let i = 0; i < 20; i++) t.record({ what: '山顶', kinds: [KINDS.HEIGHT], feeling: 0.9, now: i })
  const before = t.feel(KINDS.HEIGHT)
  t.decay(5000)
  const after = t.feel(KINDS.HEIGHT)
  ok(Math.abs(after) < Math.abs(before), `很久没去，喜欢淡了（${before.toFixed(2)} -> ${after.toFixed(2)}）`)
}

console.log('\n[心情：影响迁就意愿]')
{
  const m = new Mood(tmp())
  m.energy = 0.9; m.spirit = 0.9; m.irritation = 0.05; m.satisfaction = 0.85
  const good = m.willingness()
  m.energy = 0.1; m.spirit = 0.2; m.irritation = 0.9; m.satisfaction = 0.3
  const bad = m.willingness()
  ok(good > bad, `心情好更愿意迁就（${good.toFixed(2)} vs ${bad.toFixed(2)}）`)
  ok(m.state() === 'irritated', '烦躁时状态是 irritated')
}

console.log('\n[心情：事件影响]')
{
  const m = new Mood(tmp())
  const e0 = m.energy
  m.onEvent('task_done', 1)
  ok(m.energy < e0, '干完活会累')
  const s0 = m.spirit
  m.onEvent('death', 1)
  ok(m.spirit < s0, '死了会打击兴致')
  const i0 = m.irritation
  m.onEvent('hurt', 1)
  ok(m.irritation > i0, '挨打会烦')
}

console.log('\n[体验归类]')
{
  ok(classifyExp('爬到山顶看风景').includes(KINDS.HEIGHT), '识别"高处"')
  ok(classifyExp('在地下挖了半天矿').includes(KINDS.UNDERGROUND), '识别"地下"')
  ok(classifyExp('跟张三一起盖了个房').includes(KINDS.BUILDING), '识别"建造"')
  ok(classifyExp('跟张三一起盖了个房').includes(KINDS.SOCIAL), '识别"跟人一起"')
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
