#!/usr/bin/env node
'use strict'
/**
 * 把测试小号从记忆里清掉（UNHUMAN-SCAN #13）。
 *
 *   node scripts/purge-test-accounts.js           # 只看会删什么（不动文件）
 *   node scripts/purge-test-accounts.js --apply   # 真删
 *
 * 过滤逻辑和 src/memory/writer.js 里的 isTestAccount() 是同一套：
 * XJJ + 4 位以上大写字母/数字，主账号（config.json 的 bot.username）除外。
 *
 * 为什么需要这个脚本：writer.js 的过滤只对**新写入**生效，
 * 已经在 data/runtime/memory.json 里的 4 条测试号记录不会自己消失。
 * 删之前会写一份 .bak。
 */

const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const { isTestAccount } = require(path.join(ROOT, 'src', 'memory', 'writer'))

const APPLY = process.argv.includes('--apply')

function mainAccount () {
  for (const f of ['config.json', 'config.example.json']) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'))
      if (cfg.bot && cfg.bot.username) return cfg.bot.username
    } catch (e) {}
  }
  return 'XJJ'
}

const MAIN = mainAccount()
for (const rel of ['data/runtime/memory.json', 'data/runtime-min/memory.json']) {
  const file = path.join(ROOT, rel)
  if (!fs.existsSync(file)) { console.log(`- ${rel}：不存在，跳过`); continue }

  const mem = JSON.parse(fs.readFileSync(file, 'utf8'))
  const people = Object.keys(mem.people || {})
  const badPeople = people.filter(n => isTestAccount(n, MAIN))
  const entries = mem.entries || []
  const badEntries = entries.filter(e => {
    const who = Array.isArray(e.who) ? e.who : (e.who ? [e.who] : [])
    const hit = who.length ? who.every(n => isTestAccount(n, MAIN)) : false
    return hit || /第一次见到\s*XJJ[A-Z0-9]{4,}/.test(e.text || '')
  })

  console.log(`\n${rel}`)
  console.log(`  主账号: ${MAIN}`)
  console.log(`  people: ${people.length} 个，其中测试号 ${badPeople.length} 个 ${JSON.stringify(badPeople)}`)
  console.log(`  entries: ${entries.length} 条，其中测试号相关 ${badEntries.length} 条`)
  for (const e of badEntries) console.log(`    · ${e.text}`)

  if (!badPeople.length && !badEntries.length) { console.log('  没有要清的东西'); continue }
  if (!APPLY) { console.log('  （只是预览，加 --apply 才真删）'); continue }

  fs.writeFileSync(file + '.bak', JSON.stringify(mem, null, 1), 'utf8')
  for (const n of badPeople) delete mem.people[n]
  mem.entries = entries.filter(e => !badEntries.includes(e))
  mem.journal = (mem.journal || []).filter(j => !/XJJ[A-Z0-9]{4,}/.test(String(j.text || '')))
  fs.writeFileSync(file, JSON.stringify(mem, null, 1), 'utf8')
  console.log(`  已清理，备份在 ${path.basename(file)}.bak`)
}
