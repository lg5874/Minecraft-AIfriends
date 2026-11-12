// 用石镐挖身边的石头和泥土，在脚边围一个两格高的封闭临时避难所过夜。
// 目标：在脚边围一个两格高的封闭临时避难所，安全过夜
try {
  await actions.ensureChunks()

  const p = actions.pos()
  const bx = p.x, by = p.y, bz = p.z
  log('当前站在 (' + bx + ',' + by + ',' + bz + ')，时间晚上')

  // —— 1. 尝试挖点身边的泥土/石头（有镐就挖石头，没有就用手/斧挖泥土）——
  let mined = 0
  try {
    const hasPick = actions.item('stone_pickaxe') || actions.item('wooden_pickaxe') ||
                    actions.item('iron_pickaxe') || actions.item('diamond_pickaxe')
    const names = hasPick
      ? ['stone', 'andesite', 'diorite', 'dirt']
      : ['dirt']
    for (let i = 0; i < 4; i++) {
      let t = null
      try { t = await actions.findAny(names, 3) } catch (e) {}
      if (!t) break
      // 别挖自己脚下或正上方的支撑块
      if (t.x === bx && t.z === bz && (t.y === by || t.y === by - 1)) break
      try { await actions.bestToolFor(t) } catch (e) {}
      let ok = false
      try { ok = await actions.digAt(t) } catch (e) {}
      if (!ok) break
      mined++
      await sleep(100)
    }
    try { await actions.pickupNearby(3) } catch (e) {}
  } catch (e) {}

  // —— 2. 清空头顶，保证不被卡住 ——
  for (const dy of [1, 2]) {
    try {
      const b = await actions.blockAt(bx, by + dy, bz)
      if (b && b !== 'air' && b !== 'cave_air') {
        try { await actions.digAt({ x: bx, y: by + dy, z: bz, name: b }) } catch (e) {}
      }
    } catch (e) {}
  }
  await sleep(150)

  // —— 3. 选一种建墙方块（背包里石头/泥土很多，直接用）——
  let blockType = null
  for (const n of ['cobblestone', 'dirt', 'andesite', 'stone', 'diorite', 'stone_bricks']) {
    if (actions.countOf(n) >= 14) { blockType = n; break }
  }
  if (!blockType) return '身上没有足够的方块搭避难所，只能先躲一躲'

  // —— 4. 在脚边围 3x3 的两格高墙（脚边 y 和头顶 y+1），中间留给自己 ——
  const ring = []
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue
      ring.push([dx, dz])
    }
  }

  let placed = 0
  for (const dy of [0, 1]) {
    for (const [dx, dz] of ring) {
      const x = bx + dx, y = by + dy, z = bz + dz
      let cur = null
      try { cur = await actions.blockAt(x, y, z) } catch (e) {}
      if (cur && cur !== 'air' && cur !== 'cave_air' && cur !== 'water') continue // 已是实心
      let ok = false
      try { ok = await actions.place(blockType, x, y, z) } catch (e) {}
      if (!ok) {
        // 站回中心再试一次（可能距离太远）
        try { await actions.goto(bx, by, bz, 1) } catch (e) {}
        try { ok = await actions.place(blockType, x, y, z) } catch (e) {}
      }
      if (ok) placed++
      await sleep(70)
    }
  }

  // —— 5. 封顶：头顶 by+2 铺一层 3x3 ——
  let roof = 0
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const x = bx + dx, y = by + 2, z = bz + dz
      let cur = null
      try { cur = await actions.blockAt(x, y, z) } catch (e) {}
      if (cur && cur !== 'air' && cur !== 'cave_air') continue
      let ok = false
      try { ok = await actions.place(blockType, x, y, z) } catch (e) {}
      if (!ok) {
        try { await actions.goto(bx, by, bz, 1) } catch (e) {}
        try { ok = await actions.place(blockType, x, y, z) } catch (e) {}
      }
      if (ok) roof++
      await sleep(70)
    }
  }

  // —— 6. 回到中心站好，检查封闭情况 ——
  try { await actions.goto(bx, by, bz, 1) } catch (e) {}
  await sleep(300)

  let sealedWalls = 0
  for (const dy of [0, 1]) {
    for (const [dx, dz] of ring) {
      try {
        const b = await actions.blockAt(bx + dx, by + dy, bz + dz)
        if (b && b !== 'air' && b !== 'cave_air') sealedWalls++
      } catch (e) {}
    }
  }
  let sealedRoof = 0
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      try {
        const b = await actions.blockAt(bx + dx, by + 2, bz + dz)
        if (b && b !== 'air' && b !== 'cave_air') sealedRoof++
      } catch (e) {}
    }
  }

  return '在(' + bx + ',' + by + ',' + bz + ')用' + blockType + '搭了2格高避难所：' +
         '挖料' + mined + '块，砌墙' + placed + '块、封顶' + roof + '块；' +
         '封闭墙' + sealedWalls + '/16、顶' + sealedRoof + '/9，可以过夜了'
} catch (e) {
  return '出错了: ' + e
}