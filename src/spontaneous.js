'use strict'
/**
 * 主动开口。
 *
 * 真人不会等你说话才说话。他挖到钻石会喊一声，
 * 看到你在打架会问要不要帮忙，发现个洞会说"这有个洞"。
 *
 * 但不是话痨。所以这里做的是：**先判断这事值不值得说，再决定说不说。**
 * 说了什么，全部现编，不预设。
 */

const realtime = require('./realtime')

/**
 * 值得主动开口的时机。
 * 每一项返回 {situation, chance, maxLen} 或者 null。
 */

/** 挖到好东西 */
function onValuableFind (item, count) {
  const bigValue = ['diamond', 'emerald', 'ancient_debris', 'netherite_scrap', 'golden_apple', 'enchanted_golden_apple']
  const midValue = ['iron_ingot', 'gold_ingot', 'redstone', 'lapis_lazuli', 'amethyst_shard']
  const name = String(item || '')

  if (bigValue.some(v => name.includes(v))) {
    return { situation: `你刚挖到了 ${name} x${count || 1}，这是好东西。`, chance: 0.7, maxLen: 30 }
  }
  if (midValue.some(v => name.includes(v)) && (count || 1) >= 5) {
    return { situation: `你挖到了 ${count} 个 ${name}，算小有收获。`, chance: 0.3, maxLen: 25 }
  }
  return null
}

/** 第一次到某个新地形/结构 */
function onNewTerrain (what) {
  if (!what) return null
  return { situation: `你走到了一片没见过的 ${what}。`, chance: 0.45, maxLen: 30 }
}

/** 看到别人在挨打 / 快死了 */
function onFriendInDanger (name, health) {
  if (!name) return null
  return {
    situation: `${name} 快死了（血 ${health}），或者正在被怪打。`,
    chance: 0.8, maxLen: 30, people: [name]
  }
}

/** 看到别人在挖矿/干活，想搭话 */
function onFriendBusy (name, what) {
  return {
    situation: `${name} 在${what || '忙着'}，你正好路过。`,
    chance: 0.25, maxLen: 25, people: [name]
  }
}

/** 自己差点死 */
function onNearDeath (how) {
  return { situation: `你差点死了：${how}。现在活下来了，血不多。`, chance: 0.6, maxLen: 30 }
}

/** 干成了一件事，而且是自己一直想干的 */
function onGoalDone (goal, how) {
  // 注意：how 是程序返回的执行结果，里面全是数字和方块名。
  // 绝对不能原样塞给模型，不然他会念出来（"挖了脚边的andesite（mine返回1）"）。
  return {
    situation: `你刚把「${goal}」这件事做完了。`,
    chance: 0.4,
    maxLen: 20
  }
}

/** 时间很晚了 */
function onLateNight () {
  const t = realtime.realTime()
  const p = realtime.timeRemarkChance(t)
  if (p < 0.1) return null
  return {
    situation: `现在是 ${t.text}，挺晚了。你还在游戏里。`,
    chance: p, maxLen: 25
  }
}

/** 有人上线 / 下线 */
function onPlayerJoin (name) {
  return { situation: `${name} 上线了。`, chance: 0.5, maxLen: 20, people: [name] }
}

function onPlayerLeave (name) {
  return { situation: `${name} 下线了。`, chance: 0.25, maxLen: 20, people: [name] }
}

/**
 * 判断现在这个时机值不值得开口。
 * 节流：两次主动说话之间至少隔一段时间。
 */
class Spontaneity {
  constructor (ctx) {
    this.ctx = ctx
    this.lastSpokeAt = 0
    this.cooldownMs = 90000        // 至少隔 90 秒才主动开口一次
    this.pendingEvents = []
  }

  /** 攒一个事件，等冷却过了再决定说不说 */
  push (ev) {
    if (!ev) return
    this.pendingEvents.push({ ev, t: Date.now() })
    if (this.pendingEvents.length > 6) this.pendingEvents.shift()
  }

  /**
   * 主循环调用：有攒着的事就问他要不要说。
   * @returns {Promise<boolean>}
   */
  async tick (talk) {
    if (!this.pendingEvents.length) return false

    // 先看看最早的事件是不是"吐槽"，吐槽不受冷却限制
    const first = this.pendingEvents[0]
    const isComplain = first && /死了|找不到|失败|卡住|差点|走错|奇怪|运气/.test(first.ev.situation || '')
    if (!isComplain && Date.now() - this.lastSpokeAt < this.cooldownMs) return false
    if (isComplain && Date.now() - this.lastSpokeAt < 8000) return false   // 至少隔 8 秒
    // 忙的时候一般不主动搭话……
    // 但"吐槽"例外：正在挖矿被怪弄死，当场就会骂一句，不会等忙完
    if (this.ctx.busy && this.ctx.busy() && !isComplain) return false

    // 挑最新的一条
    const item = this.pendingEvents.shift()
    const age = Date.now() - item.t
    // 太久以前的就不说了（已经过时了）
    if (age > 120000) return false

    const said = await talk.speak(item.ev.situation, {
      chance: item.ev.chance,
      maxLen: Math.min(item.ev.maxLen || 20, 24),
      people: item.ev.people || [],
      extraHint: '随口一句就行，最多十几个字。别汇报，别描述一堆数字。'
    })
    if (said) this.lastSpokeAt = Date.now()
    return said
  }
}

/** 吐槽事件：只在这些真实发生时触发，不凭空来 */
function onComplain (what, detail) {
  const map = {
    died: { s: `你刚死了（${detail || '不知道咋死的'}）。`, c: 0.75, m: 20 },
    diedAgain: { s: `你今天已经死了好几次了，刚又死了一回（${detail || ''}）。`, c: 0.85, m: 20 },
    nothingFound: { s: `你找了半天什么都没找到（${detail || ''}）。`, c: 0.6, m: 20 },
    craftFail: { s: `你合成失败了（${detail || ''}）。`, c: 0.55, m: 18 },
    stuck: { s: `你走不动了，卡住了（${detail || ''}）。`, c: 0.5, m: 18 },
    almostDied: { s: `你差点死了（${detail || ''}），现在活下来了。`, c: 0.65, m: 20 },
    gotLost: { s: `你走错路了，绕了一大圈（${detail || ''}）。`, c: 0.55, m: 18 },
    robbed: { s: `有人拿了你的东西（${detail || ''}）。`, c: 0.7, m: 20 },
    weird: { s: `你看到个奇怪的东西（${detail || ''}）。`, c: 0.5, m: 18 },
    lucky: { s: `你运气不错（${detail || ''}）。`, c: 0.5, m: 18 }
  }
  const e = map[what]
  if (!e) return null
  return { situation: e.s, chance: e.c, maxLen: e.m }
}

module.exports = {
  Spontaneity,
  onComplain,
  onValuableFind,
  onNewTerrain,
  onFriendInDanger,
  onFriendBusy,
  onNearDeath,
  onGoalDone,
  onLateNight,
  onPlayerJoin,
  onPlayerLeave
}
