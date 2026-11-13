#!/usr/bin/env node
/**
 * 长跑采样器 v3：快照线 + 事件线 + bot_count + 四栏任务统计
 *
 * 【v1 的问题】只有累计计数器，看不出「构成」。
 * 【v2 的问题】任务统计还是「开 / 成 / 败」三栏，「成」里混着背包+0、方块+0、位移+0 的空转。
 *   一句「50% 成功率」会让人以为机器人在干活。v3 把任务拆成四栏（见 scripts/task-stats.js）：
 *     真产出 / 零产出通过 / 真失败 / 卡住·超时
 *
 * 【为什么必须有 bot_count】
 * 今晚最贵的教训：不知道环境，数字就不能用。
 * 「75% 跟随」「0.1-0.5 吞吐」全是被 10 个测试 bot 污染过的。
 * 采样器自己记环境，明早任何人看 CSV 都知道这个数能不能用。
 * v3 修正：v2 用 10 分钟内出现过的名字猜在线人数，会把路过的人算进去（实测报过 30）。
 *   现在只认「进来了：<名字>」这类进场事件，并且扣掉自己 —— 是**在线下限**，不是实时人数。
 *
 * 用法（必须在仓库根目录跑，或者用绝对路径 —— 路径写错会报 ERR_MODULE_NOT_FOUND）：
 *   cd /root/workspace/minecraft-AIfriend
 *   node scripts/sample-soak.js --log /tmp/soak.log --out /tmp/soak.csv --interval 60
 *
 * 产出两个文件：
 *   <out>         快照线（CSV，一行一个采样点）
 *   <out>.events  事件线（只记发生的那一刻，带相对秒数）
 *
 * 只读日志，不碰 bot、不连服务器。
 */

const fs = require('fs')
const { summarize } = require('./task-stats')

const argv = process.argv.slice(2)
function arg (name, def) {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}

const LOG = arg('log', '/tmp/soak.log')
const OUT = arg('out', '/tmp/soak.csv')
const EVT = OUT + '.events'
const INTERVAL = Number(arg('interval', '60')) * 1000

if (!fs.existsSync(LOG)) {
  console.error('日志不存在: ' + LOG)
  process.exit(1)
}

let lastLen = 0          // 上次读到哪（事件线用增量）
let t0 = null            // 首行时间戳作基准
let seenEvents = new Set()

function readNew () {
  const buf = fs.readFileSync(LOG)
  if (buf.length <= lastLen) return ''
  const chunk = buf.slice(lastLen).toString('utf8')
  lastLen = buf.length
  return chunk
}

function relSec (tsLine) {
  const m = tsLine.match(/^\[(\d{2}):(\d{2}):(\d{2})\]/)
  if (!m) return null
  const sec = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])
  if (t0 == null) t0 = sec
  return sec - t0
}

// ---- 快照：从整个日志里抽当前状态 ----
function snapshot () {
  const s = fs.readFileSync(LOG, 'utf8')
  const lines = s.split('\n')

  const cnt = (re) => (s.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length

  // 最后一次心跳：坐标 / 血 / 饿 / 背包种数 / 忙什么 / 锁
  let hb = null
  for (let i = lines.length - 1; i >= 0 && !hb; i--) {
    const m = lines[i].match(/\[hb\]\s+(-?\d+),(-?\d+),(-?\d+)\s+血(\d+)\s+饿(\d+)\s+背包(\d+)种\s+(\S+)/)
    if (m) hb = { x: +m[1], y: +m[2], z: +m[3], hp: +m[4], food: +m[5], kinds: +m[6], busy: m[7] }
  }

  // 当前目标
  let goal = ''
  for (let i = lines.length - 1; i >= 0 && !goal; i--) {
    const m = lines[i].match(/\[goals\]\s+(?:自己定了个方向|立了个长期目标|换法子（目标不变）)[：:]\s*(.+)/)
    if (m) goal = m[1].slice(0, 24)
  }
  if (!goal) {
    for (let i = lines.length - 1; i >= 0 && !goal; i--) {
      const m = lines[i].match(/>>> 开始：(.+)/)
      if (m) goal = '任务:' + m[1].slice(0, 20)
    }
  }

  // 自己是谁：从「连接 <host> 作为 <NAME>」或第一次「进来了：<NAME>」取
  let self = null
  const ms = s.match(/连接 \S+ 作为 ([A-Za-z0-9_]{2,16})/)
  if (ms) self = ms[1]

  // 在场其他 bot（下限）：只认进场事件，扣掉自己
  const joins = new Set()
  const reJoin = /(?:进来了|过来了)：([A-Za-z0-9_]{2,16})/g
  let jm
  while ((jm = reJoin.exec(s)) !== null) joins.add(jm[1])
  if (!self && joins.size) self = [...joins][0]
  joins.delete(self)

  // 任务四栏
  const st = summarize(s, { log: LOG })

  return {
    kicks: cnt(/被服务器踢了|disconnect\.spam|Connection throttled/g),
    r429: cnt(/HTTP 429|rate_limit/g),
    says: cnt(/\[say\] /g),
    started: st.开始,
    done: cnt(/<<< 完成（/g),
    failed: cnt(/<<< 失败（/g),
    proof: cnt(/\[proof\] 硬判据通过/g),
    deaths: cnt(/\[death\]/g),
    falls: cnt(/\[fall\] 落差/g),
    stuck: cnt(/\[stuck\] 同一格站了/g),
    lines: lines.length,
    hb,
    goal,
    botCount: joins.size,
    bots: [...joins].slice(0, 5).join('|'),
    four: st
  }
}

// ---- 事件线：只记这几类，发生即记 ----
const EVENT_RE = /\[say\] |\[death\]|\[lock\] acquire|\[stuck\]|被服务器踢了|disconnect\.spam|HTTP 429|\[goals\] (?:放弃|过了一步|换法子)|\[fall\] 落差|\[rest\]|\[session\] ===== /

function drainEvents () {
  const chunk = readNew()
  if (!chunk) return
  const out = []
  for (const ln of chunk.split('\n')) {
    if (!EVENT_RE.test(ln)) continue
    const key = ln.slice(0, 120)
    if (seenEvents.has(key)) continue
    seenEvents.add(key)
    const r = relSec(ln)
    out.push(`${r == null ? '?' : r}\t${ln.slice(0, 160)}`)
  }
  if (out.length) fs.appendFileSync(EVT, out.join('\n') + '\n')
  if (seenEvents.size > 5000) seenEvents = new Set([...seenEvents].slice(-2000))
}

const HEAD = 'rel_s,lines,bot_count,kicks,429,says,started,done,failed,proof,deaths,falls,stuck,' +
  'hp,food,kinds,x,y,z,busy,goal,bots,' +
  'real_out,zero_pass,real_fail,stuck_open,unfinished,real_material,death_per_min,task_span_min,minutes_per_death'
if (!fs.existsSync(OUT)) fs.writeFileSync(OUT, HEAD + '\n')
if (!fs.existsSync(EVT)) fs.writeFileSync(EVT, '# rel_s\tevent\n')

function tick () {
  const m = snapshot()
  drainEvents()
  const hb = m.hb || { x: '', y: '', z: '', hp: '', food: '', kinds: '', busy: '' }
  const rel = t0 == null ? 0 : (() => {
    const last = fs.readFileSync(LOG, 'utf8').trimEnd().split('\n').pop() || ''
    const r = relSec(last)
    return r == null ? 0 : r
  })()
  const f = m.four
  const row = [rel, m.lines, m.botCount, m.kicks, m.r429, m.says, m.started, m.done, m.failed,
    m.proof, m.deaths, m.falls, m.stuck,
    hb.hp, hb.food, hb.kinds, hb.x, hb.y, hb.z, hb.busy,
    JSON.stringify(m.goal), JSON.stringify(m.bots),
    f.真产出, f.零产出通过, f.真失败, f.卡住超时, f.未收尾, f.材料口径真产出,
    f.死亡.每N分钟一次 == null ? '' : Number((f.死亡.次数 / f.span_min).toFixed(4)), f.span_min,
    f.死亡.每N分钟一次 == null ? '' : f.死亡.每N分钟一次].join(',')
  fs.appendFileSync(OUT, row + '\n')
  console.log(`[${rel}s] bot=${m.botCount}(下限) 行${m.lines} | 踢${m.kicks} 429:${m.r429} 说${m.says} | ` +
    `任务 真产出${f.真产出}(材料${f.材料口径真产出}) 零产出通过${f.零产出通过} 真失败${f.真失败} 卡住${f.卡住超时} 未收尾${f.未收尾} | ` +
    `死${m.deaths}(${f.死亡.每N分钟一次 == null ? '-' : '每' + f.死亡.每N分钟一次 + '分钟一次'}) 摔${m.falls} | ` +
    `血${hb.hp} 饿${hb.food} @${hb.y} 忙:${String(hb.busy).slice(0, 12)}`)
}

tick()
const t = setInterval(tick, INTERVAL)
process.on('SIGINT', () => { clearInterval(t); console.log('\n快照: ' + OUT + '\n事件: ' + EVT); process.exit(0) })
process.on('SIGTERM', () => { clearInterval(t); process.exit(0) })
