// 目标：用石斧砍树凑木头 → 做工作台、木棍 → 补齐石质工具（石镐）
try {
  const logNames = ['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log']

  // 1. 手持石斧（砍树快）
  if (actions.item('stone_axe')) {
    try { await actions.equip('stone_axe') } catch (e) { log('装备石斧出错:' + e) }
  }

  // 2. 找树挖木头
  let dug = 0
  for (let i = 0; i < 12; i++) {
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

  // 3. 捡地上的木头
  for (let i = 0; i < 3; i++) {
    try { await actions.pickupNearby(4) } catch (e) {}
    await sleep(150)
  }

  // 4. 统计木头
  let logType = null, logCount = 0
  for (const n of logNames) {
    const c = actions.countOf(n)
    if (c > 0) { logType = n; logCount = c; break }
  }
  if (!logType) {
    return '没挖到木头（挖了' + dug + '个方块），先收手'
  }

  // 5. 原木 → 木板
  const plankType = logType.replace('_log', '_planks')
  try { await actions.craft(plankType, logCount * 4) } catch (e) { log('做木板出错:' + e) }

  // 6. 做工作台并放下
  if (actions.countOf(plankType) >= 4 && !actions.item('crafting_table')) {
    try { await actions.craft('crafting_table', 1) } catch (e) { log('做工作台出错:' + e) }
  }
  if (actions.item('crafting_table')) {
    try { await actions.placeNearby('crafting_table') } catch (e) { log('放工作台出错:' + e) }
  }

  // 7. 做木棍（工具要用）
  if (actions.countOf(plankType) >= 2 && actions.countOf('stick') < 4) {
    try { await actions.craft('stick', 8) } catch (e) { log('做木棍出错:' + e) }
  }

  // 8. 补齐石质工具（背包里有 218 个圆石，够用）
  const made = []
  const stone = () => actions.countOf('cobblestone')
  const stick = () => actions.countOf('stick')

  if (stone() >= 3 && stick() >= 2 && !actions.item('stone_pickaxe')) {
    try { await actions.craft('stone_pickaxe', 1); made.push('石镐') } catch (e) { log('做石镐出错:' + e) }
  }
  if (stone() >= 3 && stick() >= 2 && !actions.item('stone_axe')) {
    try { await actions.craft('stone_axe', 1); made.push('石斧') } catch (e) { log('做石斧出错:' + e) }
  }
  if (stone() >= 2 && stick() >= 1 && !actions.item('stone_sword')) {
    try { await actions.craft('stone_sword', 1); made.push('石剑') } catch (e) { log('做石剑出错:' + e) }
  }
  if (stone() >= 3 && stick() >= 2 && !actions.item('stone_hoe')) {
    try { await actions.craft('stone_hoe', 1); made.push('石锄') } catch (e) { log('做石锄出错:' + e) }
  }
  if (stone() >= 3 && stick() >= 2 && !actions.item('stone_shovel')) {
    try { await actions.craft('stone_shovel', 1); made.push('石铲') } catch (e) { log('做石铲出错:' + e) }
  }

  // 9. 换上石镐（挖矿用）
  if (actions.item('stone_pickaxe')) {
    try { await actions.equip('stone_pickaxe') } catch (e) { log('装备石镐出错:' + e) }
  }

  return '砍了' + dug + '段' + logType + '，做了' + actions.countOf(plankType) + '木板、' +
         actions.countOf('stick') + '木棍，工作台：' + (actions.item('crafting_table') ? '有' : '无') +
         '，新工具：' + (made.length ? made.join('、') : '无') +
         '，石镐：' + (actions.item('stone_pickaxe') ? '有' : '无')
} catch (e) {
  return '出错了: ' + e
}