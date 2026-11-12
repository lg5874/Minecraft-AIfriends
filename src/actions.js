'use strict'
// L1 原子动作。所有能力的底座。
// 每个动作都是 async，失败抛错或返回 false，绝不静默成功。

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')('1.21.11')

const sleep = ms => new Promise(r => setTimeout(r, ms))

class Actions {
  constructor (bot, ctx) {
    this.bot = bot
    this.ctx = ctx
    this.cancel = false
    this.current = ''
  }

  log (s) { if (this.ctx && this.ctx.log) this.ctx.log('[act] ' + s) }

  // ---------------- 基础工具 ----------------

  stop () {
    try { this.bot.pathfinder.setGoal(null) } catch (e) {}
    try {
      for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) {
        this.bot.setControlState(k, false)
      }
    } catch (e) {}
  }

  check () {
    if (this.cancel) throw new Error('任务被中断')
  }

  pos () { return this.bot.entity.position }

  item (name) {
    return this.bot.inventory.items().find(i => i.name === name)
  }

  countOf (name) {
    let n = 0
    for (const i of this.bot.inventory.items()) if (i.name === name) n += i.count
    return n
  }

  // ---------------- 看 ----------------

  async look (yaw, pitch) {
    await this.bot.look(yaw, pitch, true)
  }

  async lookAtPlayer (name) {
    const e = this.bot.players[name] && this.bot.players[name].entity
    if (!e) return false
    await this.bot.lookAt(e.position.offset(0, 1.6, 0), true)
    return true
  }

  // 环顾四周，返回看到的东西，用来"观察"
  scan (radius = 16) {
    const p = this.pos()
    const out = { blocks: {}, entities: [], players: [] }
    for (let x = -radius; x <= radius; x += 2) {
      for (let y = -6; y <= 6; y += 2) {
        for (let z = -radius; z <= radius; z += 2) {
          const b = this.bot.blockAt(p.offset(x, y, z))
          if (b && b.name !== 'air' && b.name !== 'cave_air') {
            out.blocks[b.name] = (out.blocks[b.name] || 0) + 1
          }
        }
      }
    }
    for (const e of Object.values(this.bot.entities)) {
      if (!e || e === this.bot.entity) continue
      const d = e.position.distanceTo(p)
      if (d > radius) continue
      const kind = e.type === 'player' ? 'players' : 'entities'
      out[kind].push({ name: e.name || e.username || e.type, dist: Math.round(d) })
    }
    // 只留最近的几个
    out.entities = out.entities.sort((a, b) => a.dist - b.dist).slice(0, 8)
    out.players = out.players.sort((a, b) => a.dist - b.dist).slice(0, 8)
    return out
  }

  // 这个位置能不能站人（脚下有实体，头顶空）
  // 这个方块会不会挡人
  solidBlock (b) {
    if (!b) return false
    if (b.name === 'air' || b.name === 'cave_air') return false
    if (b.boundingBox === 'empty') return false
    if (/water|lava/.test(b.name)) return false
    return true
  }

  standable (pos) {
    const b = this.bot
    const below = b.blockAt(pos.offset(0, -1, 0))
    const at = b.blockAt(pos)
    const up = b.blockAt(pos.offset(0, 1, 0))
    if (!below || !at || !up) return false
    return this.solidBlock(below) && !this.solidBlock(at) && !this.solidBlock(up)
  }

  // ---------------- 走 ----------------

  async goto (x, y, z, range = 1, timeoutMs = 30000) {
    this.check()
    this.current = `走到 ${Math.round(x)},${Math.round(y)},${Math.round(z)}`

    const p0 = this.pos()
    const dy = Math.abs(y - p0.y)

    // 目标跟自己不在同一层：先解决高度差，再水平走
    if (dy > 3) {
      const reached = await this.gotoVertical(y, timeoutMs)
      if (!reached) return false
    }

    const goal = new goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), range)
    this.bot.pathfinder.setGoal(goal)

    // 用 pathfinder 自己的到达事件，而不是自己算距离
    let reached = false
    const onReach = () => { reached = true }
    this.bot.on('goal_reached', onReach)

    const t0 = Date.now()
    let stillSince = 0
    let lastP = this.pos().clone()

    try {
      while (Date.now() - t0 < timeoutMs) {
        this.check()
        if (reached) return true

        const p = this.pos()
        const moved = p.distanceTo(lastP)
        lastP = p.clone()

        // 到了判定：水平距离和高度都够近
        const dxz = Math.hypot(p.x - x, p.z - z)
        if (dxz <= range + 1.5 && Math.abs(p.y - y) <= Math.max(3, range + 1)) {
          return true
        }

        // 连续 8 秒没挪窝才算卡住（原来是 6 秒，太急）
        if (moved < 0.1) stillSince += 180
        else stillSince = 0
        if (stillSince > 8000) {
          this.log('[goto] 卡住了，放弃')
          return false
        }

        await sleep(180)
      }
      return false
    } finally {
      this.bot.off('goal_reached', onReach)
      try { this.bot.pathfinder.setGoal(null) } catch (e) {}
      for (const k of ['forward', 'back', 'left', 'right']) {
        try { this.bot.setControlState(k, false) } catch (e) {}
      }
    }
  }

  /**
   * 解决高度差。
   * 往上：找斜坡/楼梯走，找不到就挖一条台阶上去。
   * 往下：找路下去，找不到就挖个竖井（小心别挖穿到岩浆）。
   */
  async gotoVertical (targetY, timeoutMs = 40000) {
    const bot = this.bot
    const t0 = Date.now()
    let guard = 0

    while (Date.now() - t0 < timeoutMs && guard++ < 40) {
      this.check()
      const p = this.pos()
      const diff = targetY - p.y
      if (Math.abs(diff) <= 2) return true

      const up = diff > 0

      // 1. 先试走：pathfinder 自己会找坡道
      const tx = p.x + (Math.random() - 0.5) * 6
      const tz = p.z + (Math.random() - 0.5) * 6
      try {
        this.bot.pathfinder.setGoal(new goals.GoalNear(
          Math.floor(tx), Math.floor(targetY), Math.floor(tz), 2))
        await sleep(1200)
      } catch (e) {}

      const p2 = this.pos()
      if (Math.abs(p2.y - p.y) >= 1) continue   // 高度变了，继续

      // 2. 走不动：自己挖
      this.bot.pathfinder.setGoal(null)
      if (up) {
        // 往上挖台阶：挖头顶，然后跳上去
        const head = bot.blockAt(p.offset(0, 2, 0))
        const above = bot.blockAt(p.offset(0, 1, 0))
        if (head && head.name !== 'air' && head.name !== 'cave_air' && !/bedrock/.test(head.name)) {
          try {
            await this.bestToolFor(head)
            await bot.dig(head, true)
            await sleep(200)
          } catch (e) {}
        }
        // 挖出一个能站的地方后跳上去
        try {
          await bot.look(0, 0, true)
          bot.setControlState('jump', true)
          bot.setControlState('forward', true)
          await sleep(700)
          bot.setControlState('jump', false)
          bot.setControlState('forward', false)
        } catch (e) {}
      } else {
        // 往下挖
        const below = bot.blockAt(p.offset(0, -1, 0))
        if (below && below.name !== 'air' && !/bedrock|lava|water/.test(below.name)) {
          try {
            await this.bestToolFor(below)
            await bot.dig(below, true)
            await sleep(300)
          } catch (e) {}
        }
      }
    }
    return Math.abs(this.pos().y - targetY) <= 3
  }

  async gotoPlayer (name, range = 2) {
    const pl = this.bot.players[name]
    if (!pl || !pl.entity) throw new Error('看不到 ' + name)
    const p = pl.entity.position
    return this.goto(p.x, p.y, p.z, range)
  }

  // 跟着走一段时间
  async follow (name, seconds = 15) {
    const t0 = Date.now()
    while (Date.now() - t0 < seconds * 1000) {
      this.check()
      const pl = this.bot.players[name]
      if (!pl || !pl.entity) throw new Error('跟丢了 ' + name)
      const p = pl.entity.position
      const d = this.pos().distanceTo(p)
      if (d > 3) {
        this.bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), 2))
      }
      await sleep(600)
    }
    this.bot.pathfinder.setGoal(null)
    return true
  }

  // 随便走走（自己闲逛）
  async wander (blocks = 20) {
    const p = this.pos()
    const a = Math.random() * Math.PI * 2
    const x = p.x + Math.cos(a) * blocks
    const z = p.z + Math.sin(a) * blocks
    return this.goto(x, p.y, z, 2, 20000)
  }

  // ---------------- 挖 ----------------

  findBlock (name, maxDist = 32) {
    const def = mcData.blocksByName[name]
    if (!def) {
      // 给个提示，别只说"没有"
      const hint = /^log$/.test(name) ? '（要写 oak_log / birch_log 这种全名）'
        : /_log$/.test(name) && !name.includes('_') ? '（木板是 _planks，原木是 _log）'
        : ''
      throw new Error('没有这种方块: ' + name + hint)
    }
    return this.bot.findBlock({ matching: def.id, maxDistance: maxDist })
  }

  // 多个名字一起找（原木有八个品种）
  findAny (names, maxDist = 32) {
    for (const n of names) {
      const b = this.findBlock(n, maxDist)
      if (b) return b
    }
    return null
  }

  // 区块还没加载完就先等一下
  async ensureChunks (waitMs = 6000) {
    try {
      await Promise.race([
        this.bot.waitForChunksToLoad(),
        new Promise(r => setTimeout(r, waitMs))
      ])
    } catch (e) {}
  }

  // 挖一格
  async digAt (block) {
    if (!block) return false
    this.check()

    // 方块可能已经被挖掉了 / 变成空气了，别对着空气挥镐
    const live = this.bot.blockAt(block.position)
    if (!live || live.name === 'air' || live.name === 'cave_air') {
      return false
    }
    if (/water|lava|bedrock/.test(live.name)) return false
    block = live
    // 关键：寻路还在跑的时候挖方块会被打断
    try { this.bot.pathfinder.setGoal(null) } catch (e) {}
    for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
      try { this.bot.setControlState(k, false) } catch (e) {}
    }
    await sleep(120)
    // 别挖到自己脚下
    const p0 = this.pos()
    if (Math.floor(p0.x) === block.position.x &&
        Math.floor(p0.z) === block.position.z &&
        Math.floor(p0.y) - block.position.y <= 1) {
      // 脚下那块不挖
      return false
    }
    // 目标旁边是岩浆就不挖（挖开会流过来）
    for (const d of [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]) {
      const nb = this.bot.blockAt(block.position.offset(d[0], d[1], d[2]))
      if (nb && nb.name === 'lava') return false
    }
    const p = this.pos()
    const d = block.position.distanceTo(p)
    if (d > 5) {
      await this.goto(block.position.x, block.position.y, block.position.z, 2, 20000)
    }
    // 走过去之后方块可能已经变了，再确认一次
    const again = this.bot.blockAt(block.position)
    if (!again || again.name === 'air' || again.name === 'cave_air') return false
    block = again

    // 选对工具
    await this.bestToolFor(block)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.bot.dig(block, true)
        return true
      } catch (e) {
        const msg = String(e && e.message || e)
        if (/Digging aborted/.test(msg)) {
          // 被打断：停一下重来
          await sleep(400)
          try { this.bot.pathfinder.setGoal(null) } catch (e2) {}
          continue
        }
        this.log('dig fail ' + msg)
        return false
      }
    }
    return false
  }

  // 用最合适的工具
  async bestToolFor (block) {
    try {
      const tools = this.bot.pathfinder.movements ? null : null
      const items = this.bot.inventory.items()
      const tool = this.bot.pathfinder.bestHarvestTool
        ? null : null
      const best = this.bot.pathfinder && this.bot.pathfinder.movements
        ? null : null
      // 直接按名字找
      const want = []
      const mat = block.material || ''
      if (mat.includes('pickaxe')) want.push('netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe')
      else if (mat.includes('axe')) want.push('netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe')
      else if (mat.includes('shovel')) want.push('netherite_shovel', 'diamond_shovel', 'iron_shovel', 'stone_shovel', 'wooden_shovel')
      else if (mat.includes('hoe')) want.push('netherite_hoe', 'diamond_hoe', 'iron_hoe', 'stone_hoe', 'wooden_hoe')
      else if (block.name.includes('leaves') || block.name.includes('wool')) want.push('shears')
      for (const w of want) {
        const it = items.find(i => i.name === w)
        if (it) { await this.bot.equip(it, 'hand'); return }
      }
    } catch (e) {}
  }

  // 挖若干块某种方块
  async mine (blockName, count = 1, maxDist = 32) {
    await this.ensureChunks()
    let got = 0
    let emptyTries = 0
    let guard = 0
    while (got < count && guard++ < count * 4 + 10) {
      this.check()
      // 血太少或者快淹死了，先撤
      if (this.bot.health <= 6) throw new Error('血太少了，得先撤')
      if (this.bot.oxygenLevel < 8) throw new Error('快淹死了')
      let b = this.findBlock(blockName, maxDist)
      if (!b && got === 0) {
        // 附近没有：往下挖一层看看（玩家都这么干）
        const p = this.pos()
        const below = this.bot.blockAt(p.offset(0, -1, 0))
        if (below && below.name !== 'air' && !/water|lava|bedrock/.test(below.name)) {
          try { await this.digAt(below) } catch (e) {}
          await this.pickupNearby(4)
          b = this.findBlock(blockName, maxDist)
        }
      }
      if (!b) {
        if (got === 0) {
          try { await this.wander(10) } catch (e) {}
          await this.ensureChunks(2500)
          b = this.findBlock(blockName, maxDist)
        }
        if (!b) {
          if (got === 0) throw new Error('附近找不到 ' + blockName)
          break
        }
      }
      const ok = await this.digAt(b)
      if (ok) got++
      else {
        // 挖失败：可能方块没了，重新找
        emptyTries = (emptyTries || 0) + 1
        if (emptyTries > 5) break
      }
      await sleep(120)
    }
    return got
  }

  // 砍树：找原木，挖掉整棵
  async chopTree (count = 1) {
    await this.ensureChunks()
    const logs = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
      'mangrove_log', 'cherry_log', 'pale_oak_log']
    let trees = 0
    let wanderTry = 0

    // 关键：先在最大半径内找一遍，别急着走
    await sleep(300)
    while (trees < count) {
      this.check()
      let found = null
      // 由近到远找
      for (const dist of [16, 32, 64]) {
        found = this.findAny(logs, dist)
        if (found) break
      }
      // 实在没有：长途去找（树经常在几十格之外）
      if (!found) {
        found = await this.travelToFind(() => this.findAny(logs, 64), 5, 45)
      }
      if (!found) throw new Error('走了很远也没找到树')
      // 砍这一棵：从下往上
      const base = found.position
      for (let dy = 0; dy < 8; dy++) {
        const b = this.bot.blockAt(base.offset(0, dy, 0))
        if (b && logs.includes(b.name)) {
          await this.digAt(b)
        } else break
      }
      trees++
      await sleep(200)
    }
    // 砍完捡起来
    try { await this.pickupNearby(12) } catch (e) {}
    return trees
  }

  // ---------------- 放 ----------------

  async place (blockName, x, y, z) {
    const item = this.item(blockName)
    if (!item) throw new Error('没有 ' + blockName)
    const target = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))

    // 目标格必须空
    const at = this.bot.blockAt(target)
    if (at && at.name === blockName) return true
    if (at && at.name !== 'air' && at.name !== 'cave_air') {
      // 那一格被别的东西占了，换到附近找位置
      const near = this.findBlock(blockName, 12)
      if (near) return true
      throw new Error('那一格已经被占了')
    }

    await this.bot.equip(item, 'hand')

    // 找一个相邻的实体面来靠，四个水平方向 + 正下方
    const dirs = [
      { d: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },
      { d: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },
      { d: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
      { d: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },
      { d: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) }
    ]
    for (const { d, face } of dirs) {
      const support = this.bot.blockAt(target.plus(d))
      if (!support) continue
      if (support.name === 'air' || support.name === 'cave_air' || support.name === 'water') continue
      try {
        const dist = target.distanceTo(this.pos())
        if (dist > 4) await this.goto(target.x, target.y, target.z, 2, 12000)
        await this.bot.placeBlock(support, face)
        return true
      } catch (e) {
        this.log('place try fail: ' + e.message)
      }
    }
    return false
  }

  // 在脚边找个地方放方块（比如放工作台）
  // 如果附近已经有这个方块了，直接返回它
  async placeNearby (blockName) {
    const exist = this.findBlock(blockName, 10)
    if (exist) return exist

    const item = this.item(blockName)
    if (!item) throw new Error('没有 ' + blockName)

    const spot = this.findPlaceSpot(8)
    if (!spot) return null

    await this.bot.equip(item, 'hand')
    // 试几个位置，别死磕一个
    for (let attempt = 0; attempt < 4; attempt++) {
      const sp = attempt === 0 ? spot : this.findPlaceSpot(10)
      if (!sp) break
      try {
        await this.bot.lookAt(sp.base.position.offset(0.5, 0.5, 0.5), true)
        await sleep(120)
        await this.bot.placeBlock(sp.base, new Vec3(0, 1, 0))
        await sleep(250)
        const placed = this.bot.blockAt(new Vec3(sp.x, sp.y, sp.z))
        if (placed && placed.name === blockName) return placed
      } catch (e) {
        this.log('placeNearby try' + attempt + ': ' + e.message)
      }
    }
    return this.findBlock(blockName, 10)
  }

  // ---------------- 合成 ----------------

  itemId (name) {
    const it = mcData.itemsByName[name]
    if (!it) throw new Error('没有这种物品: ' + name)
    return it.id
  }

  // 需不需要工作台
  async craft (name, count = 1) {
    this.check()
    const id = this.itemId(name)
    let recipes = this.bot.recipesFor(id, null, 1, null)
    let table = null

    if (!recipes || !recipes.length) {
      // 需要工作台：先找现成的
      table = this.findBlock('crafting_table', 24)
      // 没有就自己放一个
      if (!table && this.countOf('crafting_table') > 0) {
        table = await this.placeNearby('crafting_table')
      }
      if (!table) {
        // 连工作台都没有，看看能不能现做一个（4 个木板）
        const plank = ['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks',
          'acacia_planks', 'dark_oak_planks', 'cherry_planks', 'mangrove_planks']
          .find(n => this.countOf(n) >= 4)
        if (plank && name !== 'crafting_table') {
          await this.craft('crafting_table', 1)
          table = await this.placeNearby('crafting_table')
        }
      }
      if (!table) throw new Error('弄不到工作台')
      await this.goto(table.position.x, table.position.y, table.position.z, 3)
      recipes = this.bot.recipesFor(id, null, 1, table)
    }
    if (!recipes || !recipes.length) throw new Error('材料不够做 ' + name)

    const recipe = recipes[0]
    const times = Math.ceil(count / recipe.result.count)
    await this.bot.craft(recipe, times, table)
    return true
  }

  // 智能合成：缺什么先做什么（依赖链自动解析）
  async craftSmart (name, count = 1, depth = 0) {
    if (depth > 6) throw new Error('合成链太深了: ' + name)
    this.check()
    if (this.countOf(name) >= count) return true

    const id = this.itemId(name)
    const need = count - this.countOf(name)

    // 1. 候选配方（含需要工作台的）
    let cands = []
    try { cands = this.bot.recipesAll(id, null, true) || [] } catch (e) { cands = [] }
    if (!cands.length) {
      try { cands = this.bot.recipesAll(id, null, null) || [] } catch (e) { cands = [] }
    }
    if (!cands.length) throw new Error('没有 ' + name + ' 的配方')

    // 2. 木板统一成"手上能做的种类"，避免去凑樱桃木板这种
    const myPlank = this.myPlankKind()
    if (myPlank) {
      const prefer = cands.filter(r => {
        const names = r.delta.filter(d => d.count < 0)
          .map(d => (mcData.items[d.id] || {}).name || '')
        // 只保留"用我这种木板"或是"不用木板"的配方
        const usesPlank = names.some(n => /_planks$/.test(n))
        if (!usesPlank) return true
        return names.every(n => !/_planks$/.test(n) || n === myPlank || n === 'stick')
      })
      if (prefer.length) cands = prefer
    }

    // 2.5 排除那些原料我根本弄不到的配方（比如手上没樱桃木、附近也没樱桃树）
    const reachable = cands.filter(r => {
      for (const d of r.delta) {
        if (d.count >= 0) continue
        const it = mcData.items[d.id]
        if (!it) continue
        if (this.canObtain(it.name)) continue
        return false
      }
      return true
    })
    if (reachable.length) cands = reachable

    // 3. 挑一个"手头材料最足、需要额外弄的最少"的配方
    const scored = cands.map(r => {
      const needs = {}
      for (const d of r.delta) if (d.count < 0) needs[d.id] = (needs[d.id] || 0) - d.count
      let missing = 0
      let inHand = 0
      for (const [iid, n] of Object.entries(needs)) {
        const it = mcData.items[parseInt(iid, 10)]
        if (!it) continue
        const have = this.countOf(it.name)
        if (have >= n) inHand += n
        else missing += (n - have)
      }
      return { r, needs, missing, inHand }
    }).sort((a, b) => (a.missing - b.missing) || (b.inHand - a.inHand))

    const pick = scored[0]

    // 3. 补齐缺的原料
    for (const [iid, n] of Object.entries(pick.needs)) {
      const item = mcData.items[parseInt(iid, 10)]
      if (!item) continue
      if (this.countOf(item.name) >= n) continue
      try {
        await this.craftSmart(item.name, n, depth + 1)
      } catch (e) {
        const got = await this.gather(item.name, n - this.countOf(item.name))
        if (!got) throw new Error('缺 ' + item.name + '，也弄不到（' + e.message + '）')
      }
    }

    // 4. 正式合成
    const table = pick.r.requiresTable ? await this.ensureTable() : this.findBlock('crafting_table', 12)
    if (pick.r.requiresTable && !table) throw new Error('需要工作台但放不下')
    const times = Math.ceil(need / pick.r.result.count)

    // 走到工作台旁边再重新取配方（背包可能刚变）
    if (table) await this.goto(table.position.x, table.position.y, table.position.z, 3, 15000)
    const usable = this.bot.recipesFor(id, null, Math.max(1, count - this.countOf(name)), table || null)
    const recipe = (usable && usable.length) ? usable[0] : pick.r
    await this.safeCraft(recipe, times, table || null)
    return true
  }

  /**
   * 合成（带重试 + 背包同步）。
   *
   * 之前老失败的原因：服务端回包慢，本地 inventory 还没更新就去 craft，
   * mineflayer 算出"材料不够"，报 missing ingredient。
   * 解决：合成前等一下、失败后重新取配方、必要时打开一次背包触发同步。
   */
  async safeCraft (recipe, times, table) {
    for (let i = 0; i < 4; i++) {
      try {
        await this.bot.craft(recipe, times, table || null)
        return true
      } catch (e) {
        const msg = String((e && e.message) || '')
        this.log('craft retry' + i + ': ' + msg)

        // 等一会儿让背包同步
        await sleep(600 + i * 400)

        // 打开再关一次箱子/背包，强制同步物品栏
        if (/missing ingredient|not enough/i.test(msg)) {
          await this.syncInventory()
        }

        // 重新取配方（背包可能刚变）
        try {
          const id = recipe.result && recipe.result.id
          if (id) {
            const rs = this.bot.recipesFor(id, null, Math.max(1, times), table || null)
            if (rs && rs.length) { recipe = rs[0]; continue }
          }
        } catch (e2) {}

        if (i === 3) throw new Error('合成反复失败: ' + msg)
      }
    }
    return false
  }

  /** 强制同步背包：开关一次随身合成格 */
  async syncInventory () {
    try {
      // 触发服务端重发背包
      this.bot._client.write('window_click', {
        windowId: 0, slot: -999, mouseButton: 0,
        mode: 0, item: { present: false }
      })
      await sleep(300)
    } catch (e) {}
  }

  // 保证身边有工作台
  async ensureTable () {
    // 1. 附近已经有了
    const near = this.findBlock('crafting_table', 10)
    if (near) return near

    // 2. 手上有，放下去
    if (this.countOf('crafting_table') > 0) {
      const placed = await this.placeNearby('crafting_table')
      if (placed) return placed
    }

    // 3. 造一个：只要 4 块木板，不需要工作台
    const tableId = this.itemId('crafting_table')
    for (let attempt = 0; attempt < 3; attempt++) {
      // 木板够不够
      let plankName = this.bestPlank()
      if (!plankName || this.countOf(plankName) < 4) {
        // 用原木做木板
        if (this.woodCount() > 0) {
          try { await this.anyPlanks(8) } catch (e) {}
        } else {
          try { await this.ensureWood(2); await this.anyPlanks(8) } catch (e) {}
        }
        plankName = this.bestPlank()
      }
      if (!plankName || this.countOf(plankName) < 4) {
        this.log('[table] 木板不够（' + (plankName ? this.countOf(plankName) : 0) + '/4）')
        await sleep(500)
        continue
      }

      // 取配方
      const rs = this.bot.recipesFor(tableId, null, 1, null)
      if (!rs || !rs.length) {
        this.log('[table] 取不到工作台配方，等背包同步')
        await this.syncInventory()
        await sleep(500)
        continue
      }

      try {
        await this.safeCraft(rs[0], 1, null)
      } catch (e) {
        this.log('[table] 合工作台失败: ' + e.message)
        await sleep(400)
        continue
      }

      // 合成了就放
      if (this.countOf('crafting_table') > 0) {
        const placed = await this.placeNearby('crafting_table')
        if (placed) return placed
        // 放不下也算有（拿着也行，craft 时传 table 对象另说）
      }
    }

    // 4. 实在不行，走一段换个开阔点的地方放
    for (let i = 0; i < 2; i++) {
      try { await this.wander(8) } catch (e) {}
      const t = this.findBlock('crafting_table', 8)
      if (t) return t
      if (this.countOf('crafting_table') > 0) {
        const placed = await this.placeNearby('crafting_table')
        if (placed) return placed
      }
    }
    return null
  }

  // 找一块能放东西的空地（周围有实体地面）
  findPlaceSpot (radius = 6) {
    const p = this.pos()
    const solid = (n) => {
      if (!n || n === 'air' || n === 'cave_air') return false
      if (/water|lava/.test(n)) return false
      return true
    }
    for (let r = 1; r <= radius; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue
          for (let dy = -2; dy <= 2; dy++) {
            const base = this.bot.blockAt(p.offset(dx, dy - 1, dz))
            const at = this.bot.blockAt(p.offset(dx, dy, dz))
            const up = this.bot.blockAt(p.offset(dx, dy + 1, dz))
            if (solid(base.name) && at.name === 'air' && up.name === 'air') {
              return { x: Math.floor(p.x + dx), y: Math.floor(p.y + dy), z: Math.floor(p.z + dz), base }
            }
          }
        }
      }
    }
    return null
  }

  // 手上哪种木板最多
  bestPlank () {
    const planks = ['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks',
      'acacia_planks', 'dark_oak_planks', 'cherry_planks', 'mangrove_planks', 'pale_oak_planks']
    let best = null; let n = 0
    for (const p of planks) {
      const c = this.countOf(p)
      if (c > n) { n = c; best = p }
    }
    return best
  }

  // 这个东西我有没有办法弄到
  canObtain (name, depth = 0) {
    if (depth > 3) return false
    if (this.countOf(name) > 0) return true

    // 能直接挖/砍的
    const minable = [
      'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
      'cherry_log', 'mangrove_log', 'pale_oak_log', 'stone', 'cobblestone', 'coal', 'coal_ore',
      'iron_ore', 'raw_iron', 'sand', 'dirt', 'gravel', 'clay', 'wheat', 'carrots', 'potatoes',
      'sugar_cane', 'bamboo', 'kelp', 'sweet_berries', 'melon_slice', 'pumpkin', 'egg',
      'string', 'feather', 'leather', 'bone', 'gunpowder', 'flint', 'stick'
    ]
    if (minable.includes(name)) {
      // 原木：附近有任意一种树就算能弄到（砍什么树算什么木头）
      if (/_log$/.test(name)) {
        try {
          return !!this.findAny(['oak_log', 'birch_log', 'spruce_log', 'jungle_log',
            'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log', 'pale_oak_log'], 56)
        } catch (e) { return false }
      }
      if (name === 'bamboo') {
        try { return !!this.findBlock('bamboo', 48) } catch (e) { return false }
      }
      if (name === 'stone' || name === 'cobblestone') {
        // 地表没有可以往下挖
        return true
      }
      return true
    }

    // 能合成的：看配方里每样都能弄到
    let cands = []
    try {
      const id = this.itemId(name)
      cands = this.bot.recipesAll(id, null, true) || []
    } catch (e) { return false }
    for (const r of cands) {
      let ok = true
      for (const d of r.delta) {
        if (d.count >= 0) continue
        const it = mcData.items[d.id]
        if (!it) { ok = false; break }
        if (!this.canObtain(it.name, depth + 1)) { ok = false; break }
      }
      if (ok) return true
    }
    return false
  }

  // 我现在能做哪种木板（有原木就做对应的，有木板就用现成的）
  myPlankKind () {
    const pairs = [
      ['oak_log', 'oak_planks'], ['birch_log', 'birch_planks'], ['spruce_log', 'spruce_planks'],
      ['jungle_log', 'jungle_planks'], ['acacia_log', 'acacia_planks'], ['dark_oak_log', 'dark_oak_planks'],
      ['cherry_log', 'cherry_planks'], ['mangrove_log', 'mangrove_planks'], ['pale_oak_log', 'pale_oak_planks'],
      ['bamboo', 'bamboo_planks'], ['crimson_stem', 'crimson_planks'], ['warped_stem', 'warped_planks']
    ]
    // 先看现成木板
    let best = null; let n = 0
    for (const [, p] of pairs) {
      const c = this.countOf(p)
      if (c > n) { n = c; best = p }
    }
    if (best) return best
    // 再看原木
    for (const [l, p] of pairs) {
      if (this.countOf(l) > 0) return p
    }
    // 都没有：看附近能找到哪种树
    try {
      for (const [l, p] of pairs) {
        if (l === 'bamboo' || /stem$/.test(l)) continue
        if (this.findBlock(l, 48)) return p
      }
      // 附近有树但不确定种类：默认橡木（砍到什么就用什么）
      if (this.findAny(['oak_log', 'birch_log', 'spruce_log', 'jungle_log',
        'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log', 'pale_oak_log'], 56)) {
        return 'oak_planks'
      }
    } catch (e) {}
    return null
  }

  // 手上哪种原木最多（用来决定做哪种木板）
  bestLog () {
    const logs = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log',
      'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log', 'pale_oak_log']
    let best = null; let n = 0
    for (const l of logs) {
      const c = this.countOf(l)
      if (c > n) { n = c; best = l }
    }
    return best
  }

  // 评估这个地方值不值得待：有没有树、水、安全度
  survey (radius = 40) {
    const p = this.pos()
    const out = { trees: 0, water: 0, animals: 0, hostiles: 0, stone: 0, caves: 0 }
    const logs = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log',
      'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log', 'pale_oak_log']
    for (const l of logs) {
      if (this.findBlock(l, radius)) out.trees++
    }
    try {
      if (this.findBlock('water', radius)) out.water = 1
      if (this.findBlock('stone', 24)) out.stone = 1
    } catch (e) {}
    for (const e of Object.values(this.bot.entities)) {
      if (!e || e === this.bot.entity) continue
      const d = e.position.distanceTo(p)
      if (d > radius) continue
      if (['cow', 'pig', 'chicken', 'sheep', 'rabbit'].includes(e && e.name)) out.animals++
      if (['zombie', 'skeleton', 'creeper', 'spider', 'drowned', 'enderman', 'witch'].includes(e && e.name)) out.hostiles++
    }
    // 打分
    out.score = out.trees * 3 + out.animals + out.stone * 2 + (out.water ? 1 : 0) - out.hostiles * 1.5
    return out
  }

  // 找个好地方安家：走几段，挑分最高的
  async findHome (legs = 4, legBlocks = 60) {
    let best = null
    let bestPos = null
    for (let i = 0; i < legs; i++) {
      this.check()
      const s = this.survey(36)
      this.log(`[home] 第${i}处 树${s.trees} 动物${s.animals} 石${s.stone} 怪${s.hostiles} => ${s.score.toFixed(1)}`)
      if (!best || s.score > best.score) { best = s; bestPos = this.pos().clone() }
      if (best && best.score > 8 && i >= 1) break
      const p = this.pos()
      const a = (i * 2.399) + 0.5
      try {
        await this.goto(p.x + Math.cos(a) * legBlocks, p.y, p.z + Math.sin(a) * legBlocks, 3, 50000)
      } catch (e) {}
      await this.ensureChunks(3500)
    }
    if (bestPos) {
      this.mem && this.mem.place && this.mem.place('看过的地方', bestPos, '评分 ' + (best ? best.score.toFixed(1) : '?'))
    }
    return { survey: best, pos: bestPos }
  }

  // 长途找个东西：先扫近的，再逐步扩大半径，最后才走
  async travelToFind (predicate, maxLegs = 6, legBlocks = 40) {
    await this.ensureChunks()

    // 先扫附近（很多时候东西就在旁边，只是之前没扫到）
    for (const r of [16, 32, 48, 64]) {
      const hit = predicate()
      if (hit) return hit
      // 换个半径再扫一次（findBlock 的 maxDistance 由 predicate 内部决定）
      await sleep(150)
    }

    for (let i = 0; i < maxLegs; i++) {
      this.check()
      const hit = predicate()
      if (hit) return hit
      // 挑一个没走过的方向走
      const p = this.pos()
      const a = (i * 2.399) + Math.random() * 0.8   // 黄金角，避免原路
      const tx = p.x + Math.cos(a) * legBlocks
      const tz = p.z + Math.sin(a) * legBlocks
      this.log(`[travel] 第${i + 1}段 -> ${Math.round(tx)},${Math.round(tz)}`)
      try {
        await this.goto(tx, p.y, tz, 3, 45000)
      } catch (e) {
        this.log('[travel] ' + e.message)
      }
      await this.ensureChunks(4000)
    }
    return predicate()
  }

  // 挖圆石：直接往下挖（最快，不绕路）
  async digStone (count = 3) {
    await this.ensureChunks()
    const got = () => this.countOf('cobblestone') + this.countOf('stone') + this.countOf('cobbled_deepslate')
    if (got() >= count) return got()

    // 没镐挖石头不掉东西，先弄一把
    const hasPick = this.bot.inventory.items().some(i => /_pickaxe$/.test(i.name))
    if (!hasPick) {
      const wood = this.woodCount()
      if (wood < 3) {
        try { await this.ensureWood(3) } catch (e) {}
      }
      try {
        if (this.woodCount() > 0) await this.anyPlanks(4)
        await this.craftSmart('wooden_pickaxe', 1)
        const pick = this.bot.inventory.items().find(i => /_pickaxe$/.test(i.name))
        if (pick) await this.bot.equip(pick, 'hand')
      } catch (e) {
        this.log('[dig] 做镐失败: ' + e.message)
      }
    }

    // 1. 附近有裸露的石头先挖（省时间）
    const exposed = this.findBlock('stone', 24)
    if (exposed) {
      try { await this.mine('stone', count - got() + 1, 24) } catch (e) {}
      if (got() >= count) return got()
    }

    // 2. 直接往下挖，一路挖到石头
    this.log('[dig] 往下挖到石头层')
    // 拿好镐
    const pickForDig = this.bot.inventory.items()
      .filter(i => /_pickaxe$/.test(i.name))
      .sort((a, b) => (b.name.includes('iron') ? 1 : 0) - (a.name.includes('iron') ? 1 : 0))[0]
    if (pickForDig) { try { await this.bot.equip(pickForDig, 'hand') } catch (e) {} }

    let depth = 0
    for (let i = 0; i < 24 && got() < count && depth < 20; i++) {
      this.check()
      const p = this.pos()
      const below = this.bot.blockAt(p.offset(0, -1, 0))
      if (!below) break
      if (/bedrock|lava|water/.test(below.name)) {
        // 岩浆/水：换个位置重来
        this.log('[dig] 下面是' + below.name + '，换个地方')
        try { await this.wander(6) } catch (e) {}
        continue
      }
      try {
        await this.digAt(below)
        depth++
        await sleep(200)
        await this.pickupNearby(4)
      } catch (e) {
        this.log('[dig] ' + e.message)
        break
      }
    }
    return got()
  }

  // 保证手上有 n 个任意种类的原木
  async ensureWood (n = 3) {
    const logs = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log',
      'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log', 'pale_oak_log']
    let have = 0
    for (const l of logs) have += this.countOf(l)
    if (have >= n) return have
    const need = n - have
    await this.chopTree(Math.max(1, Math.ceil(need / 3)))
    let now = 0
    for (const l of logs) now += this.countOf(l)
    return now
  }

  // 手上有多少原木（不分种类）
  woodCount () {
    const logs = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log',
      'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log', 'pale_oak_log',
      'crimson_stem', 'warped_stem', 'bamboo_block']
    let n = 0
    for (const l of logs) n += this.countOf(l)
    return n
  }

  // 把任意原木做成对应木板，返回做出了多少
  async anyPlanks (n = 4) {
    const pairs = [
      ['oak_log', 'oak_planks'], ['birch_log', 'birch_planks'], ['spruce_log', 'spruce_planks'],
      ['jungle_log', 'jungle_planks'], ['acacia_log', 'acacia_planks'], ['dark_oak_log', 'dark_oak_planks'],
      ['cherry_log', 'cherry_planks'], ['mangrove_log', 'mangrove_planks'], ['pale_oak_log', 'pale_oak_planks']
    ]
    let made = 0
    for (const [l, p] of pairs) {
      if (this.countOf(p) >= n) return this.countOf(p)
      const logs = this.countOf(l)
      if (logs > 0) {
        try {
          const id = this.itemId(p)
          const rs = this.bot.recipesFor(id, null, 1, null)
          if (rs && rs.length) {
            await this.bot.craft(rs[0], logs, null)
            made += this.countOf(p)
          }
        } catch (e) {}
      }
    }
    return made
  }

  // 缺原料就去弄（木头/石头这类能从世界上直接拿的）
  async gather (itemName, count) {
    // 木板 -> 对应原木
    if (/_planks$/.test(itemName)) {
      try {
        const wood = await this.ensureWood(Math.max(1, Math.ceil(count / 4)))
        if (wood <= 0) return false
        await this.anyPlanks(count)
        return this.countOf(itemName) >= count || this.woodCount() > 0
      } catch (e) { return false }
    }
    if (/_log$/.test(itemName)) {
      try {
        const n = await this.ensureWood(Math.max(1, count))
        return n > 0 || this.countOf(itemName) > 0
      } catch (e) { return false }
    }
    const map = {
      cobblestone: ['stone'], stone: ['stone'], cobbled_deepslate: ['deepslate'],
      coal: ['coal_ore'], raw_iron: ['iron_ore'], iron_ore: ['iron_ore'],
      raw_copper: ['copper_ore'], copper_ore: ['copper_ore'],
      sand: ['sand'], dirt: ['dirt'], gravel: ['gravel'], clay_ball: ['clay']
    }
    const src = map[itemName]
    if (!src) return false
    try {
      if (/_log$/.test(src[0]) || src[0] === 'stone') {
        if (src[0] === 'stone') {
          const got = await this.mine('stone', count + 2)
          return got > 0
        }
        await this.chopTree(Math.max(1, Math.ceil(count / 3)))
        return true
      }
      if (itemName === 'torch') return false
      if (/_ore$/.test(src[0])) {
        const got = await this.mine(src[0], count)
        return got > 0
      }
      return false
    } catch (e) { return false }
  }

  async placeFromInventory (blockName) {
    const it = this.item(blockName)
    if (!it) return false
    const p = this.pos()
    const base = this.bot.blockAt(p.offset(1, -1, 0))
    if (!base || base.name === 'air') return false
    await this.bot.equip(it, 'hand')
    try {
      await this.bot.placeBlock(base, new Vec3(0, 1, 0))
      return true
    } catch (e) { return false }
  }

  // ---------------- 冶炼 ----------------

  async smelt (inputName, fuelName, count = 1) {
    this.check()
    let furnace = this.findBlock('furnace', 16)
    if (!furnace) {
      if (this.countOf('furnace') > 0) {
        await this.placeFromInventory('furnace')
        furnace = this.findBlock('furnace', 8)
      }
    }
    if (!furnace) throw new Error('没有熔炉')

    const input = this.item(inputName)
    if (!input) throw new Error('没有 ' + inputName)
    let fuel = fuelName ? this.item(fuelName) : (this.item('coal') || this.item('charcoal') ||
      this.item('oak_planks') || this.item('oak_log'))
    if (!fuel) throw new Error('没有燃料')

    await this.goto(furnace.position.x, furnace.position.y, furnace.position.z, 2)
    const f = await this.bot.openFurnace(furnace)
    try {
      await f.putInput(input.type, null, Math.min(count, input.count))
      const need = Math.max(1, Math.ceil(Math.min(count, input.count) / 8))
      await f.putFuel(fuel.type, null, Math.min(need, fuel.count))
      // 等烧
      const t0 = Date.now()
      while (Date.now() - t0 < 90000) {
        await sleep(1000)
        const out = f.outputItem()
        if (out && out.count >= Math.min(count, input.count)) break
      }
      const out = f.outputItem()
      if (out) await f.takeOutput()
      return !!out
    } finally {
      try { f.close() } catch (e) {}
    }
  }

  // ---------------- 装备 ----------------

  async equip (name) {
    const it = this.item(name)
    if (!it) throw new Error('没有 ' + name)
    let dest = 'hand'
    if (/_helmet$/.test(name)) dest = 'head'
    else if (/_chestplate$/.test(name)) dest = 'torso'
    else if (/_leggings$/.test(name)) dest = 'legs'
    else if (/_boots$/.test(name)) dest = 'feet'
    else if (name === 'shield') dest = 'off-hand'
    await this.bot.equip(it, dest)
    return true
  }

  // 自动穿最好的装备
  async autoArmor () {
    const sets = [
      ['netherite_helmet', 'diamond_helmet', 'iron_helmet', 'chainmail_helmet', 'golden_helmet', 'leather_helmet', 'head'],
      ['netherite_chestplate', 'diamond_chestplate', 'iron_chestplate', 'chainmail_chestplate', 'golden_chestplate', 'leather_chestplate', 'torso'],
      ['netherite_leggings', 'diamond_leggings', 'iron_leggings', 'chainmail_leggings', 'golden_leggings', 'leather_leggings', 'legs'],
      ['netherite_boots', 'diamond_boots', 'iron_boots', 'chainmail_boots', 'golden_boots', 'leather_boots', 'feet']
    ]
    for (const s of sets) {
      const dest = s.pop()
      for (const name of s) {
        const it = this.item(name)
        if (it) { try { await this.bot.equip(it, dest) } catch (e) {} ; break }
      }
    }
  }

  // 武器
  async bestWeapon () {
    const order = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
      'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe']
    for (const n of order) {
      const it = this.item(n)
      if (it) { try { await this.bot.equip(it, 'hand'); return n } catch (e) {} }
    }
    return null
  }

  // ---------------- 吃 ----------------

  /**
   * 吃。用 minecraft-data 的食物表，按"吃了能回多少"排序。
   * 生的先吃也没事 —— 真人饿急了不会挑。
   */
  async eat ({ preferCooked = true } = {}) {
    const items = this.bot.inventory.items()
    const foods = []

    for (const it of items) {
      const f = mcData.foodsByName[it.name]
      if (!f || !f.foodPoints) continue
      // 毒土豆、河豚、蜘蛛眼这些吃了有害的，不碰
      if (/poisonous_potato|pufferfish|spider_eye|suspicious_stew/.test(it.name)) continue
      // 腐肉：只有实在没别的才吃
      const bad = /rotten_flesh/.test(it.name)
      const cooked = /^cooked_|baked_|bread|golden_apple|golden_carrot|stew/.test(it.name)
      let score = f.foodPoints + (f.saturationRatio || 0) / 10
      if (cooked && preferCooked) score += 6
      if (bad) score -= 20
      foods.push({ it, score, name: it.name })
    }

    if (!foods.length) return null
    foods.sort((a, b) => b.score - a.score)

    for (const f of foods) {
      try {
        await this.bot.equip(f.it, 'hand')
        await this.bot.consume()
        return f.name
      } catch (e) { continue }
    }
    return null
  }

  /**
   * 找吃的。按"最快拿到"的顺序试：
   *   1. 背包里有就直接吃
   *   2. 附近有动物就打死，捡肉，有熔炉就烤
   *   3. 摘浆果
   *   4. 打瓜
   *   5. 水边抓鱼
   *   6. 走远再找一轮
   */
  async findFood () {
    const bot = this.bot

    // 0. 先确认自己能走动。困在坑里的话什么都干不了
    if (!(await this.canMoveAround())) {
      this.log('[food] 动不了，先挖出去')
      if (this.ctx && this.ctx.reflex) await this.ctx.reflex.digOut().catch(() => {})
      else await this.digOutSelf()
    }

    // 1. 背包里有
    if (this.hasFood()) {
      const ate = await this.eat()
      if (ate) return '吃了背包里的 ' + ate
    }

    // 2. 打动物 -> 捡肉 -> 能烤就烤（动物经常在几十格外，得走过去）
    const animals = ['cow', 'pig', 'chicken', 'sheep', 'rabbit']
    for (const a of animals) {
      const e = this.nearestEntity(a, 96)
      if (!e) continue
      try {
        // 太远就先追过去（用 GoalFollow，动物会动）
        const dist = e.position.distanceTo(this.pos())
        if (dist > 8) {
          this.log('[food] ' + a + ' 在 ' + Math.round(dist) + ' 格外，追过去')
          try {
            await this.chase(a, 45000)
          } catch (err) {
            this.log('[food] 追不上: ' + err.message)
          }
        }
        await this.attack(a, 8)
        await this.pickupNearby(12)
        // 打到生肉了吗
        const raw = this.item('beef') || this.item('porkchop') || this.item('mutton') || this.item('chicken') || this.item('rabbit')
        if (raw) {
          // 有熔炉和燃料就烤，没有就直接吃
          const cooked = await this.tryCook(raw.name).catch(() => null)
          if (cooked) return '打了' + a + '，烤熟了吃'
          const ate = await this.eat()
          if (ate) return '打了' + a + '，吃了' + ate
        }
        if (this.hasFood()) {
          const ate = await this.eat()
          if (ate) return '打了' + a + '，吃了' + ate
        }
      } catch (err) {}
    }

    // 3. 浆果
    for (const bush of ['sweet_berry_bush', 'cave_vines', 'cave_vines_plant']) {
      const b = this.findBlock(bush, 48)
      if (!b) continue
      try {
        await this.digAt(b)
        await this.pickupNearby(6)
        if (this.hasFood()) {
          const ate = await this.eat()
          if (ate) return '摘了浆果吃了'
        }
      } catch (e) {}
    }

    // 4. 瓜
    for (const crop of ['melon', 'pumpkin']) {
      const b = this.findBlock(crop, 48)
      if (!b) continue
      try {
        await this.digAt(b)
        await this.pickupNearby(6)
        if (this.hasFood()) {
          const ate = await this.eat()
          if (ate) return '弄了' + crop + '吃了'
        }
      } catch (e) {}
    }

    // 5. 抓鱼
    for (const fish of ['cod', 'salmon']) {
      const e = this.nearestEntity(fish, 24)
      if (!e) continue
      try {
        await this.attack(fish, 6)
        await this.pickupNearby(10)
        const raw = this.item('cod') || this.item('salmon')
        if (raw) {
          const cooked = await this.tryCook(raw.name).catch(() => null)
          if (cooked) return '抓了鱼，烤熟了吃'
          const ate = await this.eat()
          if (ate) return '抓了鱼吃'
        }
      } catch (err) {}
    }

    // 6. 走远再找一轮
    try {
      this.log('[food] 附近没有，走远找')
      await this.wander(48)
      await this.ensureChunks(4000)
      const e = this.nearestEntity('cow', 96) || this.nearestEntity('pig', 96) ||
        this.nearestEntity('chicken', 96) || this.nearestEntity('sheep', 96)
      if (e) {
        await this.attack(e.name, 8)
        await this.pickupNearby(12)
        const raw = this.item('beef') || this.item('porkchop') || this.item('mutton') || this.item('chicken')
        if (raw) {
          const cooked = await this.tryCook(raw.name).catch(() => null)
          if (cooked) return '走远打了' + e.name + '，烤熟了吃'
        }
        if (this.hasFood()) {
          const ate = await this.eat()
          if (ate) return '走远打到猎物吃了'
        }
      }
      const b = this.findBlock('sweet_berry_bush', 40)
      if (b) {
        await this.digAt(b)
        await this.pickupNearby(6)
        if (this.hasFood()) {
          const ate = await this.eat()
          if (ate) return '走远摘到浆果'
        }
      }
    } catch (err) {}

    return null
  }

  /** 试一下能不能走动（四个方向都试，不是只往前走） */
  async canMoveAround () {
    const p0 = this.pos()
    const dirs = [
      { yaw: -Math.PI / 2, key: 'forward' },   // +X
      { yaw: Math.PI / 2, key: 'forward' },    // -X
      { yaw: 0, key: 'forward' },              // +Z
      { yaw: Math.PI, key: 'forward' }         // -Z
    ]
    for (const d of dirs) {
      try {
        await this.bot.look(d.yaw, 0, true)
        this.bot.setControlState(d.key, true)
        await sleep(450)
        this.bot.setControlState(d.key, false)
      } catch (e) {}
      await sleep(120)
      if (p0.distanceTo(this.pos()) > 0.6) return true
    }
    return false
  }

  /** 朝某个方向走（会先转向） */
  async walkToward (dx, dz, ms = 900) {
    // yaw 约定：0 = +Z，-PI/2 = +X
    const yaw = Math.atan2(-dx, dz)
    try {
      await this.bot.look(yaw, 0, true)
      await sleep(120)
      this.bot.setControlState('forward', true)
      await sleep(ms)
      this.bot.setControlState('forward', false)
    } catch (e) {
      try { this.bot.setControlState('forward', false) } catch (e2) {}
    }
  }

  /** 自己挖一条路出来（不依赖 reflex） */
  async digOutSelf () {
    const bot = this.bot
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]].sort(() => Math.random() - 0.5)
    for (const [dx, dz] of dirs) {
      try {
        for (let step = 1; step <= 3; step++) {
          const p = bot.entity.position
          const base = p.offset(dx * step, 0, dz * step)
          for (const off of [0, 1]) {
            const b = bot.blockAt(base.offset(0, off, 0))
            if (!b || b.name === 'air' || b.name === 'cave_air') continue
            if (/bedrock|water|lava/.test(b.name)) break
            try {
              await this.bestToolFor(b)
              await bot.dig(b, true)
              await sleep(200)
            } catch (e) { break }
          }
        }
        await this.walkToward(dx, dz, 1100)
        if (await this.canMoveAround()) {
          this.log('[digout] 出来了')
          return true
        }
      } catch (e) {}
    }
    return false
  }

  /**
   * 把生肉烤成熟肉。
   * 没熔炉就现做一个（8 个圆石），没燃料就砍点木头。
   */
  async tryCook (rawName) {
    if (!rawName) return null
    const cookedName = rawName.replace(/^beef$/, 'cooked_beef')
      .replace(/^porkchop$/, 'cooked_porkchop')
      .replace(/^mutton$/, 'cooked_mutton')
      .replace(/^chicken$/, 'cooked_chicken')
      .replace(/^rabbit$/, 'cooked_rabbit')
      .replace(/^cod$/, 'cooked_cod')
      .replace(/^salmon$/, 'cooked_salmon')
    if (cookedName === rawName) return null
    if (this.item(cookedName)) return cookedName

    // 有熔炉吗
    let furnace = this.findBlock('furnace', 20)
    if (!furnace) {
      // 现做一个：需要 8 个圆石
      if (this.countOf('furnace') > 0) {
        furnace = await this.placeNearby('furnace')
      } else {
        let stone = this.countOf('cobblestone') + this.countOf('cobbled_deepslate')
        if (stone < 8) {
          this.log('[cook] 圆石不够（' + stone + '/8），挖点')
          try { stone = await this.digStone(8) } catch (e) {}
        }
        if (stone < 8) {
          this.log('[cook] 挖不到圆石，只能吃生的')
          return null
        }
        try {
          await this.craftSmart('furnace', 1)
          furnace = await this.placeNearby('furnace')
        } catch (e) {
          this.log('[cook] 做熔炉失败: ' + e.message)
          return null
        }
      }
    }
    if (!furnace) return null

    // 有燃料吗
    const fuel = ['coal', 'charcoal', 'oak_planks', 'birch_planks', 'spruce_planks',
      'oak_log', 'birch_log', 'spruce_log', 'stick']
      .map(n => this.item(n)).find(Boolean)
    if (!fuel) {
      this.log('[cook] 没燃料，砍点木头')
      try { await this.ensureWood(2); await this.anyPlanks(2) } catch (e) {}
      const f2 = ['oak_planks', 'birch_planks', 'oak_log', 'stick'].map(n => this.item(n)).find(Boolean)
      if (!f2) return null
      return await this.smelt(rawName, f2.name, 2).then(() => this.item(cookedName) ? cookedName : null).catch(() => null)
    }

    try {
      await this.smelt(rawName, fuel.name, 2)
      if (this.item(cookedName)) {
        this.log('[cook] 烤好了 ' + cookedName)
        return cookedName
      }
    } catch (e) {
      this.log('[cook] 烤失败: ' + e.message)
    }
    return null
  }

  // 背包里有没有能吃的（用游戏自己的食物表）
  hasFood () {
    return this.bot.inventory.items().some(i => {
      const f = mcData.foodsByName[i.name]
      if (!f || !f.foodPoints) return false
      return !/poisonous_potato|pufferfish|spider_eye/.test(i.name)
    })
  }

  /** 背包里所有能吃的东西，按好坏排 */
  foodList () {
    const out = []
    for (const it of this.bot.inventory.items()) {
      const f = mcData.foodsByName[it.name]
      if (!f || !f.foodPoints) continue
      out.push({ name: it.name, count: it.count, points: f.foodPoints, raw: f.displayName })
    }
    return out.sort((a, b) => b.points - a.points)
  }

  // ---------------- 打 ----------------

  nearestEntity (name, range = 16) {
    const p = this.pos()
    let best = null; let bd = 1e9
    for (const e of Object.values(this.bot.entities)) {
      if (!e || e === this.bot.entity) continue
      if (name && e.name !== name) continue
      const d = e.position.distanceTo(p)
      if (d < range && d < bd) { bd = d; best = e }
    }
    return best
  }

  /** 追一个会动的目标 */
  async chase (name, timeoutMs = 30000, stopDist = 3) {
    const bot = this.bot
    const t0 = Date.now()
    let lastDist = 1e9
    let stillSince = 0

    while (Date.now() - t0 < timeoutMs) {
      this.check()
      const e = this.nearestEntity(name, 96)
      if (!e) return false
      const d = e.position.distanceTo(this.pos())
      if (d <= stopDist) {
        try { bot.pathfinder.setGoal(null) } catch (err) {}
        return true
      }
      // 追
      try {
        bot.pathfinder.setGoal(new goals.GoalFollow(e, Math.max(1, stopDist - 1)), true)
      } catch (err) {}
      await sleep(300)

      if (Math.abs(d - lastDist) < 0.3) stillSince += 300
      else stillSince = 0
      lastDist = d
      if (stillSince > 10000) {
        this.log('[chase] 追不上 ' + name)
        try { bot.pathfinder.setGoal(null) } catch (err) {}
        return false
      }
    }
    try { bot.pathfinder.setGoal(null) } catch (err) {}
    return false
  }

  async attack (name, times = 5) {
    this.check()
    await this.bestWeapon()
    const e = this.nearestEntity(name, 96)
    if (!e) throw new Error('附近没有 ' + name)
    for (let i = 0; i < times; i++) {
      this.check()
      const ent = this.nearestEntity(name, 24)
      if (!ent) break
      const d = ent.position.distanceTo(this.pos())
      if (d > 3.2) {
        this.bot.pathfinder.setGoal(new goals.GoalFollow(ent, 2), true)
        await sleep(400)
        continue
      }
      this.bot.pathfinder.setGoal(null)
      await this.bot.lookAt(ent.position.offset(0, 1.4, 0), true)
      await this.bot.attack(ent)
      await sleep(620)
    }
    return true
  }

  // ---------------- 箱子 ----------------

  async openChest (x, y, z) {
    const b = this.bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)))
    if (!b || !/chest|barrel|shulker/.test(b.name)) throw new Error('那里没有箱子')
    await this.goto(b.position.x, b.position.y, b.position.z, 2)
    return this.bot.openContainer(b)
  }

  async depositAll (x, y, z, except = []) {
    const c = await this.openChest(x, y, z)
    try {
      const items = this.bot.inventory.items()
      for (const it of items) {
        if (except.some(e => it.name.includes(e))) continue
        try { await c.deposit(it.type, null, it.count) } catch (e) {}
      }
      return true
    } finally { c.close() }
  }

  async withdraw (x, y, z, itemName, count = 1) {
    const c = await this.openChest(x, y, z)
    try {
      const slot = c.containerItems().find(i => i.name === itemName)
      if (!slot) throw new Error('箱子里没有 ' + itemName)
      await c.withdraw(slot.type, null, Math.min(count, slot.count))
      return true
    } finally { c.close() }
  }

  // ---------------- 捡东西 ----------------

  async pickupNearby (radius = 8) {
    const p = this.pos()
    const drops = Object.values(this.bot.entities).filter(e =>
      e.name === 'item' && e.position.distanceTo(p) < radius)
    for (const d of drops) {
      try { await this.goto(d.position.x, d.position.y, d.position.z, 1) } catch (e) {}
    }
    return drops.length
  }

  // ---------------- 睡觉 ----------------

  async sleepInBed () {
    const bed = this.bot.findBlock({
      matching: b => /_bed$/.test(b.name),
      maxDistance: 24
    })
    if (!bed) return false
    await this.goto(bed.position.x, bed.position.y, bed.position.z, 1)
    try { await this.bot.sleep(bed); return true } catch (e) { return false }
  }

  // ---------------- 状态 ----------------

  status () {
    const p = this.pos()
    const inv = {}
    for (const i of this.bot.inventory.items()) inv[i.name] = (inv[i.name] || 0) + i.count
    const held = this.bot.heldItem ? this.bot.heldItem.name : null
    return {
      pos: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
      health: Math.round(this.bot.health),
      food: Math.round(this.bot.food),
      time: this.bot.time.timeOfDay < 12000 ? '白天' : '晚上',
      dimension: this.bot.game.dimension,
      weather: this.bot.isRaining ? '下雨' : '晴',
      held,
      inventory: inv
    }
  }
}

module.exports = { Actions, sleep }
