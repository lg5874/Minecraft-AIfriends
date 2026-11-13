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

/**
 * 【2026-11-13 UNHUMAN-SCAN #10 · 行为后果】
 *
 * 上一轮改掉了"永远 irritated"的标签，但只改了标签 ——
 * energy=0 的他照样精神抖擞地挖矿，累这件事没有任何后果。
 *
 * 真人熬到那个份上是撑不住的：会停下来、会坐着、会说"不行了我歇会儿"。
 * 所以这里加一个真正的**休息周期**：
 *   精力掉到 REST_ENTER 以下 → 进入 rested 状态（自动，不等人下令）
 *   歇回 REST_EXIT 以上     → 结束
 * 休息时才回血，不休息时只掉 —— 于是"累"变成一个有始有终的过程，
 * 而不是一条贴在身上的标签。
 */
const REST_ENTER = 0.15   // 低于这个就撑不住了
const REST_EXIT = 0.55    // 歇回这个才算缓过来

// 现实时间：凌晨人会困。这条不靠游戏的昼夜，靠真人自己的钟。
let realtime = null
try { realtime = require('./realtime') } catch (e) {}

/**
 * 当前"活着"的那个 Mood 实例。
 *
 * selfstate 要读"累不累"，但它拿不到 Bot 的 mood 引用（构造顺序在前，
 * 且 main.js 这次不动）。一个进程只起一个 Bot（main.js 里只有一处 new Bot），
 * 所以这里留一个进程内的活动实例给提示词层用。
 */
let ACTIVE = null

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
    this.resting = false
    this._restSince = 0
    this.load()
    ACTIVE = this
  }

  load () {
    try {
      const d = JSON.parse(require('fs').readFileSync(this.file, 'utf8'))
      Object.assign(this, {
        energy: d.energy ?? this.energy,
        spirit: d.spirit ?? this.spirit,
        irritation: d.irritation ?? this.irritation,
        satisfaction: d.satisfaction ?? this.satisfaction,
        lastTick: d.lastTick || 0,
        _angeredAt: d._angeredAt || 0,
        resting: !!d.resting
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
        lastTick: this.lastTick,
        _angeredAt: this._angeredAt || 0,
        resting: !!this.resting
      }), 'utf8')
    } catch (e) {}
  }

  /**
   * 每游戏分钟推进一次自然变化。
   * 精力慢慢掉，烦躁慢慢消，兴致慢慢回落。
   */
  tick (minutes = 1) {
    const m = minutes / 1
    const now = Date.now()

    // 【2026-11-13 UNHUMAN-SCAN #10】
    // 原来是每分钟固定 -0.006，从 0.8 降到 0.6 要 33 分钟 ——
    // 一局才 25 分钟，所以他整局都是同一张脸。
    //
    // 真人的烦躁是"没人惹就消得快，一直被惹才积着"。
    // 所以衰减速率取决于最近有没有被惹 —— 这里用"上次被激怒的时刻"判断。
    const sinceAngered = this._angeredAt ? (now - this._angeredAt) / 60000 : Infinity
    let irritDecay
    if (sinceAngered < 2) {
      // 刚被惹：还没消，慢慢来
      irritDecay = 0.004
    } else if (sinceAngered < 10) {
      // 平静几分钟：开始消
      irritDecay = 0.012
    } else {
      // 好一阵没人惹了：化得快些。人不会记一小时的仇
      irritDecay = 0.025
    }

    // 【UNHUMAN-SCAN #11 · 凌晨该困】
    // 原来的精力只跟游戏里干了多少活有关，跟"现在是几点"无关 ——
    // 04:00 的心跳照样是 good，一句话不提时间。真人这个点坐着都困。
    // 所以凌晨额外掉精力（不用改提示词，生理上就撑不住了）。
    const nightDrain = this._nightDrain()

    // 精力：闲着恢复得慢，但也得能恢复。
    // 原来只掉不涨，energy 一旦见底就永远爬不回来 —— 这不合理，
    // 坐着发呆也是休息。
    //
    // 【#10 行为后果】现在只有真的在休息（resting）才回，
    // 而且回得像个活人：0→0.55 要九分钟，不是一趟任务就满血。
    if (this.resting) {
      this.energy = clamp(this.energy + 0.06 * m, 0, 1)
    } else {
      this.energy = clamp(this.energy - (0.008 + nightDrain) * m, 0, 1)
    }

    this.irritation = clamp(this.irritation - irritDecay * m, 0, 1)
    this.spirit = clamp(this.spirit - 0.002 * m, 0, 1)
    // 满足感慢慢回落
    this.satisfaction = clamp(this.satisfaction - 0.003 * m, 0, 1)

    // 休息周期：累垮了自己停，缓过来了自己起
    this._updateRest()
    this.save()
  }

  /** 现实时间是深夜/凌晨时，精力额外掉得快 */
  _nightDrain () {
    if (!realtime) return 0
    try {
      const t = realtime.realTime()
      if (!t) return 0
      if (t.isVeryLate) return 0.02    // 1~5 点：这个点坐着都困
      if (t.isLate) return 0.006       // 23 点后
      return 0
    } catch (e) {
      return 0
    }
  }

  /**
   * 休息状态机。
   * 进入/退出都会留一条记录，行为层（提示词）据此决定"这轮别接活"。
   */
  _updateRest () {
    if (!this.resting && this.energy <= REST_ENTER) {
      this.resting = true
      this._restSince = Date.now()
      this._restWhy = 'energy'
    } else if (this.resting && this.energy >= REST_EXIT) {
      this.resting = false
      this._restEndedAt = Date.now()
    }
  }

  /** 行为层：他决定歇一会儿 */
  rest (on = true) {
    const next = !!on
    if (next && !this.resting) {
      this.resting = true
      this._restSince = Date.now()
      this._restWhy = 'manual'
    } else if (!next) {
      this.resting = false
      this._restEndedAt = Date.now()
    }
    this.save()
  }

  /** 还在歇吗、歇了多久 */
  restState () {
    const secs = this.resting && this._restSince
      ? Math.round((Date.now() - this._restSince) / 1000)
      : 0
    return { resting: !!this.resting, secs, why: this._restWhy || null }
  }

  /**
   * 给提示词用的"身体感觉"。
   *
   * 只改 state() 的标签是不够的 —— 实测 energy=0 时他照样挖矿。
   * 这里给出**该做什么**：停下来、坐下、别接活、明说累。
   */
  bodyPrompt () {
    const bits = []
    const rs = this.restState()

    if (rs.resting) {
      bits.push(`你现在是真的累垮了（精力 ${Math.round(this.energy * 100)}%），这不是心情问题，是身体撑不住了。`)
      bits.push('这一轮**别接活**：原地坐下（对着地面右键）或者靠墙站着别动，别跑、别挖、别爬。')
      bits.push('有人叫你干活，就直接说撑不住了、要歇会儿 —— 别硬撑着答应，也别假装没事。')
      bits.push('歇到精力回到一半以上再起来干活。')
    } else if (this.energy < 0.35) {
      bits.push(`你有点累了（精力 ${Math.round(this.energy * 100)}%）。干完手头这件就找个地方坐会儿，别接下来又是一堆活。`)
    }

    // 现实时间很晚了：困 + 想下线
    if (realtime) {
      try {
        const t = realtime.realTime()
        if (t && t.isVeryLate) {
          bits.push(`现实里已经 ${t.clock} 了，这个点正常人早睡了 —— 你其实困得慌，心里在盘算"再玩一会儿就下"。`)
        } else if (t && t.isLate) {
          bits.push(`现实里 ${t.clock}，挺晚了，你有点想收摊。`)
        }
      } catch (e) {}
    }
    return bits.join('')
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
        this._angeredAt = Date.now()
        break
      case 'hurt':             // 挨打
        this.irritation = clamp(this.irritation + 0.12 * amount, 0, 1)
        this.spirit = clamp(this.spirit - 0.05 * amount, 0, 1)
        this._angeredAt = Date.now()
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

  /**
   * 合成一个"现在什么状态"。
   *
   * 【2026-11-13 UNHUMAN-SCAN #10】原来的写法是"从上往下第一个命中的就返回"：
   *
   *   if (irritation > 0.6) return 'irritated'
   *   if (energy < 0.25) return 'tired'      // ← 永远走不到
   *
   * 烦躁一旦过 0.6，energy 检查就永远轮不上。实测 36/36 次心跳全是
   * irritated，而 mood.json 里 energy 已经是 0 —— 他"累得不行还在烦"，
   * 只会说"谁跟你说话都想呛回去"，从来不喊累。
   *
   * 现在改成**算紧迫度，取最严重的那一个**：
   *   energy 掉到底   → 累（身体的事最硬，困了就是困了）
   *   irritation 很高 → 烦
   *   兴致低          → 提不起劲
   *   各项都不错      → 状态好 / 兴头上
   *
   * 关键取舍：**精力排在烦躁前面**。
   * 真人的身体感受压得住情绪 —— 熬到凌晨四点，再气也只想睡。
   * 反过来"心里烦但还是精神抖擞"是说得通的，所以烦躁不是更低优先级，
   * 只是同一档里要看谁更极端。
   */
  state () {
    const good = this.energy * 0.3 + this.spirit * 0.4 + this.satisfaction * 0.3

    // 极端的生理状态压过一切：困到快睁不开眼的时候，情绪是次要的
    if (this.energy < 0.12) return 'tired'
    // 已经在歇了：这时候就是累，不是烦（烦躁可能还高，但那不是当前的事）
    if (this.resting && this.energy < REST_EXIT) return 'tired'

    // 其余按"偏离正常有多远"算紧迫度，取最大的
    // 归一化：每个维度都在 0~1，越靠近极端越紧迫
    const urgent = [
      { k: 'tired', v: this.energy < 0.3 ? (0.3 - this.energy) / 0.3 : 0 },
      { k: 'irritated', v: this.irritation > 0.5 ? (this.irritation - 0.5) / 0.5 : 0 },
      { k: 'down', v: this.spirit < 0.35 ? (0.35 - this.spirit) / 0.35 : 0 }
    ].filter(x => x.v > 0).sort((a, b) => b.v - a.v)

    if (urgent.length && urgent[0].v >= 0.2) {
      // 累跟烦咬得很近时，选累 —— 身体比情绪诚实
      if (urgent.length > 1 && urgent[0].k === 'irritated' && urgent[1].k === 'tired' &&
          urgent[1].v >= urgent[0].v - 0.15) {
        return 'tired'
      }
      return urgent[0].k
    }

    if (good > 0.72) return 'good'         // 状态好
    if (this.spirit > 0.75) return 'excited' // 兴头上
    return 'normal'
  }

  /**
   * 累不累。给行为层用 —— energy 低了他该真的停下来歇，
   * 不是嘴上说说然后接着挖。
   */
  exhausted () {
    return this.energy < 0.2
  }

  /** 人话版本：随具体数值变化，不是固定几句 */
  describe () {
    const s = this.state()
    const bits = []

    switch (s) {
      case 'irritated':
        // 【烦躁 ≠ 攻击】2026-11-14
        //
        // 原来 >0.8 写的是「你现在很烦，谁跟你说话都想呛回去」——
        // 那是在**教他攻击**，而不是描述他的状态。
        //
        // 真人烦躁到 0.9 时的表现是**变短、变懒、不耐烦**，不是**攻击**：
        //   烦躁 0.9（没人惹他）： 「嗯」「没什么」「就弄点东西」
        //   被骂（有人挑衅）：     「关你事」「你管得着吗」
        //
        // 这两件被混成了一条线，而明早用户的第一个问题是「你在干啥」——
        // 一个陌生人上来就呛你，用户不会想再试第二次。
        //
        // 原则：**烦躁只压低「愿意说多少」，不改变「对人什么态度」。
        // 攻击性只由「被谁怎么对待」触发（那条在被骂梯度里，本来就有）。**
        // 【下界】2026-11-14
        //
        // 「简短应一句」+ 弱模型 = 「嗯」「哦」「行」。
        // 而 hasRealContent() 只要求"至少有一个汉字"，单字拦不住 ——
        // 这就是 UNHUMAN-SCAN 第 1 条（公屏只有句号）换了一张脸：
        // 从"只有标点"变成"只有单字"，而且会更频繁（他今晚 irritation 0.9，明天话都短）。
        //
        // 所以"话少"必须给下界：一句完整的话、六到十五个字、别只回一个字。
        bits.push(this.irritation > 0.8
          ? '你现在又累又烦，话很少。别人问你什么，就用一句话答完 —— ' +
            '一句完整的话，六到十五个字，别只回「嗯」「哦」「行」。'
          : '你现在有点烦，不想被人指使。')
        break
      case 'tired':
        if (this.resting) bits.push('你累到极限了，现在只想坐下歇着，什么都不想干。')
        else bits.push(this.energy < 0.12 ? '你困得不行了，随时能睡过去。' : '你现在挺累的，想歇一会儿。')
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
module.exports.REST_ENTER = REST_ENTER
module.exports.REST_EXIT = REST_EXIT
module.exports.active = () => ACTIVE
