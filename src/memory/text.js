'use strict'
/**
 * 中文分词相关的小工具。
 */

/**
 * 抽取汉字集合（去掉停用字）。
 * @param {string} s
 * @param {Set<string>} [stop]
 * @returns {Set<string>}
 */
function cnChars (s, stop) {
  const out = new Set()
  const str = String(s || '')
  for (const c of str) {
    if (!/[\u4e00-\u9fa5]/.test(c)) continue
    if (stop && stop.has(c)) continue
    out.add(c)
  }
  return out
}

/** 取所有二字组合（用于短语匹配） */
function bigrams (s) {
  const out = new Set()
  const segs = String(s || '').match(/[\u4e00-\u9fa5]{2,}/g) || []
  for (const seg of segs) {
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2))
  }
  return out
}

module.exports = { cnChars, bigrams }
