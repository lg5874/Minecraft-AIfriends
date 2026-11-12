'use strict'
/**
 * 衰减：让人会忘。
 *
 * 真人不会每天回忆"张三上周给了我两个铁锭"这种细节，
 * 但"跟张三一起下了个大矿洞"这种事会记很久。
 *
 * 衰减用游戏时间算，不是现实时间 —— 他不在线的时候不该变老。
 */

const { KINDS } = require('./entry')

// 半衰期（游戏分钟）。1 游戏分钟 = 1 分钟真实在线时间。
const HALF_LIFE = {
  [KINDS.EVENT]: 6 * 60,        // 6 小时：普通事件
  [KINDS.PERSON]: 20 * 60,      // 20 小时：关于人的印象
  [KINDS.PROMISE]: Infinity,    // 承诺不忘
  [KINDS.PLACE]: Infinity,      // 地点不忘
  [KINDS.GRIEVANCE]: 40 * 60,   // 40 小时：恩怨记得久
  [KINDS.SKILL]: Infinity,      // 学会的不会忘
  [KINDS.FACT]: 30 * 60         // 30 小时：事实
}

// 情感/重要性给的加成
function halfLifeOf (entry) {
  const base = HALF_LIFE[entry.kind] == null ? 6 * 60 : HALF_LIFE[entry.kind]
  if (!isFinite(base)) return Infinity
  // 情感越强，活得越久
  const boost = 1 + entry.emotion * 3 + entry.importance * 2
  return base * boost
}

/**
 * 走一批时间后更新强度。
 * @param {object[]} entries
 * @param {number} elapsedMinutes 这段时间走过的游戏分钟
 */
function decay (entries, elapsedMinutes) {
  if (!(elapsedMinutes > 0)) return entries
  let changed = 0
  for (const e of entries) {
    if (e.protected) continue
    if (e.archived) continue
    const hl = halfLifeOf(e)
    if (!isFinite(hl)) continue

    // 被经常想起的记忆衰减得慢（记忆强化）
    const recallBoost = 1 + Math.min(e.recallCount, 10) * 0.08
    const factor = Math.pow(0.5, (elapsedMinutes / hl) / recallBoost)
    const before = e.strength
    e.strength = Math.max(0.02, e.strength * factor)
    if (Math.abs(e.strength - before) > 0.001) changed++
  }
  return changed
}

/**
 * 模糊化：强度掉到阈值的，降级成"记不清了"。
 * 不是删掉，是变成模糊印象 —— 真人就是这样。
 */
function blur (entries, threshold = 0.35) {
  const blurred = []
  for (const e of entries) {
    if (e.protected || e.archived || e.fuzzy) continue
    if (e.strength < threshold) {
      e.fuzzy = true
      e.text = toFuzzy(e)
      e.certainty = Math.max(0.25, e.certainty * 0.6)
      blurred.push(e)
    }
  }
  return blurred
}

/** 把一句话变成"记不清"的版本 */
function toFuzzy (e) {
  const who = e.who && e.who.length ? e.who[0] : '有人'
  switch (e.kind) {
    case KINDS.PERSON: return `好像跟${who}一起干过什么事，具体记不清了`
    case KINDS.GRIEVANCE: return `记得好像跟${who}闹过不愉快，细节想不起来了`
    case KINDS.EVENT: return '有那么件事，但是记不太清是什么了'
    case KINDS.FACT: return '有个事记不太清了'
    default: return '好像有那么回事，想不起来了'
  }
}

/**
 * 归档：强度极低的移出去，节省空间和上下文。
 */
function archive (entries, threshold = 0.12) {
  const out = []
  for (const e of entries) {
    if (e.protected) continue
    if (e.strength < threshold && e.fuzzy) {
      e.archived = true
      out.push(e)
    }
  }
  return out
}

module.exports = { decay, blur, archive, halfLifeOf, HALF_LIFE }
