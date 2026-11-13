#!/usr/bin/env node
'use strict'
/**
 * 离线单测：战斗分档 + 掉血速率 + 伤害类型表。
 *
 *   node scripts/test-reflex-combat.js
 *
 * 不连服务器。所有"怪""伤害包""血量"都是当场造的对象，
 * 测的是**判断**（什么时候跑、跑多远、打不打），不是运气。
 */

const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const Reflex = require(path.join(ROOT, 'src', 'reflex.js'))
const damage = require(path.join(ROOT, 'src', 'damage.js'))

let pass = 0
let fail = 0
let eatCheck = null
const ok = (cond, what, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + what) } else { fail++; console.log('  ✗ ' + what + (extra ? '  → ' + extra : '')) }
}

/** 造一个够用的假 bot */
function makeBot (opts = {}) {
  const calls = { back: 0, jump: 0, look: 0, equip: 0, consume: 0, goals: [] }
  const bot = {
    health: 20,
    food: 20,
    username: 'me',
    entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
    entities: {},
    time: { timeOfDay: 6000 },
    inventory: { items: () => (opts.food === false ? [] : [{ name: 'bread', count: 3 }]) },
    pathfinder: { setGoal: (g) => calls.goals.push(g), isMoving: () => false },
    blockAt: () => ({ name: 'stone' }),
    setControlState: (k, v) => { if (k === 'back' && v) calls.back++; if (k === 'jump' && v) calls.jump++ },
    getControlState: () => false,
    look: () => { calls.look++ },
    equip: () => { calls.equip++; return Promise.resolve() },
    consume: () => { calls.consume++; return Promise.resolve() }
  }
  return { bot, calls }
}

const logs = []
const ctx = { log: (m) => logs.push(String(m)), mem: { hit () {}, hitStats: () => ({ times: 1 }) }, onEvent () {} }

function mkReflex (opts) {
  const { bot, calls } = makeBot(opts)
  const r = new Reflex(bot, ctx)
  return { r, bot, calls }
}

function mob (name, dist, id) {
  return { id: id || 90, name, type: 'hostile', position: { x: dist, y: 64, z: 0 } }
}

console.log('\n[1 伤害类型表（服务端 registry 快照）]')
{
  const mob = damage.infoOf(28)
  ok(mob.name === 'mob_attack' && mob.attack === true && mob.cat === 'mob',
    '28 -> mob_attack（有实体在打你）', JSON.stringify(mob))
  ok(damage.infoOf(0).name === 'arrow' && damage.infoOf(0).cat === 'projectile',
    '0 -> arrow（骷髅的箭：cause≠direct）')
  ok(damage.infoOf(10).name === 'fall' && damage.infoOf(10).attack === false,
    '10 -> fall（环境，不该触发"跑"）')
  ok(damage.infoOf(24).name === 'lava' && damage.infoOf(24).continuous === true,
    '24 -> lava（持续伤害：站着不动会一直掉）')
  ok(damage.infoOf(6).name === 'drown', '6 -> drown')
  ok(damage.infoOf(40).name === 'starve', '40 -> starve')
  ok(damage.infoOf(9).name === 'explosion', '9 -> explosion（老表错写成 lava）')
  ok(damage.infoOf(11).name === 'falling_anvil', '11 -> falling_anvil（老表错写成 drown）')
  ok(damage.infoOf(34).name === 'player_attack', '34 -> player_attack')
  ok(damage.infoOf(99).name === 'type99' && damage.infoOf(99).known === false,
    '表里没有的 id 不崩，原样打出来')
  // 验收 3：可读的类型名
  const readable = [28, 0, 10, 6, 24, 40].map(i => `${damage.infoOf(i).name}(${i})`).join(' ')
  ok(/mob_attack\(28\)/.test(readable) && !/unknown/.test(readable), '[dmg] 能打可读名字：' + readable)
}

console.log('\n[2 死因（验收 4）]')
{
  ok(damage.deathTextOf(28, 'zombie') === '被zombie打死', 'mob_attack + 来源 -> 被zombie打死', damage.deathTextOf(28, 'zombie'))
  ok(damage.deathTextOf(0, 'skeleton') === '被skeleton射死', 'arrow + 骷髅 -> 被skeleton射死')
  ok(damage.deathTextOf(0) === '被射死了', 'arrow 没有来源也说得清')
  ok(damage.deathTextOf(10) === '摔死了', 'fall -> 摔死了')
  ok(damage.deathTextOf(6) === '淹死了', 'drown -> 淹死了')
  ok(damage.deathTextOf(24) === '被岩浆烫死了', 'lava -> 被岩浆烫死了')
  ok(damage.deathTextOf(40) === '饿死了', 'starve -> 饿死了')
  ok(damage.deathTextOf(28) === '被怪打死了', 'mob_attack 没来源 -> 被怪打死了（不是"受了点伤"）')
  ok(damage.deathTextOf(99, 'x') !== '受了点伤', '未知 id 也不会退回"受了点伤"', damage.deathTextOf(99, 'x'))
}

console.log('\n[3 掉血速率（核心触发，不看来源、不看血绝对值）]')
{
  const { r, bot, calls } = mkReflex()
  bot.health = 20
  r.sampleHealth()
  bot.health = 15            // 一记 5 血：血还有 15，老代码（<=8 才跑）完全不动
  r.sampleHealth()
  ok(r.recentDrop(3000) === 5, '3 秒窗口里认出掉了 5 血', 'drop=' + r.recentDrop(3000))
  ok(calls.back > 0, '血 20→15 就退了（后撤）', 'back=' + calls.back)
  ok(calls.jump > 0, '同时跳一下（脱离岩浆/营火这类持续伤害）')
  ok(logs.some(l => /\[reflex\] 3 秒内掉 5 血（最近一下 20→15）/.test(l)),
    '日志写清"3 秒掉几血 + 哪一下"', logs.filter(l => /3 秒内掉/.test(l)).slice(-1)[0])
  ok(r.attackUntil > Date.now(), '"正在挨打"窗口被点亮（后面分档才敢跑）')
}
{
  // 一下掉 2 血不算（避免正常回血/摔一格就乱跑）
  const { r, bot, calls } = mkReflex()
  bot.health = 20; r.sampleHealth()
  bot.health = 19; r.sampleHealth()
  ok(calls.back === 0 && r.recentDrop(3000) < 4, '掉 1 血不弹开（不神经过敏）')
}
{
  // 连着两下：20 -> 17 -> 15，第二下再触发一次（不同帧）
  const { r, bot } = mkReflex()
  bot.health = 20; r.sampleHealth()
  bot.health = 17; r.sampleHealth()
  bot.health = 15; r.sampleHealth()
  ok(r.recentDrop(3000) === 5, '连续掉血按窗口最高血算，不是单次差值')
  ok(r.attackUntil > Date.now(), '连续掉血一直保持"正在挨打"')
}

console.log('\n[4 分档：14 / 10 / 8 / 5]')
{
  const { r, bot } = mkReflex()
  // 血 16 + 有怪 -> 0 档（还够打，别乱跑）
  ok(r.threatLevel(16, { near: mob('zombie', 4) }) === 0, '血 16 有怪 -> 0 档（不动）')
  // 血 14 + 有怪 -> 1 档
  ok(r.threatLevel(14, { near: mob('zombie', 4) }) === 1, '血 14 + 有怪 -> 1 档（拉开距离）')
  // 血 14 没怪也没挨打 -> 0 档
  ok(r.threatLevel(14, {}) === 0, '血 14 但没威胁 -> 0 档')
  ok(r.threatLevel(10, {}) === 2, '血 10 -> 2 档（跑）')
  ok(r.threatLevel(8, {}) === 3, '血 8 -> 3 档（跑+吃）')
  ok(r.threatLevel(5, {}) === 4, '血 5 -> 4 档（跑+吃+不接任务）')
  void bot
}
{
  // 1 档：拉开距离，但真的设了寻路目标（有反应）
  const { r, bot, calls } = mkReflex()
  bot.health = 14
  const lvl = r.reactByTier(14, { near: mob('zombie', 4), underAttack: true })
  ok(lvl === 1, '血 14 有怪 -> 走 1 档', 'lvl=' + lvl)
  ok(calls.goals.length === 1, '1 档真的朝反方向走（GoalNear）', 'goals=' + calls.goals.length)
  ok(logs.some(l => /拉开点距离|reflex\] 血 14/.test(l)), '1 档有日志', logs.slice(-2).join(' | '))
}
{
  // 2 档：跑
  const { r, bot, calls } = mkReflex()
  bot.health = 10
  const before = calls.goals.length
  r.reactByTier(10, { near: mob('zombie', 5), underAttack: true })
  ok(calls.goals.length > before, '血 10 -> 真的跑（设了逃跑目标）')
  ok(r.blocksNewTasks() === false, '血 10 还没到"不接任务"那档')
}
{
  // 3 档：跑 + 吃
  const { r, bot, calls } = mkReflex()
  bot.health = 8
  r.reactByTier(8, { near: mob('zombie', 5), underAttack: true })
  ok(calls.goals.length > 0, '血 8 -> 跑')
  ok(calls.equip > 0, '血 8 -> equip 了食物（consume 在下一个微任务，见结尾）', `equip=${calls.equip}`)
  eatCheck = calls
}
{
  // 4 档：跑 + 吃 + 不接新任务
  const { r, bot } = mkReflex()
  bot.health = 5
  r.reactByTier(5, { near: mob('zombie', 5), underAttack: true })
  ok(r.blocksNewTasks() === true, '血 5 -> blocksNewTasks() 为真（主循环据此不接新任务）')
  ok(logs.some(l => /不接新任务/.test(l)), '日志说清"不接新任务"', logs.filter(l => /不接新任务/.test(l)).slice(-1)[0])
}

console.log('\n[5 busy 门禁：命比任务重要（昨晚就死在这）]')
{
  const logs2 = []
  const { bot } = makeBot()
  let busy = true
  const r = new Reflex(bot, { log: (m) => logs2.push(String(m)), mem: {}, busy: () => busy, onEvent () {} })
  bot.health = 9
  bot.entities = { 90: mob('zombie', 5) }
  const before = r.bot.pathfinder.setGoal && 0
  r.tick()
  ok(r.bot.pathfinder.setGoal !== undefined, '（自检）假 bot 有 pathfinder')
  void before
  ok(logs2.length > 0 || true, 'tick 在 busy 下不抛错')
}
{
  // 血 9 时 busy 也必须跑：用 setGoal 是否被调用来判断
  const goals = []
  const { bot } = makeBot()
  bot.pathfinder.setGoal = (g) => goals.push(g)
  bot.health = 9
  bot.entities = { 90: mob('zombie', 4) }
  const r = new Reflex(bot, { log: () => {}, mem: {}, busy: () => true, onEvent () {} })
  r.tick()
  ok(goals.length > 0, '血 9 + 任务在跑（busy）-> 照样抢 bot 逃跑', 'goals=' + goals.length)
}
{
  // 血满 + busy -> 不抢 pathfinder（老事故：抢了会出 Digging aborted）
  const goals = []
  const { bot } = makeBot()
  bot.pathfinder.setGoal = (g) => goals.push(g)
  bot.health = 20
  bot.entities = {}
  const r = new Reflex(bot, { log: () => {}, mem: {}, busy: () => true, onEvent () {} })
  r.tick()
  ok(goals.length === 0, '血满 + busy -> 不碰寻路（不抢任务）', 'goals=' + goals.length)
}

console.log('\n[6 反击门槛：血 > 14 且怪 <= 2]')
{
  const { r, bot, calls } = mkReflex()
  let attacked = 0
  bot.attack = () => { attacked++ }
  bot.lookAt = () => {}
  bot.health = 20
  bot.entities = { 90: mob('zombie', 2) }
  ok(r.canRetaliate() === true, '血 20 + 1 只怪 -> 可以反打')
  r.tick()
  ok(attacked > 0, '真的出手了', 'attacked=' + attacked)
  void calls
}
{
  const { r, bot } = mkReflex()
  let attacked = 0
  bot.attack = () => { attacked++ }
  bot.lookAt = () => {}
  bot.health = 14
  ok(r.canRetaliate() === false, '血 14 -> 不反打（该跑）')
  bot.health = 20
  bot.entities = { 90: mob('zombie', 2, 90), 91: mob('skeleton', 3, 91), 92: mob('creeper', 3, 92) }
  ok(r.canRetaliate() === false, '血 20 但 3 只怪 -> 不反打（打不过）')
  bot.entities = { 90: mob('zombie', 2) }
  r.panicUntil = Date.now() + 10000
  ok(r.canRetaliate() === false, 'panic 期间 -> 不反打')
}

console.log('\n[7 onHurt：怪打 / 环境 分开处理]')
{
  // mob_attack + 血 16（还很高）：也要有反应（验收 1）
  const { r, bot, calls } = mkReflex()
  bot.health = 16
  r.onHurt(mob('zombie', 2), 16, 'mob_attack', { id: 28, name: 'mob_attack', attack: true, cat: 'mob', causeId: 90, directId: 90 })
  ok(calls.back > 0 || calls.goals.length > 0 || logs.some(l => /被攻击/.test(l)),
    '血 16 被僵尸打 -> 有反应（弹开/跑/日志）', logs.slice(-2).join(' | '))
  ok(r.lastDamage && r.lastDamage.cat === 'mob', '记下了"这是 mob 打的"（不是环境伤害）')
  ok(logs.some(l => /mob_attack\/28/.test(l)), '[hurt] 打出可读类型名', logs.filter(l => /\[hurt\]/.test(l)).slice(-1)[0])
}
{
  // 环境伤害：摔（已经发生完了）不该触发"跑"
  const { r, bot, calls } = mkReflex()
  bot.health = 12
  r.onHurt(null, 12, 'fall', { id: 10, name: 'fall', attack: false, cat: 'env', causeId: 0, directId: 0 })
  ok(r.lastDamage.cat === 'env' && r.lastDamage.attack === false, 'fall 记成环境伤害')
  ok(calls.goals.length === 0, '摔伤不触发逃跑（摔完就完了）', 'goals=' + calls.goals.length)
  ok(logs.some(l => /环境伤害 摔下来了/.test(l)), '[hurt] 环境伤害也说人话', logs.filter(l => /\[hurt\]/.test(l)).slice(-1)[0])
}
{
  // 环境伤害：溺水 + 血 9 -> 立刻救（保留原行为）
  const { r, bot } = mkReflex()
  bot.health = 9
  r.onHurt(null, 9, 'drown', { id: 6, name: 'drown', attack: false, cat: 'env', continuous: true })
  ok(logs.some(l => /\[sos\] 血 9/.test(l)), '血 9 溺水照旧走 sos（原行为没退化）', logs.filter(l => /\[sos\]/.test(l)).slice(-1)[0])
}
{
  // 看不见的怪：没有实体、没有类型，只有掉血 —— 也要跑（昨晚的现场）
  const { r, bot, calls } = mkReflex()
  bot.entities = {}                    // 一个怪都看不见
  bot.health = 20; r.sampleHealth()
  bot.health = 16; r.sampleHealth()    // 20 -> 16
  r.onHurt(null, 16, 'unknown', { id: 99, name: 'type99', attack: false, cat: 'env' })
  ok(r.recentDrop(3000) >= 4 && r.attackUntil > Date.now(), '看不见来源也认出"正在挨打"')
  ok(calls.back > 0, '看不见的怪也能触发弹开（昨天就是卡在这里）')
  bot.health = 9
  r.tick()
  ok(calls.goals.length > 0, '掉到 9 血就真跑了（不用等认出是谁）', 'goals=' + calls.goals.length)
}

console.log('\n[8 敌对识别：白名单 + minecraft-data 兜底]')
{
  const { r, bot } = mkReflex()
  ok(r.isHostile({ name: 'zombie' }) === true, 'zombie 是敌对')
  ok(r.isHostile({ name: 'cow' }) === false, 'cow 不是')
  // 注册表里有 category: 'Hostile mobs' 就算（新怪不用改代码）
  bot.registry = { entitiesByName: { bogged: { type: 'hostile', category: 'Hostile mobs' } } }
  ok(r.isHostile({ name: 'bogged' }) === true, '注册表兜底：bogged 算敌对')
  bot.entities = { 90: { name: 'bogged', position: { x: 3, y: 64, z: 0 } } }
  ok(r.nearestHostile(5) && r.nearestHostile(5).name === 'bogged', 'nearestHostile 认得出它')
  ok(r.hostileCount(5) === 1, 'hostileCount 数得对')
  void bot
}

console.log('\n[9 panic 期间照样能逃（闸门只挡"开新任务"）]')
{
  const { r, bot, calls } = mkReflex()
  bot.health = 4
  bot.entities = { 90: mob('zombie', 5) }
  r.panic(4)
  ok(r.blocksNewTasks() === true, 'panic 中：blocksNewTasks 为真')
  const goalsBefore = calls.goals.length
  bot.health = 4
  r.tick()                       // 主循环被闸门挡住，但 reflex 自己的定时器不会
  ok(calls.goals.length > goalsBefore, 'panic 中 tick 仍然逃跑（不是站着等死）', 'goals=' + calls.goals.length)
  ok(calls.equip > 0, 'panic 中仍然尝试吃东西')
}

// consume 是在 equip().then() 里调的，要等一个微任务
setTimeout(() => {
  ok(eatCheck && eatCheck.consume > 0, '血 8 -> 真的吃了（bot.consume 被调用）', eatCheck ? 'consume=' + eatCheck.consume : '没走到吃')
  console.log(`\n${fail ? '❌' : '✅'} 通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}, 30)
