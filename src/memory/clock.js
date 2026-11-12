'use strict'
/**
 * 游戏内时间钟。
 *
 * 关键设计：这个钟只在机器人真正在线的时候走。
 * 下线期间时间不动 —— 所以服务器关一周，他回来不会觉得"过了好久"，
 * 也不会因为挂机把记忆全忘光。
 *
 * 单位：游戏分钟（gameMinutes）。
 * 每 20 tick = 1 秒，所以 1 分钟真实在线 = 1 gameMinute。
 */

const fs = require('fs')
const path = require('path')

class GameClock {
  constructor (dir) {
    this.file = path.join(dir, 'clock.json')
    this.totalMinutes = 0        // 累计在线分钟数
    this.sessionStart = null     // 本次上线开始的 totalMinutes
    this.online = false
    this.dirty = false
    this.load()
  }

  load () {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.totalMinutes = d.totalMinutes || 0
      this.sessions = d.sessions || 0
    } catch (e) {
      this.sessions = 0
    }
  }

  save () {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify({
        totalMinutes: this.totalMinutes,
        sessions: this.sessions
      }), 'utf8')
    } catch (e) {}
  }

  /** 上线：开始计时 */
  goOnline () {
    if (this.online) return
    this.online = true
    this.sessionStart = this.totalMinutes
    this.sessions++
    this.save()
  }

  /** 下线：停止计时 */
  goOffline () {
    if (!this.online) return
    this.online = false
    this.sessionStart = null
    this.save()
  }

  /** 推进时间（由主循环每秒调用一次） */
  tick (realSeconds = 1) {
    if (!this.online) return
    this.totalMinutes += realSeconds / 60
  }

  /** 当前游戏内时间（分钟） */
  now () {
    return this.totalMinutes
  }

  /** 本次上线已经玩了多久（分钟） */
  sessionMinutes () {
    if (!this.online || this.sessionStart == null) return 0
    return this.totalMinutes - this.sessionStart
  }

  /** 把分钟数转成人话 */
  static human (minutes) {
    if (minutes < 1) return '刚才'
    if (minutes < 60) return `${Math.round(minutes)} 分钟`
    const h = minutes / 60
    if (h < 24) return `${h.toFixed(1)} 小时`
    return `${(h / 24).toFixed(1)} 天`
  }
}

module.exports = GameClock
