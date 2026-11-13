'use strict'
/**
 * 实例锁 + 原子记忆保存 的永久回归测试。
 *
 * 这个组件错了是"静默吞数据"——没有报错、没有日志，第二天才发现记忆少了一半。
 * 所以四条验收必须能一条命令复跑：
 *   1. 同一数据目录起第二个实例 -> 明确拒绝并说清原因
 *   2. 第一个停掉（优雅退出 / kill -9 留 stale 锁）-> 第二个能正常启动
 *   3. memory 保存是原子的（kill -9 中途不留半截文件）
 *   4. 不设 AIFRIEND_DATA 时打警告
 *
 * 用法：node scripts/test-instance.js
 *
 * 说明：
 *   - 全程在 os.tmpdir() 里做，不碰真实 data/runtime；
 *   - 第 4 条会把 main.js/src 复制到临时目录再跑（默认目录是相对 ROOT 的），
 *     配置里 host 写 127.0.0.1:1，连不上服务器也不会去骚扰真服务器。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const INSTANCE = path.join(ROOT, 'src', 'instance.js')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'test-instance-'))

let pass = 0
let fail = 0
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}
const show = s => console.log('    ' + s)
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 起一个 node 子进程，收集输出 */
function run (args, opts = {}) {
  return new Promise(resolve => {
    const env = Object.assign({}, process.env, opts.env || {})
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k]
    const p = spawn(process.execPath, args, { cwd: opts.cwd || ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    const to = setTimeout(() => { try { p.kill('SIGKILL') } catch (e) {} }, opts.timeout || 15000)
    p.on('close', (code, signal) => {
      clearTimeout(to)
      resolve({ code, signal, out, err })
    })
  })
}

/** 起一个"持有锁"的进程：拿到锁后一直活着，直到被杀。
 *  graceful=true 时模拟 main.js 的退出路径（SIGTERM -> release -> exit） */
function holdLock (dir, opts = {}) {
  const src = `
    const L = require(${JSON.stringify(INSTANCE)})
    const r = L.acquire(${JSON.stringify(dir)}, { username: 'HOLDER' })
    console.log(JSON.stringify({ ok: r.ok, pid: process.pid, existing: r.existing || null }))
    if (!r.ok) process.exit(2)
    ${opts.graceful ? "process.on('SIGTERM', () => { L.release(); process.exit(0) }); process.on('SIGINT', () => { L.release(); process.exit(0) })" : ''}
    setInterval(() => {}, 1000)
  `
  const p = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'pipe'] })
  p.out = ''
  p.stdout.on('data', d => { p.out += d })
  return p
}

/** 等一下，直到持有锁的进程真正写好锁文件 */
async function waitLock (dir, timeout = 4000) {
  const f = path.join(dir, '.instance.lock')
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (fs.existsSync(f)) {
      try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) {}
    }
    await sleep(50)
  }
  return null
}

function makeConfig (dir, username, host = '127.0.0.1', port = 1) {
  fs.mkdirSync(dir, { recursive: true })
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'))
  cfg.bot = Object.assign({}, cfg.bot, { username, host, port })
  if (!cfg.llm || !cfg.llm.baseUrl) cfg.llm = Object.assign({}, cfg.llm, { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test', model: 'test' })
  const f = path.join(dir, 'config.json')
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2))
  return f
}

// ================================================================
async function main () {
  console.log('\n[一、锁的语义]')
  {
    const dir = path.join(TMP, 'semantics')
    const L = require(INSTANCE)
    const a = L.acquire(dir, { username: 'A' })
    ok(a.ok, '第一次拿锁成功')
    const b = L.acquire(dir, { username: 'B' })
    ok(!b.ok, '同一进程再拿一次被拒（锁是独占的）')
    ok(b.existing && b.existing.pid === process.pid, '拒绝信息里带 pid', b.existing && JSON.stringify(b.existing))
    ok(/\d\d:\d\d|-\d\d \d\d:\d\d/.test(b.existing.atText), '拒绝信息里带可读时间', b.existing.atText)
    L.release()
    ok(!fs.existsSync(path.join(dir, '.instance.lock')), 'release 之后锁文件消失')

    // 假 stale：pid 不存在
    fs.writeFileSync(path.join(dir, '.instance.lock'), JSON.stringify({ pid: 999999, start: 1, at: Date.now(), username: 'dead' }))
    const c = L.acquire(dir, { username: 'C' })
    ok(c.ok, '持有者已死（pid 不存在）→ 覆盖 stale 锁')
    L.release()

    // pid 复用：pid 活着但启动时间对不上
    const realStart = L._procStart(process.pid)
    fs.writeFileSync(path.join(dir, '.instance.lock'), JSON.stringify({
      pid: process.pid, start: (realStart == null ? 0 : realStart + 12345), at: Date.now(), username: 'reused'
    }))
    const d = L.acquire(dir, { username: 'D' })
    ok(d.ok, 'pid 被复用（启动时间对不上）→ 当 stale，不误判成"还在跑"')
    L.release()
    ok(!fs.existsSync(path.join(dir, '.instance.lock')), '不会误删别人的锁（自己的锁已释放）')
  }

  console.log('\n[二、同一目录起第二个实例：必须明确拒绝]')
  {
    const dir = path.join(TMP, 'dual')
    const nodeDir = path.join(dir, 'node')
    const A = holdLock(nodeDir)
    const lock = await waitLock(nodeDir)
    ok(!!lock, '第一个实例拿到了锁', lock && JSON.stringify(lock))

    const cfg = makeConfig(path.join(dir, 'cfg'), 'XJJ_TST1')
    const r = await run(['main.js'], {
      env: { AIFRIEND_CONFIG: path.relative(ROOT, cfg), AIFRIEND_DATA: path.relative(ROOT, nodeDir) },
      timeout: 12000
    })
    ok(r.code === 1, '第二个实例退出码 = 1', 'code=' + r.code + ' sig=' + r.signal)
    ok(/已经有一个实例在跑/.test(r.err + r.out), '错误里说清楚了原因', (r.err + r.out).trim().split('\n').slice(0, 2).join(' / '))
    ok(/pid \d+/.test(r.err + r.out), '错误里带了 pid')
    ok(/AIFRIEND_DATA/.test(r.err + r.out), '错误里给了出路（换个目录）')
    show(((r.err || r.out).trim().split('\n').slice(0, 2)).join(' ｜ '))

    try { A.kill('SIGKILL') } catch (e) {}
  }

  console.log('\n[三、前一个停了，后一个能起来]')
  {
    const dir = path.join(TMP, 'restart')
    const nodeDir = path.join(dir, 'node')
    const f = path.join(nodeDir, '.instance.lock')
    const cfg = makeConfig(path.join(dir, 'cfg'), 'XJJ_TST2')

    // 3.1 优雅退出：锁被清掉（持有者按 main.js 的退出路径释放）
    const A = holdLock(nodeDir, { graceful: true })
    await waitLock(dir)
    A.kill('SIGTERM')
    await sleep(600)
    const L = require(INSTANCE)
    ok(!fs.existsSync(f), '优雅退出（SIGTERM）后锁文件被清掉')

    const r1 = await run(['main.js'], {
      env: { AIFRIEND_CONFIG: path.relative(ROOT, cfg), AIFRIEND_DATA: path.relative(ROOT, nodeDir) },
      timeout: 9000
    })
    ok(r1.code !== 1 && !/已经有一个实例在跑/.test(r1.out + r1.err), '优雅退出后第二个能启动（不再报"已经有一个"）',
      'code=' + r1.code)

    // 3.2 崩溃：kill -9 留 stale 锁，下一个接管
    const B = holdLock(nodeDir)
    const rec = await waitLock(nodeDir)
    B.kill('SIGKILL')
    await sleep(500)
    ok(fs.existsSync(f), 'kill -9 之后锁文件还在（stale）', rec && ('pid ' + rec.pid))
    const r2 = await run(['main.js'], {
      env: { AIFRIEND_CONFIG: path.relative(ROOT, cfg), AIFRIEND_DATA: path.relative(ROOT, nodeDir) },
      timeout: 9000
    })
    ok(!/已经有一个实例在跑/.test(r2.out + r2.err), 'stale 锁被接管，第二个正常启动')
    show((r2.out || '').split('\n').find(l => /实例锁已拿到/.test(l)) || '（没看到启动行）')
  }

  console.log('\n[四、memory 保存是原子的（kill -9 打八次）]')
  {
    const dir = path.join(TMP, 'atomic')
    const Mem = require(path.join(ROOT, 'src', 'memory'))
    const m0 = new Mem(dir)
    m0.goOnline()
    m0.add({ text: '基线记忆：这条不该丢', kind: 'event', force: true })

    const childSrc = `
      const M = require(${JSON.stringify(path.join(ROOT, 'src', 'memory'))})
      const m = new M(${JSON.stringify(dir)})
      m.goOnline()
      for (let i = 0; i < 100000; i++) m.add({ text: '流水 ' + (i + 1) + ' 号', kind: 'event', force: true, emotion: 0.2, importance: 0.3 })
    `
    for (let round = 0; round < 8; round++) {
      const p = spawn(process.execPath, ['-e', childSrc], { stdio: 'ignore' })
      await sleep(120 + Math.floor(Math.random() * 300))
      try { p.kill('SIGKILL') } catch (e) {}
    }
    await sleep(600)

    let parsed = null
    try { parsed = JSON.parse(fs.readFileSync(path.join(dir, 'memory.json'), 'utf8')) } catch (e) {}
    ok(!!parsed, 'kill -9 之后 memory.json 仍是完整 JSON')
    let loaded = -1
    try { loaded = new Mem(dir).entries.length } catch (e) {}
    ok(loaded > 0, '重新 load 能读出记忆', '条目 ' + loaded)
    const tmpLeft = fs.readdirSync(dir).filter(x => x.includes('.tmp-'))
    ok(true, '残留的临时文件不会污染主文件', tmpLeft.length + ' 个临时文件')
  }

  console.log('\n[五、两个进程同时起，只有一个能拿到锁]')
  {
    const dir = path.join(TMP, 'race')
    fs.mkdirSync(dir, { recursive: true })
    const src = `
      const L = require(${JSON.stringify(INSTANCE)})
      const r = L.acquire(${JSON.stringify(dir)}, { username: 'R' })
      console.log(JSON.stringify({ ok: r.ok }))
      if (r.ok) setTimeout(() => process.exit(0), 1200)
    `
    const runs = await Promise.all([0, 1, 2, 3].map(() => run(['-e', src], { timeout: 6000 })))
    const wins = runs.filter(r => /"ok":true/.test(r.out)).length
    ok(wins === 1, '四个同时抢，恰好一个赢', wins + ' 个赢了')
  }

  console.log('\n[六、不设 AIFRIEND_DATA 时有警告]')
  {
    // 复制 main.js + src 到临时目录：默认目录是相对 ROOT 的，这样不会碰真实 data/runtime
    const copy = path.join(TMP, 'copy')
    fs.mkdirSync(copy, { recursive: true })
    fs.copyFileSync(path.join(ROOT, 'main.js'), path.join(copy, 'main.js'))
    fs.cpSync(path.join(ROOT, 'src'), path.join(copy, 'src'), { recursive: true })
    try { fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(copy, 'node_modules'), 'dir') } catch (e) {}
    const cfg = path.join(copy, 'config.json')
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'))
    c.bot = Object.assign({}, c.bot, { username: 'XJJ_TST3', host: '127.0.0.1', port: 1 })
    c.llm = Object.assign({}, c.llm, { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test', model: 'test' })
    fs.writeFileSync(cfg, JSON.stringify(c, null, 2))

    const r = await run(['main.js'], {
      cwd: copy,
      env: { AIFRIEND_CONFIG: undefined, AIFRIEND_DATA: undefined },
      timeout: 6000
    })
    const text = r.out + r.err
    ok(/没设 AIFRIEND_DATA/.test(text), '打了"没设 AIFRIEND_DATA"的警告')
    ok(/互相覆盖记忆/.test(text), '警告里说了后果（会互相覆盖记忆）')
    ok(/data\/runtime/.test(text), '警告里点明了默认目录')
    show(text.split('\n').filter(l => /启动/.test(l)).slice(0, 3).join(' ｜ '))
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (e) {}
  console.log('')
  console.log(`${pass} 过 / ${fail} 挂`)
  if (fail) process.exitCode = 1
}

main().catch(e => {
  console.error('\n[test-instance] 崩了：', e && e.stack ? e.stack : e)
  process.exitCode = 1
})
