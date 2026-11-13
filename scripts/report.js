#!/usr/bin/env node
'use strict'
/**
 * 成绩单：统计一个日志文件的真实成败。
 *
 * 用法：
 *   node scripts/report.js data/runtime/bot.log
 *   node scripts/report.js data/runtime-min/bot.log
 */
const fs = require('fs')
const path = require('path')

const file = process.argv[2]
if (!file || !fs.existsSync(file)) {
  console.error('用法: node scripts/report.js <日志文件>')
  process.exit(1)
}

const lines = fs.readFileSync(file, 'utf8').split('\n')

let ok = 0, fail = 0
const failures = []
const goals = []

for (const line of lines) {
  const m = line.match(/<<<\s*(完成|失败)[（(](\d+)s[）)]：(.+)$/)
  if (!m) continue
  const [, kind, secs, text] = m
  const goalMatch = [...lines].reverse().find(l => l.includes('>>> 开始：'))
  if (kind === '失败') {
    fail++
    failures.push(text.slice(0, 60))
  } else {
    // "完成"里也要再筛一次假成功
    const fake = /出错|Error|没挖到|没找到|挖了\s*0|0\s*块|0\s*个|没变|尝试\s*\d+\s*轮|没弄到|中断/.test(text)
    if (fake) {
      fail++
      failures.push('[假成功] ' + text.slice(0, 55))
    } else {
      ok++
    }
  }
}

const total = ok + fail
const rate = total ? Math.round(ok / total * 100) : 0

console.log(`\n===== 成绩单：${path.basename(file)} =====\n`)
console.log(`任务总数: ${total}`)
console.log(`  真成功: ${ok}`)
console.log(`  失败  : ${fail}`)
console.log(`成功率  : ${rate}%`)

if (failures.length) {
  console.log(`\n----- 失败明细（最多 15 条）-----`)
  failures.slice(-15).forEach((f, i) => console.log(`${i + 1}. ${f}`))
}

// 其他指标
const grep = (re) => lines.filter(l => re.test(l)).length
console.log(`\n----- 其他指标 -----`)
console.log(`寻路失败  : ${grep(/走不通|高度到不了|卡住/)}`)
console.log(`够不到    : ${grep(/够不到/)}`)
console.log(`打开超时  : ${grep(/打开超时|windowOpen/)}`)
console.log(`任务中断  : ${grep(/任务被中断/)}`)
console.log(`视觉进上下文: ${grep(/含视觉地形图/)} 次`)
console.log(`无视觉      : ${grep(/没有视觉/)} 次`)
console.log('')
