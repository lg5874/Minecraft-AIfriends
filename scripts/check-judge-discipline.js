'use strict'
// 判据纪律检查：**禁止"对目标/模型输出做正则 → 直接判成功"**。
//
// 为什么要有这条 CI：同一个病已经犯过四次
//   1. judgeOutcome 读模型自己写的结尾话术
//   2. markUse 把"代码没抛异常"当成功
//   3. [proof] 的 stay 豁免读输出里的"歇会儿"
//   4. 证据类型没声明时的默认分支
// 每一次都不是"不小心"，是判据覆盖不到某类目标，就有人顺手开个文本后门。
// 所以把这条做成机器检查：谁再写"正则匹配文本 -> return ok:true"，CI 直接红。
//
// 两条规则（缺一条都漏过真实病例）：
//   A. 直球：`.test(goal/out/text…)` 之后 260 字内就 `return ok:true / done(…)`，
//      中间没读任何世界证据。
//   B. 缓存分类（第四次就是这个形态）：先 classify(goal) 存成 c.stay/c.mental/stayGoal，
//      几十行后再 `if (c.stay …) return done(…)` —— 正则离 return 很远，
//      规则 A 抓不到，但本质还是"文本批准"。改成看**最近一层 if 的条件**：
//      条件由文本分类字段构成、块内又没有任何世界证据 -> 违规。
//
// 允许的写法：
//   · 正则只用来**决定要求什么证据**（produce/consume/travel 分类），成败由世界证据定
//   · 正则后先读证据变量（inv/blocks/moved/held/food/duration/stateOk…）再判成败
//   · 确实必须开例外时，在同一行/下一行写注释 `// judge-discipline: allow <理由>`
//
// 用法：
//   node scripts/check-judge-discipline.js            # 扫当前工作区
//   node scripts/check-judge-discipline.js --json
//   node scripts/check-judge-discipline.js --selftest # 只跑检测器自测
//   node scripts/check-judge-discipline.js --rev 3be1f17  # 扫某个历史版本（证明它对旧病有效）
// 退出码：有违规 -> 1

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const TARGETS = ['main.js', 'src/judge.js', 'src/coder.js', 'src/goals.js', 'src/skills.js']
const SELF = path.basename(__filename)

// 文本变量（目标/输出/描述）
const TEXTY = /\.test\(\s*(goal|goalText|out|outText|output|text|desc|t|line|msg|reason|reply|say|summary|answer|remark|content|words|sentence)\b/
// 世界证据变量（看到这些就说明不是纯文本批准）
const EVIDENCE = /(invBefore|invAfter|inventory|blocks|worldSig|worldDiff|moved|posBefore|posAfter|held|foodLevel|durationSec|stateOk|countOf|snapshotInv|_taskStart|hp0|hp1|f0|f1)/
// 判定为成功
const SUCCESS = /(return\s*\{\s*ok:\s*true|ok:\s*true|done\(|PASS)/

// 规则 B 用：文本分类字段（classify() 的产物）与"量出来的东西"
const CLASSIFIED = /(?:^|[^A-Za-z0-9_.$])c\.(?:produce|consume|move|travel|stay|mental|eat|craft|needsHeight)\b|\bstayGoal\b|\bneedsMove\b|\bnoMoveWish\b|\bmentalGoal\b|\bclassify\s*\(/
const MEASURED = /(invBefore|invAfter|inventory|snapshotInv|blocks|worldSig|worldDiff|worldChanged|moved|posBefore|posAfter|heldBefore|heldAfter|heldChanged|foodLevel|foodLevelBefore|foodLevelAfter|durationSec|stateOk|countOf|targetGain|targetDelta|gainedTotal|lostTotal|foodUsed|\bsecs\b|\bhp0\b|\bhp1\b|\by0\b|\by1\b|\brisen\b|undergroundAfter|\bate\b)/
// 成功出口（规则 B 的起点）
const SUCCESS_RETURN = /return\s+(?:done\(|\{\s*ok\s*:\s*true)/g

const WINDOW = 260
const ALLOW = /judge-discipline:\s*allow/

// 去掉注释再扫：注释里写"旧代码长这样"不该算违规（第一版就自摆了一道）
function stripComments (src) {
  const out = []
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') { out.push(' '); i++ }
      continue
    }
    if (c === '/' && c2 === '*') {
      out.push(' '); out.push(' '); i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out.push(src[i] === '\n' ? '\n' : ' '); i++
      }
      if (i < n) { out.push(' '); out.push(' '); i += 2 }
      continue
    }
    out.push(c)
    i++
  }
  return out.join('')
}

function lineAt (src, idx) {
  let n = 1
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === '\n') n++
  return n
}

// 找 idx 之前最近的一层 `if (…) {`，返回 { condition, body }（body = `{` 到 idx）
function enclosingIf (src, idx) {
  const from = Math.max(0, idx - 900)
  const before = src.slice(from, idx)
  const at = before.search(/if\s*\(/g)
  let last = -1
  let m
  const re = /if\s*\(/g
  while ((m = re.exec(before))) last = m.index
  if (last < 0) return null
  const condStart = last + before.slice(last).indexOf('(') + 1
  // 从外层括号**里面**开始数：外层 '(' 已经吃掉，depth 从 1 起，
  // 否则条件里的第一个内层 ")" 就会被当成结尾（(c.stay || c.mental) 就是这么踩的）。
  let depth = 1
  let i = condStart
  for (; i < before.length; i++) {
    if (before[i] === '(') depth++
    else if (before[i] === ')') { depth--; if (depth === 0) break }
  }
  if (depth !== 0) return null
  const condition = before.slice(condStart, i)
  let j = i + 1
  while (j < before.length && /\s/.test(before[j])) j++
  if (before[j] !== '{') return null
  return { condition, body: before.slice(j + 1) }
}

// 规则 A：正则 -> 成功，中间没有世界证据
function ruleA (src) {
  const lines = src.split('\n')
  const hits = []
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = TEXTY.exec(line)
    if (m) {
      const start = offset + m.index
      const windowText = src.slice(start, start + WINDOW)
      if (SUCCESS.test(windowText)) {
        const successIdx = windowText.search(SUCCESS)
        const pre = windowText.slice(0, successIdx)
        if (!EVIDENCE.test(pre) && !ALLOW.test(windowText)) {
          hits.push({
            rule: 'A',
            line: i + 1,
            code: line.trim().slice(0, 110),
            window: windowText.replace(/\s+/g, ' ').slice(0, 150)
          })
        }
      }
    }
    offset += line.length + 1
  }
  return hits
}

// 规则 B：成功出口最近一层 if 的条件是文本分类，块里没有任何世界证据
function ruleB (src) {
  const hits = []
  SUCCESS_RETURN.lastIndex = 0
  let m
  while ((m = SUCCESS_RETURN.exec(src))) {
    const idx = m.index
    const guard = enclosingIf(src, idx)
    if (!guard) continue
    if (!CLASSIFIED.test(guard.condition)) continue
    if (MEASURED.test(guard.body)) continue
    const tail = src.slice(idx, idx + WINDOW)
    if (ALLOW.test(guard.condition) || ALLOW.test(guard.body.slice(-120)) || ALLOW.test(tail)) continue
    const ln = lineAt(src, idx)
    hits.push({
      rule: 'B',
      line: ln,
      code: src.split('\n')[ln - 1].trim().slice(0, 110),
      window: (`if (${guard.condition.replace(/\s+/g, ' ').trim()}) { ${guard.body.replace(/\s+/g, ' ').trim()}`).slice(0, 150)
    })
  }
  return hits
}

// 规则 W（接线）：声明的证据类型必须真的**到达目标层**。
//
// 2026-11-14 实测踩到的洞：阶段在 POOL 里都盖了 evidence 章，
// 但 makeGoal() 只拷 key/kind/need/title —— 真实目标 5/5 阶段 evidence=undefined，
// main 的 `|| 'world'` 于是悄悄接管，duration 永远用不上。
// 这种事正则扫不出来（代码里"看起来"声明了），只能跑一遍真实链路：
//   POOL 计划 -> makeGoal -> 每个阶段身上必须带 world/duration/state。
// 同时反向自测：没声明的阶段必须原样漏过去，否则说明这条检查永远绿。
function checkWiring () {
  try {
    const Goals = require(path.join(ROOT, 'src', 'goals.js'))
    const { POOL } = Goals
    const os = require('os')
    const g = new Goals(path.join(os.tmpdir(), 'judge-discipline-wiring'), { now: () => Date.now() })
    const status = { inventory: {}, pos: { x: 0, y: 64, z: 0 } }
    const def = POOL.find(d => (d.stages || []).length)
    if (!def) return []
    const goal = g.makeGoal({
      key: def.key,
      title: def.title,
      why: '',
      stages: def.stages.map(s => Object.assign({}, s))
    }, status)
    const bad = goal.stages.filter(s => !['world', 'duration', 'state'].includes(s.evidence))

    // 反向自测：没声明的计划，makeGoal 不许偷偷补默认值
    const probe = g.makeGoal({
      key: 'probe', title: 'probe', why: '', stages: [{ kind: 'do', title: '没声明的阶段' }]
    }, status)
    if (!probe.stages.some(s => !s.evidence)) {
      return [{
        file: 'src/goals.js',
        line: 0,
        rule: 'W',
        code: '接线自测失效：makeGoal 给没声明的阶段补了默认 evidence',
        window: JSON.stringify(probe.stages.map(s => s.evidence))
      }]
    }

    return bad.map(s => ({
      file: 'src/goals.js',
      line: 0,
      rule: 'W',
      code: `makeGoal 丢了 evidence：${s.title}`,
      window: `evidence=${String(s.evidence)}`
    }))
  } catch (e) {
    return [{
      file: 'src/goals.js',
      line: 0,
      rule: 'W',
      code: '接线检查无法执行: ' + String(e.message).slice(0, 120),
      window: ''
    }]
  }
}

function readSource (file, rev) {
  if (!rev) return fs.readFileSync(path.join(ROOT, file), 'utf8')
  return execFileSync('git', ['show', `${rev}:${file}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function scanFile (file, rev) {
  const src = stripComments(readSource(file, rev))
  return [...ruleA(src), ...ruleB(src)].sort((a, b) => a.line - b.line)
}

// 自测：两段确定违规的代码（直球 + 缓存分类）都必须抓到。
// 没有这条，"0 违规"可能只是检测器坏了。
function selftest () {
  const direct = [
    'function judgeIt (goal, out, inv) {',
    '  if (/做好了/.test(out)) { return { ok: true } }',
    '  if (inv.stone_pickaxe > 0) { return { ok: true } }',
    '  return { ok: false }',
    '}'
  ].join('\n')
  // 第四次真实病例（3be1f17:src/judge.js:220）
  const cached = [
    'function judgeTask (ctx) {',
    '  const goal = String(ctx.goal || "")',
    '  const c = classify(goal)',
    '  const needsMove = /(回|去|走)/.test(goal)',
    '  const stayGoal = c.stay && !needsMove',
    '  if (!c.produce && !c.consume && !c.move && (c.stay || c.mental) && !c.eat) {',
    '    // 待着 = 没有可验证的进展',
    '    return done(0, c.stay ? "原地待着" : "非体力任务")',
    '  }',
    '  if (inv.gainedTotal > 0) return done(1, "背包 +1")',
    '}'
  ].join('\n')
  // 反例：分类照旧，但成败由**量出来的变量**定 —— 这才是允许的写法
  const cleanSample = [
    'function judgeTask (ctx) {',
    '  const c = classify(ctx.goal)',
    '  if (wants.length && c.produce && !c.consume && !c.move) {',
    '    if (targetGain > 0) { return done(targetGain, hit) }',
    '    return fail("背包没涨")',
    '  }',
    '}'
  ].join('\n')
  const a = ruleA(stripComments(direct)).length
  const b = ruleB(stripComments(cached)).length
  const clean = ruleB(stripComments(cleanSample)).length
  console.log(`[自测] 直球样本抓到 ${a} 处（应 ≥1），缓存分类样本抓到 ${b} 处（应 ≥1），证据驱动样本 ${clean} 处（应 0）`)
  return a >= 1 && b >= 1 && clean === 0
}

function parseArgs (argv) {
  const out = { json: argv.includes('--json'), rev: null, selftest: argv.includes('--selftest') }
  const i = argv.indexOf('--rev')
  if (i >= 0 && argv[i + 1]) out.rev = argv[i + 1]
  if (out.rev && !/^[0-9A-Za-z_^~.\-/]+$/.test(out.rev)) {
    console.log(`[bad] --rev 参数不合法：${out.rev}`)
    process.exit(2)
  }
  return out
}

function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.selftest) {
    process.exit(selftest() ? 0 : 1)
  }

  const all = []
  for (const f of TARGETS) {
    if (path.basename(f) === SELF) continue
    try {
      for (const h of scanFile(f, args.rev)) all.push({ file: f, ...h })
    } catch (e) {
      console.log(`[skip] ${f}: ${e.message.split('\n')[0]}`)
    }
  }
  // 接线只在扫当前工作区时查（历史版本没有"现在"的目标层）
  const wiring = args.rev ? [] : checkWiring()
  all.push(...wiring)

  if (args.json) {
    console.log(JSON.stringify({ rev: args.rev || 'working-tree', violations: all.length, items: all }, null, 1))
    process.exit(all.length ? 1 : 0)
  }

  console.log(`扫描 ${args.rev ? args.rev + ' 版本' : '工作区'}: ${TARGETS.join(', ')}`)
  console.log(`违规（文本正则直接判成功 / 缓存分类直接判成功）: ${all.length}`)
  if (!args.rev && !wiring.length) {
    console.log('接线：目标层证据透传 OK（POOL 计划 → makeGoal → 每个阶段都带 evidence）')
  }
  for (const h of all) {
    console.log(`\n  ${h.file}:${h.line}  [规则 ${h.rule}]`)
    console.log(`    ${h.code}`)
    console.log(`    -> ${h.window}`)
  }
  if (!all.length) console.log('\n干净：没有"文本批准"的写法。')
  else {
    console.log('\n修法：正则只用来决定"要求哪类证据"，成败必须由世界证据定；' +
      '\n确实要开例外的，同一行写 `// judge-discipline: allow <理由>`。')
  }
  process.exit(all.length ? 1 : 0)
}

main()
