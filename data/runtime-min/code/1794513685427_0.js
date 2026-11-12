// 先用石镐在脚边挖几块石头，找找铁或煤。
// 目标：先做出石镐（需要木棍/木头），再在脚边挖石头找铁或煤
try {
  const logNames = ['oak_log', 'birch_log', 'spruce_log']
  const beforeIron = actions.countOf('raw_iron')
  const beforeCoal = actions.countOf('coal')

  // —— 1. 没有石镐就从头搞：木头→木板→木棍→石镐 ——
  if (!actions.item('stone_pickaxe')) {
    // 缺木棍就先找树
    if (actions.countOf('stick') < 2) {
      let t = null
      for (let i = 0; i < 6 && !t; i++) {
        try { t = await actions.findAny(logNames, 48) } catch (e) { log('找树出错:' + e) }
        if (!t) { await actions.wander(5); await sleep(300) }
      }
      if (t) {
        try { await actions.equip('stone_axe') } catch (e) {}
        // 多砍几块，确保够做木板和木棍
        for (let k = 0; k < 4; k++) {
          let ok = false
          try { ok = await actions.digAt(t) } catch (e) { log('砍树出错:' + e) }
          if (!ok) {
            try { await actions.goto(t.x, t.y, t.z, 2) } catch (e) {}
            try { ok = await actions.digAt(t) } catch (e) {}
          }
          if (!ok) break
          await sleep(150)
          // 找下一块原木
          let nt = null
          try { nt = await actions.findAny(logNames, 8) } catch (e) {}
          if (!nt) break
          t = nt
        }
        try { await actions.pickupNearby(5) } catch (e) {}
        await sleep(200)
        // 做木板和木棍
        let logType = null
        for (const n of logNames) { if (actions.countOf(n) > 0) { logType = n; break } }
        if (logType) {
          const plankType = logType.replace('_log', '_planks')
          try { await actions.craft(plankType, 8) } catch (e) { log('做木板出错:' + e) }
          try { await actions.craft('stick', 8) } catch (e) { log('做木棍出错:' + e) }
        }
      }
    }
    // 材料够就做石镐
    if (actions.countOf('cobblestone') >= 3 && actions.countOf('stick') >= 2) {
      try { await actions.craft('stone_pickaxe', 1) } catch (e) { log('做石镐出错:' + e) }
    }
  }

  const toolOK = !!actions.item('stone_pickaxe')
  if (!toolOK) {
    return '没木棍没木头，做不出石镐，先收手（圆石有' + actions.countOf('cobblestone') + '个）'
  }
  try { await actions.equip('stone_pickaxe') } catch (e) {}

  // —— 2. 找矿优先，没矿就挖石头碰运气 ——
  const oreNames = ['coal_ore', 'iron_ore', 'deepslate_coal_ore', 'deepslate_iron_ore']
  let minedOre = 0
  let minedRock = 0
  for (let i = 0; i < 24; i++) {
    let isOre = true
    let target = null
    try { target = await actions.findAny(oreNames, 20) } catch (e) { log('找矿出错:' + e) }
    if (!target) {
      isOre = false
      try { target = await actions.findBlock('stone', 12) } catch (e) { log('找石头出错:' + e) }
      if (!target) { try { target = await actions.findBlock('andesite', 12) } catch (e) {} }
      if (!target) { try { target = await actions.findBlock('diorite', 12) } catch (e) {} }
      if (!target) break
    }

    try { await actions.bestToolFor(target) } catch (e) {}

    let ok = false
    try { ok = await actions.digAt(target) } catch (e) { log('挖出错:' + e) }
    if (!ok) {
      try { await actions.goto(target.x, target.y, target.z, 2) } catch (e) {}
      try { ok = await actions.digAt(target) } catch (e) {}
    }
    if (!ok) {
      await actions.wander(3)
      await sleep(250)
      continue
    }
    if (isOre) minedOre++
    else minedRock++
    await sleep(140)
  }

  // —— 3. 捡掉落物 ——
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

  return '做出石镐后挖了' + minedOre + '个矿、' + minedRock + '块石头，' + gain +
         '；背包圆石 ' + actions.countOf('cobblestone') + ' 个'
} catch (e) {
  return '出错了: ' + e
}