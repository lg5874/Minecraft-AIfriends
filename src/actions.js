'use strict'
// L1 原子动作。所有能力的底座。
// 每个动作都是 async，失败抛错或返回 false，绝不静默成功。

const { goals, Movements } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')('1.21.11')

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 方块名 -> 挖掉后掉什么物品。
 * 这是个大坑：mine('lapis_ore') 挖掉了方块，但背包里收到的是 lapis_lazuli，
 * 所以 countOf('lapis_ore') 永远是 0，看起来像"挖到0块"。
 */
const BLOCK_DROPS = {
  lapis_ore: 'lapis_lazuli',
  coal_ore: 'coal',
  deepslate_coal_ore: 'coal',
  iron_ore: 'raw_iron',
  deepslate_iron_ore: 'raw_iron',
  copper_ore: 'raw_copper',
  deepslate_copper_ore: 'raw_copper',
  gold_ore: 'raw_gold',
  deepslate_gold_ore: 'raw_gold',
  diamond_ore: 'diamond',
  deepslate_diamond_ore: 'diamond',
  emerald_ore: 'emerald',
  deepslate_emerald_ore: 'emerald',
  redstone_ore: 'redstone',
  deepslate_redstone_ore: 'redstone',
  nether_quartz_ore: 'quartz',
  nether_gold_ore: 'gold_nugget',
  stone: 'cobblestone',
  deepslate: 'cobbled_deepslate',
  grass_block: 'dirt',
  gravel: 'gravel',
  clay: 'clay_ball',
  // 原木就是原木
  oak_log: 'oak_log', birch_log: 'birch_log', spruce_log: 'spruce_log',
  jungle_log: 'jungle_log', acacia_log: 'acacia_log', dark_oak_log: 'dark_oak_log',
  cherry_log: 'cherry_log', mangrove_log: 'mangrove_log', pale_oak_log: 'pale_oak_log'
}

/** 挖这个方块会掉什么（用于数数量） */
function dropOf (blockName) {
  return BLOCK_DROPS[blockName] || blockName
}

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
  // ============================================================
  // 视觉：让他真的"看见"地形，而不是一堆方块计数
  // ============================================================

  /** 看某个位置是什么方块 */
  blockAt (x, y, z) {
    const b = this.bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)))
    if (!b) return null
    return { name: b.name, solid: b.boundingBox === 'block', pos: { x: b.position.x, y: b.position.y, z: b.position.z } }
  }

  /** 单个方块画成什么符号 */
  _sym (b) {
    if (!b) return '?'
    const n = b.name
    if (n === 'air' || n === 'cave_air') return '·'
    if (/lava/.test(n)) return 'L'
    if (/water/.test(n)) return '~'
    if (/_log$/.test(n)) return 'T'
    if (/leaves/.test(n)) return 't'
    if (/_ore$/.test(n)) return 'O'
    if (n === 'bedrock') return '#'
    if (/chest|furnace|crafting_table/.test(n)) return 'C'
    if (b.boundingBox === 'block') return '█'
    return '░'
  }

  /**
   * 侧面剖视图：沿某个方向切一刀，看竖直方向的地形。
   * 这是最有用的一张图 —— 能直接看出"头顶有没有石头""前面通不通"。
   *
   * @param {string} axis 'x' | 'z'  沿哪个轴切
   * @param {number} range 水平看多远（默认 8）
   * @param {number} up 往上看几格（默认 8）
   * @param {number} down 往下看几格（默认 4）
   */
  lookProfile (axis = 'x', range = 8, up = 8, down = 4) {
    const p = this.pos()
    const lines = []

    const head = `      y+${up}${' '.repeat(Math.max(0, (up + down) * 1 - 4))}y-${down}`
    lines.push(`【${axis === 'x' ? '东西' : '南北'}方向剖面】`)

    for (let d = -range; d <= range; d++) {
      let row = ''
      for (let dy = up; dy >= -down; dy--) {
        const b = axis === 'x'
          ? this.bot.blockAt(p.offset(d, dy, 0))
          : this.bot.blockAt(p.offset(0, dy, d))
        row += this._sym(b)
      }
      const label = `${axis}${d >= 0 ? '+' : ''}${String(d).padStart(2)}`
      lines.push(`${label}: ${row}${d === 0 ? '  ← 你在这' : ''}`)
    }
    return lines.join('\n')
  }

  /**
   * 俯视图：从头顶往下看，脚下的平面。
   * 能看出"四周哪里能走"。
   */
  lookTop (range = 8, layer = 0) {
    const p = this.pos()
    const lines = ['【俯视图】']
    for (let dz = -range; dz <= range; dz++) {
      let row = ''
      for (let dx = -range; dx <= range; dx++) {
        row += this._sym(this.bot.blockAt(p.offset(dx, layer, dz)))
      }
      lines.push(`z${dz >= 0 ? '+' : ''}${String(dz).padStart(2)}: ${row}${dz === 0 ? '  ← 你' : ''}`)
    }
    return lines.join('\n')
  }

  /**
   * 完整的视觉快照：三个方向的剖面 + 俯视 + 图例。
   * 这是给模型"看世界"用的。
   */
  lookAround3D (range = 6) {
    const p = this.pos()
    const out = []
    out.push(`【位置】x=${Math.round(p.x)} y=${Math.round(p.y)} z=${Math.round(p.z)}`)
    out.push('【图例】█实心 ·空 ~水 L岩浆 T原木 t树叶 O矿石 #基岩 C容器 ░半格 ?未知')
    out.push('')
    out.push(this.lookProfile('x', range, 6, 3))
    out.push('')
    out.push(this.lookProfile('z', range, 6, 3))
    out.push('')
    out.push(this.lookTop(range, 0))
    return out.join('\n')
  }

  /**
   * 判断某个方向能不能走（用视觉判断，不靠算法）
   * @returns {{walkable:boolean, needDig:number, reason:string}}
   */
  canWalkTo (dx, dz) {
    const p = this.pos()
    const feet = this.bot.blockAt(p.offset(dx, 0, dz))
    const body = this.bot.blockAt(p.offset(dx, 1, dz))
    const head = this.bot.blockAt(p.offset(dx, 2, dz))
    const below = this.bot.blockAt(p.offset(dx, -1, dz))

    const isFree = b => b && (b.name === 'air' || b.name === 'cave_air' || b.boundingBox === 'empty')
    const isSolid = b => b && b.boundingBox === 'block'

    if (!feet || !body || !head) return { walkable: false, needDig: 99, reason: '看不清' }
    if (/lava/.test(feet.name) || /lava/.test(below?.name || '')) {
      return { walkable: false, needDig: 99, reason: '有岩浆' }
    }

    // 身体和头要空
    let dig = 0
    if (!isFree(body)) dig++
    if (!isFree(head)) dig++
    // 脚下要有东西踩（或者自己垫）
    const needFloor = !isSolid(below)

    if (dig === 0 && !needFloor && isFree(feet)) {
      return { walkable: true, needDig: 0, reason: '直接能走' }
    }
    if (dig <= 2 && !needFloor) {
      return { walkable: true, needDig: dig, reason: `挖 ${dig} 格就能走` }
    }
    return { walkable: false, needDig: dig + (needFloor ? 1 : 0), reason: `要挖 ${dig} 格，脚下${needFloor ? '悬空' : '有地'}` }
  }

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

    // 坐标校验：NaN/undefined 会让后面所有计算都变成 NaN
    x = Number(x); y = Number(y); z = Number(z)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      this.log(`[goto] 坐标无效 (${x},${y},${z})，不走了`)
      return false
    }
    this.current = `走到 ${Math.round(x)},${Math.round(y)},${Math.round(z)}`

    const p0 = this.pos()
    const dy = Math.abs(y - p0.y)

    // 目标跟自己不在同一层：先解决高度差，再水平走
    if (dy > 2) {
      const reached = await this.gotoVertical(y, timeoutMs)
      if (!reached) {
        this.log(`[goto] 高度到不了（目标 y=${Math.round(y)}，现在 y=${Math.round(this.pos().y)}）`)
        return false
      }
    }

    const goal = new goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), range)
    this.bot.pathfinder.setGoal(goal)

    const t0 = Date.now()
    let stillSince = 0
    let lastP = this.pos().clone()
    let lastStatus = ''

    try {
      while (Date.now() - t0 < timeoutMs) {
        this.check()

        const p = this.pos()
        const moved = p.distanceTo(lastP)
        lastP = p.clone()

        // 1. 到达判定：水平近 + **垂直也必须近**
        // 之前的 bug：垂直容差给到 4 格，结果箱子在 y=58 他在 y=45，
        // 差了 13 格却判定"到了"，然后去开箱子必然失败。
        const dxz = Math.hypot(p.x - x, p.z - z)
        const dyAbs = Math.abs(p.y - y)
        if (dxz <= range + 2 && dyAbs <= 2) {
          return true
        }

        // 2. pathfinder 说到了，就是到了（别等 goal_reached 事件，可能已错过）
        try {
          const pf = this.bot.pathfinder
          if (pf.isMoving && !pf.isMoving()) {
            // 没在走：可能到了，也可能走不通
            // 再等一小会儿确认（用 500ms）
            await sleep(200)
            const p2 = this.pos()
            if (p2.distanceTo(p) < 0.15) {
              // 真的停住了
              const d2 = Math.hypot(p2.x - x, p2.z - z)
              if (d2 <= range + 3) return true       // 差不多到了
              // 没到但也不走了 -> 走不通
              this.log(`[goto] 走不通了（差 ${d2.toFixed(1)} 格）`)
              return false
            }
            continue
          }
        } catch (e) {}

        // 3. 卡住判定：连续 6 秒没挪窝
        if (moved < 0.1) stillSince += 180
        else stillSince = 0
        if (stillSince > 6000) {
          this.log(`[goto] 卡住（${stillSince / 1000}秒没动，差 ${Math.hypot(p.x - x, p.z - z).toFixed(1)} 格）`)
          return false
        }

        await sleep(180)
      }
      this.log(`[goto] 超时（${Math.round(timeoutMs / 1000)}秒）`)
      return false
    } finally {
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
        // 往上挖台阶：必须先挖身体位置(y+1)，再挖头顶(y+2)
        // 只挖头顶的话，身体那格还是实心，跳了也上不去
        const body = bot.blockAt(p.offset(0, 1, 0))
        const head = bot.blockAt(p.offset(0, 2, 0))
        for (const blk of [body, head]) {
          if (!blk) continue
          if (blk.name === 'air' || blk.name === 'cave_air') continue
          if (/bedrock/.test(blk.name)) continue
          try {
            await this.bestToolFor(blk)
            await bot.dig(blk, true)
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

  /**
   * 找最近的**能走到跟前**的某种方块。
   * findBlock 只看距离，不管够不够得着；挖不到的东西等于没有。
   */
  findReachableBlock (name, maxDist = 32) {
    const def = mcData.blocksByName[name]
    if (!def) return null
    const p = this.pos()
    // 收集附近所有这个方块，按距离排序，挨个试
    const cands = []
    const r = Math.min(maxDist, 32)
    for (let dx = -r; dx <= r; dx += 1) {
      for (let dy = -8; dy <= 8; dy += 1) {
        for (let dz = -r; dz <= r; dz += 1) {
          const b = this.bot.blockAt(p.offset(dx, dy, dz))
          if (!b || b.name !== name) continue
          cands.push(b)
        }
      }
    }
    if (!cands.length) return null
    cands.sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p))
    // 返回最近的（能不能走到由 digAt 判断）
    return cands[0]
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
    // 挖脚下要小心：如果下面 3 格内有岩浆/水/虚空，就不挖
    const p0 = this.pos()
    const isUnderfoot = Math.floor(p0.x) === block.position.x &&
      Math.floor(p0.z) === block.position.z &&
      Math.floor(p0.y) - block.position.y <= 1
    if (isUnderfoot) {
      for (let dy = 1; dy <= 3; dy++) {
        const below = this.bot.blockAt(block.position.offset(0, -dy, 0))
        if (!below) return false
        if (/lava|water/.test(below.name)) return false
        if (below.name === 'bedrock') return false
      }
      // 检查通过，允许挖脚下（digStone 靠这个往下走）
    }
    // 目标旁边是岩浆就不挖（挖开会流过来）
    for (const d of [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]) {
      const nb = this.bot.blockAt(block.position.offset(d[0], d[1], d[2]))
      if (nb && nb.name === 'lava') return false
    }
    // ===== 关键：必须走到跟前才能挖 =====
    // 距离超过约 4.5 格时，客户端以为挖到了，服务端直接忽略，不掉东西。
    // 这就是"挖了但背包没涨"的真正原因。
    const REACH = 4.2
    let d = block.position.distanceTo(this.pos())
    if (d > REACH) {
      // 走过去，并且检查是不是真走到了
      const ok = await this.goto(
        block.position.x, block.position.y, block.position.z,
        Math.max(1, Math.floor(REACH) - 2), 25000
      )
      d = block.position.distanceTo(this.pos())
      if (!ok || d > REACH + 0.8) {
        // 到不了就别挖 —— 挖了也是白挖
        this.log(`[dig] 够不到（差 ${d.toFixed(1)} 格），不挖了`)
        return false
      }
    }

    // 走过去之后方块可能已经变了，再确认一次
    const again = this.bot.blockAt(block.position)
    if (!again || again.name === 'air' || again.name === 'cave_air') return false
    block = again

    // 再确认一次距离（走的过程中可能被推开）
    if (block.position.distanceTo(this.pos()) > REACH + 0.8) {
      this.log('[dig] 距离又变远了，不挖')
      return false
    }

    // 选对工具（挖不动就明确报错，不拿泥土硬挖石头）
    const toolResult = await this.bestToolFor(block)
    if (!toolResult.ok) {
      this.log(`[dig] 挖不了 ${block.name}：${toolResult.reason}`)
      return false
    }
    if (toolResult.tool) {
      this.log(`[dig] 用 ${toolResult.tool} 挖 ${block.name}`)
    }
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
  /**
   * 换最合适的工具。
   *
   * 之前的实现是坏的：一堆 `null : null` 的死代码，而且只看 material 字段，
   * 遇到 "mineable/pickaxe" 这种格式就匹配不上，结果拿着泥土去挖石头。
   *
   * 现在用 mineflayer 自带的 bestHarvestTool —— 它知道每个方块需要什么工具等级。
   *
   * @returns {Promise<{ok:boolean, tool:string|null, reason:string}>}
   */
  async bestToolFor (block) {
    const bot = this.bot
    if (!block) return { ok: false, tool: null, reason: '没有方块' }

    try {
      // mineflayer 的 bot.pathfinder.bestHarvestTool 会返回最优工具（可能为 null）
      const best = bot.pathfinder && bot.pathfinder.bestHarvestTool
        ? bot.pathfinder.bestHarvestTool(block)
        : null

      if (best) {
        // 已经拿在手上就不换
        if (bot.heldItem && bot.heldItem.name === best.name) {
          return { ok: true, tool: best.name, reason: '已经在手上' }
        }
        await bot.equip(best, 'hand')
        return { ok: true, tool: best.name, reason: '换上了' }
      }
    } catch (e) {}

    // 兜底：按方块需要的工具类型自己找
    const need = this._toolKindFor(block)
    if (need) {
      const found = bot.inventory.items()
        .filter(i => i.name.includes(need))
        .sort((a, b) => this._toolRank(b.name) - this._toolRank(a.name))[0]
      if (found) {
        try {
          await bot.equip(found, 'hand')
          return { ok: true, tool: found.name, reason: '按类型找到 ' + need }
        } catch (e) {}
      }
      // 需要工具但没有
      const canDigBare = this._canDigByHand(block)
      if (!canDigBare) {
        return {
          ok: false,
          tool: null,
          reason: `需要${need === 'pickaxe' ? '镐子' : need === 'axe' ? '斧头' : need === 'shovel' ? '铲子' : '工具'}，但身上没有`
        }
      }
    }

    // 空手也能挖的（泥土、沙子、木头）
    return { ok: true, tool: null, reason: '空手可以挖' }
  }

  /** 这个方块需要什么类型的工具 */
  _toolKindFor (block) {
    const mat = String(block.material || '')
    const name = block.name || ''
    if (mat.includes('pickaxe')) return 'pickaxe'
    if (mat.includes('axe')) return 'axe'
    if (mat.includes('shovel')) return 'shovel'
    if (mat.includes('hoe')) return 'hoe'
    if (mat.includes('shears') || /leaves|wool/.test(name)) return 'shears'
    // 兜底：按方块名判断
    if (/stone|ore|deepslate|cobble|andesite|diorite|granite|obsidian|netherrack|brick|concrete|terracotta/.test(name)) return 'pickaxe'
    if (/_log$|_planks$|_wood$|crafting_table|chest|furnace|door|fence/.test(name)) return 'axe'
    if (/dirt|sand|gravel|clay|snow|soul_soil/.test(name)) return 'shovel'
    return null
  }

  /** 工具等级（数字越大越好） */
  _toolRank (name) {
    if (/netherite/.test(name)) return 6
    if (/diamond/.test(name)) return 5
    if (/iron/.test(name)) return 4
    if (/stone/.test(name)) return 3
    if (/golden/.test(name)) return 2
    if (/wooden/.test(name)) return 1
    return 0
  }

  /** 空手能不能挖 */
  _canDigByHand (block) {
    const name = block.name || ''
    // 石头类空手挖不掉
    if (/stone|ore|deepslate|cobble|andesite|diorite|granite|obsidian/.test(name)) return false
    return true
  }

  /**
   * 检查关键工具还在不在。镐子会坏，坏了就挖不了石头。
   * @returns {{has:boolean, missing:string[]}}
   */
  checkTools () {
    const items = this.bot.inventory.items()
    const has = (kind) => items.some(i => i.name.includes(kind))
    const missing = []
    if (!has('pickaxe')) missing.push('pickaxe')
    return { has: missing.length === 0, missing }
  }

  /**
   * 想办法弄一把镐子。
   * 优先级：背包有现成的 → 有原木就做 → 有木板就做 → 什么都没有就砍树
   */
  async ensurePickaxe () {
    const items = this.bot.inventory.items()
    // 1. 已经有
    const have = items.filter(i => /_pickaxe$/.test(i.name))
      .sort((a, b) => this._toolRank(b.name) - this._toolRank(a.name))[0]
    if (have) {
      try { await this.bot.equip(have, 'hand') } catch (e) {}
      return have.name
    }

    this.log('[tool] 没有镐子，得做一把')

    // 2. 有原木 -> 做木板 -> 做木棍 -> 做镐
    if (this.woodCount() > 0) {
      try {
        await this.anyPlanks(4)
        await this.craftSmart('stick', 2)
        await this.craftSmart('wooden_pickaxe', 1)
        const p = this.item('wooden_pickaxe')
        if (p) { await this.bot.equip(p, 'hand'); this.log('[tool] 做了把木镐'); return 'wooden_pickaxe' }
      } catch (e) {
        this.log('[tool] 做木镐失败: ' + e.message)
      }
    }

    // 3. 有木板 -> 直接做木棍
    const plank = this.bestPlank()
    if (plank && this.countOf(plank) >= 3) {
      try {
        await this.craftSmart('stick', 2)
        await this.craftSmart('wooden_pickaxe', 1)
        const p = this.item('wooden_pickaxe')
        if (p) { await this.bot.equip(p, 'hand'); this.log('[tool] 用木板做了把木镐'); return 'wooden_pickaxe' }
      } catch (e) {}
    }

    // 4. 有圆石+木棍 -> 做石镐
    if (this.countOf('cobblestone') >= 3 && this.countOf('stick') >= 2) {
      try {
        await this.craftSmart('stone_pickaxe', 1)
        const p = this.item('stone_pickaxe')
        if (p) { await this.bot.equip(p, 'hand'); this.log('[tool] 做了把石镐'); return 'stone_pickaxe' }
      } catch (e) {}
    }

    // 5. 什么都没有 -> 得去砍树
    this.log('[tool] 没有材料，得先砍树')
    try {
      if (this.isUnderground()) await this.getToSurface()
      await this.ensureWood(3)
      await this.anyPlanks(4)
      await this.craftSmart('stick', 2)
      await this.craftSmart('wooden_pickaxe', 1)
      const p = this.item('wooden_pickaxe')
      if (p) { await this.bot.equip(p, 'hand'); this.log('[tool] 砍树后做了把木镐'); return 'wooden_pickaxe' }
    } catch (e) {
      this.log('[tool] 还是弄不到镐子: ' + e.message)
    }

    throw new Error('弄不到镐子（没原木没木板没木棍）')
  }

  /**
   * 挖之前检查工具，挖不动就明确报错，别拿着泥土硬挖。
   */
  async ensureToolFor (block) {
    const r = await this.bestToolFor(block)
    if (!r.ok) {
      throw new Error(`挖不了 ${block.name}：${r.reason}`)
    }
    return r
  }

  async mine (blockName, count = 1, maxDist = 32) {
    await this.ensureChunks()

    // 挖石头类的东西之前，先确保有镐子（没镐子挖了不掉东西）
    const needPick = /stone|ore|deepslate|cobble|andesite|diorite|granite|obsidian/.test(blockName)
    if (needPick) {
      const t = this.checkTools()
      if (!t.has) {
        this.log(`[mine] 没有镐子，挖 ${blockName} 不会掉东西，先做一把`)
        await this.ensurePickaxe()
      }
    }
    // 关键：数的是掉落物，不是方块名
    const itemName = dropOf(blockName)
    const startCount = this.countOf(itemName)

    // 挖地表资源（原木）时如果在地下，先上去
    if (/_log$/.test(blockName) && this.isUnderground()) {
      this.log('[mine] 在地下挖不到原木，先回地面')
      await this.getToSurface()
      await this.ensureChunks(3000)
    }

    const def = mcData.blocksByName[blockName]
    if (!def) throw new Error('没有这种方块: ' + blockName)

    const failed = []      // 试过挖不到的坐标
    let got = 0
    let attempts = 0
    const maxAttempts = count * 6 + 15

    while (got < count && attempts++ < maxAttempts) {
      this.check()
      if (this.bot.health <= 6) throw new Error('血太少了，得先撤')
      if (this.bot.oxygenLevel < 8) throw new Error('快淹死了')

      // 找最近的、没试过的
      let target = null
      const p = this.pos()
      const r = Math.min(maxDist, 32)
      const cands = []
      for (let dx = -r; dx <= r; dx += 1) {
        for (let dy = -10; dy <= 10; dy += 1) {
          for (let dz = -r; dz <= r; dz += 1) {
            const b = this.bot.blockAt(p.offset(dx, dy, dz))
            if (!b || b.name !== blockName) continue
            const key = `${b.position.x},${b.position.y},${b.position.z}`
            if (failed.includes(key)) continue
            cands.push(b)
          }
        }
      }
      if (!cands.length) {
        if (got === 0) {
          // 附近真没有：走远点找
          this.log(`[mine] 附近 ${r} 格内没 ${blockName}，走远找`)
          await this.wander(30)
          await this.ensureChunks(3000)
          continue
        }
        break
      }
      cands.sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p))
      target = cands[0]

      const ok = await this.digAt(target)
      if (ok) {
        got++
        try { await this.pickupNearby(4) } catch (e) {}
      } else {
        // 记下来，别再试
        failed.push(`${target.position.x},${target.position.y},${target.position.z}`)
        if (failed.length >= 8 && got === 0) {
          this.log(`[mine] 试了 ${failed.length} 个都挖不到，放弃`)
          break
        }
      }
      await sleep(120)
    }

    // 返回真实增加的数量
    const gained = this.countOf(itemName) - startCount
    return gained > 0 ? gained : got
  }

  // 砍树：找原木，挖掉整棵
  /** 通知外部"遇到挫折了"（用来触发吐槽） */
  complain (kind, detail) {
    if (this.ctx && this.ctx.onComplain) {
      try { this.ctx.onComplain(kind, detail) } catch (e) {}
    }
  }

  async chopTree (count = 1) {
    await this.ensureChunks()
    const logs = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
      'mangrove_log', 'cherry_log', 'pale_oak_log']
    let trees = 0
    let wanderTry = 0
    const tried = []      // 记录试过但砍不动的树坐标，别重复试

    // 在地下找不到树很正常 —— 先爬回地面
    if (this.isUnderground()) {
      this.log('[chop] 在地下，先回地面')
      const ok = await this.getToSurface()
      if (!ok) throw new Error('在地下爬不出去，砍不了树')
      await this.ensureChunks(3000)
    }

    // 关键：先在最大半径内找一遍，别急着走
    await sleep(300)
    while (trees < count) {
      this.check()
      let found = null
      // 由近到远找（跳过已经试过砍不动的）
      for (const dist of [16, 32, 64]) {
        for (const l of logs) {
          const def = mcData.blocksByName[l]
          if (!def) continue
          // 找所有这个种类的树，跳过试过的
          const candidates = this.bot.findBlocks({ matching: def.id, maxDistance: dist, count: 20 })
          for (const pos of candidates) {
            const key = `${pos.x},${pos.y},${pos.z}`
            if (tried.includes(key)) continue
            found = this.bot.blockAt(pos)
            if (found) break
          }
          if (found) break
        }
        if (found) break
      }
      // 实在没有：长途去找（树经常在几十格之外）
      if (!found) {
        found = await this.travelToFind(() => this.findAny(logs, 64), 5, 45)
      }
      if (!found) {
        this.complain('nothingFound', '走了一圈没树')
        throw new Error('走了很远也没找到树')
      }
      // 砍这一棵：从下往上，检查每块是否真的挖掉了
      const base = found.position
      let chopped = 0
      for (let dy = 0; dy < 8; dy++) {
        const b = this.bot.blockAt(base.offset(0, dy, 0))
        if (!b || !logs.includes(b.name)) break
        const ok = await this.digAt(b)
        if (ok) chopped++
        else break          // 挖不动就别硬挖（比如太高够不到）
      }
      if (chopped > 0) {
        trees++
        // 每棵树砍完立刻捡，别等全部砍完（不然前面的掉落物早跑出范围了）
        try { await this.pickupNearby(8) } catch (e) {}
      } else {
        // 这棵砍不动，记下来别再试
        tried.push(`${base.x},${base.y},${base.z}`)
        const dist = found.position.distanceTo(this.pos())
        this.log(`[chop] 这棵砍不动（差 ${dist.toFixed(0)} 格），换一棵`)
        // 如果连续几棵都很远，说明该换个地方了
        if (tried.length >= 3) {
          this.log('[chop] 附近几棵都够不到，走远点')
          try { await this.wander(40) } catch (e) {}
          await this.ensureChunks(4000)
          tried.length = 0     // 换地方后重新计
        }
        if (tried.length >= 5) throw new Error('试了 5 棵树都砍不动')
      }
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
    // 试几个位置，别死磕一个（每次都重新找，会挑分数更高的）
    for (let attempt = 0; attempt < 5; attempt++) {
      const sp = attempt === 0 ? spot : this.findPlaceSpot(8 + attempt * 2)
      if (!sp) break
      try {
        await this.bot.lookAt(sp.base.position.offset(0.5, 0.5, 0.5), true)
        await sleep(120)
        await this.bot.placeBlock(sp.base, new Vec3(0, 1, 0))
        await sleep(250)
        const placed = this.bot.blockAt(new Vec3(sp.x, sp.y, sp.z))
        if (placed && placed.name === blockName) return placed
      } catch (e) {
        const msg = String(e && e.message || '')
        // blockUpdate 超时说明服务端没回包（网络或卡顿），不是位置问题
        if (/blockUpdate|did not answer/i.test(msg)) {
          this.log(`[place] 服务端没回包（第${attempt + 1}次），等一下重试`)
          await sleep(600)
          continue
        }
        this.log('placeNearby try' + attempt + ': ' + msg)
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

    // 走到工作台旁边再确认配方
    if (table) await this.goto(table.position.x, table.position.y, table.position.z, 3, 15000)
    const usable = this.bot.recipesFor(id, null, Math.max(1, count - this.countOf(name)), table || null)
    // 关键：优先用补料时选的那个配方，别让 usable[0] 换成别的变体
    // （补的是 oak_planks，结果用了需要 birch_planks 的配方 -> missing ingredient）
    let recipe = pick.r
    if (usable && usable.length) {
      const same = usable.find(r => r.result.id === pick.r.result.id)
      recipe = same || usable[0]
    }
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

    // 2. 手上有，放下去（放不下就走几步再试，别直接放弃）
    if (this.countOf('crafting_table') > 0) {
      for (let i = 0; i < 3; i++) {
        const placed = await this.placeNearby('crafting_table')
        if (placed) return placed
        try { await this.wander(5) } catch (e) {}
        await sleep(400)
      }
      // 还放不下：先挖平脚边一块地
      try { await this.flattenSpot() } catch (e) {}
      const placed2 = await this.placeNearby('crafting_table')
      if (placed2) return placed2
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

  /**
   * 我现在是不是在地下。
   *
   * 判据：从头顶往上找，第一块"能挡住光"的方块离我多远。
   *   - 3 格内就有 -> 肯定在洞里
   *   - 一直通到天空（找到 y>=120 还没遮挡）-> 露天
   *   - 中间遇到遮挡，但上面还有空 -> 半封闭（山洞、树下）
   *
   * 之前用"头顶 10 格有 4 格实心"判定，但每走一步地形都变，
   * 同一个位置两次测出不同结果。
   */
  isUnderground () {
    const bot = this.bot
    const p = this.pos()

    // 头顶 2 格就被挡 -> 肯定在洞里
    const near = bot.blockAt(p.offset(0, 2, 0))
    const near2 = bot.blockAt(p.offset(0, 3, 0))
    if (near && near.boundingBox === 'block') return true
    if (near2 && near2.boundingBox === 'block') return true

    // 往上找第一个遮挡
    let firstBlockAt = -1
    for (let dy = 4; dy <= 60; dy++) {
      const b = bot.blockAt(p.offset(0, dy, 0))
      if (!b) break
      if (b.boundingBox === 'block' && !/leaves|log/.test(b.name)) {
        firstBlockAt = dy
        break
      }
    }

    // 一直通到天（60 格内没遮挡）-> 露天
    if (firstBlockAt < 0) return false

    // 头顶 15 格内就有石头 -> 在洞里
    // （实测：y=51 时头顶 +9 才开始有石头，+20 是地表草地。
    //  原来的阈值 8 太严，差一格就误判成露天）
    if (firstBlockAt <= 15) return true

    // 更远的遮挡：可能是山体或树冠，算露天
    return false
  }

  /**
   * 挖一条台阶回到地面。
   * 这是真人在洞里最常干的事：往上挖个楼梯出来。
   */
  /**
   * 挖阶梯回到地面。
   *
   * 关键：必须挖"楼梯"，不能原地往上挖。
   * 楼梯 = 往前走一格的同时上升一格。
   * 每步：挖掉【前方】的方块（脚下那格 + 上面两格），然后走进去跳上去。
   *
   * 之前失败的原因：只挖了自己头顶，但脚下没变，跳了也上不去。
   */
  /**
   * 挖阶梯回到地面。
   *
   * 踩过的坑：直接"挖头顶然后跳"不行，因为跳上去脚下是空的，会掉下来。
   *
   * 正确做法（真人挖楼梯就是这样）：
   *   1. 先把【前方 y+1】挖空（这是我的身体要占的位置）
   *   2. 把【前方 y+0】填上（这是我的脚要踩的台阶）
   *   3. 挖掉【前方 y+2】（头）
   *   4. 跳上去
   *
   * 这样每走一步上升一格，形成台阶。
   */
  /**
   * 从地下出来。
   *
   * 关键设计（跟真人挖矿道一样）：
   *   挖一条 **2 格高、1 格宽的斜梯**，每前进 1 格上升 1 格。
   *
   * 之前失败的原因：
   *   - 只挖自己头顶，脚下没变，跳上去还是原地
   *   - 前方挖开了但没台阶踩，跳上去会掉下来
   *
   * 正确做法：每步挖【前方 y+0 y+1 y+2】三格，然后往前走 + 跳。
   * 前方 y+0 挖空了也不要紧，因为跳的瞬间会踩到新挖出来的地面。
   */
  async getToSurface (maxSteps = 80) {
    const bot = this.bot
    if (!this.isUnderground()) return true

    const startY = this.pos().y
    this.log('[surface] 在地下（y=' + Math.round(startY) + '），往上开一条路')

    const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]
    const bad = new Set()          // 「格子|方向」试过且失败，别原地打转

    const filler = () => ['dirt', 'cobblestone', 'andesite', 'stone', 'gravel', 'granite', 'diorite']
      .map(n => this.item(n)).find(Boolean)

    const isSolid = (v) => {
      const b = bot.blockAt(v)
      return !!(b && b.boundingBox === 'block')
    }
    const isFree = (v) => {
      const b = bot.blockAt(v)
      return !b || b.boundingBox !== 'block'
    }
    const nameAt = (v) => {
      const b = bot.blockAt(v)
      return b ? b.name : 'null'
    }

    // 挖掉一格。返回 true 表示这一格现在是空的（本来就空也算成功）
    const digOne = async (v) => {
      const b = bot.blockAt(v)
      if (!b) return false
      if (b.boundingBox !== 'block') return true
      if (/bedrock|lava|water/.test(b.name)) return false
      try {
        await this.bestToolFor(b)
        await bot.dig(b, true)
        await sleep(130)
      } catch (e) {
        // 挖一半被打断很常见，看最终结果说话
      }
      return isFree(v)
    }

    /**
     * 站到脚下方块的正中心。
     *
     * 这是「台阶垫不上」的真凶：人站在格子边上（比如 x=73.77），
     * 身体（半宽 0.3）已经探进了前面那格，服务端直接拒绝放置，
     * 报 "the block is still air"。实测居中到 0.09 格之后就放得上了。
     */
    const recenter = async () => {
      for (let i = 0; i < 12; i++) {
        const p = this.pos()
        const dx = Math.floor(p.x) + 0.5 - p.x
        const dz = Math.floor(p.z) + 0.5 - p.z
        if (Math.hypot(dx, dz) < 0.12) return true
        try {
          await bot.look(Math.atan2(-dx, -dz), 0, true)
          bot.setControlState('forward', true)
          await sleep(Math.max(60, Math.min(240, Math.hypot(dx, dz) * 400)))
          bot.setControlState('forward', false)
          await sleep(110)
        } catch (e) { break }
      }
      const p = this.pos()
      return Math.hypot(Math.floor(p.x) + 0.5 - p.x, Math.floor(p.z) + 0.5 - p.z) < 0.3
    }

    /**
     * 上到指定那一格。
     * 一格台阶优先交给 pathfinder（实测 0.4 秒就上去了），
     * 手动 jump+forward 在矮通道里起不来，只当兜底。
     */
    const stepUpTo = async (x, y, z) => {
      try {
        bot.pathfinder.setGoal(new goals.GoalBlock(x, y, z))
        for (let i = 0; i < 12; i++) {
          await sleep(180)
          if (this.pos().y >= y - 0.15) break
        }
      } catch (e) {}
      try { bot.pathfinder.setGoal(null) } catch (e) {}
      if (this.pos().y >= y - 0.15) return true

      try {
        const p = this.pos()
        await bot.look(Math.atan2(-(x - p.x), -(z - p.z)), 0, true)
        bot.setControlState('jump', true)
        bot.setControlState('forward', true)
        await sleep(420)
        bot.setControlState('jump', false)
        bot.setControlState('forward', false)
        await sleep(450)
      } catch (e) {}
      return this.pos().y >= y - 0.15
    }

    // ===== 塔升：真人在洞里最直接的走法，1 格宽也管用 =====
    // 实测：allow1by1towers 打开后，pathfinder 0.25 秒就能把自己顶上 1 格，
    //       1 格宽的竖井里也管用。这是整条路的主力。
    //
    // main.js 全局已经配好 towers + scafoldingBlocks，但这里不依赖它：
    // 直接就地补齐当前 movements 对象上的几个开关（缺哪个补哪个），
    // 做完在 finally 里还原。这样不管 main.js 怎么改都不会塌。
    const SCAFFOLD = ['dirt', 'cobblestone', 'andesite', 'stone', 'gravel', 'granite', 'diorite']
    const moves = bot.pathfinder.movements
    const saved = {}
    const restore = []
    if (moves) {
      for (const k of ['allow1by1towers', 'canDig', 'digCost', 'canOpenDoors', 'liquidCost', 'maxDropDown']) {
        saved[k] = moves[k]
        restore.push(k)
      }
      try {
        moves.allow1by1towers = true
        moves.canDig = true
        if (!moves.scafoldingBlocks || !moves.scafoldingBlocks.length) {
          saved.scafoldingBlocks = moves.scafoldingBlocks
          restore.push('scafoldingBlocks')
          moves.scafoldingBlocks = SCAFFOLD
            .map(n => bot.registry.itemsByName[n])
            .filter(Boolean)
            .map(it => it.id)
        }
      } catch (e) {
        this.log('[surface] 塔升开关设置失败：' + (e && e.message))
      }
    }
    const towerOk = !!(moves && moves.allow1by1towers)

    // 原地上顶一格。成功返回 true。
    const tryPillar = async (dbg) => {
      if (!towerOk) { this.log('[dbg] 塔升不可用 towerOk=false'); return false }
      if (!filler()) { this.log('[dbg] 没有垫脚方块'); return false }
      const p = this.pos()
      const F = Math.floor(p.y)

      // 头顶 8 格里有水/岩浆就别直着上（会淹死/烧死）
      for (let dy = 2; dy <= 8; dy++) {
        const n = nameAt(p.offset(0, dy, 0))
        if (/water|lava/.test(n)) { this.log(`[dbg] 头顶 +${dy} 是 ${n}，不直上`); return false }
      }
      // 挖出站人和起跳的空间
      const dug = []
      for (let dy = 2; dy <= 4; dy++) {
        if (isSolid(p.offset(0, dy, 0))) {
          const ok = await digOne(p.offset(0, dy, 0))
          dug.push(`+${dy}:${ok ? 'ok' : 'FAIL'}:${nameAt(p.offset(0, dy, 0))}`)
        }
      }
      if (dbg && dug.length) this.log('[dbg] 挖头顶 ' + dug.join(' '))
      try {
        let st = '?'
        const onUpd = (r) => { st = r.status }
        bot.on('path_update', onUpd)
        if (dbg) this.log(`[dbg] 配置 towers=${moves && moves.allow1by1towers} scaff=${moves && moves.scafoldingBlocks && moves.scafoldingBlocks.length} canDig=${moves && moves.canDig} moving=${(() => { try { return bot.pathfinder.isMoving() } catch (e) { return 'err' } })()}`)
        bot.pathfinder.setGoal(new goals.GoalBlock(Math.floor(p.x), F + 1, Math.floor(p.z)))
        for (let i = 0; i < 18; i++) {
          await sleep(200)
          if (this.pos().y >= F + 0.9) break
        }
        bot.removeListener('path_update', onUpd)
        if (dbg) this.log('[dbg] path_update 最后状态 = ' + st)
      } catch (e) {
        this.log('[dbg] setGoal 异常 ' + e.message)
      }
      try { bot.pathfinder.setGoal(null) } catch (e) {}
      const rose = this.pos().y >= F + 0.9
      if (dbg && !rose) {
        this.log(`[dbg] 塔升失败 F=${F} y=${this.pos().y.toFixed(2)} 头顶=${[0,1,2,3,4].map(d => nameAt(p.offset(0, d, 0))).join(',')}`)
      }
      return rose
    }

    try {
      for (let step = 0; step < maxSteps; step++) {
        this.check()

        if (!this.isUnderground()) {
          const climbed = Math.round(this.pos().y - startY)
          this.log(`[surface] 出来了！y=${Math.round(this.pos().y)}（上升 ${climbed} 格）`)
          return true
        }

        // ===== 主策略：原地往上顶一格 =====
        if (await tryPillar(true)) continue

        // ===== 兜底：挖台阶（头顶有水/岩浆、或者没垫脚方块时才走这里）=====
        const p = this.pos()
        const F = Math.floor(p.y)
        const here = `${Math.floor(p.x)},${F},${Math.floor(p.z)}`

        // 先给自己留出跳跃空间：2 格高的通道里跳只抬 0.5 格，够不到 1 格台阶
        for (const dy of [2, 3]) {
          if (isSolid(p.offset(0, dy, 0))) await digOne(p.offset(0, dy, 0))
        }

        // 挑方向：必须真能形成「一格台阶」
        // 台阶成立 = 前方 (dx,F) 实心（踩的台面）+ (dx,F+1)/(dx,F+2) 空。
        // 原来随机挑方向，老是往"下方悬空"那边跳，跳进去只会平走，一格不升。
        const cands = []
        for (const [dx, dz] of DIRS) {
          if (bad.has(`${here}|${dx},${dz}`)) continue
          const stepV = p.offset(dx, 0, dz)
          const bodyV = p.offset(dx, 1, dz)
          const headV = p.offset(dx, 2, dz)
          const supV = p.offset(dx, -1, dz)
          const blocked = (v) => /bedrock|lava|water/.test(nameAt(v))
          if (blocked(bodyV) || blocked(headV)) continue
          if (isSolid(stepV)) cands.push({ dx, dz, score: 10 })
          else if (isSolid(supV)) cands.push({ dx, dz, score: 5 })
        }

        if (!cands.length) {
          this.log('[surface] 这一步四个方向都挖不成台阶，挪一格再看')
          let moved = false
          for (const [dx, dz] of DIRS) {
            if (isSolid(p.offset(dx, 0, dz)) || isSolid(p.offset(dx, 1, dz)) ||
                isSolid(p.offset(dx, 2, dz)) || !isSolid(p.offset(dx, -1, dz))) continue
            try {
              const tx = Math.floor(p.x) + dx
              const tz = Math.floor(p.z) + dz
              bot.pathfinder.setGoal(new goals.GoalBlock(tx, F, tz))
              for (let i = 0; i < 8; i++) {
                await sleep(160)
                const q = this.pos()
                if (Math.floor(q.x) === tx && Math.floor(q.z) === tz) break
              }
              bot.pathfinder.setGoal(null)
            } catch (e) {}
            moved = this.pos().distanceTo(p) > 0.6
            if (moved) break
          }
          if (!moved) {
            this.log('[surface] 挪不动了，把头顶一路挖开')
            for (const dy of [2, 3, 4, 5]) await digOne(p.offset(0, dy, 0))
          }
          await sleep(200)
          continue
        }

        cands.sort((a, b) => b.score - a.score)
        const { dx, dz } = cands[0]

        // 挖出身体和头的空间
        const bodyOk = await digOne(p.offset(dx, 1, dz))
        const headOk = await digOne(p.offset(dx, 2, dz))
        if (!bodyOk || !headOk) {
          bad.add(`${here}|${dx},${dz}`)
          this.log(`[surface] (${dx},${dz}) 挖不开，换方向`)
          continue
        }

        // 台阶面：没有就自己垫一块
        if (!isSolid(p.offset(dx, 0, dz))) {
          const fill = filler()
          const sup = bot.blockAt(p.offset(dx, -1, dz))
          if (!fill || !sup) {
            bad.add(`${here}|${dx},${dz}`)
            this.log('[surface] 没有垫脚方块或下方没支撑，换方向')
            continue
          }
          try {
            await recenter()                      // 不站中心，放方块必被拒
            await bot.equip(fill, 'hand')
            await bot.lookAt(sup.position.offset(0.5, 1.0, 0.5), true)
            await sleep(140)
            await bot.placeBlock(sup, new Vec3(0, 1, 0))
            await sleep(220)
          } catch (e) {}
          if (!isSolid(p.offset(dx, 0, dz))) {
            bad.add(`${here}|${dx},${dz}`)
            this.log(`[surface] (${dx},${dz}) 台阶垫不上，换方向`)
            continue
          }
        }

        // 上去，并且验证真的上去了
        const tx = Math.floor(p.x) + dx
        const tz = Math.floor(p.z) + dz
        await stepUpTo(tx, F + 1, tz)

        const nowY = this.pos().y
        if (nowY < F + 0.9) {
          bad.add(`${here}|${dx},${dz}`)
          this.log(`[surface] 方向 (${dx},${dz}) 上不去（y=${nowY.toFixed(1)}），换方向`)
        }
        await sleep(150)
      }
    } finally {
      try { bot.pathfinder.setGoal(null) } catch (e) {}
      // 把临时补的寻路开关还原，别影响别的动作
      if (moves) {
        for (const k of restore) {
          try { moves[k] = saved[k] } catch (e) {}
        }
      }
      for (const k of ['forward', 'back', 'left', 'right', 'jump']) {
        try { bot.setControlState(k, false) } catch (e) {}
      }
    }

    const climbed = this.pos().y - startY
    this.log(`[surface] 挖了 ${maxSteps} 步，上升 ${Math.round(climbed)} 格，还没出去`)
    return !this.isUnderground()
  }

  /** 把脚边挖平，腾出一块能放东西的地方 */
  async flattenSpot () {
    const bot = this.bot
    const p = this.pos()
    // 挖掉脚边和头顶的方块
    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]) {
      for (const dy of [0, 1]) {
        const b = bot.blockAt(p.offset(dx, dy, dz))
        if (!b) continue
        if (b.name === 'air' || b.name === 'cave_air') continue
        if (/bedrock|water|lava/.test(b.name)) continue
        try {
          await this.bestToolFor(b)
          await bot.dig(b, true)
          await sleep(150)
        } catch (e) {}
      }
      // 检查这个位置现在能不能放
      const base = bot.blockAt(p.offset(dx, 0, dz))
      const up = bot.blockAt(p.offset(dx, 1, dz))
      if (base && this.solidBlock(base) && up && up.name === 'air') return true
    }
    return false
  }

  // 找一块能放东西的空地（周围有实体地面）
  /**
   * 找一块能放东西的地方。
   *
   * 踩过的坑：在 coal_ore（矿石）上面放东西，服务端会拒绝
   * （"the block is still air"）。石头、泥土上就没问题。
   * 所以这里给底座方块打分，优先选稳定的。
   */
  findPlaceSpot (radius = 6) {
    const p = this.pos()
    const solid = (n) => {
      if (!n || n === 'air' || n === 'cave_air') return false
      if (/water|lava/.test(n)) return false
      return true
    }

    // 底座方块好不好放东西（分数越高越优先）
    const baseScore = (name) => {
      if (!name) return -1
      if (/^(stone|cobblestone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff)$/.test(name)) return 10
      if (/^(dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium)$/.test(name)) return 9
      if (/^(sand|red_sand|gravel|clay)$/.test(name)) return 7
      if (/_planks$|_log$/.test(name)) return 8
      if (/_ore$|^raw_/.test(name)) return 2      // 矿石上不好放
      if (/leaves|glass|ice|magma|soul_sand/.test(name)) return 0
      return 5
    }

    const cands = []
    for (let r = 1; r <= radius; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          // 只走外圈（内圈上轮扫过了）
          if (r > 1 && Math.abs(dx) !== r && Math.abs(dz) !== r) continue
          for (let dy = -2; dy <= 2; dy++) {
            const base = this.bot.blockAt(p.offset(dx, dy - 1, dz))
            const at = this.bot.blockAt(p.offset(dx, dy, dz))
            const up = this.bot.blockAt(p.offset(dx, dy + 1, dz))
            if (!base || !at || !up) continue
            if (!solid(base.name)) continue
            const atFree = at.name === 'air' || at.name === 'cave_air' || at.boundingBox === 'empty'
            const upOk = up.boundingBox !== 'block'
            if (!atFree || !upOk) continue

            const score = baseScore(base.name) - r * 0.5 - Math.abs(dy) * 0.3
            cands.push({
              x: Math.floor(p.x + dx),
              y: Math.floor(p.y + dy),
              z: Math.floor(p.z + dz),
              base,
              score
            })
          }
        }
      }
    }

    if (!cands.length) return null
    // 挑分数最高的
    cands.sort((a, b) => b.score - a.score)
    return cands[0]
  }

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
    // 没镐子挖石头不掉东西
    if (!this.checkTools().has) {
      this.log('[digStone] 没有镐子，先做一把')
      await this.ensurePickaxe()
    }
    const got = () => this.countOf('cobblestone') + this.countOf('cobbled_deepslate')
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

    const f = await this.openSafely(furnace)
    try {
      await f.putInput(input.type, null, Math.min(count, input.count))
      const need = Math.max(1, Math.ceil(Math.min(count, input.count) / 8))
      await f.putFuel(fuel.type, null, Math.min(need, fuel.count))
      // 等烧：烤好一个就取一个，别等凑满（凑满容易超时）
      const t0 = Date.now()
      let taken = 0
      const want = Math.min(count, input.count)
      while (Date.now() - t0 < 90000 && taken < want) {
        await sleep(1000)
        const out = f.outputItem()
        if (out && out.count > 0) {
          taken += out.count
          try { await f.takeOutput() } catch (e) {}
        }
      }
      return taken > 0
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

  /**
   * 安全地打开容器。
   *
   * mineflayer 默认等 20 秒才超时，而且一超时整个流程就崩。
   * 实测正常打开只要 300ms 左右，所以：
   *   - 5 秒超时（不是 20 秒）
   *   - 失败重试 3 次，每次先走到跟前、面朝方块
   *   - 每次失败后等一会儿（网络抖动）
   */
  async openSafely (block) {
    const bot = this.bot
    if (!block) throw new Error('没有可打开的方块')

    const kind = /chest|barrel|shulker/.test(block.name) ? 'container'
      : block.name === 'furnace' ? 'furnace'
      : block.name === 'crafting_table' ? 'crafting'
      : 'block'

    for (let attempt = 0; attempt < 3; attempt++) {
      this.check()

      // 1. 确认方块还在
      const live = bot.blockAt(block.position)
      if (!live || live.name !== block.name) {
        throw new Error(`方块没了（${block.name}）`)
      }

      // 2. 停寻路、站定
      try { bot.pathfinder.setGoal(null) } catch (e) {}
      for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
        try { bot.setControlState(k, false) } catch (e) {}
      }
      await sleep(200)

      // 3. 走到跟前（2 格内）
      const d = live.position.distanceTo(this.pos())
      if (d > 3) {
        try {
          await this.goto(live.position.x, live.position.y, live.position.z, 2, 12000)
        } catch (e) {}
        await sleep(200)
      }

      // 4. 面朝它
      try {
        await bot.lookAt(live.position.offset(0.5, 0.5, 0.5), true)
        await sleep(150)
      } catch (e) {}

      // 5. 5 秒超时打开（不是 20 秒）
      try {
        const win = await Promise.race([
          kind === 'furnace' ? bot.openFurnace(live) : bot.openContainer(live),
          new Promise((_, rej) => setTimeout(() => rej(new Error('打开超时(5s)')), 5000))
        ])
        return win
      } catch (e) {
        const msg = String(e && e.message || '')
        this.log(`[open] 第${attempt + 1}次失败：${msg}`)
        // 超时的话，可能服务端还在处理，等久一点
        await sleep(800 + attempt * 700)
        // 换个位置再试
        if (attempt === 1) {
          try { await this.wander(3) } catch (e2) {}
        }
      }
    }
    throw new Error(`打不开 ${block.name}（试了3次）`)
  }

  async openChest (x, y, z) {
    const b = this.bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)))
    if (!b || !/chest|barrel|shulker/.test(b.name)) throw new Error('那里没有箱子')
    return this.openSafely(b)
  }

  async depositAll (x, y, z, except = []) {
    const c = await this.openChest(x, y, z)
    let moved = 0
    try {
      // 每次操作后背包会变，所以要重新取列表
      for (let round = 0; round < 3; round++) {
        const items = this.bot.inventory.items()
          .filter(it => !except.some(e => it.name.includes(e)))
        if (!items.length) break
        let any = false
        for (const it of items) {
          // 关键：itemType 必须是有效数字，否则 mineflayer 内部断言失败
          const t = Number(it.type)
          if (!Number.isInteger(t) || t < 0) continue
          try {
            await c.deposit(t, null, it.count)
            moved++
            any = true
          } catch (e) {}
        }
        if (!any) break
        await sleep(200)
      }
      return moved > 0
    } finally {
      try { c.close() } catch (e) {}
    }
  }

  async withdraw (x, y, z, itemName, count = 1) {
    const c = await this.openChest(x, y, z)
    try {
      const slot = c.containerItems().find(i => i.name === itemName)
      if (!slot) throw new Error('箱子里没有 ' + itemName)
      const t = Number(slot.type)
      if (!Number.isInteger(t) || t < 0) throw new Error('物品 ID 无效: ' + slot.type)
      await c.withdraw(t, null, Math.min(count, slot.count))
      return true
    } finally {
      try { c.close() } catch (e) {}
    }
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

  /** 敲一个指令（比如 /home /spawn /tpa 张三） */
  async runCommand (cmd) {
    const clean = String(cmd || '').replace(/^\//, '').trim()
    if (!clean) return false
    // 管理指令一律不许
    if (/^(op|deop|ban|kick|whitelist|gamemode|give|tp|setblock|fill|clone|summon|kill|effect|enchant|xp|clear|difficulty|gamerule|stop|reload)\b/i.test(clean)) {
      this.log('[cmd] 拒绝管理指令: /' + clean)
      return false
    }
    try {
      this.bot.chat('/' + clean)
      await sleep(500)
      return true
    } catch (e) { return false }
  }

  // ---------------- 人的动作（不产出资源，纯人味） ----------------

  /** 转头看四周（真的转一圈） */
  async lookAround (steps = 4) {
    const bot = this.bot
    for (let i = 0; i < steps; i++) {
      const yaw = (Math.PI * 2 / steps) * i
      try { await bot.look(yaw, 0.1, true) } catch (e) {}
      await sleep(420)
    }
    return true
  }

  /** 按方位走（不是坐标，是"往东北走一段"） */
  async walkTo (dir, blocks = 10) {
    const map = { 北: [0, -1], 南: [0, 1], 东: [1, 0], 西: [-1, 0],
      东北: [0.7, -0.7], 西北: [-0.7, -0.7], 东南: [0.7, 0.7], 西南: [-0.7, 0.7] }
    const d = map[dir] || map[北]
    const p = this.pos()
    return this.goto(p.x + d[0] * blocks, p.y, p.z + d[1] * blocks, 2, 25000)
  }

  /** 探头看（往前探一下再回来） */
  async peek (dir = '北') {
    const map = { 北: [0, -1], 南: [0, 1], 东: [1, 0], 西: [-1, 0] }
    const d = map[dir] || map[北]
    const p = this.pos()
    try {
      await this.bot.look(Math.atan2(-d[0], d[1]), 0, true)
      await sleep(200)
      await this.goto(p.x + d[0] * 2, p.y, p.z + d[1] * 2, 1, 8000)
    } catch (e) {}
    return true
  }

  /** 站着等（不是 sleep —— 是站在原地，会转头看看） */
  async wait (seconds = 10) {
    const bot = this.bot
    const t0 = Date.now()
    while (Date.now() - t0 < seconds * 1000) {
      this.check()
      // 偶尔转头
      if (Math.random() < 0.3) {
        try { await bot.look(bot.entity.yaw + (Math.random() - 0.5), 0, false) } catch (e) {}
      }
      await sleep(1200)
    }
    return true
  }

  /** 坐下（潜行 = 蹲下，视觉上像坐着） */
  async sit (seconds = 8) {
    const bot = this.bot
    try { bot.setControlState('sneak', true) } catch (e) {}
    await this.wait(seconds)
    try { bot.setControlState('sneak', false) } catch (e) {}
    return true
  }

  /** 瞥某人一眼 */
  async glance (name) {
    const pl = this.bot.players[name]
    if (!pl || !pl.entity) return false
    try {
      await this.bot.lookAt(pl.entity.position.offset(0, 1.6, 0), true)
      await sleep(600)
    } catch (e) {}
    return true
  }

  /** 指方向（转头对着那个方向，然后回来看人） */
  async point (dir) {
    const map = { 北: 0, 东北: Math.PI / 4, 东: Math.PI / 2, 东南: Math.PI * 3 / 4,
      南: Math.PI, 西南: -Math.PI * 3 / 4, 西: -Math.PI / 2, 西北: -Math.PI / 4 }
    try {
      await this.bot.look(map[dir] || 0, 0, true)
      await sleep(700)
    } catch (e) {}
    return true
  }

  /** 丢东西给某人 */
  async toss (itemName, count = 1) {
    const it = this.item(itemName)
    if (!it) throw new Error('没有 ' + itemName)
    try {
      await this.bot.equip(it, 'hand')
      await this.bot.look(this.bot.entity.yaw, -0.6, true)
      this.bot.activateItem()
      await sleep(300)
      this.bot.deactivateItem()
      return true
    } catch (e) { return false }
  }

  /** 听声音：返回附近能听到的动静 */
  listen (radius = 24) {
    const bot = this.bot
    const p = this.pos()
    const heard = []
    for (const e of Object.values(bot.entities)) {
      if (!e || e === bot.entity || !e.name) continue
      const d = e.position.distanceTo(p)
      if (d > radius) continue
      const map = {
        zombie: '低吼', skeleton: '骨头响', creeper: '嘶嘶声', spider: '窸窣声',
        cow: '哞', pig: '哼唧', chicken: '咯咯', sheep: '咩'
      }
      const snd = map[e.name]
      if (snd) heard.push(`${snd}（${Math.round(d)} 格外）`)
    }
    return heard.length ? heard.join('、') : '没什么动静'
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

module.exports = { Actions, sleep, BLOCK_DROPS, dropOf }
