'use strict'
/**
 * 心情。
 *
 * "看心情"不是随机。心情有来源、有持续时间、会影响判断。
 *
 * 真人：刚被怪追着砍完，你让他去挖矿，他大概率不想。
 *       刚盖完一个自己满意的房子，你叫他去哪都行。
 *
 * 所以这里做的是：
 *   几个状态量（精力/兴致/烦躁/满足）→ 合成一个"现在的状态"
 *   → 影响他愿不愿意迁就别人
 */

const clamp = (v, a, b) => {
  const n = Number(v)
  return isFinite(n) ? Math.max(a, Math.min(b, n)) : a
}

class Mood {
  constructor (dir) {
    this.file = require('path').join(dir, 'mood.json')
    // 0~1，初始中间偏上
    this.energy = 0.7      // 精力：干活会掉，休息会涨
    this.spirit = 0.6      // 兴致：做成事会涨，失败/无聊会掉
    this.irritation = 0.1  // 烦躁：被打、被抢、连续失败会涨
    this.satisfaction = 0.5 // 满足感：完成自己想干的事会涨
    this.lastTick = 0
    this.recentMoods = []
    this.load()
  }

  load () {
    try {
      const d = JSON.parse(require('fs').readFileSync(this.file, 'utf8'))
      Object.assign(this, {
        energy: d.energy ?? this.energy,
        spirit: d.spirit ?? this.spirit,
        irritation: d.irritation ?? this.irritation,
        satisfaction: d.satisfaction ?? this.satisfaction,
        lastTick: d.lastTick || 0
      })
    } catch (e) {}
  }

  save () {
    try {
      require('fs').mkdirSync(require('path').dirname(this.file), { recursive: true })
      require('fs').writeFileSync(this.file, JSON.stringify({
        energy: this.energy,
        spirit: this.spirit,
        irritation: this.irritation,
        satisfaction: this.satisfaction,
        lastTick: this.lastTick
      }), 'utf8')
    } catch (e) {}
  }

  /**
   * 每游戏分钟推进一次自然变化。
   * 精力慢慢掉，烦躁慢慢消，兴致慢慢回落。
   */
  tick (minutes = 1) {
    const m = minutes / 1
    this.energy = clamp(this.energy - 0.004 * m, 0, 1)
    this.irritation = clamp(this.irritation - 0.006 * m, 0, 1)
    this.spirit = clamp(this.spirit - 0.002 * m, 0, 1)
    // 满足感慢慢回落
    this.satisfaction = clamp(this.satisfaction - 0.003 * m, 0, 1)
    this.save()
  }

  /** 事件影响 */
  onEvent (kind, amount = 1) {
    switch (kind) {
      case 'task_done':        // 做成一件事
        this.spirit = clamp(this.spirit + 0.08 * amount, 0, 1)
        this.energy = clamp(this.energy - 0.03 * amount, 0, 1)
        this.satisfaction = clamp(this.satisfaction + 0.05 * amount, 0, 1)
        break
      case 'task_fail':        // 失败
        this.spirit = clamp(this.spirit - 0.06 * amount, 0, 1)
        this.irritation = clamp(this.irritation + 0.05 * amount, 0, 1)
        break
      case 'hurt':             // 挨打
        this.irritation = clamp(this.irritation + 0.12 * amount, 0, 1)
        this.spirit = clamp(this.spirit - 0.05 * amount, 0, 1)
        break
      case 'death':            // 死了
        this.spirit = clamp(this.spirit - 0.12 * amount, 0, 1)
        this.irritation = clamp(this.irritation + 0.08 * amount, 0, 1)
        break
      case 'rest':             // 休息
        this.energy = clamp(this.energy + 0.25 * amount, 0, 1)
        break
      case 'food':             // 吃了东西
        this.energy = clamp(this.energy + 0.06 * amount, 0, 1)
        break
      case 'social':           // 跟人一起玩
        this.spirit = clamp(this.spirit + 0.06 * amount, 0, 1)
        break
      case 'bored':            // 闲久了
        this.spirit = clamp(this.spirit - 0.03 * amount, 0, 1)
        break
      case 'gift':             // 收到东西
        this.spirit = clamp(this.spirit + 0.1 * amount, 0, 1)
        this.satisfaction = clamp(this.satisfaction + 0.08 * amount, 0, 1)
        break
    }
    this.save()
  }

  /** 合成一个"现在什么状态" */
  state () {
    const good = this.energy * 0.3 + this.spirit * 0.4 + this.satisfaction * 0.3
    const bad = this.irritation

    if (bad > 0.6) return 'irritated'      // 烦
    if (this.energy < 0.25) return 'tired' // 累
    if (this.spirit < 0.3) return 'down'   // 提不起劲
    if (good > 0.72) return 'good'         // 状态好
    if (this.spirit > 0.75) return 'excited' // 兴头上
    return 'normal'
  }

  /** 人话版本：随具体数值变化，不是固定几句 */
  describe () {
    const s = this.state()
    const bits = []

    switch (s) {
      case 'irritated':
        bits.push(this.irritation > 0.8 ? '你现在很烦，谁跟你说话都想呛回去。' : '你现在有点烦，不想被人指使。')
        break
      case 'tired':
        bits.push(this.energy < 0.12 ? '你困得不行了，随时能睡过去。' : '你现在挺累的，想歇一会儿。')
        break
      case 'down':
        bits.push(this.spirit < 0.15 ? '你现在什么都不想干，感觉这游戏都没意思了。' : '你现在提不起劲，干什么都觉得没意思。')
        break
      case 'good':
        bits.push(this.satisfaction > 0.8 ? '你现在心情特别好，干什么都带劲。' : '你现在状态不错，心情挺好。')
        break
      case 'excited':
        bits.push('你现在正在兴头上，很想接着干。')
        break
      default:
        bits.push('你现在心情一般，谈不上好也谈不上坏。')
    }

    // 副状态也要说
    if (s !== 'tired' && this.energy < 0.4) bits.push('有点累了。')
    if (s !== 'irritated' && this.irritation > 0.35) bits.push('心里有点堵。')
    if (s !== 'excited' && this.spirit > 0.7) bits.push('挺有兴致的。')
    if (s !== 'good' && this.satisfaction > 0.75) bits.push('刚干成点事，还挺舒坦。')

    return bits.join('')
  }

  /**
   * 迁就别人的意愿 0~1。
   * "看心情"就是这里出来的 —— 不是随机数，是状态推的。
   */
  willingness () {
    const s = this.state()
    let base = 0.5
    switch (s) {
      case 'irritated': base = 0.15; break
      case 'tired': base = 0.25; break
      case 'down': base = 0.3; break
      case 'good': base = 0.75; break
      case 'excited': base = 0.55; break   // 兴头上反而不想被打断
      default: base = 0.5
    }
    // 满足感高的人更好说话
    base += this.satisfaction * 0.15
    // 烦躁压一压
    base -= this.irritation * 0.25
    return clamp(base, 0.05, 0.95)
  }

  /**
   * 被要求做某件事时的反应。
   * @param {object} o { who, what, effort, liked, urgent }
   * @returns {{comply:boolean, style:string, reason:string}}
   */
  respondTo ({ who, what, effort = 0.5, liked = 0, urgent = false }) {
    if (urgent) return { comply: true, style: 'urgent', reason: '急事' }

    let w = this.willingness()
    w += liked * 0.3                // 这事正好是他喜欢的
    w -= effort * 0.35              // 越麻烦越不想干
    w = clamp(w, 0.02, 0.95)

    const comply = Math.random() < w

    let style
    if (comply) {
      style = w > 0.7 ? 'yes' : (w > 0.4 ? 'reluctant_yes' : 'grudging_yes')
    } else {
      style = w < 0.2 ? 'flat_no' : 'excuse'
    }

    return {
      comply,
      style,
      reason: `心情=${this.state()} 意愿=${w.toFixed(2)}`
    }
  }

  /** 给提示词用 */
  prompt () {
    return `## 你现在的状态
${this.describe()}
精力 ${Math.round(this.energy * 100)}%，兴致 ${Math.round(this.spirit * 100)}%，烦躁 ${Math.round(this.irritation * 100)}%，满足 ${Math.round(this.satisfaction * 100)}%。

这些会影响你说话和做事的方式，但不用报数字。
累了说话就短一点，烦了就不太想搭理人，兴头上会多话。`
  }
}

module.exports = Mood
