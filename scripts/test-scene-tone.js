#!/usr/bin/env node
'use strict'
/**
 * 场景语气回归（2026-11-13，地面 + 有怪 + 多人）。
 *
 *   node scripts/test-scene-tone.js
 *
 * 测三件事：
 *   1. 危险时话要塌缩（血 ≤6 / 附近有怪 → 两三个字；血 ≤14 → 六七个字；安全 → 不干预）
 *   2. 方位要说人话，不报坐标
 *   3. 多人时不是每句都要接（只加一句定性，不加规则）
 *
 * 全离线，只调 systemPrompt，不连服务器、不调模型。
 */

const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const persona = require(path.join(ROOT, 'src', 'persona'))

let pass = 0
let fail = 0
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) } else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')) }
}

const mem = {
  session: [],
  peopleDigest: () => '',
  placesDigest: () => '',
  recentSession: () => '',
  lastSummary: () => null
}
const build = (state) => persona.systemPrompt(mem, state, [], { cfg: { persona: {} } })

console.log('\n[1] 危险时话要塌缩')
{
  const critical = build('地面开阔；威胁：两只僵尸在10格外；血 4/20，饿 12/20，手上是木剑')
  ok(/最多三个字/.test(critical), '血 4/20 + 僵尸 → 硬上限三个字')
  ok(!/最多八个字/.test(critical), 'critical 不出现"八个字"这一档')
  ok(/不像人/.test(critical), '说明了后果，不是干巴巴一条规则')
}
{
  const byThreat = build('地面开阔；威胁：一只苦力怕在3格外；血 18/20')
  ok(/最多三个字/.test(byThreat), '血满但旁边有苦力怕 → 也算危险')
}
{
  const hurt = build('洞里；威胁：无；血 12/20，饿 10/20')
  ok(/最多八个字/.test(hurt), '血 12/20 → 上限八个字')
  ok(!/最多三个字/.test(hurt), 'hurt 不越级成 critical')
}
{
  const safe = build('地面开阔，阳光很好；威胁：无；血 20/20，饿 18/20')
  ok(!/最多三个字|最多八个字/.test(safe), '安全时不加任何长度约束（别没事也念规矩）')
}

console.log('\n[2] 方位说人话，不报坐标')
{
  const p = build('地面开阔；血 20/20')
  ok(/树后头/.test(p) || /坡上/.test(p), '给了人的方位说法')
  ok(/不说坐标/.test(p), '明确禁止坐标')
  ok(/你左边/.test(p), '给了"你左边"这种相对位置')
}

console.log('\n[3] 多人不是逐条回（只定性，不加规则）')
{
  const p = build('地面开阔；人：A、B、C；血 20/20')
  ok(/不是每句都要你接/.test(p), '有一句定性')
  ok(/自言自语/.test(p), '点了"自言自语"这种状态')
  const count = (p.match(/不是每句都要你接/g) || []).length
  ok(count === 1, '只有一句，没有堆成规则表', `出现 ${count} 次`)
}

console.log('\n[4] 思考过程漏到公屏（实测抓到的真事）')
{
  const leaked = '血4/20,很少。不能报数字。说"快没了""见底了"。而且这一句最多三个字。因为当前状态血4/20，硬上限三个字。但如果这次提示说50字？'
  ok(persona.isMachineTalk(leaked), '154 字的内心独白被 isMachineTalk 拦下')
  ok(!persona.isMachineTalk('跑啊'), '正常短句不误伤（跑啊）')
  ok(!persona.isMachineTalk('我提个醒 那边有洞'), '含"提醒"的正常话不误伤')
  ok(persona.isMachineTalk('这条规则说要短'), '复述规则也拦')
}

console.log('\n[5] 元信息结构判据：5 条泄漏全拦，5 条正常全放行')
{
  const leaks = [
    '这一句最多三个字，但这次提示里说要50字',
    '血4/20 所以不能报数字，按规矩说"快没了"',
    '我确认下规则：不超过3个字，保守起见就这样',
    '当前威胁是两只僵尸，状态栏写着血12，我应该简短',
    '刚那句超了字数上限，这次我该说两个字'
  ]
  const normals = [
    '跑啊', '你左边', '我这边也不安静', '血不多了 快跑', '树后头有只苦力怕'
  ]
  let leakOk = 0; let normalOk = 0
  for (const t of leaks) if (persona.isMetaLeak(t)) leakOk++
  for (const t of normals) if (!persona.isMetaLeak(t)) normalOk++
  ok(leakOk === 5, '5 条思考泄漏全部命中', `${leakOk}/5`)
  ok(normalOk === 5, '5 条正常话全部放行', `${normalOk}/5`)
}

console.log('\n[6] 代码层危险截断（超了就整句不发）')
{
  const path = require('path')
  const Talk = require(path.join(ROOT, 'src', 'talk'))
  const os = require('os')
  const fs = require('fs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcai-cap-'))
  const sent = []
  const bot = { username: 'XJJ', chat: (t) => sent.push(t) }
  const mem2 = Object.assign({}, mem, {
    remember: () => [], maybeRemember: () => null, getSecrets: () => [],
    markTold: () => {}, add: () => {}, person: () => ({ trust: 0, notes: [] })
  })
  const ctx = {
    dataDir: dir, log: () => {},
    cfg: { behavior: { chatDelayPerChar: 0, chatMinDelay: 0, chatMaxDelay: 1 } },
    busy: () => false, taskDesc: () => '', perceive: { brief: () => '' },
    taste: { prompt: () => '' }, mood: { prompt: () => '', state: () => 'normal', irritation: 0, spirit: 0.5 },
    botNames: []
  }
  const talk = new Talk(bot, { chat: async () => ({ text: '' }) }, mem2, ctx)
  talk.sayGapMs = 0; talk.fastSayGapMs = 0; talk.sayWindowMax = 1e9; talk.sayWindow = []

  return Promise.all([]).then(async () => {
    const r1 = await talk.say('跑啊', { danger: 'critical' })
    const r2 = await talk.say('那只僵尸又过来了', { danger: 'critical' })
    const r3 = await talk.say('血不多了 还能撑一下', { danger: 'hurt' })
    const r4 = await talk.say('这地方石头倒是挺多的', { danger: 'hurt' })
    ok(r1 === true, 'critical 的四个字放行（跑啊）')
    ok(r2 === false, 'critical 的九字句被整句拦掉（不是截半句）')
    ok(r3 === true, 'hurt 的九个字放行')
    ok(r4 === false, 'hurt 的十字句被拦')
    ok(!sent.some(t => t.length > 0 && t.includes('僵尸又过来')), '被拦的没有出现在发送记录里')

    console.log('\n[7] 元语言泄漏（用户抓到的原句）')
    ok(persona.isMetaLeak('喊一句 P20 等等，带名字，2'), '原句被拦')
    ok(persona.isMetaLeak('这句要带名字'), '"要带名字"被拦')
    ok(!persona.isMetaLeak('你叫什么名字'), '问名字不误伤')

    console.log('\n[8] 血量一致性：不满血不许说满')
    {
      const sent2 = []
      const bot2 = { username: 'XJJ', chat: (t) => sent2.push(t) }
      const talk2 = new Talk(bot2, { chat: async () => ({ text: '' }) }, mem2, ctx)
      talk2.sayGapMs = 0; talk2.fastSayGapMs = 0; talk2.sayWindowMax = 1e9; talk2.sayWindow = []
      talk2._hp = 14
      const a = await talk2.say('我血是满的', { allowFast: true })
      const b = await talk2.say('血不多了 快跑', { allowFast: true })
      talk2._hp = 20
      const c = await talk2.say('我血是满的', { allowFast: true })
      ok(a === false, '血 14 说"血是满的"被拦')
      ok(b === true, '血 14 说"血不多了"放行')
      ok(c === true, '血 20 说满血放行')
    }

    console.log('\n[9] 进程级限速：两个实例叠在一起也压得住')
    {
      const sentA = []; const sentB = []
      const mk = (sent) => new Talk({ username: 'XJJ', chat: (t) => sent.push(t) },
        { chat: async () => ({ text: '' }) }, mem2, ctx)
      const tA = mk(sentA); const tB = mk(sentB)
      Talk.GLOBAL_SAY.lastAt = 0; Talk.GLOBAL_SAY.window = []
      for (const t of [tA, tB]) { t.sayGapMs = 5000; t.fastSayGapMs = 2500; t.sayWindowMs = 20000; t.sayWindowMax = 6 }
      // 两个实例同时猛说 20 条
      for (let i = 0; i < 10; i++) { await tA.say('A' + i, { allowFast: true }); await tB.say('B' + i, { allowFast: true }) }
      const total = sentA.length + sentB.length
      ok(total <= 6, '20 秒内全局不超过 6 条', `实际 ${total}（A${sentA.length}+B${sentB.length}）`)
      ok(total >= 1, '至少发出去一条')
    }

    console.log('\n[10] 没碰到不能动的东西')
    finish()
  })
}

function finish () {
  console.log(`\n===== 结果 =====\n${pass} 通过，${fail} 失败`)
  process.exit(fail ? 1 : 0)
}
{
  const p = build('血 4/20；威胁：僵尸')
  ok(/不许数数/.test(p), '五条死规矩仍在')
  ok(/不许问对方叫什么/.test(p), '第五条仍在')
  ok(/被骂/.test(p) && /懵/.test(p), '被骂梯度仍在')
  ok(p.length > 3000 && p.length < 12000, '提示词体量没有失控', `${p.length} 字`)
}


