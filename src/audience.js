'use strict'
/**
 * 「有人在看」（audience）—— 被注视 / 被围观。
 *
 * 这是一个**独立的感知维度**，也是一个**独立的行为输入**。
 * 以前 scanPeople() 认得出 8 格内有人，但那个人只用来决定"说不说话"，
 * 从来不决定"做什么"。结果：动作 100% 稳定，有没有人看一模一样。
 * 在多人服里，这一点比句号还容易暴露 —— 站在旁边看 30 秒就知道不是人。
 *
 * ------------------------------------------------------------------
 * 这里做三件事，彼此解耦
 * ------------------------------------------------------------------
 *  1. 感知：8 格内有没有人 / 他朝哪 / 他是不是在看我 / 看了多久 / 熟不熟
 *  2. 情绪：这一幕（一次到访的注视）随机抽一个 mood
 *           tense 紧张 / showoff 显摆 / awkward 尴尬 / relaxed 放松
 *  3. 行为：mood 落到四个地方
 *           · 动作节奏（dig 前的小停顿 = "手抖了一下"）
 *           · 小动作（抬头看回去、移开视线、跳一下、挪半步）
 *           · 说话倾向（takeSpeakEvent()，默认不接，见下）
 *           · 目标选择（preferVisible()，给 goals 用）
 *
 * ------------------------------------------------------------------
 * 分寸（不做成"有人来就停手"，那也假）
 * ------------------------------------------------------------------
 *  · 概率：不是每次都反应。每个动作各自带概率，且整局有反应上限。
 *  · 冷却：全局 7 秒内只反应一次；同一个人一段到访只抽一次 mood。
 *  · 熟识度：熟人偏 relaxed/showoff，生人偏 tense/awkward。
 *  · 收摊：反应过几次就 `settled`，人再站着也不继续演 ——
 *    这条是防"有人站着不走，他一直反应"的关键。
 */

const realSleep = ms => new Promise(r => setTimeout(r, ms))

/** 默认参数：全部可被 ctx 覆盖，测试用 */
const DEFAULTS = {
  range: 8,                              // 感知半径（格）
  lookDot: Math.cos(38 * Math.PI / 180), // 视线夹角 < 38° 算"在看我"
  forgetMs: 15000,                       // 15 秒没看见 = 走了，下次算新到访
  gazeBreakMs: 25000,                    // 视线移开 25 秒 = 这一幕结束
  reactGapMs: 7000,                      // 两个反应之间至少 7 秒
  maxLooksPerEpisode: 3,                 // 同一幕最多抬头看 3 次（再多就成巡逻灯了）
  maxReactPer10Min: 6,                   // 10 分钟内最多 6 次反应（防过度触发）
  settleAfterReact: 5,                   // 同一段到访总反应 5 次就收摊
  settleAfterStrong: 2,                  // 其中"看得见"的强反应 2 次就收摊
  speakGapMs: 90000                      // "看啥呢"这类话，全局 90 秒一条
}

/** mood -> dig 前停顿（毫秒）与附属行为 */
const MOOD_PACE = {
  // 标定：紧张 平均 ~150ms、偶尔一次 0.3-0.5s 的停顿（手一抖）；
  // 超过 0.5s 的单次停顿看起来像卡服，所以上限压住。
  tense: { preMin: 60, preMax: 260, hiccupP: 0.15, hiccup: [250, 500] },
  showoff: { preMin: 0, preMax: 35, hiccupP: 0, hiccup: [0, 0] },
  awkward: { preMin: 40, preMax: 160, hiccupP: 0.08, hiccup: [150, 350] },
  relaxed: { preMin: 0, preMax: 60, hiccupP: 0.02, hiccup: [0, 0] }
}

const MOOD_W = {
  familiar: [['showoff', 0.35], ['relaxed', 0.30], ['tense', 0.20], ['awkward', 0.15]],
  stranger: [['tense', 0.40], ['awkward', 0.30], ['showoff', 0.20], ['relaxed', 0.10]]
}

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x)
const rnd = (a, b, rand = Math.random) => a + rand() * (b - a)

function pick (table, rand = Math.random) {
  let r = rand()
  for (const [k, w] of table) {
    r -= w
    if (r <= 0) return k
  }
  return table[table.length - 1][0]
}

class Watched {
  constructor (ctx = {}) {
    this.ctx = ctx
    this.opts = Object.assign({}, DEFAULTS, ctx.opts || {})
    this.log = ctx.log || (() => {})
    this.familiarOf = ctx.familiarOf || (() => false)
    this.ignore = ctx.ignore || (() => false)
    this.sleep = ctx.sleep || realSleep
    // 可注入随机源：测试要可复现，不然"抖动/频率"这类断言每次都漂
    this.rand = ctx.rand || Math.random
    // 测试/调试用：把情绪钉死成某个 mood（不传就是正常的概率抽取）
    this.forcedMood = ctx.forcedMood || null
    this._now = ctx.now || (() => Date.now())

    /** name -> 记录 */
    this._people = new Map()
    this._bot = null

    this._lastReactAt = 0
    this._reacts = []          // 反应时间戳（滑动窗口数频率）
    this._lastSpeakAt = 0
    this._lastSig = ''
    this._lastLogAt = 0
    this._lastEmpty = null     // 上一段"有人"的结束时间

    /** 对外的状态快照（main / 别处只读） */
    this.state = {
      count: 0,
      nearest: null,          // {name, d}
      anyoneLooking: false,
      lookingNames: [],
      gazeMs: 0,
      stayMs: 0,
      familiar: false,
      mood: null,
      intensity: 0,
      settled: false,
      at: 0
    }

    this.stats = {
      scans: 0,
      visits: 0,             // 有人进入 8 格（到访次数）
      episodes: 0,           // 注视幕（被人真正"看"到的次数）
      byMood: {},
      reactions: {},         // 主动反应 kind -> 次数（抬头/跳/挪/移开视线/说话）
      flourish: 0,           // 显摆空挥（干活时的动作，不占反应额度）
      sleeps: 0,             // dig 前停顿次数
      dug: { watched: 0, settled: 0, unwatched: 0 },
      preDelayMs: { watched: [], unwatched: [] },
      settledSkips: 0,       // 因为"收摊"而压住的反应
      capSkips: 0            // 因为 10 分钟上限压住的反应
    }
  }

  /** 显式接线：主程序拿到 bot 就可以直接装（不必等第一次 scanPeople） */
  attach (bot) {
    this._attach(bot)
    this._bot = bot
    return this
  }

  /** 当前"被注视强度" 0..1 —— 动作层（挖矿节奏）就是按它调的 */
  get focus () {
    return this.state.intensity
  }

  /**
   * 主循环每轮喂一次（main.js 调用）。
   * 内部 900ms 节流：scanPeople 也会调 observe，别一个循环扫两遍。
   */
  tick (bot) {
    const now = this._now()
    if (this._lastObserveAt && now - this._lastObserveAt < 900) return this.state
    return this.observe(bot)
  }

  // ================================================================
  // 感知
  // ================================================================

  _log (s) {
    try { if (this.log) this.log(s) } catch (e) {}
  }

  _posOf (ent) {
    try {
      const p = ent && ent.position
      if (!p) return null
      if (typeof p.x === 'number' && typeof p.z === 'number') return p
    } catch (e) {}
    return null
  }

  /** 他是不是在看我（水平朝向夹角） */
  _isLooking (botPos, p) {
    const e = p.entity || {}
    const yaw = (typeof e.yaw === 'number') ? e.yaw : null
    if (yaw === null) return { looking: false, dot: 0 }
    const dx = botPos.x - p.entity.position.x
    const dz = botPos.z - p.entity.position.z
    const L = Math.hypot(dx, dz)
    // 贴脸（<1.5 格）时方向是退化的：人站在你旁边，朝哪都看得见你
    if (L < 1.5) return { looking: true, dot: 1 }
    // Minecraft：yaw=0 朝 +Z，dir = (-sin yaw, cos yaw)
    const vx = -Math.sin(yaw)
    const vz = Math.cos(yaw)
    const dot = (vx * dx + vz * dz) / L
    return { looking: dot >= this.opts.lookDot, dot }
  }

  /**
   * 扫一眼 8 格，更新所有人，算出状态，按需反应。
   * 主循环每轮调一次（由 spontaneous.scanPeople 调）。
   */
  observe (bot) {
    const st = this.state
    const me = this._posOf(bot && bot.entity)
    if (!me) return st

    this._attach(bot)
    const now = this._now()
    this._lastObserveAt = now
    this.stats.scans++

    // ── 扫人 ─────────────────────────────────────────────
    const found = []
    for (const [name, p] of Object.entries((bot && bot.players) || {})) {
      if (!p || !p.entity) continue
      if (p.username === bot.username || name === bot.username) continue
      if (this.ignore(p.username || name)) continue
      const pos = this._posOf(p.entity)
      if (!pos) continue
      let d = 99
      try { d = Math.hypot(pos.x - me.x, pos.y - me.y, pos.z - me.z) } catch (e) { d = 99 }
      if (d > this.opts.range) continue
      found.push({ name: p.username || name, p, d, pos })
    }

    for (const f of found) {
      let rec = this._people.get(f.name)
      const isNew = !rec
      if (isNew) {
        rec = {
          name: f.name,
          firstSeen: now,
          lastSeen: now,
          d: f.d,
          familiar: false,
          looking: false,
          dot: 0,
          gazeSince: null,
          gazeMs: 0,
          mood: null,
          episodeAt: 0,
          reacts: 0,
          strong: 0,        // 强反应（跳、挪、移开视线、说话）：2 次就"慌了"
          settled: false,
          reacted: {},
          hopped: 0,
          stepped: false
        }
        this._people.set(f.name, rec)
        this.stats.visits++
        this._log(`[watched] 有人进入 ${this.opts.range} 格 name=${f.name} d=${f.d.toFixed(1)} familiar=${this.familiarOf(f.name) ? 'yes' : 'no'}`)
      }
      rec.lastSeen = now
      rec.d = f.d
      try { rec.familiar = this.familiarOf(f.name) === true } catch (e) { rec.familiar = false }

      const lk = this._isLooking(me, f.p)
      rec.dot = lk.dot
      if (lk.looking) {
        if (!rec.looking) rec.gazeSince = now
        rec.looking = true
        rec.gazeMs = now - (rec.gazeSince || now)
        if (!rec.mood) this._startEpisode(rec, now)
      } else {
        rec.looking = false
        // 视线移开很久 -> 这一幕结束（下次再看是新的一幕）
        if (rec.mood && now - (rec.lastLookedAt || rec.gazeSince || now) > this.opts.gazeBreakMs) {
          rec.mood = null
          rec.gazeMs = 0
          rec.reacts = 0
          rec.settled = false
          rec.reacted = {}
        }
      }
      if (rec.looking) rec.lastLookedAt = now
    }

    // ── 走远的清掉 ────────────────────────────────────────
    const seen = new Set(found.map(f => f.name))
    for (const [name, rec] of this._people) {
      if (!seen.has(name) && now - rec.lastSeen > this.opts.forgetMs) {
        this._people.delete(name)
      }
    }

    // ── 汇总状态 ──────────────────────────────────────────
    const live = found.map(f => this._people.get(f.name)).filter(Boolean)
    const lookers = live.filter(r => r.looking)
    let nearest = null
    for (const r of live) if (!nearest || r.d < nearest.d) nearest = { name: r.name, d: +r.d.toFixed(1) }

    const lookNearest = lookers.length
      ? lookers.reduce((a, b) => (b.d < a.d ? b : a))
      : null

    st.count = live.length
    st.nearest = nearest
    st.anyoneLooking = lookers.length > 0
    st.lookingNames = lookers.map(r => r.name)
    st.gazeMs = lookNearest ? lookNearest.gazeMs : 0
    st.stayMs = nearest ? (now - (this._people.get(nearest.name)?.firstSeen || now)) : 0
    st.familiar = !!(nearest && nearest.name && this._people.get(nearest.name)?.familiar)
    st.mood = lookNearest ? lookNearest.mood : null
    st.settled = lookNearest ? lookNearest.settled : false
    st.at = now

    // 强度：近 + 在看我 + 看久了 —— 决定动作幅度，不决定"做不做"
    const prox = nearest ? clamp01(1 - (nearest.d - 1) / Math.max(1, this.opts.range)) : 0
    const look = lookers.length ? 1 : 0
    const ramp = clamp01(st.gazeMs / 15000)
    st.intensity = +(0.45 * prox + 0.4 * look + 0.15 * ramp).toFixed(3)

    // ── 日志（变人/变朝向才打，没人时收一句） ─────────────
    this._logState(now, st, live)

    // ── 小动作 ────────────────────────────────────────────
    try { this._micro(bot, now, st, lookNearest) } catch (e) {}

    return st
  }

  _startEpisode (rec, now) {
    const familiar = rec.familiar
    rec.mood = this.forcedMood || pick(familiar ? MOOD_W.familiar : MOOD_W.stranger, this.rand)
    rec.episodeAt = now
    rec.gazeSince = rec.gazeSince || now
    rec.reacts = 0
    rec.settled = false
    rec.reacted = {}
    this.stats.episodes++
    this.stats.byMood[rec.mood] = (this.stats.byMood[rec.mood] || 0) + 1
    this._log(`[watched] 一幕开始 who=${rec.name} mood=${rec.mood} d=${rec.d.toFixed(1)} familiar=${familiar ? 'yes' : 'no'}`)
  }

  _logState (now, st, live) {
    const sig = st.count === 0
      ? ''
      : live.map(r => `${r.name}:${r.looking ? 'L' : '-'}:${r.mood || ''}`).sort().join('|')

    if (st.count === 0) {
      if (this._lastSig !== '') {
        this._lastSig = ''
        this._lastEmpty = now
        this._log('[watched] 附近没人了')
      }
      return
    }

    // 人变了 / 朝向变了 / mood 变了 -> 立刻打；否则 20 秒一行心跳
    if (sig !== this._lastSig || now - this._lastLogAt > 20000) {
      this._lastSig = sig
      this._lastLogAt = now
      const r = live.slice().sort((a, b) => a.d - b.d)[0]
      this._log(
        `[watched] 附近 ${st.count} 人 nearest=${r.name} d=${r.d.toFixed(1)} ` +
        `looking=${r.looking ? 'yes' : 'no'} dot=${r.dot.toFixed(2)} ` +
        `gaze=${(r.gazeMs / 1000).toFixed(1)}s stay=${((now - r.firstSeen) / 1000).toFixed(1)}s ` +
        `mood=${r.mood || '-'} familiar=${r.familiar ? 'yes' : 'no'} focus=${st.intensity}`
      )
    }
  }

  // ================================================================
  // 行为：节奏（dig 前的小停顿）
  // ================================================================

  /** 把 bot.dig 包一层：被看着的时候，手会顿一下 */
  _attach (bot) {
    if (!bot || bot.__watchedAttached) return
    if (typeof bot.dig !== 'function') return
    const self = this
    const orig = bot.dig.bind(bot)

    bot.dig = async function (block, forceLook) {
      // 【状态保鲜】主循环一挖就是几十秒不进 tick，光靠 scanPeople 每 4 秒扫一次
      // 会让他"被人盯着挖了半天"，state 还停在没人看的时候。
      // 这里在每格开挖前自己补一次观察（1 秒节流，开销可以忽略）。
      try {
        const t = self._now()
        if (!self._lastObserveAt || t - self._lastObserveAt > 1000) self.observe(bot)
      } catch (e) {}
      const d = self.preDigDelay()
      if (d > 0) {
        self.stats.sleeps++
        await self.sleep(d)
      }
      try {
        const r = await orig(block, forceLook)
        self._afterDig()
        return r
      } catch (e) {
        throw e
      }
    }
    bot.__watchedAttached = true
    this._bot = bot
  }

  /** 现在挖一格之前该顿多久（毫秒）—— 单独可测，不依赖 bot */
  preDigDelay () {
    const st = this.state
    const r = this._pickRec()
    // 注意：settled 也算"被看着"（只是幅度降下来），别在这里排掉 ——
    // 排掉就等于"人盯着看久了，他又恢复 100% 稳定的机器人节奏"。
    const watched = !!(r && r.looking && r.mood)

    if (!watched) {
      this.stats.dug.unwatched++
      this._sample('unwatched', 0)
      return 0
    }

    const pace = MOOD_PACE[r.mood] || MOOD_PACE.relaxed
    // 强度只调幅度：紧张的时候手更抖，不紧张的时候几乎看不出来
    const scale = 0.5 + 0.5 * clamp01(st.intensity)
    // 【收摊的余温】反应次数用完了（settled）不代表彻底放松 ——
    // 人还盯着看，手还是会有点抖，只是不再"抬头、跳、清嗓子"这些离散动作。
    // 这里保留 35% 的节奏偏移：既不会看起来很假地恢复 100% 稳定，
    // 也不会因为一直演而显得像 loop。
    const settleK = r.settled ? 0.35 : 1
    let d = rnd(pace.preMin, pace.preMax, this.rand) * scale * settleK
    if (this.rand() < pace.hiccupP * (r.settled ? 0.3 : 1)) {
      d += rnd(pace.hiccup[0], pace.hiccup[1], this.rand) * scale * settleK
    }
    d = Math.round(d)

    r.reacted.preDig = (r.reacted.preDig || 0) + 1
    if (r.settled) this.stats.dug.settled++
    else this.stats.dug.watched++
    this._sample('watched', d)

    // 【可验证性】光有"有人进入 8 格"的日志不算数，得能看出**动作真的被改了**。
    // 15 秒最多一行，且写出实际注入的停顿毫秒数。
    const now = this._now()
    if (!this._lastPaceLogAt || now - this._lastPaceLogAt > 15000) {
      this._lastPaceLogAt = now
      this._log(`[watched] 节奏 mood=${r.mood} focus=${st.intensity} 停顿=${d}ms（被 ${r.name} 看着）`)
    }
    return d
  }

  _sample (kind, d) {
    const a = this.stats.preDelayMs[kind]
    a.push(d)
    if (a.length > 500) a.shift()
  }

  /**
   * 显摆用的独立通道。
   *
   * 【踩过的坑】显摆一开始直接 _countReact：
   *  · 第一次实测 10 分钟刷出 12 次反应（上限写 6）—— 明显过火；
   *  · 改成共用全局闸之后，抬头看一眼就把 7 秒额度吃掉，2 分钟里显摆 0 次。
   * 显摆本质是"干活时的空挥两下"（真人也一直在挥胳膊），
   * 所以它单独计时、单独限额，既不挤占"看见有人"的反应额度，也不会刷屏。
   */
  _allowFlourish (now) {
    if (!this._flourishAt) this._flourishAt = []
    this._flourishAt = this._flourishAt.filter(t => now - t < 10 * 60 * 1000)
    if (this._flourishAt.length >= 8) return false
    if (now - (this._lastFlourishAt || 0) < 4000) return false
    return true
  }

  _afterDig () {
    const r = this._pickRec()
    if (!r || !r.looking || r.settled || r.mood !== 'showoff') return
    if (!this._allowFlourish(this._now())) return
    if (this.rand() > 0.35) return
    const bot = this._bot
    if (!bot || typeof bot.swingArm !== 'function') return
    // 显摆：挖完顺手空挥两下（不阻塞 dig 的返回，节奏来自"看起来更卖力"）
    try {
      bot.swingArm('right')
      setTimeout(() => { try { bot.swingArm('left') } catch (e) {} }, 180)
      this._lastFlourishAt = this._now()
      this._flourishAt.push(this._lastFlourishAt)
      this.stats.flourish++
      if (r) r.flourish = (r.flourish || 0) + 1
    } catch (e) {}
  }

  /** 当前"最该被在意"的那个人（最近且在看我的） */
  _pickRec () {
    let best = null
    for (const r of this._people.values()) {
      if (!r.looking) continue
      if (!best || r.d < best.d) best = r
    }
    return best
  }

  // ================================================================
  // 行为：小动作
  // ================================================================

  _safeToAct (bot) {
    if (!bot || !bot.entity) return false
    try {
      if (bot.targetDigBlock) return false                                  // 正在挖
      if (bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' && bot.pathfinder.isMoving()) return false
      if (typeof this.ctx.busy === 'function' && this.ctx.busy()) return false
    } catch (e) { return false }
    return true
  }

  _micro (bot, now, st, r) {
    if (!r || !r.looking || r.settled) return
    // 只在"没在挖、没在走路、没在干活"的空档做小动作 ——
    // 挖着矿突然扭头会把这一格挖废，走路时抢控制权会把寻路弄乱。
    if (!this._safeToAct(bot)) return
    const mood = r.mood

    // 抬头看回去 —— 最像人的一个反应，也最便宜
    const lookP = { tense: 0.45, showoff: 0.25, awkward: 0.35, relaxed: 0.2 }[mood] || 0.2
    // 尴尬的人会移开视线
    const averted = mood === 'awkward' && this.rand() < 0.4

    const looks = (r.reacted.look || 0) + (r.reacted.glanceAway || 0)
    if (looks < (this.opts.maxLooksPerEpisode || 3) && this.rand() < lookP && this._allow('look', now)) {
      if (averted) this._glanceAway(bot, r)
      else this._lookAt(bot, r)
    }

    // 跳一下 / 挪半步：只在尴尬时，且一次到访最多一次
    if (mood === 'awkward' && r.gazeMs > 12000 && r.hopped < 1 && this._safeToAct(bot) && this._allow('hop', now)) {
      if (this.rand() < 0.5) this._hop(bot, r)
      else this._stepAside(bot, r)
    }

    // 看太久了 -> 收摊（人还在，但不继续演；这是防"一直反应"的闸）
    // 【为什么分强弱】原来"反应 3 次就收摊"，而抬头看一眼(weak)会把额度吃光：
    // 生人站着看 10 分钟 -> 前 20 秒抬头 3 次 -> 之后 9 分钟又变回机器人。
    // 现在：抬头随便看（但有上限），跳/挪/说话才算"真被盯慌了"，两次就收。
    if ((r.strong >= (this.opts.settleAfterStrong || 2) || r.reacts >= this.opts.settleAfterReact) && !r.settled) {
      r.settled = true
      this._log(`[watched] 收摊 who=${r.name} reacts=${r.reacts} strong=${r.strong}（人还在，只保留紧张的余温）`)
    }
  }

  _allow (kind, now) {
    if (now - this._lastReactAt < this.opts.reactGapMs) return false
    this._reacts = this._reacts.filter(t => now - t < 10 * 60 * 1000)
    if (this._reacts.length >= this.opts.maxReactPer10Min) {
      this.stats.capSkips++
      return false
    }
    return true
  }

  /** 强反应：会被人明显看见的（跳、挪、移开视线、说话）；抬头看一眼算弱反应 */
  static get STRONG () { return ['hop', 'stepAside', 'glanceAway', 'speak'] }

  _countReact (kind, rec) {
    this._lastReactAt = this._now()
    this._reacts.push(this._lastReactAt)
    this.stats.reactions[kind] = (this.stats.reactions[kind] || 0) + 1
    if (!this._reactLog) this._reactLog = []
    this._reactLog.push({ t: this._lastReactAt, kind })
    if (rec) {
      rec.reacts++
      rec.reacted[kind] = (rec.reacted[kind] || 0) + 1
      if (Watched.STRONG.includes(kind)) rec.strong++
    }
  }

  _lookAt (bot, r) {
    try {
      const me = bot.entity.position
      const pl = bot.players && Object.values(bot.players).find(x => x && (x.username || '') === r.name)
      const tgt = pl && pl.entity && pl.entity.position ? pl.entity.position : null
      if (!tgt) return
      const dx = tgt.x - me.x
      const dz = tgt.z - me.z
      const dy = (tgt.y + 1.6) - (me.y + 1.6)
      const yaw = Math.atan2(-dx, dz)
      const dist = Math.hypot(dx, dz) || 1
      const pitch = Math.atan2(dy, dist)
      if (typeof bot.look === 'function') bot.look(yaw, pitch, true)
      this._countReact('look', r)
      this._log(`[watched] 反应 look who=${r.name} mood=${r.mood} d=${r.d.toFixed(1)} gaze=${(r.gazeMs / 1000).toFixed(0)}s`)
    } catch (e) {}
  }

  _glanceAway (bot, r) {
    try {
      const yaw = (bot.entity.yaw || 0) + Math.PI / 2 + rnd(-0.3, 0.3, this.rand)
      if (typeof bot.look === 'function') bot.look(yaw, 0, true)
      this._countReact('glanceAway', r)
      this._log(`[watched] 反应 glanceAway who=${r.name}（盯太久了，把视线挪开）`)
    } catch (e) {}
  }

  _hop (bot, r) {
    try {
      bot.setControlState('jump', true)
      setTimeout(() => { try { bot.setControlState('jump', false) } catch (e) {} }, 120)
      r.hopped++
      this._countReact('hop', r)
      this._log(`[watched] 反应 hop who=${r.name}（站那儿不知道干啥，跳一下）`)
    } catch (e) {}
  }

  _stepAside (bot, r) {
    try {
      const me = bot.entity.position
      const yaw = bot.entity.yaw || 0
      // 侧向一格（左）
      const vx = -Math.cos(yaw)
      const vz = -Math.sin(yaw)
      const tp = { x: Math.round(me.x + vx), y: Math.round(me.y), z: Math.round(me.z + vz) }
      const below = bot.blockAt && bot.blockAt({ x: tp.x, y: tp.y - 1, z: tp.z })
      if (!below || below.boundingBox === 'empty') return   // 脚下是空 -> 别迈步，会掉下去
      bot.setControlState('left', true)
      setTimeout(() => { try { bot.setControlState('left', false) } catch (e) {} }, 240)
      r.stepped = true
      this._countReact('stepAside', r)
      this._log(`[watched] 反应 stepAside who=${r.name}（挪半步，别站那么近）`)
    } catch (e) {}
  }

  // ================================================================
  // 行为：说话倾向（默认不接 —— social 触发归 social-fixer）
  // ================================================================

  /**
   * 要不要因为"被盯着"说一句话。
   * 返回一个 spontaneous 认的事件对象，或者 null。
   * 这条**默认不接线**：spontaneous.scanPeople 里由 this.watchSpeak 控制，
   * 关着的时候完全不影响现存的 social 触发源。
   */
  takeSpeakEvent () {
    const now = this._now()
    const r = this._pickRec()
    if (!r) return null
    if (r.gazeMs < 8000) return null
    if (r.reacted.speak) return null
    if (now - this._lastSpeakAt < this.opts.speakGapMs) return null

    const moody = r.mood === 'awkward' ? 0.34 : r.mood === 'tense' ? 0.22 : r.mood === 'relaxed' ? 0.28 : 0.16
    if (this.rand() > moody) return null

    this._lastSpeakAt = now
    r.reacted.speak = true
    this._countReact('speak', r)
    const secs = Math.round(r.gazeMs / 1000)
    const familiar = r.familiar
    const situations = familiar
      ? [`${r.name} 就在旁边看着你干活，看了 ${secs} 秒了，你俩挺熟的。`,
        `${r.name} 一直盯着你，也不说话，你觉得有点好笑。`]
      : [`${r.name} 站在你旁边盯着你看了 ${secs} 秒，你有点不自在。`,
        `${r.name} 一声不吭在旁边看你挖，你被看得手都有点僵。`]

    return {
      situation: situations[Math.floor(this.rand() * situations.length)],
      chance: 0.8,
      maxLen: 20,
      people: [r.name],
      trigger: 'watchedGaze',
      priority: 'social',
      instant: true
    }
  }

  /** 给 goals 用：有人在看的时候，更想干"看得见的活"（挖/砍/建 > 整理背包） */
  preferVisible () {
    const st = this.state
    if (!st.anyoneLooking) return 0
    return +clamp01(0.25 + 0.5 * st.intensity).toFixed(2)
  }

  // ================================================================
  // 数据口（验收用）
  // ================================================================

  report () {
    const avg = a => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null)
    const recent = this._reacts.filter(t => this._now() - t < 10 * 60 * 1000).length
    return {
      scans: this.stats.scans,
      visits: this.stats.visits,
      episodes: this.stats.episodes,
      byMood: this.stats.byMood,
      reactions: this.stats.reactions,
      flourish: this.stats.flourish,
      reactsPer10Min: recent,
      settledSkips: this.stats.settledSkips,
      capSkips: this.stats.capSkips,
      dug: this.stats.dug,
      preDelayAvgMs: { watched: avg(this.stats.preDelayMs.watched), unwatched: avg(this.stats.preDelayMs.unwatched) },
      sleeps: this.stats.sleeps,
      state: this.state
    }
  }
}

module.exports = { Watched, MOOD_PACE, MOOD_W, DEFAULTS }
