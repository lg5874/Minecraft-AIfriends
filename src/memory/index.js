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

const VERSION = 3

class Memory {
  constructor (dir) {
    this.dir = dir
    this.file = path.join(dir, 'memory.json')
    this.clock = new GameClock(dir)

    this.entries = []        // 长期
    this.people = {}         // 人物档案，单独存（不衰减）
    this.places = {}         // 地点，单独存（不衰减）
    this.session = []        // 本次上线的事件（虚拟分钟 + 文本）
    this.secrets = []        // 别人私下托付的秘密
    this.journal = []        // 工作日志：任务执行结果走这里，不进 entries
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
      this.secrets = Array.isArray(d.secrets) ? d.secrets : []
      this.journal = Array.isArray(d.journal) ? d.journal : []
      this.lastDecayAt = d.lastDecayAt || 0
      this.summaries = d.summaries || []
    } catch (e) {
      this.entries = []
      this.people = {}
      this.places = {}
      this.session = []
      this.summaries = []
      this.journal = []
    }
  }

  /**
   * 迁移。
   * v1: 旧的平铺结构（events/facts/lessons/places）
   * v2: entries 里混着大量任务流水账 -> 过一遍准入，不合格的挪进 journal
   */
  migrate (old) {
    this.entries = []
    this.people = {}
    this.places = {}
    this.session = []
    this.secrets = []
    this.summaries = []
    this.journal = []

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

    // v2 -> v3：把历史里混进来的任务流水账清出去
    if (Array.isArray(old.entries) && old.entries.length) {
      this.people = old.people || this.people
      this.places = old.places || this.places
      this.secrets = Array.isArray(old.secrets) ? old.secrets : []
      this.summaries = Array.isArray(old.summaries) ? old.summaries : []
      this.lastDecayAt = old.lastDecayAt || 0
      const kept = []
      for (const e of old.entries) {
        const r = sanitizeEntry(e)
        if (r) kept.push(r)
        else this.journal.push({ t: e.createdAt || 0, text: short(e.text), from: 'migrate' })
      }
      this.entries = kept
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
        secrets: this.secrets,
        summaries: this.summaries,
        journal: this.journal.slice(-300),
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

  /**
   * 写一条记忆。**所有路径最后都走这里**，所以准入判定只能有一处。
   *
   * 判定不合格的（任务流水账、计划、自言自语）不进记忆，
   * 只落到 journal —— 那是工作日志，不进提示词、不衰减、也不占记忆位置。
   *
   * @param {object} o
   * @param {string} o.text
   * @param {string} [o.kind]
   * @param {string|string[]} [o.who]
   * @param {number} [o.emotion]
   * @param {number} [o.importance]
   * @param {boolean} [o.force] 调用方已经确认真实语义（人物档案/秘密/恩怨），跳过准入
   * @returns {object|null} 写入或命中的条目；被判定为日志时返回 null
   */
  add (o = {}) {
    const now = this.clock.now()
    const text = String(o.text == null ? '' : o.text).replace(/\s+/g, ' ').trim()
    if (!text) return null

    let v
    if (o.force) {
      v = { keep: true, text, kind: o.kind || KINDS.EVENT, who: normWho(o.who), where: o.where || null, emotion: o.emotion, importance: o.importance, reason: 'forced' }
    } else {
      v = writer.admit({
        text,
        kind: o.kind,
        who: o.who,
        where: o.where,
        emotion: o.emotion,
        importance: o.importance,
        // 老接口的契约：调用方显式给了情绪/重要性，说明它已经判断过"这事有点分量"。
        // 这种允许进，但压成弱记忆（几小时就淡），不会污染长期印象。
        vouched: o.emotion != null || o.importance != null
      })
    }

    // 不是记忆，是日志
    if (!v.keep) {
      this.journal.push({ t: now, text: short(text), why: v.reason })
      if (this.journal.length > 300) this.journal.shift()
      if (!o.silent) this.save()
      return null
    }

    const finalText = v.text
    const kind = v.kind
    const who = (v.who && v.who.length) ? v.who : normWho(o.who)
    const where = v.where || o.where || null

    // 先去重：同一类、同一批人、内容高度重合的，合并而不是新增
    const dup = this.findDuplicate(finalText, kind, who, now)
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

    const e = entry.make({
      text: finalText,
      kind,
      who,
      where,
      emotion: v.emotion == null ? o.emotion : v.emotion,
      importance: v.importance == null ? o.importance : v.importance,
      certainty: o.certainty,
      hops: o.hops
    }, now)
    this.entries.push(e)
    this.session.push({ t: now, text: short(finalText) })
    if (this.session.length > 200) this.session.shift()
    if (!o.silent) this.save()
    return e
  }

  /**
   * 只记日志，不碰记忆。
   * 任务执行结果走这里 —— 他要复盘时能查，但不会把它当成"记忆"念出来。
   */
  log (text, meta = {}) {
    const now = this.clock.now()
    this.journal.push({
      t: now,
      text: short(String(text || '')),
      why: meta.why || 'task',
      ok: meta.ok
    })
    if (this.journal.length > 300) this.journal.shift()
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
    const v = writer.admit({ text, who: meta.who, where: meta.where })
    if (!v.keep) return null
    return this.add({
      text: v.text,
      kind: v.kind,
      who: v.who && v.who.length ? v.who : meta.who || [],
      emotion: v.emotion,
      importance: v.importance,
      certainty: meta.certainty,
      hops: meta.hops,
      where: v.where || meta.where,
      force: true   // 已经判定过，别再判一次
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
      who: [name], importance: 0.6, force: true
    })
  }

  gave (to, item) {
    const p = this.person(to); if (!p) return
    p.gave.push({ t: this.clock.now(), item })
    if (p.gave.length > 40) p.gave.shift()
    this.add({
      text: `我把${item}给了${to}`, kind: KINDS.PERSON,
      who: [to], importance: 0.55, emotion: 0.4, force: true
    })
  }

  got (from, item) {
    const p = this.person(from); if (!p) return
    p.got.push({ t: this.clock.now(), item })
    if (p.got.length > 40) p.got.shift()
    p.trust = Math.min(10, (p.trust || 0) + 1)
    this.add({
      text: `${from}给了我${item}`, kind: KINDS.PERSON,
      who: [from], importance: 0.65, emotion: 0.6, force: true
    })
  }

  hit (by, times = 1) {
    const p = this.person(by); if (!p) return
    p.hits = (p.hits || 0) + times
    p.lastHitAt = this.clock.now()
    p.trust = Math.max(-10, (p.trust || 0) - times)
    this.add({
      text: `${by}打我`, kind: KINDS.GRIEVANCE,
      who: [by], importance: 0.75, emotion: 0.8, force: true
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
      who: [name], importance: 0.7, emotion: 0.6, force: true
    })
  }

  // ---------------- 秘密 ----------------

  /** 存一个别人托付的秘密 */
  addSecret ({ content, from, about, weight }) {
    if (!content) return null
    // 同一个人重复说同一件事，合并
    const dup = this.secrets.find(s => s.from === from && s.content === content)
    if (dup) return dup

    const sec = {
      id: 's' + Date.now().toString(36),
      content: String(content).slice(0, 200),
      from,
      about: about || '',
      weight: weight == null ? 0.5 : weight,
      promiseStrength: 0.8,
      t: this.clock.now(),
      toldTo: []
    }
    this.secrets.push(sec)
    if (this.secrets.length > 30) this.secrets.shift()
    this.save()
    this.add({
      text: `${from} 私下跟我说：${content}${about ? '（不能让 ' + about + ' 知道）' : ''}`,
      kind: 'promise', who: [from].concat(about ? [about] : []),
      importance: 0.8, emotion: 0.5, force: true
    })
    return sec
  }

  /** 取秘密（可以按问的人过滤） */
  getSecrets (askerName) {
    return this.secrets.filter(s => !askerName || !(s.toldTo || []).includes(askerName))
  }

  /** 记录"我跟谁说了" */
  markTold (secretId, to) {
    const s = this.secrets.find(x => x.id === secretId)
    if (!s) return
    s.toldTo = s.toldTo || []
    if (!s.toldTo.includes(to)) s.toldTo.push(to)
    this.save()
  }

  // ---------------- 地点 ----------------

  place (name, pos, note) {
    this.places[name] = {
      x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z),
      note: note || '', t: this.clock.now()
    }
    // 地点本身不衰减（places 单独存），但"这地方有什么"要进记忆，
    // 这样他在附近时会想起来。
    // note 得是人话 —— "评分 5.0" 这种是内部打分，不是记忆。
    if (note && !/^(评分|score|得分)\s*[:：]?\s*[\d.]+$/i.test(String(note).trim())) {
      this.add({
        text: `${name}：${note}`,
        kind: KINDS.PLACE,
        where: name,
        importance: 0.6,
        force: true
      })
    }
    this.save()
  }

  /**
   * 记一条地点知识：「X 那边有 Y」。
   * 这是真人会记的东西，也是"想起"最有用的东西。
   */
  learnPlace (where, what, opts = {}) {
    if (!where || !what) return null
    return this.add({
      text: `${where}那边有${what}`,
      kind: KINDS.PLACE,
      where,
      importance: opts.importance == null ? 0.6 : opts.importance,
      emotion: opts.emotion || 0.3,
      force: true
    })
  }

  getPlace (name) { return this.places[name] }

  // ---------------- 检索 ----------------

  /**
   * 想起一些事。
   * @param {string} query 当前情境
   * @param {object} [opts] { people:[], limit, near:{x,z} }
   */
  remember (query, opts = {}) {
    const now = this.clock.now()
    const list = recall.search(
      this.entries,
      {
        text: query,
        people: opts.people || [],
        near: opts.near || null,
        places: this.places
      },
      opts.limit || 8,
      now
    )
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
   *
   * 注意：这里只压**真记忆**（session 里本来就是准入过的），
   * 而且不再从 journal 抓文本 —— 否则又把流水账绕回来了。
   */
  summarizeSession () {
    if (!this.session.length) {
      this.session = []
      return null
    }
    const now = this.clock.now()
    const mine = this.session.slice(-60)

    const picked = []
    for (const s of mine) {
      if (picked.length >= 5) break
      const t = String(s.text || '')
      if (t.length < 4) continue
      picked.push(t)
    }
    if (!picked.length) {
      this.session = []
      return null
    }

    const summary = {
      at: now,
      minutes: this.clock.sessionMinutes(),
      text: picked.join('；').slice(0, 240)
    }
    this.summaries = this.summaries || []
    this.summaries.push(summary)
    if (this.summaries.length > 20) this.summaries.shift()
    this.session = []
    return summary
  }

  // ---------------- 状态 ----------------

  /**
   * 清理：把记忆里混着的任务流水账挑出去。
   * 幂等 —— 跑几次结果一样，可以随时手动跑。
   *
   * @param {object} [opts] { dryRun }
   * @returns {{before:number, after:number, removed:number, rescued:number, samples:object[]}}
   */
  purgeLogs (opts = {}) {
    const before = this.entries.length
    const kept = []
    const removed = []
    let rescued = 0

    for (const e of this.entries) {
      const r = sanitizeEntry(e)
      if (!r) { removed.push(e); continue }
      if (r.text !== e.text) rescued++
      kept.push(r)
    }

    const report = {
      before,
      after: kept.length,
      removed: removed.length,
      rescued,
      samples: removed.slice(0, 10).map(e => ({ kind: e.kind, text: String(e.text).slice(0, 70) }))
    }

    if (!opts.dryRun) {
      this.entries = kept
      for (const e of removed) {
        this.journal.push({ t: e.createdAt || 0, text: short(e.text), why: 'purge' })
      }
      if (this.journal.length > 300) this.journal = this.journal.slice(-300)
      this.save()
    }
    return report
  }

  stats () {
    return {
      entries: this.entries.length,
      alive: this.entries.filter(e => !e.archived).length,
      fuzzy: this.entries.filter(e => e.fuzzy).length,
      protectedCount: this.entries.filter(e => e.protected).length,
      people: Object.keys(this.people).length,
      places: Object.keys(this.places).length,
      journal: (this.journal || []).length,
      playMinutes: Math.round(this.clock.now()),
      sessions: this.clock.sessions || 0,
      secrets: (this.secrets || []).length
    }
  }

  /** 工作日志（给排查用，不进提示词） */
  recentLog (n = 10) {
    return (this.journal || []).slice(-n)
  }
}

function agoText (mins) {
  if (mins < 1) return '刚才'
  if (mins < 60) return `${Math.round(mins)}分钟前`
  const h = mins / 60
  if (h < 24) return `${h.toFixed(0)}小时前`
  return `${(h / 24).toFixed(0)}天前`
}

function normWho (w) {
  if (!w) return []
  return (Array.isArray(w) ? w : [w]).filter(Boolean).slice(0, 6)
}

/**
 * 体检一条历史条目：是真记忆就留下（必要时压一压），是流水账就返回 null。
 * 迁移和清理都走这里。
 */
function sanitizeEntry (e) {
  if (!e || !e.text) return null
  const v = writer.admit({
    text: e.text,
    kind: e.kind,
    who: e.who,
    where: e.where,
    emotion: e.emotion,
    importance: e.importance
  })
  if (!v.keep) return null

  // 已经在衰减的，尊重它现在的强度（别让清理变成"恢复记忆"）
  const keepStrength = typeof e.strength === 'number' ? e.strength : 1
  const ne = entry.make({
    text: v.text,
    kind: v.kind,
    who: (v.who && v.who.length) ? v.who : normWho(e.who),
    where: v.where || e.where || null,
    emotion: e.emotion == null ? v.emotion : e.emotion,
    importance: e.importance == null ? v.importance : e.importance,
    certainty: e.certainty,
    hops: e.hops
  }, e.createdAt || 0)
  ne.id = e.id || ne.id
  ne.strength = keepStrength
  ne.recallCount = e.recallCount || 0
  ne.lastRecall = e.lastRecall || 0
  ne.repeat = e.repeat
  ne.lastAt = e.lastAt
  ne.fuzzy = false   // 文字变了，模糊标记不适用
  ne.archived = e.archived || false
  return ne
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
