'use strict'
/**
 * 代价层 —— 他会为白干心疼。
 *
 * 【为什么要有这个文件】
 * 全项目对记忆的"读"只有三处：lastSummary / hitStats / remember(pos)。
 * 「我白干了一小时」这一类，一处都没有。
 * goals.abandon() 直接换路，从不结算 —— 于是他的失败是**免费**的：
 * 花了 40 分钟什么都没挖到，和 4 分钟没挖到，在他心里一样重。
 *
 * 人格 = 你愿意为什么付多少。不付出、不损失、不心疼的东西不会像人。
 * 所以这里做三件事：
 *
 *   1. 结算（settle）—— 放弃一个目标时算笔账：多久、多远、弄到啥、白搭多少。
 *      算完写进记忆，写成**人话**，不是 "目标 house 放弃，耗时 2400 秒，产出 6"。
 *
 *   2. 记忆有牙（avoidZone / hazard / dread）—— 记下来不算数，得在下次选目标时
 *      真的把分数压下去：被岩浆烫过这几天不选深层；某片地白干过就绕着走；
 *      同一件事栽过三回，提起来就烦。
 *
 *   3. 时间值钱（rate / wear / sourness）—— 投入产出比进判断。
 *      同一件事干太久没进展 -> 该烦；白干完 -> 该有情绪。
 *
 * 【边界】记忆模块是别人的：这里只通过它的公开接口写
 * （mem.add / entry.make 的返回结构），不碰 src/memory/**。
 * 目标模块（goals.js）也不用改：attach(goals) 在**实例**上包一层，
 * 放弃/选目标/提示词三个口子都能接上；等 goals 那边稳定了，
 * 也可以改成 goals.js 里直接调 settle() / bias()，两条路并存不会重复记账
 * （_costSettled 幂等）。
 */

const fs = require('fs')
const path = require('path')

const FILE = 'cost.json'
// 当前活着的实例（main.js 的 attach() 会登记）。
// spontaneous 要"把账说出口"，但没有 main.js 传参的通道 —— 用它取。
let CURRENT = null
const VERSION = 1
const MIN = 60 * 1000

// ============================================================
// 0. 报价：什么东西值多少
// ============================================================

/**
 * 粗略"值多少"。
 * 单位不是钱，是"这一趟值不值"的相对重量 —— 一块钻石 ≈ 四十块圆石。
 * 只用来算投入产出比，不进记忆文本（记忆里说人话：两块圆石）。
 */
const VALUE = {
  diamond: 40, emerald: 30, ancient_debris: 60, netherite_ingot: 120,
  gold_ingot: 12, raw_gold: 9, gold_ore: 9,
  iron_ingot: 8, raw_iron: 6, iron_ore: 6,
  redstone: 3, lapis_lazuli: 3, copper_ingot: 2, raw_copper: 1.5,
  coal: 2, charcoal: 1,
  wheat: 2, bread: 3, apple: 2, carrot: 1.5, potato: 1.5, beetroot: 1.5,
  porkchop: 3, beef: 3, chicken: 2, mutton: 3, cod: 1.5, salmon: 1.5,
  leather: 2, wool: 3, string: 2, feather: 1, bone: 1, gunpowder: 2,
  slime_ball: 3, ender_pearl: 8, blaze_rod: 12,
  torch: 1, stick: 0.5, crafting_table: 2, furnace: 4, chest: 2,
  bucket: 6, iron_pickaxe: 20, stone_pickaxe: 6, wooden_pickaxe: 3,
  cobblestone: 1, stone: 1, andesite: 0.8, granite: 0.8, diorite: 0.8,
  deepslate: 1, tuff: 0.6,
  dirt: 0.2, sand: 0.2, gravel: 0.2, clay_ball: 0.4, snowball: 0.2
}

const UNIT = {
  石头: '块', 圆石: '块', 土: '块', 沙砾: '把', 木头: '根', 木板: '块',
  煤: '块', 铁矿石: '块', 铁锭: '块', 金锭: '块', 钻石: '颗',
  红石: '把', 青金石: '颗', 绿宝石: '颗',
  木棍: '根', 火把: '根', 面包: '个', 苹果: '个',
  小麦: '把', 种子: '把', 皮革: '张', 羊毛: '团', 线: '团', 骨头: '根',
  箭: '支', 腐肉: '块', 泥土: '块'
}

const ITEM_CN = {
  diamond: '钻石', emerald: '绿宝石', gold_ingot: '金锭', raw_gold: '金矿石',
  iron_ingot: '铁锭', raw_iron: '铁矿石', iron_ore: '铁矿石',
  coal: '煤', charcoal: '木炭', redstone: '红石', lapis_lazuli: '青金石',
  copper_ingot: '铜锭', raw_copper: '铜矿石', ancient_debris: '远古残骸',
  cobblestone: '圆石', stone: '石头', andesite: '安山岩', granite: '花岗岩',
  diorite: '闪长岩', deepslate: '深板岩', tuff: '凝灰岩',
  dirt: '土', sand: '沙子', gravel: '沙砾', clay_ball: '黏土球',
  oak_log: '木头', birch_log: '木头', spruce_log: '木头', jungle_log: '木头',
  acacia_log: '木头', dark_oak_log: '木头', cherry_log: '木头', mangrove_log: '木头',
  oak_planks: '木板', birch_planks: '木板', spruce_planks: '木板',
  stick: '木棍', torch: '火把', crafting_table: '工作台', furnace: '熔炉',
  chest: '箱子', bread: '面包', apple: '苹果', wheat: '小麦', wheat_seeds: '种子',
  porkchop: '猪排', beef: '牛肉', chicken: '鸡肉', mutton: '羊肉',
  leather: '皮革', wool: '羊毛', string: '线', feather: '羽毛', bone: '骨头',
  gunpowder: '火药', slime_ball: '黏液球', ender_pearl: '末影珍珠',
  bucket: '桶', stone_pickaxe: '石镐', wooden_pickaxe: '木镐',
  iron_pickaxe: '铁镐', stone_axe: '石斧', stone_sword: '石剑'
}

/** 一个物品的重量 */
function priceOf (item) {
  const k = String(item || '').toLowerCase()
  if (VALUE[k] != null) return VALUE[k]
  if (/_log$/.test(k)) return 2
  if (/_planks$/.test(k)) return 1.2
  if (/_ore$/.test(k)) return 4
  if (/_sword$|_pickaxe$|_axe$|_shovel$|_hoe$/.test(k)) return 5
  if (/_seeds$/.test(k)) return 0.4
  return 0.5
}

function cnOf (item) {
  const k = String(item || '').toLowerCase()
  if (ITEM_CN[k]) return ITEM_CN[k]
  if (/_log$/.test(k)) return '木头'
  if (/_planks$/.test(k)) return '木板'
  if (/_ore$/.test(k)) return k.replace(/_/g, ' ')
  return k.replace(/_/g, ' ')
}

// ============================================================
// 1. 说人话的数字
// ============================================================

const CN = '零一二三四五六七八九'

function cnNum (n) {
  const v = Math.max(0, Math.round(Number(n) || 0))
  // 两条鱼 / 两回死 —— 量词前面说"两"，不说"二"
  if (v === 2) return '两'
  if (v < 10) return CN[v]
  if (v < 20) return '十' + (v % 10 ? CN[v % 10] : '')
  if (v < 100) {
    const t = Math.floor(v / 10)
    const o = v % 10
    return CN[t] + '十' + (o ? CN[o] : '')
  }
  return String(v)
}

/**
 * 分钟 -> 人的说法。
 * 真人不报秒，也不会说"耗时 2400 秒"，他说"四十来分钟"、"一刻钟"、"一个多钟头"。
 */
function humanMins (mins) {
  const m = Math.max(1, Math.round(Number(mins) || 0))
  if (m <= 2) return '两分钟'
  if (m < 10) return cnNum(m) + '分钟'
  if (m < 14) return '一刻钟'
  if (m < 60) {
    // 按十位取整：40~42 -> 四十分钟；43~49 -> 四十来分钟
    // 真人不会说"四十五来分钟"，也不会把 43 分钟说成"四十来分钟"以外的东西
    const tens = Math.floor(m / 10) * 10
    if (tens < 10) return cnNum(m) + '分钟'
    const slack = m - tens
    return cnNum(tens) + (slack <= 2 ? '分钟' : '来分钟')
  }
  const h = m / 60
  if (h < 1.5) return '一个多钟头'
  if (h < 2.5) return '两个来钟头'
  if (h < 6) return cnNum(Math.round(h)) + '个钟头'
  return '大半天'
}

/** 数量 + 物品：两块圆石 / 一把煤 / 六颗钻石 */
function humanGoods (item, n) {
  const name = cnOf(item)
  const unit = UNIT[name] || '个'
  return cnNum(n) + unit + name
}

/** 一句"弄到啥"，最多三样 */
function humanLoot (gained) {
  const list = (gained || []).filter(g => g.n > 0).slice(0, 3)
  if (!list.length) return ''
  return list.map(g => humanGoods(g.item, g.n)).join('、')
}

// ============================================================
// 2. 死因 -> 危险类别
// ============================================================

const HAZARD_RULES = [
  { kind: 'lava', re: /岩浆|熔岩|lava|burned|fire|烧死|着火/, ttl: 25 * MIN },
  { kind: 'fall', re: /摔|坠落|fell|high place|落地|高空/, ttl: 15 * MIN },
  { kind: 'water', re: /溺|沉|water|drown|水/, ttl: 12 * MIN },
  { kind: 'mob', re: /僵尸|骷髅|蜘蛛|苦力怕|爬行者|末影|女巫|溺尸|猪灵|监守者|zombie|skeleton|spider|creeper|slain by/, ttl: 12 * MIN },
  { kind: 'void', re: /虚空|void/, ttl: 20 * MIN }
]

function classifyDeath (how) {
  const s = String(how || '')
  for (const r of HAZARD_RULES) if (r.re.test(s)) return r
  return null
}

/** 这一趟是往深处去的活儿吗（岩浆这种危险主要在深层） */
const DEEP_RE = /挖|矿|钻|铁|深层|下去|洞|y=|\bdig|mine|depth|underground/i

function normPos (p) {
  if (!p || !isFinite(p.x) || !isFinite(p.z)) return null
  return { x: Math.round(p.x), y: Math.round(Number(p.y) || 0), z: Math.round(p.z) }
}

function hDist (a, b) {
  if (!a || !b) return Infinity
  return Math.hypot(a.x - b.x, a.z - b.z)
}

// ============================================================
// 3. 主体
// ============================================================

class Cost {
  /**
   * new Cost(dir, { mem, now, log, cfg })
   * 也接受 new Cost({ dir, mem, ... })
   *
   * dir  数据目录（一般 data/runtime，跟 goals/memory 同一个）
   * mem  记忆实例（可选；没有就只记账不写记忆）
   * now  可注入时钟（测试用），默认 Date.now
   */
  constructor (dir, opts = {}) {
    if (dir && typeof dir === 'object') { opts = dir; dir = opts.dir }
    this.dir = dir || path.join(process.cwd(), 'data', 'runtime')
    this.file = path.join(this.dir, FILE)
    this.mem = opts.mem || null
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now()
    this.log = typeof opts.log === 'function' ? opts.log : () => {}

    this.cfg = Object.assign({
      // 一趟活值不值：每分钟该弄到多少"重量"
      expectRate: 1.2,
      whiteRate: 0.25,        // 低于这个 = 白干
      mehRate: 0.9,           // 低于这个 = 凑合
      minBillMs: 3 * MIN,     // 不到 3 分钟的活不记账（省得每件小事都"白干"）
      deathCost: 10,          // 一条命折多少重量
      // 避开一片地方
      zoneRadius: 48,
      zoneTtl: 30 * MIN,
      // 烦躁
      wearPerWhite: 0.35,
      wearPerBitter: 0.4,
      wearPerMeh: 0.08,
      wearDecayPerMin: 0.02,
      // 栽过几回就"提起来就烦"
      dreadAt: 2,
      // ===== 把账说出口 =====
      // 一笔损失只吐槽一次；两笔之间至少隔 10 分钟，别变成怨妇。
      // 只吐槽 8 分钟以内的新鲜账 —— 三天前的破事突然翻出来不像人。
      speakCooldownMs: 10 * 60 * 1000,
      speakMaxAgeMs: 8 * 60 * 1000,
      // 结算记忆的权重
      lossEmotion: 0.6,
      lossImportance: 0.72
    }, opts.cfg || {})

    this.zones = []       // [{x,y,z,r,reason,until,at,key}]
    this.hazards = {}     // kind -> 到期时间
    this.losses = []      // 结算过的账（最近 40 条）
    this.fails = {}       // goalKey -> [{at, reason}]
    this._wear = 0
    this._wearAt = this.now()
    this._trail = []      // [{t, d}] 走路里程采样
    this._walked = 0
    this._lastPos = null
    this._lastAt = 0
    this._deaths = []     // [{at, how, kind}]
    this.load()
  }

  // ------------------------------------------------ 存盘

  load () {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8') || '{}')
      if (!d || d.version !== VERSION) return this
      const now = this.now()
      this.zones = (Array.isArray(d.zones) ? d.zones : []).filter(z => z && z.until > now)
      this.hazards = {}
      for (const [k, v] of Object.entries(d.hazards || {})) if (v > now) this.hazards[k] = v
      this.losses = Array.isArray(d.losses) ? d.losses.slice(-40) : []
      this.fails = d.fails && typeof d.fails === 'object' ? d.fails : {}
      this._wear = Number(d.wear) || 0
      this._wearAt = d.wearAt || now
      this._deaths = Array.isArray(d.deaths) ? d.deaths.slice(-20) : []
    } catch (e) {
      // 没存过就算了 —— 空账本不影响主流程
    }
    return this
  }

  save () {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify({
        version: VERSION,
        zones: this.zones,
        hazards: this.hazards,
        losses: this.losses.slice(-40),
        fails: this.fails,
        wear: this._wear,
        wearAt: this._wearAt,
        deaths: this._deaths.slice(-20)
      }), 'utf8')
    } catch (e) {}
  }

  // ------------------------------------------------ 观察（每轮调）

  /**
   * 主循环每轮喂一次状态。只做两件事：记走路里程、记住人在哪。
   * 不写盘（下一轮还会有），结算时一次写。
   */
  observe (status) {
    const p = normPos(status && status.pos)
    if (!p) return this
    const now = this.now()
    if (this._lastPos) {
      const d = Math.hypot(p.x - this._lastPos.x, p.y - this._lastPos.y, p.z - this._lastPos.z)
      // 一次跨 64 格以上 = 复活 / 传送，不是走出来的，别记成"走了多少路"
      if (d < 64) {
        this._walked += d
        this._trail.push({ t: now, d: Math.round(d) })
      } else {
        this._trail.push({ t: now, d: 0, warp: true })
      }
    }
    this._lastPos = p
    this._lastAt = now
    // 只留最近两小时的采样
    if (this._trail.length > 2400) this._trail.splice(0, this._trail.length - 2400)
    const cut = now - 120 * MIN
    while (this._trail.length && this._trail[0].t < cut) this._trail.shift()
    return this
  }

  /** 从某时刻到现在走了多少格 */
  walkedSince (t) {
    const from = Number(t) || 0
    let sum = 0
    for (const s of this._trail) if (s.t >= from) sum += s.d || 0
    return Math.round(sum)
  }

  /** 死一回。死因决定接下来一阵子躲什么。 */
  onDeath (info = {}) {
    const how = typeof info === 'string' ? info : (info.how || '')
    const pos = normPos(info.pos || (info.status && info.status.pos) || this._lastPos)
    const now = this.now()
    const rule = classifyDeath(how)
    this._deaths.push({ at: now, how: String(how).slice(0, 80), kind: rule ? rule.kind : null })
    if (this._deaths.length > 20) this._deaths.shift()
    if (rule) this.hazard(rule.kind, rule.ttl)
    // 死过的地方记一下（半径小一点：不是"这块地方没搞头"，是"这儿要命"）
    if (pos) this.avoidZone(pos, '死过', 20 * MIN, { r: 32, key: 'death' })
    this.save()
    return { kind: rule ? rule.kind : null, pos }
  }

  deathsSince (t) {
    const from = Number(t) || 0
    return this._deaths.filter(d => d.at >= from).length
  }

  // ------------------------------------------------ 结算

  /**
   * 算一笔账。goal 是 goals.js 里的目标对象（放弃前抓到的那份）。
   *
   * stats 可给可不给：
   *   { status, ms, distance, gained, spent, deaths, pos, reason }
   * 不给就自己从 goal.stages[0].base（建立目标时的库存/坐标）和 trail 里推。
   *
   * 返回账单：
   *   { at, key, title, mins, time, dist, deaths, gained, spent, worth, rate,
   *     verdict, text, memText, zone, settled }
   *
   * 副作用：写进 this.losses、写一条记忆、白干就记"这片地方别来了"。
   * 幂等：同一份 goal 只结一次账（_costSettled）。
   */
  settle (goal, stats = {}) {
    if (!goal || typeof goal !== 'object') return null
    if (goal._costSettled) return goal._costSettled

    const now = this.now()
    const startedAt = Number(stats.startedAt || goal.createdAt || now)
    const ms = Number.isFinite(stats.ms) ? stats.ms : Math.max(0, now - startedAt)
    const mins = ms / MIN

    const base = (goal.stages && goal.stages[0] && goal.stages[0].base) || {}
    const curInv = (stats.status && stats.status.inventory) || null
    const baseInv = base.inv || null

    const gained = stats.gained || diffInv(baseInv, curInv)
    const spent = stats.spent || diffInv(curInv, baseInv)

    const pos = normPos(stats.pos || (stats.status && stats.status.pos) || this._lastPos || base.pos)
    const startPos = normPos(base.pos)
    let distance = stats.distance
    if (!Number.isFinite(distance)) {
      distance = (this._trail.length && startedAt) ? this.walkedSince(startedAt) : 0
      if (!distance && startPos && pos) distance = Math.round(hDist(startPos, pos))
    }
    const deaths = Number.isFinite(stats.deaths) ? stats.deaths : this.deathsSince(startedAt)

    const worth = gained.reduce((s, g) => s + g.n * priceOf(g.item), 0)
    const burn = spent.reduce((s, g) => s + g.n * priceOf(g.item), 0)
    const rate = mins >= 0.5 ? worth / mins : worth
    const verdict = this.verdictOf({ mins, worth, rate, deaths })

    const bill = {
      at: now,
      key: goal.key || '',
      title: goal.title || '',
      reason: stats.reason || '',
      stage: (goal.stages && goal.stages[goal.stageIndex || 0] && goal.stages[goal.stageIndex || 0].title) || '',
      startedAt,
      ms,
      mins: Math.round(mins * 10) / 10,
      time: humanMins(mins),
      dist: distance,
      deaths,
      gained,
      spent,
      worth: Math.round(worth * 10) / 10,
      burn: Math.round(burn * 10) / 10,
      rate: Math.round(rate * 100) / 100,
      verdict
    }
    // 先定"是不是栽在这片地方"，再生成文案 —— 句子里的"这破地方"要靠它
    bill.zone = verdict === 'white' || verdict === 'bitter' ? pos : null
    bill.text = billText(bill)
    bill.memText = memText(bill)

    goal._costSettled = bill

    // ---- 记账 ----
    this.losses.push({
      at: bill.at, key: bill.key, title: bill.title, verdict,
      mins: bill.mins, dist: bill.dist, worth: bill.worth, rate: bill.rate,
      gained: bill.gained, spent: bill.spent, burn: bill.burn, deaths: bill.deaths,
      text: bill.memText,
      spokenAt: null      // 说出口了吗（spontaneous 用；说一次就不再提）
    })
    if (this.losses.length > 40) this.losses.shift()

    // 太短的活不算"栽过" —— 不然一分钟的临时换向也会变成"提起来就烦"
    if (verdict !== 'short' && bill.key) {
      this.fails[bill.key] = (this.fails[bill.key] || [])
        .concat([{ at: now, reason: bill.reason || verdict }]).slice(-20)
    }

    // ---- 时间值钱：白干会让他烦 ----
    if (verdict === 'white') this.addWear(this.cfg.wearPerWhite)
    else if (verdict === 'bitter') this.addWear(this.cfg.wearPerBitter)
    else if (verdict === 'meh') this.addWear(this.cfg.wearMeh || this.cfg.wearPerMeh)

    // ---- 记忆有牙：这片地方别再来了 ----
    let zone = null
    if (bill.zone) {
      zone = this.avoidZone(bill.zone, verdict === 'bitter' ? '栽过' : '白干过', this.cfg.zoneTtl, { key: bill.key })
    }

    // ---- 写进记忆 ----
    //
    // 只在他"吃了亏"的时候记：白干 / 不划算 / 勉强够本。
    // 顺的活儿不记 —— 记忆不是流水账，记满"这趟没白跑"会把真印象挤掉。
    // 例外：一趟收获特别大（worth >= 25），那也是件事。
    const worthRemembering = verdict !== 'ok' || bill.worth >= 25
    bill.memKept = worthRemembering && !!this.rememberLoss(bill.memText, {
      kind: verdict === 'bitter' ? 'grievance' : 'skill',
      importance: verdict === 'bitter' ? 0.75 : this.cfg.lossImportance,
      emotion: verdict === 'bitter' ? 0.68 : this.cfg.lossEmotion,
      where: zone,
      zone: bill.zone,
      verdict,
      mins: bill.mins,
      // 顺利的账被准入毙了就毙了（说明确实不像"值得记的事"），不硬塞
      allowForce: verdict !== 'ok'
    })

    this.save()
    if (verdict !== 'short') this.log(`[cost] ${bill.text}`)
    return bill
  }

  /** 白干 / 凑合 / 值 —— 判据是"每分钟弄到多少" */
  verdictOf ({ mins, worth, rate, deaths }) {
    if (mins < this.cfg.minBillMs / MIN) return 'short'   // 不到 3 分钟，不记这笔账
    const white = worth <= 0.5 || rate < this.cfg.whiteRate
    const meh = rate < this.cfg.mehRate
    if (white) return (deaths > 0) ? 'bitter' : 'white'
    if (meh) return (deaths > 0) ? 'bitter' : 'meh'
    return 'ok'
  }

  /**
   * 把"白干"写进记忆。
   *
   * 走记忆模块的公开接口 add()。
   * 那句文本本身带"记住"这种教训信号，正常能进；万一被准入当流水账毙了
   * （措辞里带了数字/物品名，被 LOG_MARKS 抓到），就用它自己的 force 兜底 ——
   * 宁可多一条"我白干了"，不要连一条都没有。
   */
  rememberLoss (text, meta = {}) {
    const mem = this.mem
    if (!mem || !text) return null
    const o = {
      text,
      kind: meta.kind === 'grievance' ? 'grievance' : 'skill',
      emotion: meta.emotion == null ? this.cfg.lossEmotion : meta.emotion,
      importance: meta.importance == null ? this.cfg.lossImportance : meta.importance
    }
    if (meta.where) o.where = meta.where
    let e = null
    try { e = mem.add(o) } catch (err) { e = null }
    if (!e) {
      if (meta.allowForce !== false) {
        try { e = mem.add(Object.assign({}, o, { force: true })) } catch (err) { e = null }
      }
    }
    if (e && meta.zone) {
      // 记忆条目上留个坐标，召回时可以按"离这儿多远"加权
      e.zone = { x: meta.zone.x, y: meta.zone.y, z: meta.zone.z }
    }
    return e || null
  }

  // ------------------------------------------------ 记忆有牙（1）避开一片地方

  /**
   * 记下"这片地方没搞头"。
   * @param {{x,y,z}} pos
   * @param {string} reason 人话，进记忆/提示词
   * @param {number} [ttlMs]
   */
  avoidZone (pos, reason, ttlMs, opts = {}) {
    const p = normPos(pos)
    if (!p) return null
    const now = this.now()
    const ttl = Number(ttlMs) || this.cfg.zoneTtl
    const r = Number(opts.r) || this.cfg.zoneRadius
    // 同一片地方不重复记（48 格内算同一片）。
    // 但"在这儿挖矿白干"和"在这儿爬不上去"是两笔不同的账 ——
    // 所以一片区域记住它坑过哪几类活（keys），不是只记第一笔。
    const key = opts.key || ''
    const near = this.zones.find(z => z.until > now && hDist(z, p) < Math.min(z.r, r))
    if (near) {
      near.until = Math.max(near.until, now + ttl)
      near.times = (near.times || 1) + 1
      // 越栽越多，那片地方越"没搞头"
      near.r = Math.min(96, Math.max(near.r, r))
      near.reason = reason || near.reason
      const keys = near.keys || (near.keys = near.key ? [near.key] : [])
      if (key && !keys.includes(key)) keys.push(key)
      this.save()
      return near.name || null
    }
    const name = placeName(p)
    this.zones.push({
      x: p.x, y: p.y, z: p.z, r, reason, until: now + ttl, at: now, times: 1,
      key: opts.key || '', keys: key ? [key] : [], name
    })
    if (this.zones.length > 24) this.zones.shift()
    this.save()
    return name
  }

  /** 这儿是不是"白干过"的地方 */
  zoneAt (pos) {
    const p = normPos(pos)
    if (!p) return null
    const now = this.now()
    let best = null
    for (const z of this.zones) {
      if (z.until <= now) continue
      const d = hDist(z, p)
      if (d >= z.r) continue
      const k = 1 - d / z.r
      if (!best || k > best.k) best = { zone: z, k, d }
    }
    return best
  }

  /**
   * 这片地方该扣多少分。
   *
   * 扣多少要看"是不是同一类活"：
   *   在同一片地方挖矿白干过 -> "再在这儿挖矿"扣满；
   *   但那片地方不是所有事都不能干（回家、砍树、吃口东西还是行的），
   *   所以别的活只扣一半 —— 心里膈应，但不是禁区。
   *
   * @param {{x,y,z}} pos
   * @param {string} [goalKey] 当前在评的那类活
   */
  zoneBias (pos, goalLike = {}) {
    const hit = this.zoneAt(pos)
    if (!hit) return { penalty: 0, why: '' }
    const now = this.now()
    const left = Math.max(0, hit.zone.until - now)
    const fresh = Math.min(1, left / (10 * MIN))       // 刚发生的最狠，快过期时慢慢放
    const repeat = Math.min(1.3, 0.85 + 0.15 * ((hit.zone.times || 1) - 1))
    const zoneKeys = hit.zone.keys || (hit.zone.key ? [hit.zone.key] : [])
    const sameWork = !!goalLike.key && zoneKeys.includes(goalLike.key)
    // 在这儿干的活按全价扣；要上去才能干的活只是"心里膈应"，扣三成
    const factor = sameWork ? 1 : (goalLike.undergroundGoal ? 0.9 : 0.35)
    const k = Math.min(1, hit.k * fresh * repeat * factor)
    const penalty = Math.round(100 * k)
    if (!penalty) return { penalty: 0, why: '' }
    const why = sameWork
      ? `在这一片${hit.zone.reason || '白干过'}，同一件活栽了 ${hit.zone.times || 1} 回`
      : `这一片（${hit.zone.name}）${hit.zone.reason || '白干过'}，待着心里膈应`
    return { penalty, why }
  }

  // ------------------------------------------------ 记忆有牙（2）危险期

  /** 记一段"危险期"：lava / fall / water / mob / void */
  hazard (kind, ttlMs) {
    if (!kind) return
    const now = this.now()
    this.hazards[kind] = Math.max(this.hazards[kind] || 0, now + (Number(ttlMs) || 10 * MIN))
    this.save()
  }

  hazardLeft (kind) {
    return Math.max(0, (this.hazards[kind] || 0) - this.now())
  }

  hazardActive (kind) {
    return this.hazardLeft(kind) > 0
  }

  /**
   * 危险期怎么影响选目标。
   * 刚被岩浆烫过 -> 这阵子别选深层；刚摔死 -> 别急着跑远路。
   */
  hazardBias (goalLike = {}) {
    const why = []
    let penalty = 0
    // candidates() 给出来的 stages 是**个数**不是数组，这里两种都认
    const stageText = Array.isArray(goalLike.stages)
      ? goalLike.stages.map(s => (s && s.title) || '').join(' ')
      : ''
    const text = `${goalLike.key || ''} ${goalLike.title || ''} ${stageText}`
    const deep = !!goalLike.undergroundGoal || /矿|钻|深层|下去|洞|挖铁|铁镐|y=/.test(goalLike.title || '')
    const away = /走远|探|外面|换地方|远点|跑/.test(text)

    const take = (kind, amount, word, match) => {
      const left = this.hazardLeft(kind)
      if (!left || !match) return
      const k = Math.min(1, left / (20 * MIN))
      penalty -= Math.round(amount * (0.45 + 0.55 * k))
      why.push(`${word}（还有 ${Math.round(left / MIN)} 分钟才缓过来）`)
    }

    take('lava', 55, '刚被岩浆烫过，别急着往深处钻', deep)
    take('fall', 30, '刚摔过一次，先别跑那么远', away || deep)
    take('mob', 25, '刚被怪弄死，别一个人往黑地方去', deep || away)
    take('water', 20, '刚在水里吃过亏，绕开河', away)
    take('void', 45, '刚掉下去过，别往边上去', away || deep)
    return { penalty, why }
  }

  // ------------------------------------------------ 记忆有牙（3）栽过几回

  failCount (key) {
    return (this.fails[key] || []).length
  }

  isDreaded (key) {
    return this.failCount(key) >= this.cfg.dreadAt
  }

  dreadBias (goalLike = {}) {
    const key = goalLike.key
    if (!key) return { penalty: 0, why: '' }
    const n = this.failCount(key)
    if (n < this.cfg.dreadAt) return { penalty: 0, why: '' }
    const penalty = -Math.min(40, 12 * (n - 1))
    const last = this.fails[key][this.fails[key].length - 1]
    const ago = last ? humanMins(Math.max(1, (this.now() - last.at) / MIN)) : ''
    return { penalty, why: `这档子事栽过 ${n} 回了${ago ? '（' + ago + '前还栽了一次）' : ''}，提起来就有点不想干` }
  }

  // ------------------------------------------------ 时间值钱

  addWear (n) {
    this.decayWear()
    this._wear = Math.max(0, Math.min(1, this._wear + (Number(n) || 0)))
    this._wearAt = this.now()
  }

  decayWear () {
    const now = this.now()
    const mins = Math.max(0, (now - (this._wearAt || now)) / MIN)
    if (mins > 0) this._wear = Math.max(0, this._wear - mins * this.cfg.wearDecayPerMin)
    this._wearAt = now
  }

  /** 0~1：现在有多烦"白折腾" */
  wear () {
    this.decayWear()
    return Math.round(this._wear * 100) / 100
  }

  wearText () {
    const w = this.wear()
    if (w < 0.15) return ''
    if (w < 0.4) return '有点堵，白折腾的账还没消'
    if (w < 0.7) return '有点烦了，不想再磨半天没动静'
    return '挺毛躁的，想干点马上见效的事'
  }

  /**
   * 正在干的这件事"馊了"没有。
   * 干得越久、进展越少，越该烦 —— 这是"投入产出比进入判断"的那一半。
   * @returns {number} 0~1
   */
  sourness ({ startedAt, progress, mins } = {}) {
    const m = Number.isFinite(mins) ? mins : (startedAt ? (this.now() - startedAt) / MIN : 0)
    if (m < 8) return 0
    const p = Math.max(0, Math.min(1, Number(progress) || 0))
    const stall = Math.min(1, (m - 8) / 25)
    return Math.round(Math.min(1, stall * (1 - p) * 1.2) * 100) / 100
  }

  sourText (o = {}) {
    const s = this.sourness(o)
    if (s < 0.25) return ''
    if (s < 0.55) return '这么久了还没个着落，有点烦'
    return '半天推不动，这活儿八成不对路'
  }

  // ------------------------------------------------ 汇总：给目标打补丁

  /**
   * 综合三条牙，给一个目标方向扣分。
   * goals.candidates() 出来的每一项都能塞进来。
   * @returns {{penalty:number, why:string[]}}
   */
  bias (goalLike = {}, status = null) {
    const why = []
    let penalty = 0
    const pos = normPos(status && status.pos) || this._lastPos
    const z = this.zoneBias(pos, goalLike)
    if (z.penalty) { penalty += -z.penalty; why.push(z.why) }
    const h = this.hazardBias(goalLike)
    if (h.penalty) { penalty += h.penalty; why.push(...h.why) }
    const d = this.dreadBias(goalLike)
    if (d.penalty) { penalty += d.penalty; why.push(d.why) }
    const w = this.wear()
    if (w >= 0.5 && goalLike.undergroundGoal) {
      const p = -Math.round(20 * w)
      penalty += p
      why.push('现在心里毛躁，不想再钻那种费半天的事')
    }
    return { penalty, why }
  }

  /** 把一批候选按"代价"重排（goals.candidates 的返回直接能喂） */
  applyBias (cands, status = null) {
    const list = (Array.isArray(cands) ? cands : []).map(c => {
      const b = this.bias(c, status)
      return Object.assign({}, c, {
        score: Math.round((Number(c.score) || 0) + b.penalty),
        costPenalty: b.penalty,
        costWhy: b.why
      })
    })
    list.sort((a, b) => b.score - a.score)

    // 观测：选目标时真的被压分了没有（一分钟最多一行，别刷屏）
    const hit = list.filter(c => c.costPenalty < 0)
    if (hit.length && this.now() - (this._biasLogAt || 0) > 60 * 1000) {
      this._biasLogAt = this.now()
      const top = hit.slice(0, 3).map(c => `${c.key}${c.costPenalty}`).join('；')
      this.log(`[cost] 选目标时压分：${top} —— ${(hit[0].costWhy[0] || '').slice(0, 60)}`)
    }

    return list.filter(c => c.score > 0)
  }

  // ------------------------------------------------ 说出口

  /**
   * 取一条"还没说出口"的损失。
   *
   * 条件：
   *   - 白干 / 不划算 / 勉强够本（够本的不必抱怨）
   *   - 还没说过（spokenAt 为空）
   *   - 是新鲜的（8 分钟以内）—— 半钟头前的破事突然翻出来不像人
   *   - 距离上一次吐槽至少 10 分钟 —— 别变成怨妇
   *
   * @returns {object|null} 账本条目（交给 spontaneous 组一句话）
   */
  nextUnspokenLoss () {
    const now = this.now()
    const gap = this.cfg.speakCooldownMs || 0
    if (gap > 0 && now - (this._lastLossSpokenAt || 0) < gap) return null
    const maxAge = this.cfg.speakMaxAgeMs || 0
    const list = this.losses.filter(l =>
      l && !l.spokenAt &&
      (l.verdict === 'white' || l.verdict === 'bitter' || l.verdict === 'meh') &&
      (maxAge <= 0 || now - l.at <= maxAge)
    )
    return list.length ? list[list.length - 1] : null
  }

  /** 记一笔"这条已经说过了"（说成没说出来都算一次机会，免得反复念） */
  markSpoken (loss) {
    const now = this.now()
    if (loss) loss.spokenAt = now
    this._lastLossSpokenAt = now
    this.save()
  }

  // ------------------------------------------------ 给提示词用

  /** 最近的亏（只有真记了账的） */
  recentLoss (n = 3, maxAgeMs = 6 * 60 * MIN) {
    const now = this.now()
    return this.losses
      .filter(l => l.verdict !== 'ok' && l.verdict !== 'short' && now - l.at <= maxAgeMs)
      .slice(-n)
      .reverse()
  }

  /** 栽过好几回的那些活（给提示词用） */
  dreadBlock (limit = 2) {
    const keys = Object.keys(this.fails)
      .filter(k => this.isDreaded(k))
      .sort((a, b) => this.failCount(b) - this.failCount(a))
      .slice(0, limit)
    if (!keys.length) return ''
    const titles = {}
    for (const l of this.losses) if (l.key) titles[l.key] = l.title
    const lines = ['## 有几件事你栽过好几回了']
    for (const k of keys) {
      const n = this.failCount(k)
      const t = titles[k] || k
      lines.push(`- 「${t}」栽了 ${n} 回，一提起来就有点不想碰`)
    }
    lines.push('不是不能碰，是别再照着老样子硬来 —— 换个地方、换个法子。')
    return lines.join('\n')
  }

  /**
   * 塞进提示词的一段话。
   *
   * 【为什么每行不带"X 分钟前"】
   * 实测（tone-researcher 照念测试）：账上写"两个来钟头前"，模型说出来变成
   * "昨天白耗了那么久" —— 时间戳被当成素材放大了。
   * 时间戳本来是给检索用的，进提示词就变成流水账格式。
   * 所以整段只给一个**粗窗口**（这一两个小时 / 这半天 / 这两天），
   * 由真实最老的那笔算出来；每行只留那件事本身。
   */
  lossBlock () {
    const list = this.recentLoss(3)
    const w = this.wearText()
    const d = this.dreadBlock()
    if (!list.length && !w && !d) return ''
    const lines = []
    if (list.length) {
      const oldest = Math.min.apply(null, list.map(l => l.at))
      const ageMin = (this.now() - oldest) / MIN
      const window = ageMin <= 90 ? '这一两个小时里' : ageMin <= 6 * 60 ? '这半天里' : '这两天里'
      lines.push(`## ${window}吃的亏（真花了时间的，别当没发生过）`)
      for (const l of list) lines.push(`- ${l.text}`)
    }
    if (d) lines.push(d)
    if (w) lines.push(`你现在的状态：${w}。`)
    if (list.length) lines.push('挑下一件事的时候掂量一下：别再挑那种磨半天出不了东西的活儿。')
    return lines.join('\n')
  }

  // ------------------------------------------------ 接线（不改 goals.js）

  /**
   * 在一个已经建好的 Goals 实例上包一层，三个口子：
   *   abandon()      -> 放弃时结算
   *   candidates()   -> 选目标时读记忆（避开栽过的地方 / 危险期 / 栽过的活）
   *   promptBlock()  -> 把最近的亏塞进提示词
   *
   * 为什么用实例包装而不是改 goals.js：goals.js 现在有人在改（#7 阈值 + 层3），
   * 直接动文件必打架。实例包装是零侵入的，等那边稳定了再挪进去也行 ——
   * settle() 是幂等的（_costSettled），两条路同时接也不会记两次账。
   */
  attach (goals) {
    CURRENT = this
    if (!goals || goals.__costAttached) return goals
    const self = this

    const origAbandon = goals.abandon.bind(goals)
    goals.abandon = function (reason, opts) {
      const g = this.goal
      const rec = origAbandon(reason, opts)
      // 只有真的放弃了（goal 没了 / 换了一个）才结账；
      // 被"最低寿命"闸门挡回来的时候 rec 是 null，不记。
      if (rec && g && this.goal !== g) {
        try {
          self.settle(g, { status: this.lastStatus, reason })
        } catch (e) {
          self.log('[cost] 结算出错: ' + e.message)
        }
      }
      return rec
    }

    const origCands = goals.candidates.bind(goals)
    goals.candidates = function (status) {
      const raw = origCands(status)
      try { return self.applyBias(raw, status) } catch (e) { return raw }
    }

    const origBlock = goals.promptBlock.bind(goals)
    goals.promptBlock = function () {
      const base = origBlock()
      try {
        const extra = self.lossBlock()
        return [base, extra].filter(Boolean).join('\n')
      } catch (e) { return base }
    }

    goals.__costAttached = true
    goals.cost = this
    CURRENT = this
    this.log(`[cost] 代价层挂上了（账 ${this.losses.length} 笔 / 避开区 ${this.zones.filter(z => z.until > this.now()).length} 片 / 栽过的活 ${Object.keys(this.fails).filter(k => this.isDreaded(k)).length} 件）`)
    return goals
  }

  // ------------------------------------------------ 报告

  stats () {
    return {
      losses: this.losses.length,
      white: this.losses.filter(l => l.verdict === 'white' || l.verdict === 'bitter').length,
      zones: this.zones.filter(z => z.until > this.now()).length,
      hazards: Object.keys(this.hazards).filter(k => this.hazardLeft(k) > 0),
      dreads: Object.keys(this.fails).filter(k => this.isDreaded(k)),
      wear: this.wear()
    }
  }
}

// ============================================================
// 4. 账本 -> 人话
// ============================================================

/**
 * 给人看的账单（日志 / 报告用）。
 * 「在这破地方折腾了四十来分钟，就挖了六块石头，不值」这种。
 */
function billText (bill) {
  const t = bill.time
  const { loot, burn } = parts(bill)
  const where = bill.zone ? '在这破地方' : '这一趟'
  // 跑老远是玩家最常抱怨的一件事：走了三百多格，说出来的话总得跟在家门口不一样
  const far = bill.dist >= 300 ? '，还跑老远' : ''
  const died = bill.deaths > 0 ? `，还死了${cnNum(bill.deaths)}回` : ''
  switch (bill.verdict) {
    case 'bitter': {
      // 有货的 bitter 也合法（勉强够本 + 赔命），不能说成"白扔了"。
      // 但"净赚却赔本"这件事得说出来 —— 只在搭进去的东西超过产出的一半时补，
      // 否则一句话里堆两三个数字，又变回报表。
      const showBurn = !!burn && bill.burn > bill.worth * 0.5
      return `${where}耗了${t}${loot ? '，就到手' + loot + (showBurn ? '，还搭进去' + burn : '') : ''}${died}${far}，亏`
    }
    case 'white':
      return `${where}折腾了${t}，${loot ? '就弄到' + loot : '啥也没弄到'}${far}，不值`
    case 'meh':
      return `${t}下来${loot ? '就' + loot : '没啥收获'}${bill.deaths ? '，还搭进去' + cnNum(bill.deaths) + '条命' : ''}，勉强够本`
    case 'ok':
      return `${t}换来${loot || '些东西'}，这趟没白跑${bill.deaths ? '，命差点没保住' : ''}`
    default:
      return `${t}，${loot || '基本没动静'}（太短，不记账）`
  }
}

/** 产出/搭进去，按人话拆好，两边文案共用 */
function parts (bill) {
  const loot = humanLoot(bill.gained)
  const spent = (bill.spent || []).filter(x => x.n > 0)
  const burn = (bill.burn > 0.5 && spent.length) ? humanGoods(spent[0].item, spent[0].n) : ''
  return { loot, burn }
}

/**
 * 写进记忆的那一句。要像人想的：
 *   ✓ 「记住这回：在那破地方耗了四十来分钟，就弄到两块圆石，不值」
 *   ✗ 「目标 house 放弃，耗时 2400 秒，产出 6」
 *
 * 前面带「记住这回」是故意的：那是教训信号，记忆准入会当"值得记"放进来。
 *
 * 【事实优先】记忆是给未来的自己看的，说错了以后会拿错经验：
 *   有货就不能说"白扔"，死了就必须提 —— 哪怕这是个"够本"的趟。
 *
 * 【落点】能落在"我以后怎么做"就别只落在"这地方不行"：
 *   地方是客观的，改不了；"下回我先探一探"才是他自己的做法。
 */
function memText (bill) {
  const t = bill.time
  const { loot, burn } = parts(bill)
  const far = bill.dist >= 300 ? '，还跑老远' : ''
  const diedN = cnNum(bill.deaths)
  switch (bill.verdict) {
    case 'bitter':
      // 有货：不许说"白扔了" —— 账上明明弄到了东西，只是代价太重
      if (loot) {
        const showBurn = !!burn && bill.burn > bill.worth * 0.5
        return `记住这回：${t}就弄到${loot}${showBurn ? '，还搭进去' + burn : ''}${far}，还死了${diedN}回，亏`
      }
      // 空手：说清搭进去什么、赔了几条命，落在"这地方不能再进"
      if (burn) return `记住这回：${t}白搭进去${burn}${far}，还死了${diedN}回，那地方不能再去`
      return `记住这回：${t}就这么白扔了${far}，还死了${diedN}回，那地方不能再去`
    case 'white':
      if (!loot) {
        // 两种说法轮着来，别每回都是一句 —— 真人同一个心情也有不同说法
        return (jitter(bill) % 2)
          ? `记住这回：在那边耗了${t}${far}，一块像样的都没弄着，白忙`
          : `记住这回：${t}就这么白搭进去了${far}，啥也没捞着`
      }
      return `记住这回：折腾${t}就弄到${loot}${burn ? '，还搭进去' + burn : ''}${far}，跟白干差不多`
    case 'meh': {
      // 够本但有代价：death 比"搭进去材料"更值一提
      const cost = bill.deaths > 0 ? `还搭进去${diedN}条命` : (burn ? `还搭进去${burn}` : '')
      return `${t}下来也就${loot || '那点东西'}${cost ? '，' + cost : ''}，勉强够本，下回我先探一探再说`
    }
    case 'ok':
      // 顺序有讲究：先认下"没白跑"，再补一句代价，读起来才是人话
      return bill.deaths > 0
        ? `${t}换来${loot || '些东西'}，这趟没白跑，命差点没保住`
        : `${t}换来${loot || '些东西'}${burn ? '，还搭进去' + burn : ''}，这趟没白跑`
    default:
      return ''
  }
}

/** 稳定的"随口换一种说法"：同样一笔账永远得到同一句话（可复现） */
function jitter (bill) {
  // 同一类活固定用一种说法：换着花样说会让"又白干一次"变成三条不同的记忆
  const key = `${bill.key || ''}|${bill.verdict || ''}`
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return h
}

/** 把一笔账压成"素材"（不带「记住这回」，给 spontaneous 组句子用） */
function lossMaterial (loss) {
  const l = loss || {}
  const t = humanMins(l.mins || 0)
  const loot = humanLoot(l.gained || [])
  const died = (l.deaths || 0) > 0 ? `，还死了${cnNum(l.deaths)}回` : ''
  const far = (l.dist || 0) >= 300 ? '，跑得还挺远' : ''
  if (!loot) return `折腾了${t}，啥也没弄到${died}${far}`
  return `折腾了${t}，就弄到${loot}${died}${far}`
}

/** 库存差值：a 有 b 没有的（正向增量），每项 {item, n}，按重量降序 */
function diffInv (a, b) {
  if (!a || !b) return []
  const out = []
  for (const [k, v] of Object.entries(b)) {
    const d = (Number(v) || 0) - (Number(a[k]) || 0)
    if (d > 0) out.push({ item: k, n: d })
  }
  out.sort((x, y) => y.n * priceOf(y.item) - x.n * priceOf(x.item))
  return out
}

/** 坐标 -> 一个能念出来的地方名（不编名字，就用方位和大坐标） */
function placeName (p) {
  if (!p) return '那边'
  const ns = p.z >= 0 ? '南' : '北'
  const ew = p.x >= 0 ? '东' : '西'
  const deep = p.y < 40
  const up = p.y > 70
  const kind = deep ? '底下' : up ? '高处' : ''
  // 东南 / 西北 这种说法中国人念着顺
  return `${ew}${ns}${kind}那一片`
}

/**
 * 毫秒 -> 人话时长（给不想自己换算的调用方，比如台词/旁白）。
 * 和 humanMins 是一对：humanMins 吃分钟，这个吃毫秒。
 */
function humanDuration (ms) {
  return humanMins((Number(ms) || 0) / MIN)
}

module.exports = {
  Cost,
  /** 当前登记的实例（没有就是 null） */
  currentInstance () { return CURRENT },
  // 给测试和外部看的小工具
  humanMins,
  humanDuration,
  humanGoods,
  humanLoot,
  cnNum,
  priceOf,
  classifyDeath,
  billText,
  memText,
  lossMaterial,
  diffInv,
  placeName,
  VALUE
}
