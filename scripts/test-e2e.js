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
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
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

// ==================================================================
// 测试夹具：**保证有镐**
// ==================================================================
//
// 为什么需要这个：
//   「挖石头」这个用例原来同时测三件事 —— 造镐、找树、挖矿。
//   三个都过才 ✅，任何一个挂了就 ❌，于是根本看不出 mine() 修得怎么样。
//   实测「挖石头」301s 超时里，挖矿本身只占 2 秒，剩下全是造镐（砍树）。
//
// 拆开之后：
//   「做木镐」用例  -> 测造镐
//   「挖石头」用例  -> 夹具保证有镐，**只测 mine()**
//
// 用户给的三种做法里选了 C+B 混合：
//   1. 先试已知"有树"的固定坐标（goto 过去再砍）—— 最可控
//   2. 不行就带足预算（300s，不设 ensurePickaxe 的 120s 上限）自己找
//   3. 都不行就 skip（不算失败，因为这是夹具问题不是能力问题）

/** 已知有树的坐标（历次实测记下来的，见脚本注释里的日期） */
const KNOWN_TREE_SPOTS = [
  { x: 86, y: 76, z: 73, note: '2026-11-13 gap-fixer 实测砍到 4 块 oak_log' },
  { x: 74, y: 65, z: 134, note: '2026-11-13 08:18 实测砍到 6 块 birch_log' },
  { x: 107, y: 76, z: 66, note: '2026-11-13 10:40 实测砍到 1 块 oak_log' },
  { x: 57, y: 81, z: -94, note: '2026-11-13 15:43 实测砍到 2 块 oak_log' },
  { x: 75, y: 75, z: -125, note: '2026-11-13 15:43 实测砍到 6 块 oak_log' }
]

/**
 * 让 bot 手上有一把镐（任意种类）。
 *
 * @returns {Promise<{ ok:boolean, how:string, secs:number }>}
 */
async function ensurePickaxeByFixture (a, bot, ctx, opts = {}) {
  const budgetMs = opts.budgetMs || 300000
  const t0 = Date.now()
  const pickUp = () => bot.inventory.items()
    .filter(i => /_pickaxe$/.test(i.name))
    .sort((x, y) => {
      const rank = (n) => /netherite/.test(n) ? 6 : /diamond/.test(n) ? 5 : /iron/.test(n) ? 4
        : /stone/.test(n) ? 3 : /golden/.test(n) ? 2 : /wooden/.test(n) ? 1 : 0
      return rank(y.name) - rank(x.name)
    })[0]

  // 0. 已经有了
  let have = pickUp()
  if (have) return { ok: true, how: `开局已有 ${have.name}`, secs: 0 }

  // 1. 已知坐标：走到树旁直接砍
  if (bot.pathfinder) {
    for (const spot of KNOWN_TREE_SPOTS) {
      if (Date.now() - t0 > budgetMs) break
      // 太远就别去（>400 格说明出生点完全在另一片区域）
      const d = Math.hypot(a.pos().x - spot.x, a.pos().z - spot.z)
      if (d > 400) continue
      ctx.notes.push(`夹具：试已知树点 (${spot.x},${spot.y},${spot.z}) 距离 ${Math.round(d)} 格（${spot.note}）`)
      try {
        // 用 pathfinder 的 GoalXZ 长途接近（不经过 goto，避免 gotoVertical 卡死）
        const arrived = await Promise.race([
          (async () => {
            try {
              bot.pathfinder.setGoal(new goals.GoalXZ(Math.floor(spot.x), Math.floor(spot.z)))
            } catch (e) { return false }
            const s = Date.now()
            let last = a.pos().clone()
            let still = 0
            while (Date.now() - s < 90000) {
              const p = a.pos()
              if (Math.hypot(p.x - spot.x, p.z - spot.z) <= 4) return true
              if (p.distanceTo(last) < 0.12) still += 200
              else still = 0
              last = p.clone()
              if (still > 6000) break
              await sleep(200)
            }
            return Math.hypot(a.pos().x - spot.x, a.pos().z - spot.z) <= 8
          })(),
          sleep(95000).then(() => false)
        ])
        try { bot.pathfinder.setGoal(null) } catch (e) {}

        if (arrived) {
          // 找附近原木直接砍（chopTree 在该点附近应该能找到）
          const before = a.woodCount()
          try { await a.chopTree(1) } catch (e) {}
          if (a.woodCount() > before) {
            ctx.notes.push(`夹具：在已知树点砍到 ${a.woodCount() - before} 块原木`)
            break
          }
        }
      } catch (e) {}
    }
  }

  // 2. 有木头了 -> 做木板/木棍/木镐（用 craftSmart，它已经验证过）
  const tryCraft = async () => {
    try {
      if (a.woodCount() > 0) await a.anyPlanks(12)
      if (a.countOf('stick') < 2) await a.craftSmart('stick', 2)
      await a.craftSmart('wooden_pickaxe', 1)
    } catch (e) {
      ctx.notes.push(`夹具：合成失败 ${String(e.message).slice(0, 50)}`)
    }
    const p = pickUp()
    if (p) { try { await bot.equip(p, 'hand') } catch (e) {} }
    return p
  }

  have = await tryCraft()
  if (have) return { ok: true, how: `用已知树点做出 ${have.name}`, secs: Math.round((Date.now() - t0) / 1000) }

  // 3. 兜底：带足 300 秒预算，不设 ensurePickaxe 的 120s 上限，让它自己慢慢找
  if (Date.now() - t0 < budgetMs - 60000) {
    ctx.notes.push('夹具：已知树点都不行，放开预算自己找（最多 ~240s）')
    try {
      // 直接调 ensurePickaxe 并把预算拉满 —— 这是"允许慢"的版本
      const leftMs = Math.max(60000, budgetMs - (Date.now() - t0) - 10000)
      await a.ensurePickaxe({ budgetMs: leftMs })
      have = pickUp()
      if (have) {
        try { await bot.equip(have, 'hand') } catch (e) {}
        return { ok: true, how: `自己找到材料做出 ${have.name}`, secs: Math.round((Date.now() - t0) / 1000) }
      }
    } catch (e) {
      ctx.notes.push(`夹具：自找失败 ${String(e.message).slice(0, 50)}`)
    }
  }

  return { ok: false, how: '夹具造不出镐（出生点附近确实没有可用的树）', secs: Math.round((Date.now() - t0) / 1000) }
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
      const t0 = Date.now()
      const hadPick = bot.inventory.items().some(i => /_pickaxe$/.test(i.name))

      // ===== 夹具：先保证有镐，再测 mine() =====
      //
      // 【为什么 · 2026-11-13 16:10】
      // 这个用例原来一次测三件事：造镐 + 找树 + 挖矿。
      // 实测 301s 超时里挖矿只占 2 秒，剩下全是砍树造镐 ——
      // 于是"mine() 修得怎么样"完全看不出来。
      // 造镐已经由「做木镐」用例覆盖，这里不该重复测。
      //
      // 夹具造不出镐时按"跳过"处理，不算失败 —— 那是夹具问题，不是能力问题。
      let fixture = { ok: hadPick, how: hadPick ? '开局已有镐' : '', secs: 0 }
      if (!hadPick) {
        ctx.notes.push('挖石头：开局没镐，启用夹具（不设 120s 上限，允许慢）')
        // 夹具预算不能给满 300 秒 —— 一旦砍树卡住，整轮任务直接超时，
        // 连一行 mine() 的日志都看不到（实测 prof2：301s 全在试已知树点）。
        // 给 150 秒：够走 1~2 个已知树点，不够就明确"夹具失败"跳过，
        // 这样测试至少能给出"mine 没被验证"的结论，而不是含糊的超时。
        fixture = await ensurePickaxeByFixture(a, bot, ctx, { budgetMs: 150000 })
        if (!fixture.ok) {
          return {
            ok: false,
            skip: true,
            kind: SKIP_KIND,
            detail: `夹具造不出镐（${fixture.how}，${fixture.secs}s），无法单测 mine()`
          }
        }
        ctx.notes.push(`挖石头：夹具就绪 ${fixture.how}（${fixture.secs}s），下面只测 mine()`)
      }

      // 基线必须在夹具之后取 —— 否则会把造镐过程里挖到的圆石算进来
      const before = cnt()

      // 【关键】计时也要在夹具之后重新起算。
      // 原来 t0 在任务开头就定了，于是 `mine 段` 把夹具那 216 秒也算进去，
      // 报出"mine 段 254s"——但 mine() 自己只跑了 37.8 秒。
      // 这种统计口径错误会直接把结论带偏（看起来像 mine 很慢）。
      const tMine0 = Date.now()

      // 路径 A：原子动作 mine()。这是"他自己写代码"会调的入口。
      let retA = null
      let errA = null
      try {
        retA = await a.mine('stone', 3, 24)
      } catch (e) { errA = e.message }
      await sleep(1000)
      const tA = Date.now()
      const afterA = cnt()
      const mineSecs = Math.round((tA - tMine0) / 1000)

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

      // 夹具耗时和 mine 耗时分开报 —— 这才是"mine() 单独的真实耗时"
      const fixtureStr = hadPick
        ? '开局已有镐'
        : `夹具 ${fixture.secs}s（${fixture.how}）`
      return {
        ok,
        kind: ok ? null : (errA || errB ? FAIL_KINDS.EXCEPTION : FAIL_KINDS.NO_OUTPUT),
        detail: `圆石 ${before} -> ${after}｜mine 段 ${mineSecs}s｜${pathA}（返回 ${JSON.stringify(retA)}` +
          `${errA ? '，异常: ' + errA.slice(0, 40) : ''}）｜${pathB}` +
          `${errB ? '，异常: ' + errB.slice(0, 40) : ''}` +
          `｜${fixtureStr}`
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

      // ---- 夹具 1：往下挖 4 格（用 digDownOne，不靠 goto）----
      let dugDown = 0
      for (let i = 0; i < 4; i++) {
        const p0 = a.pos()
        const below = bot.blockAt(p0.offset(0, -1, 0))
        const ok = await digDownOne(bot, a)
        if (!ok) {
          fixture.push(`第${i + 1}格下不去（脚下是 ${below ? below.name : '空'}）`)
          break
        }
        dugDown++
        await sleep(200)
      }

      if (dugDown < 3) {
        return {
          ok: false,
          skip: true,
          detail: `造不出地下夹具：只挖下去 ${dugDown} 格（${fixture.join('；')}）`
        }
      }

      // ---- 夹具 2：横着掘进，让头顶压着实心 ----
      // 目的：让 isUnderground() 判真（"头顶 15 格内有石头"）。
      // 竖井下来时头顶还是自己挖的竖井 -> 通天 -> 判露天，
      // 所以必须往侧面拐进去，头上才有原生的实心方块。
      const dirs = [
        { name: '+X', dx: 1, dz: 0 },
        { name: '-X', dx: -1, dz: 0 },
        { name: '+Z', dx: 0, dz: 1 },
        { name: '-Z', dx: 0, dz: -1 }
      ]
      // 先挑一个前方是实心的方向（避免直接挖进天然洞穴，那样头顶又是空的）
      let chosen = null
      for (const d of dirs) {
        const p0 = a.pos()
        const foot = bot.blockAt(p0.offset(d.dx, 0, d.dz))
        const head = bot.blockAt(p0.offset(d.dx, 1, d.dz))
        const roof = bot.blockAt(p0.offset(d.dx, 2, d.dz))
        if (foot && head && roof &&
            foot.boundingBox === 'block' && head.boundingBox === 'block') {
          chosen = d
          break
        }
      }
      if (!chosen) chosen = dirs[0]

      let tunneled = 0
      for (let step = 0; step < 4; step++) {
        const moved = await tunnelOneStep(bot, a, chosen.dx, chosen.dz)
        if (moved) tunneled++
        await sleep(200)
        // 已经是"真地下"了就停（省时间）
        if (tunneled >= 2 && a.isUnderground()) break
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
// 夹具工具：把自己弄到地下
// ==================================================================
//
// 【为什么不能用 a.goto(cx, y-1, cz) 让人掉进坑里】
// goto 的到达判据是 `dxz <= tol && dyAbs <= 2`（见 src/actions.js 的 goto）。
// 目标设成 p.y - 1 时，dyAbs = 1 ≤ 2 一开始就成立，
// 只要水平距离够近就直接 return true —— 人一步都没动，
// 调用方却以为"已经下去了"。
//
// 实测（/tmp/fixdiag.js）：
//   第1格: 脚下=grass_block y=71.00
//     digAt= true
//     掉落=false 现在y=71.00 onGround=false
//   没掉下去，break
//   >>> 最终 y= 71.0 下挖= 1 格
// 这就是「从地下爬出来」永远报"只挖下去 1 格"的原因。
//
// 正确做法：不管路径，直接确认"脚下是空的 + 等人自己掉"。
// 原版重力会把玩家拉下去，只需要时间。

/** 等玩家真的落到某一层的实心方块上 */
async function settleOnGround (bot, a, maxTicks = 40) {
  for (let i = 0; i < maxTicks; i++) {
    await sleep(100)
    const p = a.pos()
    const below = bot.blockAt(p.offset(0, -1, 0))
    const onSolid = below && below.boundingBox === 'block'
    if (bot.entity.onGround && onSolid) return true
  }
  return false
}

/**
 * 往下挖一格，并确保自己真的落进坑里。
 * @returns {Promise<boolean>} 是否成功下降
 */
async function digDownOne (bot, a) {
  const p0 = a.pos()
  const y0 = p0.y
  let below = bot.blockAt(p0.offset(0, -1, 0))
  if (!below) return false
  if (/bedrock|lava|water/.test(below.name)) return false

  // 脚下已经是空气：人可能浮在方块边缘（出生点挂在树叶/斜坡上）。
  //
  // 【踩过的坑】这里必须**重新取** below。
  // 原来只在开头取一次快照，然后等落地，落地后仍拿那个旧的 air 对象去 digAt ——
  // digAt(air) 直接返回 false，于是报"第1格下不去（脚下是 grass_block）"：
  // 错误信息里 real 的 grass_block 是任务体重新取的，日志却永远是 false。
  // 现象非常迷惑：诊断脚本能连挖 4 格，e2e 里一格都下不去。
  if (below.boundingBox !== 'block') {
    for (let i = 0; i < 30; i++) {
      await sleep(100)
      const q = a.pos()
      const b2 = bot.blockAt(q.offset(0, -1, 0))
      if (b2 && b2.boundingBox === 'block') break
    }
    // 重新取当前位置脚下的方块（不要用上面那个旧快照）
    let q2 = a.pos()
    below = bot.blockAt(q2.offset(0, -1, 0))

    // 等 3 秒还浮空，说明出生点挂在半空（树叶/悬空方块边缘），
    // 重力不会把我们送到地面。往四周挪一格再试。
    if (!below || below.boundingBox !== 'block') {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
        try {
          const yaw = Math.atan2(-dx, dz)
          await bot.look(yaw, 0, true)
          bot.setControlState('forward', true)
          await sleep(600)
          bot.setControlState('forward', false)
        } catch (e) {}
        await sleep(400)
        q2 = a.pos()
        const b4 = bot.blockAt(q2.offset(0, -1, 0))
        if (b4 && b4.boundingBox === 'block') { below = b4; break }
      }
    }
    if (!below || below.boundingBox !== 'block') return false
    if (/bedrock|lava|water/.test(below.name)) return false
  }

  // allowBare：夹具只要"挖通"，不要掉落物。
  // 空手挖石头慢且不掉料，但能把方块挖掉让我们下去。
  let ok = false
  try { ok = await a.digAt(below, { allowBare: true }) } catch (e) { return false }
  if (!ok) return false

  // 关键：不调 goto。等重力把玩家拉下去。
  for (let i = 0; i < 30; i++) {
    await sleep(100)
    if (a.pos().y < y0 - 0.6) break
  }
  if (a.pos().y >= y0 - 0.6) {
    // 没掉下去：可能卡在方块边缘。往中心挪一点点（用原始控制键，不走 pathfinder）
    try {
      const cx = Math.floor(p0.x) + 0.5
      const cz = Math.floor(p0.z) + 0.5
      const dx = cx - a.pos().x
      const dz = cz - a.pos().z
      if (Math.hypot(dx, dz) > 0.25) {
        await bot.look(Math.atan2(-dx, -dz), 0, true)
        bot.setControlState('forward', true)
        await sleep(Math.min(500, Math.max(150, Math.hypot(dx, dz) * 400)))
        bot.setControlState('forward', false)
      }
    } catch (e) {}
    for (let i = 0; i < 25; i++) {
      await sleep(100)
      if (a.pos().y < y0 - 0.6) break
    }
  }

  await settleOnGround(bot, a)
  return a.pos().y < y0 - 0.6
}

/**
 * 朝某个方向掘进一格（挖掉脚和头，然后走进去）。
 * 用控制键而不是 goto —— 这一格距离上 goto 的距离判据不可靠。
 */
async function tunnelOneStep (bot, a, dx, dz) {
  const p0 = a.pos()
  const base = { x: Math.floor(p0.x), y: Math.floor(p0.y), z: Math.floor(p0.z) }

  // 挖掉前方脚位和头位
  for (const dy of [0, 1]) {
    const b = bot.blockAt(bot.entity.position.offset(
      (base.x + dx) - bot.entity.position.x,
      (base.y + dy) - bot.entity.position.y,
      (base.z + dz) - bot.entity.position.z))
    if (!b || b.name === 'air' || b.name === 'cave_air') continue
    try { await a.digAt(b, { allowBare: true }) } catch (e) {}
    await sleep(150)
  }

  // 走进去：面朝 dx,dz 方向按前进。
  //
  // 【踩过的坑】yaw 符号写反了。
  // Minecraft 的约定：yaw=0 面向 +Z（南），yaw=-π/2 面向 +X（东）。
  // 前进单位向量 = (-sin(yaw), cos(yaw))。
  // 要走向 (dx, dz)，解 -sin(yaw)=dx、cos(yaw)=dz，得
  //   yaw = atan2(-dx, dz)
  // 原来写成 atan2(-dx, -dz)，等于朝着**反方向**走 ——
  // 挖开了前面的方块，人却往回退，所以永远"掘进 0 格"。
  const yaw = Math.atan2(-dx, dz)
  try {
    await bot.look(yaw, 0, true)
    bot.setControlState('forward', true)
    // 1 格约 0.25 秒，给到 1.2 秒容错；中途到了就停
    for (let i = 0; i < 12; i++) {
      await sleep(100)
      const q = a.pos()
      if (Math.floor(q.x) === base.x + dx && Math.floor(q.z) === base.z + dz) break
    }
    bot.setControlState('forward', false)
  } catch (e) {}
  await sleep(200)

  // 还没进去：用 pathfinder 补一次（挖开了就是一条 1 格通道，它能走）
  {
    const q = a.pos()
    if (Math.floor(q.x) !== base.x + dx || Math.floor(q.z) !== base.z + dz) {
      try {
        bot.pathfinder.setGoal(new goals.GoalBlock(base.x + dx, base.y, base.z + dz))
        for (let i = 0; i < 20; i++) {
          await sleep(150)
          const r = a.pos()
          if (Math.floor(r.x) === base.x + dx && Math.floor(r.z) === base.z + dz) break
        }
        bot.pathfinder.setGoal(null)
      } catch (e) {}
    }
  }

  // 确认真的进了新格子
  const q = a.pos()
  const moved = Math.floor(q.x) === base.x + dx && Math.floor(q.z) === base.z + dz
  await settleOnGround(bot, a)
  return moved
}


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

  // ================================================================
  // 掉落物健康检查（Lead 要求：开跑前确认这一轮环境可不可信）
  // ================================================================
  //
  // 背景：实测发现同一个 `mine` 在不同时刻回收率天差地别
  //   （16:00 那轮 4/5 捡到，16:03 那轮 0/4），用户亲手挖是正常的。
  // 这说明存在"外部环境"因素：服务器掉落物实体同步、TPS、区块 tick。
  //
  // 如果这轮环境本身就不给掉落物，后面所有"挖石头失败"的数据都没有归因价值 ——
  // 白烧 300 秒还得不出结论。所以开跑前先做个 20 秒的小实验：
  //   连续挖 3 块**同层**的软方块（dirt/grass_block 这类空手就能挖的），
  //   看背包涨不涨。涨 = 环境正常；不涨 = 标记本轮不可信。
  //
  // 用同层目标是有意的：同层掉落物落在脚边，不受"掉落物掉到下方捡不到"
  // 那个已知地形因素干扰，测的就是纯粹的"掉落物进不进包"。
  const lootCheck = { tried: 0, gained: 0, samples: [], ok: false, note: '' }
  try {
    console.log('---- 环境健康检查：掉落物能不能进包 ----')
    const soft = ['dirt', 'grass_block', 'gravel', 'sand', 'coarse_dirt']
    let digs = 0
    const t0 = Date.now()
    // 最多 25 秒 / 最多挖 5 次，尽量拿到 3 个样本
    while (digs < 5 && lootCheck.samples.length < 3 && Date.now() - t0 < 25000) {
      if (kicked || !bot.entity) break
      const p0 = a.pos()
      // 找同层、伸手范围内的软方块
      let target = null
      for (const name of soft) {
        const def = mcData.blocksByName[name]
        if (!def) continue
        let ps = []
        try {
          ps = bot.findBlocks({ matching: def.id, maxDistance: 6, count: 8 }) || []
        } catch (e) { ps = [] }
        const same = ps
          .filter(q => {
            const dy = q.y - p0.y
            return dy >= -0.6 && dy <= 1.6 && q.distanceTo(p0) <= 4.2
          })
          .sort((x, y) => x.distanceTo(p0) - y.distanceTo(p0))
        if (same.length) {
          const b = bot.blockAt(same[0])
          if (b) { target = b; break }
        }
      }
      if (!target) {
        lootCheck.note = '附近 6 格内没有同层软方块可挖'
        break
      }

      const before = soft.reduce((n, k) => n + a.countOf(k), 0)
      let dug = false
      // 不要用 allowBare：这个检查要验证的是"正常挖掘的掉落物能不能进包"，
      // 空手强挖（allowBare）本身就可能不掉落，会把环境误判成异常。
      // 实测：健康检查报"挖 3 次全 +0"，但同一轮 mine() 用木镐挖到 3/3，
      // 就是因为检查用的是空手。
      try { dug = await a.digAt(target) } catch (e) {}
      digs++
      lootCheck.tried++
      if (!dug) {
        lootCheck.samples.push('挖不动')
        continue
      }
      // 等掉落物进包（吸附有延迟）
      let gained = 0
      for (let k = 0; k < 14; k++) {
        await sleep(200)
        const now = soft.reduce((n, kk) => n + a.countOf(kk), 0)
        gained = now - before
        if (gained > 0) break
      }
      // 捡不到就走两步再试一次（可能是掉落物偏了一点）
      if (gained <= 0) {
        try { await a.pickupNearby(6) } catch (e) {}
        await sleep(300)
        const now = soft.reduce((n, kk) => n + a.countOf(kk), 0)
        gained = now - before
      }
      lootCheck.gained += Math.max(0, gained)
      lootCheck.samples.push(gained > 0 ? `+${gained}` : '+0')
      await sleep(300)
    }

    const hasAnyTool = bot.inventory.items().some(i => /_(pickaxe|axe|shovel)$/.test(i.name))
    lootCheck.hasTool = hasAnyTool
    lootCheck.ok = lootCheck.gained > 0
    lootCheck.note = lootCheck.note ||
      (lootCheck.ok
        ? `挖 ${lootCheck.tried} 次，收到 ${lootCheck.gained} 个`
        : hasAnyTool
          ? `挖 ${lootCheck.tried} 次，一个都没进包`
          : `挖 ${lootCheck.tried} 次全 +0，但当前是空手（软方块空手也可能不掉落），本次检查不作数`)
    // 空手时不下"环境异常"的结论 —— 那是检查方法本身的问题
    if (!hasAnyTool && !lootCheck.ok) lootCheck.inconclusive = true

    if (lootCheck.ok) {
      console.log(`✅ 环境正常：${lootCheck.note}（样本 ${lootCheck.samples.join(' ')}）`)
    } else if (lootCheck.inconclusive) {
      console.log(`➖ 环境未测出：${lootCheck.note}（样本 ${lootCheck.samples.join(' ')}）`)
    } else {
      console.log(`⚠️  环境异常：${lootCheck.note}（样本 ${lootCheck.samples.join(' ')}）`)
      console.log('   这一轮的"挖石头失败"不能全归到代码上，数据要打折看')
      if (!envWarning) envWarning = '掉落物回收异常（环境问题），本轮数据参考价值低'
    }
  } catch (e) {
    lootCheck.note = '健康检查本身出错: ' + e.message
    console.log(`⚠️  健康检查出错: ${e.message}`)
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
  if (lootCheck) {
    console.log(`环境健康  : ${lootCheck.ok ? '✅ 正常' : '⚠️  异常'} — ${lootCheck.note}`)
    if (!lootCheck.ok) {
      console.log('            （掉落物回收异常时，下面的失败不能全算代码的账）')
    }
  }
  if (envWarning) console.log(`环境警示  : ${envWarning}`)
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
    lootCheck,
    envWarning: envWarning || '',
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
