#!/usr/bin/env node
'use strict'
/**
 * ActionLock 单测。
 *
 * 锁是全项目唯一一个"错了就全线卡死"的组件，所以先有这些断言，再把 main.js 接上去。
 *
 * 用法：node scripts/test-actionlock.js
 *
 * 覆盖文档里点名的 6 个边界 + 几个我踩过的：
 *   1. 重复 acquire 同 reason
 *   2. release 没持有的 reason（false + 日志，不抛错）
 *   3. 高 rank 抢低 rank
 *   4. 低 rank 抢高 rank（被拒）
 *   5. 两条线同时持有，一条 release 后另一条还在
 *   6. 超时 forceRelease
 *   7. Step 2 之后兼容层已删：busy 只剩只读视图
 *   8. interruptCurrent 的顺序不变量：中间不许出现 busy=false
 *   9. main.js 接线守则：busy 写点归零、cancel=true 只许一处（静态检查）
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const {
  ActionLock,
  REASON,
  RANK,
  registerRank
} = require(path.join(ROOT, 'src', 'actionlock'))

// ---------------- 迷你断言框架 ----------------
let pass = 0
let fail = 0
const failures = []

function ok (name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    failures.push(name + (detail ? '：' + detail : ''))
    console.log(`  ✗ ${name}${detail ? '：' + detail : ''}`)
  }
}

function eq (name, got, want) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  ok(name, g === w, g === w ? '' : `期望 ${w}，实际 ${g}`)
}

function throws (name, fn) {
  try {
    fn()
    ok(name, false, '抛错了')
  } catch (e) {
    ok(name, true)
  }
}

function noThrow (name, fn) {
  try {
    const r = fn()
    ok(name, true)
    return r
  } catch (e) {
    ok(name, false, '不该抛错：' + e.message)
    return undefined
  }
}

function section (title) {
  console.log('\n' + title)
}

/** 每个用例一套干净环境：假时钟 + 收日志 */
function makeLock () {
  const clock = { t: 1000000 }
  const logs = []
  const lock = new ActionLock({
    log: (s) => logs.push(s),
    now: () => clock.t
  })
  watchClock(lock, clock, logs)
  return { lock, clock, logs }
}

/** 让 clock.advance() 直接改时钟（lock 持有的是闭包，自动生效） */
function watchClock (lock, clock) {
  clock.advance = (sec) => { clock.t += sec * 1000 }
}

const hasLog = (logs, re) => logs.some(s => re.test(s))

// ==================== 1. 重复 acquire ====================
section('1. 重复 acquire 同 reason（tick 会重复进入，不能报错）')
{
  const { lock } = makeLock()
  ok('第一次 acquire 成功', lock.acquire(REASON.TASK, '挖矿') === true)
  ok('重复 acquire 也成功，不报错', lock.acquire(REASON.TASK, '挖矿') === true)
  eq('count = 2', lock.holders()[0].count, 2)
  ok('release 一次后仍然持有（第一次的锁没被第二次清掉）', lock.release(REASON.TASK) === true && lock.isHolding(REASON.TASK))
  eq('count 回到 1', lock.holders()[0].count, 1)
  ok('再 release 才真的放开', lock.release(REASON.TASK) === true && !lock.isHolding(REASON.TASK))
  ok('空锁 busy = false', lock.busy === false)
}

// ==================== 2. release 没持有的 reason ====================
section('2. release 没持有的 reason（false + 日志，永不抛错）')
{
  const { lock, logs } = makeLock()
  const r = noThrow('release 未持有的 reason 不抛错', () => lock.release(REASON.HOME))
  ok('返回 false', r === false)
  ok('打了 "release 没有持有的锁" 日志', hasLog(logs, /release 没有持有的锁/))
  noThrow('release(undefined) 不抛错', () => lock.release(undefined))
  noThrow('release(null) 不抛错', () => lock.release(null))
  eq('误 release 后锁仍然是空的', lock.holders(), [])
}

// ==================== 3. 高 rank 抢低 rank ====================
section('3. 高 rank 抢低 rank（follow 60 打断挖矿 task 10）')
{
  const { lock } = makeLock()
  lock.acquire(REASON.TASK, '挖矿')
  ok('follow 能 acquire', lock.acquire(REASON.FOLLOW, '玩家喊我') === true)
  ok('两条线同时在', lock.isHolding(REASON.TASK) && lock.isHolding(REASON.FOLLOW))
  eq('holders 按 rank 排序，follow 在前', lock.holders().map(h => h.reason), [REASON.FOLLOW, REASON.TASK])
  ok('busy 仍然是 true', lock.busy === true)
}

// ==================== 4. 低 rank 抢高 rank ====================
section('4. 低 rank 抢高 rank（被拒：不能打断逃命）')
{
  const { lock, logs } = makeLock()
  lock.acquire(REASON.SURVIVE, '被骷髅追')
  ok('follow 抢 survive 被拒', lock.acquire(REASON.FOLLOW, '玩家喊我') === false)
  ok('survive 还在', lock.isHolding(REASON.SURVIVE))
  ok('follow 没进来', !lock.isHolding(REASON.FOLLOW))
  ok('拒绝有日志', hasLog(logs, /acquire 被拒/))
  ok('canPreempt(follow) = false', lock.canPreempt(REASON.FOLLOW) === false)
  ok('canStart(task) = false', lock.canStart(REASON.TASK) === false)
  ok('survive 自己重入仍然允许', lock.acquire(REASON.SURVIVE, '继续跑') === true)
}

// ==================== 5. 两条线同时持有，一条 release ====================
section('5. 两条线同时持有，一条 release 后另一条还在')
{
  const { lock } = makeLock()
  // 真实顺序：任务先起跑，回家线后插进来（home 50 > legacy/task 10）
  lock.acquire(REASON.TASK, '早就起跑的任务')
  lock.acquire(REASON.HOME, '走回家')
  ok('release task', lock.release(REASON.TASK) === true)
  ok('home 还在（这一条就是 107 的修法）', lock.isHolding(REASON.HOME))
  ok('busy 仍然 true —— 主循环不会插进来', lock.busy === true)
  ok('release home 后锁才空', lock.release(REASON.HOME) === true && lock.busy === false)
}

// ==================== 6. 超时 forceRelease ====================
section('6. 超时 forceRelease（from 不放，到点夺锁）')
{
  const { lock, clock, logs } = makeLock()
  lock.acquire(REASON.HOME, '走回家卡住')
  lock.acquire(REASON.HOME, '重入一次') // count=2，模拟重复进入
  clock.advance(8.4)
  eq('超时前 ageSecs ≈ 8.4s', lock.ageSecs(REASON.HOME).toFixed(1), '8.4')
  const r = lock.forceRelease(REASON.HOME, 'timeout 8.4s')
  ok('forceRelease 成功', r === true)
  ok('count=2 也一次清干净', !lock.isHolding(REASON.HOME) && lock.busy === false)
  ok('打了 forceRelease 日志', hasLog(logs, /forceRelease home（持了 8\.4s ×2）/))
  ok('重复 forceRelease 返回 false 且不抛错', noThrow('重复 forceRelease 不抛错', () => lock.forceRelease(REASON.HOME, 'timeout')) === false)
}

// ==================== 7. Step 2：兼容层已删 ====================
section('7. Step 2：legacy 兼容层已删，busy 只剩只读视图')
{
  ok('REASON 里没有 LEGACY 这条线', REASON.LEGACY === undefined)
  ok('RANK 里没有 __legacy__', RANK.__legacy__ === undefined)
  const mod = require(path.join(ROOT, 'src', 'actionlock'))
  ok('模块不再导出 installLegacyBusy', mod.installLegacyBusy === undefined)
  ok('模块不再导出 installHoming', mod.installHoming === undefined)

  // 没有 legacy 这条线之后，改忙状态只有 acquire/release/forceRelease 三条路，
  // 再没有"谁都能写一个布尔"的后门。
  const { lock } = makeLock()
  ok('空锁 busy=false', lock.busy === false)
  lock.acquire(REASON.TASK, '挖矿')
  ok('占一条线 busy=true', lock.busy === true)
  lock.release(REASON.TASK)
  ok('放掉才 false', lock.busy === false)
}

// ==================== 8. interruptCurrent 的顺序不变量 ====================
section('8. 顺序不变量：acquire(to) → 等 from 自己 release，中间没有 busy=false 的窗口')
{
  const { lock, logs } = makeLock()
  lock.acquire(REASON.TASK, '正在挖矿')

  // 第 1 步：先拿新的
  lock.acquire(REASON.FOLLOW, '玩家喊我')
  // 第 2 步这里会 actions.cancel = true（锁不参与），只检查锁的可见性
  const samples = []
  samples.push(lock.busy) // 新主子已经上位
  // 第 3 步：from 自己 release
  lock.release(REASON.TASK)
  samples.push(lock.busy)
  ok('全过程 busy 一直是 true（没有主循环能插进来的窗口）', samples.every(v => v === true), JSON.stringify(samples))
  ok('最后持有的是 to', lock.holders().map(h => h.reason).join(',') === REASON.FOLLOW)

  // 错误顺序对照：先 release 再 acquire —— 中间必然出现 busy=false
  const bad = makeLock()
  bad.lock.acquire(REASON.TASK, '正在挖矿')
  bad.lock.release(REASON.TASK)
  ok('错误顺序确实会露出 busy=false（说明这条不变量测的是真事）', bad.lock.busy === false)
}

// ==================== 9. canStart / canPreempt / rank ====================
section('9. 查询接口与 rank')
{
  const { lock } = makeLock()
  ok('空锁 canStart(task) = true', lock.canStart(REASON.TASK) === true)
  ok('空锁 canPreempt(follow) = true', lock.canPreempt(REASON.FOLLOW) === true)
  lock.acquire(REASON.FOLLOW, '跟人走')
  ok('follow 还在时 canStart(follow) = true（重入）', lock.canStart(REASON.FOLLOW) === true)
  ok('follow 还在时 canStart(task) = false', lock.canStart(REASON.TASK) === false)
  ok('follow 还在时 canStart(survive) = true（逃命能压过）', lock.canStart(REASON.SURVIVE) === true)
  ok('follow 还在时 canStart(session) = true（session 80 > 60）', lock.canStart(REASON.SESSION) === true)
  ok('home 压不过 follow', lock.canPreempt(REASON.HOME) === false)
  eq('rank 表跟文档一致', [RANK.survive, RANK.session, RANK.follow, RANK.home, RANK.task], [100, 80, 60, 50, 10])
  ok('未注册 reason 按 0', lock.rankOf('walking_the_dog') === 0)
}

// ==================== 10. holders 是能拿来查案的 ====================
section('10. holders / describe（卡死时靠这个定位）')
{
  const { lock, clock } = makeLock()
  lock.acquire(REASON.FOLLOW, '跟玩家走')
  clock.advance(480)
  lock.acquire(REASON.FOLLOW, '跟玩家走') // count 2
  const h = lock.holders()[0]
  eq('reason', h.reason, REASON.FOLLOW)
  eq('count', h.count, 2)
  eq('secs 打了 8 分钟', h.secs, 480)
  eq('why 保留了原因', h.why, '跟玩家走')
  ok('describe 一行能看懂', /follow×2 480s@跟玩家走/.test(lock.describe()), lock.describe())
  ok('describe 空闲时是「空闲」', makeLock().lock.describe() === '空闲')
}

// ==================== 11. 未注册 rank 不刷屏 / registerRank 生效 ====================
section('11. 新动作线只注册 rank，不改别人的代码')
{
  const { lock, logs } = makeLock()
  lock.acquire(REASON.TASK, '挖矿')
  ok('未注册的线抢不过 task', lock.acquire('walking_the_dog', '遛狗') === false)
  lock.acquire('walking_the_dog', '遛狗')
  lock.rankOf('walking_the_dog')
  const warnLines = logs.filter(s => /未知动作线 rank/.test(s)).length
  eq('警告只打一次', warnLines, 1)
  ok('registerRank 注册 55 生效', registerRank('walking_the_dog', 55) === true)
  ok('注册后能压过 task(10)', lock.canPreempt('walking_the_dog') === true)
  ok('但压不过 follow(60)', lock.acquire(REASON.FOLLOW, '玩家喊我') === true && lock.canPreempt('walking_the_dog') === false)
}

// ==================== 12. forceReleaseAll（死亡/断开的安全阀） ====================
section('12. forceReleaseAll')
{
  const { lock, logs } = makeLock()
  // 按 rank 递增的顺序占（低 rank 后被高 rank 压是正常规则）
  lock.acquire(REASON.TASK, '挖矿')
  lock.acquire(REASON.HOME, '回家')
  lock.acquire('session', '收工结算')
  eq('三条线', lock.holders().length, 3)
  eq('清掉三条', lock.forceReleaseAll('死亡'), 3)
  ok('锁全空', lock.busy === false)
  eq('重复调用是 0', lock.forceReleaseAll('死亡'), 0)
  ok('每个都留了日志', logs.filter(s => /forceRelease .*← 死亡/.test(s)).length === 3)
}

// ==================== 13. 死守的边界：acquire 拒绝时不能半推半就 ====================
section('13. 被拒的 acquire 不留下任何痕迹')
{
  const { lock } = makeLock()
  lock.acquire(REASON.SURVIVE, '逃命')
  const before = JSON.stringify(lock.holders())
  lock.acquire(REASON.HOME, '回家')
  eq('holders 没变', JSON.stringify(lock.holders()), before)
}

// ==================== C. 接线守则（Step 2 之后） ====================
section('C. 接线守则：没有第二个人能改忙状态')
{
  const mainPath = path.join(ROOT, 'main.js')
  const src = fs.readFileSync(mainPath, 'utf8')
  // 去掉注释行再数，免得被历史说明里的代码片段骗到
  const codeLines = src.split('\n').filter(line => {
    const t = line.trim()
    return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  })

  ok('兼容层 installLegacyBusy 已删除', !/installLegacyBusy\s*\(/.test(src))
  ok('兼容层 installHoming 已删除', !/installHoming\s*\(/.test(src))
  eq('this.busy = 写点归零', codeLines.filter(l => /this\.busy\s*=/.test(l)).length, 0)
  eq('this._homing = 写点归零', codeLines.filter(l => /this\._homing\s*=/.test(l)).length, 0)
  ok('busy 是只读 getter', /defineProperty\(this,\s*'busy'/.test(src) && /get:\s*\(\)\s*=>\s*this\.lock\.busy/.test(src))
  ok('有 interruptCurrent()', /async interruptCurrent\s*\(/.test(src))

  // cancel 只许一处写：这是 107 那个 bug 结构上不可能复现的前提
  eq('actions.cancel = true 只有一处', codeLines.filter(l => /actions\.cancel\s*=\s*true/.test(l)).length, 1)
  const cancelIdx = codeLines.findIndex(l => /actions\.cancel\s*=\s*true/.test(l))
  const fnIdx = codeLines.findIndex(l => /_signalCancel\s*\(/.test(l))
  ok('唯一那处写在 _signalCancel 里', fnIdx >= 0 && cancelIdx > fnIdx && cancelIdx - fnIdx <= 8,
    `_signalCancel 在 ${fnIdx + 1} 行，写入在 ${cancelIdx + 1} 行`)

  // 顺序不变量：先 acquire(to)，再 cancel，再等 from，再 forceRelease
  const ic = src.slice(src.indexOf('async interruptCurrent'))
  const body = ic.slice(0, ic.indexOf('\n  }'))
  const iAcquire = body.indexOf('lock.acquire')
  const iCancel = body.indexOf('_signalCancel')
  const iWait = body.indexOf('isHolding(from)')
  const iForce = body.indexOf('forceRelease')
  ok('顺序 1：先 acquire(to)', iAcquire >= 0 && iAcquire < iCancel)
  ok('顺序 2：再发 cancel', iCancel >= 0 && iCancel < iWait)
  ok('顺序 3：等 from 自己 release，再超时 forceRelease', iWait >= 0 && iWait < iForce)
  ok('最后才在 !busy 时复位 cancel', /!this\.lock\.busy[\s\S]{0,80}cancel\s*=\s*false/.test(body))

  // 三条线都真的在占锁/放锁（不是只靠 busy 显示）
  for (const r of ['TASK', 'HOME', 'SURVIVE']) {
    ok(`main.js 占锁 ${r}`, src.includes(`lock.acquire(REASON.${r}`))
    ok(`main.js 放锁 ${r}`, src.includes(`lock.release(REASON.${r}`))
  }
}

// ==================== D. 真对象冒烟：107→105→107 的回归 ====================
//
// 前面 13 段测的是锁本身。这一段用**真的 Bot 实例**（不连服务器、不碰正式数据），
// 跑一遍当年那个 bug 的现场：任务先起跑 → 回家插进来 → 早跑的任务收尾 busy=false。
section('D. 真对象冒烟：任务收尾清不掉回家的锁（107→105→107 的现场）')
;(async () => {
  const cfgPath = path.join(ROOT, 'config.json')
  if (!fs.existsSync(cfgPath)) {
    console.log('  · 没有 config.json，本段跳过')
    return
  }
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-smoke-'))
  process.env.AIFRIEND_DATA = tmpData
  const { Bot } = require(path.join(ROOT, 'main.js'))
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))

  let bot
  try {
    bot = new Bot(cfg)
  } catch (e) {
    ok('构造 Bot 实例', false, e.message)
    return
  }
  const logs = []
  bot.log = (s) => logs.push(s)
  const has = (re) => logs.some(x => re.test(x))

  // ---- Step 2：busy 只读，写它直接抛错 ----
  ok('busy 没有 setter', Object.getOwnPropertyDescriptor(bot, 'busy').set === undefined)
  let wrote = false
  try { bot.busy = true; wrote = true } catch (e) { wrote = false }
  ok('严格模式下写 busy 抛错（逼你写清是哪条线）', wrote === false)

  // ---- 场景：task 早就起跑，home 中途插进来 ----
  // 这就是 06:18 的现场。旧代码里老任务收尾会无条件 busy=false 把 home 清掉，
  // 主循环立刻起新任务，两边抢 pathfinder —— 实测 107 → 105 → 107。
  bot.home = {
    goHome: async () => { await new Promise(r => setTimeout(r, 120)); return { ok: true, seconds: 0.1 } }
  }
  logs.length = 0
  bot.lock.acquire(REASON.TASK, '早就起跑的任务')
  const walking = bot.walkHomeNow('冒烟：回家')
  await new Promise(r => setTimeout(r, 20))
  ok('两条线同时在（busy 仍是 true）', bot.busy === true && bot.lock.holders().length === 2)
  ok('home 已持有', bot.lock.isHolding(REASON.HOME))

  // 老任务收尾：只归还自己那条线
  bot.lock.release(REASON.TASK)
  ok('【核心】home 的锁还在', bot.lock.isHolding(REASON.HOME))
  ok('【核心】busy 还是 true —— 主循环不会起新任务（107 消失）', bot.busy === true)
  const gate = () => bot.busy ? 'blocked' : 'start-new-task'
  eq('主循环闸门', gate(), 'blocked')

  ok('walkHomeNow 正常收尾', (await walking) === true)
  ok('回家结束锁才空', bot.busy === false && bot.lock.holders().length === 0)
  eq('taskDesc 被 method 清空', bot.taskDesc, '')

  // ---- interruptCurrent 的 5 步顺序（真方法，不是复述）----
  bot.actions = { cancel: false, stop () {} }
  bot.lock.acquire('task', '正在挖矿')
  // from 在 80ms 后自己放手（模拟它的 finally）
  setTimeout(() => bot.lock.release('task'), 80)
  const switched = await bot.interruptCurrent({ from: 'task', to: 'follow', why: '玩家喊我跟着走', timeoutMs: 2000, step: 10 })
  ok('interruptCurrent 返回 true', switched === true)
  ok('from 已经放手', !bot.lock.isHolding('task'))
  ok('to 已经上位', bot.lock.isHolding('follow'))
  ok('to 还在跑时 cancel 不会被提前复位', bot.actions.cancel === true)
  bot.lock.release('follow')
  ok('to 释放后锁空', bot.busy === false)

  // ---- 超时夺锁（from 死不放）----
  logs.length = 0
  bot.lock.acquire('home', '回家卡死')
  const t0 = Date.now()
  const okTimeout = await bot.interruptCurrent({ from: 'home', to: 'survive', why: '逃命', timeoutMs: 120, step: 20 })
  ok('超时路径也返回 true', okTimeout === true)
  ok('超时后 home 被夺走', !bot.lock.isHolding('home'))
  ok('夺锁有日志（这里死过一次要有证据）', has(/\[lock\] home 超时未释放 [\d.]+s，强制夺走/))
  ok('确实等满了 timeout', Date.now() - t0 >= 120)
  bot.lock.release('survive')

  // ---- rank 抢不过时什么都不动 ----
  logs.length = 0
  bot.actions.cancel = false
  bot.lock.acquire('survive', '被骷髅追')
  const refused = await bot.interruptCurrent({ from: 'task', to: 'home', why: '回家' })
  ok('抢不过时返回 false', refused === false)
  ok('survive 没被打断', bot.lock.isHolding('survive'))
  ok('home 没上位', !bot.lock.isHolding('home'))
  ok('也没白发中断信号', bot.actions.cancel === false && !has(/中断信号/))
  bot.lock.forceReleaseAll('冒烟结束')
  ok('收尾后锁为空', bot.busy === false)

  try { fs.rmSync(tmpData, { recursive: true, force: true }) } catch (e) {}
})().then(() => finish())

// ---------------- 结果 ----------------
let finished = false
function finish () {
  if (finished) return
  finished = true
  console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass}，失败 ${fail}`)
  if (fail) {
    console.log('\n失败项：')
    for (const f of failures) console.log('  · ' + f)
  }
  process.exit(fail ? 1 : 0)
}

setTimeout(finish, 30000)
