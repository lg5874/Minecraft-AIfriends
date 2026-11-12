// 用石镐挖脚边的石头和泥土，围一个两格高的封闭避难所过夜。
// 目标：用石镐挖身边的石头和泥土，在脚边围一个两格高的封闭避难所过夜
try {
  // —— 1. 装备石镐 ——
  if (actions.item('stone_pickaxe')) {
    try { await actions.equip('stone_pickaxe') } catch (e) {}
  } else if (actions.item('wooden_pickaxe')) {
    try { await actions.equip('wooden_pickaxe') } catch (e) {}
  }

  // —— 2. 先挖点身边的石头/泥土当建材 ——
  const stoneNames = ['stone', 'andesite', 'diorite', 'granite', 'cobblestone', 'dirt']
  let mined = 0
  for (let i = 0; i < 16; i++) {
    let target = null
    try { target = await actions.findAny(stoneNames, 6) } catch (e) {}
    if (!target) break
    try { await actions.bestToolFor(target) } catch (e) {}
    let ok = false
    try { ok = await actions.digAt(target) } catch (e) {}
    if (!ok) {
      try { await actions.goto(target.x, target.y, target.z, 2) } catch (e) {}
      try { ok = await actions.digAt(target) } catch (e) {}
    }
    if (!ok) break
    mined++
    await sleep(120)
  }
  // 捡掉落物
  for (let i = 0; i < 3; i++) {
    try { await actions.pickupNearby(4) } catch (e) {}
    await sleep(150)
  }

  // —— 3. 选一种建墙方块 ——
  let blockType = null
  for (const n of ['cobblestone', 'stone', 'andesite', 'dirt', 'diorite', 'granite']) {
    if (actions.countOf(n) >= 12) { blockType = n; break }
  }
  if (!blockType) {
    return '石头/泥土不够，没法搭避难所'
  }

  // —— 4. 确定站立位置，先清出头顶两格 ——
  const p0 = actions.pos()
  const bx = p0.x, by = p0.y, bz = p0.z
  for (const dy of [1, 2]) {
    try {
      const b = await actions.blockAt(bx, by + dy, bz)
      if (b && b !== 'air' && b !== 'cave_air') {
        try { await actions.digAt({ x: bx, y: by + dy, z: bz, name: b }) } catch (e) {}
      }
    } catch (e) {}
  }

  // —— 5. 围一圈两格高的墙（8个方向，高度 by+1、by+2）——
  let placed = 0, fail = 0
  const ring = []
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue
      ring.push([dx, dz])
    }
  }
  for (const level of [1, 2]) {
    for (const [dx, dz] of ring) {
      const x = bx + dx, y = by + level, z = bz + dz
      let cur = null
      try { cur = await actions.blockAt(x, y, z) } catch (e) {}
      if (cur && cur !== 'air' && cur !== 'cave_air' && cur !== 'water') continue
      let ok = false
      try { ok = await actions.place(blockType, x, y, z) } catch (e) {}
      if (!ok) {
        try { await actions.goto(x, by, z, 2) } catch (e) {}
        try { ok = await actions.place(blockType, x, y, z) } catch (e) {}
      }
      if (ok) placed++
      else fail++
      await sleep(70)
      if (fail > 10) break
    }
    if (fail > 10) break
  }

  // —— 6. 封顶（by+3 铺一层 3x3）——
  let roofPlaced = 0
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const x = bx + dx, y = by + 3, z = bz + dz
      let cur = null
      try { cur = await actions.blockAt(x, y, z) } catch (e) {}
      if (cur && cur !== 'air' && cur !== 'cave_air') continue
      let ok = false
      try { ok = await actions.place(blockType, x, y, z) } catch (e) {}
      if (!ok) {
        try { await actions.goto(x, by + 1, z, 2) } catch (e) {}
        try { ok = await actions.place(blockType, x, y, z) } catch (e) {}
      }
      if (ok) roofPlaced++
      await sleep(70)
    }
  }

  // —— 7. 回到中心，检查封闭 ——
  try { await actions.goto(bx, by, bz, 1) } catch (e) {}
  await sleep(300)
  let sealed = 0
  for (const [dx, dz] of ring) {
    const b = await actions.blockAt(bx + dx, by + 1, bz + dz)
    if (b && b !== 'air' && b !== 'cave_air') sealed++
  }

  return '挖了' + mined + '块石头/泥土，用' + blockType + '搭了避难所：墙' + placed +
         '块、顶' + roofPlaced + '块，封闭' + sealed + '/8，在(' +
         bx + ',' + by + ',' + bz + ')过夜'
} catch (e) {
  return '出错了: ' + e
}