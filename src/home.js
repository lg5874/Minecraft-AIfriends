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

// 垂直一格的"回家代价"相当于水平几格。
// 实测：水平 80 格走过去约 40 秒；垂直 40 格要挖楼梯/垫柱子，1~3 分钟还常卡住。
const VERTICAL_COST = 3

// 回家代价的阈值（单位 = 水平格数，垂直已加权）
const SOFT_HOME_COST = 100     // 到这儿开始"有点远"，会在上下文里提一句
const HARD_HOME_COST = 140     // 到这儿该主动往回走了

// 地下多深算"该考虑回家"。地面 y≈64，他实测能挖到 y=18。
const DEEP_UNDERGROUND = 25

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

    // 总超时按距离算。
    //
    // 原来写死 150 秒。实测：离家 106.8 格，150 秒只推进了 68 格
    //（106.8 → 39.0），然后报"走不回去"—— 差 39 格。
    // 真人走路也不会"15 分钟没到家就永远不回了"。
    // 2 秒/格是实测速度（水平），留一倍余量；下限 60 秒，上限 10 分钟。
    const timeoutMs = opts.timeoutMs ||
      Math.max(60000, Math.min(startDist * 2000, 600000))
    const left = () => timeoutMs - (Date.now() - t0)

    this.stats.goHomeRuns = (this.stats.goHomeRuns || 0) + 1
    this.stats.lastGoHomeAt = Date.now()

    // ---- 分段走 ----
    //
    // 为什么分段：一次 setGoal 走到底，pathfinder 中途规划失败就整趟结束，
    // 后面 40 格再也没机会。分段后每段从"现在的位置"重新规划一次，
    // 相当于每走一段就重新看一眼路。
    //
    // 每段之后检查"有没有比段前更近"：连续两段没进展就认输，
    // 不然会在原地磨到超时。
    let best = startDist
    let stall = 0
    let segIndex = 0
    const MAX_SEGMENTS = 8
    let reached = false

    for (segIndex = 0; segIndex < MAX_SEGMENTS; segIndex++) {
      if (this.cancel) break
      if (left() < 8000) break

      const segBefore = this.distanceFromHome(this.pos())
      const r = await this._oneSegment(range, left)
      for (const l of r.legs) legs.push(Object.assign({ seg: segIndex + 1 }, l))
      if (r.ok) { reached = true; break }

      const segAfter = this.distanceFromHome(this.pos())
      if (segAfter <= range + 3) { reached = true; break }

      if (segAfter < segBefore - 4) {
        stall = 0
        best = Math.min(best, segAfter)
        this.log(`[home] 第 ${segIndex + 1} 段：${Math.round(segBefore)} → ${Math.round(segAfter)} 格`)
      } else {
        stall++
        this.log(`[home] 第 ${segIndex + 1} 段没往前走（${Math.round(segBefore)} → ${Math.round(segAfter)}）`)
        // 连续 3 段都推不动才认输。实测地形会有一段走不动（悬崖/水/树墙），
        // 换条策略往往下一段就通了，急着放弃等于白走前面那几十格。
        if (stall >= 3) {
          this.log('[home] 连续 3 段没进展，不硬耗了')
          break
        }
      }
    }

    const p1 = this.pos()
    const finalDist = p1 ? this.distanceFromHome(p1) : Infinity
    const ok = reached || finalDist <= range + 3
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

    this.log(`[home] ${ok ? '到家了' : '没到家'}：${seconds}s，${segIndex} 段，还差 ${finalDist.toFixed(1)} 格`)
    return {
      ok,
      seconds,
      dist: finalDist,
      startDist,
      best,
      segments: segIndex,
      from: p0,
      to: p1,
      legs,
      reason: ok ? '' : (this.cancel ? '被中断' : (stall >= 2 ? '走不回去（两段都没进展）' : '走不回去'))
    }
  }

  /**
   * 走一段。三条策略依次试，跟原来一样，但预算由调用方给（分段共用总超时）。
   * @returns {Promise<{ok:boolean, legs:Array}>}
   */
  async _oneSegment (range, left) {
    const legs = []
    // 每段的预算。
    //
    // 给太多 = 分段没意义（direct 一口气吃掉全部时间，走不通就没机会重规划）。
    // 给太少 = 每段都"超时"，实测 45 秒只走十几格，反而走不完。
    // 取剩余时间的一半、夹在 30~120 秒之间：direct 走一段，然后从新位置
    // 重新规划一次 —— 这正是分段的收益。
    const budget = () => {
      const rem = left() - 3000
      return Math.max(15000, Math.min(Math.floor(rem * 0.5), Math.min(120000, rem)))
    }

    // ---- 1. 直线走回去 ----
    let leg = await this._leg('direct', () => this._walkTo(this.home.x, this.home.y, this.home.z, {
      range, timeoutMs: budget()
    }))
    legs.push(leg)
    if (leg.ok) return { ok: true, legs }

    // ---- 2. 沿着出门的路退回去 ----
    if (!this.cancel && this.trail.length && left() > 8000) {
      leg = await this._leg('trail', () => this._followTrail({
        leftMs: Math.max(5000, Math.min(30000, left() - 4000)),
        range
      }))
      legs.push(leg)
      if (leg.ok) {
        const l2 = await this._leg('final', () => this._walkTo(this.home.x, this.home.y, this.home.z, {
          range, timeoutMs: budget()
        }))
        legs.push(l2)
        return { ok: l2.ok, legs }
      }
    }

    // ---- 3. 只对齐水平坐标，高度交给寻路 ----
    if (!this.cancel && left() > 6000) {
      leg = await this._leg('xz', () => this._walkTo(this.home.x, this.home.y, this.home.z, {
        xz: true, range, timeoutMs: budget()
      }))
      legs.push(leg)
      if (leg.ok) {
        const l2 = await this._leg('xz-final', () => this._walkTo(this.home.x, this.home.y, this.home.z, {
          range, timeoutMs: Math.max(5000, Math.min(20000, left()))
        }))
        legs.push(l2)
        return { ok: l2.ok, legs }
      }
    }

    return { ok: false, legs }
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

  /** 垂直距离（离家的高差） */
  vDistanceFromHome (pos) {
    if (!this.home) return Infinity
    const p = pos || this.pos()
    if (!p) return Infinity
    return Math.abs(p.y - this.home.y)
  }

  /**
   * "回趟家有多费劲" —— 水平一格算 1，垂直一格算 3。
   *
   * 为什么垂直要加权：水平 80 格是走过去 40 秒的事，垂直 40 格要挖
   * 楼梯或者垫柱子爬上去，实测一次要 1~3 分钟，而且经常卡住。
   * 旧实现只用水平距离，于是「水平 82 格 / 垂直 46 格」被判成"不远"，
   * 他在地下 40 多格深的地方一直挖，永远不会想到回家 ——
   * 这就是用户说的「每次见到他他都在地下」。
   */
  walkCostHome (pos) {
    const h = this.hDistanceFromHome(pos)
    const v = this.vDistanceFromHome(pos)
    if (!Number.isFinite(h) || !Number.isFinite(v)) return Infinity
    return h + v * VERTICAL_COST
  }

  isNearHome (pos, radius = DEFAULT_NEAR) {
    return this.hDistanceFromHome(pos) <= radius
  }

  /**
   * 离家远不远。
   *
   * @param {number} [threshold] 默认 96（"再挖下去也是荒的"的经验线）
   * @param {object} [pos]
   * @param {boolean} [weighted] true = 按 walkCostHome（垂直×3）算。
   *        默认 true —— 旧的纯水平判定会把"地下 46 格深"当成近。
   */
  isFarFromHome (threshold = 96, pos, weighted = true) {
    const d = weighted ? this.walkCostHome(pos) : this.hDistanceFromHome(pos)
    return Number.isFinite(d) && d > threshold
  }

  /** 0..1，越接近家越大。给打分用 */
  homeAffinity (pos, radius = DEFAULT_NEAR) {
    const d = this.walkCostHome(pos)
    if (!Number.isFinite(d)) return 0
    return 1 / (1 + d / radius)
  }

  /**
   * 现在该不该往回走？
   *
   * 旧实现只有"复活后离家 >96 才回家"这一条触发路径 —— 也就是说
   * **不死就永远不回家**。他在地下越挖越深，家在身后 90 格远、
   * 46 格高，却没有任何理由往回走。
   *
   * 这里给主循环一个明确的判断：什么时候"回家"比"继续干"更划算。
   * 不是"离家就回"（那样没法干活），而是**代价已经超过收益**时才回：
   *
   *   · 太远了（walkCost > 140）—— 走一趟要几分钟，再挖下去更回不去
   *   · 在地下很深（y 差 > 25）—— 越挖越深，回家的路只会更难
   *   · 背包快满了 —— 本来就该回去卸货
   *   · 工具快没了 / 没吃的 —— 家里有存货
   *
   * @param {object} [st] actions.status() 的形状（能拿到背包/血/饿就更好）
   * @returns {{should:boolean, why:string, urgency:number, cost:number}}
   */
  shouldHeadHome (st) {
    const none = { should: false, why: '', urgency: 0, cost: null }
    if (!this.home) return none
    const p = this.pos()
    if (!p) return none

    const cost = this.walkCostHome(p)
    const v = this.vDistanceFromHome(p)
    if (!Number.isFinite(cost)) return none

    // 已经在家附近：不用回（但仍然把代价带出去，方便调用方判断）
    if (this.hDistanceFromHome(p) <= HOME_RADIUS && v <= 6) {
      return { should: false, why: '已经在家', urgency: 0, cost }
    }

    const why = []
    let urgency = 0

    // 1) 走一趟的代价已经很大
    if (cost > HARD_HOME_COST) { why.push(`离家太远（走回去约 ${Math.round(cost / 25)} 分钟）`); urgency = Math.max(urgency, 0.8) }
    else if (cost > SOFT_HOME_COST) { why.push('离家有点远了'); urgency = Math.max(urgency, 0.35) }

    // 2) 地下很深：越挖越深，回家的路只会更长
    if (v > DEEP_UNDERGROUND) { why.push(`在 ${Math.round(v)} 格深的地方，再往下挖就更回不去了`); urgency = Math.max(urgency, 0.6) }
    else if (v > DEEP_UNDERGROUND * 0.6) { why.push(`已经下到 ${Math.round(v)} 格深`); urgency = Math.max(urgency, 0.3) }

    // 3) 背包/工具/吃的（有状态数据才判断）
    if (st) {
      const empty = typeof st.emptySlots === 'number' ? st.emptySlots : null
      if (empty !== null && empty <= 2) { why.push('背包快满了'); urgency = Math.max(urgency, 0.7) }
      if (st.hasPickaxe === false) { why.push('镐子没了'); urgency = Math.max(urgency, 0.75) }
      if (typeof st.food === 'number' && st.food <= 6) { why.push('快饿死了'); urgency = Math.max(urgency, 0.65) }
      if (typeof st.health === 'number' && st.health <= 8) { why.push('血不多了'); urgency = Math.max(urgency, 0.5) }
    }

    if (!why.length) return { should: false, why: '', urgency: 0, cost }

    // 只有"远"这一条、没有别的压力时，不打断手头的活
    if (urgency < 0.5) return { should: false, why: why.join('，'), urgency, cost }

    return { should: true, why: why.join('，'), urgency, cost }
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

  /**
   * 家附近有什么可挖的 —— 一句话，塞进提示词。
   *
   * 为什么要有这个：`findNearHome()` 写好了但**从来没人调用**（实测
   * 静态扫描：actions.js 里 0 处调用，5 个 findBlocks 调用点没有一个
   * 传 point）。也就是说挖矿永远是"以脚底下为中心找最近的"，
   * 家附近有什么资源他根本不知道，家就只是个坐标。
   *
   * 这里不改变挖矿逻辑（那是 dig-owner 的地盘），只是把"家附近有 X"
   * 摆到模型眼前，让它自己选"回去挖"还是"就地挖"。
   *
   * @param {string[]} [names] 关心哪些资源，默认原木+石头+铁矿
   * @param {{radius?:number, count?:number}} [opts]
   * @returns {string} 没有家/没有资源时返回 ''
   */
  homeResourceHint (names, opts = {}) {
    if (!this.home || !this.bot) return ''
    const want = names || ['oak_log', 'birch_log', 'spruce_log', 'stone', 'iron_ore']
    const radius = opts.radius || 40
    let found = []
    try {
      found = this.findNearHome(want, { radius, count: opts.count || 12 })
    } catch (e) {
      return ''
    }
    if (!found.length) return ''

    // 按方块名归组，各报一个最近的
    const seen = new Map()
    for (const b of found) {
      if (!b || !b.name) continue
      const cur = seen.get(b.name)
      const d = b.position.distanceTo(this.homePos())
      if (!cur || d < cur.d) seen.set(b.name, { d, pos: b.position })
    }
    if (!seen.size) return ''

    const WORD = {
      oak_log: '橡木', birch_log: '白桦', spruce_log: '云杉', jungle_log: '丛林木',
      acacia_log: '金合欢', dark_oak_log: '深色橡木', cherry_log: '樱花木',
      stone: '石头', iron_ore: '铁矿', coal_ore: '煤', copper_ore: '铜'
    }
    const parts = [...seen.entries()]
      .sort((a, b) => a[1].d - b[1].d)
      .slice(0, 4)
      .map(([name, v]) => `${WORD[name] || name}（${Math.round(v.d)} 格）`)

    return `家附近 ${radius} 格内有：${parts.join('、')}。就地开荒之前先想想，回去挖是不是更省事。`
  }

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

  /**
   * 一句中文，能直接塞进提示词。
   *
   * 关键改动：**把"该不该回家"直接说出来**。
   * 之前只写"家记在 66,64,-92，约 82 格" —— 82 格听起来不远，
   * 但他其实在地下 46 格深，回去要挖上去；模型看不到这层，
   * 就一直在下面挖。现在高差和"该往回走了"都明说。
   */
  summary () {
    if (!this.home) return '还没有家。找个合适的地方放下箱子或床，那儿就是家。'
    const h = this.hDistanceFromHome()
    const v = this.vDistanceFromHome()
    const cost = this.walkCostHome()
    const where = `${this.home.x},${this.home.y},${this.home.z}`
    const what = this.home.anchor ? anchorWord(this.home.anchor) : (this.home.reason || '据点')

    if (!Number.isFinite(h)) return `家记在 ${where}（${what}）。`
    if (h <= HOME_RADIUS && v <= 6) return `家就在脚下（${where}，${what}）。`

    const dir = this.homeDirection()
    const side = dir && dir !== '就在附近' ? `${dir}边 ` : ''
    const lines = [`家记在 ${where}（${what}），${side}水平 ${Math.round(h)} 格。`]

    // 高差是"回不去"的真正原因，必须单独讲
    const p = this.pos()
    if (Number.isFinite(v) && v > 4) {
      const up = p && p.y < this.home.y ? '要往上爬' : '在上面'
      lines.push(`你家在 y=${this.home.y}，你现在 y=${Math.round(p ? p.y : 0)}，差 ${Math.round(v)} 格，${up}。`)
    }

    // 该不该现在往回走
    const head = this.shouldHeadHome()
    if (head.should) {
      lines.push(`**该往回走了**：${head.why}。把这一趟收尾，走回去。`)
    } else if (Number.isFinite(cost) && cost > SOFT_HOME_COST) {
      const mins = Math.max(1, Math.round(cost / 25))
      lines.push(`走回去大概 ${mins} 分钟。这一趟可以再干一会儿，但别走更远了。`)
    }

    return lines.join('')
  }

  status () {
    return {
      hasHome: !!this.home,
      home: this.home,
      fromHome: Number.isFinite(this.hDistanceFromHome()) ? Math.round(this.hDistanceFromHome()) : null,
      fromHome3d: Number.isFinite(this.distanceFromHome()) ? Math.round(this.distanceFromHome()) : null,
      vertical: Number.isFinite(this.vDistanceFromHome()) ? Math.round(this.vDistanceFromHome()) : null,
      walkCost: Number.isFinite(this.walkCostHome()) ? Math.round(this.walkCostHome()) : null,
      direction: this.homeDirection(),
      trail: this.trail.length,
      stats: this.stats,
      file: this.file
    }
  }
}

module.exports = {
  Home,
  anchorRank,
  anchorWord,
  HOME_FILE: 'home.json',
  // 常量给测试和主程序用
  VERTICAL_COST,
  SOFT_HOME_COST,
  HARD_HOME_COST,
  DEEP_UNDERGROUND,
  HOME_RADIUS,
  DEFAULT_NEAR
}
