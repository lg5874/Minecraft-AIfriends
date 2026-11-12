// 往上挖几格看看头顶那片青金石矿脉到底有多大。
// 目标：往上挖几格，摸摸头顶那片青金石矿脉有多大
try {
  // 1. 先看看背包里现有的青金石，记下初始值
  const beforeLapis = actions.countOf('lapis_lazuli')
  const beforeOre = actions.countOf('lapis_ore') + actions.countOf('deepslate_lapis_ore')

  // 2. 找石镐（挖青金石需要石镐以上），没有就现场做一个
  if (!actions.item('stone_pickaxe')) {
    if (actions.countOf('cobblestone') >= 3 && actions.countOf('stick') >= 2) {
      try { await actions.craft('stone_pickaxe', 1) } catch (e) { log('做石镐出错:' + e) }
    }
  }
  if (!actions.item('stone_pickaxe')) {
    // 实在没镐，至少用现有的木镐/石镐顶上
    if (actions.item('wooden_pickaxe')) {
      try { await actions.equip('wooden_pickaxe') } catch (e) {}
    }
  } else {
    try { await actions.equip('stone_pickaxe') } catch (e) { log('装备石镐出错:' + e) }
  }

  // 3. 在地形里找青金石矿（含深板岩版），只找头顶附近的
  const lapisNames = ['lapis_ore', 'deepslate_lapis_ore']
  let minedOre = 0
  let tried = 0

  // 反复找最近的青金石矿去挖，直到找不到或挖够次数
  for (let i = 0; i < 16; i++) {
    tried++
    let target = null
    try { target = await actions.findAny(lapisNames, 12) } catch (e) { log('找矿出错:' + e) }

    if (!target) {
      // 附近没有就往上挖一格碰运气：先看头顶方块
      const p = actions.pos()
      let upBlock = null
      try { upBlock = await actions.blockAt(p.x, p.y + 2, p.z) } catch (e) {}
      if (upBlock && upBlock.name && upBlock.name !== 'air') {
        // 头顶那格挖掉
        try { await actions.digAt(upBlock) } catch (e) { log('挖头顶出错:' + e) }
        await sleep(150)
        // 往上走一格（跳上去）
        try { await actions.walkToward(0, 0, 400) } catch (e) {}
        try { await actions.goto(p.x, p.y + 1, p.z, 0) } catch (e) {}
        await sleep(150)
        continue
      }
      // 上面是空的？那就真的没矿了，换着走几步再找
      await actions.wander(3)
      await sleep(200)
      continue
    }

    // 换到最合适的镐
    try { await actions.bestToolFor(target) } catch (e) { log('换工具出错:' + e) }

    let ok = false
    try { ok = await actions.digAt(target) } catch (e) { log('挖矿出错:' + e) }
    if (!ok) {
      // 够不到，靠近一点再试
      try { await actions.goto(target.x, target.y, target.z, 1) } catch (e) {}
      try { ok = await actions.digAt(target) } catch (e) {}
    }
    if (ok) {
      minedOre++
    } else {
      // 挖不动就换地方
      await actions.wander(2)
      await sleep(200)
    }
    await sleep(130)
  }

  // 4. 捡地上的掉落物
  for (let i = 0; i < 4; i++) {
    try { await actions.pickupNearby(5) } catch (e) { log('捡东西出错:' + e) }
    await sleep(180)
  }

  // 5. 统计成果
  const nowLapis = actions.countOf('lapis_lazuli')
  const nowOre = actions.countOf('lapis_ore') + actions.countOf('deepslate_lapis_ore')
  const gainLapis = nowLapis - beforeLapis
  const gainOre = nowOre - beforeOre

  return '往上摸了一圈，挖了' + minedOre + '块青金石矿（尝试' + tried + '轮），' +
         '青金石' + (gainLapis > 0 ? '+' + gainLapis : '没变') +
         '，矿石块' + (gainOre > 0 ? '+' + gainOre : '没变') +
         '；现在背包青金石共' + nowLapis + '个'
} catch (e) {
  return '出错了: ' + e
}