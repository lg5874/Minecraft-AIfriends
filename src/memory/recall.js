'use strict'
/**
 * 检索：从几千条记忆里挑出"现在该想起来的那几条"。
 *
 * 不用向量库 —— 一共几千条，关键词 + 权重打分足够快，还省一个模型。
 *
 * 打分 = 相关性 × 0.45
 *      + 情感强度 × 0.2
 *      + 重要性 × 0.2
 *      + 强度（衰减后）× 0.1
 *      + 回想次数加成 × 0.05
 */

const { cnChars } = require('./text')

// 中文里没区分度的字
const STOP = new Set('的了是我你他她它在有和就都也很不个这那什么怎么吗呢吧啊想要点弄去来做个一下能会可以要'.split(''))

function relevance (entry, queryChars, queryWords, names) {
  let score = 0
  const text = entry.text + ' ' + (entry.who || []).join(' ')

  // 1. 汉字重叠
  const t = cnChars(text, STOP)
  if (queryChars.size) {
    let hit = 0
    for (const c of queryChars) if (t.has(c)) hit++
    score += hit / queryChars.size
  }

  // 2. 英文词
  if (queryWords.length) {
    const low = text.toLowerCase()
    let hit = 0
    for (const w of queryWords) if (low.includes(w)) hit++
    score += hit / queryWords.length
  }

  // 3. 提到的人在记忆里 -> 大幅加分
  if (names && names.length) {
    for (const n of names) {
      if (n && (entry.who || []).includes(n)) { score += 0.6; break }
    }
  }

  return Math.min(score, 2)
}

/**
 * @param {object[]} entries 所有记忆
 * @param {object} q { text, people }
 * @param {number} limit
 * @param {number} now 当前游戏时间
 */
function search (entries, q, limit = 8, now = 0) {
  const query = String((q && q.text) || '')
  const queryChars = cnChars(query, STOP)
  const queryWords = (query.toLowerCase().match(/[a-z_]{3,}/g) || [])
  const names = (q && q.people) || []

  const scored = []
  for (const e of entries) {
    if (e.archived) continue
    if (e.strength < 0.05 && !e.protected) continue

    const rel = relevance(e, queryChars, queryWords, names)
    const recallBonus = Math.min(e.recallCount || 0, 10) * 0.05

    // 完全没相关、也不涉及提到的人 -> 跳过
    if (rel <= 0 && recallBonus <= 0) continue

    const score =
      rel * 0.45 +
      (e.emotion || 0) * 0.2 +
      (e.importance || 0) * 0.2 +
      (e.strength || 0) * 0.1 +
      recallBonus

    scored.push({ e, score })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(x => x.e)
}

/** 标记被想起过 */
function markRecalled (entries, now, deltaMinutes = 0) {
  for (const e of entries) {
    e.recallCount = (e.recallCount || 0) + 1
    e.lastRecall = now
    // 想起来会让记忆稍微清晰一点（但不至于完全恢复）
    if (e.strength < 1) e.strength = Math.min(1, e.strength + 0.03)
  }
}

module.exports = { search, markRecalled, relevance }
