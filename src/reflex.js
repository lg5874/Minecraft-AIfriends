'use strict'
// L0 反射层：不经过思考的下意识反应。
// 这一层是"像活人"的来源 —— 真人有反射，不需要先推理。

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const damage = require('./damage')

// 有毒食物：能吃，但腐肉有 80% 概率给 30 秒「饥饿」（越吃越饿），
// 蜘蛛眼/毒马铃薯/河豚各有各的负面效果 —— 只当最后一档，且吃的时候要说出来。
// （注意：**蘑菇不是食物** —— 1.21 的 foodsByName 里没有 brown_mushroom，
//   生蘑菇只能做煲。别为了"背包里还有蘑菇"去加它，consume 会直接失败。）
const POISON_FOOD = /^(rotten_flesh|spider_eye|poisonous_potato|pufferfish)$/
// 数据表拿不到时的兜底名字表（补了老正则漏掉的：浆果/海带/甜菜根/蜂蜜）
const FOOD_NAME = /bread|cooked_|apple|carrot|potato|beetroot|beef|porkchop|mutton|chicken|rabbit|salmon|cod|melon|baked|stew|kelp|berries|honey_bottle/

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
    this._sosSaid = []      // 15 分钟内喊过的求救话 {text, at}（不喊重样的）

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

    // MC 自然回血线：food >= 18 且饱和度 > 0 才回血。
    // 现场死循环就是卡在这 1 点（饿 17 → 不回血 → 血一直 7）。
    this.REGEN_FOOD = 18
    // 吃东西的冷却：同一个东西刚吃过就别连着吃（腐肉要更久，它会带回血副作用）
    this.FOOD_COOLDOWN_MS = 10000
    this.POISON_COOLDOWN_MS = 30000
    // "这东西对我没用"的记忆时长（吃了腐肉等于白吃，两分钟内不再指望它）
    this.NO_POISON_MS = 120000
    // 只剩毒食时，血低到这个数才允许吃（比 panic 线 5 高一点：真到要命了）
    this.POISON_HP = 6
    this._foodAt = {}
    this._noPoisonUntil = 0

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

  /** 方块能站吗（空气/水/岩浆都不算落脚点） */
  _standable (b) {
    if (!b || !b.name) return false
    return !/^(air|cave_air|water|lava|bubble_column|seagrass|tall_seagrass|kelp)$/.test(b.name)
  }

  /**
   * 掉下去会不会摔？水不算摔（能游），岩浆也不算"摔"——但岩浆会烫死人，
   * 这里只有"脚下有没有能承接的东西"这一个问题，所以水算承接。
   */
  _support (b) {
    if (!b || !b.name) return false
    return this._standable(b) || /^(water|kelp|seagrass|tall_seagrass|bubble_column)$/.test(b.name)
  }

  /**
   * 退之前先看落点：从脚下往 dir 方向退 1~2 格，那两格有能站的地方吗？
   *
   * 【2026-11-14 · 摔死的最后一环】`recoil()` 原来是"扭头就退 2 格 + 跳"，
   * **完全没有落点检查**。实测：
   *   [07:13:35] 3 秒内掉 6 血 —— 先退开 2 格 + 跳一下
   *   [07:13:38] 35.3 格 -> 摔死了
   * 掉 30 格 ≈ 掉 20 血（必死）；硬吃一下怪的攻击只掉 2~5 血。
   * **所以"不知道背后是什么"的时候就不该退。**
   * move-owner 在 actions.js 加的 `[ledge]` 50ms 闸是"退了之后兜底"，
   * 这里是"退之前就判断"，两层叠起来才稳（50ms 采样可能漏掉边缘）。
   */
  safeToStepBack (dir, steps = 2) {
    if (!dir || !isFinite(dir.x) || !isFinite(dir.z)) return false
    try {
      const bot = this.bot
      const p = bot.entity.position
      for (let k = 1; k <= Math.max(1, steps); k++) {
        const bx = Math.floor(p.x + dir.x * k)
        const by = Math.floor(p.y)
        const bz = Math.floor(p.z + dir.z * k)
        const feet = bot.blockAt(new Vec3(bx, by, bz))
        const head = bot.blockAt(new Vec3(bx, by + 1, bz))
        if (!feet || !head) return false
        if (this._standable(feet) || this._standable(head)) {
          // 第二格被墙挡住不算危险（退不到那么远）；第一格就挡着 = 压根退不动
          return k > 1
        }
        let support = false
        for (let dy = 1; dy <= 3; dy++) {
          if (this._support(bot.blockAt(new Vec3(bx, by - dy, bz)))) { support = true; break }
        }
        if (!support) return false                                         // 下面 3 格全空 = 崖/坑
      }
      return true
    } catch (e) {
      return false      // 判不出来就当不安全（宁可硬吃一下）
    }
  }

  /**
   * 挑一个能退的方向 + 退几格。
   *
   * 【两级退】2026-11-14 实机统计：只判"退 2 格"时 `退=4 / 不退=12`，
   * 75% 的情况站着不动 —— 挨打钉在原地蹦，不像活人。
   * 退 2 格要求太高，退 1 格最多也就掉 0.5 心，比硬吃 2~5 血划算。
   * 所以：2 格 -> 1 格 -> 都不行才原地跳。
   *
   * @returns {{dir:{x:number,z:number}, steps:number}|null}
   */
  pickRetreatDir () {
    const dirs = []
    try {
      const p = this.bot.entity.position
      const origin = this.attackOrigin()
      if (p && origin) {
        const dx = p.x - origin.x
        const dz = p.z - origin.z
        const len = Math.hypot(dx, dz)
        // 有来源就只往"背向来源"退：退不了宁可不退 ——
        // 往侧面/朝怪的方向退，等于把自己送到攻击范围里，还可能踩空。
        if (len > 0.1) {
          const away = { x: dx / len, z: dz / len }
          if (this.safeToStepBack(away, 2)) return { dir: away, steps: 2 }
          if (this.safeToStepBack(away, 1)) return { dir: away, steps: 1 }
          return null
        }
      }
      // 不知道来源：四个正方向里挑第一个脚下有地的
      dirs.push({ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 })
    } catch (e) {}
    for (const d of dirs) {
      if (this.safeToStepBack(d, 2)) return { dir: d, steps: 2 }
    }
    for (const d of dirs) {
      if (this.safeToStepBack(d, 1)) return { dir: d, steps: 1 }
    }
    return null
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

    // 【退之前看落点】没确认脚下有地方踩就不退 —— 掉 30 格必死，硬吃一下只掉 2~5 血
    let pick = null
    try { pick = this.pickRetreatDir() } catch (e) {}
    let mode = 'still'
    let steps = 0
    try {
      if (pick && pick.dir) {
        mode = 'back'
        steps = pick.steps || 1
        const dir = pick.dir
        // 面朝退路的反方向，"后退"才是往 dir 走
        try { bot.look(Math.atan2(dir.x, dir.z), 0, true) } catch (e) {}
        bot.setControlState('back', true)
        setTimeout(() => { try { bot.setControlState('back', false) } catch (e) {} }, steps >= 2 ? 420 : 240)
      }
      // 原地也要跳一下：脱离岩浆/营火/浆果丛这种站着就掉血的地方
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
    const act = mode === 'back'
      ? (steps >= 2 ? '先退开 2 格 + 跳一下' : '退 1 格（两格退不了）+ 跳一下')
      : (origin ? '退路上是坑/挡着，原地跳一下（不后退）' : '不知道背后是什么，原地跳一下（不后退）')
    this.logThrottled(`[reflex] 3 秒内掉 ${shown.toFixed(0)} 血${detail} —— ${why}，${act}`, 3000, 'recoil')
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
              '我在这底下 上不来', '完了 气不够了', '谁会游泳啊', '我卡水下了',
              '往上浮不动 拉我一把', '水里出不去 救命', '我快憋死了', '这片水怎么这么深']
            : (k === 'lava' || k === 'on_fire' || k === 'in_fire')
              ? ['着火了', '烫死我了', '我身上着火了', '我操 烧起来了',
                '快烧没了 谁有水', '烫死 我往回跑', '烧起来了 赶紧跑',
                '岩浆边上呢 别过来', '我脚底是岩浆', '烫 烫 烫', '快把我浇一下']
              : (hp <= 6
                  ? ['血不多了', '快撑不住了', '有人吗 我快不行了', '我快挺不住了 有吃的吗',
                    '我这边情况不太妙', '快没了 谁在附近', '我得缓一下 不然要交代在这',
                    '妈的 血见底了', '再不来人我就没了', '撑住 撑住',
                    '血就剩一点了', '我快被打死了', '来个人 我要没了', '谁有吃的 给我一口',
                    '站不住了', '我快交代了']
                  : ['血有点低', '我得缓一下', '先不折腾了 缓口气', '有点顶不住',
                    '让我坐会儿', '掉了点血 没事', '血不太满 先稳一下', '我歇会儿 别打岔',
                    '缓一下再弄'])

          // 【同一句 15 分钟内不喊第二遍】2026-11-14
          //
          // 现场：06:12:45「我快挺不住了 有吃的吗」，06:27:56 一字不差又来一遍
          // （随机从池子里抽，抽中了同一句）。talk.say() 的 30 分钟复读拦截现在
          // 能兜住它，但"兜住"= 这句直接没了 —— 血 3 卡洞里一声不吭更糟。
          // 所以在这里先挑没喊过的：池子里还有就换一句，全喊完了这次就不喊
          // （连着两句一模一样，比沉默更假）。
          const nowSay = Date.now()
          this._sosSaid = (this._sosSaid || []).filter(x => nowSay - x.at < 15 * 60 * 1000)
          const used = new Set(this._sosSaid.map(x => x.text))
          // 从"没喊过的"里精确抽一条：随机抽 12 次会漏 —— 池子只剩 1 条时
          // 约 46% 抽不中，明明还有新说法却提前静默了（和注释里说的"还有就换一句"不符）。
          const fresh = pool.filter(c => !used.has(c))
          const line = fresh.length ? fresh[Math.floor(Math.random() * fresh.length)] : null
          if (line) {
            this._sosSaid.push({ text: line, at: nowSay })
            if (this._sosSaid.length > 60) this._sosSaid.shift()
            this.ctx.say(line)
          } else {
            try { this.ctx.log('[sos 静默] 15 分钟里的说法都用过了，这次不重复喊') } catch (e) {}
          }
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

  /**
   * 背包里**能吃**的东西。
   *
   * 老写法是一条名字正则，漏了蜂蜜瓶/干海带/熟鲑鱼这类，也把 `rotten_flesh`
   * 这种吃了要中毒的算进来。1.21 的 `foodsByName` 数据表是现成的，优先用它，
   * 数据表不在才退回名字正则（宁可多吃，不可饿着）。
   */
  foodItems (opts = {}) {
    const items = (this.bot.inventory && this.bot.inventory.items && this.bot.inventory.items()) || []
    let byName = null
    try { byName = this.bot.registry && this.bot.registry.foodsByName } catch (e) {}
    const normal = []
    const poison = []
    for (const i of items) {
      if (!i || !i.name) continue
      const isPoison = Reflex.POISON_FOOD.test(i.name)
      // 数据表优先：1.21 的 foodsByName 认得出 beetroot / dried_kelp /
      // honey_bottle / sweet_berries / glow_berries 这些老正则漏掉的；
      // 表不在才退回名字正则（宁可多吃，不可饿着）。
      const edible = byName ? !!byName[i.name] : (Reflex.FOOD_NAME.test(i.name) || isPoison)
      if (!edible) continue
      ;(isPoison ? poison : normal).push(i)
    }
    // 正常食物按"回得多"排序；有毒的永远排最后
    const score = (n) => {
      try {
        const f = byName && byName[n]
        if (f) return (f.foodPoints || 0) + (f.saturationRatio || 0) / 10
      } catch (e) {}
      return 1
    }
    normal.sort((a, b) => score(b.name) - score(a.name))
    return opts && opts.includePoison ? normal.concat(poison) : normal
  }

  /**
   * 立刻吃一口，不看饥饿值（保命用）。
   *
   * 【2026-11-14 · 为什么加了日志和卡死保护】
   * 现场他血 7、饿 17 蹲了 4 分钟，日志里一行都没提吃 —— 因为老实现
   * **失败是全静默的**（没吃的就直接 return，equip/consume 失败也吞掉），
   * 排查时只能靠猜。现在三种结果都会说出来：
   *   · 没吃的      -> `[eat] 饿 17，想吃但背包里没吃的`
   *   · 吃到了      -> `[eat] 饿 17 < 18，吃一个 cooked_beef`
   *   · equip 失败  -> `[eat] 吃 cooked_beef 失败: ...`
   * 另外 `this.eating` 一旦卡住（equip 的 Promise 不回来）就永远不会再吃，
   * 所以 15 秒还没结束就当它卡了，强制复位。
   *
   * @returns {string|null} 吃了什么（null = 没吃成）
   */
  eatNow (why) {
    const bot = this.bot
    const now = Date.now()
    if (this.eating) {
      if (now - (this._eatingAt || 0) < 15000) return null
      this.eating = false
      this.logThrottled('[eat] 上回吃东西卡住了（15 秒没结束），强制复位再试', 30000, 'eatingStuck')
    }
    // 【同一个东西 N 秒内不重复吃】2026-11-14 现场：
    //   07:32:12 / 07:32:20 / 07:32:28 每 8 秒吃一次腐肉，饿一直 16 ——
    //   腐肉 +4 饱食但带 30 秒「饥饿」，净收益接近 0，于是 keepFed 每次都判"还没到 18"，
    //   又吃一次。冷却这道闸就是拦这个的。
    this._foodAt = this._foodAt || {}
    const cooling = (i) => (this._foodAt[i.name] || 0) > now
    const foods = this.foodItems().filter(i => !cooling(i))
    const poison = this.foodItems({ includePoison: true })
      .filter(i => Reflex.POISON_FOOD.test(i.name) && !cooling(i))

    if (!foods.length && !poison.length) {
      const hp = Math.round(bot.health)
      const any = this.foodItems({ includePoison: true })
      if (any.length) {
        // 有吃的但都在冷却里（刚吃过）—— 说一次就够，别刷屏
        this.logThrottled(`[eat] 饿 ${bot.food}，刚吃过 ${any[0].name}（冷却中），等一下再说`, 30000, 'foodCooling')
      } else {
        this.logThrottled(`[eat] 饿 ${bot.food}、血 ${hp}，想吃但背包里没吃的（背包 ${(bot.inventory.items() || []).length} 种）`, 60000, 'noFood')
      }
      return null
    }

    // 有正经食物就吃正经的
    let food = foods[0]
    if (!food) {
      // 【只剩毒食】不饿到要命、或者刚吃过它没用 -> 忍着，去找正经吃的。
      // "忍着"比"吃腐肉"对：腐肉的饥饿效果是负收益，吃了等于白搭一条命的时间。
      const hp = typeof bot.health === 'number' ? bot.health : 20
      const remembered = now < (this._noPoisonUntil || 0)
      if (hp > this.POISON_HP || remembered) {
        const why = remembered
          ? '刚吃过它，饱食度又被饥饿吃回去了'
          : `血还有 ${Math.round(hp)}，没到 ${this.POISON_HP} 的救命线`
        this.logThrottled(`[eat] 只有 ${poison[0].name}，但它会让我更饿（${why}）—— 忍着，去找正经吃的`, 60000, 'poisonHold')
        return null
      }
      food = poison[0]
      this.logThrottled(`[eat] 血 ${Math.round(hp)} ≤ ${this.POISON_HP}，没别的吃的，只能垫 ${food.name}（腐肉有 80% 概率给 30 秒「饥饿」）`, 30000, 'eatPoison')
      // 记一句"这东西对我不顶饱"：两分钟内不再指望它
      this._noPoisonUntil = now + this.NO_POISON_MS
      this._foodAt[food.name] = now + this.POISON_COOLDOWN_MS
    } else {
      this._foodAt[food.name] = now + this.FOOD_COOLDOWN_MS
    }
    this.eating = true
    this._eatingAt = now
    bot.equip(food, 'hand')
      .then(() => bot.consume())
      .then(() => { this._lastAte = { name: food.name, at: Date.now(), why: why || '' } })
      .catch((e) => {
        this.logThrottled(`[eat] 吃 ${food.name} 失败: ${e && e.message ? e.message : e}`, 30000, 'eatFail')
      })
      .finally(() => { this.eating = false })
    return food.name
  }

  /**
   * 维持"回血线"：饿 < 18 又有吃的就吃。
   *
   * MC 的自然回血条件是 **food >= 18 且饱和度 > 0**。现场就是这么卡死的：
   * 血 7、饿 17（差 1 点）→ 永远不回血 → 一直躺在那 → 怪一来就死。
   * 原来"吃"只在血低档位里做一次，而且失败是静默的。
   *
   * 这不是新行为，是把「吃」从"快死了才吃"修成"饿到回血线以下就吃"。
   * 不做过头：血是满的就不吃（省食物）。
   */
  keepFed () {
    const bot = this.bot
    const food = bot.food
    const hp = bot.health
    if (typeof food !== 'number' || typeof hp !== 'number' || !isFinite(food)) return null
    if (typeof hp !== 'number' || hp <= 0) return null

    if (food < this.REGEN_FOOD) {
      // 【口径】饿 < 18 就吃，不看血量 —— 17 意味着"永远不回血"，
      // 等血掉了再补已经晚了两下。省一口食物<多一条命。
      const ate = this.eatNow('regen')
      if (ate) {
        const busy = this.isBusy()
        this.logThrottled(`[eat] 饿 ${food} < ${this.REGEN_FOOD}（这条线以下不自然回血）${busy ? '，正在干活也先吃' : ''}，吃一个 ${ate}`, 8000, 'eatRegen')
      }
      return ate
    }

    // 已经在回血线以上：什么都不做，但要能证明"没吃"
    if (hp < 20) {
      this.logThrottled(`[eat] 饿 ${food} ≥ ${this.REGEN_FOOD}，会自然回血，先不吃`, 300000, 'eatSkip')
    }
    return null
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

    // ===== 回血线（2026-11-14）=====
    // 【为什么要放在分档之前】血低档位里那句 eatNow 是"救命吃"，
    // 但现场的死法是"饿 17 卡在回血线下面 → 一直不回血 → 被拖死"。
    // 吃这件事得在**还没到救命档**的时候就开始做，而且血低时也要继续做。
    // 只在真的在干活（busy）且还没饿到危险程度时让路，别为了一口饭打断任务。
    // 干活时也让吃：饿 17 就是"永远不回血"，为了一口饭打断 1.6 秒，
    // 比"挖着挖着血见底"便宜得多（实测他就是边干边掉到血 7 的）。
    try { this.keepFed() } catch (e) {}

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

Reflex.POISON_FOOD = POISON_FOOD
Reflex.FOOD_NAME = FOOD_NAME

module.exports = Reflex
