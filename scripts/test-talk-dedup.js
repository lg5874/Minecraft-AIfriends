#!/usr/bin/env node
'use strict'
/**
 * talk.js 查重四件套的测试。全 mock，不连服务器、不调模型。
 *
 *   node scripts/test-talk-dedup.js
 *
 * 测的是用户反复反馈的那件事：「同一件事回了两遍，很人机」。
 * 日志里实际回了四次，根因都在 talk.js：
 *   BUG-1  followUpDeferred 里 markReplied(username, message) 变量不存在 -> ReferenceError
 *   BUG-2  reply() 从不 markReplied -> 查重形同虚设
 *   BUG-3  fatigueHint 要求三句全同 -> 真实序列永远不触发
 *   BUG-4  followUpDeferred 说的话不进 recentSaid -> 疲劳机制看不见
 */

const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const Talk = require(path.join(ROOT, 'src', 'talk'))

let pass = 0; let fail = 0
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')) }
}

// ============================================================
// mock 环境
// ============================================================

function mkTmpDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcai-talk-'))
}

/** 假记忆：只实现 talk.js 会碰到的那几个方法 */
function mkMem () {
  return {
    people: {},
    secrets: [],
    person (name) {
      if (!this.people[name]) this.people[name] = { trust: 0, notes: [] }
      return this.people[name]
    },
    remember () { return [] },
    maybeRemember () { return null },
    getSecrets () { return [] },
    markTold () {},
    add () {},
    peopleDigest () { return '（还不认识谁）' },
    placesDigest () { return '（还没记地方）' },
    recentSession () { return '' },
    lastSummary () { return null },
    addSecret () { return null }
  }
}

/** 假 bot：把发出去的话记下来 */
function mkBot (sent) {
  return {
    username: 'XJJ',
    chat (t) { sent.push(t) }
  }
}

/** 假模型：按顺序返回预设台词 */
function mkLLM (lines) {
  const q = lines.slice()
  return {
    calls: [],
    async chat (msgs) {
      this.calls.push(msgs)
      const text = q.length ? q.shift() : '[不说]'
      return { text }
    }
  }
}

function mkCtx (dir, extra = {}) {
  return Object.assign({
    dataDir: dir,
    log: () => {},
    cfg: {
      behavior: {
        chatDelayPerChar: 0,
        chatMinDelay: 0,
        chatMaxDelay: 1
      }
    },
    busy: () => false,
    taskDesc: () => '',
    perceive: { brief: () => '' },
    taste: { prompt: () => '' },
    mood: { prompt: () => '', state: () => 'normal', irritation: 0, spirit: 0.5 },
    botNames: []
  }, extra)
}

function mkTalk (opts = {}) {
  const dir = opts.dir || mkTmpDir()
  const sent = []
  const bot = mkBot(sent)
  const llm = mkLLM(opts.lines || [])
  const mem = opts.mem || mkMem()
  const talk = new Talk(bot, llm, mem, mkCtx(dir, opts.ctx))
  // 这个文件测的是**去重**（同一条只回一次 / 不同的话都要回），不是发言速率。
  // 发言限速（5 秒 1 条）是另一条线（B 方案），会让"不同的话都回"这种用例
  // 在 5 秒内被限速拦掉 —— 那是限速在正常工作，不是去重坏了。这里关掉它再测。
  talk.sayGapMs = 0
  talk.fastSayGapMs = 0
  talk.sayWindowMax = 1e9
  talk.sayWindow = []
  return { talk, sent, bot, llm, mem, dir }
}

// ============================================================
// BUG-2：同一条消息连 reply 三次，只能发一条
// ============================================================

async function testBug2 () {
  console.log('\n[BUG-2] 同一条消息连 reply 三次')
  const { talk, sent, dir } = mkTalk({
    lines: ['回来了', '回来了', '回来了']
  })

  const WHO = '老王'
  const MSG = '你人呢'

  for (let i = 0; i < 3; i++) {
    await talk.reply(WHO, MSG)
  }

  ok(sent.length === 1, '只发 1 条', `(实际发了 ${sent.length} 条: ${JSON.stringify(sent)})`)
  ok(talk.repliedMsgIds.size === 1, 'repliedMsgIds.size === 1', `(实际 ${talk.repliedMsgIds.size})`)
  ok(talk.hasReplied(WHO, MSG), 'hasReplied 认得这条')
  ok(talk.hasReplied(WHO, MSG) && !talk.hasReplied(WHO, '你人呢?'), '别的消息不受影响')

  fs.rmSync(dir, { recursive: true, force: true })
}

// ============================================================
// BUG-1：followUpDeferred 不能抛 ReferenceError
// ============================================================

async function testBug1 () {
  console.log('\n[BUG-1] followUpDeferred 不抛 ReferenceError')
  const { talk, sent, dir } = mkTalk({
    lines: ['刚才没顾上，你说啥']
  })

  // 造一条 9 秒前的"等会儿再回"
  const WHO = '老王'
  const MSG = '借我把镐子'
  talk.defer(WHO, MSG)
  talk.deferred[0].at = Date.now() - 9000

  let err = null
  let ret = null
  try {
    ret = await talk.followUpDeferred()
  } catch (e) {
    err = e
  }

  ok(err === null, '没抛异常', err ? `(${err.name}: ${err.message})` : '')
  ok(ret === true, '返回 true（说了话）', `(实际 ${ret})`)
  ok(sent.length === 1, '说了 1 条', `(${JSON.stringify(sent)})`)
  ok(talk.hasReplied(WHO, MSG), '标记的是"那个人那句话"，不是 undefined')
  ok(talk.repliedMsgIds.size === 1, 'repliedMsgIds 里 1 条', `(实际 ${talk.repliedMsgIds.size})`)

  // 关键：标记的 key 里不能出现 undefined
  const keys = Array.from(talk.repliedMsgIds.keys())
  ok(!keys.some(k => /undefined/.test(k)), '没有 undefined 混进 key', `(${JSON.stringify(keys)})`)

  fs.rmSync(dir, { recursive: true, force: true })
}

// ============================================================
// BUG-3：相邻两句同开头，fatigueHint 要能触发
// ============================================================

function testBug3 () {
  console.log('\n[BUG-3] 相邻两句同开头就该触发疲劳')

  // 这是日志里的真实序列：先一句短的，然后连着两句"回来了，…"
  const real = [
    { text: '嗯，好', at: Date.now(), kind: 'short' },
    { text: '回来了，刚爬上来做石镐呢', at: Date.now(), kind: 'normal' },
    { text: '回来了，问第三遍了', at: Date.now(), kind: 'normal' }
  ]

  const { talk, dir } = mkTalk()
  talk.recentSaid = real.map(r => ({ ...r }))
  const hint = talk.fatigueHint()
  ok(hint.length > 0, '真实序列能触发', `(hint 长度 ${hint.length})`)
  const head = hint.split('\n').find(l => l.trim()) || ''
  ok(/回来了/.test(hint), '提示里点名了重复的开头', `("${head.trim().slice(0, 40)}")`)

  // 三句开头全不一样 -> 不该触发
  talk.recentSaid = [
    { text: '嗯', at: Date.now(), kind: 'minimal' },
    { text: '这就去挖', at: Date.now(), kind: 'normal' },
    { text: '你要不要一起来', at: Date.now(), kind: 'ask' }
  ]
  ok(talk.fatigueHint() === '', '三句都不重样时不啰嗦')

  // 只有一句 -> 不该触发
  talk.recentSaid = [{ text: '嗯', at: Date.now(), kind: 'minimal' }]
  ok(talk.fatigueHint() === '', '只有一句时不触发')

  // 空 -> 不该触发
  talk.recentSaid = []
  ok(talk.fatigueHint() === '', '没有记录时不触发')

  fs.rmSync(dir, { recursive: true, force: true })
}

// ============================================================
// BUG-4：followUpDeferred 说的话要进 recentSaid
// ============================================================

async function testBug4 () {
  console.log('\n[BUG-4] 回头接的话要进 recentSaid')
  const { talk, sent, dir } = mkTalk({
    lines: ['刚才没顾上，你说啥', '木头等会儿给你']
  })

  ok(talk.recentSaid.length === 0, '开始时 recentSaid 是空的')

  talk.defer('老王', '借我把镐子')
  talk.deferred[0].at = Date.now() - 9000

  await talk.followUpDeferred()

  ok(talk.recentSaid.length === 1, '说了 1 条，记了 1 条', `(实际 ${talk.recentSaid.length})`)
  ok(talk.recentSaid[0] && talk.recentSaid[0].text === sent[0], '记的内容就是发出去的那句', `("${talk.recentSaid[0] && talk.recentSaid[0].text}")`)
  ok(talk.recentSaid[0] && typeof talk.recentSaid[0].kind === 'string', '带上了 kind（疲劳判断要用）', `(${talk.recentSaid[0] && talk.recentSaid[0].kind})`)

  // 连着接两次同样的话，疲劳机制应该看得见
  talk.defer('老王', '再借我点木头')
  talk.deferred[talk.deferred.length - 1].at = Date.now() - 9000
  await talk.followUpDeferred()
  ok(talk.recentSaid.length === 2, '第二次也记上了', `(实际 ${talk.recentSaid.length})`)

  fs.rmSync(dir, { recursive: true, force: true })
}


// ============================================================
// BUG-2 的真正杀手场景：三条路径**并发**触发
// ============================================================

async function testConcurrent () {
  console.log('\n[并发] 延迟回复 + 事件队列 + 回头接话同时进来')
  const { talk, sent, dir } = mkTalk({
    lines: ['在，正爬上去做石镐呢', '回来了，刚爬上来做石镐呢', '嗯 回来了', '回来了，问第三遍了']
  })
  // 让模型慢一点回，三条路径才有机会挤在一起
  const origChat = talk.llm.chat.bind(talk.llm)
  talk.llm.chat = async (m) => { await new Promise(r => setTimeout(r, 30)); return origChat(m) }

  const WHO = '老王'
  const MSG = '你人呢'

  // 这就是日志里那四条各自的来源，同一个 tick 里一起触发
  await Promise.all([
    talk.reply(WHO, MSG, { busy: true }),   // 延迟回复
    talk.reply(WHO, MSG),                    // 事件队列
    talk.reply(WHO, MSG),                    // 又一条路径
    talk.reply(WHO, MSG)
  ])

  ok(sent.length === 1, '四条并发路径只发出 1 条', `(实际 ${sent.length} 条: ${JSON.stringify(sent)})`)
  ok(talk.repliedMsgIds.size === 1, 'repliedMsgIds 只有 1 条')

  fs.rmSync(dir, { recursive: true, force: true })
}

// ============================================================
// 回归：别把正常回复弄坏
// ============================================================

async function testRegression () {
  console.log('\n[回归] 正常回复仍然能发出去')

  // 不同的人说同一句话，都要回（查重是按 人+话 的 key）
  {
    const { talk, sent, dir } = mkTalk({ lines: ['在', '嗯'] })
    await talk.reply('老王', '你在吗')
    await talk.reply('小李', '你在吗')
    ok(sent.length === 2, '不同的人说同一句，都回', `(发了 ${sent.length} 条)`)
    ok(talk.repliedMsgIds.size === 2, 'repliedMsgIds 里 2 条')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // 同一个人说不同的话，都要回
  {
    const { talk, sent, dir } = mkTalk({ lines: ['在', '挖矿呢'] })
    await talk.reply('老王', '你在吗')
    await talk.reply('老王', '干嘛呢')
    ok(sent.length === 2, '同一人不同的话，都回', `(发了 ${sent.length} 条)`)
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // 模型选择不说 -> 不发，也不该标记已回（下次还有机会）
  {
    const { talk, sent, dir } = mkTalk({ lines: ['[不理]'] })
    await talk.reply('老王', '你在吗')
    ok(sent.length === 0, '模型不理就不发')
    ok(talk.repliedMsgIds.size === 0, '不理不等于回过，不标记', `(实际 ${talk.repliedMsgIds.size})`)
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // 最后防线还在：机器味的话照样被拦
  {
    const { talk, sent, dir } = mkTalk({ lines: ['mine returned 1, cobblestone 229'] })
    await talk.reply('老王', '挖到啥了')
    ok(sent.length === 0, 'isMachineTalk 仍然拦得住', `(发了 ${sent.length} 条)`)
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // 说出去的话都要进 recentSaid（reply 路径）
  {
    const { talk, dir } = mkTalk({ lines: ['在呢'] })
    await talk.reply('老王', '你在吗')
    ok(talk.recentSaid.length === 1, 'reply 说的话也进 recentSaid')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // 一次完整的"忙 -> 延迟回 -> 回头接"不该变成四句
  {
    const { talk, sent, dir } = mkTalk({ lines: ['在，忙着呢', '回来了，你说啥'] })
    const WHO = '老王'
    const MSG = '在不在'

    // 1) 忙的时候先回一句（模拟 onChat 的 busy 分支 + 延迟 reply）
    await talk.reply(WHO, MSG, { busy: true })
    // 2) 事件队列那条路径（main.js:795 会先 hasReplied 再 reply）
    talk.defer(WHO, MSG)
    talk.deferred[0].at = Date.now() - 9000
    if (!talk.hasReplied(WHO, MSG)) await talk.reply(WHO, MSG)
    // 3) 回头接
    await talk.followUpDeferred()

    ok(sent.length <= 2, '整条链路不会刷出三四句', `(共 ${sent.length} 条: ${JSON.stringify(sent)})`)
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ============================================================

async function run (name, fn) {
  try {
    await fn()
  } catch (e) {
    // 一个用例崩了不许拖累后面的（修前 BUG-1 会抛 ReferenceError，得让其余用例照跑，
    // 不然拿不到完整的修前/修后对比）
    fail++
    console.log(`  ✗ ${name} 崩了：${e.name}: ${e.message}`)
  }
}

async function main () {
  console.log('===== talk.js 查重测试（全 mock）=====')
  await run('BUG-1', testBug1)
  await run('BUG-2', testBug2)
  await run('BUG-3', testBug3)
  await run('BUG-4', testBug4)
  await run('并发', testConcurrent)
  await run('回归', testRegression)

  console.log(`\n===== 结果 =====`)
  console.log(`${pass} 通过，${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => {
  console.error('\n测试崩了：', e && e.stack || e)
  process.exit(2)
})
