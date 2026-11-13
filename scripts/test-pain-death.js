#!/usr/bin/env node
'use strict'
/**
 * 离线单测：痛觉（onPain）与死因判定（resolveDeathCause）
 *
 * 不连服务器，直接用 Bot.prototype 造一个最小对象，验证：
 *   · 血 >6 不打断
 *   · 血 <=6 一定打断（_signalCancel）+ 清寻路 + 走 reflex 保命
 *   · 死因优先级：damage_event > 死亡消息 > 饿死 > 不知道
 *
 *   node scripts/test-pain-death.js
 */

const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const { Bot } = require(path.join(ROOT, 'main.js'))

let pass = 0
let fail = 0
const ok = (cond, what, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + what) } else { fail++; console.log('  ✗ ' + what + (extra ? '  → ' + extra : '')) }
}

function makeBot () {
  const b = Object.create(Bot.prototype)
  const logs = []
  const events = []
  const sos = []
  let pathCleared = false
  let cancelled = 0
  b.log = (s) => { logs.push(String(s)) }
  b.events = { push: (...a) => events.push(a) }
  b.reflex = { sos: (k, o) => sos.push({ k, o }) }
  b._signalCancel = (why) => { cancelled++; return true }
  b.bot = {
    health: 20,
    food: 20,
    entity: { id: 1, position: { x: 11.4, y: 18.2, z: -33.7 } },
    pathfinder: { setGoal: () => { pathCleared = true } }
  }
  return { b, logs, events, sos, clear: () => pathCleared, cancelled: () => cancelled }
}

console.log('\n[#A 痛觉 · 血 > 6 不该打断]')
{
  const t = makeBot()
  t.b.onPain(12, '被僵尸打了')
  ok(t.cancelled() === 0, '血 12 不打断', 'cancelled=' + t.cancelled())
  ok(t.sos.length === 0, '血 12 不触发 SOS')
  t.b.onPain(7, '快淹死了')
  ok(t.cancelled() === 0, '血 7 仍不打断（只提醒）')
  ok(t.events.length === 1, '血 7 推了一条 health_low 事件', JSON.stringify(t.events))
}

console.log('\n[#A 痛觉 · 血 <= 6 必须停手]')
{
  const t = makeBot()
  t.b._lastDamage = { at: Date.now(), kind: 'drown', text: '快淹死了' }
  t.b.onPain(6, '快淹死了')
  ok(t.cancelled() === 1, '血 6 -> 打断动作线（_signalCancel）', 'cancelled=' + t.cancelled())
  ok(t.clear(), '血 6 -> 清了寻路目标')
  ok(t.sos.length >= 1 && t.sos[0].k === 'drown' && t.sos[0].o.urgent === true,
    '血 6 -> reflex.sos(drown, urgent)', JSON.stringify(t.sos[0]))
  ok(t.logs.some(l => /\[pain\]/.test(l)), '[pain] 日志打出来了', t.logs.join(' | '))
  ok(t.b.painUntil > Date.now(), 'painUntil 置位（60 秒）')

  // 节流：连着来
  const before = t.logs.length
  for (let i = 0; i < 5; i++) t.b.onPain(5, '快淹死了')
  ok(t.logs.length - before <= 1, '连续伤害不刷屏（15 秒内只一条）')
}

console.log('\n[#A 有怪时 SOS 走 lowhp（跑/吃），不吃 mob 的 kind]')
{
  const t = makeBot()
  t.b._lastDamage = { at: Date.now(), kind: 'mob', text: '被僵尸打了' }
  t.b.onPain(4, '被僵尸打了')
  ok(t.sos[0] && t.sos[0].k === 'lowhp', 'mob 伤害转成 lowhp 交给反射层', JSON.stringify(t.sos[0]))
}

console.log('\n[#B 死因 · 优先级]')
{
  const t = makeBot()
  t.b._lastDamage = { at: Date.now(), kind: 'drown', text: '快淹死了', by: null }
  const c = t.b.resolveDeathCause()
  ok(c.text === '快淹死了' && c.src === 'damage_event', 'damage_event 优先', JSON.stringify(c))
}
{
  const t = makeBot()
  t.b._lastDamage = { at: Date.now() - 120000, kind: 'fall', text: '摔下来了' }
  t.b._deathMsgs = [{ at: Date.now() - 1000, text: 'XJJ 被僵尸杀死了' }]
  const c = t.b.resolveDeathCause()
  ok(c.text === 'XJJ 被僵尸杀死了' && c.src === 'chat', '过期的伤害不用，退到死亡消息', JSON.stringify(c))
}
{
  const t = makeBot()
  t.b.bot.food = 0
  const c = t.b.resolveDeathCause()
  ok(c.text === '饿死了' && c.src === 'food', '什么都没记 -> 用饱食度兜底', JSON.stringify(c))
}
{
  const t = makeBot()
  const c = t.b.resolveDeathCause()
  ok(c.text === '不知道怎么回事' && c.src === 'none', '真的没有任何线索才说不知道', JSON.stringify(c))
}

console.log('\n[#B 死因 · 死亡消息解析（中英）]')
{
  // 直接测正则：跟 main.js 里那条保持同一份
  const src = require('fs').readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  const m = /const DEATH_MSG = (\/.+\/[a-z]*)/.exec(src)
  ok(!!m, 'main.js 里有 DEATH_MSG 正则')
  if (m) {
    // eslint-disable-next-line no-new-func
    const re = new Function('return ' + m[1])()
    const cn = ['XJJ 被僵尸杀死了', 'XJJ 被苦力怕炸了', 'XJJ 淹死了', 'XJJ 从高处摔了下来', 'XJJ 被岩浆吞了', 'XJJ 饿死了']
    const en = ['XJJ was slain by Zombie', 'XJJ drowned', 'XJJ fell from a high place']
    const notDeath = ['XJJ: 你死了这条心吧', 'XJJ joined the game']
    cn.forEach(s => ok(re.test(s), '认中文：' + s))
    en.forEach(s => ok(re.test(s), '认英文：' + s))
    // 注意：第一句"你死了这条心吧"包含"死了"但不在我们的 pattern 里（只认被…杀/淹死等）
    ok(!re.test('XJJ joined the game'), '不误判普通消息')
    void notDeath
  }
}

console.log('\n[#A2 危险环境：血 7~10 也要停手（按威胁类型）]')
{
  const t = makeBot()
  t.b._lastDamage = { at: Date.now(), kind: 'drown', text: '快淹死了' }
  t.b.onPain(8, '快淹死了')
  ok(t.cancelled() === 1, '血 8 溺水 -> 停手', 'cancelled=' + t.cancelled())
  ok(t.logs.some(l => /还在水里/.test(l)), '日志说清楚为什么停（还在水里）', t.logs.join(' | '))
}
{
  const t = makeBot()
  t.b._lastDamage = { at: Date.now(), kind: 'fall', text: '摔下来了' }
  t.b.onPain(8, '摔下来了')
  ok(t.cancelled() === 0, '血 8 摔伤（已经发生完了）-> 不停手')
}
{
  const t = makeBot()
  t.b._lastDamage = { at: Date.now() - 60000, kind: 'drown', text: '快淹死了' }
  t.b.onPain(8, '快淹死了')
  ok(t.cancelled() === 0, '过期的溺水记录不触发停手（5 秒窗口）')
}
{
  const t = makeBot()
  t.b._lastDamage = { at: Date.now(), kind: 'lava', text: '被岩浆烫了' }
  t.b.onPain(9, '被岩浆烫了')
  ok(t.cancelled() === 1, '血 9 岩浆 -> 停手')
}

console.log('\n[#A3 sos 刷屏：动作照旧、日志不刷]')
{
  const Reflex = require(path.join(ROOT, 'src', 'reflex.js'))
  const logs = []
  const bot = {
    health: 5,
    username: 'me',
    entity: { position: { x: 0, y: 0, z: 0 } },
    setControlState: () => {},
    inventory: { items: () => [] },
    entities: {}
  }
  const ctx = { log: (m) => logs.push(String(m)), mem: {}, onEvent: () => {} }
  const r = new Reflex(bot, ctx)

  // 模拟 tick 每 800ms 叫一次，血一直卡在 5，共 5 分钟
  const t0 = Date.now()
  let acts = 0
  const realSos = r.sos.bind(r)
  r.sos = (k, o) => { acts++; return realSos(k, o) }
  for (let i = 0; i < 375; i++) {          // 5 分钟 / 800ms
    bot.health = 5
    r.sos('drown')
  }
  const sosLogs = logs.filter(l => /^\[sos\]/.test(l))
  ok(sosLogs.length <= 6, `血卡在 5，5 分钟只有 ${sosLogs.length} 条 [sos]（改前 131 条）`, sosLogs.slice(0, 3).join(' | '))
  ok(acts > 10, '但救援动作没有停（仍会反复执行）', 'acts=' + acts)

  // 掉档才报：5 -> 4 -> 3
  const before = logs.filter(l => /^\[sos\]/.test(l)).length
  bot.health = 4; r.sos('drown')
  bot.health = 3; r.sos('drown')
  const after = logs.filter(l => /^\[sos\]/.test(l)).length
  ok(after - before === 2, '5→4→3 各报一条', `新增 ${after - before} 条`)
  // 同一档反复掉
  const b2 = logs.filter(l => /^\[sos\]/.test(l)).length
  bot.health = 3; r.sos('drown'); bot.health = 2.99; r.sos('drown')
  ok(logs.filter(l => /^\[sos\]/.test(l)).length - b2 <= 1, '同一档反复掉不重发')

  const ctx2 = { log: (m) => logs.push(String(m)), mem: {}, onEvent: () => {} }
  const r2 = new Reflex({ ...bot, health: 5 }, ctx2)
  const b3 = logs.length
  bot.health = 8
  r2.onHurt(null, 8, 'drown')   // 血 8 溺水也要救
  ok(logs.some(l => /\[sos\]/.test(l)) && logs.length > b3, '血 8 溺水：反射层也出手（按威胁类型）')
  const c4 = logs.filter(l => /^\[sos\]/.test(l)).length
  r2.bot.health = 8
  r2.onHurt(null, 8, 'fall')
  const c5 = logs.filter(l => /^\[sos\]/.test(l)).length
  ok(c5 === c4, '血 8 摔伤：反射层不额外叫 sos', `新增 ${c5 - c4} 条`)
}

console.log('\n[#C 天黑反应：血满是警觉，血低才是躲]')
{
  const src = require('fs').readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  ok(/bot\.health > 14[^\n]*\n[^]*?_nightAlerted/.test(src) || /_nightAlerted/.test(src), 'main.js 里有"血够也要警觉"的分支')
  const nightBlock = /tod > 13000 && tod < 23000 && bot\.health > 14/.test(src)
  ok(nightBlock, '警觉分支条件是 天黑 + 血 > 14')
  ok(/tod > 13000 && tod < 23000 && bot\.health <= 14/.test(src), '躲的分支仍在（天黑 + 血 <= 14），原行为没退化')
  ok(/\[night\] 天黑了（血 \$\{Math\.round\(bot\.health\)\}，血够，不躲）/.test(src), '[night] 日志区分"躲/不躲"')
  ok(/_nightAlerted = false/.test(src), '天亮时会复位 _nightAlerted（不会只警觉第一夜）')
}

console.log('\n[#C2 提示词：血满的夜里知道自己该留神]')
{
  const SelfState = require(path.join(ROOT, 'src', 'selfstate.js'))
  const mk = (health) => {
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      inventory: { items: () => [] },
      health, food: 20, heldItem: null,
      time: { timeOfDay: 18000 }
    }
    const ss = new SelfState(bot, { log: () => {}, events: { push: () => {} } })
    ss.known = ss.snapshot()
    return ss.prompt()
  }
  const full = mk(20)
  const low = mk(10)
  ok(/外面在刷怪/.test(full), '血满的夜里也有"外面在刷怪"')
  ok(/留个心眼/.test(full), '血满的夜里提示"留个心眼"（不吓唬他躲）', full.split('\n').slice(3, 6).join(' / '))
  ok(!/留个心眼/.test(low), '血少时不会给"不用慌"的那句')
}

console.log('\n[#C3 [pain] 日志间隔 30 秒]')
{
  const src = require('fs').readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  ok(/_painLogAt \|\| 0\) > 30000/.test(src), '[pain] 节流是 30 秒', (/_painLogAt \|\| 0\) > (\d+)/.exec(src) || [])[1])
  ok(!/_painLogAt \|\| 0\) > 15000/.test(src), '没有残留的 15 秒')
}

console.log(`\n${fail ? '❌' : '✅'} 通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
