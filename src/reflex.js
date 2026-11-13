'use strict'
// L0 反射层：不经过思考的下意识反应。
// 这一层是"像活人"的来源 —— 真人有反射，不需要先推理。

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const damage = require('./damage')

const HOSTILE = new Set([
  'zombie', 'zombie_villager', 'skeleton', 'creeper', 'spider', 'cave_spider',
  'enderman', 'witch', 'drowned', 'husk', 'stray', 'bogged', 'pillager',
  'vindicator', 'ravager', 'phantom', 'slime', 'magma_cube', 'blaze', 'ghast',
  'piglin_brute', 'zoglin', 'hoglin', 'warden', 'silverfish', 'vex', 'evoker',
  'breeze', 'creaking', 'guardian', 'elder_guardian', 'shulker', 'zombified_piglin'
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

    // ===== 战斗分档（2026-11-14） =====
    //
    // 【为什么不是"把 8 改成 14"就完事】
    // 实测掉血是 2 秒 5 血：20 -> 15 -> 10 -> 5 -> 0 一共 8 秒。
    // 就算阈值抬到 14，从 20 掉到 14 也只多给 1.2 秒 —— 阈值这条路救不了命。
    // 真正的问题是他**不知道自己在挨打**：sourceTypeId 解析不出来，
    // 日志写"环境伤害 未知"，于是反射层选不出应对（跑？跳？退？），干脆什么都不做。
    //
    // 所以主触发是**掉血速率**（见 sampleHealth / recoil），
    // 分档只是"已经知道危险之后再做什么"。
    this.HP_ALERT = 14   // 有敌对/正在挨打 -> 拉开距离
    this.HP_FLEE = 10    // 血 <= 10 -> 真跑
    this.HP_PANIC = 8    // 血 <= 8  -> 跑 + 吃
    this.HP_CRIT = 5     // 血 <= 5  -> 跑 + 吃 + 不接新任务

    this.hpTrace = []       // 最近几秒的血量采样 {t, hp}
    this.lastHp = null
    this.lastRecoilAt = 0
    this.lastKeepDistAt = 0
    this.lastThreatLogAt = 0
    this.lastThreatLog = -1
    this.panicUntil = 0     // 这段时间内不接新任务（血 <= 5）
    this.attackUntil = 0    // 这段时间内算"正在挨打"
    this.lastDamage = null  // { at, id, name, cat, attack, causeId, directId, pos }
    this._healthBound = null
  }

  start () {
    this.timer = setInterval(() => this.tick(), 800)
    // 掉血最快、最准的信号不是 tick（每 800ms），是服务端的 health 包：
    // 每挨一下必推一个，几乎和伤害同帧到。挂上它，掉血速率才来得及反应。
    try {
      this._healthBound = () => this.sampleHealth()
      this.bot.on('health', this._healthBound)
    } catch (e) {}
  }

  stop () {
    if (this.timer) clearInterval(this.timer)
    try { if (this._healthBound) this.bot.removeListener('health', this._healthBound) } catch (e) {}
    this._healthBound = null
  }

  reset () {
    this.hitLog = []
    this.stuckSince = 0
    this.lastPos = null
    this.eating = false
    this.hpTrace = []
    this.lastHp = null
    this.panicUntil = 0
    this.attackUntil = 0
    this.lastDamage = null
  }

  // ==================== 掉血速率（核心触发） ====================

  /** 位置快照：Vec3 用 clone，普通 {x,y,z} 原样拷（单测里是普通对象） */
  _pos (p) {
    if (!p) return null
    try { if (typeof p.clone === 'function') return p.clone() } catch (e) {}
    return { x: p.x, y: p.y, z: p.z }
  }

  /** 两点距离，兼容 Vec3 和普通 {x,y,z}（单测里是普通对象） */
  dist (a, b) {
    if (!a || !b) return Infinity
    const dx = (a.x || 0) - (b.x || 0)
    const dy = (a.y || 0) - (b.y || 0)
    const dz = (a.z || 0) - (b.z || 0)
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }

  /** 最近 windowMs 内掉了多少血（窗口内最高血 - 现在） */
  recentDrop (windowMs = 3000) {
    const now = Date.now()
    const hp = this.bot.health
    if (typeof hp !== 'number' || !isFinite(hp)) return 0
    let max = hp
    for (const s of this.hpTrace) {
      if (now - s.t <= windowMs && s.hp > max) max = s.hp
    }
    return Math.max(0, max - hp)
  }

  /**
   * 采一次血量，算掉血速率。
   *
   * 【这条是主触发，不看血绝对值、不看来源】
   * 真人被烫会立刻弹开，不会先搞清那是岩浆还是火；
   * 被怪打也一样 —— 只要 3 秒内掉了 4 血，先退开 2 格再说。
   * 这样即使 sourceTypeId 解析不出来（"环境伤害 未知"），也已经动了。
   */
  sampleHealth () {
    const bot = this.bot
    const hp = bot && bot.health
    if (typeof hp !== 'number' || !isFinite(hp) || hp <= 0) return
    const now = Date.now()

    this.hpTrace.push({ t: now, hp })
    if (this.hpTrace.length > 64) this.hpTrace = this.hpTrace.slice(-64)
    this.hpTrace = this.hpTrace.filter(s => now - s.t <= 8000)

    // 掉血 -> 立刻记成"正在挨打"，这是最可靠的信号
    const drop = this.recentDrop(3000)
    if (drop >= 4) {
      this.attackUntil = now + 4000
      this.recoil(drop, { hp })
    }
    if (this.lastHp != null && hp < this.lastHp - 0.01) this.attackUntil = Math.max(this.attackUntil, now + 4000)
    this.lastHp = hp
  }

  /**
   * 立刻弹开：后退 + 跳一下。
   *
   * 不用 pathfinder —— 任务可能正在用寻路，设 goal 会把它打断（"Digging aborted"
   * 那一堆事故就是这么来的）。控制键脉冲只持续 0.4 秒，代价小、见效快，
   * 而且"退不动"的时候至少跳一下，能脱离岩浆/营火/浆果丛这种持续伤害。
   */
  recoil (drop, opts = {}) {
    const now = Date.now()
    if (now - this.lastRecoilAt < 900) return
    this.lastRecoilAt = now
    const bot = this.bot

    // 往哪个方向退：优先最近一次伤害的来源点，其次最近的敌对生物
    let origin = null
    try { origin = this.attackOrigin() } catch (e) {}

    try {
      const p = bot.entity && bot.entity.position
      if (p && origin) {
        // 背对来源（这样"后退"真的是远离，而不是往枪口上撞）
        const yaw = Math.atan2(p.x - origin.x, p.z - origin.z)
        try { bot.look(yaw, 0, true) } catch (e) {}
      }
      bot.setControlState('back', true)
      setTimeout(() => { try { bot.setControlState('back', false) } catch (e) {} }, 420)
      bot.setControlState('jump', true)
      setTimeout(() => { try { bot.setControlState('jump', false) } catch (e) {} }, 260)
    } catch (e) {}

    const why = this.lastDamage && now - this.lastDamage.at < 4000
      ? `被 ${this.lastDamage.name}`
      : '来源不明'
    // 两个数都要说实话：窗口累计（3 秒掉多少）和最近一下（9→8）。
    // 只写累计会变成"掉血 5（12→8）"—— 12 是窗口最高点，不是上一下。
    const cur = typeof opts.hp === 'number' ? Math.round(opts.hp) : null
    const prev = typeof this.lastHp === 'number' ? Math.round(this.lastHp) : null
    const pair = (prev != null && cur != null && prev !== cur) ? prev - cur : 0
    const shown = Math.max(1, drop, pair)
    const detail = pair > 0 ? `（最近一下 ${prev}→${cur}）` : ''
    if (cur != null && cur <= 0) return          // 已经死了，弹开没意义
    this.logThrottled(`[reflex] 3 秒内掉 ${shown.toFixed(0)} 血${detail} —— ${why}，先退开 2 格 + 跳一下`, 3000, 'recoil')
  }

  /** 最近一次伤害的来源位置：真实体 -> 位置 -> 最近敌对 -> null */
  attackOrigin () {
    const now = Date.now()
    const d = this.lastDamage
    if (d && now - d.at < 5000) {
      if (d.pos && typeof d.pos.x === 'number') return d.pos
      const ent = d.causeId ? this.bot.entities[d.causeId] : null
      if (ent && ent.position) return ent.position
    }
    const near = this.nearestHostile(12)
    return near ? near.position : null
  }

  logThrottled (msg, gapMs, key) {
    const now = Date.now()
    this._logAt = this._logAt || {}
    const k = key || msg.slice(0, 24)
    if (now - (this._logAt[k] || 0) < (gapMs || 5000)) return
    this._logAt[k] = now
    try { this.ctx.log(msg) } catch (e) {}
  }

  /** 血 <= 5：跑到安全为止，并且这段时间不接新任务 */
  blocksNewTasks () {
    return Date.now() < this.panicUntil
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
    // 已经死了（这一下就是致命的）：别再刷"紧急保命"，死因由 main.js 记
    if (typeof hp === 'number' && hp <= 0) return

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

      // 【喊救命】跟日志同一档节流（换类型 / 掉档 / 一分钟一次），不会刷屏。
      //
      // 为什么要有：明天用户第一眼很可能就是"他血 3 卡在洞里"。
      // 真人这时候会喊"我快不行了，有吃的吗" —— 那是**双向**的开场，
      // 用户有事可做；而一个一声不吭的伤者，用户只会觉得"这号坏了"。
      try {
        if (this.ctx && typeof this.ctx.say === 'function' && hp > 0) {
          // 【池子要够大】2026-11-14
          // 原来只有 3-4 条，一分钟喊一次 → 10 分钟就重复两遍
          // （实测 [21:31] 和 [24:27] 都是「快撑不住了」）。
          // 真人反复喊救命也会换说法：先喊人、再报状况、最后骂一句。
          const pool = k === 'drown'
            ? ['我快淹死了', '水里上不去', '我沉底了', '憋不住了 谁来拉我一把',
              '我在这底下 上不来', '完了 气不够了', '谁会游泳啊']
            : (k === 'lava' || k === 'on_fire' || k === 'in_fire')
              ? ['着火了', '烫死我了', '我身上着火了', '我操 烧起来了',
                '快烧没了 谁有水', '烫死 我往回跑']
              : (hp <= 6
                  ? ['血不多了', '快撑不住了', '有人吗 我快不行了', '我快挺不住了 有吃的吗',
                    '我这边情况不太妙', '快没了 谁在附近', '我得缓一下 不然要交代在这',
                    '妈的 血见底了', '再不来人我就没了', '撑住 撑住']
                  : ['血有点低', '我得缓一下', '先不折腾了 缓口气', '有点顶不住', '让我坐会儿'])
          this.ctx.say(pool[Math.floor(Math.random() * pool.length)])
        }
      } catch (e) {}
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
  onHurt (attacker, health, kind, meta = {}) {
    const now = Date.now()
    const hp = typeof health === 'number' ? health : this.bot.health

    // ---- 先把"这一下是什么"记下来（哪怕解析不出来也要有记录） ----
    const info = meta && meta.id != null ? damage.infoOf(meta.id) : null
    const name = (info && info.name) || kind || 'unknown'
    const isAttack = meta && meta.attack != null
      ? !!meta.attack
      : (info ? info.attack : !!(attacker && attacker.type))
    const by = (attacker && (attacker.username || attacker.name)) || meta.by || null

    this.lastDamage = {
      at: now,
      id: meta && meta.id != null ? meta.id : null,
      name,
      cat: (info && info.cat) || (isAttack ? 'mob' : 'env'),
      attack: isAttack,
      by,
      causeId: meta.causeId || 0,
      directId: meta.directId || 0,
      pos: meta.pos || (attacker && attacker.position) || null
    }

    // 不管是什么伤害，先按"掉血速率"过一遍：3 秒掉 4 血就弹开
    try { this.sampleHealth() } catch (e) {}
    if (isAttack) {
      this.attackUntil = now + 6000
      // 单次挨打（一下 5 血也可能只掉一次）也要有动作
      if (this.recentDrop(3000) < 4) this.recoil(Math.max(2, this.recentDrop(3000)), { hp })
    }

    if (!attacker || !attacker.username || attacker.username === this.bot.username) {
      // ---- 环境伤害 / 看不见来源：不记恩怨，但**必须救命** ----
      const cn = (info && info.cn) || kind || '未知'
      const idTxt = meta && meta.id != null ? `${name}/${meta.id}` : String(name)
      this.logThrottled(`[hurt] ${isAttack ? '被攻击' : '环境伤害'} ${cn}（${idTxt}），血 ${Math.round(hp)}`, 1200)

      // 【按威胁类型，不只是按血量】快淹死/岩浆/着火，血 7~10 一样得先离开。
      // 血 10 还在水里往下挖，下一口水就没了；摔伤/饿这种已经发生过的不用停手。
      const LETHAL = kind === 'drown' || kind === 'lava' || kind === 'on_fire' ||
        kind === 'in_fire' || kind === 'suffocate' || kind === 'out_of_world' ||
        !!(info && info.continuous)
      // 血已经归零（这一下就是致命的）就别再喊保命了，死因由 main.js 那边记
      if (hp > 0 && (hp <= this.SOS_HP || (LETHAL && hp <= 10))) {
        // 环境伤害（溺水/岩浆）等不起节流窗口，直接 urgent
        this.sos(LETHAL ? (kind || name) : (name || kind), { urgent: true })
      }

      // 分档（不管能不能解析来源，只要有威胁就按血量走）
      this.reactByTier(hp, { near: this.nearestHostile(9), underAttack: isAttack || this.recentDrop(3000) >= 4 })
      return
    }

    if (attacker.username && attacker.username !== this.bot.username) {
      const isPlayer = !(attacker.type === 'mob' || attacker.type === 'hostile')
      if (isPlayer) {
        this.hitLog.push({ t: now, by: attacker.username })
        this.hitLog = this.hitLog.filter(h => now - h.t < 10 * 60 * 1000)
        this.ctx.mem.hit(attacker.username, 1)
        const hs = this.ctx.mem.hitStats(attacker.username)
        this.ctx.log(`[hurt] by=${attacker.username} 累计=${hs.times}`)

        // 头一两次懵，不还手
        if (hs.times <= 2) {
          this.ctx.onEvent && this.ctx.onEvent('hurt_confused', { by: attacker.username, times: hs.times })
        } else {
          // 反复挨打 -> 还手或者跑
          this.ctx.onEvent && this.ctx.onEvent('hurt_repeat', { by: attacker.username, times: hs.times })
          if (this.canRetaliate()) this.retaliate(attacker)
          else this.flee(attacker)
        }
      } else {
        // 怪打的：血够才反打，否则跑（"他会跑"比"他会反击"重要）
        if (this.canRetaliate()) this.retaliate(attacker)
        else this.flee(attacker)
      }
      this.reactByTier(hp, { near: attacker, underAttack: true })
    }
  }

  /**
   * 按血量分档反应。
   *
   *   血 <= 14 且附近有敌对（或正在挨打） -> 拉开距离（不是拼命跑）
   *   血 <= 10 -> 真跑
   *   血 <= 8  -> 跑 + 吃
   *   血 <= 5  -> 跑 + 吃 + 不接新任务
   *
   * 返回档位，调用方可以用它决定要不要 return。
   */
  threatLevel (hp, opts = {}) {
    if (typeof hp !== 'number' || !isFinite(hp) || hp <= 0) return 0
    if (hp <= this.HP_CRIT) return 4
    if (hp <= this.HP_PANIC) return 3
    if (hp <= this.HP_FLEE) return 2
    if (hp <= this.HP_ALERT && (opts.near || opts.underAttack)) return 1
    return 0
  }

  reactByTier (hp, opts = {}) {
    const lvl = this.threatLevel(hp, opts)
    if (lvl < 1) return 0
    const now = Date.now()
    const threat = opts.near || null
    const from = (threat && threat.position) ? threat : this.attackOrigin()

    if (lvl >= 4) {
      this.panicUntil = now + 20000
      this.flee(from)
      try { this.eatNow() } catch (e) {}
    } else if (lvl === 3) {
      if (opts.underAttack || threat) this.flee(from)
      try { this.eatNow() } catch (e) {}
    } else if (lvl === 2) {
      if (opts.underAttack || threat) this.flee(from)
      else try { this.eatNow() } catch (e) {}
    } else if (lvl === 1) {
      this.keepDistance(threat)
    }

    // 换档才打日志（20 秒一次心跳），别把日志刷满
    // 换档立刻报；同一档 60 秒提醒一次（20 秒太吵：低血蹲着等回血时会刷屏）
    if (lvl !== this.lastThreatLog || now - this.lastThreatLogAt > 60000) {
      this.lastThreatLog = lvl
      this.lastThreatLogAt = now
      // 【日志要说实话】2026-11-14
      //
      // lvl 2 的实际分支是：
      //   if (underAttack || threat) flee(from)
      //   else eatNow()                       <- 绝大多数时候走这条
      // 而日志原来一律写「跑」。实测看到：
      //   [reflex] 血 10（2 档）—— 跑
      //   [reflex] 血 10（2 档）—— 跑      （每分钟一次，位置一动不动）
      // 因为他根本没跑，他在试 `eatNow()`，而背包里没吃的 —— 失败是静默的。
      //
      // 这会让明早的人（包括我自己）误判成「reflex 说要跑但跑不动 → pathfinder 坏了」，
      // 而真相是「他在找吃的，但没有」。
      const fighting = !!(opts.underAttack || threat)
      const what = lvl === 4 ? '跑 + 吃东西 + 不接新任务'
        : lvl === 3 ? (fighting ? '跑 + 吃东西' : '找吃的（没威胁）')
          : lvl === 2 ? (fighting ? '跑' : '找吃的') : '拉开距离'
      this.ctx.log(`[reflex] 血 ${Math.round(hp)}（${lvl} 档）—— ${what}`)
    }
    return lvl
  }

  /**
   * 4 档（血 <= 5）：跑 + 吃 + **这段时间不接新任务**。
   * 阈值由 blocksNewTasks() 暴露给 main.js 的主循环 —— 血 5 的时候
   * 再起一个"去挖矿"的任务，等于让他走去死。
   */
  panic (hp) {
    const now = Date.now()
    this.panicUntil = now + 20000
    try { this.flee(this.attackOrigin()) } catch (e) {}
    try { this.eatNow() } catch (e) {}
    this.logThrottled(`[reflex] 血 ${Math.round(hp)} <= ${this.HP_CRIT}：跑 + 吃东西 + 不接新任务`, 10000)
  }

  /** 1 档：只是拉开距离，不拼命跑（血还够，别把任务全扔了） */
  keepDistance (from) {
    const now = Date.now()
    if (now - this.lastKeepDistAt < 2500) return
    this.lastKeepDistAt = now
    try {
      const bot = this.bot
      const p = bot.entity && bot.entity.position
      if (!p) return
      const d = from && from.position ? from.position : from
      const gap = d ? this.dist(p, d) : 99
      if (gap > 10) return                 // 本来就够远
      const base = d
        ? new Vec3(p.x + (p.x - d.x), p.y, p.z + (p.z - d.z))
        : new Vec3(p.x + (Math.random() - 0.5) * 12, p.y, p.z + (Math.random() - 0.5) * 12)
      const t = base.offset(0, 0, 0)
      bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(t.x), Math.floor(p.y), Math.floor(t.z), 2))
      if (!this._keepLogged || now - this._keepLogged > 8000) {
        this._keepLogged = now
        this.ctx.log(`[reflex] 身边有怪（${Math.round(gap)} 格），先拉开点距离`)
      }
    } catch (e) {}
  }

  /** 反打的门槛：血够（> 14）而且怪不多（<= 2 个） */
  canRetaliate () {
    if (this.ctx && this.ctx.aggressive === false) return false
    const hp = this.bot.health
    if (typeof hp !== 'number' || hp <= this.HP_ALERT) return false
    if (this.blocksNewTasks()) return false
    try { if (this.hostileCount(6) > 2) return false } catch (e) {}
    return true
  }


  async retaliate (ent) {
    const now = Date.now()
    if (now - this.lastAttackBack < 1200) return
    this.lastAttackBack = now
    try {
      const me = this.bot.entity && this.bot.entity.position
      const dist = this.dist(ent.position, me)
      if (dist > 3.6) return
      const aim = new Vec3(ent.position.x, ent.position.y + 1.5, ent.position.z)
      this.bot.lookAt(aim, true)
      await this.bot.attack(ent)
    } catch (e) {}
  }

  /**
   * 跑。
   * @param {object|null} from 实体、Vec3、{position} 都行；null 就朝随机方向
   */
  flee (from) {
    this.fleeUntil = Date.now() + 4000
    try {
      const bot = this.bot
      const p = bot.entity.position
      const src = from && from.position ? from.position : (from && typeof from.x === 'number' ? from : null)
      const d = src ? new Vec3(p.x - src.x, 0, p.z - src.z) : null
      const away = d && d.norm() > 0.1 ? d.normalize().scaled(12) : null
      const base = away
        ? new Vec3(p.x + away.x, p.y, p.z + away.z)
        : new Vec3(p.x + (Math.random() - 0.5) * 20, p.y, p.z + (Math.random() - 0.5) * 20)
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
      // 边跑边冲（保命时不用省饥饿值）
      try {
        bot.setControlState('sprint', true)
        setTimeout(() => { try { bot.setControlState('sprint', false) } catch (e) {} }, 3000)
      } catch (e) {}
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

    // 0.5 采样血量 —— tick 也要采一次：掉血不一定都走了 damage_event
    //     （毒、凋零、缓慢、饥饿这些都是纯 health 包），
    //     速率到这里才接得住。
    try { this.sampleHealth() } catch (e) {}

    const hp = bot.health
    const near = this.nearestHostile(10)
    const underAttack = !!near || Date.now() < this.attackUntil || this.recentDrop(3000) >= 4
    const lvl = this.threatLevel(hp, { near, underAttack })

    // ===== 救命线：血 ≤ SOS_HP，不管忙不忙都先保命 =====
    //
    // 实测事故：血 6 -> 5 -> 3 -> 2 只用了 2 秒，而当时他在任务里（busy），
    // 老的 busy 分支只在「有怪」时才跑，环境伤害（淹/摔/岩浆）根本没人管，
    // 于是照常跑任务直到死。
    // 现在这条在最前面，绕开 busy，而且环境伤害也算。
    if (typeof hp === 'number' && hp > 0 && hp <= this.SOS_HP) {
      this.sos(this.sosKind || (near ? 'hostile' : 'lowhp'))
      if (lvl >= 4) this.panic(hp)
      this.syncStuckBaseline()
      return
    }

    // ===== 战斗分档（2026-11-14）=====
    //
    // 【为什么放在 busy 之前】
    // 他昨天晚上就是死在这条 busy 门禁上：任务在跑 -> tick 直接 return ->
    // 每 2 秒掉 5 血，8 秒就没了。命比任务重要，<=10 血必须抢 bot。
    if (lvl >= 2) {
      this.reactByTier(hp, { near, underAttack })
      this.syncStuckBaseline()
      return
    }

    // ===== 任务执行中：只保留救命的事 =====
    // 血还够就一律让路。抢 bot 比"少躲一次夜"危险得多。
    if (this.isBusy()) {
      // 1 档（<=14 且有怪）：不动寻路，怕打断挖掘，但贴脸的照打
      if (this.canRetaliate()) {
        const close = this.nearestHostile(2.5)
        if (close) this.retaliate(close)
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

    // 3. 血不够 + 身边有怪 / 正在挨打 -> 拉开距离（1 档，不拼命跑）
    if (lvl === 1) this.reactByTier(hp, { near, underAttack })

    // 4. 被怪贴脸 -> 打（血 > 14 且怪不多才打；否则等 3 档去跑）
    if (this.canRetaliate()) {
      const close = this.nearestHostile(3.2)
      if (close) this.retaliate(close)
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
      this.lastPos = this._pos(p)
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

  /** 是不是敌对生物：先用白名单，再用 minecraft-data 的 category 兜底（新怪不用改代码） */
  isHostile (ent) {
    if (!ent || !ent.name) return false
    if (HOSTILE.has(ent.name)) return true
    try {
      const d = this.bot.registry && this.bot.registry.entitiesByName &&
        this.bot.registry.entitiesByName[ent.name]
      if (d) {
        if (d.type === 'hostile') return true
        if (/hostile/i.test(String(d.category || ''))) return true
      }
    } catch (e) {}
    return false
  }

  nearestHostile (range = 10) {
    const me = this.bot.entity
    if (!me || !me.position) return null
    let best = null
    let bestD = Infinity
    for (const e of Object.values(this.bot.entities || {})) {
      if (!e || e === me || !e.name || !e.position) continue
      if (!this.isHostile(e)) continue
      const d = this.dist(e.position, me.position)
      if (d <= range && d < bestD) { bestD = d; best = e }
    }
    return best
  }

  /** 附近敌对数量（决定要不要反打：只有 1~2 个才打） */
  hostileCount (range = 6) {
    const me = this.bot.entity
    if (!me || !me.position) return 0
    let n = 0
    for (const e of Object.values(this.bot.entities || {})) {
      if (!e || e === me || !e.name || !e.position) continue
      if (!this.isHostile(e)) continue
      if (this.dist(e.position, me.position) <= range) n++
    }
    return n
  }

  // 只有"pathfinder 说在走"但"实际没挪窝"时才算卡住
  checkStuck () {
    const bot = this.bot
    if (!bot.entity) return
    const p = bot.entity.position
    if (!this.lastPos) { this.lastPos = this._pos(p); this.stuckSince = 0; return }

    const moved = p.distanceTo(this.lastPos)
    this.lastPos = this._pos(p)

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
