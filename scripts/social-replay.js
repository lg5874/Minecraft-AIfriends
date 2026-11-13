#!/usr/bin/env node
'use strict'
/**
 * UNHUMAN-SCAN #3 / #14 的 A/B 重放验证。
 *
 * 为什么要这个脚本：
 *   #3 的验收指标是「54 次玩家上下线，他招呼了几次；改前 0」。
 *   真机 25 分钟一轮、要有人不断进出，跑一次成本很高；
 *   而这条链上的决定（队列上限、优先级、冷却、预算、复读拦截）
 *   全部是**纯时间逻辑**，用虚拟时钟重放就能精确复现。
 *
 * 做法：
 *   · 虚拟时钟（劫持 Date.now / Math.random），25 分钟压缩到 1 秒内跑完
 *   · 真的 Spontaneity + 真的 Talk + 真的 Memory，只有 LLM 和 bot 是桩
 *   · 同一份时间线分别跑旧代码（git worktree 4dc6627）和新代码，数字直接可比
 *
 * 用法：
 *   node scripts/social-replay.js --impl new --seeds 20
 *   node scripts/social-replay.js --impl old --seeds 20
 *   node scripts/social-replay.js --impl both --seeds 20 --minutes 25
 */

const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')

const argv = process.argv.slice(2)
const argOf = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const IMPL = argOf('impl', 'both')        // old | new | both
const SEEDS = parseInt(argOf('seeds', '20'), 10)
const MINUTES = parseFloat(argOf('minutes', '25'))
const TICK_MS = 4000

// ==================================================================
// 时间线与随机：可复现
// ==================================================================
let NOW = 0
const realNow = Date.now

function mulberry32 (a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

function installVirtualTime (seed) {
  NOW = 0
  Date.now = () => NOW
  Math.random = mulberry32(seed)
}

function restoreRealTime () {
  Date.now = realNow
}

// 服务器里见过的名字（UNHUMAN-SCAN 原文里出现的两个 + 一批同风格的）
const NAME_POOL = [
  'TMGepccj4', 'XJJ_E2E6o5d', 'TMGhuan', 'XJJHOME6', 'cold_tea',
  'TMGepccj4', 'XJJ_E2E6o5d', 'abc_wang', 'TMGhuan', 'night_owl',
  'TMGepccj4', 'XJJ_E2E6o5d'
]

/**
 * 生成 25 分钟里的事件时间线。
 *
 * 依据 UNHUMAN-SCAN #3 的实测：54 次上下线 / 25 分钟（平均 27.8 秒一次），
 * 且日志里 TMGepccj4、XJJ_E2E6o5d 这些名字反复出现（测试号在不停重连）。
 * 所以时间线做成"单人进出 + 两人突发"混合，名字有复用 ——
 * 复用正是对复读拦截的真实压力。
 *
 * 另外补 3 段"走到旁边 / 并肩站"（#14 的两个触发源）。
 */
function buildTimeline (seed) {
  const rnd = mulberry32(seed * 7919 + 13)
  const total = MINUTES * 60 * 1000
  const acts = []
  let t = 3000
  let nameIdx = 0
  let nameEvents = 0

  // 27 次"进来" + 27 次"出去" = 54 次上下线，分 6 波（测试号批量重连）。
  // 原日志就是这样：TMGepccj4 / XJJ_E2E6o5d 这类名字一次进来好几个。
  // 一窝 4~5 个、间隔 1~3 秒 —— 队列上限 6 的老实现在这里直接丢。
  let joins = 0
  let wave = 0
  while (joins < 27 && t < total - 120000) {
    const burst = Math.min(27 - joins, 4 + (wave % 2))
    const batch = []
    for (let i = 0; i < burst; i++) {
      const name = NAME_POOL[nameIdx % NAME_POOL.length]
      nameIdx++
      joins++
      nameEvents++
      const at = t + i * (800 + Math.floor(rnd() * 2200))
      batch.push(name)
      acts.push({ t: at, type: 'join', name })
    }
    for (const name of batch) {
      const leaveAt = t + 30000 + Math.floor(rnd() * 120000)
      acts.push({ t: Math.min(leaveAt, total - 5000), type: 'leave', name })
    }
    wave++
    t += 90000 + Math.floor(rnd() * 70000)   // 每波间隔 1.5~2.7 分钟
  }

  // #14：3 段"有人走到旁边，站 12~20 秒"
  const prox = []
  for (let i = 0; i < 3; i++) {
    const at = Math.floor(total * (0.15 + i * 0.28))
    const name = NAME_POOL[(i + 2) % NAME_POOL.length]
    prox.push({ at, name, holdMs: 12000 + Math.floor(rnd() * 8000) })
  }

  // "对事"的事件：不补这些，分布指标就只剩"对人"，看不出配比。
  // 数量按原日志的量级：25 分钟里 8 次左右的收获/完工 + 3 次倒霉。
  for (let i = 0; i < 8; i++) {
    acts.push({
      t: 20000 + Math.floor(rnd() * (total - 60000)),
      type: 'thing',
      kind: i % 3 === 0 ? 'goal' : (i % 3 === 1 ? 'find' : 'terrain')
    })
  }
  for (let i = 0; i < 3; i++) {
    acts.push({
      t: 40000 + Math.floor(rnd() * (total - 90000)),
      type: 'complain'
    })
  }

  acts.sort((a, b) => a.t - b.t)
  return { acts, prox, joinEvents: nameEvents }
}

// ==================================================================
// 桩：假 bot / 假 LLM
// ==================================================================

/** 位置对象（只需要 distanceTo） */
function V (x, y, z) {
  return {
    x, y, z,
    distanceTo (o) { return Math.sqrt((x - o.x) ** 2 + (y - o.y) ** 2 + (z - o.z) ** 2) }
  }
}

/**
 * 忙着干活的占空比：90 秒为一个块，前 63 秒忙（70%），后 27 秒空闲。
 * 与实测吻合：25 分钟里任务一个接一个，空闲只有零头。
 */
function busyAt (t, seed) {
  const rnd = mulberry32(seed * 31 + Math.floor(t / 90000))
  const blockStart = Math.floor(t / 90000) * 90000
  const duty = 50 + Math.floor(rnd() * 40)   // 50%~89%
  return (t - blockStart) < 90000 * duty / 100
}

function makeBot () {
  const chats = []
  const bot = {
    username: 'XJJ',
    entity: { position: V(100, 64, 100) },
    players: {},
    health: 20,
    food: 20,
    time: { timeOfDay: 6000 },
    inventory: { items: () => [] },
    heldItem: null,
    chat: (text) => { chats.push({ t: NOW, text }) },
    chats
  }
  return bot
}

/**
 * 假的"模型"。
 *
 * 它永远给出**一句像样的短话**，不模拟 [不说] —— 也就是说
 * 离线跑出来的数字是"决策管线放行次数"的上界，
 * 真机端到端（模型自己也会拒说）另行实测。
 *
 * 同一类情境准备了 8 种说法轮着用：真模型本来也不会字字相同，
 * 但"轮一圈又说回同一句"时，talk.say() 的复读拦截会真的拦下来 ——
 * 那正是我们要看的刷屏指标。
 */
function makeLLM () {
  const pool = {
    joinFamiliar: ['哟，你来了', '来了啊', '又见面了', '你怎么又上来了', '在呢', '来啦', '等你半天了', '嘿'],
    join: ['有人来了', '来人了', '谁啊', '哟', '有人进来了', '新人？', '来客人了', '看到了'],
    leave: ['走了', '这就下了', '人没了', '走了啊', '怎么走了', '下线了', '哎'],
    nearby: ['你也在这', '哟，路过啊', '在干嘛呢', '这么巧', '出来转转', '这附近有啥', '你也在啊', '看到了'],
    linger: ['站这儿干嘛', '要一起走吗', '你在等什么', '走不走', '要不一起去挖', '忙啥呢', '说话啊', '杵这儿干啥'],
    thing: ['挖到好东西了', '这地方不错', '总算弄完了', '有点收获', '可以', '还行', '这下面有货', '继续'],
    complain: ['艹', '又死了', '烦死了', '卡住了', '什么玩意', '服了', '这也能死', '算了']
  }
  const idx = {}
  let n = 0
  return {
    chat: async (msgs) => {
      n++
      const sys = msgs.map(m => String(m.content || '')).join('\n')
      const m = /这件事是：([\s\S]*?)\n\n/.exec(sys + '\n\n')
      const situation = m ? m[1].trim() : ''
      const maxLen = parseInt((/不超过 (\d+) 个字/.exec(sys) || [])[1] || '20', 10)

      let cat = 'thing'
      if (/上线了|来了/.test(situation)) cat = /老熟人/.test(situation) ? 'joinFamiliar' : 'join'
      if (/下线了/.test(situation)) cat = 'leave'
      if (/在你旁边|走到你旁边/.test(situation)) cat = 'nearby'
      if (/一起待了|站了 \d+ 秒|站了\d+ 秒/.test(situation)) cat = 'linger'
      if (/死了|卡住|找不到|差点|走错|失败/.test(situation)) cat = 'complain'

      const arr = pool[cat] || pool.thing
      idx[cat] = (idx[cat] || 0) + 1
      let text = arr[idx[cat] % arr.length]
      // 熟人的招呼要带名字才像人（模型会照做）
      const nm = (situation.match(/([A-Za-z_][A-Za-z0-9_]{2,15})/) || [])[1]
      if ((cat === 'joinFamiliar') && nm && idx[cat] % 3 === 0) text = nm + ' 来啦'
      if (text.length > maxLen) text = text.slice(0, maxLen)
      return { text }
    }
  }
}

// ==================================================================
// 一轮重放
// ==================================================================

function loadImpl (impl) {
  if (impl === 'old') {
    const p = '/tmp/spont-old/src/spontaneous.js'
    if (!fs.existsSync(p)) throw new Error('旧代码不存在：先 git worktree add --detach /tmp/spont-old 4dc6627')
    return require(p)
  }
  return require(path.join(ROOT, 'src/spontaneous.js'))
}

async function runOnce (impl, seed) {
  installVirtualTime(seed)

  const sp = loadImpl(impl)
  const Talk = require(path.join(ROOT, 'src/talk.js'))
  const Memory = require(path.join(ROOT, 'src/memory/index.js'))

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-'))
  const mem = new Memory(tmp)
  // 记忆里放一个熟人（打过 6 次交道），用来验证"熟人喊名字"这条修法真的接线了
  const FAMILIAR = 'TMGhuan'
  mem.people[FAMILIAR] = { name: FAMILIAR, talkCount: 6, meetCount: 6, firstSeen: 0, lastSeen: 0 }

  const bot = makeBot()
  const said = []
  const logs = []

  const ctx = {
    log: (s) => logs.push({ t: NOW, s }),
    cfg: {
      behavior: {
        chatDelayPerChar: 0,
        chatMinDelay: 0,
        chatMaxDelay: 0,
        botNames: ['XJJ1', 'XJJ2', 'XJJ3', 'XJJ4', 'XJJ5'],
        idleThinkSeconds: 60
      }
    },
    // 真机 25 分钟基本一直在跑任务（UNHUMAN-SCAN 里 482 次"走不通"就发生在这段）。
    // 旧实现在 busy 时丢掉所有非吐槽事件 —— 这是 #3 的第二个隐形杀手，
    // 所以 A/B 两边用同一条 busy 曲线，才比得出"社交事件该不该豁免 busy"。
    busy: () => busyAt(NOW, seed),
    taskDesc: () => '',
    perceive: { brief: () => '你在矿洞里，附近有石头。' },
    mood: null,
    taste: null,
    botNames: ['XJJ1', 'XJJ2', 'XJJ3', 'XJJ4', 'XJJ5'],
    dataDir: tmp
  }

  const talk = new Talk(bot, makeLLM(), mem, ctx)

  // 记录每次 speak 的结局（不论说没说），并按"情境"归类
  const origSpeak = talk.speak.bind(talk)
  let lastChatCount = 0
  talk.speak = async (situation, opts) => {
    const ok = await origSpeak(situation, opts)
    const newChats = bot.chats.slice(lastChatCount)
    lastChatCount = bot.chats.length
    if (ok) {
      said.push({
        t: NOW,
        situation: String(situation).slice(0, 60),
        text: newChats.length ? newChats[newChats.length - 1].text : '',
        person: /上线了|下线了|在你旁边|走到你旁边|一起待了|站了 \d+ 秒|快死了/.test(situation)
      })
    }
    return ok
  }

  const spont = new sp.Spontaneity(ctx)
  const { acts, prox, joinEvents } = buildTimeline(seed)

  // 事件指针
  let ai = 0
  const end = MINUTES * 60 * 1000

  for (let t = 0; t <= end; t += TICK_MS) {
    NOW = t

    // 1. 到点的事件
    while (ai < acts.length && acts[ai].t <= t) {
      const a = acts[ai++]
      if (a.type === 'join') {
        bot.players[a.name] = { username: a.name, entity: { position: V(100 + 20, 64, 100 + 20) } }
        spont.push(sp.onPlayerJoin(a.name))
      } else if (a.type === 'leave') {
        delete bot.players[a.name]
        spont.push(sp.onPlayerLeave(a.name))
      } else if (a.type === 'thing') {
        const ev = a.kind === 'goal'
          ? sp.onGoalDone('下去挖一层', '')
          : (a.kind === 'find'
              ? sp.onValuableFind('diamond', 1)
              : sp.onNewTerrain('溶洞'))
        if (ev) spont.push(ev)
      } else if (a.type === 'complain') {
        const ev = sp.onComplain('stuck', '前面是墙')
        if (ev) spont.push(ev)
      }
    }

    // 2. #14 的靠近 / 并肩站：实体在 6 格内出现并停留
    for (const p of prox) {
      const inside = t >= p.at && t < p.at + p.holdMs
      if (inside) {
        bot.players[p.name] = bot.players[p.name] || { username: p.name }
        bot.players[p.name].entity = { position: V(100 + 4, 64, 100 + 4) }   // ≈5.6 格
      } else if (bot.players[p.name] && bot.players[p.name].entity) {
        bot.players[p.name].entity.position = V(100 + 60, 64, 100 + 60)      // 走远
      }
    }

    // 3. 主循环（实测 4 秒一轮）
    await spont.tick(talk)
  }

  restoreRealTime()

  const stats = spont.stats || null
  return { impl, seed, said, logs, stats, joinEvents, totalActs: acts.length, bot }
}

// ==================================================================
// 指标
// ==================================================================

function metrics (r) {
  const said = r.said
  const person = said.filter(s => s.person)
  const thing = said.filter(s => !s.person)

  // 上下线招呼：情境里带"上线了/下线了/陆续上线"
  const joinGreet = said.filter(s => /上线了|陆续上线/.test(s.situation))
  const leaveBye = said.filter(s => /下线了/.test(s.situation))

  // 覆盖到几个玩家：合并成一句时，句子数 ≠ 覆盖人数
  let covered = 0
  for (const s of said) {
    const names = new Set(NAME_POOL.filter(n => s.situation.includes(n)))
    covered += Math.max(1, names.size)
  }
  const joinCovered = (() => {
    let c = 0
    for (const s of joinGreet) {
      const names = new Set(NAME_POOL.filter(n => s.situation.includes(n)))
      c += Math.max(1, names.size)
    }
    return c
  })()

  // 刷屏：任意 60 秒窗口内最多几句；任意 10 分钟内最多几句
  const ts = said.map(s => s.t).sort((a, b) => a - b)
  let max60 = 0
  let max600 = 0
  for (let i = 0; i < ts.length; i++) {
    let c60 = 0
    let c600 = 0
    for (let j = i; j < ts.length; j++) {
      if (ts[j] - ts[i] < 60000) c60++
      if (ts[j] - ts[i] < 600000) c600++
    }
    max60 = Math.max(max60, c60)
    max600 = Math.max(max600, c600)
  }

  // 复读：完全相同的句子出现几次
  const freq = {}
  for (const s of said) freq[s.text] = (freq[s.text] || 0) + 1
  const dupLines = Object.entries(freq).filter(([, n]) => n > 1)
  const dupExtra = dupLines.reduce((a, [, n]) => a + (n - 1), 0)

  return {
    total: said.length,
    person: person.length,
    thing: thing.length,
    joinGreet: joinGreet.length,
    joinCovered,
    covered,
    leaveBye: leaveBye.length,
    max60,
    max600,
    dupLines: dupLines.length,
    dupExtra,
    stats: r.stats
  }
}

function agg (runs) {
  const pick = (k) => runs.map(r => r[k]).sort((a, b) => a - b)
  const med = (arr) => arr.length ? arr[Math.floor(arr.length / 2)] : 0
  const out = {}
  for (const k of ['total', 'person', 'thing', 'joinGreet', 'joinCovered', 'leaveBye', 'max60', 'max600', 'dupLines', 'dupExtra']) {
    const a = pick(k)
    out[k] = { min: a[0], med: med(a), max: a[a.length - 1], mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) }
  }
  return out
}

// ==================================================================
// 主
// ==================================================================
async function main () {
  const impls = IMPL === 'both' ? ['old', 'new'] : [IMPL]
  const results = {}

  for (const impl of impls) {
    const runs = []
    for (let s = 1; s <= SEEDS; s++) {
      const r = await runOnce(impl, s)
      runs.push(metrics(r))
    }
    results[impl] = { runs, agg: agg(runs) }

    console.log(`\n================ ${impl === 'old' ? '改前（4dc6627）' : '改后（当前工作区）'} ================`)
    console.log(`种子 ${SEEDS} 轮，每轮 ${MINUTES} 分钟，上下线事件 ${runs[0] ? 54 : 0} 次`)
    console.log('\n-- 每一轮原始数字（按种子顺序）--')
    console.log('seed  总句数  对人  对事  上线招呼  覆盖玩家  下线招呼  最大60s  最大10min  重复句')
    runs.forEach((m, i) => {
      console.log(
        String(i + 1).padStart(4) +
        String(m.total).padStart(7) +
        String(m.person).padStart(6) +
        String(m.thing).padStart(6) +
        String(m.joinGreet).padStart(9) +
        String(m.joinCovered).padStart(9) +
        String(m.leaveBye).padStart(9) +
        String(m.max60).padStart(9) +
        String(m.max600).padStart(10) +
        String(m.dupLines).padStart(8)
      )
    })
    const a = results[impl].agg
    console.log('\n-- 汇总（min / 中位 / max / 均值）--')
    for (const k of Object.keys(a)) {
      console.log(`  ${k.padEnd(10)} ${String(a[k].min).padStart(4)} / ${String(a[k].med).padStart(4)} / ${String(a[k].max).padStart(4)} / ${a[k].mean}`)
    }
  }

  if (impls.length === 2) {
    const o = results.old.agg
    const n = results.new.agg
    console.log('\n================ 对照 ================')
    console.log(`上线招呼句数：改前 ${o.joinGreet.med} / 改后 ${n.joinGreet.med}（中位）`)
    console.log(`上线招呼覆盖玩家：改前 ${o.joinCovered.med} / 改后 ${n.joinCovered.med}（中位，共 27 次上线）`)
    console.log(`对人的句子：改前 ${o.person.med} / 改后 ${n.person.med}（中位）`)
    console.log(`对事的句子：改前 ${o.thing.med} / 改后 ${n.thing.med}（中位）`)
    console.log(`单分钟最多：改前 ${o.max60.max} 句 / 改后 ${n.max60.max} 句（各轮最大值）`)
    console.log(`10 分钟最多：改前 ${o.max600.max} 句 / 改后 ${n.max600.max} 句（各轮最大值）`)
    console.log(`重复句种类：改前 ${o.dupLines.med} / 改后 ${n.dupLines.med}（中位）`)
  }
}

main().then(() => process.exit(0)).catch(e => {
  restoreRealTime()
  console.error('崩了：' + (e && e.stack || e))
  process.exit(1)
})
