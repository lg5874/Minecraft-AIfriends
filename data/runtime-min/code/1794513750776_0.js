// 先往上挖通头顶这几格石头爬到地面，再去附近砍树凑木头。
// 目标：先做木棍/镐子的问题解决不了(没木头)，先挖掉头顶石头往上，再找树
try {
  const logNames = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log']

  // —— 1. 往上挖通头顶的石头 ——
  let dug = 0
  const startY = actions.pos().y
  for (let i = 0; i < 20; i++) {
    const p = actions.pos()
    // 找头顶实心块
    let target = null
    for (const dy of [1, 2]) {
      try {
        const b = await actions.blockAt(p.x, p.y + dy, p.z)
        if (b && b.name && b.name !== 'air' && b.name !== 'cave_air') { target = b; break }
      } catch (e) {}
    }
    if (!target) {
      // 头顶空了，跳一下试试往上
      try { await actions.walkToward(0, 0, 200) } catch (e) {}
      await sleep(150)
      const p2 = actions.pos()
      if (p2.y > p.y + 1) continue
      // 真上不去了，检查是否已见天
      try {
        const a1 = await actions.blockAt(p2.x, p2.y + 2, p2.z)
        if (!a1 || a1.name === 'air') break
      } catch (e) { break }
      // 换方向往上挖
      try { await actions.walkToward(1, 0, 100) } catch (e) {}
      continue
    }
    try { await actions.bestToolFor(target) } catch (e) {}
    let ok = false
    try { ok = await actions.digAt(target) } catch (e) { log('挖头顶出错:' + e) }
    if (ok) dug++
    await sleep(150)
    // 试图跳上去
    try { await actions.walkToward(0, 0, 200) } catch (e) {}
    await sleep(150)
    // 如果上去了几格，看看露天没
    if (actions.pos().y > startY + 3) {
      const pp = actions.pos()
      try {
        const b1 = await actions.blockAt(pp.x, pp.y + 2, pp.z)
        const b2 = await actions.blockAt(pp.x, pp.y + 3, pp.z)
        const air1 = !b1 || b1.name === 'air' || b1.name === 'cave_air'
        const air2 = !b2 || b2.name === 'air' || b2.name === 'cave_air'
        if (air1 && air2) break
      } catch (e) { break }
    }
  }
  // 捡石头渣
  for (let i = 0; i < 2; i++) { try { await actions.pickupNearby(4) } catch (e) {} await sleep(120) }

  // —— 2. 找树砍 ——
  if (actions.item('stone_axe')) { try { await actions.equip('stone_axe') } catch (e) {} }

  let treesDug = 0
  for (let i = 0; i < 12; i++) {
    let t = null
    try { t = await actions.findAny(logNames, 40) } catch (e) { log('找树出错:' + e) }
    if (!t) {
      await actions.wander(6)
      await sleep(300)
      try { t = await actions.findAny(logNames, 40) } catch (e) {}
      if (!t) {
        // 再看看树叶位置，树常带叶子
        try { t = await actions.findBlock('oak_leaves', 24) } catch (e) {}
        if (!t) break
        // 叶子就挖叶子附近找木
        try { await actions.goto(t.x, t.y, t.z, 2) } catch (e) {}
        await sleep(200)
        let t2 = null
        try { t2 = await actions.findAny(logNames, 8) } catch (e) {}
        if (!t2) { await actions.wander(3); await sleep(150); continue }
        t = t2
      }
    }
    if (actions.item('stone_axe')) { try { await actions.equip('stone_axe') } catch (e) {} }
    let ok = false
    try { ok = await actions.digAt(t) } catch (e) { log('挖树出错:' + e) }
    if (!ok) {
      try { await actions.goto(t.x, t.y, t.z, 2) } catch (e) {}
      try { ok = await actions.digAt(t) } catch (e) {}
    }
    if (!ok) {
      await actions.wander(2)
      await sleep(150)
      continue
    }
    treesDug++
    await sleep(150)
  }

  for (let i = 0; i < 4; i++) { try { await actions.pickupNearby(5) } catch (e) {} await sleep(150) }

  // —— 3. 统计木头 ——
  let logType = null, logCount = 0
  for (const n of logNames) {
    const c = actions.countOf(n)
    if (c > 0) { logType = n; logCount = c; break }
  }
  if (!logType) {
    return '往上挖了' + dug + '格到 y=' + actions.pos().y + '，砍了' + treesDug + '段树但没拿到木头'
  }

  // —— 4. 木板 -> 木棍 -> 石镐 ——
  const plankType = logType.replace('_log', '_planks')
  try { await actions.craft(plankType, Math.min(logCount * 4, 16)) } catch (e) { log('做木板出错:' + e) }
  if (!actions.item('crafting_table') && actions.countOf(plankType) >= 4) {
    try { await actions.craft('crafting_table', 1) } catch (e) {}
  }
  if (actions.item('crafting_table')) {
    try { await actions.placeNearby('crafting_table') } catch (e) {}
  }
  if (actions.countOf(plankType) >= 2 && actions.countOf('stick') < 4) {
    try { await actions.craft('stick', 8) } catch (e) { log('做木棍出错:' + e) }
  }
  const made = []
  if (!actions.item('stone_pickaxe') && actions.countOf('cobblestone') >= 3 && actions.countOf('stick') >= 2) {
    try { await actions.craft('stone_pickaxe', 1); made.push('石镐') } catch (e) { log('做石镐出错:' + e) }
  }
  if (!actions.item('stone_axe') && actions.countOf('cobblestone') >= 3 && actions.countOf('stick') >= 2) {
    try { await actions.craft('stone_axe', 1); made.push('石斧') } catch (e) {}
  }
  if (actions.item('stone_pickaxe')) { try { await actions.equip('stone_pickaxe') } catch (e) {} }

  return '往上挖了' + dug + '格到 y=' + actions.pos().y + '，砍了' + treesDug + '段' + logType +
         '，现在木板' + actions.countOf(plankType) + '、木棍' + actions.countOf('stick') +
         '，新做：' + (made.length ? made.join('、') : '无')
} catch (e) {
  return '出错了: ' + e
}