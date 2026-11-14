#!/usr/bin/env node
'use strict'
/**
 * 未覆盖改动的验收测试（2026-11-14）
 *
 *   node scripts/test-owner-changes.js
 *
 * 【为什么有这个文件】
 * 07:11 全量回归 1466 项全绿，但 `grep -r` 全 scripts/ 找不到下列标识：
 *     MANY_QUOTES / META_WORD_CHECK / containerLoss / robbed / outText
 * 也就是说：**全绿不等于这几处被测到了**。这几处都是今天现改的，
 * 一旦回归没人拦得住。这个文件只补这三处，不重复别的测试。
 *
 * 覆盖：
 *   A. src/talk.js    MANY_QUOTES（一句多个引号短语）+ META_WORD_CHECK（点评自己用词）
 *   B. src/talk.js    复读存储 10 条 -> 30 分钟（第 11 条之后原句不能被挤出去）
 *   C. src/session.js robbed 只认 containerLoss（身上少东西不许指控别人偷）
 *   D. main.js        outText 清理（undefined/null/NaN -> ?，>2 位小数 -> 1 位）
 *
 * 只读 src/、main.js。不连服务器、不调模型。
 */

const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const Talk = require(path.join(ROOT, 'src', 'talk'))
const { Session: SessionClass } = require(path.join(ROOT, 'src', 'session'))

let pass = 0
let fail = 0
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}

// ================================================================
// A + B 用同一套 mock（和 test-talk-speakgate.js 一致）
function mkMem () {
  return {
    people: {},
    secrets: [],
    person (n) { if (!this.people[n]) this.people[n] = { trust: 0, notes: [] }; return this.people[n] },
    remember () { return [] },
    maybeRemember () { return null },
    getSecrets () { return [] },
    markTold () {}, add () {},
    peopleDigest () { return '（还不认识谁）' },
    placesDigest () { return '（还没记地方）' },
    recentSession () { return '' },
    lastSummary () { return null },
    addSecret () { return null }
  }
}

function mkTalk (lines = []) {
  const os = require('os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-chg-'))
  const sent = []
  const logs = []
  const q = lines.slice()
  const bot = { username: 'XJJ', chat (t) { sent.push(t) } }
  const llm = { async chat () { return { text: q.length ? q.shift() : '[不说]' } } }
  const ctx = {
    dataDir: dir,
    log: (m) => logs.push(m),
    // 延迟给 0：本文件测的是判据，不是限速窗口
    cfg: { behavior: { chatDelayPerChar: 0, chatMinDelay: 0, chatMaxDelay: 0 } },
    busy: () => false,
    taskDesc: () => '',
    perceive: { brief: () => '' },
    taste: { prompt: () => '' },
    mood: { prompt: () => '', state: () => 'normal', irritation: 0, spirit: 0.5 },
    botNames: []
  }
  Talk.GLOBAL_SAY.lastAt = 0
  Talk.GLOBAL_SAY.window = []
  return { talk: new Talk(bot, llm, mkMem(), ctx), sent, logs, dir }
}

async function main () {
  // ================================================================
  console.log('\n[A] talk.js：MANY_QUOTES + META_WORD_CHECK')
  {
    // 拦 = 在念提示词 / 点评自己怎么说
    const mustBlock = [
      ['我必须不去想「我怎么看昨天」「这一局」', 'MANY_QUOTES｜06:59:18 现场原句'],
      ['你说过的话里这个最好', 'META_WORD_CHECK｜「你说过的话」'],
      ['刚才用过太多次了', 'META_WORD_CHECK｜「用过太多」'],
      ['别再用那个词了', 'META_WORD_CHECK｜「别再用」'],
      ['换个说法吧', 'META_WORD_CHECK｜「换个说法」']
    ]
    for (const [s, why] of mustBlock) {
      ok(Talk.isInstructionLeak(s) === true, '拦住：' + why, JSON.stringify(s.slice(0, 24)))
    }
    // 放 = 正常说话（一个引号短语是引用，不是列举）
    const mustPass = [
      ['他说「你好」就走了', '只有一个引号短语'],
      ['你猜怎么着「挖到了」', '单个引号'],
      ['我找个树先', '普通句子'],
      ['天黑这么快', '普通句子'],
      ['嗯 骷髅这箭法可以', '带语气词']
    ]
    for (const [s, why] of mustPass) {
      ok(Talk.isInstructionLeak(s) === false, '放行：' + why, JSON.stringify(s.slice(0, 24)))
    }
  }

  // ================================================================
  console.log('\n[B] talk.js：复读存储 10 条 -> 30 分钟')
  {
    // 现场：06:12:45 与 06:27:56 一字不差，中间隔了 14 条 [say]。
    // 旧代码 `if (length > 10) shift()` 把原句挤出窗口 -> 30 分钟窗口形同虚设。
    const filler = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸', '子', '丑', '寅']
      .map(x => '第' + x + '句话')
    const { talk, sent, dir } = mkTalk(['快挺不住了', ...filler, '[不说]'])
    const first = await talk.say('快挺不住了')
    ok(first === true, '第 1 次说得出去')
    // 中间夹 13 句别的话，且保证不被限速拦（直接把窗口时间戳往前拨）
    for (const f of filler) {
      talk.lastSayAt = 0
      talk.lastSpokeAt = 0
      Talk.GLOBAL_SAY.lastAt = 0
      talk.sayWindow = []
      Talk.GLOBAL_SAY.window = []
      await talk.say(f)
    }
    talk.lastSayAt = 0
    talk.lastSpokeAt = 0
    Talk.GLOBAL_SAY.lastAt = 0
    talk.sayWindow = []
    Talk.GLOBAL_SAY.window = []
    const again = await talk.say('快挺不住了')
    ok(again === false, '隔了 13 句之后同一句仍被拦（旧代码这里会放行）', 'sent=' + sent.filter(x => x === '快挺不住了').length + ' 条')
    ok(sent.filter(x => x === '快挺不住了').length === 1, '公屏上这句只有 1 条')
    ok(talk.recentSaid.length > 10, 'recentSaid 存得下 10 条以上', '实际 ' + talk.recentSaid.length + ' 条')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ================================================================
  console.log('\n[C] session.js：robbed 只认 containerLoss')
  {
    // 现场：一晚死 6 次，死亡掉落/合成/吃东西全被算成「身上的东西少了」-> 指控别人偷
    //   [06:17:29] [say] 我东西呢 少了一堆
    //
    // onComplain() 自己带概率和节流，直接看返回值会抖。所以把它的调用**记下来**，
    // 只验「会不会走到 robbed 这条路」，这才是这次改动要保证的东西。
    const spont = require(path.join(ROOT, 'src', 'spontaneous'))
    const realComplain = spont.onComplain
    const calls = []
    spont.onComplain = (kind, text) => { calls.push({ kind, text }); return null }

    function run (diff) {
      calls.length = 0
      const pushed = []
      const s = Object.create(SessionClass.prototype)
      s._push = (ev) => pushed.push(ev)
      // 注意：_speakReturn 开头 `if (!lines || !lines.length) return`，
      // 传空数组会直接早退（第一版就踩了这个坑，假绿）
      s._speakReturn(diff, diff.__lines && diff.__lines.length ? diff.__lines : ['（有变化）'], {})
      return { calls: calls.slice(), pushed }
    }

    // 完整的零变化 diff，再按用例覆盖字段（漏字段会让 linesOfDetailed 抛错）
    const mkDiff = (o = {}) => Object.assign({
      containerLoss: [], containerGain: [], containerNew: [], containerGone: [],
      blockGone: [], blockNew: [], invLoss: [], invGain: [],
      inventoryLoss: [], __lines: []
    }, o)

    const invOnly = run(mkDiff({
      inventoryLoss: [{ item: 'cobblestone', n: 32 }],
      invLoss: [{ item: 'cobblestone', n: 32 }]
    }))
    ok(!invOnly.calls.some(c => c.kind === 'robbed'), '身上少 32 块石头 -> 不触发 robbed', JSON.stringify(invOnly.calls))

    const boxLoss = run(mkDiff({
      containerLoss: [{ item: 'iron_ingot', n: 3, key: '1,2,3', pos: { x: 1, y: 2, z: 3 } }]
    }))
    ok(boxLoss.calls.filter(c => c.kind === 'robbed').length === 1, '箱子少 3 块铁 -> 触发 robbed 一次', JSON.stringify(boxLoss.calls))
    ok(/箱子/.test(boxLoss.calls.find(c => c.kind === 'robbed')?.text || ''), '文案说的是「箱子里的」，不是「你的东西」',
      JSON.stringify(boxLoss.calls.find(c => c.kind === 'robbed')?.text))

    const both = run(mkDiff({
      containerLoss: [{ item: 'iron_ingot', n: 3, key: 'k', pos: { x: 0, y: 0, z: 0 } }],
      inventoryLoss: [{ item: 'bread', n: 5 }],
      invLoss: [{ item: 'bread', n: 5 }]
    }))
    ok(both.calls.filter(c => c.kind === 'robbed').length === 1, '箱子和身上同时少 -> 只触发一次 robbed', JSON.stringify(both.calls))

    spont.onComplain = realComplain
  }

  // ================================================================
  console.log('\n[D] main.js：outText 清理（源码级，直接跑线上那段代码）')
  {
    // 从 main.js 里把真实的清理链抠出来执行 —— 测的是线上代码，不是我抄的一份
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
    const m = src.match(/String\(result\.output \|\| ''\)\s*\n?\s*\.replace\(\/\\b\(undefined\|null\|NaN\)\\b\/g, '\?'\)\s*\n?\s*\.replace\(\/\(-\?\\d\+\\\.\\d\{3,\}\)\/g, \(m\) => String\(Math\.round\(parseFloat\(m\) \* 10\) \/ 10\)\)/)
    ok(!!m, '在 main.js 里找到 outText 清理链（找不到说明被改掉了）')
    if (m) {
      const clean = new Function('result', 'return ' + m[0].replace(/^String\(result\.output \|\| ''\)/, "String(result.output || '')"))
      const f = (s) => clean({ output: s })
      ok(f('位置 undefined') === '位置 ?', 'undefined -> ?', JSON.stringify(f('位置 undefined')))
      ok(f('坐标 null') === '坐标 ?', 'null -> ?', JSON.stringify(f('坐标 null')))
      ok(f('血 NaN') === '血 ?', 'NaN -> ?', JSON.stringify(f('血 NaN')))
      ok(f('x=65.46295970970024') === 'x=65.5', '>2 位小数 -> 1 位', JSON.stringify(f('x=65.46295970970024')))
      ok(f('x=65.46') === 'x=65.46', '2 位小数不动', JSON.stringify(f('x=65.46')))
      ok(f('攒了 3 块土') === '攒了 3 块土', '整数不动')
      ok(f('ok') === 'ok', '普通文本不动')
      ok(f('木镐做好了，圆石188') === '木镐做好了，圆石188', '中文+数字不误伤')
    }
  }

  console.log('\n==============================================')
  console.log(`${pass} 通过，${fail} 失败`)
  if (fail) { console.log('有失败项'); process.exit(1) }
  console.log('未覆盖改动验收全过')
}

main().catch(e => { console.error(e); process.exit(1) })
