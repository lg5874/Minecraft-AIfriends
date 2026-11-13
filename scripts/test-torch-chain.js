#!/usr/bin/env node
'use strict'
/**
 * 离线单测：火把链的**顺序与决策**（不连服务器）
 *
 *   node scripts/test-torch-chain.js
 *
 * 真机测的是"最后能不能做出火把"，这里测的是"该叫的步骤有没有按顺序叫"：
 *   有煤有棍 -> 直接 craftSmart('torch')
 *   没煤     -> ensureCoal（挖煤 / 烧木炭）
 *   没棍     -> craftSmart('stick')
 *   最后一定再 craftSmart('torch') 并核对背包
 *
 * 用 stub 替掉 craftSmart / mine / ensureCoal 这些会碰世界的部分，
 * 只观察调用序列。
 */

const path = require('path')
const fs = require('fs')
const ROOT = path.resolve(__dirname, '..')

// actions.js 顶部要 minecraft-data 之类，直接 require 是安全的（不建 bot）
const { Actions } = require(path.join(ROOT, 'src', 'actions.js'))

let pass = 0
let fail = 0
const ok = (c, what, extra) => {
  if (c) { pass++; console.log('  ✓ ' + what) } else { fail++; console.log('  ✗ ' + what + (extra ? '  → ' + extra : '')) }
}

function makeActions (inv, behavior = {}) {
  const a = Object.create(Actions.prototype)
  a._inv = Object.assign({}, inv)
  a._log = []
  a._calls = []
  a.log = (m) => { a._log.push(String(m)) }
  a.check = () => {}
  a.countOf = (n) => a._inv[n] || 0
  a.item = (n) => (a._inv[n] ? { name: n, count: a._inv[n] } : null)
  a.craftSmart = async (name, count) => {
    a._calls.push('craftSmart:' + name + ':' + count)
    if (behavior.craftSmart) return behavior.craftSmart(a, name, count)
    return true
  }
  a.mine = async (name, count) => {
    a._calls.push('mine:' + name + ':' + count)
    if (behavior.mine) return behavior.mine(a, name, count)
    return 0
  }
  a.ensureCoal = async (n) => {
    a._calls.push('ensureCoal:' + n)
    if (behavior.ensureCoal) return behavior.ensureCoal(a, n)
    return a.countOf('coal') + a.countOf('charcoal')
  }
  a.ensureCharcoal = async (n) => {
    a._calls.push('ensureCharcoal:' + n)
    if (behavior.ensureCharcoal) return behavior.ensureCharcoal(a, n)
    return a.countOf('charcoal')
  }
  return a
}

async function gather (a, n) {
  return Actions.prototype.gather.call(a, 'torch', n)
}

async function main () {
console.log('\n[1] 有煤有棍：直接合成，不去挖')
{
  const a = makeActions({ coal: 4, stick: 4 }, {
    craftSmart: (self) => { self._inv.torch = (self._inv.torch || 0) + 8; return true }
  })
  const r = await gather(a, 8)
  ok(r === true, 'gather(torch,8) 返回 true')
  ok(a.countOf('torch') === 8, '背包里有 8 个火把', String(a.countOf('torch')))
  ok(!a._calls.some(c => /ensureCoal|mine:/.test(c)), '没有多余的挖煤动作', a._calls.join(','))
}

console.log('\n[2] 没煤：先 ensureCoal（挖煤/烧炭），再合成')
{
  const a = makeActions({ stick: 4 }, {
    ensureCoal: (self) => { self._inv.coal = 2; return 2 },
    craftSmart: (self) => { self._inv.torch = (self._inv.torch || 0) + 8; return true }
  })
  const r = await gather(a, 8)
  ok(r === true, '返回 true')
  ok(a._calls.includes('ensureCoal:2'), '按"缺 2 份料"去挖煤', a._calls.join(','))
  ok(a._calls.indexOf('ensureCoal:2') < a._calls.lastIndexOf('craftSmart:torch:8'), '先备料，后合成')
}

console.log('\n[3] 没棍：先做木棍')
{
  const a = makeActions({ coal: 4 }, {
    craftSmart: (self, name, count) => {
      if (name === 'stick') self._inv.stick = (self._inv.stick || 0) + count
      if (name === 'torch') self._inv.torch = (self._inv.torch || 0) + 8
      return true
    }
  })
  const r = await gather(a, 8)
  ok(r === true, '返回 true')
  ok(a._calls.includes('craftSmart:stick:2'), '会去 craftSmart(stick)（复用现有实现）', a._calls.join(','))
}

console.log('\n[4] 煤也挖不到、炭也烧不出：如实返回 false')
{
  const a = makeActions({ stick: 4 }, {
    ensureCoal: () => 0,
    craftSmart: () => true
  })
  const r = await gather(a, 8)
  ok(r === false, '返回 false（不谎报成功）', String(r))
  ok(a._log.some(l => /火把 0\/8|火把链|火把做不了/.test(l)), '日志里说清楚结果', a._log.slice(-3).join(' | '))
}

console.log('\n[5] 已经有 8 个：立刻返回 true，不重复合成')
{
  const a = makeActions({ torch: 8 })
  const r = await gather(a, 8)
  ok(r === true, '返回 true')
  ok(!a._calls.length, '没有多余动作', a._calls.join(','))
}

console.log('\n[6] ensureCoal：先挖 coal_ore，挖不到再烧木炭')
{
  const a = makeActions({}, { mine: () => 0, ensureCharcoal: (self) => { self._inv.charcoal = 2; return 2 } })
  delete a.ensureCoal          // 用真的 ensureCoal，不用 stub
  const n = await a.ensureCoal(2)
  ok(a._calls.includes('mine:coal_ore:2'), '先 mine(coal_ore)', a._calls.join(','))
  ok(a._calls.includes('ensureCharcoal:2'), '挖不到就烧木炭', a._calls.join(','))
  ok(n === 2, '最后 coal+charcoal = 2', String(n))
}

console.log('\n[7] 源码层面：gather 的 torch 分支在 map 查表之前')
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'actions.js'), 'utf8')
  const gi = src.indexOf('async gather (itemName, count)')
  const torchAt = src.indexOf("if (itemName === 'torch') {", gi)
  const mapAt = src.indexOf('const map = {', gi)
  ok(torchAt > 0 && mapAt > 0 && torchAt < mapAt,
    'torch 分支在 `if (!src) return false` 之前（否则永远走不到）',
    `torch@${torchAt} map@${mapAt}`)
  ok(!/if \(itemName === 'torch'\) return false/.test(src), '旧的 `return false` 已经删掉')
}


  console.log(`\n${fail ? '❌' : '✅'} 通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(2) })
