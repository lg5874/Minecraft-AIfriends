'use strict'
// L3 技能库。成功的程序存下来，下次遇到类似情况直接跑，不再让模型重写一遍。
//
// 这一版修的三件事：
//   1. 成绩是真的 —— markUse 每次复用都调用，ok/fail 不再是永远 0
//   2. 复用前判适用 —— 技能是模型写的旧代码，环境变了就不能跑
//      （"用木镐挖石头"在有石镐之后作废；"做石镐"在已经有石镐之后作废）
//   3. 按意图归并 —— 同一个意图只留最好的一份，不再是"做石镐"存 46 份
//
// 关键设计约束（来自任务书）：
//   - 技能是模型写的代码，复用 = 直接跑旧代码，所以必须能判"还适用吗"
//   - 成功率要真实：跑一次记一次，失败也记

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// ==================== 工具等级 ====================
// 用来判断"现在有更好的工具了，这个技能过时了"
const TOOL_TIERS = { wooden: 1, stone: 2, iron: 3, golden: 3, diamond: 4, netherite: 5 }
const TOOL_KINDS = ['pickaxe', 'axe', 'sword', 'shovel', 'hoe']

function parseToolName (item) {
  const m = String(item || '').match(
    /^(wooden|stone|iron|golden|diamond|netherite)_(pickaxe|axe|sword|shovel|hoe)$/
  )
  if (!m) return null
  return { tier: m[1], kind: m[2], rank: TOOL_TIERS[m[1]] || 0 }
}

// ==================== 代码分析 ====================
// 从技能代码里读出：它会造出什么、它依赖什么工具、它调了哪些动作
function analyzeCode (code) {
  const src = String(code || '')
  const produced = new Set()
  const equipped = new Set()
  const usedActions = new Set()
  let m

  const craftRe = /actions\.(?:craft|craftSmart|safeCraft)\s*\(\s*['"]([a-z0-9_]+)['"]/g
  while ((m = craftRe.exec(src))) produced.add(m[1])

  const equipRe = /actions\.(?:equip|bestWeapon)\s*\(\s*['"]([a-z0-9_]+)['"]/g
  while ((m = equipRe.exec(src))) equipped.add(m[1])

  const actRe = /actions\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g
  while ((m = actRe.exec(src))) usedActions.add(m[1])

  // 代码里出现的工具名（不管是不是 equip，做/换/检查都算依赖）
  const tools = []
  for (const item of [...produced, ...equipped]) {
    const t = parseToolName(item)
    if (t) tools.push(t)
  }
  for (const kind of TOOL_KINDS) {
    const re = new RegExp('(wooden|stone|iron|golden|diamond|netherite)_' + kind + '\\b', 'g')
    let mm
    while ((mm = re.exec(src))) {
      const t = parseToolName(mm[1] + '_' + kind)
      if (t && !tools.some(x => x.tier === t.tier && x.kind === t.kind)) tools.push(t)
    }
  }

  return {
    produced: [...produced],
    equipped: [...equipped],
    tools,
    actions: [...usedActions]
  }
}

// 代码骨架：动作序列（顺序无关），用来认"同一段逻辑"
function codeSignature (code) {
  const out = []
  const re = /actions\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\s*(?:['"]([a-z0-9_]+)['"])?/g
  let m
  while ((m = re.exec(String(code || '')))) out.push(m[1] + (m[2] ? ':' + m[2] : ''))
  return out.sort().join('|')
}

function codeHash (code) {
  const norm = String(code || '').replace(/\s+/g, ' ').replace(/\s*([(){}\[\],;:])\s*/g, '$1').trim()
  return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16)
}

// ==================== 意图识别 ====================
// 把"用工作台和圆石做一把石镐"和"先把圆石和木棍在工作台做一把石镐"认成同一件事。
// 输出 { key, conf }，conf 低的不参与归并（宁可多留，也不把两件事并成一件）。
// 描述里说的和代码真做的可能不一致（"把熔炉放下来烧木炭"其实没做熔炉）。
// 合成类意图用代码的实际产出来校正，代码比措辞可信。
const PRIMARY_ITEMS = {
  pickaxe: /^(wooden|stone|iron|golden|diamond|netherite)_pickaxe$/,
  axe: /^(wooden|stone|iron|golden|diamond|netherite)_axe$/,
  sword: /^(wooden|stone|iron|golden|diamond|netherite)_sword$/,
  shovel: /^(wooden|stone|iron|golden|diamond|netherite)_shovel$/,
  hoe: /^(wooden|stone|iron|golden|diamond|netherite)_hoe$/,
  table: /^crafting_table$/,
  furnace: /^furnace$/,
  chest: /^chest$/,
  block: /^(stone_bricks|cobblestone_wall|stone_slab|smooth_stone)$/
}

// 这个物品是不是"做这件事的目的"（而不是中间产物）
function isPrimaryItem (item) {
  for (const re of Object.values(PRIMARY_ITEMS)) if (re.test(item)) return true
  return false
}

// 代码造出来的东西 → 意图 key。工具优先于中间产物（工作台/木棍是手段不是目的）。
function intentsFromCode (code) {
  const a = analyzeCode(code)
  const out = []
  for (const item of a.produced) {
    for (const [kind, re] of Object.entries(PRIMARY_ITEMS)) {
      if (!re.test(item)) continue
      if (kind === 'table' || kind === 'furnace' || kind === 'chest' || kind === 'block') {
        out.push('craft:' + kind)
      } else {
        const t = parseToolName(item)
        if (t) out.push('craft:' + t.kind + '@' + t.tier)
      }
    }
  }
  // 去重并保持顺序
  return Array.from(new Set(out))
}

// 描述里说的合成目标，在代码里到底有没有做出来
function craftTargetsIn (desc) {
  const t = String(desc || '')
  const out = []
  if (/镐/.test(t)) out.push('pickaxe')
  if (/斧/.test(t)) out.push('axe')
  if (/剑/.test(t)) out.push('sword')
  if (/锹|铲/.test(t)) out.push('shovel')
  if (/锄/.test(t)) out.push('hoe')
  if (/工作台|crafting/.test(t)) out.push('table')
  if (/熔炉/.test(t)) out.push('furnace')
  if (/箱子/.test(t)) out.push('chest')
  if (/石砖|台阶|平滑石/.test(t)) out.push('block')
  return out
}

function intentOf (desc, code) {
  const t = String(desc || '')
  const has = re => re.test(t)
  const cand = []
  const add = (k, v) => cand.push([k, v])

  const tier = has(/铁/) ? 'iron' : has(/石|圆石/) ? 'stone' : has(/木/) ? 'wooden' : ''

  // 动词要先分清："做一把石镐" 里的"挖"是手段，"合成"才是目的。
  // 所以合成类动词分高，挖掘类动词分低，两者都有时按目的归。
  // "做成储存区"不是合成，别把这种话算成 craft
  const craftVerb = has(/做一把|做把|做一柄|做一台|做一个|做几|合成一把|合一把|补做|打造|合出|补一把|补上|补齐|备用|换掉|制作|合成|做成|做/) &&
    !has(/做成(储存|收纳|储物|仓库|区域|储藏)/)
  const digVerb = has(/挖|凿|敲|采矿|矿道|阶梯/)

  // ---- 合成工具 / 方块 ----
  const tool = has(/镐/) ? 'pickaxe'
    : has(/斧/) ? 'axe'
      : has(/剑/) ? 'sword'
        : has(/锹|铲/) ? 'shovel'
          : has(/锄/) ? 'hoe' : null
  if (craftVerb && tool) add('craft:' + tool + '@' + tier, digVerb ? 10 : 12)
  if (craftVerb && has(/熔炉/)) add('craft:furnace', digVerb ? 8 : 11)
  if (craftVerb && has(/箱子/)) add('craft:chest', digVerb ? 8 : 11)
  if (craftVerb && has(/石砖|台阶|平滑石/)) add('craft:block', digVerb ? 7 : 10)
  // 工作台基本只当工具用（"用工作台做X"），只有没别的合成目标时它才算目的
  if (craftVerb && has(/工作台|crafting/) && !cand.length) add('craft:table', digVerb ? 8 : 11)

  // ---- 挖矿 ----
  const ore = has(/青金石|lapis/) ? 'lapis'
    : has(/铁|iron/) ? 'iron'
      : has(/煤|coal/) ? 'coal'
        : has(/铜|copper/) ? 'copper'
          : has(/钻石|diamond/) ? 'diamond'
            : has(/安山岩|andesite/) ? 'andesite'
              : has(/闪长岩|diorite/) ? 'diorite'
                : has(/花岗岩|granite/) ? 'granite'
                  : has(/圆石|石头|石|cobble|stone/) ? 'stone' : ''
  if (digVerb) add('mine:' + (ore || 'misc'), 13)

  // ---- 收纳 ----
  if (has(/箱子|收纳|存进|储存|存起来|扔进箱|分类存|归置|腾出空间|腾空间|腾背包|合并整理|整理背包/)) {
    add('store:chest', digVerb ? 6 : 9)
  }
  // ---- 烧炼 ----
  if (has(/烧|木炭|冶炼|烤熟/)) add('smelt', digVerb ? 5 : 8)
  // ---- 种植 ----
  if (has(/树苗|种到|种下|种上/)) add('plant:sapling', 10)
  // ---- 砍树 ----
  if (has(/砍|原木|树干/) && !has(/种/)) add('chop:wood', 9)
  // ---- 采集 ----
  if (has(/树叶|蘑菇|采/)) add('gather:leaves', 8)
  // ---- 庇护所 ----
  if (has(/庇护所|小屋|安全屋|避难所|房子|过夜|躲|围堵|避难坑/) &&
      has(/搭|盖|垒|建|围|封/) && !has(/矿道/)) add('build:shelter', 11)
  // ---- 吃 ----
  if (has(/吃|饿|腐肉|面包/) && !has(/烤|烧/)) add('eat', 7)
  // ---- 战斗 ----
  if (has(/打|僵尸|苦力怕|怪/)) add('fight', 7)
  // ---- 探索 ----
  if (has(/看看|周围|爬|探索|岩壁|顶上|背面|透光|扫|看头顶/)) add('explore', 6)

  // 代码里一次 craft 都没调，说明这活儿压根不是合成 —— 撤掉 craft 候选
  if (code && !/actions\.(?:craft|craftSmart|safeCraft)\s*\(/.test(String(code))) {
    for (let i = cand.length - 1; i >= 0; i--) {
      if (/^craft:/.test(cand[i][0])) cand.splice(i, 1)
    }
  }

  if (!cand.length) return { key: 'misc', conf: 0 }
  cand.sort((a, b) => b[1] - a[1])
  let best = { key: cand[0][0], conf: cand[0][1] }

  // 合成类意图：用代码实际造出来的东西校正。
  // 只有当"描述说的东西代码根本没造"时才改写 —— 中间产物（工作台/木棍）不算数。
  if (/^craft:/.test(best.key) && code) {
    const fromCode = intentsFromCode(code).filter(k => !/^craft:(table)$/.test(k))
    const claimed = best.key.replace(/^craft:/, '').split('@')[0]
    const claimedMade = fromCode.some(k => k.replace(/^craft:/, '').split('@')[0] === claimed)
    if (claimedMade) {
      best = { key: best.key, conf: Math.min(best.conf + 3, 15) }
    } else if (fromCode.length) {
      // 描述说做 A，代码其实只做了 B —— 按代码归，但降一档置信度
      return { key: fromCode[0], conf: Math.max(5, best.conf - 2), corrected: true }
    }
  }
  return best
}

// ==================== 文本相似 ====================
const STOP = new Set(
  '的了是我你他她它在有和就都也很不个这那什么怎么吗呢吧啊想要点弄去来做个一下能会可以要'.split('')
)

function cnChars (s) {
  const out = new Set()
  for (const c of String(s || '')) {
    if (/[\u4e00-\u9fa5]/.test(c) && !STOP.has(c)) out.add(c)
  }
  return out
}

function tokenize (s) {
  if (!s) return []
  const out = new Set()
  for (const w of String(s).toLowerCase().match(/[a-z_]{2,}/g) || []) out.add(w)
  const cn = String(s).match(/[\u4e00-\u9fa5]{2,}/g) || []
  for (const seg of cn) {
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2))
  }
  return Array.from(out)
}

function normalizeText (s) {
  return String(s || '').toLowerCase().replace(/[\s，。、,.;；:：!！?？"'()（）【】[\]{}<>《》~\-_/\\|+*=]+/g, '')
}

function bigrams (s) {
  const t = normalizeText(s)
  const out = new Set()
  if (t.length <= 1) { if (t) out.add(t); return out }
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  return out
}

function jaccard (a, b) {
  if (!a.size && !b.size) return 1
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  const union = a.size + b.size - inter
  return union ? inter / union : 0
}

// ==================== 成绩 ====================
// 拉普拉斯平滑：0 次和 0/0 不是一个概念，未用过的技能按 50% 起算
function successRate (s) {
  if (!s) return 0.5
  const ok = s.ok || 0
  const fail = s.fail || 0
  return (ok + 1) / (ok + fail + 2)
}

function totalRuns (s) {
  if (!s) return 0
  return (s.ok || 0) + (s.fail || 0)
}

// ==================== 技能库 ====================
class SkillLibrary {
  constructor (dir, opts = {}) {
    this.dir = dir
    this.file = path.join(dir, 'skills.json')
    this.codeDir = path.join(dir, 'skillcode')
    this.quiet = !!opts.quiet
    this.data = { skills: [], stats: {} }
    this.load()
  }

  // ---------- 存取 ----------
  load () {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.data = raw && typeof raw === 'object' ? raw : { skills: [] }
      if (!Array.isArray(this.data.skills)) this.data.skills = []
    } catch (e) {
      this.data = { skills: [] }
    }
    if (!this.data.stats) this.data.stats = {}
    this.data.stats.tasks = this.data.stats.tasks || 0
    this.data.stats.reusedTasks = this.data.stats.reusedTasks || 0
    this.data.stats.reuseOk = this.data.stats.reuseOk || 0
    this.data.stats.reuseFail = this.data.stats.reuseFail || 0
    // 老数据补字段：intent / 分析结果
    for (const s of this.data.skills) this.migrate(s)
    try { fs.mkdirSync(this.codeDir, { recursive: true }) } catch (e) {}
  }

  migrate (s) {
    if (!s.intent) {
      const it = intentOf(s.desc, s.code)
      s.intent = it.key
      s.intentConf = it.conf
    }
    if (!s.analysis) s.analysis = analyzeCode(s.code)
    if (!s.codeHash) s.codeHash = codeHash(s.code)
    if (!s.codeSig) s.codeSig = codeSignature(s.code)
    if (typeof s.uses !== 'number') s.uses = 0
    if (typeof s.ok !== 'number') s.ok = 0
    if (typeof s.fail !== 'number') s.fail = 0
    if (!Array.isArray(s.runs)) s.runs = []
    if (!Array.isArray(s.tags)) s.tags = []
    return s
  }

  save () {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1), 'utf8')
    } catch (e) { console.error('[skill] save fail', e.message) }
  }

  all () { return this.data.skills }

  get (name) { return this.data.skills.find(s => s.name === name) }

  // ---------- 写入 ----------
  // 同名更新；不同名但同意图 → 合并（留下成绩更好的那份代码）
  add ({ name, desc, code, tags = [] }) {
    if (!name || !code) return null
    const it = intentOf(desc, code)
    const analysis = analyzeCode(code)
    const hash = codeHash(code)
    const sig = codeSignature(code)
    const bg = bigrams(desc)

    let hit = this.data.skills.find(s => s.name === name)

    if (!hit) {
      hit = this.data.skills.find(s => {
        // 完全一样的代码 = 同一个技能
        if (s.codeHash && s.codeHash === hash) return true
        // 意图要一致，才有资格谈合并
        if (s.intent !== it.key) return false
        // 意图不够确定时，只接受高度相似的描述
        if (it.conf < 5) return jaccard(bigrams(s.desc), bg) >= 0.7
        if (jaccard(bigrams(s.desc), bg) >= 0.62) return true
        // 骨架一样 + 描述沾边 → 同一段逻辑的另一种写法
        if (s.codeSig && s.codeSig === sig && jaccard(bigrams(s.desc), bg) >= 0.35) return true
        return false
      })
    }

    if (hit) {
      // 已经验证能跑通的代码优先保留；只有旧代码明显在失败时才换新的
      const oldRate = successRate(hit)
      const proven = totalRuns(hit) > 0 && oldRate >= 0.5
      const replace = !proven && totalRuns(hit) > 0 && oldRate < 0.5
      if (replace) {
        hit.code = code
        hit.codeHash = hash
        hit.codeSig = sig
        hit.analysis = analysis
        // 换了代码，旧成绩就不算数了，重新开始记
        hit.ok = 0
        hit.fail = 0
        hit.replaced = (hit.replaced || 0) + 1
      }
      hit.desc = hit.desc || desc
      hit.tags = Array.from(new Set([...(hit.tags || []), ...tags]))
      hit.intent = hit.intent || it.key
      hit.intentConf = Math.max(hit.intentConf || 0, it.conf)
      hit.updated = Date.now()
      hit.uses = hit.uses || 0
      hit.variants = (hit.variants || 1) + 1
      this.writeCode(hit.name, hit.code)
      this.save()
      return hit
    }

    const s = this.migrate({
      name,
      desc: desc || '',
      tags,
      code,
      created: Date.now(),
      updated: Date.now(),
      uses: 0,
      ok: 0,
      fail: 0,
      runs: [],
      intent: it.key,
      intentConf: it.conf,
      analysis,
      codeHash: hash,
      codeSig: sig,
      variants: 1
    })
    this.data.skills.push(s)
    this.writeCode(name, code)
    this.save()
    return s
  }

  writeCode (name, code) {
    try {
      const safe = name.replace(/[^\w\u4e00-\u9fa5]/g, '_')
      fs.writeFileSync(path.join(this.codeDir, safe + '.js'), code, 'utf8')
    } catch (e) {}
  }

  // ---------- 记账 ----------
  // 每次复用/参考都要调这个。ok=false 也要记 —— 失败率高就是要少用它
  markUse (name, ok, meta = {}) {
    const s = this.get(name)
    if (!s) return null
    this.migrate(s)
    s.uses = (s.uses || 0) + 1
    if (ok) s.ok = (s.ok || 0) + 1
    else s.fail = (s.fail || 0) + 1
    s.lastUsed = Date.now()
    if (ok) s.lastOk = Date.now()
    s.runs.push({
      at: Date.now(),
      ok: !!ok,
      ms: meta.ms || 0,
      error: ok ? null : String(meta.error || '').slice(0, 160)
    })
    if (s.runs.length > 20) s.runs = s.runs.slice(-20)
    this.save()
    return s
  }

  markTask ({ reused, ok }) {
    const st = this.data.stats
    st.tasks = (st.tasks || 0) + 1
    if (reused) {
      st.reusedTasks = (st.reusedTasks || 0) + 1
      if (ok) st.reuseOk = (st.reuseOk || 0) + 1
      else st.reuseFail = (st.reuseFail || 0) + 1
    }
    this.save()
  }

  // ---------- 适用性 ----------
  // 这是复用的安全闸：技能是旧代码，环境变了就不能跑。
  // ctx 直接收 actions.status() 的返回值（有 inventory 就够）。
  applicable (skill, ctx = {}) {
    const inv = ctx.inventory || ctx || {}
    const a = skill.analysis || analyzeCode(skill.code)

    // 1. 工具被更好的替代了 —— "用木镐挖石头" 在有石镐之后作废
    for (const t of a.tools) {
      for (const [item, n] of Object.entries(inv)) {
        if (!n) continue
        const have = parseToolName(item)
        if (have && have.kind === t.kind && have.rank > t.rank) {
          return {
            ok: false,
            reason: '已被更好的工具替代（技能用 ' + t.tier + '_' + t.kind +
              '，现在有 ' + item + '）'
          }
        }
      }
    }

    // 2. 目的已经达成了 —— 已经有石镐了，不必再跑"做石镐"
    //    只看主要产物：工作台/木棍是中间手段，身上没有也正常
    const isCraft = /^craft:/.test(skill.intent || '')
    if (isCraft) {
      const main = a.produced.filter(it => isPrimaryItem(it))
      if (main.length && main.every(it => (inv[it] || 0) > 0)) {
        return { ok: false, reason: '要做的东西已经有了（' + main.join('、') + '）' }
      }
    }

    return { ok: true, reason: '' }
  }

  // ---------- 检索 ----------
  // 打分 = 相关度 + 真实成功率 + 新鲜度；不适用的降权而不是直接删（留着当参考）
  search (query, limit = 6, ctx = null, opts = {}) {
    const exclude = opts.exclude instanceof Set ? opts.exclude : new Set(opts.exclude || [])
    const q = String(query || '')
    const pool = this.data.skills.filter(s => !exclude.has(s.name))

    if (!q.trim()) {
      return pool
        .slice()
        .sort((a, b) => (b.updated || 0) - (a.updated || 0))
        .slice(0, limit)
    }

    const qChars = cnChars(q)
    const qBig = bigrams(q)
    const qLow = q.toLowerCase()

    const scored = pool.map(s => {
      const text = [s.desc, s.name, (s.tags || []).join(' ')].join(' ')
      const tChars = cnChars(text)

      // 1. 汉字重叠
      let overlap = 0
      for (const c of qChars) if (tChars.has(c)) overlap++
      const charScore = qChars.size ? overlap / qChars.size : 0

      // 2. 二字组相似（比单字稳）
      const sim = jaccard(qBig, bigrams(text))

      // 3. 原样子串
      let sub = 0
      for (const seg of (q.match(/[\u4e00-\u9fa5]{2,}/g) || [])) {
        if (text.includes(seg)) sub += 3
        else for (let i = 0; i < seg.length - 1; i++) if (text.includes(seg.slice(i, i + 2))) sub += 1
      }

      // 4. 标签
      let tagHit = 0
      for (const tag of (s.tags || [])) {
        if (qLow.includes(String(tag).toLowerCase())) tagHit += 4
      }

      // 5. 英文词
      let en = 0
      for (const w of (qLow.match(/[a-z_]{3,}/g) || [])) {
        if (text.toLowerCase().includes(w)) en += 2
      }

      // 6. 意图一致直接加分（这是最硬的信号）
      const it = intentOf(q, '')
      const intentHit = (it.conf >= 5 && it.key === s.intent) ? 6 : 0

      const rate = successRate(s)
      // 成功率的影响：0% → -2，50% → 0，100% → +2
      const rateBonus = (rate - 0.5) * 4
      // 用得多说明稳定，但别让老技能霸榜
      const useBonus = Math.min((s.uses || 0) / 20, 1)

      const rel = charScore * 10 + sim * 8 + sub + tagHit + en + intentHit

      let app = { ok: true, reason: '' }
      if (ctx) app = this.applicable(s, ctx)
      // 不适用的技能仍保留（可以当写法参考），但排到后面
      const appPenalty = app.ok ? 0 : 6

      const score = rel + rateBonus + useBonus - appPenalty
      return { s, score, rel, app }
    })
      .filter(x => x.score >= 2.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    return scored.map(x => {
      const out = x.s
      // 只读投影，不写盘
      out._applicable = x.app.ok
      out._why = x.app.reason
      out._score = Math.round(x.score * 100) / 100
      return out
    })
  }

  // 挑一个"可以直接跑"的技能。找不到就返回 null，让模型重新写。
  pickFor (goal, ctx = {}, opts = {}) {
    const exclude = opts.exclude instanceof Set ? opts.exclude : new Set(opts.exclude || [])
    const minRel = opts.minRel == null ? 5.5 : opts.minRel
    const minRate = opts.minRate == null ? 0.45 : opts.minRate

    const cands = this.search(goal, 8, ctx, { exclude })
      .filter(s => s._applicable)
      .filter(s => s._score >= minRel)

    if (!cands.length) return null

    // 成功率低的不要（试过的才算，没试过的给机会）
    const ranked = cands
      .map(s => {
        const runs = totalRuns(s)
        const rate = successRate(s)
        const tested = runs > 0
        const conf = s._score + (tested ? (rate - 0.5) * 8 : 0)
        return { s, conf, tested, rate, runs }
      })
      .filter(x => !x.tested || x.rate >= minRate)
      .sort((a, b) => b.conf - a.conf)

    if (!ranked.length) return null
    const best = ranked[0]
    return {
      skill: best.s,
      confidence: Math.round(best.conf * 100) / 100,
      rate: best.rate,
      tested: best.tested,
      reason: best.tested
        ? '用过 ' + best.runs + ' 次，成功率 ' + Math.round(best.rate * 100) + '%'
        : '新技能，还没试过'
    }
  }

  // ---------- 提示词目录 ----------
  catalog (limit = 40) {
    const list = this.data.skills
      .slice()
      .sort((a, b) => (b.updated || 0) - (a.updated || 0))
      .slice(0, limit)
    if (!list.length) return '（还不会什么，都要现学）'
    return list.map(s => {
      const runs = totalRuns(s)
      // 给人看的用原始比值，不用平滑值 —— 3 次全成就是 100%
      const rate = runs ? Math.round((s.ok || 0) / runs * 100) + '%' : '未用'
      return `- ${s.name}：${s.desc}（用过 ${s.uses || 0} 次，成功率 ${rate}）`
    }).join('\n')
  }

  // ---------- 去重 ----------
  // 同意图的归并到成绩最好的一份，其它删掉（tag/uses 合并过去）
  consolidate (opts = {}) {
    const before = this.data.skills.length
    const groups = new Map()
    let anon = 0

    for (const s of this.data.skills) {
      this.migrate(s)
      // 意图不确定的不归并，避免把两件事并成一件
      const key = (s.intentConf >= 5) ? s.intent : 'anon#' + (anon++)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(s)
    }

    const keep = []
    const merged = []
    for (const [key, list] of groups) {
      if (list.length === 1) { keep.push(list[0]); continue }
      // 排序：先看成功率，再看用过几次，再看代码是否更长（信息更多），最后看新
      list.sort((a, b) => {
        const ra = totalRuns(a) ? successRate(a) : 0.5
        const rb = totalRuns(b) ? successRate(b) : 0.5
        if (Math.abs(ra - rb) > 0.01) return rb - ra
        if ((b.uses || 0) !== (a.uses || 0)) return (b.uses || 0) - (a.uses || 0)
        if ((b.code || '').length !== (a.code || '').length) return (b.code || '').length - (a.code || '').length
        return (b.updated || 0) - (a.updated || 0)
      })
      const winner = list[0]
      for (const loser of list.slice(1)) {
        winner.tags = Array.from(new Set([...(winner.tags || []), ...(loser.tags || [])]))
        winner.uses = (winner.uses || 0) + (loser.uses || 0)
        winner.ok = (winner.ok || 0) + (loser.ok || 0)
        winner.fail = (winner.fail || 0) + (loser.fail || 0)
        winner.variants = (winner.variants || 1) + (loser.variants || 1)
        winner.mergedFrom = (winner.mergedFrom || 0) + 1
      }
      winner.mergedAt = Date.now()
      keep.push(winner)
      merged.push({ key, count: list.length, keeper: winner.name, keeperDesc: winner.desc })
    }

    this.data.skills = keep
    if (!opts.dryRun) this.save()
    return {
      before,
      after: keep.length,
      removed: before - keep.length,
      groups: merged.sort((a, b) => b.count - a.count)
    }
  }

  // ---------- 统计 ----------
  stats () {
    const list = this.data.skills
    const used = list.filter(s => (s.uses || 0) > 0)
    const withRuns = list.filter(s => totalRuns(s) > 0)
    const okSum = list.reduce((a, s) => a + (s.ok || 0), 0)
    const failSum = list.reduce((a, s) => a + (s.fail || 0), 0)
    const st = this.data.stats || {}
    return {
      total: list.length,
      used: used.length,
      withRuns: withRuns.length,
      ok: okSum,
      fail: failSum,
      avgRate: (okSum + failSum) ? okSum / (okSum + failSum) : 0,
      tasks: st.tasks || 0,
      reusedTasks: st.reusedTasks || 0,
      reuseOk: st.reuseOk || 0,
      reuseFail: st.reuseFail || 0,
      reuseRate: (st.tasks || 0) ? (st.reusedTasks || 0) / st.tasks : 0
    }
  }
}

module.exports = {
  SkillLibrary,
  tokenize,
  cnChars,
  intentOf,
  analyzeCode,
  codeSignature,
  codeHash,
  successRate,
  totalRuns,
  parseToolName,
  bigrams,
  jaccard
}
