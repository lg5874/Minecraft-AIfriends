'use strict'
/**
 * 紧急直上。
 *
 * 场景：他困在地下出不来，getToSurface 想不通（比如头顶被好几层石头封死）。
 *
 * 真人这时候会怎么做？**不管三七二十一，直着往上挖。**
 * 挖一格、跳上去、垫一块、再挖。笨但一定有效。
 *
 * 这个函数跟 getToSurface 分开，作为最后兜底：
 * 当 getToSurface 失败、又确实需要出去的时候调用它。
 */

const { Vec3 } = require('vec3')

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 一路往上挖，直到看到天空或者到达 maxSteps。
 *
 * @param {object} bot  mineflayer bot
 * @param {object} opts
 * @param {function} opts.isUnderground  () => boolean
 * @param {function} opts.log
 * @param {number} [opts.maxSteps]  最多挖多少步
 * @returns {Promise<boolean>} 有没有出去
 */
async function emergencyDigUp (bot, opts = {}) {
  const log = opts.log || (() => {})
  const isUnderground = opts.isUnderground || (() => false)
  const maxSteps = opts.maxSteps || 80

  log('[digup] 紧急直上：不管地形，一路往上挖')

  // 找垫脚方块
  const findFiller = () => {
    for (const n of ['dirt', 'cobblestone', 'andesite', 'stone', 'gravel', 'granite', 'diorite', 'cobbled_deepslate']) {
      const it = bot.inventory.items().find(i => i.name === n && i.count > 0)
      if (it) return it
    }
    return null
  }

  if (!findFiller()) {
    log('[digup] 没有垫脚方块，挖上去也站不住')
    return false
  }

  const startY = bot.entity.position.y
  let climbed = 0

  for (let step = 0; step < maxSteps; step++) {
    if (!isUnderground()) {
      log(`[digup] 出来了，y=${Math.round(bot.entity.position.y)}（上升 ${Math.round(bot.entity.position.y - startY)} 格）`)
      return true
    }

    const p = bot.entity.position

    // 1. 挖头顶 3 格（给自己腾出空间）
    for (let dy = 1; dy <= 3; dy++) {
      const b = bot.blockAt(p.offset(0, dy, 0))
      if (!b || b.boundingBox !== 'block') continue
      if (/bedrock|lava|water/.test(b.name)) {
        log('[digup] 头顶是' + b.name + '，不能直上')
        return false
      }
      try {
        // 用最合适的工具
        const tool = bot.pathfinder && bot.pathfinder.bestHarvestTool
          ? bot.pathfinder.bestHarvestTool(b) : null
        if (tool) await bot.equip(tool, 'hand')
        await bot.dig(b, true)
        await sleep(120)
      } catch (e) {
        log('[digup] 挖失败: ' + e.message)
        break
      }
    }

    // 2. 跳
    const beforeY = bot.entity.position.y
    try {
      bot.setControlState('jump', true)
      await sleep(60)
      // 3. 在空中垫方块到脚下
      const filler = findFiller()
      if (filler) {
        await bot.equip(filler, 'hand')
        // 低头看脚下
        await bot.look(bot.entity.yaw, Math.PI / 2, true)
        const below = bot.blockAt(bot.entity.position.offset(0, -1, 0))
        if (below && below.boundingBox === 'block') {
          try { await bot.placeBlock(below, new Vec3(0, 1, 0)) } catch (e) {}
        }
      }
      await sleep(200)
      bot.setControlState('jump', false)
      await sleep(250)
    } catch (e) {
      try { bot.setControlState('jump', false) } catch (e2) {}
    }

    const nowY = bot.entity.position.y
    if (nowY > beforeY + 0.4) {
      climbed++
      if (climbed % 5 === 0) log(`[digup] 上升 ${climbed} 格，现在 y=${Math.round(nowY)}`)
    } else {
      // 没上去：试试原地跳（可能脚下的方块没垫上）
      try {
        bot.setControlState('jump', true)
        await sleep(400)
        bot.setControlState('jump', false)
        await sleep(200)
      } catch (e) {}
    }
  }

  const up = Math.round(bot.entity.position.y - startY)
  log(`[digup] 挖了 ${maxSteps} 步，上升 ${up} 格`)
  return !isUnderground()
}

module.exports = { emergencyDigUp }
