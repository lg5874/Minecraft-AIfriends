// 先挖点木头做工作台和木镐，把石质工具升级一下。
// —— 目标：挖木头 → 做工作台、木棍 → 升级石质工具 ——
try {
  const logNames = ['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log']

  // 1. 找树并挖木头
  let dug = 0
  for (let i = 0; i < 12; i++) {
    let t = await actions.findAny(logNames, 48)
    if (!t) {
      // 附近没树就四处走走再找
      await actions.wander(4)
      await sleep(300)
      t = await actions.findAny(logNames, 48)
      if (!t) break
    }
    const ok = await actions.digAt(t)
    if (!ok) break          // 够不到/挖不动就收手，避免死循环
    dug++
    await sleep(150)
  }

  // 2. 看看挖到了哪种木头
  let logType = null, logCount = 0
  for (const n of logNames) {
    const c = actions.countOf(n)
    if (c > 0) { logType = n; logCount = c; break }
  }
  if (!logType) {
    return '没挖到木头（挖了' + dug + '个方块），先回去别硬凑'
  }

  // 3. 原木 → 木板
  const plankType = logType.replace('_log', '_planks')
  try { await actions.craft(plankType, logCount * 4) } catch (e) { log('做木板出错:' + e) }
  const planks = actions.countOf(plankType)

  // 4. 做工作台并放到脚边
  if (planks >= 4 && !actions.item('crafting_table')) {
    try { await actions.craft('crafting_table', 1) } catch (e) { log('做工作台出错:' + e) }
  }
  if (actions.item('crafting_table')) {
    try { await actions.placeNearby('crafting_table') } catch (e) { log('放工作台出错:' + e) }
  }

  // 5. 做木棍（工具要用）
  if (actions.countOf(plankType) >= 2 && actions.countOf('stick') < 4) {
    try { await actions.craft('stick', 8) } catch (e) { log('做木棍出错:' + e) }
  }

  // 6. 升级石质工具（背包里有 216 个圆石，够用）
  const stoneCount = actions.countOf('cobblestone')
  const stickCount = actions.countOf('stick')
  const made = []

  if (stoneCount >= 3 && stickCount >= 2 && !actions.item('stone_pickaxe')) {
    try { await actions.craft('stone_pickaxe', 1); made.push('石镐') } catch (e) { log('做石镐出错:' + e) }
  }
  if (stoneCount >= 3 && stickCount >= 2 && !actions.item('stone_axe')) {
    try { await actions.craft('stone_axe', 1); made.push('石斧') } catch (e) { log('做石斧出错:' + e) }
  }
  if (stoneCount >= 2 && stickCount >= 1 && !actions.item('stone_sword')) {
    try { await actions.craft('stone_sword', 1); made.push('石剑') } catch (e) { log('做石剑出错:' + e) }
  }

  // 7. 换上石镐
  if (actions.item('stone_pickaxe')) {
    try { await actions.equip('stone_pickaxe') } catch (e) { log('装备石镐出错:' + e) }
  }

  return '挖了' + dug + '段' + logType + '，做了' + actions.countOf(plankType) + '木板、' +
         actions.countOf('stick') + '木棍，工作台：' + (actions.item('crafting_table') ? '有' : '无') +
         '，新工具：' + (made.length ? made.join('、') : '无')
} catch (e) {
  return '出错了: ' + e
}