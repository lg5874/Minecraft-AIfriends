'use strict'
/**
 * 家。
 *
 * 真人玩家都有个基地。他没有 ——
 *   · 走远了迷路
 *   · 死了回出生点，出生点周围的资源早挖光了
 *   · 不会自己走回去，每次上线等于从零开始
 *
 * 这个模块补四件事：
 *
 *   1. 认家   第一次放下箱子 / 工作台 / 床，就把那儿当家。
 *             优先级 床 > 箱子 > 工作台 —— 放了床基本就是在说"我住这儿"。
 *
 *   2. 回家   goHome() 真寻路走回去。服务器没有 /home 插件，只能靠自己走。
 *             先试直线 A*，走不通就沿出门时记下的面包屑退回去，
 *             再不行就只对齐水平坐标（GoalNearXZ），高度交给寻路自己处理。
 *
 *   3. 认路   出门时每隔十几格记一个点（trail）。这就是"记得怎么回来"。
 *             回来路上够近了就把 trail 清空，不然越攒越乱。
 *
 *   4. 家附近优先   找资源时把搜索中心放在家附近，而不是脚底下。
 *             走远了先想到"回家拿/回家挖"，而不是就地开荒。
 *
 * 数据落盘：data/runtime/home.json（跟记忆同一个目录，原子写）。
 *
 * 注意：这个模块不碰 src/actions.js，需要的新动作（walkTo / goHome）都在这里自己写。
 */

const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')

const sleep = ms => new Promise(r => setTimeout(r, ms))

const ROOT = path.resolve(__dirname, '..')

/** 认定"这是家"的方块。数字越大越算数。 */
const ANCHOR_RANK = {
  bed: 3,        // 所有 *_bed，见 anchorRank()
  chest: 2,
  trapped_chest: 2,
  barrel: 2,
  crafting_table: 1
}

/** 床的方块名还没认出来时的兜底（防止 registry 缺项） */
function anchorRank (name) {
  if (!name) return 0
  if (/_bed$/.test(name)) return ANCHOR_RANK.bed
  return ANCHOR_RANK[name] || 0
}

/** 中文叫法，落盘和说话都用得上 */
function anchorWord (name) {
  if (!name) return '东西'
  if (/_bed$/.test(name)) return '床'
  if (name === 'crafting_table') return '工作台'
  if (name === 'barrel') return '木桶'
  if (/chest/.test(name)) return '箱子'
  return name
}

const MAX_TRAIL = 120          // 面包屑最多记多少个点
const TRAIL_GAP = 12           // 走出 12 格记一个点
const HOME_RADIUS = 8          // 离这么近就算到家了（清 trail 用）
const DEFAULT_NEAR = 48        // "家附近"的默认半径

class Home {
  /**
   * @param {object} bot  mineflayer bot
   * @param {object} [ctx]
   * @param {string} [ctx.dataDir]   数据目录（默认 data/runtime，跟记忆同目录）
   * @param {string} [ctx.filename]  文件名（默认 home.json；测试用 home.test.json）
   * @param {function} [ctx.log]
   * @param {object} [ctx.mem]       有的话顺便写进记忆的 places（提示词里就能看见"家"）
   * @param {object} [ctx.actions]   有的话寻路失败时能借 actions.goto 兜底
   */
  constructor (bot, ctx = {}) {
    this.bot = bot
    this.ctx = ctx
    this.log = ctx.log || (() => {})
    this.mem = ctx.mem || null
    this.actions = ctx.actions || null

    this.dir = ctx.dataDir
      ? path.resolve(ROOT, ctx.dataDir)
      : (process.env.AIFRIEND_DATA
          ? path.resolve(ROOT, process.env.AIFRIEND_DATA)
          : path.join(ROOT, 'data', 'runtime'))
    this.file = path.join(this.dir, ctx.filename || 'home.json')

    this.home = null       // { x, y, z, dim, rank, anchor, reason, at }
    this.trail = []        // [{ x, y, z, t }] 出门的路
    this.stats = { goHomeRuns: 0, goHomeOk: 0, setCount: 0, lastGoHomeAt: 0 }
    this.cancel = false

    this._timer = null
    this._attached = false
    this.load()
  }

  // ==================== 落盘 ====================

  load () {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const d = JSON.parse(raw || '{}')
      if (d && d.home && Number.isFinite(Number(d.home.x))) {
        this.home = {
          x: Math.round(Number(d.home.x)),
          y: Math.round(Number(d.home.y)),
          z: Math.round(Number(d.home.z)),
          dim: d.home.dim || null,
          rank: Number(d.home.rank) || 1,
          anchor: d.home.anchor || null,
          reason: d.home.reason || '',
          at: Number(d.home.at) || 0
        }
      }
      if (Array.isArray(d.trail)) {
        this.trail = d.trail
          .filter(p => p && Number.isFinite(Number(p.x)))
          .map(p => ({ x: Math.round(Number(p.x)), y: Math.round(Number(p.y)), z: Math.round(Number(p.z)), t: Number(p.t) || 0 }))
          .slice(-MAX_TRAIL)
      }
      if (d.stats) Object.assign(this.stats, d.stats)
    } catch (e) {
      // 第一次跑没有文件，正常
    }
  }

  save () {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify({
        version: 1,
        home: this.home,
        trail: this.trail,
        stats: this.stats,
        savedAt: Date.now()
      }, null, 0), 'utf8')
      fs.renameSync(tmp, this.file)
      return true
    } catch (e) {
      this.log('[home] 存不下：' + e.message)
      return false
    }
  }

  // ==================== 认家 ====================

  /**
   * 挂上监听。主程序连上 bot 之后调一次。
   * 之后：放箱子/工作台/床 -> 自动认家；每 1.5 秒记一次出门的路。
   */
  attach () {
    if (this._attached || !this.bot) return this
    this._attached = true

    // 1) 自己放下的方块（mineflayer 的 blockPlaced 只对自己放置触发）
    this._onPlaced = (oldBlock, newBlock) => {
      try { this.onBlockPlaced(newBlock) } catch (e) { this.log('[home] 认家出错：' + e.message) }
    }
    try { this.bot.on('blockPlaced', this._onPlaced) } catch (e) {}

    // 2) 刚出生/重连：脚边要是有现成的家具，直接认
    this._onSpawn = () => {
      setTimeout(() => { try { this.recognize(14) } catch (e) {} }, 2500)
    }
    try { this.bot.on('spawn', this._onSpawn) } catch (e) {}

    // 3) 出门记路
    this._timer = setInterval(() => {
      try { this.tick() } catch (e) {}
    }, 1500)
    if (this._timer.unref) this._timer.unref()

    // 已在线的情况下先识一次
    if (this.bot.entity) setTimeout(() => { try { this.recognize(14) } catch (e) {} }, 2500)

    this.log('[home] ' + (this.home ? `认得家：${this.home.x},${this.home.y},${this.home.z}` : '还没有家'))
    return this
  }

  detach () {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
    if (this.bot && this._onPlaced) { try { this.bot.removeListener('blockPlaced', this._onPlaced) } catch (e) {} }
    if (this.bot && this._onSpawn) { try { this.bot.removeListener('spawn', this._onSpawn) } catch (e) {} }
    this._attached = false
  }

  /** 自己刚放下一块方块 */
  onBlockPlaced (block) {
    if (!block || !block.position) return null
    const rank = anchorRank(block.name)
    if (!rank) return null
    const pos = block.position
    const p = this.pos()
    // 只认自己脚边的（放方块一定是自己旁边）
    if (p && p.distanceTo(pos) > 20) return null

    const word = anchorWord(block.name)

    if (!this.home) {
      return this.setHome(pos, `放下了${word}`, { rank, anchor: block.name })
    }

    const distOld = this.distanceFromHome(pos)

    // 床放在远处 => 换家了（床是最硬的家信号）
    if (rank >= ANCHOR_RANK.bed && distOld > 64) {
      return this.setHome(pos, `在新地方放下了${word}`, { rank, anchor: block.name })
    }
    // 同一片地方，放了更硬的东西 => 家挪到它上面
    if (rank > (this.home.rank || 1) && distOld <= 24) {
      return this.setHome(pos, `放下了${word}`, { rank, anchor: block.name })
    }
    return null
  }

  /**
   * 扫脚边，看有没有现成的家具（第一次上线、或者别人帮他盖好了）。
   * @param {number} radius
   */
  recognize (radius = 14) {
    if (!this.bot || !this.bot.entity) return this.home
    const ids = this._anchorIds()
    if (!ids.length) return this.home
    let found = []
    try {
      const pts = this.bot.findBlocks({
        matching: ids,
        point: this.bot.entity.position,
        maxDistance: radius,
        count: 24
      })
      found = pts.map(pt => this.bot.blockAt(pt)).filter(Boolean)
    } catch (e) {
      return this.home
    }
    if (!found.length) return this.home

    found.sort((a, b) => {
      const ra = anchorRank(a.name)
      const rb = anchorRank(b.name)
      if (ra !== rb) return rb - ra
      return a.position.distanceTo(this.bot.entity.position) - b.position.distanceTo(this.bot.entity.position)
    })

    const best = found[0]
    const rank = anchorRank(best.name)
    if (this.home && rank <= (this.home.rank || 1)) return this.home
    return this.setHome(best.position, `脚边有${anchorWord(best.name)}`, { rank, anchor: best.name })
  }

  _anchorIds () {
    const reg = this.bot && this.bot.registry && this.bot.registry.blocksByName
    if (!reg) return []
    const ids = []
    for (const [name, def] of Object.entries(reg)) {
      if (anchorRank(name) > 0 && def && Number.isFinite(def.id)) ids.push(def.id)
    }
    return ids
  }

  /**
   * 把某个位置定成家。
   * @param {{x:number,y:number,z:number}} pos
   * @param {string} reason 为什么是这儿（会写进记忆）
   * @param {{rank?:number, anchor?:string}} [opts]
   */
  setHome (pos, reason = '', opts = {}) {
    if (!pos || !Number.isFinite(Number(pos.x))) return null
    this.home = {
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      z: Math.round(pos.z),
      dim: this._dim(),
      rank: opts.rank || 1,
      anchor: opts.anchor || null,
      reason: reason || '',
      at: Date.now()
    }
    this.stats.setCount = (this.stats.setCount || 0) + 1
    this.trail = []          // 新家，旧路作废
    this.save()
    this.log(`[home] 认家了：${this.home.x},${this.home.y},${this.home.z}（${reason || '手动'}）`)
    // 让记忆层也知道"家"在哪（提示词里就能想起来）
    if (this.mem && typeof this.mem.place === 'function') {
      try { this.mem.place('家', this.homePos(), '我的落脚点：' + (reason || '手动设的')) } catch (e) {}
    }
    return this.home
  }

  /** 手动换家（外部想设就调这个） */
  markHome (pos, reason) {
    return this.setHome(pos, reason || '手动设的', { rank: 9, anchor: 'manual' })
  }

  clear () {
    this.home = null
    this.trail = []
    this.save()
    this.log('[home] 家的记录清掉了')
  }

  get hasHome () { return !!this.home }

  homePos () {
    return this.home ? new Vec3(this.home.x, this.home.y, this.home.z) : null
  }

  _dim () {
    const g = this.bot && this.bot.game
    return (g && (g.dimension || g.dimensionName)) || null
  }

  pos () {
    return (this.bot && this.bot.entity && this.bot.entity.position) || null
  }

  // ==================== 认路 ====================

  /**
   * 记面包屑。主循环或 attach 的定时器调都行。
   * 规则：离家 8 格以内清空；每走出 12 格记一个点；最多 120 个。
   */
  tick () {
    const p = this.pos()
    if (!p || !this.home) return
    const d = this.distanceFromHome(p)

    if (d < HOME_RADIUS) {
      if (this.trail.length) {
        this.trail = []
        this.save()
      }
      return
    }

    const last = this.trail[this.trail.length - 1]
    if (last) {
      const moved = Math.hypot(p.x - last.x, p.z - last.z)
      if (moved < TRAIL_GAP) return
    }

    this.trail.push({ x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z), t: Date.now() })
    if (this.trail.length > MAX_TRAIL) this.trail.shift()
    this.save()
  }

  /** 出门的路（近端在前，远端在后） */
  get route () { return this.trail.slice() }

  // ==================== 回家 ====================

  stop () {
    this.cancel = true
    try { this.bot.pathfinder.setGoal(null) } catch (e) {}
    try {
      for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) {
        this.bot.setControlState(k, false)
      }
    } catch (e) {}
  }

  /**
   * 走回家。
   *
   * 三条路依次试：
   *   1. 直线 A* 到家的高度
   *   2. 顺着出门时记的面包屑退回去（认路）
   *   3. 只要水平坐标对齐（GoalNearXZ），高度让寻路自己挖/垫
   *
   * @returns {Promise<{ok:boolean, seconds:number, dist:number, from:object, to:object, legs:Array, reason?:string}>}
   */
  async goHome (opts = {}) {
    this.cancel = false
    const t0 = Date.now()
    const timeoutMs = opts.timeoutMs || 150000
    const range = opts.range == null ? 2 : opts.range

    const p0 = this.pos()
    if (!p0) return { ok: false, seconds: 0, dist: Infinity, reason: '没有位置信息', legs: [] }
    if (!this.home) return { ok: false, seconds: 0, dist: Infinity, reason: '还没认家', legs: [] }

    const dim = this._dim()
    if (this.home.dim && dim && this.home.dim !== dim) {
      return { ok: false, seconds: 0, dist: Infinity, reason: `不在同一个世界（家在 ${this.home.dim}）`, legs: [] }
    }

    const startDist = this.distanceFromHome(p0)
    const legs = []

    this.log(`[home] 回家：现在离家 ${startDist.toFixed(1)} 格`)
    if (startDist <= range + 1.5) {
      return { ok: true, seconds: 0, dist: startDist, already: true, from: p0, to: p0.clone(), legs }
    }

    this.stats.goHomeRuns = (this.stats.goHomeRuns || 0) + 1
    this.stats.lastGoHomeAt = Date.now()

    const left = () => timeoutMs - (Date.now() - t0)

    // ---- 1. 直线走回去 ----
    let leg = await this._leg('direct', () => this._walkTo(this.home.x, this.home.y, this.home.z, {
      range: opts.range == null ? 2 : opts.range,
      timeoutMs: Math.min(Math.max(20000, startDist * 1400), Math.max(8000, left() - 5000))
    }))
    legs.push(leg)

    // ---- 2. 沿着出门的路退回去 ----
    if (!leg.ok && !this.cancel && this.trail.length && left() > 8000) {
      leg = await this._leg('trail', () => this._followTrail({ leftMs: left() - 4000, range: opts.range == null ? 2 : opts.range }))
      legs.push(leg)
      if (leg.ok) {
        // 退回来路了，再补最后一段
        const l2 = await this._leg('final', () => this._walkTo(this.home.x, this.home.y, this.home.z, {
          range: 2, timeoutMs: Math.max(8000, Math.min(45000, left() - 2000))
        }))
        legs.push(l2)
        if (!l2.ok) leg = l2
      }
    }

    // ---- 3. 只对齐水平坐标，高度交给寻路 ----
    if (!leg.ok && !this.cancel && left() > 6000) {
      leg = await this._leg('xz', () => this._walkTo(this.home.x, this.home.y, this.home.z, {
        xz: true,
        range: 2,
        timeoutMs: Math.max(6000, Math.min(60000, left() - 2000))
      }))
      legs.push(leg)
      if (leg.ok) {
        const l2 = await this._leg('xz-final', () => this._walkTo(this.home.x, this.home.y, this.home.z, {
          range: 2, timeoutMs: Math.max(5000, Math.min(25000, left()))
        }))
        legs.push(l2)
        if (!l2.ok) leg = l2
      }
    }

    const p1 = this.pos()
    const finalDist = p1 ? this.distanceFromHome(p1) : Infinity
    const ok = finalDist <= range + 3
    const seconds = Math.round((Date.now() - t0) / 100) / 10

    if (ok) {
      this.stats.goHomeOk = (this.stats.goHomeOk || 0) + 1
      this.trail = []                 // 到家了，路清了
      this.stats.lastHomeAt = Date.now()
    } else if (p1) {
      // 没到家也别把路丢了
      try { this.tick() } catch (e) {}
    }
    this.save()

    this.log(`[home] ${ok ? '到家了' : '没到家'}：${seconds}s，还差 ${finalDist.toFixed(1)} 格`)
    return {
      ok,
      seconds,
      dist: finalDist,
      startDist,
      from: p0,
      to: p1,
      legs,
      reason: ok ? '' : (this.cancel ? '被中断' : '走不回去')
    }
  }

  async _leg (name, fn) {
    const t0 = Date.now()
    let r
    try {
      r = await fn()
      if (r === true) r = { ok: true }
      if (!r || typeof r !== 'object') r = { ok: false, reason: '没返回' }
    } catch (e) {
      r = { ok: false, reason: e.message }
    }
    return { name, ok: !!r.ok, seconds: Math.round((Date.now() - t0) / 100) / 10, dist: r.dist, reason: r.reason }
  }

  /** 沿着出门的路退回去 */
  async _followTrail ({ leftMs = 60000, range = 2 } = {}) {
    const deadline = () => leftMs - 0
    const t0 = Date.now()
    const left = () => deadline() - (Date.now() - t0)

    const p = this.pos()
    if (!p) return { ok: false, reason: '没有位置信息' }
    const cur = this.distanceFromHome(p)
    // 比现在离得远的点没用；按"离家从远到近"退回去
    const cand = this.trail
      .filter(w => this.distanceFromHome(w) < cur - 6)
      .sort((a, b) => this.distanceFromHome(b) - this.distanceFromHome(a))
      .slice(0, 10)

    if (!cand.length) return { ok: false, reason: '没有可用的路标' }

    let moved = 0
    for (const w of cand) {
      if (this.cancel || left() < 4000) break
      const r = await this._walkTo(w.x, w.y, w.z, {
        range: Math.max(2, range),
        timeoutMs: Math.min(20000, Math.max(4000, left() - 1500))
      })
      if (r.ok) moved++
      if (this.distanceFromHome(this.pos()) < 6) break
    }
    return { ok: moved > 0, dist: this.distanceFromHome(this.pos()), reason: moved ? '' : '路标都走不到' }
  }

  /**
   * 自己写的寻路动作。actions.js 一个字没改。
   *
   * @param {number} x @param {number} y @param {number} z
   * @param {{range?:number, timeoutMs?:number, xz?:boolean}} opts xz=true 时只对齐水平坐标
   * @returns {Promise<{ok:boolean, seconds:number, dist:number, reason?:string}>}
   */
  async walkTo (x, y, z, opts = {}) {
    return this._walkTo(x, y, z, opts)
  }

  async _walkTo (x, y, z, opts = {}) {
    const t0 = Date.now()
    x = Number(x); y = Number(y); z = Number(z)
    if (![x, y, z].every(Number.isFinite)) {
      return { ok: false, seconds: 0, dist: Infinity, reason: '坐标无效' }
    }
    const range = opts.range == null ? 2 : opts.range
    const timeoutMs = opts.timeoutMs || 30000
    const useXZ = !!opts.xz

    const bot = this.bot
    const pf = bot && bot.pathfinder

    // 没有寻路插件时退到 actions.goto（有就给，没有就算了）
    if (!pf || !bot.entity) {
      if (this.actions && typeof this.actions.goto === 'function') {
        let ok = false
        try { ok = await this.actions.goto(x, y, z, range, timeoutMs) } catch (e) { ok = false }
        return { ok, seconds: Math.round((Date.now() - t0) / 100) / 10, dist: this._hDist(x, z), reason: ok ? '' : 'actions.goto 走不通' }
      }
      return { ok: false, seconds: 0, dist: Infinity, reason: '没有寻路插件' }
    }

    const goal = useXZ
      ? new goals.GoalNearXZ(Math.floor(x), Math.floor(z), Math.max(1, Math.floor(range)))
      : new goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), Math.max(1, Math.floor(range)))

    try { pf.setGoal(goal) } catch (e) {
      return { ok: false, seconds: 0, dist: Infinity, reason: '设目标失败：' + e.message }
    }

    let still = 0
    let last = bot.entity.position.clone()
    try {
      while (Date.now() - t0 < timeoutMs) {
        if (this.cancel) return { ok: false, seconds: this._sec(t0), dist: this._hDist(x, z), reason: '被中断' }

        const p = bot.entity.position
        const dxz = Math.hypot(p.x - x, p.z - z)
        const dy = Math.abs(p.y - y)
        // 水平到了就算到（xz 模式不看高度；正常模式垂直也得对）
        if (dxz <= range + 1.5 && (useXZ || dy <= 2.5)) {
          return { ok: true, seconds: this._sec(t0), dist: dxz, dy: Math.round(dy * 10) / 10 }
        }

        const moved = p.distanceTo(last)
        last = p.clone()
        if (moved < 0.05) still += 200
        else still = 0
        if (still > 5000) {
          return { ok: false, seconds: this._sec(t0), dist: dxz, reason: '卡住不动' }
        }
        await sleep(200)
      }
      return { ok: false, seconds: this._sec(t0), dist: this._hDist(x, z), reason: '超时' }
    } finally {
      try { pf.setGoal(null) } catch (e) {}
      try {
        for (const k of ['forward', 'back', 'left', 'right']) bot.setControlState(k, false)
      } catch (e) {}
    }
  }

  _sec (t0) { return Math.round((Date.now() - t0) / 100) / 10 }

  _hDist (x, z) {
    const p = this.pos()
    if (!p) return Infinity
    return Math.hypot(p.x - x, p.z - z)
  }

  // ==================== 家附近优先 ====================

  distanceFromHome (pos) {
    if (!this.home) return Infinity
    const p = pos || this.pos()
    if (!p) return Infinity
    return Math.hypot(p.x - this.home.x, p.y - this.home.y, p.z - this.home.z)
  }

  /** 水平距离（判断"走远了"更准，别被上下几十格误导） */
  hDistanceFromHome (pos) {
    if (!this.home) return Infinity
    const p = pos || this.pos()
    if (!p) return Infinity
    return Math.hypot(p.x - this.home.x, p.z - this.home.z)
  }

  isNearHome (pos, radius = DEFAULT_NEAR) {
    return this.hDistanceFromHome(pos) <= radius
  }

  isFarFromHome (threshold = 96, pos) {
    const d = this.hDistanceFromHome(pos)
    return Number.isFinite(d) && d > threshold
  }

  /** 0..1，越接近家越大。给打分用 */
  homeAffinity (pos, radius = DEFAULT_NEAR) {
    const d = this.hDistanceFromHome(pos)
    if (!Number.isFinite(d)) return 0
    return 1 / (1 + d / radius)
  }

  /**
   * 在家附近搜方块 —— 搜索中心是家，不是脚底下。
   * @param {string|string[]} names
   * @param {{radius?:number, count?:number}} [opts]
   * @returns {Array<object>} 方块（按离家远近排好）
   */
  findNearHome (names, opts = {}) {
    const radius = opts.radius || DEFAULT_NEAR
    const count = opts.count || 4
    if (!this.home || !this.bot) return []
    const reg = this.bot.registry && this.bot.registry.blocksByName
    if (!reg) return []
    const list = Array.isArray(names) ? names : [names]
    const ids = list.map(n => reg[n]).filter(Boolean).map(d => d.id)
    if (!ids.length) return []
    let found = []
    try {
      const pts = this.bot.findBlocks({
        matching: ids,
        point: this.homePos(),
        maxDistance: radius,
        count
      })
      found = pts.map(pt => this.bot.blockAt(pt)).filter(Boolean)
    } catch (e) {
      return []
    }
    const h = this.homePos()
    found.sort((a, b) => a.position.distanceTo(h) - b.position.distanceTo(h))
    return found
  }

  /**
   * 把候选按"离家的远近"重排：家附近的排前面。
   * @param {Array} items
   * @param {function} [getPos] 从 item 取坐标，默认 item.position || item.pos
   */
  rankByHome (items, getPos) {
    if (!this.home || !Array.isArray(items)) return items || []
    const gp = getPos || (it => it && (it.position || it.pos || it))
    const h = this.homePos()
    return items
      .map((it, i) => {
        const p = gp(it)
        const d = p && Number.isFinite(Number(p.x)) ? h.distanceTo(p) : Infinity
        return { it, i, d }
      })
      .sort((a, b) => (a.d - b.d) || (a.i - b.i))
      .map(s => s.it)
  }

  // ==================== 给主程序 / 提示词用 ====================

  /** 方位词：从当前位置看，家在哪边 */
  homeDirection (pos) {
    if (!this.home) return ''
    const p = pos || this.pos()
    if (!p) return ''
    const dx = this.home.x - p.x
    const dz = this.home.z - p.z
    const ns = dz < 0 ? '北' : '南'
    const ew = dx > 0 ? '东' : '西'
    if (Math.abs(dx) < 8 && Math.abs(dz) < 8) return '就在附近'
    if (Math.abs(dx) < 8) return ns
    if (Math.abs(dz) < 8) return ew
    return ns + ew
  }

  /** 一句中文，能直接塞进提示词 */
  summary () {
    if (!this.home) return '还没有家。找个合适的地方放下箱子或床，那儿就是家。'
    const d = this.hDistanceFromHome()
    const where = `${this.home.x},${this.home.y},${this.home.z}`
    const what = this.home.anchor ? anchorWord(this.home.anchor) : (this.home.reason || '据点')

    if (!Number.isFinite(d)) return `家记在 ${where}（${what}）。`
    if (d <= HOME_RADIUS) return `家就在脚下（${where}，${what}）。`

    const dir = this.homeDirection()
    const side = dir && dir !== '就在附近' ? `${dir}边，` : ''
    const mins = Math.max(1, Math.round(d / 25))
    return `家记在 ${where}（${what}），${side}约 ${Math.round(d)} 格，走回去大概 ${mins} 分钟。`
  }

  status () {
    return {
      hasHome: !!this.home,
      home: this.home,
      fromHome: Number.isFinite(this.hDistanceFromHome()) ? Math.round(this.hDistanceFromHome()) : null,
      direction: this.homeDirection(),
      trail: this.trail.length,
      stats: this.stats,
      file: this.file
    }
  }
}

module.exports = { Home, anchorRank, anchorWord, HOME_FILE: 'home.json' }
