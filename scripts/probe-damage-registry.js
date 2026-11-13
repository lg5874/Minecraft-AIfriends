#!/usr/bin/env node
'use strict'
/**
 * 探针：抓服务端真实的 damage_type registry（id -> 名字）。
 *
 *   node scripts/probe-damage-registry.js
 *
 * 背景：1.20.5+ 服务端的注册表走 `registry_data` 包下发，mineflayer 只挑
 * chat_type / dimension_type / biome 收下（见 prismarine-registry/lib/pc/index.js），
 * damage_type 被丢掉。所以 `bot.registry.damage_type` 永远是 undefined，
 * 而 damage_event 包里的 sourceTypeId 就是这张表的下标 —— 补表只能自己拦包。
 *
 * 本探针只连一次、只读 registry，不玩、不动世界，结果写到 data/probe-damage/。
 */

const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const mineflayer = require(path.join(ROOT, 'node_modules', 'mineflayer'))

const argv = process.argv.slice(2)
const argOf = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).bot
const ACCOUNT = argOf('account', 'XJJ_DMG' + Math.random().toString(36).slice(2, 6))
const OUT_DIR = path.join(ROOT, 'data', 'probe-damage')

const registries = {}

function main () {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  console.log(`账号 ${ACCOUNT} -> ${CFG.host}:${CFG.port} (${CFG.version})`)

  const bot = mineflayer.createBot({
    username: ACCOUNT,
    host: CFG.host,
    port: CFG.port,
    version: CFG.version,
    auth: 'offline'
  })

  bot._client.on('registry_data', (packet) => {
    const codec = packet.codec || packet
    const id = String(codec.id || '')
    const entries = Array.isArray(codec.entries) ? codec.entries : []
    registries[id] = entries.map((e, ix) => ({ id: ix, name: e && e.key }))
    console.log(`[registry] ${id}  ${entries.length} 条`)
  })

  bot.once('spawn', () => {
    setTimeout(dump, 1500)
  })

  bot.on('error', (e) => console.log('[error] ' + (e && e.message)))

  function dump () {
    const dt = registries['minecraft:damage_type'] || []
    console.log('\n=== damage_type ===')
    if (!dt.length) {
      console.log('（没抓到 —— 注册表 id 可能不叫 minecraft:damage_type，看下面的清单）')
    }
    for (const e of dt) console.log(`${String(e.id).padStart(3)}  ${e.name}`)
    console.log('\n=== 所有抓到的注册表 ===')
    for (const k of Object.keys(registries)) console.log(`${k} = ${registries[k].length}`)

    const out = path.join(OUT_DIR, `registry-${ACCOUNT}.json`)
    fs.writeFileSync(out, JSON.stringify(registries, null, 1))
    console.log('\n写到 ' + path.relative(ROOT, out))

    const only = {}
    for (const e of dt) only[e.id] = String(e.name || '').replace('minecraft:', '')
    fs.writeFileSync(path.join(OUT_DIR, 'damage-type-id.json'), JSON.stringify(only, null, 1))
    console.log('id->名字：' + path.relative(ROOT, path.join(OUT_DIR, 'damage-type-id.json')))
    try { bot.quit() } catch (e) {}
    setTimeout(() => process.exit(0), 500)
  }

  setTimeout(() => { console.log('超时退出'); process.exit(2) }, 60000)
}

main()
