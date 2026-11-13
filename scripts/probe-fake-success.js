'use strict'
// #8 真机探针：三层假进度判据修完之后的真实数据。
//
// 和 scripts/probe-unhuman.js 的区别：
//   · 那个测的是 #1/#6/#9 的行为特征；这个只测 #8 的三层判据
//   · 这里额外抓 [proof]、[skill] 复用核验、[goals] 拒绝白送
//   · 落盘失败不炸（proot 里 mkdir 有时 ENOSYS）
//   · 模型 provider 顺序可覆盖：主线路挂掉时先打备用线
//
// 用法：
//   node scripts/probe-fake-success.js --minutes 10
//   node scripts/probe-fake-success.js --minutes 10 --provider backup

const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const argv = process.argv.slice(2)
const argOf = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}

const MINUTES = parseFloat(argOf('minutes', '10')) || 10
const DURATION_MS = MINUTES * 60 * 1000
const ACCOUNT = argOf('account', 'XJJ_P8') + Math.random().toString(36).slice(2, 5)
const PROVIDER = argOf('provider', 'backup')
const DATA_DIR = path.join('data', 'probe-p8', ACCOUNT)
process.env.AIFRIEND_DATA = DATA_DIR
const USE_REAL_LIB = argv.includes('--lib') && argv[argv.indexOf('--lib') + 1] === 'real'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const clock = () => new Date().toTimeString().slice(0, 8)

// ---------------- 指标 ----------------
const M = {
  lines: 0,
  taskStart: 0,
  taskDone: 0,
  taskFail: 0,
  taskEnvFail: 0,          // 环境故障单独计，不算判据的账
  failReasons: [],
  proofPass: 0,
  proofSamples: [],
  skillReuse: 0,
  skillReuseOk: 0,
  skillReuseFail: 0,
  skillFakeFail: 0,            // "代码跑完了，但世界没变"
  skillSamples: [],
  goalsRefused: 0,             // [goals] 拒绝白送
  completedLines: 0,           // <<< 完成 的行数（成功率分母）
  ledgerLines: 0,              // [ledger] 行数
  ledgerMismatch: 0,           // 声称 != 实际 的条数
  ledgerSamples: [],
  noProgressAbandon: 0,        // [skill] 白干 Ns，主动放弃
  skillRefusedSave: 0,         // [skill] 没有无进展出口，不入库
  stageAdvance: 0,             // [goals] 过了一步
  goalAbandon: 0,
  hb: [],
  say: 0
}

function feed (line) {
  M.lines++
  const t = String(line)
  if (/^\[\d\d:\d\d:\d\d\]\s*>>>\s*开始[:：]/.test(t)) M.taskStart++
  if (/\[ledger\]/.test(t)) {
    M.ledgerLines++
    // 形如  声称:圆石5/实际+2
    const mm = /声称:([^/\s]+)\/([+-]?\d+|\?)/.exec(t)
    if (mm && mm[2] !== '?') {
      const claimed = /(\d+)/.exec(mm[1])
      const actual = parseInt(mm[2].replace('+', ''), 10)
      const cN = claimed ? parseInt(claimed[1], 10) : null
      // 声称 N 个、实际只多/少了 D 个 —— 差额按 |N-D| 记
      if (cN !== null && !Number.isNaN(actual) && Math.abs(cN - actual) > 0) {
        M.ledgerMismatch++
        if (M.ledgerSamples.length < 8) M.ledgerSamples.push(t.replace(/^\[\d\d:\d\d:\d\d\]\s*/, '').slice(0, 110))
      }
    }
  }
  if (/<<<\s*完成（/.test(t)) M.taskDone++
  const mf = /<<<\s*失败（(\d+)s）[:：]\s*(.*)$/.exec(t)
  if (mf) {
    M.taskFail++
    const reason = mf[2] || ''
    // 环境故障（DNS/超时/HTTP 5xx）不是"任务失败"的证据 ——
    // 上一轮 8 个失败里 6 个是 EAI_AGAIN，这么算出来的成功率是网络的成功率，
    // 不是判据的成功率。分开计。
    if (/模型调用失败|EAI_AGAIN|HTTP \d|ECONN|timeout|超时/.test(reason)) M.taskEnvFail++
    else if (M.failReasons.length < 25) M.failReasons.push(reason.slice(0, 90))
  }
  if (/\[proof\]\s*硬判据通过/.test(t)) {
    M.proofPass++
    if (M.proofSamples.length < 12) M.proofSamples.push(t.replace(/^\[\d\d:\d\d:\d\d\]\s*/, '').slice(0, 100))
  }
  const mr = /\[skill\]\s*复用\s+(k_\w+)[:：]\s*(.*)$/.exec(t)
  if (mr) {
    M.skillReuse++
    if (M.skillSamples.length < 25) M.skillSamples.push(t.replace(/^\[\d\d:\d\d:\d\d\]\s*/, '').slice(0, 110))
  }
  if (/\[skill\]\s*k_\w+\s*代码跑完了，但世界没变/.test(t)) {
    M.skillFakeFail++
    if (M.skillSamples.length < 25) M.skillSamples.push(t.replace(/^\[\d\d:\d\d:\d\d\]\s*/, '').slice(0, 110))
  }
  if (/白干\s*\d+s/.test(t)) M.noProgressAbandon++
  if (/没有"无进展就退出"的出口，不入库/.test(t)) M.skillRefusedSave++
  if (/\[goals\]\s*拒绝白送/.test(t)) M.goalsRefused++
  if (/\[goals\]\s*过了一步/.test(t)) M.stageAdvance++
  if (/\[goals\]\s*放弃/.test(t)) M.goalAbandon++
  if (/\[say\]/.test(t)) M.say++
  const mh = /\[hb\]\s*(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(t)
  if (mh) M.hb.push({ x: +mh[1], y: +mh[2], z: +mh[3] })
}

function summarize () {
  const hb = M.hb
  const rng = (k) => (hb.length ? +(Math.max(...hb.map(h => h[k])) - Math.min(...hb.map(h => h[k]))).toFixed(1) : null)
  const realFail = M.taskFail - M.taskEnvFail
  const total = M.taskDone + realFail
  return {
    rate: total ? Math.round(M.taskDone / total * 100) : null,
    rateWithEnv: (M.taskDone + M.taskFail) ? Math.round(M.taskDone / (M.taskDone + M.taskFail) * 100) : null,
    total,
    envFail: M.taskEnvFail,
    range: hb.length ? { dx: rng('x'), dy: rng('y'), dz: rng('z') } : null,
    hbCount: hb.length
  }
}

// ---------------- 主流程 ----------------
async function main () {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
  cfg.bot.username = ACCOUNT
  cfg.behavior = cfg.behavior || {}
  cfg.behavior.reconnectDelaySeconds = 15

  // 主线路（neko）实测 503 model_not_found；备用线路 200。
  // 把能用的排前面，否则整轮全是"模型调用失败"，成功率毫无意义。
  if (PROVIDER === 'backup' && Array.isArray(cfg.llm.providers) && cfg.llm.providers.length > 1) {
    const ok = cfg.llm.providers.filter(p => !/nekoapi/.test(p.baseUrl))
    const rest = cfg.llm.providers.filter(p => /nekoapi/.test(p.baseUrl))
    cfg.llm.providers = [...ok, ...rest]
  }

  const tmpCfg = path.join(ROOT, 'data', `probe8-config-${ACCOUNT}.json`)
  try { fs.mkdirSync(path.dirname(tmpCfg), { recursive: true }) } catch (e) {}
  fs.writeFileSync(tmpCfg, JSON.stringify(cfg, null, 2))
  process.env.AIFRIEND_CONFIG = path.relative(ROOT, tmpCfg)

  const { Bot } = require(path.join(ROOT, 'main.js'))

  const origLog = console.log.bind(console)
  const raw = []
  console.log = (...a) => {
    const line = a.map(x => (typeof x === 'string' ? x : String(x))).join(' ')
    raw.push(line)
    feed(line)
    origLog(...a)
  }

  console.log('='.repeat(64))
  console.log('  #8 三层假进度判据 · 真机探针')
  console.log('='.repeat(64))
  console.log(`账号      : ${ACCOUNT}（独立）`)
  console.log(`数据目录  : ${DATA_DIR}（独立，不碰 data/runtime）`)
  console.log(`时长      : ${MINUTES} 分钟`)
  console.log(`模型      : ${cfg.llm.providers.map(p => p.name + '/' + p.model).join(' , ')}`)
  console.log(`基线      : 成功率 98%（假成功）｜dx=3 dy=25 dz=2`)
  console.log('='.repeat(64) + '\n')

  // 用正式技能库跑：这样被点名的那几条老技能（k_mwe60wh8 等）
  // 才会真的被复用，它的 ok/fail 才有得看
  let libBase = null
  if (USE_REAL_LIB) {
    try {
      fs.mkdirSync(path.join(ROOT, DATA_DIR), { recursive: true })
      const src = path.join(ROOT, 'data', 'runtime', 'skills.json')
      fs.copyFileSync(src, path.join(ROOT, DATA_DIR, 'skills.json'))
      const lib = JSON.parse(fs.readFileSync(src, 'utf8'))
      libBase = {}
      for (const sk of lib.skills || []) {
        libBase[sk.name] = { ok: sk.ok || 0, fail: sk.fail || 0, uses: sk.uses || 0, desc: sk.desc }
      }
      console.log(`技能库    : 正式库副本（${Object.keys(libBase).length} 条）`)
    } catch (e) {
      console.log('[warn] 拷技能库失败：' + e.message)
    }
  }

  const b = new Bot(cfg)
  b.connect()

  const t0 = Date.now()
  const ticker = setInterval(() => {
    console.log(`[probe] 已跑 ${Math.round((Date.now() - t0) / 1000)}s ｜ 任务 ${M.taskDone}成/${M.taskFail}败 ｜ ` +
      `硬判据过 ${M.proofPass} ｜ 技能复用 ${M.skillReuse}（世界没变被否 ${M.skillFakeFail}）｜ 目标拒绝白送 ${M.goalsRefused}`)
    // 每 60 秒落一次盘。这台机器今天已经被引擎中断干过两次，
    // 上一轮 10 分钟的数据就这么没了 —— 有快照就还有数。
    try {
      const dir = path.join(ROOT, 'data', 'test-results')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'p8-live.json'), JSON.stringify({
        at: new Date().toISOString(), account: ACCOUNT, elapsedSec: Math.round((Date.now() - t0) / 1000),
        task: { start: M.taskStart, done: M.taskDone, fail: M.taskFail, envFail: M.taskEnvFail },
        range: summarize().range, heartbeats: M.hb.length,
        proofPass: M.proofPass, skill: { reuse: M.skillReuse, fakeFail: M.skillFakeFail },
        goals: { refused: M.goalsRefused, advanced: M.stageAdvance, abandoned: M.goalAbandon },
    ledger: { lines: M.ledgerLines, mismatch: M.ledgerMismatch, proofCoverage: proofCov, mismatchSamples: M.ledgerSamples },
        failReasons: M.failReasons
      }, null, 1))
    } catch (e) {}
  }, 60000)

  await sleep(DURATION_MS)
  clearInterval(ticker)

  try { b.shutdown() } catch (e) {}
  await sleep(1500)

  const sum = summarize()

  console.log('\n' + '='.repeat(64))
  console.log('  硬数据')
  console.log('='.repeat(64))
  console.log(`任务 开始/完成/失败 : ${M.taskStart} / ${M.taskDone} / ${M.taskFail}（其中环境故障 ${M.taskEnvFail}）`)
  console.log(`成功率（剔环境故障）: ${sum.rate === null ? 'n/a' : sum.rate + '%'}   ← 基线 98%`)
  console.log(`成功率（不剔）      : ${sum.rateWithEnv === null ? 'n/a' : sum.rateWithEnv + '%'}`)
  console.log(`硬判据放行          : ${M.proofPass}`)
  console.log(`坐标范围            : ${sum.range ? `dx=${sum.range.dx} dy=${sum.range.dy} dz=${sum.range.dz}` : 'n/a'}   ← 基线 dx=3 dy=25 dz=2`)
  console.log(`心跳样本            : ${sum.hbCount}`)
  console.log(`技能复用            : ${M.skillReuse} 次，其中世界没变被否 ${M.skillFakeFail}`)
  console.log(`无进展主动放弃      : ${M.noProgressAbandon} 次   ← 靠"多久没改变世界"退出，不靠 420s 超时`)
  console.log(`新技能被拒入库      : ${M.skillRefusedSave} 次   ← 没有"没进展就退出"的代码` )
  console.log(`目标 拒绝白送/过步/放弃: ${M.goalsRefused} / ${M.stageAdvance} / ${M.goalAbandon}`)
  // 验收补充三项
  const proofCov = M.taskDone ? Math.round(M.proofPass / M.taskDone * 100) : null
  const ledgerMismatchRate = M.ledgerLines ? Math.round(M.ledgerMismatch / M.ledgerLines * 100) : null
  console.log(`[账本] 判成功带硬判据背书: ${M.proofPass}/${M.taskDone} = ${proofCov === null ? 'n/a' : proofCov + '%'}   ← 目标 100%`)
  console.log(`[账本] 声称 vs 实际 不符: ${M.ledgerMismatch}/${M.ledgerLines} = ${ledgerMismatchRate === null ? 'n/a' : ledgerMismatchRate + '%'}   ← 目标 <20%`)
  if (M.failReasons.length) {
    console.log('失败原因：')
    M.failReasons.forEach((r, i) => console.log(`  ${i + 1}. ${r}`))
  }
  if (M.proofSamples.length) {
    console.log('硬判据放行样本：')
    M.proofSamples.forEach(s => console.log('  ' + s))
  }

  // 技能库增量：这一轮里哪些老技能被复用、记成什么
  const libDelta = []
  try {
    const sp = path.join(ROOT, DATA_DIR, 'skills.json')
    const lib = JSON.parse(fs.readFileSync(sp, 'utf8'))
    const now = {}
    for (const sk of lib.skills || []) now[sk.name] = sk
    for (const [name, b0] of Object.entries(libBase || {})) {
      const a = now[name]
      if (!a) { libDelta.push({ name, desc: b0.desc, removed: true }); continue }
      const dOk = (a.ok || 0) - b0.ok
      const dFail = (a.fail || 0) - b0.fail
      if (dOk || dFail) {
        libDelta.push({ name, desc: b0.desc, ok: dOk, fail: dFail, wasOk: b0.ok, wasFail: b0.fail })
      }
    }
    libDelta.sort((x, y) => (y.ok + y.fail) - (x.ok + x.fail))
    if (libDelta.length) {
      console.log('\n本轮技能记账（老技能）：')
      for (const r of libDelta.slice(0, 12)) {
        console.log(`  ${r.name}｜${String(r.desc).slice(0, 26)}｜本轮 ok=${r.ok || 0} fail=${r.fail || 0}` +
          `（累计 ${r.wasOk}+${r.ok || 0}/${r.wasOk + r.wasFail + (r.ok || 0) + (r.fail || 0)}）`)
      }
    } else {
      console.log('\n本轮没有老技能被复用')
    }
  } catch (e) { console.log('[warn] 读技能库失败：' + e.message) }

  // k_mwe60wh8 的成功率：从探针自己的技能库读
  let k60 = null
  try {
    const sp = path.join(ROOT, DATA_DIR, 'skills.json')
    if (fs.existsSync(sp)) {
      const lib = JSON.parse(fs.readFileSync(sp, 'utf8'))
      const s = (lib.skills || []).find(x => x.name === 'k_mwe60wh8')
      if (s) k60 = { uses: s.uses || 0, ok: s.ok || 0, fail: s.fail || 0, lifetimeOk: s.lifetimeOk || 0, lifetimeFail: s.lifetimeFail || 0 }
    }
  } catch (e) {}

  const out = {
    at: new Date().toISOString(),
    account: ACCOUNT,
    minutes: MINUTES,
    provider: PROVIDER,
    task: { start: M.taskStart, done: M.taskDone, fail: M.taskFail, envFail: M.taskEnvFail, rate: sum.rate, rateWithEnv: sum.rateWithEnv },
    range: sum.range,
    heartbeats: sum.hbCount,
    proofPass: M.proofPass,
    skill: { reuse: M.skillReuse, fakeFail: M.skillFakeFail, k_mwe60wh8: k60, delta: libDelta,
      noProgressAbandon: M.noProgressAbandon, refusedSave: M.skillRefusedSave },
    goals: { refused: M.goalsRefused, advanced: M.stageAdvance, abandoned: M.goalAbandon },
    failReasons: M.failReasons,
    samples: { proof: M.proofSamples, skill: M.skillSamples }
  }

  const dir = path.join(ROOT, 'data', 'test-results')
  try {
    fs.mkdirSync(dir, { recursive: true })
    const f = path.join(dir, `p8-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    fs.writeFileSync(f, JSON.stringify(out, null, 1))
    console.log(`\n结果已存：${f}`)
  } catch (e) {
    console.log('[warn] 结果落盘失败（不影响数据）：' + e.message)
  }
  process.exit(0)
}

main().catch(e => {
  console.log('[fatal] ' + e.message)
  process.exit(1)
})
