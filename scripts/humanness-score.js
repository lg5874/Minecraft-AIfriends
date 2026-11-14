#!/usr/bin/env node
'use strict'
/**
 * 像人度尺子（2026-11-14）
 *
 *   node scripts/humanness-score.js --log data/runtime/supervisor.log --since 2h
 *   node scripts/humanness-score.js --log /tmp/soak.log --json
 *   node scripts/humanness-score.js --log ... --detail      # 附每条的判定明细
 *
 * 【为什么要有】
 * 改了一整天，没有任何一个数字能量化「他是不是更像人了」。
 * 用户的原话是「如果没人告诉你他是 AI，你多久能发现？」——这句没法直接测，
 * 但可以拆成六个数。这个脚本就是那六个数。
 *
 * 【铁律：每项必须给分子/分母/口径】
 * 只给百分比等于没有数据。数值低了要知道是"分子小"还是"分母小"。
 * 算不出来就明说「覆盖不到，原因是 X」，**不许静默跳过**。
 *
 * 六个指标：
 *   1 回声率     说出口的话里有 4-gram 和输入情景重合 / 有输入的发言   越低越好
 *   2 复读率     30 分钟窗口内说过的同句 / 总发言                     越低越好
 *   3 拦截率     被拦次数 / (被拦 + 说出)                             <5% 判据才可退役
 *   4 主动沉默率 模型自己选择不说 / (自选不说 + 说出口)                30~50% 最像人
 *   5 言行一致率 说"要去做 X"之后 60 秒内真的在做 X / 这类发言          越高越好
 *   6 无据陈述   说出来但材料里找不到依据的数量 / 可核对的陈述数         必须是 0
 *
 * 只读日志。不连服务器、不改任何东西。
 */

const fs = require('fs')

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const has = (n) => argv.includes('--' + n)

const LOG = arg('log', 'data/runtime/supervisor.log')
const SINCE = parseSince(arg('since', ''))
const TS = /^\[(\d{2}):(\d{2}):(\d{2})\]\s?(.*)$/

function parseSince (s) {
  if (!s) return 0
  const m = /^(\d+(?:\.\d+)?)([smh])$/.exec(s.trim())
  if (!m) return 0
  const n = parseFloat(m[1])
  return m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : n
}

/** 读日志 -> {lines:[{sec,tag,text,raw,idx}], span:{from,to}, truncated} */
function readLog (path) {
  const out = []
  const buf = fs.readFileSync(path, 'utf8')
  const raw = buf.split('\n')
  let dayOffset = 0
  let lastRaw = null
  let partialTail = false
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i]
    const m = TS.exec(line)
    if (!m) {
      // 最后一行可能是写一半的（日志在长）—— 记下来，别当成解析失败
      if (i === raw.length - 1 && line.trim()) partialTail = true
      continue
    }
    const sec = +m[1] * 3600 + +m[2] * 60 + +m[3]
    if (lastRaw !== null && sec < lastRaw - 12 * 3600) dayOffset += 86400
    lastRaw = sec
    out.push({ sec: sec + dayOffset, tag: tagOf(m[4]), text: m[4], raw: line, idx: i })
  }
  return { lines: out, from: out.length ? out[0].sec : 0, to: out.length ? out[out.length - 1].sec : 0, partialTail }
}

function tagOf (t) {
  const m = /^\[([^\]]+)\]/.exec(t)
  return m ? m[1] : ''
}

function hms (sec) {
  sec = ((sec % 86400) + 86400) % 86400
  const p = (n) => String(n).padStart(2, '0')
  return `${p(Math.floor(sec / 3600))}:${p(Math.floor(sec % 3600 / 60))}:${p(sec % 60)}`
}

// ---------------- 指标 1：回声率 ----------------
// 输入情景 = 玩家真的跟他说的话（[urgent] X 跟你说：…）。
// 日志没有 dump 完整 prompt，所以「输入情景」只能取这一段——这是覆盖限制，会写进输出。
const INPUT_RE = /^\[urgent\]\s*(\S+)\s*跟你说：(.+)$/

const STOP = new Set(['的', '了', '是', '在', '我', '你', '他', '她', '我', '们', '啊', '吧', '呢', '就', '都', '也', '和', '把', '被', '这', '那', '个'])

function norm4 (s) {
  const t = String(s || '')
    .replace(/[「『“”"'（）()【】\[\]，。、；：！？,.!?…\s]/g, '')
  const grams = new Set()
  for (let i = 0; i + 4 <= t.length; i++) grams.add(t.slice(i, i + 4))
  return grams
}

function metricEcho (L) {
  const inputs = []
  for (const l of L) {
    const m = INPUT_RE.exec(l.text)
    if (m) inputs.push({ sec: l.sec, who: m[1], text: m[2].trim() })
  }
  const says = L.filter(l => l.tag === 'say')
  let withInput = 0
  let echoed = 0
  const detail = []
  for (const s of says) {
    // 取这条之前 60 秒内最近的一条输入
    let near = null
    for (let i = inputs.length - 1; i >= 0; i--) {
      if (inputs[i].sec <= s.sec && s.sec - inputs[i].sec <= 60) { near = inputs[i]; break }
      if (inputs[i].sec < s.sec - 60) break
    }
    if (!near) continue
    withInput++
    const a = norm4(near.text)
    const b = norm4(s.text.replace(/^\[say\]\s*/, ''))
    let hit = 0
    for (const g of b) if (a.has(g)) hit++
    if (hit >= 1) { echoed++; detail.push({ ts: hms(s.sec), said: s.text, input: near.text, grams: hit }) }
  }
  return {
    key: '回声率',
    good: '越低越好',
    num: echoed,
    den: withInput,
    rate: withInput ? echoed / withInput : null,
    def: '说过的话里与我方输入（玩家原话）有 4-gram 重合的条数 / 60 秒内有玩家输入的发言条数',
    cover: inputs.length
      ? `窗口内「玩家跟他说」${inputs.length} 条；落在输入后 60 秒内的发言 ${withInput} 条（占全部发言 ${(100 * withInput / Math.max(says.length, 1)).toFixed(1)}%）。样本太小，别把这个百分比当结论`
      : '⚠️ 覆盖不到：日志里没有任何「玩家跟你说」记录，这项算不出（不是 0，是没有分母）',
    detail
  }
}

// ---------------- 指标 2：复读率 ----------------
function normText (s) {
  return String(s || '').replace(/[，。、；：！？,.!?…\s「」『』“”"'']/g, '')
}

function metricDup (L) {
  const says = L.filter(l => l.tag === 'say' && !/^\[say 限速\]/.test(l.text))
  const seen = new Map()   // norm -> 最近一次 sec
  let dup = 0
  const detail = []
  for (const s of says) {
    const t = normText(s.text.replace(/^\[say\]\s*/, ''))
    if (!t) continue
    const prev = seen.get(t)
    if (prev != null && s.sec - prev <= 30 * 60) {
      dup++
      detail.push({ ts: hms(s.sec), said: t, gap: s.sec - prev })
    }
    seen.set(t, s.sec)
  }
  return {
    key: '复读率',
    good: '越低越好',
    num: dup,
    den: says.length,
    rate: says.length ? dup / says.length : null,
    def: '与 30 分钟内已有发言完全相同（去标点）的条数 / 总发言条数',
    cover: says.length ? `总发言 ${says.length} 条` : '⚠️ 日志里没有 [say] 行',
    detail
  }
}

// ---------------- 指标 3：拦截率 ----------------
const BLOCK_RE = /^\[(say 限速|repeat blocked|instruction leak blocked|meta leak blocked|machine talk blocked|topic repeat blocked|say blocked[^\]]*)\]/

function metricBlock (L) {
  const said = L.filter(l => l.tag === 'say').length
  const blocked = L.filter(l => BLOCK_RE.test(l.text))
  const byKind = {}
  for (const b of blocked) {
    const m = /^\[([^\]]+)\]/.exec(b.text)
    const k = m ? m[1] : '?'
    byKind[k] = (byKind[k] || 0) + 1
  }
  const total = said + blocked.length
  return {
    key: '拦截率',
    good: '<5% 判据才可退役',
    num: blocked.length,
    den: total,
    rate: total ? blocked.length / total : null,
    def: '被任一判据拦掉的次数 /（被拦 + 说出口）；判据含限速、复读、指令泄漏、元语言、机器腔、话题重复',
    cover: total ? `分项：${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join('｜')}` : '⚠️ 没有发言也没有拦截',
    detail: blocked.slice(-20).map(b => ({ ts: hms(b.sec), line: b.text.slice(0, 80) }))
  }
}

// ---------------- 指标 4：主动沉默率 ----------------
// 分母只算「模型自己决定要不要说」的场合：
//   自选不说 = [spont] 跳过 reason=notSaid + [talk] 模型不想说 + [time] 这轮没说
//   说出口   = [say]
// 冷却/忙/让位这些还没走到模型，不算（否则沉默率会被系统节流污染）。
function metricSilence (L) {
  const says = L.filter(l => l.tag === 'say').length
  const notSaid = L.filter(l => /\[spont\] 跳过 .*reason=notSaid/.test(l.text)).length
  const talkNo = L.filter(l => /^\[talk\] 模型不想说/.test(l.text)).length
  const timeNo = L.filter(l => /^\[time\] 这轮没说/.test(l.text)).length
  const silent = notSaid + talkNo + timeNo
  const total = silent + says
  const rate = total ? silent / total : null
  let verdict = ''
  if (rate == null) verdict = ''
  else if (rate < 0.2) verdict = '太吵（见谁都想开口）'
  else if (rate > 0.7) verdict = '太闷（几乎不主动开口）'
  else if (rate >= 0.3 && rate <= 0.5) verdict = '在像人区间'
  else verdict = '边缘'
  return {
    key: '主动沉默率',
    good: '30~50% 最像人',
    num: silent,
    den: total,
    rate,
    verdict,
    def: '模型自己选择不说 /（自选不说 + 说出口）；冷却/忙/让位不算进分母',
    cover: `分项：spont notSaid ${notSaid}｜模型不想说 ${talkNo}｜这轮没说 ${timeNo}｜说出 ${says}`,
    detail: []
  }
}

// ---------------- 指标 5：言行一致率 ----------------
// 「说要做 X」-> 60 秒内有没有对应的动作行。
//
// 【严格口径 vs 宽松口径，两个都给】
//   宽松：句子里提到 X 就算一次"表态"，60 秒内出现 X 类动作就算"做到"。
//   严格：还要求这句话是**计划语气**（去/要/先/打算/准备/一会儿…），
//         且动词前面 3 个字里没有否定（"我不挖了""这附近没树"不算表态）。
// 实测宽松口径会把"这附近真没树"（抱怨）和"不往下挖了"（否定）算成表态 —— 所以主数用严格。
const INTENT = [
  { re: /挖|矿|下矿/, acts: ['dig', 'mine', 'digStone'], label: '挖矿' },
  { re: /砍|树|木头/, acts: ['chop', 'chopTree'], label: '砍树' },
  { re: /回家|回去|回屋/, acts: ['travel', 'goto', 'home'], label: '回家' },
  { re: /做|造|合成|镐|斧|剑|工作台/, acts: ['craft', 'crafting'], label: '制作' },
  { re: /吃|找点吃的|饿了/, acts: ['food', 'eat'], label: '找吃的' },
  { re: /上去|上地表|爬出去/, acts: ['surface', 'pillar', 'getToSurface'], label: '上地面' }
]
const PLAN_MARK = /(去|要|先|打算|准备|得去|该去|这就|一会儿|待会|回头|马上|现在去)/
const NEG = /[不没别甭]/

/** 命中的类别；否定词打头的整类跳过 */
function intentKinds (body) {
  const out = []
  for (const k of INTENT) {
    const m = k.re.exec(body)
    if (!m) continue
    const before = body.slice(Math.max(0, m.index - 3), m.index)
    if (NEG.test(before)) continue
    out.push(k)
  }
  return out
}

function metricConsistency (L) {
  const says = L.filter(l => l.tag === 'say')
  let loose = 0, looseKept = 0
  let strict = 0, strictKept = 0, slowKept = 0
  const detail = []
  for (const s of says) {
    const body = s.text.replace(/^\[say\]\s*/, '')
    const kinds = intentKinds(body)
    if (!kinds.length) continue
    loose++
    const actedIn = (secs) => {
      const w = L.filter(l => l.sec > s.sec && l.sec <= s.sec + secs && /^\[act\] \[([a-zA-Z]+)\]/.test(l.text))
      return [...new Set(w.map(l => (/^\[act\] \[([a-zA-Z]+)\]/.exec(l.text) || [])[1]).filter(Boolean))]
    }
    const acted = actedIn(60)
    const hit = kinds.some(k => acted.some(a => k.acts.includes(a)))
    if (hit) looseKept++
    // 拒绝语气（"不想再去""懒得动""算了"）不算计划 —— 否则会把放弃也算成表态
    const refusal = /(不想|懒得|不去|别去|算了|拉倒)/.test(body)
    const planned = PLAN_MARK.test(body) && !refusal
    if (planned) {
      strict++
      if (hit) strictKept++
      else if (kinds.some(k => actedIn(180).some(a => k.acts.includes(a)))) slowKept++
    }
    detail.push({
      ts: hms(s.sec),
      said: body.slice(0, 40),
      kind: kinds.map(k => k.label).join('/'),
      planned,
      hit,
      acts: acted.length ? acted.join(',') : '60 秒内没有 [act]'
    })
  }
  return {
    key: '言行一致率',
    good: '越高越好',
    num: strictKept,
    den: strict,
    rate: strict ? strictKept / strict : null,
    def: '说了"要去挖/砍/回家/做/吃/上去"（计划语气、非否定）之后 60 秒内出现对应 [act] 的条数 / 这类发言条数',
    cover: `严格口径 ${strictKept}/${strict}（60 秒窗口）；放宽到 180 秒是 ${strictKept + slowKept}/${strict}` +
      (slowKept ? `（多出 ${slowKept} 条 = 走过去再动手，被 60 秒窗口漏掉）；` : '（放宽窗口没有救回任何一条，不是窗口太短）；') +
      `宽松口径（提到就算，含抱怨/否定已剔除）${looseKept}/${loose}` + (loose ? `，比严格多 ${loose - strict} 条非计划句。` : '。'),
    detail
  }
}

// ---------------- 指标 6：无据陈述 ----------------
// 只核「能核的」：数字。人名/地点需要 [fabrication] 日志才能准，这里明说覆盖不到。
function metricFabrication (L) {
  const says = L.filter(l => l.tag === 'say')
  let claims = 0
  let unbacked = 0
  const detail = []
  for (const s of says) {
    const body = s.text.replace(/^\[say\]\s*/, '')
    const nums = [...body.matchAll(/\d{1,4}/g)].map(m => m[0])
    for (const n of nums) {
      claims++
      // 证据窗口：前后 120 秒内，任何非 [say] 行里出现过这个数
      const lo = s.sec - 120
      const hi = s.sec + 120
      const back = L.some(l => l.tag !== 'say' && l.sec >= lo && l.sec <= hi && l.text.includes(n))
      if (!back) {
        unbacked++
        detail.push({ ts: hms(s.sec), said: body.slice(0, 60), num: n })
      }
    }
  }
  return {
    key: '无据陈述',
    good: '必须是 0',
    num: unbacked,
    den: claims,
    rate: claims ? unbacked / claims : null,
    def: '说出口的话里出现的数字，前后 120 秒内日志其它行找不到同一个数字的次数 / 出现过的数字总数',
    cover: claims
      ? `可核数字 ${claims} 个。⚠️ 人名与地点**覆盖不到**：日志没有结构化的人和坐标依据，` +
        `要等 talk-owner 在 say() 之后补 [fabrication] 日志才算得准；这一项的 rate 只反映"数字"这一路`
      : '⚠️ 发言里没有出现数字，这项没有分母（不是 0）',
    detail
  }
}

// ---------------- 输出 ----------------
function pct (x) { return x == null ? '—' : (100 * x).toFixed(1) + '%' }

function main () {
  if (!fs.existsSync(LOG)) { console.error('日志不存在: ' + LOG); process.exit(1) }
  const { lines, from, to, partialTail } = readLog(LOG)
  const L = SINCE ? lines.filter(l => l.sec >= to - SINCE) : lines
  if (!L.length) { console.error('窗口内没有可解析的日志行'); process.exit(1) }

  const metrics = [
    metricEcho(L), metricDup(L), metricBlock(L),
    metricSilence(L), metricConsistency(L), metricFabrication(L)
  ]

  const res = {
    log: LOG,
    window: (() => {
      const wf = SINCE ? Math.max(from, to - SINCE) : from
      return { from: hms(wf), to: hms(to), minutes: Number(((to - wf) / 60).toFixed(1)), since: SINCE ? `${SINCE}s` : '全部' }
    })(),
    lines: { total: lines.length, inWindow: L.length, partialTail },
    says: L.filter(l => l.tag === 'say').length,
    metrics
  }

  if (has('json')) {
    const slim = Object.assign({}, res, { metrics: metrics.map(m => Object.assign({}, m, { detail: has('detail') ? m.detail : undefined })) })
    console.log(JSON.stringify(slim, null, 2))
    return
  }

  console.log('════════════════════════════════════════════════════════')
  console.log(` 像人度　${res.window.from} → ${res.window.to}（${res.window.minutes} 分钟）`)
  console.log(` 日志 ${LOG}　行 ${res.lines.total}｜窗口内 ${res.lines.inWindow}｜发言 ${res.says} 条`)
  if (partialTail) console.log(' （日志末行是写一半的，已跳过）')
  console.log('════════════════════════════════════════════════════════')
  console.log('')
  console.log('指标            值        分子/分母          方向')
  console.log('──────────────  ────────  ────────────────  ──────────────')
  for (const m of metrics) {
    const v = m.rate == null ? '   —   ' : pct(m.rate).padStart(7)
    console.log(`${m.key.padEnd(14)}  ${v}   ${String(m.num).padStart(5)} / ${String(m.den).padEnd(5)}  ${m.good}${m.verdict ? '｜' + m.verdict : ''}`)
  }
  console.log('')
  for (const m of metrics) {
    console.log(`【${m.key}】${m.def}`)
    console.log(`   ${m.cover}`)
    if (has('detail') && m.detail && m.detail.length) {
      for (const d of m.detail.slice(0, 12)) console.log('     · ' + JSON.stringify(d))
      if (m.detail.length > 12) console.log(`     · …还有 ${m.detail.length - 12} 条`)
    }
  }
  console.log('')
  console.log('口径说明：')
  console.log('  · 所有比率都给分子/分母，百分比只是展示；分母为 0 记「—」，不记 0%、更不记 100%。')
  console.log('  · 「覆盖不到」的指标会明写原因，不会被静默跳过。')
  console.log('  · 加了 --detail 可看每条的判定明细（哪句复读、哪句说了没做、哪个数字没依据）。')
}

main()
