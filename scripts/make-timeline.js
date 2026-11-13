#!/usr/bin/env node
/**
 * 把 bot 日志洗成「玩家视角时间线」。
 *
 * 【为什么需要】
 * 走查的执行人必须是盲的，而且**不能喂日志原文**——
 * 日志里有 [ctx]/[proof]/[skill] 这些内部痕迹，会让执行人顺着找破绽，
 * 而不是"作为一个玩家舒不舒服"。今晚已经吃过一次这个亏（盲测洗了 6 版规则）。
 *
 * 所以这个脚本只保留**一个站在旁边的玩家能看到/听到的东西**：
 *   他出现在哪 / 他移动了 / 他挖了 / 他坐下了 / 他说了什么 / 玩家说了什么
 *
 * 丢掉：所有 [xxx] 内部标签、时间戳精度、坐标小数、技能名、判据、成本、锁。
 *
 * 用法：
 *   node scripts/make-timeline.js --log /tmp/soak2.log --out /tmp/walk.txt
 *   node scripts/make-timeline.js --log /tmp/soak2.log --player XJJ   # 指定"我"的名字
 */

const fs = require('fs')

const argv = process.argv.slice(2)
function arg (name, def) {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}

const LOG = arg('log', '/tmp/soak2.log')
const OUT = arg('out', '/tmp/walk.txt')
const ME = arg('player', '')     // 用户的名字；不给就把所有非 bot 的名字都当"玩家"

if (!fs.existsSync(LOG)) {
  console.error('日志不存在: ' + LOG)
  process.exit(1)
}

const lines = fs.readFileSync(LOG, 'utf8').split('\n')

// 找出 bot 自己的名字
let BOT = ''
for (const ln of lines) {
  const m = ln.match(/进来了：([A-Za-z0-9_]+)/)
  if (m) { BOT = m[1]; break }
}
if (!BOT) {
  for (const ln of lines) {
    const m = ln.match(/连接 \S+ 作为 ([A-Za-z0-9_]+)/)
    if (m) { BOT = m[1]; break }
  }
}

let t0 = null
function rel (ln) {
  const m = ln.match(/^\[(\d{2}):(\d{2}):(\d{2})\]/)
  if (!m) return null
  const s = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])
  if (t0 == null) t0 = s
  const d = s - t0
  return `[${String(Math.floor(d / 60)).padStart(2, '0')}:${String(d % 60).padStart(2, '0')}]`
}

// ---- 只保留"玩家能看到/听到的"----
const out = []
let lastPos = null
let movedAccum = 0

function emit (ln, text) {
  const r = rel(ln)
  if (r) out.push(`${r} ${text}`)
}

for (const ln of lines) {
  if (!ln.trim()) continue

  // 1. 他说的（玩家能听见）
  let m = ln.match(/\[say\] (.+)$/)
  if (m) { emit(ln, `他说：${m[1].trim()}`); continue }

  // 2. 别人说的（日志里 [events] 下的 · 名字 说：…）
  m = ln.match(/· ([A-Za-z0-9_]{3,16}) (?:跟你说|说)[：:]\s*(.+)$/)
  if (m && m[1] !== BOT) { emit(ln, `${m[1]} 说：${m[2].trim()}`); continue }

  // 3. 他做了什么事（任务标题，但去掉"卡了N秒""可行性NN"这种）
  m = ln.match(/>>> 开始：(.+)$/)
  if (m) { emit(ln, `他开始：${cleanTask(m[1])}`); continue }
  m = ln.match(/<<< 完成（(\d+)s）：(.+)$/)
  if (m) { emit(ln, `他做完了（${m[1]} 秒）：${cleanTask(m[2])}`); continue }
  m = ln.match(/<<< 失败（(\d+)s）：(.+)$/)
  if (m) { emit(ln, `他放弃了（${m[1]} 秒）：${cleanTask(m[2])}`); continue }

  // 4. 位移（玩家能看到他在走）
  m = ln.match(/\[hb\] (-?\d+),(-?\d+),(-?\d+)\s+血(\d+)/)
  if (m) {
    const p = { x: +m[1], y: +m[2], z: +m[3] }
    if (lastPos) {
      const d = Math.hypot(p.x - lastPos.x, p.z - lastPos.z)
      movedAccum += d
      if (movedAccum >= 15) {
        emit(ln, `他往远处走了（这一段走了约 ${Math.round(movedAccum)} 格，现在 y=${p.y}）`)
        movedAccum = 0
      }
    }
    lastPos = p
    continue
  }

  // 5. 摔 / 死
  if (/\[fall\] 落差/.test(ln)) { emit(ln, '他摔下去了'); continue }
  m = ln.match(/\[death\] (.+)/)
  if (m) { emit(ln, `他死了：${cleanTask(m[1])}`); continue }

  // 6. 上下线（玩家能看到"他进来/走了"）
  m = ln.match(/进来了：([A-Za-z0-9_]+)/)
  if (m) { emit(ln, `【${m[1]} 上线了】`); continue }
  if (/被服务器踢了/.test(ln)) { emit(ln, '【他掉线了】'); continue }
}

function cleanTask (s) {
  return String(s)
    .replace(/可行性\s*\d+/g, '')
    .replace(/（\d+秒没动）/g, '')
    .replace(/\{["'][^}]*\}/g, '')
    .replace(/[\d.]+,-?[\d.]+ 一带/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
}

const header = [
  '# 玩家视角时间线（不含任何内部日志）',
  `# bot: ${BOT || '?'}`,
  '# 说明：这是一个站在旁边的玩家能看到/听到的全部内容。',
  '# 只有"他说""他说了什么""他做了什么""他走到哪""他死了"。',
  ''
].join('\n')

fs.writeFileSync(OUT, header + out.join('\n') + '\n')
console.log(`写了 ${out.length} 条 -> ${OUT}`)
console.log(`bot=${BOT}`)
