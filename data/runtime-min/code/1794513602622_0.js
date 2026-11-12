// 先用手上的石镐往上挖通头顶5格石头爬到地面，再去找附近的树砍木头。
// 目标：没镐子，先往上挖通头顶5格到地面，再砍树做木头工具
try {
  const logNames = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log']

  // —— 1. 面朝上，挖头顶5格 ——
  const startY = actions.pos().y
  let dug = 0
  for (let i = 0; i < 8; i++) {
    const p = actions.pos()
    const above = await actions.blockAt(p.x, p.y + 2, p.z) // 头顶两格（跳起来能挖的实心块）
    const above1 = await actions.blockAt(p.x, p.y + 1, p.z)
    let target = null
    if (above && above.name && above.name !== 'air') target = above
    else if (above1 && above1.name && above1.name !== 'air') target = above1
    if (!target) {
      // 头顶空了，跳一下
      try { await actions.walkToward(0, 0, 100) } catch (e) {}
      await sleep(150)
      // 检查能不能站上去
      continue
    }
    try { await actions.bestToolFor(target) } catch (e) {}
    let ok = false
    try { ok = await actions.digAt(target) } catch (e) { log('挖头顶出错:' + e) }
    if (ok) dug++
    await sleep(120)
    // 尝试往上跳
    try { await actions.walkToward(0, 0, 120) } catch (e) {}
    await sleep(150)
    const nowY = actions.pos().y
    if (nowY > startY + 3 && dug >= 3 && i > 3) {
      // 已经感觉上移，看能不能直接上去
    }
  }

  // 捡东西
  for (let i = 0; i < 3; i++) {
    try { await actions.pickupNearby(4) } catch (e) {}
    await sleep(150)
  }

  // —— 2. 看看是否到地面：往上走几步 ——
  // 若还在矿洞里，就继续挖一点打通
  for (let k = 0; k < 6; k++) {
    const p = actions.pos()
    const head = await actions.blockAt(p.x, p.y + 2, p.z)
    if (head && head.name && head.name !== 'air') {
      try { await actions.bestToolFor(head) } catch (e) {}
      try { await actions.digAt(head) } catch (e) {}
      await sleep(150)
    }
    try { await actions.walkToward(0, 0, 150) } catch (e) {}
    await sleep(120)
    // 上移到有天空的地方（头顶和上方都为空）
    const p2 = actions.pos()
    const a1 = await actions.blockAt(p2.x, p2.y + 1, p2.z)
    const a2 = await actions.blockAt(p2.x, p2.y + 2, p2.z)
    const a3 = await actions.blockAt(p2.x, p2.y + 3, p2.z)
    const clear1 = !a1 || a1.name === 'air'
    const clear2 = !a2 || a2.name === 'air'
    const clear3 = !a3 || a3.name === 'air'
    if (clear1 && clear2 && clear3) break
  }

  // —— 3. 找树砍木头 ——
  if (actions.item('stone_axe')) {
    try { await actions.equip('stone_axe') } catch (e) {}
  } else if (actions.item('wooden_axe')) {
    try { await actions.equip('wooden_axe') } catch (e) {}
  }

  let treesDug = 0
  for (let i = 0; i < 10; i++) {
    let t = null
    try { t = await actions.findAny(logNames, 48) } catch (e) { log('找树出错:' + e) }
    if (!t) {
      await actions.wander(6)
      await sleep(300)
      try { t = await actions.findAny(logNames, 48) } catch (e) {}
      if (!t) break
    }
    if (actions.item('stone_axe')) { try { await actions.equip('stone_axe') } catch (e) {} }
    let ok = false
    try { ok = await actions.digAt(t) } catch (e) { log('挖树出错:' + e) }
    if (!ok) {
      try { await actions.goto(t.x, t.y, t.z, 2) } catch (e) {}
      try { ok = await actions.digAt(t) } catch (e) {}
    }
    if (!ok) break
    treesDug++
    await sleep(150)
  }

  for (let i = 0; i < 4; i++) {
    try { await actions.pickupNearby(5) } catch (e) {}
    await sleep(150)
  }

  // —— 4. 统计木头 ——
  let logType = null, logCount = 0
  for (const n of logNames) {
    const c = actions.countOf(n)
    if (c > 0) { logType = n; logCount = c; break }
  }
  if (!logType) {
    return '往上挖了' + dug + '格，砍树挖了' + treesDug + '个方块但没拿到木头；当前在 y=' + actions.pos().y
  }

  // —— 5. 原木→木板→工作台→木棍——
  const plankType = logType.replace('_log', '_planks')
  try { await actions.craft(plankType, logCount * 4) } catch (e) { log('做木板出错:' + e) }

  if (actions.countOf(plankType) >= 4 && !actions.item('crafting_table')) {
    try { await actions.craft('crafting_table', 1) } catch (e) { log('做工作台出错:' + e) }
  }
  if (actions.item('crafting_table')) {
    try { await actions.placeNearby('crafting_table') } catch (e) { log('放工作台出错:' + e) }
  }
  if (actions.countOf(plankType) >= 2 && actions.countOf('stick') < 4) {
    try { await actions.craft('stick', 8) } catch (e) { log('做木棍出错:' + e) }
  }

  // —— 6. 用现有圆石做石镐、石斧 ——
  const made = []
  const stoneCount = () => actions.countOf('cobblestone')
  const stickCount = () => actions.countOf('stick')

  if (stoneCount() >= 3 && stickCount() >= 2 && !actions.item('stone_pickaxe')) {
    try { await actions.craft('stone_pickaxe', 1); made.push('石镐') } catch (e) { log('做石镐出错:' + e) }
  }
  if (stoneCount() >= 3 && stickCount() >= 2 && !actions.item('stone_axe')) {
    try { await actions.craft('stone_axe', 1); made.push('石斧') } catch (e) { log('做石斧出错:' + e) }
  }
  if (stoneCount() >= 3 && stickCount() >= 2 && !actions.item('stone_sword')) {
    try { await actions.craft('stone_sword', 1); made.push('石剑') } catch (e) { log('做石剑出错:' + e) }
  }

  // 换上石镐
  if (actions.item('stone_pickaxe')) {
    try { await actions.equip('stone_pickaxe') } catch (e) {}
  }

  return '往上挖了' + dug + '格到地面，砍了' + treesDug + '段' + logType + '，做了' +
         actions.countOf(plankType) + '木板、' + actions.countOf('stick') + '木棍，工作台：' +
         (actions.item('crafting_table') ? '有' : '无') + '，新工具：' + (made.length ? made.join('、') : '无')
} catch (e) {
  return '出错了: ' + e
}