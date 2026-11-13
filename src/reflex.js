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

    // 救命线：血到这个数以下，不管在忙什么都要先保命。
    // 实测事故：血 6 -> 5 -> 3 -> 2 用了 2 秒就死，而 busy 门禁把他
    // 挡在「任务里」不让跑。这条阈值以下的处理绕开 busy。
    this.SOS_HP = 6
    this.sosUntil = 0
    this.sosKind = ''
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
  /**
   * 紧急保命。血 <= SOS_HP 时无条件执行，**不看 busy**。
   *
   * 三件事按优先级：
   *   1. 环境伤害（溺水/岩浆）-> 先离开原地，往向上方向游/跳
   *   2. 有怪 -> 跑
   *   3. 什么都没有 -> 吃东西回血
   */
  /**
   * 紧急保命。
   *
   * 【2026-11-13 · 实测日志可读性事故】
   * 老节流有一条例外 `dropping`（血还在往下掉就放行），而 `urgent` 对溺水/岩浆
   * 永远为真 —— 于是 tick 每 800ms 叫一次，血卡在 5 不动也每 0.5~0.8 秒重发。
   * 实测 5 分钟打 **131 条** `[sos] 血 5，紧急保命（drown）`，
   * 日志被它淹掉，玩家在公屏/卡顿上也能感觉到"这号在疯狂重复"。
   *
   * 现在拆成两件事，各有各的节流：
   *   **动作**：仍然要重复（溺水时得一直往上，不会因为血没变就能停），
   *           紧急类型 2.5 秒一次、普通类型 1.2 秒一次；换类型/掉到更低一档立刻执行。
   *   **日志**：只有"换了一种危险"或"血掉到更低一档"或"一分钟没报了"才打。
   *           5→4→3 各一条，同一档反复掉不重发。
   */
  sos (kind, opts = {}) {
    const bot = this.bot
    const now = Date.now()
    const hp = bot.health

    // 【别让"血低"把正在处理的险情顶掉】
    // tick 每 800ms 叫一次 `sos(this.sosKind || 'lowhp')`，而 onPain 那边按伤害类型
    // 传 'drown'/'lava'。两边交替时 kind 在 drown ↔ lowhp 之间来回跳，
    // 每次都算"换了类型"→ 每次都打一行日志（实测 5 分钟 19 条里一大半是这种抖动）。
    // 正在溺水/岩浆里时，'lowhp' 这种泛泛原因不该改变当前处置。
    const HAZARD = new Set(['drown', 'lava', 'on_fire', 'in_fire', 'suffocate', 'out_of_world'])
    let k = kind || ''
    if (HAZARD.has(this.sosKind) && (k === 'lowhp' || k === '' || k === 'hostile')) k = this.sosKind
    const urgent = !!opts.urgent || k === 'drown' || k === 'lava' ||
      k === 'on_fire' || k === 'in_fire'

    // 血按 1 点分档：掉到更低一档才算"更糟了"
    const band = typeof hp === 'number' && isFinite(hp) ? Math.max(1, Math.ceil(hp)) : null
    const typeChanged = this.sosKind !== k
    const lowerBand = band != null && typeof this._sosBandHp === 'number' && band < this._sosBandHp

    const actGapMs = urgent ? 2500 : 1200
    const sinceAct = now - (this._sosActAt || 0)
    if (!typeChanged && !lowerBand && sinceAct < actGapMs) return

    this._sosActAt = now
    this.sosAt = now
    this.sosKind = k
    this.sosHp = typeof hp === 'number' ? hp : null
    this._sosBandHp = band

    // 日志：换类型 / 掉档 / 一分钟一次
    const sinceLog = now - (this._sosLogAt || 0)
    if (typeChanged || lowerBand || sinceLog > 60000) {
      this._sosLogAt = now
      try { this.ctx.log(`[sos] 血 ${Math.round(hp)}，紧急保命（${k || '未知'}）`) } catch (e) {}
    }

    // 1. 溺水：往上浮
    if (kind === 'drown') {
      try {
        bot.setControlState('jump', true)
        setTimeout(() => { try { bot.setControlState('jump', false) } catch (e) {} }, 3000)
      } catch (e) {}
      return
    }

    // 2. 岩浆/着火：找水或者往上跑
    if (kind === 'lava' || kind === 'on_fire' || kind === 'in_fire') {
      try {
        const near = this.nearestHostile(10)
        if (near) this.flee(near)
      } catch (e) {}
      return
    }

    // 3. 有怪就跑，跑不了就吃
    let near = null
    try { near = this.nearestHostile(12) } catch (e) {}
    if (near) {
      try { this.flee(near) } catch (e) {}
      return
    }

    // 4. 没怪：吃东西回血
    try { this.eatNow() } catch (e) {}
  }

  /** 立刻吃一口，不看饥饿值（保命用） */
  eatNow () {
    const bot = this.bot
    if (this.eating) return
    const food = bot.inventory.items().find(i =>
      /bread|cooked_|apple|carrot|potato|beef|porkchop|mutton|chicken|melon|baked|stew|kelp|berries/.test(i.name))
    if (!food) return
    this.eating = true
    bot.equip(food, 'hand').then(() => bot.consume()).catch(() => {})
      .finally(() => { this.eating = false })
  }

  /**
   * 挨了一下。
   *
   * @param {object|null} attacker 来源实体；环境伤害（摔/淹/饿/岩浆）传 null
   * @param {number} [health]     当前血量（不传就读 bot.health）
   * @param {string} [kind]       环境伤害类型：fall/drown/lava/starve...
   *
   * 踩过的坑：老版本 attacker 为 null 时直接 return，只打一行「[hurt] 来源不明」。
   * 于是溺水、摔落、岩浆这些**真能弄死他**的伤害，反射层完全不管 ——
   * 线上那次从血 6 掉到 2 死掉，就是因为伤害来自环境、没有 attacker。
   * 现在环境伤害也要走救命逻辑。
   */
  onHurt (attacker, health, kind) {
    const now = Date.now()
    const hp = typeof health === 'number' ? health : this.bot.health

    if (!attacker) {
      // 环境伤害：不记恩怨，但**必须救命**
      this.ctx.log(`[hurt] 环境伤害 ${kind || '未知'}，血 ${Math.round(hp)}`)
      // 【按威胁类型，不只是按血量】快淹死/岩浆/着火，血 7~10 一样得先离开。
      // 血 10 还在水里往下挖，下一口水就没了；摔伤/饿这种已经发生过的不用停手。
      const LETHAL = kind === 'drown' || kind === 'lava' || kind === 'on_fire' ||
        kind === 'in_fire' || kind === 'suffocate' || kind === 'out_of_world'
      if (hp <= this.SOS_HP || (LETHAL && hp <= 10)) {
        // 环境伤害（溺水/岩浆）等不起节流窗口，直接 urgent
        this.sos(kind, { urgent: true })
      }
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

    // ===== 救命线：血 ≤ SOS_HP，不管忙不忙都先保命 =====
    //
    // 实测事故：血 6 -> 5 -> 3 -> 2 只用了 2 秒，而当时他在任务里（busy），
    // 老的 busy 分支只在「有怪」时才跑，环境伤害（淹/摔/岩浆）根本没人管，
    // 于是照常跑任务直到死。
    // 现在这条在最前面，绕开 busy，而且环境伤害也算。
    const hp = bot.health
    if (typeof hp === 'number' && hp > 0 && hp <= this.SOS_HP) {
      const near = this.nearestHostile(12)
      if (near) {
        this.sos(this.sosKind || 'hostile')
        this.syncStuckBaseline()
        return
      }
      // 没怪也救命：可能正在溺水/岩浆/摔落，或纯粹血少了
      this.sos(this.sosKind || 'lowhp')
      this.syncStuckBaseline()
      return
    }

    // ===== 任务执行中：只保留救命的事 =====
    // 血还够就一律让路。抢 bot 比"少躲一次夜"危险得多。
    if (this.isBusy()) {
      // 被怪贴脸也要还手（attack 不抢 pathfinder / dig）
      if (this.ctx.aggressive !== false && bot.health > this.SOS_HP) {
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
