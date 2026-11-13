#!/usr/bin/env node
'use strict'
/**
 * UNHUMAN-SCAN 杂项三条（#15 / #16 / #13）的验证脚本，
 * 外加 #2 复读拦截的只读回归检查（不改复读逻辑）。
 *
 *   node scripts/test-unhuman-misc.js
 *
 * 全 mock：不连服务器、不调模型、不读写 data/runtime。
 */

const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const Talk = require(path.join(ROOT, 'src', 'talk'))
const writer = require(path.join(ROOT, 'src', 'memory', 'writer'))

let pass = 0
let fail = 0
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'unhuman-misc-'))

// ---------------- mock ----------------

function mkMem () {
  return {
    people: {},
    secrets: [],
    person (name) {
      if (!this.people[name]) this.people[name] = { trust: 0, notes: [] }
      return this.people[name]
    },
    remember () { return [] },
    maybeRemember () { return null },
    getSecrets () { return [] },
    markTold () {},
    add () {},
    peopleDigest () { return '（还不认识谁）' },
    placesDigest () { return '（还没记地方）' },
    recentSession () { return '' },
    lastSummary () { return null },
    addSecret () { return null }
  }
}

function mkBot (sent, name = 'XJJ') {
  return { username: name, chat (t) { sent.push(t) } }
}

function mkLLM (lines) {
  const q = lines.slice()
  return { async chat () { return { text: q.length ? q.shift() : '[不说]' } } }
}

function mkCtx (dir, extra = {}) {
  return Object.assign({
    dataDir: dir,
    log: () => {},
    cfg: { behavior: { chatDelayPerChar: 0, chatMinDelay: 0, chatMaxDelay: 1 } },
    busy: () => false,
    taskDesc: () => '',
    perceive: { brief: () => '' },
    taste: { prompt: () => '' },
    mood: { prompt: () => '', state: () => 'normal', irritation: 0, spirit: 0.5 },
    botNames: []
  }, extra)
}

function mkTalk (opts = {}) {
  const dir = opts.dir || tmp()
  const sent = []
  const bot = mkBot(sent)
  const llm = mkLLM(opts.lines || [])
  const mem = opts.mem || mkMem()
  const talk = new Talk(bot, llm, mem, mkCtx(dir, opts.ctx))
  // 每个 mkTalk 当成"一个新进程里的新 bot"：清掉进程级发言闸。
  // GLOBAL_SAY 是模块级共享的，不清的话前面用例说过的话会把这里的额度吃掉 ——
  // 实测表现就是「第 1 次说得出去 ✗ → 公屏 []」。这是测试隔离，不是放宽阈值。
  Talk.GLOBAL_SAY.lastAt = 0
  Talk.GLOBAL_SAY.window = []
  return { talk, sent, bot, llm, mem, dir }
}

async function main () {
  // ================================================================
  console.log('\n[#15 withThisThisBotTooMany：undefined 了吗]')
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'talk.js'), 'utf8')
    ok(!/withThisThisBotTooMany/.test(src), 'src/talk.js 里已经没有这个标识符')
    ok(typeof Talk.prototype.botChainTooLong === 'function', '改成 botChainTooLong 并定义了')

    // 名字像 bot 的玩家说话，必须不抛异常、而且真的能回
    for (const nm of ['XJJ1', 'Test1']) {
      const { talk, sent, dir } = mkTalk({ lines: ['在', '嗯'] })
      let threw = null
      try {
        // XJJ1 -> looksLikeBot true -> 走 botChain 分支；问句才会回
        for (let i = 0; i < 4; i++) await talk.onChat(nm, 'XJJ 你在吗？')
      } catch (e) { threw = e }
      ok(!threw, `${nm} 说话不抛异常`, threw ? threw.constructor.name + ': ' + threw.message : '')
      ok(talk.looksLikeBot(nm) === true, `${nm} 仍被认成 bot`)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  // ================================================================
  console.log('\n[#16 idleThinkSeconds：配置真的被读了吗]')
  {
    const srcMain = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
    ok(/idleThinkSeconds/.test(srcMain), 'main.js 里出现了 idleThinkSeconds')
    ok(!/sleep\(3000 \+ Math\.random\(\) \* 9000\)/.test(srcMain), '旧的固定 3~12 秒间隔已替换')

    const { Bot } = require(path.join(ROOT, 'main'))
    const fake = Object.create(Bot.prototype)

    for (const [sec, lo, hi] of [[60, 6000, 30000], [20, 3000, 10000], [8, 3000, 4000]]) {
      fake.cfg = { behavior: { idleThinkSeconds: sec } }
      const samples = Array.from({ length: 200 }, () => fake.idleThinkMs())
      const min = Math.min(...samples)
      const max = Math.max(...samples)
      ok(min >= lo && max <= hi, `idleThinkSeconds=${sec} -> ${min}~${max}ms`, `(期望 ${lo}~${hi})`)
    }
    fake.cfg = { behavior: {} }
    const d = fake.idleThinkMs()
    ok(d >= 6000 && d <= 30000, '配置缺失时回落到 60 秒档', `(${d}ms)`)
  }

  // ================================================================
  console.log('\n[#2 复读硬拦截：同一句话再说一次会怎样]')
  {
    const { talk, sent, dir } = mkTalk()
    const LINE = '东西带齐了，下去转转'
    const r1 = await talk.say(LINE)
    await new Promise(r => setTimeout(r, 5))
    const r2 = await talk.say(LINE)
    const r3 = await talk.say('东西带齐了 下去转转')   // 只差标点
    ok(r1 === true, '第 1 次说得出去')
    ok(r2 === false, '第 2 次（一字不差）被拦', `(sent=${sent.length})`)
    ok(r3 === false, '第 3 次（只改标点）也被拦', `(sent=${sent.length})`)
    ok(sent.length === 1, '公屏上只出现 1 条', JSON.stringify(sent))
    ok(talk.recentSaid.length === 1, 'recentSaid 只记了真正发出去的那条')
    fs.rmSync(dir, { recursive: true, force: true })

    // 不同的话照发
    const t2 = mkTalk()
    await t2.talk.say('下去转转')
    // say() 里有别人加的全局限速（5 秒 1 条 / 20 秒 8 条），这里只测"内容不同就该发"，
    // 把限速的计时器归零绕过去，免得用例被别处的阈值左右。
    // 注意两个时钟都要清：判定取的是"实例时钟"和"进程时钟"里更近的那个。
    t2.talk.lastSayAt = 0
    t2.talk.sayWindow = []
    Talk.GLOBAL_SAY.lastAt = 0
    Talk.GLOBAL_SAY.window = []
    await t2.talk.say('铁镐有了，能往下挖了')
    ok(t2.sent.length === 2, '不重复的话照发', JSON.stringify(t2.sent))
    fs.rmSync(t2.dir, { recursive: true, force: true })
  }

  // ================================================================
  console.log('\n[#13 记忆里的测试小号]')
  {
    const TEST = ['XJJHOME6', 'XJJINTG', 'XJJHOME87', 'XJJVER6']
    for (const n of TEST) {
      ok(writer.isTestAccount(n) === true, `${n} 判成测试号`)
      const v = writer.admit({ text: `第一次见到 ${n}`, kind: 'person', who: [n], importance: 0.6, emotion: 0.4 })
      ok(v.keep === false && v.reason === 'test account', `第一次见到 ${n} 不进记忆`, `(reason=${v.reason})`)
    }
    ok(writer.isTestAccount('XJJ') === false, '主账号 XJJ 不算测试号')
    ok(writer.isTestAccount('XJJ', 'XJJ') === false, '显式传主账号也不算')
    ok(writer.isTestAccount('Xylitol6983') === false, '真玩家 Xylitol6983 不算')
    // 线下划线/小写的新命名（别人的多实例 bot）——2026-11-13 实测漏网
    for (const n of ['XJJ_MAf3d32x', 'XJJ_S5wi3', 'XJJ_GD525', 'XJJMULTI2', 'XJJ_E2E6o5d', 'XJJ_MBf3d32x']) {
      ok(writer.isTestAccount(n) === true, `${n} 判成测试号`)
    }
    for (const n of ['XJJ', 'Xylitol6983', 'Steve', 'Alex_01', '老王']) {
      ok(writer.isTestAccount(n) === false, `${n} 不受影响`)
    }

    const real = writer.admit({ text: '第一次见到 Xylitol6983', kind: 'person', who: ['Xylitol6983'], importance: 0.6, emotion: 0.4 })
    ok(real.keep === true, '真玩家还是记下了', JSON.stringify(real.who))

    const mixed = writer.admit({ text: 'XJJHOME6 和 Xylitol6983 一起挖到铁', who: ['XJJHOME6', 'Xylitol6983'], importance: 0.6 })
    ok(mixed.keep === true && mixed.who.join() === 'Xylitol6983', '混着真人时只摘掉测试号', JSON.stringify(mixed.who))

    const srcTalk = fs.readFileSync(path.join(ROOT, 'src', 'talk.js'), 'utf8')
    ok(/isTestAccount/.test(srcTalk), 'talk.js 记人前也过了测试号判定')
  }

  // ================================================================
  console.log('\n[#13 尾巴：地名不是人]')
  {
    const Memory = require(path.join(ROOT, 'src', 'memory'))
    const dir = tmp()
    const m = new Memory(dir)
    m.goOnline()

    // coder 的 memory.note('标记起点', ...) 不该造出一个人
    m.note('标记起点', '起点 (100.48,59,14.3) 开始做路标')
    ok(!m.people['标记起点'], 'note(标记起点) 不建人')
    ok(m.journal.slice(-1)[0].why === 'place-not-person', 'journal 记 place-not-person')
    ok(!m.peopleDigest().includes('标记起点'), 'peopleDigest 里没有标记起点')

    // 真玩家名字带地名词，但说过话 -> 照记
    m.person('矿洞王')
    m.maybeRemember('矿洞王在哪啊，我在下面', { who: ['矿洞王'] })
    ok(m.people['矿洞王'].talked === true, '说过话打 talked 记号')
    ok(m.peopleDigest().includes('矿洞王'), '说过话的人照念')

    // 老数据：有档案但没说过话
    m.people['标记起点'] = { firstSeen: 1, lastSeen: 1, notes: ['起点 (100.48,59,14.3) 开始做路标'], gave: [], got: [], hits: 0, trust: 0, lastHitAt: 0 }
    ok(!m.peopleDigest().includes('标记起点'), '老的地名档案不念')

    // 有过互动 -> 放行
    m.hit('标记点0', 1)
    ok(m.people['标记点0'].interacted === true, '互动打 interacted 记号')
    ok(m.peopleDigest().includes('标记点0'), '被打过的照念')

    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ================================================================
  console.log('\n[#14 别人挨打：onFriendInDanger 真的接上了吗]')
  {
    const srcMain = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
    ok(/bot\.on\('entityHurt'/.test(srcMain), "main.js 订阅了 entityHurt")
    ok(/spontaneous\.onFriendInDanger\(/.test(srcMain), 'main.js 里调用了 onFriendInDanger')

    const { Bot } = require(path.join(ROOT, 'main'))
    const spontaneous = require(path.join(ROOT, 'src', 'spontaneous'))
    const f = Object.create(Bot.prototype)
    const logs = []
    const pushed = []
    f.bot = { username: 'XJJ', entity: { username: 'XJJ' } }
    f.log = (m) => logs.push(m)
    f.spont = { push: (ev) => pushed.push(ev) }

    // 快死了 -> 报
    f.onEntityHurt({ username: '老王', metadata: [] })
    ok(pushed.length === 1 && pushed[0].trigger === 'friendInDanger', '血量读不到也报（当作在挨打）', JSON.stringify(pushed[0] || {}))
    ok(logs.some(l => l.includes('老王') && l.includes('onFriendInDanger')), '日志证明触发', logs.join(' | '))

    // 血量读得到且不危险 -> 不报
    pushed.length = 0
    f.onEntityHurt({ username: '李四', metadata: { 9: 18 } })
    ok(pushed.length === 0, '血 18 不报')

    // 血量低 -> 报，且带上数字
    f.onEntityHurt({ username: '张三', metadata: { 9: 5 } })
    ok(pushed.length === 1 && /血 5/.test(pushed[0].situation), '血 5 报出来带数字', pushed[0] && pushed[0].situation)

    // 30 秒内同一个人只报一次
    const n1 = pushed.length
    f.onEntityHurt({ username: '张三', metadata: { 9: 4 } })
    ok(pushed.length === n1, '同一人 30 秒内不刷屏')

    // 怪挨打 / 自己挨打 都不管
    const n2 = pushed.length
    f.onEntityHurt({ name: 'zombie', type: 'mob' })
    f.onEntityHurt({ username: 'XJJ', metadata: { 9: 3 } })
    ok(pushed.length === n2, '怪和自己都不报')

    // peerHealth 读法
    ok(f.peerHealth({ health: 7 }) === 7, 'peerHealth 认 entity.health')
    ok(f.peerHealth({ metadata: { 9: 9.5 } }) === 9.5, 'peerHealth 认 metadata[9]')
    ok(f.peerHealth({ metadata: [] }) === null, '读不到就 null，不硬编')
  }

  // ================================================================
  console.log('\n[#4 说完就改主意：计划句被记下、走神降概率]')
  {
    const { Impulse } = require(path.join(ROOT, 'src', 'impulse'))

    // A. talk.js 记住计划
    const { talk, dir, sent } = mkTalk()
    await talk.say('下去转转')
    ok(sent.length === 1 && !!talk.lastIntention, '说了计划就记下来', JSON.stringify(talk.lastIntention))
    ok(talk.recentIntention().text === '下去转转', 'recentIntention() 读得到')
    await talk.say('嗯')     // 普通应答不覆盖
    ok(talk.recentIntention().text === '下去转转', '普通应答不覆盖计划')
    talk.lastIntention.at = Date.now() - 61000
    ok(talk.recentIntention() === null, '60 秒后自动过期')
    fs.rmSync(dir, { recursive: true, force: true })

    // B. impulse 读到计划 -> 概率打 1/4（不是硬拦）
    const logs = []
    const taste = { feel: () => 0, likes: () => [] }
    const mood = { spirit: 0.6, energy: 0.6 }
    const mkImp = (intention) => {
      const im = new Impulse({ log: s => logs.push(s), llm: { chat: async () => ({ text: '[继续]' }) }, actions: null, intention })
      im.taskStarted(); im.checkIntervalMs = 0
      return im
    }

    const rnd = Math.random
    Math.random = () => 0.99            // 不走神，但降概率的日志要在
    await mkImp(() => ({ text: '下去转转', at: Date.now() })).maybe(taste, mood, '先弄把木镐，不然什么都挖不动')
    Math.random = rnd
    const line = logs.find(l => /刚说了「下去转转」/.test(l))
    ok(!!line, 'impulse 读到了刚说的计划', line || '')
    ok(line && /0\.08 → 0\.02/.test(line), '走神概率从 0.08 打到 0.02（1/4）')

    logs.length = 0
    Math.random = () => 0.99
    await mkImp(() => null).maybe(taste, mood, '先弄把木镐')
    Math.random = rnd
    ok(!logs.some(l => /刚说了「/.test(l)), '没说过计划就不降概率')

    // C. 接线：main.js 把 talk.recentIntention 递给了 impulse
    const srcMain = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
    ok(/intention: \(\) => \(this\.talk && this\.talk\.recentIntention/.test(srcMain), 'main.js 注入了 intention 通道')
    ok(/this\.ctx\.intention/.test(fs.readFileSync(path.join(ROOT, 'src', 'impulse.js'), 'utf8')), 'impulse.js 读了 ctx.intention')
  }

  console.log('\n===== 结果 =====')
  console.log(`${pass} 通过，${fail} 失败`)
  if (fail) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
