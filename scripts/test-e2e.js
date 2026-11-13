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

const ACCOUNT_BASE = argOf('account', 'XJJ_E2E')
// 关键：默认账号必须**每次唯一**。
// 实测事故：两个进程同时跑本脚本，都用默认的 XJJ_E2E，
// 第二个登进来把第一个踢了（multiplayer.disconnect.duplicate_login），
// 前一个的 3 个任务直接变成"被踢，未执行"，整轮数据作废。
// 加后缀后各跑各的，可以并行。
const ACCOUNT = argOf('unique', '1') === '0'
  ? ACCOUNT_BASE
  : `${ACCOUNT_BASE}${Math.random().toString(36).slice(2, 6)}`.slice(0, 16)
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
  MATERIAL: '材料不足（做不出中间产物）',
  JUDGE_DISAGREE: '口径分歧（脚本成功/正式判定失败）',
  KICKED: '被踢下线',
  UNKNOWN: '未知'
}

/** 测不了的（不是他做不成，是测试夹具没搭起来）—— 不算进成功率 */
const SKIP_KIND = '跳过（夹具没搭起来，不计入成功率）'

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
      const t0 = Date.now()
      const hadPick = bot.inventory.items().some(i => /_pickaxe$/.test(i.name))

      // 路径 A：原子动作 mine()。这是"他自己写代码"会调的入口。
      let retA = null
      let errA = null
      try {
        retA = await a.mine('stone', 3, 24)
      } catch (e) { errA = e.message }
      await sleep(1000)
      const tA = Date.now()
      const afterA = cnt()

      // 路径 B：现成的脚手架 digStone()（会自己往下挖到石头层）。
      // ROADMAP 阶段 1 要回答的就是"原子动作够不够" —— 所以两条路都测，
      // 数据才有对比价值：A 成 B 不成 / A 不成 B 成，结论完全不同。
      //
      // 关键：digStone() 没有自己的时限，内部会连着 ensurePickaxe -> chopTree。
      // 实测它一把能烧 225 秒，把本任务的 300 秒预算吃掉，
      // 结果「挖石头」永远显示 301s 超时 —— 测的变成了 digStone，不是 mine。
      // 所以回退路径必须有自己的时间盒，超时就记"超时"，让 mine 的耗时独立可比。
      let retB = null
      let errB = null
      let pathBTimeout = false
      if (afterA <= before) {
        ctx.notes.push('挖石头：mine() 没产出，自动回退测 digStone()（限 90s 做对比）')
        const BUDGET_B = 90000
        try {
          retB = await Promise.race([
            a.digStone(3),
            new Promise((_, rej) => setTimeout(() => {
              pathBTimeout = true
              rej(new Error('__B_timeout__'))
            }, BUDGET_B))
          ])
        } catch (e) {
          if (pathBTimeout) errB = `digStone 超过 ${BUDGET_B / 1000}s`
          else errB = e.message
        }
        try { a.stop() } catch (e) {}
        try { bot.clearControlStates() } catch (e) {}
        await sleep(800)
      }
      const after = cnt()

      const ok = after > before
      const pathA = afterA > before ? 'mine() 成功' : 'mine() 失败'
      const pathB = retB === null ? '（未测）'
        : (after > afterA ? `digStone() 成功 ${afterA}->${after}` : 'digStone() 也失败')

      return {
        ok,
        kind: ok ? null : (errA || errB ? FAIL_KINDS.EXCEPTION : FAIL_KINDS.NO_OUTPUT),
        detail: `圆石 ${before} -> ${after}｜mine 段 ${Math.round((tA - t0) / 1000)}s｜${pathA}（返回 ${JSON.stringify(retA)}` +
          `${errA ? '，异常: ' + errA.slice(0, 40) : ''}）｜${pathB}` +
          `${errB ? '，异常: ' + errB.slice(0, 40) : ''}` +
          `｜${hadPick ? '开局已有镐' : '开局没镐（要先自己造）'}`
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
      // 给 3 次机会：出生点可能运气不好，周围没树
      // 但总预算不变（240s），所以每次最多 80s
      for (let i = 0; i < 3 && a.woodCount() <= before; i++) {
        try {
          ret = await a.chopTree(1)
        } catch (e) { err = e.message }
        if (a.woodCount() > before) break
        // 没砍到：走远一点再试
        if (i < 2) {
          try { await a.wander(35) } catch (e) {}
          try { await a.ensureChunks(3000) } catch (e) {}
        }
      }

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
      // 关键：开局背包里可能已经有木镐（服务器不掉落 + 上次测试留下的）。
      // 不清掉的话 craftSmart 第一行 `if (countOf >= count) return true`
      // 直接返回，"做木镐"变成 0 秒假通过 —— 历史数据里就踩过这个坑。
      const pre = a.countOf('wooden_pickaxe')
      if (pre > 0) {
        try { await a.toss('wooden_pickaxe', pre) } catch (e) {}
        await sleep(500)
        // 丢在原地会被自己捡回来，走开两格
        try { await a.wander(3) } catch (e) {}
        await sleep(700)
        if (a.countOf('wooden_pickaxe') > 0) {
          return {
            ok: false,
            skip: true,
            detail: `开局有 ${pre} 把木镐且丢不掉，无法测"从零做木镐"`
          }
        }
        ctx.notes.push(`做木镐前丢弃了 ${pre} 把存货，保证从零开始`)
      }

      const before = a.countOf('wooden_pickaxe')
      let wood = a.woodCount()

      // ===== 先保证有木头，否则测的是 chopTree 不是 craftSmart =====
      //
      // 【实测 · 2026-11-13 12:10】action-fixer 连续跑 6 轮 --only 做木镐，
      // 每轮出生点 48~96 格内都没有可达的树，全卡在"弄木头"这一步，
      // 压根走不到 craftSmart 的核心逻辑。
      //
      // 这个用例本来是测"合成链"，被 chopTree 的找树成功率淹没了。
      // 所以：先自己备木头（最多 90 秒），备不到就标成环境跳过，
      // 不要让它冒充"合成链失败"。
      if (wood < 3) {
        ctx.notes.push(`做木镐前只有 ${wood} 个原木，先备料`)
        const t0 = Date.now()
        while (a.woodCount() < 3 && Date.now() - t0 < 90000) {
          try { await a.chopTree(1) } catch (e) { break }
          if (a.woodCount() >= 3) break
          try { await a.wander(35) } catch (e) {}
          try { await a.ensureChunks(2500) } catch (e) {}
        }
        wood = a.woodCount()
        ctx.notes.push(`备料用了 ${Math.round((Date.now() - t0) / 1000)}s，现有原木 ${wood}`)
      }
      if (wood < 3) {
        return {
          ok: false,
          skip: true,
          detail: `备不到木头（只有 ${wood} 个原木），测不了合成链 —— 这是找树的问题，不是 craftSmart`
        }
      }

      let err = null
      try {
        await a.craftSmart('wooden_pickaxe', 1)
      } catch (e) { err = e.message }

      await sleep(600)
      const after = a.countOf('wooden_pickaxe')
      const ok = after > before
      return {
        ok,
        kind: ok ? null : (err ? FAIL_KINDS.EXCEPTION : FAIL_KINDS.NO_OUTPUT),
        detail: `木镐 ${before} -> ${after}（原料: 原木 ${wood} 个）` +
          (err ? `，异常: ${err.slice(0, 70)}` : '')
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
      const pre = a.countOf('stone_pickaxe')
      if (pre > 0) {
        try { await a.toss('stone_pickaxe', pre) } catch (e) {}
        await sleep(500)
        try { await a.wander(3) } catch (e) {}
        await sleep(700)
        if (a.countOf('stone_pickaxe') > 0) {
          return {
            ok: false,
            skip: true,
            detail: `开局有 ${pre} 把石镐且丢不掉，无法测"从零做石镐"`
          }
        }
        ctx.notes.push(`做石镐前丢弃了 ${pre} 把存货，保证从零开始`)
      }

      const before = a.countOf('stone_pickaxe')
      const cob = a.countOf('cobblestone') + a.countOf('cobbled_deepslate')
      const stick = a.countOf('stick')
      let err = null
      try {
        await a.craftSmart('stone_pickaxe', 1)
      } catch (e) { err = e.message }

      await sleep(600)
      const after = a.countOf('stone_pickaxe')
      const ok = after > before
      return {
        ok,
        kind: ok ? null : (err ? FAIL_KINDS.EXCEPTION : FAIL_KINDS.NO_OUTPUT),
        detail: `石镐 ${before} -> ${after}（材料: 圆石 ${cob} / 木棍 ${stick}）` +
          (err ? `，异常: ${err.slice(0, 70)}` : '')
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
      // 关键：附近可能已经有箱子（上次测试留下的）。
      // 老写法 placeNearby 第一行 `if (findBlock(chest,10)) return exist`
      // 直接返回已有箱子 —— "放箱子"变成 1 秒假通过，实际一次都没放。
      // 现在必须让世界里的 chest 数量**增加**才算成功。
      const countChests = () => {
        const def = mcData.blocksByName.chest
        if (!def) return 0
        try {
          return bot.findBlocks({ matching: def.id, maxDistance: 16, count: 32 }).length
        } catch (e) { return 0 }
      }
      const chestsBefore = countChests()

      // 确保手上有箱子
      if (a.countOf('chest') === 0) {
        try { await a.craftSmart('chest', 1) } catch (e) {
          ctx.notes.push('做箱子失败: ' + String(e.message).slice(0, 70))
        }
      }
      if (a.countOf('chest') === 0) {
        return {
          ok: false,
          kind: FAIL_KINDS.MATERIAL,
          detail: `做不出箱子（木板 ${a.countOf('oak_planks') + a.countOf('birch_planks') + a.countOf('spruce_planks') + a.countOf('jungle_planks')} 张、原木 ${a.woodCount()} 个、工作台 ${a.countOf('crafting_table')}）`
        }
      }

      let placed = null
      let err = null
      try {
        placed = await a.placeNearby('chest')
      } catch (e) { err = e.message }
      await sleep(800)

      const chestsAfter = countChests()
      const delta = chestsAfter - chestsBefore

      // 判据：世界里的 chest 真的多了
      const ok = delta > 0
      if (ok && placed) ctx.state.chestPos = placed.position
      else if (!ok && placed) ctx.state.chestPos = placed.position  // 复用旧箱子继续测"存东西"

      return {
        ok,
        kind: ok ? null : (err ? FAIL_KINDS.EXCEPTION : FAIL_KINDS.NO_OUTPUT),
        detail: ok
          ? `世界内 chest ${chestsBefore} -> ${chestsAfter} @${fmt(placed.position)}`
          : `世界内 chest ${chestsBefore} -> ${chestsAfter}（没放出来` +
            `${placed ? '，只是找到了旧箱子 @' + fmt(placed.position) : ''}）` +
            `${err ? '，异常: ' + err.slice(0, 60) : ''}`
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
          skip: true,
          detail: '没有可用的箱子（上一个任务没放出箱子，级联跳过）'
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
      const itemsBefore = a.foodList().reduce((s, f) => s + f.count, 0)

      let ret = null
      let err = null
      try {
        ret = await a.findFood()
      } catch (e) { err = e.message }

      await sleep(1500)
      const foodAfter = Math.round(bot.food)
      const itemsAfter = a.foodList().reduce((s, f) => s + f.count, 0)

      // 判据：背包里食物**变多了**，或饱食度上升。
      // 不能只看 hasFood() —— 开局就有存货时那也是"有食物"，等于没测。
      const gained = itemsAfter - itemsBefore
      const ate = foodAfter - foodBefore
      const ok = gained > 0 || ate > 0

      return {
        ok,
        kind: ok ? null : (err ? FAIL_KINDS.EXCEPTION : FAIL_KINDS.NO_OUTPUT),
        detail: `饥饿 ${foodBefore} -> ${foodAfter}，背包食物 ${itemsBefore} -> ${itemsAfter} 个` +
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
      /**
       * 这个任务最大的陷阱：**假成功**。
       *
       * 老写法是"本来就在地面 → 直接判成功"。历史 5 次跑，5 次都这么"通过"了，
       * 等于这个任务从来没测过 —— 而"困在地下爬不出来"恰恰是 TEAM.md 里写的当前卡点。
       *
       * 更隐蔽的一层：**只挖竖井也不算地下**。
       * isUnderground() 的判断是"头顶 15 格内有实体方块"。
       * 原地往下挖 4 格，头顶还是通天 → 判成露天 → 又变成假成功。
       *
       * 所以测试夹具必须是"真地下"：往下挖 4 格，再横着挖 3 格，
       * 让头顶压着实心泥土。这样才复现真实困境。
       */
      const startY = Math.round(a.pos().y)
      const fixture = []

      // ---- 夹具 1：往下挖 4 格 ----
      let dugDown = 0
      for (let i = 0; i < 4; i++) {
        const p = a.pos()
        const below = bot.blockAt(p.offset(0, -1, 0))
        if (!below || /bedrock|lava|water/.test(below.name)) {
          fixture.push(`第${i + 1}格下面是 ${below ? below.name : '未知'}，停止下挖`)
          break
        }
        let ok = false
        // allowBare: 空手也挖。夹具只是要"下到地下"，不需要掉落物。
        // 原来没传这个选项，空手挖石头被 bestToolFor 拦住，夹具造不出来。
        try { ok = await a.digAt(below, { allowBare: true }) } catch (e) { break }
        if (!ok) { fixture.push(`第${i + 1}格挖不动`); break }
        dugDown++

        // 挖完必须真正掉进坑里再挖下一格。
        //
        // 实测（/tmp/fix1.js）：挖掉脚下方块后，人经常卡在坑口边缘，
        // 连挖 2 格 y 只降 0.54 格，第 3 格脚下就变 air 了 ——
        // 而 dogDown<3 判定因此永远不满足，每轮 skip。
        // 解决：把人挪到格子正中心，逼它掉下去。
        const cx = Math.floor(p.x) + 0.5
        const cz = Math.floor(p.z) + 0.5
        try { await a.goto(cx, p.y - 1, cz, 0, 6000) } catch (e) {}

        // 确认真的掉下去了。没掉下去就自己再挖一次（可能是脚下又冒出一层）
        let dropped = false
        for (let k = 0; k < 12; k++) {
          const q = a.pos()
          if (bot.entity.onGround && q.y <= p.y - 0.6) { dropped = true; break }
          await sleep(150)
        }
        if (!dropped) {
          // 还悬着：把脚下再挖一格，然后再等
          const q = a.pos()
          const again = bot.blockAt(q.offset(0, -1, 0))
          if (again && !/bedrock|lava|water/.test(again.name)) {
            try { await a.digAt(again, { allowBare: true }) } catch (e) {}
          }
          for (let k = 0; k < 12 && !bot.entity.onGround; k++) await sleep(150)
        }
        await sleep(250)
      }

      if (dugDown < 3) {
        return {
          ok: false,
          skip: true,
          detail: `造不出地下夹具：只挖下去 ${dugDown} 格（${fixture.join('；')}）`
        }
      }

      // ---- 夹具 2：横着挖 3 格，让头顶压着实心 ----
      // 先挑一个前方是实心的方向（避免直接挖进天然洞穴）
      const dirs = [
        { name: '+X', dx: 1, dz: 0, yaw: -Math.PI / 2 },
        { name: '-X', dx: -1, dz: 0, yaw: Math.PI / 2 },
        { name: '+Z', dx: 0, dz: 1, yaw: 0 },
        { name: '-Z', dx: 0, dz: -1, yaw: Math.PI }
      ]
      let chosen = null
      for (const d of dirs) {
        const p = a.pos()
        const foot = bot.blockAt(p.offset(d.dx, 0, d.dz))
        const head = bot.blockAt(p.offset(d.dx, 1, d.dz))
        if (foot && head && foot.boundingBox === 'block' && head.boundingBox === 'block') {
          chosen = d
          break
        }
      }
      if (!chosen) chosen = dirs[0]

      let tunneled = 0
      for (let step = 0; step < 4; step++) {
        const p = a.pos()
        // 挖脚和头两格（allowBare：夹具只为造环境，不要掉落物）
        for (const dy of [0, 1]) {
          const b = bot.blockAt(p.offset(chosen.dx, dy, chosen.dz))
          if (!b || b.name === 'air' || b.name === 'cave_air') continue
          try { await a.digAt(b, { allowBare: true }) } catch (e) {}
        }
        // 走进新挖的格子。
        // 原来的写法只 setControlState('forward')，朝向可能没对准，
        // 结果人原地打转 —— 掘进 3 格后还在原地，头顶照样通天，
        // 于是报「y=66 仍被判为露天」。改成目标坐标寻路，稳得多。
        const tx = Math.floor(p.x) + chosen.dx
        const tz = Math.floor(p.z) + chosen.dz
        const ty = Math.floor(p.y)
        try { await a.goto(tx, ty, tz, 0, 6000) } catch (e) {}
        // 确认真的进去了
        for (let k = 0; k < 10; k++) {
          const q = a.pos()
          if (Math.floor(q.x) === tx && Math.floor(q.z) === tz) break
          await sleep(150)
        }
        await sleep(250)
        tunneled++
        // 已经够深就停
        if (step >= 1 && a.isUnderground()) break
      }
      fixture.push(`下挖 ${dugDown} 格，向 ${chosen.name} 掘进 ${tunneled} 格`)

      const undergroundBefore = a.isUnderground()
      const yBefore = Math.round(a.pos().y)

      if (!undergroundBefore) {
        return {
          ok: false,
          skip: true,
          detail: `夹具失败：${fixture.join('，')}，y=${yBefore} 仍被判为露天，无法验证`
        }
      }

      // ---- 正式测：能不能自己爬出来 ----
      const t0 = Date.now()
      let err = null
      try {
        await a.getToSurface(80)
      } catch (e) { err = e.message }
      await sleep(800)

      const out = !a.isUnderground()
      const yAfter = Math.round(a.pos().y)
      const climbed = yAfter - yBefore

      // 判据必须同时满足两条：
      //   1. 不再被判在地下
      //   2. 真的往上走了（不是靠"判定抖了一下"通过）
      // 只上升 1 格而 y 回到起始高度不算 —— 那是自己挖的竖井还在头顶。
      const rose = climbed >= dugDown - 1
      const ok = out && rose

      return {
        ok,
        kind: ok ? null : (err ? FAIL_KINDS.EXCEPTION : FAIL_KINDS.NO_OUTPUT),
        detail: `${fixture.join('，')}；起点 y=${startY}，困在 y=${yBefore}，` +
          `结果 y=${yAfter}（爬升 ${climbed} 格，需 ≥${dugDown - 1}）` +
          `${out ? '，判定已出地面' : '，仍判定在地下'}` +
          `${ok ? '' : err ? `，异常: ${err.slice(0, 60)}` : '，爬升不足'}` +
          `，耗时 ${Math.round((Date.now() - t0) / 1000)}s`
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

  if (ACCOUNT === PROD_ACCOUNT || ACCOUNT.startsWith(PROD_ACCOUNT) && ACCOUNT.length <= PROD_ACCOUNT.length + 0) {
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
  try {
    const rev = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()
    const dirty = execSync('git status --porcelain -- src main.js', { cwd: ROOT, encoding: 'utf8' }).trim()
    console.log(`代码版本  : ${rev}${dirty ? ' ⚠️ src/main.js 有未提交改动' : ''}`)
  } catch (e) {}
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
  console.log(`在线玩家  : ${baseline.players.join(', ') || '（只有我）'}`)

  // ---- 出生点健康检查 ----
  //
  // 实测发现 e2e 方差极大，出生点决定成败：
  //   v2 出生在 (60,69,5) 地表  -> 57%
  //   v3 出生在 (63,50,9) 深层地下 -> 0%（4 个任务各 240 秒全超时）
  //
  // y=50 全石头的环境里，空手挖不动石头、没料垫塔、getToSurface 出不来，
  // 整条链全断。这种出生点的数据没有参考价值。
  //
  // 所以开局先确认"能正常开始"：在地下就先爬出来，爬不出来就标记环境异常。
  let envWarning = ''
  if (baseline.underground === true || baseline.y < 60) {
    console.log(`⚠️  出生点在地下（y=${baseline.y}），先爬出来再开始计时...`)
    const y0 = a.pos().y
    try {
      await Promise.race([
        a.getToSurface(80),
        new Promise(r => setTimeout(r, 180000))
      ])
    } catch (e) {}
    const y1 = a.pos().y
    const out = a.isUnderground() === false
    console.log(`    爬升 ${Math.round(y1 - y0)} 格，现在 y=${Math.round(y1)}，在地下: ${a.isUnderground()}`)
    if (!out) {
      envWarning = `出生点在地下且爬不出来（y=${Math.round(y1)}），本轮数据参考价值低`
      console.log(`⚠️  ${envWarning}`)
    }
    await sleep(1000)
  }
  console.log('')

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

    // 两个方向都要看，性质完全不同：
    //   r.ok=true  但 judge=false -> 假成功（正式运行会记失败，但东西真做出来了）
    //   r.ok=false 但 judge=true  -> 漏报（最危险：明明没做成，正式运行却记成功）
    const disagree = judge && judge.ok !== null && judge.ok !== r.ok
    const judgeMiss = disagree && !r.ok && judge.ok === true
    const judgeFalseAlarm = disagree && r.ok && judge.ok === false

    // skip = 测不了（夹具没搭起来），既不算成功也不算失败
    const skipped = !!r.skip
    const row = {
      id: task.id,
      name: task.name,
      ok: skipped ? null : !!r.ok,
      skipped,
      secs,
      kind: skipped ? SKIP_KIND : (r.ok ? null : (r.kind || FAIL_KINDS.UNKNOWN)),
      detail: r.detail || '',
      judge,
      judgeMiss: skipped ? false : !!judgeMiss,
      judgeFalseAlarm: skipped ? false : !!judgeFalseAlarm,
      log: taskLog
    }
    results.push(row)

    const mark = skipped ? '⏭️ ' : (r.ok ? '✅' : '❌')
    let dis = ''
    if (!skipped && judgeMiss) dis = '  🚨judge漏报(实际失败却判成功)'
    else if (!skipped && judgeFalseAlarm) dis = `  ⚠️judge误报(${judge.why || 'judge 判失败'})`
    console.log(`${mark} ${String(secs).padStart(3)}s | ${r.detail}${dis}`)

    await sleep(1000)
  }

  // ---- 汇总 ----
  // 关键口径：跳过项不进分母。
  // "开局有存货测不了从零合成"是他的问题吗？不是。混进失败率会失真。
  const skippedList = results.filter(r => r.skipped)
  const graded = results.filter(r => !r.skipped)
  const total = graded.length
  const ok = graded.filter(r => r.ok).length
  const rate = total ? Math.round(ok / total * 100) : 0
  const secsTotal = results.reduce((s, r) => s + r.secs, 0)

  // 失败分类统计
  const byKind = {}
  for (const r of graded) {
    if (r.ok) continue
    byKind[r.kind] = (byKind[r.kind] || 0) + 1
  }
  const missCount = graded.filter(r => r.judgeMiss).length
  const alarmCount = graded.filter(r => r.judgeFalseAlarm).length

  console.log('\n' + '='.repeat(64))
  console.log('  结果')
  console.log('='.repeat(64))
  console.log(`成功 ${ok} / ${total}（可评分）  成功率 ${rate}%  ` +
    `${skippedList.length ? `跳过 ${skippedList.length} 项  ` : ''}` +
    `总耗时 ${Math.round(secsTotal / 60)} 分 ${secsTotal % 60} 秒\n`)

  console.log('明细：')
  for (const r of results) {
    const t = `${String(r.secs).padStart(3)}s`
    const mark = r.skipped ? '⏭️ ' : (r.ok ? '✅' : '❌')
    console.log(`  ${mark} ${r.name.padEnd(8, '　')} ${t}  ${r.detail}`)
  }

  if (Object.keys(byKind).length) {
    console.log('\n失败分类：')
    for (const [k, n] of Object.entries(byKind).sort((x, y) => y[1] - x[1])) {
      console.log(`  ${String(n).padStart(2)} 次  ${k}`)
    }
  }

  if (missCount || alarmCount) {
    console.log('\n' + '-'.repeat(64))
    console.log('  judgeOutcome 与真实结果的偏差（这是 src/ 的问题，不是测试的问题）')
    console.log('-'.repeat(64))
    if (missCount) {
      console.log(`🚨 漏报 ${missCount} 次：真实失败，judgeOutcome 却判成功。`)
      console.log('   后果：正式运行时会把没做成的事记成"完成"，失败率被系统性低估。')
      for (const r of graded.filter(x => x.judgeMiss)) {
        console.log(`   · ${r.name}: ${r.detail.slice(0, 60)}`)
      }
    }
    if (alarmCount) {
      console.log(`\n⚠️  误报 ${alarmCount} 次：真实成功，judgeOutcome 判失败。`)
      for (const r of graded.filter(x => x.judgeFalseAlarm)) {
        console.log(`   · ${r.name}: judge 理由 = ${r.judge && r.judge.why}`)
      }
    }
  }

  if (ctx.notes.length) {
    console.log('\n过程备注：')
    ctx.notes.forEach(n => console.log('  · ' + n))
  }

  // ---- 落盘 ----
  // 代码基线：同一份"成功率"必须能对应到某个 commit，
  // 否则改动前后无法对比（TEAM.md 铁律 5：改前记基线）。
  let codeRev = 'unknown'
  let codeDirty = null
  try {
    codeRev = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()
    const st = execSync('git status --porcelain -- src main.js', { cwd: ROOT, encoding: 'utf8' }).trim()
    codeDirty = st ? st.split('\n') : []
  } catch (e) {}

  const report = {
    runId,
    at: now(),
    account: ACCOUNT,
    server: `${cfg.bot.host}:${cfg.bot.port}`,
    version: cfg.bot.version,
    codeRev,
    codeDirty,
    durationSec: secsTotal,
    rate, ok, total,
    skipped: skippedList.length,
    failureKinds: byKind,
    judgeMiss: missCount,
    judgeFalseAlarm: alarmCount,
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
  // 退出码：成功率达标 **且** judgeOutcome 没有漏报，才算通过
  process.exit(rate >= 70 && missCount === 0 ? 0 : 1)
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
