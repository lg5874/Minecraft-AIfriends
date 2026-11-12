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
const spontaneous = require('./src/spontaneous')
const { Perception } = require('./src/perceive')
const { PluginAdapter } = require('./src/plugin')
const { EventQueue } = require('./src/events')
const { Taste } = require('./src/taste')
const Mood = require('./src/mood')
const { Impulse, classify, judgeFeeling } = require('./src/impulse')

const ROOT = __dirname
// 数据目录：多实例时每个实例独立（记忆/品味/心情/技能互不干扰）
// 用环境变量 AIFRIEND_DATA 指定，不指定就用默认
const DATA = process.env.AIFRIEND_DATA
  ? path.resolve(ROOT, process.env.AIFRIEND_DATA)
  : path.join(ROOT, 'data', 'runtime')

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
    this.spont = null
    this.lastInventory = {}
    this.taste = null
    this.mood = null
    this.impulse = null
    this.perceive = null
    this.events = null
    this.plugin = null
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
      if (username === bot.username) return
      // 是不是在跟我说话：叫我名字、叫我外号、或者带我的称呼
      const myName = bot.username
      const called = message.includes(myName) ||
        (this.mem.people[username] && false) ||
        /^(你|XJJ|小徐|俊杰)/.test(message) ||
        /[?？]$/.test(message)

      if (this.events) {
        if (called) this.events.push('chat_me', { who: username, message }, `${username} 跟你说：${message}`)
        else this.events.push('chat_any', { who: username, message }, `${username} 说：${message}`)
      }

      if (!this.talk) return
      this.talk.onChat(username, message).catch(e => this.log('chat err ' + e.message))
    })

    bot.on('playerJoined', (p) => {
      if (p.username === bot.username) return
      if (this.events) this.events.push('player_join', { who: p.username }, `${p.username} 上线了`)
      if (this.spont) this.spont.push(spontaneous.onPlayerJoin(p.username))
    })
    bot.on('playerLeft', (p) => {
      if (p.username === bot.username) return
      if (this.events) this.events.push('player_leave', { who: p.username }, `${p.username} 下线了`)
      if (this.spont) this.spont.push(spontaneous.onPlayerLeave(p.username))
    })

    bot.on('message', (msg) => {
      const t = msg.toString()
      // 只认跟自己名字一起出现的死亡消息
      if (!t.includes(bot.username)) return
      if (/died|slain|drowned|blew up|fell|burned|starved|withered|hit the ground|was killed|shot|impaled|suffocated|froze|magma|void|kinetic/.test(t)) {
        this.lastDeathMsg = t.replace(/^[^:]*:\s*/, '').trim()
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
        if (this.events) {
          const from = ent ? (ent.username || ent.name || '什么东西') : '不知道什么东西'
          const isPlayer = ent && ent.type === 'player'
          this.events.push(
            isPlayer ? 'attack_by_player' : 'damage',
            { from, health: bot.health },
            `你被${from}打了，血剩 ${Math.round(bot.health)}`
          )
        }
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
    // 允许挖方块：卡在坑里的时候，能挖出来比干等着强
    moves.canDig = true
    moves.digCost = 20
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
    const self = this
    this.actions = new Actions(bot, {
      log: (s) => this.log(s),
      cfg: this.cfg,
      mem: this.mem,
      get reflex () { return self.reflex },
      onComplain: (kind, detail) => {
        if (!this.spont) return
        const ev = spontaneous.onComplain(kind, detail)
        if (ev) this.spont.push(ev)
      }
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
      // 只有真的在干正事才算忙。卡住/发呆/原地折腾都不算
      busy: () => {
        if (!this.busy) return false
        // 如果一分钟没动静，就不算忙了（他只是在等模型或者卡住了）
        if (this._taskProgress && Date.now() - this._taskProgress.at > 60000) return false
        return true
      },
      currentTaskDesc: () => this.taskDesc ? `你现在正在${this.taskDesc}。` : '你现在没什么事干。',
      taskDesc: () => this.taskDesc,
      actions: this.actions,
      dataDir: DATA,
      mood: this.mood,
      taste: this.taste,
      perceive: this.perceive,
      botNames: (this.cfg.behavior && this.cfg.behavior.botNames) || [],
      // 他答应了别人要干的事：插队执行
      onComply: (who, task) => {
        this.log('[comply] 答应 ' + who + ' 去干：' + task)
        if (this.impulse) {
          this.pendingTask = { text: '帮 ' + who + ' ' + task, from: who, at: Date.now() }
        }
      }
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
      // 只有真的在干正事才算忙。卡住/发呆/原地折腾都不算
      busy: () => {
        if (!this.busy) return false
        // 如果一分钟没动静，就不算忙了（他只是在等模型或者卡住了）
        if (this._taskProgress && Date.now() - this._taskProgress.at > 60000) return false
        return true
      },
      onEvent: (kind, data) => this.onReflexEvent(kind, data)
    })
    this.reflex.start()

    // 事件队列：所有事情先进这里
    this.events = this.events || new EventQueue({ log: (m) => this.log(m) })
    this.events.onWake((ev) => this.onUrgentEvent(ev))

    // 感知层：把世界翻译成人能看懂的话
    this.perceive = new Perception(bot, {
      mem: this.mem,
      events: this.events,
      log: (m) => this.log(m)
    })

    // 插件适配：探测这个服有哪些玩法
    this.plugin = new PluginAdapter(bot, { log: (m) => this.log(m), mem: this.mem })
    setTimeout(() => {
      this.plugin.scan().then(list => {
        this.log('[plugin] 扫描完成: ' + list.length + ' 个可用指令')
      }).catch(e => this.log('[plugin] 扫描失败: ' + e.message))
    }, 6000)

    // 品味（自己长出来的）和心情（会影响判断）
    this.taste = this.taste || new Taste(DATA)
    this.mood = this.mood || new Mood(DATA)
    this.impulse = new Impulse({
      log: (s) => this.log(s),
      llm: this.llm,
      actions: this.actions
    })

    this.spont = new spontaneous.Spontaneity({
      log: (s) => this.log(s),
      busy: () => this.busy
    })
    this.lastInventory = this.snapshotInventory()

    // 上线：如果有人在，让他自己决定说不说、说什么
    const last = this.mem.lastSummary()
    setTimeout(async () => {
      const names = Object.keys(bot.players).filter(n => n !== bot.username)
      if (!names.length) return
      const situation = online.sessionsBefore > 0
        ? `你刚上线，服务器里 ${names.join('、')} 在。上次下线前你在：${last ? last.text : '（记不清了）'}。`
        : `你刚进服务器，${names.join('、')} 已经在里面了。`
      await this.talk.speak(situation, { chance: 0.65, maxLen: 25, people: names })
    }, 4000 + Math.random() * 4000)

    this.loop().catch(e => this.log('loop crash ' + e.message))
  }

  startClock () {
    if (this.clockTimer) clearInterval(this.clockTimer)
    this.clockTimer = setInterval(() => {
      try { this.mem.tick(1) } catch (e) {}
    }, 1000)

    // 心跳：每 30 秒打一行，方便看出是不是卡死了
    if (this._heartbeat) clearInterval(this._heartbeat)
    this._heartbeat = setInterval(() => {
      const b = this.bot
      if (!b || !b.entity) {
        this.log('[hb] 不在游戏里（' + (b ? 'entity 空' : '没连接') + '）')
        return
      }
      const p = b.entity.position
      const st = this.actions ? this.actions.status() : null
      const idle = this._taskProgress ? Math.round((Date.now() - this._taskProgress.at) / 1000) : 0
      const inv = st ? Object.keys(st.inventory).length : 0
      this.log(`[hb] ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)} 血${st ? st.health : '?'} 饿${st ? st.food : '?'} 背包${inv}种 ${this.busy ? '忙:' + this.taskDesc + (idle > 20 ? `（${idle}秒没动）` : '') : '空闲'} 心情:${this.mood ? this.mood.state() : '?'}`)
    }, 30000)
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
    this._deathTimes = (this._deathTimes || [])
    this._deathTimes.push(Date.now())

    const how = this.lastDeathMsg || '不知道怎么回事'
    this.log('[death] ' + how)
    if (this.events) this.events.push('death', { how }, `你死了（${how}）`)

    // 记住这次死
    this.mem.add({
      text: '死了：' + how,
      kind: 'event',
      emotion: 0.65,
      importance: 0.5
    })

    // 死亡吐槽（连续死会说得更重）
    if (this.spont) {
      const recentDeaths = (this._deathTimes || []).filter(t => Date.now() - t < 300000).length
      const ev = recentDeaths >= 3
        ? spontaneous.onComplain('diedAgain', how)
        : spontaneous.onComplain('died', how)
      if (ev) this.spont.push(ev)
    }
    this.lastDeathMsg = null

    this.busy = false
    this.taskDesc = ''
    this.seekingFood = false
    this.sheltered = false
    if (this.actions) { this.actions.cancel = true; this.actions.stop() }
    if (this.will) this.will.finish()
    if (this.mood) this.mood.onEvent('death', 1)
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

    // 短时间内连续死 -> 出生点不安全，得走远
    const now = Date.now()
    this._deathTimes = (this._deathTimes || []).filter(t => now - t < 180000)
    if (this._deathTimes.length >= 2) {
      this.log('[respawn] 这地方反复死，走远点重生')
      try {
        await this.actions.wander(60)
        await this.actions.ensureChunks(4000)
      } catch (e) {}
      this._deathTimes = []
    }

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

  /** 急件来了：立刻有反应 */
  onUrgentEvent (ev) {
    this.log('[urgent] ' + ev.what)
    switch (ev.type) {
      case 'chat_me':
        // 有人叫我：如果在忙，记下来等会儿回；不忙就直接回
        break
      case 'damage':
      case 'attack_by_player':
        // 反射层已经在处理了
        break
      case 'danger':
        // 反射层处理
        break
      case 'death':
        break
      case 'gift':
        this.mood && this.mood.onEvent('gift', 1)
        break
      case 'demand':
        break
    }
  }

  // ==================== 反射事件 ====================

  onReflexEvent (kind, data) {
    if (!this.talk) return
    if (this.mood && kind === 'hurt_repeat') this.mood.onEvent('hurt', 1)
    if (kind === 'hurt_confused') {
      // 头一两次被打：还没搞清状况
      this.talk.speak(
        `${data.by} 打了你一下，这是第 ${data.times} 次。你还不太确定他是闹着玩还是故意。`,
        { chance: 0.5, maxLen: 20, people: [data.by] }
      ).catch(() => {})
    } else if (kind === 'hurt_repeat') {
      const hs = this.mem.hitStats(data.by)
      if (hs.times >= 3) {
        this.mem.note(data.by, `老打我（第${hs.times}次）`)
        this.talk.speak(
          `${data.by} 又打你了，这已经是第 ${hs.times} 次。之前他没道过歉。`,
          { chance: 0.7, maxLen: 25, people: [data.by] }
        ).catch(() => {})
      }
    }
  }

  // ==================== 主循环 ====================

  async loop () {
    while (this.running && this.bot && this.bot.entity) {
      // 兜底：busy 卡太久（比如异常没走到 finally），强制放开
      if (this.busy && this._busySince && Date.now() - this._busySince > (this.cfg.behavior.taskTimeoutSeconds || 420) * 1000 + 30000) {
        this.log('[stall] busy 状态卡太久，强制恢复')
        this.busy = false
        this.taskDesc = ''
        if (this.actions) this.actions.cancel = false
      }
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

    // 0. 处理事件队列：攒够了就交给模型看
    if (this.events) {
      this.events.prune()
      const r = this.events.ripe()
      if (r.ripe) {
        const evs = this.events.drain()
        this.log(`[events] 处理 ${evs.length} 条（${r.reason}）`)
        for (const e of evs) this.log('  · ' + e.what)
        // 急件里的"有人叫我"：立刻回应
        // 注意：onChat 已经处理过一遍了，这里只处理"当时在忙没回"的
        const chats = evs.filter(e => e.type === 'chat_me')
        if (chats.length && this.talk && !this.busy) {
          const last = chats[chats.length - 1]
          // 别重复回同一条
          if (this.talk.lastReplyTo !== last.data.who || this.talk.lastRepliedMsg !== last.data.message) {
            this.talk.lastRepliedMsg = last.data.message
            this.talk.reply(last.data.who, last.data.message).catch(() => {})
          }
        }
      }
    }

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

    // 4. 心情和品味随时间变化
    this.tickInnerState()

    // 5. 检查背包有没有新收获，攒个"想说话"的念头
    this.checkNewLoot()

    // 6. 有攒着的念头就问他要不要说（吐槽类不受"忙"限制）
    if (this.spont && this.talk) {
      await this.spont.tick(this.talk).catch(() => {})
    }

    // 6. 正在干活不打断
    if (this.busy) return

    // 7. 有答应别人的事就先做（答应了要做到）
    let want = null
    if (this.pendingTask) {
      want = this.pendingTask
      this.pendingTask = null
      this.log('[comply] 去做答应的事：' + want.text)
    } else {
      // 看看有没有冲动想干别的
      if (this.impulse && this.taste && this.mood) {
        const whim = await this.impulse.maybe(this.taste, this.mood, this.will.pending() || '')
        if (whim) {
          want = { text: whim, since: Date.now(), done: false }
          this.log('[impulse] 临时改主意：' + whim)
        }
      }
    }

    // 8. 没有别的事，就问自己想干什么
    if (!want) want = await this.will.think()
    if (!want) return

    this.busy = true
    this._busySince = Date.now()
    this.taskDesc = want.text
    this._taskStartInv = this.snapshotInv()   // 记下开始时的背包，用来判断产出
    if (this.actions) { this.actions.cancel = false; this.actions.stop() }
    const t0 = Date.now()
    if (this.impulse) this.impulse.taskStarted()
    this.log(`>>> 开始：${want.text}`)

    // 卡死检测：任务里如果连续 60 秒没有任何动作，就当它挂了
    this._taskProgress = { at: Date.now(), pos: this.bot.entity.position.clone() }
    const stallCheck = setInterval(() => {
      const tp = this._taskProgress
      if (!tp) return
      const p = this.bot.entity ? this.bot.entity.position : null
      if (!p) return
      // 位置动了、或者背包变了、或者刚打了日志 -> 算有进展
      if (p.distanceTo(tp.pos) > 0.8) {
        tp.pos = p.clone()
        tp.at = Date.now()
        return
      }
      if (Date.now() - tp.at > 60000) {
        this.log('[stall] 一分钟没动，强制结束任务')
        if (this.actions) this.actions.cancel = true
        try { this.bot.pathfinder.setGoal(null) } catch (e) {}
        tp.at = Date.now() + 600000   // 别重复触发
      }
    }, 5000)

    // 硬超时：代码里可能卡在某个 await 上，到点强制打断
    const hardTimeout = (this.cfg.behavior.taskTimeoutSeconds || 420) * 1000
    const timeoutPromise = new Promise((_, rej) => {
      this._taskTimer = setTimeout(() => {
        if (this.actions) this.actions.cancel = true
        try { this.bot.pathfinder.setGoal(null) } catch (e) {}
        rej(new Error('这个任务干太久了，先放下'))
      }, hardTimeout)
    })

    try {
      const ctxText = this.contextForTask()
      this.log(`[ctx] 上下文 ${ctxText.length} 字符${/剖面/.test(ctxText) ? '（含视觉地形图）' : '（⚠️ 没有视觉）'}`)
      const result = await Promise.race([
        this.coder.writeAndRun(want.text, ctxText),
        timeoutPromise
      ])
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

        // 做完之后，问自己爽不爽 —— 这是他品味的来源
        this.judgeAndGrow(want.text, outText).catch(() => {})
        if (this.mood) this.mood.onEvent('task_done', 1)
        // 干完了：攒个念头，让主动层决定说不说
        if (this.spont) this.spont.push(spontaneous.onGoalDone(want.text, outText))
      } else {
        const why = result.error || verdict.why || outText
        this.log(`<<< 失败（${secs}s）：${why}`)
        this.mem.add({
          text: wishFailText(want.text, result.error || outText),
          kind: 'skill',
          importance: 0.65
        })
        this.will.finish()
        if (this.mood) this.mood.onEvent('task_fail', 1)
        const others = Object.keys(this.bot.players || {}).filter(n => n !== this.bot.username)
        if (this.spont) {
          const err = String(result.error || outText || '')
          const kind = /找不到|没找到|没树|没有/.test(err) ? 'nothingFound'
            : /合成|craft|材料/.test(err) ? 'craftFail'
            : /卡住|走不动/.test(err) ? 'stuck'
            : 'nothingFound'
          const ev = spontaneous.onComplain(kind, err.slice(0, 30))
          if (ev) this.spont.push(ev)
        }
      }
    } catch (e) {
      this.log('任务异常: ' + e.message)
      this.will.finish()
    } finally {
      if (stallCheck) clearInterval(stallCheck)
      this._taskProgress = null
      if (this._taskTimer) { clearTimeout(this._taskTimer); this._taskTimer = null }
      this.busy = false
      this.taskDesc = ''
      if (this.actions) this.actions.cancel = false
    }

    await sleep(3000 + Math.random() * 9000)
  }

  /**
   * 判断一个任务到底成没成。
   *
   * 不能靠正则匹配模型写的自然语言（"挖青金石矿（mine返回0）"这种，
   * 正则穷举不完）。改成三条硬标准，任一不满足就算失败：
   *
   *   1. 模型自己说了失败词（明确的"失败/没做成/做不了"）
   *   2. 输出里有"返回0""从0变成0""0块""0个"这种零产出的痕迹
   *   3. 任务说要做某样东西，但背包里没有
   */
  judgeOutcome (goal, outText, t0) {
    const t = String(outText || '')

    // 1. 明确的失败词
    if (/^(失败|没做成|没成功|做不了|搞不定|完成不了|放弃)/.test(t)) {
      return { ok: false, why: '模型明确说了失败' }
    }
    // 执行异常
    if (/出错|Error:|任务被中断|异常|崩溃/.test(t)) {
      return { ok: false, why: '执行出错' }
    }
    if (/(做不了|没做成|搞不定|完成不了|没能|白忙|砍不到|挖不到|找不到|弄不到|拿不到)/.test(t)) {
      return { ok: false, why: '输出里有失败词' }
    }

    // 2. 零产出的痕迹
    const zeroPatterns = [
      /（mine返回0）/,
      /返回\s*0\b/,
      /从\s*0\s*变成\s*0/,
      /\b0\s*(块|个|根|把|颗)/,
      /挖了\s*0/,
      /做了\s*0/,
      /没拿到|没弄到|没挖到|没砍到|没找到|一个也没|一块也没/,
      /挖了\s*0\s*个/,
      /（尝试\s*\d+\s*轮）/,
      /没变/,
      /墙\s*0\s*块|顶\s*0\s*块/
    ]
    for (const re of zeroPatterns) {
      if (re.test(t)) return { ok: false, why: '输出显示零产出' }
    }

    // 3. 说要做的物品，背包里有没有
    //    注意：只有"制作类"任务才检查背包增加。
    //    "摆箱子/存东西"这类是消耗物品，不适用。
    const wantItem = this.extractWantedItem(goal)
    if (wantItem && this._taskStartInv) {
      // 判断是不是"制作/获取"类任务
      const isProduce = /(做|制作|合成|弄|搞|挖|砍|打|弄到|搞到|收集|攒|备|升级|换)/.test(goal)
      const isConsume = /(放|摆|存|放好|放下|安置|整理|存进|扔进)/.test(goal)

      if (isProduce && !isConsume) {
        const before = this._taskStartInv[wantItem] || 0
        const now = this.countItem(wantItem)
        if (now <= before) {
          return { ok: false, why: `说要${wantItem}，但背包没增加（${before}->${now}）` }
        }
      }
    }

    return { ok: true, why: '' }
  }

  /** 从目标描述里猜他想要什么物品 */
  extractWantedItem (goal) {
    const map = {
      '木镐': 'wooden_pickaxe', '石镐': 'stone_pickaxe', '铁镐': 'iron_pickaxe',
      '钻石镐': 'diamond_pickaxe', '木斧': 'wooden_axe', '石斧': 'stone_axe',
      '铁斧': 'iron_axe', '木剑': 'wooden_sword', '石剑': 'stone_sword',
      '铁剑': 'iron_sword', '工作台': 'crafting_table', '熔炉': 'furnace',
      '箱子': 'chest', '木棍': 'stick', '火把': 'torch', '床': 'red_bed',
      '面包': 'bread', '木门': 'oak_door', '梯子': 'ladder',
      '煤': 'coal', '铁锭': 'iron_ingot', '青金石': 'lapis_lazuli',
      '钻石': 'diamond', '圆石': 'cobblestone', '木板': 'oak_planks'
    }
    for (const [cn, en] of Object.entries(map)) {
      if (goal.includes(cn)) return en
    }
    return null
  }

  /** 数背包里某个物品有多少 */
  countItem (name) {
    try {
      let n = 0
      for (const i of this.bot.inventory.items()) {
        if (i.name === name) n += i.count
      }
      return n
    } catch (e) { return 0 }
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

  contextForTask () {
    // ===== 视觉：让他真的看见地形，不是我替他总结 =====
    // 地形剖面图比文字描述有用得多：一眼能看出前方通不通、头顶有没有石头
    let world = ''
    try {
      world = this.actions.lookAround3D(6)
    } catch (e) {
      this.log('[vision] ' + e.message)
      // 视觉失败就退回文字感知
      try {
        world = this.perceive ? this.perceive.snapshot({ radius: 16 }) : ''
      } catch (e2) {}
    }

    // 四个方向能不能走（直接给出结论，省得他看图算）
    try {
      const dirs = [['东', 1, 0], ['西', -1, 0], ['南', 0, 1], ['北', 0, -1]]
      const walks = dirs.map(([n, dx, dz]) => {
        const r = this.actions.canWalkTo(dx, dz)
        return `${n}${r.walkable ? '能走' + (r.needDig ? '（要挖' + r.needDig + '格）' : '') : '走不通（' + r.reason + '）'}`
      })
      world += '\n【四个方向】' + walks.join('，')
    } catch (e) {}

    const s = this.actions.status()
    const recalled = this.mem.remember(s.pos.x + ',' + s.pos.z, { limit: 4 })

    const extra = []
    if (s.food < 18) extra.push('注意：饱食度低于 18 不会回血，先解决吃的')
    if (s.health < 10) extra.push('注意：血很低，先保证安全')
    if (recalled.length) extra.push('想起：' + recalled.map(e => e.text).join('；'))

    // 这个服有哪些玩法
    let pluginHint = ''
    try {
      pluginHint = this.plugin ? this.plugin.prompt() : ''
    } catch (e) {}

    return world + '\n' + extra.join('\n') + (pluginHint ? '\n' + pluginHint : '')
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

    // in_wall/cramming 只有当血真的在掉、而且周围确实有方块时才算
    if (this.lastDamageKind === 'in_wall' || this.lastDamageKind === 'cramming') {
      this.lastDamageKind = null
      if (this.busy) return null          // 正在干活，多半是挖掘产生的误报
      if (bot.health > (this._lastHealth || 20) - 0.5) return null  // 没掉血，不是真卡
      if (blocks(feetB) || blocks(headB)) return 'suffocate'
      return null
    }

    if (bot.entity.onFire) return 'fire'
    const below = bot.blockAt(pos.offset(0, -1, 0))
    if (below && below.name === 'lava') return 'lava'

    // 血量骤降记一下（用来事后开口）
    if (this._lastHealth != null && bot.health < this._lastHealth - 6) {
      if (this.spont) {
        this.spont.push(require('./src/spontaneous').onNearDeath(
          this.lastDamageKind ? this.lastDamageKind + ' 伤害' : '被打了'
        ))
      }
    }
    this._lastHealth = bot.health

    // 只有真的快死了才算紧急。饱食度低但血还够，让他自己去干活顺便找吃的
    if (bot.health <= 6) return 'lowhp'
    return null
  }

  /**
   * 做完一件事：问他爽不爽，然后长进品味里。
   * 这是偏好"自己长出来"的唯一来源。
   */
  async judgeAndGrow (task, outcome) {
    if (!this.taste || !this.mood) return
    const kinds = classify(task)
    if (!kinds.length) return   // 归不了类的不记

    const v = await judgeFeeling(this.llm, {
      what: task,
      outcome,
      mood: this.mood.describe(),
      tasted: this.taste.likes().concat(this.taste.dislikes)
    })
    if (!v) return

    this.taste.record({
      what: `${task}（${v.why || outcome}）`,
      kinds,
      feeling: v.feeling,
      now: this.mem.clock.now()
    })
    this.log(`[taste] ${task} -> 感觉 ${v.feeling.toFixed(2)} ${v.why || ''}`)

    // 记住这次体验（重要的才记）
    if (Math.abs(v.feeling) > 0.6) {
      this.mem.add({
        text: `${task}，感觉${v.feeling > 0 ? '挺爽' : '有点烦'}${v.why ? '：' + v.why : ''}`,
        kind: 'fact',
        importance: 0.6,
        emotion: Math.abs(v.feeling)
      })
    }
  }

  /** 心情/品味随时间推进 */
  tickInnerState () {
    const now = Date.now()
    if (!this._lastInnerTick) this._lastInnerTick = now
    const deltaMin = (now - this._lastInnerTick) / 60000
    if (deltaMin < 0.5) return
    this._lastInnerTick = now
    try {
      if (this.mood) this.mood.tick(deltaMin)
      if (this.taste) this.taste.decay(this.mem.clock.now())
    } catch (e) {}
  }

  /** 背包快照 */
  snapshotInventory () {
    const out = {}
    try {
      for (const i of this.bot.inventory.items()) out[i.name] = (out[i.name] || 0) + i.count
    } catch (e) {}
    return out
  }

  /** 对比上次快照，发现新收获就攒个念头 */
  checkNewLoot () {
    if (!this.spont) return
    const now = this.snapshotInventory()
    const prev = this.lastInventory || {}
    for (const [name, count] of Object.entries(now)) {
      const gained = count - (prev[name] || 0)
      if (gained <= 0) continue
      const ev = spontaneous.onValuableFind(name, gained)
      if (ev) this.spont.push(ev)
    }
    this.lastInventory = now
  }

  async doSurvive (why) {
    // 找吃的本身需要动作能力，不能把 cancel 设成 true
    const needCancel = why !== 'lowhp'
    if (needCancel && this.actions) this.actions.cancel = true
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
      // 饱食度够（>=18）就会自然回血，只要没怪，等着就行
      if (bot.food >= 18 && bot.health > 0) {
        const near0 = this.reflex ? this.reflex.nearestHostile(10) : null
        if (near0) {
          this.reflex.flee(near0)
          await sleep(4000)
          return
        }
        this.log('[survive] 吃饱了，等回血（' + Math.round(bot.health) + '/20）')
        // 找个安全地方待着
        await sleep(15000)
        return
      }
      if (this.actions.hasFood()) {
        const ate = await this.actions.eat().catch(() => null)
        if (ate) {
          this.log('[survive] 吃了 ' + ate + '，饱食度 ' + Math.round(bot.food))
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
      // 找吃的加冷却，别 4 秒一次狂刷
      const now = Date.now()
      if (!this._foodCooldownUntil) this._foodCooldownUntil = 0
      if (now >= this._foodCooldownUntil && !this.seekingFood) {
        this.seekingFood = true
        this.log('[survive] 没吃的，去找点吃的')
        try {
          // 先在附近找，找不到就走远一点再找
          let got = await this.actions.findFood()
          if (!got) {
            this.log('[survive] 附近没有，走远点')
            try { await this.actions.wander(40) } catch (e) {}
            await this.actions.ensureChunks(4000)
            got = await this.actions.findFood()
          }
          this.log('[survive] 找吃的：' + (got || '还是没有'))
        } catch (e) {
          this.log('[survive] 找吃的出错: ' + e.message)
        }
        this.seekingFood = false
        this._foodCooldownUntil = Date.now() + 30000   // 30 秒内不再试
        return
      }
      this.log('[survive] 血少，原地歇会儿')
      await sleep(10000)
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
    const msg = e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)
    console.log('[fatal] ' + msg)
    // 别让这类断言错误把整个进程干掉
    if (/Invalid itemType|AssertionError/.test(msg)) {
      console.log('[fatal] 这是 mineflayer 内部断言，忽略继续跑')
      return
    }
  })

  b.connect()
}

if (require.main === module) main()

module.exports = { Bot }
