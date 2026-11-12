'use strict'
// 衰减与遗忘自测
const path = require('path')
const fs = require('fs')
const os = require('os')

const Memory = require('../src/memory')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aifriend-decay-'))
let pass = 0, fail = 0
function ok (cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name) }
}

const m = new Memory(dir)
m.goOnline()

// 三种记忆
m.add({ text: '在河边随便走了走', kind: 'event', emotion: 0.1, importance: 0.2 })
m.add({ text: '跟张三在矿洞里差点被苦力怕炸死', kind: 'event', emotion: 0.95, importance: 0.9, who: ['张三'] })
m.add({ text: '答应帮李四挖钻石', kind: 'promise', importance: 0.7, who: ['李四'] })
m.add({ text: '记住：别在岩浆边上乱挖', kind: 'skill', importance: 0.8 })

// 用对象引用定位，文字会因模糊化而改变
const ids = {}
m.entries.forEach(e => {
  if (e.text.includes('河边')) ids.plain = e.id
  if (e.emotion >= 0.9) ids.intense = e.id
  if (e.text.includes('答应')) ids.promise = e.id
  if (e.text.includes('岩浆')) ids.lesson = e.id
})
const byId = id => m.entries.find(e => e.id === id)
const plain = () => byId(ids.plain)
const intense = () => byId(ids.intense)
const promise = () => byId(ids.promise)
const lesson = () => byId(ids.lesson)

// 模拟时间流逝：每次 tick(60) = 走过 1 游戏分钟
function advance (minutes) {
  m.clock.online = true
  for (let i = 0; i < minutes; i++) m.tick(60)
}

console.log('\n[刚记下]')
ok(plain().strength === 1, '普通事件强度 1.0')
ok(intense().protected, '刻骨铭心的事被标记为不衰减')
ok(promise().protected === false, '承诺不算刻骨铭心（靠 kind 保护）')

console.log('\n[过了 2 小时]')
advance(120)
ok(plain().strength < 1, '普通事件开始淡（' + plain().strength.toFixed(2) + '）')
ok(intense().strength === 1, '刻骨铭心的事没变')
ok(!promise().archived, '承诺还在')

console.log('\n[过了 12 小时]')
advance(600)
ok(plain().strength < 0.5, '普通事件淡了一半以上（' + plain().strength.toFixed(2) + '）')
ok(intense().strength === 1, '刻骨铭心的事还是没变')
ok(lesson().strength === 1, '学会的教训不忘')

console.log('\n[过了 50 小时]')
advance(2400)
ok(plain().fuzzy, '普通事件变成"记不清了"（' + plain().text + '）')
ok(intense().strength === 1, '刻骨铭心的事永远在')
ok(promise().strength === 1, '承诺永远在')

console.log('\n[归档]')
ok(plain().archived, '足够淡的会被归档')
ok(!intense().archived, '刻骨铭心的不会被归档')

console.log('\n[下线不计时]')
const before = m.clock.now()
m.goOffline()
// 模拟下线很久：时钟不该动
for (let i = 0; i < 100; i++) m.tick(60)
ok(m.clock.now() === before, '下线期间游戏时间不走')

console.log('\n[上线继续]')
m.goOnline()
advance(60)
ok(m.clock.now() > before, '上线后继续计时')

console.log(`\n结果：${pass} 通过，${fail} 失败`)
fs.rmSync(dir, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
