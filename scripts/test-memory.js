'use strict'
// 记忆系统自测：写入判定、去重、人物档案、检索
const path = require('path')
const fs = require('fs')
const os = require('os')

const Memory = require('../src/memory')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aifriend-mem-'))
const m = new Memory(dir)
m.goOnline()

let pass = 0
let fail = 0
function ok (cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name) }
}

console.log('\n[写入判定]')
ok(m.maybeRemember('嗯') === null, '废话不记')
ok(m.maybeRemember('好') === null, '单字不记')
ok(m.maybeRemember('你好') === null, '打招呼不记')
ok(m.maybeRemember('卧槽这苦力怕差点把我炸死', { who: ['张三'] }) !== null, '有情绪的话要记')
ok(m.maybeRemember('张三给了我把铁镐', { who: ['张三'] }) !== null, '有信息的话要记')

console.log('\n[去重]')
const before = m.stats().entries
m.hit('王五', 1); m.hit('王五', 1); m.hit('王五', 1)
const after = m.stats().entries
ok(after - before <= 1, '同一件事反复发生只记一条（' + before + ' -> ' + after + '）')
ok(m.hitStats('王五').times === 3, '但次数要累加（3 次）')

console.log('\n[人物档案]')
m.got('张三', '铁镐')
m.gave('李四', '面包')
m.note('张三', '一起挖过矿')
const pd = m.peopleDigest()
ok(pd.includes('张三'), '记得张三')
ok(pd.includes('铁镐'), '记得张三给过铁镐')
ok(pd.includes('王五') && pd.includes('打我'), '记得王五打过我')
ok(pd.includes('不太待见'), '对王五有负面态度')

console.log('\n[地点]')
m.place('家', { x: 100, y: 64, z: 200 }, '自己盖的')
ok(m.placesDigest().includes('家'), '记得家在哪')

console.log('\n[检索]')
const r1 = m.remember('王五', { people: ['王五'] })
ok(r1.length > 0, '问王五能想起相关的事')
ok(r1[0].text.includes('王五'), '想起来的第一条跟王五有关')
const r2 = m.remember('铁镐')
ok(r2.some(e => e.text.includes('铁镐')), '问铁镐能想起铁镐的事')

console.log('\n[和解]')
m.forgive('王五')
ok(m.hitStats('王五').times === 0, '道歉后次数清零')
ok(m.peopleDigest().includes('王五'), '但人还在记忆里')

console.log('\n[持久化]')
m.save()
const m2 = new Memory(dir)
ok(m2.stats().entries === m.stats().entries, '重载后条目数一致')
ok(m2.peopleDigest().includes('张三'), '重载后还记得人')
ok(m2.getPlace('家') !== undefined, '重载后还记得地方')

console.log(`\n结果：${pass} 通过，${fail} 失败`)
fs.rmSync(dir, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
