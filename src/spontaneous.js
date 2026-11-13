'use strict'
/**
 * 主动开口。
 *
 * 真人不会等你说话才说话。他挖到钻石会喊一声，
 * 看到你在打架会问要不要帮忙，发现个洞会说"这有个洞"。
 *
 * 但不是话痨。所以这里做的是：**先判断这事值不值得说，再决定说不说。**
 * 说了什么，全部现编，不预设。
 *
 * ------------------------------------------------------------------
 * 触发源分三类（UNHUMAN-SCAN #3 / #14）
 * ------------------------------------------------------------------
 *   social   对人：有人上线/下线/走到旁边/并肩站着/朋友挨打
 *   complain 吐槽：死了、卡住、找不到
 *   thing    对事：挖到东西、走到新地形、目标做完了
 *
 * 排队优先级 social > complain > thing ——
 * "有人上线了"必须比"我想去挖矿"更早被说出来，晚了就没意义了。
 */

const realtime = require('./realtime')
const { Watched } = require('./audience')
// 代价层：把"白干了一趟"这笔记账说出来（素材从这儿取，话由模型组）
let costMod = null
try { costMod = require('./cost') } catch (e) { costMod = null }

/** 事件排序用：数字越小越优先 */
const RANK = { social: 0, complain: 1, thing: 2 }

/** 吐槽类的判定（事件描述里出现这些词就是"不顺"） */
const COMPLAIN_RE = /死了|找不到|失败|卡住|差点|走错|奇怪|运气/

// ==================================================================
// 值得主动开口的时机
// 每一项返回 {situation, chance, maxLen, ...} 或者 null
// ==================================================================

/** 挖到好东西 */
function onValuableFind (item, count) {
  const bigValue = ['diamond', 'emerald', 'ancient_debris', 'netherite_scrap', 'golden_apple', 'enchanted_golden_apple']
  const midValue = ['iron_ingot', 'gold_ingot', 'redstone', 'lapis_lazuli', 'amethyst_shard']
  const name = String(item || '')

  if (bigValue.some(v => name.includes(v))) {
    return {
      situation: `你刚挖到了 ${name} x${count || 1}，这是好东西。`,
      chance: 0.7,
      maxLen: 30,
      trigger: 'valuableFind',
      priority: 'thing'
    }
  }
  if (midValue.some(v => name.includes(v)) && (count || 1) >= 5) {
    return {
      situation: `你挖到了 ${count} 个 ${name}，算小有收获。`,
      chance: 0.3,
      maxLen: 25,
      trigger: 'valuableFind',
      priority: 'thing'
    }
  }
  return null
}

/** 第一次到某个新地形/结构 */
function onNewTerrain (what) {
  if (!what) return null
  return {
    situation: `你走到了一片没见过的 ${what}。`,
    chance: 0.45,
    maxLen: 30,
    trigger: 'newTerrain',
    priority: 'thing'
  }
}

/** 看到别人在挨打 / 快死了 */
function onFriendInDanger (name, health) {
  if (!name) return null
  return {
    situation: `${name} 快死了（血 ${health}），或者正在被怪打。`,
    chance: 0.8,
    maxLen: 30,
    people: [name],
    trigger: 'friendInDanger',
    priority: 'social'
  }
}

/** 看到别人在挖矿/干活，想搭话 */
function onFriendBusy (name, what) {
  return {
    situation: `${name} 在${what || '忙着'}，你正好路过。`,
    chance: 0.25,
    maxLen: 25,
    people: [name],
    trigger: 'friendBusy',
    priority: 'social',
    // 自己在干活时就不特意停下来搭话（和"有人来了"不一样，那个必须抬头）
    busyExempt: false
  }
}

/** 自己差点死 */
function onNearDeath (how) {
  return {
    situation: `你差点死了：${how}。现在活下来了，血不多。`,
    chance: 0.6,
    maxLen: 30,
    trigger: 'nearDeath',
    priority: 'complain'
  }
}

/** 干成了一件事，而且是自己一直想干的 */
function onGoalDone (goal, how) {
  // 注意：how 是程序返回的执行结果，里面全是数字和方块名。
  // 绝对不能原样塞给模型，不然他会念出来（"挖了脚边的andesite（mine返回1）"）。
  return {
    situation: `你刚把「${goal}」这件事做完了。`,
    chance: 0.4,
    maxLen: 20,
    trigger: 'goalDone',
    priority: 'thing'
  }
}

/** 时间很晚了 */
function onLateNight () {
  const t = realtime.realTime()
  const p = realtime.timeRemarkChance(t)
  if (p < 0.1) return null
  return {
    situation: `现在是 ${t.text}，挺晚了。你还在游戏里。`,
    chance: p,
    maxLen: 25,
    trigger: 'lateNight',
    priority: 'thing'
  }
}

function whoIs (name, familiar, tail) {
  return familiar
    ? `${name}${tail}，是老熟人了。`
    : `有人${tail}（${name}），你不太认识。`
}

/**
 * 有人上线
 *
 * 【UNHUMAN-SCAN #3 · 实测 0/54】
 * 25 分钟里玩家进出 54 次，他一次招呼都没打。
 * 旧实现三层叠加把这事掐死：队列上限 6（前 48 条直接丢）+ chance 0.5 + 90 秒冷却。
 *
 * #3 要求的是"有人进来必须抬头看一眼"，所以这里：
 *   · chance 0.85
 *   · priority: 'social' + instant: true —— 走社交通道，不吃"对事"的 90 秒冷却
 *   · 熟人喊名字，生人只说"有人来了"，别对每个人都热情得不像话
 */
function onPlayerJoin (name, opts = {}) {
  const familiar = opts.familiar === true
  return {
    situation: familiar
      ? `${name} 上线了，是老熟人了。`
      : `有人上线了（${name}），你不太认识。`,
    chance: 0.85,
    maxLen: 20,
    people: [name],
    trigger: 'playerJoin',
    priority: 'social',
    instant: true
  }
}

function onPlayerLeave (name, opts = {}) {
  const familiar = opts.familiar === true
  return {
    situation: familiar
      ? `${name} 下线了，走得挺突然。`
      : `${name} 下线了。`,
    chance: 0.35,          // 下线比上线安静些，别每次都喊
    maxLen: 20,
    people: [name],
    trigger: 'playerLeave',
    priority: 'social',
    instant: true
  }
}

/**
 * 【UNHUMAN-SCAN #14】有人靠近我（8 格内）
 *
 * 原来主动说话的触发源里**没有"人"这一类** ——
 * 8 次 [say] 里 "玩家上下线 0 / 玩家说话 0 / 主动搭话 0"。
 * 真人看到一个玩家走到旁边，会瞟一眼、说句"哟"或者问一句在干嘛。
 *
 * chance 只给 0.3：每次都招呼就成 NPC 了。
 */
function onPlayerNearby (name, dist, opts = {}) {
  const familiar = opts.familiar === true
  return {
    situation: familiar
      ? `${name} 走到你旁边了（${Math.round(dist || 0)} 格），是老熟人。`
      : `有个不太认识的玩家 ${name} 在你旁边（${Math.round(dist || 0)} 格）。`,
    chance: 0.3,
    maxLen: 20,
    people: [name],
    trigger: 'playerNearby',
    priority: 'social',
    instant: true
  }
}

/**
 * 【UNHUMAN-SCAN #14】有人跟我并肩站着超过 10 秒
 *
 * 一起站着不说话会很尴尬，真人会找句话——问在干嘛、问要不要一起去哪。
 */
function onPlayerLinger (name, seconds, opts = {}) {
  const familiar = opts.familiar === true
  return {
    situation: familiar
      ? `${name} 跟你在这儿一起待了 ${Math.round(seconds)} 秒了，一直没说话。`
      : `有个玩家 ${name} 在你附近站了 ${Math.round(seconds)} 秒，一直没走。`,
    chance: 0.35,
    maxLen: 22,
    people: [name],
    trigger: 'playerLinger',
    priority: 'social',
    instant: true
  }
}

/**
 * 判断现在这个时机值不值得开口。
 * 节流：两次主动说话之间至少隔一段时间，而且有滑动窗口预算（防刷屏）。
 */
class Spontaneity {
  constructor (ctx) {
    this.ctx = ctx || {}
    this.lastSpokeAt = 0
    this.lastSocialAt = 0
    this.pendingEvents = []
    this.maxQueue = 30             // 原来是 6：54 次上下线里前 48 条直接被丢

    // 冷却
    this.cooldownMs = 90000        // 对事（挖到东西/新地形）至少隔 90 秒
    this.socialCooldownMs = 15000  // 对人（上下线/靠近/并肩站）隔 15 秒
    this.complainCooldownMs = 8000 // 吐槽当场就骂，不用等

    // 刷屏预算（滑动窗口）——
    // 光靠冷却不够：54 次上下线每次都想说，冷却 15 秒也还能堆出 2.4 句/分钟。
    // 真人 10 分钟最多也就十来句。
    this.windowMs = 10 * 60 * 1000
    this.maxSaidPerWindow = 12     // 对事+对人，10 分钟总共最多 12 句
    this.maxSocialPerWindow = 7    // 其中"对人"最多 7 句

    // 注意力预算（2026-11-13 23:40）
    // detail-fixer 实测：10 分钟 [say] 108 条、任务只启动 1 次 —— 聊天把干活挤没了。
    // 规则：连着说 3 句社交之后**强制让位 2 分钟**，这期间不管谁上下线都不招呼。
    // 真人也是这样：在群里聊嗨了会突然"行了行了 我干活去了"。
    this.socialStreak = 0
    this.socialStreakMax = 3
    this.socialYieldUntil = 0
    this.socialYieldMs = 120000
    this.socialYieldCount = 0      // 让位触发次数（验收用）

    this._recentSaid = []          // 防复读：{tpl, ent, t, kind}
    this._saidLog = []             // 真说出口的：{t, kind}
    this._talk = null              // tick 时记下，用来拿 mem / botNames
    this.debugCooldown = process.env.SPONT_DEBUG_COOLDOWN === '1'
    this._nearbySeen = new Map()   // 附近的人：name -> {firstSeen, lastSeen, greeted, lingered}

    // 【损失出口】已经在队列里排着的账（`账龄|活`），防止同一笔排两次
    this._queuedLossKeys = new Set()
    // 排了几回还没说成（0 条账最多试几回，之后当说过，别再翻旧账）
    // 【实机 01:46】3 回被模型连拒三次就用完了（模型会「不想说」，跟概率无关），
    // 一笔真账就这么憋回去了 —— 放宽到 5 回，同时把机会从 0.7 提到 0.85。
    this.lossTriesMax = 5
    this._lossTries = new Map()

    // 【被注视 · 独立维度】不是为了"说不说话"，是为了"做什么"。
    // scanPeople 一直知道 8 格内有人，但那个信息只喂给社交触发；
    // 这里旁挂一个维度：谁在看我 / 看了多久 / 熟不熟 -> 动作节奏和小动作。
    //
    // watchSpeak 默认 false：因为 social 触发源正被 social-fixer 改，
    // 这条说话的线留着但不接线，要开就把这个 flag 打开。
    this.watchSpeak = false
    // 外部可以注入同一个实例（main.js 显式接线就是这么做的），
    // 不注入就自己建一个 —— 两种入口共用同一份状态。
    this.watch = ctx.watch || new Watched({
      log: (s) => this._log(s),
      familiarOf: (n) => this._isFamiliar(n),
      ignore: (n) => this._looksLikeBot(n),
      busy: () => { try { return this.ctx.busy ? !!this.ctx.busy() : false } catch (e) { return false } }
    })

    // 数据口：验收要"对人 vs 对事"的分布，直接从这儿数，不靠猜
    this.stats = {
      said: { social: 0, complain: 0, thing: 0 },
      saidByTrigger: {},
      skipped: {},                 // reason -> 次数
      dropped: {},
      merged: 0,
      pushed: 0,
      pushedByTrigger: {}
    }
  }

  // ================================================================
  // 分类 / 计入
  // ================================================================

  _kind (ev) {
    const e = ev || {}
    if (e.priority === 'social') return 'social'
    if (e.priority === 'complain') return 'complain'
    if (e.priority === 'thing') return 'thing'
    // 老事件（没标 priority 的）：按描述猜
    if (COMPLAIN_RE.test(e.situation || '')) return 'complain'
    return 'thing'
  }

  _bump (obj, key, n = 1) {
    if (!key) return
    obj[key] = (obj[key] || 0) + n
    return obj
  }

  /**
   * 记一次"本来想说但没说"。
   *
   * 计数一次不漏（stats.skipped），但日志按 (trigger, reason) 节流 30 秒 ——
   * 主循环 4 秒一次，冷却期里每轮都打一行会把日志刷成 375 行噪音，
   * 真机验收时反而看不清到底说了什么。
   */
  _skip (trigger, reason) {
    this._bump(this.stats.skipped, reason)
    this._lastSkipLog = this._lastSkipLog || {}
    const k = (trigger || '?') + '|' + reason
    const now = Date.now()
    if (this._lastSkipLog[k] && now - this._lastSkipLog[k] < 30000) return
    this._lastSkipLog[k] = now
    this._log(`[spont] 跳过 trigger=${trigger || '?'} reason=${reason}`)
  }

  _log (s) {
    try { if (this.ctx.log) this.ctx.log(s) } catch (e) {}
  }

  // ================================================================
  // 队列
  // ================================================================

  /**
   * 攒一个事件。
   *
   * 【UNHUMAN-SCAN #3 根因的一半】队列上限原来是 6，超了直接丢最老的：
   * 25 分钟 54 次上下线 —— 前 48 条在进队列的瞬间就没了。
   *
   * 现在：上限 30，满了**先丢"对事"的旧事件**，社交事件留着。
   */
  push (ev) {
    if (!ev) return
    const kind = this._kind(ev)
    if (!ev.trigger) ev.trigger = kind
    this.pendingEvents.push({ ev, t: Date.now(), kind })
    this.stats.pushed++
    this._bump(this.stats.pushedByTrigger, ev.trigger)

    if (this.pendingEvents.length > this.maxQueue) {
      // 丢最老的一条非社交；全是社交才丢最老的
      let idx = this.pendingEvents.findIndex(x => this._kind(x.ev) !== 'social')
      if (idx < 0) idx = 0
      const gone = this.pendingEvents.splice(idx, 1)[0]
      if (gone) this._bump(this.stats.dropped, 'queueFull:' + (gone.ev.trigger || '?'))
    }
  }

  _rank (item) {
    // 「白干了一趟」要压过普通吐槽（"这有个洞/挖到东西"这类顺嘴的），
    // 但仍在「有人跟你说话」之后 —— 招呼晚 30 秒就凉了，账不会。
    if (item && item.ev && item.ev.trigger === 'loss') return 0.5
    return RANK[this._kind(item.ev)] != null ? RANK[this._kind(item.ev)] : 2
  }

  _sortQueue () {
    this.pendingEvents.sort((x, y) => {
      const r = this._rank(x) - this._rank(y)
      if (r !== 0) return r
      return y.t - x.t     // 同档先处理新的（旧的容易过时）
    })
  }

  /** 清掉过期事件（主循环没义务调它，tick 自己会先 prune） */
  prune () {
    const now = Date.now()
    this.pendingEvents = this.pendingEvents.filter(x => {
      const social = this._kind(x.ev) === 'social'
      const ttl = social ? 90000 : 120000
      const alive = now - x.t < ttl
      if (!alive) {
        this._bump(this.stats.dropped, 'expired:' + (x.ev.trigger || '?'))
        // 过期的那条如果是"白干"的账，把排队标记放掉，下一个 tick 还能重排
        // （不放进 _recentSaid 里：这话根本没出去，不算说过）
        this._releaseLoss(x.ev, 'expired')
      }
      return alive
    })
  }

  /**
   * 把攒着的几条"有人上线"合成一句话。
   *
   * 为什么要合：服务器里经常两三个人前后脚进来（实测 54 次上下线里大量是连着的）。
   * 分三条说 = 刷屏；一句"来了好几个"才是人话，而且 54 次事件也能真的覆盖到。
   */
  _coalesceHead () {
    const head = this.pendingEvents[0]
    if (!head || !head.ev || head.ev.trigger !== 'playerJoin') return null

    const names = []
    const rest = []
    let count = 0
    const now = Date.now()
    for (const it of this.pendingEvents) {
      const e = it.ev || {}
      if (e.trigger === 'playerJoin' && count < 4 && now - it.t < 60000) {
        count++
        for (const n of (e.people || [])) if (!names.includes(n)) names.push(n)
      } else {
        rest.push(it)
      }
    }
    if (count < 2 || names.length < 2) return null

    this.pendingEvents = rest
    this.stats.merged++
    this._log(`[spont] 合并 social x${count} → ${names.join('、')}`)
    const batch = {
      situation: `有 ${names.length} 个人陆续上线了（${names.join('、')}）。`,
      chance: 0.85,
      maxLen: 24,
      people: names,
      trigger: 'playerJoinBatch',
      priority: 'social',
      instant: true
    }
    this.pendingEvents.push({ ev: batch, t: Date.now(), kind: 'social' })
    return batch
  }

  // ================================================================
  // 防复读
  // ================================================================
  //
  // 【踩过的坑 · 2026-11-13 18:00 离线单测】
  // 第一版用"前 6 个字相同"判重复，于是
  //   '有人上线了（人0），你不太认识。'
  //   '有人上线了（人1），你不太认识。'
  // 被判成同一句 —— 10 个人上线只招呼了 1 个。
  // 现在按"模板 + 关键实体"区分：模板相同 **且** 实体相同才算重复。
  //
  // 窗口分两档：对事 30 分钟（"挖到铁矿"不该复读），
  // 对人 3 分钟（同一个人 3 分钟内反复进出只招呼一次，但过一会儿又来了可以说"又来了"）。
  _situationKey (situation) {
    const raw = String(situation || '').replace(/\s+/g, '')
    const names = []
    raw.replace(/（([^）]{1,40})）/g, (_, inner) => { names.push(inner); return '' })
    const nums = (raw.match(/\d+/g) || []).join(',')
    const tpl = raw
      .replace(/（[^）]*）/g, '（*）')
      .replace(/\d+/g, '#')
    return { tpl, ent: names.join('|') + '@' + nums }
  }

  _isRepeat (situation, kind) {
    const k = this._situationKey(situation)
    const now = Date.now()
    const win = kind === 'social' ? 90000 : 30 * 60 * 1000
    this._recentSaid = this._recentSaid.filter(x => now - x.t < 30 * 60 * 1000)
    return this._recentSaid.some(x => x.tpl === k.tpl && x.ent === k.ent && now - x.t < win)
  }

  _markSaid (situation, kind) {
    const k = this._situationKey(situation)
    this._recentSaid.push({ tpl: k.tpl, ent: k.ent, t: Date.now(), kind })
    if (this._recentSaid.length > 80) this._recentSaid.shift()
  }

  // ================================================================
  // 刷屏预算
  // ================================================================

  _windowCounts (now) {
    this._saidLog = this._saidLog.filter(x => now - x.t < this.windowMs)
    let all = 0
    let social = 0
    for (const x of this._saidLog) {
      all++
      if (x.kind === 'social') social++
    }
    return { all, social }
  }

  _budgetOk (now) {
    const c = this._windowCounts(now)
    if (c.all >= this.maxSaidPerWindow) return false
    if (c.social >= this.maxSocialPerWindow) return false
    return true
  }

  // ================================================================
  // 熟人判定
  // ================================================================

  /**
   * 是不是熟人（有交往记录）。
   *
   * 【为什么这里要认 talk.mem】Spontaneity 的 ctx 只有 {log, busy}，
   * 没有 mem —— 原实现 this.ctx.mem 永远 undefined，
   * 等于"熟人喊名字"这条修法根本没生效，对谁都说"你不太认识"。
   * tick() 会拿到 talk，talk.mem 才是真正的记忆。没有就一律当生人。
   */
  _isFamiliar (name) {
    try {
      const mem = (this.ctx && this.ctx.mem) || (this._talk && this._talk.mem)
      if (!mem) return false
      const p = mem.people && mem.people[name]
      if (!p) return false
      const n = (p.talkCount || p.meetCount || p.times || 0)
      return n >= 3
    } catch (e) {
      return false
    }
  }

  /** 名字像不像另一个 bot（防两个 AI 互相打招呼刷屏） */
  _looksLikeBot (name) {
    const n = String(name || '')
    if (!n) return true
    const t = this._talk
    try {
      const list = (t && t.ctx && t.ctx.botNames) || (this.ctx && this.ctx.botNames) || []
      if (Array.isArray(list) && list.includes(n)) return true
    } catch (e) {}
    // 【注意】不能再用 /^XJJ/ —— XJJHOME6 / XJJINTG 这些是真人小号（UNHUMAN-SCAN #13），
    // 一并滤掉等于"人对面站着他也当没看见"。
    return /^(bot|ai|npc)[_-]?\d*$/i.test(n)
  }

  // ================================================================
  // 主流程
  // ================================================================

  /**
   * 【真机实测暴露的问题 · 2026-11-13 19:54】
   * main.js 只在**主循环的一轮**里调 spont.tick()，而主循环会卡在长任务里
   * （日志里一次任务 4 分钟很常见）。这段时间里 tick 一次都不会跑 ——
   * 玩家上下线全堆在队列里，等到下一轮 tick 时已经超过 90 秒的有效期，直接丢掉。
   *
   * 这就是"排队排到过期"的真正原因：不是队列太短，是**没人来取**。
   *
   * 所以这里自己起一个 4 秒的泵：只要队列里有"人对人"的事，就算主循环在忙也照取。
   * 对事（挖到东西/新地形）仍然只跟主循环节奏走，避免干活时被自己的碎碎念打断。
   */
  _startPump (talk) {
    if (this._pumpTimer || !talk) return
    const ms = this.pumpMs || 4000
    this._pumpTimer = setInterval(() => { this._pump() }, ms)
    // 不要因为这个定时器把进程吊住
    if (this._pumpTimer.unref) this._pumpTimer.unref()
  }

  async _pump () {
    if (this._ticking || !this._talk) return
    // "人对人"的事值得插队；"白干了一趟"的账也一样 ——
    // 主循环卡在一个 4 分钟的任务里时，队列里非社交事件 120 秒就过期了，
    // 而一笔账的说话窗口只有 8 分钟（cost.speakMaxAgeMs），耗不起那一轮。
    const urgent = this.pendingEvents.some(x =>
      this._kind(x.ev) === 'social' || (x.ev && x.ev.trigger === 'loss'))
    if (!urgent) return
    try { await this.tick(this._talk) } catch (e) {}
  }

  /** 关掉自驱泵（测试用） */
  stopPump () {
    if (this._pumpTimer) clearInterval(this._pumpTimer)
    this._pumpTimer = null
  }

  /**
   * 主循环调用：有攒着的事就问他要不要说。
   * @returns {Promise<boolean>}
   */
  async tick (talk, bot) {
    // 防重入：主循环和自驱泵可能同时进来，一句话不能说两遍
    if (this._ticking) return false
    this._ticking = true
    try {
      return await this._tickInner(talk, bot)
    } finally {
      this._ticking = false
    }
  }

  async _tickInner (talk, bot) {
    if (talk) {
      this._talk = talk
      this._startPump(talk)
    }

    // 顺手看一眼附近有没有人（UNHUMAN-SCAN #14）。
    // main.js 不改，所以这里自己找 bot：
    //   1. tick(talk, bot) 显式传进来
    //   2. talk.bot（talk 对象持有 bot —— 最可靠的来源）
    //   3. ctx.bot（万一以后 main.js 传了）
    const b = bot || (talk && talk.bot) || (this.ctx && this.ctx.bot) || null
    if (b && b.players) {
      try { this.scanPeople(b) } catch (e) {}
    }

    // 代价层：有新鲜的"白干"账就排一条吐槽（优先级和当场吐槽同级）
    this._maybeQueueLoss()

    this.prune()
    if (!this.pendingEvents.length) return false
    if (!talk || typeof talk.speak !== 'function') return false

    this._sortQueue()

    // 几条"有人上线"合成一句（避免 54 次上下线变成 54 条公屏）
    if (this._coalesceHead()) { /* 合并后已重新入队 */ }
    this._sortQueue()

    const now = Date.now()
    const first = this.pendingEvents[0]
    const ev = first.ev || {}
    const kind = this._kind(ev)
    const trigger = ev.trigger || kind
    const busyExempt = ev.busyExempt !== false && (kind === 'social' || kind === 'complain')

    // ── 冷却 ────────────────────────────────────────────────
    //   social   15 秒（有人来要抬头，但也不是每 4 秒喊一次）
    //   complain  8 秒（当场就骂，不等）
    //   thing    90 秒（保持原样，避免话痨）
    if (kind === 'social') {
      // 注意力预算：连着说够了就先闭嘴干活
      if (now < this.socialYieldUntil) { this._skip(trigger, 'yield'); return false }
      // 诊断：真机出现过 4 秒间隔的两次社交发言，这里记下判定时刻的真实间隔
      if (this.debugCooldown) this._log(`[spont] 冷却判定 kind=${kind} sinceSocial=${now - this.lastSocialAt} sinceSpoke=${now - this.lastSpokeAt}`)
      if (now - this.lastSocialAt < this.socialCooldownMs) { this._skip(trigger, 'socialCooldown'); return false }
      if (now - this.lastSpokeAt < 6000) { this._skip(trigger, 'justSpoke'); return false }
    } else if (kind === 'complain') {
      if (now - this.lastSpokeAt < this.complainCooldownMs) { this._skip(trigger, 'complainCooldown'); return false }
    } else {
      if (now - this.lastSpokeAt < this.cooldownMs) { this._skip(trigger, 'cooldown'); return false }
    }

    // ── 刷屏预算 ────────────────────────────────────────────
    if (!this._budgetOk(now)) { this._skip(trigger, 'budget'); return false }

    // 忙的时候一般不主动搭话……
    // 但"有人上线/走到旁边"和"吐槽"例外：忙也应该抬头看一眼，这是人的本能。
    if (this.ctx.busy && this.ctx.busy() && !busyExempt) { this._skip(trigger, 'busy'); return false }

    const item = this.pendingEvents.shift()
    const age = now - item.t

    // 太久以前的不说了（已经过时）。
    // 社交事件放宽到 90 秒：有人上线那句"哟"晚 30 秒说也还是自然的，
    // 而"挖到铁矿"晚了就没意义了。
    if (age > (kind === 'social' ? 90000 : 120000)) {
      this._bump(this.stats.dropped, 'stale:' + trigger)
      this._log(`[spont] 丢弃 trigger=${trigger} reason=expired age=${Math.round(age / 1000)}s`)
      this._releaseLoss(ev, 'expired')
      return false
    }

    // 防刷屏：一模一样的话（模板+实体都相同）在窗口内不说第二遍
    if (this._isRepeat(ev.situation, kind)) {
      this._skip(trigger, 'repeat')
      this._log('[spont] 撤回重复事件：' + String(ev.situation).slice(0, 24))
      this._releaseLoss(ev, 'repeat')
      return false
    }

    // ── 预约冷却 ──────────────────────────────────────────────
    // 真机上出现过「4 秒内两条社交发言」：冷却是在 await talk.speak 之后才写
    // lastSocialAt 的，而 speak 里有 LLM + 打字延迟（2~6 秒），这段窗口里
    // 另一个事件（自驱泵 / 队列）照样能通过检查。现在改成先说后占坑：
    // 决定要说的这一刻就把冷却记上，说得成不成都不放开，宁可少说一句也不连发。
    this.lastSpokeAt = now
    if (kind === 'social') this.lastSocialAt = now

    const said = await talk.speak(ev.situation, {
      chance: ev.chance,
      maxLen: Math.min(ev.maxLen || 20, 24),
      people: ev.people || [],
      extraHint: kind === 'social'
        ? '这是跟人打招呼/搭话。随口一句，像熟人之间那样，别客套，别一大段。'
        : '随口一句就行，最多十几个字。别汇报，别描述一堆数字。'
    })

    if (said) {
      const t2 = Date.now()
      this._saidLog.push({ t: t2, kind, trigger })
      this._markSaid(ev.situation, kind)
      this.stats.said[kind] = (this.stats.said[kind] || 0) + 1
      this._bump(this.stats.saidByTrigger, trigger)

      // 连着说社交 -> 攒到上限就强制让位，把时间让给干活
      if (kind === 'social') {
        this.socialStreak++
        if (this.socialStreak >= this.socialStreakMax) {
          this.socialStreak = 0
          this.socialYieldUntil = t2 + this.socialYieldMs
          this.socialYieldCount++
          this._log(`[spont] 社交让位 ${Math.round(this.socialYieldMs / 1000)} 秒` +
            `（连着说了 ${this.socialStreakMax} 句，该干活了）`)
        }
      } else {
        this.socialStreak = 0
      }
      if (trigger === 'loss') this._releaseLoss(ev, 'said')
      this._log(`[spont] 说 trigger=${trigger} kind=${kind} people=${(ev.people || []).join(',') || '-'}`)
    } else {
      this._skip(trigger, 'notSaid')
      if (trigger === 'loss') this._releaseLoss(ev, 'miss')
    }
    return said
  }

  /**
   * 代价层：把最近一笔"白干"拿出来说。
   *
   * 参谋的原话：账造出来了，一次都没说出口。
   * 这里的做法是**素材进提示词，台词由模型现编**（tone-researcher 实测：
   * 把 lossBlock 塞进 system prompt，8 轮 0 条照念「记住这回」）。
   *
   * 所以 situation 里给的是"这趟干了啥、赔了什么"，并明确要求别复盘别报数——
   * 五分钟 / 八根木棍 / 死两回这些数进的是**他的心里**，不是台词。
   * 真人转述自己倒霉时是「坑得要死，昨天白耗了那么久」，不是把账本念一遍。
   *
   * 【排队 ≠ 说出口】这里只排队，不标记 spokenAt；标记在 _releaseLoss 里，
   * 等真说出去了才算。否则一条账排进去被冷却挡一次，就永远没人说了。
   */
  _maybeQueueLoss () {
    try {
      const C = costMod && costMod.currentInstance ? costMod.currentInstance() : null
      if (!C || typeof C.nextUnspokenLoss !== 'function') return null
      const loss = C.nextUnspokenLoss()
      if (!loss) return null
      const key = this._lossKey(loss)
      if (this._queuedLossKeys.has(key)) return null   // 已经在队里了，别堆两条一样的
      const mat = (costMod.lossMaterial ? costMod.lossMaterial(loss) : String(loss.text || ''))
        .replace(/^记住这回：/, '')
      // 账里的结论（那地方不能再去）给的是"他心里这么想"，不是要念的话
      const still = loss.verdict === 'meh' ? '' : '那地方你是真不想再去了。'
      this._queuedLossKeys.add(key)
      const ev = {
        trigger: 'loss',
        priority: 'complain',
        chance: 0.85,
        maxLen: 18,
        busyExempt: true,
        lossRef: { key, loss },
        situation: `你刚放弃了一件事，心里有点堵：${mat}。${still}` +
          '随口嘟囔一句——别复盘，别报数，就像跟旁边人顺口说的。'
      }
      this.push(ev)
      this._log('[spont] 排了一条损失吐槽：' + mat.slice(0, 40))
      return ev
    } catch (e) {
      return null
    }
  }

  /** 一条账的身份：账龄 + 那件事（同一笔账认得出，重排不会变成两条） */
  _lossKey (loss) {
    return `${Math.round(Number(loss.at) || 0)}|${loss.key || ''}`
  }

  /**
   * 排队里的那条账有结果了：说成了 / 说了没成 / 过期了。
   *
   * 【为什么不在排队时就 markSpoken】
   * 排进去 ≠ 说出口：可能被冷却挡住、被"太旧了"丢掉、或者模型这轮不想开口。
   * 早点标记 = 这笔账永远躺在账本里没人说 —— 那正是这次要修的病。
   * 所以只在**真说出口**之后才标记；说了没成最多重排 3 回，之后当说过，
   * 免得一句旧账在 8 分钟窗口里被翻来覆去地念。
   *
   * @param {object} ev 事件（认 ev.lossRef）
   * @param {string} outcome 'said' | 'miss' | 'expired' | 'repeat'
   */
  _releaseLoss (ev, outcome) {
    const ref = ev && ev.lossRef
    if (!ref || !ref.key) return
    const key = ref.key
    this._queuedLossKeys.delete(key)
    const C = costMod && costMod.currentInstance ? costMod.currentInstance() : null
    const giveUp = () => {
      try { if (C && C.markSpoken) C.markSpoken(ref.loss) } catch (e) {}
      this._lossTries.delete(key)
    }
    if (outcome === 'said') { giveUp(); return }
    const n = (this._lossTries.get(key) || 0) + 1
    this._lossTries.set(key, n)
    if (n >= this.lossTriesMax) {
      this._log(`[spont] 这笔账排了 ${n} 回没说出来，先放下`)
      giveUp()
    }
  }

  /**
   * 【UNHUMAN-SCAN #14】自己盯着附近有没有人。
   *
   * 为什么放在这里而不是 main.js：main.js 不归我改，
   * 而"有人靠近 / 有人陪着站"这两件事完全可以由 spontaneous 自己算出来
   * —— 主循环每 4 秒调一次 tick，顺手扫一眼就行。
   *
   * 两条规则：
   *   · 有人进入 8 格 -> 可能打招呼（chance 0.3，不能每次都喊）
   *   · 有人跟我并肩站超过 10 秒 -> 可能搭话（chance 0.35）
   * 同一个人一次到访只记一次，别把人烦死；走远 15 秒后再来算新的一次。
   *
   * @param {object} bot mineflayer 的 bot
   */
  scanPeople (bot) {
    if (!bot || !bot.entity || !bot.entity.position) return
    const me = bot.entity.position
    const now = Date.now()
    if (!this._nearbySeen) this._nearbySeen = new Map()

    const NEAR = 8
    const players = []
    for (const [name, p] of Object.entries(bot.players || {})) {
      if (!p || p.username === bot.username || name === bot.username) continue
      if (!p.entity || !p.entity.position) continue      // 不在视野内
      if (this._looksLikeBot(p.username)) continue        // 别跟别的 bot 互相打招呼刷屏
      let d = 0
      try { d = p.entity.position.distanceTo(me) } catch (e) { d = 99 }
      if (d <= NEAR) players.push({ name: p.username, d })
    }

    for (const pl of players) {
      let rec = this._nearbySeen.get(pl.name)
      // 已经离开过（超过 15 秒没被看见）就算新的一次到访
      if (rec && now - rec.lastSeen > 15000) rec = null

      if (!rec) {
        rec = { firstSeen: now, lastSeen: now, greeted: false, lingered: false }
        this._nearbySeen.set(pl.name, rec)
        // 第一次进入 8 格：可能打招呼
        rec.greeted = true
        this.push(onPlayerNearby(pl.name, pl.d, { familiar: this._isFamiliar(pl.name) }))
      }
      rec.lastSeen = now

      // 并肩站超过 10 秒（而且还没搭过话）
      if (!rec.lingered && now - rec.firstSeen > 10000) {
        rec.lingered = true
        this.push(onPlayerLinger(pl.name, (now - rec.firstSeen) / 1000,
          { familiar: this._isFamiliar(pl.name) }))
      }
    }

    // 走远的人从表里清掉（下次再来又是"第一次"）
    const seen = new Set(players.map(p => p.name))
    for (const [name, rec] of this._nearbySeen) {
      if (!seen.has(name) && now - rec.lastSeen > 15000) this._nearbySeen.delete(name)
    }

    // ── 被注视维度（新）──────────────────────────────────────
    // 上面的 social 队列和触发源归 social-fixer，这里**不碰**：
    // 只把"谁在看我"变成"我干什么"，走 audience.js 自己的状态机。
    try { this.watch.observe(bot) } catch (e) { this._log('[watched] 异常 ' + e.message) }
    if (this.watchSpeak) {
      try {
        const ev = this.watch.takeSpeakEvent()
        if (ev) this.push(ev)
      } catch (e) {}
    }
  }
}

/** 吐槽事件：只在这些真实发生时触发，不凭空来 */
function onComplain (what, detail) {
  const map = {
    died: { s: `你刚死了（${detail || '不知道咋死的'}）。`, c: 0.75, m: 20 },
    diedAgain: { s: `你今天已经死了好几次了，刚又死了一回（${detail || ''}）。`, c: 0.85, m: 20 },
    nothingFound: { s: `你找了半天什么都没找到（${detail || ''}）。`, c: 0.6, m: 20 },
    craftFail: { s: `你合成失败了（${detail || ''}）。`, c: 0.55, m: 18 },
    stuck: { s: `你走不动了，卡住了（${detail || ''}）。`, c: 0.5, m: 18 },
    almostDied: { s: `你差点死了（${detail || ''}），现在活下来了。`, c: 0.65, m: 20 },
    gotLost: { s: `你走错路了，绕了一大圈（${detail || ''}）。`, c: 0.55, m: 18 },
    robbed: { s: `有人拿了你的东西（${detail || ''}）。`, c: 0.7, m: 20 },
    weird: { s: `你看到个奇怪的东西（${detail || ''}）。`, c: 0.5, m: 18 },
    lucky: { s: `你运气不错（${detail || ''}）。`, c: 0.5, m: 18 }
  }
  const e = map[what]
  if (!e) return null
  return {
    situation: e.s,
    chance: e.c,
    maxLen: e.m,
    trigger: 'complain:' + what,
    priority: 'complain'
  }
}

// ==================================================================
// 「这一次上线」的三种话（session-owner）
// ------------------------------------------------------------------
// 会话以前只是个计数器，所以他从来不提"今天"。这三句把"这一次"说出来：
//   上线扫完家 -> onSessionReturn（看见变了）
//   收工       -> onSessionSettle（这一趟干了什么、值不值）
//   天亮开工   -> onSessionDayStart（今天打算干什么）
// 注意：箱子被拿空那条**不走这里**，走的是上面那个躺了很久的 robbed 模板。
// ==================================================================

/** 刚上线，扫了一圈家，看出变化 */
function onSessionReturn (r) {
  if (!r || !Array.isArray(r.lines) || !r.lines.length) return null
  return {
    situation: `你刚上线，看了一圈家：${r.lines.slice(0, 3).join('；')}。`,
    chance: r.lines.length >= 2 ? 0.85 : 0.55,
    maxLen: 30,
    trigger: 'sessionReturn',
    priority: 'complain',
    busyExempt: true
  }
}

/** 收工：这一趟到此为止 */
function onSessionSettle (bill) {
  if (!bill) return null
  // 说"今天"，不说"这一趟" —— 这一趟活值不值是 cost 层的活。
  const day = bill.dayLine || ((bill.tasks || []).length
    ? `今天干了${bill.tasks.slice(-2).map(t => t.text).join('、')}`
    : '今天什么正经事都没做成')
  const waste = (bill.verdict === 'white' || bill.verdict === 'bitter') ? '，忙了一天等于白搭' : ''
  return {
    situation: `你今天收工了。${day}${waste}。`,
    chance: 0.8,
    maxLen: 28,
    trigger: 'sessionSettle',
    priority: (bill.verdict === 'white' || bill.verdict === 'bitter') ? 'complain' : 'thing',
    busyExempt: true
  }
}

/** 歇够了，新的一天开始 */
function onSessionDayStart (d) {
  if (!d || !d.text) return null
  return {
    situation: `新的一天。家里的情况是${d.why}，所以今天打算${d.text}。`,
    chance: 0.5,
    maxLen: 26,
    trigger: 'sessionDayStart',
    priority: 'thing'
  }
}

module.exports = {
  Spontaneity,
  onComplain,
  onSessionReturn,
  onSessionSettle,
  onSessionDayStart,
  onValuableFind,
  onNewTerrain,
  onFriendInDanger,
  onFriendBusy,
  onNearDeath,
  onGoalDone,
  onLateNight,
  onPlayerJoin,
  onPlayerLeave,
  onPlayerNearby,
  onPlayerLinger
}
