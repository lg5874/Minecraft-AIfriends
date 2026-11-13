'use strict'
/**
 * 实例锁 —— 一个数据目录只允许一个进程在跑。
 *
 * 为什么要有：
 *   main.js 不设 AIFRIEND_DATA 就用 data/runtime。两个实例共用同一个目录时，
 *   memory.json 是**整文件覆盖**，谁最后写谁说了算：A 写一条、B 写一条，
 *   盘上只剩 B 那条 —— 没有任何报错，A 的记忆就静默没了。
 *
 * 判据不只看 pid：进程号会被复用。锁里同时记下 /proc/<pid>/stat 的启动时间，
 * 两者都对得上才算"那个实例还活着"，否则当 stale 锁覆盖掉。
 *
 * 用法：
 *   const lock = InstanceLock.acquire(DATA, { username: cfg.bot.username })
 *   if (!lock.ok) { 打印 lock.existing.pid / lock.existing.atText; process.exit(1) }
 *   // 正常退出时 process.on('exit') 会自动删锁；kill -9 留下的锁由下一个实例判定为 stale
 */

const fs = require('fs')
const path = require('path')

const LOCK_NAME = '.instance.lock'

/** 进程启动时间（/proc/<pid>/stat 第 22 个字段，单位 clock tick）。拿不到返回 null */
function procStart (pid) {
  try {
    const s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8')
    // comm 字段可能带空格和右括号，从最后一个 ')' 之后开始切
    const i = s.lastIndexOf(')')
    if (i < 0) return null
    const rest = s.slice(i + 2).trim().split(/\s+/)
    const v = Number(rest[19])
    return Number.isFinite(v) ? v : null
  } catch (e) {
    return null
  }
}

/** 这个 pid 还活着吗（EPERM 也算活着：进程在，只是不归我管） */
function pidAlive (pid) {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (e) {
    return e && e.code === 'EPERM'
  }
}

/**
 * 锁里记的进程还是不是"当初那个"。
 * pid 活着但启动时间对不上 = 进程号被复用了（或者机器重启了），当 stale。
 */
function stillTheSame (rec) {
  if (!rec || !rec.pid) return false
  if (!pidAlive(rec.pid)) return false
  if (rec.start == null) return true // 老锁没有 start 字段，只能信 pid
  const now = procStart(rec.pid)
  if (now == null) return true // 读不到 /proc（非 Linux），退回只看 pid
  return now === rec.start
}

function readLock (file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const d = JSON.parse(raw || '{}')
    if (!d || typeof d !== 'object') return null
    return d
  } catch (e) {
    return null
  }
}

/** 把时间说成人能对上的样子：22:30（同一天）/ 11-12 22:30 */
function atText (ms) {
  const t = Number(ms)
  if (!Number.isFinite(t) || t <= 0) return '未知时间'
  const d = new Date(t)
  const now = new Date()
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  if (sameDay) return hm
  return `${d.getMonth() + 1}-${d.getDate()} ${hm}`
}

let held = null // { file, rec }

function bindRelease () {
  if (bindRelease._done) return
  bindRelease._done = true
  const onExit = () => release()
  process.on('exit', onExit)
  // SIGINT/SIGTERM 由 main.js 自己接（要 shutdown bot），这里只兜底异常退出
  process.on('uncaughtExceptionMonitor', onExit)
}

/**
 * 拿锁。
 * @param {string} dir 数据目录
 * @param {{username?:string, now?:() => number}} [opts]
 * @returns {{ok:true, file:string, payload:object}
 *          |{ok:false, file:string, existing?:{pid:number, at:number, atText:string, username?:string}}}
 */
function acquire (dir, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const file = path.join(dir, LOCK_NAME)
  try { fs.mkdirSync(dir, { recursive: true }) } catch (e) {}

  const me = {
    pid: process.pid,
    start: procStart(process.pid),
    at: now(),
    username: String(opts.username || '')
  }

  const tryCreate = () => {
    let fd
    try {
      fd = fs.openSync(file, 'wx') // 独占创建：两个实例同时起，也只有一个能成功
      fs.writeSync(fd, JSON.stringify(me, null, 1))
      return true
    } catch (e) {
      if (e && e.code === 'EEXIST') return false
      throw e
    } finally {
      if (fd != null) { try { fs.closeSync(fd) } catch (e) {} }
    }
  }

  const hold = () => {
    held = { file, rec: me }
    bindRelease()
    return { ok: true, file, payload: me }
  }

  let created = false
  try { created = tryCreate() } catch (e) {
    return { ok: false, file, error: e.message }
  }
  if (created) return hold()

  // 已存在：看持有人是不是还活着
  const cur = readLock(file)
  if (cur && stillTheSame(cur)) {
    return {
      ok: false,
      file,
      existing: {
        pid: cur.pid,
        at: cur.at,
        atText: atText(cur.at),
        username: cur.username || ''
      }
    }
  }

  // stale（进程已死 / pid 被复用 / 文件坏了）：清掉重来一次
  try { fs.unlinkSync(file) } catch (e) {}
  try { created = tryCreate() } catch (e) {
    return { ok: false, file, error: e.message }
  }
  if (created) return hold()

  // 删了还是建不上：可能刚被别的进程抢先，再读一次给人看
  const again = readLock(file)
  return {
    ok: false,
    file,
    existing: again
      ? { pid: again.pid, at: again.at, atText: atText(again.at), username: again.username || '' }
      : null
  }
}

/** 松开自己持有的锁（不是自己写的不动） */
function release () {
  if (!held) return false
  const { file, rec } = held
  held = null
  try {
    const cur = readLock(file)
    if (cur && cur.pid !== rec.pid) return false // 锁已经换人了，别误删
    fs.unlinkSync(file)
    return true
  } catch (e) {
    return false
  }
}

module.exports = {
  acquire,
  release,
  // 给测试用
  _procStart: procStart,
  _pidAlive: pidAlive,
  _stillTheSame: stillTheSame,
  _atText: atText,
  LOCK_NAME
}
