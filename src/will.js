'use strict'
// 意愿层：决定"他现在想干嘛"。不是教学大纲，是他自己心里的事。

const WILL_TEMPLATES = [
  '去挖点圆石做个石镐',
  '去下矿看看能不能找到铁',
  '把身上的东西整理一下，做几个箱子',
  '找个视野好的地方看看周围是什么地形',
  '去砍一批木头存起来',
  '想弄把石剑，打怪用',
  '天黑了，找个地方待着等天亮',
  '挖个洞下去看看有没有矿',
  '弄点煤，晚上要点火把',
  '想盖个带门的小屋',
  '去河边看看能不能钓鱼',
  '看看附近有没有洞穴入口',
  '打点猎，弄点肉烤着吃',
  '去把工作台附近收拾一下',
  '想弄把好点的镐子',
  '想找个地方盖个屋',
  '想去看看前面那片地形',
  '想下矿找点铁',
  '想去挖点石头备着',
  '想把背包收拾一下',
  '想砍点木头',
  '想找个怪物练练手',
  '想沿着河走走看看',
  '想爬个高点看看周围',
  '想找个村子',
  '想弄点吃的',
  '想试试能不能挖到钻石',
  '想盖个小仓库放东西',
  '想看看附近有没有洞穴'
]

class Will {
  constructor (llm, mem, skills, ctx) {
    this.llm = llm
    this.mem = mem
    this.skills = skills
    this.ctx = ctx
    this.current = null      // { text, since, done }
    this.lastThink = 0
    this.recent = []         // 最近做过的事，避免车轱辘话
    this.lastSummary = null
    this.failStreak = {}     // 同类事情失败次数
    this.badPlaceCount = 0   // 这地方没资源的次数
  }

  // 现在想做点什么？优先自己挑，挑不出就用模板
  async think () {
    const now = Date.now()
    if (this.current && !this.current.done) return this.current

    // 死亡太多：先保命，别瞎跑
    if (this.ctx.deaths && this.ctx.deaths() >= 3) {
      this.ctx.deathsReset && this.ctx.deathsReset()
      this.current = { text: '先找个安全的地方待着，别乱跑，把血养回来', since: now, done: false, survival: true }
      this.ctx.log('[will] ' + this.current.text)
      return this.current
    }

    const status = this.ctx.actions.status()

    // 开局阶段：什么工具都没有，先干生存三件套
    const invMap = status.inventory || {}
    const hasTool = Object.keys(invMap).some(k => /_pickaxe$|_axe$|_sword$/.test(k))
    const wood = (invMap.oak_log || 0) + (invMap.birch_log || 0) + (invMap.spruce_log || 0) +
      (invMap.jungle_log || 0) + (invMap.acacia_log || 0) + (invMap.dark_oak_log || 0) +
      (invMap.cherry_log || 0) + (invMap.mangrove_log || 0)
    if (!hasTool && wood === 0) {
      const early = [
        '砍几棵树弄点木头，先做工具',
        '先去弄点木头，做工作台和木镐',
        '找棵树砍了，做把木镐出来'
      ]
      const pick = early.filter(e => !this.recent.includes(e))
      const text = (pick.length ? pick : early)[Math.floor(Math.random() * (pick.length || early.length))]
      this.current = { text, since: now, done: false }
      this.remember(text)
      this.ctx.log('[will] ' + text + '（开局）')
      return this.current
    }
    const inv = Object.entries(status.inventory).map(([k, v]) => `${k}x${v}`).join(' ')
    const catalog = this.skills.catalog(15)

    const prompt = `你现在在自己的世界里，没人管你。你站在 ${status.pos.x},${status.pos.y},${status.pos.z}，${status.time}，血 ${status.health}，饿 ${status.food}。
背包：${inv || '空的'}
你已经会的事：
${catalog}

最近你已经做过这些，别重复：
${this.recent.slice(-8).map((r, i) => (i + 1) + '. ' + r).join('\n') || '（还没干什么）'}
${this.mem.lastSummary() ? '上次下线前在：' + this.mem.lastSummary().text : ''}

你现在想干点什么？挑一件你现在**就能开始动手**的事。要求：
- 一句话，说清楚要做什么，比如"去挖点铁"、"找地方盖个屋子"、"砍点木头"
- 要具体，别说"探索世界"这种空话
- 别挑需要特殊条件的事（比如下界、末地）
- 如果背包里工具太差，先把工具弄好

只回一句话，不要解释。`

    let text = null
    try {
      const r = await this.llm.chat([{ role: 'user', content: prompt }], { maxTokens: 120, temperature: 1.0 })
      text = (r.text || '').split('\n')[0].trim().replace(/^["「『]|["」』]$/g, '')
      if (text.length > 40 || !text) text = null
    } catch (e) {}

    if (!text) text = WILL_TEMPLATES[Math.floor(Math.random() * WILL_TEMPLATES.length)]

    // 这块地方资源太差？去别处看看
    try {
      const sv = this.ctx.actions.survey(36)
      if (sv.trees === 0 && sv.animals < 2 && this.badPlaceCount >= 2) {
        this.badPlaceCount = 0
        const text = '这地方什么都没有，走远点换个地方'
        this.current = { text, since: now, done: false }
        this.remember(text)
        this.ctx.log('[will] ' + text + '（评估：树0 动物' + sv.animals + ' 怪' + sv.hostiles + '）')
        return this.current
      }
      if (sv.trees === 0) this.badPlaceCount = (this.badPlaceCount || 0) + 1
      else this.badPlaceCount = 0
    } catch (e) {}

    // 跟最近的太像就换一个（前 8 个字相同就算像）
    const sig = t => String(t).replace(/[，。！？,.!?\s]/g, '').slice(0, 8)
    const recentSig = this.recent.map(sig)
    if (recentSig.includes(sig(text))) {
      const pool = WILL_TEMPLATES.filter(t => !recentSig.includes(sig(t)))
      if (pool.length) text = pool[Math.floor(Math.random() * pool.length)]
    }

    this.current = { text, since: now, done: false }
    this.lastThink = now
    this.remember(text)
    this.ctx.log('[will] ' + text)
    return this.current
  }

  remember (text) {
    if (!text) return
    this.recent.push(text)
    if (this.recent.length > 12) this.recent.shift()
  }

  finish () {
    this.current = { text: this.current ? this.current.text : '', since: Date.now(), done: true }
  }

  pending () {
    return this.current && !this.current.done ? this.current.text : null
  }
}

module.exports = Will
