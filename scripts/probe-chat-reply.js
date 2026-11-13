#!/usr/bin/env node
/**
 * 「用户喊他，他会不会应」的端到端探针。
 *
 * 【为什么这是最关键的验证】
 * Goal 的判据里有一条：「用户喊他，他来了，路上说了一句」。
 * 今晚所有的说话修复（spont.tick 从两处 return 里救出来、六条语言判据、
 * 复读窗口扩到 30 分钟）——**全部只在"他自言自语"的路径上验过**。
 * 「别人叫他 → 他回应」这条路，一次都没端到端跑过。
 *
 * 这个脚本用一个普通玩家名（不是 XJJ_ 开头，不会被 looksLikeBot 过滤）
 * 连上去，说几句话，然后看他有没有回。
 *
 * 用法：
 *   AIFRIEND_DATA=/tmp/chat-probe node scripts/probe-chat-reply.js
 *
 * 它只读聊天，不动主 bot、不改任何数据。
 */

const path = require('path')
const ROOT = path.resolve(__dirname, '..')
process.chdir(ROOT)

const mineflayer = require('mineflayer')
const fs = require('fs')

const cfgPath = process.env.AIFRIEND_CONFIG || 'config.json'
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, cfgPath), 'utf8'))
const host = cfg.bot.host
const port = cfg.bot.port || 25565

// 目标：主 bot 的名字
const TARGET = process.env.TARGET_BOT || 'XJJ'

// 探针自己的名字：故意用普通玩家名，避开 looksLikeBot 的
// /^(bot|ai|npc)/ /^Test\d*/ /^XJJ\d+$/ /^XJJ[_-]…/ 这些规则
const ME = process.env.PROBE_NAME || 'Steve' + (Date.now() % 1000)

console.log(`[probe] 连 ${host}:${port} 作为 ${ME}，要喊 ${TARGET}`)

const bot = mineflayer.createBot({ host, port, username: ME, auth: 'offline', version: cfg.bot.version || false })

const heard = []
let done = false
function finish (code) {
  if (done) return
  done = true
  try { bot.quit() } catch (e) {}
  setTimeout(() => process.exit(code), 400)
}

bot.on('error', (e) => console.log('[probe] error:', e && e.message))
bot.on('kicked', (r) => { console.log('[probe] kicked:', JSON.stringify(r).slice(0, 100)); finish(2) })

bot.on('chat', (username, message) => {
  if (username === ME) return
  heard.push({ at: Date.now(), username, message })
  console.log(`  [听到] ${username}: ${message}`)
})

bot.once('spawn', async () => {
  console.log('[probe] spawned at', bot.entity.position.toString())
  await sleep(2500)

  // 三个场景，覆盖用户最可能说的三种话
  const sayings = [
    `${TARGET} 你在干啥`,      // 问句 + 含名字 -> chat_me
    `${TARGET} 过来`,           // 指令 + 含名字 -> chat_me（也是 invite）
    '这地方真难找啊'            // 纯自言自语 -> chat_any（预期不接，那是设计）
  ]

  for (const s of sayings) {
    console.log(`\n[probe] === 我说：${s} ===`)
    const before = heard.length
    bot.chat(s)
    // 等他反应：模型往返 2-6 秒 + 限速，给足 25 秒
    await sleep(25000)
    const got = heard.slice(before).filter(h => h.username === TARGET)
    if (got.length) {
      for (const g of got) console.log(`  ✅ 他回了：${g.message}`)
    } else {
      console.log('  （没回）')
    }
  }

  console.log('\n[probe] ===== 结论 =====')
  const fromTarget = heard.filter(h => h.username === TARGET)
  console.log(`[probe] 他总共说了 ${fromTarget.length} 句`)
  for (const h of fromTarget) console.log('  ·', h.message.slice(0, 60))
  finish(fromTarget.length > 0 ? 0 : 1)
})

function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }
setTimeout(() => { console.log('[probe] 总超时，退出'); finish(3) }, 150000)
