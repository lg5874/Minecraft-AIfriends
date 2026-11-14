#!/usr/bin/env node
'use strict'
/**
 * 方案 5：要不要开口交给模型（2026-11-14）。
 *
 *   node scripts/test-spont-chance.js
 *
 * 原来 spontaneous 传 `chance: ev.chance`（0.25~0.85），代码先掷骰子，
 * 不过就**连模型都不问**。现在改成 chance:1 —— 走到这一步的都问模型，
 * 由 talk.speak() 的 [不说] 决定。
 */

const path = require('path')
const fs = require('fs')
const ROOT = path.resolve(__dirname, '..')
const spontMod = require(path.join(ROOT, 'src', 'spontaneous'))
const Spontaneous = spontMod.Spontaneity || spontMod.Spontaneous || spontMod

let pass = 0
let fail = 0
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}

const src = fs.readFileSync(path.join(ROOT, 'src', 'spontaneous.js'), 'utf8')

async function main () {
  console.log('\n[1] 源码：不再把概率传给 speak')
  {
    ok(/chance:\s*1\b/.test(src), 'speak 调用处是 chance: 1')
    ok(!/chance:\s*ev\.chance\s*,/.test(src), '没有残留 chance: ev.chance（注释里的引用不算）')
  }

  console.log('\n[2] 行为：低概率事件也会问到模型（判断权在模型）')
  {
    const calls = []
    const talk = {
      mem: { people: {}, person: () => ({}), remember: () => [], maybeRemember: () => {} },
      bot: { username: 'XJJ' },
      async speak (situation, opts) { calls.push({ situation, opts }); return false }
    }
    const sp = new Spontaneous({
      log: () => {},
      busy: () => false,
      talk,
      mem: talk.mem
    })
    // 0.05 这种概率在旧实现里几乎必被骰子拦掉
    sp.push({
      trigger: 'playerJoin',
      priority: 'social',
      chance: 0.05,
      maxLen: 20,
      people: ['老王'],
      situation: '老王 刚上线，你们认识。'
    })
    await sp.tick(talk)
    ok(calls.length === 1, `事件走到了 speak（旧实现概率 0.05 ≈ 95% 被骰子拦）`, `实际 ${calls.length} 次`)
    ok(calls[0] && calls[0].opts.chance === 1, '传给 speak 的 chance 是 1', JSON.stringify(calls[0] && calls[0].opts))
  }

  console.log('\n[3] 冷却还在（不是"什么都问"）')
  {
    const calls = []
    const talk = {
      mem: { people: {}, person: () => ({}), remember: () => [], maybeRemember: () => {} },
      bot: { username: 'XJJ' },
      async speak (s, o) { calls.push(o); return true }
    }
    const sp = new Spontaneous({ log: () => {}, busy: () => false, talk, mem: talk.mem })
    const mkEv = (t) => ({ trigger: t, priority: 'social', chance: 0.9, maxLen: 20, people: ['老王'], situation: '老王 上线了 ' + t })
    sp.push(mkEv('playerJoin'))
    await sp.tick(talk)
    const afterFirst = calls.length
    sp.push(mkEv('playerJoin'))
    await sp.tick(talk)          // 立刻再来一条，应该被 socialCooldown 拦
    ok(afterFirst === 1, '第一条问了模型', `实际 ${afterFirst}`)
    ok(calls.length === 1, '第二条被社交冷却拦下（15 秒）', `实际 ${calls.length}`)
  }

  console.log('\n===== 结果 =====')
  console.log(`${pass} 通过，${fail} 失败`)
  if (fail) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
