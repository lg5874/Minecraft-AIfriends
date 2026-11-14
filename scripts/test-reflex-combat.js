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
    // 方块世界：默认是"平地"（y<64 石头、上面空气），个别测试改成悬崖/墙
    blockAt: opts.blockAt || ((pos) => ({ name: (pos && pos.y < 64) ? 'stone' : 'air' })),
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

console.log('\n[10 回血线（food >= 18 才自然回血）]')
{
  // ① 饿 17 + 血 7 + 背包有吃的 -> 主动吃（验收 1）
  const { r, bot, calls } = mkReflex()
  const mark = logs.length
  bot.food = 17; bot.health = 7
  const ate = r.keepFed()
  ok(ate === 'bread' && calls.equip > 0, '饿 17 + 血 7 -> 直接吃（不用等救命档）', 'ate=' + ate)
  const line = logs.slice(mark).find(l => /\[eat\] 饿 17 < 18/.test(l))
  ok(!!line, '日志说清为什么吃：' + (line || '（没有）'))
}
{
  // ② 饿 19（已在回血线上）-> 不吃（验收 2）
  const { r, bot, calls } = mkReflex()
  const mark = logs.length
  bot.food = 19; bot.health = 7
  const ate = r.keepFed()
  ok(ate === null && calls.equip === 0, '饿 19 >= 18 -> 不吃（不浪费）', 'equip=' + calls.equip)
  const line = logs.slice(mark).find(l => /\[eat\] 饿 19 ≥ 18/.test(l))
  ok(!!line, '日志说清"会自然回血，先不吃"：' + (line || '（没有）'))
}
{
  // ③ 血满 + 饿 17 也要吃：饿 17 = 永远不回血，等血掉了再补已经晚两下
  const { r, bot, calls } = mkReflex()
  const mark = logs.length
  bot.food = 17; bot.health = 20
  r.keepFed()
  ok(calls.equip > 0, '血满 + 饿 17 也吃（17 意味着永远不回血）', 'equip=' + calls.equip)
  ok(logs.slice(mark).some(l => /\[eat\] 饿 17 < 18/.test(l)), '日志写清原因')
}
{
  // ④ 背包没吃的 -> 说清楚（这是今天排查困难的根源：静默失败）
  const { r, bot, calls } = mkReflex({ food: false })
  const mark = logs.length
  bot.food = 17; bot.health = 7
  const ate = r.keepFed()
  ok(ate === null && calls.equip === 0, '没吃的 -> 不吃')
  ok(logs.slice(mark).some(l => /想吃但背包里没吃的/.test(l)),
    '不再静默：日志写"想吃但背包里没吃的"', logs.slice(mark).join(' | '))
}
{
  // ⑤ 集成：血满（0 档）+ 饿 17，tick 也要吃 —— 老代码只有血低才吃，这是死循环的来源
  const { r, bot, calls } = mkReflex()
  bot.food = 17; bot.health = 20; bot.entities = {}
  r.tick()
  ok(calls.equip > 0, '血满 + 饿 17：tick 里也会吃（不必等到快死）', 'equip=' + calls.equip)
}
{
  // ⑥ 集成：饿 19 -> tick 不吃
  const { r, bot, calls } = mkReflex()
  bot.food = 19; bot.health = 20; bot.entities = {}
  r.tick()
  ok(calls.equip === 0, '饿 19：tick 不吃', 'equip=' + calls.equip)
}
{
  // ⑦ 卡死保护：eating 卡住 15 秒不会永久禁吃
  const { r, bot, calls } = mkReflex()
  bot.food = 17; bot.health = 7
  r.eating = true
  r._eatingAt = Date.now() - 20000
  const ate = r.eatNow('regen')
  ok(ate === 'bread', 'eating 卡住 20 秒 -> 强制复位后照样吃', 'ate=' + ate)
  ok(logs.some(l => /卡住了/.test(l)), '并且说出来')
}
{
  // ⑧ 中毒食物不吃
  const { r } = mkReflex()
  r.bot.inventory.items = () => [{ name: 'rotten_flesh', count: 2 }, { name: 'cooked_beef', count: 1 }]
  const list = r.foodItems().map(i => i.name)
  ok(list.includes('cooked_beef') && !list.includes('rotten_flesh'), '腐肉不当正餐（中毒），熟牛肉算', list.join(','))
}
console.log('\n[11 腐肉：忍着 > 吃（07:32 每 8 秒一条的现场）]')
{
  // ⑨ 只剩腐肉、血 7（> 6）-> 不吃，记一句"忍着"
  const { r, bot, calls } = mkReflex()
  const mark = logs.length
  bot.inventory.items = () => [{ name: 'rotten_flesh', count: 8 }]
  bot.food = 16; bot.health = 7
  const ate = r.eatNow('regen')
  ok(ate === null && calls.equip === 0, '血 7（>6）只有腐肉 -> 不吃', 'ate=' + ate)
  const line = logs.slice(mark).find(l => /只有 rotten_flesh，但它会让我更饿/.test(l))
  ok(!!line, '并且说清为什么忍着（吃了更饿）', line || '（没有）')
}
{
  // ⑨b 血 6 -> 才吃，且说原因、记"没用"
  const { r, bot, calls } = mkReflex()
  const mark = logs.length
  bot.inventory.items = () => [{ name: 'rotten_flesh', count: 8 }]
  bot.food = 16; bot.health = 6
  const ate = r.eatNow('regen')
  ok(ate === 'rotten_flesh' && calls.equip > 0, '血 6（≤6）-> 救命档才垫腐肉', 'ate=' + ate)
  const line = logs.slice(mark).find(l => /只能垫 rotten_flesh/.test(l))
  ok(!!line, '说清这是救命档：' + (line || '（没有）'))
  ok(r._noPoisonUntil > Date.now(), '吃过之后记下"这东西不顶饱"（120 秒内不再指望）')
  // 立刻再要吃 -> 被记忆拦住
  const before = calls.equip
  bot.health = 6; bot.food = 16
  const again = r.eatNow('regen')
  ok(again === null && calls.equip === before, '紧接着再喊吃 -> 被拦（不会每 8 秒一条）', 'again=' + again)
}
{
  // ⑨c 吃一次后 30 秒内不再吃（冷却）
  const { r, bot, calls } = mkReflex()
  bot.inventory.items = () => [{ name: 'rotten_flesh', count: 8 }]
  bot.food = 16; bot.health = 6
  r.eatNow('regen')
  r.eating = false                       // 模拟 consume 已结束
  r._noPoisonUntil = 0                   // 单独验冷却，不受记忆影响
  const before = calls.equip
  ok(r.eatNow('regen') === null && calls.equip === before, '腐肉：吃一次后 30 秒内不再吃（冷却闸）')
  // 30 秒后可以再吃
  r._foodAt.rotten_flesh = Date.now() - 1
  r._noPoisonUntil = 0
  ok(r.eatNow('regen') === 'rotten_flesh', '冷却过期后才会再吃')
}
{
  // ⑨d 正经食物也有短冷却（防止 eatNow 在 consume 还没结束时被连调）
  const { r, bot, calls } = mkReflex()
  bot.inventory.items = () => [{ name: 'bread', count: 3 }]
  bot.food = 17; bot.health = 10
  ok(r.eatNow('regen') === 'bread', '第一次吃面包')
  r.eating = false
  ok(r.eatNow('regen') === null && calls.equip === 1, '10 秒内不重复吃同一个东西', 'equip=' + calls.equip)
}
{
  // ⑨e keepFed 集成：只有腐肉 + 血 7 -> 连喊 5 次也只记一条"忍着"，不反复吃
  const { r, bot, calls } = mkReflex()
  const mark = logs.length
  bot.inventory.items = () => [{ name: 'rotten_flesh', count: 8 }]
  bot.food = 16; bot.health = 7
  for (let i = 0; i < 5; i++) r.keepFed()
  const holds = logs.slice(mark).filter(l => /只有 rotten_flesh/.test(l)).length
  ok(calls.equip === 0, '连喊 5 次，一次也没吃（不再是 8 秒循环）')
  ok(holds === 1, '日志只记一条（不刷屏）', '条数=' + holds)
}
{
  // ⑩ 有正经食物就不碰腐肉
  const { r } = mkReflex()
  r.bot.inventory.items = () => [{ name: 'rotten_flesh', count: 3 }, { name: 'bread', count: 1 }]
  ok(r.foodItems()[0].name === 'bread', '正常食物排在腐肉前面', r.foodItems().map(i => i.name).join(','))
}
{
  // ⑪ 数据表口径：生蘑菇不是食物（1.21 只能做煲），别为了"背包里有蘑菇"去 consume
  const { r } = mkReflex()
  r.bot.registry = { foodsByName: { bread: { foodPoints: 5 }, honey_bottle: { foodPoints: 6 }, sweet_berries: { foodPoints: 2 } } }
  r.bot.inventory.items = () => [{ name: 'brown_mushroom', count: 1 }, { name: 'honey_bottle', count: 1 }]
  const list = r.foodItems().map(i => i.name)
  ok(!list.includes('brown_mushroom'), '生蘑菇不算食物（数据表里没有它）', list.join(','))
  ok(list.includes('honey_bottle'), '蜂蜜瓶算食物（老正则漏了它）')
}

console.log('\n[12 退之前看落点（摔死的最后一环）]')
{
  // 背后是平地 -> 正常退
  const { r, bot, calls } = mkReflex()
  bot.health = 20
  r.lastDamage = { at: Date.now(), name: 'mob_attack', pos: { x: 2, y: 64, z: 0 } }
  r.recoil(5, { hp: 15 })
  ok(calls.back > 0, '背后有地 -> 正常后退', 'back=' + calls.back)
  ok(logs.slice(-3).some(l => /先退开 2 格/.test(l)), '日志：先退开 2 格')
}
{
  // 背后是悬崖（退路两格内下面全空）-> 不退，只原地跳
  const { r, bot, calls } = mkReflex({
    blockAt: (pos) => {
      if (!pos) return { name: 'air' }
      // 只有脚下（x<=0 且 y<64）有地，往 +x 两格是空的
      if (pos.x >= 1) return { name: 'air' }
      return { name: pos.y < 64 ? 'stone' : 'air' }
    }
  })
  bot.health = 20
  r.lastDamage = { at: Date.now(), name: 'mob_attack', pos: { x: -2, y: 64, z: 0 } }  // 来源在 -x，退路是 +x（悬崖）
  const before = calls.back
  r.recoil(5, { hp: 15 })
  ok(calls.back === before, '退路上是坑 -> 不后退（原地不动）', 'back=' + calls.back)
  ok(calls.jump > 0, '但还是跳一下（脱离岩浆/营火靠它）')
  ok(logs.slice(-3).some(l => /退路上是坑/.test(l)), '日志说清：退路上是坑/挡着，原地跳一下', logs.slice(-3).join(' | '))
}
{
  // 完全不知道背后是什么（没有来源、四周都是虚空）-> 不退
  const { r, bot, calls } = mkReflex({ blockAt: () => ({ name: 'air' }) })
  bot.health = 20
  r.lastDamage = null
  r.recoil(5, { hp: 15 })
  ok(calls.back === 0, '四周都是空的 -> 一步都不退')
  ok(logs.slice(-3).some(l => /不知道背后是什么/.test(l)), '日志说清原因')
}
{
  // 没来源但旁边有地 -> 仍要退（"看不见的怪也要有反应"这条不能丢）
  const { r, bot, calls } = mkReflex()
  bot.health = 20
  r.lastDamage = null
  r.recoil(5, { hp: 15 })
  ok(calls.back > 0, '看不见来源时，找一个有地的方向退', 'back=' + calls.back)
}

{
  // 两级退②：两格退不了、一格有地 -> 退 1 格（不是站着不动）
  const { r, bot, calls } = mkReflex({
    blockAt: (pos) => {
      if (!pos) return { name: 'air' }
      const bx = Math.floor(pos.x)
      if (bx >= 2) return { name: 'air' }                     // 第二格是虚空
      return { name: pos.y < 64 ? 'stone' : 'air' }           // 第一格有地
    }
  })
  bot.health = 20
  r.lastDamage = { at: Date.now(), name: 'mob_attack', pos: { x: -2, y: 64, z: 0 } }  // 来源在 -x，退路 +x
  r.recoil(5, { hp: 15 })
  ok(calls.back > 0, '两格退不了时，退 1 格（不再钉在原地）', 'back=' + calls.back)
  ok(logs.slice(-3).some(l => /退 1 格（两格退不了）/.test(l)), '日志：退 1 格（两格退不了）', logs.slice(-3).join(' | '))
}
{
  // 两级退③：一格都退不了 -> 原地跳
  const { r, bot, calls } = mkReflex({ blockAt: () => ({ name: 'air' }) })
  bot.health = 20
  r.lastDamage = { at: Date.now(), name: 'mob_attack', pos: { x: -2, y: 64, z: 0 } }
  r.recoil(5, { hp: 15 })
  ok(calls.back === 0 && calls.jump > 0, '一格都没有 -> 原地跳（不后退）')
  ok(logs.slice(-3).some(l => /退路上是坑/.test(l)), '日志说清为什么不动')
}

// consume 是在 equip().then() 里调的，要等一个微任务
setTimeout(() => {
  ok(eatCheck && eatCheck.consume > 0, '血 8 -> 真的吃了（bot.consume 被调用）', eatCheck ? 'consume=' + eatCheck.consume : '没走到吃')
  console.log(`\n${fail ? '❌' : '✅'} 通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}, 30)
