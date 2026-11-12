'use strict'
/**
 * 记忆条目。
 *
 * 一条记忆不是一句话，是带权重的一个"印象"。
 * 权重决定它会不会被想起来、会不会淡忘。
 */

let SEQ = 0

function nextId () {
  SEQ++
  return 'm' + Date.now().toString(36) + SEQ.toString(36)
}

const KINDS = {
  EVENT: 'event',           // 发生过什么事
  PERSON: 'person',         // 关于某人的事
  PROMISE: 'promise',       // 答应过什么
  PLACE: 'place',           // 地点
  GRIEVANCE: 'grievance',   // 恩怨：谁打过我、谁帮过我
  SKILL: 'skill',           // 学会的本事
  FACT: 'fact'              // 记住的事实
}

/**
 * 造一条记忆。
 * @param {object} o
 * @param {string} o.text        原始描述
 * @param {string} o.kind        KINDS 之一
 * @param {string[]} [o.who]     涉及的人
 * @param {number} [o.emotion]   情感强度 0~1
 * @param {number} [o.importance] 重要性 0~1
 * @param {number} [o.certainty] 确信度 0~1
 * @param {number} [o.hops]      转述跳数（0=亲眼所见）
 * @param {number} now           当前游戏时间
 */
function make (o, now) {
  const emotion = clamp01(o.emotion == null ? 0.3 : o.emotion)
  const importance = clamp01(o.importance == null ? 0.4 : o.importance)
  return {
    id: nextId(),
    text: String(o.text || '').slice(0, 300),
    kind: o.kind || KINDS.EVENT,
    who: Array.isArray(o.who) ? o.who.filter(Boolean).slice(0, 6) : (o.who ? [o.who] : []),
    where: o.where || null,
    emotion,
    importance,
    certainty: clamp01(o.certainty == null ? 0.85 : o.certainty),
    hops: o.hops || 0,
    createdAt: now,
    lastRecall: now,
    recallCount: 0,
    strength: 1.0,
    // 刻骨铭心的不衰减
    protected: emotion >= 0.7 || importance >= 0.8,
    fuzzy: false,
    archived: false
  }
}

function clamp01 (v) {
  const n = Number(v)
  if (!isFinite(n)) return 0.3
  return Math.max(0, Math.min(1, n))
}

module.exports = { make, KINDS, nextId }
