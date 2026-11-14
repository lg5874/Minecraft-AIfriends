'use strict'
/**
 * 「这一次上线」—— 让会话有开始、有结束。
 *
 * 【为什么要有这个文件】
 * 之前 session 对他来说是个**计数器**：clock.js 里有 sessionStart / sessions，
 * main.js 只有一句"上次下线前你在：X"。也就是说，他是 `while(true)` 的循环体，
 * **没有"今天"**。每次上线都接着上次的循环继续，而那循环恰好停在地下 ——
 * 用户那句"我每次见到他他都在地下"就是这么来的：不是他偏爱地下，是他没有"今天"。
 *
 * 真人上线是有形状的：
 *
 *     进门先扫一眼家（东西还在不在、墙有没有被人拆）
 *       -> 定今天干啥（不是从菜单里抽，是看了家里的情况才决定）
 *       -> 干到一半吃饭挂机
 *       -> 收工
 *
 * 这个文件把那个形状做出来，分三段：
 *
 *   1. 上线结算 begin()     对比离线前的快照：箱子少了三十块圆石 / 门口墙被拆了，
 *                           然后说一句人话。**接上了 spontaneous 里那个躺了两年的
 *                           `robbed` 模板**（它有文案、有概率、有节流，一直没有触发器）。
 *   2. 定方向   _decide()    从家里的存货/结构/上一趟死没死人，推今天该干什么。
 *                           不是从 goals 菜单里抽 —— 是"看了家里才决定"。
 *   3. 收工     settleToday()
 *                           **"今天"没有物理边界**（用户不会下线），所以边界必须
 *                           在行为上造出来：活干够了/账算清了 -> todayDone
 *                           -> 回家待着、说一句"今天差不多了" -> 歇够 -> 新的一天。
 *
 * 【边界】**不碰任务收尾判据**（那是 probe-check 的地盘），也**不碰**
 * actions.js / goals.js / talk.js / persona.js。只通过它们的公开接口读，
 * 以及走 main.js 现有的 pendingTask 通道派活。
 *
 * 【数据】<DATA>/session.json
 *   一次上线 = 一个 day。存着：
 *     · snapshot  上一次离开（收工/断线）时家里的样子 —— 上线结算就是拿它比
 *     · last      上一次的账单（今天干了什么、拿到什么、值不值）
 *     · days      最近 20 次的账单（够看出"这几天在干什么"）
 */

const fs = require('fs')
const path = require('path')
const Vec3 = require('vec3')

const ROOT = path.resolve(__dirname, '..')
const FILE = 'session.json'
const VERSION = 1

// ============================================================
// 复用 cost 层的人话 —— 两套结算必须用同一套口径，
// 不然同一件事在"收工"和"放弃目标"两处会被说成两种重量。
// ============================================================
let cost = null
try { cost = require('./cost') } catch (e) { cost = null }

const humanMins = (cost && cost.humanMins) || ((m) => `${Math.round(m)} 分钟`)
const humanGoods = (cost && cost.humanGoods) || ((item, n) => `${n} ${item}`)
const humanLoot = (cost && cost.humanLoot) || ((g) => (g || []).slice(0, 3).map(x => `${x.item}x${x.n}`).join('、'))
const humanDuration = (cost && cost.humanDuration) || ((ms) => humanMins((Number(ms) || 0) / 60000))
const cnNum = (cost && cost.cnNum) || ((n) => String(n))
const priceOf = (cost && cost.priceOf) || (() => 1)
const placeName = (cost && cost.placeName) || (() => '那边')

/** 口语里"一块圆石"把数字去掉，剩"块圆石"，好拼"少了三十块圆石" */
function nounOf (item) {
  return String(humanGoods(item, 1)).replace(/^[一二三四五六七八九十百千万两零\d]+/, '')
}

// ============================================================
// 0. 判据与常量
// ============================================================

/** 家里的容器（能打开读内容的） */
const CONTAINER_RE = /^(chest|trapped_chest|barrel|shulker_box)$/

/**
 * "值得记账"的方块：墙、地板、会被人拆的东西。
 * 不算的：泥土/草/石头/水/空气 —— 那些本来就会因为挖矿/下雨变，
 * 全记进来上线结算就会变成"读日志"，不是"看家里有没有变样"。
 */
const NOTABLE_RE = /cobblestone|stone_bricks?|_planks|_log|_stairs|_slab|glass|bricks|chest|barrel|furnace|crafting_table|torch|door|bed|fence|ladder|scaffolding/

/** 墙类（用来说"墙被拆了"，不是"少了几块石头"） */
const WALL_RE = /cobblestone|stone_bricks?|_planks|glass|bricks|dirt|stone$/

/** 默认参数。config.json 里 behavior.session 可以覆盖，环境变量也能覆盖（实测用） */
const DEFAULTS = {
  homeRadius: 10,        // 扫家的水平半径（格）
  homeYRange: 7,         // 上下各扫几格
  maxContainers: 3,      // 一趟最多打开几个箱子（开箱慢，别耽误上线）
  containerBudgetMs: 4000,
  workMinutes: 25,       // 干多久算"今天够了"（游戏分钟，1 真实分钟 = 1 游戏分钟）
  restMinutes: 4,        // 收工后歇多久再开新的一天（相当于睡了一晚上）
  maxTasks: 6,           // 干满几件像样的事也算今天够了
  minTaskMs: 45000,      // 不到 45 秒的活不算"一件事"
  idleSettleMinutes: 8,  // 连续这么久没动静 = 收工
  restTaskSeconds: 100,  // 歇着的时候每隔多久给一个"歇着"的动作
  resumeSameDayMinutes: 3, // 断线回来多久之内还算"同一天"（不算新的一天）
  sayChance: 0.85
}

const REST_TASKS = [
  '回家待着，把身上的东西收进箱子',
  '在屋里坐着歇会儿，不干活',
  '到门口站站，看看天黑没',
  '回去坐一会儿，想想明天干什么'
]

// ============================================================
// 1. 纯函数：快照比对 / 人话 / 方向判断（好单测，不碰 bot）
// ============================================================

/**
 * 比两份家里快照。
 *
 * 关键防御：**区块没加载全的时候不能断言"东西没了"**。
 * 实测过这种坑：区块没读到 -> 所有方块都是 null -> 看起来"家被拆干净了"。
 * 所以覆盖率不够时，删/丢这一类只记 unknown，不往他嘴里塞"家没了"。
 */
function diffSnapshots (prev, now) {
  const out = {
    firstTime: !prev,
    containerLoss: [], containerGain: [], containerNew: [], containerGone: [],
    blockGone: [], blockNew: [],
    invLoss: [], invGain: [],
    unknown: [],          // 读不清的部分：不撒谎，也不装没事
    trusted: true         // 覆盖率够不够下"少了"的结论
  }
  if (!prev || !now) return out

  const covOk = (s) => s && s.coverage != null && s.coverage >= 0.9
  const canSayGone = covOk(prev) && covOk(now)
  out.trusted = canSayGone
  if (!canSayGone) {
    out.unknown.push(`家那片没读全（上次 ${pct(prev.coverage)} / 这次 ${pct(now.coverage)}）`)
  }

  // ---- 容器内容 ----
  const prevBoxes = indexBoxes(prev)
  const nowBoxes = indexBoxes(now)
  for (const [key, nb] of nowBoxes) {
    const pb = prevBoxes.get(key)
    if (!pb) {
      out.containerNew.push({ key, pos: nb.pos, n: nb.items ? Object.keys(nb.items).length : 0 })
      continue
    }
    if (!pb.items || !nb.items) { out.unknown.push(`${key} 的箱子这次没打开`); continue }
    const lost = itemDiff(nb.items, pb.items)     // 上次有、这次没有 -> 少了
    const gained = itemDiff(pb.items, nb.items)   // 这次多了
    for (const it of lost) out.containerLoss.push({ ...it, key, pos: nb.pos })
    for (const it of gained) out.containerGain.push({ ...it, key, pos: nb.pos })
  }
  if (canSayGone) {
    for (const [key, pb] of prevBoxes) {
      if (!nowBoxes.has(key)) out.containerGone.push({ key, pos: pb.pos })
    }
  }

  // ---- 方块结构 ----
  const prevSet = new Set(prev.notable || [])
  const nowSet = new Set(now.notable || [])
  const goneByName = new Map()
  const newByName = new Map()
  for (const s of prevSet) if (!nowSet.has(s)) bump(goneByName, s)
  for (const s of nowSet) if (!prevSet.has(s)) bump(newByName, s)
  if (canSayGone) {
    for (const [name, list] of goneByName) out.blockGone.push({ name, n: list.length, at: list })
  }
  for (const [name, list] of newByName) out.blockNew.push({ name, n: list.length, at: list })

  // ---- 背包（离线期间被人拿了 / 上个进程死前掉了）----
  // 刚上线那一刻背包可能还没同步（读出来是空的），那就别断言"东西没了"
  if (prev.inventory && now.inventory && Object.keys(now.inventory).length) {
    for (const it of itemDiff(now.inventory, prev.inventory)) out.invLoss.push(it)
    for (const it of itemDiff(prev.inventory, now.inventory)) out.invGain.push(it)
  }

  // 只留值钱的/量大的，别拿一块土来当"家里有变化"
  const keep = (x) => x.n >= 2 || x.n * priceOf(x.item) >= 3
  out.containerLoss = out.containerLoss.filter(keep).slice(0, 6)
  out.containerGain = out.containerGain.filter(keep).slice(0, 4)
  out.invLoss = out.invLoss.filter(keep).slice(0, 4)
  out.invGain = out.invGain.filter(keep).slice(0, 4)
  out.blockGone = out.blockGone.filter(b => b.n >= 1).slice(0, 6)
  out.blockNew = out.blockNew.filter(b => b.n >= 1).slice(0, 4)

  return out
}

function pct (v) {
  if (v == null) return '?'
  return Math.round(v * 100) + '%'
}

function indexBoxes (snap) {
  const m = new Map()
  for (const c of (snap && snap.containers) || []) m.set(c.key, c)
  return m
}

function bump (map, s) {
  const i = s.lastIndexOf(',')
  const name = s.slice(i + 1)
  if (!map.has(name)) map.set(name, [])
  map.get(name).push(s)
}

/** b 里比 a 多的（a 减 b 为负的那部分） */
function itemDiff (a, b) {
  const out = []
  for (const [item, v] of Object.entries(b || {})) {
    const d = (Number(v) || 0) - (Number(a[item]) || 0)
    if (d > 0) out.push({ item, n: d })
  }
  out.sort((x, y) => y.n * priceOf(y.item) - x.n * priceOf(x.item))
  return out
}

/** 方块名 -> 中文（说不出来就原样，别编） */
const BLOCK_CN = {
  cobblestone: '圆石', stone: '石头', stone_bricks: '石砖', oak_planks: '橡木板',
  oak_log: '橡木', dirt: '泥土', grass_block: '草方块', sand: '沙子',
  glass: '玻璃', glass_pane: '玻璃板', chest: '箱子', barrel: '木桶',
  furnace: '熔炉', crafting_table: '工作台', torch: '火把', ladder: '梯子',
  oak_door: '木门', red_bed: '床', oak_fence: '栅栏', bricks: '砖块',
  spruce_planks: '云杉木板', birch_planks: '白桦木板', oak_stairs: '橡木台阶'
}
function blockCN (name) {
  const k = String(name || '')
  if (BLOCK_CN[k]) return BLOCK_CN[k]
  if (/_planks$/.test(k)) return '木板'
  if (/_log$/.test(k)) return '木头'
  if (/chest/.test(k)) return '箱子'
  return k.replace(/_/g, ' ')
}

/**
 * 变化 -> 人话，带上"这属于哪一类"：
 *   stolen  东西少了（箱子/身上）—— 走 robbed 模板
 *   struct  房子变了（墙被拆/多了个箱子）—— 走 sessionReturn
 *   gained  东西多了
 * 分类留着是为了说话时不重复：一条"被拿了"和一条"被拆了"是两件事。
 */
function linesOfDetailed (diff, snap) {
  const out = []
  if (!diff) return out

  for (const x of diff.containerLoss) out.push({ text: `箱子里少了${cnNum(x.n)}${nounOf(x.item)}`, kind: 'stolen' })
  for (const x of diff.containerGain) out.push({ text: `箱子里多了${cnNum(x.n)}${nounOf(x.item)}`, kind: 'gained' })
  for (const x of diff.containerNew) out.push({ text: '家里多了个箱子', kind: 'struct' })
  for (const x of diff.containerGone) out.push({ text: '那口箱子不见了', kind: 'struct' })

  for (const b of diff.blockGone) {
    const where = whereWord(b.at, snap)
    if (CONTAINER_RE.test(b.name)) { out.push({ text: `${where}少了口${blockCN(b.name)}`, kind: 'struct' }); continue }
    const wall = WALL_RE.test(b.name)
    if (wall && b.n >= 2) out.push({ text: `${where}那截墙少了${cnNum(b.n)}块${blockCN(b.name)}`, kind: 'struct' })
    else out.push({ text: `${where}少了${cnNum(b.n)}块${blockCN(b.name)}`, kind: 'struct' })
  }
  for (const b of diff.blockNew) {
    const where = whereWord(b.at, snap)
    if (CONTAINER_RE.test(b.name)) out.push({ text: `${where}多了个${blockCN(b.name)}`, kind: 'struct' })
    else out.push({ text: `${where}多了${cnNum(b.n)}块${blockCN(b.name)}`, kind: 'struct' })
  }

  for (const x of diff.invLoss) out.push({ text: `身上少了${cnNum(x.n)}${nounOf(x.item)}`, kind: 'stolen' })
  for (const x of diff.invGain) out.push({ text: `身上多了${cnNum(x.n)}${nounOf(x.item)}`, kind: 'gained' })

  return out.slice(0, 6)
}

/** 变化 -> 人话（这些句子会直接进提示词，再由模型说成人话） */
function linesOf (diff, snap) {
  return linesOfDetailed(diff, snap).map(x => x.text).slice(0, 5)
}

/** "66,64,-92,cobblestone" 这类坐标串 -> 门口 / 院子 / 家附近 */
function whereWord (at, snap) {
  const home = (snap && snap.home) || null
  const first = Array.isArray(at) ? at[0] : (at && at[0])
  if (!home || !first) return '家附近'
  const p = String(first).split(',')
  const dx = Number(p[0]) - home.x
  const dz = Number(p[2]) - home.z
  const d = Math.hypot(dx, dz)
  if (!Number.isFinite(d)) return '家附近'
  if (d <= 3) return '门口'
  if (d <= 7) return '院子里'
  return '家附近'
}

/**
 * 今天干什么 —— **依据家里的情况**，不是从 goals 菜单里抽。
 *
 * 顺序有讲究：先保命（上一趟死过），再保工具，再保材料，最后才是接着上次的目标。
 *
 * @param {object} snap  这次扫到的家里快照
 * @param {object} prev  上一次的账单（含 deaths / verdict）
 * @param {object} goal  goals.current()（可空）
 * @returns {{key:string, text:string, why:string}}
 */
function decideDirection (snap, prev, goal) {
  const inv = (snap && snap.inventory) || {}
  const store = (snap && snap.store) || {}
  const near = (snap && snap.counts) || {}
  const all = {}
  for (const src of [inv, store]) for (const [k, v] of Object.entries(src)) all[k] = (all[k] || 0) + v
  const has = (re) => Object.keys(all).some(k => re.test(k))
  const nearHas = (re) => Object.keys(near).some(k => re.test(k))
  const count = (re) => Object.entries(all).reduce((s, [k, v]) => s + (re.test(k) ? v : 0), 0)

  // 1. 上一趟死过 -> 今天干点安全的
  if (prev && prev.deaths > 0) {
    return {
      key: 'safe',
      text: '在附近弄点木头，今天先不往下挖',
      why: `上次上线死了 ${prev.deaths} 次`
    }
  }
  // 2. 连镐都没有 -> 什么也挖不动
  //
  // 【要接得上，不像刚出生】2026-11-14
  //
  // 盲执行人（行为线）的原话：
  //   「身份前后对不上：一会儿像刚出生（木镐都得现做、找不到吃的），
  //     一会儿又说『家里木头快用完了』。」
  //
  // 根因在文案：同一次上线里，他先没镐说「先弄把木镐」（像新手），
  // 做出镐之后木头不够又说「家里木头快用完了」（像老玩家）。
  // 两句本身都对，但连起来像两个人。
  //
  // 修法：有上一趟的记录时，用"承接"的说法 —— 真人第二天不会说
  // 「先弄把木镐」，他会说「镐子没了，再做一把」。
  if (!has(/_pickaxe$/)) {
    const beenHere = !!(prev && ((prev.tasks || 0) > 0 || (prev.mins || 0) > 1))
    return beenHere
      ? { key: 'tool', text: '镐子没了，再做一把', why: '身上没有镐（昨天那把用坏了）' }
      : { key: 'tool', text: '先弄把木镐，不然什么都挖不动', why: '身上没有镐' }
  }
  // 3. 木头见底了（砍树是最安全的一趟活）
  if (count(/_log$/) + count(/_planks$/) < 4) {
    return {
      key: 'wood',
      text: '去砍点树，家里木头快用完了',
      why: `木头只剩 ${count(/_log$/) + count(/_planks$/)} 根`
    }
  }
  // 4. 有铁没炉子 -> 炼不出来
  const iron = count(/iron_ingot|raw_iron|iron_ore/)
  if (iron >= 3 && !has(/furnace/) && !nearHas(/furnace/)) {
    return { key: 'furnace', text: '弄个熔炉，把铁炼出来', why: `有 ${iron} 块铁，但家里没熔炉` }
  }
  // 5. 石头不够盖东西
  const stone = count(/cobblestone|stone|deepslate/)
  if (stone < 32) {
    return { key: 'stone', text: '挖点石头存着，家里石头不够了', why: `石头只有 ${stone} 块` }
  }
  // 6. 家里没吃的
  if (!has(/bread|apple|cooked_|porkchop|beef|chicken|mutton|carrot|potato|wheat/)) {
    return { key: 'food', text: '弄点吃的，家里没存粮', why: '箱子里没有吃的' }
  }
  // 7. 都够 -> 接着心里挂着的那件事
  if (goal && goal.text) {
    return { key: 'goal', text: goal.text, why: `之前惦记的是「${goal.goal || goal.stage || goal.text}」` }
  }
  // 8. 什么也不缺 -> 把东西收一收
  return { key: 'tidy', text: '把身上的东西收进箱子，整理一下家', why: '该有的都有' }
}

/**
 * 今天值不值。
 *
 * 跟 cost 层同一套"每分钟弄到多少重量"的口径，但**线放宽**：
 * 它算的是一趟活（rate<0.25 白干），我算的是一天 ——
 * 一天里三趟白干 + 一趟爆产，判"勉强够本"才对。
 * 阈值：<0.2 今天白过 / <0.7 也就这样 / 其它算没白过。
 */
function verdictOf ({ mins, worth, deaths }) {
  if (mins < 0.75) return 'short'
  const rate = worth / Math.max(0.5, mins)
  const white = worth <= 0.5 || rate < 0.2
  const meh = rate < 0.7
  if (white) return (deaths > 0) ? 'bitter' : 'white'
  if (meh) return (deaths > 0) ? 'bitter' : 'meh'
  return 'ok'
}

/** 一句话说清"今天"：做了几件、成几件、攒下什么 */
function dayLine (bill) {
  const n = (bill.tasks || []).length
  const okN = (bill.tasks || []).filter(t => t.ok).length
  const did = n ? `做了${cnNum(n)}件事，成${cnNum(okN)}件` : '什么正经事都没做成'
  const got = bill.gainedText ? `攒下${bill.gainedText}` : '什么也没攒下'
  const how = humanDuration(bill.ms || (bill.mins * 60000))
  return `今天${did}，${got}（${how}）`
}

/** 写进记忆的那句：回顾一整天，不是评价某一趟活 */
function dayMemText (bill) {
  const d = dayLine(bill)
  const tail = {
    ok: '这一天没白过',
    meh: '这一天也就这样',
    white: '这一天算是白过了',
    bitter: '这一天白过，还搭进去一条命',
    short: '这一天还没怎么过'
  }[bill.verdict] || ''
  return `${d}。${tail}`.slice(0, 90)
}

const VERDICT_TEXT = {
  ok: '这一天没白过',
  meh: '这一天也就这样',
  white: '这一天算是白过了',
  bitter: '这一天白过，还搭进去一条命',
  short: '今天还没怎么过，不算账'
}

// ============================================================
// 2. 主体
// ============================================================

class Session {
  /**
   * @param {object} ctx
   * @param {string} ctx.dataDir        数据目录（跟记忆同一个）
   * @param {object} [ctx.cfg]          整个 config（读 behavior.session 覆盖默认值）
   * @param {function} ctx.log
   * @param {object} ctx.bot            mineflayer bot（断线后会被换掉，所以传 getter）
   * @param {object} [ctx.mem]          Memory（写记忆 + 读 clock）
   * @param {object} [ctx.home]         Home（家的坐标）
   * @param {object} [ctx.actions]      Actions（走到箱子跟前开箱用）
   * @param {object} [ctx.goals]        Goals（只读：current / shouldWrapUp）
   * @param {object} [ctx.spont]        Spontaneity（吐槽/开口）
   * @param {function} [ctx.isBusy]     现在手上有没有活
   * @param {function} [ctx.status]     actions.status() + underground
   * @param {function} [ctx.taskDesc]   当前任务描述
   * @param {function} [ctx.snapshotInv] 背包快照
   * @param {function} [ctx.setTask]    把一句话塞进主循环（main.js 会设 pendingTask）
   * @param {function} [ctx.setResting] 告诉外面"现在收工了"（只用来看日志/调试）
   */
  constructor (ctx = {}) {
    this.ctx = ctx
    this.log = ctx.log || (() => {})
    this.dir = ctx.dataDir
      ? path.resolve(ROOT, ctx.dataDir)
      : (process.env.AIFRIEND_DATA
          ? path.resolve(ROOT, process.env.AIFRIEND_DATA)
          : path.join(ROOT, 'data', 'runtime'))
    this.file = path.join(this.dir, FILE)

    // 优先级：环境变量（实测要压缩一天的长度）> config.behavior.session > 默认值。
    // 注意不能写成 `x: num(env.X) || undefined` —— 那样会把 config 里配的值也一起冲成 undefined。
    const env = process.env
    const envCfg = {}
    if (num(env.SESSION_WORK_MINUTES)) envCfg.workMinutes = num(env.SESSION_WORK_MINUTES)
    if (num(env.SESSION_REST_MINUTES)) envCfg.restMinutes = num(env.SESSION_REST_MINUTES)
    if (num(env.SESSION_MAX_TASKS)) envCfg.maxTasks = num(env.SESSION_MAX_TASKS)
    if (num(env.SESSION_IDLE_MINUTES)) envCfg.idleSettleMinutes = num(env.SESSION_IDLE_MINUTES)
    this.cfg = Object.assign({}, DEFAULTS, (ctx.cfg && ctx.cfg.behavior && ctx.cfg.behavior.session) || {}, envCfg)
    for (const k of Object.keys(DEFAULTS)) if (this.cfg[k] == null) this.cfg[k] = DEFAULTS[k]

    this.state = this._load()

    // 运行期
    this.phase = 'off'        // off | opening | working | resting | closed
    this.todayDone = false
    this.day = this.state.day || 0
    this.record = null        // 当前这一趟的流水
    this._timer = null
    this._lastTickAt = 0
    this._lastDesc = ''
    this._segStart = 0
    this._segInv = null
    this._taskList = []
    this._deaths = 0
    this._startInv = null
    this._lastActivityAt = 0
    this._restUntil = 0
    this._lastRestTaskAt = 0
    this._settling = false
    this._busyScan = false
    this._opening = false
    this._restTaskIdx = 0
    this._pendingSettleWhy = null
    this._onDeath = null
    this._botRef = null
  }

  // ---------------------------------------------------------- 存取

  _load () {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8') || '{}')
      if (!d || typeof d !== 'object') return { version: VERSION }
      return { version: VERSION, day: d.day || 0, snapshot: d.snapshot || null, last: d.last || null, days: Array.isArray(d.days) ? d.days : [], today: d.today || null, rest: d.rest || null }
    } catch (e) {
      return { version: VERSION, day: 0, snapshot: null, last: null, days: [], today: null, rest: null }
    }
  }

  _save () {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const tmp = this.file + '.tmp'
      this.state.version = VERSION
      this.state.day = this.day
      this.state.days = (this.state.days || []).slice(-20)
      // 【必须落盘】休息窗口的绝对时间。被 disconnect.spam 踢掉 → 15 秒后重连，
      // 那一次 begin() 以前会把 todayDone 重置，4 分钟的休息永远走不完（run6 实测）。
      // 判据用"今天已经收工 + 休息窗口没走完"，**不看 phase**：
      // 断线时 end() 会先把 phase 设成 'closed' 再存盘，按 phase 判的话
      // 休息窗口就在这里被写成 null —— 重连就白歇了（exp 实测：重连后 day+1、todayDone=false）。
      this.state.rest = (this.todayDone && this._restUntil > Date.now())
        ? { until: this._restUntil, day: this.day, at: Date.now() }
        : null
      // 当天的流水也要留：被踢重连时要能把"今天干了多久/攒了什么"接上，
      // 不能一断线就当今天没发生过。
      this.state.today = this.phase === 'off' ? null : this._todayRecord()
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 0), 'utf8')
      fs.renameSync(tmp, this.file)
      return true
    } catch (e) {
      this.log('[session] 存不下：' + e.message)
      return false
    }
  }

  _todayRecord () {
    return {
      day: this.day,
      startedAt: this.record ? this.record.startedAt : null,
      phase: this.phase,
      todayDone: this.todayDone,
      ms: this.record ? Math.round(this.record.workMs) : 0,
      deaths: this._deaths || 0,
      startInv: this._startInv || null,
      tasks: (this._taskList || []).slice(0, 20)
    }
  }

  /**
   * 上线这一下：是"被踢了刚回来"，还是"真的新的一天"？
   *
   * 两种接着来：
   *   rest      上次收工了，休息窗口还没过 —— todayDone 保持 true、phase 保持 resting
   *   sameDay   这一天还没收工，断线不到 resumeSameDayMinutes —— 接着这一天干，不重开
   * 其余情况才是新的一天。
   */
  _resumeCheck () {
    const now = Date.now()
    const rest = this.state.rest
    if (rest && Number(rest.until) > now) {
      return { kind: 'rest', until: Number(rest.until), day: Number(rest.day) || this.day }
    }
    const t = this.state.today
    const endedAt = Number(this.state.last && this.state.last.endedAt) || 0
    const gapMin = endedAt ? (now - endedAt) / 60000 : Infinity
    if (t && t.todayDone === false && Number(t.day) === Number(this.day) && gapMin < (this.cfg.resumeSameDayMinutes || 3)) {
      return { kind: 'sameDay', today: t, gapMin }
    }
    return null
  }

  /** 接着歇：保留 todayDone / phase=resting，只把计时器和派活的节奏接回来 */
  _resumeRest (res) {
    this.day = res.day || this.day || 1
    this.todayDone = true
    this.phase = 'resting'
    this._restUntil = res.until
    this._lastRestTaskAt = 0
    this._restTaskIdx = 0
    this._settling = false
    this._pendingSettleWhy = null
    const left = Math.max(1, Math.round((res.until - Date.now()) / 60000))
    this.log(`[session] 上次收工才过 ${Math.max(1, Math.round((Date.now() - (this.state.last && this.state.last.endedAt || Date.now())) / 60000))} 分钟，还在歇着（还剩 ${left} 分钟算新的一天）`)
    this._startClock()
    this._save()
    return { day: this.day, resumed: 'rest', restUntil: res.until }
  }

  // ---------------------------------------------------------- 状态

  /** 这一趟是不是已经收工了（main.js 只用来打日志/调试） */
  isTodayDone () { return this.todayDone }

  status () {
    return {
      phase: this.phase,
      day: this.day,
      todayDone: this.todayDone,
      holdingLock: !!(this.ctx.lock && this.ctx.lock.isHolding('session')),
      minutes: this.record ? Math.round(this.record.workMs / 60000 * 10) / 10 : 0,
      tasks: (this._taskList || []).length,
      restLeftMs: this.phase === 'resting' ? Math.max(0, this._restUntil - Date.now()) : 0
    }
  }

  // ---------------------------------------------------------- 上线

  /**
   * 上线：进门先扫一眼家 -> 说一句 -> 定今天的方向。
   *
   * 不 await 也行，但 main.js 里是 await 的 —— 让他"先看家里，再干活"，
   * 而不是先挖两铲子才发现箱子空了。
   */
  async begin (opts = {}) {
    const bot = this.ctx.bot
    if (!bot || !bot.entity) return null

    // ===== 先问一句：这次上线是"被踢了刚回来"，还是"新的一天"？ =====
    // run6 实测（22:45:01 收工 → 22:45:17 重连）：以前一重连就 todayDone=false，
    // restMinutes=4 从来没走完过。现在休息窗口没走完就接着歇，今天不重开。
    const resume = this._resumeCheck()
    if (resume && resume.kind === 'rest') return this._resumeRest(resume)
    const sameDay = !!(resume && resume.kind === 'sameDay')

    if (!sameDay) {
      this.day = (this.day || 0) + 1
      this.state.rest = null
    }
    this.todayDone = false
    this.phase = 'opening'
    // 开新的一天：万一上一轮收工的锁没还干净（异常/杀进程前的窗口），这里兜一次。
    try {
      if (this.ctx.lock && this.ctx.lock.isHolding('session')) this.ctx.lock.release('session')
    } catch (e) {}
    this._settling = false
    this._pendingSettleWhy = null
    this._taskList = []
    this._deaths = 0
    this._startInv = this._inv()
    if (sameDay && resume.today) {
      const t = resume.today
      this.record = {
        day: this.day,
        startedAt: Number(t.startedAt) || Date.now(),
        startedClock: this._clockMinutes(),
        workMs: Number(t.ms) || 0,
        startPos: this._pos(),
        deaths: Number(t.deaths) || 0
      }
      this._taskList = Array.isArray(t.tasks) ? t.tasks.slice(-20) : []
      this._deaths = Number(t.deaths) || 0
      if (t.startInv && typeof t.startInv === 'object') this._startInv = t.startInv
      this.log(`[session] 刚被踢了一下，接着这一天干（断线 ${Math.round(resume.gapMin * 10) / 10} 分钟，今天已经干了 ${Math.round(this.record.workMs / 6000) / 10} 分钟）`)
    }
    this._lastDesc = ''
    this._segStart = 0
    this._segInv = null
    this._lastActivityAt = Date.now()
    if (!sameDay) {
      this.record = {
        day: this.day,
        startedAt: Date.now(),
        startedClock: this._clockMinutes(),
        workMs: 0,
        startPos: this._pos(),
        deaths: 0
      }
    }

    const prevBill = this.state.last
    const awayNote = this._awayNote(prevBill)

    const rested = opts.reason === 'rested'
    this.log(rested
      ? `[session] ===== 第 ${this.day} 天开工（歇够了）=====`
      : `[session] ===== 第 ${this.day} 次上线 =====${awayNote ? '（' + awayNote + '）' : ''}`)

    // 1) 先扫一眼（快扫：只看方块和背包，不碰箱子）。
    //    顺序很重要：这一步很便宜，被踢断也跑得完 —— 变化能被看见。
    let snap = await this._scanHome({ fast: true })

    // 刚连上那几秒，家那片区块可能还没加载 —— 读到的全是 null，覆盖率 0。
    // 这时候不能下结论（"家没了"是假象），等一下再读一次。
    if (snap && snap.coverage < 0.2) {
      this.log('[session] 家那片还没加载出来，等一会儿再看')
      try {
        if (this.ctx.actions && this.ctx.actions.ensureChunks) await this.ctx.actions.ensureChunks(3000)
      } catch (e) {}
      const again = await this._scanHome({ fast: true })
      if (again && (again.coverage || 0) > (snap.coverage || 0)) snap = again
    }

    // 1.5) 看不清家里 -> 走过去看。
    //      两种情况都得走：
    //        · 家那片根本没加载（离家 95 格，视距只有 4 个区块）——读到的全是 null
    //        · 箱子够不着 —— 站着不动读不出"箱子里少了什么"
    const cannotSee = !snap || snap.coverage < 0.5
    const boxBlind = snap && snap.containers && snap.containers.some(c => !c.items)
    if (cannotSee || boxBlind) {
      // 走不过去也要再扫一次：人可能本来就在家跟前（只是快扫没开箱），
      // 这时候"没走到家"是假阴性，箱子照样该打开看看。
      await this._approachHome()
      const again = await this._scanHome()
      if (again) snap = again
    }
    if (snap) {
      this.log(`[session] 扫家：${snap.home ? `家 ${snap.home.x},${snap.home.y},${snap.home.z}` : '还没有家，就扫脚下'}`
        + ` · 读到 ${snap.seen} 个方块（覆盖 ${pct(snap.coverage)}）· ${snap.containers.length} 个箱子`)
      if (snap.coverage < 0.9) this.log('[session] ⚠️ 家那片没读全，这次不敢断言"东西少了"')
      for (const c of snap.containers) {
        if (!c.items) { this.log(`[session] 箱子 ${c.key}：够不着/打不开`); continue }
        const list = Object.entries(c.items).slice(0, 6).map(([k, v]) => `${blockCN(k)}x${v}`).join('、')
        this.log(`[session] 箱子 ${c.key}：${list || '空的'}`)
      }
    }

    // 2) 跟上一趟离开时的样子比
    const prevSnap = this.state.snapshot
    const diff = diffSnapshots(prevSnap, snap)
    const lines = linesOf(diff, snap)
    if (diff.firstTime) {
      this.log('[session] 第一次上线，没有上次的样子可比 —— 从头认识这个家')
    } else if (lines.length) {
      this.log('[session] 家里有变化：' + lines.join('；'))
    } else {
      this.log('[session] 家里没什么变化' + (diff.trusted ? '' : '（不过没读全）'))
    }

    // 3) 说一句 —— 这里接上 spontaneous 里那个躺了很久的 robbed 模板
    this._speakReturn(diff, lines, snap)

    // 4) 定今天的方向
    //    被踢重连（同一天）就不重新定主意了 —— 手上那件事还没干完，
    //    一断线就换方向的话，他永远在"重新开始"。
    let dir = null
    if (sameDay) {
      this.log('[session] 方向不变，接着刚才那件事')
    } else {
      let goal = null
      try { goal = this.ctx.goals && this.ctx.goals.current ? this.ctx.goals.current() : null } catch (e) {}
      dir = decideDirection(snap, prevBill, goal)
      this.log(`[session] 今天：${dir.text}（依据：${dir.why}）`)
      this._setTask(dir.text)
      try {
        const { onSessionDayStart } = require('./spontaneous')
        this._push(onSessionDayStart(dir))
      } catch (e) {}
    }

    // 基线也存一份：进程被杀（没走到收工）时，下次上线比的就是"最后一次看到的家"，
    // 而不是什么都没比、又说一遍"第一次上线"。
    if (snap) this.state.snapshot = snap

    this.phase = 'working'
    this.todayDone = false
    this._startClock()
    this._save()
    return { day: this.day, snap, diff, lines, direction: dir, away: awayNote }
  }

  /** 离线多久了（真实时间，游戏钟下线不走，所以只能按墙上时间说"隔了多久"） */
  _awayNote (prevBill) {
    if (!prevBill || !prevBill.endedAt) return ''
    const mins = (Date.now() - prevBill.endedAt) / 60000
    if (mins < 2) return ''
    if (mins < 60) return `隔了${humanMins(mins)}`
    if (mins < 60 * 8) return `隔了几个钟头`
    if (mins < 60 * 24) return `隔了大半天`
    return `隔了好些天`
  }

  _speakReturn (diff, lines, snap) {
    if (!lines || !lines.length) return
    // ① 箱子里的东西少了 —— robbed 模板终于有触发器了
    // 【别再随便指控别人偷东西】2026-11-14
    //
    // 实测（final-checker 07:35 抓到的）：
    //   [06:17:29] [say] 我东西呢 少了一堆
    //   [06:38:45] [say] 我东西谁拿的 少了一堆
    // 而他那一晚死了 6 次（骷髅/摔/掠夺者/苦力怕），
    // **死亡掉落、合成消耗、吃东西、放方块，全被算成"身上的东西少了" -> 报 robbed**。
    // 模板原文是 `有人拿了你的东西` —— 用户一进来就可能被他指控偷东西。
    //
    // 箱子里少了才是真的被拿（只有别人能开箱子）。
    // 身上少了有太多正常原因，不能当"被偷"。
    const boxLoss = diff.containerLoss || []
    const invLoss = []   // 保留变量，下面日志里还用得到，但不参与 robbed 判定
    if (boxLoss.length) {
      const parts = []
      if (boxLoss.length) {
        parts.push('箱子里的' + boxLoss.slice(0, 2).map(x => `${cnNum(x.n)}${nounOf(x.item)}`).join('、') + '没了')
      }
      try {
        const { onComplain } = require('./spontaneous')
        // 这个 robbed 模板两年前就写好了，一直没有触发器 —— 上线结算就是它的触发器。
        const ev = onComplain('robbed', parts.join('，'))
        if (ev) this._push(ev)
      } catch (e) {}
    }
    // ② 其它变化（多了箱子 / 墙少了 / 东西多了）一句说完
    // 房子变样了（墙被拆 / 多了个箱子）—— 单独一句，不走"被拿东西"那条
    const struct = linesOfDetailed(diff, snap).filter(x => x.kind === 'struct').map(x => x.text)
    if (struct.length) {
      try {
        const { onSessionReturn } = require('./spontaneous')
        this._push(onSessionReturn({ lines: struct }))
      } catch (e) {}
    }
  }

  _push (ev) {
    if (!ev) return
    try {
      if (this.ctx.spont) this.ctx.spont.push(ev)
    } catch (e) {}
  }

  _setTask (text) {
    if (!text) return
    try {
      if (this.ctx.setTask) this.ctx.setTask(text)
    } catch (e) {
      this.log('[session] 派活失败：' + e.message)
    }
  }

  // ---------------------------------------------------------- 每隔几秒

  _startClock () {
    if (this._timer) clearInterval(this._timer)
    // 5 秒一轮：够看出"在干活 / 干完了 / 闲着"，也不贵
    this._timer = setInterval(() => { try { this._tick() } catch (e) { this.log('[session] tick 出错：' + e.message) } }, 5000)
    if (this._timer.unref) this._timer.unref()
    this._lastTickAt = Date.now()
    this._watchDeaths()
  }

  _stopClock () {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
    this._unwatchDeaths()
  }

  /** 死一次记一笔：上一趟死过没死过，决定今天干不干危险的活 */
  _watchDeaths () {
    const bot = this.ctx.bot
    if (!bot || this._botRef === bot) return
    this._unwatchDeaths()
    this._botRef = bot
    this._onDeath = () => {
      this._deaths++
      if (this.record) this.record.deaths = this._deaths
      this._lastActivityAt = Date.now()
    }
    try { bot.on('death', this._onDeath) } catch (e) {}
  }

  _unwatchDeaths () {
    if (this._botRef && this._onDeath) {
      try { this._botRef.removeListener('death', this._onDeath) } catch (e) {}
    }
    this._onDeath = null
    this._botRef = null
  }

  _tick () {
    const now = Date.now()
    const dt = Math.min(15000, now - (this._lastTickAt || now))
    this._lastTickAt = now
    if (this.phase !== 'working' && this.phase !== 'resting') return

    if (this.phase === 'working') {
      if (!this.record) return
      this.record.workMs += dt
      this._recordActivity(now)
      this._maybeSettle(now)
      return
    }

    // resting：歇着，别干活。**这一段就是"今天"的形状** ——
    // 收工之后不该再被 goals 拉去挖矿，只该回家、坐着、站门口看看。
    const busy = this._busy()
    if (now - (this._lastRestTaskAt || 0) > this.cfg.restTaskSeconds * 1000 && !busy) {
      // 【家里没箱子就别派"收进箱子"】2026-11-14
      //
      // 实测（final-checker 07:35）：`[07:01:56] 扫家：… 0 个箱子`，
      // 而 REST_TASKS 轮换里第一条就是「回家待着，把身上的东西收进箱子」。
      // 于是：派任务 -> `打不开 chest（试了3次）` -> 判据靠"位移"放过 -> 判完成
      // -> 下一轮又派同一条。四分钟内原地打转，13:06-14:09 那一段
      // 在 61:06-62:09 一字不差重播了一遍（盲执行人就是这么发现"像脚本"的）。
      //
      // 修法：轮换时跳过"要箱子"的那条。不改成"先造箱子"——那是新行为，不是修 bug。
      const hasChest = (() => {
        try {
          const cs = (this.state.snapshot && this.state.snapshot.containers) || []
          return cs.length > 0
        } catch (e) { return false }
      })()
      let task = REST_TASKS[this._restTaskIdx % REST_TASKS.length]
      for (let guard = 0; guard < REST_TASKS.length; guard++) {
        if (!(task.includes('箱子') && !hasChest)) break
        this._restTaskIdx++
        task = REST_TASKS[this._restTaskIdx % REST_TASKS.length]
      }
      this._restTaskIdx++
      this._lastRestTaskAt = now
      this._setTask(task)
      this.log('[session] 歇着：' + task)
    }
    if (now >= this._restUntil && !this._opening) {
      this.log('[session] 歇够了，天亮了')
      this._opening = true
      this.begin({ reason: 'rested' })
        .catch(e => this.log('[session] 新的一天出错：' + e.message))
        .finally(() => { this._opening = false })
    }
  }

  /**
   * 记下"刚才在干什么"。
   *
   * 只读 main.js 的 busy/taskDesc —— **不碰任务收尾判据**。
   * 这样"今天干了什么"是从真实执行里长出来的，不是从留言里抄的。
   */
  _recordActivity (now) {
    let desc = ''
    let busy = false
    try {
      desc = String(this.ctx.taskDesc ? (this.ctx.taskDesc() || '') : '')
      busy = !!(this.ctx.isBusy && this.ctx.isBusy())
    } catch (e) {}

    if (desc !== this._lastDesc) {
      // 上一段收尾
      if (this._lastDesc && this._segStart) {
        const ms = now - this._segStart
        if (ms >= this.cfg.minTaskMs) {
          const invNow = this._inv()
          const gained = itemDiff(this._segInv || {}, invNow)
          this._taskList.push({ text: this._lastDesc, ms: Math.round(ms / 1000) * 1000, gained: gained.slice(0, 3), ok: gained.length > 0 })
          if (this._taskList.length > 20) this._taskList.shift()
        }
      }
      this._lastDesc = desc
      this._segStart = desc ? now : 0
      this._segInv = desc ? this._inv() : null
      if (desc) this._lastActivityAt = now
    } else if (busy) {
      this._lastActivityAt = now
    }
  }

  /**
   * 该收工了吗。
   *
   * 【这条是整个设计的生死线】用户不会下线，所以"今天"没有物理边界。
   * 边界只能在行为上造出来 —— 活干够了/账算清了，就进入 todayDone。
   * 没有这一步，session 还是个 while(true)。
   */
  _maybeSettle (now) {
    if (this._settling || this.todayDone) return
    // 刚上线那一会儿不收工（不然一上线就"收工"了）。
    // 闸口按"今天准备干多久"缩放：正常 25 分钟 -> 最多 60 秒；实测压缩到 1 分钟 -> 30 秒。
    const graceMs = Math.min(60000, Math.max(500, this.cfg.workMinutes * 30000))
    if (now - (this.record.startedAt || now) < graceMs) return

    const why = []
    const mins = this.record.workMs / 60000
    if (mins >= this.cfg.workMinutes) why.push(`今天干够了（${humanMins(mins)}）`)
    if (this._taskList.length >= this.cfg.maxTasks) why.push(`干完了 ${this._taskList.length} 件像样的事`)
    if (now - (this._lastActivityAt || now) > this.cfg.idleSettleMinutes * 60000) why.push('半天没动静')
    // goals 自己也有"今天这一份够了"（挖矿 quota / 在地下待太久）—— 只读它的判断
    try {
      if (this.ctx.goals && this.ctx.goals.shouldWrapUp && this.ctx.status) {
        const w = this.ctx.goals.shouldWrapUp(this.ctx.status())
        if (w && w.yes) why.push(w.why)
      }
    } catch (e) {}

    if (!why.length) return
    // 手上正有活就先干完（收工不能打断正在做的事，那不叫收工，那叫掉线）
    if (this._busy()) { this._pendingSettleWhy = why; return }
    const reason = (this._pendingSettleWhy && this._pendingSettleWhy.length ? this._pendingSettleWhy : why)
    this._pendingSettleWhy = null
    this.settleToday(reason.join('；')).catch(e => this.log('[session] 收工结算出错：' + e.message))
  }

  // ---------------------------------------------------------- 收工

  /**
   * 收工结算：这一趟干了什么 / 拿到什么 / 有没有白费劲。
   *
   * 这是"这一次上线"的**结束**——不下线也要结束。结算完进入 resting：
   * 回家、歇着、说一句"今天差不多了"；歇够了再开新的一天。
   */
  async settleToday (reason) {
    if (this._settling) return null
    if (this.phase === 'resting' || this.phase === 'closed') return this.state.last

    // ===== 抢锁：session rank 80 =====
    // 语义（src/actionlock.js）：能压过 task(10)/legacy(10)/home(50)/follow(60)，
    // 压不过 survive(100) —— 正被骷髅追的时候不该停下来收工，等人安全了再说。
    // 抢不到就不立 todayDone，下一轮 _tick 再试（否则会卡在"已收工但没结算"）。
    const lock = this.ctx.lock
    let held = false
    if (lock) {
      held = lock.acquire('session', '收工：' + (reason || ''))
      if (!held) {
        this.log(`[session] 现在收工抢不过 ${lock.describe()}，等它松手`)
        return null
      }
    }

    this._settling = true
    this.todayDone = true
    this.phase = 'resting'
    // 【顺序很重要】先把"歇到什么时候"立起来，再做后面那些 await（扫家最慢）。
    // 反过来的话 _tick 会在 await 期间看到 resting + _restUntil=0，当场开新的一天。
    this._restUntil = Date.now() + this.cfg.restMinutes * 60000
    this._lastRestTaskAt = 0
    this._restTaskIdx = 0

    try {
      const now = Date.now()
      const mins = Math.round(this.record.workMs / 60000 * 10) / 10
      const invNow = this._inv()
      const gained = itemDiff(this._startInv || {}, invNow)
      const spent = itemDiff(invNow, this._startInv || {})
      const worth = gained.reduce((s, g) => s + g.n * priceOf(g.item), 0)
      const verdict = verdictOf({ mins, worth, deaths: this._deaths })
      const bill = {
        day: this.day,
        startedAt: this.record.startedAt,
        endedAt: now,
        mins,
        time: humanMins(mins),
        tasks: (this._taskList || []).map(t => ({ text: t.text, secs: Math.round(t.ms / 1000), ok: !!t.ok })),
        gained,
        spent,
        gainedText: humanLoot(gained),
        worth: Math.round(worth * 10) / 10,
        deaths: this._deaths,
        verdict,
        verdictText: VERDICT_TEXT[verdict] || '',
        why: reason || '',
        pos: this._pos(),
        where: placeName(this._pos())
      }
      this.state.last = bill
      this.state.days = (this.state.days || []).concat([bill]).slice(-20)

      // 账：干了什么 / 拿到什么 / 有没有白费劲
      const did = bill.tasks.length
        ? bill.tasks.slice(-3).map(t => t.text).join('、')
        : '没干什么正经事'
      this.log(`[session] ===== 收工（${reason || '时候到了'}）=====`)
      const okCount = bill.tasks.filter(t => t.ok).length
      this.log(`[session] 今天：${bill.time} · 做了 ${bill.tasks.length} 件，成了 ${okCount} 件：${did}`)
      this.log(`[session] 拿到：${bill.gainedText || '什么也没多'}${bill.deaths ? ` · 死了 ${bill.deaths} 次` : ''}`)
      this.log(`[session] ${bill.verdictText}（每分钟值 ${(worth / Math.max(0.5, mins)).toFixed(2)}，${mins} 分钟）`)

      // 记住这一天（不是"这一趟活"—— 那是 cost 层的地盘）。
      //
      // 措辞分工是硬约束，不只是风格：
      //   cost 层   kind=skill, importance 0.72, 落在"这件事/这片地方"（带牙齿，压下次选目标）
      //   这一层    kind=event, importance 0.45, 落在"这一天"（只是回忆，不影响决策）
      // 记忆层的 findDuplicate 按 kind 分组 + 中文 jaccard 合并，
      // 两边都写成 skill、措辞又像的话，这条"今天"会被并进目标级那条里，战略感受就没了。
      try {
        if (this.ctx.mem && this.ctx.mem.add) {
          this.ctx.mem.add({
            text: dayMemText(bill),
            kind: 'event',
            importance: 0.45,
            emotion: 0.4
          })
        }
      } catch (e) {}

      // 说一句"今天差不多了"
      bill.dayLine = dayLine(bill)
      try {
        const { onSessionSettle } = require('./spontaneous')
        this._push(onSessionSettle(bill))
      } catch (e) {}

      // 下一次上线的基线：现在家里什么样就存什么样（快扫，收工路径上不开箱）
      const snap = await this._scanHome({ fast: true })
      if (snap) this.state.snapshot = snap

      this.log(`[session] 今天到此为止，回去歇着（${this.cfg.restMinutes} 分钟后算新的一天）`)
      this._setTask(REST_TASKS[0])
      // 刚派过就不必让 _tick 再派一次（同一个动作派两遍，模型会重复执行）
      this._lastRestTaskAt = Date.now()

      this._save()
      return bill
    } finally {
      this._settling = false
      // 只在这段账目里占着锁：歇着的时候不能占 ——
      // 占了以后 legacy busy=true 会被拒，主循环派"回家待着"这类轻活就乱套了。
      if (held && lock) { try { lock.release('session') } catch (e) {} }
    }
  }

  // ---------------------------------------------------------- 下线

  /**
   * 真下线（断线/进程结束）。跟 settleToday 的区别：
   *   · settleToday 是"今天干完了"（行为边界，人还在）
   *   · end 是"这次上线到此为止"（物理边界），顺带把没结算的账结掉
   *
   * 必须在 main.js 的 onEnd 里**最先**调 —— 那之后 home.detach / mem.goOffline
   * 会把背包和坐标的上下文拆掉。
   */
  end (reason = 'disconnect') {
    if (this.phase === 'off' || this.phase === 'closed') return this.state.last
    const wasDone = this.todayDone
    // 先同步抓一份现状（后面 await 的扫描要慢一点，不能指望那时还读得到）
    let inv = null
    let pos = null
    try { inv = this._inv(); pos = this._pos() } catch (e) {}
    this._stopClock()

    const finish = async () => {
      // 先在"还活着"的状态下把账结掉（settleToday 要求 phase 还是 working）
      if (!wasDone && this.record) {
        // 没到收工点就断线了 —— 也得把账算清楚，不然这一趟等于没发生过
        await this.settleToday('下线了，' + reason).catch(e => this.log('[session] 下线结算出错：' + e.message))
      }
      // 快照：最后一次读到的家里样子，留给下次上线比
      try {
        const snap = await this._scanHome({ inv, pos, fast: true })
        if (snap) this.state.snapshot = snap
      } catch (e) {}
      this.phase = 'closed'
      this.todayDone = true
      if (this.state.last && this.state.last.day === this.day) {
        this.state.last.endedAt = Date.now()
        this.state.last.endedReason = reason
      }
      this._save()
      this.log(`[session] 第 ${this.day} 次上线结束（${reason}）`)
    }
    return finish()
  }

  // ---------------------------------------------------------- 扫家

  /**
   * 上线第一件事：走回家。
   *
   * 为什么必须真的走过去：生物出生点是**随机**的（实测同一个世界两次连进来
   * 一次 56,55,-1 一次 52,63,-3），离箱子十几格就开不了箱 —— 只读方块数据看不出
   * 箱子里少了什么。而"进门先扫一眼家"本来就是这段设计要的动作，不是绕路。
   *
   * 上限 93 秒：走不回去就今天先记着"没看清家"，别把整个上线耗在走路上。
   */
  async _approachHome () {
    const home = this._homePos()
    const p = this._pos()
    const actions = this.ctx.actions
    if (!home || !p || !actions || typeof actions.goto !== 'function') return false
    const d = Math.hypot(p.x - home.x, p.z - home.z)
    if (d < 5) return false
    // 140 格以内都往回走一趟（约两分钟）：再远就不像"回家看一眼"，
    // 像专门跑一趟 —— 那就别装。超过就今天先按脚下的地方过。
    if (d > 140) {
      this.log(`[session] 离家 ${Math.round(d)} 格，太远，今天先不特意回去`)
      return false
    }
    if (this._busy()) return false
    this.log(`[session] 离家 ${Math.round(d)} 格，先走回去看一眼`)
    try {
      await Promise.race([
        actions.goto(home.x, home.y, home.z, 2, 90000),
        new Promise(r => setTimeout(r, 93000))
      ])
    } catch (e) {
      this.log('[session] 走回家没走成：' + e.message)
    }
    const now = this._pos()
    if (now) {
      const left = Math.hypot(now.x - home.x, now.z - home.z)
      this.log(left < 8
        ? `[session] 到家了（离箱子 ${Math.round(left)} 格）`
        : `[session] 没走到家，还差 ${Math.round(left)} 格 —— 这次箱子读不到`)
      return left < 8
    }
    return false
  }

  _homePos () {
    try {
      const h = this.ctx.home
      if (!h) return null
      if (h.home && Number.isFinite(Number(h.home.x))) return h.home
      if (typeof h.homePos === 'function') {
        const p = h.homePos()
        if (p && Number.isFinite(Number(p.x))) return p
      }
    } catch (e) {}
    return null
  }

  _center () {
    const home = this._homePos()
    const pos = this._pos()
    if (home && Number.isFinite(Number(home.x))) {
      return { x: Math.round(home.x), y: Math.round(home.y), z: Math.round(home.z), isHome: true }
    }
    if (!pos) return null
    return { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), isHome: false }
  }

  /**
   * 扫一遍家：方块分布 + 会被人拆的东西的坐标 + 箱子里有什么。
   *
   * 只读，不动任何东西。箱子只在够得着的时候打开（2~3 格内），
   * 够不着就记 null —— 下次走到家附近再说（宁可说"没看清"，不编"被偷了"）。
   */
  async _scanHome (opts = {}) {
    const bot = this.ctx.bot
    if (this._busyScan) return null
    this._busyScan = true
    try {
      if (!bot || !bot.entity) return null
      const center = this._center()
      if (!center) return null
      const pos = opts.pos || this._pos()

      // 区块没加载时读到的全是 null —— 先等一下，别把"空"当"被拆了"
      try {
        if (this.ctx.actions && this.ctx.actions.ensureChunks && center.isHome) {
          const dxz = pos ? Math.hypot(pos.x - center.x, pos.z - center.z) : 999
          if (dxz < 24) await this.ctx.actions.ensureChunks(1500)
        }
      } catch (e) {}

      const R = this.cfg.homeRadius
      const VR = this.cfg.homeYRange
      const counts = {}
      const notable = []
      const containers = []
      let seen = 0
      let missing = 0

      for (let dx = -R; dx <= R; dx++) {
        for (let dz = -R; dz <= R; dz++) {
          for (let dy = -VR; dy <= VR; dy++) {
            const x = center.x + dx
            const y = center.y + dy
            const z = center.z + dz
            let b = null
            try { b = bot.blockAt(new Vec3(x, y, z)) } catch (e) { b = null }
            if (!b) { missing++; continue }
            seen++
            const n = b.name
            if (!n || n === 'air' || n === 'cave_air' || n === 'void_air') continue
            counts[n] = (counts[n] || 0) + 1
            if (NOTABLE_RE.test(n) && notable.length < 600) notable.push(`${x},${y},${z},${n}`)
            if (CONTAINER_RE.test(n) && containers.length < 12) containers.push({ key: `${x},${y},${z}`, pos: { x, y, z }, n })
          }
        }
      }

      const total = seen + missing
      const snap = {
        at: Date.now(),
        day: this.day,
        home: center.isHome ? { x: center.x, y: center.y, z: center.z } : null,
        hasHome: !!center.isHome,
        pos: pos ? { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) } : null,
        radius: R,
        counts,
        notable,
        containers,
        inventory: opts.inv || this._inv(),
        coverage: total ? seen / total : 0,
        seen
      }

      // 箱子内容：只开够得着的，最多 maxContainers 个，整段有时间预算。
      // fast=true 时完全不碰箱子（上线第一眼先看"东西在不在"，开箱放到后面）。
      if (!opts.fast && containers.length && pos) {
        const budget = Date.now() + this.cfg.containerBudgetMs
        let opened = 0
        for (const c of containers) {
          if (opened >= this.cfg.maxContainers || Date.now() > budget) break
          const d = Math.hypot(c.pos.x - pos.x, c.pos.y - pos.y, c.pos.z - pos.z)
          if (d > 4) { c.items = null; continue }   // 太远，不打不开，也别记成空的
          const items = await this._readBox(c)
          c.items = items
          if (items) opened++
        }
      }

      // 这次没打开（够不着/快扫）的箱子：用上次真看到的那份内容兜底。
      // 人的记忆就是这样：不站在箱子跟前，也记得里面大概有什么。
      const prevBoxes = new Map(((this.state.snapshot && this.state.snapshot.containers) || []).map(c => [c.key, c]))
      for (const c of containers) {
        if (c.items) { c.itemsAt = Date.now(); continue }
        const old = prevBoxes.get(c.key)
        if (old && old.items) {
          c.items = old.items
          c.itemsAt = old.itemsAt || old.at || null
          c.carried = true     // 这几分是我"记得"的，不是这次看见的
        }
      }

      // 箱子里的东西合一份"存货"，定方向的时候要看
      const store = {}
      for (const c of containers) {
        for (const [k, v] of Object.entries(c.items || {})) store[k] = (store[k] || 0) + v
      }
      snap.store = store
      return snap
    } finally {
      this._busyScan = false
    }
  }

  async _readBox (c) {
    const bot = this.ctx.bot
    if (!bot || !c || !c.pos) return null
    try {
      const b = bot.blockAt(new Vec3(c.pos.x, c.pos.y, c.pos.z))
      if (!b || !CONTAINER_RE.test(b.name)) return null
      const win = await Promise.race([
        bot.openContainer(b),
        new Promise((_, rej) => setTimeout(() => rej(new Error('open timeout')), 3000))
      ])
      const out = {}
      try {
        for (const it of win.containerItems()) out[it.name] = (out[it.name] || 0) + it.count
      } finally {
        try { win.close() } catch (e) {}
      }
      return out
    } catch (e) {
      this.log(`[session] 开箱失败 ${c.key}：${e.message}`)
      return null
    }
  }

  // ---------------------------------------------------------- 小工具

  _inv () {
    try {
      if (this.ctx.snapshotInv) return this.ctx.snapshotInv() || {}
      const bot = this.ctx.bot
      const out = {}
      if (!bot || !bot.inventory) return out
      for (const i of bot.inventory.items()) out[i.name] = (out[i.name] || 0) + i.count
      return out
    } catch (e) {
      return {}
    }
  }

  _pos () {
    try {
      const bot = this.ctx.bot
      if (!bot || !bot.entity || !bot.entity.position) return null
      const p = bot.entity.position
      return { x: p.x, y: p.y, z: p.z }
    } catch (e) {
      return null
    }
  }

  _busy () {
    try { return !!(this.ctx.isBusy && this.ctx.isBusy()) } catch (e) { return false }
  }

  _clockMinutes () {
    try {
      if (this.ctx.clock && this.ctx.clock.now) return this.ctx.clock.now()
      if (this.ctx.mem && this.ctx.mem.clock && this.ctx.mem.clock.now) return this.ctx.mem.clock.now()
    } catch (e) {}
    return null
  }

  /** 给提示词/日志用的一句话（"这是今天第几趟，干了多久"） */
  summary () {
    const s = this.status()
    if (s.phase === 'off' || s.phase === 'closed') {
      const l = this.state.last
      return l ? `上一次上线：${l.time}，${l.verdictText || ''}，弄到${l.gainedText || '什么也没多'}` : '还没有上一次上线'
    }
    if (s.phase === 'resting') return `今天收工了（第 ${s.day} 趟，干了 ${s.minutes} 分钟），在歇着`
    return `今天第 ${s.day} 趟，已经干了 ${s.minutes} 分钟，做了 ${s.tasks} 件事`
  }
}

function num (v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

module.exports = {
  Session,
  // 纯函数：单测和别的模块可以直接用
  diffSnapshots,
  decideDirection,
  linesOf,
  verdictOf,
  nounOf,
  blockCN,
  DEFAULTS
}
