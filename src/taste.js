'use strict'
/**
 * 品味 —— 让他自己长出来。
 *
 * 不预设"他喜欢山还是喜欢海"。预设的偏好是别人给的，不是他的。
 *
 * 真人怎么来的品味：
 *   干了一件事 → 感觉不错 / 感觉糟糕 → 下次还想 / 不想
 *   反复几次 → 变成"我就是喜欢这个"
 *   很久没干 → 淡了
 *
 * 所以这里只做三件事：
 *   1. 记下每次经历带的感觉（-1 ~ +1）
 *   2. 同类的经历累积成倾向
 *   3. 时间久了会淡
 *
 * 关键的克制：**不给他任何初始偏好**。
 * 开局他什么都不知道自己喜不喜欢。玩着玩着才有。
 */

const fs = require('fs')
const path = require('path')

// 体验的"类目"。这是维度，不是偏好 ——
// 类目是固定的（否则没法累积），但哪一类会变成他的最爱，是从无数经历里长出来的。
const KINDS = {
  HEIGHT: '高处',       // 山顶、悬崖、树顶
  WATER: '水边',        // 河、海、湖
  UNDERGROUND: '地下',  // 矿洞、洞穴
  COMBAT: '战斗',       // 打怪、打架
  BUILDING: '建造',     // 盖东西
  EXPLORING: '探索',    // 走没走过的地方
  GATHERING: '收集',    // 挖矿、砍树、收集材料
  SOCIAL: '跟人一起',   // 和别人一起玩
  CRAFTING: '做东西',   // 合成、冶炼
  RISK: '冒险',         // 危险的尝试
  IDLE: '发呆',         // 什么都不干
  FARMING: '种养'       // 种地、养动物
}

class Taste {
  constructor (dir) {
    this.file = path.join(dir, 'taste.json')
    this.data = {
      // 每个类目累计的分数和样本数
      kinds: {},
      // 最近的具体经历，用来在提示词里"举例子"
      recent: [],
      // 已经长成的偏好（分数够高的）
      grown: [],
      // 时间戳，用于衰减
      lastDecay: 0
    }
    this.load()
  }

  load () {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.data = Object.assign(this.data, d)
    } catch (e) {}
    for (const k of Object.values(KINDS)) {
      if (!this.data.kinds[k]) this.data.kinds[k] = { sum: 0, n: 0, lastAt: 0 }
    }
  }

  save () {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1), 'utf8')
    } catch (e) {}
  }

  /**
   * 记一次经历。
   * @param {object} o
   * @param {string} o.what       发生了什么（人话）
   * @param {string[]} o.kinds    属于哪几类（可以多类，比如"在山顶盖房子"）
   * @param {number} o.feeling    -1 难受 ~ +1 爽
   * @param {number} now          游戏时间
   */
  record ({ what, kinds, feeling, now }) {
    if (!what) return null
    const f = clamp(feeling, -1, 1)
    const ks = Array.isArray(kinds) ? kinds.filter(k => Object.values(KINDS).includes(k)) : []
    if (!ks.length) return null

    for (const k of ks) {
      const rec = this.data.kinds[k]
      // 存的是"总感觉"，用来算平均
      rec.n += 1
      rec.sum = (rec.sum || 0) + f
      rec.lastAt = now || 0
    }

    this.data.recent.push({ what, kinds: ks, feeling: f, t: now || 0 })
    if (this.data.recent.length > 100) this.data.recent.shift()
    // 第一次记录时把衰减起点也定下来
    if (!this.data.lastDecay) this.data.lastDecay = now || 0

    this.regrow()
    this.save()
    return { what, kinds: ks, feeling: f }
  }

  /**
   * 重新判定哪些长成了偏好。
   *
   * 关键是"置信度"：只经历两三次，哪怕感觉很强，也不该定型。
   * 样本越多，才有资格说自己真的喜欢/不喜欢。
   */
  regrow () {
    const grown = []
    for (const [name, rec] of Object.entries(this.data.kinds)) {
      if (rec.n < 4) continue
      const avg = (rec.sum || 0) / rec.n
      // 置信度：n=4 时 0.44，n=10 时 0.67，n=20 时 0.8
      const confidence = 1 - 1 / (1 + rec.n / 5)
      const strength = Math.abs(avg) * confidence
      if (strength < 0.3) continue
      grown.push({
        kind: name,
        type: avg > 0 ? 'like' : 'dislike',
        strength: Math.min(1, strength),
        n: rec.n
      })
    }
    grown.sort((a, b) => b.strength - a.strength)
    this.data.grown = grown
  }

  /** 时间衰减：很久没碰的事，感觉会淡（真人也是这样） */
  decay (nowMinutes, halfLifeMinutes = 30 * 60) {
    if (!nowMinutes) return 0
    const last = this.data.lastDecay || 0
    if (!last) { this.data.lastDecay = nowMinutes; return 0 }
    const elapsed = nowMinutes - last
    if (elapsed < 30) return 0
    this.data.lastDecay = nowMinutes

    let changed = 0
    const factor = Math.pow(0.5, elapsed / halfLifeMinutes)
    for (const rec of Object.values(this.data.kinds)) {
      if (!rec.n) continue
      const before = rec.sum || 0
      rec.sum = before * factor
      // 经历也会变模糊：样本数慢慢减少，置信度下降
      rec.n = Math.max(1, rec.n * (0.85 + 0.15 * factor))
      if (Math.abs(rec.sum - before) > 0.01) changed++
    }
    if (changed) { this.regrow(); this.save() }
    return changed
  }

  /** 现在长成什么样了 */
  likes () { return this.data.grown.filter(g => g.type === 'like') }
  dislikes () { return this.data.grown.filter(g => g.type === 'dislike') }

  /** 对某一类的好感（-1~1），没经历过就是 0 */
  feel (kind) {
    const rec = this.data.kinds[kind]
    if (!rec || rec.n === 0) return 0
    const avg = (rec.sum || 0) / rec.n
    const confidence = 1 - 1 / (1 + rec.n / 5)
    return clamp(avg * confidence, -1, 1)
  }

  /**
   * 他现在的偏好，写成人话。
   * 还没长出来的时候，明确说"他还没什么偏好"。
   */
  prompt () {
    const likes = this.likes()
    const dislikes = this.dislikes()

    if (!likes.length && !dislikes.length) {
      return `## 你的喜好

你还不太清楚自己喜欢什么。你才刚来，什么都还没试够。
别的玩家问你喜欢什么，你答不上来很正常 —— "不知道啊，还没玩明白"。
但你心里是有点数的：某些事做着舒服，某些事做着烦。只是还没形成明确的说法。`
    }

    const l = likes.slice(0, 4).map(x =>
      `- 你挺喜欢${x.kind}（${Math.round(x.strength * 100)}%）`
    ).join('\n')
    const d = dislikes.slice(0, 3).map(x =>
      `- 你不太喜欢${x.kind}（${Math.round(x.strength * 100)}%）`
    ).join('\n')

    // 去重：同一句话别列三遍
    const seen = new Set()
    const examples = this.data.recent
      .filter(r => Math.abs(r.feeling) > 0.5)
      .reverse()
      .filter(r => {
        const k = r.what.slice(0, 20)
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
      .slice(0, 4)
      .reverse()
      .map(r => `- ${r.what}（${r.feeling > 0 ? '挺爽' : '有点烦'}）`)
      .join('\n')

    return `## 你的喜好

这些是你自己玩出来的，不是别人告诉你的：
${l}
${d}

让你印象深的几次：
${examples || '（还没什么特别的）'}

这些偏好会影响你想干什么。喜欢高处就会想往高处跑，不喜欢地下就不会一直待着挖矿。
但别把"我喜欢X"挂在嘴上 —— 真人不这么说，他们直接去做。`
  }

  /** 用于调试/面板 */
  stats () {
    return {
      grown: this.data.grown,
      samples: Object.fromEntries(
        Object.entries(this.data.kinds)
          .filter(([, v]) => v.n > 0)
          .map(([k, v]) => [k, { n: Math.round(v.n), feel: +this.feel(k).toFixed(2) }])
      )
    }
  }
}

function clamp (v, a, b) {
  const n = Number(v)
  return isFinite(n) ? Math.max(a, Math.min(b, n)) : 0
}

module.exports = { Taste, KINDS }
