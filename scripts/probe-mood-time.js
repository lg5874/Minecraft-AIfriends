#!/usr/bin/env node
'use strict'
/**
 * 探针：UNHUMAN-SCAN #10（心情/累）/ #11（凌晨时间感）/ #12（游戏内昼夜）
 *
 * 两种模式，都能出原始数据：
 *
 *   1) 离线对照（不联网、不起 bot）
 *      node scripts/probe-mood-time.js --sim
 *      → 拿 git 里"改前"的 mood.js 和现在的 mood.js，喂同一串时间，
 *        打印每一分钟的心情标签，统计分布。
 *        这是"改前 36/36 irritated"能不能复现的证据。
 *
 *   2) 真机（起 bot，跑一段真实时间）
 *      node scripts/probe-mood-time.js --live --minutes 12
 *      node scripts/probe-mood-time.js --live --minutes 10 --hour 4   # 假时钟：凌晨
 *      → 采 **[hb] 心情:** 分布、[rest] 转场、[tod] 提示词里到底有没有时间、
 *        [time]/[say] 凌晨有没有提"几点了"
 *
 * 环境隔离同 probe-unhuman.js：独立账号 + 独立 AIFRIEND_DATA，不碰 data/runtime。
 */

const path = require('path')
const fs = require('fs')
const os = require('os')
const { execSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)
const argOf = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}

const SIM = has('sim')
const LIVE = has('live')
const MINUTES = parseFloat(argOf('minutes', '12')) || 12
const DURATION_MS = MINUTES * 60 * 1000
const HOUR = argOf('hour', null)
const MINUTE = parseInt(argOf('minute', '10'), 10) || 0
const ACCOUNT = argOf('account', 'XJJ_MT') + Math.random().toString(36).slice(2, 5)
const DATA_DIR = path.join('data', 'probe-mood-time', ACCOUNT)
const OUT_DIR = path.join(ROOT, 'data', 'test-results')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const clockStr = () => new Date().toTimeString().slice(0, 8)
const pct = v => Math.round(Number(v) * 100) + '%'

// ==================================================================
// 模式 1：离线对照
// ==================================================================
function loadOldMood (tmpDir) {
  // 改前的版本：commit 112917d 的父提交（#10/#11/#12 改动之前）
  const src = execSync('git show 112917d^:src/mood.js', { cwd: ROOT, encoding: 'utf8' })
  const f = path.join(tmpDir, 'mood-old.js')
  // 它 require('path') 用的绝对路径，放在 src/ 里更保险
  const dst = path.join(ROOT, 'src', '.mood-old.tmp.js')
  fs.writeFileSync(dst, src, 'utf8')
  return dst
}

function runSim () {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moodsim-'))
  const oldPath = loadOldMood(tmpDir)
  let OldMood = null
  try {
    delete require.cache[require.resolve(oldPath)]
    OldMood = require(oldPath)
  } catch (e) {
    console.error('加载改前 mood.js 失败: ' + e.message)
    process.exit(2)
  }
  delete require.cache[require.resolve(path.join(ROOT, 'src', 'mood.js'))]
  const NewMood = require(path.join(ROOT, 'src', 'mood.js'))

  // 两套起点：一个"正常开局"，一个"实测掉到底的现场"
  const cases = [
    { name: '正常开局 energy .70 / irritation .10', v: { energy: 0.70, spirit: 0.60, irritation: 0.10, satisfaction: 0.50 } },
    { name: '实测现场 energy .00 / irritation .90', v: { energy: 0.00, spirit: 0.63, irritation: 0.90, satisfaction: 1.00 } }
  ]

  const simDirA = fs.mkdtempSync(path.join(tmpDir, 'a-'))
  const simDirB = fs.mkdtempSync(path.join(tmpDir, 'b-'))

  for (const c of cases) {
    console.log('\n' + '='.repeat(70))
    console.log('【离线对照】' + c.name)
    console.log('='.repeat(70))

    const mk = (C, dir, vals) => {
      const m = new C(dir)
      Object.assign(m, vals)
      m.energy = vals.energy
      m.resting = false
      m._restSince = 0
      m.save()
      return m
    }
    const oldM = mk(OldMood, simDirA, c.v)
    const newM = mk(NewMood, simDirB, c.v)

    const oldCount = {}
    const newCount = {}
    const newRest = []
    const rows = []
    for (let i = 0; i <= 25; i++) {
      const o = oldM.state()
      const n = newM.state()
      oldCount[o] = (oldCount[o] || 0) + 1
      newCount[n] = (newCount[n] || 0) + 1
      if (newM.resting) {
        const last = newRest[newRest.length - 1]
        if (!last || last.ended) newRest.push({ from: i, ended: false })
      } else {
        const last = newRest[newRest.length - 1]
        if (last && !last.ended) { last.to = i; last.ended = true }
      }
      rows.push(`  第${String(i).padStart(2)}分  改前=${String(o).padEnd(9)} 改后=${String(n).padEnd(9)}  energy ${pct(oldM.energy).padStart(4)} → ${pct(newM.energy).padStart(4)}  irritation ${pct(oldM.irritation).padStart(4)} → ${pct(newM.irritation).padStart(4)}  ${newM.resting ? '【在歇】' : ''}`)
      oldM.tick(1)
      newM.tick(1)
    }
    console.log('  分钟  改前                改后               精力(前→后)          烦躁(前→后)')
    rows.forEach(r => console.log(r))
    console.log('')
    console.log('  分布（26 个采样点）')
    console.log('    改前: ' + Object.entries(oldCount).map(([k, v]) => `${k} ${v}`).join(' / '))
    console.log('    改后: ' + Object.entries(newCount).map(([k, v]) => `${k} ${v}`).join(' / '))
    if (newRest.length) {
      console.log('  休息区间（改后）: ' + newRest.map(r => `第${r.from}~${r.to == null ? '25+' : r.to}分`).join('，'))
    } else {
      console.log('  休息区间（改后）: 无')
    }
    console.log('  改后 bodyPrompt(): ' + (newM.bodyPrompt() || '（空）'))
  }

  try { fs.unlinkSync(oldPath) } catch (e) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (e) {}
}

// ==================================================================
// 模式 2：真机
// ==================================================================
const M = {
  hb: [],
  moods: {},
  rest: [],
  tod: [],
  time: [],
  say: [],
  samples: [],   // mood.json 快照
  lines: 0
}

const TIME_WORDS = /几点了|几点|这么晚|都这么|凌晨|夜深|睡了|睡了|睡|熬夜|困|明早|下线|下了|几号|半夜|天亮/

function feed (line) {
  M.lines++
  const t = String(line)
  // 探针自己的进度行也带 [rest]/[tod]/[time] 字样，别把它们数进去
  if (/^\[probe\]/.test(t)) return

  const hb = /\[hb\]\s*(-?\d+),(-?\d+),(-?\d+).*?心情[:：]\s*(\w+)/.exec(t)
  if (hb) {
    M.hb.push({ at: Date.now(), pos: `${hb[1]},${hb[2]},${hb[3]}`, mood: hb[4] })
    M.moods[hb[4]] = (M.moods[hb[4]] || 0) + 1
  }

  if (/\[rest\]/.test(t)) M.rest.push(t.replace(/^\[[^\]]*\]\s*/, '').trim())
  if (/\[tod\]/.test(t)) M.tod.push(t.replace(/^\[[^\]]*\]\s*/, '').trim())
  if (/\[time\]/.test(t)) M.time.push(t.replace(/^\[[^\]]*\]\s*/, '').trim())

  const say = /\[say\]\s*(.*)$/.exec(t)
  if (say) M.say.push(say[1].trim())
}

async function runLive () {
  const { rev, dirty } = (() => {
    try {
      return {
        rev: execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(),
        dirty: execSync('git status --porcelain -- src main.js', { cwd: ROOT, encoding: 'utf8' })
          .trim().split('\n').filter(Boolean)
      }
    } catch (e) { return { rev: 'unknown', dirty: [] } }
  })()

  process.env.AIFRIEND_DATA = DATA_DIR
  fs.mkdirSync(path.join(ROOT, DATA_DIR), { recursive: true })

  // --seed-energy：把初始精力压到指定值，用来测"累到极限会不会真的歇"
  // （不种的话能量从 0.7 起步，20 分钟根本掉不到 0.15，测不出休息触发）
  const seedEnergy = argOf('seed-energy', null)
  if (seedEnergy !== null) {
    const seed = {
      energy: parseFloat(seedEnergy),
      spirit: parseFloat(argOf('seed-spirit', '0.62')),
      irritation: parseFloat(argOf('seed-irritation', '0.82')),
      satisfaction: 0.9,
      lastTick: 0,
      _angeredAt: 0,
      resting: false
    }
    fs.writeFileSync(path.join(ROOT, DATA_DIR, 'mood.json'), JSON.stringify(seed))
    console.log(`种子心情: energy=${seed.energy} irritation=${seed.irritation}（写进 ${DATA_DIR}/mood.json）`)
  }

  console.log('='.repeat(70))
  console.log('  UNHUMAN #10/#11/#12 真机探针')
  console.log('='.repeat(70))
  console.log(`代码版本 : ${rev}${dirty.length ? ` ⚠️ 未提交 ${dirty.length} 个文件` : '（干净）'}`)
  dirty.forEach(d => console.log('           ' + d))
  console.log(`账号     : ${ACCOUNT}（独立）`)
  console.log(`数据目录 : ${DATA_DIR}（独立，不碰 data/runtime）`)
  console.log(`时长     : ${MINUTES} 分钟`)
  if (HOUR != null) {
    console.log(`时钟     : 伪造为 ${String(HOUR).padStart(2, '0')}:${String(MINUTE).padStart(2, '0')}（真实 ${clockStr()}）`)
  } else {
    console.log(`时钟     : 真实（${clockStr()}）`)
  }
  console.log('='.repeat(70) + '\n')

  // ---- 假时钟：只改 realtime 模块，代码逻辑一行不动 ----
  if (HOUR != null) {
    const rt = require(path.join(ROOT, 'src', 'realtime.js'))
    const orig = rt.realTime
    rt.realTime = () => {
      const d = new Date()
      d.setHours(parseInt(HOUR, 10), MINUTE, 0, 0)
      return orig(d)
    }
  }

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
  cfg.bot.username = ACCOUNT
  cfg.behavior = cfg.behavior || {}
  cfg.behavior.reconnectDelaySeconds = 15
  const tmpCfg = path.join(ROOT, 'data', `probe-mt-${ACCOUNT}.json`)
  fs.writeFileSync(tmpCfg, JSON.stringify(cfg, null, 2))
  process.env.AIFRIEND_CONFIG = path.relative(ROOT, tmpCfg)

  const rawLog = []
  const origLog = console.log.bind(console)
  console.log = (...args) => {
    const line = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ')
    rawLog.push(line)
    feed(line)
    origLog(...args)
  }

  const { Bot } = require(path.join(ROOT, 'main.js'))
  const b = new Bot(cfg)
  b.connect()

  // 心情文件采样：mood.json 是它自己写的，比任何内部变量都可信
  const moodFile = path.join(ROOT, DATA_DIR, 'mood.json')
  const t0 = Date.now()
  const ticker = setInterval(() => {
    try {
      const d = JSON.parse(fs.readFileSync(moodFile, 'utf8'))
      M.samples.push({
        secs: Math.round((Date.now() - t0) / 1000),
        energy: +Number(d.energy).toFixed(3),
        irritation: +Number(d.irritation).toFixed(3),
        spirit: +Number(d.spirit).toFixed(3),
        resting: !!d.resting
      })
    } catch (e) {}
    const el = Math.round((Date.now() - t0) / 1000)
    origLog(`[probe] ${el}s ｜ 心跳 ${M.hb.length} ｜ 心情 ${JSON.stringify(M.moods)} ｜ [rest] ${M.rest.length} ｜ [tod] ${M.tod.length} ｜ [time] ${M.time.length} ｜ say ${M.say.length}`)
  }, 30000)

  await sleep(DURATION_MS)
  clearInterval(ticker)

  try { b.shutdown() } catch (e) {}
  await sleep(1500)
  const realLog = console.log
  console.log = origLog

  // ---- 原始数据 ----
  const show = (title, arr, n = 40) => {
    realLog('\n' + title + `（${arr.length} 条）`)
    if (!arr.length) { realLog('  （空）'); return }
    arr.slice(-n).forEach(x => realLog('  ' + x))
  }

  realLog('\n' + '='.repeat(70))
  realLog('  原始数据')
  realLog('='.repeat(70))

  realLog('\n【#10 心情分布】[hb] 采样 ' + M.hb.length + ' 次')
  Object.entries(M.moods).forEach(([k, v]) => realLog(`  ${k.padEnd(10)} ${v}`))
  realLog('  逐条 [' + M.hb.map(h => h.mood).join(', ') + ']')

  const restCycles = M.samples.filter(s => s.resting)
  realLog('\n【#10 精力/休息】mood.json 采样 ' + M.samples.length + ' 次，其中 resting=true ' + restCycles.length + ' 次')
  M.samples.forEach(s => realLog(`  ${String(s.secs).padStart(4)}s energy=${s.energy.toFixed(3)} irritation=${s.irritation.toFixed(3)} spirit=${s.spirit.toFixed(3)} resting=${s.resting}`))
  show('【#10 休息转场】[rest]', M.rest)

  realLog('\n【#12 游戏内时间进提示词】[tod]')
  show('', M.tod)

  realLog('\n【#11 凌晨时间感】[time]')
  show('', M.time)
  const timeTalks = M.say.filter(s => TIME_WORDS.test(s))
  realLog('\n  提到时间/熬不住的 [say]: ' + timeTalks.length + ' 条')
  timeTalks.forEach(s => realLog('    「' + s + '」'))
  show('  全部 [say]', M.say.map(s => '「' + s + '」'))

  const report = {
    at: new Date().toISOString(),
    account: ACCOUNT, codeRev: rev, codeDirty: dirty,
    minutes: MINUTES, fakeHour: HOUR == null ? null : `${HOUR}:${MINUTE}`,
    moodDist: M.moods,
    hbMoods: M.hb.map(h => h.mood),
    restLog: M.rest,
    todLog: M.tod,
    timeLog: M.time,
    say: M.say,
    samples: M.samples
  }
  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, `mood-time-${runId}.json`), JSON.stringify(report, null, 2))
  fs.writeFileSync(path.join(OUT_DIR, `mood-time-${runId}.log`), rawLog.join('\n'))
  realLog('\n原始日志: data/test-results/mood-time-' + runId + '.log')
  try { fs.unlinkSync(tmpCfg) } catch (e) {}
  process.exit(0)
}

// ==================================================================
if (SIM) { runSim(); process.exit(0) }
if (LIVE) {
  runLive().catch(e => {
    console.error('探针崩溃: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e))
    process.exit(2)
  })
} else {
  console.log('用法：')
  console.log('  node scripts/probe-mood-time.js --sim')
  console.log('  node scripts/probe-mood-time.js --live --minutes 12 [--hour 4]')
}
