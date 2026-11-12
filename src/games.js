'use strict'
// 二游知识库加载
const fs = require('fs')
const path = require('path')

let cache = null

function load () {
  if (cache) return cache
  const p = path.join(__dirname, '..', 'data', 'games.json')
  try {
    cache = JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (e) {
    cache = { played: [], knows: [], opinions: [] }
  }
  return cache
}

// 给提示词用的紧凑版本
function brief () {
  const d = load()
  const played = d.played.map(g =>
    `- ${g.name}（${g.type}，${g.maker}，${g.since} 年）：${g.how}。黑话：${(g.jargon || []).join('、')}。我的看法：${g.attitude}`
  ).join('\n')
  const knows = d.knows.map(g => `- ${g.name}：${g.one}`).join('\n')
  const ops = d.opinions.map(o => `- ${o}`).join('\n')
  return `### 我在玩的二游\n${played}\n\n### 我知道但没怎么玩的\n${knows}\n\n### 我对二游这行的看法\n${ops}`
}

// 按名字找，用于被问到时精准回答
function find (name) {
  const d = load()
  const n = String(name || '').toLowerCase()
  const hit = d.played.find(g => n.includes(g.name.toLowerCase()) || g.name.toLowerCase().includes(n))
  if (hit) return { kind: 'played', game: hit }
  const k = d.knows.find(g => n.includes(g.name.toLowerCase()) || g.name.toLowerCase().includes(n))
  if (k) return { kind: 'knows', game: k }
  return null
}

function names () {
  const d = load()
  return {
    played: d.played.map(g => g.name),
    knows: d.knows.map(g => g.name)
  }
}

module.exports = { load, brief, find, names }
