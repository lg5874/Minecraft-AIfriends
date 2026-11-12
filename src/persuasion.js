'use strict'
/**
 * 说服。
 *
 * 核心：**拒绝不是终点。**
 *
 * 真人的"不"分好几种：
 *   "不行我忙着呢"   —— 有商量
 *   "说了不去"       —— 生气了，但还能磨
 *   "不"             —— 真不干
 *
 * 而且对方能用的手段很多：
 *   求他、给好处、讲道理、硬来、装可怜、反复磨
 * 每种手段效果不一样，看你俩关系、看他当时心情、看这事多麻烦。
 *
 * 所以这里不是"一次掷骰子决定"，是**一个会累积的过程**。
 */

// 说服手段
const APPROACH = {
  BEG: 'beg',           // 求、说好话、撒娇
  BARGAIN: 'bargain',   // 给好处、交换
  REASON: 'reason',     // 讲道理、说为什么重要
  COMMAND: 'command',   // 命令、摆身份
  THREAT: 'threat',     // 威胁、放狠话
  GUILT: 'guilt',       // 装可怜、拉感情
  REPEAT: 'repeat'      // 就是重复一遍
}

/**
 * 从一句话判断他用的是哪种手段。
 */
function classify (text) {
  const t = String(text || '')
  if (!t) return APPROACH.REPEAT

  if (/(求你|求你|帮帮忙|拜托|就这一次|行行好|好不好嘛|求求)/.test(t)) return APPROACH.BEG
  if (/(给你|换|拿.*换|你要是帮我|报酬|分你|送你|好处)/.test(t)) return APPROACH.BARGAIN
  if (/(因为|不然|否则|要是.*就|很重要|必须|急用|等下|不然.*没法)/.test(t)) return APPROACH.REASON
  if (/(快点|赶紧|马上|我叫你|你听不听话|命令你|必须去)/.test(t)) return APPROACH.COMMAND
  if (/(踢你|打你|删你|举报你|拆了你|拆你|放火烧|炸你|不给你|要你好看|叫op|告你)/.test(t)) return APPROACH.THREAT
  if (/(你再不|不.*的话.*我|不然我)/.test(t)) return APPROACH.THREAT
  if (/(可怜|都快死了|就我一个|没人帮|你不帮我.*怎么办|好难受)/.test(t)) return APPROACH.GUILT
  return APPROACH.REPEAT
}

/**
 * 每种手段的效果。
 * pressure: 累积多少压力（磨久了会松口）
 * irritate: 惹毛多少（硬来会烦）
 * warmth:   对关系的影响（威胁会掉感情）
 * trust需要: 关系得多好才管用
 */
const EFFECT = {
  [APPROACH.BEG]:     { pressure: 0.30, irritate: 0.05, warmth: 0.02, needTrust: 0.1 },
  [APPROACH.BARGAIN]: { pressure: 0.55, irritate: 0.00, warmth: 0.05, needTrust: 0.0 },
  [APPROACH.REASON]:  { pressure: 0.24, irritate: 0.10, warmth: 0.00, needTrust: 0.0 },
  [APPROACH.GUILT]:   { pressure: 0.34, irritate: 0.08, warmth: 0.00, needTrust: 0.3 },
  [APPROACH.COMMAND]: { pressure: 0.30, irritate: 0.28, warmth: -0.06, needTrust: 0.2 },
  [APPROACH.THREAT]:  { pressure: 0.38, irritate: 0.45, warmth: -0.25, needTrust: 0.0 },
  [APPROACH.REPEAT]:  { pressure: 0.12, irritate: 0.12, warmth: -0.02, needTrust: 0.0 }
}

class Persuasion {
  constructor (dir) {
    this.file = require('path').join(dir, 'requests.json')
    this.requests = {}   // key: 人 -> 请求状态
    this.load()
  }

  load () {
    try { this.requests = JSON.parse(require('fs').readFileSync(this.file, 'utf8')) } catch (e) { this.requests = {} }
  }

  save () {
    try {
      require('fs').mkdirSync(require('path').dirname(this.file), { recursive: true })
      require('fs').writeFileSync(this.file, JSON.stringify(this.requests, null, 1), 'utf8')
    } catch (e) {}
  }

  /**
   * 收到一个请求。
   * @param {object} o
   * @param {string} o.who     谁在要求
   * @param {string} o.what    要干什么
   * @param {number} o.effort  多麻烦 0~1
   * @param {object} o.ctx     { mood, trust, liked }
   * @returns {object} 他的反应
   */
  ask ({ who, what, task, effort = 0.5, ctx }) {
    const now = Date.now()
    const key = who
    let req = this.requests[key]
    // task = 到底要他干什么（用来判断是不是同一件事）
    // what = 他说的原话（用来判断用了什么手段）
    const taskKey = task || what

    // 新请求，或者换了件事
    if (!req || req.taskKey !== taskKey) {
      // 第一次的抵抗力：看心情、看麻烦程度、看关系
      // 关系好的人开口，本来就不太好拒绝
      const baseline = 0.42 + effort * 0.28 - (ctx.trust || 0) * 0.035
      req = {
        taskKey,
        what,
        since: now,
        attempts: 0,
        pressure: 0,
        resistance: clamp(baseline, 0.1, 0.95),
        approaches: [],
        countered: false
      }
      this.requests[key] = req
    }

    req.attempts++
    req.lastAt = now

    const approach = classify(what)   // 用原话判断手段，不是任务名
    const eff = EFFECT[approach] || EFFECT[APPROACH.REPEAT]
    req.approaches.push({ at: now, approach })

    // 关系不够，这招不好使
    const trustGate = (ctx.trust || 0) >= eff.needTrust * 10

    // 第一次只是提一下，不算说服
    const isFirst = req.attempts === 1

    let gained = eff.pressure * (trustGate ? 1 : 0.3)
    // 同一个手段用多了会失效（他会免疫）
    const sameCount = req.approaches.filter(a => a.approach === approach).length
    if (sameCount > 2) gained *= Math.max(0.2, 1 - (sameCount - 2) * 0.3)

    // 心情好时更容易松口
    if (ctx.moodState === 'good') gained *= 1.3
    if (ctx.moodState === 'irritated') gained *= 0.5
    if (ctx.moodState === 'tired') gained *= 0.6

    req.pressure += gained
    // 每多磨一次，抵抗本身也松动一点点（人会累）
    if (!isFirst) req.resistance = Math.max(0.15, req.resistance - 0.02)

    // 惹毛
    const irritation = eff.irritate * (isFirst ? 0.5 : 1)
    const warmth = eff.warmth

    // 判断松口没有
    let comply = req.pressure >= req.resistance
    // 威胁的特殊情况：不情愿地先应下，但记仇
    if (!comply && approach === APPROACH.THREAT && Math.random() < 0.4) {
      comply = true
    }

    // 决定表现
    let style, reason
    if (comply) {
      if (req.pressure > req.resistance * 2) style = 'cave_hard'    // 顶不住了
      else if (approach === APPROACH.BARGAIN) style = 'deal'        // 谈成了
      else if (approach === APPROACH.BEG) style = 'softened'        // 心软了
      else if (approach === APPROACH.COMMAND || approach === APPROACH.THREAT) style = 'submit'
      else style = 'reluctant'
      reason = `压力${req.pressure.toFixed(2)} >= 抵抗${req.resistance.toFixed(2)}`
    } else {
      // 还没松口：看压力差和情绪决定怎么拒
      const gap = req.resistance - req.pressure
      if (irritation > 0.3) style = 'angry_no'
      else if (gap < 0.12) style = 'hesitate'      // 快松口了，语气会软
      else if (isFirst) style = 'first_no'         // 第一次就正常拒绝
      else style = 'firm_no'
      reason = `压力${req.pressure.toFixed(2)} < 抵抗${req.resistance.toFixed(2)}（差${gap.toFixed(2)}）`
    }

    this.save()

    return {
      comply,
      style,
      approach,
      attempts: req.attempts,
      pressure: +req.pressure.toFixed(2),
      resistance: +req.resistance.toFixed(2),
      gap: +(req.resistance - req.pressure).toFixed(2),
      irritation,
      warmth,
      reason
    }
  }

  /** 答应了，清掉这个请求 */
  resolved (who) {
    delete this.requests[who]
    this.save()
  }

  /** 现在还挂着的请求（他还没松口） */
  pending (who) {
    return this.requests[who] || null
  }

  /**
   * 生成"怎么回应这个要求"的提示词。
   * 原则：把他的心理状态说清楚，但话让模型自己说。
   */
  hint (verdict, who, what) {
    const s = verdict.style
    const name = who

    const map = {
      first_no: `你不太想干这件事。正常拒绝，说个理由（真在忙、不想跑、没兴趣）。
说话可以随意点，不用很客气。`,

      firm_no: `你已经拒绝过一次了，他还来要。你会更不耐烦一点。
但不用吵，就是重复"不去"、"你自己弄"这种。`,

      hesitate: `他一直在说，你有点动摇了，但还不想直接答应。
可以说点软的："等我弄完这个"、"……那行吧"、"烦死了"这种口风。`,

      angry_no: `你已经烦了。他这么说话让你不爽。
会有情绪，可能顶回去，语气重。但不用骂街。`,

      softened: `他是求你的，你心软了。可以答应，但嘴上会嘟囔一句
（"行行行，就这一次"）。`,

      deal: `他给了你好处，这笔买卖划算。答应，可能还会确认一下他给什么。`,

      submit: `他硬来/施压了，你不想再顶。答应了，但心里不痛快，可能阴阳一句。`,

      cave_hard: `他磨了你太久，你已经烦得不想争了。答应了，语气会很不情愿。`,

      reluctant: `你答应了，但不太乐意。可以答应得简短点，别显得热情。`
    }

    return `## 现在的情况
${name} 想让你：${what}

${map[s] || map.first_no}

注意：
- 就正常说话，别解释心理活动
- 不想答应就直接说不想，不用说抱歉
- 答应了就别磨叽，简短`
  }
}

function clamp (v, a, b) {
  const n = Number(v)
  return isFinite(n) ? Math.max(a, Math.min(b, n)) : a
}

module.exports = { Persuasion, classify, APPROACH, EFFECT }
