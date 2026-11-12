// 目标：用石镐在附近挖石头，看看能不能挖到铁或煤
try {
  const beforeIron = actions.countOf('raw_iron')
  const beforeCoal = actions.countOf('coal')

  // —— 1. 确保有石镐（挖铁矿必须要石镐以上）——
  if (!actions.item('stone_pickaxe')) {
    // 没木棍就找棵树做
    if (actions.countOf('stick') < 2) {
      const logNames = ['oak_log', 'birch_log', 'spruce_log']
      let t = null
      for (let i = 0; i < 5 && !t; i++) {
        try { t = await actions.findAny(logNames, 40) } catch (e) { log('找树出错:' + e) }
        if (!t) { await actions.wander(5); await sleep(300) }
      }
      if (t) {
        try { await actions.digAt(t) } catch (e) { log('砍树出错:' + e) }
        await sleep(200)
        let logType = null
        for (const n of logNames) { if (actions.countOf(n) > 0) { logType = n; break } }
        if (logType) {
          const plankType = logType.replace('_log', '_planks')
          try { await actions.craft(plankType, 4) } catch (e) { log('做木板出错:' + e) }
          try { await actions.craft('stick', 4) } catch (e) { log('做木棍出错:' + e) }
        }
      }
    }
    // 有材料就做石镐
    if (actions.countOf('cobblestone') >= 3 && actions.countOf('stick') >= 2) {
      try { await actions.craft('stone_pickaxe', 1) } catch (e) { log('做石镐出错:' + e) }
    }
  }
  // 手持石镐
  const toolOK = !!actions.item('stone_pickaxe')
  if (toolOK) {
    try { await actions.equip('stone_pickaxe') } catch (e) { log('装备石镐出错:' + e) }
  }

  // —— 2. 找矿挖矿：有石镐才挖铁矿，否则只挖煤 ——
  const oreNames = toolOK
    ? ['coal_ore', 'iron_ore', 'deepslate_coal_ore', 'deepslate_iron_ore']
    : ['coal_ore', 'deepslate_coal_ore']

  let minedOre = 0
  let minedRock = 0
  for (let i = 0; i < 24; i++) {
    let isOre = true
    let target = null
    try { target = await actions.findAny(oreNames, 20) } catch (e) { log('找矿出错:' + e) }
    if (!target) {
      // 附近没矿就挖点石头碰运气
      isOre = false
      try { target = await actions.findBlock('stone', 16) } catch (e) { log('找石头出错:' + e) }
      if (!target) {
        try { target = await actions.findBlock('andesite', 16) } catch (e) {}
      }
      if (!target) break
    }

    try { await actions.bestToolFor(target) } catch (e) { log('换工具出错:' + e) }

    let ok = false
    try { ok = await actions.digAt(target) } catch (e) { log('挖出错:' + e) }
    if (!ok) {
      // 够不到就靠近再试一次
      try { await actions.goto(target.x, target.y, target.z, 2) } catch (e) {}
      try { ok = await actions.digAt(target) } catch (e) {}
    }
    if (!ok) {
      // 实在挖不动就换个地方，别卡死
      await actions.wander(3)
      await sleep(250)
      continue
    }
    if (isOre) minedOre++
    else minedRock++
    await sleep(140)
  }

  // —— 3. 捡地上的掉落物 ——
  for (let i = 0; i < 4; i++) {
    try { await actions.pickupNearby(5) } catch (e) { log('捡东西出错:' + e) }
    await sleep(200)
  }

  // —— 4. 统计成果 ——
  const iron = actions.countOf('raw_iron') - beforeIron
  const coal = actions.countOf('coal') - beforeCoal
  const part = []
  if (iron > 0) part.push('铁' + iron + '个')
  if (coal > 0) part.push('煤' + coal + '个')
  const gain = part.length ? '挖到 ' + part.join('、') : '没挖到铁和煤'

  return '用' + (toolOK ? '石镐' : '木镐(没做出石镐,铁矿挖不了)') +
         '挖了' + minedOre + '个矿、' + minedRock + '块石头，' + gain +
         '；现在背包石头/cobblestone ' + actions.countOf('cobblestone') + ' 个'
} catch (e) {
  return '出错了: ' + e
}