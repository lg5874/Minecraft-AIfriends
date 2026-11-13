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
    this.botChain = []        // 检测 bot 之间的对话链
    this.deferred = []        // 忙的时候没回/说要等会儿的，得回头接
    this.repliedMsgIds = new Map()  // 哪条消息已经回过了（防止多条路径重复回）
    this.lastReplyTo = null   // 上一条是回给谁的
  }

  /**
   * 语气疲劳检查：如果最近几句都是同一种反应，这次要换。
   * 这是 personagent 的 register-fatigue 规则。
   */
  fatigueHint () {
    const recent = this.recentSaid.slice(-3)
    if (recent.length < 2) return ''

    const kinds = recent.map(r => r.kind).filter(Boolean)
    const same = kinds.length >= 2 && kinds.every(k => k === kinds[0])
    // 开头字重复也算。注意是**相邻两句**就算 —— 日志里的真实序列是
    // 「嗯，好」「回来了，刚爬上来做石镐呢」「回来了，问第三遍了」，
    // 三句全同的要求永远等不到，等于这个机制从来没生效过。
    const heads = recent.map(r => String(r.text || '').slice(0, 2))
    const sameHead = heads.length >= 2 && heads.some((h, i) => i > 0 && h === heads[i - 1])

    if (!same && !sameHead) return ''

    const lastTexts = recent.map(r => `"${r.text}"`).join('、')
    return `\n\n【重要】你最近说过 ${lastTexts}，都是同一个路数。
这次必须换，不能再这样：
- 换成平淡的："嗯" "行" "哦" "可以"
- 或者换个角度说，别用一样的句式开头
- 或者干脆不说（输出 [不说] / [不理]）
连着用同一种反应说话，会显得很假。`
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
  async say (text) {
    if (!text) return false
    let t = String(text).trim()
    if (!t) return false
    if (t.length > 180) t = t.slice(0, 180)

    if (persona.isLeak(t)) {
      this.ctx.log('[leak blocked] ' + t)
      return false
    }
    // 说出程序味的话就别说了（宁可不说，也不能念日志）
    if (persona.isMachineTalk(t)) {
      this.ctx.log('[machine talk blocked] ' + t)
      return false
    }

    await this.humanDelay(t)
    try {
      this.bot.chat(t)
      this.lastSpoke = Date.now()
      this.lastSpokeAt = Date.now()
      this.ctx.log('[say] ' + t)
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

    // 意愿：不是每次都开口
    if (!opts.force && opts.chance != null && Math.random() > opts.chance) return false

    const doing = this.describeDoing()
    let world = ''
    try {
      world = this.ctx.perceive ? this.ctx.perceive.brief() : ''
    } catch (e) {}
    const stateLine = world ? `${world}\n${doing}` : doing

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

    if (!out || out.includes('[不说]')) return false

    out = cleanLine(out, opts.maxLen || 40)
    if (!out) return false
    if (persona.isLeak(out)) {
      this.ctx.log('[leak blocked] ' + out)
      return false
    }

    this.history.push({ who: '我', msg: out })
    if (this.history.length > 40) this.history = this.history.slice(-40)

    // 记录说过的话（语气疲劳用）
    this.recentSaid.push({ text: out, at: Date.now(), kind: detectSayKind(out) })
    if (this.recentSaid.length > 10) this.recentSaid.shift()

    // 自己说的话里如果有承诺之类，也记一笔
    this.mem.maybeRemember('我说：' + out, { hasNewInfo: false })

    return this.say(out)
  }

  /** 收到别人的话 */
  async onChat (username, message) {
    if (username === this.bot.username) return

    // ===== 防 bot 之间无限对答 =====
    // 判断对方是不是"另一个 AI 玩家"：名字像 bot、或者说话风格像
    const isBotLike = this.looksLikeBot(username)

    if (isBotLike) {
      // 1. 连续跟同一个 bot 对话太多次 -> 断开
      const now = Date.now()
      this.botChain = (this.botChain || []).filter(c => now - c.at < 120000)   // 只留 2 分钟内的
      const withThisBot = this.botChain.filter(c => c.who === username)

      if (withThisThisBotTooMany(withThisBot)) {
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

    // 记人
    const isNew = !this.mem.people[username]
    this.mem.person(username)

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

    // 判断这句话值不值得记
    this.mem.maybeRemember(message, { who: [username], hasNewInfo: true })

    // 是不是在托付秘密
    const sec = secretsMod.detect(message, username)
    if (sec) {
      const p = this.mem.person(username)
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
    if (persona.isLeak(out) || persona.isMachineTalk(out)) return false

    this.history.push({ who: item.who, msg: item.msg })
    this.history.push({ who: '我', msg: out })
    const said = await this.say(out)
    // 回头接的话也要进疲劳记录，不然疲劳机制看不见这一句
    if (said) {
      this.recentSaid.push({ text: out, at: Date.now(), kind: detectSayKind(out) })
      if (this.recentSaid.length > 10) this.recentSaid.shift()
    }
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
    const doing = this.describeDoing()
    let world = ''
    try {
      world = this.ctx.perceive ? this.ctx.perceive.brief() : ''
    } catch (e) {}
    const stateLine = world ? `${world}\n${doing}` : doing

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
    if (persona.isLeak(out)) {
      this.ctx.log('[leak blocked] ' + out)
      return false
    }

    this.history.push({ who: username, msg: message })
    this.history.push({ who: '我', msg: out })
    if (this.history.length > 40) this.history = this.history.slice(-40)

    // 记录说过的话（语气疲劳用）
    this.recentSaid.push({ text: out, at: Date.now(), kind: detectSayKind(out) })
    if (this.recentSaid.length > 10) this.recentSaid.shift()

    // 试着从对方话里提取称呼
    const m = message.match(/(?:叫我|喊我|我叫|我是)\s*([\u4e00-\u9fa5A-Za-z0-9_]{1,12})/)
    if (m && m[1]) this.setName(username, m[1])

    this.mem.maybeRemember('我说：' + out, { who: [username], hasNewInfo: false })

    // 真的说出去了才算回过（say 可能被 isLeak / isMachineTalk 拦下）
    const said = await this.say(out)
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

/** 清理模型输出 */
function cleanLine (out, maxLen) {
  let t = String(out || '').trim()
  t = t.replace(/^["「『（(]|["」』）)]$/g, '')
    .replace(/^(我说|回复|回答|回应)[:：]\s*/, '')
    .replace(/\n[\s\S]*$/, '')
    .trim()
  if (!t) return ''
  if (t.length > maxLen) t = t.slice(0, maxLen)
  return t
}


/**
 * 判断一个玩家是不是"另一个 AI"。
 * 这纯粹是程序层的自我保护：防止两个 bot 无限对答把服务器聊天刷爆。
 * 注意：徐俊杰本人不会觉得对方是 AI，这只是代码层面的防护。
 */
Talk.prototype.looksLikeBot = function (username) {
  const name = String(username || '')
  if (/^(bot|ai|npc|_bot|bot_|XJJ\d+|Test\d*)/i.test(name)) return true
  if (this.ctx.botNames && this.ctx.botNames.includes(name)) return true
  return false
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
