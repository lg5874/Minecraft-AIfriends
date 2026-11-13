'use strict'
/**
 * 动作线仲裁（ActionLock）
 *
 * 解决的问题：`main.js` 里 4 条会动的线（task / home / survive / session）抢同一套
 * `busy` / `actions.cancel` / pathfinder。用一个布尔表达"两条线同时占着"是**类型表达
 * 能力不足**，于是只能靠 `if (!this._homing)` 这种例外去补，例外会指数增长。
 *
 * 这里用 `Map<reason, {count, since, why}>`：
 *   · 不用 Set：同一 reason 重入（tick 重复进入）会变成"第二次 release 清掉第一次的锁"
 *   · 不用裸计数：出错时看不出是谁占着、占了多久
 *   · reason 用 rank 表达优先级，新加一条线**只需要注册一个 rank**，不用改别人的代码
 *
 * 三条语义（必须守住，写错了就是全线卡死）：
 *   1. 同一 reason 重复 acquire → 允许，count+1
 *   2. release 一个没持有的 reason → 返回 false + 打日志，**永不抛错**
 *      （它几乎都写在 finally 里，抛错会吃掉真正的异常）
 *   3. 低 rank 抢高 rank → 拒绝；高 rank 抢低 rank → 成功
 *
 * 本文件不认识 mineflayer、不认识 actions.cancel，只做所有权记账。
 * 和 cancel 的配合顺序见 main.js `interruptCurrent()`。
 *
 * Step 1 的兼容层（installLegacyBusy / installHoming）已在 Step 2 删除：
 * main.js 里 `this.busy = true/false` 的 6 处写点全部换成 acquire/release，
 * busy 只剩只读 getter。现在没有任何"绕过锁改忙状态"的路。
 */

/** 动作线名字。字符串常量，不要传自由文本。 */
const REASON = Object.freeze({
  TASK: 'task', // 主循环正在跑一个任务
  HOME: 'home', // 走回家
  SURVIVE: 'survive', // 找吃的 / 逃命
  FOLLOW: 'follow', // 跟玩家走（第 2 层）
  SESSION: 'session' // 收工 / 上线结算
})

/**
 * 默认 rank。
 *
 * 规则像人：follow(60) > task(10) 能打断挖矿；follow(60) < survive(100) 不能打断逃命
 * —— 你喊他时他正被骷髅追，他先跑，回头再理你。
 *
 * 没有"例外"这一档：新线只要注册 rank，不用改任何别人的代码。
 */
const RANK = Object.freeze({
  [REASON.SURVIVE]: 100,
  [REASON.SESSION]: 80,
  [REASON.FOLLOW]: 60,
  [REASON.HOME]: 50,
  [REASON.TASK]: 10
})

/** 未注册的 reason 一律按 0 处理（连最低的 task 都抢不过），并打一次警告。 */
const UNKNOWN_RANK = 0

/** 可写的一份当前 rank 表。新动作线走 registerRank()，不改别人的代码。 */
const RANKS = Object.assign(Object.create(null), RANK)

/** 注册一条新动作线的 rank。返回是否生效。 */
function registerRank (reason, rank) {
  if (typeof reason !== 'string' || !reason) return false
  if (typeof rank !== 'number' || !Number.isFinite(rank)) return false
  RANKS[reason] = rank
  return true
}

class ActionLock {
  /**
   * @param {object} [opts]
   * @param {(s: string) => void} [opts.log] 日志出口，默认吞掉（单测时可注入）
   * @param {() => number} [opts.now] 时钟，默认 Date.now（单测可注入假时钟）
   */
  constructor (opts = {}) {
    this._m = new Map()
    this._logger = typeof opts.log === 'function' ? opts.log : null
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now()
    this._warned = new Set()
  }

  /** 打日志。没配 log 就当无事发生。 */
  log (s) {
    if (this._logger) {
      try { this._logger(s) } catch (e) {}
    }
  }

  /** 一条线的 rank。未注册按 0，并只警告一次（否则每 tick 刷屏）。 */
  rankOf (reason) {
    const r = RANKS[reason]
    if (r === undefined) {
      if (!this._warned.has(reason)) {
        this._warned.add(reason)
        this.log(`[lock] 未知动作线 rank：${String(reason)}，按 ${UNKNOWN_RANK} 处理（用 registerRank 注册）`)
      }
      return UNKNOWN_RANK
    }
    return r
  }

  /** 当前所有持有者里最高的 rank；没人持有是 -Infinity。 */
  maxRank () {
    let max = -Infinity
    for (const reason of this._m.keys()) {
      const r = this.rankOf(reason)
      if (r > max) max = r
    }
    return max
  }

  /**
   * 占住一条动作线。
   *
   * 同一 reason 重入允许（count+1）；被更高 rank 占着时拒绝（返回 false，不抛错）。
   */
  acquire (reason, why = '') {
    if (!reason) {
      this.log('[lock] acquire 缺少 reason，忽略这次调用')
      return false
    }
    const held = this._m.get(reason)
    if (held) {
      held.count += 1
      if (why) held.why = String(why)
      return true
    }
    if (this._m.size > 0 && !this.canPreempt(reason)) {
      this.log(`[lock] acquire 被拒：${reason}（rank ${this.rankOf(reason)}）抢不过 ${this._topText()}`)
      return false
    }
    this._m.set(reason, { count: 1, since: this._now(), why: String(why || '') })
    const stack = this._m.size > 1 ? `，叠在 ${this._othersText(reason)}` : ''
    this.log(`[lock] acquire ${reason}（rank ${this.rankOf(reason)}）${why ? '「' + why + '」' : ''}${stack}`)
    return true
  }

  /**
   * 归还一次。count 归零才删 key。
   * **永不抛错**：没持有就是 false + 一行日志（它几乎都写在 finally 里）。
   */
  release (reason) {
    const held = this._m.get(reason)
    if (!held) {
      this.log(`[lock] release 没有持有的锁：${String(reason)}`)
      return false
    }
    held.count -= 1
    if (held.count > 0) return true
    this._m.delete(reason)
    this.log(`[lock] release ${reason}（持了 ${this._secs(held)}s）`)
    return true
  }

  /**
   * 夺锁：不管 count 多少直接清掉。
   * 合法来路只有两种：超时（interruptCurrent 第 4 步）和死亡/重连的整把清理。
   * 必须打日志 —— 它是"这里死过一次"的证据。
   */
  forceRelease (reason, why = '') {
    const held = this._m.get(reason)
    if (!held) {
      this.log(`[lock] forceRelease 空操作：${String(reason)} 本来没人持有（${why || '未说明'}）`)
      return false
    }
    this._m.delete(reason)
    this.log(`[lock] forceRelease ${reason}（持了 ${this._secs(held)}s ×${held.count}）← ${why || '未说明'}`)
    return true
  }

  /** 全部清掉（死亡 / 断开这种"整局作废"的时刻用）。返回清掉几条线。 */
  forceReleaseAll (why = '') {
    if (this._m.size === 0) return 0
    const reasons = [...this._m.keys()]
    for (const reason of reasons) this.forceRelease(reason, why || '释放全部')
    return reasons.length
  }

  isHolding (reason) {
    return this._m.has(reason)
  }

  /** 某条线什么时候开始占的（毫秒时间戳），没占着是 null。 */
  since (reason) {
    const held = this._m.get(reason)
    return held ? held.since : null
  }

  /** 某条线占了多久（秒），没占着是 0。 */
  ageSecs (reason) {
    const held = this._m.get(reason)
    return held ? (this._now() - held.since) / 1000 : 0
  }

  /** 有没有任何线占着。这是 `this.busy` 的真身。 */
  get busy () {
    return this._m.size > 0
  }

  /** 别人能不能压过现在所有持有者。没人的时候真（没有东西可压）。 */
  canPreempt (reason) {
    if (this._m.size === 0) return true
    return this.rankOf(reason) > this.maxRank()
  }

  /**
   * 现在能不能起这条线。
   *   没人持有 → 能；自己已经持有（重入）→ 能；rank 压得过 → 能；否则不能。
   */
  canStart (reason = REASON.TASK) {
    if (!this.busy) return true
    if (this.isHolding(reason)) return true
    return this.canPreempt(reason)
  }

  /** 当前持有者，按 rank 从高到低。卡死时靠这个定位"谁占着、占了多久"。 */
  holders () {
    const now = this._now()
    const list = []
    for (const [reason, held] of this._m.entries()) {
      list.push({
        reason,
        count: held.count,
        since: held.since,
        why: held.why,
        rank: this.rankOf(reason),
        secs: Number(((now - held.since) / 1000).toFixed(1))
      })
    }
    list.sort((a, b) => b.rank - a.rank || a.since - b.since)
    return list
  }

  /** 一行摘要，给日志/日报用。 */
  describe () {
    const hs = this.holders()
    if (!hs.length) return '空闲'
    return hs.map(h => `${h.reason}×${h.count} ${h.secs}s${h.why ? '@' + h.why : ''}`).join(' + ')
  }

  // ---------- 内部小工具 ----------

  _secs (held) {
    return ((this._now() - held.since) / 1000).toFixed(1)
  }

  _topText () {
    const hs = this.holders()
    return hs.length ? `${hs[0].reason}（rank ${hs[0].rank}，已持 ${hs[0].secs}s）` : '空'
  }

  _othersText (except) {
    const hs = this.holders().filter(h => h.reason !== except)
    return hs.map(h => `${h.reason}（rank ${h.rank}）`).join(' + ')
  }
}

module.exports = {
  ActionLock,
  REASON,
  RANK,
  registerRank
}
