'use strict'
/**
 * 事件队列。
 *
 * 解决的根本问题：**他现在靠轮询，事情不会主动找上他。**
 *
 * 原来的样子：
 *   while(true) { sleep(4s); if(危险) 处理; if(空闲) 想目标 }
 *   所以"张三刚说了句话""有只苦力怕在靠近""有人路过"
 *   全都要等到下一次轮询才知道，或者根本不知道。
 *
 * 改成：
 *   所有事情先进队列，队列自己判断"现在熟没熟"。
 *   急件（被打、被叫名字）立刻叫醒；不急的（有人路过）攒一会儿一起处理。
 *
 * 设计参考 numen 的 EventQueue：
 *   - 队列只是台账，不是调度员
 *   - 急不急在入队那一刻就定了
 *   - 满了先丢最老的不急件，但如实告诉模型"你看到的是残片"
 *
 * ============================================================
 * 本次补全（perception-owner）
 * ============================================================
 * 之前只接了 8 种：chat / damage / playerJoin / playerLeave / death /
 * attack_by_player / inventory_full / goal_fail。
 *
 * 现在 27 种，每种都写了触发条件（TYPES[type].src）。
 *
 * 补的入口全部是**语义化方法**（pushHealth / pushTime / pushWeather …）：
 * main.js 里每个监听器只需要一行 `if (this.events) this.events.pushXxx(bot)`，
 * 判断、节流、去重、格式化全在这个文件里。这样 main.js 不被污染，
 * 加事件源也不用动主循环。
 *
 * 两个关键机制：
 *   1. **合并（cooldown + dedupeKey）**：方块变化这种洪水事件，
 *      同一个 key 在 cooldown 内只留一条，次数累加到 count。
 *      否则 10 秒就能把 60 条容量塞满，别的事全被挤掉。
 *   2. **半径过滤（radius）**：只关心身边的方块变化。
 *      远处别人挖矿跟你没关系，但会把你的事件槽位吃光。
 */

const DEFAULT_CAP = 60

// Minecraft 一天的刻数
const DAY_TICKS = 24000

/**
 * 事件类型表。
 *
 * urgent: 入队后是否立刻叫醒主循环
 * label:  默认描述（push 时没传 what 就用它）
 * src:    触发条件 —— 以后补监听时照这一行对，别猜
 */
const TYPES = {
  // ==================== 急件：入队立刻叫醒 ====================
  chat_me: {
    urgent: true,
    label: '有人跟你说话',
    src: 'bot.on("chat")：消息里出现你的名字 / 以「你」开头 / 是问句'
  },
  damage: {
    urgent: true,
    label: '你受伤了',
    src: 'bot._client.on("damage_event")：伤害来源是环境（摔/火/溺水/岩浆/仙人掌…）'
  },
  attack_by_player: {
    urgent: true,
    label: '有人打你',
    src: 'bot._client.on("damage_event")：sourceCauseId 解析出是一个玩家实体'
  },
  death: {
    urgent: true,
    label: '你死了',
    src: 'bot.on("death")'
  },
  danger: {
    urgent: true,
    label: '有威胁靠近',
    src: '反射层（reflex.js）判定敌对生物进入威胁半径时推'
  },
  demand: {
    urgent: true,
    label: '有人要你做某事',
    src: '对话层（talk.js）识别出祈使句 / 明确的请求时推'
  },
  gift: {
    urgent: true,
    label: '有人给你东西',
    src: '玩家丢东西到你脚下，或通过指令给你物品时推'
  },

  // ==================== 不急：攒够 3 条或过 20 秒一起处理 ====================
  chat_any: {
    urgent: false,
    label: '有人说话',
    src: 'bot.on("chat")：普通聊天，没叫你'
  },
  player_join: {
    urgent: false,
    label: '有人上线',
    src: 'bot.on("playerJoined")'
  },
  player_leave: {
    urgent: false,
    label: '有人下线',
    src: 'bot.on("playerLeft")'
  },
  player_near: {
    urgent: false,
    label: '有人走到你旁边',
    src: 'bot.on("entityMoved") → pushProximity：某玩家从 >8 格进入 <=8 格'
  },
  player_far: {
    urgent: false,
    label: '有人走开了',
    src: 'bot.on("entityMoved") → pushProximity：某玩家从 <=8 格离开到 >12 格'
  },

  // ---- 世界变化（本次新接）----
  block_change: {
    urgent: false,
    label: '附近方块变了',
    src: 'bot.on("blockUpdate") → pushBlockChange：8 格内、非空气、8 秒内同类合并'
  },
  block_broken: {
    urgent: false,
    label: '你挖掉了一个方块',
    src: 'bot.on("blockBreakProgressObserved") → pushDig：自己挖的方块（同坐标 60 秒只记一次）'
  },
  item_pickup: {
    urgent: false,
    label: '你捡到东西',
    src: 'bot.on("playerCollect") → pushCollect：collector 是你自己'
  },
  inventory_full: {
    urgent: false,
    label: '背包满了',
    src: 'selfstate.js tick()：已用格数从 <34 跨到 >=34'
  },
  inventory_change: {
    urgent: false,
    label: '背包变了',
    src: 'selfstate.js tick()：某种物品数量变化超过阈值'
  },
  health_low: {
    urgent: false,
    label: '你血量很低',
    src: 'bot.on("health") → pushHealth：血 <=6 且之前不低'
  },
  hunger_low: {
    urgent: false,
    label: '你饿了',
    src: 'bot.on("health") → pushHealth：饱食度 <=6 且之前不低'
  },
  time_change: {
    urgent: false,
    label: '天色变了',
    src: 'bot.on("time") → pushTime：昼夜阶段切换（白天/黄昏/夜晚/黎明）'
  },
  weather_change: {
    urgent: false,
    label: '天气变了',
    src: 'bot.on("rain") / bot.on("weatherUpdate") → pushWeather：下雨或打雷状态翻转'
  },

  // ---- 自己 / 进度 ----
  exp_gain: {
    urgent: false,
    label: '你涨经验了',
    src: 'bot.on("experience") → pushExp：等级上升'
  },
  goal_done: {
    urgent: false,
    label: '做完一件事',
    src: '任务层完成一个目标时推'
  },
  goal_fail: {
    urgent: false,
    label: '一件事没成',
    src: '任务层失败时推；selfstate.js 检测到工具消失也推这里'
  },
  stuck: {
    urgent: false,
    label: '你卡住了',
    src: '主循环发现 30 秒位置没变但 busy=true 时推'
  },
  found_something: {
    urgent: false,
    label: '你发现了什么',
    src: '感知层发现新的矿石/结构/村庄等值得记的地标时推'
  },

  // ---- 连接 ----
  respawn: {
    urgent: false,
    label: '你复活了',
    src: 'bot.on("respawn") → pushRespawn'
  },
  kick: {
    urgent: true,
    label: '你被服务器踢了',
    src: 'bot.on("kicked") → pushKick'
  }
}

/** 昼夜阶段：0-11999 白天，12000-13799 黄昏，13800-22199 夜晚，22200+ 黎明 */
function dayPhase (timeOfDay) {
  if (timeOfDay == null || !Number.isFinite(timeOfDay)) return null
  const t = ((timeOfDay % DAY_TICKS) + DAY_TICKS) % DAY_TICKS
  if (t < 12000) return 'day'
  if (t < 13800) return 'dusk'
  if (t < 22200) return 'night'
  return 'dawn'
}

const PHASE_WORD = {
  day: '天亮了，白天',
  dusk: '天快黑了',
  night: '天黑了，晚上',
  dawn: '天快亮了'
}

/** 安全取 bot 的某个字段，断了就返回 undefined，不抛 */
function safe (fn, fallback) {
  try {
    const v = fn()
    return v === undefined ? fallback : v
  } catch (e) {
    return fallback
  }
}

class EventQueue {
  constructor (opts = {}) {
    this.cap = opts.cap || DEFAULT_CAP
    this.events = []          // { type, what, at, lastAt, count, urgent, data, read }
    this.wakers = []          // 注册的"叫醒"回调
    this.dropped = 0          // 丢了多少条（用来告诉模型"你看到的是残片"）
    this.lastDrainAt = 0
    this.log = opts.log || (() => {})

    // 语义化入口用的记忆（别塞进 events，这些是"上次看到的值"）
    this._lastHealth = null
    this._lastFood = null
    this._lastPhase = null
    this._lastRaining = null
    this._lastThunder = null
    this._lastExpLevel = null
    this._prox = {}           // 玩家名 -> { near: bool, at: number }
    this._lastProxAt = 0
  }

  /**
   * 推一个事件。
   *
   * @param {string} type   TYPES 里的键
   * @param {object} [data] 附加数据（会原样留给上层）
   * @param {string} [what] 自定义描述（不写就按类型生成）
   * @param {object} [opts] 可选行为：
   *   - cooldown {number}   合并窗口（毫秒）。同一个 dedupeKey 在这个窗口内
   *                         只留一条，后续的累加 count，不新增条目。
   *   - dedupeKey {string}  合并键。不传时用 type。
   *   - whatUpdate {bool}   合并时用最新一次的 what 覆盖旧描述（默认 false）
   *   - silent {bool}       不入队、不叫醒，只返回（用于预热基线或纯计数）
   *
   * 半径过滤不放在这里：它需要方块位置，属于事件源自己的活儿
   *（见 pushBlockChange）。队列只管台账。
   *
   * @returns {object|null} 入队的事件；silent 时返回未入队的临时事件
   */
  push (type, data = {}, what, opts = {}) {
    const def = TYPES[type]
    if (!def) {
      this.log('[event] 未知事件类型: ' + type)
      return null
    }

    const now = Date.now()

    // ---- 合并：洪水事件不新增条目，只累加 ----
    if (opts.cooldown > 0) {
      const key = opts.dedupeKey || type
      const exist = this.events.find(
        e => e._key === key && !e.read && now - e.at < opts.cooldown
      )
      if (exist) {
        exist.count = (exist.count || 1) + 1
        exist.lastAt = now
        if (opts.whatUpdate && what) exist.what = what
        if (data && typeof data === 'object') exist.data = Object.assign({}, exist.data, data)
        return exist
      }
    }

    const ev = {
      type,
      urgent: def.urgent,
      what: what || def.label,
      at: now,
      lastAt: now,
      count: 1,
      data,
      read: false,
      _key: opts.cooldown > 0 ? (opts.dedupeKey || type) : null
    }

    if (opts.silent) return ev

    this.events.push(ev)

    // 超容量：先丢最老的不急件
    if (this.events.length > this.cap) {
      const idx = this.events.findIndex(e => !e.urgent && !e.read)
      if (idx >= 0) {
        this.events.splice(idx, 1)
        this.dropped++
      } else {
        this.events.shift()
        this.dropped++
      }
    }

    // 急件立刻叫醒
    if (ev.urgent) this.wake(ev)
    return ev
  }

  // ============================================================
  // 语义化入口
  // 每个方法对应 main.js 里的一行 `if (this.events) this.events.pushXxx(...)`
  // 全部自己 try/catch，断了也不会把主循环带崩
  // ============================================================

  /**
   * 血量 / 饱食度变化。
   * 触发条件：血 <=6 且之前 >6；或饱食度 <=6 且之前 >6。
   * 不做"每掉一点血就报一次"——那样他会一直在喊疼。
   */
  pushHealth (bot) {
    try {
      const hp = safe(() => Math.round(bot.health), null)
      const food = safe(() => Math.round(bot.food), null)

      if (hp != null) {
        const prev = this._lastHealth
        this._lastHealth = hp
        if (prev != null && hp <= 6 && prev > 6) {
          this.push('health_low', { health: hp }, `你血很低了（${hp}/20），得躲一下`, { cooldown: 15000 })
        }
      }

      if (food != null) {
        const prev = this._lastFood
        this._lastFood = food
        if (prev != null && food <= 6 && prev > 6) {
          this.push('hunger_low', { food }, `你饿得不行了（${food}/20），再不吃就走不动了`, { cooldown: 30000 })
        }
      }
    } catch (e) {
      this.log('[event] pushHealth 出错: ' + e.message)
    }
  }

  /**
   * 时间流逝。
   * 触发条件：昼夜阶段切换（白天/黄昏/夜晚/黎明）。
   * 注意：bot.on('time') 每 20 tick 就触发一次，绝不能每次都推。
   */
  pushTime (bot) {
    try {
      const tod = safe(() => bot.time.timeOfDay, null)
      const phase = dayPhase(tod)
      if (!phase) return
      const prev = this._lastPhase
      this._lastPhase = phase
      if (prev == null) return            // 第一次只建基线
      if (prev === phase) return
      // dedupeKey 必须带上 phase：黄昏→夜晚是两件事，
      // 用同一个 key 会在 5 秒窗口内把第二件吞掉。
      this.push('time_change', { phase, prev, timeOfDay: tod }, PHASE_WORD[phase], {
        cooldown: 5000,
        dedupeKey: 'time:' + phase
      })
    } catch (e) {
      this.log('[event] pushTime 出错: ' + e.message)
    }
  }

  /**
   * 天气变化。
   * 触发条件：下雨状态翻转，或雷暴等级从 0 变成非 0。
   */
  pushWeather (bot) {
    try {
      const raining = safe(() => !!bot.isRaining, null)
      const thunder = safe(() => (bot.thunderState || 0) > 0, false)
      const prevRain = this._lastRaining
      const prevThunder = this._lastThunder
      this._lastRaining = raining
      this._lastThunder = thunder

      if (prevRain == null) return         // 第一次只建基线

      if (raining !== prevRain) {
        this.push(
          'weather_change',
          { raining, thunder },
          raining ? '开始下雨了' : '雨停了',
          { cooldown: 8000, dedupeKey: 'weather:rain:' + raining }
        )
        return
      }
      if (thunder !== prevThunder) {
        this.push(
          'weather_change',
          { raining, thunder },
          thunder ? '打雷了' : '雷声停了',
          { cooldown: 8000, dedupeKey: 'weather:thunder:' + thunder }
        )
      }
    } catch (e) {
      this.log('[event] pushWeather 出错: ' + e.message)
    }
  }

  /**
   * 捡起东西。
   * 触发条件：playerCollect 的 collector 是自己（不是别人捡走了）。
   * 别人捡走你脚下的东西也值得知道 —— 那种走 "found_something" 语义太重，
   * 这里只用 item_pickup 记自己捡的。
   */
  pushCollect (collector, collected, bot) {
    try {
      const me = safe(() => bot.entity, null)
      if (!me || !collector || collector.id !== me.id) return

      const name = safe(() => (collected && (collected.name || collected.displayName)), null) ||
        safe(() => (collected && collected.entityType), '东西')
      const label = String(name).replace(/_/g, ' ')
      this.push('item_pickup', { item: name }, `你捡起了 ${label}`, { cooldown: 2000 })
    } catch (e) {
      this.log('[event] pushCollect 出错: ' + e.message)
    }
  }

  /**
   * 附近方块变化。
   * 触发条件：blockUpdate 且新方块在 8 格内、不是空气、不是你自己在挖的那格。
   *
   * 这是最容易洪水的事件：一个 TNT 爆炸能推几百条。
   * 所以：8 格半径 + 按 (from -> to) 分类 + 8 秒合并。
   */
  pushBlockChange (oldBlock, newBlock, bot) {
    try {
      if (!newBlock || !newBlock.position) return
      const p = safe(() => bot.entity.position, null)
      if (!p) return

      const from = (oldBlock && oldBlock.name) || '空气'
      const to = (newBlock && newBlock.name) || '空气'
      if (from === to) return
      // 空气 -> 空气（区块刷新）没意义
      if (from === 'air' && to === 'air') return

      const d = newBlock.position.distanceTo(p)
      if (!Number.isFinite(d) || d > 8) return

      const word = name => (/^(air|cave_air)$/.test(name) ? '空气' : name.replace(/_/g, ' '))
      const what = from === '空气' || from === 'air' || from === 'cave_air'
        ? `附近有人放了 ${word(to)}`
        : to === 'air' || to === 'cave_air'
          ? `附近有 ${word(from)} 被挖掉了`
          : `附近 ${word(from)} 变成了 ${word(to)}`

      this.push(
        'block_change',
        { from, to, at: { x: newBlock.position.x, y: newBlock.position.y, z: newBlock.position.z }, dist: d },
        what,
        { cooldown: 8000, dedupeKey: `block:${from}>${to}`, whatUpdate: true }
      )
    } catch (e) {
      this.log('[event] pushBlockChange 出错: ' + e.message)
    }
  }

  /**
   * 自己挖掉一个方块。
   *
   * 触发条件：blockBreakProgressObserved（挖的时候服务端会连续推 0..9 十个阶段）。
   *
   * 为什么不用 diggingCompleted：那个事件传的是**挖完之后填进去的空气方块**
   * （mineflayer digging.js: `bot.emit('diggingCompleted', newBlock)`，
   * 而 newBlock.type === 0 就是它判定完成的条件）。拿它做"挖掉了什么"，
   * 名字永远是 air，等于什么都没记录。
   *
   * 两道过滤：
   *   1. entity 不是自己 -> 是别人在挖，跳过
   *   2. 同一个坐标 60 秒内只记一次 -> 十个破坏阶段只算挖掉一块
   */
  pushDig (block, bot, entity) {
    try {
      if (!block || !block.name || !block.position) return
      if (/^(air|cave_air)$/.test(block.name)) return

      // 别人挖的
      const me = safe(() => bot.entity, null)
      if (entity && me && entity.id !== me.id) return

      const pos = block.position
      const posKey = `${pos.x},${pos.y},${pos.z}`
      const now = Date.now()

      // 同一个方块的十个破坏阶段只算一次
      this._digSeen = this._digSeen || new Map()
      const seenAt = this._digSeen.get(posKey)
      if (seenAt && now - seenAt < 60000) return
      this._digSeen.set(posKey, now)

      // 别让这张表无限长
      if (this._digSeen.size > 200) {
        for (const [k, t] of this._digSeen) {
          if (now - t > 60000) this._digSeen.delete(k)
        }
      }

      const label = block.name.replace(/_/g, ' ')
      this.push('block_broken', { block: block.name, pos: posKey }, `你挖掉了 ${label}`, {
        cooldown: 6000,
        dedupeKey: 'dig:' + block.name,
        whatUpdate: true
      })
    } catch (e) {
      this.log('[event] pushDig 出错: ' + e.message)
    }
  }

  /**
   * 经验变化。
   * 触发条件：等级上升（不是每次经验球都报）。
   */
  pushExp (bot) {
    try {
      const lv = safe(() => bot.experience.level, null)
      if (lv == null) return
      const prev = this._lastExpLevel
      this._lastExpLevel = lv
      if (prev == null || lv <= prev) return
      this.push('exp_gain', { level: lv, prev }, `你升到 ${lv} 级了`, { cooldown: 10000 })
    } catch (e) {
      this.log('[event] pushExp 出错: ' + e.message)
    }
  }

  /**
   * 玩家远近变化。
   * 触发条件：某玩家从 >8 格进到 <=8 格（player_near），
   *           或从 <=8 格退到 >12 格（player_far）。
   * 8 进 12 出的滞回区间防止边界抖动刷屏。
   *
   * entityMoved 每 tick 会触发几十次，所以先做 2 秒节流，
   * 再做距离判断 —— 开销只有几十次减法。
   */
  pushProximity (bot) {
    try {
      const now = Date.now()
      if (now - this._lastProxAt < 2000) return
      this._lastProxAt = now

      const me = safe(() => bot.entity, null)
      if (!me || !me.position) return
      const players = safe(() => bot.players, null)
      if (!players) return

      const NEAR = 8
      const FAR = 12

      for (const [name, pl] of Object.entries(players)) {
        if (name === safe(() => bot.username, null)) continue
        const ent = pl && pl.entity
        if (!ent || !ent.position) continue
        const d = ent.position.distanceTo(me.position)
        if (!Number.isFinite(d)) continue

        const rec = this._prox[name] || { near: false }
        if (!rec.near && d <= NEAR) {
          rec.near = true
          rec.at = now
          this._prox[name] = rec
          this.push('player_near', { who: name, dist: d }, `${name} 走到你旁边了`, { cooldown: 10000 })
        } else if (rec.near && d > FAR) {
          rec.near = false
          rec.at = now
          this._prox[name] = rec
          this.push('player_far', { who: name, dist: d }, `${name} 走开了`, { cooldown: 15000 })
        }
      }
    } catch (e) {
      this.log('[event] pushProximity 出错: ' + e.message)
    }
  }

  /**
   * 被踢。
   * 触发条件：bot.on('kicked')。这条是急件——被踢了他得知道是为什么。
   */
  pushKick (reason) {
    try {
      let text = ''
      if (typeof reason === 'string') text = reason
      else if (reason && typeof reason === 'object') {
        text = reason.text || reason.message || reason.reason || JSON.stringify(reason)
      }
      text = String(text || '不知道原因').slice(0, 120)
      this.push('kick', { reason: text }, `你被服务器踢了：${text}`)
    } catch (e) {
      this.log('[event] pushKick 出错: ' + e.message)
    }
  }

  /**
   * 复活。
   * 触发条件：bot.on('respawn')。复活点位置会跟着记下来，
   * 因为"我从哪爬起来"直接影响接下来该干嘛。
   */
  pushRespawn (bot) {
    try {
      const p = safe(() => bot.entity.position, null)
      const where = p ? `（${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}）` : ''
      this.push('respawn', { pos: p ? { x: p.x, y: p.y, z: p.z } : null }, `你复活了${where}`, { cooldown: 5000 })
    } catch (e) {
      this.log('[event] pushRespawn 出错: ' + e.message)
    }
  }

  /** 注册"被叫醒"回调 */
  onWake (fn) { this.wakers.push(fn) }

  wake (ev) {
    for (const fn of this.wakers) {
      try { fn(ev) } catch (e) {}
    }
  }

  /**
   * 现在熟没熟？
   * 规则很简单：有急件 -> 熟；不急的攒够 3 条或者过了 20 秒 -> 熟。
   */
  ripe () {
    const unread = this.events.filter(e => !e.read)
    if (!unread.length) return { ripe: false, reason: 'empty' }

    const urgent = unread.filter(e => e.urgent)
    if (urgent.length) return { ripe: true, reason: 'urgent', count: urgent.length }

    const oldest = unread[0]
    const age = Date.now() - oldest.at
    if (unread.length >= 3) return { ripe: true, reason: 'batch', count: unread.length }
    if (age > 20000) return { ripe: true, reason: 'timeout', count: unread.length }
    return { ripe: false, reason: 'waiting', count: unread.length }
  }

  /** 取出所有未读（标记已读） */
  drain () {
    const out = this.events.filter(e => !e.read)
    for (const e of out) e.read = true
    this.lastDrainAt = Date.now()
    return out
  }

  /** 只取急件 */
  drainUrgent () {
    const out = this.events.filter(e => !e.read && e.urgent)
    for (const e of out) e.read = true
    return out
  }

  /** 最近 N 毫秒内发生的事（给感知用，不标记已读） */
  recent (ms = 45000) {
    const now = Date.now()
    return this.events
      .filter(e => now - (e.lastAt || e.at) <= ms)
      .slice(-12)
  }

  /** 清掉很旧的 */
  prune (maxAgeMs = 300000) {
    const now = Date.now()
    this.events = this.events.filter(e => now - (e.lastAt || e.at) <= maxAgeMs)
  }

  /** 把一批事件翻译成给模型看的话 */
  describe (events) {
    if (!events || !events.length) return ''
    const now = Date.now()
    const lines = events.map(e => {
      const t = e.lastAt || e.at
      const ago = Math.max(1, Math.round((now - t) / 1000))
      const n = e.count || 1
      const times = n > 1 ? `（共 ${n} 次）` : ''
      return `- ${ago} 秒前：${e.what}${times}`
    })
    if (this.dropped > 0) {
      lines.push(`（还有 ${this.dropped} 条更早的事没来得及记，你看到的是残片）`)
      this.dropped = 0
    }
    return lines.join('\n')
  }

  /** 状态（调试用） */
  stats () {
    const unread = this.events.filter(e => !e.read)
    return {
      total: this.events.length,
      unread: unread.length,
      urgent: unread.filter(e => e.urgent).length,
      dropped: this.dropped,
      // 按类型分组，方便看哪一类在刷屏
      byType: unread.reduce((acc, e) => {
        acc[e.type] = (acc[e.type] || 0) + (e.count || 1)
        return acc
      }, {})
    }
  }
}

module.exports = { EventQueue, TYPES, dayPhase }
