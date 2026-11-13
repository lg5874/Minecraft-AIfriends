#!/usr/bin/env node
/**
 * 任务统计 v2：四栏读法（真产出 / 零产出通过 / 真失败 / 卡住·超时）
 *
 * 【为什么改】
 * v1 只报「N 开 / M 成 / K 败」。「成」里混着背包+0、方块+0、位移+0 的空转，
 * 这样的 50% 成功率会让人以为机器人在干活，实际产出是 0。
 * 所以把「成」拆成两栏，把「败」拆成两栏。
 *
 * 【判据】
 *   真产出      ：`<<< 完成` 且 [ledger] 的 背包>0 或 方块>0 �� 位移>=1
 *   零产出通过  ：`<<< 完成` 但 [ledger] 背包/方块都 0 且 位移<1
 *   真失败      ：`<<< 失败`，且没有 [stall] / 任务硬超时
 *   卡住/超时   ：`<<< 失败`（或没收尾）且期间出现 [stall] 或 `任务硬超时`
 *   未收尾      ：日志到末尾还没有 `<<<` 行 —— **不算四栏之内**，单独列出
 *
 * 【优先级（重要，写在代码里免得以后吵）】
 *   已经 `<<< 完成` 的任务，即使中途出现过 [stall]，也按产出入「真产出 / 零产出通过」，
 *   只额外标注「中途 stall N 次」。理由：强制结束后重跑成功 = 真的做完了，
 *   把它算成卡住会把实际完成的任务抹掉。
 *   另附一行「严格口径（出现 stall 就算卡住）」的数字，供选择。
 *
 * 【为什么位移单列】
 * 「位移 10 格」是走过去，不是产出。「背包 0 / 方块 0 / 位移 10」按上面的判据算真产出，
 * 但如果要回答「他到底攒到东西没有」，得看材料口径。所以同时输出：
 *   材料口径真产出 = 背包>0 或 方块>0（不含纯走路）
 *
 * 用法：
 *   node scripts/task-stats.js --log /tmp/soak.log
 *   node scripts/task-stats.js --log /tmp/soak.log --json      # 机器可读
 *   node scripts/task-stats.js --log /tmp/soak.log --detail     # 附每个任务明细
 *   node scripts/task-stats.js --log /tmp/soak.log --bots 3     # 标注当时在场 bot 数
 *
 * 只读日志。不连服务器、不碰 bot。
 */

const fs = require('fs')

const RE = {
  start: /^\[(\d{2}:\d{2}:\d{2})\] >>> 开始：(.+)$/,
  end: /^\[(\d{2}:\d{2}:\d{2})\] <<< (完成|失败)（(\d+)s）：(.*)$/,
  legacyDone: /^\[(\d{2}:\d{2}:\d{2})\] 他做完了（(\d+) 秒）：(.*)$/,
  ledger: /^\[(\d{2}:\d{2}:\d{2})\] \[ledger\](.*)$/,
  stall: /\[stall\]/,
  hardTimeout: /任务硬超时/,
  ts: /^\[(\d{2}:\d{2}:\d{2})\]/
}

function secOf (hhmmss) {
  const [h, m, s] = hhmmss.split(':').map(Number)
  return h * 3600 + m * 60 + s
}

/** 解析 [ledger] 正文里的四个数 */
function parseLedger (body) {
  const m = body.match(/背包([+-]?\d+)\s+减(\d+)\s+方块([?\d]+)\s+位移([?\d.]+)/)
  if (!m) return { invGain: null, invLoss: null, blocks: null, moved: null, ok: /结论:(成|败)/.exec(body)?.[1] || null }
  return {
    invGain: Number(m[1]),
    invLoss: Number(m[2]),
    blocks: m[3] === '?' ? null : Number(m[3]),
    moved: m[4] === '?' ? null : Number(m[4]),
    ok: /结论:(成|败)/.exec(body)?.[1] || null
  }
}

/**
 * 日志 → 任务记录数组
 * 时间戳只到秒，跨零点时用「后退超过 12 小时视为跨天」修正。
 */
function parseLog (text) {
  const lines = text.split('\n')
  const tasks = []
  const deaths = []
  let cur = null
  let dayOffset = 0
  let lastRaw = null
  let lastSec = null   // 兼容返回名：最后一行时间戳（含跨天偏移）

  // 秒数按「当天秒」比较，跨零点时整体加一天。
  // 注意：比较必须用 raw（0..86399），不能用已经加过 offset 的值，否则会连加两天。
  const tsec = (ts) => {
    const raw = secOf(ts)
    if (lastRaw != null && raw < lastRaw - 12 * 3600) dayOffset += 24 * 3600
    lastRaw = raw
    lastSec = raw + dayOffset
    return raw + dayOffset
  }

  for (const ln of lines) {
    let m
    if ((m = RE.start.exec(ln))) {
      cur = { ts: m[1], startSec: tsec(m[1]), goal: m[2].trim(), stalls: 0, hardTimeout: false, ledger: null, end: null }
      tasks.push(cur)
      continue
    }
    if (RE.stall.test(ln)) { if (cur) cur.stalls++; continue }
    if (RE.hardTimeout.test(ln)) { if (cur) cur.hardTimeout = true; continue }

    if ((m = RE.end.exec(ln))) {
      if (!cur) { // 日志中途开始，先补一条
        cur = { ts: m[1], startSec: null, goal: '(日志开始前就在跑)', stalls: 0, hardTimeout: false, ledger: null, end: null }
        tasks.push(cur)
      }
      cur.end = m[2]; cur.sec = Number(m[3]); cur.why = m[4].trim(); cur.endSec = tsec(m[1])
      cur = null
      continue
    }
    if ((m = RE.legacyDone.exec(ln))) {
      if (!cur) { cur = { ts: m[1], startSec: null, goal: '(旧格式)', stalls: 0, hardTimeout: false, ledger: null, end: null }; tasks.push(cur) }
      cur.end = '完成'; cur.sec = Number(m[2]); cur.why = m[3].trim(); cur.endSec = tsec(m[1])
      cur = null
      continue
    }
    if ((m = RE.ledger.exec(ln))) {
      if (!cur) { cur = { ts: m[1], startSec: null, goal: '(日志开始前就在跑)', stalls: 0, hardTimeout: false, ledger: null, end: null }; tasks.push(cur) }
      const led = parseLedger(m[2])
      led.raw = m[2].trim()
      led.ts = m[1]
      cur.ledger = led
      continue
    }
    if (/\[death\]/.test(ln)) {
      const t = RE.ts.exec(ln)
      deaths.push({ ts: t ? t[1] : null, sec: t ? tsec(t[1]) : null, line: ln.slice(0, 120) })
    }
  }
  return { tasks, deaths, lastSec: lastRaw == null ? null : lastRaw + dayOffset }
}

/** 单任务归类 */
function classify (t) {
  const led = t.ledger || {}
  const inv = led.invGain
  const blocks = led.blocks
  const moved = led.moved
  const hasMaterial = (inv != null && inv > 0) || (blocks != null && blocks > 0)
  const hasMove = moved != null && moved >= 1
  const hasAny = hasMaterial || hasMove
  const stuckSignal = t.stalls > 0 || t.hardTimeout

  if (!t.end) return { bucket: '未收尾', strict: stuckSignal ? '卡住/超时' : '未收尾', hasMaterial, hasMove, hasAny, stuckSignal }
  if (t.end === '完成') {
    // 账本没数（缺行、或者三项都是 ?）：不能当成"零产出"，否则会把"没测到"记成"没干活"
    if (!t.ledger || (inv == null && blocks == null && moved == null)) {
      return { bucket: '未核', strict: stuckSignal ? '卡住/超时' : '未核', hasMaterial, hasMove, hasAny, stuckSignal, unknownLedger: true }
    }
    return { bucket: hasAny ? '真产出' : '零产出通过', strict: stuckSignal ? '卡住/超时' : (hasAny ? '真产出' : '零产出通过'), hasMaterial, hasMove, hasAny, stuckSignal }
  }
  // 失败
  return { bucket: stuckSignal ? '卡住/超时' : '真失败', strict: stuckSignal ? '卡住/超时' : '真失败', hasMaterial, hasMove, hasAny, stuckSignal }
}

function summarize (text, opts = {}) {
  const { tasks, deaths, lastSec } = parseLog(text)
  const rows = tasks.map(t => Object.assign({}, t, classify(t)))
  const pick = (b) => rows.filter(r => r.bucket === b).length
  const strictPick = (b) => rows.filter(r => r.strict === b).length

  const firstSecRaw = text.split('\n').map(l => RE.ts.exec(l)).filter(Boolean).map(m => secOf(m[1]))[0] ?? null
  let firstSec = firstSecRaw
  if (firstSec != null && lastSec != null && firstSec > lastSec) firstSec += 24 * 3600 // 跨零点
  const endSec = lastSec
  const spanMin = firstSec != null && endSec != null ? Math.max(0, (endSec - firstSec) / 60) : 0

  const res = {
    log: opts.log || null,
    lines: text.split('\n').length,
    bots: opts.bots ?? null,
    span_min: Number(spanMin.toFixed(1)),
    开始: tasks.length,
    真产出: pick('真产出'),
    零产出通过: pick('零产出通过'),
    真失败: pick('真失败'),
    卡住超时: pick('卡住/超时'),
    未收尾: pick('未收尾'),
    未核: pick('未核'),
    严格口径: {
      真产出: strictPick('真产出'),
      零产出通过: strictPick('零产出通过'),
      真失败: strictPick('真失败'),
      卡住超时: strictPick('卡住/超时')
    },
    材料口径真产出: rows.filter(r => r.bucket === '真产出' && r.hasMaterial).length,
    只靠位移算真产出: rows.filter(r => r.bucket === '真产出' && !r.hasMaterial && r.hasMove).length,
    零产出通过明细: rows.filter(r => r.bucket === '零产出通过').map(r => ({ ts: r.ts, goal: r.goal.slice(0, 30), why: (r.why || '').slice(0, 30), sec: r.sec })),
    失败但有产出: rows.filter(r => r.end === '失败' && r.hasAny).map(r => ({
      ts: r.ts, goal: r.goal.slice(0, 24), why: (r.why || '').slice(0, 24),
      背包: r.ledger?.invGain, 方块: r.ledger?.blocks, 位移: r.ledger?.moved
    })),
    账本与任务行不一致: rows.filter(r => r.ledger && r.end && ((r.end === '完成' && r.ledger.ok === '败') || (r.end === '失败' && r.ledger.ok === '成'))).length,
    死亡: {
      次数: deaths.length,
      每N分钟一次: deaths.length ? Number((spanMin / deaths.length).toFixed(1)) : null,
      三十分钟外推: deaths.length ? Math.round(30 / (spanMin / deaths.length)) : null
    },
    rows: opts.detail ? rows : undefined,
    _raw: { tasks, deaths }
  }
  return res
}

/** 实机硬指标：说话数 / 最长静止 / 掉线 / 报错（不含心跳） */
function liveMetrics (text) {
  const lines = text.split('\n').filter(Boolean)
  const tsOf = (l) => { const m = RE.ts.exec(l); return m ? secOf(m[1]) : null }
  let maxGap = 0, gapAt = '', last = null
  for (const l of lines) {
    if (/\[hb\]/.test(l)) continue
    const t = tsOf(l)
    if (t == null) continue
    if (last != null) { const d = t - last; if (d >= 0 && d > maxGap) { maxGap = d; gapAt = l.slice(1, 9) } }
    last = t
  }
  const count = (re) => (text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length
  return {
    说话条数: count(/\[say\] /g),
    最长静止秒: maxGap,
    最长静止点: gapAt,
    被踢次数: count(/disconnect|被服务器踢了/g),
    // 「任务被中断」是正常的取消路径，不算报错；剩下的是脚本真的抛了异常
    报错行数: lines.filter(l => /\bError\b|TypeError|未捕获/.test(l) && !/任务被中断/.test(l)).length,
    中断次数: lines.filter(l => /任务被中断/.test(l)).length,
    心跳条数: count(/\[hb\]/g)
  }
}

/** 明早贴给人看的那一段 */
function brief (text, opts = {}) {
  const r = summarize(text, opts)
  const m = liveMetrics(text)
  const L = []
  L.push(`实机（${r.bots == null ? '**bot 数未标注，数字可能被污染**' : r.bots + ' 个其他 bot 在场'}）：`)
  L.push(`- 任务 ${r.开始} 开：真产出 ${r.真产出}（材料口径 ${r.材料口径真产出}）｜零产出通过 ${r.零产出通过}｜真失败 ${r.真失败}｜卡住/超时 ${r.卡住超时}｜未收尾 ${r.未收尾}`)
  L.push(`- 说话：${m.说话条数} 条`)
  L.push(`- 最长静止：${m.最长静止秒}s（${m.最长静止点}，不含心跳）`)
  L.push(`- 被踢：${m.被踢次数} 次｜报错：${m.报错行数} 行（另有 ${m.中断次数} 次正常取消）`)
  L.push(`- 死亡：${r.死亡.次数} 次 / ${r.span_min} 分钟 = 每 ${r.死亡.每N分钟一次 ?? '-'} 分钟一次（30 分钟外推 ${r.死亡.三十分钟外推 ?? 0} 次）`)
  const settled = r.开始 - r.未收尾 - (r.未核 || 0)
  if (settled > 0) {
    L.push(`- 材料产出率：${r.材料口径真产出} / ${settled} 个已收尾任务 = ${(100 * r.材料口径真产出 / settled).toFixed(0)}%` +
      `（分母只算已收尾；要回答"他会干活吗"看这行，别用「成/败」）`)
  }
  return L.join('\n')
}

function fmt (r) {
  const L = []
  L.push(`== 任务四栏 ==  ${r.log || ''}`)
  L.push(`日志 ${r.lines} 行｜时长 ${r.span_min} 分钟｜在场其他 bot：${r.bots == null ? '未标注（数字可能被污染）' : r.bots}`)
  L.push('')
  L.push(`  真产出        ${String(r.真产出).padStart(3)}   （其中材料口径 ${r.材料口径真产出}，只靠走路 ${r.只靠位移算真产出}）`)
  L.push(`  零产出通过    ${String(r.零产出通过).padStart(3)}   ← 判了"完成"但背包/方块/位移全 0`)
  L.push(`  真失败        ${String(r.真失败).padStart(3)}`)
  L.push(`  卡住/超时     ${String(r.卡住超时).padStart(3)}`)
  L.push(`  ── 开始合计    ${String(r.开始).padStart(3)}（未收尾 ${r.未收尾} / 未核 ${r.未核}，都不计入四栏）`)
  L.push('')
  const s = r.严格口径
  L.push(`严格口径（出现 [stall] 就算卡住）：真产出 ${s.真产出} / 零产出通过 ${s.零产出通过} / 真失败 ${s.真失败} / 卡住超时 ${s.卡住超时}`)
  L.push('')
  L.push('== 死亡 ==')
  if (!r.死亡.次数) L.push('0 次')
  else L.push(`${r.死亡.次数} 次 / ${r.span_min} 分钟 = 每 ${r.死亡.每N分钟一次} 分钟一次；按 30 分钟游戏外推 ≈ ${r.死亡.三十分钟外推} 次`)
  if (r.零产出通过明细.length) {
    L.push('')
    L.push('== 零产出通过明细（假"成"） ==')
    for (const z of r.零产出通过明细) L.push(`  ${z.ts}  ${z.sec}s  ${z.goal}  ｜ ${z.why}`)
  }
  if (r.失败但有产出.length) {
    L.push('')
    L.push(`== 失败但有产出（${r.失败但有产出.length} 条，四栏里算"真失败"，别当成啥也没干） ==`)
    for (const z of r.失败但有产出) L.push(`  ${z.ts}  ${z.goal}  ｜ 背包${z.背包} 方块${z.方块} 位移${z.位移} ｜ ${z.why}`)
  }
  if (r.账本与任务行不一致) L.push(`\n账本结论与任务行不一致：${r.账本与任务行不一致} 条`)
  if (r.rows) {
    L.push('')
    L.push('== 明细 ==')
    L.push('  时间      结局  秒   背包 方块 位移  归类        目标')
    for (const t of r.rows) {
      const l = t.ledger || {}
      L.push(`  ${t.ts}  ${(t.end || '未完').padEnd(2)} ${String(t.sec ?? '-').padStart(4)} ` +
        `${String(l.invGain ?? '-').padStart(4)} ${String(l.blocks ?? '-').padStart(4)} ${String(l.moved ?? '-').padStart(5)}  ` +
        `${t.bucket.padEnd(10)} ${t.goal.slice(0, 26)}`)
    }
  }
  return L.join('\n')
}

module.exports = { parseLog, summarize, classify, parseLedger, fmt, liveMetrics, brief }

if (require.main === module) {
  const argv = process.argv.slice(2)
  const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
  const has = (n) => argv.includes('--' + n)
  const log = arg('log', '/tmp/soak.log')
  if (!fs.existsSync(log)) { console.error('日志不存在: ' + log); process.exit(1) }
  const r = summarize(fs.readFileSync(log, 'utf8'), {
    log,
    bots: arg('bots', null) == null ? null : Number(arg('bots')),
    detail: has('detail')
  })
  delete r._raw
  delete r.rows
  if (has('brief')) {
    const full = summarize(fs.readFileSync(log, 'utf8'), { log, bots: r.bots })
    delete full._raw
    console.log(brief(fs.readFileSync(log, 'utf8'), { log, bots: r.bots }))
  } else if (has('json')) {
    const full = summarize(fs.readFileSync(log, 'utf8'), { log, bots: r.bots == null ? null : r.bots, detail: has('detail') })
    delete full._raw
    console.log(JSON.stringify(full, null, 2))
  } else {
    const full = summarize(fs.readFileSync(log, 'utf8'), { log, bots: r.bots == null ? null : r.bots, detail: has('detail') })
    console.log(fmt(full))
  }
}
