#!/usr/bin/env node
'use strict'
/**
 * 记忆日记（叙事整合）—— 离线单测，假 LLM，不联网。
 *
 * 验的是"这一小时揉成一段"这条链本身：
 *   1. 到点写：一小时满了、事够多 → 写一篇
 *   2. 事不够（<3 条）→ 不写，也不调模型（省钱）
 *   3. 日记正文进 entries（importance 0.92），以后 remember 能想起它
 *   4. 落盘 + 重载还在（diaries 持久化）
 *   5. token 用量被记下来（输入/输出）
 *   6. 模型报错不炸，只记一条 journal
 *
 * 跑：node scripts/test-memory-diary.js
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const Memory = require('../src/memory')

let pass = 0
let fail = 0
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}

function tmp () { return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-diary-')) }

// 【为什么要拨钟】新目录的 GameClock 从 0 起算，而"过去一小时"会是负数窗口，
// hourLines() 会把刚写进去的料全部过滤掉。真机上线半小时后 now>0，不会遇到；
// 测试里必须先把钟拨到非零，才是在验真实形状。
function wake (m, minutes = 600) { m.clock.totalMinutes = minutes; return m.clock.now() }

function fakeLLM (reply, opts = {}) {
  const calls = []
  return {
    calls,
    writes: 0,
    checks: 0,
    stats: { calls: 0, promptTokens: 1000, completionTokens: 200, fails: 0 },
    async chat (msgs, o) {
      calls.push({ msgs, o })
      if (opts.throw) throw new Error('boom')
      this.stats.promptTokens += 1200
      this.stats.completionTokens += 260
      const isCheck = /【问题】/.test(String(msgs[0] && msgs[0].content))
      if (isCheck) {
        this.checks++
        if (Array.isArray(opts.violations)) {
          const v = opts.violations.shift()
          if (v) return { text: v }
        }
        return { text: '无' }
      }
      this.writes++
      if (Array.isArray(reply)) {
        const r = reply.shift()
        return { text: r == null ? '' : r }
      }
      return { text: reply }
    }
  }
}

async function main () {
  console.log('\n[1] 一小时满了、事够多 → 写一篇')
  {
    const dir = tmp()
    const m = new Memory(dir)
    const now = wake(m)
    for (let i = 0; i < 6; i++) {
      m.journal.push({ t: now - 50 + i * 5, text: `第 ${i} 件事：挖矿没成`, why: 'task' })
    }
    const llm = fakeLLM('下午在东北边摔死两回，那坡太陡，下回绕远走。')
    const d = await m.writeDiary({ llm, force: true })
    ok(!!d, '写出日记了')
    ok(d && /摔死两回/.test(d.text), '正文是模型写的那段')
    ok(d && d.lines === 6, `料是 6 行（实际 ${d && d.lines}）`)
    // 生成 + 自检各一次，所以是两轮的累计
    ok(d && d.promptTokens === 2400 && d.completionTokens === 520,
      `token 记下来了（入 ${d && d.promptTokens} / 出 ${d && d.completionTokens}）`)
    ok(llm.writes === 1, '生成调了一次模型')
    ok(llm.checks === 1, '自检调了一次模型')
    ok(llm.calls[0].o && llm.calls[0].o.maxTokens === 1500, 'maxTokens 1500（不省）')
    ok(/这一小时发生的事/.test(llm.calls[0].msgs[0].content), '提示词里有"这一小时发生的事"')
    ok(/睡前回想|不要逐条列|因果/.test(llm.calls[0].msgs[0].content), '提示词要求像人回想、别逐条列')

    const hit = m.entries.filter(e => e.text === d.text)
    ok(hit.length === 1, '日记进长期记忆了')
    ok(hit[0] && hit[0].importance === 0.92, `importance 0.92（实际 ${hit[0] && hit[0].importance}）`)
    const recalled = m.remember('东北边 摔死', { limit: 30 })
    ok(recalled.some(e => e.text === d.text), '以后 remember 能想起这一整段')
  }

  console.log('\n[2] 事不够（<3 条）→ 不写，也不调模型')
  {
    const dir = tmp()
    const m = new Memory(dir)
    const now = wake(m)
    m.journal.push({ t: now - 5, text: '就一件事', why: 'task' })
    const llm = fakeLLM('不该被调用')
    const d = await m.writeDiary({ llm })
    ok(d === null, '没写')
    ok(llm.calls.length === 0, '没调模型（省钱）')
    ok(m.diaries.length === 0, 'diaries 还是空的')
  }

  console.log('\n[3] 到点才写：一小时内重复调用不会再写')
  {
    const dir = tmp()
    const m = new Memory(dir)
    const now = wake(m)
    for (let i = 0; i < 5; i++) m.journal.push({ t: now - 10 + i, text: `事 ${i}`, why: 'task' })
    const llm = fakeLLM('第一段。')
    const d1 = await m.maybeWriteDiary({ llm })
    ok(!!d1, '第一次到点，写了')
    const d2 = await m.maybeWriteDiary({ llm })
    ok(d2 === null, '还没到下一小时，再调不写')
    ok(llm.writes === 1 && llm.checks === 1, '模型只被调一轮（生成+自检各一次）')
  }

  console.log('\n[4] 落盘 + 重载还在')
  {
    const dir = tmp()
    const m = new Memory(dir)
    const now = wake(m)
    for (let i = 0; i < 4; i++) m.journal.push({ t: now - 8 + i, text: `事 ${i}`, why: 'task' })
    await m.writeDiary({ llm: fakeLLM('这段要能存下来。'), force: true })
    const m2 = new Memory(dir)
    ok(m2.diaries.length === 1, `重载后 diaries 还在（${m2.diaries.length} 篇）`)
    ok(m2.diaries[0] && m2.diaries[0].text === '这段要能存下来。', '正文没丢')
    ok(m2.lastDiaryAt === m.lastDiaryAt, 'lastDiaryAt 也存了')
    ok(m2.entries.some(e => e.text === '这段要能存下来。'), '日记条目也重载回来了')
  }

  console.log('\n[5] 模型报错 → 不炸，只在 journal 记一笔')
  {
    const dir = tmp()
    const m = new Memory(dir)
    const now = wake(m)
    for (let i = 0; i < 4; i++) m.journal.push({ t: now - 8 + i, text: `事 ${i}`, why: 'task' })
    const d = await m.writeDiary({ llm: fakeLLM('', { throw: true }), force: true })
    ok(d === null, '没写出日记')
    ok(m.journal.some(j => (j.why === 'diary-fail')), 'journal 里留了失败记录')
    ok(m.diaries.length === 0, '坏数据没写进 diaries')
  }

  console.log('\n[5b] 三道闸：人名材料化 / 数字照抄 / 自检有编造就重写')
  {
    const dir = tmp()
    const m = new Memory(dir)
    const now = wake(m)
    for (let i = 0; i < 5; i++) m.journal.push({ t: now - 9 + i, text: `事 ${i}`, why: 'task' })
    m.person('小明')
    m.people['小明'].lastSeen = now - 3
    m.people['小明'].talked = true
    m.person('XJJ')
    m.people['XJJ'].lastSeen = now - 180     // 这一小时不在线

    const llm = fakeLLM(['醒过来是小明把我拉起来的。', '这一小时没遇上人，白忙一场。'], { violations: ['「小明救我」材料里没有'] })
    const d = await m.writeDiary({ llm, force: true })
    const sys0 = llm.calls[0].msgs[0].content
    ok(/这一小时谁出现过/.test(sys0), '材料里有"谁出现过"清单')
    ok(/小明：这一小时在/.test(sys0), '在场的人标了在场')
    ok(/XJJ：上一次出现是 180 分钟前，\*\*这一小时不在\*\*/.test(sys0), '不在线的人明确标"这一小时不在"')
    ok(/找不到就不许写/.test(sys0) && /那是编/.test(sys0), '提示词写了"找不到就不许写/那是编"')
    ok(/坐标、数量、次数/.test(sys0) && /照抄材料原文/.test(sys0), '提示词要求数字只能照抄')
    ok(llm.checks === 2 && llm.writes === 2, `自检发现编造 -> 重写了一次（生成 ${llm.writes} / 自检 ${llm.checks}）`)
    ok(d && d.rewrote === true, '日记标了 rewrote')
    ok(d && d.text === '这一小时没遇上人，白忙一场。', '留下的是重写后的那一版')
    ok(d && d.clean === true, '重写后自检通过')
    ok(m.journal.some(j => j.why === 'diary-check'), '日志里留了"自检发现无依据"')
  }

  console.log('\n[5c] 重写还编 -> 不进长期记忆')
  {
    const dir = tmp()
    const m = new Memory(dir)
    const now = wake(m)
    for (let i = 0; i < 5; i++) m.journal.push({ t: now - 9 + i, text: `事 ${i}`, why: 'task' })
    const llm = fakeLLM(['编的 A', '还是编的 B'], { violations: ['A 无依据', 'B 也无依据'] })
    const d = await m.writeDiary({ llm, force: true })
    ok(d && d.clean === false, '标了没通过自检')
    ok(d && d.keptInMemory === false, '标了不进记忆')
    ok(!m.entries.some(e => e.text === '编的 A' || e.text === '还是编的 B'), '两条编的都没进 entries')
    ok(m.diaries.length === 1, '但留在 diaries 里可审计')
    ok(m.journal.some(j => j.why === 'diary-reject'), 'journal 里有 reject 记录')
  }

  console.log('\n[5d] 机械闸：把自己写成救命恩人 → 拦下重写')
  {
    const dir = tmp()
    const m = new Memory(dir)
    const now = wake(m)
    for (let i = 0; i < 5; i++) m.journal.push({ t: now - 9 + i, text: `事 ${i}`, why: 'task' })
    // 模型两次都说"无"，全靠机械闸拦
    const llm = fakeLLM(['我谢了徐小徐一句，那段路是他救回来的。', '这一小时没遇上人，自己把东西收好了。'],
      { violations: [null, null] })
    const d = await m.writeDiary({ llm, force: true })
    ok(d && d.rewrote === true, '机械闸发现"徐小徐"材料里没有 -> 重写')
    ok(d && d.text === '这一小时没遇上人，自己把东西收好了。', '留下的是重写后那一版')
    ok(d && d.clean === true, '重写后通过')
    ok(d && d.firstCheck && d.firstCheck.length > 3, '第一次被拦的原因记下来了：' + String(d && d.firstCheck).slice(0, 40))
    ok(m.journal.some(j => j.why === 'diary-check'), 'journal 里留了 diary-check')
  }

  console.log('\n[6] 没给 LLM 时按 config 懒加载（不崩）')
  {
    const dir = tmp()
    const m = new Memory(dir)
    const now = wake(m)
    for (let i = 0; i < 4; i++) m.journal.push({ t: now - 8 + i, text: `事 ${i}`, why: 'task' })
    // 把懒加载掐掉，模拟"机器上没有 config"
    m._ensureLLM = () => null
    const d = await m.writeDiary({ force: true })
    ok(d === null, '没有 LLM 就安静返回 null，不抛错')
  }

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过，${fail} 失败\n`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error('崩了：' + (e && e.stack || e)); process.exit(1) })
