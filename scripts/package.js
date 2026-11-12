#!/usr/bin/env node
'use strict'
/**
 * 打包脚本：把 bot 打成能传到服务器上的 tar.gz。
 *
 * 进包的：
 *   main.js
 *   src/**            （除 *.bak）
 *   package.json
 *   package-lock.json （有就带，能锁死版本）
 *   data/games.json   （他的二游知识库，代码要读）
 *   config.example.json
 *   PACKAGE.json      （清单：文件数、sha256、buildId）
 *
 * 不进包的：
 *   node_modules/     500MB，服务器上 npm install
 *   config.json       ★ 里面有 API key，绝不进包
 *   data/runtime/     记忆/技能/家，是运行数据，服务器自己长
 *   scripts/test-*.js 测试脚本，服务器上用不到
 *   .git/ 日志 等
 *
 * 用法：
 *   node scripts/package.js                  # 输出 dist/minecraft-aifriend-<版本>-<时间>.tar.gz
 *   node scripts/package.js --out /tmp/x     # 指定输出目录
 *   node scripts/package.js --name foo       # 指定文件名前缀
 *   node scripts/package.js --list           # 只列会打进去的文件，不打包
 *   node scripts/package.js --json           # 机器可读输出
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')

const ROOT = path.resolve(__dirname, '..')

// ==================== 参数 ====================

function parseArgs (argv) {
  const o = { out: path.join(ROOT, 'dist'), name: null, list: false, json: false, quiet: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out' || a === '-o') o.out = path.resolve(argv[++i])
    else if (a === '--name' || a === '-n') o.name = argv[++i]
    else if (a === '--list' || a === '-l') o.list = true
    else if (a === '--json') o.json = true
    else if (a === '--quiet' || a === '-q') o.quiet = true
    else if (a === '--help' || a === '-h') { usage(); process.exit(0) } else {
      console.error('未知参数: ' + a)
      usage()
      process.exit(2)
    }
  }
  return o
}

function usage () {
  console.log(`
用法: node scripts/package.js [选项]

  -o, --out <dir>    输出目录（默认 dist/）
  -n, --name <前缀>  文件名前缀（默认取 package.json 的 name）
  -l, --list         只列出会进包的文件
      --json         以 JSON 输出结果
  -q, --quiet        只输出最终路径

产物: <out>/<name>-<version>-<时间戳>.tar.gz
`)
}

// ==================== 收集文件 ====================

/** 明确要打的（相对 ROOT），存在的才加 */
const INCLUDE = [
  'main.js',
  'package.json',
  'package-lock.json',
  'config.example.json',
  'data/games.json'
]

/** 整个目录都要打（递归） */
const INCLUDE_DIRS = ['src']

/** 任何位置命中就跳过 */
const SKIP_BASENAMES = new Set([
  'config.json', 'config.local.json', 'config.test.json',
  '.DS_Store', 'Thumbs.db', '.gitignore', '.gitattributes'
])

const SKIP_EXT = ['.bak', '.orig', '.rej', '.swp', '.log', '.tgz', '.tar', '.gz', '.zip']

/** 相对路径命中就跳过 */
const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', '.review', 'logs', '.cache', 'tmp']

function isSkipDir (rel) {
  const parts = rel.split(path.sep)
  return parts.some(p => SKIP_DIRS.includes(p))
}

function shouldSkipFile (rel) {
  const base = path.basename(rel)
  if (SKIP_BASENAMES.has(base)) return true
  if (/^config\..*\.json$/.test(base) && base !== 'config.example.json') return true
  if (SKIP_EXT.some(e => base.endsWith(e))) return true
  // 测试脚本不进包（服务器不跑测试）
  if (rel.startsWith('scripts' + path.sep) && /^test-/.test(base)) return true
  // 运行数据不进包
  if (rel.startsWith('data' + path.sep) && !rel.endsWith('games.json')) return true
  return false
}

function walk (dir, acc) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return acc
  }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name)
    const rel = path.relative(ROOT, abs)
    if (isSkipDir(rel)) continue
    if (ent.isSymbolicLink()) {
      // node_modules 是软链，跳过；其它软链也一律不跟，避免把外面东西打进包
      continue
    }
    if (ent.isDirectory()) {
      walk(abs, acc)
    } else if (ent.isFile()) {
      if (shouldSkipFile(rel)) continue
      acc.push(rel)
    }
  }
  return acc
}

function collectFiles () {
  const files = []
  for (const f of INCLUDE) {
    const abs = path.join(ROOT, f)
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      if (!shouldSkipFile(f)) files.push(f)
    }
  }
  for (const d of INCLUDE_DIRS) {
    const abs = path.join(ROOT, d)
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) walk(abs, files)
  }
  // 去重 + 稳定排序（打出来的包可复现）
  const uniq = Array.from(new Set(files))
  uniq.sort()
  return uniq
}

// ==================== 安全检查：不许把 key 打进包 ====================

const SECRET_PATTERNS = [
  { name: 'OpenAI 风格 key', re: /sk-[A-Za-z0-9_\-]{16,}/ },
  { name: 'apiKey 赋值', re: /["']?apiKey["']?\s*[:=]\s*["'][^"']{12,}["']/ },
  { name: 'Bearer token', re: /Bearer\s+[A-Za-z0-9_\-.]{20,}/ },
  { name: '疑似私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ }
]

// 模板里允许出现的占位符
const ALLOWED = new Set(['PUT_YOUR_KEY_HERE', 'your-model-name', 'api.example.com'])

function scanSecrets (files) {
  const hits = []
  for (const rel of files) {
    let text
    try {
      text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    } catch (e) {
      continue
    }
    for (const p of SECRET_PATTERNS) {
      const m = text.match(p.re)
      if (!m) continue
      const s = m[0]
      if (Array.from(ALLOWED).some(a => s.includes(a))) continue
      hits.push({ file: rel, kind: p.name, sample: s.slice(0, 40).replace(/\s+/g, ' ') })
    }
  }
  return hits
}

// ==================== tar 写入 ====================

function octal (n, len) {
  return n.toString(8).padStart(len - 1, '0') + '\0'
}

/** 写一个 512 字节 ustar 头 */
function tarHeader (name, size, mtime, mode, type) {
  const h = Buffer.alloc(512, 0)
  let nameBuf = Buffer.from(name, 'utf8')

  // ustar: name(100) prefix(155) 分割
  if (nameBuf.length > 100) {
    let split = -1
    for (let i = nameBuf.length - 1; i > 0; i--) {
      if (nameBuf[i] === 0x2f && nameBuf.length - i - 1 <= 100 && i <= 155) { split = i; break }
    }
    if (split < 0) throw new Error('路径太长，没法放进 ustar 头: ' + name)
    const prefix = nameBuf.slice(0, split)
    const rest = nameBuf.slice(split + 1)
    if (prefix.length > 155 || rest.length > 100) throw new Error('路径太长: ' + name)
    prefix.copy(h, 345)
    rest.copy(h, 0)
  } else {
    nameBuf.copy(h, 0)
  }

  h.write(octal(mode, 8), 100, 'ascii')       // mode
  h.write(octal(0, 8), 108, 'ascii')          // uid
  h.write(octal(0, 8), 116, 'ascii')          // gid
  h.write(octal(size, 12), 124, 'ascii')      // size
  h.write(octal(mtime, 12), 136, 'ascii')     // mtime
  h.write('        ', 148, 'ascii')           // 校验和先填空格
  h.write(type, 156, 'ascii')
  h.write('ustar\0', 257, 'ascii')
  h.write('00', 263, 'ascii')
  h.write('root', 265, 'ascii')
  h.write('root', 297, 'ascii')

  let sum = 0
  for (let i = 0; i < 512; i++) sum += h[i]
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  return h
}

function pad512 (buf) {
  const rem = buf.length % 512
  if (rem === 0) return buf
  return Buffer.concat([buf, Buffer.alloc(512 - rem, 0)])
}

function buildTar (entries) {
  const chunks = []
  for (const e of entries) {
    chunks.push(tarHeader(e.name, e.data.length, e.mtime, e.mode, '0'))
    chunks.push(pad512(e.data))
  }
  // 结束：两个全零块
  chunks.push(Buffer.alloc(1024, 0))
  return Buffer.concat(chunks)
}

// ==================== 主流程 ====================

function sha256 (buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function fmtSize (n) {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(2) + ' MB'
}

function stamp () {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function main () {
  const opt = parseArgs(process.argv)
  const say = (...a) => { if (!opt.quiet && !opt.json) console.log(...a) }

  const pkgPath = path.join(ROOT, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    console.error('找不到 package.json: ' + pkgPath)
    process.exit(1)
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const version = pkg.version || '0.0.0'
  const prefix = opt.name || pkg.name || 'bot'

  const files = collectFiles()

  if (opt.list) {
    console.log(files.length + ' 个文件:')
    for (const f of files) {
      const st = fs.statSync(path.join(ROOT, f))
      console.log('  ' + f.padEnd(44) + fmtSize(st.size).padStart(10))
    }
    return
  }

  if (files.length === 0) {
    console.error('没收集到任何文件，检查路径')
    process.exit(1)
  }

  // 硬门槛：main.js 必须在
  if (!files.includes('main.js')) {
    console.error('main.js 没进包，说明路径判断有问题')
    process.exit(1)
  }

  // 安全检查
  const secrets = scanSecrets(files)
  if (secrets.length) {
    console.error('\n包里发现疑似密钥，停止打包：')
    for (const h of secrets) console.error(`  ${h.file}  [${h.kind}]  ${h.sample}`)
    console.error('\nkey 应该只放在服务器的 config.json 里，不要进包。\n')
    process.exit(3)
  }

  // 组装条目
  const mtime = Math.floor(Date.now() / 1000)
  const entries = []
  const manifest = {
    name: prefix,
    version,
    buildId: '',
    builtAt: new Date().toISOString(),
    files: []
  }

  for (const rel of files) {
    const abs = path.join(ROOT, rel)
    const data = fs.readFileSync(abs)
    const isScript = rel.endsWith('.js') || rel === 'main.js'
    entries.push({
      name: rel.split(path.sep).join('/'),
      data,
      mtime,
      mode: isScript ? 0o644 : 0o644
    })
    manifest.files.push({ path: rel.split(path.sep).join('/'), size: data.length, sha256: sha256(data) })
  }

  // buildId 由所有文件内容算出，同样的源码 -> 同样的 id
  manifest.buildId = sha256(Buffer.from(manifest.files.map(f => f.path + ':' + f.sha256).join('\n'))).slice(0, 16)
  manifest.fileCount = manifest.files.length

  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  entries.push({ name: 'PACKAGE.json', data: manifestBuf, mtime, mode: 0o644 })
  entries.sort((a, b) => a.name.localeCompare(b.name))

  const tar = buildTar(entries)
  const gz = zlib.gzipSync(tar, { level: 9 })

  fs.mkdirSync(opt.out, { recursive: true })
  const fileName = `${prefix}-${version}-${stamp()}.tar.gz`
  const outPath = path.join(opt.out, fileName)
  fs.writeFileSync(outPath, gz)

  const sha = sha256(gz)
  const result = {
    ok: true,
    path: outPath,
    fileName,
    bytes: gz.length,
    bytesHuman: fmtSize(gz.length),
    tarBytes: tar.length,
    fileCount: entries.length,
    buildId: manifest.buildId,
    version,
    sha256: sha,
    files: manifest.files.map(f => f.path)
  }

  if (opt.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  say('')
  say('打包完成')
  say('  产物   ' + outPath)
  say('  大小   ' + fmtSize(gz.length) + '（tar ' + fmtSize(tar.length) + ' 压缩后）')
  say('  文件   ' + entries.length + ' 个')
  say('  build  ' + manifest.buildId)
  say('  sha256 ' + sha.slice(0, 32) + '...')
  say('')
  say('不含 node_modules / config.json（key 在服务器上单独配）')
  say('下一步：把包传到 plugins/XJJBot/upload/ 然后 /xj restart')
  say('详见 docs/DEPLOY.md')

  // 体积门槛：5MB
  if (gz.length > 5 * 1024 * 1024) {
    say('')
    say('⚠ 超过 5MB 了，检查是不是混进了大文件')
    process.exitCode = 4
  }
}

if (require.main === module) main()

module.exports = { collectFiles, buildTar, tarHeader }
