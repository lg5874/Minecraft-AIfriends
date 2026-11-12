// 用石斧砍点木头做工作台和木镐。
// 目标：用石斧砍点木头，做工作台和木镐
try {
  // 1. 装备石斧（没有就用木斧）
  if (actions.item('stone_axe')) {
    try { await actions.equip('stone_axe') } catch (e) {}
  } else if (actions.item('wooden_axe')) {
    try { await actions.equip('wooden_axe') } catch (e) {}
  }

  // 2. 找树砍木头（石头地表附近可能有树，多试几次+走走）
  const logNames = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log']
  let dug = 0
  for (let i = 0; i < 15; i++) {
    let t = null
    try { t = await actions.findAny(logNames, 48) } catch (e) { log('找树出错:' + e) }
    if (!t) {
      // 周围没树就换方向走走再找
      try { await actions.wander(6) } catch (e) {}
      await sleep(300)
      try { t = await actions.findAny(logNames, 48) } catch (e) {}
      if (!t) break
    }
    // 确保拿斧头
    try { await actions.bestToolFor(t) } catch (e) {}
    let ok = false
    try { ok = await actions.digAt(t) } catch (e) { log('砍树出错:' + e) }
    if (!ok) {
      try { await actions.goto(t.x, t.y, t.z, 2) } catch (e) {}
      try { ok = await actions.digAt(t) } catch (e) {}
    }
    if (!ok) {
      // 挖不动就换地方
      try { await actions.wander(4) } catch (e) {}
      await sleep(200)
      continue
    }
    dug++
    await sleep(150)
    // 够做工具就停
    if (dug >= 4) break
  }

  // 捡掉落物
  for (let i = 0; i < 3; i++) {
    try { await actions.pickupNearby(4) } catch (e) {}
    await sleep(150)
  }

  // 3. 看看挖到哪种木头
  let logType = null
  for (const n of logNames) {
    if (actions.countOf(n) > 0) { logType = n; break }
  }
  if (!logType) {
    return '没砍到木头（砍了' + dug + '个），周围可能没树'
  }

  // 4. 原木 → 木板
  const plankType = logType.replace('_log', '_planks')
  const logCount = actions.countOf(logType)
  try { await actions.craft(plankType, logCount * 4) } catch (e) { log('做木板出错:' + e) }
  let planks = actions.countOf(plankType)

  // 5. 做工作台（需要4木板）
  let tableMade = false
  if (planks >= 4 && !actions.item('crafting_table')) {
    try {
      await actions.craft('crafting_table', 1)
      tableMade = !!actions.item('crafting_table')
    } catch (e) { log('做工作台出错:' + e) }
  }
  // 把工作台放到脚边
  if (actions.item('crafting_table')) {
    try { await actions.placeNearby('crafting_table') } catch (e) { log('放工作台出错:' + e) }
  }

  // 6. 做木棍（木镐需要2木棍）
  if (actions.countOf(plankType) >= 2 && actions.countOf('stick') < 2) {
    try { await actions.craft('stick', 4) } catch (e) { log('做木棍出错:' + e) }
  }

  // 7. 做木镐（需要3木板 + 2木棍）
  let pickMade = false
  if (!actions.item('wooden_pickaxe')) {
    // 木板可能刚被工作台用掉了，不够就再补做
    if (actions.countOf(plankType) < 3 && actions.countOf(logType) > 0) {
      try { await actions.craft(plankType, 4) } catch (e) {}
    }
    if (actions.countOf(plankType) >= 3 && actions.countOf('stick') >= 2) {
      try {
        await actions.craft('wooden_pickaxe', 1)
        pickMade = !!actions.item('wooden_pickaxe')
      } catch (e) { log('做木镐出错:' + e) }
    }
  } else {
    pickMade = true
  }

  // 装上木镐
  if (actions.item('wooden_pickaxe')) {
    try { await actions.equip('wooden_pickaxe') } catch (e) {}
  }

  return '砍了' + dug + '段' + logType + '，做了木板' + actions.countOf(plankType) +
         '个、木棍' + actions.countOf('stick') + '个；工作台：' +
         (actions.item('crafting_table') ? '有' : '无') +
         '，木镐：' + (pickMade ? '做好了' : '没做成')
} catch (e) {
  return '出错了: ' + e
}