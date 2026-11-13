'use strict'
/**
 * 修 #10 / #11 / #12 的验证脚本。
 *
 * 这三条都属于"写好了但没接上"或者"顺序写错了"，
 * 靠读代码看不出来 —— 必须跑起来看输出去哪了。
 *
 * 不连服务器，用假 bot / 假 clock 验证。
 */

const path = require('path')
const fs = require('fs')
const os = require('os')

let pass = 0
let fail = 0
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'unhuman-'))

async function main () {
  // ================================================================
  console.log('\n[#10 心情判定：energy=0 该喊累，不是一直烦]')
  {
    const Mood = require('../src/mood')
    const m = new Mood(tmp())

    // UNHUMAN-SCAN 里实测的那组数
    m.energy = 0
    m.spirit = 0.9986
    m.irritation = 0.805
    m.satisfaction = 0.998
    ok(m.state() === 'tired', '实测数据（energy=0 烦躁 0.805）→ tired', m.state())
    ok(!/呛回去/.test(m.describe()), '不再说"谁跟你说话都想呛回去"', m.describe())
    ok(/困得不行|累了/.test(m.describe()), '说的是累', m.describe())
    console.log('    ' + m.describe())

    // 有精力 + 烦 → 还是该烦
    m.energy = 0.9; m.irritation = 0.8; m.spirit = 0.6; m.satisfaction = 0.5
    ok(m.state() === 'irritated', '精力够但很烦 → irritated', m.state())

    // 能出多种状态（不再永远同一张脸）
    const states = new Set()
    const cases = [
      [0, 0.99, 0.8, 0.99], [0.95, 0.9, 0.05, 0.9], [0.6, 0.2, 0.1, 0.5],
      [0.8, 0.6, 0.3, 0.7], [0.9, 0.85, 0.1, 0.85], [0.5, 0.5, 0.5, 0.5]
    ]
    for (const [e, s, i, sa] of cases) {
      m.energy = e; m.spirit = s; m.irritation = i; m.satisfaction = sa
      states.add(m.state())
    }
    ok(states.size >= 4, '一组不同数值能出 4 种以上状态', [...states].join(','))
    console.log('    状态种类：' + [...states].join(', '))

    // 烦躁会自己消下去（不用 33 分钟）
    m.energy = 0.5; m.irritation = 0.8; m._angeredAt = Date.now() - 15 * 60000
    m.tick(10)
    ok(m.irritation < 0.6, '15 分钟没人惹，烦躁降到 0.6 以下', m.irritation.toFixed(3))
    console.log('    10 分钟后 irritation=' + m.irritation.toFixed(3) + ' state=' + m.state())

    // 累了能恢复
    m.energy = 0.1
    m.rest(true)
    m.tick(10)
    ok(m.energy > 0.1, '歇着的时候精力能回来', m.energy.toFixed(3))
    m.rest(false)

    ok(typeof m.exhausted === 'function' && m.energy < 0.2 === m.exhausted(), 'exhausted() 能问"是不是累垮了"')
  }

  // ================================================================
  console.log('\n[#11 凌晨提时间：onLateNight 真的被调用了吗]')
  {
    // 先证明函数本身是好的
    const sp = require('../src/spontaneous')
    ok(typeof sp.onLateNight === 'function', 'onLateNight 存在于 spontaneous')

    // 再证明 main.js 里真的调了（上一版就是"写好了 0 次调用"）
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
    ok(/noteLateNight\s*\(\)/.test(src), 'main.js 里定义/调用了 noteLateNight')
    ok(/spontaneous\.onLateNight\(\)/.test(src), 'main.js 真的调了 spontaneous.onLateNight()')
    ok(/tickInnerState\s*\(\)/.test(src), 'tickInnerState 在主循环里')

    // 确认 noteLateNight 被 tickInnerState 调用（不是定义了没人用）
    const inner = src.slice(src.indexOf('tickInnerState ()'), src.indexOf('noteLateNight ()'))
    ok(/noteLateNight/.test(inner), 'tickInnerState 里调了 noteLateNight')

    // 概率：凌晨时段必须有机会说
    const realtime = require('../src/realtime')
    const late = { isVeryLate: true, isLate: true, clock: '04:00', text: '凌晨四点' }
    ok(realtime.timeRemarkChance(late) >= 0.3, '凌晨提时间的概率够高', String(realtime.timeRemarkChance(late)))

    // 真跑一次：把系统时间伪装成凌晨
    const ev = sp.onLateNight()
    // 现在不是凌晨，可能返回 null —— 所以看的是"凌晨时会怎样"
    console.log('    当前时段 onLateNight() → ' + (ev ? '会说话：「' + ev.situation + '」' : '不说（现在不是深夜，正常）'))

    // 节流：10 分钟内不该重复攒
    ok(/10 \* 60 \* 1000/.test(src), '有 10 分钟节流，不会每轮都念一遍时间')
  }

  // ================================================================
  console.log('\n[#12 游戏内时间进提示词]')
  {
    const SelfState = require('../src/selfstate')
    const { describeTod } = SelfState

    ok(typeof describeTod === 'function', 'describeTod 已导出')

    // 各时段都要有话说
    const bands = [
      [0, '天刚亮'], [3000, '白天'], [12000, '要黑了'],
      [13000, '黑下来'], [18000, '黑透'], [23200, '快亮'], [23500, '天亮了']
    ]
    let allOk = true
    for (const [tod, want] of bands) {
      const r = describeTod(tod)
      if (!r || !r.text.includes(want)) { allOk = false; console.log('    ✗ ' + tod + ' → ' + (r && r.text)) }
    }
    ok(allOk, '七个时段都能说清楚')

    // 黑夜要标出来
    ok(describeTod(18000).night === true, '深夜标记为危险')
    ok(describeTod(3000).night === false, '白天不标危险')
    ok(describeTod(null) === null, '读不到时间时不硬编')

    // 关键：真的出现在 prompt() 里
    const fakeBot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      inventory: { items: () => [{ name: 'stone_pickaxe', count: 1, durability: 100 }] },
      heldItem: { name: 'stone_pickaxe' },
      health: 20,
      food: 18,
      time: { timeOfDay: 18000 }        // 深夜
    }
    const ss = new SelfState(fakeBot, { log: () => {}, events: null })
    ss.known = ss.snapshot()
    const p = ss.prompt()
    ok(/时间：/.test(p), 'prompt() 里有"时间："这一行')
    ok(/天黑|危险/.test(p), '深夜时 prompt() 会提醒危险')
    console.log('    提示词片段：')
    p.split('\n').filter(l => /时间|注意/.test(l)).forEach(l => console.log('      ' + l))

    // 白天不该说危险
    fakeBot.time.timeOfDay = 4000
    ss.known = ss.snapshot()
    const p2 = ss.prompt()
    ok(/白天/.test(p2), '白天提示词说是白天')
    ok(!/外面在刷怪/.test(p2), '白天不吓唬他')

    // 边界：bot.time 缺失不能崩
    delete fakeBot.time
    ss.known = ss.snapshot()
    let crash = false
    try { ss.prompt() } catch (e) { crash = true }
    ok(!crash, 'bot.time 读不到时 prompt() 不崩')
  }

  // ================================================================
  console.log('\n[综合：这三条一起，仰头看看他现在的状态输出]')
  {
    const Mood = require('../src/mood')
    const SelfState = require('../src/selfstate')
    const m = new Mood(tmp())
    m.energy = 0.18; m.spirit = 0.55; m.irritation = 0.72; m.satisfaction = 0.4

    const bot = {
      entity: { position: { x: 12, y: 64, z: -8 } },
      inventory: { items: () => [{ name: 'stone_pickaxe', count: 1, durability: 60 }, { name: 'torch', count: 3 }] },
      heldItem: { name: 'stone_pickaxe' },
      health: 20, food: 17,
      time: { timeOfDay: 14500 }
    }
    const ss = new SelfState(bot, { log: () => {}, events: null })
    ss.known = ss.snapshot()

    console.log('\n    ── 心情 ──')
    console.log('    ' + m.describe())
    console.log('\n    ── 自己状况 ──')
    ss.prompt().split('\n').forEach(l => console.log('    ' + l))

    ok(m.state() === 'tired' || m.state() === 'irritated', '累+烦时能说出其中一个')
    ok(/时间：/.test(ss.prompt()), '时间进了提示词')
  }
}

main().then(() => {
  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过，${fail} 失败\n`)
  process.exit(fail ? 1 : 0)
}).catch(e => {
  console.error('\n测试崩了：' + (e && e.stack || e))
  process.exit(1)
})
