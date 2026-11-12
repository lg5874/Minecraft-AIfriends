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

    return {
      health: Math.round(bot.health),
      food: Math.round(bot.food),
      held,
      heldIsTool: held && /_pickaxe$|_axe$|_shovel$|_sword$/.test(held),
      inv,
      tools,
      invSlots: items.reduce((a, b) => a + b.count, 0),
      slotsUsed: items.length,
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
