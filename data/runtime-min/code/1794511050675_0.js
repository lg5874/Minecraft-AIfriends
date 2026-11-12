// 先用手上的石斧砍点木头，做工作台和木镐，再把石质工具升级一下。
// —— 目标：石斧砍木头 → 做工作台、木棍 → 升级石质工具 ——
try {
  const logNames = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log']

  // 1. 拿石斧，准备砍树
  if (actions.item('stone_axe')) {
    try { await actions.equip('stone_axe') } catch (e) { log('装备石斧出错:' + e) }
  } else if (actions.item('wooden_axe')) {
    try { await actions.equip('wooden_axe') } catch (e) { log('装备木斧出错:' + e) }
  }

  // 2. 找树挖木头
  let dug = 0
  for (let i = 0; i < 10; i++) {
    let t = null
    try { t = await actions.findAny(logNames, 48) } catch (e) { log('找树出错:' + e) }
    if (!t) {
      await actions.wander(5)
      await sleep(300)
      try { t = await actions.findAny(logNames, 48) } catch (e) {}
      if (!t) break
    }
    if (actions.item('stone_axe')) { try { await actions.equip('stone_axe') } catch (e) {} }
    let ok = false
    try { ok = await actions.digAt(t) } catch (e) { log('挖树出错:' + e) }
    if (!ok) {
      // 够不到就靠近再试一次
      try { await actions.goto(t.x, t.y, t.z, 2) } catch (e) {}
      try { ok = await actions.digAt(t) } catch (e) {}
    }
    if (!ok) break
    dug++
    await sleep(150)
  }

  // 捡一下地上的木头
  for (let i = 0; i < 3; i++) {
    try { await actions.pickupNearby(4) } catch (e) {}
    await sleep(150)
  }

  // 3. 统计木头
  let logType = null, logCount = 0
  for (const n of logNames) {
    const c = actions.countOf(n)
    if (c > 0) { logType = n; logCount = c; break }
  }
  if (!logType) {
    return '没挖到木头（挖了' + dug + '个方块），先收手'
  }

  // 4. 原木 → 木板
  const plankType = logType.replace('_log', '_planks')
  try { await actions.craft(plankType, logCount * 4) } catch (e) { log('做木板出错:' + e) }
  const planks = actions.countOf(plankType)

  // 5. 做工作台
  if (planks >= 4 && !actions.item('crafting_table')) {
    try { await actions.craft('crafting_table', 1) } catch (e) { log('做工作台出错:' + e) }
  }
  if (actions.item('crafting_table')) {
    try { await actions.placeNearby('crafting_table') } catch (e) { log('放工作台出错:' + e) }
  }

  // 6. 做木棍
  if (actions.countOf(plankType) >= 2 && actions.countOf('stick') < 4) {
    try { await actions.craft('stick', 8) } catch (e) { log('做木棍出错:' + e) }
  }

  // 7. 升级石质工具（背包里已有圆石和石剑石斧，补齐石镐）
  const made = []
  const stoneCount = () => actions.countOf('cobblestone')
  const stickCount = () => actions.countOf('stick')

  if (stoneCount() >= 3 && stickCount() >= 2 && !actions.item('stone_pickaxe')) {
    try { await actions.craft('stone_pickaxe', 1); made.push('石镐') } catch (e) { log('做石镐出错:' + e) }
  }
  if (stoneCount() >= 3 && stickCount() >= 2 && !actions.item('stone_axe')) {
    try { await actions.craft('stone_axe', 1); made.push('石斧') } catch (e) { log('做石斧出错:' + e) }
  }
  if (stoneCount() >= 2 && stickCount() >= 1 && !actions.item('stone_sword')) {
    try { await actions.craft('stone_sword', 1); made.push('石剑') } catch (e) { log('做石剑出错:' + e) }
  }

  // 8. 换上石镐
  if (actions.item('stone_pickaxe')) {
    try { await actions.equip('stone_pickaxe') } catch (e) { log('装备石镐出错:' + e) }
  }

  return '砍了' + dug + '段' + logType + '，做了' + actions.countOf(plankType) + '木板、' +
         actions.countOf('stick') + '木棍，工作台：' + (actions.item('crafting_table') ? '有' : '无') +
         '，新工具：' + (made.length ? made.join('、') : '无')
} catch (e) {
  return '出错了: ' + e
}