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

  tick () {
    if (!this.enabled || !this.bot.entity) return
    const bot = this.bot

    // 1. 快死了 / 掉虚空 -> 自救
    try {
      if (bot.entity.position.y < -60) {
        this.ctx.onEvent && this.ctx.onEvent('void', {})
      }
    } catch (e) {}

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

    // 6. 卡住脱困
    this.checkStuck()
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

  nearestHostile (range) {
    const ents = Object.values(this.bot.entities).filter(e =>
      e !== this.bot.entity && e.name && HOSTILE.has(e.name) &&
      e.position.distanceTo(this.bot.entity.position) <= range)
    if (!ents.length) return null
    ents.sort((a, b) =>
      a.position.distanceTo(this.bot.entity.position) - b.position.distanceTo(this.bot.entity.position))
    return ents[0]
  }

  // 走着走着位置不动 -> 卡住了，跳一下或者换个方向
  checkStuck () {
    const p = this.bot.entity.position
    if (!this.lastPos) { this.lastPos = p.clone(); this.stuckSince = 0; return }
    const moved = p.distanceTo(this.lastPos)
    this.lastPos = p.clone()
    const moving = this.bot.pathfinder && this.bot.pathfinder.isMoving && this.bot.pathfinder.isMoving()
    if (moving && moved < 0.15) {
      this.stuckSince++
      if (this.stuckSince >= 8) {
        this.stuckSince = 0
        this.unstuck()
      }
    } else {
      this.stuckSince = 0
    }
  }

  async unstuck () {
    const now = Date.now()
    if (now - (this.lastUnstuck || 0) < 6000) return
    this.lastUnstuck = now
    const bot = this.bot
    this.ctx.log('[unstuck]')
    try {
      bot.setControlState('jump', true)
      await new Promise(r => setTimeout(r, 350))
      bot.setControlState('jump', false)
      const dirs = ['forward', 'back', 'left', 'right']
      const d = dirs[Math.floor(Math.random() * dirs.length)]
      bot.setControlState(d, true)
      await new Promise(r => setTimeout(r, 600))
      bot.setControlState(d, false)
    } catch (e) {}
  }
}

module.exports = Reflex
