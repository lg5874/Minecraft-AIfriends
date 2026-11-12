'use strict'
// L0 反射层：不经过思考的下意识反应。
// 这一层是"像活人"的来源 —— 真人有反射，不需要先推理。

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')

const HOSTILE = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman',
  'witch', 'drowned', 'husk', 'stray', 'pillager', 'vindicator', 'ravager',
  'phantom', 'slime', 'magma_cube', 'blaze', 'ghast', 'piglin_brute',
  'zoglin', 'hoglin', 'warden', 'silverfish', 'vex', 'evoker'
])

class Reflex {
  constructor (bot, ctx) {
    this.bot = bot
    this.ctx = ctx           // { mem, say, log, onEvent }
    this.enabled = true
    this.lastAttackBack = 0
    this.hitLog = []         // 最近被打记录 {t, by}
    this.stuckSince = 0
    this.fleeUntil = 0
    this.timer = null
  }

  start () {
    this.timer = setInterval(() => this.tick(), 800)
  }

  stop () { if (this.timer) clearInterval(this.timer) }

  reset () {
    this.hitLog = []
    this.stuckSince = 0
    this.lastPos = null
    this.eating = false
  }

  // 被打：记录，并判断要不要还手
  onHurt (attacker) {
    const now = Date.now()
    if (!attacker) {
      // 不知道谁打的（怪、摔落、环境），不记恩怨
      this.ctx.log('[hurt] 来源不明')
      return
    }
    if (attacker.username && attacker.username !== this.bot.username) {
      this.hitLog.push({ t: now, by: attacker.username })
      this.hitLog = this.hitLog.filter(h => now - h.t < 10 * 60 * 1000)
      this.ctx.mem.hit(attacker.username, 1)
      const hs = this.ctx.mem.hitStats(attacker.username)
      this.ctx.log(`[hurt] by=${attacker.username} 累计=${hs.times}`)

      // 是怪就先打回去
      const isMob = attacker.type === 'mob' || attacker.type === 'hostile'
      if (isMob) { this.retaliate(attacker); return }

      // 头一两次懵，不还手
      if (hs.times <= 2) {
        this.ctx.onEvent && this.ctx.onEvent('hurt_confused', { by: attacker.username, times: hs.times })
      } else {
        // 反复挨打 -> 还手或者跑
        this.ctx.onEvent && this.ctx.onEvent('hurt_repeat', { by: attacker.username, times: hs.times })
        const hp = this.bot.health
        if (hp < 8) { this.flee(attacker); } else { this.retaliate(attacker) }
      }
    }
  }

  async retaliate (ent) {
    const now = Date.now()
    if (now - this.lastAttackBack < 1200) return
    this.lastAttackBack = now
    try {
      const dist = ent.position.distanceTo(this.bot.entity.position)
      if (dist > 3.6) return
      this.bot.lookAt(ent.position.offset(0, 1.5, 0), true)
      await this.bot.attack(ent)
    } catch (e) {}
  }

  flee (from) {
    this.fleeUntil = Date.now() + 4000
    try {
      const bot = this.bot
      const p = bot.entity.position
      const d = from && from.position ? p.minus(from.position) : null
      const base = d && d.norm() > 0.1
        ? p.plus(d.normalize().scaled(12))
        : p.offset((Math.random() - 0.5) * 20, 0, (Math.random() - 0.5) * 20)
      // 找一块脚下有东西、头顶空的落脚点，别往坑里跳
      let target = null
      for (let r = 0; r < 8 && !target; r++) {
        const tryPos = base.offset((Math.random() - 0.5) * 6, 0, (Math.random() - 0.5) * 6)
        const below = bot.blockAt(tryPos.offset(0, -1, 0))
        const at = bot.blockAt(tryPos)
        const above = bot.blockAt(tryPos.offset(0, 1, 0))
        if (below && below.name !== 'air' && at && at.name === 'air' && above && above.name === 'air') {
          target = tryPos
        }
      }
      if (!target) target = base
      bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z), 1))
    } catch (e) {}
  }

  /**
   * 现在有没有任务在跑。
   *
   * main.js 一直在传 busy 回调，但这个类从来没读过它 ——
   * 结果是每 800ms 无条件跑完 6 级检查，跟任务抢同一个 bot：
   *   flee -> pathfinder.setGoal
   *   shelter -> bot.dig + placeBlock
   *   unstuck -> setControlState + digOut(bot.dig)
   *   eat -> bot.equip + bot.consume
   * 最坑的是 checkStuck：任务在算路时 isMoving() 恰好为真、位置还没动，
   * 8 秒后判"卡住" -> unstuck -> digOut 挖脚下，
   * 把任务正在挖的方块打断（就是那堆 "Digging aborted"）。
   */
  isBusy () {
    try {
      return typeof this.ctx.busy === 'function' ? !!this.ctx.busy() : false
    } catch (e) {
      return false
    }
  }

  tick () {
    if (!this.enabled || !this.bot.entity) return
    const bot = this.bot

    // 0. 掉虚空 -> 自救。这条永远先跑，不看 busy
    try {
      if (bot.entity.position.y < -60) {
        this.ctx.onEvent && this.ctx.onEvent('void', {})
      }
    } catch (e) {}

    // ===== 任务执行中：只保留救命的事 =====
    // 血还够就一律让路。抢 bot 比"少躲一次夜"危险得多。
    if (this.isBusy()) {
      // 血真的少了 + 身边确实有怪 -> 还是得跑
      if (bot.health <= 6) {
        const near = this.nearestHostile(10)
        if (near) this.flee(near)
      }
      // 被怪贴脸也要还手（attack 不抢 pathfinder / dig）
      if (this.ctx.aggressive !== false && bot.health > 6) {
        const near = this.nearestHostile(2.5)   // 半径收窄：只有真贴脸才打
        if (near) this.retaliate(near)
      }
      // 关键：busy 期间仍然刷新卡住基线。
      // 不然任务一结束，第一次 checkStuck 会拿很久以前的坐标比，
      // 算出一个巨大的位移（或反过来），判定完全失真。
      this.syncStuckBaseline()
      return
    }

    // 2. 饿到不行就吃
    if (bot.food <= 17 && !this.eating) {
      const food = bot.inventory.items().find(i =>
        /bread|cooked_|apple|carrot|potato|beef|porkchop|mutton|chicken|melon|baked|stew/.test(i.name))
      if (food) {
        this.eating = true
        bot.equip(food, 'hand').then(() => bot.consume()).catch(() => {})
          .finally(() => { this.eating = false })
      }
    }

    // 3. 血少就躲
    if (bot.health <= 8 && Date.now() > this.fleeUntil) {
      const near = this.nearestHostile(10)
      if (near) this.flee(near)
    }

    // 4. 被怪贴脸 -> 打
    if (this.ctx.aggressive !== false) {
      const near = this.nearestHostile(3.2)
      if (near && bot.health > 10) this.retaliate(near)
    }

    // 5. 天黑 + 血不多 + 没怪贴脸 -> 挖个洞躲着（真人的第一反应）
    this.checkNight()

    // 6. 卡住脱困（只在真的想动却没动时才触发）
    this.checkStuck()
  }

  /**
   * 只更新"上次位置"，不判卡住。
   * busy 期间用它保持基线新鲜，避免任务结束后第一次判断失真。
   */
  syncStuckBaseline () {
    try {
      const p = this.bot.entity.position
      this.lastPos = p.clone()
      this.stuckSince = 0
    } catch (e) {}
  }

  // 天黑自救：挖三格洞把自己埋起来
  checkNight () {
    const bot = this.bot
    if (this.sheltering) return
    const tod = bot.time && bot.time.timeOfDay
    if (tod === undefined) return
    const isNight = tod > 13000 && tod < 23000
    // 血够多就不用躲
    if (!isNight || bot.health > 14) return
    // 已经在洞里就不动
    const p = bot.entity.position
    const above = bot.blockAt(p.offset(0, 2, 0))
    const above2 = bot.blockAt(p.offset(0, 3, 0))
    const ceiling = above && above.name !== 'air' && above.name !== 'cave_air'
    if (ceiling) return
    // 身边没怪才挖（有怪先打）
    if (this.nearestHostile(6)) return

    this.shelter()
  }

  async shelter () {
    const bot = this.bot
    this.sheltering = true
    this.ctx.log('[night] 天黑了，挖个洞躲一下')
    try {
      const p = bot.entity.position
      // 往下挖两格，然后封顶
      for (let i = 0; i < 2; i++) {
        const cur = bot.entity.position
        const below = bot.blockAt(cur.offset(0, -1, 0))
        if (below && below.name !== 'air' && below.name !== 'cave_air' && !/water|lava/.test(below.name)) {
          try { await bot.dig(below, true) } catch (e) { break }
          await new Promise(r => setTimeout(r, 500))
        }
      }
      // 用身上的土/石头把头顶封住
      const blocks = ['dirt', 'cobblestone', 'stone', 'gravel', 'sand', 'oak_planks', 'birch_planks']
      let placed = false
      for (const b of blocks) {
        const it = bot.inventory.items().find(i => i.name === b)
        if (!it) continue
        try {
          await bot.equip(it, 'hand')
          const cur = bot.entity.position
          // 封头顶那一格
          const head = bot.blockAt(cur.offset(0, 2, 0))
          const belowHead = bot.blockAt(cur.offset(0, 1, 0))
          if (head && head.name === 'air' && belowHead && belowHead.name === 'air') {
            await bot.placeBlock(bot.blockAt(cur.offset(0, 1, 0)) || bot.blockAt(cur), new Vec3(0, 1, 0))
            placed = true
          }
        } catch (e) {}
        if (placed) break
      }
      this.ctx.log('[night] 躲好了 ' + (placed ? '（封顶了）' : '（没东西封顶）'))
    } catch (e) {
      this.ctx.log('[night] 挖洞失败 ' + e.message)
    } finally {
      setTimeout(() => { this.sheltering = false }, 60000)
    }
  }

  /**
   * 真的挖出去。
   * 卡在坑里 / 被围住的时候，pathfinder 算不出路，只能自己开一条。
   */
  async digOut () {
    const bot = this.bot
    this.ctx.log('[digout] 挖一条路出去')
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    // 打乱方向，别总往一个方向挖
    dirs.sort(() => Math.random() - 0.5)

    for (const [dx, dz] of dirs) {
      try {
        const p = bot.entity.position
        // 往这个方向挖两格，同时把头顶挖开
        for (let step = 1; step <= 2; step++) {
          const base = p.offset(dx * step, 0, dz * step)
          const feet = bot.blockAt(base)
          const head = bot.blockAt(base.offset(0, 1, 0))

          // 脚下如果是空的，往下垫一下（别掉下去）
          const below = bot.blockAt(base.offset(0, -1, 0))
          if (below && (below.name === 'air' || below.name === 'cave_air')) {
            const fill = ['dirt', 'cobblestone', 'stone', 'gravel']
              .map(n => bot.inventory.items().find(i => i.name === n)).find(Boolean)
            if (fill) {
              try {
                await bot.equip(fill, 'hand')
                await bot.placeBlock(below, new Vec3(0, 1, 0))
              } catch (e) {}
            }
          }

          for (const b of [feet, head]) {
            if (!b) continue
            if (b.name === 'air' || b.name === 'cave_air') continue
            if (b.name === 'bedrock' || b.name === 'water' || b.name === 'lava') break
            try {
              await bot.dig(b, true)
              await new Promise(r => setTimeout(r, 250))
            } catch (e) { break }
          }
        }
        // 挖通了就朝那个方向走过去（先转向，不然是撞墙）
        const yaw = Math.atan2(-dx, dz)
        try {
          await bot.look(yaw, 0, true)
          await new Promise(r => setTimeout(r, 120))
        } catch (e) {}
        bot.setControlState('forward', true)
        await new Promise(r => setTimeout(r, 1100))
        bot.setControlState('forward', false)

        // 出来了？
        const now = bot.entity.position
        if (this.lastPos && now.distanceTo(this.lastPos) > 1.5) {
          this.ctx.log('[digout] 出来了')
          return true
        }
      } catch (e) {}
    }
    this.ctx.log('[digout] 没挖出去，再试')
    return false
  }

  nearestHostile (range) {
    const ents = Object.values(this.bot.entities).filter(e =>
      e !== this.bot.entity && e.name && HOSTILE.has(e.name) &&
      e.position.distanceTo(this.bot.entity.position) <= range)
    if (!ents.length) return null
    ents.sort((a, b) =>
      a.position.distanceTo(this.bot.entity.position) - b.position.distanceTo(this.bot.entity.position))
    return ents[0]
  }

  // 只有"pathfinder 说在走"但"实际没挪窝"时才算卡住
  checkStuck () {
    const bot = this.bot
    if (!bot.entity) return
    const p = bot.entity.position
    if (!this.lastPos) { this.lastPos = p.clone(); this.stuckSince = 0; return }

    const moved = p.distanceTo(this.lastPos)
    this.lastPos = p.clone()

    // pathfinder 是不是真的在驱动移动
    const pfMoving = bot.pathfinder && typeof bot.pathfinder.isMoving === 'function'
      ? bot.pathfinder.isMoving() : false
    // 有没有手动按键
    const manual = ['forward', 'back', 'left', 'right'].some(k => {
      try { return bot.getControlState(k) } catch (e) { return false }
    })

    const wantsToMove = pfMoving || manual

    if (wantsToMove && moved < 0.12) {
      this.stuckSince++
      if (this.stuckSince >= 10) {     // 10 * 0.8s = 8 秒没动
        this.stuckSince = 0
        this.unstuck()
      }
    } else {
      this.stuckSince = 0
    }
  }

  async unstuck () {
    const now = Date.now()
    if (now - (this.lastUnstuck || 0) < 15000) return   // 15 秒内只折腾一次
    // 没在寻路、也没按键 -> 他只是站着，不用"脱困"
    const bot0 = this.bot
    const pfMoving = bot0.pathfinder && typeof bot0.pathfinder.isMoving === 'function'
      ? bot0.pathfinder.isMoving() : false
    if (!pfMoving) return
    this.lastUnstuck = now
    const bot = this.bot
    this.ctx.log('[unstuck]')

    // 先试最简单的：跳一下 + 随便走
    // 如果连续几次都没用，就真的挖出去
    this.unstuckTries = (this.unstuckTries || 0) + 1
    if (this.unstuckTries >= 3) {
      this.unstuckTries = 0
      await this.digOut()
      return
    }
    try {
      bot.setControlState('jump', true)
      await new Promise(r => setTimeout(r, 350))
      bot.setControlState('jump', false)
      // 朝四个方向各试一下（先转再走）
      const yaws = [-Math.PI / 2, Math.PI / 2, 0, Math.PI]
      for (const y of yaws) {
        try {
          await bot.look(y, 0, true)
          await new Promise(r => setTimeout(r, 80))
          bot.setControlState('forward', true)
          await new Promise(r => setTimeout(r, 500))
          bot.setControlState('forward', false)
        } catch (e) {}
        const p2 = bot.entity.position
        if (this.lastPos && p2.distanceTo(this.lastPos) > 0.8) break
      }
    } catch (e) {}
  }
}

module.exports = Reflex
