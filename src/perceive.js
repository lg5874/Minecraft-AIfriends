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

// ============ 视觉（图，不是表）============
//
// 【为什么要有这一整段】2026-11-14
//
// 原来喂给模型的是计数表：「附近有 173 个 stone、24 个 dirt、3 个 oak_log」。
// 模型拿到这个，答不出"前面是堵墙"——它只知道有多少块石头，不知道石头在哪。
//
// 真人看地形看的是**布局**：这边一堵墙、那边有个口子、脚下这块地是挖过的。
// 布局是二维的，二维的东西只能拿图喂，文字描述还原不了。
//
// 所以这里生成三张图 + 两张剖面，再让模型自己把图"看成人话"：
//   · 俯视切片：你脚下这一层的材质（通道、墙、水、坑都在这层）
//   · 高差图  ：每个格子比你脚底高/低几格（"哪边能过去"靠这张）
//   · 实体图  ：谁站在哪一格（被围住的时候一眼就看见）
//   · 剖面    ：东西向 / 南北向各一刀（头顶压不压、前面通不通）
//
// 图 + 原始数字一起给模型，让它自己说"这像什么"—— 表格换不出这个。

const SIGHT = {
  R: 8,            // 俯视半宽 -> 17x17（取奇数才能让 @ 真的居中）
  HALF: 6,         // 剖面半宽
  UP: 4,           // 剖面向上看几格
  DOWN: 7,         // 剖面向下看几格
  SCAN_DOWN: 14,       // 材质普查往下扫几格
  TTL_MS: 30 * 1000,   // 超过 30 秒重算
  MOVE_BLOCKS: 8,      // 走超过 8 格重算
  MAX_TOKENS: 2000,    // 不省。实测 800 会被 thinking 吃干，content 空着回来
  MIN_SCENE_MS: 1500,  // 两次模型调用之间至少隔这么久（防抖，不是省钱）
  HARD_FLOOR_MS: 15 * 1000, // 硬下限：不管怎么触发，两次模型调用至少隔 15 秒（跑起来时每 5 秒就过期一次）
  FAIL_BACKOFF_MS: 90 * 1000
}

const LEGEND = '@你 ▓石头/实心 ▒土沙砾 ░空气 ≈水 !岩浆 T树干 t树叶 O矿 ' +
  '*光源 C箱子/台 =门梯栅栏 #基岩/黑曜 +人造方块(木板/圆石/砖) ?看不清'

/**
 * 一个方块 -> 一个字符。
 *
 * 【为什么用字符而不是首字母】图是要"看"的：▓ 和 ░ 一眼能分出实心和空，
 * s 和 a 不行。而且一行 17 个字符，模型读起来就是一幅画。
 *
 * 【+ 人造方块 是故意的】"这面墙看着是自己垒的"这句话的信息量全在这个字符上。
 * cobblestone / planks / 砖 和天然 stone 必须能分开。
 */
function symOf (b) {
  if (b === null || b === undefined) return '?'   // 区块没加载：看不见，不是空气
  const n = b.name
  if (!n) return '?'
  if (n === 'air' || n === 'cave_air' || n === 'void_air') return '░'
  if (n.includes('water') || n === 'bubble_column' || n === 'kelp' ||
      n === 'seagrass' || n === 'tall_seagrass' || n === 'ice' || n === 'frosted_ice') return '≈'
  if (n.includes('lava') || n === 'magma_block') return '!'
  if (/(^|_)log$/.test(n) || /_wood$|hyphae$/.test(n)) return 'T'
  if (n.includes('leaves') || n === 'azalea' || n === 'flowering_azalea') return 't'
  if (n.includes('torch') || n.includes('lantern') || n.includes('candle') ||
      n === 'glowstone' || n.includes('froglight') || n === 'shroomlight' ||
      n === 'sea_lantern' || n === 'campfire' || n === 'soul_campfire' ||
      n === 'fire' || n === 'soul_fire' || n === 'jack_o_lantern') return '*'
  if (n.includes('chest') || n.includes('barrel') || n === 'crafting_table' ||
      n.includes('furnace') || n === 'anvil' || n === 'smithing_table' ||
      n === 'enchanting_table' || n === 'brewing_stand' || n === 'hopper' ||
      n === 'dispenser' || n === 'dropper' || n === 'lectern' ||
      n === 'stonecutter' || n === 'cartography_table' || n === 'fletching_table' ||
      n === 'loom' || n === 'grindstone' || n === 'beacon' || n === 'conduit') return 'C'
  if (n.includes('door') || n.includes('fence') || n === 'ladder' ||
      n.includes('rail') || n === 'scaffolding' || n.includes('trapdoor') ||
      n.includes('_gate') || n === 'vine' || n === 'cobweb' ||
      n === 'chain' || n === 'iron_bars') return '='
  if (n === 'bedrock' || n === 'obsidian' || n === 'crying_obsidian' ||
      n === 'barrier' || n === 'end_portal_frame') return '#'
  if (n.includes('ore') || n === 'ancient_debris') return 'O'
  // 人造：玩家放下去的东西。圆石算 —— 天然圆石极少，出现在墙里基本都是人垒的
  if (/planks$|_bricks?$|_tiles?$|concrete|terracotta|wool$|glass$|_glass|_slab$|_stairs$/i.test(n) ||
      n === 'cobblestone' || n === 'mossy_cobblestone' || n === 'cobbled_deepslate' ||
      n === 'smooth_stone' || n === 'polished_andesite' || n === 'polished_granite' ||
      n === 'polished_diorite' || n === 'chiseled_stone_bricks' || n === 'quartz_block' ||
      n === 'white_concrete' || n === 'hay_block' || n === 'bookshelf') return '+'
  if (/dirt|grass_block|sand|gravel|clay|podzol|mycelium|mud$|snow|farmland|soul_soil|rooted_dirt|moss_block|sculk|netherrack|soul_sand|_nylium/.test(n)) return '▒'
  return '▓'
}

/** 这个方块算不算"挡路"（实心） */
function solidOf (b) {
  if (!b) return false
  return b.boundingBox === 'block'
}

/**
 * 高差图的一个字符。
 *
 * @param {number|null} dy  往下扫到的第一个实心方块相对脚底的行数（-1 = 脚底那块）
 * @param {boolean} blind   这一列从头到尾都读不到
 *
 * 约定（图例里也写了）：
 *   0   和你脚底同高（能走）
 *   1   高出一格（要跳/要挖）
 *   #   到头顶那格就是实心 —— 挡路或者压顶
 *   .   低一格     ,  低两格     -  低三格以上
 *   _   这一列一直到底都没东西（洞/悬崖）
 *   ?   看不清（区块没加载）
 */
function groundChar (dy, blind) {
  if (dy === null) return blind ? '?' : '_'
  if (dy === 1) return '#'
  const rel = dy + 1
  if (rel === 0) return '0'
  if (rel > 0) return String(Math.min(rel, 6))
  if (rel === -1) return '.'
  if (rel === -2) return ','
  return '-'
}


/**
 * 模型的输出收一下，别把坐标/数量带进来。
 * 只做"明显违反要求"的清理，不过度删改 —— 句子是它自己的。
 */
function cleanScene (t) {
  let s = String(t || '')
  s = s.replace(/\r/g, '')
  s = s.replace(/```[\s\S]*?```/g, ' ')
  s = s.replace(/^【[^】]{0,12}】\s*/gm, '')       // 它自己加的标题
  s = s.replace(/\b[xX]\s*[=:]\s*-?\d+/g, '')     // 坐标
  s = s.replace(/\b[zZ]\s*[=:]\s*-?\d+/g, '')
  s = s.replace(/\(?-?\d{1,3}\s*,\s*-?\d{1,3}\s*,\s*-?\d{1,3}\)?/g, '')  // (x,y,z)
  s = s.replace(/\d{2,}\s*个/g, '很多')            // 「173 个石头」
  s = s.split('\n').map(x => x.trim()).filter(Boolean).join('\n')
  // 最多留 6 句 —— 再长就不是"看一眼"了
  const parts = s.split(/(?<=[。！？!?])/).filter(x => x.trim())
  if (parts.length > 6) s = parts.slice(0, 6).join('')
  return s.trim()
}

class Perception {
  constructor (bot, ctx) {
    this.bot = bot
    this.ctx = ctx || {}    // { mem, events, llm, log }
    this.mem = this.ctx.mem
    this.events = this.ctx.events
    this.llm = this.ctx.llm || null
    this.log = this.ctx.log || (() => {})
    this.lastPos = null
    this.lastScanAt = 0

    // ---- 视觉缓存 ----
    // 地形变化慢。每 tick 调一次模型纯属浪费，而且没必要 —— 30 秒内世界不长草。
    this.sight = {
      map: null,          // { text, at, pos, y, underground, blind }
      mapDirty: true,     // 周围方块变了
      scene: '',          // 模型说的那几句人话
      sceneAt: 0,
      scenePos: null,
      inflight: false,
      failAt: 0,
      lastCallAt: 0,
      // 记账（验收要用，不是装饰）
      reads: 0,           // 被问了几次"你看见什么"
      hits: 0,            // 其中几次直接给了缓存
      calls: 0,           // 真正调了几次模型
      fails: 0,
      tokens: { prompt: 0, completion: 0 },
      lastMs: 0,
      lastErr: null,
      callsLog: []        // [{at, why, ms, prompt, completion, text}]
    }
    this._timer = null
    this._onBlock = null
    this._onEnd = null

    // 有 llm 就自己起来看 —— wiring 只需要多传这一个字段，
    // 不用谁记得每 tick 来喂。（探针/测试传 ctx.autoStart=false 关掉）
    if (!this.llm) {
      this.log('[sight] 没拿到 llm —— 只出图，不说话。main.js 要传 llm: this.llm')
    }
    if (this.ctx.autoStart !== false && this.llm && this.bot) {
      const t = setTimeout(() => { try { this.start() } catch (e) {} }, 3000)
      if (t.unref) t.unref()
    }
  }

  // ============ 生命周期 ============

  /**
   * 起来自己看。
   *
   * wiring 只需要传一个 llm 字段，剩下的自己动 —— 不用谁记得每 tick 来喂。
   * （有 llm 才起；没有 llm 就只出图，图本身也是"看见"。）
   */
  start (opts = {}) {
    if (this._timer) return false
    if (!this.bot) return false

    // 方块变了就标脏（挖了 / 放了 / 别人在旁边盖房子）
    this._onBlock = (oldBlock, newBlock) => {
      try {
        const p = this.pos()
        if (!p) return
        const b = newBlock && newBlock.position
        if (!b) return
        const dx = b.x - p.x
        const dz = b.z - p.z
        if (Math.abs(dx) <= SIGHT.R + 1 && Math.abs(dz) <= SIGHT.R + 1 &&
            Math.abs(b.y - p.y) <= 12) {
          this.sight.mapDirty = true
        }
      } catch (e) {}
    }
    try { this.bot.on('blockUpdate', this._onBlock) } catch (e) {}

    this._onEnd = () => { this.sight.mapDirty = true; this.sight.scene = '' }
    try { this.bot.once('end', this._onEnd) } catch (e) {}

    // 5 秒一看：够快（他走动后 5 秒内就有新图），又不至于空转
    if (opts.timer !== false) {
      this._timer = setInterval(() => { this._tick() }, 5000)
      if (this._timer.unref) this._timer.unref()
      // 第一张图别等 5 秒
      const t = setTimeout(() => { this._tick() }, 2500)
      if (t.unref) t.unref()
    }
    return true
  }

  stop () {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
    try { if (this._onBlock) this.bot.removeListener('blockUpdate', this._onBlock) } catch (e) {}
    this._onBlock = null
  }

  _tick () {
    if (!this.canSee()) return
    // 后台刷新：不 await，错了就等下一次
    this.ensureScene({ why: 'tick' }).catch(e => {
      this.log('[sight] ' + (e && e.message))
    })
  }

  // ---------------- 基础工具 ----------------

  /** 把相对位移翻译成中文方位 */
  dirOf (dx, dz) {
    // Minecraft: -Z = 北, +X = 东
    const angle = Math.atan2(dx, -dz)        // 0 = 北, 顺时针
    const idx = Math.round(((angle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8
    return DIRS[idx]
  }

  pos () {
    try { return this.bot.entity.position } catch (e) { return null }
  }

  /**
   * 读一个方块。
   *
   * **null 有两种完全不同的意思，绝不能混：**
   *   - 区块没加载 / 刚断线 / 人死了还没复活 -> null（我们"看不见"）
   *   - 那里确实是空气                   -> { name:'air' }（我们"看见了，是空的"）
   *
   * 之前把两者当成一回事：断线时 blockAt 全返回 null，
   * 于是"头顶一路没遮挡" -> 判成露天 -> 他以为自己在地面上。
   * actions.js 的 isUnderground 现在还有这个问题（不归我改，报告见 PERCEPTION-REPORT.md）。
   */
  blockAt (pos) {
    if (!pos) return null
    try {
      return this.bot.blockAt(pos) || null
    } catch (e) {
      return null
    }
  }

  /** 这个世界我到底看得见吗（有没有 entity、脚下那块加载了没） */
  canSee () {
    const p = this.pos()
    if (!p) return false
    return this.blockAt(p.offset(0, -1, 0)) !== null
  }

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
   * 头顶的通天情况。
   *
   * 这是"我在洞里还是在地面"的唯一判据，所以必须能表达"不知道"。
   *
   * 关键：扫的过程中只要连续遇到 null，就不能下"露天"的结论 ——
   * 那可能是石头，只是区块还没加载。这时返回 unknown。
   *
   * @returns {{
   *   state: 'open'|'covered'|'unknown',
   *   firstBlockAt: number,   // 第一块遮挡离头顶几格，-1 = 没找到
   *   firstBlock: string|null,
   *   checked: number,        // 扫了几格
   *   blind: number           // 其中几格看不见（null）
   * }}
   */
  sky () {
    const p = this.pos()
    if (!p) return { state: 'unknown', firstBlockAt: -1, firstBlock: null, checked: 0, blind: 0 }

    let checked = 0
    let blind = 0
    let firstBlockAt = -1
    let firstBlock = null

    for (let dy = 2; dy <= 60; dy++) {
      checked++
      const b = this.blockAt(p.offset(0, dy, 0))
      if (!b) {
        blind++
        // 连续 3 格看不见就不猜了（再往上大概率都没加载）
        if (blind >= 3) break
        continue
      }
      // 树叶/原木算遮挡，但不等于在洞里 —— 树底下也是露天
      if (b.boundingBox === 'block' && !/leaves|log/.test(b.name)) {
        firstBlockAt = dy
        firstBlock = b.name
        break
      }
    }

    if (blind >= 3) {
      return { state: 'unknown', firstBlockAt: -1, firstBlock: null, checked, blind }
    }
    if (firstBlockAt < 0) {
      return { state: 'open', firstBlockAt: -1, firstBlock: null, checked, blind }
    }
    return { state: 'covered', firstBlockAt, firstBlock, checked, blind }
  }

  /**
   * 我是不是在地下 —— **正确版**。
   *
   * 这个函数是给 Lead 参考/替换 actions.js 里那个 isUnderground 用的
   *（actions.js 不归我改，只报告问题）。
   *
   * 跟 actions.js 那版的三处差别：
   *   1. 断线 / 区块没加载 -> 返回 null（不知道），不是 false（露天）
   *   2. 阈值从 15 放宽到 20，并加"绝对高度"兜底：
   *      y < 60 且头顶有遮挡 -> 一定在地下
   *   3. 树冠（leaves/log）不算遮挡，站在树顶不该判成洞
   *
   * @returns {boolean|null} true 地下 / false 露天 / null 看不清
   */
  isUnderground () {
    const p = this.pos()
    if (!p) return null

    // 头顶 2-3 格就被挡 -> 铁定在洞里（这条不依赖远处区块）
    const near = this.blockAt(p.offset(0, 2, 0))
    const near2 = this.blockAt(p.offset(0, 3, 0))
    if (near && near.boundingBox === 'block') return true
    if (near2 && near2.boundingBox === 'block') return true

    const s = this.sky()

    // 看不见 -> 不知道，别猜
    if (s.state === 'unknown') return null
    // 头顶通天 -> 露天
    if (s.state === 'open') return false
    // 有遮挡：近处的算洞；远的算山体/树冠
    if (s.firstBlockAt <= 20) return true
    // 已经在很低的位置（地表一般 63-72），头顶还有遮挡 -> 还是洞里
    if (p.y < 60) return true
    return false
  }

  /**
   * 描述"我站在什么地方"。
   * 这是最有用的一条 —— 模型需要知道自己在哪。
   *
   * 断线时不再瞎编"我站在不知道什么上"，而是如实说看不见。
   */
  describeTerrain () {
    const p = this.pos()
    if (!p) return '我不知道自己在哪（还没进游戏或者刚断线）'

    const bits = []
    const ent = this.bot.entity || {}

    // 脚下是什么
    const below = this.blockAt(p.offset(0, -1, 0))
    const feet = this.blockAt(p)
    const groundName = below ? (INTERESTING[below.name] || groundWord(below.name)) : null

    if (ent.isInWater) bits.push('我在水里')
    else if (ent.isInLava) bits.push('我泡在岩浆里')
    else if (feet && feet.name !== 'air' && feet.name !== 'cave_air' && feet.boundingBox === 'block') {
      bits.push('我卡在方块里')
    } else if (groundName) {
      bits.push(`我站在${groundName}上`)
    } else {
      // 看不见脚下 —— 断线、区块没加载、或者正在掉落
      bits.push('脚下看不见（区块没加载，或者我正在往下掉）')
    }

    // 头顶有没有遮挡 -> 洞里还是露天。必须区分"露天"和"看不见"
    const s = this.sky()
    if (s.state === 'open') bits.push('头顶是露天的')
    else if (s.state === 'covered') bits.push('头顶有遮挡，像在洞里或者树底下')
    else bits.push('头顶看不清（区块没加载，别当自己在地面上）')

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
    const tod = this.bot.time && this.bot.time.timeOfDay
    if (tod !== undefined && tod !== null) {
      if (tod < 12000) bits.push('现在是白天')
      else if (tod < 13800) bits.push('天快黑了')
      else if (tod < 22200) bits.push('现在是晚上')
      else bits.push('天快亮了')
    }
    if (this.bot.isRaining) bits.push('在下雨')

    return bits.join('，')
  }

  /**
   * 某个水平位置的地面高度。
   * @returns {number|null} null 表示"要么没地面，要么看不见" —— 要区分用 heightAtDetail()
   */
  heightAt (dx, dz) {
    return this.heightAtDetail(dx, dz).y
  }

  /** 带原因的版本：能分清"这里是空的"和"我看不见" */
  heightAtDetail (dx, dz) {
    const p = this.pos()
    if (!p) return { y: null, why: 'blind' }

    const base = p.offset(dx, 0, dz)
    let blind = 0
    for (let dy = 8; dy >= -12; dy--) {
      const b = this.blockAt(base.offset(0, dy, 0))
      if (!b) { blind++; continue }
      if (b.boundingBox === 'block' && !/leaves|log/.test(b.name)) {
        return { y: Math.floor(p.y + dy), why: 'ok' }
      }
    }
    return { y: null, why: blind > 0 ? 'blind' : 'empty' }
  }

  // ---------------- 附近有什么 ----------------

  /**
   * 附近值得注意的东西，带方位。
   * 用聚类：把挨着的同类方块合成一个"地方"。
   */
  describeNearby (radius = 26, limit = 8) {
    const p = this.pos()
    if (!p) return '我看不见周围（还没进游戏或者刚断线）'
    const groups = new Map()   // name -> [{pos, n}]
    let sampled = 0
    let blind = 0

    // 采样，别太密（性能）
    for (let dx = -radius; dx <= radius; dx += 2) {
      for (let dz = -radius; dz <= radius; dz += 2) {
        for (let dy = -10; dy <= 12; dy += 2) {
          sampled++
          const b = this.blockAt(p.offset(dx, dy, dz))
          if (!b) { blind++; continue }
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

    // 采样点里超过一半读不到 -> 是断线/区块没加载，不是"周围什么都没有"
    const blindPct = sampled ? blind / sampled : 0
    if (blindPct > 0.5) {
      return `周围大部分看不见（${Math.round(blindPct * 100)}% 的采样点读不到，区块没加载或者刚断线）`
    }

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
    if (!p) return ''

    for (const e of Object.values(bot.entities || {})) {
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
    if (!p) return '我不知道自己在哪，也看不清谁在附近'

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
    if (!ent || !ent.position) return ''
    const prev = this._playerPrev && this._playerPrev[name]
    this._playerPrev = this._playerPrev || {}
    let pos
    try { pos = ent.position.clone() } catch (e) { return '' }
    const now = { pos, at: Date.now() }
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
      const ago = Math.max(1, Math.round((now - (e.lastAt || e.at)) / 1000))
      const n = e.count || 1
      return `${ago} 秒前 ${e.what}${n > 1 ? `（${n} 次）` : ''}`
    }).join('；')
  }

  // ---------------- 自己 ----------------

  describeSelf () {
    const bot = this.bot
    if (!bot || !bot.entity) return '我看不到自己的状态（没连上服务器）'

    let items = []
    try { items = bot.inventory ? bot.inventory.items() : [] } catch (e) { items = [] }
    const slots = items.length
    const held = bot.heldItem ? itemWord(bot.heldItem.name) : '空手'

    const hp = Number.isFinite(bot.health) ? Math.round(bot.health) : '?'
    const food = Number.isFinite(bot.food) ? Math.round(bot.food) : '?'

    const bits = [
      `血 ${hp}/20`,
      `饿 ${food}/20`,
      `手上是${held}`
    ]
    if (slots >= 32) bits.push('背包快满了')
    else if (slots === 0) bits.push('背包空的')
    else bits.push(`背包 ${slots} 格东西`)

    return bits.join('，')
  }

  // ============ 视觉：三张图 + 两刀剖面 ============

  /**
   * 建一次网格。17x17 三个层 + 两条剖面，约 5000 次 blockAt。
   * 30 秒最多一次，忽略不计。
   */
  _grid () {
    const p = this.pos()
    if (!p) return null
    const R = SIGHT.R
    const fx = Math.floor(p.x)
    const fy = Math.floor(p.y)       // 脚所在的那一格
    const fz = Math.floor(p.z)
    const base = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    const N = base
    const at = (dx, dy, dz) => this.blockAt(N.offset(dx, dy, dz))

    const view = []     // [dz][dx] 俯视合成图：挡路的看材质，空着的看地面
    const ground = []   // [dz][dx] 高差字符
    const ent = []      // [dz][dx] 实体层
    const feat = { man: 0, light: 0, table: 0, water: 0, lava: 0, ore: 0, tree: 0, door: 0 }
    const manAt = { x: 0, z: 0 }
    let blind = 0
    let cells = 0

    for (let dz = -R; dz <= R; dz++) {
      const rowV = []
      const rowG = []
      for (let dx = -R; dx <= R; dx++) {
        cells++
        const bFeet = at(dx, 0, dz)       // 身体那格：实心就是挡路的（墙/树/箱子）
        if (!bFeet) blind++
        // 脚下这格：往下找第一块实心。坡地上 feet-1 是空气，
        // 死盯这一层会让整张图变成 ░（第一版就是这么错的，实测整片草地看不见）
        let bFloor = null
        for (let dy = -1; dy >= -4; dy--) {
          const b = at(dx, dy, dz)
          if (!b) continue
          if (solidOf(b) || b.name.includes('water') || b.name.includes('lava')) { bFloor = b; break }
        }

        // ① 合成俯视：挡路的显示它自己的材质，空着的显示脚下是什么
        let c
        if (bFeet && bFeet.boundingBox === 'block') c = symOf(bFeet)
        else if (bFeet && (bFeet.name.includes('water') || bFeet.name.includes('lava'))) c = symOf(bFeet)
        else c = symOf(bFloor)
        if (dx === 0 && dz === 0) c = '@'
        rowV.push(c)

        // ② 高差（第一块实心）+ 顺手做一遍 3D 材质普查
        //    普查是"这墙是圆石补的""这里有矿"的唯一来源 —— 只看一层看不出这些
        let first = null
        let colBlind = false
        for (let dy = 1; dy >= -SIGHT.SCAN_DOWN; dy--) {
          const b = at(dx, dy, dz)
          if (!b) { colBlind = true; continue }
          const solid = solidOf(b)
          if (!solid && !b.name.includes('water') && !b.name.includes('lava')) continue
          const ch = symOf(b)
          if (ch === '+') { feat.man++; manAt.x += dx; manAt.z += dz } else if (ch === '*') feat.light++
          else if (ch === 'C') feat.table++
          else if (ch === '≈') feat.water++
          else if (ch === '!') feat.lava++
          else if (ch === 'O') feat.ore++
          else if (ch === 'T' || ch === 't') feat.tree++
          else if (ch === '=') feat.door++
          if (first === null && solid) first = dy
        }
        rowG.push(groundChar(first, colBlind && first === null))
      }
      view.push(rowV)
      ground.push(rowG)
    }

    // ③ 实体层
    for (let dz = -R; dz <= R; dz++) ent.push(new Array(2 * R + 1).fill('·'))
    let entN = 0
    for (const e of Object.values(this.bot.entities || {})) {
      if (!e || e === this.bot.entity || !e.position) continue
      const ex = Math.floor(e.position.x) - fx
      const ez = Math.floor(e.position.z) - fz
      const ey = Math.floor(e.position.y) - fy
      if (Math.abs(ex) > R || Math.abs(ez) > R || Math.abs(ey) > 6) continue
      ent[ez + R][ex + R] = e.type === 'player' ? '●' : (HOSTILE.has(e.name) ? '▲' : '○')
      entN++
    }

    return { view, ground, ent, entN, feat, manAt, fx, fy, fz, blind, cells, p: new Vec3(p.x, p.y, p.z) }
  }

  /**
   * 整个"图"块，带上标题和图例。
   *
   * @param {{force?:boolean}} opts
   */
  mapView (opts = {}) {
    const now = Date.now()
    const p = this.pos()
    if (!p) return { text: '（看不见：还没进游戏，或者刚断线）', at: now, blind: true, pos: null, grid: null }

    const st = this.sight
    const far = !st.map || !st.map.pos || st.map.pos.distanceTo(p) > SIGHT.MOVE_BLOCKS
    const old = !st.map || now - st.map.at > SIGHT.TTL_MS
    if (!opts.force && st.map && !st.mapDirty && !far && !old) return st.map

    let g = null
    try { g = this._grid() } catch (e) { this.log('[sight] grid: ' + e.message) }
    if (!g) {
      const bad = { text: '（地形读不出来，可能刚断线）', at: now, blind: true, pos: new Vec3(p.x, p.y, p.z), grid: null, traces: [] }
      st.map = bad
      return bad
    }

    const L = []
    L.push(`【图例】${LEGEND}`)
    L.push(`【俯视图 · 你身上这一层的平面（北在上，@是你，每格 1 方块；${2 * SIGHT.R + 1}x${2 * SIGHT.R + 1}）】`)
    for (const row of g.view) L.push('  ' + row.join(''))
    L.push('【高差图 · 每格和你脚底差几格（0 平 1-6 高出来 # 到你头那么高 . 低一格 , 低两格 - 更低 _ 底下是空的 ? 看不见）】')
    for (const row of g.ground) L.push('  ' + row.join(''))
    if (g.entN > 0) {
      L.push('【谁站在哪（▲怪 ●人 ○动物）】')
      for (const row of g.ent) L.push('  ' + row.join(''))
    }
    L.push('')
    L.push(this._profile(g, 'x'))
    L.push(this._profile(g, 'z'))

    const blindPct = g.cells ? g.blind / g.cells : 0
    if (blindPct > 0.4) L.push(`【注意】${Math.round(blindPct * 100)}% 的格子读不到（区块没加载）。图上 '?' 是"看不清"，不是"空气"，别当成通路。`)

    const text = L.join('\n')
    const rec = {
      text,
      at: now,
      pos: new Vec3(p.x, p.y, p.z),
      grid: g,
      fx: g.fx,
      fy: g.fy,
      fz: g.fz,
      blind: blindPct > 0.4,
      underground: this.isUnderground(),
      traces: this.traces(g)
    }
    st.map = rec
    st.mapDirty = false
    return rec
  }

  /** 一条竖剖面：东西向（x）或南北向（z），过你脚下 */
  _profile (g, axis) {
    const half = SIGHT.HALF
    const up = SIGHT.UP
    const down = SIGHT.DOWN
    const p = this.pos()
    const head = axis === 'x' ? '【侧视图 · 东西向（左西右东）】' : '【侧视图 · 南北向（左北右南）】'
    const out = [head]
    for (let dy = up; dy >= -down; dy--) {
      let row = ''
      for (let d = -half; d <= half; d++) {
        const b = axis === 'x' ? this.blockAt(p.offset(d, dy, 0)) : this.blockAt(p.offset(0, dy, d))
        let c = symOf(b)
        if (d === 0 && dy === 0) c = '@'
        else if (d === 0 && dy === 1) c = 'Y'     // 你的身体（头）
        row += c
      }
      out.push(`y=${Math.floor(p.y) + dy}`.padEnd(8) + ' ' + row)
    }
    return out.join('\n')
  }

  /**
   * 痕迹 —— "这里被人挖过""这墙是补的""有人在这干过活"。
   *
   * 这一段是"注意到"的核心：数字表永远说不出这些，
   * 因为它们不是"有什么"，是"哪里不对劲"。
   */
  traces (g) {
    if (!g) return []
    const R = SIGHT.R
    const out = []
    const dirAt = (dx, dz) => this.dirOf(dx, dz)
    const cellOf = (arr, dx, dz) => (arr[dz + R] ? arr[dz + R][dx + R] : '?')

    // ① 一格宽的长通道：人挖的矿道 / 走廊
    //    判断：这条线上能过（0 / . / ,），南北两边都堵着 -> 东西向走廊
    const pass = c => c === '0' || c === '.' || c === ','
    let tunnel = null
    for (let dz = -R + 1; dz <= R - 1 && !tunnel; dz++) {
      let run = 0
      let best = 0
      let atX = 0
      for (let dx = -R + 1; dx <= R - 1; dx++) {
        const c = cellOf(g.ground, dx, dz)
        const n = cellOf(g.ground, dx, dz - 1)
        const s = cellOf(g.ground, dx, dz + 1)
        if (pass(c) && !pass(n) && !pass(s)) {
          run++
          if (run > best) { best = run; atX = dx }
        } else run = 0
      }
      if (best >= 6) tunnel = `一条笔直的一格宽通道，在${dirAt(atX, dz)}边延伸出去`
    }
    if (!tunnel) {
      for (let dx = -R + 1; dx <= R - 1 && !tunnel; dx++) {
        let run = 0
        let best = 0
        let atZ = 0
        for (let dz = -R + 1; dz <= R - 1; dz++) {
          const c = cellOf(g.ground, dx, dz)
          const w = cellOf(g.ground, dx - 1, dz)
          const e = cellOf(g.ground, dx + 1, dz)
          if (pass(c) && !pass(w) && !pass(e)) {
            run++
            if (run > best) { best = run; atZ = dz }
          } else run = 0
        }
        if (best >= 6) tunnel = `一条笔直的一格宽通道，在${dirAt(dx, atZ)}边延伸出去`
      }
    }
    if (tunnel) out.push(tunnel)

    // ② 挡路的实心：墙 / 山体 / 洞壁
    let wall = 0
    let wx = 0
    let wz = 0
    // 只数内圈：地图最外两圈基本都是"视野边缘的石头"，会把方向带偏
    const Ri = R - 2
    for (let dz = -Ri; dz <= Ri; dz++) {
      for (let dx = -Ri; dx <= Ri; dx++) {
        if (cellOf(g.ground, dx, dz) === '#') { wall++; wx += dx; wz += dz }
      }
    }
    const wallPct = g.cells ? wall / g.cells : 0
    if (wallPct > 0.55) out.push('四周基本都堵着，你像是待在一条通道或者洞里')
    else if (wall >= 8) out.push(`${dirAt(wx / wall, wz / wall)}边有一片到头的实心，像墙或者山体`)

    // ③ 脚边的坑 / 断崖
    let drop = 0
    for (const [name, dx, dz] of [['北', 0, -1], ['南', 0, 1], ['东', 1, 0], ['西', -1, 0]]) {
      for (let d = 1; d <= 3; d++) {
        const c = cellOf(g.ground, dx * d, dz * d)
        if (c === '-' || c === '_') { out.push(`${name}边三格内是个坑，踩空会掉下去`); drop++; break }
      }
      if (drop >= 2) break
    }

    // ④ 人造方块：补过的墙、垒过的东西
    if (g.feat.man >= 8) {
      const m = g.feat.man
      const dx = g.manAt.x / m
      const dz = g.manAt.z / m
      out.push(`${dirAt(dx, dz)}边有一片砌过的方块（圆石/木板/砖那类），看着是人垒的`)
    }

    // ⑤ 有人在这干过活
    if (g.feat.light && g.feat.table) out.push('插着火把、还摆着工作台或箱子，有人在这住过或者常来')
    else if (g.feat.table) out.push('附近有箱子或工作台，有人在这收拾过')
    else if (g.feat.light) out.push('附近有火把，有人来过')

    // ⑥ 水 / 岩浆
    if (g.feat.lava > 0) out.push('有岩浆，别掉进去')
    else if (g.feat.water > 0) out.push('附近有水')

    // ⑦ 树 / 矿
    if (g.feat.tree > 0) out.push('附近有树')
    if (g.feat.ore >= 4) out.push('眼前的石头里有矿露出来')

    // ⑧ 头顶压不压
    const p = this.pos()
    if (p) {
      const head2 = this.blockAt(p.offset(0, 2, 0))
      const head3 = this.blockAt(p.offset(0, 3, 0))
      if ((head2 && solidOf(head2)) || (head3 && solidOf(head3))) out.push('头顶很低，两层之内就压着石头，得低头走')
    }

    return out.slice(0, 6)
  }

  // ============ 让模型把图说成人话 ============

  /** 缓存还有效吗（三个条件：没走远 / 没变过 / 没超时） */
  sceneFresh (p) {
    const st = this.sight
    if (!st.scene) return false
    if (st.mapDirty) return false
    if (Date.now() - st.sceneAt > SIGHT.TTL_MS) return false
    if (!st.scenePos || !p) return false
    if (st.scenePos.distanceTo(p) > SIGHT.MOVE_BLOCKS) return false
    return true
  }

  /** 同步读上一次的景象。说话/做决定的地方用这个 —— 不能等模型。 */
  sceneText () {
    const p = this.pos()
    if (!this.sight.scene) return ''
    if (!this.sceneFresh(p)) {
      // 过期了也先给旧的：旧的景象比没有强，后台马上会换新的
      return this.sight.scene
    }
    return this.sight.scene
  }

  /**
   * 确保有一份新鲜的景象。有缓存就不调模型。
   *
   * @param {{force?:boolean, why?:string}} opts
   * @returns {Promise<string>} 那几句人话（或图，没有 llm 时）
   */
  async ensureScene (opts = {}) {
    const st = this.sight
    st.reads++
    const p = this.pos()
    if (!p || !this.canSee()) { st.hits++; return st.scene || '' }

    const fresh = this.sceneFresh(p)
    if (fresh && !opts.force) { st.hits++; return st.scene }
    if (st.inflight) { st.hits++; return st.scene || '' }
    // 去抖只拦"刚刚算过"（防同一个 tick 里连着打）——
    // 原来这里拦的是 nextTryAt，结果"走远 9 格该重算"被 4 秒去抖吃掉了（实测）。
    if (!opts.force && st.sceneAt && Date.now() - st.sceneAt < SIGHT.MIN_SCENE_MS) {
      st.hits++
      return st.scene || ''
    }
    // 失败退避
    if (!opts.force && st.failAt && Date.now() - st.failAt < SIGHT.FAIL_BACKOFF_MS) {
      st.hits++
      return st.scene || ''
    }
    // 硬下限：冲刺的时候 5 秒就走出 28 格，"走远 8 格就重算"每 tick 都成立 ——
    // 那不叫感知，那叫烧 token。15 秒一次封顶，期间先给上一眼。
    if (!opts.force && st.lastCallAt && Date.now() - st.lastCallAt < SIGHT.HARD_FLOOR_MS) {
      st.hits++
      return st.scene || ''
    }

    const map = this.mapView({ force: opts.forceMap })
    if (!this.llm) {
      // 没有模型：图本身就是"看见"。不说话，但也不瞎。
      st.hits++
      st.scene = ''
      st.sceneAt = Date.now()
      st.scenePos = new Vec3(p.x, p.y, p.z)
      return map.text
    }

    st.inflight = true
    st.lastCallAt = Date.now()
    const t0 = Date.now()
    const why = opts.why || 'ask'
    try {
      const prompt = this._scenePrompt(map, p)
      const msgs = [{ role: 'user', content: prompt }]
      let r = await this.llm.chat(msgs, { maxTokens: SIGHT.MAX_TOKENS, temperature: 1.0 })
      let usage = (r.raw && r.raw.usage) || {}
      let text = cleanScene(r.text)

      // 【实测 · 2026-11-14】这个端点默认开着 thinking，reasoning 也算在
      // completion_tokens 里。800 的预算会被思考吃干，content 空着回来
      // （finish=length，usage 800/800）。所以预算拉到 2000；
      // 万一还是被吃干，再加一档重试一次 —— 宁可多花 token，不许"看不见"。
      if (!text && r.finish === 'length') {
        const retry = await this.llm.chat(msgs, { maxTokens: SIGHT.MAX_TOKENS * 2, temperature: 1.0 })
        const u2 = (retry.raw && retry.raw.usage) || {}
        usage = {
          prompt_tokens: (usage.prompt_tokens || 0) + (u2.prompt_tokens || 0),
          completion_tokens: (usage.completion_tokens || 0) + (u2.completion_tokens || 0)
        }
        r = retry
        text = cleanScene(retry.text)
      }
      const ms = Date.now() - t0

      st.calls++
      st.tokens.prompt += usage.prompt_tokens || 0
      st.tokens.completion += usage.completion_tokens || 0
      st.lastMs = ms
      if (text) {
        st.scene = text
        st.sceneAt = Date.now()
        st.scenePos = new Vec3(p.x, p.y, p.z)
      } else {
        st.fails++
        st.failAt = Date.now()
        st.lastErr = 'empty content（finish=' + r.finish + '）'
      }
      st.callsLog.push({
        at: Date.now(),
        why,
        ms,
        prompt: usage.prompt_tokens || 0,
        completion: usage.completion_tokens || 0,
        text: String(text || '').slice(0, 60)
      })
      if (st.callsLog.length > 30) st.callsLog.shift()
      this.log(`[sight] 看了一次（${why}）：${ms}ms，${usage.prompt_tokens || 0}+${usage.completion_tokens || 0} tok`)
      return st.scene
    } catch (e) {
      st.fails++
      st.failAt = Date.now()
      st.lastErr = String(e && e.message || e).slice(0, 120)
      this.log('[sight] 看失败：' + st.lastErr)
      return st.scene || map.text
    } finally {
      st.inflight = false
    }
  }

  /** 给模型看的那段话。图和原始数据都给它，让它自己判断什么重要。 */
  _scenePrompt (map, p) {
    const g = map.grid
    const bits = []
    bits.push('你在玩 Minecraft。下面是你此刻"看到"的东西 —— 不是让你算的，是让你看的。')
    bits.push('')
    bits.push(map.text)
    bits.push('')

    // 原始数据：保留，但只是底料
    const raw = []
    try { raw.push('周围的东西：' + this.describeNearby(24, 6)) } catch (e) {}
    try { raw.push('人：' + this.describePeople(48)) } catch (e) {}
    try {
      const t = this.describeThreats(20, 4)
      if (t) raw.push('怪：' + t)
    } catch (e) {}
    if (raw.length) {
      bits.push('【原始数据（底料，别照抄）】')
      bits.push(raw.join('\n'))
      bits.push('')
    }

    const tr = map.traces || []
    if (tr.length) {
      bits.push('【已经注意到的痕迹（可以采纳，也可以推翻）】')
      bits.push(tr.map(x => '- ' + x).join('\n'))
      bits.push('')
    }

    const where = []
    where.push(map.underground === true ? '你在地下' : map.underground === false ? '你在地面上' : '你在哪看不清楚')
    try {
      const tod = this.bot.time && this.bot.time.timeOfDay
      if (tod != null) where.push(tod < 12000 ? '白天' : tod < 13800 ? '天快黑了' : tod < 22200 ? '夜里' : '天快亮了')
      if (this.bot.isRaining) where.push('在下雨')
    } catch (e) {}
    try {
      const below = this.blockAt(this.pos().offset(0, -1, 0))
      if (below) where.push('脚下是' + (INTERESTING[below.name] || groundWord(below.name)))
    } catch (e) {}
    if (map.traces && map.traces.some(t => /火把|箱子/.test(t))) where.push('这地方有人活动过')
    bits.push('【现在的处境】' + where.join('，'))

    bits.push('')
    bits.push('用 3-5 句话描述你看到的景象：')
    bits.push('- 说"这像什么"：一堵墙 / 一条走廊 / 一个院子 / 一段矿道 / 一片林子 / 一个坑')
    bits.push('- 说有没有路可走、往哪边走，哪边不对劲、哪里可能出事')
    bits.push('- 不要报坐标，不要报数量（别说"有 173 个石头"，说"这边全是石头"）')
    bits.push('- 不要念方块英文名，不要用列表，不要写"根据图"、"图中显示"这种话')
    bits.push('- 像一个人站在那抬眼扫了一圈，心里过的一句话')
    bits.push('- 例子：「前面一堵石墙，看着是自己垒的。左边有个口子能过去。脚下这块地挖过，石头是新的断口。」')
    return bits.join('\n')
  }

  /**
   * 一次给足的"你看见什么"：景象 + 图。
   * 给 goals / 任务上下文用 —— 那两处要图也要话。
   */
  sightBlock (opts = {}) {
    const map = this.mapView(opts)
    const parts = []
    const scene = this.sceneText()
    if (scene) parts.push('【景象】' + scene.replace(/\n/g, ''))
    parts.push(map.text)
    const tr = map.traces || []
    if (tr.length) parts.push('【痕迹】' + tr.join('；'))
    return parts.join('\n')
  }

  /** 只要那几句人话。给 contextForTask 里已经有图的地方用。 */
  sightLine () {
    const s = this.sceneText()
    return s ? '【景象】' + s.replace(/\n/g, '') : ''
  }

  // ---------------- 汇总 ----------------

  /**
   * 完整的世界快照。
   * 这是给模型看的"你现在看到了什么"。
   */
  snapshot (opts = {}) {
    // 每一项单独兜底：一项挂了不该把整张快照拖没
    const safe = (fn, fallback) => {
      try { return fn() } catch (e) { return fallback }
    }

    const terrain = safe(() => this.describeTerrain(), '（地形描述失败）')
    const nearby = safe(() => this.describeNearby(opts.radius || 26), '（附近描述失败）')
    const threats = safe(() => this.describeThreats(opts.threatRadius || 20), '')
    const people = safe(() => this.describePeople(opts.peopleRadius || 48), '（看不清）')
    const recent = safe(() => this.describeRecent(opts.recentSeconds || 45), '')
    const self = safe(() => this.describeSelf(), '（自己状态读不到）')

    const lines = []
    // 【景象】排第一 —— 这是"他看见世界"的那一眼，比任何计数都重要
    const sight = safe(() => this.sightLine(), '')
    if (sight) lines.push(sight)
    if (opts.map !== false) {
      const mv = safe(() => this.mapView(opts), null)
      if (mv && mv.text) lines.push(mv.text)
    }
    lines.push(`【你在哪】${terrain}`)
    lines.push(`【附近】${nearby}`)
    if (threats) lines.push(`【有威胁】${threats}`)
    lines.push(`【人】${people}`)
    if (recent) lines.push(`【刚才】${recent}`)
    lines.push(`【自己】${self}`)

    // 地下 / 露天 —— 这是"我该往上爬还是继续挖"的直接依据
    const ug = safe(() => this.isUnderground(), null)
    if (ug === true) lines.push('【在不在洞里】在地下')
    else if (ug === false) lines.push('【在不在洞里】在地面上')
    else lines.push('【在不在洞里】看不清（区块没加载），别当自己在地面上')

    return lines.join('\n')
  }

  /** 简版快照，说话用。图上不进来，但那几句"人话"必须进来。 */
  brief () {
    const safe = (fn, fallback) => {
      try { return fn() } catch (e) { return fallback }
    }
    const lines = []
    // 自己的状态排第一：persona.dangerOf 靠这行判危险等级（血 18/20）
    lines.push(safe(() => this.describeSelf(), '状态读不到'))
    const sight = safe(() => this.sightLine(), '')
    if (sight) lines.push(sight)
    lines.push(safe(() => this.describeTerrain(), '不知道自己在哪'))
    const threats = safe(() => this.describeThreats(14, 3), '')
    if (threats) lines.push('威胁：' + threats)
    const people = safe(() => this.describePeople(32), '看不清')
    lines.push('人：' + people)
    return lines.join('\n')
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
