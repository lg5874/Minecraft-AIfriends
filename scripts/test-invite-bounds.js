#!/usr/bin/env node
'use strict'
/**
 * 跟随边界验收（Lead 的三条）：
 *   1. 连续跟随 > 3 分钟 → 有反应（说一句 / 到 5 分钟自己散）
 *   2. 同一个人 5 分钟内邀请 → 第二次降概率、第三次不接
 *   3. 跟随时能不能顺手干活（本测试不覆盖，见报告）
 *
 * 全程假 bot + 假时钟，不连服务器。
 */

let pass = 0
let fail = 0
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}

// 可控时钟
let NOW = 1000
const now = () => NOW

function makeBot () {
  const pos = { x: 0, y: 64, z: 0 }
  const mk = (x) => ({
    position: { x, y: 64, z: 0, distanceTo (o) { return Math.abs(x - o.x) } }
  })
  return {
    username: 'XJJ',
    version: '1.21.11',
    entity: { position: { x: 0, y: 64, z: 0, distanceTo (o) { return Math.abs(0 - o.x) } } },
    players: { 老王: { username: '老王', entity: mk(1) } },
    pathfinder: { setGoal () {}, setMovements () {} },
    stopDigging () {},
    clearControlStates () {}
  }
}

const Invite = require('../src/invite').Invite

function makeInvite () {
  const said = []
  const inv = new Invite({
    log: () => {},
    speak: async (situation, opts) => { said.push({ situation, opts }); return true },
    sleep: async () => {},
    now,
    isBotName: () => false
  })
  inv.attach(makeBot())
  // attach 会起 setInterval，测试里关掉，手动驱动 tick
  if (inv._timer) clearInterval(inv._timer)
  inv._timer = null
  return { inv, said }
}

async function main () {
  console.log('\n[1] 跟随时长边界')
  {
    const { inv, said } = makeInvite()
    console.log('    maxFollowMs =', inv.opts.maxFollowMs, ' askAtMs =', inv.opts.askAtMs)
    inv.handleChat('老王', '跟我来')
    ok(inv.active === true, '接受邀请，开始跟随')
    const saidAtStart = said.length

    // 走到 3 分 01 秒
    NOW += 3 * 60e3 + 1000
    await inv.tick()
    ok(said.length > saidAtStart, `到 3 分钟说了一句（实际 ${said.length - saidAtStart} 句）`)
    ok(/还走吗/.test(said[said.length - 1].situation), '说的是"还走吗"这类')
    console.log('    ' + said[said.length - 1].situation.slice(0, 40))
    ok(inv.active === true, '3 分钟还在跟（不是直接甩人）')

    // 到 5 分钟
    NOW += 2 * 60e3 + 1000
    await inv.tick()
    ok(inv.active === false, '超过 5 分钟自己散了')
    ok(inv.stats.stops >= 1, `记了一次结束（stops=${inv.stats.stops}）`)
  }

  console.log('\n[2] 同一个人 5 分钟内反复邀请')
  {
    const { inv } = makeInvite()
    const results = []
    // 模拟探针 bot 每 30 秒叫一次，共 4 次（2 分钟内）
    for (let i = 0; i < 4; i++) {
      const r = inv.handleChat('老王', '跟我来')
      results.push(r === 'invite' ? '接' : '不接')
      if (inv.active) inv.stop('detach', { quiet: true })   // 每次重新开始，避免"已在跟"提前返回
      NOW += 30000
    }
    console.log('    4 次邀请结果：' + results.join(' '))
    const accepted = results.filter(r => r === '接').length
    ok(accepted <= 2, `2 分钟内被叫 4 次，最多接 2 次（实际 ${accepted}）`)
    ok(results[2] === '不接' || results[3] === '不接', '第 3/4 次里至少有一次被挡')

    // 过了冷却，又能接
    NOW += 5 * 60e3 + 1000
    const r = inv.handleChat('老李', '跟我走')
    ok(r === 'invite', '换个新人叫，正常接受')
  }

  console.log('\n[3] 不同的人互不影响')
  {
    const { inv } = makeInvite()
    inv.handleChat('老王', '跟我来'); inv.stop('detach', { quiet: true })
    NOW += 1000
    const r = inv.handleChat('老李', '跟我走')
    ok(r === 'invite', '老王刚叫完，老李叫照样接')
  }

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过，${fail} 失败\n`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => {
  console.error('崩了：' + (e && e.stack || e))
  process.exit(1)
})
