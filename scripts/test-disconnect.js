#!/usr/bin/env node
'use strict'
/**
 * 断线收尾测试：`_teardown` 四类状态 + 三条路径 + 不记失败。
 *
 * 为什么要有这个脚本
 * ------------------------------------------------------------------
 * 「断线时状态全都没清」这个 bug **长跑抓不到** —— 它伪装成正常行为：
 * 重连回来人还是那个人，只是从那一刻起永远不开新任务、第一句话被闸门拦掉、
 * 或者突然提起断线前的人和事。日志里没有任何"错"。
 *
 * 所以用离线断线注入：真 Bot 实例（不连服务器、数据目录打到 tmp）+ 假组件，
 * 直接调 `_teardown()`，断言四类状态。1 秒跑完，改一次跑一次。
 *
 * 验收判据（Lead 定的第 4 条）
 * ------------------------------------------------------------------
 * 断线注入 5 次后，skills.json 里任何技能的 fail **不许增加**。
 * 断线不是"他没做成事"——记了 fail，goals 会以为这个阶段不行、
 * 技能库会"越失败越窄"，一次网络抖动就被当成能力问题。
 *
 * 跑法：node scripts/test-disconnect.js
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
let pass = 0
let fail = 0
const failures = []

function ok (name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) } else {
    fail++; failures.push(name)
    console.log('  ✗ ' + name + (extra ? '  ' + extra : ''))
  }
}
function section (t) { console.log('\n' + t) }

// ==================== 造一个"断线前"的现场 ====================
//
// 不连服务器。`new Bot(cfg)` 只建 lock / mem / cost / skills，
// will/spont/talk/actions/invite 是 connect() 里才建的 —— 这里手动塞假件，
// 字段名照真实对象的来，`_teardown` 就是按这些字段清的。

function makeBot (Bot, cfg) {
  const bot = new Bot(cfg)
  const logs = []
  bot.log = (s) => logs.push(s)
  bot.logs = logs

  // ① 闸门 / 时间（照 src/talk.js 的真实字段名）
  bot.talk = {
    lastSayAt: 1234567,
    lastSpokeAt: 1234000,
    sayWindow: [1, 2, 3],
    repliedMsgIds: new Map([['老王|过来', 1], ['老李|在吗', 2]]),
    _ackCleared: false,
    cancelPendingAck (why) { this._ackCleared = why }
  }

  // ② 待办 / 承诺
  bot.will = { current: { text: '去砍树', since: 1, done: false }, finish () { this.current = null } }
  bot.pendingTask = { text: '帮老王挖石头', from: '老王', at: 1 }
  bot.spont = {
    pendingEvents: [
      { ev: { situation: '老王 在挨打', trigger: 'friendInDanger' }, t: 1, kind: 'social' },
      { ev: { situation: '跑不动了', trigger: 'complain' }, t: 2, kind: 'complain' }
    ]
  }

  // ③ 动作线 / 锁
  // 注意 acquire 的规则：只有 rank 更高的才压得过当前的（TASK 10 < HOME 50），
  // 所以「两条线同时占着」必须先 TASK 再 HOME —— 反过来 HOME 在时 TASK 会被直接拒。
  bot.actions = {
    cancel: true,
    stopped: false,
    stop () { this.stopped = true },
    status () {
      return { pos: { x: 1, y: 2, z: 3 }, health: 20, food: 20, time: '白天', inventory: {} }
    },
    isUnderground () { return false }
  }
  bot._taskTimer = setTimeout(() => {}, 60000)
  if (bot._taskTimer.unref) bot._taskTimer.unref()
  bot._taskProgress = { at: Date.now(), pos: { x: 1, y: 2, z: 3 } }
  bot._taskStartAt = Date.now()
  bot._taskStartInv = { dirt: 3 }
  bot._taskStartPos = { x: 1, y: 2, z: 3 }
  bot._taskStartWorld = 'sig'
  bot._taskStartHealth = 20
  bot._taskStartFood = 20
  bot._taskStartHeld = 'stone_pickaxe'

  // ②' invite 的承诺（内部字段，stop() 在没跟人时清不到，所以 teardown 直接清）
  bot.invite = {
    _pendingFollow: { user: '老王', at: 1 },
    _pendingRecover: { user: '老李', at: 2 },
    stopped: false,
    stop () { this.stopped = true }
  }

  // ④ 目标层：只记录有没有被调用，用来证明"断线不记失败"
  bot.goalCalls = []
  bot.goals = {
    calls: bot.goalCalls,
    onTaskResult (arg) { this.calls.push(arg); return { stageCompleted: false } },
    currentStage () { return null },
    stage () { return null },
    observe () { return null },
    ensure () { return null }
  }
  return bot
}

async function main () {
  const cfgPath = path.join(ROOT, 'config.json')
  if (!fs.existsSync(cfgPath)) {
    console.log('没有 config.json，无法构造 Bot，退出')
    process.exit(1)
  }
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'disc-test-'))
  process.env.AIFRIEND_DATA = tmpData
  // 第④类的证据文件：先确认它在 tmp 里，别碰 data/runtime/
  const realSkills = path.join(ROOT, 'data', 'runtime', 'skills.json')
  const realBefore = fs.existsSync(realSkills) ? fs.readFileSync(realSkills, 'utf8') : null

  const { Bot } = require(path.join(ROOT, 'main.js'))
  const Talk = require(path.join(ROOT, 'src', 'talk.js'))
  const { REASON } = require(path.join(ROOT, 'src', 'actionlock.js'))
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))

  // ==================== A. 第③类：锁 ====================
  section('A. ③ 占用/锁：断线时持着的锁必须全释放')
  {
    const bot = makeBot(Bot, cfg)
    // 先 TASK(rank 10) 再 HOME(rank 50)：高的才能叠在低的上面
    bot.lock.acquire(REASON.TASK, '砍树')
    bot.lock.acquire(REASON.HOME, '走回家')
    ok('断线前确实占着两把锁', bot.lock.holders().length === 2, `holders=${bot.lock.holders().length}`)
    ok('断线前 busy 为 true', bot.busy === true)

    const did = bot._teardown('end:socketClosed')

    ok('_teardown 返回 true（第一次确实做了事）', did === true)
    ok('锁全部释放（holders 为 0）', bot.lock.holders().length === 0)
    ok('busy 变回 false（否则重连后永远开不了新任务）', bot.busy === false)
    ok('actions.cancel 归零', bot.actions.cancel === false)
    ok('actions.stop() 被调过', bot.actions.stopped === true)
    ok('任务起点字段清空', bot._taskStartAt === null && bot._taskStartInv === null && bot._taskStartPos === null)
    ok('任务进度清空', bot._taskProgress === null)
    ok('任务定时器清空', bot._taskTimer === null)
    ok('释放锁写了日志', bot.logs.some(l => /\[teardown\] 释放锁/.test(l)), bot.logs.find(l => /释放锁/.test(l)) || '')
  }

  // ==================== B. 第②类：待办/承诺 ====================
  section('B. ② 待办/承诺：重连后不该继续干断线前的事')
  {
    const bot = makeBot(Bot, cfg)
    bot._teardown('kicked:spam')
    ok('will.current 为 null', bot.will.current === null)
    ok('pendingTask 为 null', bot.pendingTask === null)
    ok('spont.pendingEvents 清空', bot.spont.pendingEvents.length === 0)
    ok('invite._pendingFollow 清空', bot.invite._pendingFollow === null)
    ok('invite._pendingRecover 清空', bot.invite._pendingRecover === null)
    ok('invite.stop() 被调过', bot.invite.stopped === true)
    ok('talk.cancelPendingAck 被调过', bot.talk._ackCleared === 'kicked:spam', String(bot.talk._ackCleared))
  }

  // ==================== C. 第①类：闸门 ====================
  section('C. ① 限速/时间：闸门必须归零（sayWindow 20 秒 > 重连 15 秒，不清就拦第一句）')
  {
    const bot = makeBot(Bot, cfg)
    Talk.GLOBAL_SAY.lastAt = 999999
    Talk.GLOBAL_SAY.window = [1, 2, 3, 4]
    bot._teardown('error:read ECONNRESET')
    ok('talk.lastSayAt 归零', bot.talk.lastSayAt === 0)
    ok('talk.lastSpokeAt 归零', bot.talk.lastSpokeAt === 0)
    ok('talk.sayWindow 清空', bot.talk.sayWindow.length === 0)
    ok('talk.repliedMsgIds 清空', bot.talk.repliedMsgIds.size === 0)
    ok('GLOBAL_SAY.lastAt 归零', Talk.GLOBAL_SAY.lastAt === 0)
    ok('GLOBAL_SAY.window 清空', Talk.GLOBAL_SAY.window.length === 0)
    ok('各类冷却时间戳归零',
      bot._foodCooldownUntil === 0 && bot._lowHpAt === 0 && bot._lastHeadHomeAt === 0 &&
      bot._lastGoalObserveAt === 0 && bot._nightAlerted === false)
  }

  // ==================== D. 第④类：绝不记失败 ====================
  section('D. ④ 断线不记失败（这条是硬约束）')
  {
    const bot = makeBot(Bot, cfg)
    // 断线前：正常的失败汇报应该照常进 goals
    const r0 = bot.reportTaskResult(false, '砍树', '没做成', { progress: 0 })
    ok('断线前：失败汇报正常进 goals', bot.goals.calls.length === 1 && r0 !== null)

    bot._teardown('end:socketClosed')
    const r1 = bot.reportTaskResult(false, '砍树', '没做成', { progress: 0 })
    ok('断线后：reportTaskResult 直接返回 null', r1 === null)
    ok('断线后：goals.onTaskResult 没被再调用（fails 不涨）', bot.goals.calls.length === 1, `calls=${bot.goals.calls.length}`)
    ok('断线后：日志说明是"被断线打断"', bot.logs.some(l => /被断线打断/.test(l)))
    ok('_interrupted 标记立起来了', bot._interrupted === true)
  }

  // ==================== E. 幂等 + 三条路径 ====================
  section('E. 幂等：kicked -> end 连着来，只收尾一次')
  {
    const bot = makeBot(Bot, cfg)
    const first = bot._teardown('kicked:spam')
    const second = bot._teardown('end:socketClosed')
    ok('第一次 true', first === true)
    ok('第二次 false（不重复做）', second === false)
    const done = bot.logs.filter(l => /断线收尾完成/.test(l))
    ok('收尾日志只打一次', done.length === 1, `count=${done.length}`)
  }

  section('F. 三条路径都接上了（静态检查 main.js）')
  {
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
    const kickedBlock = src.slice(src.indexOf("bot.on('kicked'"), src.indexOf("bot.on('error'"))
    const errStart = src.indexOf("bot.on('error'")
    const errBlock = src.slice(errStart, errStart + 400)
    ok("onEnd 里调了 _teardown", /this\._teardown\('end:/.test(src))
    ok("kicked 分支调了 _teardown", /_teardown\(why\)/.test(kickedBlock), kickedBlock.split('\n').filter(l => /teardown/.test(l)).join(' | '))
    ok("error 分支调了 _teardown", /_teardown\('error:/.test(errBlock))
    ok('connect() 复位 _tornDown / _interrupted', /this\._tornDown = false/.test(src) && /this\._interrupted = false/.test(src))
    ok('_teardown 不在任何地方被当成功路径调用', !/_teardown\(.*progress/.test(src))
  }

  // ==================== G. 连跑 5 次断线，fail 不许涨 ====================
  section('G. 断线注入 5 次：skills 的 fail 不许增加（Lead 的验收判据）')
  {
    const bot = makeBot(Bot, cfg)
    bot.skills.add({ name: 'test_chop', desc: '砍树', code: '// noop', tags: ['砍树'] })
    const before = bot.skills.data.skills.map(s => ({ name: s.name, fail: s.fail || 0, ok: s.ok || 0 }))
    for (let i = 0; i < 5; i++) {
      bot._tornDown = false        // 模拟 connect() 复位
      bot._interrupted = false
      bot.lock.acquire(REASON.TASK, '第' + i + '局')
      bot._teardown('end:第' + i + '次')
      bot.reportTaskResult(false, '砍树', '断了', { progress: 0 })
    }
    const after = bot.skills.data.skills.map(s => ({ name: s.name, fail: s.fail || 0, ok: s.ok || 0 }))
    ok('5 次断线后 fail 完全没变', JSON.stringify(before) === JSON.stringify(after),
      `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)
    ok('5 次断线后 goals 一次都没收到失败', bot.goals.calls.length === 0, `calls=${bot.goals.calls.length}`)
    ok('5 次断线后锁都是空的', bot.lock.holders().length === 0)
  }

  // ==================== H. 不碰用户真实数据 ====================
  section('H. 数据隔离：整轮没写过 data/runtime/skills.json')
  {
    const realAfter = fs.existsSync(realSkills) ? fs.readFileSync(realSkills, 'utf8') : null
    ok('data/runtime/skills.json 内容一字未变', realBefore === realAfter,
      realBefore === realAfter ? '' : '被改动了！')
    ok('测试数据写在 tmp 里', String(process.env.AIFRIEND_DATA).startsWith(os.tmpdir()), String(process.env.AIFRIEND_DATA))
  }

  console.log(`\n===== 结果 =====\n${pass} 通过，${fail} 失败`)
  if (fail) {
    console.log('失败项：\n  ' + failures.join('\n  '))
    process.exit(1)
  }
}

main().catch(e => { console.error('测试脚本自己崩了: ' + e.stack); process.exit(2) })
