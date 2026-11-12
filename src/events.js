'use strict'
/**
 * 事件队列。
 *
 * 解决的根本问题：**他现在靠轮询，事情不会主动找上他。**
 *
 * 现在的样子：
 *   while(true) { sleep(4s); if(危险) 处理; if(空闲) 想目标 }
 *   所以"张三刚说了句话""有只苦力怕在靠近""有人路过"
 *   全都要等到下一次轮询才知道，或者根本不知道。
 *
 * 改成：
 *   所有事情先进队列，队列自己判断"现在熟没熟"。
 *   急件（被打、被叫名字）立刻叫醒；不急的（有人路过）攒一会儿一起处理。
 *
 * 设计参考 numen 的 EventQueue：
 *   - 队列只是台账，不是调度员
 *   - 急不急在入队那一刻就定了
 *   - 满了先丢最老的不急件，但如实告诉模型"你看到的是残片"
 */

const DEFAULT_CAP = 60

// 事件类型定义。
// urgent: 是否立刻叫醒
// what:   怎么描述这件事（写进感知里）
const TYPES = {
  // ---- 急件 ----
  chat_me: { urgent: true, label: '有人跟你说话' },        // 直接叫名字/@你
  chat_any: { urgent: false, label: '有人说话' },          // 普通聊天
  damage: { urgent: true, label: '你受伤了' },
  death: { urgent: true, label: '你死了' },
  danger: { urgent: true, label: '有威胁靠近' },
  demand: { urgent: true, label: '有人要你做某事' },
  gift: { urgent: true, label: '有人给你东西' },
  attack_by_player: { urgent: true, label: '有人打你' },

  // ---- 不急 ----
  player_join: { urgent: false, label: '有人上线' },
  player_leave: { urgent: false, label: '有人下线' },
  player_near: { urgent: false, label: '有人走到你旁边' },
  player_far: { urgent: false, label: '有人走开了' },
  block_change: { urgent: false, label: '附近方块变了' },
  item_pickup: { urgent: false, label: '你捡到东西' },
  inventory_full: { urgent: false, label: '背包满了' },
  health_low: { urgent: false, label: '你血量很低' },
  hunger_low: { urgent: false, label: '你饿了' },
  time_change: { urgent: false, label: '天色变了' },
  weather_change: { urgent: false, label: '天气变了' },
  goal_done: { urgent: false, label: '做完一件事' },
  goal_fail: { urgent: false, label: '一件事没成' },
  stuck: { urgent: false, label: '你卡住了' },
  found_something: { urgent: false, label: '你发现了什么' }
}

class EventQueue {
  constructor (opts = {}) {
    this.cap = opts.cap || DEFAULT_CAP
    this.events = []          // { type, what, at, urgent, data, read }
    this.wakers = []          // 注册的"叫醒"回调
    this.dropped = 0          // 丢了多少条（用来告诉模型"你看到的是残片"）
    this.lastDrainAt = 0
    this.log = opts.log || (() => {})
  }

  /**
   * 推一个事件。
   * @param {string} type   TYPES 里的键
   * @param {object} [data] 附加数据
   * @param {string} [what] 自定义描述（不写就按类型生成）
   */
  push (type, data = {}, what) {
    const def = TYPES[type]
    if (!def) {
      this.log('[event] 未知事件类型: ' + type)
      return
    }

    const ev = {
      type,
      urgent: def.urgent,
      what: what || def.label,
      at: Date.now(),
      data,
      read: false
    }

    this.events.push(ev)

    // 超容量：先丢最老的不急件
    if (this.events.length > this.cap) {
      const idx = this.events.findIndex(e => !e.urgent && !e.read)
      if (idx >= 0) {
        this.events.splice(idx, 1)
        this.dropped++
      } else {
        this.events.shift()
        this.dropped++
      }
    }

    // 急件立刻叫醒
    if (ev.urgent) this.wake(ev)
    return ev
  }

  /** 注册"被叫醒"回调 */
  onWake (fn) { this.wakers.push(fn) }

  wake (ev) {
    for (const fn of this.wakers) {
      try { fn(ev) } catch (e) {}
    }
  }

  /**
   * 现在熟没熟？
   * 规则很简单：有急件 -> 熟；不急的攒够 3 条或者过了 20 秒 -> 熟。
   */
  ripe () {
    const unread = this.events.filter(e => !e.read)
    if (!unread.length) return { ripe: false, reason: 'empty' }

    const urgent = unread.filter(e => e.urgent)
    if (urgent.length) return { ripe: true, reason: 'urgent', count: urgent.length }

    const oldest = unread[0]
    const age = Date.now() - oldest.at
    if (unread.length >= 3) return { ripe: true, reason: 'batch', count: unread.length }
    if (age > 20000) return { ripe: true, reason: 'timeout', count: unread.length }
    return { ripe: false, reason: 'waiting', count: unread.length }
  }

  /** 取出所有未读（标记已读） */
  drain () {
    const out = this.events.filter(e => !e.read)
    for (const e of out) e.read = true
    this.lastDrainAt = Date.now()
    return out
  }

  /** 只取急件 */
  drainUrgent () {
    const out = this.events.filter(e => !e.read && e.urgent)
    for (const e of out) e.read = true
    return out
  }

  /** 最近 N 毫秒内发生的事（给感知用，不标记已读） */
  recent (ms = 45000) {
    const now = Date.now()
    return this.events
      .filter(e => now - e.at <= ms)
      .slice(-12)
  }

  /** 清掉很旧的 */
  prune (maxAgeMs = 300000) {
    const now = Date.now()
    this.events = this.events.filter(e => now - e.at <= maxAgeMs)
  }

  /** 把一批事件翻译成给模型看的话 */
  describe (events) {
    if (!events || !events.length) return ''
    const now = Date.now()
    const lines = events.map(e => {
      const ago = Math.max(1, Math.round((now - e.at) / 1000))
      return `- ${ago} 秒前：${e.what}`
    })
    if (this.dropped > 0) {
      lines.push(`（还有 ${this.dropped} 条更早的事没来得及记，你看到的是残片）`)
      this.dropped = 0
    }
    return lines.join('\n')
  }

  /** 状态（调试用） */
  stats () {
    return {
      total: this.events.length,
      unread: this.events.filter(e => !e.read).length,
      urgent: this.events.filter(e => !e.read && e.urgent).length,
      dropped: this.dropped
    }
  }
}

module.exports = { EventQueue, TYPES }
