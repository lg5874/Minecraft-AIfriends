// 目标：用石镐挖身边的石头和泥土，在脚边围两格高的封闭临时避难所过夜
try {
  const logNames = ['oak_log', 'birch_log', 'spruce_log']

  // —— 1. 确保有镐子和剑，先换石镐 ——
  if (actions.item('stone_pickaxe')) {
    try { await actions.equip('stone_pickaxe') } catch (e) {}
  } else if (actions.item('wooden_pickaxe')) {
    try { await actions.equip('wooden_pickaxe') } catch (e) {}
  }

  // —— 2. 挖一点身边的石头/泥土备料（作为方块用）——
  const stoneNames = ['stone', 'andesite', 'diorite', 'granite', 'cobblestone', 'dirt']
  let mined = 0
  for (let i = 0; i < 20; i++) {
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
  // 捡地上的掉落物
  for (let i = 0; i < 3; i++) {
    try { await actions.pickupNearby(4) } catch (e) {}
    await sleep(150)
  }

  // —— 3. 选一种建墙方块 ——
  let blockType = null
  for (const n of ['cobblestone', 'stone', 'dirt', 'andesite', 'diorite', 'granite']) {
    if (actions.countOf(n) >= 12) { blockType = n; break }
  }
  if (!blockType) {
    // 料不够就再补挖
    for (let i = 0; i < 15; i++) {
      let t = null
      try { t = await actions.findAny(['dirt', 'stone'], 6) } catch (e) {}
      if (!t) break
      try { await actions.digAt(t) } catch (e) { break }
      await sleep(100)
    }
    try { await actions.pickupNearby(4) } catch (e) {}
    for (const n of ['cobblestone', 'stone', 'dirt', 'andesite', 'diorite', 'granite']) {
      if (actions.countOf(n) >= 8) { blockType = n; break }
    }
  }
  if (!blockType) {
    return '石头/泥土不够，没法搭避难所，先回去了'
  }

  // —— 4. 确认脚下位置，把脚边地面挖平（找站立位置）——
  const p0 = actions.pos()
  const bx = p0.x, by = p0.y, bz = p0.z
  // 确保头顶两格空出来（别被卡住）
  try {
    const above1 = await actions.blockAt(bx, by + 1, bz)
    if (above1 && above1 !== 'air' && above1 !== 'cave_air') {
      const b = await actions.blockAt(bx, by + 1, bz)
      try { await actions.digAt({ x: bx, y: by + 1, z: bz, name: b }) } catch (e) {}
    }
  } catch (e) {}

  // —— 5. 在脚下这块 3x3 区域围一圈两格高的墙（中间1格留给自己站）——
  // 站的圆心 = (bx, by, bz)，周围8格墙，高度 by+1 和 by+2 各一层
  let placed = 0
  let fail = 0
  const ring = []
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue // 中间是自己
      ring.push([dx, dz])
    }
  }
  // 先围低层，再围高层
  for (const level of [1, 2]) {
    for (const [dx, dz] of ring) {
      const x = bx + dx, y = by + level, z = bz + dz
      let cur = null
      try { cur = await actions.blockAt(x, y, z) } catch (e) {}
      // 已经是实心方块就不用放了
      if (cur && cur !== 'air' && cur !== 'cave_air' && cur !== 'water') { continue }
      let ok = false
      try { ok = await actions.place(blockType, x, y, z) } catch (e) {}
      if (ok) placed++
      else {
        fail++
        // 失败一次就换到附近方块再试（可能太远）
        try { await actions.goto(x, by, z, 2) } catch (e) {}
        try { ok = await actions.place(blockType, x, y, z) } catch (e) {}
        if (ok) { placed++; fail-- }
      }
      await sleep(80)
      if (fail > 8) break
    }
    if (fail > 8) break
  }

  // —— 6. 封顶：在头顶 by+3 铺一层，把自己盖住 ——
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
      await sleep(80)
    }
  }

  // —— 7. 回到中心站好，检查封闭情况 ——
  try { await actions.goto(bx, by, bz, 1) } catch (e) {}
  await sleep(300)

  // 检查四周是否都封上了
  let sealed = 0
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue
      const b = await actions.blockAt(bx + dx, by + 1, bz + dz)
      if (b && b !== 'air' && b !== 'cave_air') sealed++
    }
  }

  return '挖了' + mined + '块石头/泥土，用' + blockType + '围了避难所：墙' + placed +
         '块、顶' + roofPlaced + '块，四周封闭' + sealed + '/8，现在在(' +
         bx + ',' + by + ',' + bz + ')准备过夜'
} catch (e) {
  return '出错了: ' + e
}