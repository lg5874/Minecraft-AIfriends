'use strict'
// 感知层与事件队列自测（不连服务器）
const { Perception } = require('../src/perceive')
const { EventQueue, TYPES } = require('../src/events')

let pass = 0, fail = 0
function ok (cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name) }
}

console.log('\n[方位]')
{
  const p = Object.create(Perception.prototype)
  ok(p.dirOf(0, -10) === '北', '正北')
  ok(p.dirOf(10, 0) === '东', '正东')
  ok(p.dirOf(0, 10) === '南', '正南')
  ok(p.dirOf(-10, 0) === '西', '正西')
  ok(p.dirOf(7, -7) === '东北', '东北')
  ok(p.dirOf(-7, 7) === '西南', '西南')
}

console.log('\n[距离说法]')
{
  const p = Object.create(Perception.prototype)
  ok(p.distWord(1) === '就在脚边', '很近的说法')
  ok(p.distWord(30) === '挺远', '很远的说法')
  ok(!/\d+\.\d+/.test(p.distWord(17.3)), '不会出现 17.3 这种精确到小数')
}

console.log('\n[事件队列]')
{
  const q = new EventQueue()
  ok(q.ripe().ripe === false, '空队列不该熟')

  q.push('player_near', {}, '张三走过来')
  ok(q.ripe().ripe === false, '一条不急的不该立刻熟')

  let woken = 0
  q.onWake(() => woken++)
  q.push('damage', {}, '你被打了一下')
  ok(woken === 1, '急件会立刻叫醒')

  const evs = q.drain()
  ok(evs.length === 2, '取出 2 条')
  ok(evs.every(e => e.read), '取出后标记已读')

  q.push('player_near', {}, 'A')
  q.push('item_pickup', {}, 'B')
  q.push('block_change', {}, 'C')
  ok(q.ripe().ripe === true, '攒够 3 条就熟')
}

console.log('\n[事件描述]')
{
  const q = new EventQueue()
  q.push('chat_me', { who: '张三' }, '张三跟你说：过来一下')
  const evs = q.drain()
  const desc = q.describe(evs)
  ok(desc.includes('张三'), '描述里带上谁')
  ok(/\d+ 秒前/.test(desc), '带上"几秒前"')
}

console.log('\n[事件类型表]')
{
  ok(TYPES.chat_me.urgent === true, '有人叫我 = 急件')
  ok(TYPES.damage.urgent === true, '挨打 = 急件')
  ok(TYPES.player_near.urgent === false, '有人路过 = 不急')
  ok(TYPES.block_change.urgent === false, '方块变化 = 不急')
}

console.log('\n[物品名翻译]')
{
  const { itemWord } = require('../src/perceive')
  ok(itemWord('stone_pickaxe') === '石镐', '工具名翻译')
  ok(itemWord('oak_planks') === '橡木木板', '材料名翻译')
  ok(itemWord(null) === '空手', '空手')
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
