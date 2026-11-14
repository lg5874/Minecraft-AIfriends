#!/usr/bin/env node
'use strict'
/**
 * morning-check.sh 的时间炸弹守卫（2026-11-14 08:43 现场）
 *
 *   node scripts/test-morning-check.js
 *
 * 【现场】
 *   08:00 之后每次跑晨检都报：
 *     scripts/morning-check.sh: line 72: 08: value too great for base (error token is "08")
 *   原因：`$(( $(date +%H) * 3600 ... ))` —— bash 把 "08" 当前导零八进制，
 *   而 08/09 不是合法八进制。07:59 之前一直是好的，**到 8 点就坏**。
 *
 * 【这个测试为什么必须存在】
 * 它不可能被"白天跑一遍"发现 —— 只有 08/09 点这两个小时会红。
 * 所以要用合成日志把 00~09 这几个"有前导零"的时刻挨个喂进去。
 *
 * 只跑 bash，不连服务器、不碰 data/runtime。
 */

const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
// MC_SCRIPT 可指向一份旧的 morning-check.sh，用来验证这个守卫真的抓得住那个 bug
const SCRIPT = process.env.MC_SCRIPT || path.join(ROOT, 'scripts', 'morning-check.sh')

let pass = 0
let fail = 0
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morning-check-'))

function runWith (lines) {
  const log = path.join(dir, 'log-' + Math.random().toString(36).slice(2) + '.txt')
  fs.writeFileSync(log, lines.join('\n') + '\n')
  const r = spawnSync('bash', [SCRIPT], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { MC_LOG: log }),
    encoding: 'utf8'
  })
  return { out: (r.stdout || '') + (r.stderr || ''), status: r.status }
}

// 前导零的时刻：00/01/08/09 都是八进制陷阱区
const HOURS = ['00', '01', '08', '09']
for (const h of HOURS) {
  const ts = `${h}:09:27`
  const ts2 = `${h}:09:40`
  const { out, status } = runWith([
    `[${ts}] [hb] 68,65,-91 血20 饿20 背包3种 空闲｜锁:空闲｜今天第1趟 心情:ok`,
    `[${ts2}] [say] 我找个树先`
  ])
  ok(!/value too great for base/.test(out), `${ts} 不报八进制错`, (out.match(/line \d+: [^\n]*/) || [''])[0])
  ok(status === 0, `${ts} 退出码 0`, 'exit=' + status)
  ok(/日志 \d+ 秒前还在写|日志已经/.test(out), `${ts} 新鲜度那行打出来了`)
}

// 卡死判定：时间戳停在很久以前 -> 必须报红
{
  const stale = '06:00:00'
  const { out } = runWith([
    `[${stale}] [hb] 68,65,-91 血20 饿20 背包3种 空闲｜锁:空闲｜今天第1趟 心情:ok`,
    `[${stale}] [say] 早`
  ])
  ok(/日志已经 \d+ 分钟没更新|日志 \d+ 秒前还在写/.test(out), '卡死判定有输出（不崩）')
}

// 血 7 必须被提（原版血 7 会说「一切正常」，这是 07:19 现场）
{
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const ts = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  const { out } = runWith([
    `[${ts}] [hb] 68,65,-91 血7 饿17 背包3种 空闲｜锁:空闲｜今天第1趟 心情:down`,
    `[${ts}] [say] 在`
  ])
  ok(/血 7 ≤ 8/.test(out), '血 7 会提示（≤8 档）', (out.match(/血 7[^\n]*/) || [''])[0].trim())
  ok(/ADVICE=1/.test(out), '结论不是「一切正常」')
}

// 一切正常时不该乱报
{
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const ts = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  const { out } = runWith([
    `[${ts}] [hb] 68,65,-91 血20 饿20 背包3种 空闲｜锁:空闲｜今天第1趟 心情:ok`,
    `[${ts}] [say] 在`
  ])
  ok(/ADVICE=0/.test(out), '血满饿满时 ADVICE=0', (out.match(/血 20[^\n]*/) || [''])[0].trim())
}

fs.rmSync(dir, { recursive: true, force: true })
console.log('\n==============================================')
console.log(`${pass} 通过，${fail} 失败`)
if (fail) { console.log('有失败项'); process.exit(1) }
console.log('晨检脚本守卫全过')
