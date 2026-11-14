'use strict'
// 全部 JS 语法检查
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const files = []

function walk (dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'data') continue
    if (name.startsWith('.')) continue   // 点开头的是临时文件/编辑中间态，不参与语法检查
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p)
    else if (name.endsWith('.js')) files.push(p)
  }
}
walk(root)

let bad = 0
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })
  } catch (e) {
    bad++
    console.error('✗ ' + path.relative(root, f))
    console.error(String(e.stderr || e.message).split('\n').slice(0, 3).join('\n'))
  }
}
console.log(`检查了 ${files.length} 个文件，${bad} 个有问题`)
process.exit(bad ? 1 : 0)
