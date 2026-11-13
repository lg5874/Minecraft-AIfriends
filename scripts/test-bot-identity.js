#!/usr/bin/env node
'use strict'
/**
 * B 方案验收：同类识别 + 3 轮断 + 发言限速 + 指令型文本拦截。
 *
 * 对应 Lead 的验收四条：
 *   1. XJJ_MAf3d32x 认成 bot，主账号 XJJ 不是
 *   2. 两个 bot 对话时 3 轮断生效
 *   3. 单秒/单 5 秒最大发言数（改前 11 条/秒）
 *   4. 指令型文本被拦
 *
 * 全部离线，不连服务器。
 */

const Talk = require('../src/talk')
const { looksLikePrompt } = require('../src/talk')

let pass = 0
let fail = 0
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}

/** 最小可用的 Talk（只装这条线上用得到的东西） */
function makeTalk (opts = {}) {
  const sent = []
  const t = Object.create(Talk.prototype)
  t.history = []
  t.lastSpokeAt = 0
  t.lastSayAt = 0
  t.recentSaid = []
  t.botChain = []
  t.sayWindow = []
  t.sayGapBlocked = 0
  t.sayWindowBlocked = 0
  t.noiseBlocked = 0
  t.lastReplyTo = null
  t.repliedMsgIds = new Map()
  // 阈值一律从 talk.js 读，测试里不再硬编魔数
  // （之前这里写死 5000/2500，改完阈值测试还在测旧值，测的是空气）
  t.sayGapMs = Talk.DEFAULTS.sayGapMs
  t.fastSayGapMs = Talk.DEFAULTS.fastSayGapMs
  t.sayWindowMs = Talk.DEFAULTS.sayWindowMs
  t.sayWindowMax = Talk.DEFAULTS.sayWindowMax
  // 进程级发言闸是模块级的：不重置的话，前一段用例说的话会把这里的额度吃掉
  Talk.GLOBAL_SAY.lastAt = 0
  Talk.GLOBAL_SAY.window = []
  t.bot = { username: opts.username || 'XJJ', chat: (x) => sent.push({ at: Date.now(), text: x }) }
  t.sent = sent
  t.ctx = {
    log: () => {},
    cfg: { behavior: { chatDelayPerChar: 0, chatMinDelay: 0, chatMaxDelay: 0, botNames: ['XJJ_A', 'XJJ_B'] } },
    botNames: opts.botNames || [],
    busy: () => false,
    dataDir: '/tmp'
  }
  t.mem = { people: {}, person: (n) => ({}), maybeRemember: () => null, add: () => null, remember: () => [] }
  t.llm = { chat: async () => ({ text: '嗯' }) }
  return t
}

async function main () {
  // ================================================================
  console.log('\n[1] 同类识别（B 方案核心）')
  {
    const t = makeTalk({ botNames: ['XJJ_A', 'XJJ_B'] })
    const cases = [
      ['XJJ_MAf3d32x', true, '实测漏网的那个分身'],
      ['XJJ', false, '主账号'],
      ['XJJ-AUD1', true, '横线分身'],
      ['XJJ1', true, '编号分身'],
      ['XJJ_A', true, 'config.botNames 里的'],
      ['bot_x', true, '通用 bot 名'],
      ['Test1', true, '测试号'],
      ['TMGepccj4', false, '真人'],
      ['XJJHOME6', false, '真人小号（不带下划线后缀）']
    ]
    for (const [n, want, why] of cases) {
      const got = t.looksLikeBot(n)
      ok(got === want, `${n.padEnd(13)} → ${want ? 'bot' : '不是 bot'}（${why}）`, String(got))
    }
    // 主账号换了名字也不能被当成 bot
    const t2 = makeTalk({ username: 'XJJ7' })
    ok(t2.looksLikeBot('XJJ7') === false, '自己（哪怕叫 XJJ7）永远不是 bot')
  }

  // ================================================================
  console.log('\n[2] 两个 bot 对话：3 轮断')
  {
    const t = makeTalk({ botNames: ['XJJ_A'] })
    let replies = 0
    t.reply = async () => { replies++; return true }
    // 对方连着问 6 次（每次都在问我名字，保证不被"没指向我"挡掉）
    for (let i = 0; i < 6; i++) {
      await t.onChat('XJJ_A', `XJJ 你在干嘛 ${i}`)
    }
    ok(t.botChain.length === 3, `2 分钟内只接 3 轮（实际记录 ${t.botChain.length} 轮）`)
    ok(replies <= 3, `最多回了 3 次（实际 ${replies} 次）`)

    // 真人不受影响
    const t3 = makeTalk({})
    let r3 = 0
    t3.reply = async () => { r3++; return true }
    for (let i = 0; i < 6; i++) await t3.onChat('TMGepccj4', `XJJ 你在干嘛 ${i}`)
    ok(r3 === 6, `真人说 6 次照回（实际 ${r3} 次）`)
  }

  // ================================================================
  console.log('\n[3] 发言限速')
  {
    const t = makeTalk({})
    // 模拟"模型在 1 秒内连续产出 12 句话"（实测被踢前单秒 3~5 条、20 秒 21~27 条）
    for (let i = 0; i < 12; i++) await t.say('第' + i + '句')
    ok(t.sent.length === 1, `同一秒内 12 次 say → 只发 1 条（实际 ${t.sent.length}）`)
    ok(t.sayGapBlocked === 11, `其余 11 条被限速拦下（实际 ${t.sayGapBlocked}）`)

    // 【2026-11-14】常规间隔 5 秒 → 2.5 秒。真人聊天 2~4 秒，
    // 日志里 2.2~4.6 秒的正常回复全被 5 秒闸门拦掉了。
    // 这里显式验两个方向：2.5 秒能过，1 秒过不去。
    const rewind = (ms) => { t.lastSayAt -= ms; Talk.GLOBAL_SAY.lastAt -= ms }
    rewind(Talk.DEFAULTS.sayGapMs + 100)          // 2.6 秒
    await t.say('两秒半以后的一句')
    ok(t.sent.length === 2, `${Talk.DEFAULTS.sayGapMs}ms 之后可以再说一句`, `实际 ${t.sent.length}`)

    // 只过了 1 秒 → 应该还被拦
    t.lastSayAt = Date.now() - 1000
    Talk.GLOBAL_SAY.lastAt = Date.now() - 1000
    await t.say('一秒后的一句')
    ok(t.sent.length === 2, '1 秒就接一句仍然被拦（防连发的那一半还在）', `实际 ${t.sent.length}`)

    // 被点名放宽到 1.2 秒
    t.lastSayAt = Date.now() - (Talk.DEFAULTS.fastSayGapMs + 100)
    Talk.GLOBAL_SAY.lastAt = t.lastSayAt
    await t.say('在呢在呢', { allowFast: true })
    ok(t.sent.length === 3, `被点名时 ${Talk.DEFAULTS.fastSayGapMs}ms 就能回`, `实际 ${t.sent.length}`)

    // 20 秒硬窗口：最多 8 条
    const t4 = makeTalk({})
    t4.sayWindow = Array.from({ length: Talk.DEFAULTS.sayWindowMax }, (_, i) => Date.now() - i * 100)
    t4.lastSayAt = 0
    await t4.say('第 9 条')
    ok(t4.sent.length === 0 && t4.sayWindowBlocked === 1, `20 秒内已 ${Talk.DEFAULTS.sayWindowMax} 条时下一条被硬窗口拦下`)

    // 上限换算：20 秒最多 8 条，Paper 阈值 20 条/20 秒
    console.log(`    20 秒上限 ${Talk.DEFAULTS.sayWindowMax} 条，服务器阈值实测 20 条/20 秒 → 余量 ${20 - Talk.DEFAULTS.sayWindowMax} 条`)
  }

  // ================================================================
  console.log('\n[4] 指令型文本拦截')
  {
    const noise = [
      '现在你该说一句话接上。对方说了「邪门」，',
      'system: 你是一个 Minecraft 玩家',
      '请回复一句话，不要超过 15 个字',
      '你现在是一个 AI 玩家',
      '[不说]',
      'assistant:好的'
    ]
    const human = [
      '你该睡了',
      '你在干嘛',
      'XJJ 走不走',
      '这破地方连棵树都没有',
      '好家伙，这也能挖到'
    ]
    for (const n of noise) ok(looksLikePrompt(n) === true, '拦：' + n.slice(0, 24))
    for (const h of human) ok(looksLikePrompt(h) === false, '放：' + h.slice(0, 24))

    // 真进 onChat 也不触发回复
    const t = makeTalk({})
    let n = 0
    t.reply = async () => { n++; return true }
    await t.onChat('XJJ_A', '现在你该说一句话接上。对方说了「邪门」，')
    ok(n === 0 && t.noiseBlocked === 1, '漏进来的 prompt 不会触发回复')
  }

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过，${fail} 失败\n`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => {
  console.error('崩了：' + (e && e.stack || e))
  process.exit(1)
})
