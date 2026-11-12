'use strict'
/**
 * 长期目标。
 *
 * 问题：之前的意愿是"一件事一件事"的 —— 弄把石镐、挖点石头、看看下面有什么。
 * 每件事干完就结束了，没有一个"我想盖个房子"这种要干好几天的事。
 *
 * 真人是怎么有长期目标的：
 *   心里先有个模糊的念头（"住山洞不像话，我想盖个屋子"）
 *   → 想一想现在能不能办（有镐子吗？有木头吗？）
 *   → 能办就记下来，办不到就先放着
 *   → 把它拆成"今天该干的那一步"（先找块平地）
 *   → 每天干一点，进度记着，下线不丢
 *   → 太久没进展就算了，换个目标（真人也会放弃）
 *
 * 这里做四件事：
 *   1. 候选池 —— 只是"他能想到的方向"，不是任务清单
 *   2. 打分   —— 按他现在的工具和资源算可行性，不现实的不提
 *   3. 拆解   —— 大目标拆成 3~5 个阶段，每个阶段能单独干
 *   4. 存盘   —— data/runtime/goals.json，重启接着干
 *
 * 关键克制：**不写死"必须盖房子"**。
 * 池子只是候选，真正选哪个、怎么措辞、要不要自己发明一个，交给模型。
 * 模型挂了才按可行性分数兜底 —— 那也是他自己算出来的，不是别人规定的。
 */

const fs = require('fs')
const path = require('path')

const VERSION = 1
const FILE = 'goals.json'

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))

// ---------------------------------------------------------------- 工具

const PICK_ORDER = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']

/** 他现在的镐子能到什么级别：-1 没镐子，0 木，1 石，2 铁，3 钻石，4 下界合金 */
function pickTier (inv) {
  inv = inv || {}
  let best = -1
  for (const name of PICK_ORDER) if ((inv[name] || 0) > 0) best = Math.max(best, PICK_ORDER.indexOf(name))
  // 金镐挖不动铁以上的矿，按石镐算
  if ((inv.golden_pickaxe || 0) > 0) best = Math.max(best, 1)
  return best
}

/** 背包里某类东西有多少。支持 #log / #planks / #stone / #food 这种"一类"的写法 */
function itemCount (inv, key) {
  inv = inv || {}
  const sum = (re) => Object.entries(inv).reduce((a, [k, v]) => a + (re.test(k) ? (Number(v) || 0) : 0), 0)
  switch (key) {
    case '#log': return sum(/_log$/)
    case '#planks': return sum(/_planks$/)
    case '#stone': return sum(/^(cobblestone|stone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff)$/)
    // 地表就能挖到的石头（挖 stone 掉 cobblestone）。垫脚、盖墙都用它。
    // 单独列一个键，是因为 #stone 把 andesite/diorite/granite/deepslate/tuff
    // 也算进去了 —— 那些主要生成在地下（y≈50 上下），
    // 在地表攒垫脚料时去挖它们是够不到的。
    // 实测：目标「攒够垫脚的石头」时他一直在找 andesite，
    // 日志里 [goto] 高度到不了（目标 y=57，现在 y=63）连着刷。
    case '#surfacestone': return sum(/^(cobblestone|stone|cobbled_deepslate)$/)
    case '#food': return sum(/^(bread|cooked_|baked_potato|apple|carrot|potato|beef|porkchop|chicken|mutton|rabbit)/)
    default: return Number(inv[key]) || 0
  }
}

const ITEM_CN = {
  '#log': '木头',
  '#planks': '木板',
  '#stone': '石头',
  '#food': '吃的',
  cobblestone: '圆石',
  stone: '石头',
  raw_iron: '粗铁',
  iron_ingot: '铁锭',
  coal: '煤',
  torch: '火把',
  diamond: '钻石',
  wheat: '小麦',
  wheat_seeds: '种子',
  wooden_hoe: '木锄',
  stone_pickaxe: '石镐',
  iron_pickaxe: '铁镐',
  iron_sword: '铁剑',
  iron_helmet: '铁头盔',
  iron_chestplate: '铁胸甲',
  furnace: '熔炉',
  oak_door: '门'
}
const cn = (k) => ITEM_CN[k] || k

/** 背包里的存货 —— 存盘时快照一份，用来算"这一阶段新弄到了多少" */
function snapInv (status) {
  const inv = (status && status.inventory) || {}
  const out = {}
  for (const [k, v] of Object.entries(inv)) out[k] = Number(v) || 0
  return out
}

function posOf (status) {
  const p = (status && status.pos) || {}
  return { x: Number(p.x) || 0, y: Number(p.y) || 0, z: Number(p.z) || 0 }
}

function dist (a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function makeBase (stage, status) {
  const p = posOf(status)
  return { at: Date.now(), inv: snapInv(status), pos: p, y: p.y }
}

// ---------------------------------------------------------------- 候选池

/**
 * 候选池。每一条是"他可能会想到的方向"，不是命令。
 *
 * 每条：
 *   key    内部标识（存盘 / 冷却用，不给人看）
 *   title  默认说法（模型可以改词）
 *   why    他为什么会想到这件事
 *   tag    对应的品味类目（有品味模块就参考，没有就不管）
 *   stages 阶段模板，need 里的数字是"大概要多少"，不是硬指标
 *   score  按当前状态算可行性（0~100），越高越现实
 */
const POOL = [
  {
    key: 'house',
    title: '攒够材料盖个小屋',
    why: '一直住山洞不像话，想要个自己的地方',
    tag: '建造',
    stages: [
      { kind: 'do', title: '找块够平的地方，把地面收拾出来', need: { count: 1 } },
      {
        kind: 'gather',
        title: '备料：石头和木头攒够一堆',
        need: { '#surfacestone': 48, '#log': 16 },
        where: '地上：石头挖裸露的岩面，木头找树'
      },
      { kind: 'do', title: '把四面墙立起来', need: { count: 1 } },
      { kind: 'do', title: '封顶，顺手装个门', need: { count: 1 } }
    ],
    score (status) {
      const inv = status.inventory || {}
      const tier = pickTier(inv)
      let s = 50
      if (tier >= 1) s += 15
      if (tier >= 2) s += 10
      s += Math.min(15, itemCount(inv, '#log') / 16 * 15)
      return s
    }
  },
  {
    key: 'iron',
    title: '攒够一堆铁，做身铁家伙',
    why: '石镐不经用，铁的东西才扛造',
    tag: '收集',
    stages: [
      { kind: 'craft', title: '先弄把石镐，铁矿才挖得动', need: { item: 'stone_pickaxe', n: 1 } },
      { kind: 'gather', title: '带够火把和吃的，下去挖矿', need: { torch: 8, '#food': 4 } },
      { kind: 'gather', title: '挖够铁矿背上来', need: { raw_iron: 40 } },
      { kind: 'gather', title: '烧成铁锭，攒着', need: { iron_ingot: 32 } }
    ],
    score (status) {
      const tier = pickTier(status.inventory || {})
      let s = 40
      if (tier >= 1) s += 25
      if (tier >= 2) s += 15
      return s
    }
  },
  {
    key: 'diamond',
    title: '一直往下挖，挖到钻石为止',
    why: '听说最底下有好东西，想自己看一眼',
    tag: '冒险',
    stages: [
      { kind: 'craft', title: '先弄把铁镐，不然到深层白跑', need: { item: 'iron_pickaxe', n: 1 } },
      { kind: 'depth', title: '往下挖到很深的地方', need: { y: 16 } },
      { kind: 'gather', title: '带够火把，别在下面摸黑', need: { torch: 16 } },
      { kind: 'gather', title: '找到钻石矿，挖下来', need: { diamond: 1 } }
    ],
    score (status) {
      const tier = pickTier(status.inventory || {})
      if (tier >= 2) return 85
      if (tier === 1) return 45
      return 22
    }
  },
  {
    key: 'tower',
    title: '搭个高台，站上去看看这片地方长什么样',
    why: '地上看不远，站高了心里有数',
    tag: '建造',
    stages: [
      {
        kind: 'gather',
        title: '在附近地上捡够垫脚的石头',
        need: { '#surfacestone': 40 },
        where: '地上（脚边、山坡、石头裸露的地方）'
      },
      { kind: 'do', title: '一层层往上码，搭到高处', need: { count: 1 } },
      { kind: 'do', title: '站上去，把四周看一遍', need: { count: 1 } }
    ],
    score (status) {
      const inv = status.inventory || {}
      let s = 42
      if (itemCount(inv, '#surfacestone') >= 40) s += 25
      if (pickTier(inv) >= 0) s += 10
      return s
    }
  },
  {
    key: 'farm',
    title: '开一小块地，种点能吃的东西',
    why: '老靠打猎和摘野果不是长久办法',
    tag: '种养',
    stages: [
      { kind: 'craft', title: '做把锄头', need: { item: 'wooden_hoe', n: 1 } },
      { kind: 'gather', title: '找点种子', need: { wheat_seeds: 6 } },
      { kind: 'do', title: '翻地、下种、围个栅栏', need: { count: 1 } },
      { kind: 'gather', title: '等它长，收一茬麦子', need: { wheat: 8 } }
    ],
    score (status) {
      const inv = status.inventory || {}
      let s = 40
      if (itemCount(inv, '#log') >= 4) s += 12
      if (itemCount(inv, 'wheat_seeds') > 0) s += 10
      return s
    }
  },
  {
    key: 'explore',
    title: '往一个方向走远点，看看那边有什么',
    why: '总在这一小片转，想知道外面是什么样',
    tag: '探索',
    stages: [
      { kind: 'gather', title: '带上吃的和火把再出门', need: { '#food': 4, torch: 6 } },
      { kind: 'travel', title: '朝一个方向走出去，走到没见过的地界', need: { distance: 300 } },
      { kind: 'do', title: '在那边转一圈，记下有什么值得回来的', need: { count: 1 } }
    ],
    score (status) {
      let s = 38
      if ((status.health || 20) >= 16) s += 12
      if (itemCount(status.inventory || {}, '#food') >= 3) s += 10
      return s
    }
  }
]

// ---------------------------------------------------------------- 主类

class Goals {
  /**
   * new Goals(dir, { llm, ctx, cfg, now })
   * 也接受 new Goals({ dir, llm, ... })
   *
   * dir  数据目录（一般是 data/runtime）
   * llm  可选。给了就让他自己选目标 / 自己编一个；没给就按可行性分数兜底
   * ctx  { log, taste, actions }
   * cfg  可调阈值
   * now  可注入的时钟（测试用）
   */
  constructor (dir, opts = {}) {
    if (dir && typeof dir === 'object') { opts = dir; dir = opts.dir }
    this.dir = dir || path.join(process.cwd(), 'data', 'runtime')
    this.file = path.join(this.dir, FILE)
    this.llm = opts.llm || null
    this.ctx = opts.ctx || {}
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now()
    this.cfg = Object.assign({
      stallMs: 45 * 60 * 1000,       // 这么久没有任何进展 -> 放弃
      maxFails: 6,                    // 同一阶段试这么多次都失败 -> 放弃
      maxIdleWins: 5,                 // 连续这么多趟"说成了但进度没动" -> 放弃
      cooldownMs: 2 * 60 * 60 * 1000, // 放弃后这段时间不再选它
      doneCooldownMs: 12 * 60 * 60 * 1000, // 做完了的目标这段时间不重复
      maxCustomStages: 5
    }, opts.cfg || {})

    this.goal = null        // 当前长期目标
    this.history = []       // 干完的 / 放弃的
    this.cooldown = {}      // key -> 到期时间
    this.lastStatus = null  // 最近一次观察到的状态（算进度用）
    this._savedAt = 0
    this.load()
  }

  // ------------------------------------------------ 存盘

  load () {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8') || '{}')
      if (d && d.version === VERSION) {
        this.goal = d.goal || null
        this.history = Array.isArray(d.history) ? d.history : []
        this.cooldown = d.cooldown && typeof d.cooldown === 'object' ? d.cooldown : {}
      }
    } catch (e) {
      this.goal = null
      this.history = []
      this.cooldown = {}
    }
    return this
  }

  save (force) {
    // 主循环里 observe() 调得很勤，没必要每次都写盘
    if (!force && this.now() - (this._savedAt || 0) < 10000) return
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const data = {
        version: VERSION,
        goal: this.goal,
        history: this.history.slice(-30),
        cooldown: this.cooldown,
        savedAt: this.now()
      }
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8')
      fs.renameSync(tmp, this.file)   // 先写临时文件再换名，断电不至于写坏
      this._savedAt = this.now()
    } catch (e) {
      this.log('[goals] 存盘失败 ' + e.message)
    }
  }

  log (s) {
    try {
      if (this.ctx.log) this.ctx.log(s)
    } catch (e) {}
  }

  // ------------------------------------------------ 候选与打分

  /** 现在能想到哪些方向，各自多现实 */
  candidates (status) {
    const now = this.now()
    const out = []
    for (const g of POOL) {
      const until = this.cooldown[g.key] || 0
      if (until > now) continue
      let score = 0
      try { score = g.score(status) } catch (e) { score = 30 }
      score += this.tasteBonus(g.tag)
      out.push({
        key: g.key,
        title: g.title,
        why: g.why,
        score: Math.round(score),
        stages: g.stages.length
      })
    }
    out.sort((a, b) => b.score - a.score)
    return out
  }

  /** 他喜欢干这类事就更想干（没有品味模块就不加分） */
  tasteBonus (tag) {
    try {
      const t = this.ctx && this.ctx.taste
      const k = t && t.data && t.data.kinds && t.data.kinds[tag]
      if (!k || !k.n) return 0
      const avg = k.sum / k.n   // -1 ~ 1
      return Math.round(avg * 12)
    } catch (e) { return 0 }
  }

  // ------------------------------------------------ 立目标

  /**
   * 保证心里有个目标。没有就现在想一个。
   * 主程序开一轮之前 await 一次；之后 current() 就是同步的。
   */
  async ensure (status) {
    if (status) this.lastStatus = status

    // 手上已经有个没做完的，接着干
    if (this.goal && !this.goal.done) return this.goal

    // 上一个目标已经收尾了（完成时已清空，这里兜底）
    if (this.goal && this.goal.done) this.goal = null

    const cands = this.candidates(status || this.lastStatus || {})
    if (!cands.length) {
      // 全在冷却里：把冷却清掉，总得有事干
      this.cooldown = {}
      return this.ensure(status)
    }

    let picked = null
    try {
      picked = await this.askModel(status || this.lastStatus || {}, cands)
    } catch (e) {
      this.log('[goals] 让他自己想的时候出错：' + e.message)
    }

    // 模型没给 / 给了个不认识的：按可行性挑最现实的那个
    if (!picked) {
      const top = cands[0]
      const def = POOL.find(g => g.key === top.key)
      picked = {
        key: def.key,
        title: def.title,
        why: def.why,
        stages: def.stages.map(s => Object.assign({}, s))
      }
      this.log('[goals] 自己定了个方向：' + picked.title + '（可行性 ' + top.score + '）')
    }

    this.goal = this.makeGoal(picked, status || this.lastStatus || {})
    this.save(true)
    this.log('[goals] 立了个长期目标：' + this.goal.title)
    return this.goal
  }

  /**
   * 问他：这几个方向里你想干哪个？也可以自己另想一个。
   * 只要 JSON，不要长篇大论。
   */
  async askModel (status, cands) {
    if (!this.llm || !this.llm.chat) return null

    const inv = Object.entries(status.inventory || {}).map(([k, v]) => cn(k) + 'x' + v).join('，') || '空的'
    const list = cands.map((c, i) => `${i + 1}. ${c.title} —— ${c.why}（现在办起来的把握：${c.score}/100）`).join('\n')
    const did = this.history.slice(-4).map(h => `- ${h.title}（${h.result === 'done' ? '干完了' : '放弃了：' + (h.reason || '')}）`).join('\n')

    const prompt = `你在自己的世界里过日子，没人给你派活。

现在的状况：
坐标 ${posOf(status).x},${posOf(status).y},${posOf(status).z}，血 ${status.health}，饿 ${status.food}，${status.time || ''}
背包：${inv}
${did ? '这些是你之前干过的：\n' + did : '你还没正经干完过什么。'}

你心里冒出过这些念头（不一定都对，也不一定都要干）：
${list}

挑一件你**真想干、而且眼下干得动**的事，当接下来这些天的正事。
可以就从上面挑一个，也可以自己另想一件 —— 只要符合你现在的本事和手里的东西。

回一个 JSON，别写别的：
{"key":"上面某个编号对应的英文 key，或者 custom","title":"一句话说清你想干什么，像人话，别超过 20 个字","why":"为什么想干这件事，一句话"}
如果 key 是 custom，再加一个 stages 数组，3 到 5 条，每条一句话，说清先干什么后干什么：
"stages":["先……","然后……","最后……"]`

    const r = await this.llm.chat([{ role: 'user', content: prompt }], { maxTokens: 320, temperature: 1.0 })
    const obj = parseJson(r && r.text)
    if (!obj || !obj.title) return null

    const title = String(obj.title).trim().replace(/^["「『]|["」』]$/g, '').slice(0, 40)
    if (!title) return null
    const why = String(obj.why || '').trim().slice(0, 60)

    // 从池子里挑的：阶段用模板（模板里的阶段是打磨过的）
    const def = POOL.find(g => g.key === obj.key)
    if (def) {
      // 刚放弃 / 刚做完的方向，模型又想起来了也不行 —— 免得反复绕回同一条死路
      if ((this.cooldown[def.key] || 0) > this.now()) return null
      return { key: def.key, title, why: why || def.why, stages: def.stages.map(s => Object.assign({}, s)) }
    }

    // 自己发明的：把他说的话变成能验收的阶段
    const raw = Array.isArray(obj.stages) ? obj.stages : []
    const stages = raw
      .map(s => (typeof s === 'string' ? { title: s } : s))
      .filter(s => s && s.title)
      .slice(0, this.cfg.maxCustomStages)
      .map(s => normalizeStage(s))
    if (!stages.length) return null

    return { key: 'custom:' + title, title, why: why || '自己想出来的事', stages }
  }

  makeGoal (picked, status) {
    const now = this.now()
    const stages = picked.stages.map(s => {
      const stage = Object.assign({ key: s.key || null, kind: s.kind || 'do', need: s.need || { count: 1 }, title: s.title }, {})
      stage.startedAt = now
      stage.base = makeBase(stage, status)
      stage.work = 0
      stage.ratio = 0
      stage.best = 0
      stage.attempts = 0
      stage.fails = 0
      stage.doneAt = null
      return stage
    })
    return {
      key: picked.key,
      title: picked.title,
      why: picked.why || '',
      createdAt: now,
      updatedAt: now,
      stageIndex: 0,
      stages,
      attempts: 0,
      fails: 0,
      lastProgressAt: now,
      journal: [{ at: now, text: '定了这件事：' + picked.title }],
      done: false
    }
  }

  // ------------------------------------------------ 现在该干什么

  stage () {
    if (!this.goal) return null
    return this.goal.stages[this.goal.stageIndex] || null
  }

  /**
   * 现在该做的那一步。同步返回，will.js 可以直接用。
   * 没有目标或者目标做完了 -> null
   *
   * 返回的字段跟 will 的 current 对齐：{ text, since, done }
   * 另外带上 goal / stageIndex / total，方便上层显示进度。
   */
  current () {
    if (!this.goal || this.goal.done) return null
    const s = this.stage()
    if (!s) return null
    return {
      text: s.title,
      since: s.startedAt || this.goal.createdAt,
      done: false,
      goal: this.goal.title,
      why: this.goal.why,
      stage: s.title,
      stageIndex: this.goal.stageIndex,
      total: this.goal.stages.length,
      progress: s.ratio || 0,
      fromGoal: true
    }
  }

  /** 只取一句话 */
  currentText () {
    const c = this.current()
    return c ? c.text : null
  }

  /** 这一步现在的进度，说人话 */
  progressText () {
    if (!this.goal) return ''
    const s = this.stage()
    if (!s) return ''
    const p = stageProgress(s, this.lastStatus || {})
    return p.text
  }

  /** 塞进提示词的一段话 */
  promptBlock () {
    if (!this.goal) return ''
    const s = this.stage()
    if (!s) return ''
    const idx = this.goal.stageIndex + 1
    const lines = [
      '## 你心里挂着的一件事',
      `目标：${this.goal.title}${this.goal.why ? '（' + this.goal.why + '）' : ''}`,
      `进度：第 ${idx}/${this.goal.stages.length} 步 —— ${s.title}`,
      // 去哪找：没有这句他会挑"最近的那块" —— 而最近的石头可能在地下，
      // 他下不去（实测 [goto] 高度到不了 连刷 6 次）。
      s.where ? `去哪弄：${s.where}` : '',
      this.progressText() ? `这一步到现在：${this.progressText()}` : '',
      '这件事不是今天干完的，是一天天攒出来的。能干就往前推一点，别每次从零想。'
    ].filter(Boolean)
    return lines.join('\n')
  }

  // ------------------------------------------------ 记进度

  /**
   * 扫一眼状态，更新进度。主循环里隔一会儿调一次就行。
   * 返回 { stageCompleted, goalCompleted, ratio, abandoned }
   */
  observe (status) {
    if (status) this.lastStatus = status
    if (!this.goal || this.goal.done || !status) {
      return { stageCompleted: false, goalCompleted: false, ratio: 0, abandoned: false }
    }
    const s = this.stage()
    if (!s) return { stageCompleted: false, goalCompleted: false, ratio: 0, abandoned: false }

    const p = stageProgress(s, status)
    const before = s.best || 0
    s.ratio = p.ratio
    s.progressText = p.text
    if (p.ratio > before + 0.01) {
      s.best = p.ratio
      this.goal.lastProgressAt = this.now()
      this.goal.updatedAt = this.now()
    }

    if (p.ratio >= 1 - 1e-9) {
      s.doneAt = this.now()
      this.journal(`搞定了「${s.title}」`)
      const isLast = this.goal.stageIndex >= this.goal.stages.length - 1
      if (isLast) {
        this.completeGoal()
        return { stageCompleted: true, goalCompleted: true, ratio: 1, abandoned: false }
      }
      this.goal.stageIndex++
      const ns = this.stage()
      if (ns) {
        ns.base = makeBase(ns, status)
        ns.startedAt = this.now()
      }
      this.journal(ns ? `接下来：${ns.title}` : '')
      this.save(true)
      this.log(`[goals] 过了一步：「${s.title}」→ 下一步「${ns ? ns.title : '完了'}」`)
      return { stageCompleted: true, goalCompleted: false, ratio: 1, abandoned: false }
    }

    // 太久没动静：这事可能干不成，或者他不想干了
    const idle = this.now() - (this.goal.lastProgressAt || this.goal.createdAt)
    if (idle > this.cfg.stallMs) {
      const mins = Math.round(idle / 60000)
      this.abandon(`「${s.title}」卡了 ${mins} 分钟没往前挪，先算了`)
      return { stageCompleted: false, goalCompleted: false, ratio: p.ratio, abandoned: true }
    }

    this.save()
    return { stageCompleted: false, goalCompleted: false, ratio: p.ratio, abandoned: false }
  }

  /**
   * 干完一件事之后回报结果。
   * 主程序在任务结束（成功/失败）时调一次，长期目标才知道"刚才那一下算不算数"。
   */
  onTaskResult ({ ok, text, status, progress } = {}) {
    if (status) this.lastStatus = status
    if (!this.goal || this.goal.done) return { advanced: false }
    const s = this.stage()
    if (!s) return { advanced: false }

    s.attempts = (s.attempts || 0) + 1
    this.goal.attempts++

    if (ok) {
      // 他自己的动作算"这一步往前推了一点"
      if (s.kind === 'do' || s.kind === 'build') this.addWork(progress || 1)
      s.fails = 0

      // ===== 防空转：说"成了"但进度一点没动 =====
      //
      // 实测：目标「开一小块地」第 2 步要 6 个种子，他手上只有 1 个。
      // will 给的任务是「找点种子」，模型每次都答"身上已有 1 个小麦种子"，
      // judgeOutcome 判成功 -> 这里 s.fails 归零 -> 阶段永远推不动。
      // 结果：40 秒内同一个任务跑了 37 次，什么都没干。
      //
      // 现在：成功率对得上进度才算数。连续这么多轮"成功但没进展"，
      // 就当这一阶段没戏，换条路 —— 跟真人一样，
      // "我已经有了"重复几十遍之后，他自己也会觉得不对劲。
      const before = s.best || 0
      if (status) {
        const p0 = stageProgress(s, status)
        if (p0.ratio <= before + 1e-9) {
          s.idleWins = (s.idleWins || 0) + 1
          if (s.idleWins >= (this.cfg.maxIdleWins || 5)) {
            this.abandon(`「${s.title}」干了 ${s.idleWins} 趟都说成了，进度一点没动，八成是弄不到`)
            return { advanced: false, abandoned: true }
          }
        } else {
          s.idleWins = 0
          this.goal.lastProgressAt = this.now()
        }
      } else {
        this.goal.lastProgressAt = this.now()
      }
    } else {
      s.fails = (s.fails || 0) + 1
      this.goal.fails++
      this.journal(`这趟没成：${text || '不知道为啥'}`)
    }

    // 同一件事反复干不成，别死磕
    if (s.fails >= this.cfg.maxFails) {
      this.abandon(`「${s.title}」试了 ${s.fails} 次都不行，换条路`)
      return { advanced: false, abandoned: true }
    }

    const res = status ? this.observe(status) : { stageCompleted: false, goalCompleted: false }
    this.save(true)
    return res
  }

  /** 手工给当前阶段加工作量（盖墙、搭台子这种"做成了"的计量） */
  addWork (n = 1) {
    const s = this.stage()
    if (!s) return 0
    s.work = (s.work || 0) + Math.max(0, Number(n) || 0)
    return s.work
  }

  journal (text) {
    if (!this.goal || !text) return
    this.goal.journal.push({ at: this.now(), text })
    if (this.goal.journal.length > 40) this.goal.journal.shift()
  }

  // ------------------------------------------------ 收尾

  completeGoal () {
    const g = this.goal
    if (!g) return
    const now = this.now()
    const mins = Math.round((now - g.createdAt) / 60000)
    this.history.push({
      key: g.key,
      title: g.title,
      why: g.why,
      result: 'done',
      stages: g.stages.length,
      at: now,
      tookMin: mins
    })
    this.cooldown[g.key] = now + this.cfg.doneCooldownMs
    this.goal = null
    this.save(true)
    this.log(`[goals] 干完了：${g.title}（${g.stages.length} 步，用了 ${mins} 分钟游戏外的时间）`)
  }

  /** 放弃。真人也会放弃 —— 不丢人，记下来就行 */
  abandon (reason) {
    const g = this.goal
    if (!g) return null
    const now = this.now()
    const s = this.stage()
    this.history.push({
      key: g.key,
      title: g.title,
      why: g.why,
      result: 'abandoned',
      reason: reason || '不想干了',
      stoppedAt: s ? s.title : '',
      stagesDone: g.stageIndex,
      at: now
    })
    // 近期不再选同一个方向（自己发明的目标用整句话当 key）
    this.cooldown[g.key] = now + this.cfg.cooldownMs
    this.goal = null
    this.save(true)
    this.log(`[goals] 放弃：${g.title} —— ${reason || ''}`)
    return this.history[this.history.length - 1]
  }

  /** 给上层看的一眼状态 */
  status () {
    if (!this.goal) {
      return { has: false, text: '现在没在忙什么大事', history: this.history.slice(-3) }
    }
    const s = this.stage()
    return {
      has: true,
      title: this.goal.title,
      why: this.goal.why,
      stage: s ? s.title : '',
      stageIndex: this.goal.stageIndex,
      total: this.goal.stages.length,
      progress: s ? (s.ratio || 0) : 0,
      progressText: this.progressText(),
      since: this.goal.createdAt,
      history: this.history.slice(-3)
    }
  }

  /** 存进长期记忆的一句话 */
  summary () {
    if (!this.goal) return null
    const s = this.stage()
    return `最近在忙一件事：${this.goal.title}。卡在「${s ? s.title : ''}」这一步。`
  }

  /** 全部阶段（报告 / 测试用） */
  plan () {
    if (!this.goal) return []
    return this.goal.stages.map((s, i) => ({
      index: i,
      title: s.title,
      kind: s.kind,
      done: !!s.doneAt || i < this.goal.stageIndex,
      current: i === this.goal.stageIndex,
      ratio: s.ratio || 0
    }))
  }
}

// ---------------------------------------------------------------- 阶段进度计算

function stageProgress (stage, status) {
  const inv = (status && status.inventory) || {}
  const need = stage.need || {}
  const base = (stage.base && stage.base.inv) || {}

  if (stage.kind === 'gather') {
    const keys = Object.keys(need)
    if (!keys.length) return { ratio: 1, text: '' }
    let total = 0
    let got = 0
    const parts = []
    for (const k of keys) {
      const want = Number(need[k]) || 0
      const have = Math.max(0, itemCount(inv, k) - itemCount(base, k))
      const g = Math.min(want, have)
      total += want
      got += g
      parts.push(`${cn(k)} ${g}/${want}`)
    }
    return { ratio: total > 0 ? clamp01(got / total) : 1, text: parts.join('，') }
  }

  if (stage.kind === 'craft') {
    const name = need.item
    const want = Number(need.n) || 1
    const have = itemCount(inv, name)
    return { ratio: clamp01(have / want), text: `${cn(name)} ${Math.min(want, have)}/${want}` }
  }

  if (stage.kind === 'depth') {
    const target = Number(need.y)
    const from = stage.base && typeof stage.base.y === 'number' ? stage.base.y : 64
    const y = Math.round(posOf(status).y)
    if (y <= target) return { ratio: 1, text: `已经到 y=${y} 了` }
    const span = from - target
    const done = span > 0 ? (from - y) / span : 0
    return { ratio: clamp01(done), text: `现在 y=${y}，目标是 y=${target}` }
  }

  if (stage.kind === 'travel') {
    const want = Number(need.distance) || 100
    const from = (stage.base && stage.base.pos) || posOf(status)
    const d = dist(from, posOf(status))
    return { ratio: clamp01(d / want), text: `走了 ${Math.round(d)}/${want} 格` }
  }

  // do / build / custom：靠"做成了几次"或 addWork 计数
  const want = Number(need.count) || 1
  const work = Number(stage.work) || 0
  return { ratio: clamp01(work / want), text: `${Math.min(want, work)}/${want}` }
}

/** 模型给的阶段（可能只有一句话）补成能验收的结构 */
/**
 * 模型给的阶段（可能只有一句话）补成能验收的结构。
 *
 * 它自己发明的阶段没有数字，只能按"做成了没有"来算 —— 一次成功算一步。
 * 这样宁可粗一点，也不能因为"没法量化"就不记账。
 */
function normalizeStage (raw) {
  const title = String(raw.title || '').trim().slice(0, 40)
  let kind = String(raw.kind || '').trim()
  if (!['gather', 'craft', 'depth', 'travel', 'do', 'build'].includes(kind)) kind = 'do'
  const need = raw.need && typeof raw.need === 'object' && Object.keys(raw.need).length
    ? raw.need
    : { count: 1 }
  return { key: null, kind, need, title }
}

function parseJson (text) {
  const s = String(text || '')
  const m = s.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch (e) { return null }
}

module.exports = Goals
module.exports.Goals = Goals
module.exports.POOL = POOL
module.exports.ITEM_CN = ITEM_CN
module.exports.pickTier = pickTier
module.exports.itemCount = itemCount
module.exports.stageProgress = stageProgress
module.exports.VERSION = VERSION
