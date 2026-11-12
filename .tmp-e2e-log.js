#!/usr/bin/env node
'use strict'
/**
 * 端到端测试：他到底能不能做成事？
 *
 * 用法：
 *   node scripts/test-e2e.js                # 跑全部任务
 *   node scripts/test-e2e.js --only 挖石头   # 只跑一个
 *   node scripts/test-e2e.js --account XJJ_E2E
 *
 * 设计原则：
 * 1. **用独立账号**（默认 XJJ_E2E），绝不跟正式运行的 bot 抢登录
 * 2. **每个任务只测一件事**，成功判据是"背包真的变了"，不是"代码没报错"
 * 3. **记录失败原因**，方便定位
 * 4. **可以重复跑**，数据可对比
 *
 * 这个脚本存在的意义：之前 89 项单元测试全绿，实际任务失败率 78%。
 * 因为测的是"函数能不能跑"，不是"能不能做成事"。
 */

const path = require('path')
const fs = require('fs')

const ROOT = __dirname
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))

const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const mcData = require('minecraft-data')('1.21.11')
const { Actions } = require(path.join(ROOT, 'src', 'actions'))

// ---- 参数 ----
const argv = process.argv.slice(2)
const argOf = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
// 每次用全新账号，保证背包是空的、位置是出生点 —— 否则状态累积，数据不可比
const ACCOUNT = argOf('account', 'E2E' + Date.now().toString(36).slice(-6))
const ONLY = argOf('only', null)
const TIMEOUT = parseInt(argOf('timeout', '180'), 10) * 1000

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ==================== 任务定义 ====================
// 每个任务：名字、怎么做、怎么判断成功
const TASKS = [
  {
    name: '移动',
    async run (a, bot) {
      const p0 = a.pos().clone()
      await a.goto(p0.x + 5, p0.y, p0.z + 5, 2, 20000)
      const moved = a.pos().distanceTo(p0)
      return { ok: moved > 3, detail: `移动了 ${moved.toFixed(1)} 格`, need: '>3 格' }
    }
  },
  {
    name: '挖泥土',
    async run (a, bot) {
      const before = a.countOf('dirt')
      // 找最近的泥土/草方块挖
      for (const n of ['dirt', 'grass_block']) {
        const b = a.findBlock(n, 16)
        if (b) { await a.digAt(b); break }
      }
      await sleep(1200)
      const after = a.countOf('dirt')
      return { ok: after > before, detail: `泥土 ${before} -> ${after}`, need: '增加' }
    }
  },
  {
    name: '挖石头',
    async run (a, bot) {
      const before = a.countOf('cobblestone')
      const hasPick = a.checkTools ? a.checkTools().has : false
      if (!hasPick) return { ok: false, detail: '没有镐子，跳过（这本身是个问题）', need: '镐子' }
      try { await a.mine('stone', 3, 20) } catch (e) { /* 让它自己失败 */ }
      await sleep(1000)
      const after = a.countOf('cobblestone')
      return { ok: after > before, detail: `圆石 ${before} -> ${after}`, need: '增加' }
    }
  },
  {
    name: '砍树',
    async run (a, bot) {
      const before = a.woodCount ? a.woodCount() : 0
      try { await a.chopTree(1) } catch (e) { /* 记录结果 */ }
      await sleep(1000)
      const after = a.woodCount ? a.woodCount() : 0
      return { ok: after > before, detail: `原木 ${before} -> ${after}`, need: '增加' }
    }
  },
  {
    name: '做木棍',
    async run (a, bot) {
      const before = a.countOf('stick')
      try { await a.craftSmart('stick', 2) } catch (e) {}
      await sleep(500)
      const after = a.countOf('stick')
      return { ok: after > before, detail: `木棍 ${before} -> ${after}`, need: '增加' }
    }
  },
  {
    name: '放箱子',
    async run (a, bot) {
      const before = a.countOf('chest')
      if (before === 0) {
        try { await a.craftSmart('chest', 1) } catch (e) {}
      }
      if (a.countOf('chest') === 0) return { ok: false, detail: '做不出箱子（没木板）', need: '有箱子' }
      const placed = await a.placeNearby('chest')
      return { ok: !!placed, detail: placed ? '放好了 @' + placed.position : '没放成', need: '放下' }
    }
  },
  {
    name: '从地下爬出来',
    async run (a, bot) {
      const underground = a.isUnderground ? a.isUnderground() : false
      if (!underground) return { ok: true, detail: '本来就在地面，无需爬', need: '在地面' }
      const y0 = a.pos().y
      try { await a.getToSurface(60) } catch (e) {}
      const climbed = a.pos().y - y0
      const out = !a.isUnderground()
      return { ok: out, detail: `y ${y0.toFixed(0)} -> ${a.pos().y.toFixed(0)}（上升 ${climbed.toFixed(0)} 格）`, need: '不在洞穴判定里' }
    }
  },
  {
    name: '找食物',
    async run (a, bot) {
      const before = a.status().food
      try { await a.findFood() } catch (e) {}
      await sleep(1500)
      const after = a.status().food
      const hasFoodItem = (a.foodList ? a.foodList().length : 0) > 0
      return { ok: after > before || hasFoodItem, detail: `饥饿 ${before} -> ${after}，背包有食物: ${hasFoodItem}`, need: '食物增加或有存货' }
    }
  }
]

// ==================== 主流程 ====================
async function main () {
  // 安全检查
  const { execSync } = require('child_process')
  try {
    const running = execSync('ps aux 2>/dev/null | grep -c "[n]ode main.js"', { encoding: 'utf8' }).trim()
    if (running !== '0') {
      console.log(`\n⚠️  检测到 ${running} 个 node main.js 在跑。`)
      console.log('   如果它们用的是同一个账号，会互相踢线，测试数据不可信。')
      console.log(`   本测试用 ${ACCOUNT}，请确认不冲突。\n`)
    }
  } catch (e) {}

  const list = ONLY ? TASKS.filter(t => t.name.includes(ONLY)) : TASKS
  if (!list.length) {
    console.log('没有匹配的任务。可用：', TASKS.map(t => t.name).join('、'))
    process.exit(1)
  }

  console.log(`\n===== 端到端测试 =====`)
  console.log(`账号: ${ACCOUNT}`)
  console.log(`任务数: ${list.length}`)
  console.log(`单任务超时: ${TIMEOUT / 1000}s\n`)

  const bot = mineflayer.createBot({
    host: cfg.bot.host,
    port: cfg.bot.port,
    username: ACCOUNT,
    auth: 'offline',
    version: '1.21.11',
    hideErrors: true
  })

  const results = []
  let kicked = false

  bot.on('kicked', (r) => {
    kicked = true
    console.log('\n❌ 被踢:', JSON.stringify(r).slice(0, 150))
  })
  bot.on('error', (e) => {
    if (!/ECONNRESET|EPIPE/.test(e.message)) console.log('[err]', e.message)
  })

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('连接超时')), 60000)
    bot.once('spawn', () => { clearTimeout(t); resolve() })
  })

  await bot.waitForChunksToLoad().catch(() => {})
  await sleep(2000)

  // 修 mineflayer 的 crafting 注册表问题（这是已知的坑）
  if (!bot.registry.recipes) {
    bot.registry.recipes = mcData.recipes
    bot.registry.items = bot.registry.items || mcData.itemsArray
  }

  // 必须先加载 pathfinder 插件，否则 bot.pathfinder 是 undefined
  try { bot.loadPlugin(pathfinder) } catch (e) {}
  await sleep(500)

  const moves = new Movements(bot)
  moves.canDig = true
  moves.digCost = 20
  moves.allow1by1towers = true
  moves.scafoldingBlocks = ['dirt', 'cobblestone', 'andesite', 'stone', 'gravel']
    .map(n => bot.registry.itemsByName[n]).filter(Boolean).map(i => i.id)
  moves.maxDropDown = 3
  moves.liquidCost = 20
  bot.pathfinder.setMovements(moves)

  const a = new Actions(bot, { log: console.log, cfg })

  console.log(`出生: ${a.pos().x.toFixed(1)}, ${a.pos().y.toFixed(1)}, ${a.pos().z.toFixed(1)}`)
  console.log(`在地下: ${a.isUnderground ? a.isUnderground() : '?'}`)
  console.log(`背包: ${bot.inventory.items().map(i => i.name + 'x' + i.count).join(', ') || '空'}\n`)

  for (let i = 0; i < list.length; i++) {
    if (kicked) break
    const task = list[i]
    process.stdout.write(`[${i + 1}/${list.length}] ${task.name} ... `)

    const t0 = Date.now()
    let r
    try {
      r = await Promise.race([
        task.run(a, bot),
        new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), TIMEOUT))
      ])
    } catch (e) {
      r = { ok: false, detail: e.message, need: '-' }
    }
    const secs = Math.round((Date.now() - t0) / 1000)

    results.push({ name: task.name, ...r, secs })
    console.log(`${r.ok ? '✅' : '❌'} ${secs}s | ${r.detail}`)

    await sleep(800)
  }

  // ==================== 报告 ====================
  const ok = results.filter(r => r.ok).length
  const total = results.length
  const rate = total ? Math.round(ok / total * 100) : 0

  console.log(`\n===== 结果 =====`)
  console.log(`成功 ${ok} / ${total}  成功率 ${rate}%\n`)

  console.log('明细：')
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.name.padEnd(12)} ${String(r.secs).padStart(3)}s  ${r.detail}`)
  }

  // 落盘，方便和下次对比
  const outDir = path.join(ROOT, 'data', 'test-results')
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `e2e-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(outFile, JSON.stringify({
    account: ACCOUNT,
    at: new Date().toISOString(),
    rate, ok, total, results
  }, null, 2))
  console.log(`\n结果已存: ${path.relative(ROOT, outFile)}`)

  try { bot.quit() } catch (e) {}
  await sleep(500)
  process.exit(rate >= 70 ? 0 : 1)
}

main().catch(e => {
  console.error('\n测试崩溃:', e.message)
  process.exit(2)
})
