#!/usr/bin/env node
'use strict'
/**
 * 探针：「能被邀请」这一层（offscreen，不连服务器）
 *
 * 验收口径（lead 给的）：
 *   · 跟 3 分钟不丢人
 *   · 跟着的时候不插队干活（不开新任务）
 *   · 至少说 2 句话
 *   · 不许站人身上、不许跟着跳崖
 *
 * 用假 bot + 假时钟 + 假 speak，一秒真实时间都不等。
 *
 * 用法：node scripts/probe-invite.js
 */

const fs = require('fs')
const path = require('path')
const { Invite } = require('../src/invite')

let pass = 0; let fail = 0
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) } else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}

// ---------------------------------------------------------------- 假世界

class V {
  constructor (x, y, z) { this.x = x; this.y = y; this.z = z }
  clone () { return new V(this.x, this.y, this.z) }
  distanceTo (o) { return Math.hypot(o.x - this.x, o.y - this.y, o.z - this.z) }
}

let clockT = 0

function makeBot (name = 'XJJ', at = [0, 64, 0]) {
  const bot = {
    username: name,
    version: '1.21.11',
    entity: { position: new V(...at), yaw: 0, onGround: true },
    registry: require('minecraft-data')('1.21.11'),
    inventory: { items: () => [] },
    game: { gameMode: 'survival' },
    entities: {},
    players: {},
    pathfinder: {
      goal: null,
      movements: null,
      isMoving: () => false,
      setGoal (g) { this.goal = g },
      setMovements (m) { this.movements = m },
      stop () {}
    },
    controls: {},
    dug: 0,
    controlLog: [],
    setControlState (k, v) { this.controls[k] = v; this.controlLog.push([k, v]) },
    clearControlStates () { this.controls = {} },
    stopDigging () { bot.dugStopped = (bot.dugStopped || 0) + 1 }
  }
  return bot
}

function addPlayer (bot, name, at) {
  bot.players[name] = { username: name, entity: { position: new V(...at), yaw: 0, pitch: 0 } }
  return bot.players[name]
}

function makeInvite (bot, opts = {}) {
  const lines = []
  const inv = new Invite({
    log: () => {},
    now: () => clockT,
    sleep: async () => {},
    opts,
    speak: async (situation, o) => { lines.push(situation); return true },
    isBotName: () => false
  })
  inv.attach(bot)
  inv.lines = lines
  return inv
}

/** 跑 n 秒，每秒 tick 一次；每步让玩家按 mover 移动 */
async function run (inv, bot, name, seconds, mover) {
  for (let i = 0; i < seconds; i++) {
    clockT += 1000
    const ent = bot.players[name] && bot.players[name].entity
    if (mover) mover(i, ent && ent.position)
    await inv.tick()
  }
}

// ================================================================
async function main () {
  console.log('\n[1] 收到「跟我来」：接下、打断手上的活、说一句带名字的话')
  // ================================================================
  {
    clockT = 1000
    const bot = makeBot()
    addPlayer(bot, 'XJJF', [2, 64, 0])
    const inv = makeInvite(bot)

    const r = inv.handleChat('XJJF', 'XJJ 跟我来')
    ok(r === 'invite', '识别为邀请')
    ok(inv.active === true && inv.target === 'XJJF', '状态 active，目标是 XJJF')
    ok(inv.lines.length === 1, `接了就说一句：${inv.lines[0] || '（无）'}`)
    ok(inv.lines[0].includes('XJJF'), '这句话带他的名字（提示词里点名）')
    ok(bot.dugStopped > 0, 'stopDigging 被调用（打断当前活）')
    ok(inv._safeMovements && inv._safeMovements.maxDropDown === 2, '跟随用安全寻路：maxDropDown=2（不跳崖）')
    ok(inv._safeMovements.allowParkour === false, 'allowParkour=false（不连着蹦）')
  }

  // ================================================================
  console.log('\n[2] 跟 3 分钟：玩家走走停停，不丢人')
  // ================================================================
  {
    clockT = 0
    const bot = makeBot()
    addPlayer(bot, 'XJJF', [3, 64, 0])
    const inv = makeInvite(bot)
    inv.handleChat('XJJF', '过来一起挖')

    const pos = bot.players.XJJF.entity.position
    // 玩家：走 20 秒、停 15 秒、再走 25 秒……总共 180 秒
    const segs = [[20, 1], [15, 0], [25, 1], [20, 0], [30, 1], [15, 0], [25, 1], [30, 1]]
    let seg = 0; let segT = 0; let dirZ = 1
    await run(inv, bot, 'XJJF', 180, (i) => {
      const [dur, moving] = segs[seg]
      if (segT >= dur) {
        seg = Math.min(segs.length - 1, seg + 1); segT = 0
        dirZ = dirZ * -1
      }
      segT++
      if (moving) {
        pos.z += dirZ * 0.9                       // 玩家慢慢走
        // bot 跟着（模拟 pathfinder：每 tick 朝玩家挪一点，保持 2 格）
        const me = bot.entity.position
        const d = me.distanceTo(pos)
        if (d > 2 && bot.pathfinder.goal) {
          const step = Math.min(1.1, d - 2)
          me.x += (pos.x - me.x) / d * step
          me.z += (pos.z - me.z) / d * step
          me.y += Math.max(-0.6, Math.min(0.6, (pos.y - me.y) / d))
        }
      }
    })

    const rep = inv.report()
    ok(inv.active === true, '3 分钟后仍然在跟（没丢人）')
    ok(rep.lost === 0, 'lost=0')
    ok(rep.nearRatio >= 0.9, `跟住比例 ${rep.nearRatio}（每秒采样，2.5 格内算跟上）`)
    ok(rep.maxDist <= 6, `最远只到 ${rep.maxDist} 格`)
    ok(rep.lines >= 2, `3 分钟说了 ${rep.lines} 句话（判据：至少 2 句）`)
    ok(rep.backoffs <= 5, `没有反复贴人后退（${rep.backoffs} 次 / 180 秒）`)
    console.log(`     细节：${JSON.stringify(rep)}`)
  }

  // ================================================================
  console.log('\n[3] 玩家站着不动 90 秒：跟着但不催')
  // ================================================================
  {
    clockT = 0
    const bot = makeBot()
    addPlayer(bot, 'XJJF', [2.2, 64, 0])
    const inv = makeInvite(bot)
    inv.handleChat('XJJF', '跟我来')
    const linesAfterStart = inv.lines.length

    // 前 2 秒在 3 格外 -> 会 setGoal；之后站着
    await run(inv, bot, 'XJJF', 90, () => {})
    ok(inv._idleHeld === true, '判定玩家停下 -> 自己也停（idleHeld）')
    ok(bot.pathfinder.goal === null, '停下后 pathfinder.goal 被清空（不贴着催）')
    const extraLines = inv.lines.length - linesAfterStart
    ok(extraLines <= 2, `90 秒里只多说 ${extraLines} 句（不催人）`)
    ok(!/走啊|快来|你走/.test(inv.lines.join('')), '没有催人的话术')
  }

  // ================================================================
  console.log('\n[4] 玩家跑远 >32 格：喊一句，15 秒内不重复')
  // ================================================================
  {
    clockT = 0
    const bot = makeBot()
    addPlayer(bot, 'XJJF', [0, 64, 3])
    const inv = makeInvite(bot)
    inv.handleChat('XJJF', '跟上')
    await inv.tick()

    // 玩家直接跑到 40 格外（模拟他跑得快 / 有坐骑）
    bot.players.XJJF.entity.position.z = 40
    const before = inv.lines.length
    await inv.tick()
    const afterFirst = inv.lines.length
    ok(afterFirst === before + 1, `第一次超距喊了一句：${inv.lines[inv.lines.length - 1]}`)
    ok(/XJJF/.test(inv.lines[inv.lines.length - 1]), '喊话里带他的名字')
    // 立即再来 3 秒：不重复喊
    await run(inv, bot, 'XJJF', 3, () => {})
    ok(inv.lines.length === afterFirst, '3 秒内没有重复喊（15 秒间隔）')
    ok(inv.stats.shouts === 1, `shouts=${inv.stats.shouts}`)
  }

  // ================================================================
  console.log('\n[5] 不许站人身上：<1.2 格后退半步')
  // ================================================================
  {
    clockT = 0
    const bot = makeBot()
    addPlayer(bot, 'XJJF', [0.6, 64, 0])
    const inv = makeInvite(bot)
    inv.handleChat('XJJF', '过来')
    // 站定 1.5 秒后才退（刚贴上来就躲，看起来像抽搐）
    await run(inv, bot, 'XJJF', 3, () => {})
    ok(inv.stats.backoffs >= 1, `触发后退 ${inv.stats.backoffs} 次`)
    ok(bot.controlLog.some(([k, v]) => k === 'back' && v === true), 'setControlState("back", true) 被调用')
    ok(inv.stats.backoffs <= 2, `3 秒内最多退 ${inv.stats.backoffs} 次（有 2 秒冷却）`)
  }

  // ================================================================
  console.log('\n[6] 不许跟着跳崖：目标在下面 6 格且很近时，绕不跳')
  // ================================================================
  {
    clockT = 0
    const bot = makeBot()
    addPlayer(bot, 'XJJF', [0, 58, 3])     // 玩家在脚下 6 格
    const inv = makeInvite(bot)
    inv.handleChat('XJJF', '下来')
    await inv.tick()
    ok(inv.stats.ledgeGuards === 1, '识别为高低差场景（ledgeGuards=1）')
    ok(bot.pathfinder.goal && bot.pathfinder.goal.constructor.name === 'GoalNear',
      `改用 GoalNear 绕路（不是跳下去）：${bot.pathfinder.goal && bot.pathfinder.goal.constructor.name}`)
    ok(!(bot.pathfinder.goal && bot.pathfinder.goal.constructor.name === 'GoalFollow'),
      '没有直接 GoalFollow 到下面去')
  }

  // ================================================================
  console.log('\n[7] 玩家说「别跟了」/ 跟丢')
  // ================================================================
  {
    clockT = 0
    const bot = makeBot()
    addPlayer(bot, 'XJJF', [2, 64, 0])
    const inv = makeInvite(bot)
    inv.handleChat('XJJF', '跟我来')
    ok(inv.active, '先跟上了')
    inv.handleChat('XJJF', '算了别跟了')
    ok(inv.active === false, '「别跟了」-> 立刻停')
    ok(bot.pathfinder.goal === null, 'pathfinder goal 清空')

    // 跟丢：玩家消失 16 秒
    clockT = 100000
    addPlayer(bot, 'XJJG', [2, 64, 0])
    const inv2 = makeInvite(bot)
    inv2.handleChat('XJJG', '跟我走')
    delete bot.players.XJJG
    await run(inv2, bot, 'XJJG', 17, () => {})
    ok(inv2.active === false, '消失 15 秒后结束跟随')
    ok(inv2.report().lost === 1, 'lost=1')
    ok(inv2.lines.length >= 2, `跟丢时说了一句（共 ${inv2.lines.length} 句）`)
  }

  // ================================================================
  console.log('\n[8] 跟着的时候不开新任务（主循环闸门）')
  // ================================================================
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
    ok(/if \(this\.invite && this\.invite\.active\) return/.test(src),
      'main.js 任务选择前有 invite.active 闸门')
    const idx = src.indexOf('if (this.invite && this.invite.active) return')
    const goalIdx = src.indexOf('// 7. 有答应别人的事就先做')
    ok(idx > 0 && goalIdx > idx, '闸门在"选任务"之前（顺序对）')
    ok(/this\.invite\.handleChat\(username, message\)/.test(src), 'chat 入口接上了')
  }

  // ================================================================
  console.log('\n[9] 不会把别的玩家/机器人当邀请')
  // ================================================================
  {
    clockT = 0
    const bot = makeBot()
    addPlayer(bot, 'XJJA', [2, 64, 0])
    addPlayer(bot, 'XJJB', [2, 64, 0])
    const inv = makeInvite(bot)
    ok(inv.handleChat('XJJA', 'XJJB 跟我来') === null, '"小明跟我来" 不接（叫的是别人）')
    ok(inv.active === false, '没有被拉走')
    ok(inv.handleChat('XJJA', '这怪真难打') === null, '普通聊天不触发')
    ok(inv.handleChat('XJJA', 'follow me') === 'invite', '英文 follow me 也认')
  }

  // ================================================================
  console.log('\n[10] 跟着 A 的时候，旁人说「跟紧点」不许抢人')
  // ================================================================
  {
    clockT = 0
    const bot = makeBot()
    addPlayer(bot, 'XJJA', [2, 64, 0])
    addPlayer(bot, 'XJJB', [3, 64, 2])
    const inv = makeInvite(bot)
    inv.handleChat('XJJA', 'XJJA 跟我来，走')
    ok(inv.target === 'XJJA', '先跟 XJJA')
    const r = inv.handleChat('XJJB', '哦 那你跟紧点 别掉坑里')
    ok(r === null && inv.target === 'XJJA', '旁边人说「跟紧点」不抢人（实机踩过的坑）')
    const r2 = inv.handleChat('XJJB', 'XJJ 过来一下')
    ok(r2 === 'invite' && inv.target === 'XJJB', '但点名叫了才换人')
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
}

main().then(() => process.exit(fail ? 1 : 0)).catch(e => { console.error(e); process.exit(1) })
