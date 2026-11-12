'use strict'
// L3 技能库。成功的程序存下来，下次遇到类似情况直接复用。
// 这是"慢慢学会所有玩法"的机制：技能会叠加，会用旧技能写新技能。

const fs = require('fs')
const path = require('path')

class SkillLibrary {
  constructor (dir) {
    this.dir = dir
    this.file = path.join(dir, 'skills.json')
    this.codeDir = path.join(dir, 'skillcode')
    this.data = { skills: [] }
    this.load()
  }

  load () {
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!Array.isArray(this.data.skills)) this.data.skills = []
    } catch (e) {
      this.data = { skills: [] }
    }
    try { fs.mkdirSync(this.codeDir, { recursive: true }) } catch (e) {}
  }

  save () {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1), 'utf8')
    } catch (e) { console.error('[skill] save fail', e.message) }
  }

  all () { return this.data.skills }

  // 添加/更新一个技能
  add ({ name, desc, code, tags = [] }) {
    if (!name || !code) return null
    const exist = this.data.skills.find(s => s.name === name)
    if (exist) {
      exist.desc = desc || exist.desc
      exist.code = code
      exist.tags = Array.from(new Set([...(exist.tags || []), ...tags]))
      exist.updated = Date.now()
      exist.uses = exist.uses || 0
      this.writeCode(name, code)
      this.save()
      return exist
    }
    const s = {
      name,
      desc: desc || '',
      tags,
      code,
      created: Date.now(),
      updated: Date.now(),
      uses: 0,
      ok: 0,
      fail: 0
    }
    this.data.skills.push(s)
    this.writeCode(name, code)
    this.save()
    return s
  }

  writeCode (name, code) {
    try {
      const safe = name.replace(/[^\w\u4e00-\u9fa5]/g, '_')
      fs.writeFileSync(path.join(this.codeDir, safe + '.js'), code, 'utf8')
    } catch (e) {}
  }

  markUse (name, ok) {
    const s = this.data.skills.find(x => x.name === name)
    if (!s) return
    s.uses = (s.uses || 0) + 1
    if (ok) s.ok = (s.ok || 0) + 1; else s.fail = (s.fail || 0) + 1
    s.lastUsed = Date.now()
    this.save()
  }

  // 按当前处境检索最相关的技能
  search (query, limit = 6) {
    const q = String(query || '')
    if (!q.trim()) return this.data.skills.slice(-limit)
    const qChars = cnChars(q)

    const scored = this.data.skills.map(s => {
      const text = [s.name, s.desc, (s.tags || []).join(' ')].join(' ')
      const tChars = cnChars(text)

      // 1. 汉字重叠（中文最重要的信号）
      let overlap = 0
      for (const c of qChars) if (tChars.has(c)) overlap++
      const charScore = qChars.size ? overlap / qChars.size : 0

      // 2. 原样子串
      let sub = 0
      for (const seg of (q.match(/[\u4e00-\u9fa5]{2,}/g) || [])) {
        if (text.includes(seg)) sub += 3
        else for (let i = 0; i < seg.length - 1; i++) {
          if (text.includes(seg.slice(i, i + 2))) sub += 1
        }
      }

      // 3. 标签命中
      let tagHit = 0
      for (const tag of (s.tags || [])) {
        if (q.toLowerCase().includes(String(tag).toLowerCase())) tagHit += 4
      }

      // 4. 英文词
      let en = 0
      for (const w of (q.toLowerCase().match(/[a-z_]{3,}/g) || [])) {
        if (text.toLowerCase().includes(w)) en += 2
      }

      const total = (s.ok || 0) + (s.fail || 0)
      const rate = total > 0 ? (s.ok || 0) / total : 0.5
      const score = charScore * 10 + sub + tagHit + en + rate + Math.min((s.uses || 0) / 20, 1)
      return { s, score }
    })
      .filter(x => x.score >= 2.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    return scored.map(x => x.s)
  }

  // 给提示词用的目录
  catalog (limit = 40) {
    return this.data.skills.slice(-limit).map(s => {
      const total = (s.ok || 0) + (s.fail || 0)
      const rate = total ? Math.round((s.ok || 0) / total * 100) + '%' : '未用'
      return `- ${s.name}：${s.desc}（用过 ${s.uses || 0} 次，成功率 ${rate}）`
    }).join('\n') || '（还不会什么，都要现学）'
  }

  get (name) {
    return this.data.skills.find(s => s.name === name)
  }

  stats () {
    return {
      total: this.data.skills.length,
      used: this.data.skills.filter(s => (s.uses || 0) > 0).length
    }
  }
}

// 中文常用字，没有区分度，不参与打分
const STOP = new Set('的了是我你他她它在有和就都也很不个这那什么怎么吗呢吧啊想要点弄去来做个一下能会可以要'.split(''))

function cnChars (s) {
  const out = new Set()
  for (const c of String(s || '')) {
    if (/[\u4e00-\u9fa5]/.test(c) && !STOP.has(c)) out.add(c)
  }
  return out
}

// 中英文都切一下
function tokenize (s) {
  if (!s) return []
  const out = new Set()
  // 英文/数字词
  for (const w of String(s).toLowerCase().match(/[a-z_]{2,}/g) || []) out.add(w)
  // 中文：按二字切
  const cn = String(s).match(/[\u4e00-\u9fa5]{2,}/g) || []
  for (const seg of cn) {
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2))
  }
  return Array.from(out)
}

module.exports = { SkillLibrary, tokenize, cnChars }
