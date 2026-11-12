'use strict'
/**
 * 徐俊杰的主程序。
 *
 * 连接 → 活着 → 自己想干点什么 → 跟人说话。
 */

const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')

const Memory = require('./src/memory')
const { SkillLibrary } = require('./src/skills')
const { Actions, sleep } = require('./src/actions')
const { Coder } = require('./src/coder')
const { LLM } = require('./src/llm')
const Reflex = require('./src/reflex')
const Talk = require('./src/talk')
const Will = require('./src/will')
const persona = require('./src/persona')
const knowledge = require('./src/knowledge')

const ROOT = __dirname
const DATA = path.join(ROOT, 'data', 'runtime')

function loadConfig () {
  const p = path.join(ROOT, process.env.AIFRIEND_CONFIG || 'config.json')
  if (!fs.existsSync(p)) {
    throw new Error(`找不到配置文件：${p}\n先 cp config.example.json config.json 然后填 API key`)
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

class Bot {
  constructor (cfg) {
    this.cfg = cfg
    this.bot = null
    this.running = true

    this.mem = new Memory(DATA)
    this.skills = new SkillLibrary(DATA)
    this.llm = new LLM(cfg.llm)

    this.actions = null
    this.coder = null
    this.reflex = null
    this.talk = null
    this.will = null

    this.busy = false
    this.taskDesc = ''
    this.deathCount = 0
    this.deathsSinceSafe = 0
    this.seekingFood = false
    this.sheltered = false
    this.reconnectTimer = null
    this.clockTimer = null
  }

  log (s) {
    const t = new Date().toTimeString().slice(0, 8)
    console.log(`[${t}] ${s}`)
  }

  // ==================== 连接 ====================

  connect () {
    const c = this.cfg.bot
    this.log(`连接 ${c.host}:${c.port} 作为 ${c.username}`)

    const bot = mineflayer.createBot({
      host: c.host,
      port: c.port,
      username: c.username,
      auth: c.auth || 'offline',
      version: c.version,
      hideErrors: false,
      checkTimeoutInterval: 120000,
      viewDistance: 'short'
    })
    this.bot = bot
    bot.loadPlugin(pathfinder)

    bot.once('spawn', () => this.onSpawn())
    bot.on('respawn', () => this.onRespawn())
    bot.on('end', (r) => this.onEnd(r))
    bot.on('kicked', (r) => this.log('被踢: ' + JSON.stringify(r)))
    bot.on('error', (e) => this.log('错误: ' + (e && e.message)))
    bot.on('death', () => this.onDeath())

    bot.on('chat', (username, message) => {
      if (!this.talk) return
      this.talk.onChat(username, message).catch(e => this.log('chat err ' + e.message))
    })

    bot.on('message', (msg) => {
      const t = msg.toString()
      if (/died|slain|drowned|blew up|fell|burned|starved|withered|hit the ground|was killed/.test(t)) {
        this.lastDeathMsg = t
      }
    })

    // 协议层精确识别伤害来源
    bot._client.on('damage_event', (pkt) => {
      try {
        if (!bot.entity || pkt.entityId !== bot.entity.id) return
        const ENV = {
          0: 'in_fire', 1: 'lightning', 2: 'on_fire', 3: 'lava', 4: 'hot_floor',
          5: 'in_wall', 6: 'cramming', 7: 'drown', 8: 'starve', 9: 'cactus',
          10: 'fall', 11: 'fly_into_wall', 12: 'out_of_world', 16: 'dragon_breath',
          17: 'dry_out', 18: 'berry', 19: 'freeze'
        }
        const t = pkt.sourceTypeId
        if (ENV[t]) { this.lastDamageKind = ENV[t]; return }
        const srcId = pkt.sourceCauseId ? pkt.sourceCauseId - 1 : -1
        const ent = srcId >= 0 ? bot.entities[srcId] : null
        if (this.reflex) this.reflex.onHurt(ent)
      } catch (e) {}
    })
  }

  // ==================== 上线 ====================

  async onSpawn () {
    const bot = this.bot

    // 补配方数据：服务器 registry 里没有 recipes，mineflayer 的合成会全废
    try {
      if (!bot.registry.recipes) {
        const mcData = require('minecraft-data')(bot.version)
        bot.registry.recipes = mcData.recipes
        bot.registry.items = bot.registry.items || mcData.itemsArray
        this.log('补上配方数据：' + Object.keys(mcData.recipes).length + ' 条')
      }
    } catch (e) {
      this.log('补配方失败: ' + e.message)
    }

    // 等区块，不然 findBlock 全是 null
    try {
      await bot.waitForChunksToLoad()
      this.log('区块加载完成')
    } catch (e) {}

    this.log('进来了：' + bot.username + ' @ ' + bot.entity.position)

    // 寻路配置
    const moves = new Movements(bot)
    moves.canDig = false
    moves.allow1by1towers = false
    moves.scafoldingBlocks = []
    moves.canOpenDoors = true
    moves.liquidCost = 200      // 尽量别往水里走
    moves.maxDropDown = 4
    bot.pathfinder.setMovements(moves)

    // 计时开始（下线不走）
    const online = this.mem.goOnline()
    this.startClock()

    // 组件
    this.actions = new Actions(bot, {
      log: (s) => this.log(s),
      cfg: this.cfg,
      mem: this.mem
    })
    this.coder = new Coder(bot, this.actions, this.llm, this.skills, {
      log: (s) => this.log(s),
      say: (m) => this.talk ? this.talk.say(m) : null,
      mem: this.mem,
      cfg: this.cfg,
      dumpCode: (goal, code, attempt) => this.dumpCode(goal, code, attempt)
    })
    this.talk = new Talk(bot, this.llm, this.mem, {
      log: (s) => this.log(s),
      cfg: this.cfg,
      busy: () => this.busy,
      currentTaskDesc: () => this.taskDesc ? `你现在正在${this.taskDesc}。` : '你现在没什么事干。',
      actions: this.actions
    })
    this.will = new Will(this.llm, this.mem, this.skills, {
      log: (s) => this.log(s),
      cfg: this.cfg,
      actions: this.actions,
      deaths: () => this.deathsSinceSafe,
      deathsReset: () => { this.deathsSinceSafe = 0 }
    })
    this.reflex = new Reflex(bot, {
      mem: this.mem,
      log: (s) => this.log(s),
      cfg: this.cfg,
      busy: () => this.busy,
      onEvent: (kind, data) => this.onReflexEvent(kind, data)
    })
    this.reflex.start()

    // 第一次进服打个招呼
    if (!this.greeted) {
      this.greeted = true
      setTimeout(() => {
        const names = Object.keys(bot.players).filter(n => n !== bot.username)
        if (names.length && Math.random() < 0.7) this.talk.say('来了')
      }, 3000 + Math.random() * 3000)
    }

    // 上次下线前的事，可能主动提一句
    const last = this.mem.lastSummary()
    if (last && online.sessionsBefore > 0 && Math.random() < 0.4) {
      setTimeout(() => {
        const names = Object.keys(bot.players).filter(n => n !== bot.username)
        if (names.length) {
          const lines = ['我又来了', '上线', '回来了']
          this.talk.say(lines[Math.floor(Math.random() * lines.length)])
        }
      }, 6000 + Math.random() * 8000)
    }

    this.loop().catch(e => this.log('loop crash ' + e.message))
  }

  startClock () {
    if (this.clockTimer) clearInterval(this.clockTimer)
    this.clockTimer = setInterval(() => {
      try { this.mem.tick(1) } catch (e) {}
    }, 1000)
  }

  // ==================== 下线 / 重连 ====================

  onEnd (reason) {
    this.log('断开: ' + reason)
    if (this.reflex) this.reflex.stop()
    if (this.clockTimer) { clearInterval(this.clockTimer); this.clockTimer = null }
    try { this.mem.goOffline() } catch (e) {}

    if (!this.running) return
    const d = (this.cfg.behavior.reconnectDelaySeconds || 15) * 1000
    this.log(`${d / 1000} 秒后重连`)
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => { if (this.running) this.connect() }, d)
  }

  // ==================== 死亡 ====================

  onDeath () {
    this.deathCount++
    this.deathsSinceSafe++

    const line = knowledge.deathLines[Math.floor(Math.random() * knowledge.deathLines.length)]
    this.log('[death] ' + (this.lastDeathMsg || '') + ' | ' + line)
    if (this.talk) this.talk.say(line)

    // 记住这次死
    this.mem.add({
      text: '死了：' + (this.lastDeathMsg || '不知道怎么回事'),
      kind: 'event',
      emotion: 0.6,
      importance: 0.5
    })
    this.lastDeathMsg = null

    this.busy = false
    this.taskDesc = ''
    this.seekingFood = false
    this.sheltered = false
    if (this.actions) { this.actions.cancel = true; this.actions.stop() }
    if (this.will) this.will.finish()
  }

  async onRespawn () {
    this.log('复活了')
    if (this.reflex) this.reflex.reset()
    if (this.actions) { this.actions.cancel = false; this.actions.stop() }
    this.busy = false
    setTimeout(() => this.afterRespawn(), 3000)
  }

  async afterRespawn () {
    const bot = this.bot
    if (!bot || !bot.entity) return
    this.lastDamageKind = null
    try {
      // 水里往上浮
      if (bot.entity.isInWater || (bot.oxygenLevel !== undefined && bot.oxygenLevel < 20)) {
        this.log('在水里，往上游')
        const dirs = ['forward', 'left', 'right']
        bot.setControlState('jump', true)
        for (let i = 0; i < 30; i++) {
          if (!bot.entity.isInWater) break
          bot.setControlState(dirs[Math.floor(i / 10) % 3], true)
          await sleep(250)
        }
        for (const k of ['jump', 'forward', 'left', 'right']) bot.setControlState(k, false)
      }

      await this.actions.bestWeapon().catch(() => {})
      await this.actions.autoArmor().catch(() => {})

      const near = this.reflex.nearestHostile(12)
      if (near) {
        this.log('身边有怪，跑')
        this.reflex.flee(near)
        await sleep(4000)
      }

      const p = bot.entity.position
      this.mem.place('出生点', p, '复活的地方')

      for (let i = 0; i < 40 && bot.health < 16; i++) {
        if (bot.food <= 18 && this.actions.hasFood()) {
          await this.actions.eat().catch(() => {})
        }
        const h = this.reflex.nearestHostile(8)
        if (h) { this.reflex.flee(h); await sleep(2000) }
        await sleep(1000)
      }
      this.log('复活后状态：血 ' + Math.round(bot.health) + ' 饿 ' + Math.round(bot.food))
    } catch (e) {
      this.log('afterRespawn err ' + e.message)
    }
  }

  // ==================== 反射事件 ====================

  onReflexEvent (kind, data) {
    if (kind === 'hurt_confused') {
      if (Math.random() < 0.5) this.talk.say('干嘛啊')
    } else if (kind === 'hurt_repeat') {
      const hs = this.mem.hitStats(data.by)
      if (hs.times >= 3) {
        this.mem.note(data.by, `老打我（第${hs.times}次）`)
        if (Math.random() < 0.6) this.talk.say(data.by + '你有完没完')
      }
    }
  }

  // ==================== 主循环 ====================

  async loop () {
    while (this.running && this.bot && this.bot.entity) {
      try {
        await this.tick()
      } catch (e) {
        this.log('[tick err] ' + (e && e.message))
      }
      await sleep(4000)
    }
    this.log('主循环退出')
  }

  async tick () {
    const bot = this.bot
    if (!bot || !bot.entity) return

    // 1. 危险先自救
    const danger = this.checkSurvival()
    if (danger) {
      const now = Date.now()
      const key = danger + ':' + Math.round(bot.health) + ':' + Math.round(bot.food)
      if (this._lastDangerKey !== key || now - (this._lastDangerAt || 0) > 20000) {
        this._lastDangerKey = key
        this._lastDangerAt = now
        this.log('[survive] ' + danger)
      }
      await this.doSurvive(danger)
      return
    }

    // 2. 天亮重置
    const tod = bot.time && bot.time.timeOfDay
    if (tod !== undefined && (tod < 12000 || tod > 23500)) this.sheltered = false

    // 3. 天黑 + 血少 -> 躲
    if (tod !== undefined && tod > 13000 && tod < 23000 && bot.health <= 14) {
      if (!this.sheltered) {
        this.sheltered = true
        this.log('[night] 天黑了，先躲起来')
        const near = this.reflex.nearestHostile(12)
        if (near) { this.reflex.flee(near); await sleep(3000) }
        await this.reflex.shelter()
      }
      await sleep(8000)
      return
    }

    // 4. 正在干活不打断
    if (this.busy) return

    // 5. 决定干什么
    const want = await this.will.think()
    if (!want) return

    this.busy = true
    this.taskDesc = want.text
    if (this.actions) { this.actions.cancel = false; this.actions.stop() }
    const t0 = Date.now()
    this.log(`>>> 开始：${want.text}`)

    try {
      const result = await this.coder.writeAndRun(want.text, this.contextForTask())
      const secs = Math.round((Date.now() - t0) / 1000)
      const outText = String(result.output || '')
      const head = outText.slice(0, 40)
      const looksFailed = /^(失败|没做成|没成功|做不了|搞不定|完成不了)|失败[:：]|没做成[:：]/.test(head) ||
        /做不了|没做成|搞不定|完成不了/.test(outText)

      if (result.ok && !looksFailed) {
        this.log(`<<< 完成（${secs}s）：${outText}`)
        if (result.code) {
          this.skills.add({
            name: 'k_' + Date.now().toString(36),
            desc: want.text,
            code: result.code,
            tags: extractTags(want.text)
          })
        }
        this.will.finish()
        this.mem.add({
          text: want.text + (outText ? ' -> ' + outText.slice(0, 60) : ''),
          kind: 'event',
          importance: 0.4,
          emotion: 0.3
        })
        if (Math.random() < 0.35) {
          const lines = ['搞定了', '弄完了', '行了', '差不多了']
          this.talk.say(lines[Math.floor(Math.random() * lines.length)])
        }
      } else {
        this.log(`<<< 失败（${secs}s）：${result.error || outText}`)
        this.mem.add({
          text: wishFailText(want.text, result.error || outText),
          kind: 'skill',
          importance: 0.65
        })
        this.will.finish()
        if (Math.random() < 0.3) this.talk.say('这咋弄啊')
      }
    } catch (e) {
      this.log('任务异常: ' + e.message)
      this.will.finish()
    } finally {
      this.busy = false
      this.taskDesc = ''
      if (this.actions) this.actions.cancel = false
    }

    await sleep(3000 + Math.random() * 9000)
  }

  contextForTask () {
    const s = this.actions.status()
    const inv = Object.entries(s.inventory).map(([k, v]) => `${k}x${v}`).join(', ')
    const scan = this.actions.scan(10)
    const found = Object.entries(scan.blocks).slice(0, 10).map(([k, v]) => `${k}(${v})`).join(' ')
    const others = Object.keys(this.bot.players).filter(n => n !== this.bot.username)
    const recalled = this.mem.remember(s.pos.x + ',' + s.pos.z, { limit: 4 })

    return `背包：${inv || '空'}（${this.actions.hasFood() ? '有吃的' : '没吃的'}）
周围看到：${found || '没什么'}
附近的人：${others.join('、') || '没有别人'}
血 ${s.health}，饿 ${s.food}，${s.time}
${recalled.length ? '想起：' + recalled.map(e => e.text).join('；') : ''}
${s.food < 18 ? '注意：饱食度低于 18 不会回血，先解决吃的' : ''}
${s.health < 10 ? '注意：血很低，先保证安全' : ''}`
  }

  dumpCode (goal, code, attempt) {
    try {
      const dir = path.join(DATA, 'code')
      fs.mkdirSync(dir, { recursive: true })
      const f = path.join(dir, `${Date.now()}_${attempt}.js`)
      fs.writeFileSync(f, '// ' + goal + '\n' + code, 'utf8')
      this.log('[code] ' + f)
    } catch (e) {}
  }

  // ==================== 生存 ====================

  checkSurvival () {
    const bot = this.bot
    if (!bot.entity) return null
    const pos = bot.entity.position

    if (pos.y < -50) return 'void'
    if (bot.entity.isInLava) return 'lava'
    if (bot.entity.isInWater && bot.oxygenLevel !== undefined && bot.oxygenLevel < 8) return 'drowning'

    // 卡在方块里（只看真正挡人的）
    const feetB = bot.blockAt(pos)
    const headB = bot.blockAt(pos.offset(0, 1, 0))
    const blocks = (b) => {
      if (!b) return false
      if (b.name === 'air' || b.name === 'cave_air') return false
      if (b.boundingBox === 'empty') return false
      return true
    }
    if (blocks(feetB) || blocks(headB)) return 'suffocate'

    if (this.lastDamageKind === 'in_wall' || this.lastDamageKind === 'cramming') {
      this.lastDamageKind = null
      return 'suffocate'
    }

    if (bot.entity.onFire) return 'fire'
    const below = bot.blockAt(pos.offset(0, -1, 0))
    if (below && below.name === 'lava') return 'lava'

    if (bot.health <= 8) return 'lowhp'
    if (bot.health <= 14 && bot.food < 18) return 'lowhp'
    return null
  }

  async doSurvive (why) {
    if (this.actions) this.actions.cancel = true
    this.busy = false
    try {
      await this._survive(why)
    } finally {
      if (this.actions) this.actions.cancel = false
    }
  }

  async _survive (why) {
    const bot = this.bot

    if (why === 'lava' || why === 'fire') {
      this.log('[survive] 泡在岩浆/火里，往上爬')
      for (let i = 0; i < 20 && (bot.entity.isInLava || bot.entity.onFire); i++) {
        bot.setControlState('jump', true)
        bot.setControlState('forward', true)
        await sleep(250)
      }
      bot.setControlState('jump', false)
      bot.setControlState('forward', false)
      try { await this.actions.wander(10) } catch (e) {}
      return
    }

    if (why === 'water' || why === 'drowning') {
      this.log('[survive] 在水里/憋气，先浮上去')
      const dir = ['forward', 'left', 'right'][Math.floor(Math.random() * 3)]
      bot.setControlState('jump', true)
      bot.setControlState(dir, true)
      for (let i = 0; i < 40; i++) {
        if ((bot.oxygenLevel === undefined || bot.oxygenLevel >= 20) && !bot.entity.isInWater) break
        await sleep(200)
        if (i % 10 === 9) {
          bot.setControlState(dir, false)
          const d2 = ['forward', 'back', 'left', 'right'][Math.floor(Math.random() * 4)]
          bot.setControlState(d2, true)
        }
      }
      for (const k of ['jump', 'forward', 'back', 'left', 'right']) bot.setControlState(k, false)
      return
    }

    if (why === 'suffocate') {
      this.log('[survive] 卡在方块里，挣脱')
      const pos = bot.entity.position
      let freed = false
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const t = pos.offset(dx, 0, dz)
        const feetB = bot.blockAt(t)
        const headB = bot.blockAt(t.offset(0, 1, 0))
        const free = (b) => b && (b.name === 'air' || b.boundingBox === 'empty')
        if (free(feetB) && free(headB)) {
          try {
            await bot.look(Math.atan2(-dx, dz), 0, true)
            bot.setControlState('forward', true)
            await sleep(700)
            bot.setControlState('forward', false)
            freed = true
            break
          } catch (e) {}
        }
      }
      if (!freed) {
        try {
          const head = bot.blockAt(pos.offset(0, 1, 0))
          if (head && head.name !== 'air') await bot.dig(head)
        } catch (e) {}
      }
      bot.setControlState('jump', true)
      await sleep(500)
      bot.setControlState('jump', false)
      return
    }

    if (why === 'void') {
      this.log('[survive] 掉虚空了')
      return
    }

    if (why === 'lowhp') {
      if (this.actions.hasFood()) {
        const ate = await this.actions.eat().catch(() => null)
        if (ate) {
          this.log('[survive] 吃了 ' + ate)
          await sleep(2500)
          return
        }
      }
      const near = this.reflex ? this.reflex.nearestHostile(12) : null
      if (near) {
        this.log('[survive] 附近有怪，先躲开')
        this.reflex.flee(near)
        await sleep(5000)
        return
      }
      if (!this.seekingFood) {
        this.seekingFood = true
        this.log('[survive] 没吃的，去找点吃的')
        try {
          const got = await this.actions.findFood()
          this.log('[survive] 找吃的：' + (got || '附近真没有'))
        } catch (e) {
          this.log('[survive] 找吃的出错: ' + e.message)
        }
        this.seekingFood = false
        return
      }
      this.log('[survive] 血少，原地歇会儿')
      await sleep(8000)
    }
  }

  // ==================== 退出 ====================

  shutdown () {
    this.running = false
    if (this.reflex) this.reflex.stop()
    if (this.clockTimer) clearInterval(this.clockTimer)
    try { this.mem.goOffline() } catch (e) {}
    try { this.bot.quit() } catch (e) {}
  }
}

function wishFailText (goal, err) {
  const e = String(err || '').slice(0, 60)
  return `教训：${goal} 没成（${e}）`
}

function extractTags (text) {
  const tags = []
  const map = {
    挖: ['mine', '挖矿'], 矿: ['mine'], 铁: ['iron'], 钻: ['diamond'], 石: ['stone'],
    树: ['wood', 'tree'], 木: ['wood'], 砍: ['chop'],
    盖: ['build'], 屋: ['house', 'build'], 房: ['house', 'build'],
    打: ['fight'], 怪: ['mob'],
    合成: ['craft'], 做: ['craft'], 镐: ['pickaxe'], 剑: ['sword'],
    烧: ['smelt'], 熔: ['smelt'], 吃: ['eat'], 饿: ['food'],
    箱: ['chest'], 存: ['chest'],
    走: ['move'], 看: ['explore'], 找: ['find'], 村: ['village']
  }
  for (const [k, v] of Object.entries(map)) {
    if (text.includes(k)) tags.push(...v)
  }
  return Array.from(new Set(tags))
}

// ==================== 启动 ====================

function main () {
  let cfg
  try {
    cfg = loadConfig()
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }

  const b = new Bot(cfg)

  process.on('SIGINT', () => { b.shutdown(); process.exit(0) })
  process.on('SIGTERM', () => { b.shutdown(); process.exit(0) })
  process.on('uncaughtException', (e) => {
    console.log('[fatal] ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e))
  })

  b.connect()
}

if (require.main === module) main()

module.exports = { Bot }
