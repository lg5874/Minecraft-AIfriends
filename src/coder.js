'use strict'
// L2 程序层：让模型自己写一小段 JS，在沙箱里跑，出错把报错喂回去重写。
// 这是"能学任何东西"的核心 —— 能力不由我写死，由它自己长。

const vm = require('vm')
const judge = require('./judge')
const { Vec3 } = require('vec3')

// 禁词：沙箱外的任何东西都不许碰
const FORBIDDEN = [
  /\brequire\s*\(/, /\bimport\s+/, /\bprocess\b/, /\bglobalThis\b/, /\bglobal\b/,
  /\b__dirname\b/, /\b__filename\b/, /\bmodule\b/, /\bexports\b/,
  /\bFunction\s*\(/, /\beval\s*\(/, /\bfetch\s*\(/, /\bXMLHttpRequest\b/,
  /\bsetTimeout\s*\(.*=>.*fetch/, /\bconstructor\s*\.\s*constructor/
]

function checkSafety (code) {
  for (const re of FORBIDDEN) {
    if (re.test(code)) return '代码里不能用 ' + re.source.replace(/\\b/g, '').replace(/\\/g, '')
  }
  return null
}

// 任务描述里点名的产物 -> 游戏物品名。
// 技能层核验要知道"这趟到底该多出什么东西"，否则"顺路挖了几块圆石"
// 就能把"做铁镐 / 做石剑"这种任务洗成成功。
// 和 main.js 的 extractWantedItem 是同一张表：两个模块各存一份，
// 是为了不让 coder 反向依赖 main（main 是入口，require 会成环）。
// 顺序有意义：先长词后短词，否则"做钻石镐"会先命中"石镐"。
const WANT_MAP = {
  钻石镐: 'diamond_pickaxe', 木镐: 'wooden_pickaxe', 石镐: 'stone_pickaxe',
  铁镐: 'iron_pickaxe', 木斧: 'wooden_axe', 石斧: 'stone_axe',
  铁斧: 'iron_axe', 木剑: 'wooden_sword', 石剑: 'stone_sword',
  铁剑: 'iron_sword', 工作台: 'crafting_table', 熔炉: 'furnace',
  箱子: 'chest', 木棍: 'stick', 火把: 'torch', 床: 'red_bed',
  面包: 'bread', 木门: 'oak_door', 梯子: 'ladder',
  煤: 'coal', 铁锭: 'iron_ingot', 青金石: 'lapis_lazuli',
  钻石: 'diamond', 圆石: 'cobblestone', 木板: 'oak_planks'
}

/**
 * 【无进展退出】生成的技能代码必须自带"干不动就失败退出"的出口。
 *
 * 参谋的判断（2026-11-13）：
 *   **不该问"这个任务最多允许多久"，该问"它已经多久没改变世界了"。**
 * 证据是那个技能 8 次成功耗时是双峰：5s / 16s / 131s / 233s / 311s / 312s / 394s / 407s
 * —— 要么几十秒拿到，要么顶到天花板。双峰 = 它只有成功出口，没有失败出口。
 *
 * 入库规则：代码里有 while/for 循环，却没有"连续 N 次没进展就 return 失败"
 * 的计数 → 拒绝入库。这样新技能不会再把 420 秒天花板当成常态。
 */
function hasNoProgressExit (code) {
  const src = String(code || '')
  const hasLoop = /\b(while|for)\s*\(/.test(src)
  if (!hasLoop) return true            // 没有循环，就不存在"空转到底"
  // 有计数变量 + 有 return（通常 return 失败文案或 throw）
  const counter = /(noProgress|no_progress|stall|stuck|unchanged|没进展|无进展|没变化|连续)/i
  const exits = /(return|throw)\s/.test(src)
  const hasCounterVar = /(\+\+\s*;?|\+=\s*1|=\s*[A-Za-z_$][\w$]*\s*\+\s*1)/.test(src)
  return counter.test(src) && exits && hasCounterVar
}

function wantedItemOf (text) {
  const t = String(text || '')
  for (const [cn, en] of Object.entries(WANT_MAP)) {
    if (t.includes(cn)) return en
  }
  return null
}

class Coder {
  constructor (bot, actions, llm, skills, ctx) {
    this.bot = bot
    this.actions = actions
    this.llm = llm
    this.skills = skills
    this.ctx = ctx
    this.lastCode = null
  }

  // 主入口：写一段代码来完成 goal
  //
  // 两段式：先跑旧技能，跑不动才让模型重写。
  // 技能是模型以前写通的代码，复用 = 直接跑，省掉一次生成。
  async writeAndRun (goal, extraContext = '') {
    const skillCatalog = this.skills.catalog(30)
    const apiDoc = this.apiDoc()
    const statusObj = this.actions.status()
    const status = JSON.stringify(statusObj)

    // ---- 第一段：找可以直接跑的旧技能 ----
    // 复用前必须过适用性检查（工具升级了、东西已经有了，就不该再跑）
    const tried = new Set()
    let skillFailed = ''
    const MAX_REUSE = 2

    for (let i = 0; i < MAX_REUSE; i++) {
      const picked = this.skills.pickFor(goal, statusObj, { exclude: tried })
      if (!picked) break
      const sk = picked.skill
      tried.add(sk.name)

      const t0 = Date.now()
      this.ctx.log(`[skill] 复用 ${sk.name}：${sk.desc}（${picked.reason}）`)

      // 【#8】技能跑之前先记背包，跑完核对"世界真的变了吗"。
      //
      // 原来 out.ok 只表示"代码没抛异常"。而坏技能 k_mwe74ysb 结尾是
      //   return '现在手上有圆石' + countOf('cobblestone') + '个，够垫脚用了'
      // 无条件返回，所以它 74 次复用 ok 74 / fail 0，世界却毫无变化。
      // 技能库、心情、长期目标全建在这个假进展上。
      //
      // 现在：产出型技能必须让背包真的涨，放置型必须真的少，
      // 否则这一趟记成失败，让 pickFor 以后少选它。
      const invBefore = this.snapshotInv()
      const posBefore = this.actions.pos ? this.actions.pos().clone() : null
      const worldBefore = this.worldSig(posBefore)
      // 手持和饱食度也是证据维度：换装备时背包可能完全不变
      try { this._skillHeld = this.bot.heldItem ? this.bot.heldItem.name : null } catch (e) { this._skillHeld = null }
      try { this._skillFood = this.bot ? Math.round(this.bot.food) : null } catch (e) { this._skillFood = null }

      const out = await this.run(sk.code, goal)
      const ms = Date.now() - t0

      const real = this.verifySkillEffect(goal, sk, invBefore, posBefore, out, worldBefore)
      if (out.ok && !real.ok) {
        this.ctx.log(`[skill] ${sk.name} 代码跑完了，但世界没变：${real.why}`)
        out.ok = false
        out.error = real.why
      }

      // 跑一次记一次，失败也记 —— 成功率必须是真的
      this.skills.markUse(sk.name, out.ok, { ms, error: out.error, fake: out.ok === false && real.fake })

      if (out.ok) {
        this.skills.markTask({ reused: true, ok: true })
        this.lastCode = sk.code
        return { ok: true, code: sk.code, output: out.output, reused: sk.name }
      }
      // 复用失败也要记任务级统计，否则 stats.reuseFail 永远是 0，复用率虚高
      this.skills.markTask({ reused: true, ok: false })
      skillFailed = out.error || String(out.output || '未知原因')
      this.ctx.log(`[skill] ${sk.name} 跑挂了：${skillFailed}`)
    }

    // 旧技能都不行：让模型重写。
    // 只拿**验证过**的技能当参考 —— 没跑通的代码不给，那是拿没依据的东西当依据。
    // 单条代码可能上千字符，所以限定条数 + 总字符预算，别把提示词撑爆。
    const CODE_BUDGET = 3000
    const relevant = this.skills.search(goal, 2, statusObj, { exclude: tried, verifiedOnly: true })
    let usedChars = 0
    const parts = []
    for (const sk of relevant) {
      if (usedChars + sk.code.length > CODE_BUDGET) continue
      usedChars += sk.code.length
      const runs = (sk.ok || 0) + (sk.fail || 0)
      const rate = runs ? Math.round((sk.ok || 0) / runs * 100) + '%' : '还没试过'
      const note = sk._applicable === false ? `【现在不适用：${sk._why}】` : ''
      parts.push(`### ${sk.name}（${sk.desc}，成功率 ${rate}）${note}\n\`\`\`javascript\n${sk.code}\n\`\`\``)
    }
    const relevantCode = parts.join('\n\n')

    let feedback = ''
    const MAX = 4
    for (let attempt = 0; attempt < MAX; attempt++) {
      const messages = [
        { role: 'system', content: this.systemPrompt(apiDoc, skillCatalog) },
        {
          role: 'user',
          content: `当前状态：${status}\n\n${extraContext}\n\n要做的事：${goal}\n\n${relevantCode ? '以前做过类似的事，可以参考这些代码：\n' + relevantCode + '\n\n' : ''}${feedback ? '上一次失败了，原因：' + feedback + '\n\n重新写。' : ''}直接给代码，不要解释。`
        }
      ]

      let res
      try {
        res = await this.llm.chat(messages, {
          maxTokens: this.ctx.cfg.llm.codeMaxTokens,
          temperature: 0.3
        })
      } catch (e) {
        return { ok: false, error: '模型调用失败: ' + e.message }
      }

      const code = extractCode(res.text)
      if (!code) {
        feedback = '没有给出代码块'
        continue
      }

      const bad = checkSafety(code)
      if (bad) {
        feedback = bad
        continue
      }

      this.lastCode = code
      if (this.ctx && this.ctx.dumpCode) this.ctx.dumpCode(goal, code, attempt)
      const out = await this.run(code, goal)
      if (out.ok) {
        // 这次是重新生成的，没有复用旧技能 —— 也要记进任务统计
        this.skills.markTask({ reused: false, ok: true })
        return { ok: true, code, output: out.output, reused: null }
      }
      feedback = out.error + (out.output ? '\n输出：' + out.output : '')
    }
    this.skills.markTask({ reused: false, ok: false })
    const prefix = skillFailed ? '旧技能也没跑通（' + skillFailed + '）；' : ''
    return { ok: false, error: prefix + '试了 ' + MAX + ' 次都没成：' + feedback }
  }

  /** 背包快照（物品名 -> 数量） */
  snapshotInv () {
    const out = {}
    try {
      for (const i of this.bot.inventory.items()) {
        out[i.name] = (out[i.name] || 0) + i.count
      }
    } catch (e) {}
    return out
  }

  /**
   * 周围方块的快照（半径 5、高 -2..+2）。
   *
   * 【层2】技能的成功率必须由"世界真的变了"决定。
   * 挖通道 / 堵墙 / 铺路这类活背包不涨 —— 挖下来的东西当场又用掉了，
   * 只看背包会把真干成的判成失败；只看代码有没有抛异常则相反。
   */
  // 快照统一走 src/judge.js：那边用**绝对坐标**做 key。
  // 之前这里是相对偏移 + 每次用当前 pos 重拍，人一动所有 key 都变，
  // 实测"动了 2 格没挖"会被算成 482 格变化 —— 走动型假成功全放行。
  worldSig (pos) {
    return judge.worldSig(this.bot, pos)
  }

  worldDiff (before, pos) {
    if (!before) return -1
    return judge.worldDiffCount(before, this.worldSig(pos))
  }
  /**
   * 核对一次技能运行到底有没有改变世界。
   *
   * 判定本体在 src/judge.js（单判定器）。这里只负责**收集证据**：
   * 背包、方块快照、位移、手持、饱食度。
   *
   * 为什么必须共用一份判据：原来 main 和 coder 各写一套，
   * 38 个真实技能 × 3 种世界状态里，同一份证据两边差 42%
   * —— 技能记成功、任务记失败，账本互相打架。
   */
  verifySkillEffect (goal, skill, invBefore, posBefore, out, worldBefore) {
    const desc = String((skill && skill.desc) || '')
    const posNow = this.actions && this.actions.pos ? this.actions.pos() : null
    const res = judge.judgeTask({
      // 技能都是体力活 —— 用最硬的世界证据。技能没有"阶段"可声明。
      evidence: 'world',
      goal: String(goal || ''),
      text: desc,
      invBefore: invBefore || {},
      invAfter: this.snapshotInv(),
      posBefore,
      posAfter: posNow,
      worldBefore,
      worldAfter: this.worldSig(posBefore || posNow),
      heldBefore: this._skillHeld === undefined ? null : this._skillHeld,
      heldAfter: (this.bot && this.bot.heldItem) ? this.bot.heldItem.name : null,
      foodLevelBefore: this._skillFood === undefined ? null : this._skillFood,
      foodLevelAfter: this.bot ? Math.round(this.bot.food) : null
    })
    return { ok: res.ok, why: res.why, fake: !res.ok, progress: res.progress }
  }

  async run (code, goal) {
    const bot = this.bot
    const actions = this.actions
    const ctx = this.ctx

    // 沙箱里能用的东西，就这些
    const api = {
      Vec3,
      actions,
      bot: {
        chat: (m) => ctx.say(m),
        username: bot.username,
        entity: bot.entity,
        health: bot.health,
        food: bot.food,
        time: bot.time
      },
      log: (m) => ctx.log('[code] ' + m),
      sleep: (ms) => new Promise(r => setTimeout(r, Math.min(ms, 5000))),
      say: (m) => ctx.say(m),
      memory: {
        note: (name, t) => ctx.mem.note(name, t),
        place: (n, pos, note) => ctx.mem.place(n, pos, note),
        fact: (t) => ctx.mem.fact(t),
        lesson: (t) => ctx.mem.lesson(t)
      },
      players: () => Object.keys(bot.players).filter(n => n !== bot.username)
    }

    // 【无进展退出】90 秒里背包/方块/位置/手持全都没变 -> 主动放弃。
    // 判据是"多久没改变世界"，不是"最多允许跑多久"——前者拟人，后者是配置表。
    const sigOf = () => {
      try {
        const inv = this.snapshotInv()
        const invSum = Object.entries(inv).map(([k, v]) => k + ':' + v).sort().join(',')
        const p = this.actions && this.actions.pos ? this.actions.pos() : null
        const posKey = p ? `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}` : '?'
        const held = this.bot && this.bot.heldItem ? this.bot.heldItem.name : '-'
        return invSum + '|' + posKey + '|' + held
      } catch (e) { return '?' }
    }
    let lastSig = sigOf()
    let lastChangeAt = Date.now()
    const NO_PROGRESS_MS = Number(ctx.cfg.behavior && ctx.cfg.behavior.noProgressSeconds
      ? ctx.cfg.behavior.noProgressSeconds * 1000 : 90000)
    const watchdog = setInterval(() => {
      const sig = sigOf()
      if (sig !== lastSig) {
        lastSig = sig
        lastChangeAt = Date.now()
        return
      }
      if (Date.now() - lastChangeAt >= NO_PROGRESS_MS) {
        const secs = Math.round((Date.now() - lastChangeAt) / 1000)
        // 【必须设 actions.cancel】只设 this.cancelFlag 是没用的 ——
        // 那个字段没有任何人读（实测 grep 只有赋值、没有判读）。
        // actions 里每步开头 `if (this.cancel) throw new Error('任务被中断')`，
        // 所以真正能打断执行的是它。
        this.cancelFlag = true
        try { this.actions.cancel = true } catch (e) {}
        try { this.bot.pathfinder.setGoal(null) } catch (e) {}
        ctx.log(`[skill] 白干 ${secs}s：背包/方块/位置全没变，主动放弃`)
        // 记账：白干的时间要能结算，不能悄悄吞掉
        try { ctx.onNoProgress && ctx.onNoProgress(secs, goal) } catch (e) {}
        lastChangeAt = Date.now() + 1e9   // 别重复触发
      }
    }, 5000)

    const sandbox = {
      ...api,
      console: { log: (m) => ctx.log('[code] ' + m) },
      Math, JSON, Date, Array, Object, String, Number, Boolean, Promise, Error,
      parseInt, parseFloat, isNaN, isFinite
    }
    sandbox.globalThis = undefined

    let output = ''
    this.cancelFlag = false
    const wrapped = `(async () => {
${code}
})()`

    try {
      const context = vm.createContext(sandbox)
      const script = new vm.Script(wrapped, { filename: 'action.js' })
      const result = await Promise.race([
        script.runInContext(context, { timeout: (this.ctx.cfg.behavior.taskTimeoutSeconds || 300) * 1000 + 10000 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('这次干太久了，算了')), (this.ctx.cfg.behavior.taskTimeoutSeconds || 300) * 1000))
      ])
      return { ok: true, output: result === undefined ? '' : String(result) }
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e), output }
    } finally {
      if (watchdog) clearInterval(watchdog)
    }
  }

  systemPrompt (apiDoc, skillCatalog) {
    return `你在给一个 Minecraft 玩家写一小段动作代码。这段代码会被执行，直接控制这个玩家。

规则：
1. 只输出一个 \`\`\`javascript 代码块，里面是一个 async 函数体（不用写函数声明，直接写语句）
2. 只能用下面列出的 API，不能用 require、process、fs、fetch、eval
3. 代码要能跑通。每一步都可能失败，用 try/catch 或检查返回值
4. 循环里要留一点余地，别写死循环
5. 需要的东西不在身上时，先想办法弄到（合成、去挖、去拿）
6. 最后 return 一句话总结你干了什么
7. 代码里的注释用中文

## 你能看见地形

每次任务开头，你会拿到三张图：

**东西方向剖面** / **南北方向剖面**

    x+ 0: ·······███  ← 你在这
    x+ 1: ·█████████

左边是水平方向（x+1 = 东边一格），右边每一格是一个高度（从高到低）。
图例：█实心 ·空 ~水 L岩浆 T原木 t树叶 O矿石 #基岩

**俯视图**：从头顶往下看，能看出四周哪里能走。

**四个方向**：直接告诉你东南西北能不能走、要挖几格。

**用这些图来写代码**：比如看到"东边能走"就直接往东，看到"头顶是实心"就先挖开再跳。

## 能用的 API
${apiDoc}

## 已经会的技能（可以直接调用 actions 做类似的事，也可以组合）
${skillCatalog}

**注意**：上面标着"成功率"的技能是真的跑过的。成功率低的别再照抄它的写法；
标"未用"的是还没验证过的新技能，可以参考思路但别当成可靠方案。

## 例子
\`\`\`javascript
// 砍三棵树，做成木板
const n = await actions.chopTree(3)
if (n < 1) return '没找到树'
const logs = actions.countOf('oak_log') + actions.countOf('birch_log') + actions.countOf('spruce_log')
if (logs > 0) {
  const logType = actions.item('oak_log') ? 'oak_planks' : (actions.item('birch_log') ? 'birch_planks' : 'spruce_planks')
  await actions.craft(logType, 8)
  return '砍了' + n + '棵树，做了木板'
}
return '砍了树但没木头'
\`\`\``
  }

  /**
   * API 文档。
   * 有个环境变量 AIFRIEND_MINIMAL_API=1 可以切成"精简模式"：
   * 只给视觉 + 原子动作，不给那些"完整解决方案"的函数。
   * 这是用来做实验的：验证模型靠视觉能不能自己写出正确的逻辑。
   */
  /** 精简版：只有视觉 + 原子动作 */
  apiDocMinimal () {
    return `### 看地形（视觉）
- actions.lookAround3D(range=6)  完整地形图
- actions.lookProfile('x'|'z', range, up, down)  单方向剖面
- actions.lookTop(range, layer)  俯视图
- actions.canWalkTo(dx, dz)  判断某方向能不能走：{walkable, needDig, reason}
- actions.pos()  当前位置 {x,y,z}
- actions.status()  返回 {pos, health, food, time, inventory}
- actions.findBlock(name, maxDist)  找最近的方块
- actions.findAny([名字1,名字2], maxDist)  在多个名字里找
- actions.blockAt(x,y,z)  看某个位置是什么方块

### 走
- actions.goto(x, y, z, range=1)  走到坐标
- actions.walkToward(dx, dz, 毫秒)  朝某个方向走一段（会先转向）
- actions.wander(格数)  随便走走
- actions.stop()  停下

### 挖
- actions.digAt(block)  挖指定的方块（会先走过去，够不到返回 false）
- actions.bestToolFor(block)  换最合适的工具

### 放
- actions.place(blockName, x, y, z)  在指定坐标放方块
- actions.placeNearby(blockName)  在脚边找位置放

### 合成
- actions.craft(itemName, count)  合成（需要工作台时会自动找/放）
- actions.itemId(name)  物品 id

### 背包
- actions.item(name)  背包里这个物品或 null
- actions.countOf(name)  有多少个
- actions.equip(name)  装备/手持
- actions.eat()  吃东西
- actions.foodList()  能吃的列表

### 战斗
- actions.nearestEntity(name, range)  找最近的实体
- actions.attack(name, times)  打怪

### 其他
- actions.pickupNearby(radius)  捡地上的东西
- actions.ensureChunks()  等区块加载
- sleep(毫秒)  等待
- say('文字')  说话
- log('文字')  写日志

### 常用方块名（必须写全名）
原木：oak_log / birch_log / spruce_log
木板：oak_planks / birch_planks / spruce_planks
石头：stone / cobblestone / deepslate / andesite / granite / diorite
矿石：coal_ore / iron_ore / copper_ore / gold_ore / diamond_ore / lapis_ore
注意：挖矿石掉的不一定是同名物品！
  lapis_ore→lapis_lazuli  iron_ore→raw_iron  stone→cobblestone
  用 actions.countOf() 时要查掉落物的名字`
  }

  apiDoc () {
    if (process.env.AIFRIEND_MINIMAL_API === '1') {
      return this.apiDocMinimal()
    }
    return `### 移动
- actions.goto(x, y, z, range=1)  走到坐标，返回 true/false
- actions.gotoPlayer(name, range=2)  走到某个玩家旁边
- actions.follow(name, seconds)  跟着某玩家走一段时间
- actions.wander(blocks)  随便走走
- actions.stop()  停下

### 看
- actions.scan(radius=16)  返回 { blocks:{名字:数量}, entities:[{name,dist}], players:[{name,dist}] }
- actions.pos()  当前位置 {x,y,z}
- actions.status()  返回 {pos, health, food, time, dimension, weather, held, inventory}
- actions.findBlock(name, maxDist=32)  找最近的某种方块，返回方块对象或 null
- actions.nearestEntity(name, range=16)  找最近的实体

### 常用方块名（必须写全名，别写 log/stone 这种）
原木：oak_log / birch_log / spruce_log / jungle_log / acacia_log / dark_oak_log / cherry_log / mangrove_log
木板：oak_planks / birch_planks / spruce_planks …（每种树对应一种）
石头类：stone / cobblestone / deepslate / cobbled_deepslate / granite / diorite / andesite
矿石：coal_ore / iron_ore / copper_ore / gold_ore / diamond_ore / redstone_ore / lapis_ore
其他：dirt / grass_block / sand / gravel / water / lava / crafting_table / furnace / chest

### 挖
- actions.mine(blockName, count, maxDist=32)  挖若干个，返回**背包里实际增加的数量**
  注意：矿石挖掉后掉的不一定是同名物品！
  lapis_ore → lapis_lazuli，iron_ore → raw_iron，stone → cobblestone
  所以挖完要查 dropOf 的名字，不是方块名。mine() 内部已经处理了，直接看返回值就行。
- actions.chopTree(count)  砍树，返回砍了几棵
- actions.digAt(block)  挖指定方块

### 放
- actions.place(blockName, x, y, z)  在坐标放一个方块

### 合成与冶炼
- actions.craft(itemName, count)  合成，自动找工作台（只做一步，缺材料会失败）
- actions.craftSmart(itemName, count)  ★推荐用这个★ 智能合成：缺什么自动先做/去挖，依赖链自动补齐
- actions.survey(半径)  评估这块地方：{trees,water,animals,hostiles,stone,score}
- actions.findHome(走几段, 每段格数)  走几处挑最好的地方安家，返回 {survey,pos}
- actions.travelToFind(() => 找东西的表达式, 最多几段, 每段多少格)  走远去找资源，边走边扫
- actions.digStone(count)  ★挖圆石★ 直接往下挖到石头层，返回现有圆石数（用这个别自己写循环）
- actions.ensureWood(count)  砍树直到有 count 个任意种类的原木（不挑品种），返回现有数量
- actions.woodCount()  手上一共有多少原木（不分种类）
- actions.anyPlanks(count)  把任意原木做成木板，返回木板数量
- actions.myPlankKind()  我现在能做哪种木板（如 oak_planks）
- actions.gather(itemName, count)  去弄原料（原木、石头、矿石这类能从世界上直接拿的）
- actions.findAny([name1,name2,...], maxDist)  在多个名字里找最近的方块
- actions.ensureChunks()  等区块加载（刚进服务器或走远之后要先调）
- actions.placeNearby(blockName)  在脚边找个位置放方块，返回放好的方块
- actions.smelt(inputName, fuelName, count)  烧东西，fuelName 可以是 null
- actions.itemId(name)  拿物品 id

### 背包
- actions.item(name)  返回背包里的这个物品或 null
- actions.countOf(name)  这个物品有多少个
- actions.equip(name)  装备/手持
- actions.autoArmor()  自动穿上最好的盔甲
- actions.bestWeapon()  拿出最好的武器
- actions.eat()  吃（自动挑最好的，熟食优先）
- actions.foodList()  背包里所有能吃的：[{name,count,points}]，按好坏排
- actions.findFood()  完整的找食流程：打猎/摘果/抓鱼，有熔炉会烤
- actions.tryCook(rawName)  把生肉烤熟（没熔炉现做，没燃料去砍）

### 战斗
- actions.attack(entityName, times=5)  打附近的怪

### 容器
- actions.openChest(x,y,z)  打开箱子，返回容器对象（要自己 close()）
- actions.depositAll(x,y,z,except=[])  全部存进去
- actions.withdraw(x,y,z,itemName,count)  取东西
- actions.pickupNearby(radius)  捡地上的东西

### 指令（这个服支持的玩法）
- actions.runCommand('/home')  回家
- actions.runCommand('/spawn')  回出生点
- actions.runCommand('/tpa 张三')  请求传送到某人
- actions.runCommand('/msg 张三 内容')  私聊
管理指令（/op /give /tp /gamemode 等）会被拒绝，别用。

### 人的动作（不产出资源，但很像人）
- actions.lookAround(几圈)  转头看看四周
- actions.walkTo('东北', 格数)  按方位走，不是按坐标
- actions.peek('北')  探头看一眼
- actions.wait(秒)  站着等（会偶尔转头，不是死等）
- actions.sit(秒)  蹲下（像坐着）
- actions.glance('张三')  瞥某人一眼
- actions.point('东')  转头指向某个方向
- actions.toss('铁锭', 数量)  丢东西
- actions.listen()  听听附近有什么动静

### 其他
- actions.sleepInBed()  睡觉
- actions.look(yaw, pitch)
- actions.lookAtPlayer(name)
- sleep(ms)  等待

### 其他可用
- say('文字')  在游戏里说一句话
- log('文字')  写进日志
- memory.note(玩家名, '记一笔')  记住关于某人的事
- memory.place('名字', {x,y,z}, '备注')  记住一个地点
- memory.fact('事实')  记住一件事
- memory.lesson('教训')  记住一个教训
- players()  当前服务器里的玩家名列表
- bot.username  自己的名字
- bot.health / bot.food  血量和饥饿度
- Vec3  new Vec3(x,y,z)`
  }
}

function extractCode (text) {
  if (!text) return null
  const m = text.match(/```(?:javascript|js)?\s*([\s\S]*?)```/)
  if (m) return m[1].trim()
  // 没有代码块，看看整段是不是像代码
  if (/await |actions\.|const |let |function /.test(text)) return text.trim()
  return null
}

module.exports = {
  hasNoProgressExit, Coder, extractCode, checkSafety }
