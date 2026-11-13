'use strict'
/**
 * 伤害类型解析（MC 1.20.5+ 的 damage_type 注册表）。
 *
 * 【为什么需要这个文件】
 * 1.21.11 的 `damage_event` 包里 `sourceTypeId` 是**服务端注册表下标**，
 * 而 mineflayer 只把 chat_type / dimension_type / biome 三类注册表收进
 * `bot.registry`（见 prismarine-registry/lib/pc/index.js），damage_type 被丢掉。
 * 所以 `minecraft-data` 查不到、`bot.registry.damage_type` 也不存在 ——
 * 只能自己拦 `registry_data` 包，边收边用。
 *
 * 【实测抓到的表（s205.singsi.cn，1.21.11，XJJ_DMG*）】
 *   0 arrow … 28 mob_attack … 34 player_attack … 49 wither_skull
 * 跟线上日志对得上：`28` 的 cause==direct（同一个实体打你），
 * `0`（arrow）的 cause!=direct（骷髅 -> 箭）。
 *
 * 老表（main.js 里手写的 9:lava 10:fall 11:drown …）整体错位：
 *   9 其实是 explosion，11 是 falling_anvil，24 才是 lava。
 * 于是 `[dmg] 未知类型` 满屏，而死因只会写"受了点伤"。
 */

// 服务端注册表原样快照（顺序 = 网络 id）。注册表包没到时用它兜底。
const FALLBACK_ID = {
  0: 'arrow',
  1: 'bad_respawn_point',
  2: 'cactus',
  3: 'campfire',
  4: 'cramming',
  5: 'dragon_breath',
  6: 'drown',
  7: 'dry_out',
  8: 'ender_pearl',
  9: 'explosion',
  10: 'fall',
  11: 'falling_anvil',
  12: 'falling_block',
  13: 'falling_stalactite',
  14: 'fireball',
  15: 'fireworks',
  16: 'fly_into_wall',
  17: 'freeze',
  18: 'generic',
  19: 'generic_kill',
  20: 'hot_floor',
  21: 'in_fire',
  22: 'in_wall',
  23: 'indirect_magic',
  24: 'lava',
  25: 'lightning_bolt',
  26: 'mace_smash',
  27: 'magic',
  28: 'mob_attack',
  29: 'mob_attack_no_aggro',
  30: 'mob_projectile',
  31: 'on_fire',
  32: 'out_of_world',
  33: 'outside_border',
  34: 'player_attack',
  35: 'player_explosion',
  36: 'sonic_boom',
  37: 'spear',
  38: 'spit',
  39: 'stalagmite',
  40: 'starve',
  41: 'sting',
  42: 'sweet_berry_bush',
  43: 'thorns',
  44: 'thrown',
  45: 'trident',
  46: 'unattributed_fireball',
  47: 'wind_charge',
  48: 'wither',
  49: 'wither_skull'
}

// 名字 -> 大类。
//   mob        普通近战怪
//   projectile 远程/投掷（骷髅箭、三叉戟、火球、羊驼口水…）
//   player     玩家打的
//   explosion  爆炸
//   magic      药水/凋零/龙息这类"有来源但看不见实体"的
//   env        环境（摔/淹/岩浆/饿/卡方块…）
const CAT = {
  mob_attack: 'mob',
  mob_attack_no_aggro: 'mob',
  sting: 'mob',
  spit: 'mob',
  sonic_boom: 'mob',

  arrow: 'projectile',
  mob_projectile: 'projectile',
  trident: 'projectile',
  thrown: 'projectile',
  fireball: 'projectile',
  unattributed_fireball: 'projectile',
  wither_skull: 'projectile',
  fireworks: 'projectile',
  wind_charge: 'projectile',

  player_attack: 'player',
  player_explosion: 'player',
  spear: 'player',
  mace_smash: 'player',

  explosion: 'explosion',
  thorns: 'magic',
  magic: 'magic',
  indirect_magic: 'magic',
  dragon_breath: 'magic',
  wither: 'magic',

  fall: 'env',
  drown: 'env',
  lava: 'env',
  in_fire: 'env',
  on_fire: 'env',
  campfire: 'env',
  hot_floor: 'env',
  freeze: 'env',
  starve: 'env',
  in_wall: 'env',
  cramming: 'env',
  cactus: 'env',
  sweet_berry_bush: 'env',
  stalagmite: 'env',
  falling_anvil: 'env',
  falling_block: 'env',
  falling_stalactite: 'env',
  lightning_bolt: 'env',
  out_of_world: 'env',
  outside_border: 'env',
  dry_out: 'env',
  ender_pearl: 'env',
  fly_into_wall: 'env',
  bad_respawn_point: 'env',
  generic: 'env',
  generic_kill: 'env'
}

// 会**持续**掉血的：光站原地不动没用，必须离开原地（跑/游/跳）
const CONTINUOUS = new Set([
  'lava', 'in_fire', 'on_fire', 'campfire', 'hot_floor',
  'drown', 'in_wall', 'cramming', 'sweet_berry_bush', 'outside_border'
])

// 活着挨一下时的说法（死因另有一套，见 deathTextOf）
const CN = {
  arrow: '被箭射了',
  mob_projectile: '被射了',
  mob_attack: '挨了一下',
  mob_attack_no_aggro: '被撞了一下',
  sting: '被蛰了',
  spit: '被吐了一口',
  sonic_boom: '吃了监守者的音波',
  player_attack: '被打了',
  player_explosion: '被爆炸波及',
  spear: '被长矛捅了',
  mace_smash: '被重锤砸了',
  explosion: '被炸了',
  thorns: '被反伤扎了',
  magic: '中药水了',
  indirect_magic: '中药水了',
  dragon_breath: '被龙息喷了',
  wither: '中了凋零',
  fall: '摔下来了',
  drown: '快淹死了',
  lava: '被岩浆烫了',
  in_fire: '烧起来了',
  on_fire: '身上着火',
  campfire: '被营火烫了',
  hot_floor: '踩到烫方块了',
  freeze: '冻伤了',
  starve: '饿坏了',
  in_wall: '被卡在方块里',
  cramming: '被挤伤了',
  cactus: '被仙人掌扎了',
  sweet_berry_bush: '被甜浆果丛扎了',
  stalagmite: '扎到石笋上',
  falling_anvil: '被铁砧砸了',
  falling_block: '被掉下来的方块砸了',
  falling_stalactite: '被钟乳石戳了',
  lightning_bolt: '被雷劈了',
  out_of_world: '掉出世界了',
  outside_border: '跑到世界边界外了',
  dry_out: '被晒干了',
  ender_pearl: '被末影珍珠摔了',
  fly_into_wall: '撞到墙上了',
  bad_respawn_point: '出生点不对劲',
  generic: '受了点伤',
  generic_kill: '被规则弄死了'
}

// 死因：要说清"怎么死的"，不是"受了点伤"
const DEATH = {
  arrow: '被箭射死了',
  mob_projectile: '被射死了',
  mob_attack: '被打死了',
  mob_attack_no_aggro: '被撞死了',
  sting: '被蛰死了',
  spit: '被吐死了',
  sonic_boom: '被音波震死了',
  player_attack: '被打死了',
  player_explosion: '被炸死了',
  spear: '被长矛捅死了',
  mace_smash: '被重锤砸死了',
  explosion: '被炸死了',
  thorns: '被反伤扎死了',
  magic: '被药水害死了',
  indirect_magic: '被药水害死了',
  dragon_breath: '被龙息喷死了',
  wither: '被凋零耗死了',
  fall: '摔死了',
  drown: '淹死了',
  lava: '被岩浆烫死了',
  in_fire: '烧死了',
  on_fire: '烧死了',
  campfire: '被营火烧死了',
  hot_floor: '被烫方块烫死了',
  freeze: '冻死了',
  starve: '饿死了',
  in_wall: '被方块卡死了',
  cramming: '被挤死了',
  cactus: '被仙人掌扎死了',
  sweet_berry_bush: '被甜浆果丛扎死了',
  stalagmite: '扎到石笋上摔死了',
  falling_anvil: '被铁砧砸死了',
  falling_block: '被掉下来的方块砸死了',
  falling_stalactite: '被钟乳石戳死了',
  lightning_bolt: '被雷劈死了',
  out_of_world: '掉出世界了',
  outside_border: '越界死了',
  dry_out: '被晒死了',
  ender_pearl: '被末影珍珠摔死了',
  fly_into_wall: '撞墙撞死了',
  bad_respawn_point: '出生点不对劲，死了',
  generic: '死了',
  generic_kill: '被规则抹了'
}


// 常见怪的叫法：`被zombie打死` 不算说人话（displayName 是英文 "Zombie"）
const ZH_MOB = {
  zombie: '僵尸', zombie_villager: '僵尸村民', husk: '尸壳', drowned: '溺尸',
  skeleton: '骷髅', stray: '流浪者', bogged: '沼骸', wither_skeleton: '凋灵骷髅',
  creeper: '苦力怕', spider: '蜘蛛', cave_spider: '洞穴蜘蛛', enderman: '末影人',
  witch: '女巫', pillager: '掠夺者', vindicator: '卫道士', evoker: '唤魔者',
  ravager: '劫掠兽', phantom: '幻翼', slime: '史莱姆', magma_cube: '岩浆怪',
  blaze: '烈焰人', ghast: '恶魂', piglin_brute: '猪灵蛮兵', zoglin: '僵尸疣猪兽',
  hoglin: '疣猪兽', piglin: '猪灵', warden: '监守者', silverfish: '蠹虫',
  vex: '恼鬼', breeze: '旋风人', creaking: '嘎枝', guardian: '守卫者',
  elder_guardian: '远古守卫者', shulker: '潜影贝', zombified_piglin: '僵尸猪灵',
  wolf: '狼', bee: '蜜蜂', llama: '羊驼', iron_golem: '铁傀儡',
  ender_dragon: '末影龙', wither: '凋灵', pufferfish: '河豚', goat: '山羊'
}

/** 怪名说人话：zombie -> 僵尸；不认识的保留原名（玩家名原样） */
function mobCn (name) {
  const n = bare(name)
  return ZH_MOB[n] || n
}

// 不带 minecraft: 前缀
function bare (name) {
  const s = String(name || '')
  const i = s.indexOf(':')
  return i >= 0 ? s.slice(i + 1) : s
}

let liveTable = Object.assign({}, FALLBACK_ID)
let liveSource = 'fallback'
let liveRegistryName = ''

/** 从注册表条目数组（[{key}]）建表；顺序就是网络 id */
function tableFromEntries (entries) {
  const t = {}
  ;(entries || []).forEach((e, ix) => {
    if (e && e.key) t[ix] = bare(e.key)
  })
  return t
}

/**
 * 挂到 bot 上：拦 `registry_data`（1.20.5+ 的注册表下发）。
 * 只认 damage_type，其它注册表不动 —— mineflayer 自己会处理 chat/biome/dimension。
 */
function attach (bot) {
  if (!bot || !bot._client) return false
  try {
    bot._client.on('registry_data', (packet) => {
      try {
        const codec = packet && (packet.codec || packet)
        if (!codec || bare(codec.id) !== 'damage_type') return
        const t = tableFromEntries(codec.entries)
        if (Object.keys(t).length < 10) return      // 明显不对就不覆盖
        liveTable = t
        liveSource = 'registry'
        liveRegistryName = String(codec.id || '')
      } catch (e) {}
    })
    return true
  } catch (e) {
    return false
  }
}

/** id -> 名字（不带命名空间）。表里没有就返回 `type<N>` */
function nameOf (id) {
  const n = liveTable[id]
  if (n) return n
  if (id === 0) return 'generic'
  return 'type' + id
}

function known (id) {
  return !!liveTable[id]
}

/** 一次解析出全部结论（main.js 只需要读这个） */
function infoOf (id) {
  const name = nameOf(id)
  const cat = CAT[name] || 'env'
  return {
    id,
    name,
    cat,
    known: known(id),
    // 有"人在打你"：被打 -> 退开/跑/反击；env -> 按类型走（淹/岩浆/摔）
    attack: cat === 'mob' || cat === 'projectile' || cat === 'player' ||
      cat === 'explosion' || cat === 'magic',
    // 站着不动就会一直掉血
    continuous: CONTINUOUS.has(name),
    cn: CN[name] || (name + ' 伤害')
  }
}

/**
 * 死因文案。
 * @param {number} id        sourceTypeId
 * @param {string} [by]      来源实体名（僵尸/骷髅/玩家名）
 */
function deathTextOf (id, by) {
  const info = infoOf(id)
  const who = by ? String(by) : ''
  switch (info.cat) {
    case 'mob':
      return who ? `被${who}打死` : info.name === 'mob_attack' ? '被怪打死了' : info.name + ' 打死'
    case 'projectile':
      // 骷髅的箭：cause 是骷髅，direct 是箭 —— by 传进来的是骷髅
      return who ? `被${who}射死` : '被射死了'
    case 'player':
      return who ? `被${who}打死` : (DEATH[info.name] || '被玩家打死了')
    case 'explosion':
      return who ? `被${who}炸死` : (DEATH[info.name] || '被炸死了')
    case 'magic':
      return who ? `${DEATH[info.name] || '被法术弄死'}（${who}）` : (DEATH[info.name] || '被法术弄死')
    default:
      return DEATH[info.name] || (info.known ? `${info.name} 弄死的` : `被 unknown(${id}) 弄死`)
  }
}

/** 测试用：知道现在用的是注册表还是兜底表 */
function source () {
  return { kind: liveSource, registry: liveRegistryName, size: Object.keys(liveTable).length }
}

/** 测试用：直接把表塞进来（不连服务器也能验） */
function _setTable (t) {
  liveTable = Object.assign({}, t || {})
  liveSource = 'injected'
}

module.exports = {
  FALLBACK_ID,
  CAT,
  CN,
  DEATH,
  CONTINUOUS,
  attach,
  nameOf,
  known,
  infoOf,
  deathTextOf,
  mobCn,
  ZH_MOB,
  source,
  _setTable,
  _tableFromEntries: tableFromEntries
}
