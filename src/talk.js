'use strict'
/**
 * 说话。
 *
 * 核心原则：**不预设任何台词**。
 *
 * 之前我写死了"搞定了""我又来了""艹，掉岩浆了"这些句子随机抽，
 * 结果就是他一遍遍说同样的话 —— 一眼人机。
 *
 * 真人在每个情境下说的话都不一样，因为：
 *   - 当时手上在干什么不同
 *   - 心情不同
 *   - 刚才聊到哪了不同
 *   - 死法不同
 * 所以这里全部交给模型按情境现编。哪怕它编得不够好，
 * 也好过抽卡一样的重复。
 */

const persona = require('./persona')
const secretsMod = require('./secrets')
const persuasion = require('./persuasion')
const realtime = require('./realtime')

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 进程级发言闸（2026-11-13 夜）。
 * 一个进程里可能有多个 Talk 实例（多 bot / 探针），各算各的会叠成 2~3 倍，
 * 服务器直接 disconnect.spam。放模块级：整个进程共用一个窗口。
 *
 * 【2026-11-14 补】实例自己的时钟（this.lastSayAt / this.sayWindow）和这个
 * 进程级时钟**两个都要过**。原因见 say() 里的注释：只信 GLOBAL_SAY 的话，
 * 「占坑」和「真发」会被算成两次间隔（占坑记一次、发之前再查一次，
 * 中间隔着 2~6 秒的模型往返），正常的话全被判成"太快"。
 */
const GLOBAL_SAY = { lastAt: 0, window: [] }

/**
 * 发言闸的默认值（单一出处）。
 * 测试脚本直接读 Talk.DEFAULTS，不要在别处再写一遍 5000 / 2500 这种魔数 ——
 * 之前 test-bot-identity 里硬编了旧值，改阈值以后测试测的是空气。
 */
const SAY_DEFAULTS = {
  sayGapMs: 2500,       // 常规：2.5 秒内最多 1 条
  fastSayGapMs: 1200,   // 被点名（话里带我的名字）时放宽
  sayWindowMs: 20000,
  sayWindowMax: 8       // 服务器阈值是 20 秒 20 条，这里留一半余量
}

/**
 * 2026 过时词 / 机器腔硬拦截。
 *
 * 【为什么要有这个】提示词里已经写了禁用清单，但模型会漏。
 * 这批词看着"很有网感"，实际是 2026 年所有接了大模型的 QQ bot 在说的话，
 * 早就成了机器味标志（参考 qfish 项目的 defaults/slang.json 与黑名单做法，
 * 2026-11 仍在维护的实测词表）。详细语料见 docs/ALIVE-TONE.md §2.3。
 *
 * 【拦截力度分两种】
 *   - 整句级的套路词（就这/笑死/行吧/哎呦）只在**句首或独立成句**时拦，
 *     避免把"笑死我了""行吧你说得对"这种半自然的话一刀切死。
 *   - 机器腔连词（本质上/说白了/换句话说）出现就拦，这些词在任何位置都是提示词味。
 */
const OBSOLETE_EXACT = [
  /^就这[?？!！。~～\s]*$/,
  /^笑死[?？!！。~～\s]*$/,
  /^行吧[。!！~～\s]*$/,
  /^哎呦|^哎哟/
]
const OBSOLETE_ANY = [
  /yyds/i, /绝绝子/, /2333/, /awsl/i, /\b666+\b/, /栓q/i, /芭比q/i,
  /emo了/i, /退退退/, /city不city/i, /松弛感/, /情绪价值/, /班味/,
  /家人们谁懂/, /记下了/,
  // 机器腔（2026 的新一批，比"首先其次"更隐蔽）
  /本质上/, /换句话说/, /说白了/, /总的来说/, /这事儿吧/, /总结一下/
]

/** 这句话是不是 2026 已经过时 / 一眼机器味 */
function isObsolete (text) {
  const t = String(text || '').trim()
  if (!t) return false
  if (OBSOLETE_EXACT.some(re => re.test(t))) return true
  return OBSOLETE_ANY.some(re => re.test(t))
}

/**
 * 指令式开头 / 结尾（2026-11-14，灾难级）。
 *
 * 【现场 · /tmp/soak.log 00:59:36】干净环境 3 分钟，唯一一句说出口的话是：
 *   [say] 答一句短的。大概意思是：看见你上线了。
 * 那是提示词里的指令，被模型当正文念了出来。玩家听到这一句就知道是 AI，
 * 比任何行为问题都致命。
 *
 * 【为什么 isMachineTalk / metaSignals 没拦住】
 * 它们数的是「字数 / 数值约束 / 规则引用 / 状态变量 / 自指」五类元信息信号，
 * "答一句短的"一类都不命中 —— 它不是元信息，它是**一条命令**。
 * 所以这里单独一条判据：**像在给自己下命令，不像在说话**。
 *
 * 【为什么结尾也要判】同一份日志 01:02:14 还有一句
 *   [say] 是不是新人？直接说
 * "直接说"是提示词的尾巴，同样单独命中就拦。
 *
 * 【误伤控制】"说""回"单独出现不拦（"说真的""回答了问题"要放行），
 * 必须带上数量/长短这类**指令限定语**，或者跟在标点后面独立成尾。
 */
const INSTRUCTION_PREFIX = /^(?:(?:答|说|回|讲|喊|喊话|告诉|回复|回答|念叨|嚷)(?:一句|两句|一句话|两句话|句把|句话)(?:短|长)?的?(?:[。.，,：:！!]|$)|(?:答|说|回|讲|喊|告诉|回复|回答)(?:短|长)的?[。.，,：:！!]|大概意思|意思是\s*[：:，,]|如下[：:]|用.{0,6}的语气)/

const INSTRUCTION_TAIL = /[。！？!?；;，,]\s*(?:直接说|直接回答|直接回|一句话就行|说一句就行|简短点说|别多说)[。！!]?$/

/** 这句话是不是把提示词里的指令当正文说出来了 */
function isInstructionLeak (text) {
  const t = String(text || '').trim()
  if (!t) return false
  return INSTRUCTION_PREFIX.test(t) || INSTRUCTION_TAIL.test(t)
}

/**
 * 反应层：先垫一句（2026-11-14）。
 *
 * 【为什么】receive → 模型（2~6 秒）→ 限速 → 才开口。用户问「你在干啥」，
 * 真人 2~3 秒就回，他 6 秒；而且真人在忙的时候会**先秒回一个短词**："等下""咋了"。
 * 这不是 bug，是"这人反应好慢" —— 第一分钟就会撞上。
 *
 * 【为什么要分池子】固定一个"嗯"就是敷衍机。短词要跟当前状态挂钩：
 *   busy     → 让对方知道你活着、只是在忙（"等下""等我把这块弄完"）
 *   called   → 被叫名字，应一声（"咋了""在呢"）
 *   question → 被问，表示在听（"嗯？""你说"）
 *   recovery → 垫了话却一直没等到真回复，补一句收尾（比只留一个"等下"强）
 *
 * 【为什么池子里给 6 个】同一个词连着出现两次，人就会看出是模板。
 * pickVaried 会避开最近两次说过的。
 */
const ACK_POOLS = {
  busy: ['等下', '等我把这块弄完', '忙完这阵', '马上', '这就来', '稍等'],
  called: ['咋了', '在呢', '嗯？', '来了', '说', '我在'],
  question: ['嗯？', '你说', '咋了', '我听着', '什么'],
  recovery: ['刚才走神了，你说啥', '刚没听着，再说一遍', '刚才在忙，你说啥来着', '嗯？刚才没注意']
}

/** 从池子里挑一个，避开最近说过的两个 */
function pickVaried (pool, recent) {
  if (!pool || !pool.length) return null
  const avoid = new Set((recent || []).slice(-2))
  const left = pool.filter(x => !avoid.has(x))
  const arr = left.length ? left : pool
  return arr[Math.floor(Math.random() * arr.length)]
}

/**
 * 主题级复读拦截（2026-11-13，用户实机截图抓到的病）。
 *
 * 【现场】十句里六句是同一批意思：
 *   一转眼就没影了 → 眨眼就没影了
 *   那我睡了啊   → 是该睡了 → 我躺了
 *   你自己弄吧   → 你那边自己搞定
 * 每次都**成功接住了对方的词**，然后拿同一个意思反复说。
 * 字面去重（findRecentDuplicate）抓不到：睡了 / 躺了 / 该睡了 字面完全不同。
 *
 * 【为什么只拦"社交主题"】挖矿、打怪这类**任务主题**反复出现是正常的
 * —— 对方一直在问，你就得一直答。真正像客服的是"别人的生活状态"被反复复读：
 * 睡、走、帮忙、卡不卡、开没开挂。这类只该回一次。
 */
const SOCIAL_THEMES = [
  { id: 'sleep', label: '睡觉/下线', re: /睡|躺|歇|熬|下线|困了?|晚安|早点休息/ },
  { id: 'leave', label: '没影/走了', re: /没影|眨眼|一转眼|不见|消失|人呢|跑哪|走了|跑哪去/ },
  { id: 'help', label: '自己弄/帮忙', re: /自己(弄|搞|搞定|来|整|干)|帮我|帮忙|搭把手|带上我/ },
  { id: 'cheat', label: '外挂', re: /外挂|开挂|作弊/ },
  { id: 'lag', label: '卡/延迟', re: /卡|延迟|掉线/ },
  { id: 'eat', label: '吃饭', re: /吃饭|吃了|外卖/ }
]

/** 这句话踩到了哪些社交主题（返回 id 数组） */
function socialThemesOf (text) {
  const t = String(text || '')
  if (!t) return []
  const out = []
  for (const th of SOCIAL_THEMES) if (th.re.test(t)) out.push(th.id)
  return out
}

function themeLabel (id) {
  const th = SOCIAL_THEMES.find(x => x.id === id)
  return th ? th.label : id
}


class Talk {
  constructor (bot, llm, mem, ctx) {
    this.bot = bot
    this.llm = llm
    this.mem = mem
    this.ctx = ctx
    this.history = []
    this.lastSpoke = 0
    this.lastSpokeAt = 0
    this.pendingDemand = null
    this.persuasion = new persuasion.Persuasion(ctx.dataDir || '/tmp')
    this.recentSaid = []      // 最近说过的话，用于语气疲劳判断
    this.recentModes = []     // 最近几句是"接住对方"还是"说自己的"（岔开比例用）
    this.themeUses = []       // [{id, at}] 最近说过哪些社交主题（话题预算，10 分钟窗口）
    this.botChain = []        // 检测 bot 之间的对话链
    this.deferred = []        // 忙的时候没回/说要等会儿的，得回头接
    this.repliedMsgIds = new Map()  // 哪条消息已经回过了（防止多条路径重复回）
    this.lastReplyTo = null   // 上一条是回给谁的
    // 发言限速（B 方案）。cost-owner 实测两个 AI 互相对答时**单秒最多 11 条公屏**，
    // 这已经不是"话多"，是刷屏。真人不会 1 秒说 11 句。
    // 刚说出口的"我要去做 X"（UNHUMAN-SCAN #4）。
    // 说"下去转转"2 秒后改主意挖金矿，玩家看着就是"说话不算数"。
    // 这里只**记录**，降不降概率由 impulse.maybe() 决定 —— 不硬拦。
    this.lastIntention = null
    this.lastSayAt = 0
    // 【2026-11-14 改】5 秒 → 2 秒。
    // 实测日志（/tmp/soak.log）6 次限速拦的全是正常社交回复：
    //   「天黑这么快」「来了啊」「看见你上来了」「玩不玩啊」，间隔 2196~4643ms。
    // 真人聊天间隔 2~4 秒是常态，5 秒的闸门把正常话全拦了，方向反了。
    // 定 2000：2 秒间隔 = 20 秒 10 条，离服务器的 20 条/20 秒还有一半余量。
    this.sayGapMs = Talk.DEFAULTS.sayGapMs          // 常规：2.5 秒内最多 1 条
    this.fastSayGapMs = Talk.DEFAULTS.fastSayGapMs  // 被点名（话里带我的名字）时放宽到 1.2 秒
    // 硬窗口保持不变：Paper 的 spam 阈值是「20 秒内 20 条」（实测被踢前 20s 说了 21~27 条）。
    // 现在 20 秒最多 8 条，比阈值低一半还多 —— 正常对话过的去，刷屏过不去。
    this.sayWindowMs = Talk.DEFAULTS.sayWindowMs
    this.sayWindowMax = Talk.DEFAULTS.sayWindowMax
    this.sayWindow = []           // 最近 20 秒真的发出去的时刻
    this.sayGapBlocked = 0        // 被限速拦下的条数（验收用）
    this.sayWindowBlocked = 0
    this.noiseBlocked = 0         // 被当成 prompt/指令丢掉的入站消息数

    // ===== 反应层（两级回复）· 2026-11-14 =====
    // 第一级：忙的时候 500ms 先垫一个短词；第二级：照常走模型。
    // 垫话**不占发言闸**（sayGap / sayWindow 都不动）—— 它是"反应"，不是"说话"。
    // 但另有一道更松的硬上限，防的是反应层自己变成刷屏（服务器阈值 20 条/20 秒）。
    this.ackDelayMs = 500        // 垫话延迟：立刻发反而不像人在打字
    this.ackRecoveryMs = 8000    // 垫了话，这么久没等到真回复就补一句
    this.ackGapMs = 10000        // 10 秒内不重复垫
    this.reactionWindowMs = 20000
    this.reactionWindowMax = 6
    this.ackWindow = []          // 反应层最近 20 秒发出去的时刻
    this.lastAckAt = 0
    this.recentAcks = []         // 最近垫过哪些词（避免连着重样）
    this.ackSent = 0             // 垫过几句（验收用）
    this.ackSkipped = 0          // 该垫但没垫的次数
    this.ackRecovered = 0        // 补过几句收尾
    this._ackTimer = null
    this._ackRecoveryTimer = null
    this._ackSentAt = 0
  }

  /**
   * 语气疲劳检查：如果最近几句都是同一种反应，这次要换。
   * 这是 personagent 的 register-fatigue 规则。
   */
  /**
   * 语气疲劳检查：如果最近几句都是同一种反应，这次要换。
   * 这是 personagent 的 register-fatigue 规则。
   *
   * 【2026-11-13 扩】用户实机截图抓到"语义复读"：每句都成功接住对方的词，
   * 但连着三句说的是同一个意思（睡 → 该睡了 → 躺了）。
   * 字面去重（findRecentDuplicate）抓不到这种。所以这里加两件：
   *   1) 最近三句里同一个社交主题出现 ≥2 次 → 明令这个话题已经用完
   *   2) 最近三句全在"接话"、没有一句"说自己的" → 明令这一句必须岔开
   */
  fatigueHint () {
    const recent = this.recentSaid.slice(-3)
    const parts = []

    if (recent.length >= 2) {
      const kinds = recent.map(r => r.kind).filter(Boolean)
      const same = kinds.length >= 2 && kinds.every(k => k === kinds[0])
      // 开头字重复也算。注意是**相邻两句**就算 —— 日志里的真实序列是
      // 「嗯，好」「回来了，刚爬上去做石镐呢」「回来了，问第三遍了」，
      // 三句全同的要求永远等不到，等于这个机制从来没生效过。
      const heads = recent.map(r => String(r.text || '').slice(0, 2))
      const sameHead = heads.length >= 2 && heads.some((h, i) => i > 0 && h === heads[i - 1])

      if (same || sameHead) {
        const lastTexts = recent.map(r => `"${r.text}"`).join('、')
        parts.push(`【重要】你最近说过 ${lastTexts}，都是同一个路数。
这次必须换，不能再这样：
- 换成平淡的："嗯" "行" "哦" "可以"
- 或者换个角度说，别用一样的句式开头
- 或者干脆不说（输出 [不说] / [不理]）
连着用同一种反应说话，会显得很假。`)
      }
    }

    // 主题级：最近三句里同一个社交话题出现 ≥2 次
    const cutoff = Date.now() - 10 * 60 * 1000
    const used = {}
    for (const u of (this.themeUses || []).filter(x => x.at >= cutoff)) used[u.id] = (used[u.id] || 0) + 1
    for (const r of recent) for (const id of socialThemesOf(r.text)) used[id] = (used[id] || 0) + 1
    const exhausted = Object.keys(used).filter(id => used[id] >= 2)
    if (exhausted.length) {
      parts.push(`【这条尤其重要】"${exhausted.map(themeLabel).join('""')}"这个话题，你最近几句里已经说过好几回了。
这一句**不许再碰这个话题**——不评论、不附和、不换个词再说一遍。
要么说你自己的事（手上在干嘛、自己碰到什么），要么只应一声，要么干脆不说。`)
    }

    // 岔开比例：最近三句全在接对方的话，一句自己的事都没有
    const modes = this.recentModes.slice(-3)
    if (modes.length === 3 && modes.every(m => m === 'reach')) {
      parts.push(`【这一句】你连着三句都在回应对方。真人不会这样，会有一句说的是自己。
这一句**必须**是你自己的事（你手上在干嘛、身上什么事、刚才碰到什么），
或者干脆不说（输出 [不理]）。别再接他的话。`)
    }

    return parts.length ? '\n\n' + parts.join('\n\n') : ''
  }

  /**
   * 把"现在在干嘛"说清楚。
   * 说话要跟手上的事挂钩，不然像客服。
   */
  describeDoing () {
    if (this.ctx.busy && this.ctx.busy()) {
      const task = this.ctx.taskDesc ? this.ctx.taskDesc() : ''
      return task ? `你正忙着${task}，是中途停下来说话的。` : '你正忙着。'
    }
    return '你现在手头没别的事。'
  }

  /** 直接说一句（已经有内容了） */
  /**
   * 现在这个时刻能不能发一条（限速 + 20 秒硬窗口）。
   *
   * 【为什么要单独抽出来 · 2026-11-13 23:40】
   * detail-fixer 实测：10 分钟里 [say] 108 条、限速拦了 254 次、任务只启动 1 次。
   * 也就是说**模型被白叫了 254 次** —— 限速放在 say() 里只挡住了"发出去"，
   * 前面那一次 LLM 调用（2~6 秒 + 上下文）照付。他时间全花在生成注定要丢掉的话上。
   * 所以这里抽一个前置判断：注定发不出去，就**别调模型**。
   */
  /**
   * 占坑：判定能说 + 立刻把坑占掉。
   *
   * 只做 canSpeakNow 的判断是不够的：onChat / 事件队列 / 回头接话是三条并发路径，
   * 它们会在**同一瞬间**都通过判断，然后各自去叫模型（实测 10 分钟白叫 43 次）。
   * 这里在判断通过的同时把时间戳写进窗口，后面的路径再进来就会被挡。
   * 占坑后如果最终没说（模型拒说/被拦），这个坑不退还 —— 宁可少说，不连发。
   */
  reserveSpeak (opts = {}) {
    if (!this.canSpeakNow(opts)) return false
    this.stampSpeak(Date.now())
    return true
  }

  /** 记一次发言（占坑或真发出去都算）：实例时钟和进程时钟一起走 */
  stampSpeak (now) {
    this.lastSayAt = now
    GLOBAL_SAY.lastAt = now
    if (!Array.isArray(this.sayWindow)) this.sayWindow = []
    this.sayWindow.push(now)
    GLOBAL_SAY.window.push(now)
    this.trimSayWindows(now)
  }

  /** 丢掉窗口外的旧时间戳 */
  trimSayWindows (now) {
    this.sayWindow = (this.sayWindow || []).filter(x => now - x < this.sayWindowMs)
    GLOBAL_SAY.window = GLOBAL_SAY.window.filter(x => now - x < this.sayWindowMs)
  }

  canSpeakNow (opts = {}) {
    const now = Date.now()
    const minGap = opts.allowFast ? this.fastSayGapMs : this.sayGapMs
    // 两个时钟取**更近的那个**：实例管自己，GLOBAL_SAY 管同进程多实例
    const lastAt = Math.max(this.lastSayAt || 0, GLOBAL_SAY.lastAt || 0)
    if (now - lastAt < minGap) return false
    const mine = (this.sayWindow || []).filter(x => now - x < this.sayWindowMs).length
    const globalCount = GLOBAL_SAY.window.filter(x => now - x < this.sayWindowMs).length
    return Math.max(mine, globalCount) < this.sayWindowMax
  }

  async say (text, opts = {}) {
    if (!text) return false
    let t = String(text).trim()
    if (!t) return false

    // ===== 断线了就别再说 =====
    //
    // 【实测 · 2026-11-14】p8-final.log 22:08:04 被 disconnect.spam 踢掉，
    // 之后 13 秒里 `[say]` 还在继续打日志、说了 20 多句（「早撤了 谁还搁那儿泡着」
    // 「嗯 你走 我后头跟着」…）—— 这些一个字都发不出去（socketClosed），
    // 但 lastSayAt / GLOBAL_SAY / lastSpokeAt 全被更新了。
    //
    // 后果有三层：
    //   ① 白白消耗限速额度，重连后想说真话时闸门还卡着
    //   ② 白花 LLM 调用（每句都是几秒钟的往返）
    //   ③ 如果 mineflayer 在断线期间把消息攒着，重连后一次性倒出来 = 又一个 spam 循环
    //
    // 所以：没有实体（没连上/已断）直接拒，且**不更新任何状态**。
    // 判定用 _client：真实 bot 一定有它，测试里的假 bot 没有（不能把假 bot 全拦了）。
    // `_client.ended` 是断线，`!bot.entity` 是还没 spawn / 已经掉了。
    try {
      if (!this.bot) return false
      const cli = this.bot._client
      if (cli && cli.ended) return false
      if (cli && !this.bot.entity) return false
    } catch (e) { return false }
    if (t.length > 180) t = t.slice(0, 180)

    // ===== 发言限速（B 方案）=====
    // 实测两个 AI 互相对答：A 说 105 句 / B 说 31 句，单秒最多 11 条公屏。
    // 这里放在 say() —— 所有出口的唯一收口，任何路径都绕不过去。
    // 不是排队等待，是**直接不说**：真人在刷屏的群里也是一句话不说，而不是攒着补发。
    //
    // 【2026-11-14 修的坑 · 为什么"正常话全被拦"】
    // 上游 speak() / reply() 会先 reserveSpeak() 占坑（占坑会写 lastSayAt），
    // 然后才去叫模型（2~6 秒），回来再调 say()。旧代码在 say() 里
    // **又**拿 lastSayAt 比了一次 —— 比到的其实是"模型往返耗时"，不是"上一句到这一句"。
    // 日志证据：00:59:36 说过一句，00:59:47 又想说话（真实间隔 11 秒），
    // 却报 "距上一条 3124ms < 5000ms"。占坑的坑被当成了上一句话。
    // 所以：**已经占过坑的调用必须带 opts.reserved**，这里不再重复判间隔。
    const nowSay = Date.now()
    const minGap = opts.allowFast ? this.fastSayGapMs : this.sayGapMs
    if (!opts.reserved) {
      const lastAt = Math.max(this.lastSayAt || 0, GLOBAL_SAY.lastAt || 0)
      const gap = nowSay - lastAt
      if (gap < minGap) {
        this.sayGapBlocked++
        this.ctx.log(`[say 限速] 距上一条 ${gap}ms < ${minGap}ms，这句不说：${t.slice(0, 16)}`)
        return false
      }
      // 硬窗口：不管是不是被点名，20 秒内最多 8 条
      this.trimSayWindows(nowSay)
      const winCount = Math.max(this.sayWindow.length, GLOBAL_SAY.window.length)
      if (winCount >= this.sayWindowMax) {
        this.sayWindowBlocked++
        this.ctx.log(`[say 限速] 20 秒内已发 ${winCount} 条，这句不说：${t.slice(0, 16)}`)
        return false
      }
    }

    // 最后一道闸：纯标点/空白一律不发（UNHUMAN-SCAN #1）。
    // 走到这里说明上游某个调用方绕过了 cleanLine（或者模型只吐了标点）。
    if (!hasRealContent(t)) {
      this.ctx.log('[say blocked: 只有标点] ' + JSON.stringify(t))
      return false
    }

    // 指令泄漏（2026-11-14 · 灾难级）：把提示词里的命令当正文念出来了
    if (isInstructionLeak(t)) {
      this.ctx.log('[instruction leak blocked] ' + t.slice(0, 60))
      return false
    }

    if (persona.isLeak(t)) {
      this.ctx.log('[leak blocked] ' + t)
      return false
    }
    // 说出程序味的话就别说了（宁可不说，也不能念日志）
    if (persona.isMachineTalk(t)) {
      this.ctx.log('[machine talk blocked] ' + t)
      return false
    }
    // 2026 过时词 / 机器腔（见文件头 OBSOLETE_*）
    if (isObsolete(t)) {
      this.ctx.log('[obsolete word blocked] ' + t)
      return false
    }

    // 思考泄漏：一句话里出现两类以上"元信息"，它是在跟提示词说话（2026-11-13）
    if (persona.isMetaLeak(t)) {
      this.ctx.log('[meta leak blocked] ' + JSON.stringify(persona.metaSignals(t)) + ' ' + t.slice(0, 40))
      return false
    }

    // 血量一致性：实际不满血就别嘴硬说满（用户抓的"血 14 说满血"）
    if (Number.isFinite(this._hp) && this._hp < 18 && /满血|血(是|还|挺)?满|血没掉|血一点没掉/.test(t)) {
      this.ctx.log(`[hp contradiction] 实际血 ${this._hp}/20 却这么说：${t}`)
      return false
    }

    // 危险态硬上限：提示词管方向，这里管底线（超了就整句不发，绝不截半句）
    const danger = opts.danger || this._danger || 'ok'
    const bodyLen = String(t).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').length
    const cap = danger === 'critical' ? 4 : (danger === 'hurt' ? 9 : Infinity)
    if (bodyLen > cap) {
      this.ctx.log(`[danger cap] ${danger} 上限 ${cap} 字，这句 ${bodyLen} 字，不发：${t.slice(0, 24)}`)
      return false
    }

    // ===== 复读硬拦截（UNHUMAN-SCAN #2）=====
    // fatigueHint 只是往提示词里塞"你最近说过 X，必须换"，模型可以无视 ——
    // 实测「东西带齐了，下去转转」98 秒内一字不差说了两遍。
    // 这里在代码层拦：跟最近几句**去标点后完全相同**就直接不说。
    //
    // 为什么放在 say() 而不是 speak()：say() 是所有出口的唯一收口
    // （speak / reply / 直接调用都走这里），放这里才拦得住每条路。
    const dupOf = this.findRecentDuplicate(t)
    if (dupOf) {
      this.ctx.log(`[repeat blocked] ${Math.round((Date.now() - dupOf.at) / 1000)} 秒前刚说过：${t}`)
      return false
    }

    await this.humanDelay(t)
    try {
      this.bot.chat(t)
      this.lastSpoke = Date.now()
      this.lastSpokeAt = Date.now()
      this.lastSayAt = Date.now()
      GLOBAL_SAY.lastAt = this.lastSayAt
      // 已经由 reserveSpeak 占过坑的不要重复计数（否则窗口一半就被填满）
      if (!opts.reserved) {
        if (!Array.isArray(this.sayWindow)) this.sayWindow = []
        this.sayWindow.push(this.lastSayAt)
        GLOBAL_SAY.window.push(this.lastSayAt)
        this.trimSayWindows(this.lastSayAt)
      }
      this.ctx.log('[say] ' + t)
      // 真话已经出去了：还没发的那句垫话就没意义了
      this.cancelPendingAck()
      // 真的打出去了才记进 recentSaid（语气疲劳 + 复读拦截都靠它）
      this.recentSaid.push({ text: t, at: Date.now(), kind: detectSayKind(t) })
      if (this.recentSaid.length > 10) this.recentSaid.shift()
      // 说了"我下去了/我去挖"就记一笔（没发出去的不算，所以放这里）
      this.noticeIntention(t)
      return true
    } catch (e) {
      return false
    }
  }

  /** 按字数模拟打字时间 */
  async humanDelay (text) {
    const cfg = this.ctx.cfg.behavior
    const base = cfg.chatDelayPerChar * text.length
    const jitter = Math.random() * 800
    const d = Math.min(cfg.chatMaxDelay, Math.max(cfg.chatMinDelay, base + jitter))
    await sleep(d)
  }

  // ============================================================
  // 反应层：两级回复（2026-11-14）
  // ------------------------------------------------------------
  //   收到消息 ──500ms──→ 短词（不占发言闸）
  //        └──2~6 秒──→ 真回复（走模型，占闸）
  //
  // 只在"对方确实在问他/叫他 + 他手上正忙"的时候垫。
  // 闲的时候模型本来就快，多垫一句就是多嘴。
  // ============================================================

  /**
   * 该不该先垫一句。
   * @returns {boolean}
   */
  needsAck (message, username, opts = {}) {
    const m = String(message || '')
    if (!m) return false
    // 危险时不垫：那时候短句是另一套规则，血 4 还说"等下"会显得没在跑
    const danger = opts.danger || 'ok'
    if (danger !== 'ok') { this.ackSkipped++; return false }
    // 只在**手上正忙**的时候垫（对方的等待才值得先给个回音）
    const busy = !!(this.ctx.busy && this.ctx.busy())
    if (!busy) { this.ackSkipped++; return false }
    // 刚垫过就不垫：10 秒内不重复，否则每句都"等下"，立刻变敷衍机
    if (this.lastAckAt && Date.now() - this.lastAckAt < this.ackGapMs) { this.ackSkipped++; return false }
    // 一定得是在问他/叫他，纯聊天不垫（不然会变成到处插一句"嗯"）
    const called = /(在不在|在吗|在么|来一下|过来|人呢)/.test(m) || m.includes(this.bot.username)
    const question = /[?？]/.test(m) || /(吗|呢|么)[\s。.!！?？]*$/.test(m)
    if (!called && !question) { this.ackSkipped++; return false }
    return true
  }

  /**
   * 挑一个短词。跟当前状态挂钩，不是固定台词。
   * 优先级：忙 > 被叫 > 被问 —— 忙的时候"等下"比"咋了"有用，
   * 对方一眼就知道你没死，只是在干活。
   */
  pickAck (message) {
    const m = String(message || '')
    const busy = !!(this.ctx.busy && this.ctx.busy())
    const called = m.includes(this.bot.username) || /(在不在|在吗|在么|过来|来一下)/.test(m)
    const question = /[?？]/.test(m) || /(吗|呢|么)[\s。.!！?？]*$/.test(m)
    const pool = busy ? ACK_POOLS.busy : (called ? ACK_POOLS.called : (question ? ACK_POOLS.question : null))
    if (!pool) return null
    return pickVaried(pool, this.recentAcks)
  }

  /**
   * 排一句垫话（500ms 后发）。
   * 不 await：它必须跟模型请求并行，否则就白垫了。
   */
  scheduleAck (message, username, danger) {
    if (this._ackTimer) return false
    if (!this.needsAck(message, username, { danger })) return false
    const text = this.pickAck(message)
    if (!text) return false
    const scheduledAt = Date.now()
    this.ctx.log(`[ack] ${this.ackDelayMs}ms 后先垫一句：${text}`)
    this._ackTimer = setTimeout(() => {
      this._ackTimer = null
      // 模型比 500ms 还快 —— 真话已经在公屏上了，再垫就是重复
      if ((this.lastSpokeAt || 0) > scheduledAt) {
        this.ctx.log('[ack 取消] 真回复抢先了')
        return
      }
      this.sendReaction(text, 'ack')
    }, this.ackDelayMs)
    if (this._ackTimer.unref) this._ackTimer.unref()
    return true
  }

  /**
   * 发一条"反应"（垫话 / 补话）。
   *
   * 不占发言闸：sayGapMs / sayWindow 一个都不碰 —— 这是反应，不是说话。
   * 但另有一道更松的硬上限（20 秒 6 条），防反应层自己变成刷屏。
   * 也不动 lastSpokeAt：它不能算"我已经回过了"，否则模型那边会以为回完了。
   */
  sendReaction (text, kind = 'ack') {
    let t = ''
    try { t = cleanLine(String(text || ''), 30) } catch (e) { return false }
    if (!t) return false
    if (isInstructionLeak(t) || persona.isLeak(t) || persona.isMachineTalk(t) || isObsolete(t)) return false
    const now = Date.now()
    this.ackWindow = (this.ackWindow || []).filter(x => now - x < this.reactionWindowMs)
    if (this.ackWindow.length >= this.reactionWindowMax) {
      this.ctx.log(`[ack 跳过] 反应层 20 秒已发 ${this.ackWindow.length} 条`)
      return false
    }
    try {
      this.bot.chat(t)
    } catch (e) { return false }
    this.ackWindow.push(now)
    this.lastAckAt = now
    this.ackSent++
    this.recentAcks.push(t)
    if (this.recentAcks.length > 6) this.recentAcks.shift()
    this.ctx.log(kind === 'recovery' ? `[ack 补话] ${t}（不占发言闸）` : `[ack] ${t}（不占发言闸）`)
    if (kind === 'ack') {
      this._ackSentAt = now
      this.armAckRecovery()
    }
    return true
  }

  /**
   * 垫了话之后的兜底：8 秒内没等到真回复，补一句收尾。
   *
   * 【为什么必须有】"等下"发出去、模型挂了，用户就只收到一个"等下"然后没了 ——
   * 这比不垫更怪（像被无视）。补一句把话说圆。
   */
  armAckRecovery () {
    if (this._ackRecoveryTimer) { clearTimeout(this._ackRecoveryTimer); this._ackRecoveryTimer = null }
    this._ackRecoveryTimer = setTimeout(() => {
      this._ackRecoveryTimer = null
      // 垫话之后已经说过真话 → 不用补
      if ((this.lastSpokeAt || 0) >= this._ackSentAt) return
      const line = pickVaried(ACK_POOLS.recovery, this.recentAcks)
      if (line && this.sendReaction(line, 'recovery')) this.ackRecovered++
    }, this.ackRecoveryMs)
    if (this._ackRecoveryTimer.unref) this._ackRecoveryTimer.unref()
  }

  /** 真回复抢先发出去时，取消还没发的垫话 */
  cancelPendingAck (why) {
    if (!this._ackTimer) return
    clearTimeout(this._ackTimer)
    this._ackTimer = null
    this.ctx.log('[ack 取消] ' + (why || '真回复已发'))
  }

  /**
   * 让他自己决定要不要说话、说什么。
   *
   * @param {string} situation 现在发生了什么（用中文描述，给模型看）
   * @param {object} [opts]
   * @param {number} [opts.maxLen] 最长几个字
   * @param {boolean} [opts.force] 一定要说（比如有人直接问他）
   * @param {string[]} [opts.people] 相关的人
   * @param {number} [opts.chance] 说话的意愿 0~1（默认 1；想让他"可能不说"就调低）
   */
  async speak (situation, opts = {}) {
    // 冷却：别一句话接一句话地刷
    const sinceLast = Date.now() - (this.lastSpokeAt || 0)
    const minGap = opts.minGap == null ? 1500 : opts.minGap
    if (!opts.force && sinceLast < minGap) return false

    // 限速窗口内注定发不出去 —— 别调模型（省一次 2~6 秒的往返，把时间还给干活）
    // reserved 记下来传给 say()：坑已经占过，say() 不能再拿占坑时间当"上一句"重复判一次
    let reserved = false
    if (!opts.force) {
      if (!this.reserveSpeak()) {
        this.speakGapSkipped = (this.speakGapSkipped || 0) + 1
        return false
      }
      reserved = true
    }

    // 意愿：不是每次都开口
    if (!opts.force && opts.chance != null && Math.random() > opts.chance) return false

    const doing = this.describeDoing()
    let world = ''
    try {
      world = this.ctx.perceive ? this.ctx.perceive.brief() : ''
    } catch (e) {}
    const stateLine = world ? `${world}\n${doing}` : doing
    // 危险等级决定这一句能有多长（提示词里只是方向，代码里兜底）
    const dg = persona.dangerOf(stateLine)
    const danger = dg.level
    this._danger = danger
    this._hp = dg.hp

    const recalled = this.mem.remember(situation, { people: opts.people || [], limit: 5 })

    const msgs = [
      { role: 'system', content: persona.systemPrompt(this.mem, stateLine, recalled, {
        secrets: this.mem.secrets, taste: this.ctx.taste, mood: this.ctx.mood
      }) },
      {
        role: 'system',
        content: `现在发生了一件事，你要在游戏公屏上说一句。

这件事是：${situation}

要求：
- 只说你要打出来的字，不要引号，不要"我说："前缀
- 不超过 ${opts.maxLen || 40} 个字
- 像真人随口一句，不要完整得像写作文
- 不要每次都感叹，普通事就平静地说
- 不要用书面语
${opts.extraHint ? '- ' + opts.extraHint : ''}
- **绝对不要念出方块的英文名、数量、坐标、括号里的返回值**。说人话。
- 如果你觉得这事不值一提、不想说，就只输出 [不说]
${this.fatigueHint()}`
      }
    ]

    const recent = this.history.slice(-10).map(h => `${h.who}: ${h.msg}`).join('\n')
    if (recent) msgs.push({ role: 'system', content: '刚才聊的：\n' + recent })

    let out = null
    try {
      const r = await this.llm.chat(msgs, { maxTokens: 160, temperature: 1.0 })
      out = (r.text || '').trim()
    } catch (e) {
      this.ctx.log('[talk] llm fail ' + e.message)
      return false
    }

    // 【为什么要这行日志 · UNHUMAN-SCAN #3 验收】
    // spontaneous 侧只看到 speak() 返回 false，分不清是"概率没过"还是"模型自己不想说"。
    // 这两件事的修法完全不同（前者调 chance，后者要改情境描述），必须能分开数。
    if (!out || out.includes('[不说]')) {
      this.ctx.log('[talk] 模型不想说：' + String(situation).slice(0, 30))
      return false
    }

    out = cleanLine(out, opts.maxLen || 40)
    if (!out) return false
    // 指令泄漏：日志里那句「答一句短的。大概意思是：看见你上线了。」就是从这里进来的。
    // say() 里还有一道；这里先拦，是为了别把它写进 history / 记忆（写进去下次还会学它）。
    if (isInstructionLeak(out)) {
      this.ctx.log('[instruction leak blocked] ' + out.slice(0, 60))
      return false
    }
    if (persona.isLeak(out)) {
      this.ctx.log('[leak blocked] ' + out)
      return false
    }
    if (isObsolete(out)) {
      this.ctx.log('[obsolete word blocked] ' + out)
      return false
    }

    this.history.push({ who: '我', msg: out })
    if (this.history.length > 40) this.history = this.history.slice(-40)

    // 记录放到 say() 成功之后 —— 提前 push 的话，
    // say() 里的复读拦截会撞见"刚加进去的自己"，第一句就发不出去。

    // 自己说的话里如果有承诺之类，也记一笔
    this.mem.maybeRemember('我说：' + out, { hasNewInfo: false })

    return this.say(out, { reserved, danger })
  }

  /** 收到别人的话 */
  async onChat (username, message) {
    if (username === this.bot.username) return

    // ===== 指令型文本拦截 =====
    // 别的 AI 会把提示词漏到公屏（"现在你该说一句话接上。对方说了「邪门」，"）。
    // 那种东西当噪音丢掉：不进记忆、不触发回复、不占限速额度。
    if (looksLikePrompt(message)) {
      this.noiseBlocked++
      this.ctx.log('[noise] 疑似 prompt/指令，丢掉：' + String(message).slice(0, 40))
      return
    }

    // ===== 防 bot 之间无限对答 =====
    // 判断对方是不是"另一个 AI 玩家"：名字像 bot、或者说话风格像
    const isBotLike = this.looksLikeBot(username)

    if (isBotLike) {
      // 1. 连续跟同一个 bot 对话太多次 -> 断开
      const now = Date.now()
      this.botChain = (this.botChain || []).filter(c => now - c.at < 120000)   // 只留 2 分钟内的
      const withThisBot = this.botChain.filter(c => c.who === username)

      if (this.botChainTooLong(withThisBot)) {
        this.ctx.log(`[chain] 跟 ${username} 已经聊了 ${withThisBot.length} 轮，先不接了`)
        return
      }

      // 2. 记录这次
      this.botChain.push({ who: username, at: now })

      // 3. 只有明确提到我、或者问句，才回。不主动接话
      const mentioned = message.includes(this.bot.username) ||
        (this.mem.people[username] && message.includes(this.mem.people[username].callMe || '\u0000'))
      const isQuestion = /[?？]/.test(message)

      if (!mentioned && !isQuestion) {
        this.ctx.log(`[chain] ${username} 说的话没指向我，不接`)
        return
      }

      // 4. 就算回，也大概率回得短或者不回
      if (Math.random() < 0.5) {
        this.ctx.log(`[chain] ${username} 虽然在跟我说话，但这次先不回`)
        return
      }
    }

    // ===== 普通玩家 =====
    this.lastReplyTo = username

    // 记人（UNHUMAN-SCAN #13）
    //
    // 实测 memory.json 的"认识的人"里 5 个有 4 个是他自己的测试小号
    // （XJJHOME6 / XJJINTG / XJJHOME87 / XJJVER6），importance 0.6 衰减极慢，
    // 长期占着 peopleDigest 的位置 —— 哪天玩家问"你还记得谁"，会报出一串假名字。
    // 测试号照样回话（见下面），只是**不进人际关系记忆**。
    const isTestAccount = this.isTestAccount(username)
    if (isTestAccount) this.ctx.log(`[mem] ${username} 是测试小号，不记人际关系`)

    const isNew = !isTestAccount && !this.mem.people[username]
    if (!isTestAccount) this.mem.person(username)

    // 第一次见：**不问称呼**。
    //
    // 【2026-11-13 15:35 用户反馈】「不用反问，也不用主动问别人怎么称呼，
    // 如果人家不告诉他叫什么名，他就喊人家那个英文游戏名就行了，
    // 有人跟他说"叫我什么什么"他才会从游戏英文名改口成这个」
    //
    // 之前第一次见面必然问一句"怎么称呼"，很突兀 —— 真人玩家不会每次都问。
    // 现在：直接记一笔，名字就用游戏 ID。等对方主动说了再改口。
    if (isNew) {
      this.ctx.log('[chat] 第一次见 ' + username + '（不问称呼，先用游戏名）')
      this.mem.add({
        text: `第一次见到 ${username}`,
        kind: 'person', who: [username], importance: 0.6, emotion: 0.4
      })
      // 不 return —— 继续走正常回复流程，回他说的那句话
    }

    // 判断这句话值不值得记（测试小号的话不进长期记忆）
    if (!isTestAccount) this.mem.maybeRemember(message, { who: [username], hasNewInfo: true })

    // 是不是在托付秘密
    const sec = secretsMod.detect(message, username)
    if (sec) {
      if (!isTestAccount) this.mem.person(username)
      this.mem.addSecret({
        content: sec.content,
        from: username,
        about: sec.about,
        weight: guessWeight(message)
      })
      this.ctx.log('[secret] ' + username + ' 托付了件事')
    }

    // 是不是在要他做事（说服系统）
    const demand = this.detectDemand(message, username)

    // 是不是在套某个秘密
    const probing = this.detectProbe(message)

    // 忙的时候**照样回**，只是回得短、回得慢。
    // 真人不会因为手上在挖矿就不理人，他会边挖边回一句"等会儿"。
    const busy = this.ctx.busy && this.ctx.busy()
    if (busy) {
      const cfg = this.ctx.cfg.behavior

      // 记进"回头再回"的队列 —— 说"等会儿"就是承诺，之后必须接
      this.defer(username, message)

      // 只有一小部分情况是真的没看见（比如正在打怪）
      if (Math.random() < 0.15) {
        this.ctx.log('[chat] 这会儿腾不出手 ' + username)
        return
      }
      // 慢一点回，像腾出手来才打字的
      const delay = 1500 + Math.random() * 3000
      this.ctx.log('[chat] 忙着，' + Math.round(delay / 1000) + '秒后回 ' + username)

      // ===== 关键：调度时就占位 =====
      //
      // 【实测 · 2026-11-13 16:09】延迟回复（setTimeout 1.5-4.5s）和回头接话
      // 是两条独立路径。回头接话在 8 秒后才触发，但那时延迟回复可能还没跑完，
      // 或者已经跑完了 —— 无论如何，只要回头接话先跑，它就看不到标记，会重复说。
      //
      // 所以在"决定要回"这一刻就占位，中间任一环节真的没说出来才撤销。
      this.markReplied(username, message)
      setTimeout(() => {
        this.reply(username, message, { busy: true, _placeholder: true }).catch(() => {})
      }, delay)
      return
    }

    await this.reply(username, message)
  }

  /** 给一条消息生成唯一 id */
  msgId (who, msg) { return who + '|' + msg }

  /** 这条消息回过了吗 */
  hasReplied (who, msg) {
    const id = this.msgId(who, msg)
    return this.repliedMsgIds.has(id)
  }

  /** 标记这条消息已回 */
  markReplied (who, msg) {
    this.repliedMsgIds.set(this.msgId(who, msg), Date.now())
    // 只留最近 50 条
    if (this.repliedMsgIds.size > 50) {
      const first = this.repliedMsgIds.keys().next().value
      this.repliedMsgIds.delete(first)
    }
  }

  /** 撤销标记（这次其实没说出来，下次还得有机会回） */
  unmarkReplied (who, msg) {
    this.repliedMsgIds.delete(this.msgId(who, msg))
  }

  /** 记下一条"等会儿再回"的话 */
  defer (who, msg) {
    // 同一人同一句不重复记
    const dup = this.deferred.find(d => d.who === who && d.msg === msg)
    if (dup) return
    this.deferred.push({ who, msg, at: Date.now(), handled: false })
    // 只留最近 10 条
    if (this.deferred.length > 10) this.deferred.shift()
  }

  /**
   * 忙完了，回头接一下刚才没回的话。
   * 真人说"等会儿"之后一定会回来，不然就是没礼貌。
   * @returns {Promise<boolean>} 有没有说话
   */
  async followUpDeferred () {
    // 筛出还没处理的、且已经过了至少 8 秒的（太近说明还没忙完）
    const now = Date.now()
    const pending = this.deferred.filter(d => !d.handled && now - d.at > 8000)
    if (!pending.length) return false

    // 只接最近的一条（真人不会一口气回十条）
    const item = pending[pending.length - 1]
    item.handled = true

    // ===== 关键：这条已经回过了就别再回 =====
    //
    // 【实测 · 2026-11-13 16:09】用户说一句话，他回了两条：
    //   [16:09:41] [chat] 忙着，4秒后回 Xylitol6983
    //   [16:09:49] [say] 行，等我挖完这点石头       ← 延迟回复路径
    //   [16:09:53] [followup] 回头接 Xylitol6983 刚才说的
    //   [16:09:56] [say] 也行                        ← 回头接话路径
    //
    // 延迟回复和回头接话是两条独立路径，互相不知道对方回过。
    // 前面加了 hasReplied 查重，但 followUpDeferred 没查。
    if (this.hasReplied(item.who, item.msg)) {
      this.ctx.log(`[followup] ${item.who} 那句已经回过了，跳过`)
      return false
    }

    this.ctx.log(`[followup] 回头接 ${item.who} 刚才说的：${item.msg.slice(0, 30)}`)

    // 跟 speak / reply 一样的口径：先占坑再叫模型。
    // 不占坑的话 say() 会在模型回来之后才判限速，白付一次往返（跟修掉的
    // "正常话全被拦"是同一类坑：占坑和不占坑的路径必须走同一套时钟）。
    if (!this.reserveSpeak()) {
      this.ctx.log('[followup 早退] 限速窗口内，这次不叫模型')
      return false
    }

    const status = this.ctx.actions ? this.ctx.actions.status() : null
    let world = ''
    try {
      world = this.ctx.perceive ? this.ctx.perceive.brief() : ''
    } catch (e) {}

    const msgs = [
      { role: 'system', content: persona.systemPrompt(this.mem, world, [], {
        cfg: this.ctx.cfg,
        secrets: this.mem.secrets, taste: this.ctx.taste, mood: this.ctx.mood
      }) },
      { role: 'system', content: `刚才你很忙，${item.who} 跟你说了话，你回了句"等会儿"或者没顾上。
现在你手头的事弄完了（或告一段落了），该回头接一下。

${item.who} 刚才说的是：${item.msg}

要求：
- 就像刚腾出手一样，自然地接一句
- 短，一两句
- 不要道歉式开场（"不好意思刚才在忙"这种太客气），真人不这么说
- 可以直接回他刚才的问题，或者就说"刚才没顾上，你说啥"
- 如果那话已经过时了（比如他问你借东西，现在你不确定还要不要），就说"还等着不"
- 不想接就输出 [不说]` }
    ]

    let out = null
    try {
      const r = await this.llm.chat(msgs, { maxTokens: 160, temperature: 0.95 })
      out = (r.text || '').trim()
    } catch (e) { return false }

    if (!out || out.includes('[不说]') || out.includes('[不理]')) return false
    out = cleanLine(out, 50)
    if (!out) return false
    if (isInstructionLeak(out)) {
      this.ctx.log('[instruction leak blocked] ' + out.slice(0, 60))
      return false
    }
    if (persona.isLeak(out) || persona.isMachineTalk(out) || isObsolete(out)) return false
    const topicHit2 = this.topicRepeat(out)
    if (topicHit2) {
      this.ctx.log(`[topic repeat blocked] ${topicHit2.label}（回头接话）：${out}`)
      return false
    }

    this.history.push({ who: item.who, msg: item.msg })
    this.history.push({ who: '我', msg: out })
    // recentSaid 由 say() 在真正发出去之后统一记录，这里不再重复 push
    // （重复 push 会让同一句在窗口里占两个位置，把真正的"上一句"挤掉）
    const okSaid = await this.say(out, { reserved: true })
    if (okSaid) this.noteMode(out, item.msg)
    // 标记这条回过了，防止其他路径重复（这里是 item.who / item.msg，不是 username/message）
    this.markReplied(item.who, item.msg)
    return true
  }

  /** 第一次见面，问对方怎么称呼 */
  async askNameFor (username) {
    const ok = await this.speak(
      `${username} 刚进服务器/刚跟你打照面，你不认识这人。`,
      {
        force: true,
        maxLen: 25,
        people: [username],
        minGap: 0,
        extraHint: '你是第一次见他，顺势问一句该怎么称呼他。别太客气，就像游戏里随口一问。'
      }
    )
    if (!ok) {
      // 万一模型不想说，也不硬凑
      this.ctx.log('[talk] 没问称呼')
    }
  }

  /** 记住对方怎么称呼自己 */
  setName (username, what) {
    const p = this.mem.person(username)
    if (!p || !what) return
    p.callMe = String(what).slice(0, 20)
    this.mem.add({
      text: `${username} 让我叫他 ${p.callMe}`,
      kind: 'person', who: [username], importance: 0.7
    })
    this.ctx.log('[chat] 记住称呼：' + username + ' -> ' + p.callMe)
  }

  /** 回一句话 */
  async reply (username, message, opts = {}) {
    // 防重复：同一句话只回一次（延迟回复 + 回头接话 + 正常回复可能同时触发）
    if (this.hasReplied(username, message)) {
      this.ctx.log(`[chat] 这条已经回过了，跳过：${message.slice(0, 20)}`)
      return
    }
    // **先占位再干活**。
    // 只靠开头这次 hasReplied 是不够的：延迟回复、事件队列、回头接话是三条
    // 并发路径，它们会在 await 模型的时候同时通过检查，然后各发一条 ——
    // 日志里那四句就是这么来的。先占位，后面任何路径再进来都会被挡掉。
    this.markReplied(username, message)
    let committed = false
    try {
      committed = await this._replyInner(username, message, opts)
    } finally {
      // 没真的说出口（模型不理、被拦、报错）就撤销占位，下次还有机会
      if (!committed) this.unmarkReplied(username, message)
    }
    return committed
  }

  /** reply 的本体。返回 true 表示真的说出去了 */
  async _replyInner (username, message, opts = {}) {
    const busyReply = !!opts.busy

    // ===== 先看限速，再决定要不要叫模型 =====
    // 实测：10 分钟 254 次限速拦截 = 254 次白叫模型。
    // 这段时间正是"任务只启动 1 次"的原因 —— 循环全耗在生成注定丢掉的话上。
    // 被点名（话里带我的名字）才放宽，跟 say() 里的口径保持一致。
    const mentionedEarly = String(message || '').includes(this.bot.username)
    if (!this.reserveSpeak({ allowFast: mentionedEarly })) {
      this.earlyGapSkipped = (this.earlyGapSkipped || 0) + 1
      this.ctx.log('[chat 早退] 限速窗口内，这次不叫模型：' + String(message).slice(0, 20))
      return false
    }

    const doing = this.describeDoing()
    let world = ''
    try {
      world = this.ctx.perceive ? this.ctx.perceive.brief() : ''
    } catch (e) {}
    const stateLine = world ? `${world}\n${doing}` : doing
    // 危险等级决定这一句能有多长（提示词只是方向，代码里兜底）
    const danger = persona.dangerOf(stateLine).level
    this._danger = danger

    // 两级回复第一级：手上忙 + 对方在问他 → 500ms 先垫一个短词，
    // 别让人盯着空公屏等 6 秒。不 await，跟下面的模型请求并行。
    this.scheduleAck(message, username, danger)

    const recalled = this.mem.remember(message, {
      people: [username],
      limit: 6
    })

    const callMe = (this.mem.people[username] || {}).callMe
    const nameHint = callMe ? `\n你平时叫他"${callMe}"。` : ''

    // 说服：他愿不愿意干
    let demandHint = ''
    if (this.pendingDemand) {
      const d = this.pendingDemand
      const verdict = this.persuasion.ask({
        who: username,
        task: d.task,
        what: message,
        effort: d.effort,
        ctx: {
          moodState: this.ctx.mood ? this.ctx.mood.state() : 'normal',
          trust: (this.mem.people[username] || {}).trust || 0
        }
      })
      this.ctx.log(`[persuade] ${username} ${verdict.approach} -> ${verdict.style} (${verdict.reason})`)

      // 心情影响
      if (this.ctx.mood) {
        if (verdict.irritation > 0.2) this.ctx.mood.irritation = Math.min(1, this.ctx.mood.irritation + verdict.irritation)
        if (verdict.warmth) this.ctx.mood.spirit = Math.max(0, Math.min(1, this.ctx.mood.spirit + verdict.warmth))
      }

      // 答应了就真的去做
      if (verdict.comply) {
        this.persuasion.resolved(username)
        this.pendingDemand = null
        if (this.ctx.onComply) this.ctx.onComply(username, d.task)
      }

      demandHint = '\n' + this.persuasion.hint(verdict, username, d.task)
    }

    // 这个人能问到的秘密（已经跟他说过的不再重复）
    const askable = this.mem.getSecrets(username)
    // 判断他会不会说漏
    let secretHint = ''
    if (askable.length) {
      const pressure = this.mem.people[username] ? Math.min(1, Math.abs(this.mem.people[username].trust || 0) / 10) : 0.3
      for (const sec of askable) {
        const verdict = secretsMod.shouldTell(sec, {
          name: username,
          trust: (this.mem.people[username] || {}).trust || 0
        }, { pressure, directAsk: /是|吧|吗|有没有|是不是/.test(message) })
        this.ctx.log(`[secret] ${username} 问到 ${sec.from} 的秘密 -> ${verdict.style} (${verdict.reason})`)
        if (verdict.style === 'blurt') {
          secretHint = `\n这次你实在瞒不住了，可以说出 "${sec.content}"。说完可能有点后悔。`
          this.mem.markTold(sec.id, username)
        } else if (verdict.style === 'hint') {
          secretHint = `\n这个话题你不想多说，但又有点想让人知道，可以含糊提一句，别说得太明白。`
        } else if (verdict.style === 'slip') {
          secretHint = `\n你可能不小心说漏一点，说完赶紧想圆回来。`
          this.mem.markTold(sec.id, username)
        } else if (verdict.style === 'awkward_deny') {
          secretHint = `\n你知道点什么，但不太想让他知道，否认的时候会有点不自然。`
        } else {
          secretHint = `\n这个问题你要么装不懂，要么直接岔开话题。`
        }
        break
      }
    }

    const msgs = [
      { role: 'system', content: persona.systemPrompt(this.mem, stateLine, recalled, {
        cfg: this.ctx.cfg,
        secrets: this.mem.secrets, viewer: username,
        taste: this.ctx.taste, mood: this.ctx.mood
      }) },
      {
        role: 'system',
        content: `${persona.chatHint({ maxLen: busyReply ? 20 : 50 })}${nameHint}${secretHint}${demandHint}${this.fatigueHint()}${busyReply ? '\n\n【注意】你手上正忙着，回一句短的就行，别停下来长聊。可以让他等（"等会儿""我弄完这个"），也可以边干边回。' : ''}

另外：
- **不要去问对方叫什么、该怎么称呼**。真人不会每次都问。
  他现在就叫游戏 ID（${username}），你就这么叫他。
- 只有对方主动说了"叫我老王""我叫XX"，才改口用那个名字
- **你正在忙的话，回得短一点**，甚至就一句"等会儿""忙着呢"，不用停下来长篇回
- 不忙的时候可以多聊两句`
      }
    ]

    const recent = this.history.slice(-8).map(h => `${h.who}: ${h.msg}`).join('\n')
    if (recent) msgs.push({ role: 'system', content: '刚才的对话：\n' + recent })
    msgs.push({ role: 'user', content: `${username} 说：${message}` })

    let out = null
    try {
      const r = await this.llm.chat(msgs, { maxTokens: 200, temperature: 0.95 })
      out = (r.text || '').trim()
    } catch (e) {
      this.ctx.log('[chat] llm fail ' + e.message)
      return false
    }

    if (!out || out.includes('[不理]')) {
      this.ctx.log('[chat] 选择不理 ' + username)
      return false
    }

    out = cleanLine(out, 60)
    if (!out) return false
    // 指令泄漏（「答一句短的。大概意思是：…」那类），先拦在写进 history / 记忆之前
    if (isInstructionLeak(out)) {
      this.ctx.log('[instruction leak blocked] ' + out.slice(0, 60))
      return false
    }
    if (persona.isLeak(out)) {
      this.ctx.log('[leak blocked] ' + out)
      return false
    }
    if (isObsolete(out)) {
      this.ctx.log('[obsolete word blocked] ' + out)
      return false
    }
    if (persona.isMetaLeak(out)) {
      this.ctx.log('[meta leak blocked] ' + JSON.stringify(persona.metaSignals(out)) + ' ' + out.slice(0, 40))
      return false
    }
    // 主题级复读：同一件"别人的事"已经说过两回，这一句不许再说（2026-11-13）
    const topicHit = this.topicRepeat(out)
    if (topicHit) {
      this.ctx.log(`[topic repeat blocked] ${topicHit.label}（最近三句里说过 ${topicHit.n} 回）：${out}`)
      return false
    }

    this.history.push({ who: username, msg: message })
    this.history.push({ who: '我', msg: out })
    if (this.history.length > 40) this.history = this.history.slice(-40)

    // 记录放到 say() 成功之后 —— 提前 push 的话，
    // say() 里的复读拦截会撞见"刚加进去的自己"，第一句就发不出去。

    // 试着从对方话里提取称呼
    const m = message.match(/(?:叫我|喊我|我叫|我是)\s*([\u4e00-\u9fa5A-Za-z0-9_]{1,12})/)
    if (m && m[1]) this.setName(username, m[1])

    this.mem.maybeRemember('我说：' + out, { who: [username], hasNewInfo: false })

    // 真的说出去了才算回过（say 可能被 isLeak / isMachineTalk 拦下）
    // 被点名（话里带我的名字）才放宽限速 —— 点名叫人还慢吞吞不吭声才不像人
    // reserved: 上面已经 reserveSpeak 占过坑了，say() 不能再拿占坑时间重判一次间隔
    const mentionedMe = String(message || '').includes(this.bot.username)
    const said = await this.say(out, { allowFast: mentionedMe, danger, reserved: true })
    if (said) this.noteMode(out, message)
    return !!said
  }
}

/** 判断对方是不是在要求他做事 */
Talk.prototype.detectDemand = function (message, username) {
  const m = String(message || '')
  // 已经是同一件事的后续追问
  if (this.pendingDemand) return this.pendingDemand

  // 新要求：必须是明确的祈使句（"帮我X" / "去X" / "给我X" / "快点X"）
  // 光提一个动词不算 —— "你发育怎么样了"是在聊天，不是要人干活
  const imperative = /^(帮我|帮忙|你去|去|给我|带我|陪我|过来|快点|赶紧|来帮|能不能帮|可不可以帮|麻烦你|求)/.test(m) ||
    /(帮我|帮忙|带我|陪我|给我点|过来一下|快点过来|求你了|求你帮|行行好|拜托你)/.test(m)

  // 而且得是真的在要东西/要人做事，不是问句
  const asking = /(呗|吧|嘛|好不好|行不行|可以吗|成不)[？?]?$/.test(m) || /[!！]$/.test(m)
  const question = /[？?]$/.test(m) && !imperative

  const isDemand = imperative && !question && m.length >= 3
  if (!isDemand) return null

  // 猜这件事有多麻烦
  let effort = 0.4
  if (/(一箱|一堆|很多|大量|全部|所有)/.test(m)) effort = 0.8
  if (/(远处|很远|跑一趟|跑过去|去.*那边)/.test(m)) effort += 0.15
  if (/(马上|现在|立刻)/.test(m)) effort += 0.1
  effort = Math.min(1, effort)

  const task = m.replace(/^(帮我|帮忙|你去|去)/, '').trim() || m

  this.pendingDemand = { task, effort, from: username, at: Date.now() }
  this.ctx.log('[demand] ' + username + ' 要他：' + task + '（麻烦度 ' + effort.toFixed(2) + '）')
  return this.pendingDemand
}

/** 判断对方是不是在套话 */
Talk.prototype.detectProbe = function (message) {
  if (!this.mem.secrets || !this.mem.secrets.length) return null
  const m = String(message || '')
  // 提到秘密里涉及的人、或者直接问"他跟你说了啥"
  for (const sec of this.mem.secrets) {
    if (sec.from && m.includes(sec.from)) return sec
    if (sec.about && m.includes(sec.about)) return sec
  }
  if (/(跟你说了什么|跟你说啥|跟你聊什么|有啥瞒着|有啥事瞒|是不是有事)/.test(m)) {
    return this.mem.secrets[this.mem.secrets.length - 1]
  }
  return null
}

/** 粗略判断一个秘密有多重 */
function guessWeight (text) {
  const t = String(text || '')
  if (/(退服|不玩了|要走|删号)/.test(t)) return 0.95
  if (/(钻石|下界合金|满级|附魔)/.test(t)) return 0.75
  if (/(藏|埋|放哪|箱子)/.test(t)) return 0.6
  if (/(生气|讨厌|不喜欢|烦)/.test(t)) return 0.55
  return 0.5
}

/**
 * 一句话里有没有"实质内容"（汉字/字母/数字）。
 *
 * 【为什么要有这个 · 2026-11-13 UNHUMAN-SCAN #1】
 * 实测日志里 25 分钟说了 8 句，其中 5 句是纯标点：
 *   [say] 。   × 4      [say] 。。  × 1
 * 复刻验证 cleanLine("。") -> "。"、"。。" -> "。。" —— 原样通过。
 * say() 只过 isLeak / isMachineTalk，两个都不拦标点。
 * 于是公屏上出现"一个号在发句号"，比不说话还像挂了。
 */
function hasRealContent (t) {
  const s = String(t || '').trim()
  if (/[\u4e00-\u9fa5a-zA-Z0-9]/.test(s)) return true
  // 【例外】单个/两个问号是真实的"懵"，属于正常反应，不能拦。
  // persona 里写了「第一次被骂 -> 懵：'？'」，拦掉这条反应就废了。
  // 但"。。"「，，」这类是模型输出失败的残渣，要拦。
  if (/^[?？]{1,2}$/.test(s)) return true
  return false
}

/** 清理模型输出 */
function cleanLine (out, maxLen) {
  let t = String(out || '').trim()
  t = t.replace(/^["「『（(]|["」』）)]$/g, '')
    .replace(/^(我说|回复|回答|回应)[:：]\s*/, '')
    .replace(/\n[\s\S]*$/, '')
    .trim()
  if (!t) return ''
  // 一个汉字/字母/数字都没有 -> 当没说（模型有时把"不想说"输成句号）
  if (!hasRealContent(t)) return ''
  if (t.length > maxLen) t = t.slice(0, maxLen)
  return t
}


/**
 * 判断一个玩家是不是"另一个 AI"。
 * 这纯粹是程序层的自我保护：防止两个 bot 无限对答把服务器聊天刷爆。
 * 注意：徐俊杰本人不会觉得对方是 AI，这只是代码层面的防护。
 */
Talk.prototype.looksLikeBot = function (username) {
  const name = String(username || '').trim()
  if (!name) return false

  // 自己永远不算"另一个 AI"
  const self = this.bot && this.bot.username
  if (self && name.toLowerCase() === String(self).toLowerCase()) return false

  // ① 显式配置：behavior.botNames（运行时读，加第二个 AI 不用改代码）
  const names = this.botNames()
  if (names.some(n => String(n).toLowerCase() === name.toLowerCase())) return true

  // ② 通用 bot 名
  if (/^(bot|ai|npc|_bot|bot_)/i.test(name)) return true
  if (/^(bot|ai|npc)[_-]?\d*$/i.test(name)) return true
  if (/^Test\d*/i.test(name)) return true

  // ③ 分身上线用的名字：XJJ1 / XJJ_MAf3d32x / XJJ-AUD1
  //    【关键】主账号 `XJJ` 本身不能算 bot —— 上面的 self 检查已经把它挡掉了，
  //    这里只认"带编号或带下划线后缀"的。
  if (/^XJJ\d+$/i.test(name)) return true
  if (/^XJJ[_-][A-Za-z0-9_]{2,}$/i.test(name)) return true

  return false
}

/**
 * 运行时读 behavior.botNames。
 * 不缓存 —— 用户在 config.json 里加一个名字，下一次判定就生效（重启后）。
 */
/**
 * 这条消息像不像"另一个 AI 把提示词漏到公屏上了"。
 *
 * 实测抓到的原样泄漏（goals-fixer run6）：
 *   现在你该说一句话接上。对方说了「邪门」，
 * 这种消息对他完全没用 —— 拿它去回，等于替对方把提示词也念一遍。
 * 当噪音丢掉，不进记忆、不触发回复。
 *
 * 注意别误伤真人说话：
 *   "你该睡了"      -> 不拦（没有"说/回复"这类指令词）
 *   "system: ..."   -> 拦
 */
const PROMPT_NOISE = [
  /(system|assistant|developer|user)\s*[:：]/i,
  /你现在是.{0,10}(角色|AI|助手|机器人|玩家)/,
  /你(现在)?(该|要|应该|需要)(说|回复|回答|输出|扮演)/,
  /请(你)?(只)?(回复|回答|输出|扮演|接上)/,
  /对方说了\s*[「『"]/,
  /(一句话|说一句)接上/,
  /不要超过\s*\d+\s*个字/,
  /要求[:：]\s*$/m,
  /\[不说\]|\[不理\]/,
  /<\|?(system|im_start|im_end)\|?>/
]

function looksLikePrompt (text) {
  const t = String(text || '')
  if (!t) return false
  // 公屏消息不会太长；超长的基本是把整段 prompt 粘进来了
  if (t.length > 240) return true
  return PROMPT_NOISE.some(re => re.test(t))
}

Talk.prototype.looksLikePrompt = function (text) { return looksLikePrompt(text) }

Talk.prototype.botNames = function () {
  const out = []
  const push = (v) => { if (Array.isArray(v)) for (const x of v) if (x) out.push(String(x).trim()) }
  try { push(this.ctx && this.ctx.botNames) } catch (e) {}
  try { push(this.ctx && this.ctx.cfg && this.ctx.cfg.behavior && this.ctx.cfg.behavior.botNames) } catch (e) {}
  return out
}

/**
 * 跟同一个 bot 在两分钟里来回太多次，就断开 —— 防止两个 AI 无限对答。
 *
 * 原先这里调的是一个**全项目不存在的函数**（名字里连着三个 This/Bot，见 UNHUMAN-SCAN #15）。
 * 名字像 bot 的玩家（XJJ1 / Test1，正好命中 looksLikeBot 的正则）一说话就抛
 * ReferenceError，被 main.js 的 `.catch()` 吞成一行 `chat err` 日志，
 * 表现是「这人不理我」，而且没有任何可查的痕迹。
 *
 * 原意就是这一行：同一个 bot 2 分钟内已经聊满 3 轮，就不再接。
 * 阈值取 3：一问一答算 1 轮，3 轮已经能看出是机器人在对刷了。
 */
Talk.prototype.botChainTooLong = function (chain, limit = 3) {
  return Array.isArray(chain) && chain.length >= limit
}

/**
 * 是不是自己的测试小号（UNHUMAN-SCAN #13）。
 *
 * 命名规律：XJJ + 4 位以上大写字母/数字，如 XJJHOME6 / XJJINTG / XJJHOME87 / XJJVER6。
 * 主账号（XJJ）本身不匹配这条正则，但仍显式放行一次 —— 万一以后主账号改名成
 * XJJMAIN 之类，不能把"自己"当测试号滤掉。
 */
Talk.prototype.isTestAccount = function (username) {
  const n = String(username || '').trim()
  if (!n) return false
  const main = this.bot && this.bot.username ? String(this.bot.username) : ''
  if (main && n.toLowerCase() === main.toLowerCase()) return false
  return /^XJJ[_-]?[A-Z0-9]{4,}$/i.test(n)
}

/**
 * 最近说过的话里，有没有跟这句一模一样的。
 *
 * 比的是**去掉标点、空白、常见语气尾巴后**的正文 —— 真人重复起来也不会每个标点都一样，
 * 「东西带齐了，下去转转」和「东西带齐了 下去转转」在他看来就是同一句。
 *
 * 窗口取最近 5 句（`recentSaid` 存 10 条，但太久以前说过的不该拦 ——
 * 隔 5 分钟说一句"走吧"是正常的，不是复读）。
 *
 * @returns {object|null} 命中的那条记录（带 at，用来算隔了多久）
 */
/**
 * 主题级复读：这句话踩的社交主题，在最近三句里已经出现过 ≥2 次吗。
 *
 * 【为什么不用字面比对】「睡了」「是该睡了」「我去躺了」字面完全不同，
 * findRecentDuplicate 一个都抓不到，但人听着就是一句话说了三遍。
 *
 * @returns {{id:string,label:string,n:number}|null}
 */
Talk.prototype.topicRepeat = function (text) {
  const mine = socialThemesOf(text)
  if (!mine.length) return null
  // 窗口 6 而不是 3：实测截图里的复读是**隔一句一次**（睡 → 别的 → 睡 → 别的 → 睡），
  // 只看最近 3 句，同一个主题永远数不到第二次，闸门等于没装。
  // 【为什么不是"最近 3 句"】实测截图里的复读是**隔一句一次**：
  //   睡 → 别的 → 睡 → 别的 → 睡 → 歇着 → 去吧
  // 只看相邻三句，同一个主题永远数不到第二次，闸门等于没装。
  // 所以改成"话题预算"：10 分钟内这个主题说过 2 次，就不再允许第 3 次。
  const cutoff = Date.now() - 10 * 60 * 1000
  this.themeUses = (this.themeUses || []).filter(u => u.at >= cutoff)
  for (const id of mine) {
    const n = this.themeUses.filter(u => u.id === id).length
    if (n >= 2) return { id, label: themeLabel(id), n }
  }
  return null
}

// 判断"接没接住"时要忽略的高频双字（它们不代表内容被接住了）
const MODE_STOP = new Set(['什么', '这个', '那个', '一个', '就是', '不是', '你还', '我我', '你你',
  '怎么', '可以', '现在', '刚才', '我们', '你们', '他们', '一下', '没有', '知道', '觉得'])

/**
 * 记一句：这次是"接住了对方"还是"说自己的"。
 *
 * 用双字重合判断，不追求精确 —— 这一层只用来数比例（岔开 ≥1/10），
 * 判错了也不影响单句质量，只影响"该岔开了"的提醒。
 */
Talk.prototype.noteMode = function (out, incoming) {
  const grams = (s) => {
    const t = String(s || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
    const set = new Set()
    for (let i = 0; i + 2 <= t.length; i++) {
      const g = t.slice(i, i + 2)
      if (!MODE_STOP.has(g)) set.add(g)
    }
    return set
  }
  const inc = grams(incoming)
  const mine = grams(out)
  let hit = 0
  for (const g of inc) if (mine.has(g)) hit++
  const sharedTheme = socialThemesOf(out).some(id => socialThemesOf(incoming).includes(id))
  this.recentModes.push((hit > 0 || sharedTheme) ? 'reach' : 'dodge')
  if (this.recentModes.length > 6) this.recentModes.shift()

  // 话题预算：记下这句用掉了哪些社交主题（10 分钟窗口，见 topicRepeat）
  const now = Date.now()
  this.themeUses = (this.themeUses || []).filter(u => u.at >= now - 10 * 60 * 1000)
  for (const id of socialThemesOf(out)) this.themeUses.push({ id, at: now })
}

Talk.prototype.findRecentDuplicate = function (text) {
  const norm = (s) => String(s || '')
    .replace(/[\s，。！？、；：,.!?;:~～…"'“”‘’（）()【】\[\]]/g, '')
    .replace(/[啊呀哦嘛哈呢吧啦噢喔]+$/g, '')
    .trim()

  const mine = norm(text)
  if (mine.length < 2) return null   // 「嗯」「？」这种短应答不算复读

  const recent = (this.recentSaid || []).slice(-5)
  for (let i = recent.length - 1; i >= 0; i--) {
    if (norm(recent[i].text) === mine) return recent[i]
  }
  return null
}

/**
 * 这句话是不是"我接下来要去做 X"的自我声明（UNHUMAN-SCAN #4）。
 *
 * 只认第一人称、将来时的行动句。回别人的话（"行 那我走了"）也算 ——
 * 那同样是向对方宣布了计划。
 */
const INTENTION_RE = /(我去|我下去|我走了|我出发|出发了|下去转转|我去转转|继续挖|接着挖|我去挖|我去看看|我回去|我先去|我下矿|下去看看|上路了)/

Talk.prototype.detectIntention = function (text) {
  const t = String(text || '').trim()
  if (!t || t.length > 60) return null      // 长句是叙述，不算承诺
  if (!INTENTION_RE.test(t)) return null
  return t
}

/** 记下刚说出口的计划（只留最近一条，60 秒有效） */
Talk.prototype.noticeIntention = function (text) {
  const it = this.detectIntention(text)
  if (!it) return null
  this.lastIntention = { text: it, at: Date.now() }
  this.ctx.log('[intent] 记住刚说的计划：' + it)
  return this.lastIntention
}

/** 给 impulse 用：60 秒内的计划，过期返回 null */
Talk.prototype.recentIntention = function () {
  const p = this.lastIntention
  if (!p) return null
  if (Date.now() - p.at > 60000) { this.lastIntention = null; return null }
  return p
}

/** 判断这句话属于哪种语气（语气疲劳用） */
function detectSayKind (text) {
  const t = String(text || '')
  if (!t) return 'empty'
  if (/^(嗯|行|哦|在|好|可以|ok)[。！？.!?]?$/i.test(t)) return 'minimal'
  if (/(草|妈的|卧槽|操|艹|靠|我靠)/.test(t)) return 'swear'
  if (/(又|第三次|第[一二三四五]次)/.test(t)) return 'repeat-complain'
  if (/[？?]/.test(t)) return 'ask'
  if (/(可以|成了|搞定|行了|弄完)/.test(t)) return 'done'
  if (/(不知道|不懂|不清楚)/.test(t)) return 'dunno'
  if (t.length <= 6) return 'short'
  return 'normal'
}

module.exports = Talk
// 类的静态默认值：构造器里读 Talk.DEFAULTS，测试也读它 —— 单一出处
Talk.DEFAULTS = SAY_DEFAULTS
module.exports.looksLikePrompt = looksLikePrompt
module.exports.isInstructionLeak = isInstructionLeak
// 发言闸的默认值（测试读这个，别在测试里硬编阈值）
module.exports.DEFAULTS = SAY_DEFAULTS
// 测试用：进程级发言闸（真实运行不需要拿它）
module.exports.GLOBAL_SAY = GLOBAL_SAY
