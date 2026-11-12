// 目标：把脚边的铜矿石捡起来/挖出来，堆成一摞看看能摞多高
try {
  // 1. 先看看背包里现在有多少铜矿石相关物品
  let have = actions.countOf('raw_copper') + actions.countOf('copper_ore')
  log('开始时铜相关物品：' + have)

  // 2. 看看附近有没有铜矿石方块（脚边、周围）
  let mined = 0
  for (let i = 0; i < 40; i++) {
    const ore = await actions.findBlock('copper_ore', 8)
    if (!ore) break

    // 换到合适的镐，石镐以上才能挖铜矿
    try { await actions.bestToolFor(ore) } catch (e) { log('换工具出错:' + e) }

    const ok = await actions.digAt(ore)
    if (!ok) {
      // 够不到就挪近点再试一次
      try { await actions.goto(ore.x, ore.y, ore.z, 2) } catch (e) {}
      const ok2 = await actions.digAt(ore)
      if (!ok2) break
    }
    mined++
    await sleep(120)
  }

  // 3. 把地上的掉落物捡起来
  for (let i = 0; i < 5; i++) {
    try { await actions.pickupNearby(4) } catch (e) { log('捡东西出错:' + e) }
    await sleep(200)
  }

  // 4. 数一数现在有多少铜矿石
  const copperOre = actions.countOf('copper_ore')
  const rawCopper = actions.countOf('raw_copper')
  let total = copperOre + rawCopper

  // 5. 如果挖到的是 raw_copper，先熔炼？没有炉子的话就先算 raw_copper 摞起来
  //    这里直接统计能摞起来的总数（铜矿石方块 / 原铜）
  let stackCount = total
  let height = Math.floor(stackCount / 1) // 每格摞1个方块高度计算
  // 如果要做成铜锭也能摞，但我们先按现有物品摞

  // 6. 尝试垒起来：有铜矿石方块就垒方块，否则把 raw_copper 摞在脚边（用 place 放不了 raw_copper，只能放方块）
  let placed = 0
  if (copperOre > 0) {
    // 选个脚边空地垒
    for (let i = 0; i < copperOre && i < 17; i++) {
      const p = actions.pos()
      const ok = await actions.place('copper_ore', p.x + 1, p.y + (placed < 16 ? placed : 0), p.z)
      if (ok) placed++
      // 摞满了就换个位置
      if (placed >= 16) break
      await sleep(100)
    }
  }

  const finalCopperOre = actions.countOf('copper_ore')
  const finalRaw = actions.countOf('raw_copper')

  return '挖了' + mined + '个铜矿方块，现在有铜矿石' + finalCopperOre + '个、原铜' + finalRaw +
         '个，一共' + (finalCopperOre + finalRaw) + '个铜料，垒起了' + placed + '块铜矿石'
} catch (e) {
  return '出错了: ' + e
}