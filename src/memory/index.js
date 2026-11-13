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
        if (!r) {
          this.journal.push({ t: e.createdAt || 0, text: short(e.text), from: 'migrate' })
          continue
        }
        // 迁移不走 add()，所以这里自己合并一次同类条目
        // （否则历史里 5 条「缺木棍这事就卡住了」会原样带进来）
        const dup = kept.find(k => k.kind === r.kind && similarText(k.text, r.text))
        if (dup) {
          dup.repeat = (dup.repeat || 1) + 1
          dup.lastAt = Math.max(dup.lastAt || 0, r.lastAt || 0)
          continue
        }
        kept.push(r)
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
        // 模糊化的文案由 decay.js 给，但"记不清也得记得是谁"这条要求
        // 在这里补一刀 —— decay.js 是设计层，不去改它。
        for (const b of blurred) {
          b.text = fuzzyText(b)
          console.log('[mem] 记不清了：' + b.text)
        }
        this.save()
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

    // 称呼告示里的名字要洗干净：
    //   talk.js 写的是「XJJVER6 让我叫他 小徐就行」，callMe 原文没洗
    //   -> 「XJJVER6 让我叫他 小徐」
    const text2 = finalText.replace(/(让我叫他|让我喊他|让我叫他做)\s*(\S+)$/, (all, lead, nm) => {
      return lead + ' ' + cleanCallMe(nm)
    })

    // 先去重：同一类、同一批人、内容高度重合的，合并而不是新增
    const dup = this.findDuplicate(text2, kind, who, now)
    if (dup) {
      return this.mergeRepeat(dup, now)
    }

    // 同一次死亡会走两条路：
    //   1. 系统给的死法「死了：XJJ was slain by Zombie」-> 「被僵尸弄死了」
    //   2. 他自己那句吐槽「草，被僵尸挠死了」
    // 文字相似度不够（0.6），去重抓不住，于是记成两条 —— 一次死变成两条记忆。
    // 按**内容**判（不能按 kind：吐槽那句会被归成 event），死因对得上就并。
    if (/死/.test(text2)) {
      const cause = deathCause(text2)
      if (cause) {
        const sameDeath = this.entries.find(e => {
          if (e.archived) return false
          if (!/死/.test(e.text)) return false
          if (now - (e.lastAt || e.createdAt) > 3) return false   // 3 游戏分钟内算同一次
          return deathCause(e.text) === cause
        })
        if (sameDeath) {
          // 保留信息更全的那条（一般是系统翻出来的「被僵尸弄死了」）
          if (text2.length > sameDeath.text.length) sameDeath.text = text2
          return this.mergeRepeat(sameDeath, now)
        }
      }
    }

    const e = entry.make({
      text: text2,
      kind,
      who,
      where,
      emotion: v.emotion == null ? o.emotion : v.emotion,
      importance: v.importance == null ? o.importance : v.importance,
      certainty: o.certainty,
      hops: o.hops
    }, now)
    this.entries.push(e)
    this.session.push({ t: now, text: short(text2) })
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
   * 合并一条重复记忆。
   *
   * 关键：**重复 ≠ 刻骨铭心**。
   * 「还差点石头」念了 7 遍，只能说明"我老是缺石头"，不是"这事我忘不了"。
   * 所以：
   *   - 强度可以回一点（想起过，记忆会清晰些）
   *   - 情绪/重要性只小幅上升，且**有硬上限**，绝不允许刷到保护线（0.7 / 0.8）
   *   - 重复次数只用来给一点"这事反复发生"的分量
   *
   * 旧实现每 repeat 一次 emotion +0.08 / importance +0.06 / strength +0.15 无上限，
   * 8 次就把一句废话刷成 protected: true，永不衰减 —— 直接违背"会忘事是设计"。
   */
  mergeRepeat (dup, now) {
    dup.repeat = (dup.repeat || 1) + 1
    dup.lastAt = now

    // 想起过一次，清晰一点，但回到 1.0 就够，不给额外奖励
    dup.strength = Math.min(1, (dup.strength || 0) * 1 + 0.12)

    // 情绪/重要性：按"原始值"往上涨，但封顶在保护线以下
    // 0.62 / 0.72 是留了余量的上限 —— 再重复也不会自己升格成"刻骨铭心"
    const emoCap = Math.min(0.62, (dup.emotion || 0) + 0.05)
    const impCap = Math.min(0.72, (dup.importance || 0) + 0.04)
    dup.emotion = Math.max(dup.emotion || 0, emoCap)
    dup.importance = Math.max(dup.importance || 0, impCap)

    // 本来就已经是刻骨铭心的（情感/重要性本来就高），重复时保持保护
    // 但**不允许**靠重复跨过这条线
    if ((dup.emotion >= 0.7 || dup.importance >= 0.8) && dup.protected) {
      dup.protected = true
    }

    this.save()
    return dup
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

      // 时间窗：默认 30 游戏分钟。
      // 但「教训/技能」和「地点」是不衰减的长期知识 —— 同一句规则隔几天又踩一次，
      // 也该合并成一条（记 repeat 次数），而不是堆成 5 条一样的「缺木棍这事就卡住了」。
      const forever = kind === KINDS.SKILL || kind === KINDS.PLACE
      if (!forever && now - (e.lastAt || e.createdAt) > 30) continue

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
    const p = this.people[name]
    p.lastSeen = this.clock.now()
    // talk.js 的正则会把「俊杰就行」「小徐吧」整段抓进来当称呼。
    // 这里统一洗一遍 —— 不改 talk.js，但存储侧必须是干净的。
    if (p.callMe) p.callMe = cleanCallMe(p.callMe)
    return p
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
    if (!name) return null

    const x = Math.round(pos.x)
    const y = Math.round(pos.y)
    const z = Math.round(pos.z)

    // 同一个坐标不许挂 4 个名字。
    // 真实数据里 100,59,14 挂了「水边探索起点 / 标记起点 / 水边探索终点 / 标记点0」四条，
    // 挤满 placesDigest 的 8 行名额，还让"想起这地方"变成噪声。
    // 处理：同坐标已存在就并过去（保留旧名，note 追加），不再新增。
    const sameCoord = Object.keys(this.places).find(k => {
      const p = this.places[k]
      return p && p.x === x && p.y === y && p.z === z
    })
    if (sameCoord && sameCoord !== name) {
      const keep = this.places[sameCoord]
      if (note && !String(keep.note || '').includes(note)) {
        keep.note = [keep.note, note].filter(Boolean).join('；')
      }
      keep.t = this.clock.now()
      // 别名记下来，方便以后按新名字查
      keep.aliases = keep.aliases || []
      if (!keep.aliases.includes(name)) keep.aliases.push(name)
      this.save()
      return sameCoord
    }

    this.places[name] = {
      x, y, z,
      note: note || '', t: this.clock.now(),
      aliases: (this.places[name] && this.places[name].aliases) || []
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
    return name
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
    const all = Object.entries(this.places)
    if (!all.length) return '（还没记地方）'

    // 别随便截最后 8 个 —— 家、出生点这种要永远在最前面。
    // 排序：有名字含义的（家/出生点/庇护所）> 最近去过的 > 其他
    const IMPORTANT = /家|出生点|基地|庇护所|矿洞|矿脉|箱子|炉/
    const list = all
      .map(([k, v]) => ({ k, v, score: (IMPORTANT.test(k) ? 100 : 0) + (v.t || 0) / 1000 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(x => [x.k, x.v])

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
   * **保守原则**：已经是「恩怨 / 承诺 / 地点 / 技能」的条目一律保留。
   * 那四类不是"文本长什么样"的问题，是"这确实发生过"的事实 ——
   * 重生脚本不该因为一句正则就把"他打过我"删掉。
   * 只有归类为普通 event / person 的，才按准入规则重新体检。
   *
   * @param {object} [opts] { dryRun }
   * @returns {{before:number, after:number, removed:number, rescued:number, samples:object[]}}
   */
  purgeLogs (opts = {}) {
    const before = this.entries.length
    const kept = []
    const removed = []
    let rescued = 0

    const KEEP_KINDS = new Set([KINDS.GRIEVANCE, KINDS.PROMISE, KINDS.PLACE, KINDS.SKILL])

    for (const e of this.entries) {
      // 恩怨/承诺/技能：事实层，不动。
      // 那三类是"这确实发生过"，不该因为一句正则被删。
      if (e.kind === KINDS.GRIEVANCE || e.kind === KINDS.PROMISE || e.kind === KINDS.SKILL) {
        kept.push(e)
        continue
      }

      // 地点：得真有"某地有某物"的内容。
      // 「上线了 上次那边还有铁没挖完」被误判成 place 存进来了 —— 那不是地点知识。
      if (e.kind === KINDS.PLACE) {
        const looksLikePlace = /[:：]/.test(e.text) || /(?:有|藏着|全是|都是|能挖到)/.test(e.text)
        if (looksLikePlace) { kept.push(e); continue }
        // 不像地点知识，退回普通准入再体检
      }

      const r = sanitizeEntry(e)
      if (!r) { removed.push(e); continue }
      if (r.text !== e.text) rescued++
      kept.push(r)
    }

    // 合并清理后可能撞车的同类条目
    const merged = []
    for (const e of kept) {
      const dup = merged.find(k => k.kind === e.kind && similarText(k.text, e.text))
      if (dup) {
        dup.repeat = (dup.repeat || 1) + (e.repeat || 1)
        dup.lastAt = Math.max(dup.lastAt || 0, e.lastAt || 0)
        continue
      }
      merged.push(e)
    }

    const report = {
      before,
      after: merged.length,
      removed: removed.length,
      rescued,
      samples: removed.slice(0, 10).map(e => ({ kind: e.kind, text: String(e.text).slice(0, 70) }))
    }

    if (!opts.dryRun) {
      this.entries = merged
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
 * 清洗"他让我叫他 X"里的 X。
 *
 * talk.js 用 `(?:叫我|喊我|我叫|我是)\s*([\u4e00-\u9fa5A-Za-z0-9_]{1,12})`
 * 抓称呼，会把后面的语气词一起吃进来：
 *   「叫我俊杰就行」-> 俊杰就行
 *   「叫我小徐吧」  -> 小徐吧
 *   「我叫老王啊」  -> 老王啊
 * 这里把尾巴上的虚词剁掉。宁可短一点，也别让他喊错人。
 */
function cleanCallMe (raw) {
  let s = String(raw || '').trim()
  if (!s) return s

  // 先剁掉尾巴上的语气词/助词（可连续）
  s = s.replace(/[就吧啊呀哦嘛哈呢了的呗啦噢喔]+$/g, '')

  // 再剁掉常见的"就行/可以了/就好"这种收尾
  s = s.replace(/(就行|就好|就可以|可以了|就行了|吧就行)$/g, '')

  // 名字里不该有空格和标点
  s = s.replace(/[\s，。！？、；：,.!?;:]/g, '')

  // 长度兜底：MC 用户名最长 16，中文称呼一般 2~4
  if (s.length > 16) s = s.slice(0, 16)
  return s || String(raw || '').trim()
}

/**
 * "记不清了"该怎么说。
 *
 * 真人忘细节，但**不会忘掉人**。
 *   ✓ 「好像跟老王干过什么事，具体记不清了」
 *   ✗ 「有那么件事，但是记不太清是什么了」  ← 这等于把人也忘了
 *
 * decay.js 的 blur() 已经写了文字，这里只做"如果丢了人/地点就补回来"。
 * 为什么不直接改 decay.js：半衰期和保护条件是设计层，不动。
 */
function fuzzyText (e) {
  const who = e.who && e.who.length ? e.who[0] : null
  const base = String(e.text || '')
  if (!who) return base
  if (base.includes(who)) return base
  // 文字里没人名了，按种类给一个"还记得是谁"的说法
  switch (e.kind) {
    case KINDS.GRIEVANCE: return `好像跟${who}闹过不愉快，细节想不起来了`
    case KINDS.PERSON: return `好像跟${who}打过交道，具体什么事想不起来了`
    case KINDS.PROMISE: return `好像答应过${who}什么事，想不起来了`
    default: return `${base}（好像跟${who}有关）`
  }
}

/**
 * 从一句"死"的描述里认出死因，用来判断两条是不是同一次死亡。
 * 认不出返回 null —— 宁可不合并，也别把两次死并成一次。
 */
function deathCause (text) {
  const t = String(text || '')
  const CAUSES = [
    ['僵尸', /僵尸|zombie/i],
    ['溺尸', /溺尸|drowned/i],
    ['骷髅', /骷髅|skeleton/i],
    ['蜘蛛', /蜘蛛|spider/i],
    ['苦力怕', /苦力怕|爬行者|creeper/i],
    ['末影人', /末影人|enderman/i],
    ['女巫', /女巫|witch/i],
    ['岩浆', /岩浆|熔岩|lava/i],
    ['水', /淹死|水里|drown/i],
    ['摔', /摔|fell/i],
    ['饿', /饿死|starve/i],
    ['炸', /炸死|爆炸|explosion/i]
  ]
  for (const [name, re] of CAUSES) if (re.test(t)) return name
  // 「莫名其妙死了一回」「不知道怎么回事」——没有可辨识的死因
  if (/莫名其妙|不知道怎么回事|没搞清/.test(t)) return 'unknown'
  return null
}

/** 两句话是不是在说同一件事（用于合并重复） */
function similarText (a, b) {
  const A = cnChars(a, STOP)
  const B = cnChars(b, STOP)
  return jaccard(A, B) >= 0.6
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

  // 称呼告示也要洗（add() 里洗过一次，清理路径也得洗）
  const cleaned = String(v.text).replace(/(让我叫他|让我喊他)\s*(\S+)$/, (all, lead, nm) => {
    return lead + ' ' + cleanCallMe(nm)
  })

  const ne = entry.make({
    text: cleaned,
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
