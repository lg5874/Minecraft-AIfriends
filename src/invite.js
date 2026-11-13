'use strict'
/**
 * 「能被邀请」—— 玩家叫他过去 / 跟着走。
 *
 * 用户最初要的是"一起玩"。原来他能聊天、能干活，但**叫他他不来**：
 * 说"跟我来"他没反应，因为"跟着走"根本不是他的行为之一。
 * 这一层要解决的问题是：**他得能被带走，而且带走以后别自己跑掉去挖矿。**
 *
 * ------------------------------------------------------------------
 * 判据（验收口径）
 * ------------------------------------------------------------------
 *  · 跟 3 分钟不丢人
 *  · 不插队干活（跟随期间不开新任务）
 *  · 至少说 2 句话（答应一句 + 走远时喊一句 / 跟一会儿搭一句）
 *
 * ------------------------------------------------------------------
 * 分寸
 * ------------------------------------------------------------------
 *  · 玩家停，他也停，不催（不每 5 秒"你走啊"）
 *  · 站太近（<1.2 格）往后退半步，别站人家身上
 *  · 玩家在下面/上面超过 3 格：不直接跳，绕路或者等着
 *  · 走远 >32 格：喊一句"哎你等等"，15 秒内不重复
 *  · 跟丢 >15 秒：说一句"人呢"，然后自己停下（别原地转圈）
 *  · 最长跟 10 分钟，之后自己散了
 *
 * 这个模块只用 bot + pathfinder，不改 actions.js：
 * 接邀请时 setGoal(null) + stopDigging() 打断当前活，
 * 主循环那边靠 invite.active 把"开新任务"挡住。
 */

const { goals, Movements } = require('mineflayer-pathfinder')

const realSleep = ms => new Promise(r => setTimeout(r, ms))

const DEFAULTS = {
  followRange: 2,          // 跟到多远就算"跟上了"
  tooClose: 1.2,           // 比这更近就往后退半步
  farShout: 32,            // 超过这个距离喊人
  giveUpDist: 64,          // 超过这个距离还持续 10 秒就散了
  lostMs: 15000,           // 看不见人多久算跟丢
  idleStopMs: 60000,       // 玩家站着不动这么久，就不贴着了（但仍然"跟着"）
  maxFollowMs: 5 * 60e3,   // 最长跟 5 分钟（原来 10 分钟：真人跟朋友走 10 分钟一句话不干不像话）
  askAtMs: 3 * 60e3,       // 跟到 3 分钟问一句"还走啊？我这边还有点事"
  inviteCooldownMs: 5 * 60e3, // 同一个人 5 分钟内反复叫：只有超过下面那个很宽的上限才不接
  // 【2026-11-14】"条件式拒绝"整条收掉：
  //   原来是「同一个人 5 分钟内：第 1 次接、第 2 次 50%、第 3 次起不接」。
  //   那是为"10 个探针 bot 轮流邀请、跟随占 75% 时间"造的补丁，
  //   放到"1 个真人、明早第一次喊他过来"的场景里就是灾难 —— 第一次喊就被拒。
  //   现在判据从"叫了几次"换成"现在什么状态"（手上有活吗 / 血够不够），
  //   只留一个很宽的后台上限，防止探针环境里被无限拉走。
  inviteHardCap: 5,           // 同一个人 5 分钟内最多接 5 次（原来 2 次就拒）
  busyProgress: 0.5,          // 任务进度过半 = "手上有活"，这时才延后
  followThruMs: 60e3,         // 答应了"等我把这块弄完"最多多久，到点主动过去
  lowHp: 8,                   // 血 ≤ 8：先说"我快不行了"，缓过来再过去
  lowFood: 6,                 // 饿得只剩这点渣：别再跟着跑远了
  recoverHp: 12,              // 血回到这个数就算"缓过来了"
  recoverMaxMs: 90e3,         // 再怎么缓，90 秒后也得给个交代（过去或再说一句）
  tickMs: 1000,
  shoutGapMs: 15000,       // 喊"等等"的间隔
  chatGapMs: 8000          // 主动搭话的间隔
}

/**
 * 邀请（"跟我来"这一类）。
 *
 * 【2026-11-14 收窄】原来 `上来|下来|过来` 是裸词，实机踩到：
 * 别的 bot 说一句「XJJ_VOICE30126 刚上来啊」，他当成邀请跟着走了。
 * 用户明天随口一句「我刚上来了」也会触发跟随 —— 误触发比没反应更怪。
 *
 * 现在 `过来/上来` 要求前面**不是**「我/刚/才/已」这类"叙述自己动作"的字，
 * `下来` 整条去掉（"下来"当邀请的说法太少，当叙述的太多）。
 * 「你上来 / 快过来 / 过来」照样认，「我刚过来了 / 他刚上来」不认。
 */
const INVITE_RE = new RegExp([
  '跟我(来|走|去)',
  '跟上', '跟着我', '跟紧',
  '(?<![我刚才已正])过来',
  '(?<![我刚才已正])上来',
  '来这里', '到这来', '来这边', '来我这',
  '一起(挖|去|走|打|玩|逛)',
  '带我(去|走)',
  '陪我(去|走|逛)',
  '^走啊',
  'come\\s*(here|on|with)', 'follow\\s*me', "let'?s\\s*go", 'with\\s*me'
].join('|'), 'i')
/** 不要跟了 */
const STOP_RE = /别跟了|不用跟|不要跟|自己玩|别过来了|停吧|散了|站住|算了别|stop\s*follow|go\s*away|leave\s*me/i

class Invite {
  constructor (ctx = {}) {
    this.ctx = ctx
    this.opts = Object.assign({}, DEFAULTS, ctx.opts || {})
    this.log = ctx.log || (() => {})
    this.speak = ctx.speak || (async () => false)
    this.sleep = ctx.sleep || realSleep
    this._now = ctx.now || (() => Date.now())
    this.isBotName = ctx.isBotName || (() => false)

    this.active = false
    this.target = null          // 跟着谁
    this.startedAt = 0
    // 同一个人 5 分钟内反复叫：多来几次就不跟了（测试环境有 5-10 个探针 bot 会无限邀请，
    // 真实场景是 1-2 个朋友 —— 这里按真人设计：同一人短时间内第三次叫，就"我这儿还有事"）
    this._lastInviteAt = {}
    this._inviteStreak = {}
    this._pendingFollow = null   // {user, at}：答应了"等我把这块弄完"还没过去
    this._pendingRecover = null  // {user, at}：血见底说了"先缓一下"，缓过来要去找他
    this._everAccepted = false   // 这次上线还没答应过谁（第 1 声无条件答应，attach 时重置）
    this._askedAt = 0
    this._bot = null
    this._timer = null
    this._tickBusy = false
    this._lastGoalAt = -1e15
    // 【踩过的坑】初值写 0 时，测试时钟从 0 起算 -> "现在 - 上次 = 0" 永远不满足间隔，
    // 喊人/搭话一次都发不出来。用"很久以前"才是对的语义。
    this._lastShoutAt = -1e15
    this._lastChatAt = -1e15
    this._lastSaidAt = -1e15
    this._lastBackoffAt = -1e15
    this._stillSince = this._now()
    this._lastSeen = 0
    this._lastPos = null
    this._lastMovedAt = 0
    this._idleHeld = false
    this._guarded = 0
    this._defaultMovements = null

    this.stats = {
      invites: 0,
      accepted: 0,
      refused: 0,
      deferred: 0,            // 手上有活："等我把这块弄完就来"
      followThru: 0,          // 说完了真的过去了
      firstCall: 0,           // 这次上线的第 1 声（无条件答应）
      recover: 0,             // 血见底："先缓一下"，后来真的过去了
      stops: 0,
      shouts: 0,
      lines: 0,
      goals: 0,
      backoffs: 0,
      ledgeGuards: 0,
      lost: 0,
      giveUp: 0,
      samples: [],            // {t, d, act}
      events: []
    }
  }

  // ================================================================
  // 接邀请
  // ================================================================

  attach (bot) {
    if (!bot || this._bot === bot) return this
    this._everAccepted = false      // 新的一次上线 = 新的一次"第 1 声"
    this._pendingFollow = null
    this._pendingRecover = null
    this._bot = bot
    if (this._timer) clearInterval(this._timer)
    this._timer = setInterval(() => { this.tick().catch(() => {}) }, this.opts.tickMs)
    if (this._timer.unref) this._timer.unref()
    return this
  }

  detach () {
    if (this._timer) clearInterval(this._timer)
    this._timer = null
    this.stop('detach', { quiet: true })
  }

  /**
   * 收到一句话：是不是在叫我跟上去（或者别跟了）。
   * @returns {'invite'|'stop'|null}
   */
  handleChat (username, message) {
    const bot = this._bot
    if (!bot || !username || username === bot.username) return null
    if (this.isBotName && this.isBotName(username)) return null
    const msg = String(message || '')
    if (!msg) return null

    if (STOP_RE.test(msg)) {
      // 只认跟自己在跟的人说的"别跟了"，或者点名
      if (this.active && (msg.includes(bot.username) || username === this.target || this._near(username, 12))) {
        this.stop('asked', { who: username })
        return 'stop'
      }
      // 还没过去（答应了"等我把这块弄完"）时叫人别来，也得认
      if (this._pendingFollow && this._pendingFollow.user === username) {
        this._pendingFollow = null
        this.log(`[invite] ${username} 说别来了，那个"等会儿过去"撤掉`)
        return 'stop'
      }
      if (this._pendingRecover && this._pendingRecover.user === username) {
        this._pendingRecover = null
        this.log(`[invite] ${username} 说别来了，"缓过来去找你"也撤掉`)
        return 'stop'
      }
    }

    if (!INVITE_RE.test(msg)) return null
    // 点名别人（"小明跟我来"）就不接
    if (this._mentionsOther(msg, username)) return null

    // 【实机踩到】正在跟 A 的时候，旁边的 B 说一句"跟紧点 别掉坑里"，
    // 他立刻换去跟 B，然后跟丢 —— 真人不会这样，真人只认带自己名字的那句。
    // 规则：已经在跟人、且那人还在附近时，只有**点名叫我**才换目标。
    if (this.active && username !== this.target) {
      const named = this._nameHit(msg, bot.username)
      if (!named && this._near(this.target, 12)) {
        this.log(`[invite] 正在跟 ${this.target}，${username} 这句没点名，不换人`)
        return null
      }
    }

    this.stats.invites++

    // ===== 宽上限：只在一个人短时间反复叫到第 6 次才拦 =====
    // 【为什么不再按次数拒绝】原来这里是「第二次 50%、第三次起不接」，
    // 那是为"10 个探针 bot 轮流邀请"造的补丁。真实场景是 1 个朋友喊你过去，
    // 第一次喊就得到"来了" —— 所以判据从"叫了几次"改成"现在什么状态"（下面 3 条），
    // 这里只留一个很宽的后台兜底，防止探针环境把人无限拉走。
    const now = this._now()
    const cd = this.opts.inviteCooldownMs
    // 【踩过同一个坑】初值写 0 时，假时钟从 0/1000 起算会让"刚叫过"永远成立。
    // 用"很久以前"才是正确语义（文件里 _lastShoutAt 也踩过这个）。
    const last = this._lastInviteAt[username] || -1e15
    if (now - last < cd) {
      const n = (this._inviteStreak[username] || 0) + 1
      this._inviteStreak[username] = n
      if (n >= this.opts.inviteHardCap) {
        this.stats.inviteIgnored = (this.stats.inviteIgnored || 0) + 1
        this.log(`[invite] ${username} 5 分钟内叫了 ${n + 1} 次，先歇会儿`)
        return null
      }
    } else {
      this._inviteStreak[username] = 0
    }
    this._lastInviteAt[username] = now

    // 已经在跟这个人：他再喊一声，就当作"我在呢"，不重新判定
    if (this.active && this.target === username) {
      this._lastSeen = now
      return 'invite'
    }
    // 说了"等我把这块弄完"之后他又喊：别让他等第二次，立刻过去
    if (this._pendingFollow && this._pendingFollow.user === username) {
      this._pendingFollow = null
      this.start(username, msg)
      return 'invite'
    }

    // ===== 第 1 声：无条件答应 =====
    //
    // 【Lead 拍板 · 2026-11-14】用户进游戏第一件事大概率是「XJJ 过来」，
    // 这一声决定他是不是"能一起玩"。所以**这次上线第一次被叫，不看进度、
    // 不看血、不看任何条件**，直接答应 —— 调阈值（0.5→0.85）只是把问题推后，
    // 用户试到第三次照样撞上。
    // 重置点：attach()（每次上线/重连都会重新 attach 一个新 bot）。
    if (!this._everAccepted) {
      this._everAccepted = true
      this.stats.firstCall = (this.stats.firstCall || 0) + 1
      this._ev({ what: 'firstCall', who: username })
      this.start(username, msg)
      return 'invite'
    }

    // ===== 第 2 声起：状态条件（不是配置表，也不是概率）=====
    const v = this._vitals()

    // 1) 血真的见底了：说「我快不行了」，然后**真的缓过来再回去找他**
    //    （原来这里 return null 就完了 —— 用户听到"我得先回家"然后人没了，
    //     观感是"他跑了"。Lead 的口径：说出来的话要有下文。）
    if (v.health != null && v.health <= this.opts.lowHp) {
      this.stats.refused++
      this._ev({ what: 'recover', why: 'lowhp', who: username, hp: +v.health.toFixed(1) })
      this._pendingRecover = { user: username, at: now }
      this._say(`你被 ${username} 叫过去，但血只剩 ${Math.round(v.health)}，` +
        '现在出去就是白送一条命。跟他说一声：我快不行了，先缓一下，缓过来就去找你',
      { force: true, people: [username] })
      this.log(`[invite] 血 ${Math.round(v.health)}，先缓一下（${username} 叫的），缓过来会主动过去`)
      return null
    }

    // 2) 手上有活且过半：不是不来，是"等一下就来"（60 秒内自己过去）
    const p = this._progress()
    if (p > this.opts.busyProgress && !this._badState(v)) {
      this.stats.deferred = (this.stats.deferred || 0) + 1
      this._pendingFollow = { user: username, at: now }
      this._ev({ what: 'defer', who: username, progress: +p.toFixed(2) })
      this._say(`你手上这件活已经过半了（${username} 在叫你过去），先回一句：` +
        '等我把这块弄完就来，别让他干等', { force: true, people: [username] })
      this.log(`[invite] ${username} 叫，手上活 ${Math.round(p * 100)}%，先说一句，弄完自己过去`)
      return null
    }

    // 3) 其余一律答应 —— 明早用户第一句「过来」，必须得到"来了"
    this.start(username, msg)
    return 'invite'
  }

  /** 现在的状态：血 / 饿 / 是不是夜里（都从 bot 读，不用 main 传） */
  _vitals () {
    const bot = this._bot
    const out = { health: null, food: null, night: false }
    try {
      if (!bot) return out
      if (Number.isFinite(bot.health)) out.health = bot.health
      if (Number.isFinite(bot.food)) out.food = bot.food
      const tod = bot.time && bot.time.timeOfDay
      out.night = Number.isFinite(tod) && tod > 13000 && tod < 23000
    } catch (e) {}
    return out
  }

  /** 手上这件活干到几成了（0~1）。没人给这个口子就当 0 —— 也就是一律答应 */
  _progress () {
    try {
      if (typeof this.ctx.progress === 'function') {
        const v = Number(this.ctx.progress())
        if (Number.isFinite(v)) return Math.max(0, Math.min(1, v))
      }
    } catch (e) {}
    return 0
  }

  /** 状态差（血见底 / 饿得发慌 / 天黑了）：这种时候别赖着不走，跟着人反而安全 */
  _badState (v) {
    if (v.health != null && v.health <= this.opts.lowHp) return true
    if (v.food != null && v.food <= this.opts.lowFood) return true
    return !!v.night
  }

  _isBusy () {
    try {
      if (typeof this.ctx.busy === 'function') return !!this.ctx.busy()
    } catch (e) {}
    return this._progress() > this.opts.busyProgress
  }

  /**
   * 「等我把这块弄完就来」之后，真的过去。
   *
   * 这是这次改动的关键：拒绝变成了**延后**，而不是不来。
   * 到点还没空（活卡住了）也照样过去 —— 答应了人就得去，
   * start() 会打断寻路/挖掘，那个卡住的活会自己收尾。
   */
  _tickPendingFollow () {
    const p = this._pendingFollow
    if (!p) return
    const bot = this._bot
    if (!bot || !bot.entity) return
    if (!bot.players[p.user]) { this._pendingFollow = null; return }   // 人走了
    const waited = this._now() - p.at
    if (this._isBusy() && waited < this.opts.followThruMs) return     // 还在按答应的时间收尾
    this._pendingFollow = null
    this.stats.followThru = (this.stats.followThru || 0) + 1
    this._ev({ what: 'followThru', who: p.user, waitedMs: waited })
    this.log(`[invite] 说到做到：${Math.round(waited / 1000)} 秒后主动去找 ${p.user}`)
    this.start(p.user, '等我把这块弄完', {
      line: `你刚才跟 ${p.user} 说"等我把这块弄完就来"，现在活告一段落了。` +
        '主动说一句你来了（要带他名字），然后跟上去'
    })
  }

  /**
   * 「我快不行了，先缓一下，缓过来就去找你」之后，真的回去找。
   *
   * 【为什么必须有这个方法】原来血 ≤8 只 return null 就完了 ——
   * 话说出口，人没了。用户听到的是"他跑了"，不是"他待会儿来"。
   * 现在这里等血回到 recoverHp 以上（或者等满 recoverMaxMs 到极限），
   * 就主动 start() 过去。跟「等我把这块弄完」是同一个模式：说出来的话有下文。
   *
   * 【为什么不看 busy】血少本来就该先养，忙不忙不该拦着这条承诺。
   */
  _tickPendingRecover () {
    const r = this._pendingRecover
    if (!r) return
    const bot = this._bot
    if (!bot || !bot.entity) return
    if (!bot.players[r.user]) { this._pendingRecover = null; return }   // 人走了
    const v = this._vitals()
    const waited = this._now() - r.at

    // 血缓过来了：去找他
    if (v.health != null && v.health > this.opts.recoverHp) {
      this._pendingRecover = null
      this.stats.recover = (this.stats.recover || 0) + 1
      this._ev({ what: 'recoverDone', who: r.user, waitedMs: waited, hp: +v.health.toFixed(1) })
      this.log(`[invite] 血回到 ${Math.round(v.health)}（等了 ${Math.round(waited / 1000)} 秒），去找 ${r.user}`)
      this.start(r.user, '缓过来了', {
        line: `你刚才跟 ${r.user} 说"先缓一下，缓过来就去找你"，现在血回来了。` +
          '主动说一句你来了（要带他名字），然后跟上去'
      })
      return
    }

    // 到极限还没缓过来：也别把人吊着，给个交代（这句不硬说，免得变成抱怨）
    if (waited >= this.opts.recoverMaxMs) {
      this._pendingRecover = null
      this._ev({ what: 'recoverGiveUp', who: r.user, waitedMs: waited })
      this.log(`[invite] ${Math.round(waited / 1000)} 秒血还没回来，${r.user} 那边先不承诺了`)
      this._say(`你还没缓过来（血 ${v.health == null ? '很少' : Math.round(v.health)}），` +
        `${r.user} 还在等你。说一句实话：这会儿过去就是送死，让他别等我`, { people: [r.user] })
    }
  }

  /**
   * 消息里有没有点到某个名字。
   *
   * 【坑】他的号叫 XJJ，服务器里还有 XJJHOME6 / XJJINTG 这些真人小号，
   * 直接 includes 的话 "XJJB 跟我来" 会被当成在叫 XJJ（因为 XJJB 里含 XJJ）。
   * 所以英文名按标识符边界匹配。
   */
  _nameHit (msg, name) {
    if (!name) return false
    const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp('(^|[^A-Za-z0-9_])' + esc + '([^A-Za-z0-9_]|$)').test(msg)
  }

  _mentionsOther (msg, from) {
    const bot = this._bot
    if (!bot) return false
    const others = Object.keys(bot.players || {}).filter(n =>
      n !== bot.username && n !== from && n.length >= 3 && this._nameHit(msg, n))
    if (!others.length) return false
    // 同时点了我：以更长的那个名字为准（XJJB vs XJJ）
    if (this._nameHit(msg, bot.username)) return others.some(n => n.length > String(bot.username).length)
    return true
  }

  _near (name, r) {
    try {
      const p = this._bot.players[name]
      const me = this._bot.entity.position
      return !!p && p.entity && p.entity.position.distanceTo(me) <= r
    } catch (e) { return false }
  }

  /** 开始跟：打断手上的活，接管移动 */
  start (name, said = '', opts = {}) {
    const bot = this._bot
    if (!bot) return false
    this._pendingFollow = null     // 已经过去了，"等会儿就来"这个约定就兑现了
    if (this.active && this.target === name) {
      this._lastSeen = this._now()
      return true
    }
    // 换人跟：先把上一个停掉（不吭声）
    if (this.active) this.stop('switch', { quiet: true })

    const now = this._now()
    this.active = true
    this.target = name
    this.startedAt = now
    this._askedAt = 0
    this._lastSeen = now
    this._lastShoutAt = -1e15
    this._lastChatAt = -1e15
    this._lastGoalAt = -1e15
    this._idleHeld = false
    this._lastPos = null
    this._lastMovedAt = now
    this.stats.accepted++
    this._ev({ what: 'start', who: name })

    // 【停下手里的活】不碰 actions.js，直接从协议层打断：
    // 停止寻路、停止挖掘、清空控制键 —— 正在跑的任务会因为拿不到进度而快速结束。
    try { bot.pathfinder.setGoal(null) } catch (e) {}
    try { if (typeof bot.stopDigging === 'function') bot.stopDigging() } catch (e) {}
    try { bot.clearControlStates() } catch (e) {}

    // 绕路优先、不要跳崖：单独一套 movements，跟随结束会还原
    //
    // 【2026-11-14 摔死修复】还原时必须还原**进入跟随之前那个对象**，
    // 不能 new 一个默认 Movements。原来 stop() 里是：
    //   bot.pathfinder.setMovements(new Movements(bot, mcData))
    // 默认对象的 maxDropDown = 4（引擎默认值），于是跟完一次人，
    // main.js 里配好的 maxDropDown=3 就被悄悄换成 4 —— 4 格落地要掉血。
    // 顺带 digCost 20→1、liquidCost 20→1、脚手架方块也少两种。
    // 这是「跟随落点判定和普通移动不一致」的根因：不是判定不一致，
    // 是跟随结束后全局寻路被降级了，而且再也回不来。
    try {
      const prev = bot.pathfinder.movements || null
      if (prev) this._prevMovements = prev
      const mv = new Movements(bot, require('minecraft-data')(bot.version))
      mv.allowParkour = false        // 不跳障碍（真人不为了跟人连着蹦）
      mv.allow1by1towers = false     // 不原地搭柱子追人
      mv.canDig = false              // 跟着的时候不挖墙
      mv.maxDropDown = 2             // 最多从 2 格高处下来
      mv.scafoldingBlocks = []
      this._safeMovements = mv
      bot.pathfinder.setMovements(mv)
    } catch (e) { this._safeMovements = null }

    this.log(`[invite] 接了 ${name} 的邀请（"${String(said).slice(0, 16)}"）-> 开始跟`)

    // 第一句：答应一句，带他名字
    // 「等我把这块弄完」兑现过去时，说的话不一样（不是"答应了"，是"我来了"）
    this._say(opts.line || `你答应了 ${name}，回一句就跟他走（要说他的名字，别客套）`,
      { force: true, people: [name] })
    return true
  }

  /** 散伙 */
  stop (why, opts = {}) {
    const bot = this._bot
    const was = this.active
    const who = this.target
    this.active = false
    this.target = null
    this._idleHeld = false
    if (!was) return
    this.stats.stops++
    this._ev({ what: 'stop', why, who })

    try { if (bot) bot.pathfinder.setGoal(null) } catch (e) {}
    // 还原寻路设置：还原到**跟随之前那个 Movements 对象**（main.js 配的
    // canDig/digCost/liquidCost/scafoldingBlocks/maxDropDown=3 都在里面）。
    // 只有当前还挂着跟随副本时才还原，别把别人后来换的配置盖掉。
    try {
      if (bot && this._safeMovements && bot.pathfinder.movements === this._safeMovements) {
        if (this._prevMovements) {
          bot.pathfinder.setMovements(this._prevMovements)
        } else {
          bot.pathfinder.setMovements(new Movements(bot, require('minecraft-data')(bot.version)))
        }
      }
      this._safeMovements = null
      this._prevMovements = null
    } catch (e) {}

    this.log(`[invite] 结束跟随 ${who || ''}（${why}）`)
    if (!opts.quiet && who && why !== 'asked') {
      // 【实机踩到】target 已经清空了，再说"你"就变成了对空气说话；
      // people 必须在这里显式带上，LLM 才知道该喊谁的名字。
      this._say(`你跟着 ${who} 走着走着就散了（${this._whyText(why)}），用一句话说一下`,
        { chance: 0.5, people: [who] })
    }
  }

  _whyText (why) {
    return { lost: '人不见了', timeout: '跟太久了', bored: '跟够久了，该干点别的了', far: '他跑太远了', detach: '不算' }[why] || why
  }

  // ================================================================
  // 每秒一次
  // ================================================================

  async tick () {
    // 没在跟人的时候也要看一眼："等我把这块弄完就来"的那种约定到点了没有
    if (!this.active) {
      this._tickPendingRecover()    // "我快不行了…缓过来就去找你"这条也得有下文
      this._tickPendingFollow()
      return
    }
    const bot = this._bot
    if (!bot || !bot.entity || !bot.entity.position) return
    if (this._tickBusy) return
    this._tickBusy = true
    try { this._tick(bot) } finally { this._tickBusy = false }
  }

  _tick (bot) {
    const now = this._now()
    const o = this.opts
    const me = bot.entity.position

    // 跟到 3 分钟：问一句（真人会问"还走啊"），不是默默跟到底
    if (o.askAtMs && !this._askedAt && now - this.startedAt > o.askAtMs) {
      this._askedAt = now
      const who = this.target
      this._say(`你跟 ${who} 已经走了三分钟了。说一句：还走吗？我这边好像还有点事。`,
        { chance: 0.8, people: [who] })
    }
    if (now - this.startedAt > o.maxFollowMs) { this.stop('bored'); return }

    const pl = bot.players[this.target]
    const ent = pl && pl.entity
    if (!ent || !ent.position) {
      if (now - this._lastSeen > o.lostMs) {
        this.stats.lost++
        this._say(`你跟丢了 ${this.target}（看不见了），说一句找他的`, { chance: 0.7 })
        this.stop('lost')
      }
      return
    }

    this._lastSeen = now
    const tgt = ent.position
    const d = me.distanceTo(tgt)
    this.stats.samples.push({ t: now, d: +d.toFixed(1), act: d <= o.followRange + 0.6 })
    if (this.stats.samples.length > 2000) this.stats.samples.shift()

    // 玩家是不是在动（判断"他停了，我也停"）
    const movedTick = this._lastPos ? this._lastPos.distanceTo(tgt) : 99
    const playerMoving = movedTick > 0.25
    if (movedTick > 0.1) this._stillSince = now
    const stillFor = now - (this._stillSince || now)
    if (!this._lastPos || this._lastPos.distanceTo(tgt) > 1.5) {
      this._lastPos = tgt.clone ? tgt.clone() : { x: tgt.x, y: tgt.y, z: tgt.z }
      this._lastMovedAt = now
    }
    const playerIdle = now - this._lastMovedAt > o.idleStopMs

    // ── 太近：退半步，别站人身上 ────────────────────────────
    //  · 只在玩家**站着不动**又贴脸的时候才退（人家路过，你躲什么）
    //  · 2 秒冷却：不然他一秒退一次，看起来像抽搐
    if (d < o.tooClose) {
      // 站定 1.5 秒以上才退：路过/擦肩而过的人不用躲
      if (stillFor > 1500 && now - this._lastBackoffAt > 2000) {
        this._lastBackoffAt = now
        try {
          bot.pathfinder.setGoal(null)
          bot.setControlState('back', true)
          setTimeout(() => { try { bot.setControlState('back', false) } catch (e) {} }, 260)
          this.stats.backoffs++
          this._ev({ what: 'backoff', d: +d.toFixed(1) })
        } catch (e) {}
      } else {
        try { bot.pathfinder.setGoal(null) } catch (e) {}
      }
      return
    }

    // ── 太远：先喊人，再追 ─────────────────────────────────
    if (d > o.farShout) {
      if (now - this._lastShoutAt > o.shoutGapMs) {
        this._lastShoutAt = now
        this.stats.shouts++
        this._say(`${this.target} 已经走远到 ${Math.round(d)} 格了，你喊一句让他等等（要带他名字）`, { force: true })
      }
      if (d > o.giveUpDist && now - (this._farSince || now) > 10000) {
        this.stats.giveUp++
        this.stop('far')
        return
      }
      this._farSince = this._farSince || now
    } else {
      this._farSince = null
    }

    // ── 玩家站着不动：别贴着他催，站旁边等 ──────────────────
    //      但如果他站在我下面/上面好几格（比如跳下去了），那不叫"在一起"，
    //      得走绕路分支，不能当成"跟着呢"糊过去。
    const dyNow = tgt.y - me.y
    if (playerIdle && d <= o.followRange + 2 && Math.abs(dyNow) <= 2) {
      if (!this._idleHeld) {
        this._idleHeld = true
        try { bot.pathfinder.setGoal(null) } catch (e) {}
        this.log(`[invite] ${this.target} 停下了，我也停（不催）d=${d.toFixed(1)}`)
      }
      return
    }
    if (!playerIdle) this._idleHeld = false

    // ── 高差太大：不直接跳，绕 ─────────────────────────────
    const dy = tgt.y - me.y
    const dh = Math.hypot(tgt.x - me.x, tgt.z - me.z)
    if (dy < -3 && dh < 6) {
      // 他在下面：不跳下去，沿着水平方向找坡度过去
      this.stats.ledgeGuards++
      this._ev({ what: 'ledgeGuard', dy: +dy.toFixed(1), d: +d.toFixed(1) })
      try {
        const gx = Math.floor(me.x + (tgt.x - me.x) * 0.6)
        const gz = Math.floor(me.z + (tgt.z - me.z) * 0.6)
        bot.pathfinder.setGoal(new goals.GoalNear(gx, Math.floor(me.y), gz, 2))
        this.stats.goals++
      } catch (e) {}
      return
    }

    // ── 正常跟随 ───────────────────────────────────────────
    // 【实机】领队 3 分钟走了 179 格，跟随时 p90 落后到 12 格 —— 因为原来每 700ms
    // 才允许重下一次目标，他拐弯/下坡时就跟不上。落远（>8 格）立刻重下，不等节流。
    const urgent = d > 8
    if (d > o.followRange + 0.6 && (urgent || now - this._lastGoalAt > 700)) {
      this._lastGoalAt = now
      try {
        // GoalFollow 是动态目标：玩家走，goal 自动跟着走；他到 2 格内 pathfinder 自己停
        bot.pathfinder.setGoal(new goals.GoalFollow(ent, o.followRange - 0.5), true)
        this.stats.goals++
      } catch (e) {
        this.log('[invite] setGoal 失败：' + e.message)
      }
    }

    // ── 跟着的时候搭一句话（不催，只是有人味） ──────────────
    if (now - this._lastChatAt > 45000 && d < o.farShout) {
      this._lastChatAt = now
      this._say(`你正跟着 ${this.target} 走，路上一句闲聊（问去哪 / 说跟着呢），别催他`, { chance: 0.35 })
    }
  }

  // ================================================================
  // 说话
  // ================================================================

  async _say (situation, opts = {}) {
    const now = this._now()
    if (!opts.force && now - (this._lastSaidAt || 0) < this.opts.chatGapMs) return false
    try {
      const said = await this.speak(situation, Object.assign({
        chance: 0.85,
        maxLen: 22,
        people: this.target ? [this.target] : []
      }, opts))
      if (said) {
        this._lastSaidAt = now
        this.stats.lines++
        this._ev({ what: 'say', situation: String(situation).slice(0, 30) })
      }
      return !!said
    } catch (e) { return false }
  }

  _ev (e) {
    e.t = this._now()
    this.stats.events.push(e)
    if (this.stats.events.length > 400) this.stats.events.shift()
  }

  // ================================================================
  // 数据口
  // ================================================================

  report () {
    const s = this.stats.samples
    const near = s.filter(x => x.act)
    return {
      active: this.active,
      target: this.target,
      invites: this.stats.invites,
      accepted: this.stats.accepted,
      refused: this.stats.refused,
      deferred: this.stats.deferred || 0,
      followThru: this.stats.followThru || 0,
      firstCall: this.stats.firstCall || 0,
      recover: this.stats.recover || 0,
      stops: this.stats.stops,
      lines: this.stats.lines,
      shouts: this.stats.shouts,
      goals: this.stats.goals,
      backoffs: this.stats.backoffs,
      ledgeGuards: this.stats.ledgeGuards,
      lost: this.stats.lost,
      giveUp: this.stats.giveUp,
      samples: s.length,
      nearRatio: s.length ? +(near.length / s.length).toFixed(2) : null,
      maxDist: s.length ? Math.max(...s.map(x => x.d)) : null,
      avgDist: s.length ? +(s.reduce((a, b) => a + b.d, 0) / s.length).toFixed(1) : null
    }
  }
}

module.exports = { Invite, INVITE_RE, STOP_RE, DEFAULTS }
