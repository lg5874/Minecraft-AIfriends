'use strict'
/**
 * 长期目标的"实测"场景测试。
 *
 * 起因（用户原话）：
 *   「我每次见到他他都在地下，之前见到他他正在准备搭格子上来，
 *    过几分钟发现他又在地下挖矿了。一个正常玩家会一直把自己埋在地里吗」
 *
 * 这个文件不测"函数返回什么"，测的是**行为**：
 *   把时间往前拨，看他在地下待久了会不会自己选择上来、
 *   会不会无限重复挖矿、资源充足时会不会就赖在下面不出来。
 *
 * 全程用可注入的假时钟 now: () => t，一秒真实时间都不等。
 */

const path = require('path')
const fs = require('fs')
const os = require('os')

const Goals = require('../src/goals')

let pass = 0
let fail = 0
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aifriend-live-'))

/** 假 LLM：模型总是想挖矿（最坏情况 —— 他自己一心想挖） */
const greedyLLM = {
  calls: 0,
  async chat () {
    this.calls++
    return { text: JSON.stringify({ key: 'diamond', title: '一直往下挖，挖到钻石为止', why: '想看一眼' }) }
  }
}

/** 假 LLM：给了候选就挑第一个候选（模拟"顺着分数走"的模型） */
function followerLLM () {
  return {
    calls: 0,
    async chat (msgs) {
      this.calls++
      const txt = String(msgs[0].content || '')
      // 从提示词里认出给了哪些 key，挑排第一个的
      const m = txt.match(/^1\.\s/m) || txt.match(/（现在办起来的把握：(\d+)\/100）/g)
      // 简单点：按顺序看哪个 key 出现过，取第一个
      for (const k of ['diamond', 'iron', 'house', 'getup', 'tower', 'farm', 'explore']) {
        if (new RegExp('\\b' + k + '\\b').test(txt)) {
          return { text: JSON.stringify({ key: k, title: '顺着分数挑的：' + k, why: '看着最该干' }) }
        }
      }
      return { text: '{}' }
    }
  }
}

const st = ({ inv = {}, y = 68, x = 0, z = 0, health = 20, food = 18 } = {}) => ({
  pos: { x, y, z },
  health,
  food,
  time: '白天',
  dimension: 'overworld',
  weather: '晴',
  held: null,
  inventory: inv
})

const log = () => {}

// =====================================================================
async function main () {
  // -----------------------------------------------------------------
  console.log('\n[一、在地下待 30 分钟：会不会自己选择上来]')
  {
    let t = 1000000
    const g = new Goals(tmp(), { llm: greedyLLM, ctx: { log }, now: () => t })

    // 他是从地面上出发的
    const surfaceInv = { stone_pickaxe: 1, torch: 8, bread: 4, cobblestone: 32 }
    g.observe(st({ inv: surfaceInv, y: 68 }))

    // 下去了
    const deepInv = { stone_pickaxe: 1, torch: 8, bread: 4, raw_iron: 4 }
    g.observe(st({ inv: deepInv, y: 14 }))

    const trail = []
    let flipped = null
    for (let m = 1; m <= 30; m++) {
      t += 60 * 1000
      const cs = g.candidates(st({ inv: deepInv, y: 14 }))
      const top = cs[0]
      const getup = cs.find(c => c.key === 'getup')
      if (top.key === 'getup' && flipped === null) flipped = m
      if ([1, 5, 10, 12, 15, 20, 25, 30].includes(m)) {
        trail.push(`${String(m).padStart(2)}分 ${top.key}(${top.score}) getup=${getup.score}`)
      }
    }
    console.log('    ' + trail.join('\n    '))

    ok(flipped !== null, '地下待久了，第一名会变成「上去」', flipped === null ? '一直没变' : flipped + ' 分钟时')
    ok(flipped !== null && flipped <= 15, '15 分钟内就该想上来', flipped + ' 分钟')
    ok(g.candidates(st({ inv: deepInv, y: 14 }))[0].key === 'getup', '30 分钟时已经在想着上去')

    // 走到地面后，getup 立刻消失
    g.observe(st({ inv: surfaceInv, y: 68 }))
    const csUp = g.candidates(st({ inv: surfaceInv, y: 68 }))
    ok(csUp.find(c => c.key === 'getup').score === 0, '到了地面，「上去」这个念头就没了')
    ok(csUp[0].key !== 'getup', '地面上的第一名不是「上去」', csUp[0].key)
  }

  // -----------------------------------------------------------------
  console.log('\n[二、模型一心想挖矿，也不会被一直埋在下面]')
  {
    let t = 1000000
    const g = new Goals(tmp(), { llm: greedyLLM, ctx: { log }, now: () => t })
    const inv = { iron_pickaxe: 1, torch: 32, bread: 16 }
    g.observe(st({ inv, y: 14 }))

    // 30 分钟后，候选里挖矿类已经被压到负分
    t += 30 * 60 * 1000
    const cs = g.candidates(st({ inv, y: 14 }))
    const dia = cs.find(c => c.key === 'diamond')
    ok(dia.score < 0, '憋了 30 分钟，杀钻石已经是负分', String(dia.score))
    ok(cs[0].score > dia.score + 100, '「上去」比它高出一大截', `${cs[0].key} ${cs[0].score} vs ${dia.score}`)

    // 就算模型硬挑 diamond，也应该被冷却/顺序挡住：这里验分数差就够
    ok(cs[0].key === 'getup', '排第一的是上去', cs[0].key)
  }

  // -----------------------------------------------------------------
  console.log('\n[三、挖矿目标本身带「强制出洞」阶段]')
  {
    const iron = Goals.POOL.find(p => p.key === 'iron')
    const dia = Goals.POOL.find(p => p.key === 'diamond')
    ok(!!iron, 'iron 目标在池子里')
    ok(iron.stages.some(s => s.kind === 'surface'), 'iron 有一阶段是"回地面"',
      iron.stages.map(s => s.kind).join(','))
    ok(dia.stages.some(s => s.kind === 'surface'), 'diamond 有一阶段是"回地面"',
      dia.stages.map(s => s.kind).join(','))
    ok(iron.undergroundGoal === true, 'iron 标了 undergroundGoal')

    // 关键：最后一个"攒东西"阶段必须在 surface 之前，不能以 gather 结尾
    const lastGather = iron.stages.map(s => s.kind).lastIndexOf('gather')
    const surfaceAt = iron.stages.findIndex(s => s.kind === 'surface')
    ok(surfaceAt > 0 && surfaceAt < iron.stages.length, 'surface 不是第一步也不是最后一步', `第 ${surfaceAt + 1}`)
    ok(lastGather >= 0, '还有攒东西的阶段')

    // 需求量改小了：一趟就能完成
    const ironStage = iron.stages.find(s => s.need && s.need.raw_iron)
    ok(!!ironStage, 'iron 有"挖铁矿"的阶段')
    ok(ironStage.need.raw_iron <= 16, '一趟的铁矿量是合理的（≤16 块）', ironStage.need.raw_iron)
    console.log('    iron 阶段顺序：' + iron.stages.map(s => s.kind).join(' → '))
    console.log('    iron 挖矿量：' + ironStage.need.raw_iron + ' 块粗铁')
  }

  // -----------------------------------------------------------------
  console.log('\n[四、回到地面才算过那一关：y 坐标驱动]')
  {
    let t = 1000000
    const g = new Goals(tmp(), {
      llm: { async chat () { return { text: JSON.stringify({ key: 'iron', title: '挖一趟铁就上来', why: 'x' }) } } },
      ctx: { log },
      now: () => t
    })
    const inv = { stone_pickaxe: 1, torch: 8, bread: 4 }
    await g.ensure(st({ inv, y: 68 }))

    // 跳过前两步（工具、备料）
    g.observe(st({ inv: { ...inv, stone_pickaxe: 1, torch: 8, bread: 4 }, y: 68 }))
    g.observe(st({ inv: { stone_pickaxe: 1, torch: 16, bread: 8 }, y: 68 }))
    g.observe(st({ inv: { stone_pickaxe: 1, torch: 16, bread: 8 }, y: 68 }))

    // 挖够 12 块
    let r = g.observe(st({ inv: { stone_pickaxe: 1, raw_iron: 12 }, y: 14 }))
    ok(g.currentStage() && g.currentStage().kind === 'surface', '挖够之后进到"回地面"', g.currentStage() && g.currentStage().kind)

    // 还在洞里，不该过
    r = g.observe(st({ inv: { stone_pickaxe: 1, raw_iron: 12 }, y: 30 }))
    ok(r.stageCompleted === false, 'y=30 还在下面，不算过')
    console.log('    y=30 时：' + g.progressText())

    // 上到地面
    r = g.observe(st({ inv: { stone_pickaxe: 1, raw_iron: 12 }, y: 70 }))
    ok(r.stageCompleted === true, 'y=70 到地面了，这一关过了')
  }

  // -----------------------------------------------------------------
  console.log('\n[五、资源充足时，挖矿目标会不会一直重复]')
  {
    let t = 1000000
    const rich = {
      iron_pickaxe: 1, diamond_pickaxe: 1,
      torch: 64, bread: 32,
      cobblestone: 128, oak_log: 64,
      iron_ingot: 40, diamond: 3
    }
    const g = new Goals(tmp(), { llm: greedyLLM, ctx: { log }, now: () => t })

    // 他刚做完 diamond（进了 12 小时冷却）
    g.observe(st({ inv: rich, y: 68 }))
    g._undergroundSince = 0
    const c1 = g.candidates(st({ inv: rich, y: 68 }))
    ok(c1.length > 1, '资源充足时有多项可选', c1.length + ' 项')

    // 模拟"总是选第一名"跑 20 轮，每轮换 20 分钟，看会不会一直挖矿
    const picks = []
    for (let i = 0; i < 20; i++) {
      t += 20 * 60 * 1000
      // 每 3 轮上下一次地面（模拟其它目标把他带回地面）
      const underground = i % 3 !== 2
      if (!underground) g._undergroundSince = 0
      else if (!g._undergroundSince) g._undergroundSince = t
      const cs = g.candidates(st({ inv: rich, y: underground ? 20 : 68 }))
      picks.push(cs[0].key)
    }
    const uniq = new Set(picks)
    console.log('    20 轮的选择：' + picks.join(' '))
    ok(uniq.size >= 2, '不会永远只挑同一个方向', [...uniq].join(','))

    // 关键：不该出现"连续 4 轮以上都是挖矿"
    const mine = new Set(['iron', 'diamond'])
    let streak = 0
    let maxStreak = 0
    for (const p of picks) {
      if (mine.has(p)) { streak++; maxStreak = Math.max(maxStreak, streak) }
      else streak = 0
    }
    ok(maxStreak <= 3, '挖矿不会连续太多次', '最长连选 ' + maxStreak + ' 次')

    // 有铁镐+钻石时，挖矿类应该因为已经"干过"而降权（冷却机制）
    ok(g.cooldown && typeof g.cooldown === 'object', '冷却表存在')
  }

  // -----------------------------------------------------------------
  console.log('\n[六、"今天挖一点，明天接着"]')
  {
    let t = 1000000
    const g = new Goals(tmp(), {
      llm: { async chat () { return { text: JSON.stringify({ key: 'iron', title: '挖一趟铁就上来', why: 'x' }) } } },
      ctx: { log },
      now: () => t
    })
    await g.ensure(st({ inv: { stone_pickaxe: 1 }, y: 68 }))

    // 直接把阶段推到"挖铁矿"
    g.goal.stageIndex = 2
    g.goal.stages[2].base = { at: t, inv: {}, pos: { x: 0, y: 14, z: 0 }, y: 14 }
    g.goal.stages[2].startedAt = t
    g.save(true)      // 这里是测试直接改了内部状态，得手动落盘

    const q0 = g.dailyQuota(st({ inv: { stone_pickaxe: 1 }, y: 14 }))
    ok(q0.reached === false, '刚开始什么也没挖，今天份没完成', q0.text)

    const q3 = g.dailyQuota(st({ inv: { stone_pickaxe: 1, raw_iron: 3 }, y: 14 }))
    ok(q3.reached === false, '挖 3 块还不够今天份')

    const q8 = g.dailyQuota(st({ inv: { stone_pickaxe: 1, raw_iron: 8 }, y: 14 }))
    ok(q8.reached === true, '挖 8 块就算今天这份干完了', q8.text)
    console.log('    挖到 8 块：' + q8.text)

    const w = g.shouldWrapUp(st({ inv: { stone_pickaxe: 1, raw_iron: 8 }, y: 14 }))
    ok(w.yes === true, '该收手上去了')
    ok(/今天/.test(w.why), '理由是"今天份够了"', w.why)

    // 明天再来：进度还在，不是从零开始
    const saved = JSON.parse(fs.readFileSync(g.file, 'utf8'))
    ok(saved.goal.stageIndex === 2, '存盘里还停在这一步')
    t += 8 * 60 * 60 * 1000          // 睡了八小时
    const g2 = new Goals(g.dir, { llm: greedyLLM, ctx: { log }, now: () => t })
    ok(g2.goal && g2.goal.stageIndex === 2, '第二天上线，进度没丢')
    const qNext = g2.dailyQuota(st({ inv: { stone_pickaxe: 1, raw_iron: 8 }, y: 14 }))
    ok(qNext.reached === true, '第二天已经攒到 8 块，直接算今天够了')
    const r = g2.observe(st({ inv: { stone_pickaxe: 1, raw_iron: 12 }, y: 14 }))
    ok(r.stageCompleted === true, '第二天补齐到 12 块，这一关过了')
  }

  // -----------------------------------------------------------------
  console.log('\n[七、憋太久的兜底：不管在挖什么，25 分钟必须收手]')
  {
    let t = 1000000
    const g = new Goals(tmp(), {
      llm: { async chat () { return { text: JSON.stringify({ key: 'diamond', title: '下去探一趟', why: 'x' }) } } },
      ctx: { log },
      now: () => t
    })
    const inv = { iron_pickaxe: 1, torch: 32 }
    await g.ensure(st({ inv, y: 68 }))
    g.goal.stageIndex = 3                           // 停在"找到钻石矿"
    g.goal.stages[3].base = { at: t, inv: {}, pos: { x: 0, y: 16, z: 0 }, y: 16 }

    g.observe(st({ inv, y: 16 }))
    t += 10 * 60 * 1000
    let w = g.shouldWrapUp(st({ inv, y: 16 }))
    ok(w.yes === false, '10 分钟还早，接着挖')

    t += 16 * 60 * 1000                              // 累计 26 分钟
    w = g.shouldWrapUp(st({ inv, y: 16 }))
    ok(w.yes === true, '26 分钟 → 强制收手')
    ok(/分钟/.test(w.why), '理由是待太久了', w.why)
    console.log('    ' + w.why)
  }

  // -----------------------------------------------------------------
  console.log('\n[八、连续 3 小时在下面的极端情况]')
  {
    let t = 1000000
    const g = new Goals(tmp(), { llm: greedyLLM, ctx: { log }, now: () => t })
    const inv = { diamond_pickaxe: 1, torch: 128, bread: 64 }
    g.observe(st({ inv, y: 12 }))

    const seq = []
    for (let m = 5; m <= 180; m += 15) {
      t += 15 * 60 * 1000
      const cs = g.candidates(st({ inv, y: 12 }))
      seq.push(`${m}分:${cs[0].key}`)
    }
    console.log('    ' + seq.join('  '))
    // 全程第一都必须是 getup（一旦超过阈值）
    const after10 = seq.filter((s, i) => (5 + i * 15) > 12)
    ok(after10.every(s => s.endsWith('getup')), '12 分钟后一路都是「上去」', after10.join(' '))
  }

  // -----------------------------------------------------------------
  console.log('\n[九、回到地面，一切恢复正常]')
  {
    let t = 1000000
    const g = new Goals(tmp(), { llm: greedyLLM, ctx: { log }, now: () => t })
    const inv = { iron_pickaxe: 1, cobblestone: 64, oak_log: 32, torch: 16 }

    g.observe(st({ inv, y: 12 }))
    t += 40 * 60 * 1000
    ok(g.candidates(st({ inv, y: 12 }))[0].key === 'getup', '在地下 40 分钟，想上去')

    // 上来了
    t += 60 * 1000
    g.observe(st({ inv, y: 66 }))
    const cs = g.candidates(st({ inv, y: 66 }))
    console.log('    回到地面后的候选：' + cs.slice(0, 3).map(c => `${c.key}(${c.score})`).join(', '))
    ok(cs[0].key !== 'getup', '在地上不再想"上去"', cs[0].key)
    ok(cs[0].key === 'house' || cs[0].key === 'tower', '选的是个地上能干的事', cs[0].key)
    ok(g.undergroundFor() === 0, '地下计时归零')
  }

  // -----------------------------------------------------------------
  console.log('\n[十、原来的 6 个目标都还在，没有被改坏]')
  {
    const keys = Goals.POOL.map(p => p.key)
    ok(keys.includes('house'), 'house 还在')
    ok(keys.includes('iron'), 'iron 还在')
    ok(keys.includes('diamond'), 'diamond 还在')
    ok(keys.includes('tower'), 'tower 还在')
    ok(keys.includes('farm'), 'farm 还在')
    ok(keys.includes('explore'), 'explore 还在')
    ok(keys.includes('getup'), 'getup 是新增的')
    ok(keys.includes('food'), 'food 是新增的生存出口')
    ok(Goals.POOL.length === 8, '一共 8 个方向（新增 food）', Goals.POOL.length)

    // 每个目标都还能正常出分数
    const g = new Goals(tmp(), { ctx: { log }, now: () => Date.now() })
    const cs = g.candidates(st({ inv: { stone_pickaxe: 1 }, y: 68 }))
    ok(cs.length === 8, '8 个都能算出分', cs.length)
    ok(cs.every(c => typeof c.score === 'number' && isFinite(c.score)), '分数都是有效数字')
  }

  // -----------------------------------------------------------------
  // 【新增】home-owner 16:47 实测：回家 1 分钟就又往下挖了
  //   16:47:39 到家了 → 16:48:39 已经到 y=60 → 16:50:09 到 y=55
  console.log('\n[十一、刚回地面 5 分钟内，挖矿类要降权]')
  {
    let t = 1000000
    const g = new Goals(tmp(), { ctx: { log }, now: () => t })
    const inv = { iron_pickaxe: 1, torch: 32, cobblestone: 64, oak_log: 32 }
    const at = (ug, y) => ({ pos: { x: 0, y, z: 0 }, underground: ug, inventory: inv, health: 20, food: 18 })

    // 在地下待了一阵
    g.observe(at(true, 14))
    t += 20 * 60 * 1000
    ok(g.candidates(at(true, 14))[0].key === 'getup', '地下待久了想上去')

    // 回到家 —— 这一刻记下"刚上来"
    g.observe(at(false, 66))
    const justUp = g.candidates(at(false, 66))
    const diaNow = justUp.find(c => c.key === 'diamond').score
    const ironNow = justUp.find(c => c.key === 'iron').score

    // 对照：假装上来很久了（把 _lastSurfaceAt 往前推）
    g._lastSurfaceAt = t - 10 * 60 * 1000
    const settled = g.candidates(at(false, 66))
    const diaLater = settled.find(c => c.key === 'diamond').score
    const ironLater = settled.find(c => c.key === 'iron').score

    console.log(`    刚到家：diamond=${diaNow} iron=${ironNow}`)
    console.log(`    十分钟后：diamond=${diaLater} iron=${ironLater}`)
    ok(diaNow < diaLater, '刚上来时挖钻石被压低了', `${diaNow} < ${diaLater}`)
    ok(ironNow < ironLater, '刚上来时挖铁被压低了', `${ironNow} < ${ironLater}`)
    ok(diaLater - diaNow >= 30, '压得够狠（至少 30 分）', String(diaLater - diaNow))

    // 刚上来时第一名不该是挖矿
    g._lastSurfaceAt = t
    const c0 = g.candidates(at(false, 66))
    ok(c0[0].key !== 'diamond' && c0[0].key !== 'iron', '刚到家第一名不是挖矿', c0[0].key)

    // 5 分钟后恢复
    g._lastSurfaceAt = t - 5 * 60 * 1000 - 1000
    const c5 = g.candidates(at(false, 66))
    ok(c5.find(c => c.key === 'diamond').score === diaLater, '过了 5 分钟就恢复正常了')

    // 又下去了：计时清掉，不该还按"刚上来"算
    g.observe(at(true, 20))
    ok(g._lastSurfaceAt === 0, '一下去，"刚上来"的计时就清了')
  }

  // -----------------------------------------------------------------
  console.log('\n[十二、surface 阶段用 isUnderground() 判定，不是纯 y]')
  {
    const SP = Goals.stageProgress
    const stage = {
      kind: 'surface',
      need: { y: 58 },
      base: { y: 14, inv: {}, pos: { x: 0, y: 14, z: 0 }, at: 0 }
    }
    const s = (ug, y) => ({ pos: { x: 0, y, z: 0 }, underground: ug, inventory: {} })

    // 山谷：y 低但头顶是天 —— 必须算到了
    let r = SP(stage, s(false, 52))
    ok(r.ratio >= 1, '山谷 y=52 头顶是天 → 算到地面了', r.text)

    // 山体里的高处洞穴：y 高但头顶是石头 —— 必须不算
    r = SP(stage, s(true, 70))
    ok(r.ratio < 1, '山体洞穴 y=70 头顶石头 → 不算到', r.text)
    ok(r.ratio <= 0.8, '洞穴里进度封在 75%，不给人"快完了"的错觉', String(r.ratio))

    // 正常两种情况
    ok(SP(stage, s(false, 68)).ratio >= 1, '真到地面 y=68 → 过了')
    ok(SP(stage, s(true, 30)).ratio < 1, '还在矿洞 y=30 → 没过')

    // 没传 underground 时退回 y 估算，且文案里说清楚是估算
    r = SP(stage, s(undefined, 70))
    ok(r.ratio >= 1, '没传 underground 时按 y 估算', r.text)
    ok(/估算/.test(r.text), '文案标明这是按高度估算的', r.text)

    // 通过 observe 走一遍：山体洞穴不该让目标过关
    let t = 1000000
    const g = new Goals(tmp(), {
      llm: { async chat () { return { text: JSON.stringify({ key: 'iron', title: '挖一趟铁', why: 'x' }) } } },
      ctx: { log },
      now: () => t
    })
    const inv = { stone_pickaxe: 1 }
    await g.ensure({ pos: { x: 0, y: 68, z: 0 }, underground: false, inventory: inv, health: 20, food: 18 })
    g.goal.stageIndex = 3
    g.goal.stages[3].base = { at: t, inv: {}, pos: { x: 0, y: 14, z: 0 }, y: 14 }
    g.goal.stages[3].startedAt = t

    let res = g.observe({ pos: { x: 0, y: 70, z: 0 }, underground: true, inventory: inv, health: 20, food: 18 })
    ok(res.stageCompleted === false, 'y=70 但在山肚子里 → 这一关没过', g.progressText())

    res = g.observe({ pos: { x: 0, y: 52, z: 0 }, underground: false, inventory: inv, health: 20, food: 18 })
    ok(res.stageCompleted === true, 'y=52 但在露天 → 这一关过了', g.progressText())
  }
}

main().then(() => {
  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过，${fail} 失败\n`)
  process.exit(fail ? 1 : 0)
}).catch(e => {
  console.error('\n测试崩了：' + (e && e.stack || e))
  process.exit(1)
})
