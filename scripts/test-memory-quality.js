'use strict'
/**
 * 记忆质量测试：这玩意儿到底记不记得住"该记的"。
 *
 * 核心命题：记忆 ≠ 工作日志。
 *   该记的：关于人的印象、地点知识、重要事件、教训、承诺
 *   不该记的：我今天做了啥、任务执行结果、计划、廉价劳作、自言自语
 *
 * 跑法：node scripts/test-memory-quality.js
 *      node scripts/test-memory-quality.js --verbose
 *
 * 边界：只读 src/memory/**，不连服务器，不碰真实 data/。
 */

const path = require('path')
const fs = require('fs')
const os = require('os')

const Memory = require('../src/memory')
const writer = require('../src/memory/writer')
const { KINDS } = require('../src/memory/entry')

const VERBOSE = process.argv.includes('--verbose')

let pass = 0
let fail = 0
const failures = []

function ok (cond, name, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    failures.push(name)
    console.log('  ✗ ' + name + (extra ? '  ← ' + extra : ''))
  }
}

function section (t) {
  console.log('\n' + t)
}

// 每个用例一个干净的记忆库，避免互相污染
const tmpdirs = []
function fresh () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memq-'))
  tmpdirs.push(dir)
  const m = new Memory(dir)
  m.goOnline()
  return m
}

function cleanup () {
  for (const d of tmpdirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch (e) {}
  }
}

// ============================================================
// 20 条典型输入
// ============================================================
//
// want: 'keep' = 该记 / 'drop' = 不该记
// kind: 期望的记忆种类（可选）
// about: 期望里面带上的人或地点（可选）
// 这 20 条来自真实 memory.json 里的流水账 + BACKLOG 里说要记的三类

const CASES = [
  // ---------- 不该记：任务流水账（真实数据里 141/212 条长这样）----------
  {
    id: 1,
    text: '把脚边那块andesite挖了看看下面是什么颜色。 -> 啥也没挖',
    want: 'drop',
    why: '任务 + 执行结果，典型的流水账'
  },
  {
    id: 2,
    text: '把圆石放进背包留着，先去用木斧砍点橡木原木补充木材。',
    want: 'drop',
    why: '计划句，还没发生任何事'
  },
  {
    id: 3,
    text: '用石斧把庇护所周边剩下的树干砍了，攒点木头做把石镐备着。 -> 用石斧砍了0棵树，原木从0个变成0个，石镐没能做成，最后换回石剑',
    want: 'drop',
    why: '任务日志 + 数字结果，什么都没得到'
  },
  {
    id: 4,
    text: '用石镐在阶梯矿道尽头继续向前挖，找煤和铁。 -> 沿矿道向前挖了0块（圆石+1），煤+0，生铁+0',
    want: 'drop',
    why: '挖了 0 块，纯日志'
  },
  {
    id: 5,
    text: '把背包里的圆石和安山岩整理进箱子，腾出空间。 -> 整理完成：往箱子存了 240 件东西（圆石剩 203 块、安山岩剩 35 块、泥土剩 46 块），背包空间腾出来了',
    want: 'drop',
    why: '整理背包不是记忆'
  },
  {
    id: 6,
    text: '先看看周围地形和资源分布，再决定接下来挖矿还是砍树。 -> 我在 (66,43,-93) 周围：granite:457 coal_ore:55 stone:5006 diorite',
    want: 'drop',
    why: '坐标 + 方块统计，是日志不是印象'
  },
  {
    id: 7,
    text: '用8个圆石合成一个熔炉。 -> 熔炉没做出来（可能缺工作台或圆石），剩圆石 216 块',
    want: 'drop',
    why: '失败报告，没提炼出规则'
  },
  {
    id: 8,
    text: '我说：嗯 回来了',
    want: 'drop',
    why: '自言自语 + 废话'
  },
  {
    id: 9,
    text: '把这块青金石矿周围挖一圈，看看有没有连着的矿脉。 -> 做不出石镐，青金石矿挖不了',
    want: 'drop',
    why: '计划 + 失败，没有任何新知识'
  },
  {
    id: 10,
    text: '在河边随便走了走',
    want: 'drop',
    why: '没有信息量（原有测试也要求它衰减成"记不清"）'
  },

  // ---------- 该记：关于人 ----------
  {
    id: 11,
    text: '张三帮我打死了僵尸',
    want: 'keep',
    kind: KINDS.PERSON,
    about: '张三',
    why: '有人帮了我 —— 这是对人的印象'
  },
  {
    id: 12,
    text: '李四趁我不注意把我箱子里的铁锭全偷走了',
    want: 'keep',
    kind: KINDS.GRIEVANCE,
    about: '李四',
    why: '恩怨，要记很久'
  },
  {
    id: 13,
    text: '王五说我挖矿跟蜗牛一样慢，笑死',
    want: 'keep',
    about: '王五',
    why: '有情绪 + 关于人'
  },

  // ---------- 该记：地点知识 ----------
  {
    id: 14,
    text: '这山洞里有铁矿',
    want: 'keep',
    kind: KINDS.PLACE,
    about: '山洞',
    why: '地点知识 —— 下次来能用上'
  },
  {
    id: 15,
    text: '北边那个峡谷底下全是钻石',
    want: 'keep',
    kind: KINDS.PLACE,
    about: '峡谷',
    why: '地点 + 资源，最值钱的一类记忆'
  },

  // ---------- 该记：承诺（不衰减）----------
  {
    id: 16,
    text: '我答应张三给他铁',
    want: 'keep',
    kind: KINDS.PROMISE,
    about: '张三',
    why: '承诺，永远不忘'
  },

  // ---------- 该记：危险 / 生死 ----------
  {
    id: 17,
    text: '上次在这儿差点被苦力怕炸死',
    want: 'keep',
    about: '这儿',
    why: '刻骨铭心的经历'
  },
  {
    id: 18,
    text: '死了：XJJ was slain by Zombie',
    want: 'keep',
    why: '机器死法要翻成人话，而不是丢掉'
  },

  // ---------- 该记：教训 ----------
  {
    id: 19,
    text: '教训：用背包里的圆石和木棍再做一把石镐，换掉手里的石斧。 没成（木棍只有 1 根做不了新的）',
    want: 'keep',
    kind: KINDS.SKILL,
    why: '失败原因能提炼成规则（缺木棍），不是纯报错'
  },

  // ---------- 不该记：模型/网络事故（不是他的教训）----------
  {
    id: 20,
    text: '教训：弄点木头，先做把镐 没成（模型调用失败: HTTP 403 <!DOCTYPE html>）',
    want: 'drop',
    why: '这是运维事故，不是他的记忆'
  }
]

// ============================================================

console.log('='.repeat(62))
console.log('记忆质量测试：记忆只存"值得记的"，不存"我今天做了啥"')
console.log('='.repeat(62))

// ------------------------------------------------------------
section('[一] 20 条典型输入：该记的记，不该记的别记')
// ------------------------------------------------------------

const verdicts = []
for (const c of CASES) {
  const v = writer.admit({ text: c.text })
  verdicts.push({ c, v })

  const kept = v.keep
  const expectKeep = c.want === 'keep'
  const label = `#${c.id} ${c.want === 'keep' ? '记' : '不记'}：${c.text.slice(0, 34)}${c.text.length > 34 ? '…' : ''}`

  if (kept !== expectKeep) {
    ok(false, label, `期望 ${c.want}，实际 ${kept ? 'keep(' + v.reason + ')' : 'drop(' + v.reason + ')'} —— ${c.why}`)
    continue
  }

  // 种类对不对
  if (c.kind && kept && v.kind !== c.kind) {
    ok(false, label, `种类应为 ${c.kind}，实际 ${v.kind} —— ${c.why}`)
    continue
  }

  // 关于谁 / 关于哪儿
  if (c.about && kept) {
    const hay = v.text + ' ' + (v.who || []).join(' ') + ' ' + (v.where || '')
    if (!hay.includes(c.about)) {
      ok(false, label, `应该带上「${c.about}」，实际「${v.text}」who=${JSON.stringify(v.who)}`)
      continue
    }
  }

  ok(true, label)
  if (VERBOSE && kept) {
    console.log(`       → [${v.kind}] ${v.text}` + (v.who.length ? `  who=${v.who.join(',')}` : ''))
  }
}

const keptCount = verdicts.filter(x => x.v.keep).length
const dropCount = verdicts.length - keptCount
console.log(`\n  统计：20 条里记下 ${keptCount} 条，丢掉 ${dropCount} 条`)

// ------------------------------------------------------------
section('[二] 写进记忆库：内容和归属都对吗')
// ------------------------------------------------------------

{
  const m = fresh()

  // 挖石头：不记
  const r1 = m.add({ text: '挖了块石头', kind: 'event', importance: 0.4, emotion: 0.3 })
  ok(r1 === null, '喂「挖了块石头」→ 不进记忆')
  ok(m.stats().entries === 0, '记忆库还是空的（0 条）')
  ok(m.stats().journal === 1, '但落进了工作日志（1 条）')

  // 张三帮我打死僵尸：记，而且挂在张三名下
  const r2 = m.add({ text: '张三帮我打死了僵尸' })
  ok(r2 !== null, '喂「张三帮我打死了僵尸」→ 进记忆')
  ok(r2 && (r2.who || []).includes('张三'), '而且这条挂在「张三」名下：' + JSON.stringify(r2 && r2.who))
  ok(r2 && r2.kind === KINDS.PERSON, '种类是 person（关于人的印象），实际 ' + (r2 && r2.kind))

  // 山洞有铁矿：记，而且是地点
  const r3 = m.add({ text: '这山洞里有铁矿' })
  ok(r3 !== null, '喂「这山洞里有铁矿」→ 进记忆')
  ok(r3 && r3.kind === KINDS.PLACE, '种类是 place（地点知识），实际 ' + (r3 && r3.kind))
  ok(r3 && String(r3.text + ' ' + r3.where).includes('山洞'), '内容提到「山洞」：' + (r3 && r3.text))

  // 答应给铁：记，而且不衰减
  const r4 = m.add({ text: '我答应张三给他铁' })
  ok(r4 !== null, '喂「我答应张三给他铁」→ 进记忆')
  ok(r4 && r4.kind === KINDS.PROMISE, '种类是 promise，实际 ' + (r4 && r4.kind))
  ok(r4 && (r4.who || []).includes('张三'), '挂在「张三」名下：' + JSON.stringify(r4 && r4.who))

  // 承诺经过很久也不淡
  m.clock.online = true
  for (let i = 0; i < 60 * 24 * 7; i++) m.tick(60)   // 走 7 天游戏时间
  const p = m.entries.find(e => e.kind === KINDS.PROMISE)
  ok(p && p.strength === 1, '过了 7 天，承诺强度还是 1.0（不衰减），实际 ' + (p && p.strength))
  ok(p && !p.archived, '承诺没被归档')

  // 地点也不忘
  const pl = m.entries.find(e => e.kind === KINDS.PLACE)
  ok(pl && pl.strength === 1, '地点知识也不衰减，实际 ' + (pl && pl.strength))

  // 普通事件照样会忘（衰减机制没被破坏）
  const plain = m.add({ text: '在树林里瞎转了两圈，有点无聊', force: true, kind: 'event', emotion: 0.1, importance: 0.2 })
  for (let i = 0; i < 60 * 50; i++) m.tick(60)       // 再走 50 小时
  ok(plain && plain.strength < 0.5, '普通事件 50 小时后淡掉了（' + (plain && plain.strength.toFixed(2)) + '）—— 遗忘还在')
}

// ------------------------------------------------------------
section('[三] 模糊：记不清细节，但记得大概')
// ------------------------------------------------------------

{
  const m = fresh()
  const e = m.add({ text: '跟张三一起下了个矿洞', kind: 'event', emotion: 0.1, importance: 0.2, who: ['张三'] })
  m.clock.online = true
  for (let i = 0; i < 60 * 60; i++) m.tick(60)   // 60 小时
  ok(e.fuzzy === true, '60 小时后变成"记不清"状态')
  ok(!/下了个矿洞/.test(e.text), '细节没了，不再是原句：' + e.text)
  ok(/张三|有人/.test(e.text), '但还留着"跟谁"这个大概：' + e.text)
  ok(e.certainty < 0.85, '确信度降下来了（' + e.certainty.toFixed(2) + '）')
}

// ------------------------------------------------------------
section('[四] 清理历史流水账（65+ 条那种）')
// ------------------------------------------------------------

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memq-'))
  tmpdirs.push(dir)

  // 造一个 v2 老库：混着流水账和真记忆
  const legacy = {
    version: 2,
    entries: [
      // ---- 流水账（该清）----
      { id: 'a1', text: '把脚边那块andesite挖了看看下面是什么颜色。 -> 啥也没挖', kind: 'event', who: [], emotion: 0.3, importance: 0.4, strength: 1, createdAt: 0, recallCount: 0 },
      { id: 'a2', text: '用石斧砍了0棵树，原木从0个变成0个', kind: 'event', who: [], emotion: 0.3, importance: 0.4, strength: 1, createdAt: 0, recallCount: 0 },
      { id: 'a3', text: '我说：嗯 回来了', kind: 'person', who: [], emotion: 0, importance: 0.5, strength: 1, createdAt: 0, recallCount: 0 },
      { id: 'a4', text: '整理完成：往箱子存了 240 件东西（圆石剩 203 块）', kind: 'event', who: [], emotion: 0.3, importance: 0.4, strength: 1, createdAt: 0, recallCount: 0 },
      // ---- 真记忆（该留）----
      { id: 'b1', text: '张三帮我打死了僵尸', kind: 'person', who: ['张三'], emotion: 0.6, importance: 0.6, strength: 0.7, createdAt: 10, recallCount: 2 },
      { id: 'b2', text: '这山洞里有铁矿', kind: 'place', who: [], where: '山洞', emotion: 0.3, importance: 0.6, strength: 0.9, createdAt: 20, recallCount: 0 },
      { id: 'b3', text: '我答应张三给他铁', kind: 'promise', who: ['张三'], emotion: 0.2, importance: 0.7, strength: 1, createdAt: 30, recallCount: 1 },
      { id: 'b4', text: '李四偷了我箱子里的铁锭', kind: 'grievance', who: ['李四'], emotion: 0.8, importance: 0.8, strength: 1, createdAt: 40, recallCount: 0, protected: true }
    ],
    people: { 张三: { notes: [], gave: [], got: [], hits: 0, trust: 2, lastSeen: 50 } },
    places: { 家: { x: 1, y: 64, z: 2, note: '自己盖的' } },
    session: [],
    secrets: [],
    summaries: [],
    lastDecayAt: 0
  }
  fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify(legacy), 'utf8')

  const m = new Memory(dir)   // 构造时自动迁移 v2 -> v3
  const st = m.stats()

  ok(st.entries === 4, '8 条老数据里只留下 4 条真记忆，实际 ' + st.entries)
  ok(st.journal >= 4, '清出去的 4 条进了工作日志，实际 ' + st.journal)

  const texts = m.entries.map(e => e.text)
  ok(!texts.some(t => /->/.test(t)), '没有一条带 "->" 的任务日志了')
  ok(!texts.some(t => /^我说：/.test(t)), '没有一条「我说：」自言自语了')
  ok(texts.some(t => t.includes('张三')), '张三那条还在')
  ok(texts.some(t => t.includes('山洞')), '山洞那条还在')
  ok(texts.some(t => t.includes('答应')), '承诺那条还在')

  // 强度要尊重现状，别让清理变成"恢复记忆"
  const b1 = m.entries.find(e => e.id === 'b1')
  ok(b1 && Math.abs(b1.strength - 0.7) < 0.001, '留下的条目保留原来的衰减强度（0.7），实际 ' + (b1 && b1.strength))

  // 人物档案不能因为清理丢
  ok(m.people.张三 && m.people.张三.trust === 2, '人物档案（信任值）没丢')
  ok(m.places.家, '地点坐标没丢')

  // 幂等：再清一次结果一样
  const rep = m.purgeLogs()
  ok(rep.removed === 0 && rep.after === 4, '再清理一次：0 条被删（幂等），还是 4 条')

  // 清完能正常检索
  const r = m.remember('张三')
  ok(r.length > 0 && r.some(e => (e.who || []).includes('张三')), '清完还能想起张三')
}

// ------------------------------------------------------------
section('[五] 记忆不能退化成"什么都记"')
// ------------------------------------------------------------

{
  const m = fresh()
  const logs = [
    '挖了块石头',
    '把圆石放进箱子',
    '用木斧砍了两根原木',
    '走到山坡上看了看',
    '整理了一下背包',
    '看了看周围的地形',
    '合成了 4 个木板',
    '在洞里走了两圈'
  ]
  let stored = 0
  for (const t of logs) if (m.add({ text: t })) stored++
  ok(stored === 0, `8 条廉价劳作一条都没进记忆（实际进了 ${stored} 条）`)
  ok(m.stats().entries === 0, '记忆库保持 0 条')
  ok(m.stats().journal === 8, '8 条全在工作日志里')

  // 但同一批文字里带真信号的，要捞出来
  const real = [
    '张三帮我把僵尸打死了',
    '这山洞里有铁矿',
    '答应给李四三块铁',
    '差点被苦力怕炸死'
  ]
  let got = 0
  for (const t of real) if (m.add({ text: t })) got++
  ok(got === 4, `4 条真记忆全记住了（实际 ${got} 条）`)
}

// ------------------------------------------------------------
section('[六] 去重：同一件事反复发生，合并而不是刷屏')
// ------------------------------------------------------------

{
  const m = fresh()
  m.add({ text: '张三帮我打死了僵尸' })
  m.add({ text: '张三帮我打死了僵尸' })
  m.add({ text: '张三帮我打死了僵尸' })
  ok(m.stats().entries === 1, '同一件事说三遍只留 1 条，实际 ' + m.stats().entries)
  const e = m.entries[0]
  ok((e.repeat || 1) === 3, '但记了重复次数（3 次），实际 ' + (e.repeat || 1))
  ok(e.importance > 0.6, '重复让重要性上升（' + e.importance.toFixed(2) + '）')
}

// ------------------------------------------------------------
section('[七] 检索：按人、按地方、按内容都能想起来')
// ------------------------------------------------------------

{
  const m = fresh()
  m.add({ text: '张三帮我打死了僵尸' })
  m.add({ text: '这山洞里有铁矿' })
  m.add({ text: '李四偷了我箱子里的铁锭' })
  m.add({ text: '我答应张三给他铁' })

  const byPerson = m.remember('张三', { people: ['张三'] })
  ok(byPerson.length > 0 && (byPerson[0].who || []).includes('张三'), '问张三 → 第一条就是张三的事')

  const byPlace = m.remember('山洞')
  ok(byPlace.some(e => e.text.includes('山洞')), '问山洞 → 想起山洞那条')

  const byOre = m.remember('铁矿')
  ok(byOre.some(e => /铁/.test(e.text)), '问铁矿 → 想起跟铁有关的')
}

// ------------------------------------------------------------
section('[八] 衰减设计没被动过（这是设计，不是 bug）')
// ------------------------------------------------------------

{
  const d = require('../src/memory/decay')
  ok(d.HALF_LIFE[KINDS.EVENT] === 6 * 60, '普通事件半衰期还是 6 小时')
  ok(d.HALF_LIFE[KINDS.GRIEVANCE] === 40 * 60, '恩怨半衰期还是 40 小时')
  ok(d.HALF_LIFE[KINDS.PROMISE] === Infinity, '承诺还是不忘')
  ok(d.HALF_LIFE[KINDS.SKILL] === Infinity, '技能/教训还是不忘')
  ok(d.HALF_LIFE[KINDS.PLACE] === Infinity, '地点还是不忘')

  const m = fresh()
  const hard = m.add({ text: '差点被苦力怕炸死，真的刻骨铭心', kind: 'event', emotion: 0.9, importance: 0.5, force: true })
  ok(hard.protected === true, '情感 ≥0.7 的仍然永不衰减')
  const big = m.add({ text: '这是一件天大的事', kind: 'event', emotion: 0.2, importance: 0.9, force: true })
  ok(big.protected === true, '重要性 ≥0.8 的仍然永不衰减')
}

// ------------------------------------------------------------

console.log('\n' + '='.repeat(62))
if (fail) {
  console.log(`结果：${pass} 通过，${fail} 失败`)
  console.log('\n失败的：')
  for (const f of failures) console.log('  - ' + f)
} else {
  console.log(`结果：${pass} 通过，${fail} 失败 ✓ 全过`)
}
console.log('='.repeat(62))

cleanup()
process.exit(fail ? 1 : 0)
