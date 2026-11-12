'use strict'
/**
 * 感知。
 *
 * 这个模块解决一个根本问题：**他看不见世界。**
 *
 * 原来的 scan() 返回的是一堆计数：
 *   { stone: 1234, dirt: 800, oak_log: 3 }
 * 模型拿到这个，不知道自己在哪、周围长什么样、哪些东西值得注意。
 *
 * 真人感知到的是：
 *   "左边 20 格有棵树，过去要绕过一条沟。"
 *   "背后 6 格有只苦力怕，正朝我走过来。"
 *   "张三在东北 8 格挖矿。"
 *
 * 所以这里把原始数据翻译成**人能看懂的世界描述**：
 * 带方位、带距离、带"那是什么地方"、带"它在干什么"。
 */

const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')('1.21.11')

// 值得注意的方块。没列进来的（泥土、沙子）不重要，不提。
const INTERESTING = {
  // 资源
  oak_log: '橡树', birch_log: '白桦', spruce_log: '云杉', jungle_log: '丛林树',
  acacia_log: '金合欢', dark_oak_log: '深色橡树', cherry_log: '樱花树',
  mangrove_log: '红树', pale_oak_log: '苍白橡树',
  coal_ore: '煤矿', iron_ore: '铁矿', copper_ore: '铜矿', gold_ore: '金矿',
  diamond_ore: '钻石', redstone_ore: '红石矿', lapis_ore: '青金石矿',
  emerald_ore: '绿宝石矿', deepslate: '深板岩',
  // 地形
  water: '水', lava: '岩浆', sand: '沙地', gravel: '砂砾',
  // 结构/地标
  crafting_table: '工作台', furnace: '熔炉', chest: '箱子',
  torch: '火把', ladder: '梯子', door: '门',
  // 植物
  wheat: '小麦', carrots: '胡萝卜', potatoes: '土豆', beetroots: '甜菜',
  pumpkin: '南瓜', melon: '西瓜', sweet_berry_bush: '浆果丛',
  sugar_cane: '甘蔗', bamboo: '竹子',
  // 危险
  cactus: '仙人掌', fire: '火', magma_block: '岩浆块',
  // 有用的
  cobblestone: '圆石', stone: '石头', bedrock: '基岩'
}

const HOSTILE = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman',
  'witch', 'drowned', 'husk', 'stray', 'pillager', 'vindicator', 'ravager',
  'phantom', 'slime', 'magma_cube', 'blaze', 'ghast', 'piglin', 'piglin_brute',
  'zoglin', 'hoglin', 'warden', 'silverfish', 'vex', 'evoker', 'shulker', 'guardian'
])

const MOB_NAME = {
  zombie: '僵尸', skeleton: '骷髅', creeper: '苦力怕', spider: '蜘蛛',
  cave_spider: '洞穴蜘蛛', enderman: '末影人', witch: '女巫', drowned: '溺尸',
  husk: '尸壳', stray: '流浪者', slime: '史莱姆', phantom: '幻翼',
  cow: '牛', pig: '猪', chicken: '鸡', sheep: '羊', rabbit: '兔子',
  horse: '马', wolf: '狼', cat: '猫', fox: '狐狸', bee: '蜜蜂',
  cod: '鳕鱼', salmon: '鲑鱼', squid: '鱿鱼', turtle: '海龟',
  villager: '村民', iron_golem: '铁傀儡'
}

// 八个方向的中文名（Minecraft 里 -Z 是北）
const DIRS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']

class Perception {
  constructor (bot, ctx) {
    this.bot = bot
    this.ctx = ctx          // { mem, events }
    this.lastPos = null
    this.lastScanAt = 0
  }

  // ---------------- 基础工具 ----------------

  /** 把相对位移翻译成中文方位 */
  dirOf (dx, dz) {
    // Minecraft: -Z = 北, +X = 东
    const angle = Math.atan2(dx, -dz)        // 0 = 北, 顺时针
    const idx = Math.round(((angle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8
    return DIRS[idx]
  }

  pos () { return this.bot.entity.position }

  /** 大致距离说法，别写精确数字（人不会说"距离 17.3 格"） */
  distWord (d) {
    if (d < 3) return '就在脚边'
    if (d < 6) return '很近'
    if (d < 12) return `${Math.round(d / 2) * 2} 格`
    if (d < 24) return `${Math.round(d / 4) * 4} 格`
    return '挺远'
  }

  // ---------------- 地形 ----------------

  /**
   * 描述"我站在什么地方"。
   * 这是最有用的一条 —— 模型需要知道自己在哪。
   */
  describeTerrain () {
    const bot = this.bot
    const p = this.pos()
    const bits = []

    // 脚下是什么
    const below = bot.blockAt(p.offset(0, -1, 0))
    const feet = bot.blockAt(p)
    const groundName = below ? (INTERESTING[below.name] || groundWord(below.name)) : '不知道什么'

    if (bot.entity.isInWater) bits.push('我在水里')
    else if (bot.entity.isInLava) bits.push('我泡在岩浆里')
    else if (feet && feet.name !== 'air' && feet.name !== 'cave_air' && feet.boundingBox !== 'empty') {
      bits.push('我卡在方块里')
    } else {
      bits.push(`我站在${groundName}上`)
    }

    // 头顶有没有遮挡 -> 判断在洞里还是露天
    let openSky = true
    for (let dy = 2; dy <= 12; dy++) {
      const b = bot.blockAt(p.offset(0, dy, 0))
      if (b && b.boundingBox === 'block' && !/leaves/.test(b.name)) { openSky = false; break }
    }
    bits.push(openSky ? '头顶是露天的' : '头顶有遮挡，像在洞里或者树底下')

    // 四个方向的地形起伏
    const slopes = []
    for (const [name, dx, dz] of [['北', 0, -1], ['东', 1, 0], ['南', 0, 1], ['西', -1, 0]]) {
      const h = this.heightAt(dx * 10, dz * 10)
      if (h == null) continue
      const diff = h - p.y
      if (diff > 4) slopes.push(`${name}边是高坡`)
      else if (diff < -4) slopes.push(`${name}边是下坡或悬崖`)
    }
    if (slopes.length) bits.push(slopes.join('、'))

    // 时间、天气
    const tod = bot.time && bot.time.timeOfDay
    if (tod !== undefined) {
      if (tod < 12000) bits.push('现在是白天')
      else if (tod < 13800) bits.push('天快黑了')
      else if (tod < 22200) bits.push('现在是晚上')
      else bits.push('天快亮了')
    }
    if (bot.isRaining) bits.push('在下雨')

    return bits.join('，')
  }

  /** 某个水平位置的地面高度 */
  heightAt (dx, dz) {
    const bot = this.bot
    const p = this.pos()
    const base = p.offset(dx, 0, dz)
    for (let dy = 8; dy >= -12; dy--) {
      const b = bot.blockAt(base.offset(0, dy, 0))
      if (b && b.boundingBox === 'block' && !/leaves|log/.test(b.name)) {
        return Math.floor(p.y + dy)
      }
    }
    return null
  }

  // ---------------- 附近有什么 ----------------

  /**
   * 附近值得注意的东西，带方位。
   * 用聚类：把挨着的同类方块合成一个"地方"。
   */
  describeNearby (radius = 26, limit = 8) {
    const bot = this.bot
    const p = this.pos()
    const groups = new Map()   // name -> [{pos, n}]

    // 采样，别太密（性能）
    for (let dx = -radius; dx <= radius; dx += 2) {
      for (let dz = -radius; dz <= radius; dz += 2) {
        for (let dy = -10; dy <= 12; dy += 2) {
          const b = bot.blockAt(p.offset(dx, dy, dz))
          if (!b) continue
          const label = INTERESTING[b.name]
          if (!label) continue
          // 只关心地表或浅层
          if (dy < -10) continue

          if (!groups.has(label)) groups.set(label, [])
          const list = groups.get(label)
          // 距离近的先看
          const d = Math.hypot(dx, dz)
          if (list.length < 40) list.push({ dx, dy, dz, d })
        }
      }
    }

    // 每个类别取最近的一个点作为代表
    const out = []
    for (const [label, list] of groups) {
      if (!list.length) continue
      list.sort((a, b) => a.d - b.d)
      const near = list[0]
      const dxz = Math.hypot(near.dx, near.dz)
      out.push({
        label,
        dir: this.dirOf(near.dx, near.dz),
        dist: dxz,
        dy: near.dy,
        count: list.length
      })
    }

    out.sort((a, b) => a.dist - b.dist)
    const picked = out.slice(0, limit)

    if (!picked.length) return '周围没什么值得注意的东西'

    return picked.map(o => {
      const many = o.count > 20 ? '一片' : o.count > 6 ? '好几处' : ''
      const h = o.dy > 4 ? `，在头顶上方 ${Math.round(o.dy)} 格` : o.dy < -4 ? `，在下面 ${Math.round(-o.dy)} 格` : ''

      // 近的直接说方位，远的说"大概多远"
      let loc
      if (o.dist < 2) loc = '就在脚边'
      else if (o.dist < 5) loc = `很近，${o.dir}边两三格`
      else if (o.dist < 14) loc = `${o.dir}边${Math.round(o.dist / 2) * 2}格`
      else loc = `${o.dir}边挺远`

      return `${many}${o.label}${loc}${h}`
    }).join('；')
  }

  // ---------------- 威胁 ----------------

  /** 附近的威胁，带"它在干什么" */
  describeThreats (radius = 20, limit = 5) {
    const bot = this.bot
    const p = this.pos()
    const out = []

    for (const e of Object.values(bot.entities)) {
      if (!e || e === bot.entity) continue
      if (!e.name || !HOSTILE.has(e.name)) continue
      const d = e.position.distanceTo(p)
      if (d > radius) continue

      const dir = this.dirOf(e.position.x - p.x, e.position.z - p.z)
      const doing = this.describeEntityDoing(e)
      out.push({
        name: MOB_NAME[e.name] || e.name,
        dir,
        dist: d,
        doing,
        dy: Math.round(e.position.y - p.y)
      })
    }

    out.sort((a, b) => a.dist - b.dist)
    if (!out.length) return ''

    return out.slice(0, limit).map(t => {
      const loc = t.dist < 3 ? '贴脸' : t.dir + '边' + this.distWord(t.dist)
      const h = Math.abs(t.dy) > 3 ? (t.dy > 0 ? '，在上方' : '，在下方') : ''
      return `${t.name}在${loc}${h}${t.doing ? '，' + t.doing : ''}`
    }).join('；')
  }

  /** 判断一个实体现在在干嘛 */
  describeEntityDoing (e) {
    if (!e.position) return ''
    // 需要速度（如果有）
    const v = e.velocity
    if (v) {
      const speed = Math.hypot(v.x, v.z)
      if (speed > 0.15) {
        const p = this.pos()
        const toMe = Math.hypot(p.x - e.position.x, p.z - e.position.z)
        const vLen = Math.hypot(v.x, v.z)
        if (vLen > 0.01) {
          const approach = ((p.x - e.position.x) * v.x + (p.z - e.position.z) * v.z) / (vLen * (toMe || 1))
          if (approach > 0.5) return '正朝我这边过来'
          if (approach < -0.5) return '在往远处走'
        }
        return '在动'
      }
    }
    // 燃烧中
    if (e.metadata && e.metadata.some(m => m === true)) return ''
    return ''
  }

  // ---------------- 人 ----------------

  /** 附近的人，带方位和"在干嘛" */
  describePeople (radius = 48) {
    const bot = this.bot
    const p = this.pos()
    const out = []

    for (const [name, pl] of Object.entries(bot.players || {})) {
      if (name === bot.username) continue
      if (!pl.entity) {
        out.push(`${name}（你叫不上他具体在哪，可能在远处）`)
        continue
      }
      const d = pl.entity.position.distanceTo(p)
      if (d > radius) {
        out.push(`${name}（在很远的地方）`)
        continue
      }
      const dir = this.dirOf(pl.entity.position.x - p.x, pl.entity.position.z - p.z)
      const loc = d < 3 ? '就在你旁边' : dir + '边' + this.distWord(d)
      const doing = this.guessPlayerDoing(name, pl.entity)
      const call = this.mem ? this.mem.people[name] : null
      const callName = call && call.callMe ? `（你叫他${call.callMe}）` : ''
      out.push(`${name}${callName}在${loc}${doing ? '，' + doing : ''}`)
    }

    if (!out.length) return '现在没别人在线'
    return out.join('；')
  }

  /** 猜一个玩家在干嘛（看他的动作/朝向） */
  guessPlayerDoing (name, ent) {
    const prev = this._playerPrev && this._playerPrev[name]
    this._playerPrev = this._playerPrev || {}
    const now = { pos: ent.position.clone(), at: Date.now() }
    this._playerPrev[name] = now

    if (!prev) return ''
    const moved = prev.pos.distanceTo(now.pos)
    const dt = (now.at - prev.at) / 1000
    if (dt <= 0) return ''
    const speed = moved / dt

    if (speed > 3) return '在跑'
    if (speed > 0.8) return '在走'
    if (speed < 0.15) return '站着不动'
    return ''
  }

  // ---------------- 最近发生的事 ----------------

  /** 最近发生了什么（从事件队列拿） */
  describeRecent (seconds = 45) {
    if (!this.events) return ''
    const now = Date.now()
    const list = this.events.recent(seconds * 1000)
    if (!list.length) return ''
    return list.map(e => {
      const ago = Math.max(1, Math.round((now - e.at) / 1000))
      return `${ago} 秒前 ${e.what}`
    }).join('；')
  }

  // ---------------- 自己 ----------------

  describeSelf () {
    const bot = this.bot
    const items = bot.inventory ? bot.inventory.items() : []
    const invCount = items.reduce((a, b) => a + b.count, 0)
    const slots = items.length
    const held = bot.heldItem ? itemWord(bot.heldItem.name) : '空手'

    const bits = [
      `血 ${Math.round(bot.health)}/20`,
      `饿 ${Math.round(bot.food)}/20`,
      `手上是${held}`
    ]
    if (slots >= 32) bits.push('背包快满了')
    else if (slots === 0) bits.push('背包空的')
    else bits.push(`背包 ${slots} 格东西`)

    return bits.join('，')
  }

  // ---------------- 汇总 ----------------

  /**
   * 完整的世界快照。
   * 这是给模型看的"你现在看到了什么"。
   */
  snapshot (opts = {}) {
    const terrain = this.describeTerrain()
    const nearby = this.describeNearby(opts.radius || 26)
    const threats = this.describeThreats(opts.threatRadius || 20)
    const people = this.describePeople(opts.peopleRadius || 48)
    const recent = this.describeRecent(opts.recentSeconds || 45)
    const self = this.describeSelf()

    const lines = []
    lines.push(`【你在哪】${terrain}`)
    lines.push(`【附近】${nearby}`)
    if (threats) lines.push(`【有威胁】${threats}`)
    lines.push(`【人】${people}`)
    if (recent) lines.push(`【刚才】${recent}`)
    lines.push(`【自己】${self}`)

    return lines.join('\n')
  }

  /** 简版快照，给需要省 token 的地方用 */
  brief () {
    const lines = []
    lines.push(this.describeTerrain())
    const threats = this.describeThreats(14, 3)
    if (threats) lines.push('威胁：' + threats)
    const people = this.describePeople(32)
    lines.push('人：' + people)
    lines.push(this.describeSelf())
    return lines.join('；')
  }
}

/** 物品/方块英文名 -> 中文（常见的那批） */
const NAME_CN = {
  stone_pickaxe: '石镐', wooden_pickaxe: '木镐', iron_pickaxe: '铁镐',
  diamond_pickaxe: '钻石镐', netherite_pickaxe: '下界合金镐',
  stone_axe: '石斧', wooden_axe: '木斧', iron_axe: '铁斧',
  stone_sword: '石剑', wooden_sword: '木剑', iron_sword: '铁剑',
  stone_shovel: '石铲', wooden_shovel: '木铲', iron_shovel: '铁铲',
  oak_planks: '橡木木板', birch_planks: '白桦木板', spruce_planks: '云杉木板',
  oak_log: '橡木原木', birch_log: '白桦原木', spruce_log: '云杉原木',
  crafting_table: '工作台', furnace: '熔炉', chest: '箱子',
  cobblestone: '圆石', dirt: '泥土', sand: '沙子', gravel: '砂砾',
  coal: '煤', charcoal: '木炭', iron_ingot: '铁锭', raw_iron: '粗铁',
  stick: '木棍', torch: '火把', bread: '面包', apple: '苹果',
  cooked_beef: '熟牛肉', beef: '生牛肉', cooked_porkchop: '熟猪排',
  rotten_flesh: '腐肉', string: '线', feather: '羽毛', leather: '皮革',
  bone: '骨头', gunpowder: '火药', wheat: '小麦', wheat_seeds: '小麦种子'
}

function itemWord (name) {
  if (!name) return '空手'
  if (NAME_CN[name]) return NAME_CN[name]
  if (INTERESTING[name]) return INTERESTING[name]
  // 兜底：把下划线换成空格，别显示原始 ID
  return name.replace(/_/g, ' ')
}

function groundWord (name) {
  if (/grass/.test(name)) return '草地'
  if (/dirt/.test(name)) return '泥土地'
  if (/sand/.test(name)) return '沙地'
  if (/stone|cobble|deepslate/.test(name)) return '石头地'
  if (/gravel/.test(name)) return '砂砾地'
  if (/plank|wood/.test(name)) return '木地板'
  if (/snow/.test(name)) return '雪地'
  if (/leaves/.test(name)) return '树叶上'
  return '地上'
}

module.exports = { Perception, INTERESTING, MOB_NAME, HOSTILE, itemWord }
