'use strict'
/**
 * 说话。
 *
 * 真人打字有节奏：不是收到就秒回，也不是固定延迟。
 * 句子越长打越久，但有个上限 —— 真人也不会因为一个字多就卡 10 秒。
 */

const persona = require('./persona')

const sleep = ms => new Promise(r => setTimeout(r, ms))

class Talk {
  constructor (bot, llm, mem, ctx) {
    this.bot = bot
    this.llm = llm
    this.mem = mem
    this.ctx = ctx
    this.history = []
    this.lastSpoke = 0
    this.pending = null
  }

  /** 主动说一句 */
  async say (text) {
    if (!text) return
    let t = String(text).trim()
    if (!t) return
    if (t.length > 180) t = t.slice(0, 180)

    // 漏嘴拦截
    if (persona.isLeak(t)) {
      this.ctx.log('[leak blocked] ' + t)
      t = persona.fallbackLine()
    }

    await this.humanDelay(t)
    try {
      this.bot.chat(t)
      this.lastSpoke = Date.now()
      this.ctx.log('[say] ' + t)
    } catch (e) {}
  }

  /** 按字数模拟打字时间 */
  async humanDelay (text) {
    const cfg = this.ctx.cfg.behavior
    const base = cfg.chatDelayPerChar * text.length
    const jitter = Math.random() * 800
    const d = Math.min(cfg.chatMaxDelay, Math.max(cfg.chatMinDelay, base + jitter))
    await sleep(d)
  }

  /** 收到别人的话 */
  async onChat (username, message) {
    if (username === this.bot.username) return

    // 记人 + 判断要不要记这件事
    this.mem.person(username)
    this.mem.maybeRemember(message, { who: [username], hasNewInfo: true })

    // 忙的时候不一定搭理
    const cfg = this.ctx.cfg.behavior
    if (this.ctx.busy && this.ctx.busy()) {
      if (Math.random() < cfg.ignoreChanceWhenBusy) {
        this.ctx.log('[chat] 忙着，先没理 ' + username)
        // 一半概率过一会儿补一句
        if (Math.random() < 0.5) {
          setTimeout(() => this.reply(username, message), 4000 + Math.random() * 6000)
        }
        return
      }
    }

    await this.reply(username, message)
  }

  /** 想说一个人 */
  replyTo (username) {
    this.pending = username
  }

  async reply (username, message) {
    const status = this.ctx.actions.status()
    const stateLine = `你站在 ${status.pos.x},${status.pos.y},${status.pos.z}，血 ${status.health}，饿 ${status.food}，${status.time}，手上是 ${status.held || '空手'}。${this.ctx.currentTaskDesc()}`

    // 想起跟这句相关的事
    const recalled = this.mem.remember(message, {
      people: [username],
      limit: 6
    })

    const msgs = [
      { role: 'system', content: persona.systemPrompt(this.mem, stateLine, recalled) },
      { role: 'system', content: persona.chatHint({ maxLen: 50 }) }
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

    // 清理
    out = out.replace(/^["「『]|["」』]$/g, '')
      .replace(/^(我说|回复|回答)[:：]\s*/, '')
      .replace(/\n[\s\S]*$/, '')
      .trim()
    if (!out) return
    if (out.length > 80) out = out.slice(0, 80)
    if (persona.isLeak(out)) {
      this.ctx.log('[leak blocked] ' + out)
      out = persona.fallbackLine()
    }

    this.history.push({ who: username, msg: message })
    this.history.push({ who: '我', msg: out })
    if (this.history.length > 40) this.history = this.history.slice(-40)

    // 他说的话也可能值得记（比如答应了什么）
    this.mem.maybeRemember('我说：' + out, { who: [username], hasNewInfo: false })

    await this.say(out)
  }
}

module.exports = Talk
