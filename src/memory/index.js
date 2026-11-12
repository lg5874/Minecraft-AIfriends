'use strict'
/**
 * 记忆总仓。
 *
 * 三层：
 *   眼前   本次任务上下文（不落盘，主程序自己管）
 *   本次   这次上线发生的事，下线时压缩成一段"今天干了啥"
 *   长期   所有带权重的印象，会衰减、会模糊、会归档
 *
 * 时间用 GameClock，下线不走 —— 服务器关了再开，他不会觉得过了很久。
 */

const fs = require('fs')
const path = require('path')

const GameClock = require('./clock')
const entry = require('./entry')
const { KINDS } = entry
const decay = require('./decay')
const recall = require('./recall')
const writer = require('./writer')
const { cnChars } = require('./text')
const { STOP } = writer

const VERSION = 2

class Memory {
  constructor (dir) {
    this.dir = dir
    this.file = path.join(dir, 'memory.json')
    this.clock = new GameClock(dir)

    this.entries = []        // 长期
    this.people = {}         // 人物档案，单独存（不衰减）
    this.places = {}         // 地点，单独存（不衰减）
    this.session = []        // 本次上线的事件（虚拟分钟 + 文本）
    this.lastDecayAt = 0
    this.load()
  }

  // ---------------- 持久化 ----------------

  load () {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const d = JSON.parse(raw || '{}')
      if (d.version !== VERSION) {
        this.migrate(d)
        return
      }
      this.entries = Array.isArray(d.entries) ? d.entries : []
      this.people = d.people || {}
      this.places = d.places || {}
      this.session = Array.isArray(d.session) ? d.session : []
      this.lastDecayAt = d.lastDecayAt || 0
      this.summaries = d.summaries || []
    } catch (e) {
      this.entries = []
      this.people = {}
      this.places = {}
      this.session = []
      this.summaries = []
    }
  }

  /** 从 v1（旧的平铺结构）迁移 */
  migrate (old) {
    this.entries = []
    this.people = {}
    this.places = {}
    this.session = []
    this.summaries = []
    // 旧的 people
    for (const [name, p] of Object.entries(old.people || {})) {
      this.people[name] = {
        firstSeen: 0, lastSeen: 0,
        notes: p.notes || [],
        gave: (p.gave || []).map(g => ({ t: 0, item: g.item })),
        got: (p.got || []).map(g => ({ t: 0, item: g.item })),
        hits: Object.keys(p.hitsBy || {}).length,
        trust: p.trust || 0
      }
    }
    // 旧的事件
    for (const e of (old.events || [])) {
      if (!e.what) continue
      this.entries.push(entry.make({
        text: `${e.who ? e.who + ' ' : ''}${e.what}`,
        kind: e.kind === 'hit' ? KINDS.GRIEVANCE : KINDS.EVENT,
        who: e.who ? [e.who] : [],
        emotion: e.kind === 'hit' ? 0.8 : 0.3,
        importance: e.kind === 'hit' ? 0.75 : 0.4
      }, 0))
    }
    // 旧的地点
    for (const [k, v] of Object.entries(old.places || {})) {
      this.places[k] = { x: v.x, y: v.y, z: v.z, note: v.note || '' }
    }
    // 旧的事实 -> 记忆
    for (const f of (old.facts || [])) {
      this.entries.push(entry.make({ text: f, kind: KINDS.FACT, importance: 0.6 }, 0))
    }
    // 旧教训 -> 记忆
    for (const l of (old.lessons || [])) {
      this.entries.push(entry.make({ text: '教训：' + l, kind: KINDS.SKILL, importance: 0.75 }, 0))
    }
    this.save()
  }

  save () {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify({
        version: VERSION,
        entries: this.entries,
        people: this.people,
        places: this.places,
        session: this.session,
        summaries: this.summaries,
        lastDecayAt: this.lastDecayAt
      }, null, 0), 'utf8')
    } catch (e) {
      console.error('[mem] save failed:', e.message)
    }
  }

  // ---------------- 时间推进 ----------------

  /** 主循环每秒调一次 */
  tick (realSeconds = 1) {
    const before = this.clock.now()
    this.clock.tick(realSeconds)
    const after = this.clock.now()
    const elapsed = after - before
    if (elapsed <= 0) return

    // 每 10 游戏分钟衰减一次
    if (after - this.lastDecayAt >= 10) {
      const span = after - (this.lastDecayAt || 0)
      this.lastDecayAt = after
      const changed = decay.decay(this.entries, span)
      const blurred = decay.blur(this.entries)
      const archived = decay.archive(this.entries)
      if (blurred.length) {
        for (const b of blurred) console.log('[mem] 记不清了：' + b.text)
      }
      if (archived.length) this.save()
    }
  }

  goOnline () {
    this.clock.goOnline()
    // 上次到这次的间隔，因为下线不走时钟，所以是 0
    const away = this.clock.sessionMinutes()
    return { sessionsBefore: this.clock.sessions - 1, awayMinutes: away }
  }

  goOffline () {
    // 下线时把这次上线压缩成一句"今天干了啥"
    this.summarizeSession()
    this.clock.goOffline()
    this.save()
  }

  // ---------------- 写 ----------------

  /** 直接记一条（调用方已经判断过值得记） */
  add ({ text, kind, who, emotion, importance, certainty, hops, where, silent }) {
    const now = this.clock.now()

    // 先去重：同一类、同一批人、内容高度重合的，合并而不是新增
    const dup = this.findDuplicate(text, kind, who, now)
    if (dup) {
      dup.repeat = (dup.repeat || 1) + 1
      dup.emotion = Math.min(1, dup.emotion + 0.08)
      dup.importance = Math.min(1, dup.importance + 0.06)
      dup.strength = Math.min(1, dup.strength + 0.15)
      dup.lastAt = now
      if (dup.emotion >= 0.7 || dup.importance >= 0.8) dup.protected = true
      this.save()
      return dup
    }

    const e = entry.make({ text, kind, who, emotion, importance, certainty, hops, where }, now)
    this.entries.push(e)
    this.session.push({ t: now, text: short(text) })
    if (this.session.length > 200) this.session.shift()
    if (!silent) this.save()
    return e
  }

  /**
   * 找重复记忆。
   * 判定：同一 kind、who 有交集、文字相似度高、且是最近 30 游戏分钟内的事。
   */
  findDuplicate (text, kind, who, now) {
    const tchars = cnChars(text, STOP)
    if (!tchars.size) return null
    const whoArr = Array.isArray(who) ? who : (who ? [who] : [])

    let best = null; let bestSim = 0
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]
      if (e.archived) continue
      if (e.kind !== kind) continue
      if (now - (e.lastAt || e.createdAt) > 30) continue

      const sameWho = whoArr.length && (e.who || []).some(w => whoArr.includes(w))
      if (whoArr.length && !sameWho) continue

      const sim = jaccard(tchars, cnChars(e.text, STOP))
      if (sim > bestSim) { bestSim = sim; best = e }
    }
    return bestSim >= 0.6 ? best : null
  }

  /** 从一句对话里提取并决定要不要记 */
  maybeRemember (text, meta = {}) {
    const v = writer.judge(text, meta)
    if (!v.keep) return null
    return this.add({
      text,
      kind: v.kind,
      who: meta.who || [],
      emotion: v.emotion,
      importance: v.importance,
      certainty: meta.certainty,
      hops: meta.hops,
      where: meta.where
    })
  }

  // ---------------- 人 ----------------

  person (name) {
    if (!name) return null
    if (!this.people[name]) {
      this.people[name] = {
        firstSeen: this.clock.now(),
        lastSeen: this.clock.now(),
        notes: [],
        gave: [], got: [],
        hits: 0,
        trust: 0,
        lastHitAt: 0
      }
    }
    this.people[name].lastSeen = this.clock.now()
    return this.people[name]
  }

  note (name, text) {
    const p = this.person(name); if (!p) return
    if (!p.notes.includes(text)) p.notes.push(text)
    if (p.notes.length > 30) p.notes.shift()
    this.add({
      text: `关于${name}：${text}`, kind: KINDS.PERSON,
      who: [name], importance: 0.6
    })
  }

  gave (to, item) {
    const p = this.person(to); if (!p) return
    p.gave.push({ t: this.clock.now(), item })
    if (p.gave.length > 40) p.gave.shift()
    this.add({
      text: `我把${item}给了${to}`, kind: KINDS.PERSON,
      who: [to], importance: 0.55, emotion: 0.4
    })
  }

  got (from, item) {
    const p = this.person(from); if (!p) return
    p.got.push({ t: this.clock.now(), item })
    if (p.got.length > 40) p.got.shift()
    p.trust = Math.min(10, (p.trust || 0) + 1)
    this.add({
      text: `${from}给了我${item}`, kind: KINDS.PERSON,
      who: [from], importance: 0.65, emotion: 0.6
    })
  }

  hit (by, times = 1) {
    const p = this.person(by); if (!p) return
    p.hits = (p.hits || 0) + times
    p.lastHitAt = this.clock.now()
    p.trust = Math.max(-10, (p.trust || 0) - times)
    this.add({
      text: `${by}打我`, kind: KINDS.GRIEVANCE,
      who: [by], importance: 0.75, emotion: 0.8
    })
  }

  hitStats (name) {
    const p = this.people[name]
    if (!p) return { times: 0, last: 0 }
    return { times: p.hits || 0, last: p.lastHitAt || 0 }
  }

  forgive (name, amount = 3) {
    const p = this.person(name); if (!p) return
    p.trust = Math.min(10, (p.trust || 0) + amount)
    p.hits = 0
    p.lastHitAt = 0
    this.add({
      text: `${name}跟我道歉了，这事就算了`, kind: KINDS.PERSON,
      who: [name], importance: 0.7, emotion: 0.6
    })
  }

  // ---------------- 地点 ----------------

  place (name, pos, note) {
    this.places[name] = {
      x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z),
      note: note || '', t: this.clock.now()
    }
    this.save()
  }

  getPlace (name) { return this.places[name] }

  // ---------------- 检索 ----------------

  /**
   * 想起一些事。
   * @param {string} query 当前情境
   * @param {object} [opts] { people:[], limit }
   */
  remember (query, opts = {}) {
    const now = this.clock.now()
    const list = recall.search(this.entries, { text: query, people: opts.people || [] },
      opts.limit || 8, now)
    recall.markRecalled(list, now)
    return list
  }

  // ---------------- 给提示词用 ----------------

  /** 最近发生的事（本次上线） */
  recentSession (n = 12) {
    const now = this.clock.now()
    return this.session.slice(-n).map(s => {
      const mins = Math.max(0, now - s.t)
      return `- ${agoText(mins)} ${s.text}`
    }).join('\n')
  }

  /** 人物摘要 */
  peopleDigest (limit = 8) {
    const now = this.clock.now()
    const list = Object.entries(this.people)
      .sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0))
      .slice(0, limit)

    if (!list.length) return '（还不认识谁）'

    return list.map(([name, p]) => {
      const bits = []
      if (p.notes && p.notes.length) bits.push(p.notes.slice(-2).join('；'))
      const got = (p.got || []).slice(-3)
      const gave = (p.gave || []).slice(-3)
      if (got.length) bits.push(`给过我 ${got.map(g => g.item).join('、')}`)
      if (gave.length) bits.push(`我给过他 ${gave.map(g => g.item).join('、')}`)
      if (p.hits > 0) {
        bits.push(`打我 ${p.hits} 次，最近一次${agoText(Math.max(0, now - (p.lastHitAt || 0)))}`)
      }
      const rel = p.trust > 3 ? '关系不错' : p.trust < -2 ? '不太待见' : '一般'
      return `- ${name}（${rel}）：${bits.join('；') || '没什么交情'}`
    }).join('\n')
  }

  /** 地点摘要 */
  placesDigest (limit = 8) {
    const list = Object.entries(this.places).slice(-limit)
    if (!list.length) return '（还没记地方）'
    return list.map(([k, v]) =>
      `- ${k}：${v.x},${v.y},${v.z}${v.note ? '（' + v.note + '）' : ''}`
    ).join('\n')
  }

  /** 上一次上线的总结 */
  lastSummary () {
    if (!this.summaries || !this.summaries.length) return null
    return this.summaries[this.summaries.length - 1]
  }

  // ---------------- 会话压缩 ----------------

  /**
   * 把这次上线压成一句"今天干了啥"。
   * 不调模型，就用事件挑几条重要的拼 —— 便宜、够用。
   */
  summarizeSession () {
    if (!this.session.length) return null
    const now = this.clock.now()
    const mine = this.session.slice(-60)

    // 挑最"有内容"的几件事
    const picked = []
    for (const s of mine) {
      if (picked.length >= 6) break
      const t = String(s.text || '')
      if (t.length < 4) continue
      if (/^(走到|看了|转了一圈)/.test(t)) continue
      picked.push(t)
    }
    if (!picked.length) return null

    const summary = {
      at: now,
      minutes: this.clock.sessionMinutes(),
      text: picked.join('；').slice(0, 300)
    }
    this.summaries = this.summaries || []
    this.summaries.push(summary)
    if (this.summaries.length > 20) this.summaries.shift()
    this.session = []
    return summary
  }

  // ---------------- 状态 ----------------

  stats () {
    return {
      entries: this.entries.length,
      alive: this.entries.filter(e => !e.archived).length,
      fuzzy: this.entries.filter(e => e.fuzzy).length,
      protectedCount: this.entries.filter(e => e.protected).length,
      people: Object.keys(this.people).length,
      places: Object.keys(this.places).length,
      playMinutes: Math.round(this.clock.now()),
      sessions: this.clock.sessions || 0
    }
  }
}

function agoText (mins) {
  if (mins < 1) return '刚才'
  if (mins < 60) return `${Math.round(mins)}分钟前`
  const h = mins / 60
  if (h < 24) return `${h.toFixed(0)}小时前`
  return `${(h / 24).toFixed(0)}天前`
}

function jaccard (a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

function short (s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > 80 ? t.slice(0, 80) + '…' : t
}

module.exports = Memory
