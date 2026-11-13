'use strict'
/**
 * 「白干了一趟」这笔记账，到底有没有说出口 —— 单测。
 *
 * 不打 MC 服务器、不调模型：用假 Cost + 假 talk，把 spontaneous 的
 * 排队/标记/重排/优先这条链单独跑一遍。真机上跑的是
 * `AIFRIEND_DATA=/tmp/voice-test AIFRIEND_CONFIG=... node main.js`。
 *
 * 覆盖：
 *   1. 账 -> 事件：排得进队列，素材里没有「记住这回」，没有"念账本"的原文
 *   2. 排队 ≠ 说出口：只排队时 spokenAt 必须是空的
 *   3. 真说出来才标记：spokenAt 有值 + 不会重排同一笔
 *   4. 说了没成最多重排 3 回，之后放下（不在 8 分钟窗口里反复念）
 *   5. 过期的那条也要放掉排队标记，不能把账锁死
 *   6. 优先于普通吐槽排队，但仍然排在"有人跟你说话"之后
 *
 * 跑：node scripts/test-loss-voice.js
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { Cost } = require('../src/cost')
const spontaneous = require('../src/spontaneous')

const T = 1800000000000        // 固定时钟，别让测试跟真实时间跑
const MEM_TEXT = '记住这回：五分钟白搭进去八根木棍，还跑老远，还死了两回，那地方不能再去'

// spontaneous 的冷却直接读 Date.now()（没做注入），这里把它整体冻住，
// 才能测"隔 8 秒再说一次"这种节奏；不动被测代码。
let CLOCK = T
Date.now = () => CLOCK
const advance = (ms) => { CLOCK += ms }

let pass = 0
function ok (name) { pass++; console.log('  ✓ ' + name) }

function tmpDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'voice-loss-'))
}

function mkCost (dir) {
  const C = new Cost(dir, { now: () => T })
  C.attach(null)      // main.js:460 就是这么登记的（CURRENT = this）
  return C
}

function addLoss (C, extra) {
  const loss = Object.assign({
    at: T,
    key: 'iron',
    title: '挖一趟铁就上来',
    verdict: 'bitter',
    mins: 5,
    dist: 320,
    worth: 0,
    rate: 0,
    gained: [{ item: 'stick', n: 8 }],
    spent: [],
    burn: 0,
    deaths: 2,
    text: MEM_TEXT,
    spokenAt: null
  }, extra || {})
  C.losses.push(loss)
  C.save()
  return loss
}

/** 假 talk：想让它说成 / 说不出 / 差一次 */
function mkTalk (script) {
  const said = []
  const queue = Array.isArray(script) ? script.slice() : null
  return {
    said,
    async speak (situation, opts) {
      said.push({ situation, opts })
      if (queue) return queue.length ? queue.shift() : false
      return script !== false
    }
  }
}

function mkSpont (busy) {
  const logs = []
  const S = new spontaneous.Spontaneity({
    log: (s) => logs.push(s),
    busy: typeof busy === 'function' ? busy : () => !!busy,
    mem: null
  })
  S.logs = logs
  return S
}

// ---------------------------------------------------------------- 1
{
  const dir = tmpDir()
  const C = mkCost(dir)
  addLoss(C)
  const S = mkSpont(true)              // 故意"忙"着：损失吐槽应该还能说
  const ev = S._maybeQueueLoss()
  assert(ev, '账在 8 分钟窗口里，应该排得进队列')
  assert.strictEqual(ev.trigger, 'loss')
  assert.strictEqual(ev.priority, 'complain')
  assert(ev.busyExempt === true, '忙的时候也要能说')
  assert(!/记住这回/.test(ev.situation), '素材不许带「记住这回」这种记忆格式')
  assert(/八根木棍/.test(ev.situation), '素材要带上真实损失（八根木棍）')
  assert(/两回/.test(ev.situation), '素材要带上死了两回')
  assert(/别报数/.test(ev.situation), '要明确要求别报数（不然会念账本）')
  assert.strictEqual(S.pendingEvents.length, 1)
  ok('账 → 事件：素材进情境，不带「记住这回」/不念账本')
}

// ---------------------------------------------------------------- 2
{
  const dir = tmpDir()
  const C = mkCost(dir)
  const loss = addLoss(C)
  const S = mkSpont(false)
  S._maybeQueueLoss()
  assert.strictEqual(loss.spokenAt, null, '只排队还没说，不能标记成说过')
  const again = S._maybeQueueLoss()
  assert.strictEqual(again, null, '同一笔账不许在队列里堆两条')
  assert.strictEqual(S.pendingEvents.length, 1)
  ok('排队 ≠ 说出口：spokenAt 保持空，同一笔不重排')
}

// ---------------------------------------------------------------- 3
{
  const dir = tmpDir()
  const C = mkCost(dir)
  const loss = addLoss(C)
  const S = mkSpont(false)
  const talk = mkTalk(true)
  S._maybeQueueLoss()
  return (async () => {
    await S.tick(talk)
    assert.strictEqual(talk.said.length, 1, '应该说一次')
    assert(loss.spokenAt === T, '真说出来了才标记 spokenAt')
    assert.strictEqual(S._queuedLossKeys.size, 0, '排队标记要放掉')
    assert.strictEqual(S._maybeQueueLoss(), null, '说过的账不再排')
    ok('真说出来才标记；说过的账不再排')

    // ------------------------------------------------------------ 4
    {
      const dir4 = tmpDir()
      const C4 = mkCost(dir4)
      const l4 = addLoss(C4)
      const S4 = mkSpont(false)
      const talk4 = mkTalk([false, false, false, true])
      for (let i = 0; i < 4; i++) {
        S4._maybeQueueLoss()
        if (S4.pendingEvents.length) await S4.tick(talk4)
        advance(9000)       // 越过 complain 的 8 秒冷却
      }
      assert.strictEqual(talk4.said.length, 3, '说了没成最多排 3 回')
      assert(l4.spokenAt === T, '试满 3 回就放下，当说过')
      ok('说了没成最多 3 回，之后不再翻旧账')
    }

    // ------------------------------------------------------------ 5
    {
      const dir5 = tmpDir()
      const C5 = mkCost(dir5)
      const l5 = addLoss(C5)
      const S5 = mkSpont(false)
      S5._maybeQueueLoss()
      // 把事件做旧，模拟"主循环卡了 4 分钟，队列里这条过期了"
      S5.pendingEvents[0].t = Date.now() - 200000
      S5.prune()
      assert.strictEqual(S5.pendingEvents.length, 0, '过期的该丢')
      assert.strictEqual(l5.spokenAt, null, '过期的那条不算说过')
      const again5 = S5._maybeQueueLoss()
      assert(again5, '过期之后还能重排 —— 否则这笔账就被锁死在账本里')
      ok('过期要放掉排队标记，账不能被锁死')
    }

    // ------------------------------------------------------------ 6
    {
      const dir6 = tmpDir()
      const C6 = mkCost(dir6)
      addLoss(C6)
      const S6 = mkSpont(false)
      S6.push({ situation: '你挖到铁矿了', chance: 1, maxLen: 20, trigger: 'valuableFind', priority: 'thing' })
      S6.push({ situation: '你死了，掉了东西', chance: 1, maxLen: 20, trigger: 'died', priority: 'complain' })
      S6.push({ situation: '有人上线了', chance: 1, maxLen: 20, trigger: 'playerJoin', priority: 'social' })
      S6._maybeQueueLoss()
      S6._sortQueue()
      const order = S6.pendingEvents.map(x => x.ev.trigger)
      assert.deepStrictEqual(order, ['playerJoin', 'loss', 'died', 'valuableFind'],
        '顺序应为 招呼 > 损失 > 普通吐槽 > 对事，实际：' + order.join(' > '))
      ok('优先级：招呼 > 损失 > 普通吐槽 > 对事')
    }

    console.log(`\n损失出口单测：${pass} 项全过`)
  })().catch(e => { console.error(e); process.exit(1) })
}
