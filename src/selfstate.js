'use strict'
/**
 * 自我状态。
 *
 * 解决的问题：**他不是一直在场的。**
 *
 * 现在的架构是：问模型"你想干嘛" → 模型写脚本 → 脚本操作游戏 → 脚本结束。
 * 脚本运行期间，他不知道自己在干什么；脚本结束后，他只知道一段文字总结。
 *
 * 所以镐子坏了、背包满了、血少了，他都不知道 —— 因为"他不知道"这件事本身
 * 没有人替他记着。
 *
 * 这个模块做的就是那个"替他记着"的东西：
 *   - 每 2 秒扫一次自己的状态（背包、工具、耐久、血量）
 *   - 检测变化（工具坏了、东西丢了、背包满了）
 *   - 变化写成"自己的状态"，永远在提示词里
 *
 * 真人不需要"想起来"自己有几把镐子，因为那个信息一直在脑子里。
 */

const mcData = require('minecraft-data')('1.21.11')

const TOOL_KINDS = {
  pickaxe: ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe', 'golden_pickaxe'],
  axe: ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe', 'golden_axe'],
  shovel: ['netherite_shovel', 'diamond_shovel', 'iron_shovel', 'stone_shovel', 'wooden_shovel', 'golden_shovel'],
  sword: ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'golden_sword']
}

const TOOL_CN = {
  pickaxe: '镐子', axe: '斧头', shovel: '铲子', sword: '剑'
}

/**
 * 游戏内时间说人话。
 *
 * MC 一天 24000 tick = 20 分钟现实时间：
 *   0      清晨/日出
 *   6000   正午
 *   12000  日落开始
 *   13000  天黑
 *   18000  深夜（怪物最多）
 *   23000  天快亮
 *
 * 【2026-11-13 UNHUMAN-SCAN #12】这段原来只藏在 perceive.js 的
 * describeTerrain() 里，而那段在正常路径上根本不执行。
 * 挪到 selfstate 后每轮都进提示词。
 */
function describeTod (tod) {
  if (tod === null || tod === undefined || !isFinite(tod)) return null
  const t = ((tod % 24000) + 24000) % 24000
  if (t < 1000) return { text: '天刚亮，太阳刚出来', phase: 'dawn', night: false }
  if (t < 11000) return { text: '白天，太阳挂着', phase: 'day', night: false }
  if (t < 12500) return { text: '太阳开始偏西，天要黑了', phase: 'dusk', night: false }
  if (t < 13500) return { text: '天正在黑下来', phase: 'nightfall', night: true }
  if (t < 22500) return { text: '天已经黑透了，外面危险', phase: 'night', night: true }
  if (t < 23500) return { text: '天快亮了，再撑一会儿', phase: 'predawn', night: true }
  return { text: '天亮了', phase: 'sunrise', night: false }
}

/**
 * 当前活着的 Mood 实例（可能还没有 —— 构造顺序上 selfstate 在前）。
 * 拿不到就当没有，绝不让提示词因为心情模块崩掉。
 */
let Mood = null
try { Mood = require('./mood') } catch (e) {}
function safeMood () {
  try { return (Mood && typeof Mood.active === 'function') ? Mood.active() : null } catch (e) { return null }
}

class SelfState {
  constructor (bot, ctx) {
    this.bot = bot
    this.ctx = ctx            // { log, events }
    this.prev = null          // 上一次的快照
    this.timer = null
    this.changes = []         // 最近检测到的变化
    this.known = {}           // 我"知道"的自己的状态（持久）
  }

  start () {
    // 建立基线。
    //
    // 这里必须把结果存进 known —— 原来只调了 snapshot() 没赋值，
    // 而 known 初始是 {}（truthy），于是上线头 2 秒里 prompt() 的
    // `if (!s) return ''` 拦不住，直接读到 s.tools.pickaxe 就抛
    // "Cannot read properties of undefined (reading 'pickaxe')"，
    // 整段自我状态失效（他不知道自己的镐子还在不在）。
    // 下次 tick() 才会填 known，所以那 2 秒是空窗。
    const base = this.snapshot()
    if (base) this.known = base
    this.timer = setInterval(() => this.tick(), 2000)
  }

  stop () { if (this.timer) clearInterval(this.timer) }

  /** 现在扫一次自己的状态 */
  snapshot () {
    const bot = this.bot
    if (!bot || !bot.entity || !bot.inventory) return null

    const items = bot.inventory.items()
    const inv = {}
    for (const i of items) inv[i.name] = (inv[i.name] || 0) + i.count

    // 工具：每种最耐用的那把
    const tools = {}
    for (const [kind, names] of Object.entries(TOOL_KINDS)) {
      for (const n of names) {
        const it = items.find(i => i.name === n)
        if (it) {
          // 耐久：mineflayer 的 durability 是剩余使用次数
          const maxDur = (mcData.itemsByName[n] || {}).maxDurability || (mcData.itemsByName[n] || {}).durability || null
          const left = it.durability != null ? it.durability : null
          tools[kind] = {
            name: n,
            display: n.replace(/_/g, ' '),
            count: it.count,
            durability: left,
            maxDurability: maxDur,
            // 耐久低于 20% 就警告
            low: left != null && maxDur != null ? (left / maxDur) < 0.2 : false
          }
          break
        }
      }
    }

    const held = bot.heldItem ? bot.heldItem.name : null

    // ===== 游戏内时间 =====
    //
    // 【2026-11-13 UNHUMAN-SCAN #12】25 分钟里"天亮了"两次，他完全无感。
    // perceive.js 的 describeTerrain() 里其实算了 tod，但那段只在
    // lookAround3D 失败时才会跑到 —— 正常情况根本不执行。
    // 所以"天黑了/天亮了"从来没进过提示词。
    //
    // 这里放进 selfstate 的 snapshot：它的 prompt() 是**永远**在提示词里的
    // （main.js 的 contextForTask 第一个拼的就是 selfBlock），
    // 放这儿保证他每轮都知道现在是什么时候。
    let tod = null
    try {
      const bt = bot.time && bot.time.timeOfDay
      if (bt !== undefined && bt !== null) tod = Number(bt)
    } catch (e) {}

    return {
      health: Math.round(bot.health),
      food: Math.round(bot.food),
      held,
      heldIsTool: held && /_pickaxe$|_axe$|_shovel$|_sword$/.test(held),
      inv,
      tools,
      invSlots: items.reduce((a, b) => a + b.count, 0),
      slotsUsed: items.length,
      tod,
      time: Date.now()
    }
  }

  /** 每 2 秒跑一次：对比上次，找变化 */
  tick () {
    const now = this.snapshot()
    if (!now) return
    const prev = this.prev
    this.prev = now
    this.known = now
    if (!prev) return

    const events = this.ctx.events
    const log = this.ctx.log || (() => {})

    // ===== 工具坏了 =====
    for (const kind of Object.keys(TOOL_KINDS)) {
      const had = prev.tools[kind]
      const has = now.tools[kind]
      if (had && !has) {
        const msg = `你的${TOOL_CN[kind]}（${had.name.replace(/_/g, ' ')}）没了 —— 用坏了或者丢了`
        this.changes.push({ at: Date.now(), what: msg, kind: 'tool_broke' })
        log('[self] ' + msg)
        if (events) events.push('goal_fail', { reason: msg }, msg)
      } else if (!had && has) {
        const msg = `你现在有${TOOL_CN[kind]}了（${has.name.replace(/_/g, ' ')}）`
        log('[self] ' + msg)
        this.changes.push({ at: Date.now(), what: msg, kind: 'tool_got' })
      } else if (had && has && had.name !== has.name) {
        const msg = `${TOOL_CN[kind]}换了：${had.name} → ${has.name}`
        log('[self] ' + msg)
        this.changes.push({ at: Date.now(), what: msg, kind: 'tool_swap' })
      } else if (has && has.low && (!had || !had.low)) {
        const msg = `你的${TOOL_CN[kind]}快用坏了（${has.name.replace(/_/g, ' ')}）`
        log('[self] ' + msg)
        this.changes.push({ at: Date.now(), what: msg, kind: 'tool_low' })
      }
    }

    // ===== 背包快满 =====
    if (now.slotsUsed >= 34 && prev.slotsUsed < 34) {
      const msg = '背包快满了（' + now.slotsUsed + '/36 格）'
      log('[self] ' + msg)
      this.changes.push({ at: Date.now(), what: msg, kind: 'inv_full' })
      if (events) events.push('inventory_full', {}, msg)
    }

    // ===== 血量骤降 =====
    if (now.health < prev.health - 4) {
      const msg = `血掉得厉害（${prev.health} → ${now.health}）`
      this.changes.push({ at: Date.now(), what: msg, kind: 'health_drop' })
      if (events) events.push('health_low', {}, msg)
    }

    // ===== 天黑了 / 天亮了 =====
    //
    // 【2026-11-13 UNHUMAN-SCAN #12】
    // 25 分钟里天亮了两次，他一次都没反应 —— 因为他只有一个静态的时间标签，
    // 没有"变化"。真人不会盯着刻度看，但天暗下来那一下一定注意到了。
    // 这里在相位翻转的那一刻记一条变化，进"刚刚发生"，他就能提一句。
    const a = describeTod(prev.tod)
    const b = describeTod(now.tod)
    if (a && b && a.phase !== b.phase) {
      const dawn = !a.night && b.night      // 白天 → 夜里
      const msg = dawn ? '天黑了，外面开始刷怪' : (a.night && !b.night ? '天亮了，外面安全了' : null)
      if (msg) {
        this.changes.push({ at: Date.now(), what: msg, kind: dawn ? 'nightfall' : 'sunrise' })
        log(`[tod] ${msg}（tod ${Math.round(prev.tod)} → ${Math.round(now.tod)}）`)
      }
    }

    // ===== 累垮了 / 缓过来了 =====
    //
    // 【#10 行为后果】休息周期是 mood 里推进的，但"他自己注意到"这件事得有人写下来。
    // 这里盯着转场打一行，同时进"刚刚发生" —— 这样他下一轮就知道自己刚歇过 / 该歇了。
    const mood = safeMood()
    if (mood) {
      const rs = mood.restState()
      if (rs.resting && !this._wasResting) {
        this._wasResting = true
        const msg = `你累垮了（精力 ${Math.round(mood.energy * 100)}%），自己停下来歇着了`
        this.changes.push({ at: Date.now(), what: msg, kind: 'exhausted' })
        log(`[rest] ${msg}`)
      } else if (!rs.resting && this._wasResting) {
        this._wasResting = false
        const msg = `歇够了（精力 ${Math.round(mood.energy * 100)}%），可以起来干活了`
        this.changes.push({ at: Date.now(), what: msg, kind: 'rested' })
        log(`[rest] ${msg}`)
      }
    }

    // ===== 手上拿的东西变了 =====
    if (now.held !== prev.held && now.held) {
      // 只记"从工具换成非工具"这种情况（说明他在干别的）
    }

    // 只留最近 20 条变化
    if (this.changes.length > 20) this.changes = this.changes.slice(-20)
  }

  /**
   * 生成"我现在的状态" —— 永远在提示词里。
   * 这是他"在场"的方式：不用想起来，因为一直在。
   */
  prompt () {
    const s = this.known
    // 空对象也是 truthy，光判 !s 拦不住"还没扫过"的中间态。
    // 这里把字段补齐成默认值再往下走，保证 prompt() 永远不抛。
    if (!s) return ''
    const inv = s.inv || {}
    const tools = s.tools || {}

    const lines = []

    // 工具状况（最重要）
    const toolBits = []
    for (const kind of ['pickaxe', 'axe', 'shovel', 'sword']) {
      const t = tools[kind]
      if (t && t.name) {
        const dur = t.durability != null && t.maxDurability
          ? `，耐久 ${Math.round(t.durability / t.maxDurability * 100)}%`
          : ''
        toolBits.push(`${TOOL_CN[kind]} ${t.name.replace(/_/g, ' ')}${dur}`)
      } else {
        toolBits.push(`没有${TOOL_CN[kind]}`)
      }
    }
    lines.push('工具：' + toolBits.join('；'))

    // 关键材料
    const mats = []
    const watch = ['oak_log', 'birch_log', 'spruce_log', 'oak_planks', 'birch_planks',
      'stick', 'cobblestone', 'coal', 'iron_ingot', 'raw_iron', 'torch', 'crafting_table', 'furnace']
    for (const w of watch) {
      const n = inv[w] || 0
      if (n > 0) mats.push(`${w.replace(/_/g, ' ')}×${n}`)
    }
    if (mats.length) lines.push('材料：' + mats.join('、'))

    // 状态
    lines.push(`血 ${s.health == null ? '?' : s.health}/20，饿 ${s.food == null ? '?' : s.food}/20，背包 ${s.slotsUsed == null ? '?' : s.slotsUsed}/36 格，手上是 ${s.held ? s.held.replace(/_/g, ' ') : '空手'}`)

    // ===== 痛觉 =====
    //
    // 【BLIND-TEST L547 / L659】血 6 还在往下挖，一直挖到淹死。
    // 血条早就在他"眼前"了（上面那行），但没人告诉他"这意味着什么、现在该干什么"。
    // 只报数字不够 —— 跟时间那条一样，得给出后果。
    if (s.health != null) {
      if (s.health <= 6) {
        lines.push('你现在伤得很重，随时会死。**别再挖了**：先离开水/岩浆/怪，吃东西回血。')
      } else if (s.health <= 10) {
        lines.push('你身上在疼，血不多了 —— 别接硬活，先保证自己不会死。')
      }
    }

    // ===== 游戏内时间 =====
    //
    // 【2026-11-13 UNHUMAN-SCAN #12】他之前完全不知道现在是白天还是黑夜。
    // 天黑躲藏的条件还绑在血量上（血全程 20/20，永不触发），
    // 所以入夜了他照样在外面晃，一点反应都没有。
    //
    // 这里把时间摆到他眼前，并且天黑时直接给出"该干什么"的提示 ——
    // 只报时间不够，他看完照样挖；要让他知道天黑意味着什么。
    const todInfo = describeTod(s.tod)
    if (todInfo) {
      lines.push('时间：' + todInfo.text)
      if (todInfo.night) {
        lines.push('注意：外面在刷怪。要么回家，要么点个火把，别在黑地里硬待')
        // 【REAL-STATUS】天黑原来只对"血少"的人有意义（血<=14 才躲）。
        // 血满的人天黑之后毫无反应。这里按血量给不同的"该警觉到什么程度"。
        if (s.health != null && s.health > 14) {
          lines.push('你血是满的，不用慌着躲，但天黑了得留个心眼 —— 手上没火把就早点回屋，别在黑地里磨。')
        }
      }
      // 【#12 可观测】光在代码里拼进去不算数，得能从日志里证明它真的进了提示词。
      // 五分钟记一次，不刷屏。
      const nowT = Date.now()
      if (!this._lastTodLog || nowT - this._lastTodLog > 5 * 60 * 1000) {
        this._lastTodLog = nowT
        try {
          const log = this.ctx && this.ctx.log
          if (log) log(`[tod] 提示词含时间：${todInfo.text}（tod=${Math.round(s.tod)}${todInfo.night ? '，夜间' : '，白天'}）`)
        } catch (e) {}
      }
    }

    // ===== 身体感觉（精力/困） =====
    //
    // 【#10 · #11】累不是标签，得变成下一步做什么。
    // 这里接 mood.bodyPrompt()：累垮了就说"这轮别接活、坐下歇着"，
    // 凌晨就说"几点了，你其实想下"。原来这些只在聊天提示词里，
    // 干活的提示词（contextForTask）里一个字都没有 —— 所以他照挖不误。
    const mood = safeMood()
    if (mood) {
      let body = ''
      try { body = mood.bodyPrompt() || '' } catch (e) {}
      if (body) lines.push(body)
    }

    // 最近发生的变化（他自己注意到的）
    const recent = (this.changes || []).filter(c => Date.now() - c.at < 120000).slice(-4)
    if (recent.length) {
      lines.push('刚刚发生：' + recent.map(c => c.what).join('；'))
    }

    // 关键提示
    const hints = []
    if (!tools.pickaxe) hints.push('没有镐子，挖石头不会掉东西，得先做一把')
    if (!tools.pickaxe && !inv.oak_log && !inv.birch_log && !inv.stick && !inv.oak_planks) {
      hints.push('也没木头没木棍，得先砍树')
    }
    if (tools.pickaxe && tools.pickaxe.low) hints.push('镐子快坏了，考虑做把新的')
    if (s.food != null && s.food < 18) hints.push('饱食度低于 18 不回血')
    if (s.slotsUsed != null && s.slotsUsed >= 34) hints.push('背包快满了，需要整理')

    if (hints.length) {
      lines.push('注意：' + hints.join('；'))
    }

    return '## 你自己现在的状况\n' + lines.join('\n')
  }
}

module.exports = SelfState
module.exports.describeTod = describeTod
