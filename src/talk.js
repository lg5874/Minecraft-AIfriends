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

    const status = this.ctx.actions ? this.ctx.actions.status() : null
    const stateLine = status
      ? `你站在 ${status.pos.x},${status.pos.y},${status.pos.z}，血 ${status.health}，饿 ${status.food}，${status.time}，手上是 ${status.held || '空手'}。${this.ctx.currentTaskDesc()}`
      : ''

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
- 如果你觉得这事不值一提、不想说，就只输出 [不说]`
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

    // 自己说的话里如果有承诺之类，也记一笔
    this.mem.maybeRemember('我说：' + out, { hasNewInfo: false })

    return this.say(out)
  }

  /** 收到别人的话 */
  async onChat (username, message) {
    if (username === this.bot.username) return

    // 记人
    const isNew = !this.mem.people[username]
    this.mem.person(username)

    // 第一次见：可能会问怎么称呼
    if (isNew) {
      this.ctx.log('[chat] 第一次见 ' + username)
      await this.askNameFor(username)
      // 顺便记下这次碰面
      this.mem.add({
        text: `第一次见到 ${username}`,
        kind: 'person', who: [username], importance: 0.6, emotion: 0.4
      })
      return
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

    // 忙的时候不一定搭理
    const cfg = this.ctx.cfg.behavior
    if (this.ctx.busy && this.ctx.busy()) {
      if (Math.random() < cfg.ignoreChanceWhenBusy) {
        this.ctx.log('[chat] 忙着，先没理 ' + username)
        if (Math.random() < 0.5) {
          setTimeout(() => this.reply(username, message), 4000 + Math.random() * 6000)
        }
        return
      }
    }

    await this.reply(username, message)
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
  async reply (username, message) {
    const status = this.ctx.actions.status()
    const stateLine = `你站在 ${status.pos.x},${status.pos.y},${status.pos.z}，血 ${status.health}，饿 ${status.food}，${status.time}，手上是 ${status.held || '空手'}。${this.ctx.currentTaskDesc()}`

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
        secrets: this.mem.secrets, viewer: username,
        taste: this.ctx.taste, mood: this.ctx.mood
      }) },
      {
        role: 'system',
        content: `${persona.chatHint({ maxLen: 50 })}${nameHint}${secretHint}${demandHint}

另外：如果对方在这句话里告诉了你该怎么称呼他（比如"叫我老王""我叫XX"），
你要自然地接受，并在回复里用上。`
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
      return
    }

    if (!out || out.includes('[不理]')) {
      this.ctx.log('[chat] 选择不理 ' + username)
      return
    }

    out = cleanLine(out, 60)
    if (!out) return
    if (persona.isLeak(out)) {
      this.ctx.log('[leak blocked] ' + out)
      return
    }

    this.history.push({ who: username, msg: message })
    this.history.push({ who: '我', msg: out })
    if (this.history.length > 40) this.history = this.history.slice(-40)

    // 试着从对方话里提取称呼
    const m = message.match(/(?:叫我|喊我|我叫|我是)\s*([\u4e00-\u9fa5A-Za-z0-9_]{1,12})/)
    if (m && m[1]) this.setName(username, m[1])

    this.mem.maybeRemember('我说：' + out, { who: [username], hasNewInfo: false })

    await this.say(out)
  }
}

/** 判断对方是不是在要求他做事 */
Talk.prototype.detectDemand = function (message, username) {
  const m = String(message || '')
  // 已经是同一件事的后续追问
  if (this.pendingDemand) return this.pendingDemand

  // 新要求：出现"帮我/去/给我/过来/来"这类祈使
  const isDemand = /(帮我|帮忙|去|过来|来|给我|带我|陪我|一起|快点|赶紧|挖|砍|盖|打|找)/.test(m) &&
    /(呗|吧|啊|嘛|吗|好不好|行不行|[!！]|$)/.test(m) &&
    m.length >= 4

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

module.exports = Talk
