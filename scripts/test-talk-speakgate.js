#!/usr/bin/env node
'use strict'
/**
 * 说话闸验收（2026-11-14）。
 *
 *   node scripts/test-talk-speakgate.js
 *
 * 验的是两件从 /tmp/soak.log 抓到的真问题：
 *   A. 指令前缀泄漏到公屏：唯一说出口的一句是「答一句短的。大概意思是：看见你上线了。」
 *   B. 限速过严：6 次拦截全是 2.2~4.6 秒的正常社交回复。
 *
 * 全 mock：不连服务器、不调模型、不写 data/runtime。
 */

const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const Talk = require(path.join(ROOT, 'src', 'talk'))

let pass = 0
let fail = 0
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}

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

function mkTalk (lines = [], logs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-gate-'))
  const sent = []
  const q = lines.slice()
  const bot = { username: 'XJJ', chat (t) { sent.push(t) } }
  const llm = { async chat () { return { text: q.length ? q.shift() : '[不说]' } } }
  const ctx = {
    dataDir: dir,
    log: (m) => logs.push(m),
    cfg: { behavior: { chatDelayPerChar: 0, chatMinDelay: 0, chatMaxDelay: 0 } },
    busy: () => false,
    taskDesc: () => '',
    perceive: { brief: () => '' },
    taste: { prompt: () => '' },
    mood: { prompt: () => '', state: () => 'normal', irritation: 0, spirit: 0.5 },
    botNames: []
  }
  // 新实例 = 新进程：进程级闸清空（否则上一个用例说的话会吃掉这里的额度）
  Talk.GLOBAL_SAY.lastAt = 0
  Talk.GLOBAL_SAY.window = []
  return { talk: new Talk(bot, llm, mkMem(), ctx), sent, logs, dir }
}

/** 让"时间过去 ms 毫秒"：把两个时钟和窗口时间戳一起往前拨 */
function advance (talk, ms) {
  talk.lastSayAt = (talk.lastSayAt || Date.now()) - ms
  if (talk.lastSpokeAt) talk.lastSpokeAt -= ms   // speak() 的冷却也读它
  Talk.GLOBAL_SAY.lastAt = (Talk.GLOBAL_SAY.lastAt || Date.now()) - ms
  if (Array.isArray(talk.sayWindow)) talk.sayWindow = talk.sayWindow.map(x => x - ms)
  Talk.GLOBAL_SAY.window = Talk.GLOBAL_SAY.window.map(x => x - ms)
}

async function main () {
  // ================================================================
  console.log('\n[A1] 真实泄漏原句：全拦')
  {
    const leak = [
      '答一句短的。大概意思是：看见你上线了。', // soak.log 00:59:36 唯一说出口的那句
      '说一句话',
      '大概意思是：看见你上线了',
      '用轻松的语气说',
      '是不是新人？直接说'                     // soak.log 01:02:14
    ]
    for (const s of leak) {
      ok(Talk.isInstructionLeak(s) === true, '判成指令泄漏：' + s)
    }
    // 端到端：模型真的吐出这句，也必须发不出去
    const { talk, sent, logs } = mkTalk([leak[0]])
    const r = await talk.speak('XJJ_VERIFY3 刚上线')
    ok(r === false, 'speak() 返回 false（没发出去）')
    ok(sent.length === 0, '公屏一条都没有', JSON.stringify(sent))
    ok(logs.some(l => l.startsWith('[instruction leak blocked]')), '日志里有 [instruction leak blocked]')
    ok(!talk.history.some(h => /答一句短的/.test(h.msg)), '没写进 history（不然下次还会学它）')
    fs.rmSync(talk.ctx.dataDir, { recursive: true, force: true })
  }

  // ================================================================
  console.log('\n[A2] 正常话：全放行')
  {
    const normal = ['来了啊', '天黑这么快', '看见你上来了', '玩不玩啊', '说真的，这地方没树']
    for (const s of normal) {
      ok(Talk.isInstructionLeak(s) === false, '放行：' + s)
    }
    const { talk, sent } = mkTalk(['来了啊', '天黑这么快', '看见你上来了'])
    for (let i = 0; i < 3; i++) {
      advance(talk, 3000)
      await talk.speak('第 ' + (i + 1) + ' 次打招呼')
    }
    ok(sent.join('|') === '来了啊|天黑这么快|看见你上来了', '三句都真的发出去了', JSON.stringify(sent))
    fs.rmSync(talk.ctx.dataDir, { recursive: true, force: true })
  }

  // ================================================================
  console.log('\n[B1] 占坑后不再重复判间隔（"正常话全被拦"的根因）')
  {
    // 真实路径：speak() 先 reserveSpeak 占坑 → 模型跑 3 秒 → say() 发
    // 旧代码在 say() 里又拿占坑时间当"上一句"，3 秒的模型往返被判成"太快"。
    // 模型往返取 1838ms —— soak.log 01:02:26 那条 "距上一条 1838ms" 的原值：
    // 占坑已经通过了闸门，say() 不能再拿"模型跑了 1838ms"当成"上一句才 1838ms"。
    const { talk, sent, logs } = mkTalk(['来了啊'])
    const reserved = talk.reserveSpeak()
    ok(reserved === true, '占坑成功')
    advance(talk, 1838)                          // 模型往返 1838ms（低于 2 秒闸门）
    const said = await talk.say('来了啊', { reserved: true })
    ok(said === true && sent.length === 1, '占坑 + 1838ms 模型往返 → 说得出去', JSON.stringify(sent))
    ok(!logs.some(l => l.includes('[say 限速]')), '没有被限速拦')

    // 反证：同一条时间线，**不带** reserved（旧行为）→ 把往返耗时当成间隔，判"太快"
    // 这就是 soak.log 里 6 次限速拦截的成因，锁死它免得以后又被"优化"回去
    const { talk: t3, sent: s3 } = mkTalk()
    ok(t3.reserveSpeak() === true, '反证：也占坑')
    advance(t3, 1838)
    await t3.say('来了啊')                       // 没带 reserved
    ok(s3.length === 0, '不带 reserved 时 1838ms 往返被误判成太快（旧 bug 复现）', JSON.stringify(s3))

    // 不占坑的直接调用仍然受 2.5 秒约束
    const { talk: t2, sent: s2 } = mkTalk()
    await t2.say('第一句')
    await t2.say('紧接着第二句')
    ok(s2.length === 1, '不占坑连发两句 → 只发 1 条', JSON.stringify(s2))
  }

  // ================================================================
  console.log('\n[B2] 每 3 秒一句 × 10：应该全通过')
  {
    const { talk, sent } = mkTalk()
    let saidCount = 0
    for (let i = 0; i < 10; i++) {
      advance(talk, 3000)
      if (await talk.say('第' + i + '句，随便聊聊')) saidCount++
    }
    ok(saidCount === 10, `10 句全说出去（实际 ${saidCount}/10）`)
    ok(sent.length === 10, '公屏 10 条')
    console.log(`    换算：10 句 / 30 秒 = 20 句 / 60 秒，服务器阈值 20 句 / 20 秒 → 安全`)
  }

  // ================================================================
  console.log('\n[B3] 每 0.3 秒一句 × 30：应该拦掉大部分')
  {
    const { talk, sent } = mkTalk()
    let saidCount = 0
    for (let i = 0; i < 30; i++) {
      advance(talk, 300)
      if (await talk.say('刷屏第' + i + '句')) saidCount++
    }
    ok(saidCount <= 10, `说出去的 ≤10 条（实际 ${saidCount}/30）`)
    ok(saidCount < 30, '大部分被拦')
    ok(sent.length <= Talk.DEFAULTS.sayWindowMax, `20 秒窗口内不超过 ${Talk.DEFAULTS.sayWindowMax} 条（实际 ${sent.length}）`)
    console.log(`    30 次里发出去 ${saidCount} 条；被拦 ${talk.sayGapBlocked + talk.sayWindowBlocked} 次`)
  }

  // ================================================================
  console.log(`\n[B4] 5 秒内可以说 2 条（间隔 ${Talk.DEFAULTS.sayGapMs}ms）`)
  {
    const { talk, sent } = mkTalk()
    const t0 = Date.now()
    ok(await talk.say('天黑这么快') === true, '第 1 条说得出去')
    advance(talk, Talk.DEFAULTS.sayGapMs)         // 正好踩到闸门
    await talk.say('来了啊')
    advance(talk, Talk.DEFAULTS.sayGapMs - 500)   // 差一点点，应该还拦
    await talk.say('看见你上来了')
    ok(sent.join('|') === '天黑这么快|来了啊', `${Talk.DEFAULTS.sayGapMs}ms 能说第 2 条，少 500ms 不行`, JSON.stringify(sent))
    ok(Date.now() - t0 < 5000, '整个过程在 5 秒内（模拟时间，实际没等）')
  }

  // ================================================================
  console.log('\n[B5] soak.log 里被误拦的两句原间隔：现在要过')
  {
    // 00:58:58 来了啊   距上一条 2258ms
    // 01:00:02 玩不玩啊 距上一条 2196ms
    // 这两句是"正常对话被 5 秒闸门拦掉"的原型，阈值定 2000 就是为了它们。
    for (const [line, gap] of [['来了啊', 2258], ['玩不玩啊', 2196]]) {
      const { talk, sent } = mkTalk()
      ok(await talk.say('天黑这么快') === true, `${line}：先说一句占住时钟`)
      advance(talk, gap)
      const said = await talk.say(line)
      ok(said === true && sent.length === 2, `距上一条 ${gap}ms → 说得出去（原被拦）`, JSON.stringify(sent))
      fs.rmSync(talk.ctx.dataDir, { recursive: true, force: true })
    }
  }

  // ================================================================
  console.log('\n[B6] 历史窗口：模型看得见最近 40 条，内存留 200 条')
  {
    const x = mkTalk()
    for (let i = 0; i < 60; i++) x.talk.history.push({ who: '老王', msg: '第' + i + '句' })
    const joined = x.talk.speakMessages('随便说点', {}).map(m => m.content).join('\n')
    ok(joined.includes('第59句'), '最近一条在 prompt 里')
    ok(joined.includes('第20句'), '第 20 句在窗口内（40 条）')
    ok(!joined.includes('第19句'), '第 19 句超出 40 条窗口，不在 prompt 里（旧实现连第 10 句都看不到）')

    // 内存上限：源码里不再有 40 的截断
    const src = fs.readFileSync(path.join(ROOT, 'src', 'talk.js'), 'utf8')
    ok(!/history\.length > 40\b/.test(src), '源码里没有 history > 40 的截断')
    ok(/history\.length > 200/.test(src), '内存留 200 条')
  }

  console.log('\n===== 结果 =====')
  console.log(`${pass} 通过，${fail} 失败`)
  if (fail) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
