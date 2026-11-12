#!/usr/bin/env node
'use strict'
/**
 * 端到端测试（探针）：**他现在能做成事吗？成功率多少？**
 *
 * 用法：
 *   node scripts/test-e2e.js                       # 全跑，账号 XJJ_E2E
 *   node scripts/test-e2e.js --only 砍树            # 只跑名字含"砍树"的任务
 *   node scripts/test-e2e.js --account XJJ_E2E2     # 换账号
 *   node scripts/test-e2e.js --verbose              # 把 [act] 日志打到屏幕
 *   node scripts/test-e2e.js --timeout 300          # 全局超时倍率（秒，单任务基准）
 *
 * ------------------------------------------------------------------
 * 为什么要有这个脚本
 * ------------------------------------------------------------------
 * 89 项单元测试全绿，真服务器上失败率 78%。
 * 因为单元测试测的是"函数能不能跑"，不是"能不能做成事"。
 * 这个脚本只认一条：**世界状态 / 背包真的变了**。
 *
 * ------------------------------------------------------------------
 * 双判据（关键设计）
 * ------------------------------------------------------------------
 * 每个任务同时算两个结果：
 *
 *   A. 硬判据  —— 背包数量、方块是否出现在世界里、y 是否回到地面
 *   B. judgeOutcome —— 直接复用 main.js 里的正式判定函数，
 *      把它喂给"模型式的自然语言结论"，看它怎么判
 *
 * 两者不一致 = **口径分歧**：脚本说成了，正式运行会说没成（或反之）。
 * 这类分歧必须单独统计 —— 它就是"假成功"的来源。
 *
 * ------------------------------------------------------------------
 * 铁律（来自 PROJECT_STATE.md 的教训）
 * ------------------------------------------------------------------
 * 1. 必须用独立账号，默认 XJJ_E2E。绝不能用 XJJ，否则跟正式 bot 互踢，
 *    实测会变成"走 1 秒只动 0.21 格"这种假故障。
 * 2. 被踢（duplicate_login）立刻停，不继续产生脏数据。
 * 3. 不改 src/ 和 main.js，只读它们。
 * 4. 全程无人工干预：连上、跑完、落盘、退出。
 */

const path = require('path')
const fs = require('fs')
const { execSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')

// ---- 参数 ----
const argv = process.argv.slice(2)
const argOf = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const hasFlag = (name) => argv.includes('--' + name)

const ACCOUNT = argOf('account', 'XJJ_E2E')
const ONLY = argOf('only', null)
const VERBOSE = hasFlag('verbose')
const TIMEOUT_SCALE = parseFloat(argOf('timeout', '1')) || 1
const TAG = argOf('tag', '')

// 正式 bot 的账号，出现就报警（只报警不阻止 —— 我们用的是另一个号）
const PROD_ACCOUNT = 'XJJ'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const now = () => new Date().toISOString()

// ==================================================================
// 0. 载入被测代码（只读）
// ==================================================================

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))

// judgeOutcome 要实例化 Bot，而 Bot 构造会开 Memory / SkillLibrary / LLM。
// 把数据目录指到测试专用路径，绝不污染正式运行的 data/runtime。
// 注意：必须在 require main.js **之前**设，因为 DATA 在模块顶层就解析了。
process.env.AIFRIEND_DATA = path.join('data', 'test-results', 'e2e-judge-runtime')

const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const mcData = require('minecraft-data')(cfg.bot.version || '1.21.11')
const { Actions } = require(path.join(ROOT, 'src', 'actions'))
const { Bot: JudgeBot } = require(path.join(ROOT, 'main.js'))

// ==================================================================
// 1. 任务定义
// ==================================================================
//
// 顺序按 Lead 给的清单：挖石头、砍树、做木镐、做石镐、放箱子、存东西、
// 找食物、从地下爬出来。
//
// 这个顺序故意"不理想"：第一个任务就没镐子，所以"挖石头"必须自己走完
// 砍树 → 木板 → 木棍 → 木镐 → 挖石 整条链路。
// 这正是我们要测的东西 —— 从零开始，他能不能自己把事做完。
//
// 每个任务：
//   id       内部标识
//   name     中文名
//   goal     喂给 judgeOutcome 的目标描述（用中文物品名，能触发 extractWantedItem）
//   budget   单任务预算（秒，会乘 --timeout 倍率）
//   run()    返回 { ok, detail, kind? }
//              kind 是失败分类，见 FAIL_KINDS
// ==================================================================

const FAIL_KINDS = {
  TIMEOUT: '超时',
  EXCEPTION: '抛异常',
  NO_OUTPUT: '产出为 0',
  PRECONDITION: '前置条件不满足',
  JUDGE_DISAGREE: '口径分歧（脚本成功/正式判定失败）',
  KICKED: '被踢下线',
  UNKNOWN: '未知'
}

const TASKS = [
  // ---------------- 1. 挖石头 ----------------
  {
    id: 'mine_stone',
    name: '挖石头',
    goal: '挖点石头（圆石）',
    budget: 300,
    async run (a, bot, ctx) {
      const cnt = () => a.countOf('cobblestone') + a.countOf('cobbled_deepslate')
      const before = cnt()
      const hadPick = bot.inventory.items().some(i => /_pickaxe$/.test(i.name))

      let ret = null
      let err = null
      try {
        ret = await a.mine('stone', 3, 24)
      } catch (e) { err = e.message }

      await sleep(1200)
      const after = cnt()
      const ok = after > before
      return {
        ok,
        kind: ok ? null : (err ? FAIL_KINDS.EXCEPTION : FAIL_KINDS.NO_OUTPUT),
        detail: `圆石 ${before} -> ${after}（mine 返回 ${JSON.stringify(ret)}` +
          `${hadPick ? '，开局已有镐' : '，开局没镐（要先自己造）'}` +
          `${err ? '，异常: ' + err.slice(0, 60) : ''}）`
      }
    }
  },

  // ---------------- 2. 砍树 ----------------
  {
    id: 'chop_tree',
    name: '砍树',
    goal: '砍树弄点原木',
    budget: 240,
    async run (a, bot, ctx) {
      const before = a.woodCount()
      let ret = null
      let err = null
      try {
        ret = await a.chopTree(1)
      } catch (e) { err = e.message }

      await sleep(1200)
      const after = a.woodCount()
      const ok = after > before
      return {
        ok,
        kind: ok ? null : (err ? FAIL_KINDS.EXCEPTION : FAIL_KINDS.NO_OUTPUT),
        detail: `原木 ${before} -> ${after}（chopTree 返回 ${JSON.stringify(ret)}` +
          `${err ? '，异常: ' + err.slice(0, 60) : ''}）`
      }
    }
  },

  // ---------------- 3. 做木镐 ----------------
  {
    id: 'craft_wood_pick',
    name: '做木镐',
    goal: '做一把木镐',
    budget: 150,
    async run (a, bot, ctx) {
      const before = a.countOf('wooden_pickaxe')
      let err = null
      try {
        await a.craftSmart('wooden_pickaxe', 1)
      } catch (e) { err = e.message }

      await sleep(600)
      const after = a.countOf('wooden_pickaxe')
      // 判据：结束时手上有木镐（之前有也算"能做成"，但要标注是存货）
      const ok = after > 0
      const fresh = after > before
      return {
        ok,
        kind: ok ? null : (err ? FAIL_KINDS.EXCEPTION : FAIL_KINDS.NO_OUTPUT),
        detail: `木镐 ${before} -> ${after}` +
          (fresh ? '（新做出来）' : ok ? '（开局就有存货，没真正走合成链）' : '') +
          (err ? `，异常: ${err.slice(0, 60)}` : '')
      }
    }
  },

  // ---------------- 4. 做石镐 ----------------
  {
    id: 'craft_stone_pick',
    name: '做石镐',
    goal: '做一把石镐',
    budget: 180,
    async run (a, bot, ctx) {
      const before = a.countOf('stone_pickaxe')
      const cob = a.countOf('cobblestone') + a.countOf('cobbled_deepslate')
      const stick = a.countOf('stick')
      let err = null
      try {
        await a.craftSmart('stone_pickaxe', 1)
      } catch (e) { err = e.message }

      await sleep(600)
      const after = a.countOf('stone_pickaxe')
      const ok = after > 0
      return {
        ok,
        kind: ok ? null : (err ? FAIL_KINDS.EXCEPTION : FAIL_KINDS.NO_OUTPUT),
        detail: `石镐 ${before} -> ${after}（材料: 圆石 ${cob} / 木棍 ${stick}）` +
          (err ? `，异常: ${err.slice(0, 60)}` : '')
      }
    }
  },

  // ---------------- 5. 放箱子 ----------------
  {
    id: 'place_chest',
    name: '放箱子',
    goal: '放个箱子',
    budget: 240,
    async run (a, bot, ctx) {
      // 先确保手上有箱子
      if (a.countOf('chest') === 0 && !a.findBlock('chest', 10)) {
        try { await a.craftSmart('chest', 1) } catch (e) {
          ctx.notes.push('做箱子失败: ' + e.message.slice(0, 60))
        }
      }
      if (a.countOf('chest') === 0) {
        const exist = a.findBlock('chest', 10)
        if (exist) {
          ctx.state.chestPos = exist.position
          return { ok: true, detail: `附近已有箱子 @${fmt(exist.position)}（没走放置流程）` }
        }
        return {
          ok: false,
          kind: FAIL_KINDS.PRECONDITION,
          detail: `做不出箱子（木板 ${a.countOf('oak_planks') + a.countOf('birch_planks') + a.countOf('spruce_planks')} 张、原木 ${a.woodCount()} 个）`
        }
      }

      let placed = null
      let err = null
      try {
        placed = await a.placeNearby('chest')
      } catch (e) { err = e.message }

      await sleep(800)
      // 判据：世界里真的有 chest 方块（不是"函数没报错"）
      const inWorld = a.findBlock('chest', 10)
      const target = placed || inWorld
      if (target) ctx.state.chestPos = target.position

      const ok = !!target
      return {
        ok,
        kind: ok ? null : (err ? FAIL_KINDS.EXCEPTION : FAIL_KINDS.NO_OUTPUT),
        detail: ok
          ? `箱子在世界里 @${fmt(target.position)}`
          : `世界10格内没有 chest 方块${err ? '，异常: ' + err.slice(0, 60) : ''}`
      }
    }
  },

  // ---------------- 6. 存东西 ----------------
  {
    id: 'store_items',
    name: '存东西',
    goal: '把东西存进箱子',
    budget: 120,
    async run (a, bot, ctx) {
      const pos = ctx.state.chestPos
      if (!pos) {
        return {
          ok: false,
          kind: FAIL_KINDS.PRECONDITION,
          detail: '没有可用的箱子（上一个任务没放出箱子）'
        }
      }
      const p = { x: pos.x, y: pos.y, z: pos.z }

      // 先看箱子里原本有多少
      let beforeItems = 0
      try {
        const w = await a.openChest(p.x, p.y, p.z)
        beforeItems = w.containerItems().length
        try { w.close() } catch (e) {}
      } catch (e) {
        return { ok: false, kind: FAIL_KINDS.EXCEPTION, detail: '打不开箱子: ' + e.message.slice(0, 60) }
      }

      let moved = false
      let err = null
      try {
        moved = await a.depositAll(p.x, p.y, p.z, [])
      } catch (e) { err = e.message }

      await sleep(800)

      // 判据：箱子里物品格数真的变多
      let afterItems = 0
      try {
        const w = await a.openChest(p.x, p.y, p.z)
        afterItems = w.containerItems().length
        try { w.close() } catch (e) {}
      } catch (e) {}

      const ok = afterItems > beforeItems
      return {
        ok,
        kind: ok ? null : (err ? FAIL_KINDS.EXCEPTION : FAIL_KINDS.NO_OUTPUT),
        detail: `箱内 ${beforeItems} 格 -> ${afterItems} 格（depositAll 返回 ${moved}）` +
          (err ? `，异常: ${err.slice(0, 60)}` : '')
      }
    }
  },

  // ---------------- 7. 找食物 ----------------
  {
    id: 'find_food',
    name: '找食物',
    goal: '弄点吃的',
    budget: 200,
    async run (a, bot, ctx) {
      const foodBefore = Math.round(bot.food)
      const hadFood = a.hasFood()

      let ret = null
      let err = null
      try {
        ret = await a.findFood()
      } catch (e) { err = e.message }

      await sleep(1500)
      const foodAfter = Math.round(bot.food)
      const nowHasFood = a.hasFood()
      const foodCnt = a.foodList().reduce((s, f) => s + f.count, 0)

      // 判据：饱食度上升，或背包里确实有能吃的东西
      const ok = foodAfter > foodBefore || nowHasFood
      return {
        ok,
        kind: ok ? null : (err ? FAIL_KINDS.EXCEPTION : FAIL_KINDS.NO_OUTPUT),
        detail: `饥饿 ${foodBefore} -> ${foodAfter}，背包食物 ${hadFood ? '有' : '无'} -> ` +
          `${nowHasFood ? '有' : '无'}（共 ${foodCnt} 个）` +
          (ret ? `，findFood 返回 ${JSON.stringify(String(ret).slice(0, 40))}` : '，findFood 返回 null') +
          (err ? `，异常: ${err.slice(0, 60)}` : '')
      }
    }
  },

  // ---------------- 8. 从地下爬出来 ----------------
  {
    id: 'escape_underground',
    name: '从地下爬出来',
    goal: '从地下爬回地面',
    budget: 240,
    async run (a, bot, ctx) {
      const startY = Math.round(a.pos().y)
      let dug = 0

      // 如果本来就在地面，先给自己挖个坑 —— 否则这个任务永远是"本来就在地面"的假成功。
      // （历史数据里 5 次跑，5 次都是这么"通过"的，等于没测。）
      if (!a.isUnderground()) {
        for (let i = 0; i < 4; i++) {
          const p = a.pos()
          const below = bot.blockAt(p.offset(0, -1, 0))
          if (!below || /bedrock|lava|water/.test(below.name)) break
          let ok = false
          try { ok = await a.digAt(below) } catch (e) { break }
          if (!ok) break
          dug++
          await sleep(500)
        }
        await sleep(600)
      }

      const undergroundBefore = a.isUnderground()
      const yBefore = Math.round(a.pos().y)

      if (!undergroundBefore) {
        return {
          ok: false,
          kind: FAIL_KINDS.PRECONDITION,
          detail: `造不出地下场景（只挖了 ${dug} 格，仍在露天 y=${yBefore}），任务无法验证`
        }
      }

      let err = null
      try {
        await a.getToSurface(80)
      } catch (e) { err = e.message }

      await sleep(800)
      const out = !a.isUnderground()
      const yAfter = Math.round(a.pos().y)
      return {
        ok: out,
        kind: out ? null : (err ? FAIL_KINDS.EXCEPTION : FAIL_KINDS.NO_OUTPUT),
        detail: `起始 y=${startY}，自挖 ${dug} 格到 y=${yBefore}，结果 y=${yAfter}（上升 ${yAfter - yBefore}）` +
          `${out ? '，已判定在地面' : '，仍判定在地下'}` +
          (err ? `，异常: ${err.slice(0, 60)}` : '')
      }
    }
  }
]

const fmt = (p) => `(${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)})`

// ==================================================================
// 2. 环境自检
// ==================================================================

function checkEnv () {
  const warn = []
  let others = []
  try {
    const out = execSync('ps -eo pid,args 2>/dev/null || ps aux 2>/dev/null', { encoding: 'utf8' })
    others = out.split('\n')
      .filter(l => /node\s+.*main\.js/.test(l) && !/grep/.test(l))
  } catch (e) {}

  if (ACCOUNT === PROD_ACCOUNT) {
    console.error(`\n❌ 账号 ${ACCOUNT} 是正式 bot 的号，禁止使用。换 --account XJJ_E2E\n`)
    process.exit(2)
  }

  if (others.length) {
    warn.push(`检测到 ${others.length} 个 main.js 在跑（正式 bot 或别人的测试）。` +
      `本测试用独立账号 ${ACCOUNT}，不会互踢，但服务器 TPS 会受影响，数据偏慢。`)
  }
  return { warn, others }
}

// ==================================================================
// 3. 主流程
// ==================================================================

async function main () {
  const list = ONLY ? TASKS.filter(t => t.name.includes(ONLY) || t.id.includes(ONLY)) : TASKS
  if (!list.length) {
    console.log('没有匹配的任务。可用：', TASKS.map(t => `${t.name}(${t.id})`).join('、'))
    process.exit(1)
  }

  const env = checkEnv()

  const outDir = path.join(ROOT, 'data', 'test-results')
  fs.mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const runId = `${stamp}${TAG ? '-' + TAG : ''}`

  console.log('\n' + '='.repeat(64))
  console.log('  端到端测试：他现在能做成事吗？')
  console.log('='.repeat(64))
  console.log(`账号      : ${ACCOUNT}`)
  console.log(`服务器    : ${cfg.bot.host}:${cfg.bot.port} (${cfg.bot.version})`)
  console.log(`任务      : ${list.map(t => t.name).join(' → ')}`)
  console.log(`总预算    : ${list.reduce((s, t) => s + t.budget, 0)}s（最坏情况）`)
  console.log(`判据      : 硬判据（背包/世界状态） + judgeOutcome（复用 main.js）`)
  if (env.warn.length) env.warn.forEach(w => console.log(`⚠️  ${w}`))
  console.log('='.repeat(64) + '\n')

  // ---- 连接 ----
  const bot = mineflayer.createBot({
    host: cfg.bot.host,
    port: cfg.bot.port,
    username: ACCOUNT,
    auth: cfg.bot.auth || 'offline',
    version: cfg.bot.version || '1.21.11',
    hideErrors: true,
    checkTimeoutInterval: 120000,
    viewDistance: 'short'
  })

  let kicked = null
  let ended = null
  bot.on('kicked', (r) => {
    kicked = typeof r === 'string' ? r : JSON.stringify(r)
    console.log(`\n❌ 被踢: ${String(kicked).slice(0, 200)}\n`)
  })
  bot.on('end', (r) => { ended = r })
  bot.on('error', (e) => {
    if (!/ECONNRESET|EPIPE|Timed out/.test(String(e && e.message))) {
      if (VERBOSE) console.log('[err]', e && e.message)
    }
  })
  bot.on('death', () => console.log('  💀 死了（会自动重生，任务继续）'))

  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('连接超时（60s 没 spawn）')), 60000)
      bot.once('spawn', () => { clearTimeout(t); resolve() })
    })
  } catch (e) {
    console.error(`\n❌ ${e.message}`)
    if (kicked) console.error(`   被踢原因: ${kicked}`)
    process.exit(3)
  }

  // ---- 初始化（完全复刻 main.js 的 onSpawn）----
  // 配方数据：服务器 registry 里没有 recipes，不补的话所有合成都废
  if (!bot.registry.recipes) {
    bot.registry.recipes = mcData.recipes
    bot.registry.items = bot.registry.items || mcData.itemsArray
    console.log(`补上配方数据：${Object.keys(mcData.recipes).length} 条`)
  }

  try { await bot.waitForChunksToLoad() } catch (e) {}
  await sleep(2000)

  try { bot.loadPlugin(pathfinder) } catch (e) {}
  await sleep(300)

  const moves = new Movements(bot)
  moves.canDig = true
  moves.digCost = 20
  moves.allow1by1towers = true
  moves.canOpenDoors = true
  moves.liquidCost = 20
  moves.maxDropDown = 3
  moves.scafoldingBlocks = ['dirt', 'cobblestone', 'andesite', 'stone', 'gravel']
    .map(n => bot.registry.itemsByName[n])
    .filter(Boolean)
    .map(i => i.id)
  bot.pathfinder.setMovements(moves)

  // ---- actions 日志收集（失败时附最后几条，便于定位）----
  const actLog = []
  const pushLog = (s) => {
    actLog.push(`${new Date().toTimeString().slice(0, 8)} ${s}`)
    if (actLog.length > 600) actLog.shift()
    if (VERBOSE) console.log('    ' + s)
  }

  const ctx = { state: { chestPos: null }, notes: [] }
  const a = new Actions(bot, {
    log: pushLog,
    cfg,
    mem: null,
    get reflex () { return null },
    onComplain: (kind, detail) => pushLog(`[complain] ${kind} ${detail}`)
  })

  // ---- judgeOutcome 复用 ----
  const judgeBot = new JudgeBot(cfg)
  judgeBot.bot = bot   // countItem / snapshotInv 都走这个

  // ---- 基线 ----
  const baseline = {
    pos: fmt(a.pos()),
    y: Math.round(a.pos().y),
    underground: a.isUnderground(),
    health: Math.round(bot.health),
    food: Math.round(bot.food),
    inv: judgeBot.snapshotInv(),
    players: Object.keys(bot.players).filter(n => n !== bot.username)
  }
  console.log(`\n出生点    : ${baseline.pos}  y=${baseline.y}  在地下: ${baseline.underground}`)
  console.log(`血/饿     : ${baseline.health}/20  ${baseline.food}/20`)
  console.log(`背包      : ${invStr(baseline.inv)}`)
  console.log(`在线玩家  : ${baseline.players.join(', ') || '（只有我）'}\n`)

  // ---- 跑任务 ----
  const results = []

  for (let i = 0; i < list.length; i++) {
    const task = list[i]

    if (kicked) {
      results.push({
        id: task.id, name: task.name, ok: false, secs: 0,
        kind: FAIL_KINDS.KICKED,
        detail: `被踢，未执行（${String(kicked).slice(0, 80)}）`,
        judge: null, log: []
      })
      continue
    }
    if (!bot.entity) {
      results.push({
        id: task.id, name: task.name, ok: false, secs: 0,
        kind: FAIL_KINDS.KICKED,
        detail: '已断线，未执行',
        judge: null, log: []
      })
      continue
    }

    const budget = Math.round(task.budget * TIMEOUT_SCALE) * 1000
    process.stdout.write(`[${i + 1}/${list.length}] ${task.name.padEnd(8, '　')} `)

    const logMark = actLog.length
    const t0 = Date.now()
    let r
    let timedOut = false

    // 给 judgeOutcome 准备"任务开始时的背包"
    judgeBot._taskStartInv = judgeBot.snapshotInv()

    try {
      r = await Promise.race([
        task.run(a, bot, ctx),
        new Promise((_, rej) => setTimeout(() => {
          timedOut = true
          rej(new Error('__timeout__'))
        }, budget))
      ])
    } catch (e) {
      if (timedOut) {
        r = { ok: false, kind: FAIL_KINDS.TIMEOUT, detail: `超过 ${budget / 1000}s 未完成` }
      } else {
        r = { ok: false, kind: FAIL_KINDS.EXCEPTION, detail: `异常: ${String(e && e.message).slice(0, 120)}` }
      }
      // 超时/异常后把残留动作停掉，别污染下一个任务
      try { a.cancel = false; a.stop() } catch (e2) {}
      try { bot.clearControlStates() } catch (e2) {}
      await sleep(600)
    }

    const secs = Math.round((Date.now() - t0) / 1000)
    const taskLog = actLog.slice(logMark).slice(-14)

    // ---- 双判据：拿硬结果的自然语言描述去问 judgeOutcome ----
    let judge = null
    try {
      judge = judgeBot.judgeOutcome(task.goal, r.detail || '', t0)
    } catch (e) {
      judge = { ok: null, why: 'judgeOutcome 抛错: ' + e.message }
    }

    const disagree = judge && judge.ok !== null && judge.ok !== r.ok
    if (disagree && r.ok) {
      // 脚本说成了，正式口径说没成 —— 这是假成功，必须显式标出来
      r.kind = FAIL_KINDS.JUDGE_DISAGREE
    }

    const row = {
      id: task.id,
      name: task.name,
      ok: !!r.ok,
      secs,
      kind: r.ok ? null : (r.kind || FAIL_KINDS.UNKNOWN),
      detail: r.detail || '',
      judge,
      disagree: !!disagree,
      log: taskLog
    }
    results.push(row)

    const mark = r.ok ? '✅' : '❌'
    const dis = disagree ? `  ⚠️口径分歧(${judge.why || 'judge 判失败'})` : ''
    console.log(`${mark} ${String(secs).padStart(3)}s | ${r.detail}${dis}`)

    await sleep(1000)
  }

  // ---- 汇总 ----
  const total = results.length
  const ok = results.filter(r => r.ok).length
  const rate = total ? Math.round(ok / total * 100) : 0
  const secsTotal = results.reduce((s, r) => s + r.secs, 0)

  // 失败分类统计
  const byKind = {}
  for (const r of results) {
    if (r.ok) continue
    byKind[r.kind] = (byKind[r.kind] || 0) + 1
  }
  const disagreeCount = results.filter(r => r.disagree).length

  console.log('\n' + '='.repeat(64))
  console.log('  结果')
  console.log('='.repeat(64))
  console.log(`成功 ${ok} / ${total}    成功率 ${rate}%    总耗时 ${Math.round(secsTotal / 60)} 分 ${secsTotal % 60} 秒\n`)

  console.log('明细：')
  for (const r of results) {
    const t = `${String(r.secs).padStart(3)}s`
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.name.padEnd(8, '　')} ${t}  ${r.detail}`)
  }

  if (Object.keys(byKind).length) {
    console.log('\n失败分类：')
    for (const [k, n] of Object.entries(byKind).sort((x, y) => y[1] - x[1])) {
      console.log(`  ${String(n).padStart(2)} 次  ${k}`)
    }
  }

  if (disagreeCount) {
    console.log(`\n⚠️  口径分歧 ${disagreeCount} 次：脚本判成功，但 main.js 的 judgeOutcome 判失败。`)
    console.log('   这类就是"假成功" —— 正式运行时会记成失败，但背包其实变了。')
    for (const r of results.filter(x => x.disagree)) {
      console.log(`   · ${r.name}: judge 理由 = ${r.judge && r.judge.why}`)
    }
  }

  if (ctx.notes.length) {
    console.log('\n过程备注：')
    ctx.notes.forEach(n => console.log('  · ' + n))
  }

  // ---- 落盘 ----
  const report = {
    runId,
    at: now(),
    account: ACCOUNT,
    server: `${cfg.bot.host}:${cfg.bot.port}`,
    version: cfg.bot.version,
    durationSec: secsTotal,
    rate, ok, total,
    failureKinds: byKind,
    judgeDisagreements: disagreeCount,
    kicked: kicked || null,
    baseline,
    results
  }
  const outFile = path.join(outDir, `e2e-${runId}.json`)
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2))

  const logFile = path.join(outDir, `e2e-${runId}.log`)
  fs.writeFileSync(logFile, actLog.join('\n'))

  console.log(`\n结果已存: ${path.relative(ROOT, outFile)}`)
  console.log(`动作日志: ${path.relative(ROOT, logFile)}`)

  // ---- 收尾 ----
  try { bot.quit() } catch (e) {}
  await sleep(600)
  process.exit(rate >= 70 ? 0 : 1)
}

function invStr (inv) {
  const parts = Object.entries(inv || {}).map(([k, v]) => `${k}x${v}`)
  if (!parts.length) return '空'
  return parts.length > 10 ? parts.slice(0, 10).join(', ') + ` …共${parts.length}种` : parts.join(', ')
}

main().catch(e => {
  console.error('\n测试崩溃:', e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e)
  process.exit(2)
})
