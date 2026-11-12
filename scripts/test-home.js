#!/usr/bin/env node
'use strict'
/**
 * 家的测试。
 *
 * 分两段：
 *   A. 离线：认家规则、落盘、方位、家附近优先 —— 不连服务器
 *   B. 在线：真连服务器，设家 → 走远 30 格 → goHome() 真寻路走回来
 *
 * 用法：
 *   node scripts/test-home.js              # 全跑（含联机）
 *   node scripts/test-home.js --offline    # 只跑离线
 *   node scripts/test-home.js --away 40    # 走远多少格（默认 30）
 *   node scripts/test-home.js --account X  # 指定账号（默认 HOME<随机>）
 *
 * 原则：用独立账号，绝不跟正在跑的正式 bot 抢登录。
 * 家的数据写到 data/runtime/test-home/，不污染正式的 data/runtime/home.json。
 */

const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))

const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const mcData = require('minecraft-data')('1.21.11')
const { Home, anchorRank, anchorWord } = require(path.join(ROOT, 'src', 'home'))
const { Actions } = require(path.join(ROOT, 'src', 'actions'))

const argv = process.argv.slice(2)
const argOf = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const has = n => argv.includes('--' + n)

const OFFLINE_ONLY = has('offline')
const AWAY = parseInt(argOf('away', '30'), 10)
const ACCOUNT = argOf('account', 'HOME' + Date.now().toString(36).slice(-6).toUpperCase())
const DATA_DIR = path.join(ROOT, 'data', 'runtime', 'test-home')

const sleep = ms => new Promise(r => setTimeout(r, ms))

let pass = 0; let fail = 0
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')) }
}

// ============================================================
// A. 离线
// ============================================================

async function offlineTests () {
  console.log('\n[A1] 什么算家')
  {
    ok(anchorRank('chest') === 2, '箱子 = 家')
    ok(anchorRank('crafting_table') === 1, '工作台 = 家（弱一点）')
    ok(anchorRank('red_bed') === 3, '床 = 家（最强）')
    ok(anchorRank('bed') === 3, '床（旧名）也算')
    ok(anchorRank('stone') === 0, '石头不算家')
    ok(anchorRank('oak_log') === 0, '原木不算家')
    ok(anchorWord('red_bed') === '床', '床的中文叫法')
    ok(anchorWord('crafting_table') === '工作台', '工作台的中文叫法')
  }

  console.log('\n[A2] 认家 + 落盘 + 重载')
  {
    const dir = path.join(os.tmpdir(), 'mcai-home-test-' + Date.now())
    const h = new Home(null, { dataDir: dir, filename: 'home.json', log: () => {} })

    ok(!h.hasHome, '一开始没有家')

    // 模拟"放下了箱子"：直接走 setHome（在线时由 blockPlaced 事件触发同一个函数）
    h.setHome({ x: 100, y: 70, z: -50 }, '放下了箱子', { rank: 2, anchor: 'chest' })
    ok(h.hasHome, '认家了')
    ok(h.home.x === 100 && h.home.y === 70 && h.home.z === -50, '坐标记得对')
    ok(h.home.anchor === 'chest', '记住是什么东西')

    // 新实例从磁盘读回来
    const h2 = new Home(null, { dataDir: dir, filename: 'home.json', log: () => {} })
    ok(h2.hasHome, '重启后还认得家')
    ok(h2.home.x === 100 && h2.home.z === -50, '坐标没丢')

    // 换了更硬的东西（床）在附近 -> 家挪过去
    h2.setHome({ x: 104, y: 70, z: -48 }, '放下了床', { rank: 3, anchor: 'red_bed' })
    ok(h2.home.anchor === 'red_bed', '床盖过箱子')

    fs.rmSync(dir, { recursive: true, force: true })
  }

  console.log('\n[A3] 距离 / 方位 / 优先级')
  {
    const h = new Home(null, { dataDir: path.join(os.tmpdir(), 'mcai-home-t' + Date.now()), log: () => {} })
    h.setHome({ x: 0, y: 64, z: 0 }, '测试', { rank: 9, anchor: 'chest' })

    ok(h.hDistanceFromHome({ x: 30, y: 64, z: 40 }) === 50, '水平距离 = 50')
    ok(h.isNearHome({ x: 10, y: 64, z: 10 }, 48) === true, '17 格内算在家附近')
    ok(h.isNearHome({ x: 200, y: 64, z: 0 }, 48) === false, '200 格不算')
    ok(h.isFarFromHome(96) === false, '在原点不算远')

    // 家在北（z 更小）
    const dirN = h.homeDirection({ x: 0, y: 64, z: 80 })
    ok(dirN.includes('北'), '站在家南边，家在北', `(${dirN})`)
    const dirS = h.homeDirection({ x: 0, y: 64, z: -80 })
    ok(dirS.includes('南'), '站在家北边，家在南', `(${dirS})`)
    const dirE = h.homeDirection({ x: -80, y: 64, z: 0 })
    ok(dirE.includes('东'), '站在家西边，家在东', `(${dirE})`)

    // 家附近优先：离家近的排前面
    const cands = [
      { name: 'far', position: { x: 60, y: 64, z: 0 } },
      { name: 'near', position: { x: 5, y: 64, z: 0 } },
      { name: 'mid', position: { x: 20, y: 64, z: 0 } }
    ]
    const ranked = h.rankByHome(cands)
    ok(ranked[0].name === 'near' && ranked[2].name === 'far', '排序：近的在前', `(${ranked.map(r => r.name).join(' < ')})`)

    ok(h.homeAffinity({ x: 0, y: 64, z: 0 }) === 1, '在家 = 1.0')
    ok(h.homeAffinity({ x: 500, y: 64, z: 0 }) < 0.1, '很远 = 接近 0')

    const s = h.summary()
    ok(/家/.test(s), '能说出一句关于家的话', `"${s}"`)
    fs.rmSync(h.dir, { recursive: true, force: true })
  }

  console.log('\n[A4] 认路（面包屑）')
  {
    const h = new Home(null, { dataDir: path.join(os.tmpdir(), 'mcai-home-t' + Date.now()), log: () => {} })
    h.setHome({ x: 0, y: 64, z: 0 }, '测试', { rank: 9, anchor: 'chest' })

    // 假 bot：位置由测试手动推
    const fake = { entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 0 } }, game: {} }
    h.bot = fake

    // 一步一步往东走 100 格，每 2 格调一次 tick
    for (let x = 0; x <= 100; x += 2) {
      fake.entity.position = { x, y: 64, z: 0 }
      h.tick()
    }
    ok(h.trail.length >= 6 && h.trail.length <= 12, '走了 100 格，记下合理的路标数', `(${h.trail.length} 个)`)
    ok(h.trail[0].x < h.trail[h.trail.length - 1].x, '路标是按顺序记的')

    // 走回家附近 -> 路标清空
    fake.entity.position = { x: 2, y: 64, z: 0 }
    h.tick()
    ok(h.trail.length === 0, '到家附近路标就清了')

    fs.rmSync(h.dir, { recursive: true, force: true })
  }

  console.log('\n[A5] 没有家时的行为')
  {
    const h = new Home(null, { dataDir: path.join(os.tmpdir(), 'mcai-home-t' + Date.now()), log: () => {} })
    ok(h.summary().includes('还没有家'), '没家时如实说没家')
    ok(h.distanceFromHome({ x: 0, y: 0, z: 0 }) === Infinity, '没家时距离是无穷')
    ok(h.findNearHome(['chest']).length === 0, '没家时搜不到东西（不崩）')
    fs.rmSync(h.dir, { recursive: true, force: true })
  }

  console.log('\n[A6] 放下方块时的认家规则（blockPlaced 走的就是这个函数）')
  {
    const mkBot = (x, y, z) => ({
      entity: { position: { x, y, z, distanceTo: (o) => Math.hypot(x - o.x, y - o.y, z - o.z) } },
      game: { dimension: 'minecraft:overworld' }
    })
    const h = new Home(null, { dataDir: path.join(os.tmpdir(), 'mcai-home-t' + Date.now()), log: () => {} })
    h.bot = mkBot(0, 64, 0)

    // 1) 第一次放下工作台 -> 认家
    h.onBlockPlaced({ name: 'crafting_table', position: { x: 1, y: 64, z: 0 } })
    ok(h.hasHome && h.home.anchor === 'crafting_table', '放下工作台就认家')

    // 2) 远处放箱子（25 格外）-> 不改家
    h.bot = mkBot(30, 64, 0)
    const before = h.home.x
    h.onBlockPlaced({ name: 'chest', position: { x: 31, y: 64, z: 0 } })
    ok(h.home.x === before, '远处放箱子不会把家搬走')

    // 3) 家附近放床 -> 家挪到床上（床比工作台硬）
    h.bot = mkBot(2, 64, 0)
    h.onBlockPlaced({ name: 'red_bed', position: { x: 3, y: 64, z: 0 } })
    ok(h.home.anchor === 'red_bed' && h.home.x === 3, '家附近放床，家挪到床上')

    // 4) 远处（>64）放床 -> 换家
    h.bot = mkBot(200, 64, 0)
    h.onBlockPlaced({ name: 'blue_bed', position: { x: 201, y: 64, z: 0 } })
    ok(h.home.x === 201, '远处放床 = 换新家', `(${h.home.x})`)

    // 5) 挖石头不会认家
    const h2 = new Home(null, { dataDir: path.join(os.tmpdir(), 'mcai-home-t' + Date.now()), log: () => {} })
    h2.bot = mkBot(0, 64, 0)
    h2.onBlockPlaced({ name: 'stone', position: { x: 1, y: 64, z: 0 } })
    h2.onBlockPlaced({ name: 'oak_planks', position: { x: 1, y: 64, z: 1 } })
    ok(!h2.hasHome, '石头/木板不算家')

    // 6) 离自己太远的位置（比如别人放的）忽略
    const h3 = new Home(null, { dataDir: path.join(os.tmpdir(), 'mcai-home-t' + Date.now()), log: () => {} })
    h3.bot = mkBot(0, 64, 0)
    h3.onBlockPlaced({ name: 'chest', position: { x: 90, y: 64, z: 0 } })
    ok(!h3.hasHome, '离自己 90 格的箱子不当家')

    for (const x of [h, h2, h3]) fs.rmSync(x.dir, { recursive: true, force: true })
  }

  console.log('\n[A7] 回家失败时会不会退到"认路"')
  {
    // 用一个假 bot：位置能读能写，寻路结果由 _walkTo 的桩决定
    const mk = (homePos, at) => {
      const h = new Home(null, { dataDir: path.join(os.tmpdir(), 'mcai-home-t' + Date.now()), log: () => {} })
      h.setHome(homePos, '测试', { rank: 9, anchor: 'chest' })
      const pos = { x: at.x, y: at.y, z: at.z, clone () { return { x: this.x, y: this.y, z: this.z } } }
      h.bot = { entity: { position: pos }, game: {}, setControlState () {}, pathfinder: { setGoal () {} } }
      // 出门的路：离家 40 → 20
      h.trail = [
        { x: homePos.x + 20, y: homePos.y, z: homePos.z, t: 1 },
        { x: homePos.x + 40, y: homePos.y, z: homePos.z, t: 2 }
      ]
      return { h, pos }
    }

    // 情况 1：直线走不通，路标能走通 -> 应该出现 trail 这一段
    {
      const { h, pos } = mk({ x: 0, y: 64, z: 0 }, { x: 40, y: 64, z: 0 })
      const calls = []
      h._walkTo = async (x, y, z, o) => {
        calls.push({ x, z, xz: !!(o && o.xz) })
        if (calls.length === 1) return { ok: false, reason: '直线走不通' }
        // 之后每走一次就往家靠
        pos.x = Math.min(pos.x, 20)
        return { ok: true, dist: Math.hypot(pos.x, pos.z) }
      }
      await h.goHome({ timeoutMs: 20000 })
      const names = h.stats && calls.length ? calls.map(c => `${c.x},${c.z}`) : []
      ok(calls.length >= 2, '直线失败后会继续试别的路', `(共 ${calls.length} 次寻路)`)
      ok(names.some(s => s.startsWith('20,') || s.startsWith('40,')), '用上了出门记的路标', `(${names.join(' | ')})`)
    }

    // 情况 2：全部走不通 -> 明确报失败，不能假装成功
    {
      const { h } = mk({ x: 0, y: 64, z: 0 }, { x: 40, y: 64, z: 0 })
      h._walkTo = async () => ({ ok: false, reason: '走不通' })
      const r = await h.goHome({ timeoutMs: 20000 })
      ok(r.ok === false, '走不回去时如实返回失败')
      ok(typeof r.reason === 'string' && r.reason.length > 0, '失败要带原因', `(${r.reason})`)
    }

    // 情况 3：已经在家里 -> 直接成功，不该白跑一趟
    {
      const { h } = mk({ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 1 })
      let called = 0
      h._walkTo = async () => { called++; return { ok: true } }
      const r = await h.goHome()
      ok(r.ok === true && called === 0, '已经在家就不动', `(寻路 ${called} 次)`)
    }

    // 情况 4：没设家 -> 报错而不是乱走
    {
      const h = new Home(null, { dataDir: path.join(os.tmpdir(), 'mcai-home-t' + Date.now()), log: () => {} })
      h.bot = { entity: { position: { x: 0, y: 64, z: 0 } }, game: {} }
      let called = 0
      h._walkTo = async () => { called++; return { ok: true } }
      const r = await h.goHome()
      ok(r.ok === false && called === 0, '没家时不会瞎走', `(${r.reason})`)
    }
  }
}

// ============================================================
// B. 联机
// ============================================================

async function liveTest () {
  console.log('\n[B] 联机实测')
  console.log(`  账号: ${ACCOUNT}`)
  console.log(`  服务器: ${cfg.bot.host}:${cfg.bot.port}`)
  console.log(`  目标: 设家 → 走远 ${AWAY} 格 → goHome() 走回来\n`)

  const bot = mineflayer.createBot({
    host: cfg.bot.host,
    port: cfg.bot.port,
    username: ACCOUNT,
    auth: 'offline',
    version: '1.21.11',
    hideErrors: true
  })

  let kicked = false
  bot.on('kicked', r => { kicked = true; console.log('  ❌ 被踢:', JSON.stringify(r).slice(0, 200)) })
  bot.on('error', e => { if (!/ECONNRESET|EPIPE|PartialRead/.test(e.message)) console.log('  [err]', e.message) })
  bot.on('end', r => { if (!kicked) console.log('  [end]', r) })

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('连接超时 60s')), 60000)
    bot.once('spawn', () => { clearTimeout(t); resolve() })
  })

  await bot.waitForChunksToLoad().catch(() => {})
  await sleep(1500)

  if (!bot.registry.recipes) {
    bot.registry.recipes = mcData.recipes
    bot.registry.items = bot.registry.items || mcData.itemsArray
  }
  try { bot.loadPlugin(pathfinder) } catch (e) {}
  await sleep(400)

  // 跟 main.js 一样的寻路配置
  const moves = new Movements(bot)
  moves.canDig = true
  moves.digCost = 20
  moves.allow1by1towers = true
  moves.scafoldingBlocks = ['dirt', 'cobblestone', 'andesite', 'stone', 'gravel']
    .map(n => bot.registry.itemsByName[n]).filter(Boolean).map(i => i.id)
  moves.maxDropDown = 3
  moves.liquidCost = 20
  bot.pathfinder.setMovements(moves)

  const actions = new Actions(bot, { log: () => {}, cfg })

  fs.mkdirSync(DATA_DIR, { recursive: true })
  const home = new Home(bot, {
    dataDir: DATA_DIR,
    filename: 'home.json',
    log: s => console.log('  ' + s),
    actions
  })
  // 每次从零开始，避免上一次的残留影响数据
  home.clear()
  home.attach()

  const P0 = bot.entity.position.clone()
  console.log(`  出生: ${fmt(P0)}`)

  // ---- 1. 设家 ----
  home.setHome(P0, '测试设的家', { rank: 9, anchor: 'chest' })
  ok(home.hasHome, '设家成功', `(${home.home.x},${home.home.y},${home.home.z})`)

  // ---- 2. 走远 ----
  console.log(`\n  → 往远处走 ${AWAY} 格（真寻路，不是瞬移）`)
  const walkT0 = Date.now()
  let far = P0.clone()
  const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1]]
  let bestDist = 0
  for (let i = 0; i < dirs.length && bestDist < AWAY; i++) {
    const [dx, dz] = dirs[i]
    const tx = P0.x + dx * AWAY
    const tz = P0.z + dz * AWAY
    try {
      await actions.goto(tx, bot.entity.position.y, tz, 3, 60000)
    } catch (e) {}
    const p = bot.entity.position
    const d = Math.hypot(p.x - P0.x, p.z - P0.z)
    if (d > bestDist) { bestDist = d; far = p.clone() }
    if (kicked) break
  }
  const walkSecs = Math.round((Date.now() - walkT0) / 100) / 10
  const awayDist = Math.hypot(bot.entity.position.x - P0.x, bot.entity.position.z - P0.z)
  console.log(`  走到: ${fmt(bot.entity.position)}  离家 ${awayDist.toFixed(1)} 格  用时 ${walkSecs}s`)

  // 路标应该记下来了
  home.tick()
  ok(home.trail.length > 0, '走远了会记路', `(${home.trail.length} 个路标)`)
  ok(home.hDistanceFromHome() > 10, '确实走远了', `(${home.hDistanceFromHome().toFixed(1)} 格)`)

  // ---- 3. 回家 ----
  console.log('\n  → goHome()（真寻路走回来）')
  const t0 = Date.now()
  const r = await home.goHome({ timeoutMs: 180000 })
  const secs = Math.round((Date.now() - t0) / 100) / 10

  console.log(`  结果: ${r.ok ? '✅ 到家' : '❌ 没到家'}  用时 ${secs}s  离家 ${Number(r.dist).toFixed(1)} 格`)
  for (const leg of (r.legs || [])) {
    console.log(`    · ${leg.name.padEnd(10)} ${leg.ok ? 'ok' : 'fail'} ${String(leg.seconds).padStart(6)}s ${leg.reason || ''}`)
  }

  ok(r.ok, 'goHome() 能走回家', `还差 ${Number(r.dist).toFixed(1)} 格`)
  ok(secs > 1, '是走过去的花了时间（不是瞬移）', `${secs}s`)
  ok(home.hDistanceFromHome() <= 5, '最终就在家边上', `${home.hDistanceFromHome().toFixed(1)} 格`)

  // ---- 4. 到家后路标该清空 ----
  home.tick()
  ok(home.trail.length === 0, '到家后路标清空', `(${home.trail.length})`)

  // ---- 5. 落盘检查 ----
  const saved = path.join(DATA_DIR, 'home.json')
  ok(fs.existsSync(saved), '家记在 data/runtime 下', path.relative(ROOT, saved))
  try {
    const d = JSON.parse(fs.readFileSync(saved, 'utf8'))
    ok(d.home && d.home.x === home.home.x, '磁盘上的坐标和内存一致')
  } catch (e) { ok(false, '磁盘文件能读', e.message) }

  const out = {
    account: ACCOUNT,
    at: new Date().toISOString(),
    home: home.home,
    spawn: { x: P0.x, y: P0.y, z: P0.z },
    away: { x: far.x, y: far.y, z: far.z, dist: Math.round(awayDist * 10) / 10, walkSecs },
    goHome: { ok: r.ok, seconds: secs, finalDist: Math.round(Number(r.dist) * 10) / 10, legs: r.legs },
    trailAfter: home.trail.length
  }
  const outFile = path.join(ROOT, 'data', 'test-results', `home-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2))
  console.log(`\n  结果已存: ${path.relative(ROOT, outFile)}`)

  home.detach()
  try { bot.quit() } catch (e) {}
  await sleep(400)

  return out
}

function fmt (p) {
  return `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`
}

// ============================================================

async function main () {
  console.log('===== 家的测试 =====')
  await offlineTests()

  let live = null
  if (!OFFLINE_ONLY) {
    try {
      live = await liveTest()
    } catch (e) {
      console.log('\n  ⚠️ 联机段没跑成：' + e.message)
      console.log('  （离线段结果仍然有效）')
    }
  }

  console.log(`\n===== 结果 =====`)
  console.log(`断言：${pass} 通过，${fail} 失败`)
  if (live) {
    console.log(`联机：离家 ${live.away.dist} 格 → goHome ${live.goHome.seconds}s → 还差 ${live.goHome.finalDist} 格 ${live.goHome.ok ? '✅' : '❌'}`)
  }
  process.exit(fail ? 1 : 0)
}

main().catch(e => {
  console.error('\n测试崩了：', e && e.stack || e)
  process.exit(2)
})
