'use strict'
/**
 * 长期目标。
 *
 * 问题：之前的意愿是"一件事一件事"的 —— 弄把石镐、挖点石头、看看下面有什么。
 * 每件事干完就结束了，没有一个"我想盖个房子"这种要干好几天的事。
 *
 * 真人是怎么有长期目标的：
 *   心里先有个模糊的念头（"住山洞不像话，我想盖个屋子"）
 *   → 想一想现在能不能办（有镐子吗？有木头吗？）
 *   → 能办就记下来，办不到就先放着
 *   → 把它拆成"今天该干的那一步"（先找块平地）
 *   → 每天干一点，进度记着，下线不丢
 *   → 太久没进展就算了，换个目标（真人也会放弃）
 *
 * 这里做四件事：
 *   1. 候选池 —— 只是"他能想到的方向"，不是任务清单
 *   2. 打分   —— 按他现在的工具和资源算可行性，不现实的不提
 *   3. 拆解   —— 大目标拆成 3~5 个阶段，每个阶段能单独干
 *   4. 存盘   —— data/runtime/goals.json，重启接着干
 *
 * 关键克制：**不写死"必须盖房子"**。
 * 池子只是候选，真正选哪个、怎么措辞、要不要自己发明一个，交给模型。
 * 模型挂了才按可行性分数兜底 —— 那也是他自己算出来的，不是别人规定的。
 */

const fs = require('fs')
const path = require('path')

const VERSION = 1
const FILE = 'goals.json'

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))

// ---------------------------------------------------------------- 工具

const PICK_ORDER = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']

// 地表分界线。y 低于这个数，按"在地下"算。
// 海平面 63，正常地表 60~70；洞穴入口一般在 55 以下。
const SURFACE_Y = 58

/**
 * 他现在算不算在底下。
 *
 * 【为什么不能只信 status】
 * actions.status() 返回的对象里**没有** underground 字段。
 * 之前按 status.underground 判断，值永远是 undefined，
 * 于是"在地下待了多久"从来没被记下来 —— 整段逻辑是死代码。
 * 所以这里自己从坐标推：调用方给了明确的布尔值就用它，
 * 没给就按 y 判，两个都没有就当不知道（null，不改判）。
 */
function undergroundOf (status) {
  if (!status) return null
  if (typeof status.underground === 'boolean') return status.underground
  const y = status.pos && Number(status.pos.y)
  if (!isFinite(y)) return null
  return y <= SURFACE_Y
}

/**
 * 到底算不算"在露天"。
 *
 * 【为什么不能只看 y】
 * 山谷、河谷、坑道口这些地方，y 可能只有 50 出头，但头顶是天，
 * 人在外面站着 —— 按 y 判会说他"在洞里"。
 * 反过来，山体里一条高处的洞穴 y 可能到 70，头顶是石头，
 * 按 y 判会说他"在地面"，其实还困在山肚子里。
 *
 * 所以真正的判据是 actions.isUnderground()（它看头顶有没有遮挡）。
 * 上层把它塞进 status.underground 传进来就用它；
 * 没传才退回 y 坐标 —— 那个只是粗略近似。
 *
 * 返回 true / false / null（不知道）
 */
function onSurfaceOf (status) {
  const ug = undergroundOf(status)
  if (ug === null) return null
  return ug === false
}

const clamp01s = clamp01

/** 他现在的镐子能到什么级别：-1 没镐子，0 木，1 石，2 铁，3 钻石，4 下界合金 */
function pickTier (inv) {
  inv = inv || {}
  let best = -1
  for (const name of PICK_ORDER) if ((inv[name] || 0) > 0) best = Math.max(best, PICK_ORDER.indexOf(name))
  // 金镐挖不动铁以上的矿，按石镐算
  if ((inv.golden_pickaxe || 0) > 0) best = Math.max(best, 1)
  return best
}

/** 背包里某类东西有多少。支持 #log / #planks / #stone / #food 这种"一类"的写法 */
function itemCount (inv, key) {
  inv = inv || {}
  const sum = (re) => Object.entries(inv).reduce((a, [k, v]) => a + (re.test(k) ? (Number(v) || 0) : 0), 0)
  switch (key) {
    case '#log': return sum(/_log$/)
    case '#planks': return sum(/_planks$/)
    case '#stone': return sum(/^(cobblestone|stone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff)$/)
    // 能当"地表石头"用的建筑料。
    //
    // 这里必须和**他实际挖的方块**对齐：挖 stone 掉 cobblestone，
    // 挖 diorite/andesite/granite 掉同名物品 —— 都是能垫脚、能砌墙的石头。
    // 之前只认 cobblestone|stone，实测日志里他反复 `[dig] 用 stone_pickaxe
    // 挖 diorite`，东西在背包里（diorite 数量在涨），但 #surfacestone 一点
    // 不涨 → house/tower 的备料阶段永远 0 进度。
    //
    // 【P0-1 保留】深板岩（cobbled_deepslate）只在 y<0 生成，
    // 地表永远挖不到一块，仍然排除。
    // tuff 也排除：它主要在下层，且不做"地表随手攒"的料。
    case '#surfacestone': return sum(/^(cobblestone|stone|andesite|diorite|granite)$/)
    case '#food': return sum(/^(bread|cooked_|baked_potato|apple|carrot|potato|beef|porkchop|chicken|mutton|rabbit)/)
    default: return Number(inv[key]) || 0
  }
}

const ITEM_CN = {
  '#log': '木头',
  '#planks': '木板',
  '#stone': '石头',
  '#surfacestone': '地上的石头',
  '#food': '吃的',
  cobblestone: '圆石',
  stone: '石头',
  raw_iron: '粗铁',
  iron_ingot: '铁锭',
  coal: '煤',
  torch: '火把',
  diamond: '钻石',
  wheat: '小麦',
  wheat_seeds: '种子',
  wooden_hoe: '木锄',
  stone_pickaxe: '石镐',
  iron_pickaxe: '铁镐',
  iron_sword: '铁剑',
  iron_helmet: '铁头盔',
  iron_chestplate: '铁胸甲',
  furnace: '熔炉',
  oak_door: '门'
}
const cn = (k) => ITEM_CN[k] || k

/** 背包里的存货 —— 存盘时快照一份，用来算"这一阶段新弄到了多少" */
function snapInv (status) {
  const inv = (status && status.inventory) || {}
  const out = {}
  for (const [k, v] of Object.entries(inv)) out[k] = Number(v) || 0
  return out
}

function posOf (status) {
  const p = (status && status.pos) || {}
  return { x: Number(p.x) || 0, y: Number(p.y) || 0, z: Number(p.z) || 0 }
}

function dist (a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function makeBase (stage, status) {
  const p = posOf(status)
  // 【层3】记下"这一步开始时在不在下面"。
  // "回到地面"这种阶段，如果一开始人就在露天，那是**没走过**，
  // 不能算他做到了（UNHUMAN-SCAN #9 里 3 秒完成的 getup 就是这样）。
  //
  // peak：gather 阶段"达到过的最高数量"（见 trackPeak）。
  // 开局为空，第一次算进度时按 base.inv 起步。
  return { at: Date.now(), inv: snapInv(status), peak: {}, pos: p, y: p.y, ug: undergroundOf(status) }
}

// ---------------------------------------------------------------- 候选池

/**
 * 候选池。每一条是"他可能会想到的方向"，不是命令。
 *
 * 每条：
 *   key    内部标识（存盘 / 冷却用，不给人看）
 *   title  默认说法（模型可以改词）
 *   why    他为什么会想到这件事
 *   tag    对应的品味类目（有品味模块就参考，没有就不管）
 *   stages 阶段模板，need 里的数字是"大概要多少"，不是硬指标
 *   score  按当前状态算可行性（0~100），越高越现实
 */
const POOL = [
  {
    key: 'house',
    title: '攒够材料盖个小屋',
    why: '一直住山洞不像话，想要个自己的地方',
    tag: '建造',
    // 这条目标的 score() 自己会看坐标（地下压分）—— candidates() 的通用
    // 位置扣分要跳过它，否则树底下会被扣两遍（-8 变 -16）。
    locationAware: true,
    // ===== 【2026-11-13 实机反馈】边盖边攒，不要一口气攒 48+16 =====
    //
    // 原来是"备料 48 石 + 16 木 → 立墙 → 封顶"三步。
    // 实测：他人在 y=42 的洞里爬不出来，48 块地表石头是**天量**，
    // 于是 house 每次都卡在第 2 步被放弃 → 进冷却 → 30 分钟里 0 次被选中。
    //
    // 真人是"先搭个小的，再慢慢扩"：8 块石头就能围个 3×3 的窝。
    // 所以拆成三轮备料（8 → 16 → 24），每轮后面接一小段建造，
    // 让他随时有个"已经盖出来的东西"，而不是攒不满就等于白干。
    stages: [
      { kind: 'do', title: '找块够平的地方，把地面收拾出来', need: { count: 1 } },
      {
        kind: 'gather',
        title: '先弄一小堆：够围个 3×3 的石头和几根木头',
        need: { '#surfacestone': 8, '#log': 6 },
        where: '地上：脚边捡圆石，砍两棵最近的树'
      },
      { kind: 'do', title: '先搭个小的：四面矮墙立起来', need: { count: 1 } },
      {
        kind: 'gather',
        title: '再补一轮石头和木头，把屋子放大一点',
        need: { '#surfacestone': 16, '#log': 6 },
        where: '地上：石头挖裸露的岩面，木头找树'
      },
      { kind: 'do', title: '把窝扩一圈，接上墙、留个门洞', need: { count: 1 } },
      {
        kind: 'gather',
        title: '最后补一轮，够封顶压边',
        need: { '#surfacestone': 24, '#log': 4 },
        where: '地上：石头挖裸露的岩面，木头找树'
      },
      { kind: 'do', title: '封顶，顺手装个门', need: { count: 1 } }
    ],
    score (status) {
      status = status || {}
      const inv = status.inventory || {}
      const tier = pickTier(inv)
      let s = 50
      if (tier >= 1) s += 15
      if (tier >= 2) s += 10
      s += Math.min(15, itemCount(inv, '#log') / 16 * 15)
      // 【普通模式之后】天黑了有怪物，一个能关门睡觉的地方是真的要紧。
      // 只加在"该过夜"的时段上，白天这条不加分，免得又变成永远想盖房。
      try {
        const t = String(status.time || '')
        if (/夜|night|黄昏|傍晚/.test(t)) s += 12
      } catch (e) {}
      if ((status.health || 20) <= 8) s += 6

      // ===== 【排序 bug】目标自己的分数必须知道"人在哪" =====
      //
      // 之前这条检查只写在 candidates() 的通用扣分里，house.score() 单独
      // 被问的时候仍然返回 70~108 —— 比 getup 的 30~65 高。于是日志、测试、
      // 别的调用方看到的都是"他在 y=42 的洞里想盖房"，而 candidates 里
      // 的封顶只是事后补救，目标本身并没有诚实报出自己的可行性。
      //
      // 现在扣在目标自己的分数里（candidates 对 locationAware 的目标不再重复扣）：
      //   · 真的在地面以下（y < SURFACE_Y）：盖房物理上干不了，封顶 15。
      //     getup 在地下最低 30，所以哪怕夜里 +12、木头满 +15，
      //     house 也永远低于 getup —— 这是"不在地里挑盖房"的硬保证。
      //   · 地表高度、只是头顶有遮挡（树底下/洞口上方）：挪两步的事，-8。
      //   · 没给坐标：按地面算，不误伤。
      const ug = undergroundOf(status)
      const y = (status.pos && status.pos.y != null) ? Number(status.pos.y) : 70
      if (ug === true && y < SURFACE_Y) {
        s = Math.min(s - 30, 15)
      } else if (ug === true) {
        s -= 8
      }
      return s
    }
  },
  {
    key: 'iron',
    title: '挖一趟铁就上来',
    why: '石镐不经用，铁的东西才扛造',
    tag: '收集',
    // 挖矿类目标：在地下待久了会被 candidates() 扣分
    undergroundGoal: true,
    stages: [
      { kind: 'craft', title: '先弄把石镐，铁矿才挖得动', need: { item: 'stone_pickaxe', n: 1 } },
      { kind: 'gather', title: '带够火把和吃的，下去挖矿', need: { torch: 8, '#food': 4 } },
      // 【量】真人挖矿是"这一趟挖到多少算多少"，不是挖够一箱才走。
      // 12 块粗铁 ≈ 一趟正常矿洞来回的量，能烧出 12 个铁锭、做一把铁镐加几个工具。
      // 原来是 40 块，等于要在下面待到手酸 —— 这就是"一直待在地下"的直接原因。
      { kind: 'gather', title: '这一趟挖够十来块铁矿', need: { raw_iron: 12 } },
      // 【强制上来】挖完必须有一步回地面。
      // 没有这一步的话，阶段做完了目标也完了，但他人在 y=14 的洞里；
      // 下一个目标照样可能在地下开始，于是永远不抬头。
      { kind: 'surface', title: '顺着来路爬回地面，透口气', need: { y: SURFACE_Y } },
      { kind: 'gather', title: '回到地上再烧成铁锭', need: { iron_ingot: 12 } }
    ],
    score (status) {
      const tier = pickTier(status.inventory || {})
      let s = 40
      if (tier >= 1) s += 25
      if (tier >= 2) s += 15
      return s
    }
  },
  {
    key: 'diamond',
    title: '下去探一趟深层，看看有没有钻石',
    why: '听说最底下有好东西，想自己看一眼',
    tag: '冒险',
    undergroundGoal: true,
    stages: [
      { kind: 'craft', title: '先弄把铁镐，不然到深层白跑', need: { item: 'iron_pickaxe', n: 1 } },
      // 【P0-3 修】火把要在**下井前**备好。
      // 原来先 depth 后 torch：人已经摸黑下到几十层，才想起来带火把。
      // Minecraft Wiki 的挖矿流程也是"一整组火把是下去之前的事"。
      { kind: 'gather', title: '带够火把，别在下面摸黑', need: { torch: 16 } },
      // 【P0-2 修】y=16 是老版本（<1.18）的钻石层。
      // 1.18 之后钻石峰值在 y=-58/-59，y=16 只是低产区，
      // 挖到那儿就以为"到位了"，然后在贫矿层空转。
      // 取 -54 留点余量，不精确到 -58（太死板，也容易被基岩卡住）。
      { kind: 'depth', title: '往下挖到很深的地方', need: { y: -54 } },
      // 【量】找到钻石是运气活。要求"挖到 1 颗"就够 —— 没找到也不算白跑，
      // 一次没找到会走 stall 逻辑放弃，而不是逼他在下面无限挖。
      { kind: 'gather', title: '找到钻石矿，挖下来', need: { diamond: 1 } },
      { kind: 'surface', title: '不管挖没挖到，都先爬回地面', need: { y: SURFACE_Y } }
    ],
    score (status) {
      const tier = pickTier(status.inventory || {})
      if (tier >= 2) return 85
      if (tier === 1) return 45
      return 22
    }
  },
  {
    key: 'tower',
    title: '搭个高台，站上去看看这片地方长什么样',
    why: '地上看不远，站高了心里有数',
    tag: '建造',
    stages: [
      {
        kind: 'gather',
        title: '在附近地上捡够垫脚的石头',
        need: { '#surfacestone': 40 },
        where: '地上（脚边、山坡、石头裸露的地方）'
      },
      { kind: 'do', title: '一层层往上码，搭到高处', need: { count: 1 } },
      { kind: 'do', title: '站上去，把四周看一遍', need: { count: 1 } }
    ],
    score (status) {
      const inv = status.inventory || {}
      let s = 42
      if (itemCount(inv, '#surfacestone') >= 40) s += 25
      if (pickTier(inv) >= 0) s += 10
      return s
    }
  },
  {
    key: 'farm',
    title: '开一小块地，种点能吃的东西',
    why: '老靠打猎和摘野果不是长久办法',
    tag: '种养',
    stages: [
      { kind: 'craft', title: '做把锄头', need: { item: 'wooden_hoe', n: 1 } },
      { kind: 'gather', title: '找点种子', need: { wheat_seeds: 6 } },
      { kind: 'do', title: '翻地、下种、围个栅栏', need: { count: 1 } },
      { kind: 'gather', title: '等它长，收一茬麦子', need: { wheat: 8 } }
    ],
    score (status) {
      const inv = status.inventory || {}
      let s = 40
      if (itemCount(inv, '#log') >= 4) s += 12
      if (itemCount(inv, 'wheat_seeds') > 0) s += 10
      return s
    }
  },
  {
    // ===== 【rest 死锁的配套出口】=====
    // 血低 + 饿着时，光解除 rest 还不够：手上可能还挂着"砍木头"，
    // 得有一条"先弄吃的"的目标把优先级抢过来。
    key: 'food',
    title: '先弄点吃的，把血养回来',
    why: '血只剩几格，饿着回不了血',
    tag: '生存',
    // 吃的在哪都能找（地上/树上/箱子里），不受"在地下"那条位置扣分影响
    locationAware: true,
    stages: [
      { kind: 'do', title: '找点能吃的：打猎、摘野果、翻箱子都行', need: { count: 1 } }
    ],
    score (status) {
      const hp = Number(status.health)
      const food = Number(status.food)
      if (!isFinite(hp) || !isFinite(food)) return 0
      // 只在这一个组合下顶到最高：血 <8 且饿 <18（吃不到自然回血的门槛）
      return (hp < 8 && food < 18) ? 110 : 0
    }
  },
  {
    key: 'explore',
    title: '往一个方向走远点，看看那边有什么',
    why: '总在这一小片转，想知道外面是什么样',
    tag: '探索',
    // ===== 【出生点没树时的出口】=====
    //
    // 原来第一步就是「带上吃的和火把」—— 火把要木头/煤，没树就做不出来。
    // 出生点林子被砍光时，这条目标也一起卡死，他就真的没活可干了。
    // 真人在一片砍秃的地方会先**走出去看看**，而不是站着等树长出来。
    //
    // 所以第一步改成纯走路（不需要任何材料）：走出去 80 格，路上留意树。
    // 走到新地方通常就有林子，后面备料才有意义。
    stages: [
      { kind: 'travel', title: '先往远处走走，看看那边有没有树', need: { distance: 80 } },
      { kind: 'gather', title: '带上吃的和火把再出门', need: { '#food': 4, torch: 6 } },
      { kind: 'travel', title: '朝一个方向走出去，走到没见过的地界', need: { distance: 300 } },
      { kind: 'do', title: '在那边转一圈，记下有什么值得回来的', need: { count: 1 } }
    ],
    score (status) {
      let s = 38
      if ((status.health || 20) >= 16) s += 12
      if (itemCount(status.inventory || {}, '#food') >= 3) s += 10
      // 没镐、也没木头：这会儿最该做的就是出去找树，而不是卡在原地
      // 反复试「先弄把木镐」。这条加分让 explore 在这种情况下排到第一。
      const inv = status.inventory || {}
      const wood = itemCount(inv, '#log') + itemCount(inv, '#planks')
      if (undergroundOf(status) !== true && pickTier(inv) < 0 && wood < 4) s += 15
      return s
    }
  },
  {
    // 【专用出口目标】
    //
    // 用户的原话："一个正常玩家会一直把自己埋在地里吗"。
    // 光给挖矿目标扣分是堵不住的 —— 扣完分之后总分第二的仍然是某个地下活。
    // 所以得有一条"现在就该上去"的活，而且在地下待久了它的分数会涨到最高。
    //
    // 这个目标只在真的在地下时才有分（在地表时 score 是 0），
    // 所以不会变成随时都在喊"回去地面"的复读机。
    key: 'getup',
    title: '在这儿待太久了，先爬回地面上来',
    why: '洞里憋得慌，想看看天，吹吹风',
    tag: '探索',
    valleyGoal: true,
    // ===== 【实机归因】0/14 次成功 =====
    //
    // 原来只有一步 surface：必须 `isUnderground() === false`（头顶没有遮挡）
    // 才算完。可他每次能往上刨十几格就卡住，y 到了 50 出头、头顶还是石头 ——
    // 于是"真的爬了一段"在 goals 里是 0 进度，日志里只能是"没成"。
    //
    // 现在拆两步：
    //   1. climb  —— 纯高度：从 y=42 爬到 y≥58 就算这一步做到了（能做得到的事）
    //   2. surface—— 再找真正的露天（头顶见天）
    // 这样"挖上去"和"找到出口"分开计，卡住时也看得出卡在哪一段。
    stages: [
      { kind: 'climb', title: '先往上挖，挖到地表那么高', need: { y: SURFACE_Y } },
      { kind: 'surface', title: '再找露天的地方钻出去', need: { y: SURFACE_Y } },
      { kind: 'do', title: '到地面上站一会儿，看看四周', need: { count: 1 } }
    ],
    score (status) {
      // 只有在地下才想起来这件事
      if (undergroundOf(status) !== true) return 0
      const inv = status.inventory || {}
      let s = 30
      // 血少、饿、装备差 -> 更该上去
      if ((status.health || 20) <= 10) s += 15
      if ((status.food || 20) <= 8) s += 10
      if (pickTier(inv) < 1) s += 10
      return s
    }
  }
]

// ---------------------------------------------------------------- 主类

class Goals {
  /**
   * new Goals(dir, { llm, ctx, cfg, now })
   * 也接受 new Goals({ dir, llm, ... })
   *
   * dir  数据目录（一般是 data/runtime）
   * llm  可选。给了就让他自己选目标 / 自己编一个；没给就按可行性分数兜底
   * ctx  { log, taste, actions }
   * cfg  可调阈值
   * now  可注入的时钟（测试用）
   */
  constructor (dir, opts = {}) {
    if (dir && typeof dir === 'object') { opts = dir; dir = opts.dir }
    this.dir = dir || path.join(process.cwd(), 'data', 'runtime')
    this.file = path.join(this.dir, FILE)
    this.llm = opts.llm || null
    this.ctx = opts.ctx || {}
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now()
    this.cfg = Object.assign({
      stallMs: 45 * 60 * 1000,       // 这么久没有任何进展 -> 放弃
      // 【口径统一：和 src/skills.js 对齐】
      // skills 那边是"失败次数不到 2 次的不做成功率筛选"（试过的才算，
      // 第 2 次失败才允许按 minRate 排除）。goals 这边不能更松也不能更狠：
      //   失败 2 次 -> 换法子（methodSwitchFails）
      //   失败 3 次 -> 换目标（maxFails，failTotal 跨"换法子"累计）
      // 原来是 6 —— 6 次才认账，比 skills 宽太多，两边一起用的时候
      // 一边攒容错一边被抹掉，日志里就看不出到底试了几次。
      maxFails: 3,                    // 第三次还不行 -> 换目标
      // 空转同理：2 趟说成了没进展 -> 换法子；3 趟 -> 换目标。
      // maxIdleWins: 12 保留为绝对兜底（自定义目标 ways 特别多时用得上）。
      maxIdleTotal: 3,
      // 【调高：5 -> 12】UNHUMAN-SCAN #9 的 8 秒寿命就是这里造成的。
      // 5 趟 × 1.6 秒/趟 = 8 秒。12 趟大约 20 秒，配合下面的时间闸才算够。
      // 真正该修的是 #8 的假成功判定（那个不归我改），这里先把伤害限住。
      maxIdleWins: 12,                // 连续这么多趟"说成了但进度没动" -> 放弃
      cooldownMs: 2 * 60 * 60 * 1000, // 放弃后这段时间不再选它
      doneCooldownMs: 12 * 60 * 60 * 1000, // 做完了的目标这段时间不重复
      maxCustomStages: 5,
      // ===== 目标最低存活时间 =====
      //
      // 【2026-11-13 UNHUMAN-SCAN #9】25 分钟立了 6 个目标全放弃，
      // 寿命中位数 8 秒，最短 4 秒。
      //
      // 根因不是阈值"松"，是**按次数算**：
      // maxIdleWins = 5 的意思是"连续 5 趟说成了但进度没动就放弃"。
      // 但 UNHUMAN-SCAN #8 已经证明 98% 的任务判"完成"是假的，
      // 一趟"任务"只要 1~2 秒 —— 于是 5 趟 = 8 秒。
      //
      // 所以除了把次数调高，更根本的是加一条**时间**闸：
      // 目标立了之后 minLifeMs 之内不许放弃（生命危险除外）。
      // 真人不会 8 秒换一个想法；就算这目标眼下干不成，
      // 他也会先愣一会儿、试两下、再认。
      minLifeMs: 5 * 60 * 1000,       // 5 分钟内不许放弃
      minLifeStageMs: 90 * 1000,       // 每一步也至少待 90 秒
      // ===== 【UNHUMAN-SCAN #7】同一个阶段连做几遍就换**法子** =====
      //
      // 实测（data/runtime/goals.json 最近 30 条）：8 个方向全是同一句
      //   「「在附近地上捡够垫脚的石头」干了 5 趟都说成了，进度一点没动」
      // 同一个阶段连做 5 遍才动，而且一动就是整个目标被扔掉。
      //
      // 真人不是这么干的：第二遍发现"这么弄不行"，会换个法子再来一次
      // （"这锄头咋做不出来，算了直接挖石头去"），三条路都走不通才认账。
      //
      // 所以拆成两级：
      //   methodSwitchWins = 2  连续 2 趟说成了没进展 -> 换法子（日志写清换什么/为什么）
      //   maxMethods      = 3   这一阶段最多试 3 条路，都走不通才算它没戏
      // maxIdleWins: 12 保留（#9 的兜底），正常走不到 —— 先被 maxMethods 拦住。
      methodSwitchWins: 2,
      // 干不成的也算：真人做两遍不成就会换方法（原话），不是死磕六遍。
      // 但一次失败不换 —— 那才是"一失败就换"，也假。
      methodSwitchFails: 2,
      maxMethods: 3,
      // ===== 「刚上来，别马上又钻回去」 =====
      //
      // 【2026-11-13 16:47 home-owner 实测】
      //   16:47:39 [home] 到家了（48.7s）
      //   16:48:39 已经到 y=60
      //   16:50:09 到 y=55
      // 回家 1 分钟就又往下挖了。
      //
      // 光靠"在地下待久了才想上来"管不住这个 —— 因为他确实上来了，
      // 只是上来之后立刻又挑了个挖矿的活。
      // 真人回家会先歇一下、放东西、干点别的，不会掉头就往下走。
      // 所以记住"上次在地面上是什么时候"，刚上来这段时间挖矿类降权。
      surfaceHoldMs: 5 * 60 * 1000,   // 刚上来多久之内算"还没缓过来"
      surfaceHoldPenalty: 45,          // 这段时间挖矿类扣多少分
      // ===== 「今天挖一点，明天接着」 =====
      //
      // 一个阶段如果要求"攒 48 块石头"，让他一口气干完，就会连续待在地下很久。
      // 真人是一天干一点：今天挖够这一趟就上去，明天再接着挖。
      // 所以给每个阶段配一个"今天份"的额度，额度到了当天就收手。
      dayMs: 25 * 60 * 1000,   // 现实里 25 分钟算"干了一天"（一个 MC 天 20 分钟）
      dailyCap: {              // 一天大概能干多少（不是硬上限，是"今天份"）
        raw_iron: 8,
        iron_ingot: 8,
        diamond: 1,
        '#stone': 32,
        '#surfacestone': 24,
        '#log': 12,
        '#food': 4,
        torch: 8,
        wheat: 8,
        wheat_seeds: 3
      }
    }, opts.cfg || {})

    this.goal = null        // 当前长期目标
    this.history = []       // 干完的 / 放弃的
    this.cooldown = {}      // key -> 到期时间
    this.lastStatus = null  // 最近一次观察到的状态（算进度用）
    this._lastSurfaceAt = 0 // 上一次确认"人在露天"的时间（刚上来的约束用）
    this._savedAt = 0
    // ===== 看门狗用的两个时间戳（判据见 observe 的"卡死看门狗"一段）=====
    // 最后一次任务回报（成功/失败都算）：一趟收尾本身就是"他动过"的证据。
    this._lastTaskAt = 0
    // 上层最后一次问"现在该干什么"的时刻。will 派活之前一定会先问 current()，
    // 所以这就是"这一趟任务大概什么时候开始"的最近证据 ——
    // goals 看不到 main 的锁，只能认这个（有 ctx.taskSince() 时优先用那个）。
    this._askedAt = 0
    this.load()
  }

  // ------------------------------------------------ 存盘

  load () {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8') || '{}')
      if (d && d.version === VERSION) {
        this.goal = d.goal || null
        this.history = Array.isArray(d.history) ? d.history : []
        this.cooldown = d.cooldown && typeof d.cooldown === 'object' ? d.cooldown : {}
        // 老存盘没有 evidence：补上（不是给判据开口子，是让阶段自己先声明）
        if (this.goal && Array.isArray(this.goal.stages)) {
          for (const st of this.goal.stages) {
            if (!st.evidence) {
              const ev = evidenceForStage(st.kind, st.title)
              st.evidence = ev.evidence
              if (ev.minSec) st.minSec = ev.minSec
            }
          }
        }
      }
    } catch (e) {
      this.goal = null
      this.history = []
      this.cooldown = {}
    }
    return this
  }

  save (force) {
    // 主循环里 observe() 调得很勤，没必要每次都写盘
    if (!force && this.now() - (this._savedAt || 0) < 10000) return
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const data = {
        version: VERSION,
        goal: this.goal,
        history: this.history.slice(-30),
        cooldown: this.cooldown,
        savedAt: this.now()
      }
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8')
      fs.renameSync(tmp, this.file)   // 先写临时文件再换名，断电不至于写坏
      this._savedAt = this.now()
    } catch (e) {
      this.log('[goals] 存盘失败 ' + e.message)
    }
  }

  log (s) {
    try {
      if (this.ctx.log) this.ctx.log(s)
    } catch (e) {}
  }

  // ------------------------------------------------ 候选与打分

  /**
   * 在地下待了多久（毫秒）。没在地下就是 0。
   *
   * 【为什么时钟要从 this.now() 取】
   * 之前这里写的是 Date.now()。测试用 now: () => t 注入假时钟，
   * 但这一段绕过注入直接读真实时间 —— 于是测试里把 t 往前拨一小时，
   * "地下待了多久"永远算出 0，整段惩罚逻辑测不出来。
   */
  undergroundFor () {
    if (!this._undergroundSince) return 0
    return Math.max(0, this.now() - this._undergroundSince)
  }

  /**
   * 现在能想到哪些方向，各自多现实。
   *
   * 【2026-11-13 用户反馈】「每次见到他他都在地下，
   * 之前见到他在准备搭格子上来，过几分钟发现他又在地下挖矿。
   * 一个正常玩家会一直把自己埋在地里吗」
   *
   * 原设计错在两处：
   *   1. 挖矿类基础分太高（tier>=2 时 diamond=85、iron=80），
   *      建造类只有 50-90，于是只要手上有铁镐，几乎永远选挖矿。
   *   2. 目标本身没有终点感 —— "挖够 40 块铁""挖到钻石为止"，
   *      进去就是几十上百块，出来遥遥无期。
   *
   * 现在改成三层：
   *   基础分（反映"这事现不现实"）
   * + 在地下待久了的修正（挖矿压下去、地面活抬起来、出口目标浮上来）
   * + 品味偏好
   */
  /**
   * 他现在是不是在歇着。
   *
   * 【为什么任务调度要问心情】mood-fixer 的休息窗口实测：
   *   21:45:09 [rest] 你累垮了（精力 0%），自己停下来歇着了
   *   21:54:2x [rest] 歇够了（精力 60%），可以起来干活了
   * 可这 9 分钟里仍然启动了 5 个任务 —— 全是从 goals.current() 发出去的
   * 「备料：石头和木头攒够一堆」。嘴上说歇、状态在歇、任务照发。
   *
   * 根因在这一层：任务调度从来没问过心情。只读 mood，不改它。
   */
  isResting () {
    try {
      // ===== 【rest 死锁出口】=====
      //
      // 实测：血 7 + 饿 17 时 mood.resting 一直为真 -> 主循环每 3 秒
      // 「正在歇着，等缓过来再说」-> 不派活 -> 吃不到东西 -> 饿着不回血 ->
      // 血永远 7 -> 更 rest。正反馈锁死。
      //
      // 真人这时候不会继续躺着：命比歇着重要。血 < 8 且饿 < 18（没到能自然
      // 回血的门槛）时，rest 不生效，让主循环去弄吃的。
      // 只放这一种组合：血正常但累、或者血低但吃饱了，都照样歇。
      const s0 = this.lastStatus || {}
      const hp0 = Number(s0.health)
      const food0 = Number(s0.food)
      if (isFinite(hp0) && isFinite(food0) && hp0 < 8 && food0 < 18) {
        const now0 = this.now()
        if (!this._restOverrideAt || now0 - this._restOverrideAt > 60000) {
          this._restOverrideAt = now0
          this.log(`[goals] 血 ${hp0}、饿 ${food0}：命比歇着重要，先不歇了（去弄吃的）`)
        }
        return false
      }

      let m = this.ctx && this.ctx.mood
      // main.js 目前没往 goals.ctx 里塞 mood（那个文件不归我改）。
      // mood.js 自己导出了 active()：进程里最后构造的那个 Mood 实例，
      // 就是主循环在用的那个。只读它，不碰 mood 的任何状态。
      if (!m || (typeof m.resting !== 'boolean' && typeof m.state !== 'function')) {
        try { m = require('./mood').active() } catch (e) { m = null }
      }
      let rest = false
      if (m) rest = typeof m.resting === 'boolean' ? m.resting : (typeof m.state === 'function' && m.state() === 'tired')
      if (rest) return true

      // ===== 收工了也算"歇着" =====
      //
      // 实机（run5）：session 22:19:29 已经「今天到此为止，回去歇着」，
      // 22:23:04 goals 还在换法子派人去"收拾地面"。两个层各说各的。
      //
      // session.js 的 phase/todayDone 是权威信号，但 main.js 现在没把它
      // 传进 goals.ctx（那两处不归我改）。这里做成**只读、可缺省**：
      // 谁把 ctx.session 塞进来（或者 session 以后导出 active()），
      // 这一行就自动生效；没有就退回只看 mood。
      let se = this.ctx && this.ctx.session
      if (!se) {
        try {
          const sm = require('./session')
          se = typeof sm.active === 'function' ? sm.active() : null
        } catch (e) { se = null }
      }
      if (se) {
        if (typeof se.isTodayDone === 'function' && se.isTodayDone()) return true
        if (se.phase === 'resting' || se.phase === 'closed') return true
      }
      return false
    } catch (e) { return false }
  }

  candidates (status) {
    // 歇着的时候心里没有"接下来想干点什么" —— 空池子。
    // ensure() 会先看这个，不再产出新目标。
    if (this.isResting()) return []
    const now = this.now()
    const out = []
    const underMin = this.undergroundFor() / 60000
    const isUnder = undergroundOf(status) === true
    // actions 连续 3 次"挖不动"会打这个标记：这片地形处理不了，
    // 先往外走。explore 即使正在冷却也放它出来。
    const actRef = this.ctx && this.ctx.actions
    const forcedExplore = !!(actRef && actRef._forceExploreUntil && actRef._forceExploreUntil > now)

    for (const g of POOL) {
      const until = this.cooldown[g.key] || 0
      if (until > now && !(forcedExplore && g.key === 'explore')) continue
      let score = 0
      try { score = g.score(status) } catch (e) { score = 30 }

      // ===== 别一直待在地下 =====
      //
      // 曲线用"憋久了"的形状，不是线性扣到底：
      //   10 分钟以内   —— 不管，挖矿本来就是正事
      //   10~25 分钟    —— 稳步往下压（-5/分），压到 -75
      //   25 分钟以上   —— 压满 -110，挖矿类彻底抬不起头
      // 25 分钟这个坎是有意的：一趟正常的矿洞来回，加上找矿和躲避，
      // 15~20 分钟是合理的。超过 25 分钟说明他陷进去了（迷路、贪挖、
      // 或者在原地反复找同一片矿），这时候必须让他先出来。
      let penalty = 0
      if (g.undergroundGoal || g.key === 'underground') {
        penalty = Math.min(110, Math.max(0, (underMin - 10) * 5))
        if (underMin > 25) penalty = 110
      } else if (g.tag === '收集' && /挖|矿|钻石|铁/.test(g.title)) {
        // 兜底：以后新加的挖矿类目标就算忘了打 undergroundGoal 标记，
        // 按标题关键词也能被压下去，不至于又变成"永远在下面"。
        penalty = Math.min(110, Math.max(0, (underMin - 10) * 5))
        if (underMin > 25) penalty = 110
      }
      if (penalty > 0) score -= penalty

      // ===== 刚上来，别马上又钻回去 =====
      //
      // 【2026-11-13 16:47 home-owner 实测】
      //   16:47:39 到家了 → 16:48:39 已经到 y=60 → 16:50:09 到 y=55
      // 回家一分钟就掉头往下挖。
      //
      // 之前只有"在地下待久了才想上来"，管不住这个 —— 他确实上来了，
      // 只是上来之后立刻又挑了个挖矿的活。真人回家会先放东西、歇一下、
      // 干点别的，不会掉头就往下走。
      //
      // 判据：_lastSurfaceAt 是"最近一次确认人在露天的时刻"。
      // 刚上来 surfaceHoldMs 之内，挖矿类重罚 —— 不是不让他挖，
      // 是让他先在地面上待够，别把家当成矿井的电梯。
      const sinceSurface = this._lastSurfaceAt ? (now - this._lastSurfaceAt) : Infinity
      const justCameUp = sinceSurface < this.cfg.surfaceHoldMs
      if (justCameUp && (g.undergroundGoal || (g.tag === '收集' && /挖|矿|钻石|铁/.test(g.title)))) {
        // 刚上来时按"离上来多久"递减：刚上来扣满，快满 5 分钟就不扣了
        const k = 1 - sinceSurface / this.cfg.surfaceHoldMs
        score -= Math.round(this.cfg.surfaceHoldPenalty * clamp01(k))
      }

      // ===== 位置可行性 =====
      //
      // 上一版这里是"在地下久了就给建造类加分"，结果 house 涨到 130 ——
      // 比他在地下挖矿还高。但他在 y=14 的洞里，根本没地方盖房。
      // 加分加出了个做不到的选项，等于让他一直想着盖房、身体却困在下面。
      //
      // 正确的关系是减法：地面上的活，在地下就是**干不了**，
      // 分数该降（降完仍是正数，因为"先上去再干"是条通顺的路）。
      // 让他真上来的责任交给专门的 getup 目标。
      // 【2026-11-13 实测】`isUnderground()` 是"头顶有没有遮挡"，
      // 站在树底下 / 洞口上方也算 true。真机 23:26:56 他就是站在
      // y=68 的地面、脚边全是平地，只是头顶有树冠 —— 被判成"在地下"，
      // house 从 50 掉到 25，输给 iron 的 40，于是 30 分钟一次没选上。
      //
      // 所以分成两档：
      //   真的在地面以下（y < 地表）→ 扣 25 并封顶，那确实盖不了
      //   人在地表高度、只是头顶有遮挡 → 扣 8（挪两步的事，不是干不了）
      //
      // 【house 自己算】house.score() 现在自带同一套坐标判断（locationAware），
      // 这里必须跳过它 —— 否则树底下会被扣两遍（-8 变 -16）。
      if (!g.locationAware && !g.undergroundGoal && !g.valleyGoal && isUnder) {
        const yy = posOf(status).y
        if (yy < SURFACE_Y) {
          // 【参谋 2026-11-13】真的在地面以下：这些活（搭台/种地/探索）
          // 物理上就干不了，必须**压到 getup 之下**，否则会出现
          // "人在 y=42 的洞里，却挑了做不到的事" ——
          // 选了也做不了 → 放弃 → 冷却 → 过一阵又选它。
          //
          // 光扣 25 压不住：带材料 + 夜里能到 90+，扣完还有 65-77，
          // 比 getup 的 30 高。所以这里封顶 15（getup 地下最低 30，压得住）。
          score = Math.min(score - 25, 15)
        } else {
          // 人在地表高度、只是头顶有遮挡（树底下/洞口上方）：
          // 挪两步的事，不是干不了。
          score -= 8
        }
      }

      // 出口目标：只在地下时有分，憋得越久分越高。
      // 10 分钟开始明显抬头，15 分钟压过还活着的挖矿目标（那时挖矿剩 55-60），
      // 20 分钟封顶，谁也别想再拉他往下钻。
      if (g.valleyGoal) {
        if (!isUnder) score = 0
        else score += Math.min(80, Math.max(0, (underMin - 3) * 6))
      }

      if (forcedExplore && g.key === 'explore') score += 40
      score += this.tasteBonus(g.tag)
      out.push({
        key: g.key,
        title: g.title,
        why: g.why,
        score: Math.round(score),
        stages: g.stages.length,
        undergroundGoal: !!g.undergroundGoal,
        valleyGoal: !!g.valleyGoal
      })
    }
    out.sort((a, b) => b.score - a.score)
    // 注意：这里**不**过滤负分。
    // 负分是"现在不现实"，对上层和测试都是有意义的信息
    // （比如"人在地面上时 getup 是 0 分"）。挑不挑它是 ensure() 的事。
    return out
  }

  /** 现在最想做的是哪个方向（给上层 / 测试用） */
  bestCandidate (status) {
    const c = this.candidates(status)
    return c.length ? c[0] : null
  }

  /** 他喜欢干这类事就更想干（没有品味模块就不加分） */
  tasteBonus (tag) {
    try {
      const t = this.ctx && this.ctx.taste
      const k = t && t.data && t.data.kinds && t.data.kinds[tag]
      if (!k || !k.n) return 0
      const avg = k.sum / k.n   // -1 ~ 1
      return Math.round(avg * 12)
    } catch (e) { return 0 }
  }

  // ------------------------------------------------ 立目标

  /**
   * 保证心里有个目标。没有就现在想一个。
   * 主程序开一轮之前 await 一次；之后 current() 就是同步的。
   */
  async ensure (status) {
    if (status) this.lastStatus = status

    // ===== 歇着就不立新目标 =====
    // 手上的目标不扔（那是"还没干完的事"），但别再起新的。
    // 休息窗口里连续启动 5 个任务就是从这儿漏出去的。
    if (this.isResting()) {
      if (!this._restLogged) {
        this._restLogged = true
        this.log('[goals] 在歇着，先不立新目标')
      }
      return this.goal && !this.goal.done ? this.goal : null
    }
    this._restLogged = false

    // actions 连续 3 次砍树被地形挡住（没挖开也没挪动）：这片林子够不着。
    // 手上不管在做什么，都先放下，改去 explore（往外走）。
    try {
      const act = this.ctx && this.ctx.actions
      if (this.goal && act && act._forceExploreUntil > this.now() && this.goal.key !== 'explore') {
        this.log('[goals] 砍树连续被地形挡住，先放下手上的事，出去找别的地方')
        this.abandon('砍树连续被地形挡住，先出去找别的地方', { urgent: true })
      }
    } catch (e) {}

    // 手上已经有个没做完的，接着干
    if (this.goal && !this.goal.done) return this.goal

    // 上一个目标已经收尾了（完成时已清空，这里兜底）
    if (this.goal && this.goal.done) this.goal = null

    // 只有正分的才值得当"接下来这些天的正事"。
    // 0/负分 = 现在根本干不了（比如人在地面上却想"先爬回地面"），
    // 挑了它等于立了个立刻能"完成"的目标 —— 那正是 #9 里 3 秒寿命的来源。
    const allCands = this.candidates(status || this.lastStatus || {})
    const cands = allCands.filter(c => c.score > 0)
    if (!cands.length) {
      // 全在冷却里（或者全都被判成"现在干不了"）：
      // 先把冷却清掉再想一遍；还不行就放宽到"勉强能干的"，
      // 不能因为候选被过滤干净就卡在那儿不出目标。
      if (Object.keys(this.cooldown).length) {
        this.cooldown = {}
        return this.ensure(status)
      }
      const all = allCands
      if (!all.length) return null
      const top0 = all[0]
      const def0 = POOL.find(g => g.key === top0.key)
      this.goal = this.makeGoal({
        key: def0.key,
        title: def0.title,
        why: def0.why,
        stages: def0.stages.map(s => Object.assign({}, s))
      }, status || this.lastStatus || {})
      this.save(true)
      this.log('[goals] 眼下没什么特别想干的，先干这个：' + this.goal.title)
      return this.goal
    }

    let picked = null
    try {
      picked = await this.askModel(status || this.lastStatus || {}, cands)
    } catch (e) {
      this.log('[goals] 让他自己想的时候出错：' + e.message)
    }

    // 模型没给 / 给了个不认识的：按可行性挑最现实的那个
    if (!picked) {
      const top = cands[0]
      const def = POOL.find(g => g.key === top.key)
      picked = {
        key: def.key,
        title: def.title,
        why: def.why,
        stages: def.stages.map(s => Object.assign({}, s))
      }
      this.log('[goals] 自己定了个方向：' + picked.title + '（可行性 ' + top.score + '）')
    }

    this.goal = this.makeGoal(picked, status || this.lastStatus || {})
    this.save(true)
    this.log('[goals] 立了个长期目标：' + this.goal.title)
    return this.goal
  }

  /**
   * 问他：这几个方向里你想干哪个？也可以自己另想一个。
   * 只要 JSON，不要长篇大论。
   */
  async askModel (status, cands) {
    if (!this.llm || !this.llm.chat) return null

    const inv = Object.entries(status.inventory || {}).map(([k, v]) => cn(k) + 'x' + v).join('，') || '空的'
    const list = cands.map((c, i) => `${i + 1}. ${c.title} —— ${c.why}（现在办起来的把握：${c.score}/100）`).join('\n')
    const did = this.history.slice(-4).map(h => `- ${h.title}（${h.result === 'done' ? '干完了' : '放弃了：' + (h.reason || '')}）`).join('\n')

    const prompt = `你在自己的世界里过日子，没人给你派活。

现在的状况：
坐标 ${posOf(status).x},${posOf(status).y},${posOf(status).z}，血 ${status.health}，饿 ${status.food}，${status.time || ''}
背包：${inv}
${did ? '这些是你之前干过的：\n' + did : '你还没正经干完过什么。'}

你心里冒出过这些念头（不一定都对，也不一定都要干）：
${list}

挑一件你**真想干、而且眼下干得动**的事，当接下来这些天的正事。
可以就从上面挑一个，也可以自己另想一件 —— 只要符合你现在的本事和手里的东西。

回一个 JSON，别写别的：
{"key":"上面某个编号对应的英文 key，或者 custom","title":"一句话说清你想干什么，像人话，别超过 20 个字","why":"为什么想干这件事，一句话"}
如果 key 是 custom，再加一个 stages 数组，3 到 5 条，每条一句话，说清先干什么后干什么：
"stages":["先……","然后……","最后……"]`

    const r = await this.llm.chat([{ role: 'user', content: prompt }], { maxTokens: 320, temperature: 1.0 })
    const obj = parseJson(r && r.text)
    if (!obj || !obj.title) return null

    const title = String(obj.title).trim().replace(/^["「『]|["」』]$/g, '').slice(0, 40)
    if (!title) return null
    const why = String(obj.why || '').trim().slice(0, 60)

    // 从池子里挑的：阶段用模板（模板里的阶段是打磨过的）
    const def = POOL.find(g => g.key === obj.key)
    if (def) {
      // 刚放弃 / 刚做完的方向，模型又想起来了也不行 —— 免得反复绕回同一条死路
      if ((this.cooldown[def.key] || 0) > this.now()) return null
      return { key: def.key, title, why: why || def.why, stages: def.stages.map(s => Object.assign({}, s)) }
    }

    // 自己发明的：把他说的话变成能验收的阶段
    const raw = Array.isArray(obj.stages) ? obj.stages : []
    const stages = raw
      .map(s => (typeof s === 'string' ? { title: s } : s))
      .filter(s => s && s.title)
      .slice(0, this.cfg.maxCustomStages)
      .map(s => normalizeStage(s))
    if (!stages.length) return null

    return { key: 'custom:' + title, title, why: why || '自己想出来的事', stages }
  }

  makeGoal (picked, status) {
    const now = this.now()
    const stages = picked.stages.map(s => {
      // 【证据类型随计划走】evidence/minSec 必须从计划**原样带过来**。
      //
      // 2026-11-14 实测：这里原来只拷 key/kind/need/title，声明写在计划里、
      // 到了目标身上就没了 —— 真实目标 5/5 阶段 evidence=undefined，
      // main 的 `|| 'world'` 于是悄悄接管，duration 永远用不上。
      // 声明了却送不到判据层，比没声明更坏：看着有制度，实际全靠兜底。
      //
      // 这里**只透传、不推导**（推导就是默认分支，第五次文本后门就藏在那儿）；
      // 真没声明的阶段，judge 会在判定时抛错并写进日志。
      const stage = Object.assign({
        key: s.key || null,
        kind: s.kind || 'do',
        need: s.need || { count: 1 },
        title: s.title,
        evidence: s.evidence,
        ...(s.minSec ? { minSec: s.minSec } : {})
      })
      stage.startedAt = now
      stage.base = makeBase(stage, status)
      stage.work = 0
      stage.ratio = 0
      stage.best = 0
      stage.attempts = 0
      stage.fails = 0
      stage.doneAt = null
      // ===== #7：这一阶段在用第几种干法 =====
      // 0 = 原计划。连着几趟没进展就往后挪（见 switchMethod）。
      if (Array.isArray(s.ways) && s.ways.length) stage.ways = s.ways.slice()
      stage.methodIndex = 0
      stage.methodSince = now
      stage.idleWins = 0
      // 跨"换法子"累计的总账：换法子只清当条路的账，不清总账
      stage.idleTotal = 0
      stage.failTotal = 0
      stage.parked = false    // 几条路都试过、目标还在冷却期时置 true（见 PARK_TEXTS）
      return stage
    })
    const p0 = posOf(status)
    // 卡死看门狗：从这一刻开始记"最后一次真的动了"
    this._watchPos = p0
    this._watchMoveAt = now
    return {
      key: picked.key,
      title: picked.title,
      why: picked.why || '',
      createdAt: now,
      // ===== 立目标那一刻他在哪 =====
      //
      // 【参谋要的判据】"看 house 被选中时的 y 坐标。如果绝大多数 < 50，
      // 就是排序 bug"。原来的 history 不记位置，事后只能靠日志猜。
      // 现在选中时记下来，放弃/收工时一并写进 history。
      createdY: Math.round(p0.y),
      createdUnderground: undergroundOf(status),
      updatedAt: now,
      stageIndex: 0,
      stages,
      attempts: 0,
      fails: 0,
      lastProgressAt: now,
      journal: [{ at: now, text: '定了这件事：' + picked.title }],
      done: false
    }
  }

  // ------------------------------------------------ 现在该干什么

  /**
   * 内部用：手上正在办的那一步。
   *
   * 注意这是**命令式**的旧入口，只给 goals 自己的记账逻辑用
   * （进度、换法子、放弃）。对外要说"能干点什么"用 stage()。
   */
  currentStage () {
    if (!this.goal) return null
    return this.goal.stages[this.goal.stageIndex] || null
  }

  /**
   * ===== 声明式的"能干些什么"：候选池，不下命令 =====
   *
   * 【为什么改成这样】
   * 之前 stage() 直接返回"下一步做 X" —— 它是指挥官，session 只能照做。
   * 于是"他心里想干什么"永远是 goals 一个人说了算，
   * 而 goals 又只认自己刚 shuffle 出来的那一步。
   *
   * 现在它只**陈述事实**：
   *   · 这件事叫什么、要什么（need）
   *   · 现在能不能干（prereqs：差什么，差多少）
   *   · 上次干到哪了（progress：ratio / 试了几趟 / 换过几个法子 / 是不是搁着了）
   *   · 可以怎么干（ways）
   * 排哪个、干不干，留给 session（"今天的主意"）。
   *
   * 返回数组，顺序就是目标里的阶段顺序 —— **不代表优先级**。
   * 没有目标时返回空数组。
   */
  stage () {
    if (!this.goal) return []
    const st = this.lastStatus || {}
    return this.goal.stages.map((s, i) => this.describeStage(s, i, st))
  }

  /** 把一步阶段说成一条"声明"，不排序、不挑、不催 */
  describeStage (s, i, status) {
    const idx = this.goal ? this.goal.stageIndex : 0
    const state = i < idx ? 'done' : (i === idx ? 'current' : 'later')
    const need = s.need || {}
    const inv = (status && status.inventory) || {}
    const baseInv = (s.base && s.base.inv) || {}
    const prereqs = []

    // 前置 1：前面那一步
    if (i > 0) {
      const prev = this.goal.stages[i - 1]
      prereqs.push({ what: '上一步', text: `先干完「${prev.title}」`, ok: i <= idx })
    }

    // 前置 2：要的东西现在有多少
    //   current 这一步按**增量**算（base 之后新弄到的才算）
    //   后面的步骤还没开工，只能报"现在手上有多少"（参考值）
    for (const [k, v] of Object.entries(need)) {
      if (k === 'count' || k === 'item' || k === 'n' || k === 'y' || k === 'distance') continue
      const want = Number(v) || 0
      const have = itemCount(inv, k) - (state === 'current' ? itemCount(baseInv, k) : 0)
      prereqs.push({ what: cn(k), text: `${cn(k)} ${Math.max(0, Math.min(have, want))}/${want}`, ok: have >= want })
    }
    if (need.item) {
      const want = Number(need.n) || 1
      const have = itemCount(inv, need.item) - (state === 'current' ? itemCount(baseInv, need.item) : 0)
      prereqs.push({ what: cn(need.item), text: `${cn(need.item)} ${Math.max(0, Math.min(have, want))}/${want}`, ok: have >= want })
    }

    // 前置 3：位置
    if (need.y != null) {
      const y = Math.round(posOf(status).y)
      if (s.kind === 'surface') prereqs.push({ what: '位置', text: `现在 y=${y}，人得在 y≥${need.y}（露天更好）`, ok: y >= Number(need.y) })
      else if (s.kind === 'depth') prereqs.push({ what: '位置', text: `现在 y=${y}，得下到 y≤${need.y}`, ok: y <= Number(need.y) })
    }

    // 上次进展（只对正在办的那一步有意义）
    let progress = null
    if (state === 'current') {
      let p = { ratio: s.ratio || 0, text: s.progressText || '' }
      try { p = stageProgress(s, status) } catch (e) {}
      progress = {
        ratio: p.ratio,
        text: p.text,
        at: this.goal.lastProgressAt || s.startedAt || null,
        attempts: s.attempts || 0,
        idleWins: s.idleWins || 0,
        methodIndex: s.methodIndex || 0,
        parked: !!s.parked
      }
    } else if (state === 'done') {
      progress = { ratio: 1, text: '这一步过去了', at: s.doneAt || null, attempts: s.attempts || 0, idleWins: 0, methodIndex: s.methodIndex || 0, parked: false }
    }

    return {
      goal: this.goal.title,
      goalKey: this.goal.key,
      index: i,
      count: this.goal.stages.length,
      title: s.title,
      kind: s.kind || 'do',
      need,
      state,
      ready: prereqs.every(r => r.ok),
      blockedBy: prereqs.filter(r => !r.ok).map(r => r.text),
      prereqs,
      progress,
      // 可以怎么干（第一条是原计划）。只是选项，不是指令。
      ways: waysForStage(s).map((w, wi) => ({ way: w, used: wi < (s.methodIndex || 0), current: wi === (s.methodIndex || 0) }))
    }
  }

  /**
   * 现在该做的那一步。同步返回，will.js 可以直接用。
   * 没有目标或者目标做完了 -> null
   *
   * 返回的字段跟 will 的 current 对齐：{ text, since, done }
   * 另外带上 goal / stageIndex / total，方便上层显示进度。
   */
  current () {
    // 歇着的时候不发活。will 优先用 goals.current()，
    // 这里不回 null 而是回一句"歇着" —— 回 null 会掉进 will 的兜底模板
    // （"弄点木头，先做把镐"），那还是活。
    if (this.isResting()) {
      return {
        text: '先歇着，什么都不干（精力还没回来）',
        since: (this.goal && this.goal.createdAt) || this.now(),
        done: false,
        resting: true,
        fromGoal: false,
        goal: this.goal ? this.goal.title : null
      }
    }
    if (!this.goal || this.goal.done) return null
    const s = this.currentStage()
    if (!s) return null
    const ways = waysForStage(s)
    const mi = Math.max(0, Math.min(s.methodIndex || 0, ways.length - 1))
    const method = mi > 0 ? ways[mi] : null
    // 搁起来了：说"干点别的"，别再念那条已经试过三遍的任务。
    const park = s.parked ? PARK_TEXTS[(s.attempts || 0) % PARK_TEXTS.length] : null
    // 上层马上会拿这句话去派活（main 拿到 will.think() 的结果就 acquire task 锁，
    // 日志里紧接着就是 `>>> 开始`）。记下来，看门狗才知道"这一趟"什么时候起的。
    this._askedAt = this.now()
    return {
      // 【#7】换过法子之后，交给上层的是"换个法子怎么干"，
      // 不是把同一句话原样再说一遍 —— will 拿它去派活，
      // 文本变了，动作才会真的变。
      text: park || (method ? `${s.title}（换个法子：${method}）` : s.title),
      since: park ? this.now() : (s.methodSince || s.startedAt || this.goal.createdAt),
      done: false,
      goal: this.goal.title,
      why: this.goal.why,
      stage: s.title,
      method,
      parked: !!s.parked,
      methodIndex: mi,
      stageIndex: this.goal.stageIndex,
      total: this.goal.stages.length,
      progress: s.ratio || 0,
      fromGoal: true
    }
  }

  /** 只取一句话 */
  currentText () {
    const c = this.current()
    return c ? c.text : null
  }

  /** 这一步现在的进度，说人话 */
  progressText () {
    if (!this.goal) return ''
    const s = this.currentStage()
    if (!s) return ''
    const p = stageProgress(s, this.lastStatus || {})
    return p.text
  }

  /** 塞进提示词的一段话 */
  promptBlock () {
    if (this.isResting()) return '## 你现在的状态\n累得不行，坐着歇会儿。手上那件事不急，等缓过来再说。'
    if (!this.goal) return ''
    const s = this.currentStage()
    if (!s) return ''
    const idx = this.goal.stageIndex + 1
    const lines = [
      '## 你心里挂着的一件事',
      `目标：${this.goal.title}${this.goal.why ? '（' + this.goal.why + '）' : ''}`,
      `进度：第 ${idx}/${this.goal.stages.length} 步 —— ${s.title}`,
      // 【#7】换过法子就明说"上次那样不行，这次这么干"，
      // 不然模型会照着同一句话再编一遍同样的动作。
      (() => {
        if (s.parked) return '这一步几条路都试过了，先放一放：在附近转转、收拾收拾，别硬来。'
        const ways = waysForStage(s)
        const mi = s.methodIndex || 0
        if (mi <= 0 || !ways[mi]) return ''
        return `换了法子：${ways[mi]}（之前那样弄了 ${this.cfg.methodSwitchWins} 遍没往前挪，别重复）`
      })(),
      // 去哪找：没有这句他会挑"最近的那块" —— 而最近的石头可能在地下，
      // 他下不去（实测 [goto] 高度到不了 连刷 6 次）。
      s.where ? `去哪弄：${s.where}` : '',
      this.progressText() ? `这一步到现在：${this.progressText()}` : '',
      // 今天份：让他知道"干到这就够了，不用一口气挖到底"。
      // 用户的原话是"一个正常玩家会一直把自己埋在地里吗" ——
      // 一部分原因是他不知道什么时候算干完，就一直挖下去。
      (() => { const q = this.dailyQuota(this.lastStatus); return q.text ? `今天份：${q.text}${q.reached ? '（够了，可以收手上去了）' : ''}` : '' })(),
      // 位置：在地下待久了提醒他，别不知不觉埋自己三小时
      (() => {
        const m = Math.round(this.undergroundFor() / 60000)
        if (m >= 25) return `注意：你已经在下面待了 ${m} 分钟了，该上去透口气。`
        if (m >= 10) return `你在下面待了 ${m} 分钟。挖完这一份就上去，别贪。`
        return ''
      })(),
      '这件事不是今天干完的，是一天天攒出来的。能干就往前推一点，别每次从零想。'
    ].filter(Boolean)
    return lines.join('\n')
  }

  // ------------------------------------------------ 看门狗用的外部信号

  /**
   * 上层到底忙不忙。
   *
   * goals 拿不到 main 的锁，能问就问一声（ctx.busy 是可选的接线）；
   * 问不到返回 null —— 表示"不知道"，**不等于空闲**。
   */
  _busyNow () {
    try {
      const c = this.ctx || {}
      if (typeof c.busy === 'function') return !!c.busy()
    } catch (e) {}
    return null
  }

  /**
   * 这一趟任务是什么时候开始的。
   *
   * 优先问上层（ctx.taskSince()，可选接线）；
   * 没有就退回"最近一次被问『现在该干什么』"的时刻 —— will 派活之前一定先问
   * current()，所以它跟日志里那条 `>>> 开始` 基本是同一秒。
   * 两个都没有就是 0，判据里不占位置。
   */
  _taskSince () {
    try {
      const c = this.ctx || {}
      if (typeof c.taskSince === 'function') {
        const v = Number(c.taskSince())
        if (isFinite(v) && v > 0) return v
      }
    } catch (e) {}
    return this._askedAt || 0
  }

  // ------------------------------------------------ 过一步

  /**
   * 这一阶段够了 -> 往前走一步（observe 和 onTaskResult 共用这一套动作）。
   *
   * 【为什么必须两条路都走这里 · 2026-11-14 03:20 现场】
   *   03:20:16 <<< 完成（阶段其实已经够了）
   *   03:20:43 >>> 开始：先弄一小堆…   ← 同一阶段又立了一遍
   * 因为结算只在 observe() 里做，而 main 把 observe 节流成 30 秒一次：
   * 中间这 27 秒里 will 一 ask，拿到的还是同一个没结算的阶段。
   * 现在任务一收尾就结算，不用等下一轮观察。
   *
   * trivial（本来就不用做）跳过，但**不记成他做到了** ——
   * goals.json 里不留零动作完成的阶段。
   */
  _advanceStage (s, p, status) {
    const isLast = this.goal.stageIndex >= this.goal.stages.length - 1
    if (p && p.trivial) {
      this.log(`[goals] 跳过「${s.title}」：${p.text}`)
      this.journal(`「${s.title}」本来就不用做，跳过`)
      if (isLast) {
        this.completeGoal()
        return { stageCompleted: true, goalCompleted: true, ratio: 1, abandoned: false, trivial: true }
      }
      this.goal.stageIndex++
      const nextS = this.currentStage()
      if (nextS) {
        try { nextS.base = makeBase(nextS, status) } catch (e) {}
        nextS.startedAt = this.now()
      }
      this.save(true)
      return { stageCompleted: true, goalCompleted: false, ratio: 1, abandoned: false, trivial: true }
    }
    s.doneAt = this.now()
    this.journal(`搞定了「${s.title}」`)
    if (isLast) {
      this.completeGoal()
      return { stageCompleted: true, goalCompleted: true, ratio: 1, abandoned: false }
    }
    this.goal.stageIndex++
    const ns = this.currentStage()
    if (ns) {
      try { ns.base = makeBase(ns, status) } catch (e) {}
      ns.startedAt = this.now()
    }
    this.journal(ns ? `接下来：${ns.title}` : '')
    this.save(true)
    this.log(`[goals] 过了一步：「${s.title}」→ 下一步「${ns ? ns.title : '完了'}」`)
    return { stageCompleted: true, goalCompleted: false, ratio: 1, abandoned: false }
  }

  /**
   * 任务收尾时用的"这一阶段真的够了吗"。
   *
   * 跟 stageProgress 只差一处：gather 的某一项如果**立这一步的时候背包里就够了**
   * （base.inv 已经 >= 需求），不再要求"再攒一批"。
   *
   * 【为什么必须留这个口子 · 2026-11-14 03:20 现场】
   *   阶段要 {石头 8, 木头 6}，立起来时背包里已经有 22 根原木
   *   -> 任务按绝对存量判「这一小堆够了」，硬判据是石头 +8（唯一真缺的那样）
   *   -> goals 按增量判 8/14 = 57%，阶段不过
   *   -> will 27 秒后又立一遍同一个阶段，背包当然不涨，10 秒失败
   * 任务兑现的就是"还缺的那部分"，这边就得认账。
   *
   * 这不是放水：真的缺的每一项仍然要拿够增量（"存量不算"那条口径没动，
   * 见 test-goals 里"开局 130 块圆石也不算攒够"）。全都在背包里的阶段
   * 依旧是 0 进度，绝不白送。
   */
  _stageMet (s, status) {
    const p = stageProgress(s, status)
    if (p.trivial || p.ratio >= 1 - 1e-9) return p
    if (s.kind !== 'gather') return p
    const need = s.need || {}
    const keys = Object.keys(need).filter(k => (Number(need[k]) || 0) > 0)
    if (!keys.length) return p
    const inv = (status && status.inventory) || {}
    const baseInv = (s.base && s.base.inv) || {}
    for (const k of keys) {
      const want = Number(need[k]) || 0
      if (Math.max(0, itemCount(baseInv, k)) >= want) continue // 立这一步时就有了
      if (peakHave(s, inv, k) >= want) continue               // 这一阶段真攒到了
      return p                                                // 还缺 -> 没够
    }
    return { ratio: 1, text: p.text + '（手上已有的那几样不用再攒）' }
  }

  // ------------------------------------------------ 记进度
  /**
   * 扫一眼状态，更新进度。主循环里隔一会儿调一次就行。
   * 返回 { stageCompleted, goalCompleted, ratio, abandoned }
   */
  observe (status) {
    if (status) this.lastStatus = status

    // ===== 记录"在地下待了多久" =====
    // 用于 candidates() 里给挖矿类目标打折 —— 人不会一直埋在地里。
    // 【重要】原来这里读的是 status.underground，但 actions.status() 根本没这个字段
    // （它只返回 pos/health/food/time/dimension/weather/held/inventory）。
    // 于是 ug 永远是 undefined，_undergroundSince 永远不被设置，
    // candidates() 里那套"在地下待久了扣分"从来没执行过 —— 死代码。
    //
    // 现在用 undergroundOf()：优先信调用方明确给的布尔值
    // （上层如果以后接了 actions.isUnderground()，那就是最准的），
    // 没给就按坐标 y 推（SURFACE_Y 以下算地下）。
    try {
      const ug = undergroundOf(status)
      if (ug === true) {
        if (!this._undergroundSince) this._undergroundSince = this.now()
        // 一下去就把"刚上来"的计时清掉 —— 他已经在下面了，这条约束不适用
        this._lastSurfaceAt = 0
      } else if (ug === false) {
        this._undergroundSince = 0
        // 记下"刚在露天待过"的时刻。
        // 每次观察都刷新 —— 只要他还在地面上，这个时间就一直是"刚刚"。
        this._lastSurfaceAt = this.now()
      }
      // ug === null（看不清坐标）不重置，保守
    } catch (e) {}

    if (!this.goal || this.goal.done || !status) {
      return { stageCompleted: false, goalCompleted: false, ratio: 0, abandoned: false }
    }
    const s = this.currentStage()
    if (!s) return { stageCompleted: false, goalCompleted: false, ratio: 0, abandoned: false }

    // ===== 生命危险除外（#9 的例外条款，现在真的存在了）=====
    //
    // 血见底的时候什么长期目标都得先放下 —— 否则 will 还会拿
    // 「捡够垫脚的石头」去派活，人就死在四格血上。
    // 这是 minLifeMs 闸门的唯一例外，跟文档里写的一致。
    const hp = Number(status.health)
    if (isFinite(hp) && hp <= 4) {
      const rec = this.abandon(`血只剩 ${hp} 格，保命要紧，这事先放下`, { urgent: true })
      if (rec) return { stageCompleted: false, goalCompleted: false, ratio: s.ratio || 0, abandoned: true, urgent: true }
    }

    // ===== 卡死看门狗 =====
    //
    // 【实测 · 2026-11-14 01:37】树在石头后面：要挖穿才能过去 -> 没镐挖不动
    // -> 到不了树 -> 没木头 -> 做不出镐。chopTree 在 DEADLINE 里空转，
    // busy 一直是 true，70 秒只有心跳、没有一条 [act] 日志。
    // 用户看到的就是"站着不动"。
    //
    // ===== 【实测 · 2026-11-14 03:20 —— 这次是误判】=====
    //
    //   03:20:16 <<< 完成（上一趟收尾）
    //   03:20:43 >>> 开始：先弄一小堆…（中间 27 秒是发会儿呆，上层故意的 idle）
    //   03:20:53 <<< 失败（这一趟只跑了 10 秒；跑的是缓存技能，没有一条 [act] 日志）
    //   03:20:53 [goals] 卡死：37 秒没有任何动作   ← 把"任务正在跑"数成了"没动作"
    //
    // 病根：判据只认 [act] 日志和位移，两头都不认"任务边界"。
    // 一次观察的窗口横跨「上一趟收尾 → 发呆 → 下一趟起跑」，
    // 中间的 idle 和这一趟刚起的 10 秒，全被算成了安静。
    //
    // 所以判据取这几样里**最大的那个**：
    //   · 最后一次 >0.5 格位移
    //   · 最后一条 [act] 日志（_lastLogAt）
    //   · 这一阶段开始（阶段边界）
    //   · 最后一次任务回报（收尾本身就是"他动过"的铁证）
    //   · 这一趟任务的开始时间（见 _taskSince()）
    // 另外：任务在跑、又拿不到"这一趟什么时候开始"时，不判 ——
    // 那种情况由上层 main 的 [stall] 一分钟检查（任务级、会打断）说了算。
    // 证据是 duration 的阶段（守着/站一会儿）除外 —— 那本来就不该动。
    try {
      const pNow = posOf(status)
      if (!this._watchPos ||
          Math.hypot(pNow.x - this._watchPos.x, pNow.z - this._watchPos.z) > 0.5) {
        this._watchPos = pNow
        this._watchMoveAt = this.now()
      }
      const act = this.ctx && this.ctx.actions
      const lastAct = act && Number(act._lastLogAt) ? Number(act._lastLogAt) : 0
      const threshold = this.cfg.stuckActionMs || 30000
      const busyNow = this._busyNow()
      const taskSince = this._taskSince()
      const last = Math.max(
        this._watchMoveAt || 0,
        lastAct,
        s.startedAt || this.goal.createdAt || 0,
        this._lastTaskAt || 0,
        taskSince
      )
      const quiet = this.now() - last
      const watchable = s.evidence !== 'duration'
      // 只知道"在忙"、不知道这一趟何时开始：判据不成立，别抢上层的 [stall]
      const blindWhileBusy = busyNow === true && !taskSince
      if (watchable && !blindWhileBusy && quiet > threshold && !this.isResting()) {
        const reason = `卡死：${Math.round(quiet / 1000)} 秒没有任何动作，先放下`
        this.log('[goals] ' + reason)
        this.journal(reason)
        // 同时打断正在跑的任务，否则它会继续占着 task 锁
        try { if (act) act.cancel = true } catch (e) {}
        const rec = this.abandon(reason, { urgent: true })
        return { stageCompleted: false, goalCompleted: false, ratio: s.ratio || 0, abandoned: !!rec, stuck: true }
      }
    } catch (e) {}

    const p = stageProgress(s, status)
    const before = s.best || 0
    s.ratio = p.ratio
    s.progressText = p.text
    if (p.ratio > before + 0.01) {
      s.best = p.ratio
      // 搁着的时候事情自己有了进展（背包里多了、位置对了）：接着干
      if (s.parked) {
        s.parked = false
        s._holdLogged = false
        s.methodIndex = 0
        s.idleWins = 0
        this.log(`[goals] 「${s.title}」又有进展了，接着弄`)
      }
      this.goal.lastProgressAt = this.now()
      this.goal.updatedAt = this.now()
    }

    // ===== 【层3】"本来就不用做"的阶段：跳过，不算他做到 =====
    //
    // 回地面上、往回走到目标高度这类阶段，如果立起来的时候人已经在那儿，
    // 那就是没走过。直接跳过去，但**不记"搞定了"** —— 不然
    // goals.json 里又会多一条零动作完成的阶段。
    if (p.trivial) return this._advanceStage(s, p, status)

    if (p.ratio >= 1 - 1e-9) return this._advanceStage(s, p, status)

    // 太久没动静：这事可能干不成，或者他不想干了
    const idle = this.now() - (this.goal.lastProgressAt || this.goal.createdAt)
    if (idle > this.cfg.stallMs) {
      // 歇着的时候不判"这事儿干不成" —— 人只是睡了，不是放弃了。
      if (this.isResting()) {
        return { stageCompleted: false, goalCompleted: false, ratio: p.ratio, abandoned: false, resting: true }
      }
      const mins = Math.round(idle / 60000)
      const rec = this.abandon(`「${s.title}」卡了 ${mins} 分钟没往前挪，先算了`)
      return { stageCompleted: false, goalCompleted: false, ratio: p.ratio, abandoned: !!rec }
    }

    this.save()
    return { stageCompleted: false, goalCompleted: false, ratio: p.ratio, abandoned: false }
  }

  /**
   * 干完一件事之后回报结果。
   * 主程序在任务结束（成功/失败）时调一次，长期目标才知道"刚才那一下算不算数"。
   */
  onTaskResult ({ ok, text, status, progress } = {}) {
    if (status) this.lastStatus = status
    // 一趟任务收尾了。这是看门狗判据里的"他刚动过" ——
    // 不记这一笔，紧接着的观察会拿"阶段开始到现在"去算安静，
    // 把"刚跑完的一趟"算成"37 秒没动作"（2026-11-14 03:20 的误判）。
    this._lastTaskAt = this.now()
    if (!this.goal || this.goal.done) return { advanced: false }
    const s = this.currentStage()
    if (!s) return { advanced: false }

    s.attempts = (s.attempts || 0) + 1
    this.goal.attempts++

    // ===== 歇着的时候只记账，不改主意 =====
    //
    // 实机 run6：22:55:32 收工 → 22:55:43 在休息窗口里打了一条「换法子」。
    // 那不是新派的活，是休息开始前就在跑的任务刚回报完 —— 但换法子
    // 会改掉"下次说什么、干什么"，等于把休息窗口偷走了一步。
    // 这会儿只记结果（哪趟成没成），等醒过来再用。
    if (this.isResting()) {
      // 账照记（哪趟成没成、进度动没动），只是不做"换法子/换目标"的决定。
      if (!ok) {
        s.fails = (s.fails || 0) + 1
        s.failTotal = (s.failTotal || 0) + 1
        this.goal.fails++
      } else if (status) {
        const p0 = stageProgress(s, status)
        if (p0.ratio <= (s.best || 0) + 1e-9) {
          s.idleWins = (s.idleWins || 0) + 1
          s.idleTotal = (s.idleTotal || 0) + 1
        } else {
          s.idleWins = 0
          s.idleTotal = 0
          this.goal.lastProgressAt = this.now()
        }
      }
      this.journal(`歇着的时候手头那件事收了尾：${ok ? '成了' : '没成'}`)
      this.save(true)
      return { advanced: false, resting: true, deferred: true }
    }

    if (ok) {
      // 他自己的动作算"这一步往前推了一点"。
      //
      // ===== 【层3 修】别再白送 =====
      //
      // 原来是 `this.addWork(progress || 1)`，而 kind=do/build 的阶段
      // need 基本是 {count:1} —— 也就是**任何 do/build 阶段，
      // 上层一次"完成"就无条件过**。上层那个"完成"以前又是看话术的
      // （"铁锭0"也算完成），所以整条链一起白给。
      //
      // 现在 progress 由 main.verifyTaskEffect() 按硬证据算出来
      // （目标产物增量 / 背包净变化 / 周围方块变化 / 位移），
      // 没有证据就是 0，这里拒绝推进，只记一次"空跑"。
      if (s.kind === 'do' || s.kind === 'build') {
        const real = Number(progress)
        if (Number.isFinite(real) && real > 0) {
          const cap = Math.max(1, Number((s.need && s.need.count) || 1))
          this.addWork(Math.min(real, cap))
        } else {
          s.noProof = (s.noProof || 0) + 1
          if (s.noProof === 1 || s.noProof % 3 === 0) {
            this.journal(`「${s.title}」报了完成，但世界没变，这次不算数`)
            this.log(`[goals] 拒绝白送：「${s.title}」拿不出硬证据（第 ${s.noProof} 次）`)
          }
        }
      }
      s.fails = 0

      // ===== 【判据连接】这一趟成了、阶段按硬证据也够了 -> 当场过下一步 =====
      //
      // 别的结算都可以等下一轮 observe()，但 main 把 observe 节流成 30 秒一次。
      // "够了"这件事这一秒就知道，再等那 27 秒，will 就会把同一阶段重立一遍
      // （2026-11-14 03:20 现场：完成 -> 27 秒后又「先弄一小堆」）。
      if (status) {
        const pDone = this._stageMet(s, status)
        if (pDone.trivial || pDone.ratio >= 1 - 1e-9) {
          const adv = this._advanceStage(s, pDone, status)
          adv.advanced = true
          return adv
        }
      }

      // ===== 防空转：说"成了"但进度一点没动 =====
      //
      // 实测：目标「开一小块地」第 2 步要 6 个种子，他手上只有 1 个。
      // will 给的任务是「找点种子」，模型每次都答"身上已有 1 个小麦种子"，
      // judgeOutcome 判成功 -> 这里 s.fails 归零 -> 阶段永远推不动。
      // 结果：40 秒内同一个任务跑了 37 次，什么都没干。
      //
      // ===== 【UNHUMAN-SCAN #7】两遍没动就换法子，别把同一句话念五遍 =====
      //
      // 实测数据（data/runtime/goals.json，最近 30 条）：
      //   「做把锄头」干了 5 趟都说成了，进度一点没动
      //   「在附近地上捡够垫脚的石头」干了 5 趟……
      // 8 个方向一样，都是同一个阶段原样跑 5 遍，然后整个目标被扔掉。
      //
      // 现在分两步走：
      //   连着 methodSwitchWins(=2) 趟没进展 -> 换法子，目标不动
      //   换到 maxMethods(=3) 条路都试完   -> 才算这阶段真没戏
      // 换法子会写一条日志，说明"换什么、为什么换"，
      // 也会进 journal，事后看得出他试过哪几条路。
      const before = s.best || 0
      if (status) {
        const p0 = stageProgress(s, status)
        if (p0.ratio <= before + 1e-9) {
          // 已经"搁起来了"：别再数趟数，只等最低寿命那道闸到点。
          // （不然 counter 会一直涨，日志里变成"干了 184 趟"。）
          if (s.parked) {
            const rec = this.abandon(`「${s.title}」几条路都试过了，先放下`)
            return rec ? { advanced: false, abandoned: true } : { advanced: false, parked: true }
          }

          s.idleWins = (s.idleWins || 0) + 1
          s.idleTotal = (s.idleTotal || 0) + 1

          // 总账到 3：这一阶段反复"说成了没进展"，换目标。
          // （跟 maxFails=3 同一个刻度：换法子两次 + 第三次还不行。）
          if ((s.idleTotal || 0) >= (this.cfg.maxIdleTotal || 3)) {
            const rec = this.abandon(`「${s.title}」${s.idleTotal} 趟说成了进度没动（中间换过 ${s.methodIndex || 0} 个法子）`)
            if (rec) return { advanced: false, abandoned: true }
            // 还没到最低寿命：先搁着（current() 会给"干点别的"）
            if (!s.parked) {
              s.parked = true
              s.parkAt = this.now()
              this.journal('几条路都试过、趟数也够了，先放一放')
              this.save(true)
            }
            return { advanced: false, parked: true }
          }

          // 兜底：#9 那条"同一个阶段空转到 12 趟就认账"保留着。
          if (s.idleWins >= (this.cfg.maxIdleWins || 5)) {
            const rec = this.abandon(`「${s.title}」干了 ${s.idleWins} 趟都说成了，进度一点没动，八成是弄不到`)
            return rec ? { advanced: false, abandoned: true } : { advanced: false, held: true }
          }

          if (s.idleWins >= (this.cfg.methodSwitchWins || 2)) {
            const why = `连着 ${s.idleWins} 趟都说成了，进度一点没动`
            const sw = this.switchMethod(s, why)
            if (sw.switched) return { advanced: false, switched: true, method: sw.text }
            // 几条路都试过了 —— 这一步确实干不成，走放弃（还要过最低寿命那道闸）
            const reason = `「${s.title}」换了 ${(s.methodIndex || 0)} 个法子都不行（${why}）`
            // 先试放弃；被 5 分钟闸门挡住就"搁起来"：闸门会自己写一条
            // 「先不换：才立了 X 分钟」，这里不重复，只把状态换掉 ——
            // 接下来 current() 给的是"干点别的"。
            const rec = this.abandon(reason)
            if (rec) return { advanced: false, abandoned: true }
            if (!s.parked) {
              s.parked = true
              s.parkAt = this.now()
              this.journal(`这几条路都不行，先放一放，回头再想`)
              this.save(true)
            }
            return { advanced: false, parked: true }
          }
        } else {
          s.idleWins = 0
          s.idleTotal = 0
          // 真往前挪了：不用搁着了，法子从头再试
          if (s.parked) {
            s.parked = false
            s._holdLogged = false
            s.methodIndex = 0
            this.log(`[goals] 「${s.title}」又有进展了，接着弄`)
          }
          this.goal.lastProgressAt = this.now()
        }
      } else {
        this.goal.lastProgressAt = this.now()
      }
    } else {
      s.fails = (s.fails || 0) + 1
      s.failTotal = (s.failTotal || 0) + 1
      this.goal.fails++
      this.journal(`这趟没成：${text || '不知道为啥'}`)

      // 搁着的时候还失败：只等最低寿命到点，别再数遍数
      if (s.parked) {
        const rec = this.abandon(`「${s.title}」几条路都试过了，先放下`)
        return rec ? { advanced: false, abandoned: true } : { advanced: false, parked: true }
      }

      // ===== 口径：2 次失败换法子，3 次失败换目标 =====
      // 实测日志里同一个任务连着 3 遍「先弄把石镐」原样重发，
      // 每遍都失败、但每次都说"再来一次"。真人第二遍就知道这样不行。
      //
      // failTotal 是跨"换法子"累计的 —— 换法子只清当条路的账（s.fails），
      // 不清总账。所以：第 1、2 次失败在同一条路上，第 3 次失败时
      // 哪怕已经换了法子，也照样算"这个阶段不行了"。
      if ((s.failTotal || 0) >= (this.cfg.maxFails || 3)) {
        const reason = `「${s.title}」试了 ${s.failTotal} 次都不行（中间换过 ${s.methodIndex || 0} 个法子）`
        const rec = this.abandon(reason)
        if (rec) return { advanced: false, abandoned: true }
        if (!s.parked) {
          s.parked = true
          s.parkAt = this.now()
          this.journal('这条路试到头了，先放一放，回头再想')
          this.save(true)
        }
        return { advanced: false, parked: true }
      }

      if (s.fails >= (this.cfg.methodSwitchFails || 2)) {
        const sw = this.switchMethod(s, `连着 ${s.fails} 遍都没成`)
        if (sw.switched) return { advanced: false, switched: true, method: sw.text }
        // 几条路都试完了：这时才认这一步干不成（还要过最低寿命那道闸）
        const reason = `「${s.title}」换了几条路都不行（连着几次都没成）`
        const rec = this.abandon(reason)
        if (rec) return { advanced: false, abandoned: true }
        if (!s.parked) {
          s.parked = true
          s.parkAt = this.now()
          this.journal('这几条路都不行，先放一放，回头再想')
          this.save(true)
        }
        return { advanced: false, parked: true }
      }
    }

    // 同一件事反复干不成，别死磕（法子都换完之后的兜底）
    if (s.fails >= this.cfg.maxFails) {
      const rec = this.abandon(`「${s.title}」试了 ${s.fails} 次都不行，换条路`)
      return rec ? { advanced: false, abandoned: true } : { advanced: false, held: true }
    }

    const res = status ? this.observe(status) : { stageCompleted: false, goalCompleted: false }
    this.save(true)
    return res
  }

  // ------------------------------------------------ 今天份

  /**
   * 「今天这一份干完了没有」。
   *
   * 用户的原话是「有没有『今天挖一点，明天接着』这种短期目标」。
   * 这一步就是那个东西 —— 它不改变长期目标，只是给每一趟划个终点：
   * 今天挖够 8 块粗铁就该上去了，剩下的明天再说。
   *
   * 返回 { reached, text }
   *   reached = true  -> 这一趟的额度够了，可以收工上去
   */
  dailyQuota (status) {
    const s = this.currentStage()
    if (!s || !status) return { reached: false, text: '' }

    // 只有"攒东西"类阶段有额度概念。do/build 那种是一次性的，不存在分批。
    if (s.kind !== 'gather' && s.kind !== 'craft') return { reached: false, text: '' }

    const inv = (status.inventory || {})
    const base = (s.base && s.base.inv) || {}
    const need = s.need || {}
    const keys = s.kind === 'craft' ? [need.item] : Object.keys(need)
    if (!keys.length || !keys[0]) return { reached: false, text: '' }

    const parts = []
    let allReached = true
    // gather 用峰值口径（跟 stageProgress 一致）：他边挖边用的时候，
    // 当前净增量会变小，但"今天挖到多少"不该因此倒退。
    if (s.kind === 'gather') trackPeak(s, inv, keys)
    for (const k of keys) {
      const wantTotal = Number(s.kind === 'craft' ? (need.n || 1) : need[k]) || 0
      const have = s.kind === 'gather'
        ? peakHave(s, inv, k)
        : Math.max(0, itemCount(inv, k) - itemCount(base, k))
      const capRaw = this.cfg.dailyCap[k]
      const remain = Math.max(0, wantTotal - have)
      if (remain === 0) {
        // 这一项整个阶段的目标已经攒满了，今天份自然算完成
        parts.push(`${cn(k)} 够了`)
        continue
      }
      // 【2026-11-13 实测 bug】原来是 cap = min(remain, 今天份)，
      // 再用 have >= cap 判"今天份完成"—— 两个口径混了：
      //   want=6、have=4 → remain=2 → cap=2 → have(4) >= 2 → 判"够了"，
      //   于是 23:49:31 在 4/6 木头的时侯就喊"今天这一份够了"，把人从
      //   盖房的备料里拉走去"回家待着"，接着 house 卡在 2/7 步被放弃。
      // 现在：今天份 = min(整个阶段要的量, 每天能干多少)，拿 have 跟它比。
      const cap = Math.min(wantTotal, capRaw != null ? capRaw : wantTotal)
      const reached = have >= cap
      if (!reached) allReached = false
      // 显示实际攒到的（have），不是被裁剪过的 cap ——
      // 否则挖了 8 块会显示成"今天 4/4"，看着像只挖了 4 块。
      parts.push(`${cn(k)} ${have}/${wantTotal}（今天份 ${cap}${reached ? ' 已完成' : ''}）`)
    }
    return { reached: allReached, text: parts.join('，') }
  }

  /**
   * 这一趟该不该收手了。
   * 主循环可以在每轮开头问一次：true 就去干「上去 / 换点别的」，别再挖了。
   *
   * 三个理由任何一个成立就收：
   *   1. 今天份够了
   *   2. 在地下憋太久了（跟 candidates 用同一条线）
   *   3. 当前阶段已经完成（由 observe 处理，这里不重复）
   */
  shouldWrapUp (status) {
    if (!this.goal || this.goal.done) return { yes: false, why: '' }
    if (status) this.lastStatus = status
    const st = status || this.lastStatus

    const q = this.dailyQuota(st)
    if (q.reached) return { yes: true, why: '今天这一份够了：' + q.text }

    const underMin = this.undergroundFor() / 60000
    if (underMin >= 25) return { yes: true, why: `在下面待了 ${Math.round(underMin)} 分钟了，先上去` }

    return { yes: false, why: '' }
  }

  /** 手工给当前阶段加工作量（盖墙、搭台子这种"做成了"的计量） */
  addWork (n = 1) {
    const s = this.currentStage()
    if (!s) return 0
    s.work = (s.work || 0) + Math.max(0, Number(n) || 0)
    return s.work
  }

  journal (text) {
    if (!this.goal || !text) return
    this.goal.journal.push({ at: this.now(), text })
    if (this.goal.journal.length > 40) this.goal.journal.shift()
  }

  // ------------------------------------------------ 收尾

  completeGoal () {
    const g = this.goal
    if (!g) return
    const now = this.now()
    const mins = Math.round((now - g.createdAt) / 60000)
    this.history.push({
      key: g.key,
      title: g.title,
      why: g.why,
      result: 'done',
      stages: g.stages.length,
      y: g.createdY,
      underground: g.createdUnderground,
      at: now,
      tookMin: mins
    })
    this.cooldown[g.key] = now + this.cfg.doneCooldownMs
    this.goal = null
    this.save(true)
    this.log(`[goals] 干完了：${g.title}（${g.stages.length} 步，用了 ${mins} 分钟游戏外的时间）`)
  }

  // ------------------------------------------------ 换法子（#7）

  /**
   * 这一阶段换个干法 —— 不是换目标。
   *
   * 返回 { switched: true, text, from, why } 或者 { switched: false }（法子用完了）。
   *
   * 【为什么单独抽出来】UNHUMAN-SCAN #7 说得很清楚：
   * "第 2 次『成功但零进展』时就该换**方法**而不是换**目标**"。
   * 原来只有一条路：数到 5 趟 -> 整个目标扔掉 -> 下一个 8 秒再扔一个。
   * 换法子之后目标还在，只是"这么干不行，换那样干"。
   */
  switchMethod (s, why) {
    if (!s) return { switched: false }
    const ways = waysForStage(s)
    const cur = Math.max(0, Math.min(s.methodIndex || 0, ways.length - 1))
    const next = cur + 1
    const maxMethods = Math.max(1, this.cfg.maxMethods || 3)
    if (next >= ways.length || next >= maxMethods) return { switched: false }

    const from = ways[cur] || s.title
    const to = ways[next]
    s.methodIndex = next
    s.methodSince = this.now()
    s.idleWins = 0          // 新法子的账重新记
    s.fails = 0
    s.methodTries = (s.methodTries || 0) + 1

    const msg = `[goals] 换法子（目标不变）：「${s.title}」${why} —— 「${from}」→「${to}」`
    this.log(msg)
    this.journal(`这个法子不行（${why}），换个法子：${to}`)
    this.save(true)
    return { switched: true, text: to, from, why }
  }

  /** 放弃。真人也会放弃 —— 不丢人，记下来就行 */
  abandon (reason, opts = {}) {
    const g = this.goal
    if (!g) return null
    const now = this.now()
    const s = this.currentStage()

    // ===== 最低寿命：不到时间不许放弃 =====
    //
    // 【为什么要在这里拦】#9 的 minLifeMs / minLifeStageMs 之前只写进了 cfg，
    // 全文没有任何一行读它们 —— 配置在，闸门没装。
    // 而 #7 把"空转几趟就动手"从 5 趟压到 2 趟，次数更少、放弃更快，
    // 不把这道时间闸真正接上的话，#9 会当场回退成"几秒换一个目标"。
    //
    // 除了生命危险（urgent），目标立了 minLifeMs 之内、或者这一步
    // 立了 minLifeStageMs 之内，都不许扔。
    if (!opts.urgent) {
      const ageMs = now - (g.createdAt || now)
      const stageMs = now - ((s && s.startedAt) || g.createdAt || now)
      const minLife = this.cfg.minLifeMs || 0
      const minStage = this.cfg.minLifeStageMs || 0
      const tooYoung = minLife > 0 && ageMs < minLife
      const stageTooYoung = minStage > 0 && stageMs < minStage
      if (tooYoung || stageTooYoung) {
        const leftMin = Math.max(0, Math.ceil((minLife - ageMs) / 60000))
        // 只记一次，别每 30 秒刷一条
        if (!s || !s._holdLogged) {
          if (s) s._holdLogged = true
          this.log(`[goals] 先不换：这目标才立了 ${(ageMs / 60000).toFixed(1)} 分钟（至少 ${Math.round(minLife / 60000)} 分钟，还差 ${leftMin} 分钟）—— 想放弃的理由是「${reason || ''}」`)
          this.journal(`有点想放弃（${reason || ''}），但才刚开始，再试试`)
          this.save(true)
        }
        return null
      }
    }

    this.history.push({
      key: g.key,
      title: g.title,
      why: g.why,
      result: 'abandoned',
      reason: reason || '不想干了',
      stoppedAt: s ? s.title : '',
      stagesDone: g.stageIndex,
      // 立的时候在哪 / 扔的时候在哪（参谋要的排序 bug 判据）
      y: g.createdY,
      underground: g.createdUnderground,
      yNow: Math.round(posOf(this.lastStatus || {}).y),
      undergroundNow: undergroundOf(this.lastStatus || {}),
      at: now
    })
    // 近期不再选同一个方向（自己发明的目标用整句话当 key）
    this.cooldown[g.key] = now + this.cfg.cooldownMs
    this.goal = null
    this.save(true)
    this.log(`[goals] 放弃：${g.title} —— ${reason || ''}`)
    return this.history[this.history.length - 1]
  }

  /** 给上层看的一眼状态 */
  status () {
    if (!this.goal) {
      return { has: false, text: '现在没在忙什么大事', history: this.history.slice(-3) }
    }
    const s = this.currentStage()
    return {
      has: true,
      title: this.goal.title,
      why: this.goal.why,
      stage: s ? s.title : '',
      stageIndex: this.goal.stageIndex,
      total: this.goal.stages.length,
      progress: s ? (s.ratio || 0) : 0,
      progressText: this.progressText(),
      since: this.goal.createdAt,
      history: this.history.slice(-3)
    }
  }

  /** 存进长期记忆的一句话 */
  summary () {
    if (!this.goal) return null
    const s = this.currentStage()
    return `最近在忙一件事：${this.goal.title}。卡在「${s ? s.title : ''}」这一步。`
  }

  /** 全部阶段（报告 / 测试用） */
  plan () {
    if (!this.goal) return []
    return this.goal.stages.map((s, i) => ({
      index: i,
      title: s.title,
      kind: s.kind,
      done: !!s.doneAt || i < this.goal.stageIndex,
      current: i === this.goal.stageIndex,
      ratio: s.ratio || 0
    }))
  }
}

// ---------------------------------------------------------------- 阶段进度计算

/**
 * gather 阶段"达到过的最高数量"。
 *
 * 【为什么不用当前净增量】他会边挖边用：圆石 167→151→148 在减少，
 * `itemCount(inv,k) - itemCount(base,k)` 变成负数 -> Math.max(0,…) = 0，
 * 于是日志里全是「干了 5 趟都说成了，进度一点没动」——他真的干了，
 * 只是计数器不认。
 *
 * 改成阶段期间每个 key 的峰值：挖到就记，消耗不影响进度；
 * 开局已有的数量记在 base.inv 里，peak 从它起步，所以不会白送。
 * 峰值写回 stage.base.peak，随 goals.json 一起存盘，重连不丢。
 */
function trackPeak (stage, inv, keys) {
  const base = stage && stage.base
  if (!base) return
  if (!base.peak || typeof base.peak !== 'object') base.peak = {}
  const baseInv = base.inv || {}
  for (const k of keys) {
    const floor = itemCount(baseInv, k)
    const prev = base.peak[k] != null ? Number(base.peak[k]) : floor
    const now = itemCount(inv, k)
    base.peak[k] = Math.max(isFinite(prev) ? prev : floor, now)
  }
}

/** 某个 key 在这一阶段攒到的量（峰值 - 开局基线，不会因为消耗变小） */
function peakHave (stage, inv, k) {
  const baseInv = (stage.base && stage.base.inv) || {}
  const peak = stage.base && stage.base.peak && stage.base.peak[k] != null
    ? Number(stage.base.peak[k])
    : itemCount(inv, k)
  return Math.max(0, peak - itemCount(baseInv, k))
}

function stageProgress (stage, status) {
  const inv = (status && status.inventory) || {}
  const need = stage.need || {}
  const base = (stage.base && stage.base.inv) || {}

  if (stage.kind === 'gather') {
    const keys = Object.keys(need)
    if (!keys.length) return { ratio: 1, text: '' }
    // 先更新峰值，再按峰值算 —— 消耗不会让已经挖到的进度倒退
    trackPeak(stage, inv, keys)
    let total = 0
    let got = 0
    const parts = []
    for (const k of keys) {
      const want = Number(need[k]) || 0
      const have = peakHave(stage, inv, k)
      const g = Math.min(want, have)
      total += want
      got += g
      parts.push(`${cn(k)} ${g}/${want}`)
    }
    return { ratio: total > 0 ? clamp01(got / total) : 1, text: parts.join('，') }
  }

  if (stage.kind === 'craft') {
    const name = need.item
    const want = Number(need.n) || 1
    // ===== 【层3 修】craft 也要按**增量**算 =====
    //
    // 原来是 `itemCount(inv, name)` —— 绝对存量。
    // 实测：开局背包里就有 stone_pickaxe / wooden_hoe / iron_pickaxe 的时候，
    // iron/farm/diamond 三个目标的第 1 步（"先弄把石镐/做把锄头/先弄把铁镐"）
    // 一立起来 ratio 立刻是 1，一步没动就过。30 条历史里那些 stagesDone:1
    // 的记录就是这么来的。
    //
    // 现在跟 gather 一样对 base 求差：这一阶段**新做出来的**才算。
    // 手上本来就有的那一把不算他的工。
    const had = itemCount(base, name)
    if (had >= want) {
      // 一开始手上就有够用的：这一步**不用做**，跟"本来就在地面上"一样处理 ——
      // 直接跳过，但不记成"他做到了"（goals.json 里不留零动作完成的阶段）。
      return { ratio: 1, text: `手上本来就有${cn(name)}，这一步不用做`, trivial: true }
    }
    const made = Math.max(0, itemCount(inv, name) - had)
    return { ratio: clamp01(made / want), text: `${cn(name)} 新做 ${Math.min(want, made)}/${want}` }
  }

  // surface：回到地面。跟 depth 正好相反 —— 往上走，y 大于等于目标就算到。
  //
  // 【为什么挖矿目标必须有这一步】
  // 之前的 iron/diamond 都以"挖够多少"结尾，做完时人还在 y=14 的洞里。
  // 目标结束了、下一步又可能挑个地下的活，于是他永远不抬头。
  // 把"回到地面"写进目标本身，才有一个必须兑现的出口。
  //
  // 【判据：优先信 isUnderground()，不是纯 y 坐标】
  //
  // 上一版是 `y >= 58 就算到地面`。这有两个方向的错：
  //   · 山谷 / 河谷：y 可能只有 52，但头顶是天，人明明在外面 —— 判成"还在洞里"
  //   · 山肚子里的高处洞穴：y 可能 70，头顶是石头 —— 判成"到地面了"，其实没出来
  // 所以上层把 actions.isUnderground() 的结果塞进 status.underground 时，
  // 就完全按它判；没塞才退回 y 坐标（并明确在文案里标出来这是估算）。
  if (stage.kind === 'surface') {
    // 只有调用方**明确**给了 underground 才算"知道"。
    // 没给的话 undergroundOf 会按 y 猜 —— 那个结果不能当定论用，
    // 山谷和山体洞穴都会判错，所以走下面的估算分支并说明。
    const certain = status && typeof status.underground === 'boolean'
    const ug = certain ? status.underground : null
    const y = Math.round(posOf(status).y)

    // 明确的"在露天" —— 一锤定音，不管 y 是多少。
    // 但**一开始就在露天**的话，这一步是没走过的：不能白算。
    // （#9 里 3 秒完成的 getup 就是这种：立起来的时候人已经在外面了。）
    if (ug === false) {
      if (stage.base && stage.base.ug === false) {
        return { ratio: 0, text: '本来就在地面上，这一步没什么可爬的', trivial: true }
      }
      return { ratio: 1, text: `已经在露天了（y=${y}）` }
    }

    // 明确的"还在遮挡下面" —— 没过，进度按往上爬了多少算
    if (ug === true) {
      const target = Number(need.y) || SURFACE_Y
      const from = stage.base && typeof stage.base.y === 'number' ? stage.base.y : y
      // 已经比"下来时"高了不少的话，给个正反馈，但绝不算完成
      // 往上爬了一些给点正反馈，但封在 0.75 ——
      // 进度条显示 90% 会让人以为快完了，实际头顶还是石头。
      const climbed = Math.max(0, y - from)
      const guess = clamp01(climbed / Math.max(1, target - from)) * 0.75
      return { ratio: guess, text: `还在遮挡下面（y=${y}），得真的出去` }
    }

    // 不知道（没传 underground 且没有坐标可比）—— 退回 y 估算
    const target = Number(need.y) || SURFACE_Y
    if (y >= target) return { ratio: 1, text: `y=${y}，看起来出来了（按高度估算）` }
    const from = stage.base && typeof stage.base.y === 'number' ? stage.base.y : y
    const span = Math.max(1, target - from)
    return { ratio: clamp01((y - from) / span), text: `现在 y=${y}，还差到 y=${target}（按高度估算）` }
  }

  if (stage.kind === 'depth') {
    const target = Number(need.y)
    const from = stage.base && typeof stage.base.y === 'number' ? stage.base.y : 64
    const y = Math.round(posOf(status).y)
    if (y <= target) return { ratio: 1, text: `已经到 y=${y} 了` }
    const span = from - target
    const done = span > 0 ? (from - y) / span : 0
    return { ratio: clamp01(done), text: `现在 y=${y}，目标是 y=${target}` }
  }

  // climb：往上爬。跟 depth 正好相反 —— 只要 y 够了就算到。
  // 【为什么单独一个 kind】"往上挖"是他**做得到**的事（刨十几格没问题），
  // "找到露天"才是不一定做得到的（头顶有没有遮挡）。两件事分开算，
  // 卡住时才看得出卡在哪一段，而不是一律记"没成"。
  if (stage.kind === 'climb') {
    const target = Number(need.y) || SURFACE_Y
    const y = Math.round(posOf(status).y)
    if (y >= target) return { ratio: 1, text: `已经到 y=${y} 了` }
    const from = stage.base && typeof stage.base.y === 'number' ? stage.base.y : y
    const span = Math.max(1, target - from)
    return { ratio: clamp01((y - from) / span), text: `现在 y=${y}，目标是 y=${target}` }
  }

  if (stage.kind === 'travel') {
    const want = Number(need.distance) || 100
    const from = (stage.base && stage.base.pos) || posOf(status)
    const d = dist(from, posOf(status))
    return { ratio: clamp01(d / want), text: `走了 ${Math.round(d)}/${want} 格` }
  }

  // do / build / custom：靠"做成了几次"或 addWork 计数
  const want = Number(need.count) || 1
  const work = Number(stage.work) || 0
  return { ratio: clamp01(work / want), text: `${Math.min(want, work)}/${want}` }
}

/** 模型给的阶段（可能只有一句话）补成能验收的结构 */
// ---------------------------------------------------------------- 「换个法子」

/**
 * 同一件事的几种干法。第 0 条 = 原来的干法，换法子时往后挪。
 *
 * 【为什么要有这个】UNHUMAN-SCAN #7：同一个阶段连做 5 遍一模一样的事
 * （"5 在附近地上捡够垫脚的石头"），第 5 遍才放弃整个目标。
 * 真人第二遍就会换手法，而不是把"捡石头"这三个字重新念一遍：
 *   在脚边捡 → 挖裸露岩面 → 往下挖两格取石头再垫回来
 * 换的是**怎么干**，不是**干什么** —— 目标还是搭高台。
 *
 * 按标题登记，是因为池子里的阶段被复制了好几手（POOL → picked.stages →
 * makeGoal 里的新对象），只在 POOL 上挂 ways 容易在半路丢掉。
 * 自定义阶段（模型自己编的）没有登记，走下面的按 kind 兜底。
 */
const STAGE_WAYS = {
  // tower / house 的备料
  '在附近地上捡够垫脚的石头': [
    '在脚边和山坡上捡现成的圆石',
    '找裸露的岩面直接挖，别满地找',
    '往下挖两格取石头，再垫回来'
  ],
  '备料：石头和木头攒够一堆': [
    '石头挖裸露的岩面，木头找树',
    '先专门砍树把木头凑够，石头最后补',
    '先挖石头堆够，木头从地上的残桩捡'
  ],
  // iron：带火把和吃的
  '带够火把和吃的，下去挖矿': [
    '先砍树做火把，吃的顺手打猎',
    '先解决吃的：打猎或摘野果，火把回头再说',
    '翻一翻落脚点附近有没有现成的，别从零做'
  ],
  '带够火把，别在下面摸黑': [
    '砍树烧炭做火把',
    '先攒煤，煤比木炭耐烧',
    '带够木头和炭下去，边挖边做'
  ],
  '这一趟挖够十来块铁矿': [
    '顺着天然矿洞往下找露头的铁矿',
    '自己往下挖楼梯井，一路看墙上的矿',
    '换个方向找，别在同一片石头里打转'
  ],
  '回到地上再烧成铁锭': [
    '回地面上用熔炉烧',
    '先在下面用随身炉子烧一半再上去',
    '找现成的熔炉，省得自己造'
  ],
  // farm
  '做把锄头': [
    '木头做棍、石头做头，从头做一把',
    '先砍两棵树补够木头，再回来做',
    '看看有没有现成的能顶用，别非做不可'
  ],
  '找点种子': [
    '找草打掉，弄点小麦种子',
    '去有水的地方找，草多的地方种子也多',
    '先开一块地等雨，种子路上顺手捡'
  ],
  '等它长，收一茬麦子': [
    '守着这块地等它长，顺便干点别的',
    '去别处转一圈再回来看',
    '先收一轮能收的，青的留着'
  ],
  // iron：石镐（3 圆石 + 2 木棍）
  '先弄把石镐，铁矿才挖得动': [
    '先砍树做把木镐，挖 3 块圆石再做石镐',
    '地上捡现成的圆石和木头，凑够就做',
    '先徒手挖几块软石头凑数，别非得找硬岩'
  ],
  // diamond
  '先弄把铁镐，不然到深层白跑': [
    '挖够铁矿回去烧，自己做一把',
    '先找现成的铁：村庄箱子、废弃矿道',
    '用石镐先挖浅层的，铁镐边挖边攒'
  ],
  '往下挖到很深的地方': [
    '找天然竖井或矿洞往下走',
    '自己挖楼梯井，一格一格下去',
    '换个已知的洞口重新下，别死磕这一条'
  ],
  '找到钻石矿，挖下来': [
    '贴着 y=12 一层层探',
    '沿着岩浆湖边的岩壁找',
    '换个方向重新开一条探矿道'
  ],
  // explore
  '带上吃的和火把再出门': [
    '先备吃的和火把，够了就走',
    '轻装出门，路上打猎捡木头现做',
    '先带上现有的，缺的路上补'
  ],
  '朝一个方向走出去，走到没见过的地界': [
    '认准一个方向一直走',
    '沿着河走，河一般通得远',
    '翻过前面那道山看看另一边'
  ],
  // 收尾 / 回地面
  '顺着来路爬回地面，透口气': [
    '顺来路爬回去',
    '自己挖一条向上的楼梯井出去',
    '找天然洞口出去，别硬挖'
  ],
  '往上挖/找路，回到地面上': [
    '往上挖楼梯井',
    '找最近的洞口绕出去',
    '顺着水流或矿道往上摸'
  ],
  '先往上挖，挖到地表那么高': [
    '一格一格往上挖楼梯井',
    '找个天然的竖井/矿道往上爬',
    '斜着往上挖，别挖成直井（容易掉）'
  ],
  '再找露天的地方钻出去': [
    '顺着最近的洞口走出去',
    '朝光的方向挖过去（有光通常就是口子）',
    '找个漏下天光的地方往上掏'
  ],
  '到地面上站一会儿，看看四周': [
    '站高处看一圈',
    '沿着边上走一圈看看',
    '找个树顶爬上去望'
  ]
}

/**
 * 这一步有哪几种干法。第一条恒等于原计划。
 * 自定义阶段没登记 -> 按 kind 给一组通用换法（也得是真能换的做法）。
 */
function waysForStage (stage) {
  if (!stage) return []
  if (Array.isArray(stage.ways) && stage.ways.length) return stage.ways.slice()
  const t = String(stage.title || '')
  if (STAGE_WAYS[t]) return STAGE_WAYS[t].slice()

  const need = stage.need || {}
  const what = cn(Object.keys(need)[0] || '')
  switch (stage.kind) {
    case 'gather':
      return [
        t,
        `换个地方找${what}`,
        `找现成的或者能顶用的替代品`
      ]
    case 'craft':
      return [
        t,
        `先把材料补齐再回来做`,
        `看看有没有现成的能顶用`
      ]
    case 'surface':
    case 'depth':
      return [
        t,
        '自己挖一条竖井/楼梯井，别等现成的路',
        '换个方向重新找路'
      ]
    case 'travel':
      return [
        t,
        '换个方向走',
        '沿着水路走，通常通得远'
      ]
    default:
      return [
        t,
        '换个做法，别照原样再来一遍',
        '换块地方再试'
      ]
  }
}

/**
 * 几条路都试过、但目标还没到能放弃的时间，这时说什么。
 *
 * 【为什么需要】#7 修完第一版跑回放发现的：换法子到第 3 条之后，
 * 放弃被 #9 的 5 分钟闸门挡住，于是同一条任务文本又被重复了 184 遍 ——
 * 比原来的 5 遍更难看。真人这时候不会接着念同一句话，
 * 他会"先把这事放一放，去干点别的"，过一阵再回来看。
 * 这几句就是那个"干点别的"。按已经跑过的趟数轮换，不重复。
 */
const PARK_TEXTS = [
  '这一步先放放，在附近转转看看有没有别的门路',
  '坐一会儿，把身上的东西归置一下，这事待会儿再说',
  '先干点别的散散心，回头再想这件事'
]

/**
 * 模型给的阶段（可能只有一句话）补成能验收的结构。
 *
 * 它自己发明的阶段没有数字，只能按"做成了没有"来算 —— 一次成功算一步。
 * 这样宁可粗一点，也不能因为"没法量化"就不记账。
 */
/**
 * 每个阶段**必须声明**用哪类证据验收 —— 判据层没有默认分支，没声明就抛错。
 *
 * 这是在**声明**，不是在**判定**：这里只回答"这个阶段该用哪种尺子量"，
 * 成败由 src/judge.js 按尺子去量世界。
 *
 *   world    背包 / 方块 / 位移 —— 绝大多数体力活
 *   duration 在附近待够 N 秒且没掉血没饿 —— 歇着、守着、等天亮这类没有世界证据的
 *   state    调用方给一个明确状态判据
 */
// 显式声明表：**目标层是数据，判据层没有默认分支** —— 每个阶段在这里或模板里
// 写清楚用哪把尺子量。没写的阶段，judge 会直接抛错（不是静默放过）。
// 新增阶段模板时忘了声明 -> 单测 test-fake-success 的"POOL 每个阶段都能拿到 evidence"会红。
const STAGE_EVIDENCE = {
  // 没有世界证据的：待着、守着、等天亮
  '先歇着': { evidence: 'duration', minSec: 30 },
  '歇一会儿': { evidence: 'duration', minSec: 30 },
  '守着火堆': { evidence: 'duration', minSec: 60 }
}

function evidenceForStage (kind, title) {
  const t = String(title || '')
  if (STAGE_EVIDENCE[t]) return Object.assign({}, STAGE_EVIDENCE[t])
  // 明确"待着/歇/守/等"且没有位移动词的，才用 duration
  if (/(歇|休息|待着|待一会|守着|等天亮|睡一觉|养伤|养血)/.test(t) &&
      !/(回|去|走|到|搬|送|找|探|巡)/.test(t)) {
    return { evidence: 'duration', minSec: 30 }
  }
  // 其它一律 world：挖/砍/做/合/盖/放/回地面/上下…都靠背包、方块、位移
  return { evidence: 'world' }
}

// POOL 是数据：加载时给每个阶段**盖章**，让 evidence 成为阶段自己的字段。
// 注意这不是"运行时兜底" —— 盖章发生在模块初始化，之后阶段身上就带着类型；
// judge 仍然拒绝没有类型的输入。
for (const def of POOL) {
  for (const st of def.stages || []) {
    if (st.evidence) continue
    const ev = evidenceForStage(st.kind, st.title)
    st.evidence = ev.evidence
    if (ev.minSec) st.minSec = ev.minSec
  }
}

function normalizeStage (raw) {
  const title = String(raw.title || '').trim().slice(0, 40)
  let kind = String(raw.kind || '').trim()
  if (!['gather', 'craft', 'depth', 'climb', 'surface', 'travel', 'do', 'build'].includes(kind)) kind = 'do'
  const need = raw.need && typeof raw.need === 'object' && Object.keys(raw.need).length
    ? raw.need
    : { count: 1 }
  const ev = raw.evidence ? { evidence: raw.evidence, minSec: raw.minSec } : evidenceForStage(kind, title)
  return { key: null, kind, need, title, evidence: ev.evidence, ...(ev.minSec ? { minSec: ev.minSec } : {}) }
}

function parseJson (text) {
  const s = String(text || '')
  const m = s.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch (e) { return null }
}

module.exports = Goals
module.exports.Goals = Goals
module.exports.POOL = POOL
module.exports.evidenceForStage = evidenceForStage
module.exports.ITEM_CN = ITEM_CN
module.exports.pickTier = pickTier
module.exports.itemCount = itemCount
module.exports.stageProgress = stageProgress
module.exports.VERSION = VERSION
