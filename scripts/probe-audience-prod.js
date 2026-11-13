#!/usr/bin/env node
'use strict'
/**
 * 生产路径验收的"观察者"：一个真人样的玩家，去贴着 main.js 跑的那个 bot 站着看。
 * 只负责靠近 + 看，不做别的。用法：
 *   node scripts/probe-audience-prod.js --target XJJ_AUD1 --seconds 300
 */
const mineflayer = require('mineflayer')
const pf = require('mineflayer-pathfinder')

const HOST = process.env.MC_HOST || 's205.singsi.cn'
const PORT = +(process.env.MC_PORT || 19830)
const VER = process.env.MC_VER || '1.21.11'
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null }
const TARGET = arg('--target') || 'XJJ_AUD1'
const DUR = (+(arg('--seconds') || 300)) * 1000
const NAME = process.env.WATCHER_NAME || 'XJJVIEWER1'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log('[观察者]', ...a)
const t0 = Date.now()

async function main () {
  let bot = null
  for (let i = 0; i < 4 && !bot; i++) {
    try {
      bot = mineflayer.createBot({ host: HOST, port: PORT, username: NAME, version: VER, auth: 'offline' })
      bot.loadPlugin(pf.pathfinder)
      await new Promise((res, rej) => {
        const to = setTimeout(() => rej(new Error('超时')), 40000)
        bot.once('spawn', () => { clearTimeout(to); res() })
        bot.once('error', e => { clearTimeout(to); rej(e) })
      })
    } catch (e) {
      log('连接失败：' + e.message + '，45s 后重试')
      try { bot && bot.quit() } catch (_) {}
      bot = null
      await sleep(45000)
    }
  }
  if (!bot) throw new Error('连不上')
  log('上线，目标=' + TARGET)

  const mv = new pf.Movements(bot, require('minecraft-data')(bot.VER || VER))
  mv.canDig = true
  mv.maxDropDown = 4
  bot.pathfinder.setMovements(mv)

  const samples = []
  const tick = setInterval(() => {
    const t = bot.players[TARGET]
    const me = bot.entity && bot.entity.position
    if (!t || !t.entity || !me) { samples.push({ t: Date.now() - t0, d: null }); return }
    const p = t.entity.position
    const d = me.distanceTo(p)
    samples.push({ t: Date.now() - t0, d: +d.toFixed(1) })
    if (d > 3) {
      try { bot.pathfinder.setGoal(new pf.goals.GoalFollow(t.entity, 2), true) } catch (e) {}
    } else {
      try { bot.pathfinder.setGoal(null) } catch (e) {}
      const ey = (p.y + 1.6) - (me.y + 1.6)
      try { bot.look(Math.atan2(-(p.x - me.x), p.z - me.z), Math.atan2(ey, Math.max(0.4, Math.hypot(p.x - me.x, p.z - me.z))), true) } catch (e) {}
    }
  }, 1000)

  await sleep(DUR)
  clearInterval(tick)
  const ds = samples.map(x => x.d).filter(x => x != null).sort((a, b) => a - b)
  const q = p => (ds.length ? ds[Math.min(ds.length - 1, Math.floor((ds.length - 1) * p))] : null)
  log(`在场 ${samples.length}s，可见 ${ds.length}s，距离 p50=${q(0.5)} min=${ds[0]}；8 格内 ${ds.filter(x => x <= 8).length} 秒`)
  try { bot.quit() } catch (e) {}
  process.exit(0)
}
main().catch(e => { console.error('观察者崩了', e.message); process.exit(1) })
