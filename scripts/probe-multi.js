'use strict'
/**
 * 多实例共存探针 —— 起两个 AI，同一个服务器，独立账号 + 独立数据目录。
 *
 * 验五件事（跟 docs/MULTI-AGENT.md 的编号对齐）：
 *   1. 互相认不认得出来（人物档案里有没有对方、说话当人还是当自己）
 *   2. 资源冲突（是不是奔同一片树/同一块矿）
 *   3. 对话错乱（会不会互相接话接到停不下来 / 把对方的话记成自己的）
 *   4. 记忆混淆（A 的 memory.json 里会不会有 B 的事迹）
 *   5. 动作冲突（挖同一块方块时的报错）
 *
 * 用法：
 *   node scripts/probe-multi.js                 # 共存观察（默认 5 分钟，起两个 main.js）
 *   node scripts/probe-multi.js --minutes 8     # 共存观察，8 分钟
 *   node scripts/probe-multi.js --conflicts     # 定向冲突（两个裸 mineflayer，同一格/同一箱子/同一工作台/床）
 *
 * 产出：
 *   data/probe-multi/<TAG>/A/{run.log,memory.json,goals.json,...}
 *   data/probe-multi/<TAG>/result.json
 *
 * 注意：账号名带时间戳，避免 duplicate_login 静默踢人；跑完只杀自己起的进程。
 */

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const BASE_CONFIG = path.join(ROOT, process.env.AIFRIEND_CONFIG || 'config.json')

function arg (name, def) {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return def
  const v = process.argv[i + 1]
  return v == null ? true : v
}

const MINUTES = Math.max(1, Number(arg('minutes', 5)) || 5)
const TAG = Date.now().toString(36).slice(-6)
// MC 用户名上限 16 字符：XJJ_MA + 6 = 12
const NAMES = { A: 'XJJ_MA' + TAG, B: 'XJJ_MB' + TAG }
const OUT = path.join(ROOT, 'data', 'probe-multi', TAG)

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function ensure (p) { fs.mkdirSync(p, { recursive: true }) }
function readJSON (p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null }
}
function readText (p) {
  try { return fs.readFileSync(p, 'utf8') } catch (e) { return '' }
}

/** 每个实例一份 config：同一台服务器，只换名字 */
function makeConfig (who) {
  const cfg = JSON.parse(fs.readFileSync(BASE_CONFIG, 'utf8'))
  cfg.bot = Object.assign({}, cfg.bot, { username: NAMES[who] })
  // 探针期间两个 bot 都要"爱说话"一点，否则 5 分钟里可能一次都不互动
  const dir = path.join(OUT, who)
  ensure(dir)
  const f = path.join(dir, 'config.json')
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2))
  return f
}

function start (who) {
  const dir = path.join(OUT, who)
  const cfgPath = makeConfig(who)
  const logFile = path.join(dir, 'run.log')
  const fd = fs.openSync(logFile, 'a')
  const env = Object.assign({}, process.env, {
    AIFRIEND_CONFIG: path.relative(ROOT, cfgPath),
    AIFRIEND_DATA: path.relative(ROOT, dir)
  })
  const child = spawn(process.execPath, ['main.js'], { cwd: ROOT, env, stdio: ['ignore', fd, fd] })
  child.__who = who
  child.__logFile = logFile
  child.__dir = dir
  return child
}

// ---------------------------------------------------------------- 分析

const ERROR_RE = /block is not diggable|cannot dig|dig err|dig.*出错|Kicked|duplicate_login|already connected|AssertionError|Invalid itemType/i

function analyse (who, otherName) {
  const dir = path.join(OUT, who)
  const log = readText(path.join(dir, 'run.log'))
  const mem = readJSON(path.join(dir, 'memory.json')) || {}
  const goals = readJSON(path.join(dir, 'goals.json')) || {}

  const people = Object.keys(mem.people || {})
  const entries = Array.isArray(mem.entries) ? mem.entries : []
  const aboutOther = entries.filter(e => {
    const s = JSON.stringify(e)
    return otherName && s.includes(otherName)
  })
  const journal = Array.isArray(mem.journal) ? mem.journal : []

  const chat = log.split('\n').filter(l => /\[chat\]|\[say\]|\[chain\]|\[spont\]/.test(l))
  const chatTalkingTo = chat.filter(l => otherName && l.includes(otherName))

  const errors = log.split('\n').filter(l => ERROR_RE.test(l)).slice(-10)

  const pos = []
  const re = /\[hb\]\s+(-?\d+),(-?\d+),(-?\d+)/g
  let m
  while ((m = re.exec(log))) pos.push({ x: +m[1], y: +m[2], z: +m[3] })
  const box = pos.length
    ? {
        n: pos.length,
        x: [Math.min(...pos.map(p => p.x)), Math.max(...pos.map(p => p.x))],
        z: [Math.min(...pos.map(p => p.z)), Math.max(...pos.map(p => p.z))],
        first: pos[0],
        last: pos[pos.length - 1]
      }
    : null

  return {
    who,
    name: NAMES[who],
    people,
    remembersOther: !!otherName && people.includes(otherName),
    entriesAboutOther: aboutOther.length,
    entriesAboutOtherSample: aboutOther.slice(-3).map(e => e.text),
    journalAboutOther: journal.filter(j => otherName && String(j.text).includes(otherName)).length,
    goal: goals.goal ? goals.goal.title : null,
    goalHistory: (goals.history || []).slice(-4).map(h => `${h.result}:${h.title}`),
    chatLines: chat.slice(-25),
    chatMentionsOther: chatTalkingTo.slice(-12),
    errors,
    pos: box
  }
}

/** 两个实例的活动范围有多近（同片资源 = 会抢） */
function overlap (a, b) {
  if (!a || !b) return null
  const gapX = Math.max(0, Math.max(a.x[0], b.x[0]) - Math.min(a.x[1], b.x[1]))
  const gapZ = Math.max(0, Math.max(a.z[0], b.z[0]) - Math.min(a.z[1], b.z[1]))
  return {
    boxGap: { x: gapX, z: gapZ },
    sameChunkArea: gapX < 32 && gapZ < 32
  }
}


// ================================================================
// 定向冲突模式（--conflicts）
//
// 为什么用裸 mineflayer 而不是两个 main.js：
//   AI 的"挖/开箱子"最后都落到 mineflayer 的 dig/openBlock 上，冲突就发生这一层。
//   用裸连接可以把两个动作卡在同一毫秒，AI 循环做不到这种精度。
//   代价：测不到 actions.js 自己的兜底文案（比如「方块没了」），那部分用代码定位说明。
// ================================================================

function loadBaseConfig () {
  return JSON.parse(fs.readFileSync(BASE_CONFIG, 'utf8'))
}

function timeout (p, ms, onTimeout) {
  let t
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((resolve, reject) => {
      t = setTimeout(() => {
        try { onTimeout && onTimeout() } catch (e) {}
        reject(new Error('timeout-' + ms + 'ms'))
      }, ms)
    })
  ])
}

async function makeBot (cfg, username, log) {
  const mineflayer = require(path.join(ROOT, 'node_modules', 'mineflayer'))
  const bot = mineflayer.createBot({
    host: cfg.bot.host,
    port: cfg.bot.port,
    username,
    auth: 'offline',
    version: cfg.bot.version
  })
  bot.on('error', e => log(`[${username}] error ${e.message}`))
  bot.on('kicked', r => log(`[${username}] kicked ${JSON.stringify(r)}`))
  bot.on('death', () => log(`[${username}] 死了`))
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('spawn timeout')), 30000)
    bot.once('spawn', () => { clearTimeout(to); resolve() })
    bot.once('kicked', (r) => { clearTimeout(to); reject(new Error('kicked ' + JSON.stringify(r))) })
    bot.once('end', (r) => { clearTimeout(to); reject(new Error('连接结束 ' + r)) })
  })
  const { pathfinder, Movements } = require(path.join(ROOT, 'node_modules', 'mineflayer-pathfinder'))
  bot.loadPlugin(pathfinder)
  const moves = new Movements(bot)
  bot.pathfinder.setMovements(moves)
  return bot
}

const pf = require(path.join(ROOT, 'node_modules', 'mineflayer-pathfinder'))
const { GoalBlock, GoalNear } = pf.goals

const SOLID = new Set(['dirt', 'grass_block', 'stone', 'andesite', 'diorite', 'granite', 'sand', 'gravel', 'cobblestone', 'deepslate', 'tuff', 'oak_log', 'birch_log', 'spruce_log'])

/** 服务器对同 IP 有连接限流：被踢就等 20 秒重试 */
async function connectWithRetry (cfg, username, log, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try { return await makeBot(cfg, username, log) } catch (e) {
      log(`[${username}] 连接失败（${e.message}），20 秒后重试 ${i}/${tries}`)
      await sleep(20000)
    }
  }
  throw new Error('连不上服务器（可能被限流）')
}

async function runConflicts () {
  const cfg = loadBaseConfig()
  const tag = Date.now().toString(36).slice(-6)
  const NAMES = { A: 'XJJ_CA' + tag, B: 'XJJ_CB' + tag }
  const outDir = path.join(ROOT, 'data', 'probe-multi', 'conflicts-' + tag)
  ensure(outDir)
  const log = (s) => console.log('[conflicts] ' + s)
  console.log(`[conflicts] 账号 ${NAMES.A} / ${NAMES.B}   输出 ${path.relative(ROOT, outDir)}`)

  const result = { at: new Date().toISOString(), tag, names: NAMES, scenarios: [], limits: [] }
  let A = null
  let B = null
  try {
    A = await connectWithRetry(cfg, NAMES.A, log)
    B = await connectWithRetry(cfg, NAMES.B, log)
    log('两个连接都进来了')

    // 聚到同一点：以 A 的位置为目标，B 走过去
    const p = A.entity.position
    const spot = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
    try {
      await timeout(B.pathfinder.goto(new GoalBlock(spot.x, spot.y, spot.z)), 60000, () => { try { B.pathfinder.stop() } catch (e) {} })
    } catch (e) {
      result.limits.push('B 没能走到 A 身边（' + e.message + '），同格测试改为各自身边最近方块')
    }

    // ---- 场景 1：同时挖同一块 ----
    {
      const sc = { name: '同挖一格', target: null, results: [], hang: false, conclusion: '' }
      let block = null
      try {
        block = A.findBlock({ matching: (b) => SOLID.has(b.name), maxDistance: 4 })
      } catch (e) {}
      if (!block) {
        sc.conclusion = 'skip：身边 4 格内没有可挖的方块'
      } else {
        sc.target = { name: block.name, x: block.position.x, y: block.position.y, z: block.position.z }
        const count = (bot) => {
          try { return bot.inventory.items().filter(x => /dirt|grass_block|cobblestone|stone|andesite|diorite|granite|sand|gravel|log/.test(x.name)).reduce((s, x) => s + x.count, 0) } catch (e) { return 0 }
        }
        const inv0 = { A: count(A), B: count(B) }
        const t0 = Date.now()
        const dig = (bot, who) => timeout(bot.dig(block), 10000, () => { try { bot.stopDigging() } catch (e) {} })
          .then(() => ({ who, ok: true, ms: Date.now() - t0 }))
          .catch(e => ({ who, ok: false, err: e.message, ms: Date.now() - t0 }))
        const rs = await Promise.all([dig(A, 'A'), dig(B, 'B')])
        await sleep(2000) // 等掉落物被捡
        const final = A.blockAt(block.position)
        const inv1 = { A: count(A), B: count(B) }
        sc.results = rs
        sc.final = { block: final ? final.name : 'unknown', gone: !final || final.name === 'air' }
        sc.gained = { A: inv1.A - inv0.A, B: inv1.B - inv0.B }
        sc.hang = rs.some(r => /timeout/.test(r.err || ''))
        const winners = rs.filter(r => r.ok)
        sc.conclusion = (winners.length === 2
          ? '两人都报成功（mineflayer 的 dig 在"方块变空气"时就 resolve，不看是谁挖的）'
          : winners.length === 1
            ? `只有一个成功（${winners[0].who}），另一个拿到：${rs.find(r => !r.ok).err}`
            : '两人都失败：' + rs.map(r => r.err).join(' / ')) +
          `｜方块最终：${sc.final.block}｜到手：A+${sc.gained.A} B+${sc.gained.B}`
        log(`[1] 同挖一格 ${block.name}@${block.position.x},${block.position.y},${block.position.z} → ${sc.conclusion}`)
      }
      result.scenarios.push(sc)
    }

    // ---- 场景 2：同时开同一个容器/工作台 ----
    {
      const sc = { name: '同开一个容器', target: null, results: [], hang: false, conclusion: '' }
      const match = (b) => /chest|barrel|crafting_table|furnace/.test(b.name)
      let box = null
      try { box = A.findBlock({ matching: match, maxDistance: 24 }) } catch (e) {}
      if (!box) {
        sc.conclusion = 'skip：24 格内没有箱子/工作台/熔炉'
      } else {
        sc.target = { name: box.name, x: box.position.x, y: box.position.y, z: box.position.z }
        // 够不到就不算冲突：两个人先各自走到容器旁边
        const approach = async (bot, who) => {
          const d = bot.entity.position.distanceTo(box.position)
          if (d <= 3) return true
          try {
            await timeout(bot.pathfinder.goto(new GoalNear(box.position.x, box.position.y, box.position.z, 2)), 45000, () => { try { bot.pathfinder.stop() } catch (e) {} })
            return true
          } catch (e) {
            sc.results.push({ who, ok: false, err: '走不过去：' + e.message })
            return false
          }
        }
        const nearA = await approach(A, 'A')
        const nearB = await approach(B, 'B')
        if (!nearA || !nearB) {
          sc.conclusion = 'skip：有人走不到容器旁边（不是冲突）'
          log('[2] skip：走不到 ' + box.name)
        } else {
          const t0 = Date.now()
          const open = (bot, who) => timeout(bot.openBlock(box), 10000, () => { try { bot.closeWindow(bot.currentWindow) } catch (e) {} })
            .then(w => ({ who, ok: true, ms: Date.now() - t0, window: w && w.type }))
            .catch(e => ({ who, ok: false, err: e.message, ms: Date.now() - t0 }))
          const rs = await Promise.all([open(A, 'A'), open(B, 'B')])
          sc.results = sc.results.concat(rs)
          sc.hang = rs.some(r => /timeout/.test(r.err || ''))
          const wins = rs.filter(r => r.ok)
          sc.conclusion = wins.length === 2
            ? '两人同时打开了（各自一个窗口，服务端允许）'
            : wins.length === 1
              ? `只有一个打开成功（${wins[0].who}），另一个：${rs.find(r => !r.ok).err}`
              : '都失败：' + rs.map(r => r.err).join(' / ')
          log(`[2] 同开一个 ${box.name} → ${sc.conclusion}`)
          for (const bot of [A, B]) { try { bot.closeWindow(bot.currentWindow) } catch (e) {} }
        }
      }
      result.scenarios.push(sc)
    }

    // ---- 场景 3：同放一个方块位置 ----
    {
      const sc = { name: '同放一格', target: null, results: [], hang: false, conclusion: '' }
      const item = (bot) => {
        try { return bot.inventory.items().find(x => /dirt|cobblestone|stone|planks|sand|gravel/.test(x.name)) } catch (e) { return null }
      }
      // 先各挖一块，凑出可放置的东西（仍然各自独立，不算冲突）
      const ensureItem = async (bot) => {
        if (item(bot)) return true
        let b = null
        try { b = bot.findBlock({ matching: (x) => SOLID.has(x.name), maxDistance: 4 }) } catch (e) {}
        if (!b) return false
        try { await timeout(bot.dig(b), 8000, () => { try { bot.stopDigging() } catch (e) {} }) } catch (e) {}
        await sleep(600)
        return !!item(bot)
      }
      if (!item(A)) await ensureItem(A)
      if (!item(B)) await ensureItem(B)
      const ia = item(A)
      const ib = item(B)
      if (!ia || !ib) {
        sc.conclusion = `skip：两人身上没有可放方块的料（A=${ia && ia.name} B=${ib && ib.name}）`
      } else {
        // 放脚边上方一格：站在同一片地上，往同一个空气位放
        const base = A.entity.position
        const refPos = { x: Math.floor(base.x) + 2, y: Math.floor(base.y) - 1, z: Math.floor(base.z) }
        try {
          const ref = A.blockAt(new (require(path.join(ROOT, 'node_modules', 'vec3')))(refPos.x, refPos.y, refPos.z))
          sc.target = { name: ref.name, x: refPos.x, y: refPos.y, z: refPos.z }
          const face = new (require(path.join(ROOT, 'node_modules', 'vec3')))(0, 1, 0)
          const place = (bot, who, it) => timeout((async () => {
            await bot.equip(it, 'hand')
            return bot.placeBlock(ref, face)
          })(), 8000, () => {}).then(() => ({ who, ok: true })).catch(e => ({ who, ok: false, err: e.message }))
          const rs = await Promise.all([place(A, 'A', ia), place(B, 'B', ib)])
          sc.results = rs
          sc.hang = rs.some(r => /timeout/.test(r.err || ''))
          const wins = rs.filter(r => r.ok)
          sc.conclusion = wins.length === 2 ? '两人都报成功（可能分别落在不同面）'
            : wins.length === 1 ? `只有一个放成功（${wins[0].who}），另一个：${rs.find(r => !r.ok).err}`
              : '都失败：' + rs.map(r => r.err).join(' / ')
          log(`[3] 同放一格 → ${sc.conclusion}`)
        } catch (e) {
          sc.conclusion = 'skip：' + e.message
        }
      }
      result.scenarios.push(sc)
    }

    // ---- 场景 4：一个睡觉另一个挖 ----
    {
      const sc = { name: '睡觉 vs 挖', target: null, results: [], hang: false, conclusion: '' }
      let bed = null
      try { bed = A.findBlock({ matching: (b) => /_bed$/.test(b.name), maxDistance: 32 }) } catch (e) {}
      if (!bed) {
        sc.conclusion = 'skip：32 格内没有床'
      } else {
        sc.target = { name: bed.name, x: bed.position.x, y: bed.position.y, z: bed.position.z }
        // 够不到就不是冲突
        if (A.entity.position.distanceTo(bed.position) > 3) {
          try {
            await timeout(A.pathfinder.goto(new GoalNear(bed.position.x, bed.position.y, bed.position.z, 1)), 45000, () => { try { A.pathfinder.stop() } catch (e) {} })
          } catch (e2) {
            sc.conclusion = 'skip：走不到床边（' + e2.message + '）'
            bed = null
          }
        }
        if (!bed) { /* 已记 skip */ } else {
        const t0 = Date.now()
        const sleepP = timeout(A.sleep(bed), 12000, () => { try { A.wake() } catch (e) {} })
          .then(() => ({ who: 'A', ok: true, ms: Date.now() - t0 }))
          .catch(e => ({ who: 'A', ok: false, err: e.message, ms: Date.now() - t0 }))
        const digBlock = A.findBlock({ matching: (b) => SOLID.has(b.name), maxDistance: 3 })
        const digP = digBlock
          ? timeout(B.dig(digBlock), 12000, () => { try { B.stopDigging() } catch (e) {} })
            .then(() => ({ who: 'B', ok: true, ms: Date.now() - t0 }))
            .catch(e => ({ who: 'B', ok: false, err: e.message, ms: Date.now() - t0 }))
          : Promise.resolve({ who: 'B', ok: false, err: 'no-target', ms: 0 })
        const rs = await Promise.all([sleepP, digP])
        sc.results = rs
        sc.hang = rs.some(r => /timeout/.test(r.err || ''))
        sc.conclusion = 'sleep:' + (rs[0].ok ? '成功' : rs[0].err) + ' / dig:' + (rs[1].ok ? '成功' : rs[1].err)
        log(`[4] 睡觉 vs 挖 → ${sc.conclusion}`)
        }
      }
      result.scenarios.push(sc)
    }
  } catch (e) {
    result.error = e.message
    log('中断：' + e.message)
  } finally {
    for (const b of [A, B]) { try { b && b.quit() } catch (e) {} }
    fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2))
    console.log('\n======== 定向冲突 ========')
    for (const sc of result.scenarios) {
      console.log(`[${sc.name}] ${sc.conclusion}`)
      for (const r of sc.results) console.log(`   ${r.who}: ${r.ok ? '成功' : '失败 ' + r.err}${r.ms != null ? ' ' + r.ms + 'ms' : ''}`)
      if (sc.hang) console.log('   ⚠ 有调用卡住（10s 超时）')
    }
    for (const l of result.limits) console.log('限制：' + l)
    console.log('结果：' + path.relative(ROOT, path.join(outDir, 'result.json')))
  }
}

// ---------------------------------------------------------------- 主流程

function main () {
  if (process.argv.includes('--conflicts')) return runConflicts()
  ensure(OUT)
  console.log(`[probe-multi] 账号：${NAMES.A} / ${NAMES.B}`)
  console.log(`[probe-multi] 数据：data/probe-multi/${TAG}   时长：${MINUTES} 分钟`)
  console.log('[probe-multi] 注意：这里只杀自己起的两个进程，不动别人的 bot')

  const procs = [start('A'), start('B')]
  const startedAt = Date.now()

  const timer = setInterval(() => {
    const mins = ((Date.now() - startedAt) / 60000).toFixed(1)
    process.stdout.write(`\r[probe-multi] 已跑 ${mins}/${MINUTES} 分钟   `)
  }, 5000)

  const finish = () => {
    clearInterval(timer)
    console.log('\n[probe-multi] 收工，分析中…')
    for (const c of procs) { try { c.kill('SIGTERM') } catch (e) {} }
    setTimeout(() => {
      for (const c of procs) { try { c.kill('SIGKILL') } catch (e) {} }
      const A = analyse('A', NAMES.B)
      const B = analyse('B', NAMES.A)
      const ov = overlap(A.pos, B.pos)
      const sameArea = ov ? ov.sameChunkArea : null
      const result = {
        at: new Date().toISOString(),
        tag: TAG,
        names: NAMES,
        minutes: MINUTES,
        A,
        B,
        overlap: ov,
        sameArea,
        checks: {
          // 1. 互相认得出来：人物档案里有没有对方
          remembersOther: { A: A.remembersOther, B: B.remembersOther },
          // 2. 资源冲突：活动范围是否重叠
          sameArea,
          // 3. 对话：有没有互相接话
          mentionsOther: { A: A.chatMentionsOther.length, B: B.chatMentionsOther.length },
          // 4. 记忆混淆：对方的名字出现在自己记忆里的条数
          crossEntries: { A: A.entriesAboutOther, B: B.entriesAboutOther },
          // 5. 动作冲突：挖同一块之类的报错
          errors: { A: A.errors.length, B: B.errors.length }
        }
      }

      const f = path.join(OUT, 'result.json')
      fs.writeFileSync(f, JSON.stringify(result, null, 2))
      printReport(result)
      console.log(`\n[probe-multi] 结果：${path.relative(ROOT, f)}`)
    }, 3500)
  }

  setTimeout(finish, MINUTES * 60 * 1000)
  process.on('SIGINT', () => { console.log('\n[probe-multi] 手动收工'); finish() })
}

function printReport (r) {
  const line = (s) => console.log('  ' + s)
  console.log('\n======== 多实例共存实测 ========')
  console.log(`账号：${r.names.A} / ${r.names.B}   跑了 ${r.minutes} 分钟`)
  console.log('\n[1] 互相认得出来吗')
  line(`${r.names.A} 的人物档案：${r.A.people.join('、') || '（空）'}`)
  line(`${r.names.B} 的人物档案：${r.B.people.join('、') || '（空）'}`)
  line(`A 记得 B：${r.A.remembersOther}   B 记得 A：${r.B.remembersOther}`)
  if (r.A.entriesAboutOtherSample.length) line('A 记忆里提到 B 的句子：' + r.A.entriesAboutOtherSample.join(' / '))
  if (r.B.entriesAboutOtherSample.length) line('B 记忆里提到 A 的句子：' + r.B.entriesAboutOtherSample.join(' / '))

  console.log('\n[2] 资源冲突（活动范围）')
  const p = (o) => o.pos ? `x ${o.pos.x[0]}..${o.pos.x[1]}  z ${o.pos.z[0]}..${o.pos.z[1]}（${o.pos.n} 次采样）` : '没有位置采样'
  line(`A：${p(r.A)}`)
  line(`B：${p(r.B)}`)
  if (r.overlap) line(`两块活动区最近间距：x ${r.overlap.boxGap.x}  z ${r.overlap.boxGap.z} → 同一片：${r.overlap.sameChunkArea}`)

  console.log('\n[3] 对话')
  line(`A 提到 B 的对话行：${r.A.chatMentionsOther.length}`)
  r.A.chatMentionsOther.slice(0, 4).forEach(l => line('A ' + l.trim()))
  line(`B 提到 A 的对话行：${r.B.chatMentionsOther.length}`)
  r.B.chatMentionsOther.slice(0, 4).forEach(l => line('B ' + l.trim()))

  console.log('\n[4] 记忆混淆')
  line(`A 记忆里出现 B 名字的条目：${r.A.entriesAboutOther}（其中 journal ${r.A.journalAboutOther}）`)
  line(`B 记忆里出现 A 名字的条目：${r.B.entriesAboutOther}（其中 journal ${r.B.journalAboutOther}）`)
  line(`A 自己的目标：${r.A.goal || '（没有）'}`)
  line(`B 自己的目标：${r.B.goal || '（没有）'}`)

  console.log('\n[5] 动作冲突 / 报错')
  line(`A 报错 ${r.A.errors.length} 条，B 报错 ${r.B.errors.length} 条`)
  ;[...r.A.errors, ...r.B.errors].slice(0, 5).forEach(l => line(l.trim()))
  console.log('================================\n')
}

main()
