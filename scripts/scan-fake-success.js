'use strict'
// #8 假成功判据：扫技能库里"结尾无条件 return 成功文案"的技能。
//
// 为什么需要单独一个扫描器：
//   k_mwe74ysb（"在附近地上捡够垫脚的石头"）结尾是
//     return '现在手上有圆石' + countOf('cobblestone') + '个，够垫脚用了'
//   不管捡没捡到都返回同一句话。judgeOutcome 曾经只要看到"圆石132个"
//   就算有产出 —— 于是这个技能复用 76 次、世界毫无变化。
//
// 判定思路（不看运行时，只看代码结构）：
//   1. 找出所有 return（含 return '...' 和三元表达式里的），算出它的
//      包围链：函数体 → try/catch/for/while/if/else。
//   2. 一条 return 只有在"被 if 条件挡住"时才是有条件的；
//      包围链里只有 try/for/while/函数体 = 无条件执行。
//   3. 文案里有成功语气（够/好了/完成了/带齐了/no further need）且
//      代码里没有任何数值门槛（countOf(...) </> / length < / 数量比较）
//      → 记为 suspect。
//
// 用法：
//   node scripts/scan-fake-success.js            # 打印报告
//   node scripts/scan-fake-success.js --json     # 机器可读
//   node scripts/scan-fake-success.js --clear    # 清掉 suspect（写回 skills.json）

const fs = require('fs')
const path = require('path')

const FILE = path.join(__dirname, '..', 'data', 'runtime', 'skills.json')

// ---------- 1. 去注释 / 抽 token ----------
// 手写而不是上 parser：技能代码是模型写的，偶有语法怪癖，
// 用词法扫描比"解析失败就整库跳过"更稳。
//
// 【关键】必须**等长**替换。先用 out.push(' ') 把整段字符串压成一个空格，
// 索引就和原文错位了 —— 第一版就是这么写的，结果 k_mwe74ysb 的 return
// 被定位到一段字符串中间，扫描器整体报 0 个假成功（假阴性比没有更糟）。
function stripCommentsAndStrings (src) {
  const out = src.split('')
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== '\n') out[k] = ' '
    }
  }
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]
    if (c === '/' && c2 === '/') {
      const s = i
      while (i < n && src[i] !== '\n') i++
      blank(s, i)
      continue
    }
    if (c === '/' && c2 === '*') {
      const s = i
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i = Math.min(n, i + 2)
      blank(s, i)
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      const s = i
      i++
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === q) { i++; break }
        i++
      }
      blank(s, i)
      continue
    }
    i++
  }
  return out.join('')
}

// 把代码切成"每条语句的起止"，并记录包围链
function analyzeStructure (code) {
  const src = String(code || '')
  const bare = stripCommentsAndStrings(src)      // 等长替换（字符串变空格），索引对得上
  // 逐个字符走，维护栈
  const stack = []
  const returns = []
  let i = 0
  const n = bare.length

  const isWordChar = (ch) => /[A-Za-z0-9_$]/.test(ch || '')

  while (i < n) {
    const ch = bare[i]

    // 收集"语句头"文本：遇到关键结构时把括号条件读出来
    if (isWordChar(ch)) {
      const start = i
      while (i < n && isWordChar(bare[i])) i++
      const word = bare.slice(start, i)

      if (word === 'return') {
        // 取到当前层的 ; 或换行
        const exprStart = i
        let d = 0
        let j = i
        while (j < n) {
          const cj = bare[j]
          if (cj === '(' || cj === '[' || cj === '{') d++
          else if (cj === ')' || cj === ']' || cj === '}') {
            if (d === 0) break
            d--
          } else if (cj === ';' && d === 0) break
          else if (cj === '\n' && d === 0) {
            // 换行不一定结束语句：字符串拼接经常跨行
            //   return 'a' + x +
            //     '，还差材料'
            // 第一版在这里直接截断，"还差材料"没进表达式，
            // 于是诚实改写被当成假汇报 —— 扫描器自己制造了假阳性。
            let k = j - 1
            while (k >= i && /\s/.test(bare[k])) k--
            const last = bare[k]
            if (last && /[+\-*/%,?:=([&|]/.test(last)) { j++; continue }
            break
          }
          j++
        }
        returns.push({
          expr: src.slice(exprStart, j).trim(),
          chain: stack.map(s => s.type),
          guards: stack.filter(s => s.type === 'if' && s.cond).map(s => s.cond)
        })
        i = j
        continue
      }

      if (word === 'if' || word === 'while' || word === 'for' || word === 'switch' || word === 'catch') {
        // 读条件括号
        let j = i
        while (j < n && bare[j] !== '(') j++
        let d = 0
        const condStart = j + 1
        let k = j
        while (k < n) {
          if (bare[k] === '(') d++
          else if (bare[k] === ')') { d--; if (d === 0) break }
          k++
        }
        const cond = src.slice(condStart, k).trim()
        // 找到这条语句的 { 位置压栈
        let b = k
        while (b < n && bare[b] !== '{' && bare[b] !== ';') b++
        if (bare[b] === '{') {
          stack.push({ type: word === 'catch' ? 'catch' : word, depth: 'pending', cond })
          i = b + 1
          continue
        }
        i = k + 1
        continue
      }

      if (word === 'else') {
        // else { ... }
        let b = i
        while (b < n && bare[b] !== '{' && bare[b] !== ';') b++
        if (bare[b] === '{') { stack.push({ type: 'else', cond: '' }); i = b + 1; continue }
        i++
        continue
      }

      if (word === 'try') {
        let b = i
        while (b < n && bare[b] !== '{') b++
        if (bare[b] === '{') { stack.push({ type: 'try', cond: '' }); i = b + 1; continue }
        i++
        continue
      }

      if (word === 'function' || word === 'async') {
        // 只关心有没有新的函数体：async () => { 也走下面箭头那条
        i++
        continue
      }
      continue
    }

    if (ch === '{') { stack.push({ type: 'block', cond: '' }); i++; continue }
    if (ch === '}') { stack.pop(); i++; continue }
    i++
  }

  return returns
}

// 代码里有没有"数值门槛"：有，就说明作者至少在某个点核对过数量
function hasNumericGate (code) {
  const src = String(code || '')
  return [
    /countOf\s*\([^)]*\)\s*[<>]=?/,                  // countOf('x') < 16
    /<=\s*\d+|>=\s*\d+/,                             // <= 16
    /\.length\s*[<>]=?\s*\d+/,                       // list.length < 1
    /\?\s*['"`].*['"`]\s*:/,                          // 三元里给不同结论
    /if\s*\([^)]*(?:不够|不足|<)\s*\)/
  ].some(re => re.test(src))
}

// 话术里有没有"成了"的语气
const SUCCESS_TONE = /(够|好了|完成|带齐|带够|准备|搞定|成|充足|没问题|就是这样|不用再|已经)/
const FAIL_TONE = /(不够|没够|还差|失败|做不了|凑不齐|不足|只有\s*\d+\s*(?:个|块).{0,6}(?:不够|差)|挖不到|找不到)/

// ---------- 2. 主判定 ----------
function judgeSkill (sk) {
  const code = String(sk.code || '')
  const returns = analyzeStructure(code)
  const gate = hasNumericGate(code)

  const suspects = []
  // 诚实写法的特征：代码里存在一条"提前 return 失败"的分支。
  //   if (foodCount < 4) return '没带齐：…还差，先别出门'
  //   return '收拾好了：…'
  // 最后那句仍然是"无条件"的 return（它是有条件那句的 else 分支），
  // 但语义上已经被挡住了 —— 纯结构扫描看不出这层关系，
  // 所以用"存在失败分支"作为诚实的标志。这也是文档给的修法本身。
  const hasFailBranch = returns.some(r => FAIL_TONE.test(r.expr))
  for (const r of returns) {
    const expr = r.expr
    if (!expr) continue
    const guarded = r.chain.some(t => t === 'if' || t === 'else' || t === 'switch') ||
      r.guards.length > 0
    // 三元表达式本身算有条件（'x' : 'y'）
    const ternary = /\?[^:]*:[^:]*/.test(expr)
    const tone = SUCCESS_TONE.test(expr)
    const failTone = FAIL_TONE.test(expr)
    // 第二类假汇报：**报存量当成果**。
    //   return '冲铁镐: 铁锭' + countOf('iron_ingot') + ' 生铁' + countOf('raw_iron') + ' 圆石' + countOf('cobblestone')
    // 这句话里一个成功词都没有，看着像客观汇报，但它是无条件执行的：
    // 铁锭 0 也一样这么说。而 judgeOutcome 老版本看到"圆石148"就判有产出 ——
    // 实测 k_mwe60wh8 复用 50 次、一次铁锭都没产出，成功率却排第一。
    const stockReport = /countOf\s*\(/.test(expr) && !/[<>]=?|===?|!==?/.test(expr)
    if (!guarded && !ternary && !hasFailBranch && ((tone && !failTone) || stockReport)) {
      suspects.push({
        expr: expr.slice(0, 120),
        why: tone && !failTone
          ? '无条件 return 成功文案（且全文没有失败分支）'
          : '无条件把存量当成果汇报（countOf(...) 原样输出，没有达标判断）'
      })
    }
  }

  // 没有 return 但有失败文案兜底时，看最后一条语句是不是 log + 成功
  const ok = sk.ok || 0
  const fail = sk.fail || 0
  return {
    name: sk.name,
    desc: sk.desc,
    uses: sk.uses || 0,
    ok,
    fail,
    rate: ok + fail ? Math.round(ok / (ok + fail) * 100) : null,
    numericGate: gate,
    hasFailBranch,
    returns: returns.length,
    suspects,
    // 判定口径（第二版，收紧）：
    //   只要"结尾无条件 return 成功文案"就是 FAKE —— 不管代码别处有没有
    //   数值门槛。因为门槛管的是"要不要继续干活"，管不了"跑完怎么汇报"：
    //   k_mwe6vrg3 里面有 `if (torches < 4)` 这种判断，但结尾仍然是
    //   return '收拾好了…可以出门了'，没火把也一样说收拾好了。
    //   数值门槛只作为附注，用来区分"整段代码完全没核对"和"干活前核对过"。
    verdict: suspects.length ? 'FAKE' : 'HONEST'
  }
}

function scan () {
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  const list = Array.isArray(raw) ? raw : raw.skills || []
  return { raw, list: list.map(judgeSkill) }
}

function main () {
  const argv = process.argv.slice(2)
  const { raw, list } = scan()

  const fake = list.filter(s => s.verdict === 'FAKE')
  const suspect = []   // 第二版起并入 FAKE

  if (argv.includes('--json')) {
    console.log(JSON.stringify({
      total: list.length,
      fake: fake.length,
      suspect: suspect.length,
      honest: list.length - fake.length - suspect.length,
      items: fake.concat(suspect)
    }, null, 1))
    return
  }

  console.log(`技能总数 ${list.length}｜FAKE ${fake.length}｜SUSPECT ${suspect.length}｜HONEST ${list.length - fake.length - suspect.length}`)
  for (const s of fake) {
    console.log(`\n[FAKE] ${s.name}  ${s.desc}`)
    console.log(`   uses=${s.uses} ok=${s.ok} fail=${s.fail} rate=${s.rate === null ? '-' : s.rate + '%'} 数值门槛=${s.numericGate ? '有' : '无'}`)
    console.log(`   ${s.suspects[0].expr}`)
  }
  for (const s of suspect) {
    console.log(`\n[SUSPECT] ${s.name}  ${s.desc}  (ok=${s.ok} fail=${s.fail})`)
    console.log(`   ${s.suspects[0].expr}`)
  }

  if (argv.includes('--clear')) {
    const names = new Set(fake.map(s => s.name))
    const before = raw.skills.length
    raw.skills = raw.skills.filter(s => !names.has(s.name))
    raw.stats = raw.stats || {}
    raw.stats.fakeSuccessCleared = (raw.stats.fakeSuccessCleared || 0) + (before - raw.skills.length)
    fs.writeFileSync(FILE, JSON.stringify(raw, null, 1), 'utf8')
    console.log(`\n清掉 ${before - raw.skills.length} 个 FAKE 技能，剩余 ${raw.skills.length}`)
  }
}

if (require.main === module) main()

module.exports = { scan, judgeSkill, analyzeStructure, hasNumericGate }
