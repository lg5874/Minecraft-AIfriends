'use strict'
// 意愿层：决定"他现在想干嘛"。不是教学大纲，是他自己心里的事。
//
// 【2026-11-14 换形态】
// 旧版：if 瀑布决定干什么 —— 有目标就目标，死三次就躲，没工具就砍树，
//       全不中才问模型一句"你想干嘛"。模型只在瀑布的末端，等于脑子是代码、嘴是模型。
// 新版：**模型在环路里**。把完整处境 + 候选（带代价）+ 最近发生的事给它，
//       它输出结构化选择 { action, text, why, urgency }。
//       action 允许不在候选里 —— 它自己造句。
//
// 【分工】模型有选择权，规则有否决权：
//   - 模型选什么，是它的事
//   - 不可行（没镐挖铁、地下砍树、血8还想硬刚）→ 规则退回去，附"为什么不行"
//   - 退回后还不行 → 规则兜底
//
// 【归因】判失败的活不归我判（judge-owner），但"为什么没成"归我总结：
//   attribute() 把现场 + 失败原因给模型，产出一句话归因，写进记忆，
//   并且**只影响下一次的提示词**，不参与任何判定。

// 兜底：模型和规则都没辙时才用。这不是"随机抽一句话"，是"想不出来时先干最基础的"。
const FALLBACK_WILLS = [
  '弄点木头，先做把镐',
  '找地方挖点石头',
  '弄点吃的，别饿着',
  '看看周围有什么'
]

// ==================== 工具函数 ====================

function sig (t) { return String(t || '').replace(/[，。！？,.!?\s]/g, '').slice(0, 8) }

const LOG_WORDS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log']
const PICKAXES = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'golden_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']
const MELEE = ['wooden_sword', 'stone_sword', 'iron_sword', 'golden_sword', 'diamond_sword']

// 一件事"要不要工具/要不要在地表"。规则用它判可行性，不靠猜。
function needs (text, action) {
  const t = String(text || '') + ' ' + String(action || '')
  const n = { pickaxe: false, tree: false, surface: false, risky: false }
  if (/挖铁|铁矿|iron|挖矿|矿洞|下矿|钻石|diamond|挖石头|采石|煤炭|coal/i.test(t)) n.pickaxe = true
  if (/砍树|砍几棵|木头|原木|wood|chop|tree|log/i.test(t)) n.tree = true
  if (/爬出去|回地面|爬回|上去|getup|surface|up\b/i.test(t)) n.surface = true
  if (/硬刚|徒手|打怪|杀个|狩猎|fight|战斗/i.test(t)) n.risky = true
  return n
}

/**
 * 候选清单：由**真实状态**生成，每条带代价说明。
 * 候选不是许可清单 —— 模型可以想别的（action 自由）。
 */
function candidates (s) {
  const out = []
  const add = (action, text, cost) => out.push({ action, text, cost })

  if (s.underground === true) {
    add('getup', '先挖上去、爬回地面', '安全，但可能又被困在半路')
    if (s.hasPickaxe) add('mine', '就地挖矿，顺手找矿', '有镐能干，但会越挖越深')
    add('idle', '先停一会儿，把血/饱食养回来', '什么都不干，浪费时间')
  } else if (s.underground === null) {
    add('explore', '往看得清的方向走一步，先弄清自己在哪', '可能走反')
    if (s.hasPickaxe) add('mine', '往下挖', '看不清就往下挖有点冒险')
    add('idle', '先站着看清楚再说', '不动，但也不会更糟')
  } else {
    if (s.wood < 4 && s.treesNear) add('chop', '砍几棵树弄木头', '树在附近，但可能被怪盯上')
    if (s.wood > 0 && !s.hasTool) add('craft', '用现有木头做工作台和木镐', '需要先放工作台，可能占地方')
    if (s.hasPickaxe) add('mine', '挖点石头/矿', '要下坡找石头')
    if (!s.treesNear) add('explore', '往远处走，找树或者换个地方', '可能再迷路，也可能走空')
    if (s.hostiles > 0) add('fight', '先把附近的怪清掉', '有风险，血不够会死')
    add('shout', '跟附近的人说句话，看看有没有人', '没人回就是自言自语')
    add('idle', '先歇会儿，什么都不干', '不推进，但能回血')
  }
  return out.slice(0, 7)
}

class Will {
  constructor (llm, mem, skills, ctx) {
    this.goals = ctx && ctx.goals ? ctx.goals : null
    this.llm = llm
    this.mem = mem
    this.skills = skills
    this.ctx = ctx
    this.current = null      // { text, action, why, urgency, since, done }
    this.lastThink = 0
    this.fallbackIndex = 0   // 兜底意愿的轮换下标（必须初始化，否则 undefined % 4 = NaN）
    this.recent = []         // 最近做过的事，避免车轱辘话
    this.lastSummary = null
    this.failStreak = {}     // 同类事情失败次数
    this.badPlaceCount = 0   // 这地方没资源的次数
    this.lessons = []        // 归因：上次为什么没成（只进提示词，不进判定）
    this.lastGiven = null    // 上一次发出去的活 { text, at, attributed }
    this.vetoStats = { veto: 0, vetoThenOk: 0, fallback: 0 }  // 规则否决的计数，给验收用
  }

  // ==================== 现状 ====================

  /**
   * 把"他现在处在什么情况"读全。
   * 旧版只拼了点坐标和背包；模型不知道"头顶 12 格是石头"这种关键信息。
   */
  scene (status) {
    const a = this.ctx.actions
    const inv = status.inventory || {}
    const count = re => Object.entries(inv).filter(([k]) => re.test(k)).reduce((n, [, v]) => n + (v || 0), 0)
    const s = {
      pos: status.pos,
      y: Math.round(status.pos.y),
      health: status.health,
      food: status.food,
      time: status.time,
      inv,
      kinds: Object.keys(inv).length,
      wood: LOG_WORDS.reduce((n, k) => n + (inv[k] || 0), 0),
      hasPickaxe: PICKAXES.some(k => inv[k] > 0),
      hasTool: Object.keys(inv).some(k => /_pickaxe$|_axe$|_sword$/.test(k)),
      hasSword: MELEE.some(k => inv[k] > 0),
      stones: count(/^(cobblestone|stone|andesite|diorite|granite)$/),
      underground: null,
      headroom: 0,
      treesNear: false,
      stoneNear: false,
      hostiles: 0,
      survey: null
    }
    try { s.underground = a.isUnderground() } catch (e) {}
    try {
      if (s.underground === true) {
        for (let dy = 2; dy <= 60; dy++) {
          const b = a.bot.blockAt(a.pos().offset(0, dy, 0))
          if (b && b.boundingBox === 'block') { s.headroom = dy; break }
        }
      }
    } catch (e) {}
    try { s.treesNear = LOG_WORDS.some(l => !!a.findBlock(l, 32)) } catch (e) {}
    try { s.stoneNear = !!a.findBlock('stone', 24) } catch (e) {}
    try {
      const sv = a.survey(36)
      s.survey = sv
      s.hostiles = sv.hostiles || 0
      if (typeof sv.trees === 'number') s.treesNear = sv.trees > 0
    } catch (e) {
      try {
        const sc = a.scan(16)
        s.hostiles = (sc.entities || []).filter(e => /zombie|skeleton|creeper|spider|enderman|witch/i.test(e.name || e.type || '')).length
      } catch (e2) {}
    }
    return s
  }

  /** 处境 → 中文（给模型看的那一段） */
  describe (s) {
    const bits = []
    bits.push(`血 ${s.health}，饿 ${s.food}`)
    if (s.underground === true) {
      bits.push(`在**地下** y=${s.y}` + (s.headroom ? `，头顶约 ${s.headroom} 格是石头/地面` : ''))
    } else if (s.underground === false) {
      bits.push(`在地表附近 y=${s.y}`)
    } else {
      bits.push(`在 y=${s.y}，看不清是在洞里还是露天`)
    }
    bits.push(`坐标 ${s.pos.x},${s.pos.y},${s.pos.z}，${s.time}`)
    const tool = s.hasPickaxe ? '有镐' : (s.hasTool ? '有工具但没镐' : '没镐没工具')
    bits.push(tool)
    bits.push(`背包 ${s.kinds} 种` + (s.wood ? `，木头 ${s.wood}` : '，没木头') + (s.stones ? `，石头 ${s.stones}` : ''))
    bits.push(s.treesNear ? '附近有树' : '附近没树')
    if (s.stoneNear) bits.push('附近有石头')
    if (s.hostiles > 0) bits.push(`附近有 ${s.hostiles} 只怪`)
    if (s.survey && s.survey.trees === 0 && s.survey.animals < 2) bits.push('这片地方很空（没树、没什么动物）')
    return bits.join('；')
  }

  /** 最近发生过什么：不是"我做过这些"，是"刚才出了什么事" */
  recentStory (n = 3) {
    const rows = []
    // 归因优先 —— "为什么没成"比"做了什么"有用
    for (const l of this.lessons.slice(-2)) rows.push('上次没成：' + l)
    for (const r of this.recent.slice(-n)) rows.push('刚做过：' + r)
    return rows.length ? rows.join('\n') : '（刚来，还没干什么）'
  }

  // ==================== 问模型 ====================

  buildPrompt (s, cands, veto) {
    const list = cands.map(c => `- ${c.action} ${c.text}（${c.cost}）`).join('\n')
    const goalLine = this.goalLine()
    return `【你现在的处境】${this.describe(s)}
${goalLine ? goalLine + '\n' : ''}【刚才】
${this.recentStory()}

【可选】（括号里是代价，别念出来）
${list}

【选一个，一句话说为什么。都不合适就说"算了，先歇会儿"】

用 JSON 回答，不要别的：
{"action": "上面某个 action 或者你自己起一个", "text": "你打算干什么，一句话，简体中文，20 字内，能直接照着动手", "why": "为什么选这个，一句话，别念给玩家听", "urgency": 0.6}

要求：
- text 是你要**实际去做**的那句话，会直接交给执行层，所以要具体（"先挖上去回到地面"，不是"探索世界"）
- action 用英文小写单词，选上面已有的最省事；想不出贴切的就自己造一个
- why 是给你自己看的说明，不播给玩家
- urgency 0~1：多急。血少、有怪、没吃的就高；闲着就低

${veto ? `【上一次你选的「${veto.action}」被打回】原因：${veto.why}\n换一个真能做的，别再选一样的。\n` : ''}`
  }

  goalLine () {
    try {
      const g = this.goals && this.goals.current()
      if (g && !g.done && g.fromGoal) {
        const stage = (typeof g.stageIndex === 'number' && g.total) ? `，第 ${g.stageIndex + 1}/${g.total} 步` : ''
        return `【长期目标】${g.goal || ''}${stage}：${g.text}`
      }
    } catch (e) {}
    return ''
  }

  /** 一次"问模型要决定"。JSON 解析失败重试一次，再失败返回 null。 */
  async ask (s, cands, veto) {
    const prompt = this.buildPrompt(s, cands, veto)
    for (let attempt = 0; attempt < 2; attempt++) {
      let r
      try {
        r = await this.llm.json([{ role: 'user', content: prompt }], { maxTokens: 800, temperature: attempt ? 0.5 : 0.9 })
      } catch (e) {
        continue
      }
      const d = this.normalize(r)
      if (d) return d
    }
    return null
  }

  /** 模型回来的东西可能缺字段、可能把 text 写成整段、可能 action 是中文 */
  normalize (r) {
    if (!r || typeof r !== 'object') return null
    let text = String(r.text || r.action || '').trim()
    text = text.split('\n')[0].trim().replace(/^["「『“]|["」』”]$/g, '')
    if (!text) return null
    const action = String(r.action || '').trim().toLowerCase().replace(/[^a-z_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'free'
    let urgency = Number(r.urgency)
    if (!isFinite(urgency)) urgency = 0.4
    return {
      action,
      text: text.slice(0, 40),
      why: String(r.why || '').slice(0, 80),
      urgency: Math.max(0, Math.min(1, urgency)),
      raw: r
    }
  }

  // ==================== 规则否决 ====================
  //
  // 只判**可行性**（这是个物理事实问题），不判"好不好"。
  // 判"好不好"是 judge 的事；判"成没成"是硬判据的事。
  check (d, s) {
    if (!d || !d.text) return { why: '你没说要干什么', action: d ? d.action : '?' }
    if (d.text.length < 2) return { why: '太短，执行层不知道该干什么', action: d.action }

    const n = needs(d.text, d.action)

    // 死太多 / 血见底：只准保命
    const deaths = (() => { try { return this.ctx.deaths ? this.ctx.deaths() : 0 } catch (e) { return 0 } })()
    const surviveOnly = deaths >= 3 || s.health <= 8
    if (surviveOnly && (n.pickaxe || n.risky || /explore|mine|fight/.test(d.action))) {
      return {
        action: d.action,
        why: deaths >= 3
          ? `你已经连着死了 ${deaths} 次、血 ${s.health}，现在不能再下矿/硬刚。先保命。`
          : `血只有 ${s.health}，下矿或打怪大概率再死一次。先保命。`
      }
    }

    // 地下砍树 —— 树在地表
    if (s.underground === true && (n.tree || /chop|wood|tree/.test(d.action))) {
      return { action: d.action, why: `你现在在 y=${s.y} 的地下，地下没有树。想弄木头得先回到地面。` }
    }

    // 没镐挖矿 —— 挖不动，白跑一趟
    if (n.pickaxe && !s.hasPickaxe) {
      return { action: d.action, why: `你背包里没有镐（只有 ${s.hasTool ? '别的工具' : '空手'}），挖铁/挖石头只会白费时间。先弄木头做镐。` }
    }

    // 这块地已经证明是空的，还待着不动
    if (this.badPlaceCount >= 2 && s.survey && s.survey.trees === 0 && s.survey.animals < 2 &&
        !/explore|away|move|shout|idle|rest|吃|eat/i.test(d.action + ' ' + d.text) && !/走|换|远处|离开|吃/.test(d.text)) {
      return { action: d.action, why: '这地方已经确认没树没动物，待在这儿什么也做不成。换个地方或者先吃点东西。' }
    }

    // 跟刚做过的太像
    if (this.recent.map(sig).includes(sig(d.text))) {
      return { action: d.action, why: `「${d.text}」你刚做过，再干一遍没用。` }
    }
    return null
  }

  /** 规则兜底：两次都不行时的最后一招。按现状挑一件基础的事。 */
  ruleFallback (s) {
    if (s.health <= 8 || s.food <= 6) return { action: 'idle', text: '先歇着，把血和饿养回来', why: '规则兜底：状态太差', urgency: 0.9 }
    if (s.underground === true) return { action: 'getup', text: '先挖上去，回到地面', why: '规则兜底：在地下', urgency: 0.6 }
    if (!s.hasTool && s.wood < 4) return { action: 'chop', text: '砍几棵树弄点木头，先做工具', why: '规则兜底：没工具', urgency: 0.5 }
    if (this.badPlaceCount >= 2) return { action: 'explore', text: '这地方什么都没有，走远点换个地方', why: '规则兜底：地方太穷', urgency: 0.5 }
    const idx = (this.fallbackIndex || 0) % FALLBACK_WILLS.length
    this.fallbackIndex = idx + 1
    return { action: 'fallback', text: FALLBACK_WILLS[idx], why: '规则兜底：轮换', urgency: 0.3 }
  }

  // ==================== 主入口 ====================

  async think () {
    const now = Date.now()
    if (this.current && !this.current.done) return this.current

    // 上一件活干完了 -> 先归因（"为什么没成"），只影响下面这段提示词
    if (this.lastGiven && !this.lastGiven.attributed) {
      this.lastGiven.attributed = true
      try { await this.attribute({ task: this.lastGiven.text, mark: this.lastGiven.mark }) } catch (e) {}
    }

    // ===== 有长期目标就优先做它 =====
    // 真人不会每天从零想"我今天干嘛"，而是接着昨天没做完的事。
    // 注意：目标本身是 goals 那边用模型排出来的阶段，不是我这里 if 出来的。
    try {
      const g = this.goals && this.goals.current()
      if (g && !g.done) {
        this.current = g
        this.lastThink = now
        this.ctx.log('[will] ' + g.text + (g.fromGoal ? `（大目标：${g.goal}，第${g.stageIndex + 1}/${g.total}步）` : ''))
        return this.current
      }
    } catch (e) {
      this.ctx.log('[will] 长期目标读取失败: ' + e.message)
    }

    const status = this.ctx.actions.status()
    const s = this.scene(status)
    const cands = candidates(s)

    // ---- 模型先选 ----
    let d = await this.ask(s, cands, null)
    let veto = d ? this.check(d, s) : { why: '模型没给出决定', action: '?' }
    let source = 'model'

    if (veto) {
      // 有选择权，但规则是否决权：把它自己的决定连"为什么不行"一起退回去
      this.ctx.log(`[will] ✗ 规则否决「${(d && d.text) || '?'}」/${(d && d.action) || '?'}：${veto.why}`)
      this.vetoStats.veto++
      const d2 = await this.ask(s, cands, veto)
      const veto2 = d2 ? this.check(d2, s) : { why: '重选还是没给出能做的', action: '?' }
      if (!veto2) {
        d = d2
        source = 'model-retry'
        this.vetoStats.vetoThenOk++
        this.ctx.log(`[will] ↻ 重选通过：${d.action} / ${d.text}`)
      } else {
        this.ctx.log(`[will] ✗ 重选仍不可行（${veto2.why}），规则兜底`)
        this.vetoStats.fallback++
        const f = this.ruleFallback(s)
        d = { action: f.action, text: f.text, why: f.why, urgency: f.urgency }
        source = 'rule'
        // 兜底顺手把死亡计数清掉，别卡在这儿反复兜底
        if (/死亡|保命|养回来/.test(f.why)) {
          try { this.ctx.deathsReset && this.ctx.deathsReset() } catch (e) {}
        }
      }
    }

    if (!d || !d.text) {
      const f = this.ruleFallback(s)
      d = { action: f.action, text: f.text, why: f.why, urgency: f.urgency }
      source = 'rule'
    }

    // 这块地方资源太差：计一笔，下次 check() 会因此否决"待着不动"
    try {
      const sv = s.survey
      if (sv && sv.trees === 0) this.badPlaceCount = (this.badPlaceCount || 0) + 1
      else if (sv) this.badPlaceCount = 0
    } catch (e) {}

    this.current = {
      text: d.text,
      action: d.action,
      why: d.why,
      urgency: d.urgency,
      source,
      since: now,
      done: false,
      survival: /保命|养回来|歇/.test(d.why || '') || d.action === 'idle'
    }
    this.lastThink = now
    this.lastGiven = { text: d.text, at: now, attributed: false, mark: (this.mem && this.mem.entries ? this.mem.entries.length : 0) }
    this.remember(d.text)

    const urg = typeof d.urgency === 'number' ? d.urgency.toFixed(2) : '?'
    this.ctx.log(`[will] ${d.action}｜${d.text}｜urgency=${urg}｜来源=${source}` + (d.why ? `｜因为它想：${d.why}` : ''))
    return this.current
  }

  // ==================== 归因 ====================
  //
  // 【边界】归因**不参与判定**。成不成是硬判据/judge 的事。
  // 这里只回答一个模型能回答的问题：「为什么没成？」
  // 产出写进记忆 + this.lessons（只喂下一次的提示词）。
  //
  // 触发方式：
  //   1. think() 自动：上一件活干完后，去记忆里找结果（main.js 失败会写「教训：X 没成（原因）」）
  //   2. 外部显式：will.attribute({ task, ok, why })

  detectOutcome (task, mark) {
    if (!task || !this.mem) return null
    const es = Array.isArray(this.mem.entries) ? this.mem.entries : []
    // 只看"我把这件活交出去之后"新写的记忆 ——
    // 否则同一句话做过两遍时，会把上一遍的失败当成这一遍的结果，归因到错误的原因上。
    const from = typeof mark === 'number' ? Math.max(0, Math.min(mark, es.length)) : Math.max(0, es.length - 80)
    for (let i = es.length - 1; i >= from; i--) {
      const t = String((es[i] && es[i].text) || '')
      if (!t.includes(task)) continue
      const f = t.match(/^教训：([\s\S]*?) 没成（([\s\S]*?)）$/)
      if (f) return { ok: false, why: f[2] }
      const sIdx = t.indexOf(task + ' -> ')
      if (sIdx >= 0) return { ok: true, why: t.slice(sIdx + task.length + 4) }
    }
    return null
  }

  async attribute (info = {}) {
    const task = info.task || (this.lastGiven && this.lastGiven.text)
    if (!task) return null
    const mark = info.mark != null ? info.mark : (this.lastGiven && this.lastGiven.mark)
    const detected = this.detectOutcome(task, mark)
    const ok = info.ok != null ? info.ok : (detected ? detected.ok : null)
    const why = info.why || (detected ? detected.why : '')
    if (ok === true) return null                 // 成了不用归因
    if (ok === null && !why) return null          // 拿不到结果，别瞎猜

    let s = null
    try { s = this.scene(this.ctx.actions.status()) } catch (e) {}
    const prompt = `你刚才想做这件事：${task}
结果没成。系统给的现场：
${s ? this.describe(s) : '（看不到环境）'}
${why ? '失败时的那句话：' + why : ''}

别复盘整件事，只回答一个问句：**为什么没成？**

用 JSON 回答：
{"cause": "一句话，说清卡在哪（没工具/走不到/天黑了/怪太多/地方是空的…）", "next": "下次遇到同样的情况，你先做什么"}

要求：
- cause 要具体，别写"运气不好""还需要练习"这种废话
- 如果失败原因是网络/超时/模型报错，cause 就写"环境故障"，不要把它当人生教训
- next 是一句能直接照做的动作`

    let r
    try {
      r = await this.llm.json([{ role: 'user', content: prompt }], { maxTokens: 600, temperature: 0.7 })
    } catch (e) {
      return null
    }
    const cause = String((r && r.cause) || '').split('\n')[0].trim().slice(0, 80)
    const next = String((r && r.next) || '').split('\n')[0].trim().slice(0, 80)
    if (!cause) return null

    const line = cause + (next ? `；下次先：${next}` : '')
    this.lessons.push(line)
    if (this.lessons.length > 4) this.lessons.shift()
    this.ctx.log(`[will] 归因（${task}）：${line}`)

    // 环境故障不当人生教训（同 main.js 的 isEnvFailure 判据）
    const isEnv = /HTTP \d|DOCTYPE|ECONN|timeout|超时|模型调用失败|401|403|429|500|502|503|环境故障/i.test(cause)
    if (!isEnv) {
      // 落盘三处，各有各的用：
      //   1. mem.log —— 复盘时能查，但不会被当成"记忆"念出来（memory 的公开接口就是干这个的）
      //   2. 教训通道 —— memory.writer 只认「教训：X 没成（Y）」这条格式，
      //      能提炼成"缺镐/缺木"这种硬规则才留；提炼不出就只进日志，不污染长期记忆。
      //      别指望它兜住所有归因：lessonFrom 要求原因里出现具体物品 + 明确缺失标记。
      //   3. skills.note —— 同名技能下次被 coder 复用时能看见
      try {
        this.mem.log('归因：' + task + ' 没成，因为' + line, { why: 'will-attribution', ok: false })
      } catch (e) {}
      try {
        this.mem.add({ text: `教训：${task} 没成（${cause}）`, kind: 'event', importance: 0.4 })
      } catch (e) {}
      try {
        if (this.skills && this.skills.data && this.skills.data.skills) {
          for (const sk of this.skills.data.skills) {
            if (sk.desc && sig(sk.desc) === sig(task) && !sk.note) {
              sk.note = line
              break
            }
          }
        }
      } catch (e) {}
    }
    return { cause, next, isEnv }
  }

  // ==================== 生命周期 ====================

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
module.exports.candidates = candidates
module.exports.needs = needs
