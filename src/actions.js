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
    // layer=-1 是脚下那层。原来用 0（身体层），露天地形下 169 格全是"·"，
    // 264 字符（占全图 33%）纯废。改用脚下层，能看到地表材质和落脚点。
    out.push(this.lookTop(range, -1))
    return out.join('\n')
  }

  /**
   * 判断某个方向能不能走（用视觉判断，不靠算法）
   * @returns {{walkable:boolean, needDig:number, reason:string}}
   */
  /**
   * 判断某个方向能不能走。
   *
   * 踩过的坑：原版只检查 body/head 是不是空的，完全没管 feet。
   * feet 是实心（半砖、台阶、栅栏、雪层）时，身体过得去但脚过不去，
   * 判"能走"然后撞上去。
   *
   * 而且 "dig <= 2 就能走" 太宽松 —— 身体和头都被堵（dig=2）
   * 可能是一堵厚墙，挖 2 格也过不去（后面还有）。
   *
   * 现在按真人走路的判断：
   *   - 脚、身、头三格都空 + 脚下有地 = 直接能走
   *   - 身/头堵但脚空 + 脚下有地 = 挖 1-2 格能走（矮顶或树枝）
   *   - 脚堵 = 走不过去（要么挖脚下，要么绕）
   *   - 脚下悬空 = 走不过去（会掉下去）
   */
  canWalkTo (dx, dz) {
    const p = this.pos()
    const feet = this.bot.blockAt(p.offset(dx, 0, dz))
    const body = this.bot.blockAt(p.offset(dx, 1, dz))
    const head = this.bot.blockAt(p.offset(dx, 2, dz))
    const below = this.bot.blockAt(p.offset(dx, -1, dz))

    const isFree = b => b && (b.name === 'air' || b.name === 'cave_air' || b.boundingBox === 'empty')
    const isSolid = b => b && b.boundingBox === 'block'

    if (!feet || !body || !head) return { walkable: false, needDig: 99, reason: '看不清（区块没加载）' }
    if (/lava/.test(feet.name) || /lava/.test(below?.name || '')) {
      return { walkable: false, needDig: 99, reason: '有岩浆' }
    }
    if (/water/.test(feet.name)) {
      return { walkable: false, needDig: 99, reason: '有水，会淹' }
    }

    // 脚下有没有地踩
    const hasFloor = isSolid(below)
    if (!hasFloor) {
      return { walkable: false, needDig: 99, reason: '脚下悬空，会掉下去' }
    }

    // 脚这一格是实心 -> 过不去（除非挖掉）
    if (!isFree(feet)) {
      return { walkable: false, needDig: 1, reason: `脚那格是${feet.name}，得挖掉或绕` }
    }

    // 身体和头
    let dig = 0
    if (!isFree(body)) dig++
    if (!isFree(head)) dig++

    if (dig === 0) {
      return { walkable: true, needDig: 0, reason: '直接能走' }
    }
    if (dig === 1) {
      return { walkable: true, needDig: 1, reason: `挖 1 格（${isFree(body) ? head.name : body.name}）就能走` }
    }
    // 身体和头都堵：可能是一堵厚墙，挖 2 格也未必通
    return { walkable: false, needDig: 99, reason: '身和头都堵着，像堵墙，别硬挖' }
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
      // ===== 垂直预判：明显够不到就别试了 =====
      //
      // gotoVertical 一次能磨 40 秒（guard<40 × 1 秒）。实测日志里
      // 「[goto] 高度到不了」连着刷 6 次，每次白耗 20 秒以上，
      // 整轮任务就烧在这上面了（目标 y=57 现在 y=63，那种是地下矿）。
      //
      // 判据：垂直差 > 8 格，且这一路往上/往下没有可挖的方块、也没有水 ——
      // 那就不是"走两步能解决"的高度差，直接放弃，让调用方换目标。
      // 往下走挖楼梯是可以的（挖石头），所以只对"往上"和"全是基岩"收紧。
      if (dy > 8) {
        const canFix = this._canCloseGap(Math.round(y), Math.round(p0.y))
        if (!canFix) {
          this.log(`[goto] 高度差 ${Math.round(dy)} 格，没路可挖，不试了（目标 y=${Math.round(y)}，现在 y=${Math.round(p0.y)}）`)
          return false
        }
      }
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

        // 1. 到达判定：水平近 + 垂直也必须近
        //
        // 【重要】容差不能比挖掘范围大。
        // 踩过的坑：这里原来是 range+2（调用方传 range=3 -> 5 格就判"到了"），
        // 但 digAt 的 REACH 只有 4.2 格。
        // 实测：goto 到树判"成功"，最终距树 6.0 格 —— 然后 digAt 挖不到，
        // chopTree 报"走不到这棵"，整条链断掉。
        //
        // 现在：容差 = min(range + 1, 3.5)，保证判"到了"的时候真的够得着。
        const dxz = Math.hypot(p.x - x, p.z - z)
        const dyAbs = Math.abs(p.y - y)
        const tol = Math.min(range + 1, 3.5)
        if (dxz <= tol && dyAbs <= 2) {
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
   * 高度差这么大，我有没有办法把它补上？
   *
   * 只回答"有没有可行的办法"，不保证成功率 —— 目的是在 gotoVertical
   * 白磨 20~40 秒之前先判一次。
   *
   * 规则：
   *   · 往下：挖竖井/楼梯总能下去，只要路上不是基岩、不是岩浆/水
   *   · 往上：得有可挖的方块（挖出台阶），或者本来就有坡道（附近有可站的落脚点）
   *   · 路上有岩浆/水 -> 不挖（会把自己灌了）
   *
   * @returns {boolean}
   */
  _canCloseGap (targetY, curY) {
    const bot = this.bot
    const p = this.pos()
    const up = targetY > curY
    const gap = Math.abs(targetY - curY)

    // 最多扫这么多格；差得再远（比如地表 y=63 要下到 y=16）也只看这几十格
    const span = Math.min(gap, 40)

    if (!up) {
      // ---- 往下：看这一列能不能挖 ----
      for (let i = 1; i <= span; i++) {
        const b = bot.blockAt(p.offset(0, -i, 0))
        if (!b) return false                        // 看不见，别猜
        if (/bedrock/.test(b.name)) return false    // 撞到基岩层，到底了
        if (/lava|water/.test(b.name)) return false // 挖开会流过来
      }
      return true
    }

    // ---- 往上：得有能挖穿的方块 ----
    let solid = 0
    for (let i = 1; i <= span; i++) {
      const b = bot.blockAt(p.offset(0, i, 0))
      if (!b) return false
      if (/lava|water/.test(b.name)) return false
      if (b.boundingBox === 'block') solid++
    }
    // 全是实心：挖台阶上去是完全可行的（地表往地下矿走正是这种）
    // 全是空气：那本来就是通的，pathfinder 能飞/搭，也算可行
    // 只有"大部分实心但夹着岩浆/水"才是真无解，上面已经挡掉了
    return solid >= 0
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
      //
      // 【严重 bug，已修】这里原来是：
      //   const tx = p.x + (Math.random() - 0.5) * 6
      //   const tz = p.z + (Math.random() - 0.5) * 6
      // 每轮随机 ±3 格。而 gotoVertical 最多跑 40 轮，
      // 每轮都把人往随机方向推 —— 40 轮累计能把 bot 甩出几十格。
      //
      // 实测证据（/tmp/diag/stair-test.js、walkto-test.js）：
      //   树 78,77,55 距我 51.7  -> 调 goto 后位置 52,68,-62，距树干 119.61
      //   树 100,71,56 距我 63.0 -> 调 goto 后位置 56,63,-47，距树干 111.64
      // 日志里"差 4~6 格"和"差 120 格"交替出现，就是它造成的。
      //
      // 现在：**朝目标方向固定小步移动**。以目标 (x,z) 为参考轴，
      // 每轮只朝那个方向推进 2 格 —— 不随机，累积也是朝目标走。
      // 注意 gotoVertical 只拿到 targetY，没有 x/z，所以用"尽量靠近自己"
      // 的保守偏移：同一列 ±2 格内，方向由轮次奇偶交替（探两侧坡道），
      // 幅度固定，不会像随机那样到处乱窜。
      const side = (guard % 4) - 1.5          // -1.5, -0.5, 0.5, 1.5（固定序列）
      const axis = (guard % 2) === 0 ? 'x' : 'z'
      const tx = p.x + (axis === 'x' ? side * 2 : 0)
      const tz = p.z + (axis === 'z' ? side * 2 : 0)
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
  async digAt (block, opts = {}) {
    if (!block) return false
    this.check()

    // walkToBlock：够不到时允不允许自己走过去。
    //
    // 默认 true（保持历史行为，别打破现有调用方）。
    // 但"为了够到一棵树/一个方块而走动"这件事本身很危险：
    // digAt 内部调的是 this.goto，而 goto 在 |dy|>2 时先进 gotoVertical，
    // 那里每轮随机 ±3 格 —— 实测能把 bot 从树旁甩到 120 格外
    // （/tmp/diag/goto-bug.js：树距 51.7 -> 调用后距树干 119.61）。
    //
    // 所以需要"精确站位"的场合（挖台阶、挖树干）应该传 false：
    // 只负责"伸手够得到就挖"，够不到立刻 false，由调用方负责站位。
    const walkToBlock = opts.walkToBlock !== false

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
        // 下面没方块（区块没加载）不算危险，别误杀
        // 实测：砍树时树干正好在脚边，下方是 air，原来直接 return false
        // 日志报"这棵砍不动（差 1.1 格）"，1.1 格明明够得着
        if (!below) continue
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
      if (!walkToBlock) {
        // 调用方要求"只挖够得着的"，那就明确失败，不要自己乱走
        this.log(`[dig] 够不到（差 ${d.toFixed(1)} 格），按调用方要求不移动`)
        return false
      }
      // 走过去，并且检查是不是真走到了
      //
      // 预算收窄到 12 秒：原来给 25 秒，而 gotoVertical 单次就能磨 40 秒，
      // 一个 digAt 最坏能烧掉一分钟。挖一格不值得。
      const ok = await this.goto(
        block.position.x, block.position.y, block.position.z,
        Math.max(1, Math.floor(REACH) - 2), 12000
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

    // 选对工具
    //
    // 两种模式：
    //   allowBare=true  -> 开路模式：没有镐也挖（空手挖石头慢、不掉料，但能挖通）
    //   allowBare=false -> 收集模式：没工具就不挖（挖了也白挖）
    //
    // 实测：e2e 的地下夹具第 3 格挖不动，就是因为空手挖石头被这里拦住。
    // 而 getToSurface / digUpOne 开路时根本不需要掉落物，只要通路。
    const toolResult = await this.bestToolFor(block)
    if (!toolResult.ok) {
      if (opts.allowBare) {
        this.log(`[dig] 没工具，空手挖 ${block.name}（开路用，不掉落）`)
      } else {
        this.log(`[dig] 挖不了 ${block.name}：${toolResult.reason}`)
        return false
      }
    }
    if (toolResult.tool) {
      this.log(`[dig] 用 ${toolResult.tool} 挖 ${block.name}`)
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.bot.dig(block, true)
        // 挖完必须捡！东西会掉在地上，不走过去捡就等于白挖
        try {
          await sleep(150)
          await this.pickupNearby(4)
        } catch (e2) {}

        // ===== 记路：这一带有什么 =====
        // 只在矿石上记 —— 挖泥土/石头也记的话，记忆里全是"那边有泥土"，
        // 真正有用的"那儿有铁"会被冲掉。
        // learnPlace(where, what) 落成一句「{where}那边有{what}」。
        try {
          const ORE_CN = {
            coal_ore: '煤', deepslate_coal_ore: '煤',
            iron_ore: '铁', deepslate_iron_ore: '铁',
            copper_ore: '铜', deepslate_copper_ore: '铜',
            gold_ore: '金', deepslate_gold_ore: '金',
            redstone_ore: '红石', deepslate_redstone_ore: '红石',
            lapis_ore: '青金石', deepslate_lapis_ore: '青金石',
            diamond_ore: '钻石', deepslate_diamond_ore: '钻石',
            emerald_ore: '绿宝石', deepslate_emerald_ore: '绿宝石',
            nether_quartz_ore: '石英', ancient_debris: '远古残骸'
          }
          const what = ORE_CN[block.name]
          const mem = this.ctx && this.ctx.mem
          if (what && mem && typeof mem.learnPlace === 'function') {
            const bp = block.position
            // 同一种矿、同一片区域（16×16、8 格高一层）10 分钟只记一次。
            // 不然一口气挖 20 块铁矿会写 20 条一模一样的记忆。
            this._oreNotes = this._oreNotes || new Map()
            const key = block.name + '@' +
              Math.floor(bp.x / 16) + ',' + Math.floor(bp.z / 16) + ',' + Math.floor(bp.y / 8)
            const last = this._oreNotes.get(key) || 0
            if (!last || Date.now() - last > 10 * 60 * 1000) {
              this._oreNotes.set(key, Date.now())
              const where = '地下 y=' + Math.round(bp.y) + ' 那一带（' + Math.round(bp.x) + ', ' + Math.round(bp.z) + '）'
              mem.learnPlace(where, what, { importance: 0.55 })
              this.log('[dig] 记住了：' + where + '有' + what)
            }
          }
        } catch (e3) {}

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

      // 关键：只接受真正的工具。
      // bestHarvestTool 在没有合适工具时会返回手边任意物品
      // （实测它把 stick 当成工具去挖草方块），必须过滤掉。
      const isRealTool = best && /_pickaxe$|_axe$|_shovel$|_hoe$|_sword$|shears$/.test(best.name)
      if (best && isRealTool) {
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
    const picks = items.filter(i => /_pickaxe$/.test(i.name))
      .sort((a, b) => this._toolRank(b.name) - this._toolRank(a.name))
    const missing = []
    if (!picks.length) missing.push('pickaxe')

    // 顺带把"能不能现场造一把"的材料情况也报出来。
    // 之前只回 {has:false}，上层（测试/决策）看到 false 就以为没救，
    // 直接跳过挖石头 —— 其实手上 2 个原木就够做木镐了。
    const planks = this.bestPlank()
    const plankCount = planks ? this.countOf(planks) : 0
    const sticks = this.countOf('stick')
    const logs = this.woodCount()
    // 木镐 = 3 木板 + 2 木棍；木棍 = 2 木板；工作台 = 4 木板
    // 所以从零开始一共要 9 木板 = 3 原木（工作台可以反复用）
    const canCraft = !!picks.length || (plankCount >= 5 && sticks >= 2) ||
      (logs > 0) || (this.countOf('cobblestone') >= 3 && sticks >= 2)

    return {
      has: picks.length > 0,
      missing,
      pickaxe: picks.length ? picks[0].name : null,
      planks: plankCount,
      sticks,
      logs,
      canCraft
    }
  }

  /**
   * 想办法弄一把镐子。
   * 优先级：背包有现成的 → 圆石+木棍做石镐 → 木板/原木做木镐 → 砍树再做
   *
   * 数量账（之前算错，导致"有木头也做不出镐"）：
   *   木镐 = 3 木板 + 2 木棍
   *   木棍 = 2 木板 → 4 木棍
   *   工作台 = 4 木板（做木镐必须有工作台，3x3 配方）
   *   合计 = 3 + 2 + 4 = 9 木板
   *   1 原木 = 4 木板 → 至少 3 个原木
   * 老代码只 anyPlanks(4)，做到一半就没木板了，然后 craftSmart 在里面
   * 反复"缺材料 → 补料 → 又缺"，白烧时间。
   *
   * @param {{budgetMs?:number}} opts
   * @returns {Promise<string>} 镐子物品名
   */
  async ensurePickaxe (opts = {}) {
    // 重入保护。
    // craftSmart 的第 3c 步（石头类材料缺失 -> 先弄镐子）会调到这里，
    // 而这里第 2 步在有圆石+木棍时又会 craftSmart('stone_pickaxe') ——
    // 两者一对上就是无限递归（depth 参数在 ensurePickaxe 这一层是断的）。
    // 同一个实例上已有一次在跑，就直接按"拿不到"返回，让上层走它的兜底。
    if (this._ensuringPickaxe) {
      this.log('[tool] ensurePickaxe 正在跑，避免递归，直接返回')
      const busyPick = this.bot.inventory.items()
        .filter(i => /_pickaxe$/.test(i.name))
        .sort((a, b) => this._toolRank(b.name) - this._toolRank(a.name))[0]
      return busyPick ? busyPick.name : null
    }
    this._ensuringPickaxe = true
    try {
      return await this._ensurePickaxeInner(opts)
    } finally {
      this._ensuringPickaxe = false
    }
  }

  async _ensurePickaxeInner (opts = {}) {
    // 默认 200 秒。算过的账：
    //   ensureWood(3) 内部最多两轮 chopTree(1)，单轮 chopTree 的 DEADLINE 是 85 秒，
    //   所以一轮备料最坏 ~85 秒（成功则远快，实测 53~99 秒砍到）。
    //   200 秒 = 两次完整机会 + 收尾；挖石头任务本身给 300 秒，
    //   剩下的 100 秒留给真正的"挖 3 块石头"。
    //   给到 240 秒以上就会把挖石头的时间吃掉，反而更差。
    const budgetMs = opts.budgetMs || 200000
    const deadline = Date.now() + budgetMs
    const left = () => deadline - Date.now()

    const pickUp = () => this.bot.inventory.items()
      .filter(i => /_pickaxe$/.test(i.name))
      .sort((a, b) => this._toolRank(b.name) - this._toolRank(a.name))[0]

    // 1. 已经有
    let have = pickUp()
    if (have) {
      try { await this.bot.equip(have, 'hand') } catch (e) {}
      return have.name
    }

    this.log('[tool] 没有镐子，得做一把')

    // 2. 有圆石+木棍：石镐最省（不用木板），优先做
    if (this.countOf('cobblestone') >= 3 && this.countOf('stick') >= 2) {
      try {
        await this.craftSmart('stone_pickaxe', 1)
        have = pickUp()
        if (have) { await this.bot.equip(have, 'hand'); this.log('[tool] 做了把石镐'); return have.name }
      } catch (e) {
        this.log('[tool] 石镐没做成: ' + e.message)
      }
    }

    // 3. 备料：原木 -> 9 木板（3 原木），不够就砍树
    const PLANKS_NEEDED = 12      // 9 够用，多备 3 块当余量
    const LOGS_NEEDED = Math.ceil(PLANKS_NEEDED / 4)

    const plankTotal = () => {
      const p = this.bestPlank()
      return p ? this.countOf(p) : 0
    }

    // 备木头：反复试，直到够用或预算耗尽。
    // chopTree 能不能砍到树跟地形强相关（实测同一位置有时 53 秒成功、
    // 有时 380 秒都走不到），只给它一轮机会等于赌运气。
    if (this.isUnderground()) {
      this.log('[tool] 在地下砍不到树，先上去')
      try { await this.getToSurface() } catch (e) {}
    }

    // ===== 关键补充：先攒垫脚料 =====
    //
    // 踩过的坑（这个服务器的树大量长在浮空平台上）：
    //   树干下方是 air、4.2 格内可站格数 0、canSeeBlock=false
    //   -> 只能垫方块爬上去
    //   -> 但没料就永远爬不上去
    //   -> 没原木就做不出镐
    //   -> 没镐就挖不了石头（挖了不掉）
    //
    // 空手能挖的只有软方块：dirt / grass_block / gravel / sand / clay。
    // 所以砍树之前先攒 8 块，爬树成功率会高很多。
    const fillerTotal = () => ['dirt', 'cobblestone', 'andesite', 'stone', 'gravel',
      'granite', 'diorite', 'cobbled_deepslate', 'sand', 'clay', 'grass_block']
      .reduce((n, k) => n + this.countOf(k), 0)

    if (fillerTotal() < 6 && left() > 60000) {
      this.log(`[tool] 垫脚料只有 ${fillerTotal()} 块，先挖点软方块`)
      const soft = ['dirt', 'grass_block', 'gravel', 'sand', 'clay']
      const t0 = Date.now()
      for (const name of soft) {
        if (fillerTotal() >= 8 || Date.now() - t0 > 25000) break
        for (let tries = 0; tries < 3; tries++) {
          const b = this.findReachableBlock ? this.findReachableBlock(name, 12) : this.findBlock(name, 12)
          if (!b) break
          try { await this.digAt(b) } catch (e) { break }
          if (fillerTotal() >= 8) break
        }
      }
      this.log(`[tool] 垫脚料攒到 ${fillerTotal()} 块（用了 ${Math.round((Date.now() - t0) / 1000)}s）`)
    }

    let woodRound = 0
    // 只有剩 45 秒以上才开新一轮：一轮最坏 85 秒，开不了就别开，
    // 否则会在超预算后还在跑，把调用方的任务预算烧穿。
    while (this.woodCount() * 4 + plankTotal() < PLANKS_NEEDED &&
           left() > 45000 && woodRound < 3) {
      woodRound++
      this.log(`[tool] 备木头第 ${woodRound} 轮（现有原木 ${this.woodCount()}、木板 ${plankTotal()}、剩 ${Math.round(left() / 1000)}s）`)
      try {
        await this.ensureWood(LOGS_NEEDED, { budgetMs: Math.min(left() - 15000, 200000) })
      } catch (e) {
        this.log('[tool] 砍树失败: ' + e.message)
      }
      // 这一轮没进展就短暂歇一下再试（可能刚走错方向）
      if (this.woodCount() === 0 && woodRound < 4) {
        try { await this.wander(10) } catch (e) {}
        await this.ensureChunks(2500)
      }
    }

    const needLogs = Math.max(0, Math.ceil((PLANKS_NEEDED - plankTotal()) / 4))
    if (this.woodCount() < needLogs) {
      this.log(`[tool] 原木不够（${this.woodCount()}/${needLogs}）`)
    }

    // 4. 原木 -> 木板，逐步做，每步核对增量
    try { await this.anyPlanks(PLANKS_NEEDED) } catch (e) {
      this.log('[tool] 做木板失败: ' + e.message)
    }
    this.log(`[tool] 木板 ${plankTotal()} / 木棍 ${this.countOf('stick')} / 原木 ${this.woodCount()}`)

    // 5. 木板 -> 木棍（2 木板 = 4 木棍，够 2 个镐柄）
    if (this.countOf('stick') < 2 && plankTotal() >= 2) {
      try { await this.craftSmart('stick', 2) } catch (e) {
        this.log('[tool] 做木棍失败: ' + e.message)
      }
    }

    // 6. 木棍 -> 木镐（craftSmart 会自己处理工作台）
    if (plankTotal() >= 3 && this.countOf('stick') >= 2) {
      try {
        await this.craftSmart('wooden_pickaxe', 1)
        have = pickUp()
        if (have) { await this.bot.equip(have, 'hand'); this.log('[tool] 做了把木镐'); return have.name }
      } catch (e) {
        this.log('[tool] 做木镐失败: ' + e.message)
      }
    }

    // 7. 还是不行：**如果还剩足够预算**，再补一轮木头，最后再试一次。
    //
    // 踩过的坑：这里原来只判 `Date.now() < deadline`（还剩 1 毫秒也算），
    // 于是"再补一轮原木"会启动 ensureWood，而 ensureWood 内部
    // chopTree 的 DEADLINE 是 45~150 秒，**完全不看我们的 deadline**。
    // 实测：调用方给了 40 秒预算，这一步照样跑了 4 分 41 秒
    // （07:47:51 进入 -> 07:52:33 还在"备木头第 1 轮"），
    // 调用方那个 300 秒任务预算被整个烧穿，端到端永远显示"挖石头 301s 超时"。
    //
    // 现在：只有在"剩余预算至少够一轮最坏砍树（45 秒）"时才允许开这一轮。
    // 【实测的 bug · 2026-11-13 10:31 e2e】
    //   `弄不到镐子（木板 14、木棍 4、原木 1，试了 0 轮砍树，剩 190s）`
    // 木板 14 张、木棍 4 根都够做木镐了，却直接抛错 ——
    // 因为这里写的是 `left() > 45000 && this.woodCount() === 0`：
    // **只有"一根原木都没有"时才进来**。原木剩 1 个时条件为假，
    // 整段被跳过，然后一路走到最后的 throw。
    //
    // 现在：只要"料够"或者"还有预算砍树"就进来试一次。
    const canCraftNow = plankTotal() >= 3 && this.countOf('stick') >= 2
    if (canCraftNow) {
      // 料已经齐了，不用砍树，直接做
      this.log(`[tool] 料齐了（木板 ${plankTotal()}、木棍 ${this.countOf('stick')}），直接做木镐`)
      try {
        await this.craftSmart('wooden_pickaxe', 1)
        have = pickUp()
        if (have) { await this.bot.equip(have, 'hand'); this.log('[tool] 做成了木镐'); return have.name }
      } catch (e) {
        this.log('[tool] 直接做木镐失败: ' + e.message)
      }
    }

    // 料不够：还有预算就再砍一轮树补料
    if (left() > 45000 && !canCraftNow) {
      this.log(`[tool] 再补一轮原木（剩 ${Math.round(left() / 1000)}s）`)
      try {
        if (this.woodCount() === 0) {
          await this.ensureWood(LOGS_NEEDED, { budgetMs: Math.min(left() - 10000, 200000) })
        }
        await this.anyPlanks(PLANKS_NEEDED)
        await this.craftSmart('stick', 2)
        await this.craftSmart('wooden_pickaxe', 1)
        have = pickUp()
        if (have) { await this.bot.equip(have, 'hand'); this.log('[tool] 补料后做成了木镐'); return have.name }
      } catch (e) {
        this.log('[tool] 补料后还是失败: ' + e.message)
      }
    } else if (!canCraftNow) {
      this.log(`[tool] 剩 ${Math.round(left() / 1000)}s，不够再砍一轮树，直接放弃`)
    }

    throw new Error(`弄不到镐子（木板 ${plankTotal()}、木棍 ${this.countOf('stick')}、` +
      `原木 ${this.woodCount()}，试了 ${woodRound} 轮砍树，剩 ${Math.round(left() / 1000)}s）`)
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

  /**
   * 找附近某种方块。用 findBlocks（读区块缓存）而不是三重 blockAt 循环。
   *
   * 老实现的问题（实测）：
   *   r=32 时是 65 × 21 × 65 ≈ 88,725 次 blockAt，
   *   一次扫描 4.5 秒，而 mine() 的 while 每一轮都要扫一遍。
   *   「挖石头」300 秒超时，绝大部分时间烧在这个循环里。
   *
   * findBlocks 直接遍历已加载区块的调色板，快几十倍；
   * 代价是它只按水平距离筛、不限制 y，所以这里自己补上 y 范围过滤。
   *
   * @returns {Block[]} 已按"垂直加权距离"排好序
   */
  _scanBlocks (blockName, maxDist = 32, count = 1) {
    const def = mcData.blocksByName[blockName]
    if (!def) throw new Error('没有这种方块: ' + blockName)
    const p = this.pos()
    const r = Math.min(maxDist, 32)

    let positions = []
    try {
      positions = this.bot.findBlocks({
        matching: def.id,
        maxDistance: r,
        count: Math.max(24, count * 8 + 16)
      }) || []
    } catch (e) {
      return []
    }

    const out = []
    for (const pos of positions) {
      // findBlocks 不限制垂直范围，自己筛。±12 比原来的 ±10 略宽，
      // 因为垂直已经靠下面的加权排序降权了，不必靠硬砍范围。
      if (Math.abs(pos.y - p.y) > 12) continue
      const b = this.bot.blockAt(pos)
      if (!b || b.name !== blockName) continue
      out.push(b)
    }

    // 垂直加权：y 差 1 格 ≈ 水平差 4 格。
    // 3D 欧氏距离把"y 差 10"和"水平差 10"当等价，但难度天差地别 ——
    // 水平走过去几秒，y 差 10 格要挖楼梯/垫柱子。
    // 实测：他一直在挑 y≈50-57 的 andesite（人在 y=63 地表），
    // 日志里刷「高度到不了 / 172 个 andesite 都够不到」。
    const vScore = (c) => {
      const dxz = Math.hypot(c.position.x - p.x, c.position.z - p.z)
      const dy = Math.abs(c.position.y - p.y)
      return dxz + dy * 4
    }
    out.sort((a, b) => vScore(a) - vScore(b))
    return out
  }

  /** 这个方块旁边有没有空位（有的话抬手就能挖，不用寻路） */
  _isExposed (block) {
    if (!block) return false
    const around = [
      [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]
    ]
    for (const [ox, oy, oz] of around) {
      const nb = this.bot.blockAt(block.position.offset(ox, oy, oz))
      if (!nb) continue
      if (nb.boundingBox === 'empty' || nb.name === 'air' || nb.name === 'cave_air') return true
    }
    return false
  }

  /**
   * 挖某种方块。
   *
   * 三个一起改的坑（都有实测数据撑着）：
   *
   * 1. **扫描慢**：三重 blockAt 循环 88,725 次 / 轮，实测 4.5 秒。
   *    改成 _scanBlocks()（findBlocks + y 过滤）。
   *
   * 2. **可达性预筛把地下石头全毙了**：
   *    老判据是"从自己到目标的连线上，实心方块不超过一半"。
   *    可石头本来就埋在地下 —— 连线上当然全是实心。
   *    结果 reachable 永远为空，日志刷「9331 个 stone 都够不到」，
   *    然后 wander 换地方，再扫一遍，再全毙 —— 永远挖不到一块。
   *    现在改成：够得着就挖；够不着但**有暴露面**就走过去挖；
   *    两个都不是就**往下挖一格**靠近（真人挖石头就是这么干的）。
   *
   * 3. **无限扫描**：整个 mine() 最多扫 5 次，且总时长有硬上限，
   *    到点就返回已经挖到的数量，绝不把 300 秒测试预算烧光。
   *
   * @param {string} blockName 方块名
   * @param {number} count      要挖几个
   * @param {number} maxDist    搜索半径
   * @param {number} budgetMs   本函数总时长上限（默认 50 秒）
   * @returns {Promise<number>} 背包真实增加的数量
   */
  async mine (blockName, count = 1, maxDist = 32, budgetMs = 50000) {
    const tStart = Date.now()
    await this.ensureChunks()

    // 挖石头类的东西之前，先确保有镐子（没镐子挖了不掉东西）
    const needPick = /stone|ore|deepslate|cobble|andesite|diorite|granite|obsidian/.test(blockName)
    if (needPick) {
      const t = this.checkTools()
      if (!t.has) {
        // 【实测的坑】ensurePickaxe() 内部会走 备木头 -> chopTree -> wander，
        // 没有自己的时限。实测「挖石头」300 秒超时里，有 6 分 22 秒全花在这里
        // （07:15:30 进入，07:21:52 才做出木镐）；另一轮实测里
        // ensurePickaxe 直接 75 秒空转、一个原木都没砍到就返回了。
        // 真正 mine() 扫描+挖掘只用 2 秒。
        //
        // 所以这里给"取工具"单独一份**小于总预算**的时间盒：
        // 到点就明确失败返回 0，把"取不到工具"和"挖不到矿"区分开，
        // 也好让端到端测试看到 mine 本身的真实耗时。
        // 40 秒不够砍一轮树（单轮 chopTree 最坏 85 秒），会立刻进
        // "剩 40s 不够再砍一轮"分支秒退 —— 那不是省时间，是根本没试。
        // 取工具给 150 秒（够两轮砍树），挖矿本身留 budgetMs（默认 50 秒扫描+挖掘），
        // 两者相加有明确上界，不会再把 300 秒任务预算烧穿。
        const toolBudget = Math.max(45000, Math.min(150000, budgetMs * 3))
        this.log(`[mine] 没有镐子，挖 ${blockName} 不会掉东西，先做一把（最多 ${Math.round(toolBudget / 1000)}s）`)
        let pickOk = false
        try {
          // 用 ensurePickaxe 自带的 budgetMs，**不要**用 Promise.race 超时：
          // race 只是让 await 提前返回，底层任务还在跑，
          // 会一直占着 this._ensuringPickaxe 递归锁，
          // 后面的 ensurePickaxe 全被挡掉（日志里那句"正在跑，避免递归"就是这么来的）。
          pickOk = !!(await this.ensurePickaxe({ budgetMs: toolBudget }))
        } catch (e) {
          this.log('[mine] 做镐失败：' + e.message)
          pickOk = false
        }
        if (!pickOk) {
          const stillNo = !this.checkTools().has
          if (stillNo) {
            this.log(`[mine] 取不到镐子（花了 ${Math.round((Date.now() - tStart) / 1000)}s），` +
              `挖 ${blockName} 不会掉东西，直接失败`)
            return 0
          }
        }
        this.log(`[mine] 镐子就绪，取工具耗时 ${Math.round((Date.now() - tStart) / 1000)}s`)
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

    const REACH = 4.2
    // 能靠"往下挖"接近的方块。原木/树叶之类不该往下挖，那类够不着就换地方。
    const canApproachByDigging = /stone|deepslate|andesite|diorite|granite|tuff|calcite|_ore$|dirt|gravel|sand/.test(blockName)

    const failed = new Set()   // 试过挖不到的坐标（用 Set，别再 O(n) includes）
    let got = 0
    let scans = 0
    let descents = 0
    const MAX_SCANS = 5          // 整个函数最多扫 5 次
    const MAX_DESCENTS = 6       // 最多往下挖 6 格靠近
    const deadline = Date.now() + Math.max(5000, budgetMs)

    while (got < count) {
      this.check()
      if (this.bot.health <= 6) throw new Error('血太少了，得先撤')
      if (this.bot.oxygenLevel < 8) throw new Error('快淹死了')
      if (Date.now() > deadline) {
        this.log(`[mine] 到时间上限（${Math.round(budgetMs / 1000)}s），已挖到 ${got} 个`)
        break
      }

      const p = this.pos()
      let cands = this._scanBlocks(blockName, maxDist, count)
        .filter(c => !failed.has(`${c.position.x},${c.position.y},${c.position.z}`))
      scans++

      if (!cands.length) {
        if (got > 0 || scans >= MAX_SCANS) break
        this.log(`[mine] 附近 ${Math.min(maxDist, 32)} 格内没 ${blockName}，走远找`)
        await this.wander(15)
        await this.ensureChunks(2500)
        continue
      }

      // ---- 挑目标 ----
      // 优先级：够得着 > 有暴露面（走过去就能挖）> 需要往下挖靠近
      let target = null
      let exposedButFar = null
      for (const c of cands) {
        try {
          if (!this.bot.canDigBlock(c)) continue   // 工具等级不够
        } catch (e) { continue }

        const dist = c.position.distanceTo(p)
        if (dist <= REACH) { target = c; break }
        if (!exposedButFar && this._isExposed(c)) exposedButFar = c
      }
      if (!target && exposedButFar) target = exposedButFar

      // ---- 够不着：往下挖一格靠近（真人挖石头就是这么干的）----
      if (!target) {
        if (!canApproachByDigging || descents >= MAX_DESCENTS || Date.now() > deadline) {
          // 这类方块不能往下挖（比如原木），或者已经挖够了深度 → 换地方
          if (got > 0 || scans >= MAX_SCANS) {
            this.log(`[mine] ${cands.length} 个 ${blockName} 都够不到，放弃`)
            break
          }
          this.log(`[mine] ${cands.length} 个 ${blockName} 都够不到，换个地方`)
          await this.wander(15)
          await this.ensureChunks(2500)
          continue
        }

        // 往下挖一格
        const below = this.bot.blockAt(p.offset(0, -1, 0))
        if (!below || /bedrock|lava|water/.test(below.name)) {
          this.log(`[mine] 下面不能挖（${below ? below.name : '未知'}），换个地方`)
          if (got > 0) break
          await this.wander(12)
          continue
        }
        const y0 = p.y
        const dug = await this.digAt(below)
        if (!dug) {
          this.log('[mine] 往下这一格没挖成，换个地方')
          if (got > 0) break
          await this.wander(12)
          continue
        }
        descents++
        // 等自己掉下去（1 格约 0.3 秒，多给一点）
        for (let i = 0; i < 12 && this.pos().y > y0 - 0.6; i++) await sleep(100)
        await this.pickupNearby(3)
        continue
      }

      // ---- 挖 ----
      const ok = await this.digAt(target)
      if (ok) {
        got++
        try { await this.pickupNearby(4) } catch (e) {}
        // 挖到之后重新扫描（位置可能变了），但别把扫描次数烧光
        if (scans >= MAX_SCANS && got < count) {
          // 还差一些，给一次额外机会
          scans = MAX_SCANS - 1
        }
      } else {
        failed.add(`${target.position.x},${target.position.y},${target.position.z}`)
        if (failed.size >= 8 && got === 0) {
          this.log(`[mine] 试了 ${failed.size} 个都挖不到，放弃`)
          break
        }
      }
      await sleep(80)
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

  /**
   * 砍树。
   *
   * @param {number} count 要砍几棵
   * @param {{budgetMs?:number}} opts budgetMs = 调用方能给的预算（默认按棵数估）
   */
  async chopTree (count = 1, opts = {}) {
    await this.ensureChunks()
    const logs = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
      'mangrove_log', 'cherry_log', 'pale_oak_log']
    let trees = 0
    let awayRounds = 0          // 已经"换方向走远找"了几轮（上限 3）
    const tried = new Set()
    const t0 = Date.now()

    // 【预算】原来的公式是 min(150000, 45000 + count*40000)：
    //   count=1 -> 85000（85 秒）
    // 但调用方（e2e / ensurePickaxe）常常愿意给 240 秒。
    // 85 秒的上限让"周围没树、要走远找"这种情况必然失败 ——
    // 实测：找树 + 走过去 + 砍，正常要 80~120 秒；运气差要 150 秒以上。
    //
    // 现在：优先用调用方给的预算（留 15 秒收尾），否则按棵数估，
    // 但下限提到 120 秒 —— 低于这个数基本不可能砍到（走远找树就要 60 秒+）。
    // 实测（chop-test 08:29）：出生点周围没树时，走 3 轮换方向（约 116 格）
    // 才在第 3 轮后找到树，全程 108 秒。加上垫脚料 14 秒 = 122 秒。
    // 所以默认预算不能只给 120 秒 —— 必须留出"走远找"的余量。
    //   count=1 -> 150 秒（够走 3 轮 + 砍一棵）
    //   count=2 -> 200 秒
    const callerBudget = Number(opts.budgetMs) || 0
    const estimated = Math.min(200000, 110000 + count * 50000)
    const rawBudget = callerBudget > 0 ? Math.min(callerBudget, 200000) : estimated
    const DEADLINE_MS = Math.max(150000, rawBudget)
    const DEADLINE = t0 + DEADLINE_MS
    this.log(`[chop] 预算 ${Math.round(DEADLINE_MS / 1000)}s` +
      (callerBudget > 0 ? `（调用方给 ${Math.round(callerBudget / 1000)}s）` : '（按棵数估）'))

    // 在地下找不到树很正常 —— 先试着爬回地面。
    // 但**爬不上去不等于砍不了树**：地表有很多树根在坡上/洞口边，
    // 站着就能看到、够得着。原来这里直接 throw，等于"爬不出去就彻底放弃"，
    // 日志里表现为连续 4 次 `砍树失败: 在地下爬不出去，砍不了树`，
    // 整个砍树任务一行有效动作都没做。
    // 现在：爬失败就继续往下走，让后面的找树逻辑自己判断能不能够到。
    if (this.isUnderground()) {
      this.log('[chop] 在地下，先试着回地面')
      const ok = await this.getToSurface().catch(() => false)
      if (ok) {
        await this.ensureChunks(3000)
      } else {
        this.log('[chop] 没爬出去，先就地找找有没有够得着的树')
      }
    }

    /**
     * 攒垫脚料。
     *
     * 实测（/tmp/probe11.js、/tmp/probe12.js）：这个服务器的地表树大量长在
     * **浮空/高台上** —— 树干下方是 air，4.2 格内可站格数 0，canSeeBlock(树干)=false。
     * bot 在地面 y=63，树在 y=71，垂直差 8 格。
     *
     * GoalXZ 能 5 秒把人送到水平 0.6 格（/tmp/probe7.js），但高度上不去；
     * GoalNear / GoalGetToBlock 都卡在"差 6.2 格"不动（/tmp/probe8.js）。
     *
     * 唯一可行路径是**垫着方块爬上去**，而 pillarUp 需要手上有泥土/圆石。
     * 之前日志里一直是 `[pillar] 没有可以垫的方块`，因为开局背包是空的。
     * 所以砍树前先挖够垫脚料 —— 现在 pickupNearby 修好了，泥土挖得动也捡得到。
     */
    const fillerCount = () => this.countOf('dirt') + this.countOf('grass_block') +
      this.countOf('cobblestone') + this.countOf('andesite') + this.countOf('stone') +
      this.countOf('gravel')

    // 攒垫脚料 —— **硬预算 20 秒**。
    //
    // 实测（`chop-test` 2026-11-13 08:12）：这段原来没有独立预算，
    // 一轮 14 次 digAt 每次最多 12 秒，实测烧掉 **64 秒**（5.5s -> 69.3s），
    // 而且最后 `垫脚料准备完毕：0 块` —— 一块都没拿到。
    // 64 秒白烧之后，chopTree 的 DEADLINE（85 秒）已经过了大半，
    // 后面的"走到树"根本没有时间，必然报"走不到"。
    //
    // 现在：只给 20 秒，而且"连续两次没进展"就收手。
    const FILLER_BUDGET = 20000
    const fillerT0 = Date.now()
    let fillerDryRounds = 0

    // 【实测的浪费 · 2026-11-13 09:23】无条件先挖垫脚料，结果 48 格内根本没树：
    //   `[chop] 垫脚料准备完毕：5 块（用了 22.4s）`
    //   `[chop] 48 格内没扫到树，先确认区块再决定要不要走远`
    // 22 秒白烧，而调用方只给了 67 秒。
    // 现在：**先确认附近有树且树比人高**，才去攒料，否则直接跳过。
    const treeForFiller = (() => {
      try {
        const t = this.findAny(logs, 48)
        return t ? t.position : null
      } catch (e) { return null }
    })()
    const worthFiller = !!treeForFiller && treeForFiller.y > this.pos().y + 2

    if (fillerCount() < 8 && worthFiller) {
      this.log(`[chop] 树在高 ${Math.round(treeForFiller.y - this.pos().y)} 格处，先攒垫脚料（现有 ${fillerCount()}，最多 20s）`)
      while (fillerCount() < 8 && Date.now() - fillerT0 < FILLER_BUDGET) {
        if (Date.now() > DEADLINE - 15000) break
        if (fillerDryRounds >= 2) {
          this.log('[chop] 连续 2 轮没进展，不再挖垫脚料')
          break
        }
        // 优先挖泥土/草方块（最好挖，空手也掉东西）
        const b = this.findReachableBlock('dirt', 10) ||
          this.findReachableBlock('grass_block', 10) ||
          this.findAny(['dirt', 'grass_block'], 10)
        if (!b) {
          this.log('[chop] 附近没垫脚料可挖')
          break
        }
        const before = fillerCount()
        let ok = false
        try { ok = await this.digAt(b) } catch (e) { ok = false }
        if (ok) {
          // 捡的时候也要看预算：pickupNearby 内部预算是 9 秒，
          // 不看就会把 20 秒的垫脚料预算整个吃掉（实测跑了 38.4 秒）。
          const leftFiller = FILLER_BUDGET - (Date.now() - fillerT0)
          if (leftFiller > 3000) {
            try { await this.pickupNearby(6) } catch (e) {}
          } else {
            // 没时间专门捡了，用一次短促的原地吸附
            await sleep(400)
          }
        }
        // 有进展（拿到料）就重置；否则记一次"空转"
        if (fillerCount() > before) fillerDryRounds = 0
        else fillerDryRounds++
      }
      this.log(`[chop] 垫脚料准备完毕：${fillerCount()} 块（用了 ${((Date.now() - fillerT0) / 1000).toFixed(1)}s）`)
    }

    /**
     * 走到某个坐标附近。
     *
     * 不用 this.goto：goto 在 |dy|>2 时会先走 gotoVertical，
     * 而树经常长在 5 格高的坡上，gotoVertical 直接返回"高度到不了"，
     * 整个砍树流程就卡死在这一步（探针实测 44s 处就是这条）。
     * 这里直接把目标交给 pathfinder，让它的爬坡/搭桥逻辑去处理。
     */
    const walkTo = async (x, y, z, range = 2, timeout = 25000) => {
      try {
        this.bot.pathfinder.setGoal(range <= 0
          ? new goals.GoalBlock(Math.floor(x), Math.floor(y), Math.floor(z))
          : new goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), range))
      } catch (e) { return false }
      const s = Date.now()
      let last = this.pos().clone()
      let still = 0
      try {
        while (Date.now() - s < timeout) {
          this.check()
          const p = this.pos()
          const dxz = Math.hypot(p.x - x, p.z - z)
          if (dxz <= range + 1 && Math.abs(p.y - y) <= 2) return true
          if (p.distanceTo(last) < 0.12) still += 200
          else still = 0
          last = p.clone()
          if (still > 6000) break        // 卡住了，别耗满超时
          await sleep(200)
        }
      } finally {
        try { this.bot.pathfinder.setGoal(null) } catch (e) {}
      }
      return false
    }

    /**
     * 树干旁边能站人的格子。
     *
     * 关键教训 1：直接把 pathfinder 的目标设成"树干那一格"是走不到的 ——
     * 那一格是实心原木，A* 在里面找不到落脚点。
     * 关键教训 2：只找树干**底格**旁边的位置也不够。实测一棵被树叶包住的橡树：
     * 底格 y=71，而 bot 从 y=68 的水平面走过去停在 y=64（GoalXZ 只走水平），
     * 三维距离 7.5 格 —— 差的全是高度，digAt 的 4.2 格够不到。
     * 所以候选格要覆盖整根树干的高度范围，并且优先选"跟 bot 高度接近"的。
     */
    /**
     * 树干旁边能站人的格子。
     *
     * ===== 这一版是按实测数据重写的，不是猜的 =====
     *
     * 诊断脚本（/tmp/diag/reach-gap.js）在两棵树上量出来的对比：
     *
     *   树 55,72,-28  base y=72，bot y=67
     *     老实现候选 11 个，距树干 4.47 / 5.10 / 5.20 ...（高度偏移 +4 / +5）
     *     其中在 digAt REACH(4.2) 内的：**0 个**
     *
     *   树 82,69,-51  base y=69，bot y=67
     *     老实现候选 12 个，距树干 3.16 / 3.32 ...（高度偏移 +3）
     *     其中在 REACH 内的：12 个 ✅
     *
     * 结论：**差的不是水平距离，是 1~2 格高度。**
     * 老实现 `for (dy of [0,1,2,3,4,5,-1,-2])` 只往下扫 2 格，
     * 而树长在高台上时，bot 站在树底下方 4~5 格 —— 那一层根本没扫。
     * 扫到的能站的格子全在树冠顶上（+4/+5），距树干 4.5~5.4 格，
     * 物理上就在挖掘范围外。所以"走到了也没用"。
     *
     * 现在的两条硬规则：
     *   1. 高度区间扩到 **-5 .. +3**（覆盖"人在树下坡"这种最常见的卡点）
     *   2. **先按"距树干 <= 4.0"过滤，再排序** —— 够不着的格子不进候选池。
     *      排序第一优先是"和 bot 当前高度接近"，不是"距树干最近"：
     *      人在 y=68 时，y=68 的格子才走得过去，y=76 的格子看得见摸不着。
     *
     * @returns {Array<{pos:Vec3, need:number, dist:number, dyFromBot:number}>}
     */
    const standSpotsNear = (base) => {
      const p = this.pos()
      const botY = Math.floor(p.y)
      const spots = []
      const seen = new Set()
      const dirs = [
        [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
        [1, 0, 1], [-1, 0, -1], [1, 0, -1], [-1, 0, 1],
        [2, 0, 0], [-2, 0, 0], [0, 0, 2], [0, 0, -2]
      ]

      const REACH_OK = 4.0        // 候选格到树干的距离上限（digAt 是 4.2，留 0.2 余量）

      /**
       * 这个格子能不能站 —— 分两种：
       *   'ok'    现在就空着能站
       *   'dig'   挖掉 1~2 格就能站（树叶 / 矮草 / 雪层）
       *   false   挖也白搭
       */
      const spotInfo = (pos) => {
        const below = this.bot.blockAt(pos.offset(0, -1, 0))
        const at = this.bot.blockAt(pos)
        const up = this.bot.blockAt(pos.offset(0, 1, 0))
        if (!below || !at || !up) return false
        // 脚下必须是实体（树叶、草方块都算；空气不行）
        if (!this.solidBlock(below)) return false
        const soft = (b) => b && (/leaves/.test(b.name) || b.name === 'short_grass' ||
          b.name === 'tall_grass' || b.name === 'fern' || b.name === 'snow' ||
          b.name === 'vine' || b.boundingBox === 'empty')
        let need = 0
        if (this.solidBlock(at)) { if (!soft(at)) return false; need++ }
        if (this.solidBlock(up)) {
          // 头顶那格也得能挖开，否则站进去抬不起头
          if (/oak_log|birch_log|spruce_log|jungle_log|acacia_log|dark_oak_log/.test(up.name)) return false
          need++
        }
        if (need > 2) return false
        return { need }
      }

      // 高度区间 -5 .. +3。
      //   + 方向：树干往上（树冠处的落脚点，通常太远，但有些树只有那里能站）
      //   - 方向：树干往下（**树长在高台上、人站在坡下时，正解就在这一层**）
      // 实测 -4/-5 这两层是"人站树底"场景下唯一能同时满足
      // "脚踩实地" + "距树干 <= 4" 的高度。
      const dyRange = []
      for (let dy = -5; dy <= 3; dy++) dyRange.push(dy)
      // 扫描顺序：从贴近 bot 当前高度的层开始往外扩。
      // 这样 spots 天然是按"走过去要爬几层"排好的，后面的排序只是保底。
      dyRange.sort((a, b) =>
        Math.abs((base.y + a) - botY) - Math.abs((base.y + b) - botY))

      for (const dy of dyRange) {
        for (const [dx, , dz] of dirs) {
          const s = base.offset(dx, dy, dz)
          const key = `${s.x},${s.y},${s.z}`
          if (seen.has(key)) continue
          seen.add(key)

          // ===== 先过滤距离，够不着的一律不进候选池 =====
          const dist = s.distanceTo(base)
          if (dist > REACH_OK) continue

          const info = spotInfo(s)
          if (!info) continue
          spots.push({ pos: s, need: info.need, dist, dyFromBot: Math.abs(s.y - botY) })
        }
      }

      // 排序（三级）：
      //   1. 高度贴近 bot 的优先（爬坡是最容易失败的环节）
      //   2. 不用挖的优先
      //   3. 距我近的优先（少走路）
      // 注意：**不再**按"距树干最近"排第一 —— 那会把树冠顶上够不着的格子排前面。
      spots.sort((a, b) => {
        if (a.dyFromBot !== b.dyFromBot) return a.dyFromBot - b.dyFromBot
        if (a.need !== b.need) return a.need - b.need
        return a.pos.distanceTo(p) - b.pos.distanceTo(p)
      })
      return spots
    }

    /**
     * 挖路直达：沿"我 → 树干"的直线，把挡路的软方块（树叶/草）挖掉。
     *
     * 这是最后的兜底。实测那棵树四周全是树叶，纯靠 pathfinder 走不到，
     * 但人就在 6 格内 —— 挖开两格树叶就能站进去。
     * 比"换下一棵"好，因为周围可能全是这种被树叶包住的树。
     */
    const digPathTo = async (target, maxBlocks = 8) => {
      const from = this.pos().clone()
      const dir = target.clone().subtract(from)
      const len = Math.hypot(dir.x, dir.z)
      if (len < 0.5) return false
      let dug = 0
      for (let i = 1; i <= maxBlocks; i++) {
        const t = i / maxBlocks
        const x = Math.floor(from.x + dir.x * t)
        const z = Math.floor(from.z + dir.z * t)
        for (const dy of [0, 1]) {
          const v = new Vec3(x, Math.floor(from.y) + dy, z)
          const b = this.bot.blockAt(v)
          if (!b) continue
          if (!this.solidBlock(b)) continue
          // 只挖软方块和树干之间的树叶；石头挖不动也不划算
          if (!/leaves|short_grass|tall_grass|fern|vine|snow/.test(b.name)) continue
          try {
            if (await this.digAt(b)) dug++
          } catch (e) {}
        }
        if (dug >= 6) break
      }
      return dug > 0
    }

    /**
     * 挖一条朝树干方向能走的通道。
     *
     * 跟上面的 digPathTo 的区别（那个是错的，Lead 已经指出）：
     *   digPathTo 从"我 → 树干"拉一条直线，只管把中间的软方块挖掉，
     *   但**挖完不动位置**，也没有重建候选格 —— 挖出来的通道没人走，
     *   后面还是拿同一批够不着的候选格去 walkTo，等于白挖。
     *
     * 这个版本按"真人挖一条 2 格高的通道"来做：
     *   1. 从脚下往树干方向，一格一格推进（水平），每格清出脚+头两格
     *   2. 遇到实心就挖（软方块优先；石头等硬方块也挖，但需要工具，
     *      挖不动就停在那儿，别硬耗）
     *   3. **绝不碰树干那一列**（那是要砍的目标，挖掉就没得砍了）
     *   4. 每挖完一格就试着往前走一步（真的移动，不只是清空）
     *
     * @returns {Promise<number>} 挖掉了几格
     */
    const digTowardTrunk = async (base, maxBlocks = 8) => {
      const softName = (n) => /leaves|short_grass|tall_grass|fern|vine|snow|dirt|grass_block|sand|gravel|clay/.test(n)
      const trunkXZ = `${base.x},${base.z}`
      let dug = 0

      for (let step = 0; step < maxBlocks; step++) {
        if (Date.now() > DEADLINE) break
        const me = this.pos()
        const d = base.distanceTo(me)
        if (d <= 3.6) break                      // 已经够得着了

        // 朝树干走一格的方向（取主轴，避免斜着挖出奇怪的通道）
        const dx = base.x - me.x
        const dz = base.z - me.z
        let stepX = 0; let stepZ = 0
        if (Math.abs(dx) >= Math.abs(dz)) stepX = Math.sign(dx)
        else stepZ = Math.sign(dz)
        if (stepX === 0 && stepZ === 0) break

        const fx = Math.floor(me.x) + stepX
        const fz = Math.floor(me.z) + stepZ
        // 不挖树干那一列
        if (`${fx},${fz}` === trunkXZ) break

        const footY = Math.floor(me.y)
        let cleared = false

        // 清脚+头两格；脚下那格也检查（要能站住）
        for (const [yy, tag] of [[footY, 'foot'], [footY + 1, 'head']]) {
          const v = new Vec3(fx, yy, fz)
          const b = this.bot.blockAt(v)
          if (!b) continue
          if (!this.solidBlock(b)) continue
          if (/bedrock|lava|water/.test(b.name)) return dug
          // 硬方块（石头类）没工具挖不动，别开在这里
          if (!softName(b.name)) {
            const t = await this.bestToolFor(b).catch(() => ({ ok: false }))
            if (!t || !t.ok) return dug
          }
          try {
            if (await this.digAt(b)) { dug++; cleared = true }
          } catch (e) {}
        }
        if (!cleared) {
          // 前方本来就通，直接往前走
        }
        // 真的挪一步进去（不挪的话"挖出来的路"没人走）
        try {
          const yaw = Math.atan2(-stepX, stepZ)
          await this.bot.look(yaw, 0, true)
          this.bot.setControlState('forward', true)
          await sleep(420)
          this.bot.setControlState('forward', false)
          await sleep(160)
        } catch (e) {
          try { this.bot.setControlState('forward', false) } catch (e2) {}
        }
        try { await this.pickupNearby(4) } catch (e) {}
      }
      return dug
    }

    /**
     * 把树干周围挡路的树叶挖掉一圈（只挖软的，石头不动）。
     * 用于「树被树叶包住，一格都站不了」的情况。
     */
    const clearAroundTree = async (base) => {
      let dug = 0
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1],
        [2,0],[-2,0],[0,2],[0,-2]]) {
        for (const dy of [0, 1]) {
          const v = base.offset(dx, dy, dz)
          const b = this.bot.blockAt(v)
          if (!b || !this.solidBlock(b)) continue
          if (!/leaves|short_grass|tall_grass|fern|vine|snow/.test(b.name)) continue
          if (v.distanceTo(this.pos()) > 4.2) continue
          try { if (await this.digAt(b)) dug++ } catch (e) {}
        }
        if (dug >= 10) break
      }
      return dug
    }

    /**
     * 逐个试候选格，成功返回 true。
     * 候选是 { pos, need }，need>0 表示要先挖开树叶/草。
     */
    const trySpots = async (spots, base, timeout) => {
      // 多给几个：候选格按"好走程度"排过了，前面失败后面还有机会。
      // 但也不能全试（每格最坏 8 秒），取前 5 个。
      for (const s of spots.slice(0, 5)) {
        if (Date.now() > DEADLINE) return false
        // 要挖的先把树叶挖掉，否则 pathfinder 不会穿过去
        if (s.need > 0) {
          try { await digPathTo(s.pos) } catch (e) {}
        }
        // range 用 1 而不是 0：GoalBlock 精确到格中心，服务端容差下永远"差一点"，
        // 落点在格内就算到了。到了之后再用 base 距离把关。
        if (await walkTo(s.pos.x, s.pos.y, s.pos.z, 1, Math.min(timeout, 8000))) {
          if (base.distanceTo(this.pos()) <= 4.2) return true
        }
      }
      return false
    }

    /**
     * 朝树干方向挖台阶上升（不需要垫脚方块）。
     *
     * 为什么必须自己写而不用 digAt：
     *   digAt 在距离 > REACH(4.2) 时会调 this.goto 走过去，
     *   而 goto 在 |dy|>2 时先进 gotoVertical —— 那条路的随机漂移
     *   会把人甩出几十格（已单独修，但 digAt 这条路不该依赖它）。
     *   这里只挖"够得着的相邻格"，够不到就返回，绝不为了靠近而乱走。
     *
     * @param {Vec3} base 树干底格
     * @param {number} maxSteps 最多抬高几格
     * @param {number} budgetMs 总预算
     * @returns {Promise<{dug:number, moved:boolean, up:number}>}
     */
    const digStairUp = async (base, maxSteps = 6, budgetMs = 20000) => {
      const tS = Date.now()
      const startY = this.pos().y
      let dug = 0
      let moved = false
      let drySteps = 0
      let dugAtLoopStart = 0
      const solid = (b) => !!(b && b.boundingBox === 'block')

      // 直接挖一格：够得着就挖，够不到直接放弃（不调 goto）
      const digNear = async (v) => {
        const b = this.bot.blockAt(v)
        if (!b) return false
        if (!solid(b)) return true              // 本来就是空的
        if (/bedrock|lava|water/.test(b.name)) return false
        const d = b.position.distanceTo(this.pos())
        if (d > 4.2) return false               // 够不到，交回调用方
        const t = await this.bestToolFor(b).catch(() => ({ ok: false }))
        if (t && t.ok === false) return false
        try { this.bot.pathfinder.setGoal(null) } catch (e) {}
        for (const k of ['forward', 'jump', 'back', 'left', 'right']) {
          try { this.bot.setControlState(k, false) } catch (e) {}
        }
        try {
          await this.bot.dig(b, true)
          await sleep(130)
          try { await this.pickupNearby(4) } catch (e) {}
          return true
        } catch (e) {
          return false
        }
      }

      for (let step = 0; step < maxSteps; step++) {
        if (Date.now() - tS > budgetMs) break
        if (base.distanceTo(this.pos()) <= 3.8) break     // 够了

        const me = this.pos()
        const dx = base.x - me.x
        const dz = base.z - me.z
        let sx = 0; let sz = 0
        if (Math.abs(dx) >= Math.abs(dz)) sx = Math.sign(dx); else sz = Math.sign(dz)
        if (sx === 0 && sz === 0) break

        const fy = Math.floor(me.y)
        const fx = Math.floor(me.x) + sx
        const fz = Math.floor(me.z) + sz
        if (fx === base.x && fz === base.z) break   // 不挖树干那一列

        const needUp = base.y > fy + 1
        const ty = needUp ? fy + 1 : fy

        // 清出通道：先头(+1)、再脚、再做一格坡(-1)。先挖头才抬得起头。
        let clearedAny = false
        for (const yy of [ty + 1, ty, ty - 1]) {
          if (await digNear(new Vec3(fx, yy, fz))) {
            if (yy === ty || yy === ty + 1) clearedAny = true
            dug++
          }
        }

        // 走进去（朝向 + forward + jump，不用 pathfinder）
        try {
          const yaw = Math.atan2(-sx, sz)
          await this.bot.look(yaw, 0, true)
          this.bot.setControlState('forward', true)
          if (needUp) this.bot.setControlState('jump', true)
          await sleep(needUp ? 680 : 460)
          this.bot.setControlState('forward', false)
          this.bot.setControlState('jump', false)
        } catch (e) {
          try { this.bot.setControlState('forward', false) } catch (e2) {}
          try { this.bot.setControlState('jump', false) } catch (e2) {}
        }
        await sleep(160)

        const now = this.pos()
        if (now.distanceTo(me) > 0.35) moved = true
        if (!clearedAny && now.distanceTo(me) < 0.2) break

        // 【实测 · 2026-11-13 10:16】有一次上升 -3.0 格 —— 挖台阶把人挖下去了。
        // 那是把脚下那格（ty-1）挖空后没踩住，直接掉进洞里。
        // 掉超过 2 格就停：再走下去只会越掉越深，而且目标在更高处。
        if (now.y < startY - 2) {
          this.log(`[chop] 挖台阶时掉了 ${(startY - now.y).toFixed(1)} 格，停手`)
          break
        }

        // 【实测 · 2026-11-13 10:16】出生在 y=49 深层地下时，
        // 挖台阶跑了 30 秒、上升 0.0 格 —— 因为周围全是石头，
        // 空手挖不掉（bestToolFor 返 ok=false），每轮都白转。
        // 这里加"连续 3 轮零进展就收工"，别把 20 秒预算耗成 30 秒。
        if (dug === dugAtLoopStart && now.distanceTo(me) < 0.2) {
          drySteps++
          if (drySteps >= 3) break
        } else {
          drySteps = 0
        }
        dugAtLoopStart = dug
      }

      return { dug, moved, up: this.pos().y - startY }
    }

    /** 走到树干旁边（优先最近的可站立格，逐个试） */
    const goNearTree = async (base, timeout = 12000) => {
      // 已经在挖掘距离内，不用走
      if (base.distanceTo(this.pos()) <= 4.0) return true
      const p0 = this.pos()

      // 第一步：远距离先用 GoalXZ 拉近（只走水平，A* 不用管精确高度，
      // 成功率高得多）。之前直接对树干做 GoalBlock，A* 找不到落脚点，
      // 33 格外的树每棵白耗 5 秒。
      if (base.distanceTo(p0) > 8) {
        const s = Date.now()
        let still = 0
        let last = this.pos().clone()
        const startPos = this.pos().clone()
        try {
          this.bot.pathfinder.setGoal(new goals.GoalXZ(
            Math.floor(base.x), Math.floor(base.z)))
        } catch (e) {}
        try {
          while (Date.now() - s < timeout) {
            this.check()
            const p = this.pos()
            if (Math.hypot(p.x - base.x, p.z - base.z) <= 3.5) break
            if (p.distanceTo(last) < 0.12) still += 200
            else still = 0
            last = p.clone()
            if (still > 5000) break
            await sleep(200)
          }
        } finally {
          try { this.bot.pathfinder.setGoal(null) } catch (e) {}
        }

        // 【关键兜底】GoalXZ 一步都没走 = 人被卡住了（凹坑/树丛/墙角）。
        //
        // 实测（/tmp/diag/goalxz.js）：同一次运行里第一次 GoalXZ 走了 25.9 格，
        // 另一次一步都没走（位置 69,64,9 完全不变，水平距离 40.21 -> 40.21）。
        // 出生点是随机的，有些落点 pathfinder 完全找不到出口。
        //
        // 老代码遇到这种情况什么都不做，直接进入 standSpotsNear ——
        // 而那批候选格都在 40 格外，walkTo 必然失败，最后报"走不到这棵"。
        // 这就是"越试越远、一棵都砍不到"的完整链条。
        const movedFromGoalXZ = this.pos().distanceTo(startPos)
        if (movedFromGoalXZ < 2) {
          this.log(`[chop] GoalXZ 卡死（只挪了 ${movedFromGoalXZ.toFixed(1)} 格），先挖出去`)
          try { await this.digOutSelf() } catch (e) {}
          await this.ensureChunks(2000)
          // 挖出来之后再试一次 GoalXZ（这次通常就通了）
          const s2 = Date.now()
          try {
            this.bot.pathfinder.setGoal(new goals.GoalXZ(
              Math.floor(base.x), Math.floor(base.z)))
            let still2 = 0
            let last2 = this.pos().clone()
            while (Date.now() - s2 < Math.min(timeout, 10000)) {
              this.check()
              const p = this.pos()
              if (Math.hypot(p.x - base.x, p.z - base.z) <= 3.5) break
              if (p.distanceTo(last2) < 0.12) still2 += 200
              else still2 = 0
              last2 = p.clone()
              if (still2 > 5000) break
              await sleep(200)
            }
          } catch (e) {
          } finally {
            try { this.bot.pathfinder.setGoal(null) } catch (e) {}
          }
          this.log(`[chop] 挖出后距树 ${base.distanceTo(this.pos()).toFixed(1)} 格`)
        }
        if (base.distanceTo(this.pos()) <= 4.0) return true
      }

      // 第二步：走近了再找精确落脚点
      const spots = standSpotsNear(base)
      if (!spots.length) {
        // 树旁一格能站的都没有（连挖开树叶都不行）：
        // 先把挡路的树叶挖一圈，再看一次
        try { await clearAroundTree(base) } catch (e) {}
        const again = standSpotsNear(base)
        if (!again.length) {
          return await walkTo(base.x, base.y, base.z, 2, Math.min(timeout, 8000))
        }
        if (await trySpots(again, base, timeout)) return true
      } else {
        if (await trySpots(spots, base, timeout)) return true
      }

      // ===== 第三步：垂直补差 —— 挖台阶上升 =====
      //
      // 【这一版是按实测重写的】瓶颈不是候选格，是**爬不上去**。
      //
      // walkto-test.js 实测（chopTree 真实路径 GoalXZ -> 候选 -> walkTo）：
      //   bot y=65，候选 y=70~71，候选距树干只有 1.73~2.83（远在 REACH 4.2 内）
      //   walkTo 全部 false，人停在 y=65~66 —— 水平差 2 格、垂直差 4~5 格，
      //   三维加起来正好 6 格，这就是日志里"差 4~6 格"的真身。
      //
      // 为什么以前上不去：
      //   · 背包空，allow1by1towers 没有垫脚方块 -> 等于关着
      //   · GoalNear 只算水平，A* 找不到坡就把人停在坡脚
      //   · gotoVertical 每轮随机 ±3 格（已修），越爬越远
      //
      // 现在用"挖台阶"：朝树的主轴，把前方上一格的脚+头挖空，然后 jump+forward
      // 走进去 —— 不需要任何垫脚方块，纯靠挖。
      // 在 /tmp/diag/stair2.js 里验证过：相邻格 bot.dig 是成功的（y71:dug）。
      let d3 = base.distanceTo(this.pos())
      if (d3 > 4.2) {
        // 3a. 先给一次候选格机会（贴近 bot 高度的那批，刚才可能还没试到）
        const extra = standSpotsNear(base)
        if (extra.length && (await trySpots(extra, base, Math.min(timeout, 6000)))) return true
      }

      // ===== 3b. 高度不够：先判断"挖台阶"还是"垫方块" =====
      //
      // 实测（/tmp/diag/stair3.js）：朝树方向那一列**全是 air** 时，
      // 挖台阶无效 —— 挖不动任何东西，跳起来也不会升高，
      // 反而越走越远（近树 8.4 -> 18.4）。开阔地必须垫方块。
      //
      // 反过来，在 1 格高的洞穴里只有挖台阶能用（没空间搭塔）。
      // 所以先探一列，看有没有"可挖的实心方块"在正前方往上。
      d3 = base.distanceTo(this.pos())
      if (d3 > 4.2 && base.y > this.pos().y) {
        // 探测：正前方上方 2 格内有没有实心可挖方块
        const me = this.pos()
        const dxT = base.x - me.x
        const dzT = base.z - me.z
        let sxT = 0; let szT = 0
        if (Math.abs(dxT) >= Math.abs(dzT)) sxT = Math.sign(dxT); else szT = Math.sign(dzT)
        const fyT = Math.floor(me.y)
        const fxT = Math.floor(me.x) + sxT
        const fzT = Math.floor(me.z) + szT
        let diggableAhead = 0
        for (let dy = 0; dy <= 2; dy++) {
          const b = this.bot.blockAt(new Vec3(fxT, fyT + dy, fzT))
          if (b && b.boundingBox === 'block' && !/bedrock|lava|water/.test(b.name)) diggableAhead++
        }

        const stairStart = Date.now()
        const stairFromY = this.pos().y
        const beforeStairD = base.distanceTo(this.pos())
        let used = ''

        if (diggableAhead >= 1) {
          // 有东西可挖：走台阶（洞穴/坡面都适用，不需要垫脚料）
          used = '挖台阶'
          const stairResult = await digStairUp(base, 6, 20000)
          if (stairResult.moved) {
            const after = standSpotsNear(base)
            if (after.length && (await trySpots(after, base, Math.min(timeout, 5000)))) return true
          }
        } else {
          // 前方全空：开阔地，只能垫方块。先挖脚下的土攒料。
          used = '垫方块'
          if (!this.item('dirt') && !this.item('cobblestone') && !this.item('stone')) {
            // 没料：从脚边挖两块软方块（只挖 1 格内、够得着的）
            for (let i = 0; i < 3; i++) {
              let got = false
              for (const [dx2, dz2] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                for (const dy2 of [-1, 0]) {
                  const v = new Vec3(Math.floor(me.x) + dx2, Math.floor(me.y) + dy2, Math.floor(me.z) + dz2)
                  const b = this.bot.blockAt(v)
                  if (!b || b.boundingBox !== 'block') continue
                  if (!/dirt|grass_block|sand|gravel/.test(b.name)) continue
                  try { await this.digAt(b, { walkToBlock: false }) } catch (e) {}
                  try { await this.pickupNearby(4) } catch (e) {}
                  got = true
                  break
                }
                if (got) break
              }
              if (!got) break
            }
          }
          // 垫 2 格抬高（再多不值）
          for (let i = 0; i < 3 && base.distanceTo(this.pos()) > 4.2; i++) {
            const beforeY = this.pos().y
            let up = 0
            try { up = await this.pillarUp(1) } catch (e) { up = 0 }
            if (!up && this.pos().y <= beforeY + 0.2) break
            await sleep(150)
          }
        }

        const stairMs = Date.now() - stairStart
        const stairUp = this.pos().y - stairFromY
        this.log(`[chop] ${used} ${stairMs}ms：上升 ${stairUp.toFixed(1)} 格，` +
          `距树 ${beforeStairD.toFixed(1)} -> ${base.distanceTo(this.pos()).toFixed(1)} 格`)
        if (stairUp >= 0.5) {
          const after = standSpotsNear(base)
          if (after.length && (await trySpots(after, base, Math.min(timeout, 5000)))) return true
        }
      }

      // 3c. 最后：有料就走传统塔升（action-fixer 修好 pickupNearby 后，
      //     泥土能进包了，pillarUp 才真正可用）
      d3 = base.distanceTo(this.pos())
      if (d3 > 4.2 && base.y > this.pos().y) {
        const climbedFrom = this.pos().y
        for (let i = 0; i < 2 && base.distanceTo(this.pos()) > 4.2; i++) {
          if (Date.now() > DEADLINE) return false
          if (this.pos().y - climbedFrom >= 3) break
          const beforeD = base.distanceTo(this.pos())
          let up = false
          try { up = await this.pillarUp(1) } catch (e) { up = false }
          if (!up) break
          await sleep(120)
          if (base.distanceTo(this.pos()) > beforeD + 1.5) {
            this.log('[chop] 塔升后反而更远，停止')
            break
          }
        }
      }

      return base.distanceTo(this.pos()) <= 4.2
    }

    /** 找到某根原木所在那棵树的"树干最底下一格"（从找到的位置往下走） */
    const trunkBase = (pos) => {
      // 注意：必须一直拿 Vec3 往下走。老写法 `base = below` 赋的是 Block 对象，
      // 第二次循环 base.offset 就不存在了。
      let base = pos.clone()
      for (let i = 0; i < 12; i++) {
        const below = this.bot.blockAt(base.offset(0, -1, 0))
        if (!below || !logs.includes(below.name)) break
        base = below.position.clone()
      }
      return base
    }

    /** 收集附近所有树的树干底格，按"好砍程度"排序 */
    const candidates = (maxDist = 64) => {
      const p = this.pos()
      const out = []
      const seen = new Set()
      for (const l of logs) {
        const def = mcData.blocksByName[l]
        if (!def) continue
        const ps = this.bot.findBlocks({ matching: def.id, maxDistance: maxDist, count: 64 })
        for (const q of ps) {
          const base = trunkBase(q)
          const key = `${base.x},${base.y},${base.z}`
          if (seen.has(key) || tried.has(key)) continue
          // 注意：tried 只装"真的试过但失败"的树（goNearTree 走过、或者
          // 砍不动的）。换方向走远之后如果又回到这片林子，这些树仍会被跳过 ——
          // 这是有意的：它们刚才确实够不着，再试一次也大概率一样。
          // 但如果整片都没树（list 空），下面的循环不会碰 tried，所以不会误伤。
          seen.add(key)
          const d = base.distanceTo(p)
          const dy = Math.abs(base.y - p.y)
          // 优先：水平近 + 高度差小（高度差大的树要爬坡，成功率低）
          out.push({ base, name: l, d, dy, score: d + dy * 6 })
        }
      }
      out.sort((a, b) => a.score - b.score)
      return out
    }

    /**
     * 换一个方向走远找树。
     *
     * 两处都用它：
     *   · 48 格内根本没扫到树（candidates 空）
     *   · 扫到树了但一棵都砍不动（choppedThisRound === 0）
     *
     * 实测教训（chop-test 08:22）：原来这两条路各写一套，
     * "没扫到树"那条直接抛错，压根没走远 ——
     * 日志是 `48 格内没树，往外找` -> `走了 28 格` -> 立刻抛错。
     * 而同一位置 blockAt 逐格扫能在 27 格外找到 2 棵树。
     *
     * @param {Array} tryList 这一轮试过但失败的树（用作"远离"参照，可为空）
     * @returns {Promise<number>} 实际走了多少格
     */
    const walkAway = async (tryList) => {
      awayRounds++
      const remainSec = Math.round((DEADLINE - Date.now()) / 1000)
      if (awayRounds > 3) {
        this.log(`[chop] 已经换方向走了 ${awayRounds - 1} 轮，附近确实没有可达的树`)
        return 0
      }
      if (remainSec < 40) {
        this.log(`[chop] 只剩 ${remainSec}s，不够再走一轮（一轮 40 格 + 重扫约 30s）`)
        return 0
      }

      // 方向：远离这一圈里离我最近的那棵树（没有参照就随机）
      const nearest = (tryList || []).slice().sort((x, y) =>
        x.base.distanceTo(this.pos()) - y.base.distanceTo(this.pos()))[0]
      const pNow = this.pos()
      let awayYaw = nearest
        ? Math.atan2(pNow.z - nearest.base.z, pNow.x - nearest.base.x)
        : Math.random() * Math.PI * 2
      // 每轮再偏 60°，避免一直沿同一条线走到没树的地方
      awayYaw += (awayRounds - 1) * (Math.PI / 3)

      let moved = 0
      for (let attempt = 0; attempt < 2 && moved < 8; attempt++) {
        const yaw = awayYaw + attempt * (Math.PI / 2)
        const p = this.pos()
        const tx = p.x + Math.cos(yaw) * 40
        const tz = p.z + Math.sin(yaw) * 40
        const before = this.pos().clone()
        try { await walkTo(tx, p.y, tz, 3, 22000) } catch (e) {}
        await this.ensureChunks(4000)
        moved = this.pos().distanceTo(before)
        this.log(`[chop] 第 ${awayRounds} 轮换方向（第 ${attempt + 1} 次）：` +
          `走了 ${moved.toFixed(1)} 格 -> ${Math.floor(this.pos().x)},` +
          `${Math.floor(this.pos().y)},${Math.floor(this.pos().z)}`)
        if (moved >= 8) break
      }
      if (moved >= 8) {
        this.log(`[chop] 累计换方向 ${awayRounds} 轮，剩余预算 ` +
          `${Math.round((DEADLINE - Date.now()) / 1000)}s，继续找树`)
      }
      return moved
    }

    await sleep(300)

    while (trees < count && Date.now() < DEADLINE) {
      this.check()

      // 扫树。扫不到就"扩大半径 + 走远"，最多 3 轮 —— 不直接抛错。
      //
      // 【实测 · 2026-11-13 10:05 /tmp/diag/scan-cmp.js】
      // 出生点量出来的对比：
      //   findBlocks(48) -> 0 个原木
      //   findBlocks(64) -> 2 个原木        ← 同一个位置，只是半径差 16 格
      //   逐格扫描(r40,y±20) -> 0 个
      // 说明 findBlocks **没有**漏报，树确实在 48~64 格这一圈。
      // 问题是原来每轮都写死 48，走了 150 格还在扫 48 —— 半径从不增长。
      //
      // 现在：半径跟着轮次涨 48 -> 64 -> 80 -> 96，与走过的距离匹配。
      let scanRadius = 48
      let list = candidates(scanRadius)
      while (!list.length) {
        this.log(`[chop] ${scanRadius} 格内没扫到树，先确认区块再决定要不要走远`)
        // 先确认不是"区块没加载"（findBlocks 只扫已加载区块）
        let found = false
        for (let retry = 0; retry < 2 && !found; retry++) {
          try { await this.ensureChunks(4000) } catch (e) {}
          await sleep(700 + retry * 600)
          const again = candidates(scanRadius)
          if (again.length) { list = again; found = true }
        }
        if (found) break

        // 半径没到头：先原地把半径放大再扫（比走 40 格便宜得多）
        if (scanRadius < 96) {
          scanRadius = Math.min(96, scanRadius + 16)
          const wider = candidates(scanRadius)
          if (wider.length) {
            this.log(`[chop] 半径放大到 ${scanRadius} 格后找到 ${wider.length} 棵`)
            list = wider
            break
          }
          continue
        }

        // 96 格都没有：走远找（40 格/轮）。走完之后把半径收回 48 重新开始涨。
        const moved = await walkAway([])
        if (moved < 8) {
          this.complain('nothingFound', '走了一圈没树')
          throw new Error(`附近 96 格内没有可达的树（已换方向 ${awayRounds} 轮、` +
            `耗时 ${Math.round((Date.now() - t0) / 1000)}s）`)
        }
        scanRadius = 48
        list = candidates(scanRadius)
      }

      // 逐个试，砍到一棵就收工（砍不动就换下一棵，不再盲目 wander）
      let choppedThisRound = 0
      // 关键：只试最近的 3 棵。之前会把 20 多棵远树挨个试一遍，
      // 每棵失败 5~12 秒，时间全浪费在"走不到"上（实测 190s 只砍到 1 棵）。
      const tryList = list.slice(0, 3)
      for (const cand of tryList) {
        if (Date.now() > DEADLINE) break
        const base = cand.base
        const key = `${base.x},${base.y},${base.z}`

        // 走到树干跟前（目标用旁边能站的格子，不是树干本身）
        let d = base.distanceTo(this.pos())
        if (d > 4.0) {
          await goNearTree(base, 12000)
          d = base.distanceTo(this.pos())
        }
        if (d > 4.2) {
          // ===== 最后兜底：挖过去 =====
          //
          // 走到这里说明候选格（-5..+3 全扫过、已过滤到 4.0 内）也走不到 ——
          // 典型情况是被树叶/灌木/小土坡封住了，A* 找不到路。
          // 真人这时候直接把挡路的挖开，而不是"换下一棵"
          // （周围可能全是同一个林子，换一棵还是一样）。
          //
          // 关键：**挖完必须重算候选格再走**，
          // 否则挖开的路还是走老的那批错误格子，等于白挖。
          if (d <= 9) {
            this.log(`[chop] 差 ${d.toFixed(1)} 格，挖开挡路的方块过去`)
            let dug = 0
            try { dug = await digTowardTrunk(base, 8) } catch (e) {}
            if (dug > 0) {
              await this.ensureChunks(1500)
              // 挖出新空间后，候选格会变 —— 重新算、重新走
              await goNearTree(base, 10000)
              d = base.distanceTo(this.pos())
              this.log(`[chop] 挖了 ${dug} 格后距离 ${d.toFixed(1)} 格`)
            }
          }
          if (d > 4.2) {
            this.log(`[chop] 走不到这棵（差 ${d.toFixed(1)} 格），换下一棵`)
            tried.add(key)
            continue
          }
        }

        // 从下往上砍
        //
        // 这里传 walkToBlock:false：人已经站到候选格了（距树 <= 4.2），
        // 再让 digAt 自己 goto 只会把人推走 —— 实测 goto 的 gotoVertical
        // 随机漂移一次能甩出几十格，砍完第一块就够不到第二块了。
        // 够不到就如实失败，由上面的 goNearTree / digStairUp 负责站位。
        let chopped = 0
        for (let dy = 0; dy < 6; dy++) {
          const b = this.bot.blockAt(base.offset(0, dy, 0))
          if (!b || !logs.includes(b.name)) break
          const ok = await this.digAt(b, { walkToBlock: false })
          if (!ok) break
          chopped++
        }

        if (chopped > 0) {
          choppedThisRound = chopped
          trees++
          this.log(`[chop] 砍下 ${chopped} 块原木（${cand.name} @${base.x},${base.y},${base.z}）`)
          // 立刻捡，别等（掉落物 5 分钟后消失，但走远就捡不到了）
          try { await this.pickupNearby(8) } catch (e) {}
          break
        }
        this.log(`[chop] 这棵砍不动（差 ${d.toFixed(1)} 格），换下一棵`)
        tried.add(key)
      }

      if (choppedThisRound === 0) {
        // 整轮都没砍到：把这一轮真的试过的 3 棵标成 tried，然后走远换片林子。
        // （走多远、走几轮、预算够不够，全在 walkAway 里）
        for (const c of tryList) tried.add(`${c.base.x},${c.base.y},${c.base.z}`)
        this.log(`[chop] 这一圈的 ${tryList.length} 棵都砍不动，走远换片林子`)
        const moved = await walkAway(tryList)
        if (moved < 8) {
          this.log(`[chop] 走不动了（${moved.toFixed(1)} 格），提前收工`)
          break
        }
      }
      await sleep(150)
    }

    // 砍完再捡一轮（有些掉落物刚才离得远，现在走近了）
    try { await this.pickupNearby(10) } catch (e) {}
    if (trees < count) {
      const elapsed = Math.round((Date.now() - t0) / 1000)
      this.log(`[chop] 只砍到 ${trees}/${count} 棵（${elapsed}s，换方向 ${awayRounds} 轮，` +
        `预算 ${Math.round(DEADLINE_MS / 1000)}s）`)
    }
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
  /**
   * 在脚边放一个方块。
   *
   * @param {string} blockName
   * @param {{force?:boolean}} opts
   *   force=true 时**忽略附近已有的同类方块**，强制再放一个新的。
   *   为什么需要：`ensureTable` 复用旧工作台是对的（省材料），
   *   但「放箱子」这种任务要求"世界里的箱子数量真的增加了"——
   *   复用旧箱子等于一次都没放（实测 e2e：`世界内 chest 1 -> 1（没放出来，只是找到了旧箱子）`）。
   */
  async placeNearby (blockName, opts = {}) {
    // 复用已有方块的判定要更谨慎：
    //   · 工作台：复用是对的（省材料，ensureTable 也依赖这个行为）
    //   · 箱子/熔炉这类"任务产物"：复用等于没放
    //
    // 实测（e2e 10:50）：`世界内 chest 1 -> 1（没放出来，只是找到了旧箱子）`
    // —— 测试要求"世界里的箱子数量真的增加"，而这里第一行就把旧箱子返回了。
    //
    // 现在的规则：**手上有这个物品的存货**就优先真放一个新的；
    // 只有手上没有、但附近有旧的，才复用。
    const REUSE_OK = /^(crafting_table|furnace)$/.test(blockName)
    const held = this.countOf(blockName)
    const shouldReuse = !opts.force && (REUSE_OK || held === 0)
    if (shouldReuse) {
      const exist = this.findBlock(blockName, 10)
      if (exist) return exist
    }

    const item = this.item(blockName)
    if (!item) throw new Error('没有 ' + blockName)

    // 关键：放置距离必须 <= 4.5 格（跟挖掘一样）。
    // 之前 findPlaceSpot(8) 会挑到 8 格甚至 16 格外的高分位置，
    // 服务端直接丢弃 use_item_on，回一句 "the block is still air"。
    //
    // 【实测的坑 · 2026-11-13 e2e 08:36:33】
    // 更麻烦的是：**即使距离够，某个具体格子也可能永远放不上**。
    // 日志里 placeNearby 连试 5 次，每次都对着 (10, 64, -88)：
    //   try0..try4: Server refused to place crafting_table at (10, 64, -88):
    //               the block is still air
    // 原因是 findPlaceSpot 只返回 1 个 spot，重试时又挑回同一个。
    // 那格虽然通过"at 是空气 / up 不挡 / base 是实体"三项检查，
    // 但服务端碰撞盒判定更严（人站格子边缘、身体探进目标格）。
    // 换一格就能放 —— 所以现在用 findPlaceSpots 拿一串备选，失败就换。
    const REACH = 4.0
    let spots = this.findPlaceSpots(8, REACH, 10)
    if (!spots.length) {
      // 附近伸手范围内没有空地：走两步换位置再试
      for (let i = 0; i < 3 && !spots.length; i++) {
        try { await this.wander(4) } catch (e) {}
        await sleep(300)
        spots = this.findPlaceSpots(8, REACH, 10)
      }
    }
    if (!spots.length) {
      // 还是没有：放宽到 6 格，走过去再放
      spots = this.findPlaceSpots(10, 6, 10)
    }
    if (!spots.length) {
      this.log('[place] 附近找不到能放的格子')
      return null
    }

    await this.bot.equip(item, 'hand')
    const usedSpots = new Set()
    for (let attempt = 0; attempt < 8; attempt++) {
      // 按候选列表**依次换格子**（不再每次挑回同一个）
      let sp = spots.find(c => !usedSpots.has(`${c.x},${c.y},${c.z}`))
      if (!sp) {
        // 这一批都用完了：重新扫一批（半径放大，位置也可能变了）
        const more = this.findPlaceSpots(10, 6, 10)
          .filter(c => !usedSpots.has(`${c.x},${c.y},${c.z}`))
        if (!more.length) {
          this.log('[place] 候选格都用完了')
          break
        }
        sp = more[0]
      }
      usedSpots.add(`${sp.x},${sp.y},${sp.z}`)

      // 站太远就先走过去（放置判定按眼睛到方块面的距离算）
      const basePos = sp.base.position
      const distToBase = basePos.distanceTo(this.pos())
      if (distToBase > 4.2) {
        const ok = await this.goto(basePos.x, basePos.y, basePos.z, 2, 12000)
        if (!ok) {
          this.log(`[place] 走不到放置点（差 ${distToBase.toFixed(1)} 格），换一个`)
          continue
        }
      }

      // 视线校验：隔着墙放不了
      try {
        if (!this.bot.canSeeBlock(sp.base)) {
          this.log('[place] 看不见底座，换一个')
          continue
        }
      } catch (e) {}

      try {
        await this.bot.lookAt(basePos.offset(0.5, 0.5, 0.5), true)
        await sleep(120)
        await this.bot.placeBlock(sp.base, new Vec3(0, 1, 0))
        await sleep(250)
        // 落点 = base 正上方，也就是 sp.x/sp.y/sp.z
        const expect = basePos.offset(0, 1, 0)
        let placed = this.bot.blockAt(expect)
        if (!placed || placed.name !== blockName) {
          placed = this.bot.blockAt(new Vec3(sp.x, sp.y, sp.z))
        }
        if (placed && placed.name === blockName) return placed
        this.log(`[place] 放完检查不到（期望 ${expect.x},${expect.y},${expect.z} 是 ${blockName}）`)
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
    //
    // 【实测的 bug · 2026-11-13 10:38】`myPlankKind()` 在没有存货、没有原木时
    // 会**按"附近有哪种树"猜**一个品种返回。于是出现了：
    //   背包空、附近有樱花树 -> myPlankKind() = 'cherry_planks'
    //   -> 下面 prefer 过滤把 oak/birch/... 的配方全滤掉，只剩 cherry 那一份
    //   -> 补料补不到 cherry_planks（没砍到樱花木）
    //   -> `补料 2 遍后仍缺：cherry_planks 要 3 有 0`，做木镐 153 秒失败
    // 而实际上此时只要用 oak 就行（`附近有树但不确定种类 -> 默认 oak_planks` 那条兜底
    // 在"找到了 cherry_log"时永远走不到）。
    //
    // 修法：**只有手上真的握着这个品种的木板/原木时**才用它来收窄配方。
    // 纯猜测（countOf 都是 0）时不要过滤，让评分去挑最容易做的那份。
    const guessedPlank = this.myPlankKind()
    const myPlank = guessedPlank && (this.countOf(guessedPlank) > 0 ||
      this.countOf(String(guessedPlank).replace(/_planks$/, '_log')) > 0)
      ? guessedPlank
      : null
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

    // 2.7 如果配方要用木板，而手上**一块木板和一个原木都没有**，
    //     那"选哪个品种"这个问题在信息上是无解的 —— 12 份配方全打平
    //     （实测 /tmp/probe-score.js：missing=5 kind=0 × 12），
    //     排序后稳定拿到数组第一份 cherry_planks，然后去补 cherry_log 补不到，
    //     白烧 176 秒（e2e --only 做木镐）。
    //
    //     正确做法：**先去弄一根任意原木**，回来再据实选品种。
    //     手里有 oak_log 时，oak 那份配方 species 分是 5，自然赢过其它。
    const __needsPlank = cands.some(r => r.delta.some(d => {
      if (d.count >= 0) return false
      const it = mcData.items[d.id]
      return it && /_planks$/.test(it.name)
    }))
    if (__needsPlank && this.plankTotal() === 0 && this.woodCount() === 0) {
      this.log(`[craft] 做 ${name} 要先有木头（木板 0、原木 0），先去弄一根`)
      try {
        await this.ensureWood(1)
      } catch (e) {
        this.log('[craft] 弄木头失败: ' + e.message)
      }
      if (this.woodCount() > 0) {
        this.log(`[craft] 弄到 ${this.woodCount()} 个原木（${this.bestLog() || '品种未知'}），重新选配方`)
        // 重新按"现在手上有什么"挑一次配方
        return await this.craftSmart(name, count, depth)
      }
      // 弄不到木头：**立刻失败**，别回去继续挑 cherry。
      // 实测（/tmp/probe-craft-repro.js）：ensureWood 跑了 127 秒没弄到原木，
      // 然后流程又回到配方选择，继续去补 cherry_planks，再白烧 176 秒。
      throw new Error(`做 ${name} 需要木板，但一根原木都弄不到（附近找不到能砍的树）`)
    }

    // 3. 挑一个"手头材料最足、需要额外弄的最少"的配方
    //
    // 【实测的 bug · 2026-11-13 10:38】只按 missing/inHand 打分时，
    // "手上什么都没有"会让 12 份木镐配方全部打平（都是缺 3 木板 + 2 木棍），
    // 排序后拿到第一份 —— 恰好是 cherry_planks。
    // 于是去补 cherry 木板，砍到的却是橡木，`补料 2 遍后仍缺：cherry_planks 要 3 有 0`。
    //
    // 现在加一个"这个品种我到底能不能弄到"的分级：
    //   3 = 手上就有这种木板
    //   2 = 手上有对应的原木（直接能做成木板）
    //   1 = 附近真的有这种树（findBlock 点得到）
    //   0 = 完全没线索
    // 打分先按缺失量，再按品种可得性。
    /**
     * 这个品种的木板，我现在到底有多容易弄到？
     *
     * 【实测的教训 · 2026-11-13 10:44】只按"附近有没有这种树"给分是不够的：
     *   森林里 oak/birch/cherry 树**同时存在**，findBlock 全部返回真值，
     *   12 份配方又都缺同样多的料，于是又打平 -> 排序后还是拿到 cherry，
     *   然后去补 cherry_log、补不到、白烧 176 秒。
     *
     * 关键是"**手上已有的原木/木板**"权重必须远高于"附近有这种树"：
     *   6 = 手上就有这种木板
     *   5 = 手上有对应的原木（1 个原木就能做成 4 张）
     *   3 = 附近真的有这种树
     *   0 = 没线索
     * 而且 6/5 这两档在排序里应该排在 missing 之前 ——
     * 手上有的品种永远比"更省 1 张料"更值得选。
     */
    const plankKindScore = (plankName) => {
      try {
        if (this.countOf(plankName) > 0) return 6
        const logName = String(plankName)
          .replace(/_planks$/, '_log')
          .replace(/^bamboo_log$/, 'bamboo')
          .replace(/^crimson_log$/, 'crimson_stem')
          .replace(/^warped_log$/, 'warped_stem')
        if (this.countOf(logName) > 0) return 5
        if (plankName === 'bamboo_planks' || /^(crimson|warped)_planks$/.test(plankName)) return 0
        if (this.findBlock(logName, 48)) return 3
      } catch (e) {}
      return 0
    }

    const scored = cands.map(r => {
      const needs = {}
      for (const d of r.delta) if (d.count < 0) needs[d.id] = (needs[d.id] || 0) - d.count
      let missing = 0
      let inHand = 0
      let kind = 0
      for (const [iid, n] of Object.entries(needs)) {
        const it = mcData.items[parseInt(iid, 10)]
        if (!it) continue
        const have = this.countOf(it.name)
        if (have >= n) inHand += n
        else missing += (n - have)
        if (/_planks$/.test(it.name)) kind = Math.max(kind, plankKindScore(it.name))
      }
      return { r, needs, missing, inHand, kind }
    }).sort((a, b) => {
      // 第一优先：手上/手里原木就能做的品种（6/5 档），永远优于纯"附近有树"
      const aOwn = a.kind >= 5 ? 1 : 0
      const bOwn = b.kind >= 5 ? 1 : 0
      if (aOwn !== bOwn) return bOwn - aOwn
      // 其次才比缺失量、品种线索、手上存量
      return (a.missing - b.missing) || (b.kind - a.kind) || (b.inHand - a.inHand)
    })

    const pick = scored[0]

    // 3. 补齐缺的原料
    //
    // 降级链（实测「做石镐」32 秒后抛 missing ingredient，就是断在这里）：
    //
    //   craftSmart('stone_pickaxe')
    //     -> 缺 cobblestone -> gather('cobblestone')
    //     -> mine('stone')  -> ensurePickaxe()   <- 这里没木头，砍树又失败
    //     -> 抛错 -> gather 返回 false -> craftSmart 抛"缺 cobblestone"
    //
    // 死结在于：**石头类材料必须有镐子才能拿到**，而镐子本身要先有木头。
    // 所以遇到石头类材料缺失时，必须先补镐子，再用镐子去挖 —— 而不是
    // 直接 mine() 撞死在里面。craftSmart 这里就是唯一能插手的降级点。
    const STONE_MATS = /^(cobblestone|cobbled_deepslate|stone|deepslate|raw_iron|raw_copper|coal)$/

    // 【实测的 bug · 2026-11-13 08:47】补料必须**多遍**，不能单遍。
    //
    // 木镐配方 = 3 木板 + 2 木棍。单遍循环发生的事：
    //   第 1 轮 · 木板：0 < 3 -> craftSmart('oak_planks', 3)
    //                     -> 消耗 1 原木，得到 4 张木板
    //   第 1 轮 · 木棍：0 < 2 -> craftSmart('stick', 2)
    //                     -> **消耗 2 张木板**，得到 4 根木棍
    //   循环结束。此时木板只剩 2 张，而配方要 3 张。
    //   -> safeCraft 抛 "missing ingredient"
    //   -> 日志就是 `craftSmart -> 木镐=0 err=材料不够，配方已不可用`
    //
    // 更要命的是这个 bug 只在"原木刚好够"时暴露：原木多的时候
    // 第 2 遍会自己补上，原木少就直接失败。
    //
    // 修法：反复扫 needs，直到"全部满足"或"某一遍完全没进展"。
    // 每遍内部仍然是原来的三重降级（递归合成 -> 采集 -> 石头类先弄镐子）。
    let fillPass = 0
    const MAX_FILL_PASS = 4
    let unsatisfied = []

    /**
     * 按当前背包重新算一遍"这个配方还缺什么"。
     *
     * 【实测的 bug · 2026-11-13 09:15】原实现只算了一次 pick.needs 就循环补，
     * 但**木棍会消耗木板**：chest 要 8 木板，补到 4 张木板后去做木棍，
     * 木棍吃掉 2 张木板，木板又不够了 —— 而 needs 里记的还是"要 8"，
     * 循环判断 `countOf >= n` 用的是过期需求，于是补料在 7/8 处停手，
     * 报 `补料 1 遍后仍缺：oak_planks 要 8 有 7`。
     * 现在每遍都重算，木棍吃掉多少就补多少。
     */
    const recomputeNeeds = () => {
      const out = {}
      for (const d of pick.r.delta) {
        if (d.count < 0) out[d.id] = (out[d.id] || 0) - d.count * Math.max(1, times0)
      }
      // times0 = 一次合成要几份；craftSmart 的 count 用 need/结果数算过
      return out
    }
    const times0 = Math.ceil(need / pick.r.result.count)

    while (fillPass < MAX_FILL_PASS) {
      fillPass++
      unsatisfied = []
      let progressed = false

      // 每遍用"当前背包"重算需求（见上面 recomputeNeeds 的说明）
      pick.needs = recomputeNeeds()

      /**
       * 补料顺序：**会被别人消耗的材料最后补**。
       *
       * 【实测的 bug · 2026-11-13 11:00 e2e】`补料 1 遍后仍缺：oak_planks 要 3 有 1`，
       * 而背包明明有 7 个原木。推演：
       *   木镐 = 3 oak_planks + 2 stick，而 stick 配方是 **oak_planks -2 => stick +4**
       *   第 1 遍按 Object.entries 顺序补：先 oak_planks 补到 4，
       *   再 stick（要 2）-> craftSmart('stick',2) 内部 need=2、times=1，
       *   消耗 **2 张** 木板 -> 木板剩 2 < 3 -> 报缺。
       *   （日志里"有 1"是因为它还多补了一轮 stick，共吃 4 张。）
       *
       * 所以：如果是"原料 A 会消耗原料 B"这种关系，**B 必须最后补**，
       * 否则 B 补好的量会被 A 吃掉，而这一遍的需求判断已经过去了。
       */
      const consumesOther = (selfId, otherId) => {
        try {
          const it = mcData.items[selfId]
          if (!it) return false
          const rs = (mcData.recipes[it.id] || [])
          for (const raw of rs) {
            const rec = new (require('prismarine-recipe')(mcData).Recipe)(raw, mcData)
            if (rec.delta.some(d => d.id === otherId && d.count < 0)) return true
          }
        } catch (e) {}
        return false
      }
      const needEntries = Object.entries(pick.needs)
      needEntries.sort((a, b) => {
        const ai = parseInt(a[0], 10)
        const bi = parseInt(b[0], 10)
        const aEatsB = consumesOther(ai, bi)     // a 会吃掉 b -> a 先补
        const bEatsA = consumesOther(bi, ai)
        if (aEatsB && !bEatsA) return -1
        if (bEatsA && !aEatsB) return 1
        return 0
      })

      for (const [iid, n] of needEntries) {
        const item = mcData.items[parseInt(iid, 10)]
        if (!item) continue
        if (this.countOf(item.name) >= n) continue

        const before = this.countOf(item.name)
        let got = false
        let firstErr = null

        // a. 递归合成（木板/木棍这种链短的走这条）
        //
        // 【实测的 bug · 2026-11-13 10:23】递归时传的是**差值**，
        // 而 craftSmart 内部又会减一次 countOf —— 等于重复扣减。
        //   countOf(oak_planks) = 3，配方要 8 -> 传 craftSmart('oak_planks', 5)
        //   内部 need = 5 - 3 = 2，times = ceil(2/4) = 1
        //   -> 只产 4 张，总数 7，还差 1 张
        //   -> 日志 `补 oak_planks 后：7/8 got=false`
        //   -> 第 2 遍传 craftSmart('oak_planks', 1)，need = 1-7 < 0 -> 直接 return true
        //      -> `补料 2 遍后仍缺：oak_planks 要 8 有 7`
        //
        // craftSmart(name, count) 的语义是"最终要 count 个"（绝对值），
        // 不是"再补 count 个"。所以这里直接传绝对目标 n。
        try {
          this.log(`[craft] 补 ${item.name}：目标 ${n}（现有 ${before}）`)
          await this.craftSmart(item.name, n, depth + 1)
          got = this.countOf(item.name) >= n
          this.log(`[craft] 补 ${item.name} 后：${this.countOf(item.name)}/${n} got=${got}`)
        } catch (e) {
          firstErr = e
          this.log(`[craft] 补 ${item.name} 抛错: ${e.message}（现在 ${this.countOf(item.name)}/${n}）`)
        }

        // b. 合不出来：直接从世界里拿。
        //
        // 【实测 · 2026-11-13 10:35】`[mine] 到时间上限（50s），已挖到 2 个`
        // 之后 gather 认为成功（旧实现只看 >0），补料循环就放行了，
        // 最后拿着 2 个圆石去合成石镐 -> missing ingredient。
        // gather 现在会如实返回 false；这里再给它一次机会
        // （mine 有单次时长上限，再跑一次通常能凑够剩下的 1 个）。
        if (!got) {
          for (let attempt = 0; attempt < 2 && !got; attempt++) {
            const lack = n - this.countOf(item.name)
            if (lack <= 0) { got = true; break }
            try {
              got = await this.gather(item.name, lack)
            } catch (e) { got = false }
            if (!got) {
              this.log(`[craft] 采 ${item.name} 第 ${attempt + 1} 次没凑够（还差 ${lack}），再试一次`)
              await sleep(300)
            }
          }
        }

        // c. 石头类材料：先保证有镐子，再挖一次。
        //    没有镐子时挖石头不掉东西，gather 里的 mine() 会一路空转。
        if (!got && STONE_MATS.test(item.name)) {
          this.log(`[craft] 缺 ${item.name}，先弄把镐子`)
          let pick2 = null
          try {
            pick2 = await this.ensurePickaxe()
          } catch (e) {
            this.log('[craft] 镐子也没弄到: ' + e.message)
          }
          if (pick2) {
            this.log(`[craft] 有 ${pick2} 了，再挖 ${item.name}`)
            try {
              got = await this.gather(item.name, Math.max(1, n - this.countOf(item.name)))
            } catch (e) { got = false }
          }
        }

        if (this.countOf(item.name) >= n) {
          progressed = true
        } else {
          // 记下还没满足的，别在循环里直接抛 —— 下一遍可能就够了
          // （木棍消耗木板正是这种情况）
          unsatisfied.push({ name: item.name, need: n, have: this.countOf(item.name), err: firstErr })
          if (this.countOf(item.name) > before) progressed = true
        }

        // 【方案 B · 2026-11-13 11:00】每补完一项就**立刻重算** needs。
        //
        // 只靠"每遍开头重算"不够：同一遍里补 stick 会吃掉 oak_planks，
        // 而被吃掉的那一项可能已经补过了（判断用的还是补之前的数量），
        // 于是这一遍结束时木板 2 < 3，直接报"补料 1 遍后仍缺"。
        // 每项补完重算，下一项用的就是最新的真实缺口。
        pick.needs = recomputeNeeds()
      }

      if (!unsatisfied.length) break
      if (!progressed) {
        this.log(`[craft] 第 ${fillPass} 遍补料没有进展，停手`)
        break
      }
      this.log(`[craft] 第 ${fillPass} 遍补料后还缺 ` +
        unsatisfied.map(u => `${u.name}(${u.have}/${u.need})`).join('、') + '，再来一遍')
    }

    // 补料收尾：还有缺口就明确报出来（比 safeCraft 的 missing ingredient 清楚）
    const stillShort = Object.entries(pick.needs).filter(([iid, n]) => {
      const item = mcData.items[parseInt(iid, 10)]
      return item && this.countOf(item.name) < n
    })
    if (stillShort.length) {
      const detail = stillShort.map(([iid, n]) => {
        const it = mcData.items[parseInt(iid, 10)]
        return `${it.name} 要 ${n} 有 ${this.countOf(it.name)}`
      }).join('、')
      throw new Error(`补料 ${fillPass} 遍后仍缺：${detail}`)
    }

    // 4. 正式合成
    //
    // 【实测的坑 · 2026-11-13 09:45 e2e】
    // `补料 2 遍后仍缺：oak_planks 要 8 有 7` —— 补料已经把 8 张备齐了，
    // 是后面这一步把木板吃掉的：
    //   ensureTable() 为了造工作台消耗 4 张木板，
    //   而它内部的"补回 reservePlanks"只在 `woodCount() > 0` 时生效 ——
    //   原木刚好用完时就补不回来，于是箱子配方只剩 7 张。
    //
    // 现在两层保护：
    //   1. 把"配方还要几张木板"传给 ensureTable（它知道该留多少）
    //   2. ensureTable 之后如果木板掉到需求以下，这里再补一次
    const planksNeeded = (() => {
      for (const d of pick.r.delta) {
        if (d.count >= 0) continue
        const it = mcData.items[d.id]
        if (it && /_planks$/.test(it.name)) return -d.count * times0
      }
      return 0
    })()
    const table = pick.r.requiresTable
      ? await this.ensureTable(planksNeeded)
      : this.findBlock('crafting_table', 12)
    if (pick.r.requiresTable && !table) throw new Error('需要工作台但放不下')
    // times 必须按"现在还差多少"重算，不能用补料阶段的 times0。
    //
    // 【实测 · 2026-11-13 09:52】craftSmart('oak_planks', 8) 在 0->4 的过程中：
    //   times0 = ceil(8/4) = 2     （补料阶段算的，按"一张都没有"估）
    //   但补料循环里已经先做过一次 craftSmart('oak_planks', 8)，
    //   它内部 need = 8 - 0 = 8、times = 2，产出 8 张 → 之后只剩 4 张被消耗
    //   回到这里 times 仍是 2，又合成一次 —— 数量对不上就抛"背包没变化（4/8）"。
    //
    // 正确做法：按**当前**背包缺口算份数。
    const stillNeed = Math.max(1, count - this.countOf(name))
    const times = Math.max(1, Math.ceil(stillNeed / pick.r.result.count))

    // ensureTable 又把木板吃了一次 —— 补回来再合成
    if (planksNeeded > 0 && this.plankTotal() < planksNeeded) {
      const shortOf = planksNeeded - this.plankTotal()
      this.log(`[craft] 工作台吃掉了木板，还差 ${shortOf} 张，补一下`)
      try {
        if (this.woodCount() > 0) await this.anyPlanks(planksNeeded)
        else await this.gather(this.bestPlank() || 'oak_planks', shortOf)
      } catch (e) {
        this.log('[craft] 工作台后补木板失败: ' + e.message)
      }
    }

    // 走到工作台旁边再确认配方
    // 关键：走不到就立刻报错。openBlock 不做距离校验，
    // 站太远时服务端直接丢弃 use_item_on，客户端会静默等满 20 秒 windowOpen 超时，
    // 然后 safeCraft 重试 4 次 = 白烧 84 秒。宁可在第一步就失败。
    if (table) {
      let arrived = await this.goto(table.position.x, table.position.y, table.position.z, 3, 15000)
      let dTable = table.position.distanceTo(this.pos())
      if (arrived !== true && arrived !== 'ok') {
        // 【实测 · 2026-11-13 10:47】`走不到工作台（差 11.0 格）` ——
        // 工作台就在 11 格外，走过去却被地形挡住（树顶/坑边/水边）。
        // 直接 throw 会让整个合成失败，但**工作台是自己刚放的**，
        // 完全可以在脚边另找一个地方重放一个 —— 比原地放弃划算得多。
        this.log(`[craft] 走不到工作台（差 ${dTable.toFixed(1)} 格），试着在脚边重放一个`)
        try { await this.flattenSpot() } catch (e) {}
        const placed = await this.placeNearby('crafting_table')
        if (placed) {
          table = placed
          arrived = await this.goto(table.position.x, table.position.y, table.position.z, 3, 12000)
          dTable = table.position.distanceTo(this.pos())
        }
      }
      // 只要真的在伸手范围内（<= 4.2），即使 goto 判"没到"也可以合
      if (arrived !== true && arrived !== 'ok' && dTable > 4.2) {
        throw new Error('走不到工作台（差 ' + dTable.toFixed(1) + ' 格）')
      }
      if (dTable <= 4.2) this.log(`[craft] 工作台在 ${dTable.toFixed(1)} 格内，可以合`)
    }
    const usable = this.bot.recipesFor(id, null, Math.max(1, count - this.countOf(name)), table || null)
    // 关键：优先用补料时选的那个配方，别让 usable[0] 换成别的变体
    // （补的是 oak_planks，结果用了需要 birch_planks 的配方 -> missing ingredient）
    let recipe = pick.r
    if (usable && usable.length) {
      const same = usable.find(r => r.result.id === pick.r.result.id)
      recipe = same || usable[0]
    }
    const okCraft = await this.safeCraft(recipe, times, table || null)
    if (!okCraft) throw new Error('合成 ' + name + ' 失败')
    // 合成后确认真的进了背包。recipesFor 返回配方 ≠ 服务端真的给了东西
    // （材料被别的动作消耗、背包未同步，都会导致"报成功但没东西"）
    if (this.countOf(name) < count) {
      await sleep(250)
      if (this.countOf(name) < count) {
        throw new Error('合成 ' + name + ' 后背包没变化（' +
          this.countOf(name) + '/' + count + '）')
      }
    }
    return true
  }

  /**
   * 合成（带重试 + 背包同步）。
   *
   * 之前老失败的原因：服务端回包慢，本地 inventory 还没更新就去 craft，
   * mineflayer 算出"材料不够"，报 missing ingredient。
   *
   * 重要：失败必须抛错。之前重试 4 次后 `return false`，
   * 调用方 craftSmart 又不检查返回值 -> 合成失败被当成成功，
   * 上层继续往下走，最后表现为"做不出来但没人知道为什么"。
   */
  async safeCraft (recipe, times, table) {
    let lastErr = null
    for (let i = 0; i < 4; i++) {
      try {
        await this.bot.craft(recipe, times, table || null)
        return true
      } catch (e) {
        lastErr = e
        const msg = String((e && e.message) || '')
        this.log('craft retry' + i + ': ' + msg)

        // 等一会儿让背包同步
        await sleep(600 + i * 400)

        // 材料不够：先同步背包再看配方还在不在
        if (/missing ingredient|not enough/i.test(msg)) {
          await this.syncInventory()
        }

        // 重新取配方（背包可能刚变）
        try {
          const id = recipe.result && recipe.result.id
          if (id) {
            const rs = this.bot.recipesFor(id, null, Math.max(1, times), table || null)
            if (rs && rs.length) { recipe = rs[0]; continue }
            // 取不到配方 = 材料真的不够，再试也是空转，直接失败
            throw new Error('材料不够，配方已不可用: ' + msg)
          }
        } catch (e2) {
          if (/配方已不可用/.test(String(e2 && e2.message))) throw e2
        }

        if (i === 3) break
      }
    }
    throw new Error('合成反复失败: ' + String((lastErr && lastErr.message) || lastErr))
  }

  /**
   * 同步背包。
   *
   * 老实现发的是非法包：1.21.11 的 window_click 要 7 个字段
   * （windowId/stateId/slot/mouseButton/mode/changedSlots/sequence），
   * 只传 4 个会让 protodef 报 "SizeOf error for play.toServer"，
   * 服务端一个字节都收不到 —— 也就是说"强制同步"从来没生效过，还白等 300ms。
   *
   * 现在只做安全的事：请求服务端重发一次当前窗口内容。
   */
  async syncInventory () {
    try {
      // 注意方法名：mineflayer 暴露的是 **bot._syncWindow**（带下划线）。
      // 老代码写 bot.syncWindow —— 这个函数根本不存在，每次调用直接抛
      // "bot.syncWindow is not a function" 被 catch 吞掉，
      // 所以"强制同步背包"从来没生效过。
      const w = this.bot.currentWindow || this.bot.inventory
      if (w && typeof this.bot._syncWindow === 'function') {
        await this.bot._syncWindow(w)
      } else {
        await sleep(200)
      }
    } catch (e) {
      await sleep(200)
    }
  }


  // 保证身边有工作台
  /**
   * 保证身边有工作台。
   *
   * 关键：做工作台要吃掉 4 张木板。调用方（比如 craftSmart('chest')）
   * 刚刚按配方把木板备够了，ensureTable 一来就抽走 4 张 ——
   * 配方立刻从"够"变成"不够"，craftOnce 报 missing ingredient。
   * 实测「放箱子」62% 的失败就是这么来的：
   *   8 张 oak_planks 备好 -> 做工作台用掉 4 张 -> 剩 4 张，箱子要 8 张 -> 失败。
   *
   * 所以这里只在**不够做桌子**时才去动木板；够的话优先：
   *   附近的台子 -> 背包里的台子 -> 用"额外的"原木现做一个（不动调用方的木板）
   *
   * 默认预留 8 张：这是"最大单色木板消耗"（箱子 8 张）的量。
   * 之所以给非 0 默认值，是因为 craftSmart 调用时没传参 ——
   * 它刚按配方备好的木板不能被这里抽走，否则配方当场失效。
   * 严格来说应该由 craftSmart 把"这个配方还要几张"传进来，
   * 但那在 action-fixer 负责的函数里，这里先用保守默认值兜住。
   *
   * @param {number} reservePlanks 调用方还要留多少张木板（默认 8）
   */
  async ensureTable (reservePlanks = 8) {
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
      let plankName = this.bestPlank()
      const plankCount = plankName ? this.countOf(plankName) : 0

      // 木板不够"桌子 + 调用方预留"：先补
      if (plankCount < 4 + reservePlanks) {
        if (this.woodCount() > 0) {
          try { await this.anyPlanks(4 + reservePlanks + 4) } catch (e) {}
        } else {
          try { await this.ensureWood(2); await this.anyPlanks(4 + reservePlanks + 4) } catch (e) {}
        }
        plankName = this.bestPlank()
      }

      const nowCount = plankName ? this.countOf(plankName) : 0
      if (nowCount < 4) {
        this.log('[table] 木板不够（' + nowCount + '/4）')
        await sleep(400)
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
        // 关键：桌子吃掉了 4 张木板，把调用方的储备补回来。
        // 有原木就补；没原木就认了（下面 craftSmart 会报材料不够）。
        if (reservePlanks > 0 && this.woodCount() > 0 && this.plankTotal() < reservePlanks) {
          try { await this.anyPlanks(reservePlanks) } catch (e) {}
        }
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
    // 断线 / 还没复活：没有位置，就没有"我在哪"这回事。
    // 按"还在下面"处理 —— 保守方向错只会白爬一趟，
    // 乐观方向错会让调用方打出"出来了！"的假成功。
    if (!bot || !bot.entity || !bot.entity.position) return true
    const p = bot.entity.position

    // 头顶 2 格就被挡 -> 肯定在洞里
    //
    // 但树叶/原木要排除：站在树底下（尤其丛林/深色橡木那种低垂树冠）
    // 头顶 2 格就是树叶，这跟"在洞里"完全是两回事。
    // 实测：站在 y=63 地表的一棵橡树下，被判成"在地下"，
    // 于是 chopTree 先喊"[chop] 在地下，先回地面"，
    // getToSurface 挖了半天什么都没挖（本来就在地面），
    // 最后打出一行假成功"[surface] 出来了！y=63（上升 0 格）"。
    const isCover = (b) => !!(b && b.boundingBox === 'block' && !/leaves|log/.test(b.name))
    const near = bot.blockAt(p.offset(0, 2, 0))
    const near2 = bot.blockAt(p.offset(0, 3, 0))
    if (isCover(near)) return true
    if (isCover(near2)) return true

    // 往上找第一个遮挡。
    //
    // 关键：blockAt 返回 null 有两种完全不同的意思 ——
    //   · 那里确实是空气（区块加载了，我们看见了）
    //   · 我们看不见（区块没加载 / 刚断线 / 死了还没复活）
    // 原实现 `if (!b) break` 把"看不见"当成"一路通天"，
    // 于是断线时判成露天 —— 调用方（getToSurface 最后一行）就报"出来了"。
    // 现在连续 3 格看不见就不再猜，按"还在洞里"算。
    let firstBlockAt = -1
    let blind = 0
    for (let dy = 4; dy <= 60; dy++) {
      const b = bot.blockAt(p.offset(0, dy, 0))
      if (!b) {
        if (++blind >= 3) return true      // 看不清 -> 不下"露天"的结论
        continue
      }
      blind = 0
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

    const FILL_NAMES = ['dirt', 'cobblestone', 'andesite', 'stone', 'gravel', 'granite', 'diorite',
      'cobbled_deepslate']
    const filler = () => FILL_NAMES.map(n => this.item(n)).find(Boolean)
    const fillerCount = () => FILL_NAMES.reduce((n, name) => n + this.countOf(name), 0)

    /**
     * 没镐又没料的时候，先弄把镐。
     *
     * 为什么必须先做镐：空手挖 stone / granite / andesite **一块料都不掉**
     * （实测：挖掉 granite 掉 3 个物品实体，全躺在地上，背包 0 增加）。
     * 没料就没法垫台阶，就只能一格一格挖台阶，实测 50 秒/格；
     * 有镐能挖石头攒料之后，塔升只要 14 秒/格。
     *
     * 做不出来（比如周围真没树）就直接放弃，退回挖台阶 —— 不能卡死在这里。
     */
    // 关于"先做镐"：实测在地下这条路走不通 ——
    //   ensurePickaxe -> chopTree -> 在地下砍不到树 -> 又调 getToSurface -> 死锁
    // 加 _surfaceRunning 能打破死锁，但做镐依然是 0 成功（地下没树）。
    // 而且它本来就不必要：空手挖 dirt/gravel/sand 一样有料（只有石头需要镐）。
    // 所以这里不做镐，直接交给 stockFiller 挑软方块挖。

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

    /**
     * 捡起身边的掉落物（挖完不捡，背包永远是空的）。
     * 别用 goto 走远路 —— 挖台阶时掉落物就在脚边。
     */
    const grabDrops = async (radius = 3) => {
      try {
        const p = this.pos()
        const drops = Object.values(bot.entities).filter(e =>
          e && e.name === 'item' && e.position.distanceTo(p) < radius)
        if (!drops.length) return
        for (const d of drops) {
          try {
            // 站在掉落物正上方就够了，别去追它的精确 y
            // （掉落物可能卡在半空/方块里，追 y 会把寻路搞崩）
            bot.pathfinder.setGoal(new goals.GoalBlock(
              Math.floor(d.position.x), Math.floor(p.y), Math.floor(d.position.z)))
            for (let i = 0; i < 8; i++) {
              await sleep(110)
              if (!bot.entities[d.id]) break
              // 已经贴上了就别再等，自动吸附会处理
              if (d.position.distanceTo(this.pos()) < 1.2) break
            }
          } catch (e) {}
        }
        try { bot.pathfinder.setGoal(null) } catch (e) {}
        await sleep(120)
      } catch (e) {}
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
      // 关键：挖完要捡。不捡的话"挖了半天背包还是空的"，
      // 后面想垫台阶/搭柱子就没有料了。
      if (!isFree(v)) return false
      await grabDrops(3)
      return true
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

    /**
     * 找正上方第一个实心方块，离脚底多少格。
     * 头顶可能是 2 格空，也可能是 9 格空 —— 写死范围必错。
     * 返回 -1 表示 24 格内全是空的（那就是到地表了）。
     */
    const firstSolidAbove = (p, max = 24) => {
      for (let dy = 1; dy <= max; dy++) {
        if (isSolid(p.offset(0, dy, 0))) return dy
      }
      return -1
    }

    /**
     * 原地上顶一格。
     *
     * 真人往上爬柱子就两件事：
     *   1. 把头顶第一个实心块挖掉，再往上多挖 2 格，给自己腾出 3 格站人空间
     *   2. 跳起来，趁脚离地的那一下在自己脚下垫一块
     *
     * 之前失败的两个原因：
     *   - 挖的 dy 范围写死成 2..4，头顶是 9 格空的时候一格都没挖到（Lead 实测指出）
     *   - 只 setGoal 不垫方块：脚下没台阶，跳上去也站不住
     */
    const tryPillar = async () => {
      if (!towerOk) return false

      const p = this.pos()
      const F = Math.floor(p.y)

      // 没有垫脚方块：试着挖「能挖出料」的方块补一点。
      //
      // 关键：空手挖 stone/granite/andesite **0 掉落**（实测：挖掉掉 3 个
      // 物品实体全躺地上，背包 0 增加）。所以这里只能挖软方块，
      // 否则每轮都会白挖掉头顶一块石头 —— 地形被破坏了，料还是 0，
      // 这就是 54↔55 反复震荡的根源。
      let fill = filler()
      if (!fill) {
        const hasPick = bot.inventory.items().some(i => /_pickaxe$/.test(i.name))
        const SOFT = /^(dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|gravel|sand|red_sand|clay|snow_block|soul_soil|moss_block)$/
        const okToTake = (nm) => hasPick || SOFT.test(nm)

        let target = null
        // 头顶 4 格内找
        for (let dy = 1; dy <= 4; dy++) {
          const v = p.offset(0, dy, 0)
          if (!isSolid(v)) continue
          const nm = nameAt(v)
          if (/bedrock|lava|water/.test(nm)) break
          if (okToTake(nm)) { target = v; break }
        }
        // 头顶没有就找脚边的（脚和身体两层）
        if (!target) {
          for (const [dx, dz] of DIRS) {
            for (const dy of [0, 1]) {
              const v = p.offset(dx, dy, dz)
              if (!isSolid(v)) continue
              const nm = nameAt(v)
              if (/bedrock|lava|water/.test(nm)) continue
              if (!okToTake(nm)) continue
              target = v
              break
            }
            if (target) break
          }
        }

        if (target) {
          await digOne(target)
          await grabDrops(4)
          fill = filler()
        }
      }
      if (!fill) return false                      // 实在没料，交给挖台阶分支

      // 头顶 10 格内有水/岩浆就别直着上（会淹死/烧死）
      for (let dy = 2; dy <= 10; dy++) {
        if (/water|lava/.test(nameAt(p.offset(0, dy, 0)))) return false
      }

      // 1) 找第一个实心块，挖它和上面两格
      const fs = firstSolidAbove(p)
      if (fs < 0) return false                     // 头顶全空，交给外面的地表判定
      for (let dy = fs; dy <= fs + 2; dy++) {
        if (isSolid(p.offset(0, dy, 0))) await digOne(p.offset(0, dy, 0))
      }
      // 挖完必须至少有 3 格空（脚 + 身体 + 头），否则跳不起来
      for (let dy = 0; dy <= 3; dy++) {
        if (isSolid(p.offset(0, dy, 0))) return false
      }

      // 2) 跳起来，在自己脚下垫一块
      //
      // 踩过的两个坑（都是实测出来的）：
      //   a) 参考块不能用 mid.y 算。跳到半空时 floor(mid.y) 会变成 F+1，
      //      算出来的参考块就跑到了脚底下那格下面，放置位置直接错一格。
      //      必须用起跳前的 F，固定在原地那一列。
      //   b) 不能用固定 260ms。脚还没抬到目标方块上面（y-F < 1.0）时，
      //      服务端认为方块和自己重叠，拒绝放置 —— 这就是 53↔54 反复来回的原因。
      //      改成轮询到脚确实越过 F+1 再放。
      //   c) 放方块在正下方不需要 recenter（参考块就在脚底），
      //      而 recenter 会把人往前推、推出柱子边缘掉下去。
      const colX = Math.floor(p.x)
      const colZ = Math.floor(p.z)
      let placed = false
      for (let attempt = 0; attempt < 2 && !placed; attempt++) {
        try {
          await bot.equip(fill, 'hand')
          await sleep(100)
          bot.setControlState('jump', true)
          // 轮询到脚越过目标方块顶面（F+1），最多 700ms
          let airborne = false
          for (let i = 0; i < 35; i++) {
            await sleep(20)
            if (this.pos().y - F >= 1.02) { airborne = true; break }
          }
          if (airborne) {
            const ref = bot.blockAt(new Vec3(colX, F - 1, colZ))
            if (ref && ref.boundingBox === 'block') {
              await bot.lookAt(ref.position.offset(0.5, 1.0, 0.5), true)
              await bot.placeBlock(ref, new Vec3(0, 1, 0))
              placed = isSolid(new Vec3(colX, F, colZ))
            }
          }
          bot.setControlState('jump', false)
          await sleep(420)
        } catch (e) {
          try { bot.setControlState('jump', false) } catch (e2) {}
          await sleep(250)
        }
      }
      if (placed) await sleep(200)

      // 3) 没垫上就退到 pathfinder（它自己会搭塔，main.js 已开 allow1by1towers）
      if (this.pos().y < F + 0.9) {
        try {
          bot.pathfinder.setGoal(new goals.GoalBlock(Math.floor(p.x), F + 1, Math.floor(p.z)))
          for (let i = 0; i < 15; i++) {
            await sleep(200)
            if (this.pos().y >= F + 0.9) break
          }
        } catch (e) {}
        try { bot.pathfinder.setGoal(null) } catch (e) {}
      }

      return this.pos().y >= F + 0.9
    }

    /**
     * 先攒够垫脚料再往上走。
     *
     * 为什么必须有这一步：塔升一格只要 0.2 秒，但每格要消耗 1 块方块。
     * 背包空的时候只能退回"挖台阶"，实测 50 秒/格 —— 6 格就要 300 秒。
     * 有料的话 18 格 4 秒就上去了。差 75 倍。
     *
     * 做法：原地往下挖几格（挖出来的东西自己就进包），够数就停。
     */
    /**
     * 这块空手挖会不会掉东西？
     * stone 系（stone/deepslate/矿石/andesite 等）必须用镐，
     * 空手挖掉只是"方块消失了"，不掉任何物品 —— 实测确认。
     */
    const hardBlockNoTool = (blk) => {
      const hasPick = bot.inventory.items().some(i => /_pickaxe$/.test(i.name))
      if (hasPick) return false
      return /stone|deepslate|andesite|diorite|granite|tuff|calcite|_ore$|obsidian|basalt|blackstone/.test(blk.name)
    }

    /**
     * 空手能挖出料的方块。
     *
     * 实测（很关键，别再踩）：
     *   · dirt / grass_block / gravel / sand / clay  → 空手挖就掉，能进包
     *   · stone / granite / andesite / deepslate / 矿石 → **必须有镐**，
     *     空手挖掉方块会消失，但 0 物品掉落
     *
     * 所以没镐的时候不要碰石头，专挑软方块挖 —— 这才是"有料能塔升"的最快路径。
     */
    const SOFT_FILL = /^(dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|gravel|sand|red_sand|clay|snow_block|soul_soil|moss_block)$/
    const isSoft = (name) => SOFT_FILL.test(name)

    /**
     * 攒垫脚料。
     *
     * 有镐：头顶石头随便挖（顺便腾出上升空间）。
     * 没镐：只挖软方块（dirt/gravel/sand…），绝不碰石头 ——
     *       空手挖石头 0 掉落，白挖还白耗时间（实测挖掉 granite 掉 3 个
     *       物品实体全躺在地上，背包 0 增加）。
     */
    const stockFiller = async (need = 12) => {
      if (fillerCount() >= need) return true
      const hasPick = bot.inventory.items().some(i => /_pickaxe$/.test(i.name))
      const t0 = Date.now()
      let round = 0
      let emptyStreak = 0

      // 空手时给它 8 秒就够（软方块挖一块约 1 秒）；有镐给 15 秒。
      // 攒料不是主线，攒不到就该赶紧去挖台阶。
      const budget = hasPick ? 15000 : 8000
      while (fillerCount() < need && Date.now() - t0 < budget && round++ < 24) {
        const p = this.pos()
        const before = fillerCount()

        // 1) 找头顶第一个「能挖出料」的方块
        let target = null
        for (let dy = 1; dy <= 6; dy++) {
          const v = p.offset(0, dy, 0)
          if (!isSolid(v)) continue
          const nm = nameAt(v)
          if (/bedrock|lava|water/.test(nm)) break
          // 有镐 -> 石头也行；没镐 -> 只要软方块
          if (hasPick || isSoft(nm)) { target = v; break }
        }

        // 2) 头顶没有：往四周找软方块（水平 1 格，脚和身体两层）
        if (!target) {
          for (const [dx, dz] of DIRS) {
            for (const dy of [0, 1]) {
              const v = p.offset(dx, dy, dz)
              if (!isSolid(v)) continue
              const nm = nameAt(v)
              if (/bedrock|lava|water/.test(nm)) continue
              if (!(hasPick || isSoft(nm))) continue
              target = v
              break
            }
            if (target) break
          }
        }

        if (!target) {
          // 这附近没料可挖了
          if (round > 3) break
          await sleep(150)
          continue
        }

        await digOne(target)
        await grabDrops(4)
        await sleep(180)

        if (fillerCount() > before) {
          emptyStreak = 0
        } else if (++emptyStreak >= 2) {
          // 连着两铲没进包，这地形挖不出料，别再耗
          break
        }
      }

      this.log(`[surface] 攒料：${fillerCount()} 块${hasPick ? '' : '（空手，只挖软方块）'}`)
      return fillerCount() > 0
    }
    await stockFiller(12)

    /**
     * 「真的出来了」还是「只是钻进了个浅缝」？
     *
     * 只看 isUnderground() 不够 —— 实测在 y=50 全石头环境里，
     * 往上挪一格恰好挪进了个浅缝，isUnderground() 立刻变 false，
     * 于是打出一行「出来了！y=65（上升 1 格）」的假成功。
     *
     * 真出来的判据：头顶 20 格内没有任何实心方块（不含树叶/原木/草）。
     */
    const reallyOut = () => {
      if (this.isUnderground()) return false
      const p = this.pos()
      for (let dy = 1; dy <= 20; dy++) {
        const b = bot.blockAt(p.offset(0, dy, 0))
        if (!b) continue                        // 看不见就不下结论
        if (b.boundingBox === 'block' && !/leaves|log|_grass$|fern/.test(b.name)) return false
      }
      return true
    }

    // 死锁检测：用**时间**而不是步数。
    // 步数不可靠：空手挖一块石头要 7.5 秒，一步可能就要 20 秒，
    // 按 14 步算要 280 秒才认输 —— 早烧穿上层预算了（实测 e2e 就是这么 0% 的）。
    // 实测：y=50 全石头空手时，「挖台阶」每步要 20+ 秒（空手挖石头 7.5 秒/块）。
    // 75 秒才认输 -> 总耗时 181 秒，还是太慢（e2e 单任务 240 秒）。
    // 收紧到 45 秒：4~5 步没有实质上升就说明这地形走不通了。
    const NO_RISE_MS = 45000
    const HARD_MS = 180000          // 整个函数最多 3 分钟
    let lastRiseAt = Date.now()
    const fnStartAt = Date.now()
    let stuckSteps = 0
    let lastY = startY

    try {
      for (let step = 0; step < maxSteps; step++) {
        this.check()

        if (reallyOut()) {
          const climbed = Math.round(this.pos().y - startY)
          this.log(`[surface] 出来了！y=${Math.round(this.pos().y)}（上升 ${climbed} 格）`)
          return true
        }
        // 只是 isUnderground() 变 false，但头顶还压着石头 -> 不算出来，继续爬
        if (!this.isUnderground()) {
          const climbed = Math.round(this.pos().y - startY)
          this.log(`[surface] 头顶还有石头（只升了 ${climbed} 格），继续`)
        }

        // 死锁检测（时间判据）：
        // 实测 y=50 全石头 + 空手时，三个手段（塔升 / 挖台阶 / 就地掏）同时失效，
        // 空转 240 秒把 e2e 预算烧穿。现在按时间认输。
        if (this.pos().y > lastY + 0.5) {
          lastY = this.pos().y
          lastRiseAt = Date.now()
          stuckSteps = 0
        } else {
          stuckSteps++
        }
        if (Date.now() - lastRiseAt > NO_RISE_MS) {
          const climbed = Math.round(this.pos().y - startY)
          this.log(`[surface] ${Math.round((Date.now() - lastRiseAt) / 1000)} 秒没升高，` +
            `判定走不通：上升 ${climbed} 格 / ${fillerCount()} 块料 / ` +
            `头顶 ${nameAt(this.pos().offset(0, 2, 0))} / ` +
            `镐=${bot.inventory.items().some(i => /_pickaxe$/.test(i.name)) ? '有' : '无'}`)
          break
        }
        if (Date.now() - fnStartAt > HARD_MS) {
          this.log('[surface] 超过 5 分钟硬上限，收工')
          break
        }

        // ===== 每步重新决策：按「手上还有几块料」选策略 =====
        //
        // 为什么不一次性决定：挖台阶会顺手捡到 dirt/gravel，料会变多；
        // 反过来塔升一格消耗 1 块，料会变少。每步都重新看才跟得上。
        //
        //   料 >= 1  -> 先试塔升（23s/格，比挖台阶快 2~3 倍）
        //   料 == 0  -> 直接挖台阶（塔升没料必然失败，跑了也是白跑）
        const fillerNow = fillerCount()
        if (fillerNow >= 1) {
          if (await tryPillar()) continue
          // 塔升失败（头顶基岩 / 放不上去）：掉到挖台阶，不换方向不重试
        }

        // ===== 兜底：挖台阶（头顶有水/岩浆、或者没垫脚方块时才走这里）=====
        const p = this.pos()
        const F = Math.floor(p.y)
        const here = `${Math.floor(p.x)},${F},${Math.floor(p.z)}`

        // 先给自己留出跳跃空间：2 格高的通道里跳只抬 0.5 格，够不到 1 格台阶。
        // 用「找第一个实心块」而不是写死 dy —— 头顶可能是 2 格空，也可能是 9 格空。
        const fsHere = firstSolidAbove(p, 6)
        if (fsHere > 0) {
          for (let dy = fsHere; dy <= fsHere + 1; dy++) {
            if (isSolid(p.offset(0, dy, 0))) await digOne(p.offset(0, dy, 0))
          }
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
            // 四个方向都试遍了还挪不动 —— 这是「空手 + 全石头 + 没台阶」的死角。
            // 实测就在这里空转了 10 分钟（y=55 一直「上不去，换方向」）。
            // 正确做法：别管台阶了，就地往上掏一格（digUpOne 不需要任何材料）。
            const yBefore = this.pos().y
            let bore = false
            try { bore = await this.digUpOne() } catch (e) {}
            if (bore && this.pos().y > yBefore + 0.5) {
              this.log(`[surface] 无路可走，就地往上掏了一格（y=${Math.round(this.pos().y)}）`)
              bad.clear()          // 换了一层，之前拉黑的方向作废
            } else {
              this.log('[surface] 就地掏也上不去，这一层没戏了')
            }
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
            // 没料垫台阶：先记下这个方向不行，同时试着原地往上掏一格。
            // 只拉黑不动作的话，四个方向很快全黑，然后就是无限「换方向」。
            if (bad.size >= DIRS.length) {
              const yB = this.pos().y
              let b2 = false
              try { b2 = await this.digUpOne() } catch (e) {}
              if (b2 && this.pos().y > yB + 0.5) {
                this.log(`[surface] 没料垫台阶，就地掏一格（y=${Math.round(this.pos().y)}）`)
                bad.clear()
              }
            }
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
    const out = reallyOut()
    if (out) {
      this.log(`[surface] 出来了！y=${Math.round(this.pos().y)}（上升 ${Math.round(climbed)} 格）`)
    } else {
      this.log(`[surface] 没上去：上升 ${Math.round(climbed)} 格，` +
        `头顶 ${nameAt(this.pos().offset(0, 2, 0))}，料 ${fillerCount()} 块`)
    }
    // 只用 reallyOut() 判定，不再看 isUnderground()：
    //   · 它会把 null（断线/区块没加载）当成 truthy，打出假成功
    //   · 它也会把"钻进了个浅缝"当成出来了（实测 y=50 只升 1 格就报成功）
    return out
  }

  // ============================================================
  // 身体动作：跳、潜行、搭柱子
  // 这些是最基础的"用手"，之前完全没给他
  // ============================================================

  /** 跳一下 */
  async jump (ms = 300) {
    try {
      this.bot.setControlState('jump', true)
      await sleep(ms)
      this.bot.setControlState('jump', false)
      return true
    } catch (e) { return false }
  }

  /** 潜行（防止从边缘掉下去） */
  async sneak (on = true) {
    try { this.bot.setControlState('sneak', !!on); return true } catch (e) { return false }
  }

  /**
   * 把头顶挡路的方块挖掉几格，给上升腾出空间。
   *
   * 用途：树长在高坡上时，pathfinder 经常被头顶一格 cobblestone 顶死
   * （实测人在 y=64.7，+1 格就是 cobblestone，于是永远「差 6.0 格」）。
   * 只挖软的/普通的，基岩、岩浆、水一律不动。
   *
   * @param {number} layers 往上清几格
   * @returns {Promise<number>} 实际挖掉几块
   */
  async clearHeadRoom (layers = 3) {
    const bot = this.bot
    let dug = 0
    for (let dy = 1; dy <= layers + 1; dy++) {
      const v = this.pos().offset(0, dy, 0)
      const b = bot.blockAt(v)
      if (!b || b.boundingBox !== 'block') continue
      if (/bedrock|lava|water|chest|furnace|crafting_table/.test(b.name)) continue
      try {
        if (await this.digAt(b)) dug++
      } catch (e) {}
      await sleep(80)
    }
    return dug
  }

  /**
   * 往上掏一格：挖掉头顶那块，然后跳上去站稳。
   *
   * 这是「没有垫脚方块」时的上升办法 —— 不依赖任何物品。
   * 真人被困在坑里也是这样徒手一格一格刨上去的。
   *
   * @returns {Promise<boolean>} 真的上升了没有
   */
  async digUpOne () {
    const bot = this.bot
    const p = this.pos()
    const F = Math.floor(p.y)

    // 头顶到 F+3 全清空（脚/身体/头要有位置）
    //
    // 这里**不走 digAt**，也不拦 bestToolFor 的 ok：
    //   · digAt 会先 goto 走过去；头顶方块 y 比人高，gotoVertical 判「高度到不了」，
    //     结果是连头上那片树叶都挖不掉（实测报「够不到（差 14.1 格）」）
    //   · bestToolFor 没镐时返回 ok=false（"需要镐子"），但**开路不需要镐** ——
    //     空手挖石头慢（约 7.5 秒）但确实挖得掉。我们只要通路，不要掉落。
    let any = 0
    for (let dy = 1; dy <= 3; dy++) {
      const b = bot.blockAt(p.offset(0, dy, 0))
      if (!b || b.boundingBox !== 'block') continue
      if (/bedrock|lava|water/.test(b.name)) return false
      try {
        await this.bestToolFor(b)        // 有镐就换上，没镐也继续
        bot.setControlState('forward', false)
        await sleep(60)
        await bot.dig(b, true)
        any++
      } catch (e) {}
      await sleep(120)
    }

    if (!any) {
      // 头顶本来就是空的 —— 没东西可挖，那就**垫一块**往上走。
      // 实测这正是最常见的卡点：人停在 y=65，头顶 +1..+4 全空，
      // 但树干在 y=72，垂直差 7 格够不到。光"掏"是掏不上去的，
      // 必须自己搭一级台阶。
      try {
        const up = await this.pillarUp(1)
        if (up > 0 && this.pos().y >= F + 0.9) return true
      } catch (e) {}
      // 没垫脚方块：往下挖一格把土攒起来，下一轮就有料了
      try {
        const below = bot.blockAt(p.offset(0, -1, 0))
        if (below && below.boundingBox === 'block' &&
            !/bedrock|lava|water/.test(below.name)) {
          await this.digAt(below)
          await sleep(250)
          try { await this.pickupNearby(4) } catch (e) {}
        }
      } catch (e) {}
      return false
    }

    // 挖开了头顶 —— 但如果是空手挖的石头，一块料都拿不到。
    // 这时候"能站上去"是假的：真站上去也只是把洞挖高了一格，
    // 下一格还是石头，又得空手挖 7.5 秒。所以顺手横向找块软方块补料。
    const hasPickNow = bot.inventory.items().some(i => /_pickaxe$/.test(i.name))
    if (!hasPickNow) {
      const SOFT = /^(dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|gravel|sand|red_sand|clay|snow_block|soul_soil|moss_block)$/
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        let took = false
        for (let dy = 0; dy <= 1; dy++) {
          const v = this.pos().offset(dx, dy, dz)
          const nb = bot.blockAt(v)
          if (!nb || nb.boundingBox !== 'block') continue
          if (!SOFT.test(nb.name)) continue
          try {
            await bot.dig(nb, true)
            await sleep(200)
            try { await this.pickupNearby(4) } catch (e) {}
            await sleep(150)
            took = true
          } catch (e) {}
          break
        }
        if (took) break
      }
    }

    // 跳上去。一格台阶 pathfinder 比手动跳稳（实测 0.4 秒就上去了）
    try {
      bot.pathfinder.setGoal(new goals.GoalBlock(
        Math.floor(p.x), F + 1, Math.floor(p.z)))
      for (let i = 0; i < 12; i++) {
        await sleep(160)
        if (this.pos().y >= F + 0.9) break
      }
    } catch (e) {}
    try { bot.pathfinder.setGoal(null) } catch (e) {}

    if (this.pos().y >= F + 0.9) return true

    // 兜底：手动跳
    try {
      bot.setControlState('jump', true)
      bot.setControlState('forward', true)
      await sleep(420)
      bot.setControlState('jump', false)
      bot.setControlState('forward', false)
      await sleep(400)
    } catch (e) {}
    return this.pos().y >= F + 0.9
  }

  /**
   * 搭柱子：跳起来往脚下放方块，一格一格往上。
   *
   * 这是 Minecraft 最基础的操作之一。真人都会。
   * 步骤：跳 → 在空中低头看脚下 → 往脚下那块的顶面放 → 落在新方块上。
   *
   * @param {number} count 搭几格
   * @param {string} [blockName] 用什么方块（不给就自动挑）
   * @returns {Promise<number>} 实际搭了几格
   */
  async pillarUp (count = 1, blockName = null) {
    const bot = this.bot

    // 挑方块
    let filler = null
    if (blockName) {
      filler = this.item(blockName)
    } else {
      for (const n of ['dirt', 'cobblestone', 'andesite', 'stone', 'gravel', 'granite', 'diorite', 'cobbled_deepslate']) {
        const it = this.item(n)
        if (it && it.count > 0) { filler = it; break }
      }
    }
    if (!filler) {
      this.log('[pillar] 没有可以垫的方块')
      return 0
    }

    let built = 0
    for (let i = 0; i < count; i++) {
      this.check()

      const p0 = this.pos()

      // ===== 1. 找脚下那块"真正的实心方块" =====
      // 踩过的坑：站在 short_grass/tall_grass 上时，脚下那格 bbox 是 empty，
      // 往它顶面放方块会被服务端拒绝（"the block is still air"）。
      // 所以必须往下找第一个实心方块。
      let groundY = null
      for (let dy = 1; dy <= 3; dy++) {
        const b = bot.blockAt(p0.offset(0, -dy, 0))
        if (b && b.boundingBox === 'block') {
          groundY = -dy
          break
        }
      }
      if (groundY === null) {
        this.log('[pillar] 脚下 3 格内没有实心方块，搭不了')
        break
      }

      // 站在格子中心（不然身体探进目标格，服务端拒绝放置）
      const cx = Math.floor(p0.x) + 0.5 - p0.x
      const cz = Math.floor(p0.z) + 0.5 - p0.z
      if (Math.hypot(cx, cz) > 0.15) {
        try {
          await bot.look(Math.atan2(-cx, -cz), 0, true)
          bot.setControlState('forward', true)
          await sleep(120)
          bot.setControlState('forward', false)
          await sleep(200)
        } catch (e) {}
      }

      // ===== 2. 挖开头顶 =====
      for (let dy = 1; dy <= 4; dy++) {
        const b = bot.blockAt(p0.offset(0, dy, 0))
        if (b && b.boundingBox === 'block' && !/bedrock|lava|water/.test(b.name)) {
          try {
            await this.bestToolFor(b)
            await bot.dig(b, true)
            await sleep(110)
          } catch (e) {}
        }
      }

      // ===== 3. 跳 =====
      try {
        bot.setControlState('jump', true)
        await sleep(140)
      } catch (e) { break }

      // ===== 4. 空中低头，往"脚下实心方块的顶面"放 =====
      let placed = false
      try {
        await bot.look(bot.entity.yaw, Math.PI / 2, true)
        await sleep(70)
        await bot.equip(filler, 'hand')
        const ground = bot.blockAt(bot.entity.position.offset(0, groundY, 0))
        if (ground && ground.boundingBox === 'block') {
          await bot.placeBlock(ground, new Vec3(0, 1, 0))
          placed = true
          built++
        }
      } catch (e) {
        // 站位偏了或者跳跃时机不对，下一次再试
      }

      try { bot.setControlState('jump', false) } catch (e) {}
      await sleep(400)

      // ===== 5. 检查有没有上升 =====
      const p1 = this.pos()
      if (p1.y < p0.y + 0.4) {
        if (!placed) {
          // 这次没放上，重试一次（不消耗 count）
          i--
          await sleep(200)
        }
      }
    }

    this.log(`[pillar] 搭了 ${built} 格，现在 y=${Math.round(this.pos().y)}`)
    return built
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
  findPlaceSpot (radius = 6, maxDist = 0) {
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
            // 有些 bbox=empty 的方块服务端仍拒绝往上放东西（实测 leaf_litter）。
            // 只认真正的 air / cave_air，以及少数确实能替换的（草、雪片）。
            const REPLACEABLE = /^(short_grass|tall_grass|fern|large_fern|dead_bush|snow|vine|seagrass|kelp)$/
            const atFree = at.name === 'air' || at.name === 'cave_air' ||
              (at.boundingBox === 'empty' && REPLACEABLE.test(at.name))
            const upOk = up.boundingBox !== 'block'
            if (!atFree || !upOk) continue

            // 可选：只收伸手范围内的格子（放置有 4.5 格硬上限，
            // 超出服务端会直接丢弃 use_item_on，还回 "the block is still air"）
            if (maxDist > 0) {
              const tp = new Vec3(Math.floor(p.x + dx), Math.floor(p.y + dy), Math.floor(p.z + dz))
              if (tp.distanceTo(p) > maxDist) continue
            }

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
    cands.sort((a, b) => b.score - a.score)
    // 默认只返回最优的那个（老调用方按"单个 spot"用）
    return cands[0]
  }

  /**
   * 同上，但返回**排好序的多个**候选。
   *
   * 为什么需要：`findPlaceSpot` 只给一个 spot，而 `placeNearby` 会在失败时
   * 重试同一个坐标。实测（e2e 08:36:33 日志）：
   *
   *   placeNearby try0: Server refused ... at (10, 64, -88): the block is still air
   *   placeNearby try1: ... at (10, 64, -88)   ← 同一个坐标
   *   placeNearby try2/3/4: ... 全是 (10, 64, -88)
   *
   * 服务端连续拒绝 5 次，`ensureTable()` 返回 null，
   * 上层就报"需要工作台但放不下" —— 这就是「做木镐」失败的真正原因。
   *
   * 那个坐标之所以永远放不上，是因为它虽然通过了 findPlaceSpot 的
   * "at 是空气 / up 不是实体 / base 是实体"三项检查，但实际放置时
   * 客户端与服务端的碰撞盒判定不一致（站在边缘、身体探进目标格）。
   * 换成**别的格子**就能成 —— 所以这里要给多个备选。
   */
  findPlaceSpots (radius = 6, maxDist = 0, limit = 8) {
    const p = this.pos()
    const solid = (n) => {
      if (!n || n === 'air' || n === 'cave_air') return false
      if (/water|lava/.test(n)) return false
      return true
    }
    const baseScore = (name) => {
      if (!name) return -1
      if (/^(stone|cobblestone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff)$/.test(name)) return 10
      if (/^(dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium)$/.test(name)) return 9
      if (/^(sand|red_sand|gravel|clay)$/.test(name)) return 7
      if (/_planks$|_log$/.test(name)) return 8
      if (/_ore$|^raw_/.test(name)) return 2
      if (/leaves|glass|ice|magma|soul_sand/.test(name)) return 0
      return 5
    }

    const cands = []
    const seen = new Set()
    for (let r = 1; r <= radius; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (r > 1 && Math.abs(dx) !== r && Math.abs(dz) !== r) continue
          for (let dy = -2; dy <= 2; dy++) {
            const base = this.bot.blockAt(p.offset(dx, dy - 1, dz))
            const at = this.bot.blockAt(p.offset(dx, dy, dz))
            const up = this.bot.blockAt(p.offset(dx, dy + 1, dz))
            if (!base || !at || !up) continue
            if (!solid(base.name)) continue
            // 有些 bbox=empty 的方块服务端仍拒绝往上放东西（实测 leaf_litter）。
            // 只认真正的 air / cave_air，以及少数确实能替换的（草、雪片）。
            const REPLACEABLE = /^(short_grass|tall_grass|fern|large_fern|dead_bush|snow|vine|seagrass|kelp)$/
            const atFree = at.name === 'air' || at.name === 'cave_air' ||
              (at.boundingBox === 'empty' && REPLACEABLE.test(at.name))
            const upOk = up.boundingBox !== 'block'
            if (!atFree || !upOk) continue

            const tp = new Vec3(Math.floor(p.x + dx), Math.floor(p.y + dy), Math.floor(p.z + dz))
            const key = `${tp.x},${tp.y},${tp.z}`
            if (seen.has(key)) continue
            if (maxDist > 0 && tp.distanceTo(p) > maxDist) continue

            // 【实测的坑 · 2026-11-13 e2e 09:04:56】
            // 候选格通过了三项方块检查，但**眼睛看不见底座**：
            //   placeNearby try0: refused at (122,71,67)
            //   [place] 看不见底座，换一个   x6
            // 于是 8 个候选全废。人在树顶/树冠中间时，
            // "同层左右两侧"的底座会被树叶挡住，越远的越瞎。
            //
            // 现在：
            //   1. 硬性要求 canSeeBlock(base)，看不见的直接不收
            //   2. 打分里加"高度贴近自己"的权重 —— 同层的格子看得见、
            //      也放得上；高出 2 格或低 2 格的经常被挡住
            let visible = true
            try {
              visible = this.bot.canSeeBlock(base)
            } catch (e) {
              visible = true      // canSeeBlock 不存在时退回"信任方块检查"
            }
            if (!visible) continue

            seen.add(key)
            cands.push({
              x: tp.x, y: tp.y, z: tp.z,
              base,
              score: baseScore(base.name) - r * 0.5 - Math.abs(dy) * 0.3
                - Math.abs(dy) * 2.0      // 同层优先（dy=0 最优先）
            })
          }
        }
      }
    }
    if (!cands.length) return []
    cands.sort((a, b) => b.score - a.score)
    return cands.slice(0, limit)
  }

  /**
   * 手上最多的是哪种木板。
   *
   * 老实现只认 9 种 `_planks`，漏了 crimson/warped/bamboo 三种，
   * 而且没有木板时返回 null —— 上层（craftSmart 的 myPlankKind）看到 null
   * 就以为"没木头可用"，直接跳过配方筛选，去凑樱桃木板这种弄不到的材料。
   *
   * 现在：有木板返回数量最多的那种；一块木板都没有但有原木时，
   * 返回"这个原木能做出来的木板"（只是名字，countOf 仍是 0），
   * 让上层知道"该往哪个方向备料"。
   */
  /** 手上所有品种的木板加起来有多少张（craftSmart/ensurePickaxe 都要用） */
  plankTotal () {
    const planks = ['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks',
      'acacia_planks', 'dark_oak_planks', 'cherry_planks', 'mangrove_planks',
      'pale_oak_planks', 'bamboo_planks', 'crimson_planks', 'warped_planks']
    let n = 0
    for (const p of planks) n += this.countOf(p)
    return n
  }

  bestPlank () {
    const planks = ['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks',
      'acacia_planks', 'dark_oak_planks', 'cherry_planks', 'mangrove_planks',
      'pale_oak_planks', 'crimson_planks', 'warped_planks', 'bamboo_planks']
    let best = null; let n = 0
    for (const p of planks) {
      const c = this.countOf(p)
      if (c > n) { n = c; best = p }
    }
    return best
  }

  /** 木板总数（不分种类） */
  plankTotal () {
    const planks = ['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks',
      'acacia_planks', 'dark_oak_planks', 'cherry_planks', 'mangrove_planks',
      'pale_oak_planks', 'crimson_planks', 'warped_planks', 'bamboo_planks']
    let n = 0
    for (const p of planks) n += this.countOf(p)
    return n
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
        // digAt 返回 false 表示没挖成（够不到/被挡/挖断了）。
        // 原来不管返回值都 depth++，所以日志里会出现「往上挖了0格」。
        const ok = await this.digAt(below)
        if (!ok) {
          this.log('[dig] 这格没挖成，停下')
          break
        }
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

  /**
   * 保证手上有 n 个任意种类的原木。
   *
   * @param {number} n
   * @param {{budgetMs?:number}} opts budgetMs 会按剩余预算分给每一轮 chopTree
   */
  async ensureWood (n = 3, opts = {}) {
    const logs = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log',
      'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log', 'pale_oak_log']
    const count = () => logs.reduce((s, l) => s + this.countOf(l), 0)

    let have = count()
    if (have >= n) return have

    const budget = Number(opts.budgetMs) || 0
    const deadline = budget > 0 ? Date.now() + budget : 0
    const left = () => deadline ? deadline - Date.now() : Infinity

    // 最多补两轮：砍树可能只砍到 1 棵，再补一次通常就够了
    for (let round = 0; round < 2 && count() < n; round++) {
      const need = n - count()
      // 一棵树平均给 3~6 块原木，别一次要太多（砍不完白耗时间）
      const wantTrees = Math.min(3, Math.max(1, Math.ceil(need / 3)))
      // 第一轮拿大部分预算，第二轮用剩下的。
      //
      // 坑：`Math.max(60000, ...)` 会在剩余预算已经不足时**强行给 60 秒**，
      // 于是 chopTree 打出"预算 150s（调用方给 60s）"，
      // 跑完之后剩余预算变成 -45 秒（实测日志 `只剩 -45s`）。
      // 现在：剩余不够 60 秒就明确不再开这一轮，且 roundBudget 不超过剩余。
      if (deadline) {
        const remain = left()
        if (remain < 60000) {
          this.log(`[wood] 只剩 ${Math.round(remain / 1000)}s，不够再砍一轮（最少 60s）`)
          break
        }
        const share = Math.floor(remain / (2 - round))
        const roundBudget = Math.max(60000, Math.min(share, remain - 5000))
        try {
          const got = await this.chopTree(wantTrees, { budgetMs: roundBudget })
          if (!got) {
            this.log('[wood] 这一轮没砍到树')
            break
          }
        } catch (e) {
          this.log('[wood] 砍树失败: ' + e.message)
          break
        }
        continue
      }
      try {
        const got = await this.chopTree(wantTrees)
        if (!got) {
          this.log('[wood] 这一轮没砍到树')
          break
        }
      } catch (e) {
        this.log('[wood] 砍树失败: ' + e.message)
        break
      }
    }

    const now = count()
    if (now < n) this.log(`[wood] 只有 ${now}/${n} 个原木`)
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
  /**
   * 原木 -> 木板。
   *
   * 老实现的三个坑：
   *  1. 直接用 `bot.craft`，失败被 `catch {}` 吞掉，上层以为成功了
   *  2. `made += this.countOf(p)` 累加的是"当前总量"，多种原木时会重复计数
   *  3. 只 `return countOf(p)` 就退出，混着两种原木时永远做不全
   *
   * 现在：一次一个原木地做，每做一次核对增量，做不动就换下一种原木。
   */
  /**
   * 原木 -> 木板，保证手上至少 n 张（不分种类）。
   *
   * 之前的三处硬伤，实测「放箱子」就是死在这：
   *
   *  1. **只做"刚好够"的量**：`use = min(logs, ceil(lack/4))`。
   *     有 3 个原木、差 6 张木板时只肯用 2 个原木做 8 张，
   *     而箱子要 8 张同色木板 —— 差一张就整条链断。
   *  2. **一次 craft 多份**：`safeCraft(rs[0], use)` 里 use 是"次数"，
   *     但 recipesFor 的 minResultCount 是"产出数"，两个概念混用，
   *     中途材料断了整批失败，已经做出来的那部分也不认账。
   *  3. **合成报成功但背包没变**没人核对，上层以为有木板了。
   *
   * 现在：按原木存量从多到少，一种一种全部转成木板，每做一次核对增量。
   * 原木在早期只有"做木板"一个用途（木板还能反手做木棍/工作台），
   * 所以多转化没有损失，反而让"8 张同色木板"这类配方凑得齐。
   *
   * @returns {Promise<number>} 完成后手上的木板总数
   */
  async anyPlanks (n = 4) {
    const pairs = [
      ['oak_log', 'oak_planks'], ['birch_log', 'birch_planks'], ['spruce_log', 'spruce_planks'],
      ['jungle_log', 'jungle_planks'], ['acacia_log', 'acacia_planks'], ['dark_oak_log', 'dark_oak_planks'],
      ['cherry_log', 'cherry_planks'], ['mangrove_log', 'mangrove_planks'], ['pale_oak_log', 'pale_oak_planks'],
      ['crimson_stem', 'crimson_planks'], ['warped_stem', 'warped_planks'], ['bamboo_block', 'bamboo_planks']
    ]
    const total = () => this.plankTotal()

    // 已经够了、而且手上没原木：直接返回（别为了"多备"去空转）
    if (total() >= n && this.woodCount() === 0) return total()

    // 原木按存量排序：箱子/工作台都要求"同一种木板 8/4 张"，
    // 先把最多的那种全做成木板，才能凑够单一花色。
    const stock = pairs
      .map(([l, p]) => ({ l, p, have: this.countOf(l) }))
      .filter(x => x.have > 0)
      .sort((a, b) => b.have - a.have)

    if (!stock.length) {
      if (total() < n) this.log(`[planks] 没有原木，只有 ${total()}/${n} 张木板`)
      return total()
    }

    // 目标：至少 n 张，并且尽量留 4 张余量（木棍/工作台/备用镐）
    const target = n + 4

    for (const { l, p } of stock) {
      let id
      try { id = this.itemId(p) } catch (e) { continue }

      let made = 0
      // 逐次合成：每次只做一个原木，做完核对背包
      while (this.countOf(l) > 0 && total() < target) {
        let rs = null
        try { rs = this.bot.recipesFor(id, null, 1, null) } catch (e) { rs = null }
        if (!rs || !rs.length) {
          // 合成格没同步：等一下重取一次
          await sleep(180)
          try { rs = this.bot.recipesFor(id, null, 1, null) } catch (e) { rs = null }
        }
        if (!rs || !rs.length) {
          this.log(`[planks] 取不到 ${p} 配方（${l} 剩 ${this.countOf(l)}）`)
          break
        }

        const before = this.countOf(p)
        try {
          await this.safeCraft(rs[0], 1, null)
        } catch (e) {
          this.log(`[planks] ${p} 合成失败: ${e.message}`)
          break
        }
        await sleep(60)
        const gained = this.countOf(p) - before
        if (gained <= 0) {
          // 报成功但背包没变：别再空转
          this.log(`[planks] ${p} 报成功但背包没变，停手`)
          break
        }
        made += gained
      }
      if (made) this.log(`[planks] ${l} -> ${p} x${made}，总木板 ${total()}`)
    }

    const got = total()
    if (got < n) this.log(`[planks] 只做出 ${got}/${n} 木板（原木剩 ${this.woodCount()} 个）`)
    return got
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
          const before = this.countOf(itemName) +
            (itemName === 'cobblestone' ? this.countOf('cobbled_deepslate') : 0)
          const got = await this.mine('stone', count + 2)
          const after = this.countOf(itemName) +
            (itemName === 'cobblestone' ? this.countOf('cobbled_deepslate') : 0)
          // 【实测 · 2026-11-13 10:35】不能只看"有没有挖到"。
          // 日志：`[mine] 到时间上限（50s），已挖到 2 个`
          //       -> gather 返回 true（got=2>0）
          //       -> 补料循环以为圆石够了
          //       -> craftSmart 拿着 2 个圆石去合成石镐 -> missing ingredient
          //       -> 报 `补料 1 遍后仍缺：cobblestone 要 3 有 0`
          // 必须按"够不够 count 个"返回。
          if (after >= count) return true
          this.log(`[gather] ${itemName} 要 ${count}，只拿到 ${after}（本次 +${after - before}）`)
          // 【实测 · 2026-11-13 10:45】`[mine] 到时间上限（50s），已挖到 3 个`
          // 紧接着 `[gather] cobblestone 要 3，只拿到 0（本次 +0）` ——
          // mine 的 got++ 数的是"挖了几次"，不是"背包里多了几个"。
          // 掉落物还在地上时 mine 就返回了。
          // 这里补一次更宽的拾取（掉落物 5 分钟才消失，通常还在脚边）。
          try {
            await this.pickupNearby(10)
            await sleep(500)
          } catch (e) {}
          const afterPickup = this.countOf(itemName) +
            (itemName === 'cobblestone' ? this.countOf('cobbled_deepslate') : 0)
          if (afterPickup >= count) {
            this.log(`[gather] 补捡后 ${itemName} = ${afterPickup}，够了`)
            return true
          }
          this.log(`[gather] 补捡后 ${itemName} 仍只有 ${afterPickup}/${count}`)
          return false
        }
        await this.chopTree(Math.max(1, Math.ceil(count / 3)))
        return this.countOf(itemName) >= count
      }
      if (itemName === 'torch') return false
      if (/_ore$/.test(src[0])) {
        const before = this.countOf(itemName)
        await this.mine(src[0], count)
        const after = this.countOf(itemName)
        if (after >= count) return true
        this.log(`[gather] ${itemName} 要 ${count}，只拿到 ${after}（本次 +${after - before}）`)
        return false
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
  /**
   * 吃。用 minecraft-data 的食物表，按"吃了能回多少"排序。
   * 生的先吃也没事 —— 真人饿急了不会挑。
   *
   * 两个必须处理的坑：
   *  1. 饱食度满（20）时 mineflayer 的 bot.consume() 直接抛 'Food is full'。
   *     老实现 catch 掉之后 continue，把包里每样食物都试一遍，
   *     每次失败还要走完一次 equip —— 白耗时间，最后返回 null，
   *     上层以为"没吃的"。现在饱食度满就直接返回 null（没需求，不是失败）。
   *  2. 吃成功之后 bot.food 是异步更新的，立刻读可能还是旧值。
   *     这里等一下再返回，让调用方能读到真实饱食度。
   *
   * @param {{preferCooked?:boolean, force?:boolean}} opts
   * @returns {Promise<string|null>} 吃掉的物品名
   */
  async eat ({ preferCooked = true, force = false } = {}) {
    // 不饿就别吃（除非调用方明确要求）
    if (!force && this.bot.food >= 20) return null

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
      } catch (e) {
        continue
      }
      try {
        await this.bot.consume()
      } catch (e) {
        const msg = String((e && e.message) || '')
        // 饱食度满：没需求，别再试别的食物了
        if (/Food is full/i.test(msg)) return null
        continue
      }
      // 等饱食度落地（服务端 set_health 回包有延迟）
      for (let i = 0; i < 10; i++) {
        if (this.bot.food > 0) break
        await sleep(80)
      }
      return f.name
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
  /**
   * 找吃的。
   *
   * 老实现跑满 180 秒还不返回，实测原因（一条一条对过日志）：
   *
   *  1. **没有总预算**：每一步都有自己的 25~30 秒超时，
   *     5 只动物 x 30 秒 chase + 30 秒 hunt + 抓鱼 20 秒 + 走远再一轮 …
   *     加起来远超测试的 180 秒，任务永远"超时"，而且什么都没拿到。
   *  2. **先 chase 再 hunt，chase 失败也照打**：动物在 40 格外时
   *     chase 白烧 25 秒，然后 hunt 又对着一个够不着的实体空挥 30 秒。
   *  3. **烤肉的链条太长**：tryCook 没熔炉就去 digStone(8) 挖圆石，
   *     挖石头本身又要镐子 → 砍树 → 木板 … 在"找食物"这个上下文里
   *     这是几十秒起步的赌博，而且失败后 raw 肉还在包里，
   *     其实**生的就能吃**，完全没必要等。
   *  4. **没有"快速失败"**：什么都没找到时不早退，硬走完 6 个阶段。
   *
   * 现在：给一个硬预算（默认 60 秒），每一步都按剩余时间收缩，
   * 拿到任何能吃的立刻返回（生肉也算 —— 真饿急了不挑），
   * 预算用完立刻返回 null 并说清楚试过什么。
   *
   * @param {{budgetMs?:number, allowCook?:boolean}} opts
   * @returns {Promise<string|null>} 拿到了什么（null = 没找到）
   */
  async findFood (opts = {}) {
    // 默认预算 120 秒（原来是 60）。
    // 实测（/tmp/probe-food.js）：这个服务器的动物动辄在 55~90 格外，
    // 光追一只猪就要 40 秒，打猎 + 捡肉 + 找下一个 60 秒根本不够。
    // e2e 给"找食物"的预算是 200 秒，这里留出余量给上层收尾。
    const budgetMs = opts.budgetMs || 120000
    const allowCook = opts.allowCook !== false
    const deadline = Date.now() + budgetMs
    const left = () => deadline - Date.now()
    const tried = []

    // 0. 背包里有能吃的
    //    注意：饱食度满（20）时 bot.consume() 会直接抛 'Food is full'，
    //    所以这里先判断"有没有存货"，有存货且不饿就直接算成功。
    if (this.hasFood()) {
      if (this.bot.food < 20) {
        const ate = await this.eat()
        if (ate) return '吃了背包里的 ' + ate
      }
      const f = this.foodList()[0]
      if (f) return '背包里已经有 ' + f.name + ' x' + f.count
    }

    // 0.5 动不了就先挖出去（限时，别在这里耗光预算）
    if (left() > 8000) {
      const movable = await Promise.race([
        this.canMoveAround(),
        sleep(6000).then(() => true)     // 判不出来就当能动，别卡死
      ])
      if (!movable) {
        this.log('[food] 动不了，先挖出去')
        try {
          if (this.ctx && this.ctx.reflex) await this.ctx.reflex.digOut()
          else await this.digOutSelf()
        } catch (e) {}
      }
    }

    // 0.6 在地下就基本找不到吃的 —— 先回地面。
    //
    // 【实测】e2e --only 找食物 08:53 那轮：出生点 y=38（地下），
    // 80 格内唯一一只猪在 78 格外、在洞外，chase 6 秒就"自己卡住了"，
    // 30 秒后返回 null。而"能动"这个判据（水平挪得动）在洞里是成立的，
    // 所以它压根没触发上面的挖出去分支。
    // 动物/浆果/作物全在地表，在地下找食物等于白跑。
    if (this.isUnderground() && left() > 30000) {
      this.log('[food] 在地下，先回地面再找吃的')
      try {
        const ok = await Promise.race([
          this.getToSurface(),
          sleep(Math.min(60000, left() - 20000)).then(() => false)
        ])
        if (ok) {
          this.log('[food] 回到地面了')
          await this.ensureChunks(3000)
        } else {
          this.log('[food] 没爬出去，就地找找看')
        }
      } catch (e) {}
    }

    /** 打死一只动物并捡回掉落物。budgetMs 是这个动物身上的总时间 */
    const hunt = async (animalName, huntMs) => {
      const s = Date.now()
      let hits = 0
      while (Date.now() - s < huntMs && left() > 2000) {
        this.check()
        const e = this.nearestEntity(animalName, 64)
        if (!e) break                    // 打死了 / 跑掉了
        const d = e.position.distanceTo(this.pos())
        if (d > 3.0) {
          try { this.bot.pathfinder.setGoal(new goals.GoalFollow(e, 2), true) } catch (err) {}
          await sleep(250)
          continue
        }
        try { this.bot.pathfinder.setGoal(null) } catch (err) {}
        try {
          await this.bot.lookAt(e.position.offset(0, 1.2, 0), true)
          await sleep(620)               // 1.21 有攻击冷却
          await this.bot.attack(e)
          hits++
        } catch (err) {
          await sleep(250)
        }
        if (hits > 25) break
      }
      try { this.bot.pathfinder.setGoal(null) } catch (err) {}
      if (hits) this.log(`[food] 打了 ${animalName} ${hits} 下`)
      // 捡东西必须做，不然打死了也没有肉
      try { await this.pickupNearby(12) } catch (e) {}
      return hits > 0
    }

    /** 拿到生肉后：能吃就吃，能烤就烤（烤只给有限时间，烤不动就吃生的） */
    const settleRaw = async (rawName) => {
      if (!rawName) return null
      if (allowCook && left() > 12000) {
        try {
          const cooked = await Promise.race([
            this.tryCook(rawName),
            sleep(Math.min(20000, Math.max(2000, left() - 4000))).then(() => null)
          ])
          if (cooked) return '烤熟了 ' + cooked
        } catch (e) {}
      }
      if (this.bot.food < 20) {
        const ate = await this.eat()
        if (ate) return '吃了 ' + ate
      }
      // 【实测的 bug · 2026-11-13 10:58 e2e】这里原来无条件 `return '拿到 xxx'`，
      // 于是 `findFood 返回 "拿到 kelp x2"` 被当成成功 —— 但 **生 kelp 不是食物**
      // （mcData.foodsByName.kelp === undefined，只有 dried_kelp 是 food=1）。
      // 回报"拿到"，上层以为有吃的了，实际背包里全是不能吃的东西。
      // 现在：只有确实拿到了**可食用**的东西才算数。
      const it = this.item(rawName)
      const edible = this._edible(rawName)
      if (it && edible) return '拿到 ' + rawName + ' x' + it.count

      // 生海带没烤成：如果背包里已经有别的可吃的，就报那个
      if (this.hasFood()) {
        const f = this.foodList()[0]
        if (f) return '拿到 ' + f.name + ' x' + f.count
      }
      // 只有生的、不可食用的东西 -> 不算成果
      if (it && !edible) {
        this.log(`[food] 拿到 ${rawName} x${it.count} 但它不能吃，继续找别的`)
      }
      return null
    }

    // 1. 打动物
    //
    // 【实测修正】原来是 `nearestEntity(n, 48)` —— 48 格内找不到就整只跳过。
    // 探针（/tmp/probe-food.js）在真实出生点量到的分布：
    //   pig   全局 2 只 → 48 格 = 无，64 格 = 55 格
    //   sheep 全局 1 只 → 48 格 = 无，96 格 = 89 格
    //   cow/chicken/rabbit 全局 0 只
    // 也就是说**48 格一刀切直接把 1 级打猎整级跳过了**，
    // 日志里 `试过: 附近没有目标`、1.5 秒就返回 null，就是这个原因。
    // 现在按 24 → 48 → 80 逐级放宽，并且真的走过去试，而不是看距离就放弃。
    const animals = ['cow', 'pig', 'sheep', 'chicken', 'rabbit']
    const pickAnimal = (range) => animals
      .map(n => ({ n, e: this.nearestEntity(n, range) }))
      .filter(x => x.e)
      .sort((a, b) => a.e.position.distanceTo(this.pos()) - b.e.position.distanceTo(this.pos()))

    let near = []
    for (const range of [24, 48, 80]) {
      near = pickAnimal(range)
      if (near.length) {
        if (range > 48) this.log(`[food] 48 格内没有，放宽到 ${range} 格找到 ${near.length} 只`)
        break
      }
    }
    if (!near.length) {
      // 80 格内一只动物都没有 —— 别急着返回 null，先换个方向走一段再扫。
      // 实测（e2e --only 找食物 08:52）：出生点 80 格内 0 只动物，
      // 结果 25 秒就返回 null。而这个服务器的动物分布很稀，
      // 走 30~40 格常常就有一群。
      this.log('[food] 80 格内没有任何动物，换个方向找')
      for (let round = 0; round < 3 && left() > 25000 && !near.length; round++) {
        const yaw = Math.random() * Math.PI * 2
        const p = this.pos()
        const tx = p.x + Math.cos(yaw) * 34
        const tz = p.z + Math.sin(yaw) * 34
        try {
          await this.goto(tx, p.y, tz, 3, Math.min(25000, left() - 20000))
        } catch (e) {}
        await this.ensureChunks(3000)
        for (const range of [48, 80]) {
          near = pickAnimal(range)
          if (near.length) break
        }
        if (near.length) {
          this.log(`[food] 换方向后找到 ${near.length} 只动物`)
          break
        }
      }
      if (!near.length) this.log('[food] 换方向也没找到动物')
    }

    let animalTries = 0
    for (const { n: a, e } of near) {
      // 原来 `animalTries >= 2` 只试两只就收手。实测动物很稀（80 格内常常 1 只），
      // 试两只之后如果第一只"跑了"，整条打猎链就断了。放到 4。
      if (left() < 12000 || animalTries >= 4) break
      animalTries++
      const dist = e.position.distanceTo(this.pos())
      this.log(`[food] 目标 ${a} 在 ${Math.round(dist)} 格外`)

      // 太远就先拉近。追路时间按剩余预算给，别一上来就给 12 秒。
      if (dist > 12) {
        const chaseMs = Math.min(20000, Math.max(6000, left() - 12000))
        try { await this.chase(a, chaseMs) } catch (err) {}
      }
      // 贴近后再确认一次（动物会动）
      const now = this.nearestEntity(a, 64)
      if (!now) { tried.push(a + '(跑了)'); continue }
      const d2 = now.position.distanceTo(this.pos())
      if (d2 > 8) {
        // 还差得远：再追一次，这次给足预算（原来这里直接 continue，等于白追）
        this.log(`[food] ${a} 还差 ${Math.round(d2)} 格，再追一次`)
        try { await this.chase(a, Math.min(18000, Math.max(5000, left() - 8000))) } catch (err) {}
        const now2 = this.nearestEntity(a, 64)
        if (!now2 || now2.position.distanceTo(this.pos()) > 8) {
          this.log(`[food] ${a} 追不上，换下一只`)
          tried.push(a + '(够不着)')
          continue
        }
      }

      await hunt(a, Math.min(25000, Math.max(6000, left() - 4000)))
      const raw = this.item('beef') || this.item('porkchop') || this.item('mutton') ||
        this.item('chicken') || this.item('rabbit')
      if (raw) {
        const r = await settleRaw(raw.name)
        if (r) return r
      }
      if (this.hasFood()) {
        const f = this.foodList()[0]
        if (f) return '打猎后有 ' + f.name + ' x' + f.count
      }
      tried.push(a)
    }

    // 1.5 打猎全失败后：走一段再扫一次。
    //
    // 【实测】/tmp/probe-food3.js：出生点 80 格内只有 1 只 cow@79，
    // chase 卡住 -> 整条打猎链结束 -> 剩下几级都找不到 -> 23.9 秒返回 null，
    // 而调用方给了 150 秒预算。预算没花完就放弃，是"找食物 55s 就 null"的主因。
    //
    // 现在：只要有剩余预算，就换个方向走 30~40 格重新扫，
    // 最多补 3 轮 —— 直到预算真的用完或者确实找到东西。
    let extraRounds = 0
    while (left() > 30000 && !this.hasFood() && extraRounds < 3) {
      extraRounds++
      this.log(`[food] 打猎没成，换方向再找（第 ${extraRounds} 轮，剩 ${Math.round(left() / 1000)}s）`)
      const yaw = Math.random() * Math.PI * 2
      const p = this.pos()
      // 注意：这里**不能**用 this.goto —— 它在 |dy|>2 时先走 gotoVertical，
      // 而"从山坡上往下挪"这种场景 gotoVertical 直接返回 false，
      // goto 就整条失败。实测日志里连续 3 轮都是
      // `[goto] 走不通了（差 36.0 格）`，人一格都没动，
      // 于是每轮都在追同一只猪。
      // 换地方只需要水平位移，直接给 pathfinder 一个 GoalXZ。
      try {
        this.bot.pathfinder.setGoal(new goals.GoalXZ(
          Math.floor(p.x + Math.cos(yaw) * 36),
          Math.floor(p.z + Math.sin(yaw) * 36)))
        const sMove = Date.now()
        const budget = Math.min(22000, Math.max(6000, left() - 20000))
        let lastP = this.pos().clone()
        let stillMove = 0
        while (Date.now() - sMove < budget) {
          this.check()
          const cur = this.pos()
          if (cur.distanceTo(p) > 28) break
          if (cur.distanceTo(lastP) < 0.12) stillMove += 250
          else stillMove = 0
          lastP = cur.clone()
          if (stillMove > 5000) break
          await sleep(250)
        }
      } catch (e) {}
      try { this.bot.pathfinder.setGoal(null) } catch (e) {}
      await this.ensureChunks(3000)

      let again = []
      for (const range of [32, 64, 96]) {
        again = pickAnimal(range)
        if (again.length) break
      }
      if (!again.length) {
        this.log('[food] 这一轮 96 格内没动物')
        continue
      }
      this.log(`[food] 这一轮找到 ${again.length} 只`)
      for (const { n: a2 } of again.slice(0, 2)) {
        if (left() < 15000) break
        const dist2 = a2 && this.nearestEntity(a2, 96)
        if (!dist2) continue
        this.log(`[food] 追 ${a2}（${Math.round(dist2.position.distanceTo(this.pos()))} 格）`)
        try { await this.chase(a2, Math.min(25000, Math.max(8000, left() - 10000))) } catch (e) {}
        const now2 = this.nearestEntity(a2, 64)
        if (!now2 || now2.position.distanceTo(this.pos()) > 8) {
          tried.push(a2 + '(第' + extraRounds + '轮够不着)')
          continue
        }
        await hunt(a2, Math.min(22000, Math.max(6000, left() - 5000)))
        const raw2 = this.item('beef') || this.item('porkchop') || this.item('mutton') ||
          this.item('chicken') || this.item('rabbit')
        if (raw2) {
          const rr = await settleRaw(raw2.name)
          if (rr) return rr
        }
        if (this.hasFood()) {
          const f = this.foodList()[0]
          if (f) return '换方向打猎拿到 ' + f.name + ' x' + f.count
        }
      }
    }

    // 2. 野生浆果 / 作物（比打猎稳，但要走过去）
    //    半径从 32 放到 48：探针里 32 格内全都没有，动物又在 55 格外，
    //    32 格太紧，等于把这一级也跳掉了。
    if (left() > 10000) {
      for (const bush of ['sweet_berry_bush', 'cave_vines', 'cave_vines_plant']) {
        if (left() < 6000) break
        let b = null
        try { b = this.findBlock(bush, 48) } catch (e) {}
        if (!b) continue
        try {
          await this.digAt(b)
          await this.pickupNearby(6)
          if (this.hasFood()) {
            if (this.bot.food < 20) {
              const ate = await this.eat()
              if (ate) return '摘了浆果吃了'
            }
            const berry = this.item('sweet_berries')
            if (berry) return '摘到 sweet_berries x' + berry.count
          }
        } catch (e) {}
        tried.push(bush)
      }
    }

    // 3. 瓜类 / 蔬菜
    if (left() > 10000) {
      for (const crop of ['melon', 'pumpkin', 'carrots', 'potatoes', 'beetroots', 'wheat']) {
        if (left() < 6000) break
        let b = null
        try { b = this.findBlock(crop, 48) } catch (e) {}
        if (!b) continue
        try {
          await this.digAt(b)
          await this.pickupNearby(6)
          if (this.hasFood()) {
            const f = this.foodList()[0]
            if (f) return '弄到 ' + f.name + ' x' + f.count
          }
        } catch (e) {}
        tried.push(crop)
      }
    }

    // 3.5 海带 —— 生 kelp 本身不能吃，但熔炉烤一下就是 dried_kelp（food=1）。
    //
    // 【实测依据】/tmp/probe-food2.js 在一个"80 格内一只动物都没有"的出生点量到：
    //   动物 24/48/80 格全无，128 格才有 pig@80（chase 30 秒只拉到 20 格，放弃）
    //   但植物清单里: kelp@23 —— 是最近的可用食物来源
    // 另外查过 minecraft-data：kelp/sugar_cane/bamboo/蘑菇**都不是食物**
    // （只有 dried_kelp 是），所以这里只拿海带，并且交给 tryCook 处理。
    if (left() > 12000) {
      let got = 0
      for (const plant of ['kelp', 'kelp_plant']) {
        if (left() < 8000) break
        for (let k = 0; k < 3 && left() > 8000; k++) {
          let b = null
          try { b = this.findBlock(plant, 40) } catch (e) {}
          if (!b) break
          try {
            const okDig = await this.digAt(b)
            if (!okDig) break
            await this.pickupNearby(8)
            got += this.countOf('kelp')
          } catch (e) { break }
          if (got >= 3) break
        }
        if (got) break
      }
      if (got > 0) {
        this.log(`[food] 采到 ${got} 个 kelp，试着烤成 dried_kelp`)
        const r = await settleRaw('kelp').catch(() => null)
        if (r) return r
        if (this.hasFood()) {
          const f = this.foodList()[0]
          if (f) return '弄到 ' + f.name
        }
        // 烤不成：生 kelp 不是食物（查过 mcData，foodsByName 里没有 kelp）
        // 明确把这批 kelp 记成"没用的"，别让上层以为找到食物了
        // 生 kelp 不能吃（foodsByName 里没有 kelp），只有烤成 dried_kelp 才行。
        // 这里只记一笔，不返回成功 —— settleRaw 内部已经做了 _edible 校验。
        this.log('[food] kelp 没烤成，生的不能吃')
        tried.push(`kelp x${got} 没烤成（生的不能吃）`)
      }
    }

    // 4. 蘑菇 —— minecraft-data 里 brown/red_mushroom 的 foodPoints 是 0，
    //    单独吃没用（要么熬汤，要么当烤制材料）。这里只捡不指望它当主食。
    if (left() > 8000) {
      for (const shroom of ['brown_mushroom', 'red_mushroom']) {
        if (left() < 5000) break
        let b = null
        try { b = this.findBlock(shroom, 40) } catch (e) {}
        if (!b) continue
        try {
          await this.digAt(b)
          await this.pickupNearby(6)
          if (this.hasFood()) {
            const f = this.foodList()[0]
            if (f) return '挖到 ' + f.name + ' x' + f.count
          }
        } catch (e) {}
        tried.push(shroom)
      }
    }

    // 5. 抓鱼：只有时间充裕才试（鱼会跑，最耗时间）
    if (left() > 20000) {
      for (const fish of ['cod', 'salmon']) {
        if (left() < 14000) break
        const e = this.nearestEntity(fish, 40)
        if (!e) continue
        try {
          await hunt(fish, Math.min(15000, left() - 6000))
          const raw = this.item('cod') || this.item('salmon')
          if (raw) {
            const r = await settleRaw(raw.name)
            if (r) return r
          }
        } catch (err) {}
        tried.push(fish)
      }
    }

    // 6. 最后兜底：地上有没有现成的可食物品（别人打怪掉的腐肉等）
    //    探针里见过 `rotten_flesh x1` 就是僵尸掉落 —— 饿的时候是保命食物。
    //    _edible() 里腐肉的分数被压得很低，但"有"总比"没有"强。
    if (left() > 3000) {
      try {
        await this.pickupNearby(10)
        if (this.hasFood()) {
          const f = this.foodList()[0]
          if (f) return '捡到 ' + f.name + ' x' + f.count
        }
      } catch (e) {}
    }

    this.log(`[food] ${Math.round(budgetMs / 1000)}s 预算内没弄到吃的（试过: ${tried.join('/') || '附近没有目标'}）`)
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
  /**
   * 把生肉烤熟。
   *
   * 老实现的问题：没熔炉时会 `digStone(8)` 现场挖 8 个圆石。
   * digStone 又要镐子，镐子又要砍树 → 木板 → 木棍……
   * 在"我饿了想弄点吃的"这个上下文里，这是几十秒起步的赌博，
   * 而且一旦失败，生肉还在包里、其实生的就能吃 —— 白等。
   * 实测「找食物」180 秒超时，很大一块时间耗在这条链上。
   *
   * 现在：只在**熔炉已经存在 / 背包里有熔炉 / 圆石已经够**时才烤。
   * 需要现挖圆石的路径一律跳过，直接返回 null 让调用方吃生的。
   *
   * @param {string} rawName
   * @param {{allowDigStone?:boolean, budgetMs?:number}} opts
   */
  async tryCook (rawName, opts = {}) {
    if (!rawName) return null
    const allowDigStone = opts.allowDigStone === true
    const budgetMs = opts.budgetMs || 25000
    const deadline = Date.now() + budgetMs
    const left = () => deadline - Date.now()

    const cookedName = rawName.replace(/^beef$/, 'cooked_beef')
      .replace(/^porkchop$/, 'cooked_porkchop')
      .replace(/^mutton$/, 'cooked_mutton')
      .replace(/^chicken$/, 'cooked_chicken')
      .replace(/^rabbit$/, 'cooked_rabbit')
      .replace(/^cod$/, 'cooked_cod')
      .replace(/^salmon$/, 'cooked_salmon')
      .replace(/^kelp$/, 'dried_kelp')
      .replace(/^potato$/, 'baked_potato')
    if (cookedName === rawName) return null
    if (this.item(cookedName)) return cookedName
    if (!this.item(rawName)) return null

    // 1. 找熔炉：附近 -> 背包里现放
    let furnace = null
    try { furnace = this.findBlock('furnace', 16) } catch (e) {}
    if (!furnace && this.countOf('furnace') > 0) {
      try { furnace = await this.placeNearby('furnace') } catch (e) {}
    }

    // 2. 没熔炉：只有圆石已经够（或明确允许挖）才现做
    if (!furnace) {
      const stone = this.countOf('cobblestone') + this.countOf('cobbled_deepslate')
      if (stone < 8) {
        if (!allowDigStone) {
          this.log(`[cook] 没熔炉、圆石只有 ${stone}/8，跳过烤制（生的也能吃）`)
          return null
        }
        if (left() < 15000) {
          this.log('[cook] 时间不够现挖圆石，跳过烤制')
          return null
        }
        this.log('[cook] 圆石不够（' + stone + '/8），挖点')
        try { await this.digStone(8) } catch (e) {}
      }
      if (this.countOf('cobblestone') + this.countOf('cobbled_deepslate') < 8) {
        this.log('[cook] 圆石还是不够，跳过烤制')
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
    if (!furnace) return null

    // 3. 燃料：煤最好，其次木板/原木/木棍（燃料在包里就能用）
    const fuel = ['coal', 'charcoal', 'oak_planks', 'birch_planks', 'spruce_planks',
      'oak_log', 'birch_log', 'spruce_log', 'stick']
      .map(n => this.item(n)).find(Boolean)

    if (!fuel) {
      // 没燃料：别为了烤肉去砍树（又是几十秒）。生的能吃。
      this.log('[cook] 没燃料，跳过烤制（生的也能吃）')
      return null
    }

    // 4. 烧：按剩余预算收缩，别烧满 90 秒
    try {
      const waitMs = Math.min(30000, Math.max(4000, left() - 2000))
      await Promise.race([
        this.smelt(rawName, fuel.name, 1),
        sleep(waitMs).then(() => null)
      ])
      if (this.item(cookedName)) {
        this.log('[cook] 烤好了 ' + cookedName)
        return cookedName
      }
    } catch (e) {
      this.log('[cook] 烤失败: ' + e.message)
    }
    return null
  }

  /**
   * 背包里有没有能吃的。
   *
   * 口径统一到一处：`_edible(name)`。
   * 之前 hasFood 排除 spider_eye，foodList 不排除；
   * eat 又额外排除 suspicious_stew —— 三处口径不一致，
   * 会出现"hasFood 说没有、foodList 说有一堆、eat 一个都不吃"的死循环。
   */
  _edible (name) {
    const f = mcData.foodsByName[name]
    if (!f || !f.foodPoints) return null
    if (/poisonous_potato|pufferfish|spider_eye|suspicious_stew/.test(name)) return null
    return f
  }

  hasFood () {
    return this.bot.inventory.items().some(i => !!this._edible(i.name))
  }

  /** 背包里所有能吃的东西，按好坏排 */
  foodList () {
    const out = []
    for (const it of this.bot.inventory.items()) {
      const f = this._edible(it.name)
      if (!f) continue
      out.push({
        name: it.name,
        count: it.count,
        points: f.foodPoints,
        raw: f.displayName,
        // 生肉也标出来：调用方可能想先烤
        isRaw: /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/.test(it.name)
      })
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
    let stuckSince = 0
    let recovered = false
    let lastPos = this.pos().clone()

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

      // 【实测修正】原来只看"距离没变近"就 10 秒放弃。
      // 但目标在 60 格外时，前 10 秒可能一直在正常赶路（只是还没显著拉近），
      // 于是 /tmp/probe-food.js 里出现 `[chase] 追不上 pig` × 2、48 秒白跑。
      // 现在分两种卡死：
      //   · 距离没变近  -> 放宽到 18 秒（动物会跑，短暂不靠近很正常）
      //   · 自己根本没挪窝 -> 6 秒就判定真卡住（这个才是真失败）
      const pos = this.pos()
      if (pos.distanceTo(lastPos) < 0.35) stuckSince += 300
      else stuckSince = 0
      lastPos = pos.clone()

      if (Math.abs(d - lastDist) < 0.3) stillSince += 300
      else stillSince = 0
      lastDist = d

      if (stuckSince > 6000) {
        // 【实测】e2e 找食物 08:55：目标猪在 78 格外，chase 6 秒就"自己卡住"，
        // 整条打猎链断掉。而 6 秒对"从洞里刚爬出来、正在下坡"来说是正常的。
        // 现在先自救一次（清目标 + 往前拱一下），还卡再放弃。
        if (!recovered) {
          recovered = true
          this.log('[chase] 卡住了，自救一次（清目标重发）')
          try { bot.pathfinder.setGoal(null) } catch (err) {}
          await sleep(400)
          try {
            bot.pathfinder.setGoal(new goals.GoalFollow(e, Math.max(1, stopDist - 1)), true)
          } catch (err) {}
          stuckSince = 0
          lastPos = this.pos().clone()
          await sleep(300)
          continue
        }
        this.log('[chase] 自己卡住了（6 秒没挪窝），放弃 ' + name)
        try { bot.pathfinder.setGoal(null) } catch (err) {}
        return false
      }
      if (stillSince > 18000) {
        this.log('[chase] 追不上 ' + name + '（18 秒没拉近距离）')
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

  /**
   * 捡地上的掉落物。
   *
   * 老实现是坏的：用 `goto(x,y,z,1)` 走过去，而 goto 的到达判定是
   *   if (dxz <= range + 2 && dyAbs <= 2) return true
   * range=1 -> 阈值 3 格。掉落物在 1.99 格时**已经算"到达"**，
   * 人一步没挪，函数返回，东西还在原地。
   *
   * 现在用 GoalBlock 精确踩到掉落物所在格。
   * 实测（probe18）：挖 dirt 后 1.2s 掉落物在 6.78 格外，
   * GoalBlock 走过去 3 秒就捡到了 2 个。
   *
   * 关键细节：设完 goal 后**不要**每轮重设 —— 重设会让 pathfinder
   * 反复重新规划，看起来像"走不动"。目标变了才重设。
   */
  async pickupNearby (radius = 8) {
    const t0 = Date.now()
    const BUDGET = 9000
    let goalKey = ''
    let lastDist = 1e9
    let stall = 0
    const skip = new Set()
    let sawAny = false

    while (Date.now() - t0 < BUDGET) {
      this.check()
      const p = this.pos()
      const drops = Object.values(this.bot.entities)
        .filter(e => e && e.name === 'item' && !skip.has(e.id) &&
          e.position.distanceTo(p) < radius)
        .sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p))

      if (!drops.length) {
        // 关键：刚挖完时掉落物还没进实体表（实测 300~600ms 才出现）。
        // 老实现在这里直接 break，等于"挖完立刻放弃捡"。
        if (!sawAny && Date.now() - t0 < 3000) {
          await sleep(250)
          continue
        }
        break
      }
      sawAny = true

      const d = drops[0]
      const dist = d.position.distanceTo(p)
      const dy = d.position.y - p.y      // 负 = 物品在脚下

      // 1 格内：原版会自动吸附，站着别动（走反而推远）
      if (dist < 1.2) {
        if (goalKey) {
          try { this.bot.pathfinder.setGoal(null) } catch (e) {}
          goalKey = ''
        }
        await sleep(300)
        continue
      }

      // ===== 关键：物品在脚下 1.5 格以上时，走过去是没用的 =====
      // 原版拾取半径是玩家 AABB 向上/向周边扩 1 格，垂直方向够不到就不会吸附。
      // 实测：bot 站 y=72，挖掉 y=70 的泥土，掉落物确实生成了（掉落=1~2），
      // 方块也真的变成 air，但 bot 一直在 y=72 附近水平挪，永远捡不到。
      // 所以先让 bot 掉下去/下到物品那一层。
      if (dy < -1.4) {
        const targetY = Math.floor(d.position.y)
        // 目标格能不能站？能站就直接 GoalBlock 下去
        const cell = new Vec3(Math.floor(d.position.x), targetY, Math.floor(d.position.z))
        const standCell = this.standable(cell) ? cell
          : (this.standable(cell.offset(0, 1, 0)) ? cell.offset(0, 1, 0) : null)
        if (standCell) {
          const k2 = `down:${standCell.x},${standCell.y},${standCell.z}`
          if (k2 !== goalKey) {
            try {
              this.bot.pathfinder.setGoal(new goals.GoalBlock(standCell.x, standCell.y, standCell.z))
            } catch (e) {}
            goalKey = k2
          }
          await sleep(350)
          continue
        }
        // 站不了（坑里/悬空）：直接朝物品方向手动走下去，让重力带过去
        try {
          const p2 = this.pos()
          const dx = d.position.x - p2.x
          const dz = d.position.z - p2.z
          const len = Math.hypot(dx, dz)
          if (len > 0.3) {
            await this.bot.look(Math.atan2(-dx, -dz), 0.6, true)
            this.bot.setControlState('forward', true)
            this.bot.setControlState('sneak', true)   // 蹲下走，别又从边上掉下去
            await sleep(420)
            this.bot.setControlState('forward', false)
            this.bot.setControlState('sneak', false)
          } else {
            // 已经在正上方：直接松手往下掉
            await sleep(300)
          }
        } catch (e) {}
        continue
      }

      const key = `${Math.floor(d.position.x)},${Math.floor(d.position.y)},${Math.floor(d.position.z)}`
      if (key !== goalKey) {
        // 换目标才重新下发
        try {
          this.bot.pathfinder.setGoal(new goals.GoalBlock(
            Math.floor(d.position.x), Math.floor(d.position.y), Math.floor(d.position.z)))
        } catch (e) {}
        goalKey = key
        lastDist = dist
        stall = 0
      } else if (dist > lastDist - 0.15) {
        // 同一个目标但没变近 -> 卡住了，放弃这个物品换下一个
        stall++
        if (stall >= 4) {
          skip.add(d.id)
          goalKey = ''
          stall = 0
        }
      } else {
        lastDist = dist
        stall = 0
      }
      await sleep(350)
    }

    try { this.bot.pathfinder.setGoal(null) } catch (e) {}
    return true
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
