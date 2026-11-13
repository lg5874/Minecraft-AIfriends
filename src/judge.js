'use strict'
// 单判定器：一次任务/一次技能，到底有没有改变世界。
//
// 为什么要抽出来（2026-11-13 审查）：
//   main.verifyTaskEffect 和 coder.verifySkillEffect 是两份**各写各的**判据，
//   同一份证据能得出相反结论：38 个真实技能 × 3 种世界状态，
//   "真挖了 2 格、背包没涨" 这种世界里两边差 16/38（42%）。
//   同一次运行里技能记成功、任务记失败，账本互相打架。
//
// 设计原则（照审查报告）：
//   1. **证据维度**说话，不用"任务分类"决定成败
//        inv     背包净变化 / 目标物增量
//        blocks  周围方块变化
//        move    位移
//        held    手持物品变化（换装备时背包可能一点没变）
//        food    饱食度变化（吃东西：食物减少是**正常**的）
//   2. 文本只有**否决权**（说了失败词就是失败），没有批准权
//   3. 一个出口 judgeTask()，main 和 coder 都调它
//
// 关键细节（都被实测打过脸）：
//   · 目标物不能取"第一个被文本包含的中文词"——「用石镐挖圆石」会先命中"石镐"，
//     于是要求 stone_pickaxe +1，38 个技能里 14 个这么错。现在收**全部**候选，
//     任何一个涨了就算数；"用 X" 里的 X（工具/手段）直接排除。
//   · 世界快照必须用**绝对坐标**做 key。用相对偏移、第二次却在当前 pos 取样，
//     人一动所有 key 全变 —— 实测"动了 2 格没挖"会报 482 格变化，
//     等于把"他动过没有"当成了"世界变了没有"。

// ---------- 物品词典 ----------
// 值 = 游戏里的物品名（可能多个同义写法）
const ITEM_DICT = [
  ['钻石镐', ['diamond_pickaxe']], ['木镐', ['wooden_pickaxe']],
  ['石镐', ['stone_pickaxe']], ['铁镐', ['iron_pickaxe']],
  ['金镐', ['golden_pickaxe']], ['木斧', ['wooden_axe']],
  ['石斧', ['stone_axe']], ['铁斧', ['iron_axe']],
  ['木剑', ['wooden_sword']], ['石剑', ['stone_sword']], ['铁剑', ['iron_sword']],
  ['木铲', ['wooden_shovel']], ['石铲', ['stone_shovel']], ['铁铲', ['iron_shovel']],
  ['锄头', ['wooden_hoe', 'stone_hoe', 'iron_hoe']],
  ['工作台', ['crafting_table']], ['熔炉', ['furnace']],
  ['箱子', ['chest']], ['木棍', ['stick']], ['火把', ['torch']],
  ['床', ['red_bed', 'white_bed']], ['面包', ['bread']],
  ['木门', ['oak_door']], ['梯子', ['ladder']],
  ['铁锭', ['iron_ingot']], ['铁矿石', ['raw_iron', 'iron_ore']],
  ['生铁', ['raw_iron']],
  ['钻石', ['diamond']], ['青金石', ['lapis_lazuli']],
  ['煤', ['coal']], ['木炭', ['charcoal']],
  ['圆石', ['cobblestone']], ['安山岩', ['andesite']], ['石头', ['stone', 'cobblestone']],
  ['木板', ['oak_planks', 'birch_planks', 'spruce_planks']],
  ['原木', ['oak_log', 'birch_log', 'spruce_log']],
  ['泥土', ['dirt']], ['沙子', ['sand']], ['种子', ['wheat_seeds']],
  ['小麦', ['wheat']], ['苹果', ['apple']], ['熟肉', ['cooked_porkchop', 'cooked_beef']]
]
const TOOL_SUFFIX = /(镐|斧|剑|铲|锄)$/

const FOOD = ['bread', 'apple', 'cooked_porkchop', 'cooked_beef', 'cooked_chicken',
  'baked_potato', 'golden_apple', 'carrot', 'wheat', 'melon_slice', 'cooked_mutton']

/**
 * 从一句话里找出"要产出什么"。
 *
 * 规则：
 *   · 工具名默认**不算产物**（"用石镐挖圆石" 里的石镐是手段），
 *     只有当句子里出现"做/合/造"等制作动词且工具是该动词的宾语时才收。
 *   · "用 X" / "拿 X" / "换上 X" 里的 X 一律排除。
 */
function wantedItems (text) {
  const t = String(text || '')
  const hits = []
  for (const [cn, items] of ITEM_DICT) {
    let idx = t.indexOf(cn)
    while (idx >= 0) {
      const before = t.slice(Math.max(0, idx - 2), idx)
      const asInstrument = /(用|拿|使|换|带上|带上|带)/.test(before)
      const isTool = TOOL_SUFFIX.test(cn)
      const craftVerb = /(做|制作|合成|造|打|弄|修|备)[^，。；]{0,4}$/.test(before)
      if (!asInstrument && (!isTool || craftVerb)) {
        hits.push({ cn, items, at: idx })
        break
      }
      idx = t.indexOf(cn, idx + 1)
    }
  }
  hits.sort((a, b) => a.at - b.at)
  return hits
}

function classify (text) {
  const t = String(text || '')
  return {
    produce: /(做|制作|合成|造|弄|搞|挖|砍|打|采|收集|攒|备|升级|换|烤|烧|熔炼|种|捡|找点|弄点|弄到|搞到)/.test(t),
    consume: /(放|摆|存|放进|存进|摆好|放好|安置|整理|扔|丢|清空|倒)/.test(t),
    move: /(搬到|搬去|挪到|挪去|移到|移去|运到|扛到|抬到)/.test(t),
    travel: /(去|走|跑到|前往|探索|巡视|转一圈|查看|找|探|散步|遛)/.test(t),
    stay: /(待着|待一会|待会儿|躲|藏|歇|休息|睡|等|守着|别乱跑|养[血伤]|缩|趴)/.test(t),
    mental: /(说|问|聊|想|回忆|答|打招呼|回应|琢磨)/.test(t),
    eat: /(吃|填饱|别饿|饿了|弄点吃的|找点吃的|啃)/.test(t),
    craft: /(做|制作|合成|造|打一把|修一把)/.test(t),
    // 目标本身就是"改变高度/位置"：回地面、爬上去、出土、上到 y=N。
    // 这类目标**只有 y 坐标能作证**，点火把、捡东西都是无关证据。
    needsHeight: /(回到地面|回到上面|爬到|爬上|上到|升到|上去|出土|出洞|离开地下|回到地表)/.test(t)
  }
}

// ---------- 世界快照 ----------
// 绝对坐标做 key。这是审查报告点名的 bug：
//   相对偏移 + 第二次用当前 pos 取样 => 人一动，所有 key 都"变了"。
function worldSig (bot, anchor, { r = 5, up = 2, down = 2 } = {}) {
  if (!bot || !anchor) return null
  // 【必须传 Vec3】mineflayer 的 blockAt -> prismarine-world.getBlock 里有一句
  //   block.position = pos.floored()
  // 传普通 {x,y,z} 会抛 TypeError，被 catch 吞掉就成了"读不到"。
  // 实测三轮真机日志全是 `方块?`，世界证据整整一维是死的 —— 就是这个。
  const Vec3 = (() => { try { return require('vec3').Vec3 } catch (e) { return null } })()
  const mk = (x, y, z) => (Vec3 ? new Vec3(x, y, z) : { x, y, z, floored () { return { x, y, z } } })
  const sig = {}
  let ok = 0
  try {
    const ax = Math.floor(anchor.x)
    const ay = Math.floor(anchor.y)
    const az = Math.floor(anchor.z)
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dy = -down; dy <= up; dy++) {
          const x = ax + dx
          const y = ay + dy
          const z = az + dz
          const b = bot.blockAt(mk(x, y, z))
          if (b) { sig[x + ',' + y + ',' + z] = b.name; ok++ }
        }
      }
    }
  } catch (e) { return null }
  // 一格都读不到（区块没加载）不算"世界没变"，当成读不到
  return ok > 0 ? sig : null
}

// 只数**两边都看得到**的那些格子；新加载/卸载的区域不算变化。
function worldDiffCount (before, after) {
  if (!before || !after) return -1
  let n = 0
  for (const k of Object.keys(before)) {
    if (after[k] === undefined) continue
    if (after[k] !== before[k]) n++
  }
  return n
}

// ---------- 证据 ----------
function invDelta (before = {}, after = {}) {
  const gained = {}
  const lost = {}
  let g = 0
  let l = 0
  for (const [k, v] of Object.entries(after)) {
    const d = (v || 0) - (before[k] || 0)
    if (d > 0) { gained[k] = d; g += d }
  }
  for (const [k, v] of Object.entries(before)) {
    const d = (v || 0) - (after[k] || 0)
    if (d > 0) { lost[k] = d; l += d }
  }
  const sum = (o) => Object.values(o || {}).reduce((a, b) => a + (b || 0), 0)
  return { gained, lost, gainedTotal: g, lostTotal: l, totalBefore: sum(before), totalNow: sum(after) }
}

function foodDelta (before = {}, after = {}) {
  let d = 0
  for (const f of FOOD) d += ((after[f] || 0) - (before[f] || 0))
  return d   // 负数 = 吃掉了一些
}

/**
 * 单判定出口。
 *
 * ctx = {
 *   goal, text,                  // 任务/技能描述（text 用于分类，含技能 desc）
 *   invBefore, invAfter,
 *   posBefore, posAfter,
 *   worldBefore, worldAfter,     // judge.worldSig 的快照
 *   heldBefore, heldAfter,
 *   foodLevelBefore, foodLevelAfter
 * }
 *
 * @returns {{ok:boolean, why:string, progress:number, evidence:string, dims:object}}
 */
const EVIDENCE_TYPES = ['world', 'duration', 'state']

function judgeTask (ctx = {}) {
  // ===== 第一件事：目标必须声明"用哪类证据验收" =====
  //
  // 参谋的判断（第四次同一个病之后）：
  //   根因不是疏忽，是**判据覆盖不到某些目标类型**。
  //   「原地待着」本质上没有世界证据，blockAt/inventory 验不了它，
  //   于是每遇到一个新的不可观测目标，就必然有人开一个文本后门：
  //     judgeOutcome 里开过一次 -> markUse 里开过一次 -> [proof].stay 又开一次。
  //
  // 现在没有默认分支：没声明就炸，让后门当场暴露，而不是静默放过。
  if (!ctx.evidence) {
    throw new Error(`判定缺少 evidence 类型（目标「${String(ctx.goal || '').slice(0, 30)}」）—— 拒绝判定`)
  }
  if (!EVIDENCE_TYPES.includes(ctx.evidence)) {
    throw new Error(`未知 evidence 类型「${ctx.evidence}」—— 只认 ${EVIDENCE_TYPES.join('/')}`)
  }

  const goal = String(ctx.goal || '')
  // 【铁律】分类只看**目标**，绝不看模型自己写的收尾话术。
  //
  // 哨兵实测（23:5x）：
  //   PASS | 回家        | 太远了，先歇会儿    => 原地待着 | progress=0
  //   PASS | 走回家      | 太远，先在这儿等等  => 原地待着 | progress=0
  //   PASS | 去矿洞看看  | 原地待着等天亮      => 原地待着 | progress=0
  // 只要说一句"太远了先歇会儿"、什么都不做，就能拿到 [proof] 背书 + markUse(ok)。
  // 这是"文本批准"，正是这一轮要禁掉的东西 —— 只不过上次是从 judgeOutcome 漏，
  // 这次是从 judge 的豁免分支漏。ctx.text（模型的输出/技能描述）从此**不参与分类**。
  const c = classify(goal)
  const inv = invDelta(ctx.invBefore, ctx.invAfter)
  const blocks = worldDiffCount(ctx.worldBefore, ctx.worldAfter)
  const worldChanged = blocks > 0

  let moved = null
  try {
    if (ctx.posBefore && ctx.posAfter && typeof ctx.posAfter.distanceTo === 'function') {
      moved = ctx.posAfter.distanceTo(ctx.posBefore)
    }
  } catch (e) {}

  const heldChanged = !!(ctx.heldBefore !== undefined && ctx.heldAfter !== undefined &&
    ctx.heldBefore !== ctx.heldAfter)
  const ate = (typeof ctx.foodLevelBefore === 'number' && typeof ctx.foodLevelAfter === 'number')
    ? ctx.foodLevelAfter - ctx.foodLevelBefore
    : null
  const foodUsed = foodDelta(ctx.invBefore, ctx.invAfter)

  const wants = wantedItems(goal)
  const targetDelta = wants.length
    ? wants.map(w => ({
      cn: w.cn,
      d: w.items.reduce((a, it) => a + ((ctx.invAfter || {})[it] || 0) - ((ctx.invBefore || {})[it] || 0), 0)
    }))
    : []
  const targetGain = targetDelta.reduce((a, x) => a + Math.max(0, x.d), 0)

  const dims = {
    invGain: inv.gainedTotal,
    invLoss: inv.lostTotal,
    blocks,
    moved: moved === null ? null : +moved.toFixed(1),
    heldChanged,
    ate,
    foodUsed,
    targets: targetDelta
  }
  // 每个成功出口都必须说明"是哪条证据让它算成了"。
  //
  // 判据类型（ctx.evidence）在入口已经强制过；这里再堵一层：
  // 以后谁新加一个 done() 却不说证据，**当场 throw**，
  // 而不是写个空字符串悄悄混过去（第五次后门就藏在这种"差的这一点"里）。
  // kind 一并带出去，日志/账本里能看见这次用的是哪把尺子。
  const done = (progress, evidence) => {
    if (typeof evidence !== 'string' || !evidence) {
      throw new Error(`判定成功但没写证据说明（目标「${goal.slice(0, 30)}」，` +
        `证据类型 ${ctx.evidence}）—— 拒绝判定`)
    }
    return { ok: true, why: '', progress, evidence, kind: ctx.evidence, dims }
  }
  const fail = (why) => ({ ok: false, why, progress: 0, evidence: '', dims })

  // ---- 0. 位置类目标：只认 y ----
  //
  // 真机铁证（2026-11-13 22:54:45）：
  //   <<< 完成（86s）：没硬往上挖，往北探了探（没挪动），点了火把、捡了捡东西，
  //                    坐下歇了会儿。现在 y=42，还在地面下，出去的事改天再想。
  // 目标是"回到地面上"，实际 y=42 还在地底。判完成。
  //
  // 为什么五维判据会放它过：他点火把（blocks 变了）、捡东西（inv 变了）
  // —— 这两条都被算成"有变化"。可对"回到地面"这个目标来说，
  // **点火把是无关证据**。目标类型决定哪些维度算数，这点没错；
  // 错在之前没有"位置类目标"这一档，于是所有维度都算。
  // "上去"这个词太常见（"搬到山顶上去"/"站上去"），
  // 只有"回地面/出洞/爬到/上到"这类是硬信号；带搬/运/放/摆/存的先排除。
  const moveish = /(搬|运|放|摆|存|扔|丢)/.test(goal)
  const positionGoal = !moveish && (
    /(回到地面|回到上面|回到地表|离开地下|出土|出洞|爬上去|爬上|爬到|上到|升到)/.test(goal) ||
    (/上去/.test(goal) && /(地面|地表|上面|地上)/.test(goal))
  )
  if (positionGoal) {
    const y0 = ctx.posBefore ? ctx.posBefore.y : null
    const y1 = ctx.posAfter ? ctx.posAfter.y : null
    const risen = (y0 === null || y1 === null) ? null : y1 - y0
    // 已经确认在地面上（调用方能给 underground=false 就给），直接算到
    if (ctx.undergroundAfter === false) return done(1, '已经在地面上了')
    if (risen === null) {
      return fail('目标是要上去，但拿不到 y 坐标，无法证明——不算成')
    }
    if (risen < 1.5) {
      return fail(`没上去：y ${y0.toFixed(0)}->${y1.toFixed(0)}（只涨了 ${risen.toFixed(1)} 格）` +
        `；点火把、捡东西这些跟"上去"没关系`)
    }
    return done(1, `y ${y0.toFixed(0)}->${y1.toFixed(0)}`)
  }

  // ---- 0. duration：在附近待够 N 秒，且血没掉、没饿 ----
  //
  // 「原地待着」没有世界证据，判据必须换一类证据，而不是靠匹配"待着"这两个字。
  // 验的三件事：① 真待够时间 ② 几乎没挪窝（<5 格）③ 没在掉血/挨饿
  if (ctx.evidence === 'duration') {
    const need = Number(ctx.minSec || 30)
    const secs = Number(ctx.durationSec || 0)
    const hp0 = ctx.healthBefore
    const hp1 = ctx.healthAfter
    const f0 = ctx.foodLevelBefore
    const f1 = ctx.foodLevelAfter
    if (moved !== null && moved > 5) {
      return fail(`说要待着，结果挪了 ${moved.toFixed(1)} 格`)
    }
    if (hp0 != null && hp1 != null && hp1 < hp0 - 0.5) {
      return fail(`说要待着，血从 ${hp0} 掉到 ${hp1} —— 根本没在歇`)
    }
    if (f0 != null && f1 != null && f1 < f0 - 0.5) {
      return fail(`说要待着，饱食度 ${f0}->${f1} 掉着，没停下吃东西`)
    }
    if (secs < need) {
      return fail(`只待了 ${Math.round(secs)}s，要求 ${need}s`)
    }
    return done(1, `待了 ${Math.round(secs)}s，没挪窝、没掉血`)
  }

  // ---- 0b. state：调用方给一个明确的状态判据 ----
  if (ctx.evidence === 'state') {
    if (ctx.stateOk === true) return done(1, ctx.stateNote || '状态达成')
    if (ctx.stateOk === false) return fail(ctx.stateNote || '状态没达成')
    return fail('声明了 state 证据，但调用方没给 stateOk —— 无法验收')
  }

  // ---- 1. 有目标产物：那样东西得真的多出来 ----
  if (wants.length && c.produce && !c.consume && !c.move) {
    if (targetGain > 0) {
      const hit = targetDelta.filter(x => x.d > 0).map(x => `${x.cn}+${x.d}`).join(' ')
      return done(targetGain, hit)
    }
    // 制作类（做/合成/造/弄 一样具体东西）：只能靠**那样东西真的进了背包**。
    // 方块变了不算 —— "做石镐"的完成长这样：石镐 +1，不是"挖了两格"。
    //
    // 「先弄把铁镐」这种也算制作：动词是"弄"，但宾语是工具。
    // 否则它会掉进"挖通道"分支，靠挖了两格方块通过 —— 实测就是这条
    // 让 k_mwe60wh8 复用 50 次、一次铁锭都没有。
    const CRAFTABLE = /(镐|斧|剑|铲|锄|工作台|熔炉|箱子|木棍|火把|梯子|门|床|锭|面包)$/
    const craftIntent = c.craft || (wants.length && wants.every(w => CRAFTABLE.test(w.cn)))
    if (craftIntent) {
      return fail(`要 ${wants.map(w => w.cn).join('/')}，但背包里一个都没多` +
        `（方块动了 ${blocks < 0 ? '读不到' : blocks + ' 格'}也算不上做成了）`)
    }
    // 挖通道类：产物当场又垫脚/用掉了，背包不涨，但方块真的动了
    if (worldChanged) return done(1, `方块动了 ${blocks} 格`)
    return fail(`要 ${wants.map(w => w.cn).join('/')}，跑完还是 ${targetDelta.map(x => x.d).join('/')}` +
      `（背包 ${inv.totalBefore}->${inv.totalNow}，方块 ${blocks < 0 ? '读不到' : blocks + ' 格'}）`)
  }

  // ---- 2. 吃东西：食物减少是**正常**的，看饱食度/食物消耗 ----
  if (c.eat && !c.consume) {
    if (ate !== null && ate > 0) return done(1, `饱食度 +${ate}`)
    if (foodUsed < 0) return done(1, `吃掉了 ${-foodUsed} 份食物`)
    if (inv.gainedTotal > 0) return done(inv.gainedTotal, `背包 +${inv.gainedTotal}`)
    return fail(`说是弄吃的，但没吃也没多出吃的（背包 ${inv.totalBefore}->${inv.totalNow}）`)
  }

  // ---- 3. 放置/整理/消耗 ----
  if (c.consume && !c.produce) {
    if (inv.lostTotal > 0) return done(inv.lostTotal, `背包 -${inv.lostTotal}`)
    if (worldChanged) return done(1, `方块动了 ${blocks} 格`)
    return fail(`东西没出手（背包 ${inv.totalBefore}->${inv.totalNow}，方块没动）`)
  }

  // ---- 4. 走 / 搬 ----
  if (!c.stay && (c.move || c.travel)) {
    if (moved !== null && moved >= 2) return done(1, `位移 ${moved.toFixed(1)} 格`)
    if (worldChanged) return done(1, `方块动了 ${blocks} 格`)
    if (inv.gainedTotal > 0) return done(inv.gainedTotal, `背包 +${inv.gainedTotal}`)
    return fail(`说要去/要搬，人只动了 ${moved === null ? '?' : moved.toFixed(1)} 格，背包和方块都没变`)
  }

  // ---- 5. 产出型（没有点名产物）----
  if (c.produce && !c.consume && !c.move) {
    if (inv.gainedTotal > 0) return done(inv.gainedTotal, `背包 +${inv.gainedTotal}`)
    if (worldChanged) return done(1, `方块动了 ${blocks} 格`)
    return fail(`背包没增加（${inv.totalBefore}->${inv.totalNow}）、方块也没动` +
      `（${blocks < 0 ? '读不到' : blocks + ' 格'}）`)
  }

  // ---- 6. 兜底：五个维度里总得动一个 ----
  const anyChange = inv.gainedTotal > 0 || inv.lostTotal > 0 || worldChanged ||
    heldChanged || (ate !== null && ate > 0) || (moved !== null && moved >= 2)
  if (!anyChange) {
    return fail(`背包没变、方块没变、手持没变、位置也没动（${moved === null ? '?' : moved.toFixed(1)} 格）` +
      ' —— 这一趟什么都没发生')
  }
  return done(1, '有变化')
}

module.exports = {
  judgeTask,
  wantedItems,
  classify,
  invDelta,
  worldSig,
  worldDiffCount,
  ITEM_DICT,
  FOOD
}
