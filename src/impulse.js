'use strict'
/**
 * 冲动与感受。
 *
 * 两件事：
 *   1. 干完一件事，问自己"刚才爽不爽" —— 这是品味长出来的原料
 *   2. 干活途中偶尔想干别的 —— 这是"自发行为"
 *
 * 关键：**没有随机数决定他喜欢什么**。
 * 是他自己对每次经历的判断，累积起来形成了偏好。
 */

const { KINDS } = require('./taste')

/**
 * 从一次任务的描述里，猜它属于哪几类体验。
 * 这是"维度"，不是偏好 —— 维度固定，好坏由他自己评。
 */
function classify (text) {
  const t = String(text || '')
  const kinds = []
  if (/(山顶|悬崖|高处|爬|顶上|俯瞰|天空)/.test(t)) kinds.push(KINDS.HEIGHT)
  if (/(河|海|湖|水边|游泳|钓鱼|岸边)/.test(t)) kinds.push(KINDS.WATER)
  if (/(矿洞|洞穴|地下|挖矿|矿道|深处)/.test(t)) kinds.push(KINDS.UNDERGROUND)
  if (/(打|杀|战斗|怪|僵尸|骷髅|苦力怕|蜘蛛)/.test(t)) kinds.push(KINDS.COMBAT)
  if (/(盖|建|造|房子|屋|墙|搭)/.test(t)) kinds.push(KINDS.BUILDING)
  if (/(探索|走|逛|看看|探|新地方|地形)/.test(t)) kinds.push(KINDS.EXPLORING)
  if (/(挖|采|收集|砍|捡|攒)/.test(t)) kinds.push(KINDS.GATHERING)
  if (/(一起|跟|帮|陪|聊天|队友)/.test(t)) kinds.push(KINDS.SOCIAL)
  if (/(合成|做|熔|烧|镐|剑|工具|工作台)/.test(t)) kinds.push(KINDS.CRAFTING)
  if (/(冒险|危险|试试|挑战|徒手|硬刚)/.test(t)) kinds.push(KINDS.RISK)
  if (/(发呆|站着|坐着|看|歇|什么也不)/.test(t)) kinds.push(KINDS.IDLE)
  if (/(种|养|农|动物|喂|繁殖)/.test(t)) kinds.push(KINDS.FARMING)
  return Array.from(new Set(kinds))
}

/**
 * 让他评价刚才那次经历爽不爽。
 * 这是他自己的判断，不是外部规则。
 *
 * @returns {Promise<{feeling:number, why:string}|null>}
 */
async function judgeFeeling (llm, ctx) {
  const { what, outcome, mood, tasted } = ctx
  const prompt = `你刚做完一件事：${what}
结果：${outcome || '算是做成了'}
你现在的状态：${mood || '一般'}

${tasted && tasted.length
    ? `你本来${tasted.map(x => x.kind + (x.type === 'like' ? '挺喜欢' : '不太喜欢')).join('、')}。`
    : '你还没什么明确的偏好。'}

扪心自问：刚才这事，你爽吗？

用 JSON 回答：
{"feeling": 0.7, "why": "一句话说为什么"}

feeling 从 -1 到 1：
  1  = 太爽了，还想再来
  0.5 = 挺舒服
  0 = 没什么感觉，就那样
  -0.5 = 有点烦
  -1 = 再也不想了

注意：
- 别每次都正数。有些事就是无聊、就是烦，说实话。
- 同样的活干多了会腻。
- 你自己喜欢什么，就照实说。`

  try {
    const r = await llm.json([{ role: 'user', content: prompt }], { maxTokens: 150, temperature: 0.9 })
    const feeling = Number(r.feeling)
    if (!isFinite(feeling)) return null
    return { feeling: Math.max(-1, Math.min(1, feeling)), why: String(r.why || '').slice(0, 80) }
  } catch (e) {
    return null
  }
}

/**
 * 干活途中，突然想做点别的。
 *
 * 不是随机 —— 概率由几件事推：
 *   - 干得越久越容易分心
 *   - 正在做的事跟他偏好冲突时更容易
 *   - 环境里有他喜欢的东西时更容易
 */
class Impulse {
  constructor (ctx) {
    this.ctx = ctx
    this.taskStartAt = 0
    this.lastCheckAt = 0
    this.checkIntervalMs = 45000   // 每 45 秒问一次"还想继续吗"
    this.pending = null            // 攒着的冲动
  }

  taskStarted () {
    this.taskStartAt = Date.now()
    this.lastCheckAt = 0
    this.pending = null
  }

  /**
   * 主循环调用。
   * @returns {Promise<string|null>}  想干别的事的话，返回那个念头
   */
  async maybe (taste, mood, currentTask) {
    if (!this.taskStartAt) return null
    const now = Date.now()
    if (now - this.lastCheckAt < this.checkIntervalMs) return null
    this.lastCheckAt = now

    const elapsed = now - this.taskStartAt

    // 基础概率：干得越久越容易分心
    let p = 0.08
    if (elapsed > 120000) p += 0.1
    if (elapsed > 300000) p += 0.15

    // 当前这件事他不喜欢
    const kinds = classify(currentTask || '')
    let likeScore = 0
    for (const k of kinds) likeScore += taste.feel(k)
    if (kinds.length) likeScore /= kinds.length
    if (likeScore < -0.2) p += 0.2   // 不喜欢的事容易走神
    if (likeScore > 0.4) p -= 0.1    // 喜欢的事更专注

    // 兴致低的时候容易走神
    if (mood.spirit < 0.35) p += 0.12
    // 精力低也容易
    if (mood.energy < 0.3) p += 0.1

    if (Math.random() > p) return null

    // 真要走神了：问他自己想干嘛
    return this.askWhatElse(currentTask, taste, mood)
  }

  async askWhatElse (currentTask, taste, mood) {
    const llm = this.ctx.llm
    const status = this.ctx.actions ? this.ctx.actions.status() : null
    const scan = this.ctx.actions ? this.ctx.actions.scan(14) : { blocks: {}, entities: [] }
    const nearby = Object.entries(scan.blocks || {}).slice(0, 8)
      .map(([k, v]) => k + '(' + v + ')').join(' ')

    const likes = taste.likes().slice(0, 3).map(x => x.kind).join('、')
    const prompt = `你正在${currentTask}，干了一会儿了。

现在的处境：
位置 ${status ? `${status.pos.x},${status.pos.y},${status.pos.z}` : '?'}，${status ? status.time : ''}
周围看到：${nearby || '没什么'}
${mood.describe()}
${likes ? '你发现自己挺喜欢' + likes + '。' : '你还不太清楚自己喜欢什么。'}

你突然有点想干别的。想干嘛？

要求：
- 一句话，具体，能马上动手
- 不需要有什么正当理由，"想上去看看"、"这块石头颜色挺好看"都行
- 别说什么"继续挖矿"这种废话
- 如果你其实不想走神，就只输出 [继续]`

    try {
      const r = await llm.chat([{ role: 'user', content: prompt }], { maxTokens: 80, temperature: 1.2 })
      const t = (r.text || '').split('\n')[0].trim().replace(/^["「『]|["」』]$/g, '')
      if (!t || t.includes('[继续]') || t.length > 40) return null
      this.ctx.log('[impulse] 想干别的：' + t)
      return t
    } catch (e) {
      return null
    }
  }
}

module.exports = { Impulse, classify, judgeFeeling }
