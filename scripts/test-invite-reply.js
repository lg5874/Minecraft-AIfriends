#!/usr/bin/env node
'use strict'
/**
 * 「明早用户第一句『过来』不能被拒」—— 邀请应答验收（2026-11-14 口径）。
 *
 * Lead 定的三条：
 *   第 1 声              -> 无条件答应（不看进度、不看血、不看任何条件）
 *   第 2+ 声，进度 > 0.5 -> 说「等我把这块弄完」+ 60 秒内自己过去
 *   第 2+ 声，血 ≤ 8     -> 说「我快不行了，先缓一下」+ 缓过来真的过去
 *   其余                 -> 答应
 *
 * 全程假 bot + 假时钟，不连服务器。
 *
 * 跑：node scripts/test-invite-reply.js
 */

const { Invite } = require('../src/invite')

let pass = 0
let fail = 0
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}

let NOW = 1000000
const now = () => NOW

function makeBot (v = {}) {
  return {
    username: 'XJJ',
    version: '1.21.11',
    health: v.health == null ? 20 : v.health,
    food: v.food == null ? 20 : v.food,
    time: { timeOfDay: v.tod == null ? 6000 : v.tod },
    entity: { position: { x: 0, y: 64, z: 0, distanceTo (o) { return Math.abs(0 - (o.x || 0)) } } },
    players: {
      老王: { username: '老王', entity: { position: { x: 1, y: 64, z: 0, distanceTo (o) { return Math.abs(1 - (o.x || 0)) } } } },
      小李: { username: '小李', entity: { position: { x: 2, y: 64, z: 0, distanceTo (o) { return Math.abs(2 - (o.x || 0)) } } } }
    },
    pathfinder: { setGoal () {}, setMovements () {} },
    stopDigging () {},
    clearControlStates () {}
  }
}

function makeInvite (o = {}) {
  const said = []
  const logs = []
  const inv = new Invite({
    log: (s) => logs.push(s),
    speak: async (situation, opts) => { said.push({ situation, opts }); return true },
    sleep: async () => {},
    now,
    isBotName: () => false,
    progress: typeof o.progress === 'number' ? () => o.progress : undefined,
    busy: () => (o.busy == null ? (typeof o.progress === 'number' && o.progress > 0.5) : !!o.busy)
  })
  inv.attach(makeBot(o))
  if (inv._timer) clearInterval(inv._timer)
  inv._timer = null
  return { inv, said, logs }
}

async function main () {
  console.log('\n[1] 同一次上线连续喊 10 次：第 1 声立刻来，之后看状态')
  {
    const { inv } = makeInvite()
    const results = []
    for (let i = 0; i < 10; i++) {
      const r = inv.handleChat('老王', i % 2 ? '过来' : '跟我来')
      results.push(r === 'invite' ? '接' : '不接')
      if (inv.active) inv.stop('detach', { quiet: true })   // 每次重新开始
      NOW += 2000
    }
    console.log('    10 次：' + results.join(' '))
    const accepted = results.filter(r => r === '接').length
    ok(results[0] === '接', '第 1 次就接（明早第一句「过来」）')
    ok(results[2] === '接', '第 3 次照接（旧逻辑在这里就拒了）')
    ok(accepted >= 5, `前 5 次全接，宽上限之后才挡（实际接了 ${accepted} 次）`)
    ok(accepted < 10, `很短时间里叫 10 次仍有上限兜底（接了 ${accepted} 次）`)
  }

  console.log('\n[2] 第 1 声无条件：进度 0.8 + 忙 + 血 5，也当场答应')
  {
    const { inv, said } = makeInvite({ progress: 0.8, busy: true, health: 5 })
    const r = inv.handleChat('老王', '过来')
    ok(r === 'invite', '第 1 声不看进度、不看血 —— 直接答应')
    ok(inv.active === true && inv.target === '老王', '真的开始跟了')
    ok(said.length >= 1, '答应的时候说了一句')
    ok(inv.stats.firstCall === 1, '记了 firstCall')
    ok(inv._pendingFollow === null && inv._pendingRecover === null, '没留任何"等会儿再来"的尾巴')
  }

  console.log('\n[3] 第 2 声、进度 0.8：说「等我把这块弄完」，60 秒内自己过去')
  {
    const { inv, said } = makeInvite({ progress: 0.8, busy: true })
    ok(inv.handleChat('老王', '过来') === 'invite', '第 1 声当场接')
    inv.stop('detach', { quiet: true })

    const r = inv.handleChat('老王', '过来')
    ok(r !== 'invite', '第 2 声：手上活过半，不当场跟着走')
    ok(inv.active === false, '还没开始跟')
    ok(inv._pendingFollow && inv._pendingFollow.user === '老王', '记下了"等会儿要过去"')
    const line = said.map(s => s.situation).join(' | ')
    ok(/等我把这块|这块弄完|弄完就来/.test(line), '说的是"等我把这块弄完"这类，不是沉默')

    NOW += 10000
    await inv.tick()
    ok(inv.active === false, '10 秒时活还没完，先不跟')

    inv.ctx.progress = () => 0
    inv.ctx.busy = () => false
    NOW += 5000
    await inv.tick()
    ok(inv.active === true && inv.target === '老王', '活干完就主动跟上去（不用再喊一次）')
    ok(inv.stats.followThru >= 1, '记了 followThru 次数')
  }

  console.log('\n[3b] 活一直没完：到 60 秒上限也照样过去（答应人不能无限拖）')
  {
    const { inv } = makeInvite({ progress: 0.9, busy: true })
    inv.handleChat('老王', '过来'); inv.stop('detach', { quiet: true })
    ok(inv.handleChat('老王', '过来') !== 'invite', '第 2 声先延后')
    NOW += 61000
    await inv.tick()
    ok(inv.active === true, '60 秒上限到了，活没完也过去')
  }

  console.log('\n[4] 第 2 声、血 5：说「我快不行了」，缓过来真的回去找他')
  {
    const { inv, said } = makeInvite()
    ok(inv.handleChat('老王', '过来') === 'invite', '第 1 声当场接')
    inv.stop('detach', { quiet: true })

    inv._bot.health = 5
    const r = inv.handleChat('老王', '过来')
    ok(r !== 'invite', '血 5：不当场跟着走')
    ok(inv.active === false, '没开始跟')
    const line = said.map(s => s.situation).join(' | ')
    ok(/不行了|缓一下|缓过来/.test(line), '把「我快不行了，先缓一下」说出来了')
    ok(!/回家/.test(line), '不说"回家" —— 避免"他跑了"的观感')
    ok(inv._pendingRecover && inv._pendingRecover.user === '老王', '记下了"缓过来要去找他"')
    ok(inv.stats.refused >= 1, '记了一次 refused')

    // 血还没回来：不该动
    NOW += 5000
    await inv.tick()
    ok(inv.active === false, '血还没回来，先不动')

    // 血回来了：主动过去
    inv._bot.health = 15
    NOW += 3000
    await inv.tick()
    ok(inv.active === true && inv.target === '老王', '缓过来主动去找他（有下文）')
    ok(inv.stats.recover >= 1, '记了 recover 次数')
    const last = said[said.length - 1].situation
    ok(/缓过来|我来了|来了/.test(last), '过去的时候说了一句「缓过来了/我来了」')
    console.log('    say: ' + last.slice(0, 50))
  }

  console.log('\n[5] 血一直回不来：到极限也要给个交代，不能把人吊着')
  {
    const { inv, said } = makeInvite()
    inv.handleChat('老王', '过来'); inv.stop('detach', { quiet: true })
    inv._bot.health = 4
    inv.handleChat('老王', '过来')
    const before = said.length
    NOW += 95000          // 超过 recoverMaxMs
    await inv.tick()
    ok(inv._pendingRecover === null, '超时后清掉承诺，不挂一整局')
    ok(said.length > before, '给了一句实话（别等我）')
  }

  console.log('\n[6] 状态差（夜里/饿）+ 进度 0.8：第 2 声也直接跟，不延后')
  {
    for (const [name, v] of [['夜里', { tod: 15000 }], ['饿得只剩 4', { food: 4 }]]) {
      const { inv } = makeInvite(Object.assign({ progress: 0.8, busy: true }, v))
      inv.handleChat('老王', '过来')          // 第 1 声（无条件）
      inv.stop('detach', { quiet: true })
      const r = inv.handleChat('老王', '过来')
      ok(r === 'invite', `${name}：第 2 声也不当"等一下"，直接答应`)
    }
    const { inv } = makeInvite({})
    ok(inv.handleChat('老王', '过来') === 'invite', '没有进度口子时默认答应')
  }

  console.log('\n[7] 邀请词收窄：别把「刚上来」当成叫我过去')
  {
    const { INVITE_RE } = require('../src/invite')
    const should = ['过来', 'XJJ 过来', '你过来', '快过来', '跟我来', '跟上', '一起挖矿', '你上来']
    const shouldNot = ['XJJ_VOICE30126 刚上来啊', '我刚上来了', '我过来了', '他刚下来', '我刚下来',
      '这有个洞', '天黑了', '挖到铁矿了']
    const miss = should.filter(t => !INVITE_RE.test(t))
    const bad = shouldNot.filter(t => INVITE_RE.test(t))
    ok(miss.length === 0, `该认的都认（漏了：${miss.join(' / ') || '无'}）`)
    ok(bad.length === 0, `不该认的别认（误认：${bad.join(' / ') || '无'}）`)
    // 实机那条原句，直接喂给 handleChat，确认不会被跟着走
    const { inv } = makeInvite()
    ok(inv.handleChat('别的bot', 'XJJ_VOICE30126 刚上来啊') === null, '实机原句不再触发跟随')
  }

  console.log('\n[8] 说了"等会儿过去"，对方说别来了 → 撤销承诺')
  {
    const { inv } = makeInvite({ progress: 0.9, busy: true })
    inv.handleChat('老王', '过来'); inv.stop('detach', { quiet: true })
    inv.handleChat('老王', '过来')
    ok(!!inv._pendingFollow, '先记下了承诺')
    inv.handleChat('老王', '不用跟了')
    ok(inv._pendingFollow === null, '对方说别来了，承诺撤掉')
  }

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过，${fail} 失败\n`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => {
  console.error('崩了：' + (e && e.stack || e))
  process.exit(1)
})
